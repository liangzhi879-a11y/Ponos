// S2-D2 bridge 鉴权（token 闸）回归网（spec §6.2 D2、§10「S2 验收 2」、§9「S2 安全」）
// ---------------------------------------------------------------------------
// 改前事实：桥只靠 `isAllowedOrigin()` 一道闸，其首行 `if (!origin) return true` ⇒ **不带
// Origin 头的请求一律放行**。这既让 curl/node/python 可直调 `/read-file` `/write-file`
// `/config`（含明文 provider token），也把浏览器的 `<img>`/`<script>`/表单 GET（**不发 Origin**）
// 变成对任意网页开放的 CSRF 触发面——D1 收窄监听只切断局域网，堵不住这一层。
//
// 本文件钉四件事，**缺一件就可能是假绿**：
//   ① 闸门存在且 **fail-closed**（不得出现"没配 token 就放行"的分支）；令牌不得进日志。
//   ② 令牌**贯通到每个本机客户端**（main 的 /boot-status 与 WS、诊断模块、桌宠、桥 spawn env）——
//      只断言 401 会在"闸门把所有人都挡了"时通过，所以必须同时断言既有客户端全通。
//   ③ 真机正反两面：无 Origin 无 token → 401；带 token（头/query）→ 200；错 token → 401；
//      空 Origin（可构造的旁路）→ 401。
//   ④ 带 Origin 的两类既有客户端**零改动仍通**：打包版渲染层形态（`Origin: null`）与 dev
//      浏览器形态（`Origin: http://localhost:5197`）；`/health`、`/api/auth/*` 免令牌。
//
// 不 spawn 内核、不出网（PONOS_MOCK_API=1 + 隔离 home）；finally 收进程清临时目录。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import http from 'node:http'
import { WebSocket } from 'ws'
import { TEST_BRIDGE_TOKEN, authHeaders, withToken } from './test-bridge-auth.mjs'
import { bridgeTokenPath, isTokenExemptPath, authorizeBridgeRequest, isTokenValid } from './bridge-token.cjs'

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

/** spawn 桥：`token` 为 null 表示不给 env 令牌（考察"自生成 + 仍然 fail-closed"）。 */
function spawnBridge(home, port, token) {
  const env = {
    ...process.env,
    PONOS_MOCK_API: '1',
    YFW_BRIDGE_PORT: String(port),
    YFW_AUTH_FILE: join(home, 'auth.json'),
    YFWORKING_HOME: home,
    PONOS_CONFIG_DIR: home,
  }
  delete env.PONOS_HOME
  if (token) env.YFW_BRIDGE_TOKEN = token
  else delete env.YFW_BRIDGE_TOKEN
  const proc = spawn(process.execPath, [BRIDGE_ENTRY], { cwd: REPO_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const out = []
  const state = { exitInfo: null }
  let errTail = ''
  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')
  proc.stdout.on('data', (d) => { out.push(String(d)) })
  proc.stderr.on('data', (d) => { errTail = (errTail + String(d)).slice(-2000) })
  proc.once('exit', (code, signal) => { state.exitInfo = { code, signal } })
  return { proc, state, stdout: () => out.join(''), stderrTail: () => errTail }
}

async function waitReady(b, port) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (b.stdout().includes(`[bridge] listening 127.0.0.1:${port} (loopback only)`) || b.stdout().includes(`http+ws://localhost:${port}`)) return
    if (b.state.exitInfo) throw new Error(`bridge exited before ready: ${JSON.stringify(b.state.exitInfo)}; stderr tail: ${b.stderrTail()}`)
    await sleep(50)
  }
  throw new Error(`bridge 未在 ${READY_TIMEOUT_MS}ms 内就绪；stderr tail: ${b.stderrTail()}`)
}

async function stopBridge(b) {
  try { b.proc.kill() } catch {}
  await new Promise((resolve) => {
    if (b.state.exitInfo) return resolve()
    const t = setTimeout(resolve, 3000)
    b.proc.once('exit', () => { clearTimeout(t); resolve() })
  })
}

