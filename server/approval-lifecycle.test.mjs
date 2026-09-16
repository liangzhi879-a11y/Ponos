// 审批生命周期收口（2026-09-12「审批时消息已过期」的桥侧修复）
// ---------------------------------------------------------------------------
// 三个独立缺陷，共同表现为"弹窗与内核真实状态不一致"：
//  B1 收口信号缺失：`_pendingApprovals` 全代码只有 approval-response 一处 delete，
//     且旧判据写成 `{type:'user',message:{content:[{type:'tool_result'}]}}`——内核
//     **从不产出**这个形状（真帧见 kernel/protocol.mjs 的 wire.toolResult：顶层
//     `{type:'tool_result',tool_use_id,...}`）⇒ 那段是死代码。后果：用户点了审批但
//     内核已超时、工具从未执行、审批帧发给 0 个客户端等情形全部残留，残留项又让回收器
//     无条件豁免该会话 ⇒ 内核泄漏（pid 6736 静默 53min / pid 21196 静默 13min）。
//  B2 过期重放：内核审批窗口（PONOS_APPROVAL_TIMEOUT_MS 默认 600s）早已放弃等待的
//     未决项，重连时又原样重放——用户点下去只会静默 no-op（"审批时消息已过期"实证形态）。
//  B3 回执说谎：approval-resolved 无 approved 字段 ⇒ 渲染侧只能硬编码 true，日志既不
//     能当批准证据、也无法区分"生效"与"过期 no-op"。
// 本文件全部为**进程级端到端**（真桥 + mock 内核）：三处修复都在桥的状态机上，单测覆盖不到。
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
const CATASTROPHIC = '[mock:tool-catastrophic] 请执行'

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
    YFW_KERNEL_STALL_MS: '0',
    YFW_KERNEL_IDLE_MS: '600000',
    YFW_BRIDGE_TOKEN: TEST_BRIDGE_TOKEN,
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
    const ws = new WebSocket(withToken(`ws://127.0.0.1:${port}`))
    ws.frames = []
    ws.onmessage = (ev) => { try { ws.frames.push(JSON.parse(String(ev.data))) } catch {} }
    const timer = setTimeout(() => { ws.close(); reject(new Error('ws open timeout')) }, READY_TIMEOUT_MS)
    ws.onopen = () => { clearTimeout(timer); resolve(ws) }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws connection error')) }
  })
}

const framesOf = (ws, type) => ws.frames.filter((f) => f.type === type)

async function waitFrame(ws, pred, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = ws.frames.find(pred)
    if (hit) return hit
    await sleep(100)
  }
  return null
}

// 会话已就绪（内核挂起在审批上）→ 返回首次广播的 approval 帧
async function awaitApproval(b, ws) {
  const f = await waitFrame(ws, (f) => f.type === 'approval' && f.data?.toolUseId === 'tool_use_mock_catastrophic')
  assert.ok(f, '应收到灾难级审批帧；bridge stdout: ' + b.stdoutText().split('\n').filter((l) => /approval|spawn/.test(l)).slice(-6).join(' | '))
  return f
}

async function teardown(b, sockets, home) {
  for (const s of sockets) { if (s) { try { s.close() } catch {} } }
  if (b.proc && !b.state.exitInfo) {
    try { b.proc.kill() } catch {}
    await Promise.race([b.exitPromise, sleep(8000)])
  }
  await sleep(300)
  try { rmSyncRetry(home) } catch { /* Windows 句柄延迟：清理失败不影响断言 */ }
}

// B1：内核回吐该工具结果 = 该审批在内核侧已经结束（放行后执行完 / 超时放弃）。桥必须在
// 这一刻删登记项 + 解除等待豁免 + **显式通知 GUI 收起弹窗**。用短审批超时让内核主动放弃。
test('B1 内核回吐 tool_result 即关闭未决审批并广播 approval-expired', async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-appr-b1-'))
  const port = await freePort()
  // 内核审批窗口 1.5s：无人回执 → 内核放弃等待 → 工具以"拒绝"收尾 → 回吐 tool_result 帧
  const b = spawnBridge(home, port, { PONOS_APPROVAL_TIMEOUT_MS: '1500' })
  let ws
  try {
    await waitReady(b, port)
    ws = await connectWS(port)
    ws.send(JSON.stringify({ type: 'send', sessionId: 'b1-sess', prompt: CATASTROPHIC, cwd: REPO_ROOT }))
    const appr = await awaitApproval(b, ws)
    assert.equal(appr.data.replayed, undefined, '首次广播不得带 replayed 标记')
    // 全程不回执：内核超时放弃后回吐 tool_result
    const expired = await waitFrame(ws, (f) => f.type === 'approval-expired', 20000)
    assert.ok(expired, '内核回吐 tool_result 后必须广播 approval-expired（旧判据形状永不产出 ⇒ 弹窗永挂）'
      + '；bridge stdout: ' + b.stdoutText().split('\n').filter((l) => /approval/.test(l)).slice(-6).join(' | '))
    assert.equal(expired.data.toolUseId, 'tool_use_mock_catastrophic', '过期通知必须指向原 toolUseId（凭它收起对应弹窗）')
    assert.equal(expired.data.reason, 'tool-result', 'reason 应标明收口来自协议层真信号')
    assert.equal(expired.sessionId, 'b1-sess', '会话归属必须正确')
    assert.match(b.stdoutText(), /approval closed by tool_result.*toolUseId=tool_use_mock_catastrophic/,
      '收口必须有可诊断日志（否则线上无法区分"已收口"与"从未登记"）')
    // 登记项已删 ⇒ 重连不再重放这条已死的审批（残留项还会豁免回收器 → 内核泄漏）
    ws.close()
    ws = await connectWS(port)
    await sleep(1500)
    assert.equal(framesOf(ws, 'approval').filter((f) => f.data?.toolUseId === 'tool_use_mock_catastrophic').length, 0,
      '已收口的审批不得在重连时重放（否则用户面对一个点了没反应的弹窗）')
  } finally {
    await teardown(b, [ws], home)
  }
})

