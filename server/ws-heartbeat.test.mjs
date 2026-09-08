// WS 应用层心跳接线测试（S5 T2 ②-07 WS 半开心跳）
// ---------------------------------------------------------------------------
// 半开语义：TCP 假死时浏览器 send 静默失败且不触发 error/close，仅靠传输层
// ping 无法感知失联 → 应用层 {type:'ping'} → bridge 回 {type:'pong', t}，
// GUI 以「60s 无任何消息」判死强关 ws 走既有指数退避重连（判死在 GUI 侧，
// bridge 只回 pong 不判超时，见 D3）。本测试锁 bridge 应答端接线：
//   - spawn 本库 server/bridge.mjs（node），随机空闲口 + 临时 home + mock；
//   - 连入 WS，send {type:'ping'}，断言收到 {type:'pong'} 且 t 为数值。
// 不 spawn 内核、无网络、不触碰真实 ~/.yfworking / ~/.ponos；finally 收进程清目录。
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

// Windows 并发下子进程句柄释放有延迟，rmSync 会偶发 EPERM——重试兜底
function rmSyncRetry(path, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    try { rmSync(path, { recursive: true, force: true }); return } catch (e) {
      if (i === attempts - 1) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60)
    }
  }
}

// 随机空闲端口：listen(0) 取系统分配端口后关闭（spawn bridge 用 YFW_BRIDGE_PORT 注入）
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

// spawn 本库 bridge：临时 home + mock，stdout 缓冲供 ready 判定，exit 记录供清理
function spawnBridge(home, port) {
  const env = {
    ...process.env,
    PONOS_MOCK_API: '1',
    YFW_BRIDGE_PORT: String(port),
    CLAUDE_CONFIG_DIR: home,
    YFWORKING_HOME: home,
  }
  delete env.PONOS_HOME // 防止宿主演进到解析链
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

// 等 bridge 监听就绪：stdout 出现监听日志行；提前退出/超时即失败
async function waitReady(b, port) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (b.stdoutText().includes(`http+ws://localhost:${port}`)) return
    if (b.state.exitInfo) {
      throw new Error(`bridge exited before ready: ${JSON.stringify(b.state.exitInfo)}; stderr tail: ${b.stderrTail()}`)
    }
    await sleep(50)
  }
  throw new Error(`bridge ready timeout; stdout tail: ${b.stdoutText().slice(-400)}; stderr tail: ${b.stderrTail()}`)
}

// 连入 WS 并等 open（node 全局 WebSocket，v24 内置）
function connectWS(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const timer = setTimeout(() => { ws.close(); reject(new Error('ws open timeout')) }, READY_TIMEOUT_MS)
    ws.onopen = () => { clearTimeout(timer); resolve(ws) }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws connection error')) }
  })
}

// 事件驱动收下一条消息，超时兜底
function nextMessage(ws, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.onmessage = null; reject(new Error(`pong timeout (${timeoutMs}ms)`)) }, timeoutMs)
    ws.onmessage = (ev) => { clearTimeout(timer); resolve(JSON.parse(String(ev.data))) }
  })
}

test('WS 应用层心跳：bridge 收 {type:ping} → 回 {type:pong} 且 t 为数值', async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-hb-home-'))
  const port = await freePort()
  const b = spawnBridge(home, port)
  let ws
  try {
    await waitReady(b, port)
    ws = await connectWS(port)
    ws.send(JSON.stringify({ type: 'ping' }))
    const reply = await nextMessage(ws)
    assert.equal(reply.type, 'pong')
    assert.ok(Number.isFinite(reply.t), 'pong 应携带数值时间戳 t')
  } finally {
    if (ws) { try { ws.close() } catch {} }
    if (b.proc && !b.state.exitInfo) {
      try { b.proc.kill() } catch {}
      await Promise.race([b.exitPromise, sleep(2000)])
    }
    rmSyncRetry(home)
  }
})