/** 发一次 HTTP 请求；返回 { status, body }（status 0 = 连接层失败）。 */
function httpReq(port, path, { method = 'GET', headers = {}, timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    let req
    try {
      req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        let buf = ''
        res.on('data', (d) => { buf += d })
        res.on('end', () => resolve({ status: res.statusCode, body: buf }))
      })
    } catch (e) { return resolve({ status: 0, error: e.message }) }
    req.on('error', (e) => resolve({ status: 0, error: e.message }))
    req.setTimeout(timeoutMs, () => { try { req.destroy(new Error('timeout')) } catch {} })
    req.end()
  })
}

/**
 * 带预算重试的请求：**只对"连接层失败/超时"（status 0）重试**。
 * 为什么需要：`waitReady` 以监听日志为就绪判据，而监听回调里紧随 `autoInstall*`/`autoProbe*` 等
 * 启动期工作——全量并发跑（数百个测试同时 spawn 桥/内核）时事件循环被占住，首个请求可能超时
 * （首版实测即 `{"status":0,"error":"timeout"}` 的假红）。收到任何 HTTP 状态即为确定性结果，立即返回：
 * 闸门的语义（401/200/403）不受影响，被容忍的只是"启动期忙"。
 */
async function httpReqSettled(port, path, opts = {}, { budgetMs = 20000 } = {}) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const last = await httpReq(port, path, opts)
    if (last.status !== 0) return last
    if (Date.now() > deadline) return last
    await sleep(250)
  }
}

/**
 * WS 探测。服务端对非法握手**先完成 upgrade 再 1008 关闭**（与既有 origin 拒绝同一形态，
 * 见 bridge.mjs 的 wss.on('connection')），故"是否被接受"要观察一小段：open 后未在 settleMs
 * 内被关闭才算接受。
 */
function wsProbe(url, { headers = {}, timeoutMs = 5000, settleMs = 800 } = {}) {
  return new Promise((resolve) => {
    let ws
    let opened = false
    let settled = false
    const finish = (v) => { if (!settled) { settled = true; try { ws && ws.close() } catch {} ; resolve(v) } }
    try { ws = new WebSocket(url, { headers }) } catch (e) { return resolve({ opened: false, accepted: false, error: String(e && e.message) }) }
    const timer = setTimeout(() => finish({ opened, accepted: opened, closeCode: null, error: 'timeout' }), timeoutMs)
    ws.on('open', () => {
      opened = true
      setTimeout(() => { clearTimeout(timer); finish({ opened, accepted: true, closeCode: null }) }, settleMs)
    })
    ws.on('close', (code) => { clearTimeout(timer); finish({ opened, accepted: false, closeCode: code }) })
    ws.on('error', (e) => { clearTimeout(timer); finish({ opened, accepted: false, error: e && e.message }) })
  })
}

// ---------------------------------------------------------------------------
// ① 纯函数：闸门语义与豁免清单（不 spawn，失败定位最快）
// ---------------------------------------------------------------------------
test('纯函数：无 Origin 必须持 token；带 Origin 归 origin 闸；豁免面只含 /health 与 /api/auth/*', () => {
  const req = (headers, url = '/config') => ({ url, headers })
  // 无 Origin
  assert.equal(authorizeBridgeRequest(req({}), TEST_BRIDGE_TOKEN).ok, false, '无 Origin 无 token 必须拒绝')
  assert.equal(authorizeBridgeRequest(req({ 'x-yfw-bridge-token': TEST_BRIDGE_TOKEN }), TEST_BRIDGE_TOKEN).ok, true, '无 Origin 带正确 token 必须放行')
  assert.equal(authorizeBridgeRequest(req({ 'x-yfw-bridge-token': 'wrong' }), TEST_BRIDGE_TOKEN).ok, false, '错误 token 必须拒绝')
  assert.equal(authorizeBridgeRequest(req({}, '/config?token=' + TEST_BRIDGE_TOKEN), TEST_BRIDGE_TOKEN).ok, true, 'query token 必须放行')
  // 空 Origin 是可构造的旁路（isAllowedOrigin('') 因 !origin 返回 true），必须进 token 闸
  assert.equal(authorizeBridgeRequest(req({ origin: '' }), TEST_BRIDGE_TOKEN).ok, false, '空 Origin 必须按"无 Origin"处理')
  // 带 Origin → 交给 origin 白名单（第二道），不查 token
  assert.equal(authorizeBridgeRequest(req({ origin: 'null' }), TEST_BRIDGE_TOKEN).ok, true, '打包版渲染层形态（Origin: null）应放行')
  assert.equal(authorizeBridgeRequest(req({ origin: 'http://localhost:5197' }), TEST_BRIDGE_TOKEN).ok, true, 'dev 浏览器形态应放行')
  // 豁免
  assert.equal(isTokenExemptPath('/health'), true)
  assert.equal(isTokenExemptPath('/api/auth/status'), true)
  for (const p of ['/config', '/read-file', '/write-file', '/known-folders', '/diag/info']) {
    assert.equal(isTokenExemptPath(p), false, `${p} 不得免令牌`)
  }
  // fail-closed：期望值为空一律失败
  assert.equal(isTokenValid('', ''), false, '期望值为空必须判失败（不存在"没配 token 即放行"）')
  assert.equal(isTokenValid(TEST_BRIDGE_TOKEN, ''), false)
  assert.equal(isTokenValid(TEST_BRIDGE_TOKEN, TEST_BRIDGE_TOKEN), true)
})

