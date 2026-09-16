// 失速看门狗必须识别「内核在等人」（2026-09-13 取证修复）
// ---------------------------------------------------------------------------
// 背景：`warnStalledKernels()` 只看 `_turnActive` + 静默时长，不区分「内核在等用户」
// 与「内核卡死」。而提问/审批期间内核**刻意**零 stdout（阻塞在 waitForAnswer /
// 审批回执上），静默是设计；告警却把这段报成「疑似 AV/驱动卡死，建议取消/重启」。
// 实证（app.log* 全量 14 次失速告警）：9 次可证为等人（4 次审批挂起 207–463s、
// 5 次提问等待），用户据此以为内核已死——「不清楚内核及 agent 是否正常运转」的直接来源。
// 压缩同理：摘要是一次 480–600s 级完整请求，阈值 420s < 600s ⇒ 任何一次真摘要都必然误报，
// 故用「最后一条压缩帧时刻」做**有界**豁免（15min，done 帧丢失也能自行过期）。
// 本测试用 env 把阈值与扫描周期缩到秒级（全仓无假时钟库，一律缩短真实毫秒）。
// 三条用例：审批等待不报 / 提问等待不报 / 真静默（无未决等待）仍必须报——最后一条是
// 正向对照：豁免若被写成「永不告警」（如把 `size > 0` 误写成 `_pendingApprovals` 真值
// 判断，则每个会话都会被无条件豁免）在这里必然失败。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { TEST_BRIDGE_TOKEN, withToken } from './test-bridge-auth.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const BRIDGE_ENTRY = join(REPO_ROOT, 'server', 'bridge.mjs')
const READY_TIMEOUT_MS = 15000
// 失速阈值 1.2s / 扫描 300ms：任何「人等」窗口（秒级）都必然跨过至少一个扫描周期，
// 「真静默」用例也只需等 ~3s（spawn + init 帧之后 1.2s）就能观测到告警。
const STALL_ENV = { YFW_KERNEL_STALL_MS: '1200', YFW_KERNEL_STALL_TICK_MS: '300' }

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
    YFW_BRIDGE_TOKEN: TEST_BRIDGE_TOKEN,
    // 回收器与本测试无关（默认 10min/20min/30min 都远大于用例时长），给足上限避免干扰
    YFW_KERNEL_IDLE_MS: '600000',
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
    const timer = setTimeout(() => { ws.close(); reject(new Error('ws open timeout')) }, READY_TIMEOUT_MS)
    ws.onopen = () => { clearTimeout(timer); resolve(ws) }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws connection error')) }
  })
}

