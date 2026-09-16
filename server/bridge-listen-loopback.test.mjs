// S2-D1 收窄监听回归网（spec §6.2 D1、§10「S2 验收 1」）
// ---------------------------------------------------------------------------
// 改前事实：`httpServer.listen(PORT)` **未指定 host** ⇒ 绑所有网卡（实测 `0.0.0.0:51517`
// LISTENING），同网段任何设备都能直调全部端点；而桥的 origin 校验对"不带 Origin 头的非浏览器
// 客户端"一律放行 ⇒ 局域网内可直接读/写任意文件、读 `/config`（含明文 provider token）。
//
// 本文件钉两件事，**两件都不可省**：
//   ① 静态面：服务端 listen 必须带回环 host；四处客户端必须显式写 127.0.0.1（不得回到
//      `localhost`——Windows 上它先解析 ::1，而桥已不监听 IPv6 回环 ⇒ 静默失联）。
//   ② 真机面：起真桥（隔离 home + 随机端口 + mock API），断言**回环可达**、**局域网地址不可达**、
//      **IPv6 回环不可达**、netstat 无 `0.0.0.0`/`[::]` 监听。
//
// 为什么必须同时有"回环可达"：只断言"局域网不可达"会在**桥根本没起来**时也通过（假绿）。
// 为什么必须同时有"IPv6 回环不可达"：它正是"客户端必须写 127.0.0.1"这条约束的存在理由——
// 若桥同时监听了 ::1，这条断言会红，提示有人把决策改成了双栈（那时客户端约定需一并复核）。
// 不 spawn 内核、不出网（PONOS_MOCK_API=1 且隔离 home 无 provider 配置）；finally 清进程与目录。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir, networkInterfaces } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import http from 'node:http'
import { WebSocket } from 'ws'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const BRIDGE_ENTRY = join(REPO_ROOT, 'server', 'bridge.mjs')
const READY_TIMEOUT_MS = 15000

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// Windows 并发下子进程句柄释放有延迟，rmSync 会偶发 EPERM——重试兜底（照 auth-preflight 先例）
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

/** 本机第一个非回环 IPv4（"局域网地址"的真实样本）；无则返回 null */
function firstLanIPv4() {
  const ifs = networkInterfaces()
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if (a && a.family === 'IPv4' && !a.internal) return a.address
    }
  }
  return null
}

/** 取一次 HTTP 状态码；连接失败/超时返回 { error } 而不是抛 */
function httpProbe(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    let req
    try {
      req = http.get(url, (res) => { res.resume(); finish({ status: res.statusCode }) })
    } catch (e) {
      return finish({ error: e.message })
    }
    req.setTimeout(timeoutMs, () => { try { req.destroy(new Error('timeout')) } catch {} })
    req.on('error', (e) => finish({ error: e.message }))
  })
}

/** 带总预算的 HTTP 状态探测：抖动/启动期忙时重试——"慢"不等于"不可达"，反之亦然 */
async function httpProbeUntil(url, expectStatus, { budgetMs = 25000, perTryMs = 5000 } = {}) {
  const deadline = Date.now() + budgetMs
  let last = null
  while (Date.now() < deadline) {
    last = await httpProbe(url, perTryMs)
    if (last.status === expectStatus) return last
    await sleep(200)
  }
  return last
}

/** WS 握手探测（模拟主进程 C3 / 桌宠 C4 的连接方式）；成功即手；失败给 errno 文案 */
function wsProbe(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let ws
    let done = false
    const finish = (v) => { if (!done) { done = true; try { ws && ws.close() } catch {} ; resolve(v) } }
    try { ws = new WebSocket(url) } catch (e) { return resolve({ ok: false, error: String(e && e.message) }) }
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs)
    ws.on('open', () => { clearTimeout(timer); finish({ ok: true }) })
    ws.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: e && e.message }) })
  })
}

