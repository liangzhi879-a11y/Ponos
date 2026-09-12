// 未决等待帧必须在客户端接入时重放（2026-09-12 内核泄漏事故修复）
// ---------------------------------------------------------------------------
// 背景：审批/提问帧只在产生的那一刻广播一次。若那一刻没有 GUI 连接（WS 空窗、重连间隙）
// 或连接刚被心跳判死，帧就永久丢失——内核挂在一个没人看得见的答复上：
//   · 17891979 的审批帧发给了 0 个客户端，此后静默 13 分钟无人回收；
//   · 10:02:28 渲染器 WS 异常断开（1006）2 秒后重连，期间在途帧全部丢失且无重放。
// 新语义：新客户端接入 → 桥把每个会话当前未决的 approval/question 重放给它（仅发给
// 这一个新连接，不打扰既有客户端），并补一帧 first_byte_pending 让"内核静默中"立刻可见。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const BRIDGE_ENTRY = join(REPO_ROOT, 'server', 'bridge.mjs')
const READY_TIMEOUT_MS = 15000

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

function rmSyncRetry(path, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try { rmSync(path, { recursive: true, force: true }); return } catch (e) {
      if (i === attempts - 1) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function spawnBridge(home, port) {
  const env = {
    ...process.env,
    PONOS_MOCK_API: '1',
    YFW_BRIDGE_PORT: String(port),
    CLAUDE_CONFIG_DIR: home,
    YFWORKING_HOME: home,
    YFW_KERNEL_STALL_MS: '0',
    YFW_KERNEL_IDLE_MS: '600000',
  }
  delete env.PONOS_HOME
  const proc = spawn(process.execPath, [BRIDGE_ENTRY], { cwd: REPO_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const out = []
  const state = { exitInfo: null }
  let errTail = ''
  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')
  proc.stdout.on('data', (d) => { out.push(String(d)) })
  proc.stderr.on('data', (d) => { errTail = (errTail + String(d)).slice(-2000) })
  proc.once('exit', (code, signal) => { state.exitInfo = { code, signal } })
  const exitPromise = new Promise((resolve) => proc.once('exit', (code, signal) => resolve({ code, signal })))
  return { proc, state, exitPromise, stdoutText: () => out.join(''), stderrTail: () => errTail }
}

async function waitReady(b, port) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (b.stdoutText().includes(`http+ws://localhost:${port}`)) return
    if (b.state.exitInfo) throw new Error(`bridge exited before ready: ${JSON.stringify(b.state.exitInfo)}`)
    await sleep(50)
  }
  throw new Error('bridge ready timeout; stderr tail: ' + b.stderrTail())
}

function connectWS(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    ws.frames = []
    ws.onmessage = (ev) => { try { ws.frames.push(JSON.parse(String(ev.data))) } catch {} }
    const timer = setTimeout(() => { ws.close(); reject(new Error('ws open timeout')) }, READY_TIMEOUT_MS)
    ws.onopen = () => { clearTimeout(timer); resolve(ws) }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws connection error')) }
  })
}

async function waitApproval(b, ws, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = ws.frames.find((f) => f.type === 'approval')
    if (hit) return hit
    await sleep(100)
  }
  throw new Error('approval frame timeout; bridge stdout: ' + b.stdoutText().split('\n').filter((l) => /approval/.test(l)).join(' | '))
}

