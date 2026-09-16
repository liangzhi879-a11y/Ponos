// kernel-tests/mcp-auth-tools.test.mjs
// MCP 授权档位是否真的作用到 **AI 收到的工具表**（进程级端到端，验收项 5/6/7 的固化）。
//
// 为什么必须看到"请求体的 tools"：
//   · `/mcp/status` 的 servers[].tools **不做可见性过滤**（面板要展示"台子上有什么"），
//     所以它**无法**证明"这个 AI 看不到它"；
//   · `init` 帧的 tools 也不行 —— MCP 是**异步就绪**的（cli.mjs 里 `mcpRegistry.ready().then(...)`
//     才上报），init 发出时 `view()` 还返回 {}，故 init 里没有 MCP 工具是**预期**的
//     （首版验证脚本正是用 init 观测，得到"三档全不可见"的假失败）。
//   · 唯一可信的证据是内核真正发给模型的那份 tools。
//
// 手法沿用仓库既有先例 app-tools-mount.test.mjs：本机起假 Anthropic 端点（SSE），
// 内核经 PONOS_BASE_URL 直连；用 `system/mcp_status` 作为"MCP 已就绪"的信号，
// 之后再发消息，取请求体的 tools。全程无网络、无费用。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const KERNEL_CLI = fileURLToPath(new URL('../kernel/cli.mjs', import.meta.url))
const STUB = fileURLToPath(new URL('./fixtures/mcp-stub-server.mjs', import.meta.url))
const SESSION = 'mcp-auth-0000-0000-0000-000000000001'
const STUB_TOOLS = 5
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 假 Anthropic 端点：记录请求体（工具表断言只读它），回一个纯文本收尾 */
async function startApi() {
  const bodies = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => { raw += d })
    req.on('end', () => {
      try { bodies.push(JSON.parse(raw)) } catch { bodies.push({}) }
      const sse = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      sse({ type: 'message_start', message: { role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 0 } } })
      sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '收到。' } })
      sse({ type: 'content_block_stop', index: 0 })
      sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })
      sse({ type: 'message_stop' })
      res.end()
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { bodies, port: server.address().port, close: () => new Promise((r) => server.close(r)) }
}

function spawnKernel(home, port, agentId) {
  const argv = [KERNEL_CLI, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--resume', SESSION, '--add-dir', home]
  if (agentId) argv.push('--agent', agentId)
  const proc = spawn(process.execPath, argv, {
    env: {
      ...process.env,
      PONOS_MOCK_API: '',                       // 走真实 HTTP 路径（假端点在本地）
      PONOS_BASE_URL: `http://127.0.0.1:${port}`,
      PONOS_AUTH_TOKEN: 'test-token',
      PONOS_MODEL: 'test-model',
      PONOS_CONFIG_DIR: home,
      YFW_HOME: home,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const events = []
  let buf = ''
  let err = ''
  proc.stdout.on('data', (d) => {
    buf += d
    const lines = buf.split('\n'); buf = lines.pop()
    for (const line of lines) { if (!line.trim()) continue; try { events.push(JSON.parse(line)) } catch { /* 半行 */ } }
  })
  proc.stderr.on('data', (d) => { err += d })
  return { proc, events, send: (o) => proc.stdin.write(JSON.stringify(o) + '\n'), get err() { return err } }
}

async function waitFor(fn, ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = fn()
    if (v) return v
    await sleep(50)
  }
  return null
}

/** 取"这个会话的 AI 实际收到的 mcp__ 工具名"。先等 mcp_status（就绪信号）再发消息 */
async function mcpToolsSeenBy(home, agentId) {
  const api = await startApi()
  const k = spawnKernel(home, api.port, agentId)
  try {
    assert.ok(await waitFor(() => k.events.find((e) => e.type === 'system' && e.subtype === 'init'), 30000),
      `${agentId ?? '主会话'}：应收到 init 帧\nstderr=${k.err.slice(-400)}`)
    // MCP 就绪信号：收到它之后，工具表里才会（且必然会）出现 MCP 工具
    assert.ok(await waitFor(() => k.events.find((e) => e.type === 'system' && e.subtype === 'mcp_status'), 40000),
      `${agentId ?? '主会话'}：应收到 mcp_status（MCP 就绪信号）\nstderr=${k.err.slice(-400)}`)
    k.send({ type: 'user', session_id: SESSION, message: { role: 'user', content: '你好' } })
    const body = await waitFor(() => api.bodies.find((b) => Array.isArray(b.tools) && b.tools.length), 30000)
    assert.ok(body, `${agentId ?? '主会话'}：应向模型发出请求体\nstderr=${k.err.slice(-400)}`)
    return body.tools.map((t) => String(t.name)).filter((n) => n.startsWith('mcp__')).sort()
  } finally {
    try { k.proc.kill() } catch { /* 已退出 */ }
    await api.close()
  }
}

/** 三台桩服务器：一公开、一仅测试、一绑定给 researcher */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'yfw-mcp-auth-'))
  const mk = () => ({ command: process.execPath, args: [STUB], timeoutMs: 15000 })
  writeFileSync(join(home, 'mcp.json'), JSON.stringify({
    servers: {
      pub: { ...mk(), expose: { mode: 'public' } },
      priv: { ...mk(), expose: { mode: 'private' } },
      bnd: { ...mk(), expose: { mode: 'bound', bindAgents: ['researcher'] } },
    },
  }, null, 2), 'utf-8')
  return home
}