// ---------------------------------------------------------------------------
// ② 静态：闸门无 fail-open 分支、令牌不漏日志、令牌贯通到每个本机客户端
// ---------------------------------------------------------------------------
test('静态：闸门 fail-closed、令牌不进日志、且已贯通 main/诊断/桌宠/spawn env', () => {
  const bridgeSrc = readFileSync(join(REPO_ROOT, 'server', 'bridge.mjs'), 'utf8')
  assert.match(bridgeSrc, /authorizeBridgeRequest\(req, BRIDGE_TOKEN\)/, 'HTTP 与 WS 必须走同一条闸门判定')
  // fail-open 的两种写法都必须绝迹：条件式放行、令牌存在与否参与分支
  assert.doesNotMatch(bridgeSrc, /if\s*\(\s*!\s*BRIDGE_TOKEN\s*\)/, '不得存在"未配 token 即放行"的分支')
  assert.doesNotMatch(bridgeSrc, /BRIDGE_TOKEN\s*\?/, '不得用"令牌是否配置"做条件放行')
  const logLines = bridgeSrc.split(/\r?\n/).filter((l) => /console\.(log|warn|error)/.test(l))
  for (const l of logLines) {
    // 负向断言只针对**令牌值/变量**：`YFW_BRIDGE_TOKEN`（env 变量名）与 `BRIDGE_TOKEN_INFO`
    // （来源/路径对象）都允许出现在日志里——允许的是"来源与路径"，禁止的是"值"。
    assert.doesNotMatch(l, /(?<!YFW_)BRIDGE_TOKEN\b/, `日志不得打印令牌值（可打印来源/路径）：${l.trim()}`)
  }

  const mainSrc = readFileSync(join(REPO_ROOT, 'electron', 'main.cjs'), 'utf8')
  assert.match(mainSrc, /YFW_BRIDGE_TOKEN:\s*BRIDGE_TOKEN/, 'main 必须把令牌注入桥的 spawn env')
  assert.match(mainSrc, /env\[BRIDGE_TOKEN_ENV\]\s*=\s*BRIDGE_TOKEN/, '桌宠 spawn env 必须带令牌')
  assert.match(mainSrc, /headers:\s*bridgeAuthHeaders\(\)/, '主进程的 /boot-status 与 WS 必须带令牌')
  assert.match(mainSrc, /new WebSocket\('ws:\/\/127\.0\.0\.1:' \+ BRIDGE_PORT, \{ headers: bridgeAuthHeaders\(\) \}\)/, '主进程 WS 必须带令牌')
  assert.match(mainSrc, /bridgeToken:\s*BRIDGE_TOKEN/, '诊断模块必须拿到令牌（否则诊断恒报 bridge error）')
  assert.match(mainSrc, /resolveBridgeToken\(\{ home: resolveYfwHome\(\) \}\)/, '令牌必须经公共模块解析（与桥同一份规则，保证"接管遗留桥"不 401）')

  const diagSrc = readFileSync(join(REPO_ROOT, 'electron', 'diag-monitor.cjs'), 'utf8')
  assert.match(diagSrc, /bridgeToken/, '诊断模块必须接受令牌参数')

  const petSrc = readFileSync(join(REPO_ROOT, 'pet', 'jiajia-pet.py'), 'utf8')
  assert.match(petSrc, /YFW_BRIDGE_TOKEN/, '桌宠必须读令牌 env')
  assert.match(petSrc, /bridge-token/, '桌宠必须能回落到落盘令牌文件（单独启动时的通道）')
  assert.match(petSrc, /x-yfw-bridge-token: \{BRIDGE_TOKEN\}/, '桌宠 WS 握手必须带令牌头')
})

