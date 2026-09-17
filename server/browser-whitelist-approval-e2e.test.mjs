'use strict'
// 浏览器白名单审批链的**跨进程**端到端测试（2026-09-17）。
//
// 为什么需要它：本次事故（用户"点了同意却永远打不开 file:// 本地文件"，且反复弹审批）的
// 缺陷横跨**三个进程**——内核（engine.mjs 决定弹不弹审批、如何措辞）、桥（bridge.mjs 负责
// 落盘并把真实结果回传）、执行器（electron 侧决定放行与否）。此前只有内核侧单测（mock 桥）
// 与桥侧纯函数单测（addBrowserWhitelist），**没有任何测试跑真桥**，因此"桥回传的
// whitelistWritten 是否真的进了 control_response"这条契约无人把守 —— 一旦这里断掉，
// 内核会退回"谎报已批准"，事故就会以另一种形式复发。故本文件用真桥 + mock 内核 + 两个 WS
// 客户端（GUI / 执行器）把整条链拉通，断言**用户可见的行为**：
//   A. 无 hostname 的地址（file:// 类）→ **根本不弹审批**（弹了也是白弹），且不写任何文件
//   B. 合法域名 → 弹审批 → 批准 → 域名**真的写进** browser-whitelist.json
//   C. 写盘失败 → 审批仍正常收尾（不崩），且**如实告知失败**而非谎报"已批准请重试"
//
// 装置沿用 server/approval-lifecycle.test.mjs 的真桥起法（独立子进程 / 随机端口 / 临时 home）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEST_BRIDGE_TOKEN, withToken } from './test-bridge-auth.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const BRIDGE_ENTRY = join(REPO_ROOT, 'server', 'bridge.mjs')
const READY_TIMEOUT_MS = 15000
const MOCK_BROWSER = '[mock:browser] 请打开'

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
    YFW_KERNEL_STALL_MS: '0',
    YFW_KERNEL_IDLE_MS: '600000',
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
  proc.stderr.on('data', (d) => { errTail = (errTail + String(d)).slice(-3000) })
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

async function waitFrame(ws, pred, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = ws.frames.find(pred)
    if (hit) return hit
    await sleep(100)
  }
  return null
}

/** 等 GUI 帧里出现某段文字（内核回吐的工具结果就是用户/模型可见的那段话）。 */
async function waitText(ws, needle, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (JSON.stringify(ws.frames).includes(needle)) return true
    await sleep(100)
  }
  return false
}

/** 起桥 + 连两个客户端（GUI 与执行器），并让执行器完成注册——三个用例共用的开场。 */
async function setup(home) {
  const port = await freePort()
  const b = spawnBridge(home, port)
  const sockets = []
  try {
    await waitReady(b, port)
    const gui = await connectWS(port)
    sockets.push(gui)
    const exec = await connectWS(port)
    sockets.push(exec)
    exec.send(JSON.stringify({ type: 'executor:hello' }))
    // 执行器注册是异步的：先等一小会儿，避免浏览器请求在注册完成前发出而无人接收
    await sleep(300)
    return { b, port, gui, exec, sockets }
  } catch (e) {
    for (const s of sockets) { try { s.close() } catch {} }
    try { b.proc.kill() } catch {}
    throw e
  }
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

/**
 * 发起一轮浏览器工具调用，并让"执行器"按给定错误回执 —— 模拟执行器的白名单拦截。
 *
 * 注意链路里有两道审批，顺序不能跳（实测于 bridge 日志）：
 *   ① **工具级审批**：当前审批档位下 Browser 属高风险工具，内核先发 can_use_tool 审批
 *      （toolUseId 是工具调用 id，如 tool_use_mock_browser），须先批准，Browser 才会真的执行；
 *   ② **白名单审批**：执行器返回 whitelist-blocked 后，内核才按需发起 toolUseId='whitelist:<域名>' 的审批。
 * 二者都是 `{type:'approval'}` 帧，用 toolUseId 前缀区分；回执必须带 sessionId（桥按 sessionId 找会话，
 * 缺了会落到 'default' 而找不到挂起项，审批永远解不开）。
 */
async function driveBlocked(b, gui, exec, sessionId, data) {
  gui.send(JSON.stringify({ type: 'send', sessionId, prompt: MOCK_BROWSER, cwd: REPO_ROOT }))
  const toolAppr = await waitFrame(gui, (f) => f.type === 'approval' && !String(f.data?.toolUseId || '').startsWith('whitelist:'))
  assert.ok(toolAppr, '工具级审批应先到（Browser 属高风险工具）；bridge stdout: ' + b.stdoutText().slice(-400))
  gui.send(JSON.stringify({ type: 'approval-response', sessionId, toolUseId: toolAppr.data.toolUseId, approved: true }))
  const req = await waitFrame(exec, (f) => f.type === 'browser:exec')
  assert.ok(req, '批准工具后执行器应收到 browser:exec 请求；bridge stdout: ' + b.stdoutText().slice(-400))
  exec.send(JSON.stringify({ type: 'browser:exec:response', requestId: req.requestId, ok: false, code: 'whitelist-blocked', data }))
  return req
}

/** 批准白名单审批（若有）。返回该审批帧或 null —— 用例据此断言"该弹"或"不该弹"。 */
async function approveWhitelist(b, gui, sessionId, timeoutMs = 8000) {
  const appr = await waitFrame(gui, (f) => f.type === 'approval' && String(f.data?.toolUseId || '').startsWith('whitelist:'), timeoutMs)
  if (!appr) return null
  gui.send(JSON.stringify({ type: 'approval-response', sessionId, toolUseId: appr.data.toolUseId, approved: true }))
  return appr
}

const whitelistPath = (home) => join(home, 'browser-whitelist.json')
const readAllow = (home) => { try { return JSON.parse(readFileSync(whitelistPath(home), 'utf8')).allow } catch { return null } }

// ── A. 无 hostname 的地址（file:// 类）→ 不弹假审批 ────────────────────────────
// 这是本次事故的正面回归：旧代码会拿空 hostname 顶替成中文占位符「该域名」弹审批，
// 用户同意后写入端静默拒绝、内核却回"已批准请重试" ⇒ 无限循环。修复后**不弹**，直接给替代途径。
test('A 无 hostname（file:// 类）→ 不弹审批、不写文件、直接给替代途径', async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-wl-A-'))
  const { b, gui, exec, sockets } = await setup(home)
  const sessionId = 'wl-A-' + Date.now()
  try {
    await driveBlocked(b, gui, exec, sessionId, {
      domain: '', protocol: 'file:',
      url: 'file:///C:/Users/x/scratch/knowledge-module-mockup.html',
    })
    // 等到内核把工具结果回吐（说明这一轮走完、且走的是"替代途径"分支）
    const arrived = await waitText(gui, '无法通过')
    assert.ok(arrived, '应收到"无法通过域名白名单放行"的说明；GUI 帧: ' + JSON.stringify(gui.frames).slice(-500))
    // 关键断言：不得出现任何 whitelist 审批帧
    const wlApprovals = gui.frames.filter((f) => f.type === 'approval' && String(f.data?.toolUseId || '').startsWith('whitelist:'))
    assert.equal(wlApprovals.length, 0, '**不得**弹白名单审批：该地址原理上无法加入白名单，弹了必然白弹（事故根因）')
    // 也不得写任何白名单文件
    assert.equal(existsSync(whitelistPath(home)), false, '不得写入 browser-whitelist.json')
    // 文案要能真的指导模型（不再诱导空转重试）
    const dump = JSON.stringify(gui.frames)
    assert.ok(dump.includes('不要重复重试'), '应明确劝阻空转重试')
    assert.ok(!dump.includes('该域名'), '空 hostname 的中文占位符不得再出现在任何文案里')
  } finally { await teardown(b, sockets, home) }
})

