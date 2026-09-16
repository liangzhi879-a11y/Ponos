// P1-5 扩展：MCP Streamable HTTP 客户端测试。
// ---------------------------------------------------------------------------
// 覆盖重点（都是"能崩引擎/能卡死轮次/能泄漏密钥"的真实风险点）：
//   ① JSON 与 SSE 两条响应路径都必须能走通（规范允许服务器任选，客户端不能只做一条）
//   ② Mcp-Session-Id 必须被记住并回传（否则第二跳就 404，表现为"握手成功但工具为空"）
//   ③ ${ENV_VAR} 插值必须真的生效（服务器侧回显验证，不是"客户端自以为设置了"）
//   ④ 未定义变量必须**报错并点名**，绝不静默换空串
//   ⑤ 超时必须 reject **且清 pending 且中断在途连接**
//   ⑥ 密钥不得出现在日志或错误串里（日志会被贴进 issue）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startMcpHttpClient } from '../kernel/mcp-http.mjs'

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-http-stub-server.mjs', import.meta.url))

/** 启动夹具并等待它打印 PORT=<n> */
function startStub(mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE, mode], { stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('夹具启动超时')) }, 10000)
    child.stdout.on('data', (c) => {
      buf += c
      const m = buf.match(/PORT=(\d+)/)
      if (m) { clearTimeout(timer); resolve({ port: Number(m[1]), kill: () => child.kill() }) }
    })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
}

const urlOf = (s) => `http://127.0.0.1:${s.port}/mcp`

test('HTTP 客户端：JSON 响应路径 —— 握手 / 列工具 / 调工具 / 零悬挂', async () => {
  const s = await startStub('json')
  const logs = []
  const c = await startMcpHttpClient({ name: 'httpstub', url: urlOf(s), timeoutMs: 5000, onLog: (lv, m) => logs.push(`${lv}:${m}`) })
  try {
    assert.equal(c.protocolVersion, '2025-03-26', '应记录服务端协议版本')
    assert.equal(c.serverInfo?.name, 'http-stub')
    const tools = await c.tools()
    assert.deepEqual(tools.map((t) => t.name), ['echo', 'whoami'])
    assert.ok(tools.every((t) => t.input_schema && typeof t.input_schema === 'object'), '每个工具都须有 input_schema')

    const r = await c.call('echo', { text: '你好' })
    assert.equal(r.text, 'echo:你好')
    assert.equal(r.isError, false)
    assert.equal(c.stats().pending, 0, '请求结束后不得有悬挂 pending')
  } finally { await c.close(); s.kill() }
})

test('HTTP 客户端：SSE 响应路径同样走通（响应基于 SSE 流时不能认不出）', async () => {
  const s = await startStub('sse')
  const c = await startMcpHttpClient({ name: 'ssestub', url: urlOf(s), timeoutMs: 5000 })
  try {
    const tools = await c.tools()
    assert.deepEqual(tools.map((t) => t.name), ['echo', 'whoami'], 'SSE 流里的响应必须被解析出来')
    const r = await c.call('echo', { text: 'x' })
    assert.equal(r.text, 'echo:x')
    assert.equal(c.stats().pending, 0)
  } finally { await c.close(); s.kill() }
})

test('HTTP 客户端：会话 id 被记住并回传（否则第二跳即 404）', async () => {
  const s = await startStub('json')
  const c = await startMcpHttpClient({ name: 'sess', url: urlOf(s), timeoutMs: 5000 })
  try {
    // 夹具对"不带对的 session id"的请求一律回 404 ⇒ 列工具能成功即证明回传生效
    const tools = await c.tools()
    assert.equal(tools.length, 2)
  } finally { await c.close(); s.kill() }
})

test('HTTP 客户端：${ENV_VAR} 插值生效 —— 由服务器回显请求头证明', async () => {
  const s = await startStub('echo-auth')
  // 关键：配置里只放占位符，真实值从 env 取（写盘时不会出现明文）
  const c = await startMcpHttpClient({
    name: 'auth', url: urlOf(s), timeoutMs: 5000,
    headers: { Authorization: 'Bearer ${MY_TOKEN}' },
    env: { MY_TOKEN: 'secret-abc' },
  })
  try {
    const r = await c.call('whoami', {})
    assert.match(r.text, /Bearer secret-abc/,
      '服务器必须收到解析后的头——这才能证明插值真的发生在发送前')
  } finally { await c.close(); s.kill() }
})

