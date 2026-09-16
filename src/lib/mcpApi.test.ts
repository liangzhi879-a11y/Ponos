// src/lib/mcpApi.test.ts
// MCP 配置前端 API 的测试（P1-5 扩展：GUI 配置界面）。
//
// 为什么测这些点（不是凑覆盖率）：
//   ① **永不抛出**：桥没启动/端口不通时若抛出去，React 渲染期直接崩页面，用户看不到任何原因
//   ② **失败不静默**：后端 ok:false（如 mcp.json 损坏）必须把原因透出，否则界面显示"空配置"
//      会误导用户以为配置丢了
//   ③ **body 形状**：PUT 必须发 `{servers}` 整体替换语义，发错形状后端一律 400
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getMcpConfig, saveMcpConfig, testMcpServer, MCP_BASE, type McpServerConfig } from './mcpApi.ts'

/** 用可编排 stub 替换全局 fetch（照 agentsApi.test.ts 范式） */
function stubFetch(handler: (url: string, init?: RequestInit) => { status?: number; body?: unknown; throwErr?: boolean }) {
  const original = globalThis.fetch
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const r = handler(String(url), init)
    if (r.throwErr) throw new Error('network down')
    const status = r.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.body,
    } as unknown as Response
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

const mkServer = (): McpServerConfig => ({ command: 'npx', args: ['-y', 'x'], env: {}, timeoutMs: 5000 })

test('getMcpConfig：成功时返回 servers 与 configPath', async () => {
  const s = stubFetch(() => ({ body: { ok: true, configPath: '/home/u/.yfworking/mcp.json', servers: { demo: { command: 'npx', args: [], env: {} } } } }))
  try {
    const r = await getMcpConfig('http://127.0.0.1:1')
    assert.equal(r.ok, true)
    assert.deepEqual(Object.keys(r.servers), ['demo'])
    assert.equal(r.configPath, '/home/u/.yfworking/mcp.json')
  } finally { s.restore() }
})

test('getMcpConfig：后端 ok:false（配置损坏）→ 降级为空列表但**透出原因**', async () => {
  const s = stubFetch(() => ({ body: { ok: false, error: 'mcp.json 解析失败', configPath: '/x/mcp.json', servers: {} } }))
  try {
    const r = await getMcpConfig('http://127.0.0.1:1')
    assert.equal(r.ok, false)
    assert.deepEqual(r.servers, {}, '损坏时不应编造配置')
    assert.match(String(r.error), /解析失败/, '必须把原因带给界面，否则用户以为配置丢了')
  } finally { s.restore() }
})

test('getMcpConfig：网络异常 → 不抛出，转成可读中文错误', async () => {
  const s = stubFetch(() => ({ throwErr: true }))
  try {
    const r = await getMcpConfig('http://127.0.0.1:1')
    assert.equal(r.ok, false)
    assert.match(String(r.error), /无法连接本地服务/, '桥未启动是可预期情况，必须给出可读文案')
  } finally { s.restore() }
})

test('getMcpConfig：HTTP 500 → ok:false 且带状态码文案', async () => {
  const s = stubFetch(() => ({ status: 500, body: { error: '内部错误' } }))
  try {
    const r = await getMcpConfig('http://127.0.0.1:1')
    assert.equal(r.ok, false)
    assert.equal(r.error, '内部错误', '后端给了 error 就优先用它')
  } finally { s.restore() }
})

test('saveMcpConfig：PUT /mcp 且 body 形状为 {servers}', async () => {
  const s = stubFetch(() => ({ body: { ok: true, servers: { a: { command: 'node', args: [], env: {} } } } }))
  try {
    const r = await saveMcpConfig({ a: { command: 'node', args: [], env: {} } }, 'http://127.0.0.1:1')
    assert.equal(r.ok, true)
    const call = s.calls[0]
    assert.equal(call.init?.method, 'PUT')
    assert.match(String(call.url), /\/mcp$/)
    const body = JSON.parse(String(call.init?.body))
    assert.deepEqual(Object.keys(body), ['servers'], '后端要求 body 必须含 servers')
    assert.equal(body.servers.a.command, 'node')
  } finally { s.restore() }
})