// ---------------------------------------------------------------------------
// ① 静态面：禁止回退到"绑所有网卡"或 `localhost` 双栈解析
// ---------------------------------------------------------------------------
test('静态：listen 必须显式绑回环，四处客户端必须显式 127.0.0.1', () => {
  const bridgeSrc = readFileSync(join(REPO_ROOT, 'server', 'bridge.mjs'), 'utf8')
  assert.match(bridgeSrc, /const LOOPBACK_HOST = '127\.0\.0\.1'/, 'bridge 必须定义回环 host 常量')
  assert.match(bridgeSrc, /httpServer\.listen\(PORT, LOOPBACK_HOST/, 'listen 必须带回环 host（绑 0.0.0.0 = 局域网可直调全部端点）')
  assert.doesNotMatch(bridgeSrc, /httpServer\.listen\(PORT,\s*\(/, 'listen 不得回到"未指定 host"的写法')

  // 纯逻辑断言（逻辑层可被 node --test 直读）：客户端基址必须是 IPv4 回环
  const cfgSrc = readFileSync(join(REPO_ROOT, 'src', 'lib', 'config.ts'), 'utf8')
  assert.match(cfgSrc, /http:\/\/127\.0\.0\.1:\$\{__BRIDGE_PORT__\}/, '渲染层基址必须写 127.0.0.1')
  assert.doesNotMatch(cfgSrc, /http:\/\/localhost:\$\{__BRIDGE_PORT__\}/, '渲染层不得用 localhost（Windows 上先解析 ::1，桥已不监听）')

  const mainSrc = readFileSync(join(REPO_ROOT, 'electron', 'main.cjs'), 'utf8')
  assert.match(mainSrc, /http:\/\/127\.0\.0\.1:\$\{BRIDGE_PORT\}\/health/, '主进程健康轮询必须写 127.0.0.1')
  assert.match(mainSrc, /new WebSocket\('ws:\/\/127\.0\.0\.1:' \+ BRIDGE_PORT\)/, '主进程 WS 必须写 127.0.0.1')
  assert.doesNotMatch(mainSrc, /ws:\/\/localhost:/, '主进程不得留 ws://localhost:（桥侧事件通道会静默失联）')

  const petSrc = readFileSync(join(REPO_ROOT, 'pet', 'jiajia-pet.py'), 'utf8')
  assert.match(petSrc, /ws:\/\/127\.0\.0\.1:\{BRIDGE_PORT\}/, '桌宠必须写 127.0.0.1')
  assert.doesNotMatch(petSrc, /ws:\/\/localhost:/, '桌宠不得用 localhost（create_connection 会先试 ::1）')
})

// ---------------------------------------------------------------------------
// ② 真机面：真起桥，验证"只有回环可达"
// ---------------------------------------------------------------------------
test('真机：回环可达、局域网地址与 IPv6 回环均不可达、netstat 只有 127.0.0.1', { timeout: 90000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-loopback-'))
  const port = await freePort()
  const env = {
    ...process.env,
    PONOS_MOCK_API: '1',
    YFW_BRIDGE_PORT: String(port),
    YFW_AUTH_FILE: join(home, 'auth.json'),
    YFWORKING_HOME: home,
    PONOS_CONFIG_DIR: home,
  }
  delete env.PONOS_HOME // 防止宿主演进到解析链
  const proc = spawn(process.execPath, [BRIDGE_ENTRY], { cwd: REPO_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const out = []
  let errTail = ''
  const state = { exitInfo: null }
  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')
  proc.stdout.on('data', (d) => { out.push(String(d)) })
  proc.stderr.on('data', (d) => { errTail = (errTail + String(d)).slice(-2000) })
  proc.once('exit', (code, signal) => { state.exitInfo = { code, signal } })
  try {
    // 等就绪：新日志行 `listening 127.0.0.1:<port> (loopback only)`（旧文案仍在其前一行，
    // 二者都接受——就绪判据不依赖本次新增文案，避免"测试与实现互锁"）
    const deadline = Date.now() + READY_TIMEOUT_MS
    let ready = false
    while (Date.now() < deadline) {
      const text = out.join('')
      if (text.includes(`[bridge] listening 127.0.0.1:${port} (loopback only)`) || text.includes(`http+ws://localhost:${port}`)) { ready = true; break }
      if (state.exitInfo) throw new Error(`bridge exited before ready: ${JSON.stringify(state.exitInfo)}; stderr tail: ${errTail}`)
      await sleep(50)
    }
    assert.ok(ready, `bridge 未在 ${READY_TIMEOUT_MS}ms 内就绪；stderr tail: ${errTail}`)

    // (1) 回环可达——这一步先证"服务本身活着"，否则下面的不可达断言全是假绿。
    // 为什么带预算重试：listen 回调里紧跟 autoInstall*/autoProbe* 等启动期工作，全量并发跑
    // （数十个测试同时 spawn 桥/electron）时事件循环被占住，单次 2s 探测会**假红**（首版实测
    // 即 `{"error":"timeout"}`）。判据是"最终可达"，不是"必须在 2s 内响应"。
    const loop = await httpProbeUntil(`http://127.0.0.1:${port}/health`, 200)
    assert.equal(loop.status, 200, `127.0.0.1 回环必须可达（实际 ${JSON.stringify(loop)}）`)

    // (2) WS 回环握手（模拟 electron 主进程 / 桌宠的连法）；同 (1) 带预算重试
    let wsOk = null
    const wsDeadline = Date.now() + 20000
    while (Date.now() < wsDeadline) {
      wsOk = await wsProbe(`ws://127.0.0.1:${port}`)
      if (wsOk.ok) break
      await sleep(250)
    }
    assert.equal(wsOk.ok, true, `ws://127.0.0.1:${port} 必须握手成功（实际 ${JSON.stringify(wsOk)}）`)

    // (3) 局域网地址不可达（收窄的核心证据）。连接应被立即拒绝；超时同样算"不可达"（某些
    // 安全软件会静默丢弃到本机非回环地址的包），故此处只断言"拿不到 200"——桥自身活着已由
    // (1)(2) 在同一测试内证明，不存在"桥假死被误判成不可达"的空子。
    const lan = firstLanIPv4()
    if (lan) {
      const lanProbe = await httpProbe(`http://${lan}:${port}/health`, 5000)
      assert.notEqual(lanProbe.status, 200, `局域网地址 ${lan}:${port} 不得可达（实际 ${JSON.stringify(lanProbe)}）`)
    }

    // (4) IPv6 回环不可达 ⇒ 说明"客户端必须显式 127.0.0.1"这条约定是必要且当前成立的
    const v6 = await httpProbe(`http://[::1]:${port}/health`, 5000)
    assert.notEqual(v6.status, 200, `IPv6 回环 [::1]:${port} 不应可达（若可达说明改成双栈了，需同步复核客户端约定）`)

    // (5) netstat：监听行只允许 127.0.0.1（Windows 专有；其它平台跳过）
    if (process.platform === 'win32') {
      const netstat = execSync('netstat -ano -p tcp', { timeout: 5000 }).toString()
      const listenLines = netstat.split(/\r?\n/).filter((l) => l.includes(`:${port}`) && /LISTENING/i.test(l))
      assert.ok(listenLines.length >= 1, `netstat 应能看到 ${port} 的 LISTENING 行`)
      for (const line of listenLines) {
        assert.match(line.trim(), new RegExp(`^TCP\\s+127\\.0\\.0\\.1:${port}\\s`), `监听行必须只有 127.0.0.1：${line.trim()}`)
      }
    }
  } finally {
    try { proc.kill() } catch {}
    await new Promise((resolve) => {
      if (state.exitInfo) return resolve()
      const t = setTimeout(resolve, 3000)
      proc.once('exit', () => { clearTimeout(t); resolve() })
    })
    rmSyncRetry(home)
  }
})