test('授权档位决定 AI 工具表：仅测试谁都不给、公开给所有人、指定 agent 只给列出的', { timeout: 180000 }, async () => {
  const home = fixture()
  try {
    // ① 主会话（agentId = null）
    const main = await mcpToolsSeenBy(home, null)
    assert.equal(main.length, STUB_TOOLS, `主会话应只见 public 一台（${STUB_TOOLS} 个工具），实际 ${JSON.stringify(main)}`)
    assert.ok(main.every((n) => n.startsWith('mcp__pub__')), `主会话只应见 public 的工具，实际 ${JSON.stringify(main)}`)
    assert.equal(main.filter((n) => n.startsWith('mcp__priv__')).length, 0, '仅测试档：连上了也不给任何 AI')
    assert.equal(main.filter((n) => n.startsWith('mcp__bnd__')).length, 0,
      'bound 对主会话不可见（与 dyntools.visibilityOf 同义，不引入第二套规则）')

    // ② 被 bound 指定的 agent：public + bound
    const researcher = await mcpToolsSeenBy(home, 'researcher')
    assert.equal(researcher.length, STUB_TOOLS * 2, `researcher 应见 public + bound 两台，实际 ${JSON.stringify(researcher)}`)
    assert.ok(researcher.some((n) => n.startsWith('mcp__pub__')), 'public 仍可见')
    assert.ok(researcher.some((n) => n.startsWith('mcp__bnd__')), 'bound 对列出的 agent 可见')
    assert.equal(researcher.filter((n) => n.startsWith('mcp__priv__')).length, 0, '仅测试档对任何 agent 都不可见')

    // ③ 未被指定的 agent：与主会话同（只有 public）
    const other = await mcpToolsSeenBy(home, 'other')
    assert.equal(other.length, STUB_TOOLS, `other 应只见 public，实际 ${JSON.stringify(other)}`)
    assert.equal(other.filter((n) => n.startsWith('mcp__bnd__')).length, 0, 'bound 对未列出的 agent 不可见')

    // ④ 工具描述带来源前缀，且 schema 可用（"找不到调用入口"修复的最终判据）
    const api = await startApi()
    const k = spawnKernel(home, api.port, null)
    try {
      assert.ok(await waitFor(() => k.events.find((e) => e.type === 'system' && e.subtype === 'mcp_status'), 40000))
      k.send({ type: 'user', session_id: SESSION, message: { role: 'user', content: '你好' } })
      const body = await waitFor(() => api.bodies.find((b) => (b.tools || []).some((t) => String(t.name).startsWith('mcp__'))), 30000)
      assert.ok(body, '应发出含 MCP 工具的请求体')
      const t = body.tools.find((x) => x.name === 'mcp__pub__echo')
      assert.ok(t, `请求体应含 mcp__pub__echo，实际 ${JSON.stringify(body.tools.filter((x) => String(x.name).startsWith('mcp__')).map((x) => x.name))}`)
      assert.match(String(t.description), /^\[MCP:pub\]/, '描述须带来源前缀（让用户与模型都能看出这是外部工具）')
      assert.equal(t.input_schema?.type, 'object', 'input_schema 必须可用，否则模型无法调用')
    } finally {
      try { k.proc.kill() } catch { /* 已退出 */ }
      await api.close()
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
