// 应用即工具「真的被挂载」——进程级端到端（Task 4.2/4.3 的验收测试）
// ---------------------------------------------------------------------------
// 为什么必须起真进程：内核是独立进程，「绑定 → 工具进池 → 模型可调用 → 执行经桥回到
// 宿主 → 结果回填」这条链跨 cli.mjs（视图函数挂载）/ engine.mjs（桥挂起）/ bridge 路由
// 三层，任何一层漏接都只有"在真进程里跑一次"才看得出来（源码字符串断言查不出来）。
//
// 手法：本机起一个假 Anthropic 端点（SSE），内核经 PONOS_BASE_URL 直连它——
//   ① 从内核 init 帧的 tools 与真实请求体的 tools 断言 app_* 工具**确实进了工具表**；
//   ② 假端点回一个 app_* 的 tool_use，内核必然发出 bridge_request(route=app)
//      （= bridge 侧要转给主进程执行器的那条消息），测试扮演 bridge 回写 app_response；
//   ③ 断言工具结果里出现回执数据（证明"执行能力经桥往返"真的通了，而不是空转）。
// 反向用例：无绑定 → 工具表里不得出现任何 app_*，也不得发出 route=app 的桥请求。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appToolName } from '../kernel/app-naming.mjs'

const KERNEL_CLI = process.env.YFW_TEST_KERNEL_CLI || fileURLToPath(new URL('../kernel/cli.mjs', import.meta.url))
const SESSION = 'app-mount-0000-0000-0000-000000000001'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Windows：刚 kill 的子进程仍持有 cwd/handle 时 rmSync 会 EPERM（内核工作根就在临时目录里）。
// 并发跑（--test-concurrency=4）时子进程退出更慢，这个竞态会让用例在 finally 里**假失败**——
// 实测在本仓库全量跑时命中过一次（断言全过、仅清理抛 EPERM）。重试兜底是本仓库既有做法
// （见 kernel-tests/app-page-scope.test.mjs、server/answer-resume.test.mjs）。
function rmSyncRetry(path, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try { rmSync(path, { recursive: true, force: true }); return } catch (e) {
      if (i === attempts - 1) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
  }
}

const READ_CMD = { action: 'queryOrder', title: '查询订单', kind: 'read', params: [{ name: 'orderId', type: 'string', required: true }], steps: [{ act: 'goto', url: '/' }] }

/** 临时 configDir：<dir>/apps 下放 registry/spec/binding（内核读的同一份数据根） */
function fixture({ bind = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'appmount-'))
  const apps = join(dir, 'apps')
  mkdirSync(join(apps, 'app-a'), { recursive: true })
  writeFileSync(join(apps, 'registry.json'), JSON.stringify({ version: 1, apps: [{ id: 'app-a', name: '甲系统', targetType: 'web', enabled: true }] }), 'utf-8')
  const spec = { specVersion: 1, appId: 'app-a', name: '甲系统', target: { type: 'web', url: 'https://example.com' }, expose: { mode: 'console' }, commands: [READ_CMD] }
  writeFileSync(join(apps, 'app-a', 'spec.json'), JSON.stringify(spec), 'utf-8')
  if (bind) writeFileSync(join(apps, 'binding.json'), JSON.stringify({ [SESSION]: { appId: 'app-a', boundAt: '2026-09-13T00:00:00Z' } }), 'utf-8')
  return { dir, spec }
}

/**
 * 假 Anthropic 端点：第一轮回 app_* 的 tool_use（名字取自内核真实送来的 tools 列表）；
 * 之后（历史里已出现 tool_result）回文本收尾。记录每个请求体供工具表断言。
 */
async function startApi() {
  const bodies = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => { raw += d })
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(raw) } catch { /* 非 JSON 请求：按空处理 */ }
      bodies.push(body)
      const sse = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      sse({ type: 'message_start', message: { role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 0 } } })
      sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      const hasToolResult = JSON.stringify(body.messages || []).includes('tool_result')
      const appTool = (body.tools || []).find((t) => String(t.name || '').startsWith('app_'))
      if (!hasToolResult && appTool) {
        sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '调用应用命令。' } })
        sse({ type: 'content_block_stop', index: 0 })
        sse({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_app_1', name: appTool.name, input: {} } })
        sse({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"orderId":"A1"}' } })
        sse({ type: 'content_block_stop', index: 1 })
        sse({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } })
      } else {
        sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: hasToolResult ? '命令已完成。' : '未挂载应用工具。' } })
        sse({ type: 'content_block_stop', index: 0 })
        sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })
      }
      sse({ type: 'message_stop' })
      res.end()
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    bodies,
    port: server.address().port,
    close: () => new Promise((r) => server.close(r)),
  }
}

