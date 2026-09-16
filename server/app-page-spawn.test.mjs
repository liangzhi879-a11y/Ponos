// server/app-page-spawn.test.mjs —— 应用页作用域的**进程级桥接线**（2026-09-16，P2「应用页会话」）
// ---------------------------------------------------------------------------
// 要证明的两件事，都是纯函数/源码断言证明不了的：
//   ① 会话字段真的变成了内核 argv 里的 `--app-page <id>`（内核认不认另说，但拼错/漏拼在这层就能看见）；
//   ② 作用域**变更**真的触发"收割旧内核 + --resume 重 spawn"，而 `''` / `undefined` / 纯空白
//      这些"同一个状态"**不**触发——签名抖动的代价是每轮白重启一次内核（用户看到首字节变慢），
//      而"改了不生效"则表现为仍接着上一个应用的工具，两种故障都不报错。
//
// 手法：用一个**假内核**（YFWORKING_KERNEL 逃生口，内核路径换成脚本）记录每次启动的 argv，
// 自身常驻不退（进程还活着才谈得上"被收割"）。桥侧照既有测试的做法起真 bridge + WS 驱动。
// 假内核只写一行 init 帧：本文件断言的是 argv 与重 spawn 行为，不需要真内核的工具表
// （真内核那条链由 kernel-tests/app-page-scope.test.mjs 覆盖）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const BRIDGE_ENTRY = join(REPO_ROOT, 'server', 'bridge.mjs')
const READY_TIMEOUT_MS = 20000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

/**
 * 假内核：每次启动把 argv 追加一行到 FAKE_ARGV_LOG，回一行 init 帧，然后常驻。
 * 常驻是必需的——桥只在 `proc && !proc.killed` 时才走"签名比对"分支，
 * 一个启动即退出的假内核会让"作用域变更"永远走不到收割路径（用例会假绿）。
 *
 * 「常驻」必须配一条**退场路径**：桥退出（测试收尾 kill 掉桥）时 stdin 管道关闭，
 * 假内核据此自行 exit。否则 setInterval 会让它变成孤儿进程——实测这批孤儿会占住
 * 临时目录（Windows 下 rmSync EPERM）并在后续用例里越积越多（本仓库既有教训）。
 */
const FAKE_KERNEL_SRC = `
import { appendFileSync } from 'node:fs'
appendFileSync(process.env.FAKE_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake-kernel', tools: [] }) + '\\n')
process.stdin.resume()
process.stdin.on('data', () => {})
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 60000)
`

function spawnBridge(home, port, extraEnv = {}) {
  const env = {
    ...process.env,
    PONOS_MOCK_API: '1',
    YFW_BRIDGE_PORT: String(port),
    PONOS_CONFIG_DIR: home,
    YFWORKING_HOME: home,
    YFW_KERNEL_STALL_MS: '0',        // 失速告警与本用例无关，关掉以免噪声
    YFW_KERNEL_TURN_REAP_MS: '600000', // 回收器阈值拉长：本用例只关心"作用域变更"这一条收割路径
    YFW_KERNEL_IDLE_MS: '600000',
    YFW_KERNEL_REAP_TICK_MS: '60000',
    ...extraEnv,
  }
  delete env.PONOS_HOME
  const proc = spawn(process.execPath, [BRIDGE_ENTRY], { cwd: REPO_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const out = []
  let errTail = ''
  const state = { exitInfo: null }
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
    if (b.state.exitInfo) throw new Error(`bridge exited before ready: ${JSON.stringify(b.state.exitInfo)}; stderr=${b.stderrTail()}`)
    await sleep(50)
  }
  throw new Error('bridge ready timeout; stderr: ' + b.stderrTail())
}

function connectWS(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const timer = setTimeout(() => { ws.close(); reject(new Error('ws open timeout')) }, READY_TIMEOUT_MS)
    ws.onopen = () => { clearTimeout(timer); resolve(ws) }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws connection error')) }
  })
}

/** 读假内核记录的启动 argv 列表（每次 spawn 一行） */
function readArgvs(logPath) {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

async function waitArgvCount(logPath, n, ms = 15000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const rows = readArgvs(logPath)
    if (rows.length >= n) return rows
    await sleep(100)
  }
  return readArgvs(logPath)
}

const pageArgOf = (argv) => {
  const i = argv.indexOf('--app-page')
  return i === -1 ? null : argv[i + 1]
}