// B2：超过内核审批窗口的未决项重放 = 让用户为一条已死的审批签字。必须丢弃并解除豁免。
test('B2 重连重放丢弃超过阈值的过期审批（并解除等待豁免）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-appr-b2-'))
  const port = await freePort()
  // 阈值压到 1s（生产 630s）；内核审批窗口保持默认 → 内核侧确实还在等，只有桥判过期
  const b = spawnBridge(home, port, { YFW_APPROVAL_STALE_MS: '1000' })
  let ws1, ws2
  try {
    await waitReady(b, port)
    ws1 = await connectWS(port)
    ws1.send(JSON.stringify({ type: 'send', sessionId: 'b2-sess', prompt: CATASTROPHIC, cwd: REPO_ROOT }))
    await awaitApproval(b, ws1)
    await sleep(2000) // 让年龄超过 1s 阈值
    ws1.close()
    ws1 = null
    ws2 = await connectWS(port)
    await sleep(2000) // 留足重放窗口：若仍重放，这里必然收到
    assert.equal(framesOf(ws2, 'approval').length, 0, '过期审批不得重放（用户点下去只会静默 no-op）')
    assert.match(b.stdoutText(), /dropped stale approval on replay/, '丢弃过期项必须有日志（否则线上只能看到"审批凭空消失"）')
  } finally {
    await teardown(b, [ws1, ws2], home)
  }
})

// B3：回执必须回传真实 approved；无对应挂起项时必须标记 stale（旧行为硬编码 true ⇒
// 日志既不能当批准证据，也无法区分生效/过期 no-op）
test('B3 approval-resolved 携带真实 approved；未命中挂起项时标记 stale', async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-appr-b3-'))
  const port = await freePort()
  const b = spawnBridge(home, port)
  let ws
  try {
    await waitReady(b, port)
    ws = await connectWS(port)
    ws.send(JSON.stringify({ type: 'send', sessionId: 'b3-sess', prompt: CATASTROPHIC, cwd: REPO_ROOT }))
    // ① 不存在的挂起项：必须标记 stale（否则 UI 以为已生效）
    ws.send(JSON.stringify({ type: 'approval-response', sessionId: 'b3-sess', toolUseId: 'tool_use_never_registered', approved: true }))
    const bogus = await waitFrame(ws, (f) => f.type === 'approval-resolved' && f.data?.toolUseId === 'tool_use_never_registered', 8000)
    assert.ok(bogus, '任何回执都必须有 resolved 回声（否则 UI 按钮点了无反馈）')
    assert.equal(bogus.data.stale, true, '未命中挂起项的回执必须标记 stale=true')
    assert.equal(bogus.data.approved, true, 'approved 必须回传原始值（stale 与 approved 互不替代）')
    // bridge 的落空告警走 console.warn ⇒ stderr（kernel-stderr 真源同侧）
    assert.match(b.stderrTail(), /no pending approval for toolUseId=tool_use_never_registered/, '落空回执必须留痕（可诊断）')
    // ② 真实挂起项 + 拒绝：回声必须是 approved:false 且**不得**带 stale
    await awaitApproval(b, ws)
    ws.send(JSON.stringify({ type: 'approval-response', sessionId: 'b3-sess', toolUseId: 'tool_use_mock_catastrophic', approved: false }))
    const real = await waitFrame(ws, (f) => f.type === 'approval-resolved' && f.data?.toolUseId === 'tool_use_mock_catastrophic', 8000)
    assert.ok(real, '真实回执必须有 resolved 回声')
    assert.equal(real.data.approved, false, 'approve=false 必须如实回传（旧实现硬编码 true ⇒ 日志不可作证据）')
    assert.ok(!('stale' in real.data), '命中的回执不得带 stale（否则 UI 会把生效的拒绝当过期）')
    assert.match(b.stdoutText(), /approval-response sid=b3-sess toolUseId=tool_use_mock_catastrophic approved=false/, '命中回执应有可审计日志')
  } finally {
    await teardown(b, [ws], home)
  }
})
