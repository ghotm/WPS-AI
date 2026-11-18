// plugin/test/mcp-jsonrpc.test.js
// MCP JSON-RPC 核心：stdio 与 Streamable HTTP 共用的方法分发逻辑。
// 直接 require 纯模块，不启动任何 server。

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  normalizeTools,
  handleRequest
} = require("../tools/mcp-jsonrpc.js");

function makeBackend(overrides) {
  return Object.assign({
    async listTools() {
      return {
        ok: true,
        tools: [{ name: "doc_read", description: "读取文档", parameters: { type: "object", properties: {} } }]
      };
    },
    async callTool(name, args) {
      return { ok: true, value: { name, args } };
    }
  }, overrides || {});
}

test("initialize 回显客户端协议版本", async () => {
  const resp = await handleRequest(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
    makeBackend()
  );
  assert.strictEqual(resp.id, 1);
  assert.strictEqual(resp.result.protocolVersion, "2025-03-26");
  assert.deepStrictEqual(resp.result.capabilities.tools, {});
  assert.strictEqual(resp.result.serverInfo.name, "lingxi-wps-ai");
});

test("initialize 缺协议版本时回退到服务端基线版本", async () => {
  const resp = await handleRequest({ id: 2, method: "initialize", params: {} }, makeBackend());
  assert.strictEqual(resp.result.protocolVersion, PROTOCOL_VERSION);
});

test("initialize 只回支持列表内的协议版本", async () => {
  assert.deepStrictEqual(SUPPORTED_PROTOCOL_VERSIONS, ["2024-11-05", "2025-03-26"]);
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(PROTOCOL_VERSION));
});

test("initialize 遇到非法/未来协议版本时回退，不回显", async () => {
  for (const bad of ["2099-99-99", "2025-06-18", "1.0.0", ""]) {
    const resp = await handleRequest(
      { jsonrpc: "2.0", id: 21, method: "initialize", params: { protocolVersion: bad } },
      makeBackend()
    );
    assert.strictEqual(resp.result.protocolVersion, PROTOCOL_VERSION, `protocolVersion=${bad}`);
  }
  // 非字符串类型同样回退
  const resp = await handleRequest(
    { jsonrpc: "2.0", id: 22, method: "initialize", params: { protocolVersion: 20250326 } },
    makeBackend()
  );
  assert.strictEqual(resp.result.protocolVersion, PROTOCOL_VERSION);
});

test("ping 返回空结果", async () => {
  const resp = await handleRequest({ id: 3, method: "ping" }, makeBackend());
  assert.deepStrictEqual(resp.result, {});
});

test("notifications/initialized 不回包", async () => {
  const resp = await handleRequest({ method: "notifications/initialized" }, makeBackend());
  assert.strictEqual(resp, null);
});

test("无 id 的任意方法都视为通知（含 roots/list_changed）", async () => {
  for (const method of ["notifications/roots/list_changed", "notifications/cancelled", "tools/list", "resources/list"]) {
    const resp = await handleRequest({ jsonrpc: "2.0", method }, makeBackend());
    assert.strictEqual(resp, null, `method=${method}`);
  }
});

test("非对象请求返回 -32600", async () => {
  for (const bad of [null, undefined, 123, "str", true, []]) {
    const resp = await handleRequest(bad, makeBackend());
    assert.strictEqual(resp.error.code, -32600, `req=${JSON.stringify(bad)}`);
    assert.strictEqual(resp.id, null);
  }
});

test("id 为 0 或 null 时正常回包（不是通知）", async () => {
  const zero = await handleRequest({ jsonrpc: "2.0", id: 0, method: "ping" }, makeBackend());
  assert.strictEqual(zero.id, 0);
  assert.deepStrictEqual(zero.result, {});

  const nul = await handleRequest({ jsonrpc: "2.0", id: null, method: "ping" }, makeBackend());
  assert.strictEqual(nul.id, null);
  assert.deepStrictEqual(nul.result, {});
});

test("tools/list 归一化 inputSchema", async () => {
  const resp = await handleRequest({ id: 4, method: "tools/list" }, makeBackend());
  assert.strictEqual(resp.result.tools.length, 1);
  assert.deepStrictEqual(resp.result.tools[0], {
    name: "doc_read",
    description: "读取文档",
    inputSchema: { type: "object", properties: {} }
  });
});