// ---------------------------------------------------------------------------
// ③+④ 真机：闸门正反两面 + 既有两类带 Origin 客户端零改动仍通
// ---------------------------------------------------------------------------
test('真机：无 Origin 无 token → 401；带 token → 200；带 Origin 的两类既有客户端仍通', { timeout: 90000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-auth-'))
  const port = await freePort()
  const b = spawnBridge(home, port, TEST_BRIDGE_TOKEN)
  try {
    await waitReady(b, port)
    const hdrs = authHeaders()

    // (1) 无 Origin、无 token → 401（GET 与 POST 都要拦在路由之前）
    const anonGet = await httpReqSettled(port, '/known-folders')
    assert.equal(anonGet.status, 401, `无 Origin 无 token 的 GET 必须 401（实际 ${JSON.stringify(anonGet)}）`)
    const anonPost = await httpReqSettled(port, '/write-file', { method: 'POST' })
    assert.equal(anonPost.status, 401, `无 Origin 无 token 的 POST 必须 401（不能落到路由再报 400）——实际 ${JSON.stringify(anonPost)}`)

    // (2) 空 Origin 不得成为旁路
    const emptyOrigin = await httpReqSettled(port, '/known-folders', { headers: { origin: '' } })
    assert.equal(emptyOrigin.status, 401, '空 Origin 必须按"无 Origin"处理（否则是可构造旁路）')

    // (3) 无 Origin + 正确 token（头/query 两路）→ 200
    const byHeader = await httpReqSettled(port, '/known-folders', { headers: hdrs })
    assert.equal(byHeader.status, 200, `带头部令牌必须 200（实际 ${JSON.stringify(byHeader)}）`)
    const byQuery = await httpReqSettled(port, `/known-folders?token=${TEST_BRIDGE_TOKEN}`)
    assert.equal(byQuery.status, 200, `带 query 令牌必须 200（实际 ${JSON.stringify(byQuery)}）`)

    // (4) 错误 token → 401
    const wrong = await httpReqSettled(port, '/known-folders', { headers: { 'x-yfw-bridge-token': 'nope' } })
    assert.equal(wrong.status, 401, '错误 token 必须 401')

    // (5) 既有带 Origin 客户端零改动仍通：打包版渲染层（Origin: null）与 dev 浏览器形态
    const renderer = await httpReqSettled(port, '/known-folders', { headers: { origin: 'null' } })
    assert.equal(renderer.status, 200, `打包版渲染层形态（Origin: null，无 token）必须仍通——D2 不得让既有客户端失联（实际 ${JSON.stringify(renderer)}）`)
    const devBrowser = await httpReqSettled(port, '/known-folders', { headers: { origin: 'http://localhost:5197' } })
    assert.equal(devBrowser.status, 200, `dev 浏览器形态（Origin: http://localhost:5197）必须仍通（实际 ${JSON.stringify(devBrowser)}）`)

    // (6) 外部网页 Origin 仍被 origin 闸拦下（第二道没有被 D2 削弱）
    const evil = await httpReqSettled(port, '/known-folders', { headers: { origin: 'https://evil.example' } })
    assert.equal(evil.status, 403, `非白名单 Origin 必须 403（实际 ${JSON.stringify(evil)}）`)

    // (7) 豁免面：/health 与 /api/auth/* 免令牌（否则启动兜底与登录屏会一起挂）
    const health = await httpReqSettled(port, '/health')
    assert.equal(health.status, 200, '/health 应免令牌')
    const authStatus = await httpReqSettled(port, '/api/auth/status')
    assert.equal(authStatus.status, 200, '/api/auth/status 应免令牌（登录屏前置依赖）')
    // 但非豁免端点不得被豁免面带偏
    const diagNoToken = await httpReqSettled(port, '/diag/info')
    assert.equal(diagNoToken.status, 401, '/diag/info 不属豁免面，必须 401')
  } finally {
    await stopBridge(b)
    rmSyncRetry(home)
  }
})