// 帧记录器：从连上那一刻起缓存**所有**帧，等待 = 先查缓存再挂监听。
// 直接 `ws.onmessage = waiter` 会漏掉"等待者还没装好、帧已经到了"的竞态——
// 提问帧（模型产出即发）比审批帧早得多，正是这个竞态的高发处。
function recordFrames(ws) {
  const seen = []
  const waiters = []
  const prev = ws.onmessage
  ws.onmessage = (ev) => {
    let m
    try { m = JSON.parse(String(ev.data)) } catch { if (prev) prev(ev); return }
    seen.push(m)
    for (const w of [...waiters]) {
      if (w.type !== m.type) continue
      waiters.splice(waiters.indexOf(w), 1)
      w.onHit(m)
    }
    if (prev) prev(ev)
  }
  return {
    seen,
    types: () => seen.map((m) => m.type).join(','),
    wait(type, timeoutMs) {
      const hit = seen.find((m) => m.type === type)
      if (hit) return Promise.resolve(hit)
      return new Promise((resolve, reject) => {
        const w = { type, onHit: resolve }
        const timer = setTimeout(() => {
          const i = waiters.indexOf(w)
          if (i >= 0) waiters.splice(i, 1)
          reject(new Error(`waiting ${type} timeout`))
        }, timeoutMs)
        w.onHit = (m) => { clearTimeout(timer); resolve(m) }
        waiters.push(w)
      })
    },
  }
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

// 内核日志尾巴（桥把 PONOS_CONFIG_DIR/YFWORKING_HOME 都指向临时 home，故内核日志在此）
function kernelLogTail(home, max = 2000) {
  try {
    const dir = join(home, 'logs')
    const f = readdirSync(dir).filter((n) => n.endsWith('.log')).sort().pop()
    if (!f) return '(无日志文件)'
    return readFileSync(join(dir, f), 'utf-8').slice(-max)
  } catch (e) { return `(日志不可读: ${e.message})` }
}

async function withBridge(extraEnv, fn) {
  const home = mkdtempSync(join(tmpdir(), 'yfw-stall-'))
  const port = await freePort()
  const b = spawnBridge(home, port, { ...STALL_ENV, ...extraEnv })
  let ws
  let rec
  try {
    await waitReady(b, port)
    ws = await connectWS(port)
    rec = recordFrames(ws)
    await rec.wait('bridge_hello', 5000)
    try {
      await fn({ b, ws, home, port, rec })
    } catch (e) {
      // 失败原因几乎总在"桥发了没 / 内核说了没"这两份证据里，一次性带出来，省一轮复跑
      const frameDump = rec.seen.slice(0, 25).map((m) => JSON.stringify(m).slice(0, 300)).join('\n')
      throw new Error(`${e.message}\n--- WS 帧(${rec.seen.length}): ${rec.types().slice(0, 1200)}\n${frameDump}\n--- bridge stdout ---\n${b.stdoutText().slice(-2500)}\n--- kernel log ---\n${kernelLogTail(home)}`)
    }
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

test('未决审批期间不得报内核失速（等的是人，不是卡死）', async () => {
  // 17891979 形态的反面：审批挂起 207–463s 的窗口此前必被误报失速。
  await withBridge({}, async ({ b, ws, home, rec }) => {
    ws.send(JSON.stringify({ type: 'send', sessionId: 'stall-ap', prompt: '[mock:tool-catastrophic] 请执行', cwd: REPO_ROOT }))
    assert.ok(await waitSpawned(home), '内核应已 spawn')
    const ap = await rec.wait('approval', 12000)
    assert.ok(ap.data.toolUseId, '审批帧应携带 toolUseId')
    await sleep(4000) // 3× 阈值、十余个扫描周期
    assert.match(
      b.stdoutText(), /approval forwarded sid=stall-ap clients=1/,
      '审批转发必须留痕（clients 计数即"有没有人收到"的证据；发给 0 个客户端时只能靠 hello 重放）',
    )
    assert.doesNotMatch(b.stdoutText(), /kernel stall warning/, '未决审批期间不得报失速（旧判据在此误报）')
  })
})

test('未决提问期间不得报内核失速（内核阻塞在 waitForAnswer 是设计）', async () => {
  // 提问帧到达即登记 _pendingQuestions（含 raw 分支），与内核静默同步发生：
  // 同一行 stdout 既刷新 _lastOutAt 又登记等待态 ⇒ 登记窗口内不可能先触发告警。
  // 另一重身份：mock 的 streamText 把标记按 1/3 等分切成 3 帧（必然切碎标记），
  // 故本用例同时是"桥必须从累积缓冲提取提问标记"的回归测试——按帧提取时
  // 这里一个 question 帧都不会有（内核却在等，界面零提示、空转 600s）。
  await withBridge({}, async ({ b, ws, home, rec }) => {
    ws.send(JSON.stringify({ type: 'send', sessionId: 'stall-q', prompt: '[mock:ask-user] 请确认', cwd: REPO_ROOT }))
    assert.ok(await waitSpawned(home), '内核应已 spawn')
    const q = await rec.wait('question', 12000)
    assert.ok(q.data && (q.data.questions || q.data.raw), '提问帧应携带 questions 或 raw 兜底载荷')
    await sleep(4000)
    assert.match(
      b.stdoutText(), /question forwarded sid=stall-q clients=1 qs=1 parsed=1/,
      '提问转发必须留痕（题数 + 解析结果 + clients 计数）——实证 5/9 次提问帧只在 WS 重连时才送达，此前无任何桥侧记录',
    )
    assert.doesNotMatch(b.stdoutText(), /kernel stall warning/, '未决提问期间不得报失速（旧判据在此误报，且文案误导为"卡死"）')
  })
})

test('正向对照：无未决等待的真静默仍必须报失速', async () => {
  // [mock:hang-forever]：发消息后内核永久挂起（异步链失活签名），且**无**未决提问/审批。
  // 这条是豁免改动的反向保护：豁免一旦写成"永不告警"（例如把 map 非空判成 map 存在），
  // 真实的卡死就再也无人提示——本用例必须仍然看到告警与 kernel-stall 帧。
  await withBridge({}, async ({ b, ws, home, rec }) => {
    ws.send(JSON.stringify({ type: 'send', sessionId: 'stall-real', prompt: '[mock:hang-forever] 挂住', cwd: REPO_ROOT }))
    assert.ok(await waitSpawned(home), '内核应已 spawn')
    const frame = await rec.wait('kernel-stall', 12000)
    assert.equal(frame.data.sessionId, 'stall-real', 'kernel-stall 帧应指向该会话（GUI 靠它显示失速态）')
    // 桥日志里的 sid 截断到 8 字符（stall-real → stall-re），断言按截断后的写。
    assert.match(b.stdoutText(), /kernel stall warning: sid stall-re\b/, '真静默（无未决等待）必须仍然告警——豁免不得写成永不告警')
  })
})