test('审批产生时无 GUI 连接（帧广播给 0 个客户端）→ 新客户端接入即收到重放', async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-replay-'))
  const port = await freePort()
  const b = spawnBridge(home, port)
  let ws1, ws2
  try {
    await waitReady(b, port)
    ws1 = await connectWS(port)
    // 触发审批后立刻断开：审批帧到达时 wsClients 为空 → 帧被丢弃（旧行为下永久丢失）
    ws1.send(JSON.stringify({ type: 'send', sessionId: 'replay-sess', prompt: '[mock:tool-catastrophic] 请执行', cwd: REPO_ROOT }))
    const spawnedDeadline = Date.now() + 8000
    while (Date.now() < spawnedDeadline && !b.stdoutText().includes('spawn: replay-')) await sleep(100)
    // 等内核真的挂起在审批上（桥 stdout 会先有 first-token），再断开
    await sleep(1200)
    ws1.close()
    ws1 = null
    await sleep(1500) // 确认窗口内无客户端：审批帧此刻广播给 0 个客户端
    ws2 = await connectWS(port)
    const replayed = await waitApproval(b, ws2)
    assert.equal(replayed.data.replayed, true, '重放帧应带 replayed 标记（与首次广播区分）')
    assert.equal(replayed.data.toolUseId, 'tool_use_mock_catastrophic', '重放必须携带原 toolUseId 才能回填 control_response')
    assert.equal(replayed.data.command, 'rm -rf /', '重放帧需完整重建弹窗所需字段（命令文本）')
    assert.ok(replayed.data.requestId, '重放帧必须带 requestId（回执要靠它匹配内核挂起项）')
    // 年龄透传（2026-09-12）：重放的是"已等待 N 秒"的老弹窗，UI 需据此区分新请求；
    // 超过阈值的项已在重放前丢弃（见 approval-lifecycle.test.mjs 的 B2）
    assert.ok(typeof replayed.data.ageMs === 'number' && replayed.data.ageMs >= 0,
      `重放帧必须带 ageMs（实际 ${JSON.stringify(replayed.data.ageMs)}）`)
    // 回执仍能命中登记项 → 内核解除挂起
    ws2.send(JSON.stringify({ type: 'approval-response', sessionId: 'replay-sess', toolUseId: replayed.data.toolUseId, approved: false }))
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !b.stdoutText().includes('approval-response sid=replay-s')) await sleep(100)
    assert.match(b.stdoutText(), /approval-response sid=replay-s/, '重放后回执必须命中登记项')
  } finally {
    if (ws1) { try { ws1.close() } catch {} }
    if (ws2) { try { ws2.close() } catch {} }
    if (b.proc && !b.state.exitInfo) {
      try { b.proc.kill() } catch {}
      await Promise.race([b.exitPromise, sleep(8000)])
    }
    await sleep(300)
    try { rmSyncRetry(home) } catch { /* Windows 句柄延迟：清理失败不影响断言 */ }
  }
})

test('重放只发给新接入者：既有客户端不重复收到同一条审批（不重复弹窗）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-replay2-'))
  const port = await freePort()
  const b = spawnBridge(home, port)
  let ws1, ws2
  try {
    await waitReady(b, port)
    ws1 = await connectWS(port)
    ws1.send(JSON.stringify({ type: 'send', sessionId: 'replay-two', prompt: '[mock:tool-catastrophic] 请执行', cwd: REPO_ROOT }))
    await waitApproval(b, ws1) // ws1 收到首次广播
    const before = ws1.frames.filter((f) => f.type === 'approval').length
    ws2 = await connectWS(port)
    await waitApproval(b, ws2) // ws2 收到重放
    await sleep(1200)
    const after = ws1.frames.filter((f) => f.type === 'approval').length
    assert.equal(before, 1, '首次广播只应有一条审批帧')
    assert.equal(after, 1, '既有客户端不得因他人接入再收一次（否则重复弹窗）')
    const w2 = ws2.frames.filter((f) => f.type === 'approval')
    assert.equal(w2.length, 1, '新接入者恰好收到一条重放')
    assert.equal(ws2.frames[0].type, 'bridge_hello', '首包仍是 bridge_hello（握手顺序不变）')
  } finally {
    if (ws1) { try { ws1.close() } catch {} }
    if (ws2) { try { ws2.close() } catch {} }
    if (b.proc && !b.state.exitInfo) {
      try { b.proc.kill() } catch {}
      await Promise.race([b.exitPromise, sleep(8000)])
    }
    await sleep(300)
    try { rmSyncRetry(home) } catch { /* Windows 句柄延迟：清理失败不影响断言 */ }
  }
})