// ---------------------------------------------------------------------------
// ⑤ 真机：无 env 令牌时自生成并 0600 落盘，且**照样 fail-closed**
// ---------------------------------------------------------------------------
test('真机：env 无令牌时自生成落盘（0600）且不因缺配置而放行', { timeout: 90000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-authgen-'))
  const port = await freePort()
  const b = spawnBridge(home, port, null)
  try {
    await waitReady(b, port)
    // 自生成 → 落盘（桌宠/脚本/dev 的通道）
    const filePath = bridgeTokenPath(home)
    const persisted = readFileSync(filePath, 'utf8').trim()
    assert.ok(persisted.length >= 32, `落盘令牌应为足够长的随机串（实际长度 ${persisted.length}）`)
    if (process.platform !== 'win32') {
      const mode = statSync(filePath).mode & 0o777
      assert.equal(mode, 0o600, `令牌文件权限应为 0600（实际 ${mode.toString(8)}）`)
    }
    // 关键：**fail-closed**——没有 env 配置不等于放行
    const anon = await httpReqSettled(port, '/known-folders')
    assert.equal(anon.status, 401, '自生成模式下无令牌请求仍必须 401（不得"没配 token 就放行"）')
    const withFileToken = await httpReqSettled(port, '/known-folders', { headers: { 'x-yfw-bridge-token': persisted } })
    assert.equal(withFileToken.status, 200, `持落盘令牌的客户端必须全通（实际 ${JSON.stringify(withFileToken)}）`)
    // 令牌不得出现在启动日志里
    assert.ok(!b.stdout().includes(persisted), '启动日志不得包含令牌值（只允许打印路径）')
    assert.ok(b.stdout().includes(filePath), '启动日志应打印令牌文件路径，便于排查')
  } finally {
    await stopBridge(b)
    rmSyncRetry(home)
  }
})

// ---------------------------------------------------------------------------
// ⑥ 真机：WS 闸门（无 Origin 的 WS 客户端必须持令牌；渲染层形态仍通）
// ---------------------------------------------------------------------------
test('真机：WS 无令牌被拒、带头部或 query 令牌通过、渲染层形态仍通', { timeout: 90000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-authws-'))
  const port = await freePort()
  const b = spawnBridge(home, port, TEST_BRIDGE_TOKEN)
  const base = `ws://127.0.0.1:${port}`
  try {
    await waitReady(b, port)

    const anon = await wsProbe(base)
    assert.equal(anon.accepted, false, `无令牌 WS 必须被拒（实际 ${JSON.stringify(anon)}）`)
    assert.ok(anon.closeCode === 1008 || !!anon.error, `拒绝应体现为 1008 关闭或握手错误（实际 ${JSON.stringify(anon)}）`)

    const byHeader = await wsProbe(base, { headers: authHeaders() })
    assert.equal(byHeader.accepted, true, `带头部令牌的 WS 必须接受（实际 ${JSON.stringify(byHeader)}）`)

    const byQuery = await wsProbe(withToken(base))
    assert.equal(byQuery.accepted, true, `带 query 令牌的 WS 必须接受（实际 ${JSON.stringify(byQuery)}）`)

    // 渲染层 WS（浏览器上下文必带 Origin）零改动仍通——这是"小窗/宠物全通"里最关键的一条
    const rendererWs = await wsProbe(base, { headers: { origin: 'null' } })
    assert.equal(rendererWs.accepted, true, `打包版渲染层 WS（Origin: null，无 token）必须仍通（实际 ${JSON.stringify(rendererWs)}）`)
  } finally {
    await stopBridge(b)
    rmSyncRetry(home)
  }
})