test('saveMcpConfig：校验失败（400）→ ok:false，且不谎报成功', async () => {
  const s = stubFetch(() => ({ status: 400, body: { ok: false, error: '服务器 "x" 缺少 command' } }))
  try {
    const r = await saveMcpConfig({ x: { command: '', args: [], env: {} } }, 'http://127.0.0.1:1')
    assert.equal(r.ok, false)
    assert.match(String(r.error), /缺少 command/, '校验错误必须原样带给用户')
  } finally { s.restore() }
})

test('testMcpServer：成功返回工具列表与 serverInfo', async () => {
  const s = stubFetch(() => ({ body: { ok: true, tools: [{ name: 'echo', description: '回显' }], serverInfo: { name: 'stub', version: '1.0.0' } } }))
  try {
    const r = await testMcpServer(mkServer(), 'http://127.0.0.1:1')
    assert.equal(r.ok, true)
    assert.deepEqual(r.tools?.map((t) => t.name), ['echo'])
    assert.equal(r.serverInfo?.name, 'stub')
    assert.equal(s.calls[0].init?.method, 'POST')
    assert.match(String(s.calls[0].url), /\/mcp\/test$/)
  } finally { s.restore() }
})

test('testMcpServer：连不上（ok:false）→ 是正常业务结果，不抛异常', async () => {
  const s = stubFetch(() => ({ body: { ok: false, error: 'MCP 服务器 x 启动失败: spawn ENOENT' } }))
  try {
    const r = await testMcpServer(mkServer(), 'http://127.0.0.1:1')
    assert.equal(r.ok, false)
    assert.match(String(r.error), /启动失败/, '"连不上"要能显示给用户，而不是崩面板')
  } finally { s.restore() }
})

test('testMcpServer：网络异常同样不抛', async () => {
  const s = stubFetch(() => ({ throwErr: true }))
  try {
    const r = await testMcpServer(mkServer(), 'http://127.0.0.1:1')
    assert.equal(r.ok, false)
    assert.match(String(r.error), /无法连接本地服务/)
  } finally { s.restore() }
})

test('非 JSON 响应（桥返回空体）也要被兜住', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => ({
    ok: true, status: 200,
    json: async () => { throw new Error('not json') },
  })) as unknown as typeof fetch
  try {
    const r = await getMcpConfig('http://127.0.0.1:1')
    assert.equal(r.ok, true, '响应体不可解析时按空配置处理，但不应崩')
    assert.deepEqual(r.servers, {})
  } finally { globalThis.fetch = original }
})

// 【守门用例，2026-09-16】桥真实监听 `YFW_BRIDGE_PORT || 51517`
// （server/bridge.mjs:59 / electron/main.cjs:206 / vite.config.ts:11 三处一致）。
// 而 disabledApi.ts:19、agentsApi.ts:23 硬编码了历史端口 127.0.0.1:3939 —— 若照抄，
// 本页在生产必然「无法连接本地服务」，且单测全绿也发现不了（测试都注入 baseUrl）。
// 这条用例把端口钉死，防回归。
test('兜底基地址必须是桥默认端口 51517，不得回退到历史端口 3939', () => {
  assert.match(MCP_BASE, /:51517$/, 'MCP_BASE 应指向桥默认端口 51517')
  assert.doesNotMatch(MCP_BASE, /3939/, '不得使用历史坏端口 3939（见 disabledApi.ts 的坑）')
})

test('未注入 baseUrl 时走默认解析（不显式传参也不得抛，生产路径）', async () => {
  const s = stubFetch(() => ({ body: { ok: true, servers: {} } }))
  try {
    // 不传 baseUrl ⇒ 走 resolveBaseUrl → getBridgeUrl()（node 下会抛）→ 兜底 MCP_BASE。
    // 关键断言：这条路径绝不抛异常（渲染层安全），且能拿到结构化结果。
    const r = await getMcpConfig()
    assert.equal(r.ok, true)
    assert.equal(s.calls.length, 1, '应确实发出了请求')
  } finally { s.restore() }
})