function spawnKernel(dir, port, { answerApp }) {
  const proc = spawn(process.execPath, [
    KERNEL_CLI, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--resume', SESSION, '--add-dir', dir,
  ], {
    env: {
      ...process.env,
      PONOS_MOCK_API: '', // 本测试走真实 HTTP 路径（假端点在本地）
      PONOS_BASE_URL: `http://127.0.0.1:${port}`,
      PONOS_AUTH_TOKEN: 'test-token',
      PONOS_MODEL: 'test-model',
      PONOS_CONFIG_DIR: dir,
      YFW_HOME: dir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const events = []
  let buf = ''
  let err = ''
  proc.stdout.on('data', (d) => {
    buf += d
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      let ev = null
      try { ev = JSON.parse(line) } catch { continue }
      events.push(ev)
      // 扮演 bridge：内核的 bridge_request(route=app) → 回写 control_request(app_response)
      if (answerApp && ev.type === 'bridge_request' && ev.route === 'app') {
        proc.stdin.write(JSON.stringify({
          type: 'control_request',
          request: { subtype: 'app_response', requestId: ev.requestId, ok: true, data: { orderId: 'A1', status: 'paid' }, error: null, kind: 'read', durationMs: 7 },
        }) + '\n')
      }
    }
  })
  proc.stderr.on('data', (d) => { err += d })
  return {
    proc, events,
    send: (o) => proc.stdin.write(JSON.stringify(o) + '\n'),
    get err() { return err },
    get stdout() { return events },
  }
}

async function waitFor(fn, ms = 15000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = fn()
    if (v) return v
    await sleep(50)
  }
  return null
}

test('绑定到本会话 → app_* 工具真的进了工具表（init + 请求体），且执行经桥往返回到模型', async () => {
  const { dir, spec } = fixture({ bind: true })
  const api = await startApi()
  const k = spawnKernel(dir, api.port, { answerApp: true })
  const expected = appToolName(spec, 'queryOrder')
  try {
    const init = await waitFor(() => k.events.find((e) => e.type === 'system' && e.subtype === 'init'))
    assert.ok(init, `应收到 init 帧\nstderr=${k.err.slice(-500)}`)
    assert.equal(init.session_id, SESSION, 'session 身份应为 binding.json 的键（--resume 固定）')
    assert.ok(Array.isArray(init.tools) && init.tools.includes(expected),
      `init.tools 应含 ${expected}（实际 ${JSON.stringify(init.tools)}）`)

    k.send({ type: 'user', session_id: SESSION, message: { role: 'user', content: '帮我查一下 A1 订单' } })

    // ① 工具 schema 真的发给了模型（挂载的最终判据）
    const first = await waitFor(() => api.bodies.find((b) => Array.isArray(b.tools) && b.tools.some((t) => t.name === expected)))
    assert.ok(first, `请求体 tools 应含 ${expected}`)
    const sent = first.tools.find((t) => t.name === expected)
    assert.equal(sent.input_schema.type, 'object')
    assert.match(String(sent.description), /^\[甲系统\] 查询订单/)

    // ② 执行经桥：内核发出 bridge_request(route=app)，载荷 = 应用/命令/参数/session
    const br = await waitFor(() => k.events.find((e) => e.type === 'bridge_request' && e.route === 'app'))
    assert.ok(br, `应发出 bridge_request(route=app)\nstdout=${JSON.stringify(k.events.slice(-6))}\nstderr=${k.err.slice(-400)}`)
    assert.equal(br.payload.appId, 'app-a')
    assert.equal(br.payload.action, 'queryOrder')
    assert.deepEqual(br.payload.args, { orderId: 'A1' })
    assert.equal(br.payload.sessionId, SESSION)

    // ③ app_response 回执 → 工具结果（证明"执行能力经桥往返"不是空转）
    const tr = await waitFor(() => k.events.find((e) => e.type === 'tool_result' && String(e.content || '').includes('paid')))
    assert.ok(tr, `工具结果应含回执数据\nstdout=${JSON.stringify(k.events.slice(-6))}`)
    assert.equal(tr.is_error, false)
    assert.match(String(tr.content), /执行完成/)

    // ④ 轮次正常收尾（工具错误不得中断 turn）
    const res = await waitFor(() => k.events.find((e) => e.type === 'result'))
    assert.ok(res, '应正常产出 result')
  } finally {
    try { k.proc.kill() } catch { /* 已退出 */ }
    await api.close()
    rmSyncRetry(dir)
  }
})

test('未绑定本会话 → 工具表里没有任何 app_*，也不发 route=app 桥请求（fail-closed）', async () => {
  const { dir } = fixture({ bind: false })
  const api = await startApi()
  const k = spawnKernel(dir, api.port, { answerApp: false })
  try {
    const init = await waitFor(() => k.events.find((e) => e.type === 'system' && e.subtype === 'init'))
    assert.ok(init, `应收到 init 帧\nstderr=${k.err.slice(-500)}`)
    assert.equal((init.tools || []).filter((n) => String(n).startsWith('app_')).length, 0,
      `未绑定不得出现 app_* 工具（实际 ${JSON.stringify(init.tools)}）`)

    k.send({ type: 'user', session_id: SESSION, message: { role: 'user', content: '查一下订单' } })
    const res = await waitFor(() => k.events.find((e) => e.type === 'result'))
    assert.ok(res, `应正常产出 result\nstderr=${k.err.slice(-400)}`)
    const body = api.bodies[0] || {}
    assert.equal((body.tools || []).filter((t) => String(t.name).startsWith('app_')).length, 0, '请求体不得含 app_* 工具')
    assert.equal(k.events.filter((e) => e.type === 'bridge_request' && e.route === 'app').length, 0, '不得发出应用桥请求')
  } finally {
    try { k.proc.kill() } catch { /* 已退出 */ }
    await api.close()
    rmSyncRetry(dir)
  }
})
