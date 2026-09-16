// 上下文失真：桥 → GUI 全链路（2026-09-12）
// ---------------------------------------------------------------------------
// 覆盖 GUI 实际消费的那条链路（比内核单测更外层、比手工验收更早）：
//   WS 客户端 → bridge(/send) → 内核轮次 → ponos_health 事件（经 event 整包透传）
//   → GUI 侧失真判定入参（distortion.tier/issues/trigger/anchorText）
//   → POST /session/anchor-applied → bridge → 内核 stdin → 回绿事件回到 WS
// 只断言**契约不变量**（档位/字段形状/去抖键的存在性），不断言人类可读文案。
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
const READY_TIMEOUT_MS = 15_000
/** 与"已被删除的路径"同名：mock 的 Read 必然失败，回显文本会带上该路径 */
const MISSING = '__yfw_fidelity_missing__.md'
const SID = 'fidelity-chain-1'

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

function rmSyncRetry(path, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    try { rmSync(path, { recursive: true, force: true }); return } catch {
      if (i === attempts - 1) return // 清理失败不影响结论（Windows 句柄延迟释放）
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60)
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
  const env = { ...process.env, PONOS_MOCK_API: '1', PONOS_FIDELITY: '1', YFW_BRIDGE_PORT: String(port), PONOS_CONFIG_DIR: home, YFWORKING_HOME: home }
  delete env.PONOS_HOME
  const proc = spawn(process.execPath, [BRIDGE_ENTRY], { cwd: REPO_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const out = []
  let errTail = ''
  const state = { exitInfo: null }
  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')
  proc.stdout.on('data', (d) => out.push(String(d)))
  proc.stderr.on('data', (d) => { errTail = (errTail + String(d)).slice(-2000) })
  proc.once('exit', (code, signal) => { state.exitInfo = { code, signal } })
  return { proc, state, stdoutText: () => out.join(''), stderrTail: () => errTail }
}

async function waitReady(b, port) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (b.stdoutText().includes(`http+ws://localhost:${port}`)) return
    if (b.state.exitInfo) throw new Error(`bridge exited before ready: ${JSON.stringify(b.state.exitInfo)}; stderr: ${b.stderrTail()}`)
    await sleep(50)
  }
  throw new Error(`bridge ready timeout; stdout: ${b.stdoutText().slice(-400)}; stderr: ${b.stderrTail()}`)
}

/**
 * 等桥启动收尾：以"启动日志静止"为就绪代理。
 * 不用 bridge_hello（那是桥侧未提交的握手特性，本测试不能依赖未入库代码）；也不只靠
 * waitReady——它只保证 listen 那行已打印，之后桥还在做技能自举等初始化，过早 send 可能丢包。
 */
async function waitStartupSettled(b, quietMs = 800, maxMs = 20_000) {
  const deadline = Date.now() + maxMs
  let lastLen = b.stdoutText().length
  let lastChange = Date.now()
  while (Date.now() < deadline) {
    if (b.state.exitInfo) throw new Error(`bridge exited during startup: ${JSON.stringify(b.state.exitInfo)}; stderr: ${b.stderrTail()}`)
    const n = b.stdoutText().length
    if (n !== lastLen) { lastLen = n; lastChange = Date.now() }
    else if (Date.now() - lastChange >= quietMs) return
    await sleep(50)
  }
}

function connectWS(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const timer = setTimeout(() => { ws.close(); reject(new Error('ws open timeout')) }, READY_TIMEOUT_MS)
    ws.onopen = () => { clearTimeout(timer); resolve(ws) }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws connection error')) }
  })
}

/** 持续收集 WS 消息（不覆盖 onmessage，便于按条件回溯查找）。 */
function collect(ws) {
  const msgs = []
  ws.onmessage = (ev) => { try { msgs.push(JSON.parse(String(ev.data))) } catch { /* 非 JSON 忽略 */ } }
  return msgs
}

/** 轮询等待：pred 命中的第一条消息（from 起）；超时返回 null 并附最后若干消息便于诊断。 */
async function waitFor(msgs, pred, timeoutMs = 30_000, from = 0) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (let i = from; i < msgs.length; i++) if (pred(msgs[i])) return { msg: msgs[i], idx: i }
    await sleep(50)
  }
  return null
}

/** 内核事件（bridge 以 {type:'event', data:<parsed>, sessionId} 透传） */
function isEvent(m, type) { return m?.type === 'event' && m.data?.type === type }

