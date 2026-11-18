// plugin/test/mcp-http-transport.test.js
// Streamable HTTP 传输层：只测纯函数（不监听端口）。

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  MCP_HTTP_PATH,
  MAX_BODY_BYTES,
  acceptsJson,
  originAllowed,
  contentTypeAllowed,
  handleStreamableHttpReq
} = require("../tools/mcp-http-transport.js");

const backend = {
  async listTools() {
    return { ok: true, tools: [{ name: "doc_read", description: "读取文档" }] };
  },
  async callTool(name, args) {
    return { ok: true, value: { name, args } };
  }
};

function ctx(overrides) {
  return Object.assign({
    method: "POST",
    pathname: MCP_HTTP_PATH,
    headers: { accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  }, overrides || {});
}

test("非本模块路径返回 null", async () => {
  const out = await handleStreamableHttpReq(ctx({ pathname: "/mcp/call" }), backend);
  assert.strictEqual(out, null);
});

test("GET 返回 405 + Allow: POST", async () => {
  const out = await handleStreamableHttpReq(ctx({ method: "GET", body: "" }), backend);
  assert.strictEqual(out.status, 405);
  assert.strictEqual(out.headers.Allow, "POST");
  assert.strictEqual(out.body.error.code, -32000);
});

test("DELETE 同样 405", async () => {
  const out = await handleStreamableHttpReq(ctx({ method: "DELETE", body: "" }), backend);
  assert.strictEqual(out.status, 405);
});

test("Accept 不接受 json 时返回 406", async () => {
  const out = await handleStreamableHttpReq(ctx({ headers: { accept: "text/html" } }), backend);
  assert.strictEqual(out.status, 406);
  assert.ok(out.body.error);
});

test("缺 Accept 头时宽松放行", async () => {
  const out = await handleStreamableHttpReq(ctx({ headers: {} }), backend);
  assert.strictEqual(out.status, 200);
});

test("空 body 返回 400 -32700", async () => {
  const out = await handleStreamableHttpReq(ctx({ body: "   " }), backend);
  assert.strictEqual(out.status, 400);
  assert.strictEqual(out.body.error.code, -32700);
});

test("非法 JSON 返回 400 -32700", async () => {
  const out = await handleStreamableHttpReq(ctx({ body: "{oops" }), backend);
  assert.strictEqual(out.status, 400);
  assert.strictEqual(out.body.error.code, -32700);
});

test("批量数组返回 400 -32600", async () => {
  const out = await handleStreamableHttpReq(ctx({ body: "[]" }), backend);
  assert.strictEqual(out.status, 400);
  assert.strictEqual(out.body.error.code, -32600);
});

test("纯通知/响应数组返回 202 且无响应体", async () => {
  const passive = [
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", method: "notifications/roots/list_changed" },
    { jsonrpc: "2.0", id: 7, result: {} }
  ];
  const out = await handleStreamableHttpReq(ctx({ body: JSON.stringify(passive) }), backend);
  assert.strictEqual(out.status, 202);
  assert.strictEqual(out.body, null);
});

test("数组内含请求时返回 400 -32600", async () => {
  const batch = [
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 1, method: "tools/list" }
  ];
  const out = await handleStreamableHttpReq(ctx({ body: JSON.stringify(batch) }), backend);
  assert.strictEqual(out.status, 400);
  assert.strictEqual(out.body.error.code, -32600);
});

test("非对象 body（字符串/数字/null/空对象）返回 400 -32600", async () => {
  for (const body of [JSON.stringify("str"), JSON.stringify(123), "null", "{}", "true"]) {
    const out = await handleStreamableHttpReq(ctx({ body }), backend);
    assert.strictEqual(out.status, 400, `body=${body}`);
    assert.strictEqual(out.body.error.code, -32600, `body=${body}`);
    assert.strictEqual(out.body.id, null);
  }
});

