// R4-1 并发会话上限（独立 bridge 实例 + 低上限 env，避免影响其他测试文件）
// 内核 init 上报 capacity（策略内核化）→ bridge 新建会话前检查 sessions.size，
// 超限拒绝并发 error 事件（GUI 零新增，走既有 error 通道）。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REAL_KERNEL = join(__dirname, '..', 'kernel', 'cli.mjs')

let home
let bridge
let port
let clients = []

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'zz-concurrency-'))
  process.env.YFW_HOME = home
  process.env.YFW_BRIDGE_NO_LISTEN = '1'
  process.env.YFWORKING_KERNEL = REAL_KERNEL
  process.env.YFWORKING_BUN = process.execPath
  process.env.YFW_MOCK_API = '1'
  process.env.YFW_KERNEL_IDLE_MS = '0'
  process.env.YFW_KERNEL_STALL_MS = '0'
  process.env.YFW_MAX_CONCURRENT_SESSIONS = '1'   // 上限 1：第二个会话应被拒绝

  bridge = await import('./bridge.mjs')
  await new Promise((resolve) => bridge.httpServer.listen(0, resolve))
  port = bridge.httpServer.address().port
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

after(async () => {
  for (const s of bridge.sessions.values()) {
    try { s.proc?.kill() } catch {}
  }
  for (const ws of clients) {
    try { ws.close() } catch {}
  }
  await new Promise((resolve) => bridge.httpServer.close(resolve))
  try { rmSync(home, { recursive: true, force: true }) } catch {}
})

test('R4-1 并发上限：内核 init 上报 capacity=1；第二个会话被拒（error 事件）', async () => {
  const ws1 = await connect()
  const SID1 = 'c-1'
  send(ws1, { type: 'send', sessionId: SID1, cwd: home, prompt: 'hello', requestId: 'r1' })
  const init = await collect(ws1, (m) => m.type === 'event' && m.sessionId === SID1 && m.data.type === 'system')
  assert.equal(init.data.subtype, 'init')
  assert.equal(Number(init.data.capacity), 1, '内核 init 应上报 capacity=1（来自 env）')

  const ws2 = await connect()
  const SID2 = 'c-2'
  send(ws2, { type: 'send', sessionId: SID2, cwd: home, prompt: 'second', requestId: 'r2' })
  const err = await collect(ws2, (m) => m.type === 'error' && (m.sessionId === SID2 || m.data?.sessionId === SID2))
  assert.match(err.data.message, /已达并发会话上限（1）/, '超限新会话应被拒绝并提示上限')
})
