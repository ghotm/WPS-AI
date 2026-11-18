// plugin/tools/mcp-jsonrpc.js
// MCP JSON-RPC 核心逻辑（传输无关）。
//
// 两种传输共用这一份实现，避免 stdio 与 Streamable HTTP 两套逻辑漂移：
//   - stdio：plugin/tools/mcp-server.js（外部 agent 以子进程方式启动）
//   - HTTP ：proxy-server.js 的 POST /mcp/http（外部 agent 直接 HTTP 连接）
//
// backend 由调用方注入，负责「工具清单从哪来」「工具调用怎么执行」：
//   listTools(): Promise<{ ok:boolean, tools?:Array, status?:number, error?:string }>
//   callTool(name, args): Promise<{ ok:boolean, value?:any, error?:string, transport?:boolean }>
//     transport 为 true 表示「传输层失败」（proxy 不通 / 非 200），应与工具自身失败区分。

"use strict";

const PROTOCOL_VERSION = "2024-11-05";
// initialize 只能回服务端支持的协议版本（规范 MUST），不能回显客户端的任意字符串。
const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26"];
const SERVER_INFO = {
  name: "lingxi-wps-ai",
  version: "1.0.0"
};

function makeResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function makeError(id, code, message, data) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
}

// 把 plugin 注册的 { name, description, parameters|inputSchema } 归一成 MCP tools/list 结构
function normalizeTools(tools) {
  return (Array.isArray(tools) ? tools : []).map((t) => ({
    name: t.name,
    description: t.description || "",
    inputSchema: t.parameters || t.inputSchema || { type: "object", properties: {} }
  }));
}

/**
 * 处理一条 JSON-RPC 请求。通知类（无 id）返回 null，调用方不应回包。
 * @param {{id?:string|number, method?:string, params?:object}} req
 * @param {{listTools:Function, callTool:Function}} backend
 */
async function handleRequest(req, backend) {
  // JSON-RPC 消息必须是非数组对象，否则按规范回 -32600（不能静默吞掉）。
  if (!req || typeof req !== "object" || Array.isArray(req)) {
    return makeError(null, -32600, "Invalid Request");
  }
  const { id, method, params } = req;
  try {
    // 无 id 一律视为通知：规范规定服务端不得对通知回包。
    // 放在方法分发之前，可覆盖 notifications/roots/list_changed 等任意通知方法。
    if (id === undefined) return null;

    if (method === "initialize") {
      // 只回服务端支持的版本；缺失或不支持时回服务端基线版本（规范 MUST）。
      const requested = params && typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return makeResult(id, {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION,
        capabilities: {
          tools: {}     // 支持 tools/list 和 tools/call
        },
        serverInfo: SERVER_INFO
      });
    }

    if (method === "ping") {
      return makeResult(id, {});
    }

    if (method === "tools/list") {
      const res = await backend.listTools();
      if (!res || !res.ok) {
        // plugin 未在线时 list 返回空，不报错（避免 client 把整个 server 标红）
        if (res && res.status === 503) {
          return makeResult(id, { tools: [] });
        }
        return makeError(id, -32000, "拉取工具清单失败: " + ((res && res.error) || "unknown"));
      }
      return makeResult(id, { tools: normalizeTools(res.tools) });
    }

    if (method === "tools/call") {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      if (!name) return makeError(id, -32602, "缺 name 参数");
      const res = await backend.callTool(name, args);
      if (!res || !res.ok) {
        // 传输层失败（proxy/HTTP 不通）→ JSON-RPC 错误，而非工具执行失败
        if (res && res.transport) return makeError(id, -32000, res.error);
        // tool 执行失败 → MCP 用 isError + text content 返回
        return makeResult(id, {
          isError: true,
          content: [{ type: "text", text: String((res && res.error) || "执行失败") }]
        });
      }
      // tool 成功 → 把 value 序列化成 text
      const value = res.value;
      const text = typeof value === "string"
        ? value
        : (value === undefined ? "" : JSON.stringify(value, null, 2));
      return makeResult(id, {
        content: [{ type: "text", text }]
      });
    }

    // 其他 MCP 方法（resources/* prompts/* 等）暂不支持
    return makeError(id, -32601, `未实现的 MCP 方法: ${method}`);
  } catch (e) {
    return makeError(id, -32603, "内部错误: " + ((e && e.message) || e));
  }
}

module.exports = {
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  SERVER_INFO,
  makeResult,
  makeError,
  normalizeTools,
  handleRequest
};
