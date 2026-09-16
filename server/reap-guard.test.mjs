// 回收器豁免必须有时限（2026-09-12 内核泄漏事故修复）
// ---------------------------------------------------------------------------
// 背景：`_turnActive`/`_pendingQuestions`/`_pendingApprovals` 三处豁免都是**无条件**
// 的，而 `_turnActive` 只由 result 帧解除、`_pendingApprovals` 只在用户点审批时删——
// 内核挂死（永不 result）或审批帧发给 0 个客户端（永无人点）时，回收器永不动手：
//   · pid 6736  静默 53 分钟无人回收
//   · pid 21196 静默 13 分钟无人回收（其审批帧发给了 0 个客户端）
//   · 04:43:51 反向事故：提问帧解析失败走 raw 分支未登记 ⇒ 被当空闲回收，作答落空
// 新语义（三条同时成立才算健康）：
//   ① 轮次活跃但静默超 YFW_KERNEL_TURN_REAP_MS（默认 20min）→ 判挂死，强制回收；
//   ② 有未决等待时豁免，但超 YFW_KERNEL_WAIT_EXEMPT_MS（默认 30min）→ 同样回收；
//   ③ 等待被回答/审批回执/工具回吐 tool_result/轮次 result 时**结清**等待态，
//      否则上一个等待期的豁免会被无限延续。
// 本测试用 env 把阈值与扫描周期缩到秒级（全仓无假时钟库，一律缩短真实毫秒）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
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

function spawnBridge(home, port, extraEnv = {}) {
  const env = {
    ...process.env,
    PONOS_MOCK_API: '1',
    YFW_BRIDGE_PORT: String(port),
    PONOS_CONFIG_DIR: home,
    YFWORKING_HOME: home,
    YFW_KERNEL_STALL_MS: '0', // 失速告警与回收无关，关掉以免噪声
    ...extraEnv,
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
    const timer = setTimeout(() => { ws.close(); reject(new Error('ws open timeout')) }, READY_TIMEOUT_MS)
    ws.onopen = () => { clearTimeout(timer); resolve(ws) }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws connection error')) }
  })
}

// 等待某个帧类型到达（其余帧忽略）；返回该帧
function waitFrame(ws, type, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`waiting ${type} timeout`)), timeoutMs)
    const prev = ws.onmessage
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data))
      if (m.type === type) { clearTimeout(timer); resolve(m); return }
      if (prev) prev(ev)
    }
  })
}

// 等内核真起来（home/runs/*.running 由内核启动时写入）
async function waitSpawned(home, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if (readdirSync(join(home, 'runs')).some((f) => f.endsWith('.running'))) return true } catch {}
    await sleep(100)
  }
  return false
}

async function withBridge(extraEnv, fn) {
  const home = mkdtempSync(join(tmpdir(), 'yfw-reap-'))
  const port = await freePort()
  const b = spawnBridge(home, port, extraEnv)
  let ws
  try {
    await waitReady(b, port)
    ws = await connectWS(port)
    await waitFrame(ws, 'bridge_hello', 5000)
    await fn({ b, ws, home, port })
  } finally {
    if (ws) { try { ws.close() } catch {} }
    if (b.proc && !b.state.exitInfo) {
      try { b.proc.kill() } catch {}
      await Promise.race([b.exitPromise, sleep(8000)])
    }
    await sleep(300)
    try { rmSyncRetry(home) } catch { /* Windows 句柄延迟：清理失败不影响断言 */ }
  }
}

test('轮次活跃但永无输出（内核启动即挂）→ 超轮次上限被强制回收', async () => {
  // [mock:hang-forever]：永久挂起且不留定时器 = "异步链失活"签名。
  // 该内核可能一行输出都没有（_lastOutAt 恒 0）——旧代码在 _lastOutAt===0 时直接 continue，
  // 这类会话永远收不掉；新代码改用 _turnStartAt（发消息时刻）计时。
  await withBridge({ YFW_KERNEL_TURN_REAP_MS: '2500', YFW_KERNEL_REAP_TICK_MS: '400', YFW_KERNEL_IDLE_MS: '600000' }, async ({ b, ws, home }) => {
    ws.send(JSON.stringify({ type: 'send', sessionId: 'reap-hang', prompt: '[mock:hang-forever] 挂住', cwd: REPO_ROOT }))
    assert.ok(await waitSpawned(home), '内核应已 spawn')
    const deadline = Date.now() + 15000
    while (Date.now() < deadline && !/stuck turn reaped/.test(b.stdoutText())) await sleep(200)
    assert.match(b.stdoutText(), /stuck turn reaped/, '轮次活跃且长期无输出的会话必须被回收（否则内核泄漏）')
  })
})