test("tools/list 在 plugin 离线（503）时返回空数组", async () => {
  const backend = makeBackend({
    async listTools() { return { status: 503, ok: false, error: "plugin 未连接" }; }
  });
  const resp = await handleRequest({ id: 5, method: "tools/list" }, backend);
  assert.deepStrictEqual(resp.result, { tools: [] });
  assert.strictEqual(resp.error, undefined);
});

test("tools/list 其他错误返回 -32000", async () => {
  const backend = makeBackend({
    async listTools() { return { status: 500, ok: false, error: "boom" }; }
  });
  const resp = await handleRequest({ id: 6, method: "tools/list" }, backend);
  assert.strictEqual(resp.error.code, -32000);
  assert.match(resp.error.message, /boom/);
});

test("tools/list 失败且无 status/error 时返回 -32000 且消息含 unknown", async () => {
  const backend = makeBackend({ async listTools() { return { ok: false }; } });
  const resp = await handleRequest({ id: 61, method: "tools/list" }, backend);
  assert.strictEqual(resp.error.code, -32000);
  assert.match(resp.error.message, /unknown/);
});

test("tools/call 成功把对象序列化为 text", async () => {
  const resp = await handleRequest(
    { id: 7, method: "tools/call", params: { name: "doc_read", arguments: { path: "a.docx" } } },
    makeBackend()
  );
  assert.strictEqual(resp.result.isError, undefined);
  assert.strictEqual(resp.result.content[0].type, "text");
  assert.deepStrictEqual(JSON.parse(resp.result.content[0].text), { name: "doc_read", args: { path: "a.docx" } });
});

test("tools/call 字符串结果原样返回", async () => {
  const backend = makeBackend({ async callTool() { return { ok: true, value: "纯文本结果" }; } });
  const resp = await handleRequest({ id: 8, method: "tools/call", params: { name: "x" } }, backend);
  assert.strictEqual(resp.result.content[0].text, "纯文本结果");
});

test("tools/call 失败返回 isError", async () => {
  const backend = makeBackend({ async callTool() { return { ok: false, error: "工具炸了" }; } });
  const resp = await handleRequest({ id: 9, method: "tools/call", params: { name: "x" } }, backend);
  assert.strictEqual(resp.result.isError, true);
  assert.strictEqual(resp.result.content[0].text, "工具炸了");
});

test("tools/call value 为 undefined 时 text 为空字符串", async () => {
  const backend = makeBackend({ async callTool() { return { ok: true, value: undefined }; } });
  const resp = await handleRequest({ id: 91, method: "tools/call", params: { name: "x" } }, backend);
  assert.strictEqual(resp.result.isError, undefined);
  assert.strictEqual(typeof resp.result.content[0].text, "string");
  assert.strictEqual(resp.result.content[0].text, "");
});

test("tools/call 传输层失败返回 -32000（区别于工具失败）", async () => {
  const backend = makeBackend({
    async callTool() { return { ok: false, transport: true, error: "调用 WPS 工具失败: HTTP 502" }; }
  });
  const resp = await handleRequest({ id: 92, method: "tools/call", params: { name: "x" } }, backend);
  assert.strictEqual(resp.error.code, -32000);
  assert.match(resp.error.message, /HTTP 502/);
  assert.strictEqual(resp.result, undefined);
});

test("tools/call 缺 name 返回 -32602", async () => {
  const resp = await handleRequest({ id: 10, method: "tools/call", params: {} }, makeBackend());
  assert.strictEqual(resp.error.code, -32602);
});

test("未知方法返回 -32601", async () => {
  const resp = await handleRequest({ id: 11, method: "resources/list" }, makeBackend());
  assert.strictEqual(resp.error.code, -32601);
});

test("backend 抛异常时返回 -32603 且不冒泡", async () => {
  const backend = makeBackend({ async listTools() { throw new Error("kaboom"); } });
  const resp = await handleRequest({ id: 12, method: "tools/list" }, backend);
  assert.strictEqual(resp.error.code, -32603);
  assert.match(resp.error.message, /kaboom/);
});

test("normalizeTools 容错非数组输入", () => {
  assert.deepStrictEqual(normalizeTools(null), []);
  assert.deepStrictEqual(normalizeTools("x"), []);
});