// ── B. 合法域名 → 弹审批 → 批准 → 真的写进白名单文件 ─────────────────────────
// "用户点了同意，就一定生效"——这是本次修复的核心承诺，必须在真桥上验证落盘。
test('B 合法域名：批准后真写入 browser-whitelist.json，并告知可重试', async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-wl-B-'))
  const { b, gui, exec, sockets } = await setup(home)
  const sessionId = 'wl-B-' + Date.now()
  try {
    const domain = 'e2e-ok.example'
    await driveBlocked(b, gui, exec, sessionId, { domain, protocol: 'https:', url: `https://${domain}/page` })
    const appr = await approveWhitelist(b, gui, sessionId)
    assert.ok(appr, '合法域名应弹白名单审批；GUI 帧: ' + JSON.stringify(gui.frames).slice(-400))
    // ① 真的落盘（用户承诺的兑现点）
    let allow = null
    const deadline = Date.now() + 15000
    while (Date.now() < deadline && !(allow || []).includes(domain)) { await sleep(150); allow = readAllow(home) }
    assert.ok(allow && allow.includes(domain), `域名应真的写进白名单：${JSON.stringify(allow)}`)
    // ② 内核收到"已批准"并鼓励重试
    assert.ok(await waitText(gui, '已批准将', 15000), '应回"已批准"，让模型重试同一操作')
    // ③ 桥侧不应对合法域名打拒绝日志
    assert.ok(!b.stdoutText().includes('rejected invalid host'), '合法域名不得被判非法')
    // ④ 无残留未决审批
    const expired = gui.frames.filter((f) => f.type === 'approval-expired')
    assert.equal(expired.length, 0, '批准路径不应产生 approval-expired')
  } finally { await teardown(b, sockets, home) }
})

// ── C. 写盘失败 → 如实告知，不再谎报"已批准请重试" ───────────────────────────
// 构造方式：把 browser-whitelist.json 预先建成**目录** ⇒ writeFileSync 必然失败（EISDIR），
// 从而走到"批准但写入失败"这条分支（这正是旧事故里内核谎报的那条路径）。
test('C 写盘失败：审批正常收尾 + 如实告知写入失败（不谎报已批准）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-wl-C-'))
  mkdirSync(whitelistPath(home), { recursive: true })
  const { b, gui, exec, sockets } = await setup(home)
  const sessionId = 'wl-C-' + Date.now()
  try {
    const domain = 'e2e-fail.example'
    await driveBlocked(b, gui, exec, sessionId, { domain, protocol: 'https:', url: `https://${domain}/page` })
    const appr = await approveWhitelist(b, gui, sessionId)
    assert.ok(appr, '合法域名应弹审批（写入失败是批准之后才发生的）')
    // ① 如实告知失败（不再谎报"已批准，请重试"）
    assert.ok(await waitText(gui, '写入白名单失败', 15000), '应如实告知写入失败；桥 stderr: ' + b.stderrTail().slice(-300))
    const dump = JSON.stringify(gui.frames)
    assert.ok(!dump.includes('用户已批准将'), '不得同时宣称"已批准"（旧代码正是这么骗模型的）')
    // ② 桥必须留痕（旧实现的"静默"是死循环的另一半根因）
    const logged = b.stdoutText().includes('write failed') || b.stderrTail().includes('write failed') || b.stdoutText().includes('写入失败')
    assert.ok(logged, '写盘失败必须留日志；stdout: ' + b.stdoutText().slice(-400))
    // ③ 桥进程不得因此崩掉
    assert.equal(b.state.exitInfo, null, '写盘失败不得导致桥退出')
  } finally { await teardown(b, sockets, home) }
})
