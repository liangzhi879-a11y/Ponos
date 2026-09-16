// 停止键永远有效（2026-09-12 尸体事故修复）：cancel 未确认即强杀
// ---------------------------------------------------------------------------
// 背景：旧 cancel 兜底判据 `_lastOutAt > _cancelAt` 只杀"仍在产出"的内核——
// 失活尸体（零输出、事件循环无任务排程）永远不会被强杀，用户点停止面对的
// 是永不响应的进程。新语义：cancel 注入 6s 后未确认（result 未到 / 进程未退）
// 即判尸体，taskkill 强杀；桥随后广播 closed，GUI 解锁。
// 本测试用 [mock:hang-forever] 造真尸体（永久挂起且无视 abort），走完整
// send → cancel → closed 协议链，断言尸体被实际击杀（closed 为证）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { TEST_BRIDGE_TOKEN, withToken } from './test-bridge-auth.mjs'

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
    PONOS_CONFIG_DIR: home,
    YFWORKING_HOME: home,
    YFW_BRIDGE_TOKEN: TEST_BRIDGE_TOKEN,
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
    const ws = new WebSocket(withToken(`ws://127.0.0.1:${port}`))
    const timer = setTimeout(() => { ws.close(); reject(new Error('ws open timeout')) }, READY_TIMEOUT_MS)
    ws.onopen = () => { clearTimeout(timer); resolve(ws) }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws connection error')) }
  })
}

// 事件收集器：hello/cancelled/closed 等按到达顺序记录
function collect(ws, types, timeoutMs) {
  return new Promise((resolve, reject) => {
    const got = []
    const timer = setTimeout(() => reject(new Error(`waiting ${types.join('/')} timeout; got: ${JSON.stringify(got)}`)), timeoutMs)
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data))
      got.push(m.type)
      if (types.every((t) => got.includes(t))) { clearTimeout(timer); resolve(got) }
    }
  })
}

test('尸体内核 + 停止 → 6s 未确认即强杀 + 广播 closed（人工面对可响应实例）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-corpse-'))
  const port = await freePort()
  const b = spawnBridge(home, port)
  let ws
  try {
    await waitReady(b, port)
    ws = await connectWS(port)
    // 首包 = bridge_hello（2026-09-12 桥身份握手）
    const hello = await collect(ws, ['bridge_hello'], 5000)
    assert.ok(hello, '应收到 bridge_hello')
    // 发消息拉起内核：[mock:hang-forever] 永久挂起且无视 abort = 真尸体。
    // cwd 用仓库根而非临时 home：内核 CWD 不锁临时目录（Windows 句柄延迟），
    // 会话数据仍经 PONOS_CONFIG_DIR=home 落进临时目录。
    ws.send(JSON.stringify({ type: 'send', sessionId: 'corpse-sess', prompt: '[mock:hang-forever] 挂住我', cwd: REPO_ROOT }))
    // 等内核 spawn + 挂起：轮询运行 marker（PONOS_CONFIG_DIR=home → home/runs/*.running；
    // 内核启动时写入 {pid,ts}）。结构化日志走 log-tee 不进桥 stdout，故不查 stdout。
    const { existsSync, readdirSync } = await import('node:fs')
    const markerDeadline = Date.now() + 10000
    let spawned = false
    while (Date.now() < markerDeadline) {
      try {
        const rs = readdirSync(join(home, 'runs'))
        if (rs.some((f) => f.endsWith('.running'))) { spawned = true; break }
      } catch {}
      await sleep(100)
    }
    assert.ok(spawned, '内核应已 spawn（home/runs 出现 .running marker）')
    // 等回合真正挂起后再点停止：marker 出现在内核启动时，若立刻 cancel，内核
    // 还没进入回合，会被优雅处理（"cancel effective"——正确行为，测不到尸体路径）。
    // [mock:hang-forever] 的挂起不检查 abort，回合开始后 cancel 必然无应答 → 6s 强杀。
    await sleep(2500)
    ws.send(JSON.stringify({ type: 'cancel', sessionId: 'corpse-sess' }))
    const got = await collect(ws, ['cancelled', 'closed'], 15000)
    assert.ok(got.includes('cancelled'), '应立即广播 cancelled')
    assert.ok(got.includes('closed'), '6s 未确认 → 强杀 → close 事件 → 广播 closed（尸体已死，非仅广播）')
  } finally {
    if (ws) { try { ws.close() } catch {} }
    if (b.proc && !b.state.exitInfo) {
      try { b.proc.kill() } catch {}
      // 确定性等待桥退出（桥持有 home 下的 config/日志句柄；不退出无法删目录）
      await Promise.race([b.exitPromise, sleep(8000)])
    }
    await sleep(500)
    try { rmSyncRetry(home) } catch { /* Windows 句柄延迟释放偶发：清理失败不影响断言，OS 回收临时目录 */ }
  }
})
