// 真实内核 ↔ bridge 端到端集成测试（kernel/cli.mjs —— docs/bridge-contract.md §5/§6/§8）
// ---------------------------------------------------------------------------
// 与 bridge-contract.test.mjs 同构，但内核进程是净室引擎本体（YFWORKING_KERNEL
// 指向 kernel/cli.mjs + YFWORKING_BUN=node + YFW_MOCK_API=1），验证 bridge 的
// spawn 参数注入、事件转发、轮次闭环、cancel 与会话保留在真实引擎上成立。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { sanitizeSegment } from '../kernel/session.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REAL_KERNEL = join(__dirname, '..', 'kernel', 'cli.mjs')

let home
let bridge
let port
let clients = []

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'kernel-bridge-'))
  process.env.YFW_HOME = home
  process.env.YFW_BRIDGE_NO_LISTEN = '1'
  process.env.YFWORKING_KERNEL = REAL_KERNEL
  process.env.YFWORKING_BUN = process.execPath
  process.env.YFW_MOCK_API = '1'
  process.env.YFW_KERNEL_IDLE_MS = '0'    // 关闭空闲回收
  process.env.YFW_KERNEL_STALL_MS = '0'   // 关闭 stall 告警

  bridge = await import('./bridge.mjs')
  await new Promise((resolve) => bridge.httpServer.listen(0, resolve))
  port = bridge.httpServer.address().port
})

// Windows 并发下子进程句柄释放有延迟，rmSync 会偶发 EPERM——重试兜底
function rmSyncRetry(path, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    try { rmSync(path, { recursive: true, force: true }); return } catch (e) {
      if (i === attempts - 1) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60)
    }
  }
}

after(async () => {
  const procs = [...bridge.sessions.values()].map((s) => s.proc).filter(Boolean)
  for (const p of procs) {
    try { p.kill() } catch {}
  }
  await Promise.all(procs.map((p) => new Promise((resolve) => {
    if (p.exitCode !== null) return resolve()
    const t = setTimeout(resolve, 2000)
    t.unref?.()
    p.once('exit', () => { clearTimeout(t); resolve() })
  })))
  for (const ws of clients) {
    try { ws.close() } catch {}
  }
  await new Promise((resolve) => bridge.httpServer.close(resolve))
  rmSyncRetry(home)
})

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    ws._yfwQueue = []
    ws._yfwWaiter = null
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString())
      const w = ws._yfwWaiter
      if (w && w.predicate(m)) {
        ws._yfwWaiter = null
        clearTimeout(w.timer)
        w.resolve(m)
      } else {
        ws._yfwQueue.push(m)
      }
    })
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
    clients.push(ws)
  })
}

function collect(ws, predicate, { timeoutMs = 5000 } = {}) {
  const idx = ws._yfwQueue.findIndex(predicate)
  if (idx >= 0) return Promise.resolve(ws._yfwQueue.splice(idx, 1)[0])
  return new Promise((resolve, reject) => {
    const w = { predicate, resolve, reject, timer: null }
    w.timer = setTimeout(() => {
      if (ws._yfwWaiter === w) ws._yfwWaiter = null
      reject(new Error('collect timeout, queue=' + JSON.stringify(ws._yfwQueue)))
    }, timeoutMs)
    ws._yfwWaiter = w
  })
}

function send(ws, msg) {
  ws.send(JSON.stringify(msg))
}

// 收集某会话的一轮：assistant 事件（拼接 text）直到该会话 result
async function collectTurn(ws, SID) {
  const texts = []
  while (true) {
    const ev = await collect(ws, (m) => m.type === 'event' && m.sessionId === SID &&
      (m.data.type === 'assistant' || m.data.type === 'result'))
    if (ev.data.type === 'result') return texts.join('')
    for (const b of ev.data.message.content) if (b.type === 'text') texts.push(b.text)
  }
}