test('全链路：桥→内核→ponos_health(失真红) → 锚定上报 → 回绿（真桥+真内核+WS）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-chain-home-'))
  const workDir = mkdtempSync(join(tmpdir(), 'yfw-chain-cwd-'))
  const port = await freePort()
  const b = spawnBridge(home, port)
  let ws
  try {
    await waitReady(b, port)
    ws = await connectWS(port)

    const msgs = collect(ws)
    // 等桥启动收尾，确认已完成初始化（不依赖未入库的 bridge_hello 握手）
    await waitStartupSettled(b)

    const send = (prompt) => ws.send(JSON.stringify({ type: 'send', sessionId: SID, cwd: workDir, prompt }))

    // 两轮引用"已被删除的路径"：第 1 轮中证据，第 2 轮跨轮升级为强证据 → 红档
    let cursor = 0
    for (let i = 0; i < 2; i++) {
      send(`[mock:fidelity-read-fail] 请核对 ${MISSING} 里的配置`)
      const done = await waitFor(msgs, (m) => isEvent(m, 'result'), 40_000, cursor)
      assert.ok(done, `第 ${i + 1} 轮未收到 result\nstdout=${b.stdoutText().slice(-800)}\nstderr=${b.stderrTail()}`)
      cursor = done.idx + 1
    }

    // GUI 侧失真判定的输入：distortion 必须随 event 整包到达（bridge 无需改动）
    const red = await waitFor(msgs, (m) => isEvent(m, 'ponos_health') && m.data.distortion?.tier === 'red', 20_000, 0)
    assert.ok(red, `未收到失真红档事件\nstdout=${b.stdoutText().slice(-1500)}`)
    const d = red.msg.data.distortion

    assert.ok(Array.isArray(d.issues) && d.issues.length >= 1, '红档必须带证据清单（卡片要逐条展示）')
    for (const it of d.issues) {
      assert.equal(typeof it.id, 'string', '证据必须带稳定 id（前端去抖键）')
      assert.ok(['memory', 'coherence', 'goal'].includes(it.axis), `未知轴：${it.axis}`)
      assert.ok(['strong', 'medium'].includes(it.strength), `未知强度：${it.strength}`)
      assert.equal(typeof it.turn, 'number')
      assert.equal(typeof it.evidence, 'string')
    }
    assert.equal(d.trigger, d.issues[0].id, 'trigger 应指向最强证据的 id')
    assert.equal(d.anchorAvailable, true, '红档应可重新锚定')
    assert.ok(String(d.anchorText || '').length > 0, '红档必须附 anchorText（否则「重新锚定」按钮点了没反应）')
    assert.ok(d.anchorText.length <= 4096, `anchorText 应 ≤4KB，实测 ${d.anchorText.length}`)
    assert.equal(typeof d.score, 'number')
    assert.equal(typeof d.axes, 'object')

    // GUI 消费的"压力档"必须独立（红档失真是失真侧的事，不得顶红压力档）
    assert.notEqual(red.msg.data.tier, 'red', '压力档不应被失真判定影响（两轴严禁互相赋值）')

    // 用户在卡片上点「重新锚定」→ 上报 → 内核 resolved → 回绿
    const res = await fetch(`http://127.0.0.1:${port}/session/anchor-applied`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SID, issueIds: d.issues.map((it) => it.id) }),
    })
    assert.equal(res.status, 200, `锚定上报应 200，实测 ${res.status}`)

    const green = await waitFor(msgs, (m) => isEvent(m, 'ponos_health') && m.data.distortion?.tier === 'green', 20_000, red.idx)
    assert.ok(green, `未收到回绿事件（POST 是否未转发到内核？）\nstdout=${b.stdoutText().slice(-1500)}`)
    const g = green.msg.data.distortion
    assert.equal(g.score, 0, '回绿后分数归零')
    assert.deepEqual(g.issues, [], '回绿后无活跃证据')
    assert.equal(g.trigger, null, '回绿后不得带 trigger（前端据此不再弹卡）')
    assert.equal(g.anchorAvailable, false, '回绿后不再提供锚点')
  } finally {
    try { ws?.close() } catch { /* 已关闭 */ }
    try { b.proc.kill() } catch { /* 已退出 */ }
    rmSyncRetry(home)
    rmSyncRetry(workDir)
  }
})