test("无 id 的非 notifications 方法按通知处理：202 且无响应体", async () => {
  const out = await handleStreamableHttpReq(
    ctx({ body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list" }) }),
    backend
  );
  assert.strictEqual(out.status, 202);
  assert.strictEqual(out.body, null);
});

test("id 为 0 / null 时都正常返回结果", async () => {
  const zero = await handleStreamableHttpReq(
    ctx({ body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }) }),
    backend
  );
  assert.strictEqual(zero.status, 200);
  assert.strictEqual(zero.body.id, 0);

  const nul = await handleStreamableHttpReq(
    ctx({ body: JSON.stringify({ jsonrpc: "2.0", id: null, method: "ping" }) }),
    backend
  );
  assert.strictEqual(nul.status, 200);
  assert.strictEqual(nul.body.id, null);
});

test("无 Origin 的请求放行（非浏览器客户端）", async () => {
  const out = await handleStreamableHttpReq(ctx({ headers: { accept: "application/json" } }), backend);
  assert.strictEqual(out.status, 200);
});

test("本机 Origin 放行（localhost / 127.0.0.1 / ::1）", async () => {
  for (const origin of ["http://localhost:3000", "http://127.0.0.1:3890", "http://[::1]:8080"]) {
    const out = await handleStreamableHttpReq(
      ctx({ headers: { accept: "application/json", origin } }),
      backend
    );
    assert.strictEqual(out.status, 200, `origin=${origin}`);
  }
});

test("外部 Origin 返回 403 -32600", async () => {
  for (const origin of ["https://evil.com", "http://evil.com:3890", "null", "not-a-url"]) {
    const out = await handleStreamableHttpReq(
      ctx({ headers: { accept: "application/json", origin } }),
      backend
    );
    assert.strictEqual(out.status, 403, `origin=${origin}`);
    assert.strictEqual(out.body.error.code, -32600);
  }
});

test("Content-Type 非 application/json 返回 415 -32600", async () => {
  const out = await handleStreamableHttpReq(
    ctx({ headers: { accept: "application/json", "content-type": "text/plain" } }),
    backend
  );
  assert.strictEqual(out.status, 415);
  assert.strictEqual(out.body.error.code, -32600);
});

test("Content-Type 带 charset 仍放行", async () => {
  const out = await handleStreamableHttpReq(
    ctx({ headers: { accept: "application/json", "content-type": "application/json; charset=utf-8" } }),
    backend
  );
  assert.strictEqual(out.status, 200);
});

test("body 超过 4MB 返回 413 -32600", async () => {
  const out = await handleStreamableHttpReq(
    ctx({ body: Buffer.alloc(MAX_BODY_BYTES + 1, 0x20) }),
    backend
  );
  assert.strictEqual(out.status, 413);
  assert.strictEqual(out.body.error.code, -32600);
});

test("通知返回 202 且无响应体", async () => {
  const out = await handleStreamableHttpReq(
    ctx({ body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }),
    backend
  );
  assert.strictEqual(out.status, 202);
  assert.strictEqual(out.body, null);
});

test("正常请求返回 200 JSON-RPC 结果", async () => {
  const out = await handleStreamableHttpReq(ctx(), backend);
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.jsonrpc, "2.0");
  assert.strictEqual(out.body.id, 1);
  assert.strictEqual(out.body.result.tools[0].name, "doc_read");
  // 归一化时补齐 inputSchema
  assert.deepStrictEqual(out.body.result.tools[0].inputSchema, { type: "object", properties: {} });
});

test("Buffer body 也能解析（proxy readBody 返回 Buffer）", async () => {
  const out = await handleStreamableHttpReq(
    ctx({ body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })) }),
    backend
  );
  assert.strictEqual(out.status, 200);
  assert.deepStrictEqual(out.body.result, {});
});

test("acceptsJson 覆盖常见 Accept 值", () => {
  assert.strictEqual(acceptsJson({}), true);
  assert.strictEqual(acceptsJson({ accept: "application/json" }), true);
  assert.strictEqual(acceptsJson({ accept: "text/event-stream" }), true);
  assert.strictEqual(acceptsJson({ accept: "*/*" }), true);
  assert.strictEqual(acceptsJson({ accept: "text/html" }), false);
});