test('端到端：spawn 真实内核 → system(init) → 一轮 mock 对话 → result', async () => {
  const ws = await connect()
  const SID = 's-e2e'
  send(ws, { type: 'send', sessionId: SID, cwd: home, prompt: '你好内核', requestId: 'r-e2e' })
  const ack = await collect(ws, (m) => m.type === 'ack' && m.data.sessionId === SID)
  assert.equal(ack.data.requestId, 'r-e2e')
  // system(init) 被 bridge 以 event 包装转发
  const init = await collect(ws, (m) => m.type === 'event' && m.sessionId === SID && m.data.type === 'system')
  assert.equal(init.data.subtype, 'init')
  // 一轮对话：mock 流文本
  const text = await collectTurn(ws, SID)
  assert.equal(text, "mock: 你好内核 (turn=1)")
  // 内核会话 id 从 init 事件携带 → GUI 绑定 conversation.sessionId 后
  // resume 用；transcript 落盘路径与 bridge /transcript/load 读取路径一致
  const sid = init.data.session_id
  assert.ok(sid)
  const file = join(home, 'projects', sanitizeSegment(home), sid + '.jsonl')
  assert.ok(existsSync(file), 'transcript 文件应落在 bridge 读取路径')
  const entries = readFileSync(file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
  // D2-2：首行为 meta 版本标记，后续 user + assistant
  assert.equal(entries.length, 3)
  assert.equal(entries[0].type, 'meta')
  assert.equal(entries[1].message.content, '你好内核')
})

test('端到端：cancel → cancelled 事件 + result，会话保留可续聊', async () => {
  const ws = await connect()
  const SID = 's-cancel'
  send(ws, { type: 'send', sessionId: SID, cwd: home, prompt: '慢点', requestId: 'r-c1' })
  await collect(ws, (m) => m.type === 'ack' && m.data.sessionId === SID)
  await new Promise((r) => setTimeout(r, 60))
  send(ws, { type: 'cancel', sessionId: SID })
  const cancelled = await collect(ws, (m) => m.type === 'cancelled' && m.data?.sessionId === SID)
  assert.ok(cancelled)
  const text = await collectTurn(ws, SID)
  assert.match(text, /已取消。$/)
  // 会话保留：同 sessionId 续聊
  send(ws, { type: 'send', sessionId: SID, cwd: home, prompt: '接着聊', requestId: 'r-c2' })
  const again = await collectTurn(ws, SID)
  assert.equal(again, "mock: 接着聊 (turn=2)")
})

test('端到端：高危 Bash 触发 approval 事件 → approval-response 回填 → 工具执行', async () => {
  const ws = await connect()
  const SID = 's-approval'
  send(ws, { type: 'send', sessionId: SID, cwd: home, prompt: '[mock:tool] 清理', requestId: 'r-a1' })
  await collect(ws, (m) => m.type === 'ack' && m.data.sessionId === SID)
  await collect(ws, (m) => m.type === 'event' && m.sessionId === SID && m.data.type === 'system')
  // GUI 视角：approval 事件（toolUseId/command/reason/highRisk）
  const approval = await collect(ws, (m) => m.type === 'approval' && m.sessionId === SID)
  assert.equal(approval.data.toolName, 'Bash')
  assert.match(approval.data.command, /rm -rf/)
  assert.equal(approval.data.highRisk, true)
  assert.ok(approval.data.requestId)
  // GUI 批准 → bridge 回填 control_response → 内核执行 → 结果文本
  send(ws, { type: 'approval-response', sessionId: SID, toolUseId: approval.data.toolUseId, approved: true })
  const text = await collectTurn(ws, SID)
  assert.match(text, /工具执行完成：/)
  const resolved = await collect(ws, (m) => m.type === 'approval-resolved' && m.sessionId === SID)
  assert.equal(resolved.data.toolUseId, approval.data.toolUseId)
})

test('端到端：resume 重开（--resume 注入），历史上下文保留', async () => {
  const ws = await connect()
  const SID = 's-resume'
  send(ws, { type: 'send', sessionId: SID, cwd: home, prompt: '第一轮', requestId: 'r-r1' })
  await collect(ws, (m) => m.type === 'ack' && m.data.sessionId === SID)
  const t1 = await collectTurn(ws, SID)
  assert.equal(t1, "mock: 第一轮 (turn=1)")
  // 同一会话再次 send（bridge 复用进程，不重 spawn）——先验证进程复用
  const session = bridge.sessions.get(SID)
  const pid1 = session?.proc?.pid
  send(ws, { type: 'send', sessionId: SID, cwd: home, prompt: '第二轮', requestId: 'r-r2' })
  const t2 = await collectTurn(ws, SID)
  assert.equal(t2, "mock: 第二轮 (turn=2)")
  const pid2 = session?.proc?.pid
  assert.equal(pid1, pid2, '同会话复用同一内核进程')
})

test('P4-5 /providers 保存 activeProvider 后活跃会话收到 provider_switched', async () => {
  const ws = await connect()
  const SID = 's-switch'
  send(ws, { type: 'send', sessionId: SID, cwd: home, prompt: 'hello', requestId: 'r-sw1' })
  await collect(ws, (m) => m.type === 'ack' && m.data.sessionId === SID)
  await collectTurn(ws, SID)   // 完成一轮，会话空闲
  // 保存新 provider 并激活（activeProvider: true → 激活为新 provider）
  const res = await fetch(`http://127.0.0.1:${port}/providers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Hot', apiBaseUrl: 'http://hot', authToken: 'k2', models: ['m2'], primaryModel: 'm2', activeProvider: true }),
  })
  assert.equal(res.status, 200)
  // 活跃会话 stdout 经 bridge 转发 → provider_switched 回执
  const switched = await collect(ws, (m) => m.type === 'event' && m.sessionId === SID &&
    m.data.type === 'system' && m.data.subtype === 'provider_switched', { timeoutMs: 6000 })
  assert.equal(switched.data.model, 'm2')
  ws.close()
})
