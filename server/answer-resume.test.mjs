// 提问卡片久挂后作答必须能把会话续起来（2026-09-14「拉不起来」事故修复）
// ---------------------------------------------------------------------------
// 现象：提问卡片抛出后很久不处理，再处理时（作答）会话再也起不来。
// 根因：内核**先于用户作答离场**，而 answer 分支当时只认"活的会话"——
//   ① 内核侧提问等待超时（PONOS_ASK_USER_TIMEOUT_MS，默认 10min）→ 收尾本轮 →
//      会话回归普通空闲 → 再 10min 后按空闲回收（reapIdleKernels 空闲分支）；
//   ② 或"提问等待豁免"（YFW_KERNEL_WAIT_EXEMPT_MS，默认 30min）到期被强制回收。
//   两条路径都让 sessions 里不再有该会话 ⇒ 旧 answer 分支 `if (session && …)` 判空，
//   **回答被静默丢弃**（只回一个 question-resolved），而前端 sendAnswer 又乐观地把
//   会话标成"执行中"：输入条锁死、永远等不到输出 = 用户看到的「拉不起来」。
// 新契约（与 send 同源）：内核不在就以 --resume 原会话 ID 重启，再把回答注入；
// 若连 resume 信息都没有（老前端），必须显式回 error 让前端解锁，绝不静默丢弃。
// 本文件两个用例分别锁定这两条。
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
const SID = 'ans-reap' // 桥日志按 8 字符截断 sid，这里正好取满

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
    CLAUDE_CONFIG_DIR: home,
    YFWORKING_HOME: home,
    YFW_KERNEL_STALL_MS: '0', // 失速告警与回收无关，关掉以免噪声
    ...extraEnv,
  }
  delete env.PONOS_HOME
  const proc = spawn(process.execPath, [BRIDGE_ENTRY], { cwd: REPO_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const out = []
  const err = []
  const state = { exitInfo: null }
  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')
  proc.stdout.on('data', (d) => { out.push(String(d)) })
  // stderr 全量留存：桥的 console.warn/console.error 走 stderr（"回答无法送达"就是 warn），
  // 只收 stdout 会把这些断言判成永远不出现
  proc.stderr.on('data', (d) => { err.push(String(d)) })
  proc.once('exit', (code, signal) => { state.exitInfo = { code, signal } })
  const exitPromise = new Promise((resolve) => proc.once('exit', (code, signal) => resolve({ code, signal })))
  return { proc, state, exitPromise, stdoutText: () => out.join(''), stderrText: () => err.join(''), stderrTail: () => err.join('').slice(-2000) }
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

// 帧收集器：与 reap-guard 的 waitFrame 不同，这里**不覆盖** onmessage——
// 本用例要按到达顺序拼接 assistant 文本增量（mock 的 streamText 按 3 段切，
// 断言子串可能跨帧，必须保留全部帧序）。
function collect(ws) {
  const frames = []
  ws.addEventListener('message', (ev) => {
    try { frames.push(JSON.parse(String(ev.data))) } catch { /* 非 JSON 帧忽略 */ }
  })
  return frames
}

// assistant 文本增量顺序拼接（wire.assistant 是**增量**帧，不是累计）
function assistantText(frames) {
  let s = ''
  for (const f of frames) {
    if (f.type !== 'event' || f.sessionId !== SID) continue
    const d = f.data
    if (!d || d.type !== 'assistant') continue
    for (const b of d.message?.content || []) if (b?.type === 'text') s += String(b.text ?? '')
  }
  return s
}

async function waitIn(pred, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = pred()
    if (v) return v
    await sleep(100)
  }
  throw new Error(`超时等待：${what}`)
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
  const home = mkdtempSync(join(tmpdir(), 'yfw-answer-'))
  const port = await freePort()
  const b = spawnBridge(home, port, extraEnv)
  let ws
  try {
    await waitReady(b, port)
    ws = await connectWS(port)
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

// 公共前置：提问 → 等内核被"等待豁免超上限"回收 → 返回 CLI 会话 id（resume 用）。
// 阈值压到秒级：豁免 2.5s（实际回收 3s 内），轮次上限与空闲上限拉长（不参与）。
const REAP_ENV = {
  YFW_KERNEL_TURN_REAP_MS: '600000',
  YFW_KERNEL_WAIT_EXEMPT_MS: '2500',
  YFW_KERNEL_REAP_TICK_MS: '400',
  YFW_KERNEL_IDLE_MS: '600000',
}

async function askThenGetReaped({ b, ws, home, frames }) {
  ws.send(JSON.stringify({ type: 'send', sessionId: SID, prompt: '[mock:ask-user] 请先问我', cwd: REPO_ROOT }))
  assert.ok(await waitSpawned(home), '内核应已 spawn')
  const q = await waitIn(() => frames.find((f) => f.type === 'question'), 15000, '提问帧 question')
  assert.ok(q.data?.questions?.length, '提问载荷应已解析（卡片可用）')
  const resumeId = await waitIn(
    () => frames.find((f) => f.type === 'event' && f.data?.subtype === 'init' && f.data?.session_id)?.data.session_id,
    15000, 'init 帧（CLI 会话 id）',
  )
  // 卡片仍在 GUI 上，内核已按"等待豁免超上限"被强杀 —— 正是事故现场
  await waitIn(() => /waiting kernel reaped/.test(b.stdoutText()), 15000, '等待超上限回收')
  return resumeId
}

test('提问卡片久挂、内核已被回收后作答 → 以 --resume 重启内核并注入回答，历史续上', async () => {
  await withBridge(REAP_ENV, async ({ b, ws, home }) => {
    const frames = collect(ws)
    const resumeId = await askThenGetReaped({ b, ws, home, frames })

    // 前端 sendAnswer 的报文形状（resume 字段集与 buildSendPayload 同源）
    ws.send(JSON.stringify({
      type: 'answer',
      sessionId: SID,
      data: { answers: [{ question: '继续吗？', selected: '继续' }], notes: '' },
      cwd: REPO_ROOT,
      resumeId,
      mode: 'task',
    }))

    const resolved = await waitIn(() => frames.find((f) => f.type === 'question-resolved'), 15000, 'question-resolved')
    assert.equal(resolved.data?.sameTurn, false, '内核已不在 ⇒ 必须是"新轮"语义（前端不得复用上一轮的 assistant 块）')
    assert.doesNotMatch(b.stderrText(), /answer undeliverable/, '带了 resume 信息就不该走"无法送达"分支')

    await waitIn(() => /answer on reaped session/.test(b.stdoutText()), 15000, '桥重启内核')
    assert.match(
      b.stdoutText(),
      new RegExp(`\\[bridge\\] spawn: ${SID} \\(resume ${resumeId.slice(0, 8)}\\)`),
      '重启必须带 --resume 原会话 ID（不带即等于丢历史新开会话）',
    )
    assert.match(
      b.stdoutText(),
      new RegExp(`answer injected for session: ${SID} \\(new turn\\)`),
      '回答必须真被注入内核 stdin（本次事故就是它被静默丢弃）',
    )
    // 最强证据：mock 回显带 realUser 计数。(turn=2) 只可能来自"原会话历史（1 条）+ 本次
    // 回答（1 条）"——若 --resume 没生效或回答没送达，这里只可能是 (turn=1)。
    await waitIn(() => /\(turn=2\)/.test(assistantText(frames)), 20000, '续跑输出 (turn=2)')
  })
})

test('作答缺少 resume 信息时不得静默丢弃：显式回 error（前端据此从"执行中"解锁）', async () => {
  await withBridge(REAP_ENV, async ({ b, ws, home }) => {
    const frames = collect(ws)
    await askThenGetReaped({ b, ws, home, frames })

    ws.send(JSON.stringify({
      type: 'answer',
      sessionId: SID,
      data: { answers: [{ question: '继续吗？', selected: '继续' }], notes: '' },
      // 老前端不带 resume 字段：桥无从重启（重启成"无历史新会话"= 悄悄截断会话，更糟）
    }))

    const err = await waitIn(() => frames.find((f) => f.type === 'error'), 15000, 'error 帧')
    assert.match(String(err.data?.message || ''), /回答未能送达/, '必须说明回答没送达（旧实现是静默丢弃 ⇒ 会话永远"执行中"）')
    assert.match(b.stderrText(), /answer undeliverable/)
    await waitIn(() => frames.find((f) => f.type === 'question-resolved'), 15000, 'question-resolved 仍须广播（卡片要能收起）')
  })
})