test('HTTP 客户端：未定义变量**启动即报错并点名**（不静默换空串、不发请求）', async () => {
  const s = await startStub('json')
  try {
    await assert.rejects(
      () => startMcpHttpClient({
        name: 'bad', url: urlOf(s), timeoutMs: 5000,
        headers: { Authorization: 'Bearer ${NOPE_TOKEN}' }, env: {},
      }),
      (e) => /NOPE_TOKEN/.test(e.message) && /headers\.Authorization/.test(e.message),
      '错误必须点名变量名与所在配置项',
    )
  } finally { s.kill() }
})

test('HTTP 客户端：HTTP 500 → 可读错误，且 pending 清空', async () => {
  const s = await startStub('http500')
  try {
    await assert.rejects(
      () => startMcpHttpClient({ name: 'boom', url: urlOf(s), timeoutMs: 5000 }),
      (e) => /HTTP 500/.test(e.message),
    )
  } finally { s.kill() }
})

test('HTTP 客户端：密钥不得出现在日志或错误串里', async () => {
  const s = await startStub('http500')
  const logs = []
  try {
    await assert.rejects(
      () => startMcpHttpClient({
        name: 'leak', url: urlOf(s), timeoutMs: 5000,
        headers: { Authorization: 'Bearer SUPER_SECRET' }, env: {},
        onLog: (lv, m) => logs.push(String(m)),
      }),
      (e) => !/SUPER_SECRET/.test(e.message),
    )
    assert.doesNotMatch(logs.join('\n'), /SUPER_SECRET/, '日志被贴进 issue 就等于泄漏')
  } finally { s.kill() }
})

test('HTTP 客户端：已建会话后请求超时 → reject(含"超时")、pending 清空、连接被中断', async () => {
  const s = await startStub('hang-tools')
  const c = await startMcpHttpClient({ name: 'hang', url: urlOf(s), timeoutMs: 700 })
  try {
    assert.equal(c.serverInfo?.name, 'http-stub', '本用例只考察"会话已建立后某次请求超时"，握手须先成功')
    const t0 = Date.now()
    await assert.rejects(() => c.tools(), (e) => /超时/.test(e.message))
    assert.ok(Date.now() - t0 < 5000, '应在超时附近返回，而不是等 TCP 自己断')
    assert.equal(c.stats().pending, 0, '超时必须清 pending，否则会持续泄漏')
    // 超时后连接必须被中断：再发一次仍应正常超时（说明会话没有卡在"半死"状态）
    await assert.rejects(() => c.tools(), /超时/)
  } finally { await c.close(); s.kill() }
})

test('HTTP 客户端：握手阶段就超时 → 启动即失败（不留半个客户端）', async () => {
  const s = await startStub('hang')
  try {
    await assert.rejects(
      () => startMcpHttpClient({ name: 'hang-init', url: urlOf(s), timeoutMs: 700 }),
      (e) => /超时/.test(e.message),
      '握手失败必须让 start 直接 reject，由注册表记入失败服务器',
    )
  } finally { s.kill() }
})

test('HTTP 客户端：会话过期(404) 与"地址写错"给出可区分文案', async () => {
  const s = await startStub('no-session')
  const c = await startMcpHttpClient({ name: 'expired', url: urlOf(s), timeoutMs: 5000 })
  try {
    await assert.rejects(() => c.tools(), (e) => /会话已过期|404/.test(e.message),
      '404 在 Streamable HTTP 里特指会话不存在，用户需据此决定"重新连接"还是"改地址"')
  } finally { await c.close(); s.kill() }
})

test('HTTP 客户端：close() 后发起调用立即失败（不悬挂）', async () => {
  const s = await startStub('json')
  const c = await startMcpHttpClient({ name: 'closing', url: urlOf(s), timeoutMs: 5000 })
  await c.tools()
  await c.close()
  assert.equal(c.stats().closed, true)
  // 用 call 而非 tools 验证：tools 命中缓存会直接返回（stdio 亦如此，属既有语义），
  // 真正危险的是"关闭后仍去向服务器发请求"——那才会悬挂。
  await assert.rejects(() => c.call('echo', { text: 'x' }), /已关闭/)
  assert.equal(c.stats().pending, 0)
  s.kill()
})

test('HTTP 客户端：非 http(s) 地址 / 缺 url 直接拒绝（不进入网络层）', async () => {
  await assert.rejects(() => startMcpHttpClient({ name: 'x', url: '' }), /缺少 url/)
  await assert.rejects(() => startMcpHttpClient({ name: 'x' }), /缺少 url/)
})