test('有未决审批时豁免回收（等待期内不杀），且回答仍能送达内核', async () => {
  // 场景即 17891979 的反面：审批挂起期间内核零输出，绝不能被当空闲/挂死回收——
  // 用户随时可能点下审批。turn 上限故意设得比等待期短（2.5s < 60s）：若等待豁免失效，
  // 轮次分支会先开火，本用例即失败。
  await withBridge({ YFW_KERNEL_TURN_REAP_MS: '2500', YFW_KERNEL_WAIT_EXEMPT_MS: '60000', YFW_KERNEL_REAP_TICK_MS: '400', YFW_KERNEL_IDLE_MS: '600000' }, async ({ b, ws, home }) => {
    ws.send(JSON.stringify({ type: 'send', sessionId: 'reap-wait', prompt: '[mock:tool-catastrophic] 请执行', cwd: REPO_ROOT }))
    assert.ok(await waitSpawned(home), '内核应已 spawn')
    const ap = await waitFrame(ws, 'approval', 12000)
    const toolUseId = ap.data.toolUseId
    await sleep(6000) // 远超轮次上限（2.5s）与多个扫描周期
    assert.doesNotMatch(b.stdoutText(), /reaped/, '未决审批期间不得回收内核')
    // 会话仍在：审批回执被接受（写回内核），而非"no pending approval"
    // 注意：桥日志里的 sid 截断到 8 字符（reap-wait → reap-wai），断言按截断后的写。
    ws.send(JSON.stringify({ type: 'approval-response', sessionId: 'reap-wait', toolUseId, approved: false }))
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !b.stdoutText().includes('approval-response sid=reap-wai')) await sleep(100)
    assert.match(b.stdoutText(), /approval-response sid=reap-wai/, '等待期内核必须存活到用户回执')
    assert.doesNotMatch(b.stdoutText(), /no pending approval/, '回执必须命中登记项（等待态登记与回执键一致）')
  })
})

test('未决审批超等待上限（GUI 永不回执）→ 强制回收，不留永久豁免', async () => {
  // 审批帧发给 0 个客户端时永远不会有人点：豁免必须有上限，否则内核泄漏（pid 21196 形态）。
  await withBridge({ YFW_KERNEL_TURN_REAP_MS: '600000', YFW_KERNEL_WAIT_EXEMPT_MS: '2000', YFW_KERNEL_REAP_TICK_MS: '400', YFW_KERNEL_IDLE_MS: '600000' }, async ({ b, ws, home }) => {
    ws.send(JSON.stringify({ type: 'send', sessionId: 'reap-wait-ttl', prompt: '[mock:tool-catastrophic] 请执行', cwd: REPO_ROOT }))
    assert.ok(await waitSpawned(home), '内核应已 spawn')
    await waitFrame(ws, 'approval', 12000)
    const deadline = Date.now() + 15000
    while (Date.now() < deadline && !/waiting kernel reaped/.test(b.stdoutText())) await sleep(200)
    assert.match(b.stdoutText(), /waiting kernel reaped/, '等待超上限必须回收（GUI 永不回执的内核）')
  })
})

test('等待被结清后不再豁免：审批回执 → 工具回吐 tool_result → 会话回归普通空闲回收', async () => {
  // 结清链：approval-response 删除待批项 → clearSessionAwaiting 归零 _awaitingSince。
  // 若只删 map 不清等待态，_awaitingSince 会把豁免从"上一个等待期"无限延续（本用例
  // 用极短 idle 阈值把它暴露出来：结清后应能被普通空闲分支回收）。
  await withBridge({
    YFW_KERNEL_TURN_REAP_MS: '600000',
    YFW_KERNEL_WAIT_EXEMPT_MS: '600000',
    YFW_KERNEL_IDLE_MS: '2500',
    YFW_KERNEL_REAP_TICK_MS: '400',
  }, async ({ b, ws, home }) => {
    ws.send(JSON.stringify({ type: 'send', sessionId: 'reap-clear', prompt: '[mock:tool-catastrophic] 请执行', cwd: REPO_ROOT }))
    assert.ok(await waitSpawned(home), '内核应已 spawn')
    const ap = await waitFrame(ws, 'approval', 12000)
    ws.send(JSON.stringify({ type: 'approval-response', sessionId: 'reap-clear', toolUseId: ap.data.toolUseId, approved: false }))
    const deadline = Date.now() + 20000
    while (Date.now() < deadline && !/idle kernel reaped/.test(b.stdoutText())) await sleep(200)
    assert.match(b.stdoutText(), /idle kernel reaped/, '结清等待态后内核应回到普通空闲回收（豁免不得延续）')
  })
})
