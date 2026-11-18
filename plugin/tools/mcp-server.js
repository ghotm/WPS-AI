#!/usr/bin/env node
/**
 * 文小舟 WPS MCP 服务 —— 把 WPS plugin 暴露的工具通过 stdio JSON-RPC 协议提供给
 * 外部 agent（Claude Code CLI / Claude Desktop / Cursor 等）使用。
 *
 * 工作流：
 *   stdin (MCP JSON-RPC) → 本进程 → HTTP → proxy-server.js → 长轮询 → WPS plugin → 执行 → 回传
 *
 * 用法（在 Claude Code CLI / Claude Desktop 配置里）：
 *   {
 *     "mcpServers": {
 *       "wps-ai": {
 *         "command": "node",
 *         "args": ["E:/path/to/plugin/tools/mcp-server.js"],
 *         "env": { "WPS_PROXY_PORT": "3890" }   // 可选，默认 3890
 *       }
 *     }
 *   }
 *
 * 前置：
 *   1. 启动 proxy-server.js（node plugin/tools/proxy-server.js）
 *   2. 打开 WPS，启用插件设置里的「MCP 服务」开关
 */

const http = require("http");
const { URL } = require("url");
// JSON-RPC 核心与 proxy 的 POST /mcp/http 共用，避免 stdio / HTTP 两套逻辑漂移。
const { handleRequest, makeError } = require("./mcp-jsonrpc.js");

const PROXY_HOST = process.env.WPS_PROXY_HOST || "127.0.0.1";
const PROXY_PORT = Number(process.env.WPS_PROXY_PORT) || 3890;
const PROXY_BASE = `http://${PROXY_HOST}:${PROXY_PORT}`;
// MCP 共享 token：plugin 会生成一次持久化 token，插进 MCP 客户端 config 的 env。
// 我们把它作为 Authorization: Bearer <token> 传给 proxy，未来 proxy 侧强制校验
// 后同机进程也不能未授权调 WPS 工具。老版本 proxy 忽略这个 header 不会 break。
const MCP_TOKEN = process.env.WPS_MCP_TOKEN || "";

// ====== HTTP 工具 ======
function httpRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(PROXY_BASE + path);
    const data = body ? Buffer.from(JSON.stringify(body), "utf8") : null;
    const req = http.request({
      method,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: (() => {
        const h = data
          ? { "Content-Type": "application/json", "Content-Length": data.length }
          : {};
        if (MCP_TOKEN) h["Authorization"] = `Bearer ${MCP_TOKEN}`;
        return h;
      })(),
      timeout: 90 * 1000
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch (e) {}
        resolve({ status: res.statusCode, body: parsed, raw: text });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { try { req.destroy(); } catch (e) {} reject(new Error("HTTP timeout")); });
    if (data) req.write(data);
    req.end();
  });
}

// ====== MCP JSON-RPC ======
// 传输无关的核心在 mcp-jsonrpc.js；这里只提供「走 HTTP 到 proxy」的 backend。

function writeMessage(msg) {
  // MCP 使用 LSP 风格 framing？不，标准 MCP 走 stdio 时是 newline-delimited JSON
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const backend = {
  async listTools() {
    const { status, body } = await httpRequest("GET", "/mcp/tools");
    if (status !== 200 || !body?.ok) {
      return { status, ok: false, error: body?.error || `HTTP ${status}` };
    }
    return { status, ok: true, tools: body.tools || [] };
  },
  async callTool(name, args) {
    const { status, body } = await httpRequest("POST", "/mcp/call", { name, args });
    if (status !== 200) {
      // 非 200 属于传输层失败（proxy 出错/重启），由核心转成 JSON-RPC 错误而非 isError
      return { ok: false, transport: true, error: "调用 WPS 工具失败: " + (body?.error || `HTTP ${status}`) };
    }
    if (!body?.ok) {
      return { ok: false, error: body?.error || "执行失败" };
    }
    return { ok: true, value: body.value };
  }
};

// ====== stdin 读取 (newline-delimited JSON) ======

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const nl = buffer.indexOf("\n");
    if (nl < 0) break;
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); }
    catch (e) {
      writeMessage(makeError(null, -32700, "JSON parse error: " + e.message));
      continue;
    }
    handleRequest(req, backend).then((resp) => {
      if (resp) writeMessage(resp);
    }).catch((e) => {
      writeMessage(makeError(req?.id ?? null, -32603, "未捕获错误: " + (e?.message || e)));
    });
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});

// 错误信息全走 stderr，避免污染 stdout（stdout 只允许 JSON-RPC）
process.on("uncaughtException", (e) => {
  process.stderr.write(`[mcp-server] uncaught: ${e?.stack || e}\n`);
});
