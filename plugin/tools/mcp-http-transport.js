// plugin/tools/mcp-http-transport.js
// MCP Streamable HTTP 传输（规范 2025-03-26）的无状态实现。
//
// 设计取舍：
//   - 只做 POST + application/json 单响应，不做 SSE 流（GET 用于服务端主动推送，返回 405）。
//     规范的「服务端 MAY 返回 application/json」允许这种实现，主流客户端均兼容。
//   - 不做 mcp-session-id 会话管理：所有状态都在 backend 侧（plugin 注册的工具清单、
//     长轮询派发），HTTP 层无需会话。
//   - 纯函数式入口，方便单测（不依赖真实 http.Server）——proxy-server.js 只负责读 body、
//     鉴权和写回响应。

"use strict";

const { handleRequest, makeError } = require("./mcp-jsonrpc.js");

const MCP_HTTP_PATH = "/mcp/http";
// 请求体上限 4MB：避免无界内存占用（规范未强制，属于防御性限制）。
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function acceptsJson(headers) {
  const accept = String((headers && (headers.accept || headers.Accept)) || "");
  if (!accept) return true; // 部分客户端不带 Accept，按宽松处理
  return /application\/json|text\/event-stream|\*\/\*/i.test(accept);
}

// 只允许本机页面发起跨源请求，防止任意网站借用浏览器打本机 proxy（DNS rebinding / CSRF）。
// 无 Origin 视为非浏览器客户端（CLI、服务端），放行。
const ALLOWED_ORIGIN_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];

function originAllowed(headers) {
  const origin = String((headers && (headers.origin || headers.Origin)) || "").trim();
  if (!origin) return true;
  if (origin === "null") return false; // 沙箱 iframe / file:// 的不透明来源
  try {
    const host = new URL(origin).hostname;
    return ALLOWED_ORIGIN_HOSTS.includes(host);
  } catch (e) {
    return false; // 无法解析的来源一律拒绝
  }
}

// Content-Type 缺省时宽松放行（部分客户端不发）；存在时必须以 application/json 开头。
function contentTypeAllowed(headers) {
  const ct = headers && (headers["content-type"] || headers["Content-Type"]);
  if (ct === undefined || ct === null || ct === "") return true;
  return String(ct).trim().toLowerCase().startsWith("application/json");
}

// 一条消息是否是可处理的请求/通知：必须有字符串 method。
function isRequestLike(msg) {
  return !!msg && typeof msg === "object" && !Array.isArray(msg) && typeof msg.method === "string";
}

// 无 method、但有 id 且带 result 或 error → 客户端回给服务端的响应对象。
function isResponseLike(msg) {
  return !!msg && typeof msg === "object" && !Array.isArray(msg)
    && msg.method === undefined
    && msg.id !== undefined
    && (msg.result !== undefined || msg.error !== undefined);
}

/**
 * 处理一条 Streamable HTTP 请求。
 * @param {{ method:string, pathname:string, headers?:object, body?:Buffer|string }} ctx
 * @param {{listTools:Function, callTool:Function}} backend
 * @returns {Promise<null|{status:number, headers?:object, body:object|null}>}
 *          返回 null 表示不是本模块负责的路径。
 */
async function handleStreamableHttpReq(ctx, backend) {
  const { method, pathname, headers, body } = ctx || {};
  if (pathname !== MCP_HTTP_PATH) return null;

  if (method !== "POST") {
    return {
      status: 405,
      headers: { Allow: "POST" },
      body: makeError(null, -32000, "Method Not Allowed：Streamable HTTP 端点只接受 POST")
    };
  }

  // Origin 校验（规范 MUST + 安全）：必须在读 body 之前拦下跨源浏览器请求。
  if (!originAllowed(headers)) {
    return { status: 403, body: makeError(null, -32600, "Forbidden：Origin 不被允许") };
  }

  if (!contentTypeAllowed(headers)) {
    return { status: 415, body: makeError(null, -32600, "Unsupported Media Type：Content-Type 必须为 application/json") };
  }

  if (!acceptsJson(headers)) {
    return {
      status: 406,
      body: makeError(null, -32000, "Not Acceptable：请发送 Accept: application/json, text/event-stream")
    };
  }

  const raw = Buffer.isBuffer(body) ? body.toString("utf8") : String(body || "");
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return { status: 413, body: makeError(null, -32600, "Payload Too Large：请求体超过 4MB") };
  }
  if (!raw.trim()) {
    return { status: 400, body: makeError(null, -32700, "JSON parse error: empty body") };
  }

  let req;
  try {
    req = JSON.parse(raw);
  } catch (e) {
    return { status: 400, body: makeError(null, -32700, "JSON parse error: " + e.message) };
  }

  if (Array.isArray(req)) {
    // 批量请求本身已不在规范内；但纯「通知数组」或「响应数组」无响应可回，按 202 处理。
    const allPassive = req.length > 0 && req.every((item) => {
      if (isRequestLike(item)) return item.id === undefined; // notification
      return isResponseLike(item);
    });
    if (allPassive) return { status: 202, body: null };
    return { status: 400, body: makeError(null, -32600, "不支持 JSON-RPC 批量请求") };
  }

  // null / 字符串 / 数字 / 数组之外的非对象 → Invalid Request
  if (!isRequestLike(req) && !isResponseLike(req)) {
    return { status: 400, body: makeError(null, -32600, "Invalid Request") };
  }

  // 无 id 一律按通知处理（含未知方法），回 202 空体，不交给 handleRequest。
  if (req.id === undefined) {
    return { status: 202, body: null };
  }

  const resp = await handleRequest(req, backend);
  if (resp === null) return { status: 202, body: null };
  return { status: 200, body: resp };
}

module.exports = {
  MCP_HTTP_PATH,
  MAX_BODY_BYTES,
  acceptsJson,
  originAllowed,
  contentTypeAllowed,
  handleStreamableHttpReq
};