async function withBridge(fn) {
  const home = mkdtempSync(join(tmpdir(), 'yfw-apppage-'))
  const argvLog = join(home, 'argv.jsonl')
  const fake = join(home, 'fake-cli.mjs')
  writeFileSync(fake, FAKE_KERNEL_SRC, 'utf8')
  const port = await freePort()
  const b = spawnBridge(home, port, { YFWORKING_KERNEL: fake, FAKE_ARGV_LOG: argvLog })
  let ws
  try {
    await waitReady(b, port)
    ws = await connectWS(port)
    await fn({ b, ws, home, argvLog })
  } finally {
    if (ws) { try { ws.close() } catch { /* 已关闭 */ } }
    if (b.proc && !b.state.exitInfo) {
      try { b.proc.kill() } catch { /* 已退出 */ }
      await Promise.race([b.exitPromise, sleep(8000)])
    }
    await sleep(300)
    try { rmSyncRetry(home) } catch { /* Windows 句柄延迟：清理失败不影响断言 */ }
  }
}

test('★ spawn args 带 --app-page；作用域变更触发重 spawn；空串/空白与缺省同签名（不重 spawn）', async () => {
  await withBridge(async ({ b, ws, argvLog }) => {
    const send = (appPageId) => ws.send(JSON.stringify({ type: 'send', sessionId: 'page-scope', prompt: '你好', cwd: REPO_ROOT, appPageId }))

    // ① 未设作用域 → argv 里**没有** --app-page（缺省即语义，不传空串）
    send(undefined)
    const rows1 = await waitArgvCount(argvLog, 1)
    assert.equal(rows1.length, 1, `应 spawn 一次（stderr=${b.stderrTail()}）`)
    assert.equal(pageArgOf(rows1[0]), null, `无作用域时不得出现 --app-page（实际 argv=${JSON.stringify(rows1[0])}）`)
    assert.ok(rows1[0].includes('--print'), 'argv 应是我们认识的那个 spawn 形态（假内核确实被拉起了）')

    // ② '' 等价"未设作用域" → 不重 spawn（若这里重 spawn，每次发消息都会白掉一次首字节）
    send('')
    await sleep(1200)
    assert.equal(readArgvs(argvLog).length, 1, "空串必须与 undefined 同签名（否则清空作用域会白重启一次内核）")

    // ③ 设作用域 app-a → 收割旧内核 + 重 spawn，argv 带 --app-page app-a
    send('app-a')
    const rows2 = await waitArgvCount(argvLog, 2)
    assert.equal(rows2.length, 2, `作用域变更必须重 spawn（stderr=${b.stderrTail()}）`)
    assert.equal(pageArgOf(rows2[1]), 'app-a', `重 spawn 的 argv 应带 --app-page app-a（实际 ${JSON.stringify(rows2[1])}）`)
    assert.match(b.stdoutText(), /app page changed — reaping kernel/, '收割日志要能指明是作用域变更（排障线索）')

    // ④ 同一作用域（含首尾空白）→ 归一后同签名，不重 spawn
    send('  app-a  ')
    await sleep(1200)
    assert.equal(readArgvs(argvLog).length, 2, '空白差异不得被当成一次变更（归一在同一套口径上）')

    // ⑤ 换应用 → 再次重 spawn，argv 带新 id（否则仍接着旧应用的工具）
    send('app-b')
    const rows3 = await waitArgvCount(argvLog, 3)
    assert.equal(rows3.length, 3, '换应用必须重 spawn')
    assert.equal(pageArgOf(rows3[2]), 'app-b', `argv 应换成 app-b（实际 ${JSON.stringify(rows3[2])}）`)
  })
})

test('★ answer 路径（内核已回收后作答触发重 spawn）同样带 --app-page（漏一处 = 首条生效、作答后变全量）', async () => {
  await withBridge(async ({ ws, argvLog }) => {
    // 会话不在 sessions 里 + 带 resumeId ⇒ 走"内核已被回收 → --resume 重 spawn"分支
    ws.send(JSON.stringify({
      type: 'answer',
      sessionId: 'page-answer',
      resumeId: 'resume-page-answer',
      mode: 'task',
      cwd: REPO_ROOT,
      appPageId: 'app-b',
      data: { answers: [{ question: '继续吗？', selected: '继续' }], notes: '' },
    }))
    const rows = await waitArgvCount(argvLog, 1)
    assert.equal(rows.length, 1, '回答路径应重 spawn 内核')
    assert.equal(pageArgOf(rows[0]), 'app-b', `回答路径的 argv 必须带作用域（实际 ${JSON.stringify(rows[0])}）`)
    assert.ok(rows[0].includes('--resume'), '重启必须带 --resume（历史不丢）')
  })
})
