// 网络代理配置的回归网（P1「应用内增加网络VPN代理配置功能」，2026-09-17）。
// ---------------------------------------------------------------------------
// 本文件钉两层面：
//   ① **接线与治理（静态）**：桥与主进程必须引用 shared/proxy-config.* 的**唯一实现**、
//      不得各自再写一份；`off` 必须是默认档；非法配置必须**保存即失败**（不得静默保留现值）。
//   ② **真机端到端**：真起桥（隔离 home + 随机端口 + 假代理），验证
//      · 新装的代理档位 = off（与本方案落地前行为一致）
//      · manual 合法值→ 落盘可读回；非法值 → 400 + **磁盘不变**
//      · `/config` 回显打码；把打码值发回保存（用户只改端口）→ 落盘必须是**真密码**
//      · 局部补丁（只发 bypass）→ mode/url 保留
//      · **桥自身出网真的走代理**（假代理收到 CONNECT）且**回环不被代理掉**（F4 锁）
// 纪律：不 import `server/bridge.mjs`（入口模块，import 即 bind 端口）；不 spawn 内核、不出外网。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import http from 'node:http'
import { TEST_BRIDGE_TOKEN, authHeaders } from './test-bridge-auth.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const BRIDGE_ENTRY = join(REPO_ROOT, 'server', 'bridge.mjs')
const readSrc = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8')

// ---------------------------------------------------------------------------
// ① 静态：唯一实现 + off 默认 + 非法即失败
// ---------------------------------------------------------------------------
test('静态：桥与主进程共用 shared/proxy-config 的唯一实现，且 off 是默认档', () => {
  const bridge = readSrc('server/bridge.mjs')
  assert.match(bridge, /from '\.\.\/shared\/proxy-config\.mjs'/, '桥必须引用 shared 的唯一实现')
  assert.match(bridge, /Object\.assign\(env, nodeProxyEnv\(/, 'buildChildEnv 必须合并 Node 轨代理 env')
  assert.match(bridge, /network: \{ proxy: \{ mode: 'off', url: '', bypass: '' \} \}/,
    '默认档必须是 off（零回归基线），不得默认跟随系统或写死某个代理地址')
  assert.match(bridge, /if \('network' in out\)/, 'sanitizeConfigPatch 必须钳制 network（落盘前再挡一次）')
  assert.match(bridge, /throw new Error\(`网络代理配置非法/,
    '非法代理配置必须让保存失败 —— 静默保留现值会让用户以为配好了、实际走直连')
  assert.match(bridge, /return reply\(400, \{ 'Content-Type': 'application\/json' \}, JSON\.stringify\(\{ ok: false, error: e\.message \}\)\)/,
    'POST /config 必须把保存失败如实回 400 + 原因（回 200 ok:true 等于骗界面）')
  // 打码：GET 与 POST 的返回值都要过脱敏（URL 可能含 user:pass@）
  assert.match(bridge, /JSON\.stringify\(redactProxyConfig\(cfg\)\)/, 'GET /config 必须给代理 URL 打码')
  assert.match(bridge, /config: redactProxyConfig\(saved\)/, 'POST /config 的返回也要打码（与 GET 同口径）')
  assert.doesNotMatch(bridge, /function normalizeProxyConfig/, '桥内不得再写一份策略副本（会与 shared 漂移）')

  const main = readSrc('electron/main.cjs')
  assert.match(main, /require\('\.\.\/shared\/proxy-config\.cjs'\)/, '主进程必须用同一份 CJS 实现')
  assert.match(main, /\.\.\.BRIDGE_PROXY_ENV,/, '桥进程 env 必须注入 Node 轨代理变量')
  assert.match(main, /app\.on\('session-created', \(s\) => \{ installBridgeHeaderInjector\(s\); applyChromiumProxy\(s\) \}\)/,
    '新建 session 必须同时装代理（令牌注入与代理**方向相反**：令牌不进 automation 分区、代理必须进）')
  // 两行之间隔着注释，故用"就近出现"的宽松匹配（顺序 + 同处 ready 块是我们要的性质）
  assert.match(main, /installBridgeHeaderInjector\(session\.defaultSession\)[\s\S]{0,400}?applyChromiumProxy\(session\.defaultSession\)/,
    'defaultSession 早于 session-created 监听建立，必须显式补一次（否则主窗口不走代理）')
  assert.match(main, /if \(!CHROMIUM_PROXY\) return false/,
    'off 时不得调用 setProxy —— 不干预 ≠ 强制直连（Chromium 默认跟随系统代理）')
})

// ---------------------------------------------------------------------------
// ② 真机：配置读写 + 打码回填 + 非法不改盘 + 出网确实走代理
// ---------------------------------------------------------------------------
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 起一个记录请求的**假代理**：CONNECT（https）与普通请求都记下来，并立即回 502（快失败）。 */
function startFakeProxy() {
  const seen = { connect: [], request: [] }
  const srv = http.createServer((req, res) => {
    seen.request.push(`${req.method} ${req.url}`)
    res.writeHead(502, { 'Content-Type': 'text/plain' })
    res.end('fake-proxy')
  })
  srv.on('connect', (req, socket) => {
    seen.connect.push(req.url)
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
  })
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, port: srv.address().port }))
  })
}

async function startBridge(env) {
  const proc = spawn(process.execPath, [BRIDGE_ENTRY], { cwd: REPO_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const out = []
  let errTail = ''
  const state = { exitInfo: null }
  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')
  proc.stdout.on('data', (d) => out.push(String(d)))
  proc.stderr.on('data', (d) => { errTail = (errTail + String(d)).slice(-2000) })
  proc.once('exit', (code, signal) => { state.exitInfo = { code, signal } })
  const port = env.YFW_BRIDGE_PORT
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (out.join('').includes(`[bridge] listening 127.0.0.1:${port} (loopback only)`) || out.join('').includes(`http+ws://localhost:${port}`)) {
      return { proc, out: () => out.join(''), err: () => errTail, state }
    }
    if (state.exitInfo) throw new Error(`bridge exited before ready: ${JSON.stringify(state.exitInfo)}; stderr: ${errTail}`)
    await sleep(50)
  }
  throw new Error(`bridge 未就绪；stderr tail: ${errTail}`)
}

async function postConfig(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/config`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  })
  let json = null
  try { json = await res.json() } catch { /* 非 JSON 响应：保持 null，由断言报出状态码 */ }
  return { status: res.status, json }
}

async function getConfig(port) {
  const res = await fetch(`http://127.0.0.1:${port}/config`, { headers: authHeaders() })
  return res.json()
}

const diskProxy = (home) => {
  const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
  return (cfg.network && cfg.network.proxy) || null
}

test('真机：off 默认 → manual 落盘 → 打码回显 → 回填真密码 → 非法不改盘 → 局部补丁', { timeout: 120000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-proxy-'))
  const port = await freePort()
  const env = {
    ...process.env,
    PONOS_MOCK_API: '1',
    YFW_BRIDGE_PORT: String(port),
    YFW_AUTH_FILE: join(home, 'auth.json'),
    YFWORKING_HOME: home,
    PONOS_CONFIG_DIR: home,
    YFW_BRIDGE_TOKEN: TEST_BRIDGE_TOKEN,
  }
  delete env.PONOS_HOME // 防宿主演进到解析链
  // 刻意**不**给桥注入代理 env：本用例验证配置面；出网面（走真实代理）另有专测。
  delete env.HTTP_PROXY; delete env.HTTPS_PROXY; delete env.NO_PROXY
  let bridge = null
  try {
    bridge = await startBridge(env)
    // (1) 新装 = off（与本方案落地前行为一致的直接证据）
    const initial = await getConfig(port)
    assert.equal(initial.network.proxy.mode, 'off', '新装必须默认 off')
    assert.equal(diskProxy(home).mode, 'off', '落盘的默认档也必须是 off')

    // (2) manual 合法值 → 200 + 落盘
    const saved = await postConfig(port, { network: { proxy: { mode: 'manual', url: 'http://u:realpass@127.0.0.1:7890', bypass: ' example.com ' } } })
    assert.equal(saved.status, 200, `合法 manual 应保存成功：${JSON.stringify(saved.json)}`)
    const onDisk = diskProxy(home)
    assert.equal(onDisk.mode, 'manual')
    assert.equal(onDisk.url, 'http://u:realpass@127.0.0.1:7890', '真密码应原样落盘（本次发的是真值）')
    assert.equal(onDisk.bypass, 'example.com', 'bypass 应去空白后落盘')

    // (3) 回显打码：/config 不得把代理密码明文吐给界面
    const shown = await getConfig(port)
    assert.equal(shown.network.proxy.url, 'http://u:***@127.0.0.1:7890', `/config 必须打码：${shown.network.proxy.url}`)
    assert.ok(!JSON.stringify(shown).includes('realpass'), '代理密码不得出现在 /config 响应里')

    // (4) 打码值发回保存（用户只改端口）→ 落盘必须是**真密码**，不能是字面量 ***
    const round = await postConfig(port, { network: { proxy: { url: 'http://u:***@127.0.0.1:7891' } } })
    assert.equal(round.status, 200)
    const afterRound = diskProxy(home)
    assert.equal(afterRound.url, 'http://u:realpass@127.0.0.1:7891', '打码值必须回填真密码（否则代理鉴权失败而用户毫不知情）')
    assert.equal(afterRound.mode, 'manual', '局部补丁不得把 mode 打回默认')

    // (5) 非法值 → 400 + 磁盘**不变**（静默保留现值 = 用户以为配好了、实际直连）
    const badUrl = await postConfig(port, { network: { proxy: { mode: 'manual', url: '127.0.0.1:7890' } } })
    assert.equal(badUrl.status, 400, `非法 URL 必须 400：${JSON.stringify(badUrl.json)}`)
    assert.match(String(badUrl.json && badUrl.json.error), /代理/, '错误信息应点明是代理配置')
    assert.equal(diskProxy(home).url, afterRound.url, '非法保存不得改动磁盘（且不得被降级为 off 静默落盘）')
    const badMode = await postConfig(port, { network: { proxy: { mode: 'yolo' } } })
    assert.equal(badMode.status, 400, '非法模式必须 400')
    assert.equal(diskProxy(home).mode, 'manual', '非法保存后磁盘档位不变')

    // (6) 局部补丁：只发 bypass ⇒ mode/url 继承现值
    const patch = await postConfig(port, { network: { proxy: { bypass: 'a.com, b.com' } } })
    assert.equal(patch.status, 200)
    const afterPatch = diskProxy(home)
    assert.equal(afterPatch.url, afterRound.url, '只改 bypass 不该动 url')
    assert.equal(afterPatch.mode, 'manual')
    assert.equal(afterPatch.bypass, 'a.com,b.com')
    // (7) 切档不丢值：manual → off → 读回 url 仍在（用户切回来不用重填）
    await postConfig(port, { network: { proxy: { mode: 'off' } } })
    assert.equal(diskProxy(home).mode, 'off')
    assert.equal(diskProxy(home).url, afterRound.url, '切到 off 不得丢掉已填的地址')
  } finally {
    try { bridge && bridge.proc.kill() } catch { /* 进程可能已退出 */ }
    rmSyncRetry(home)
  }
})

test('真机：桥自身出网真的走代理（假代理收到 CONNECT），且回环不被代理掉', { timeout: 120000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-proxy-egress-'))
  const port = await freePort()
  const fake = await startFakeProxy()
  const env = {
    ...process.env,
    PONOS_MOCK_API: '1',
    YFW_BRIDGE_PORT: String(port),
    YFW_AUTH_FILE: join(home, 'auth.json'),
    YFWORKING_HOME: home,
    PONOS_CONFIG_DIR: home,
    YFW_BRIDGE_TOKEN: TEST_BRIDGE_TOKEN,
    // 模拟主进程注入的 Node 轨（`electron/main.cjs` 的 `...BRIDGE_PROXY_ENV` 原样）。
    // 回环必须进 NO_PROXY —— 这正是"别把自己代理掉"那条防线（F4）。
    NODE_USE_ENV_PROXY: '1',
    HTTP_PROXY: `http://127.0.0.1:${fake.port}`,
    HTTPS_PROXY: `http://127.0.0.1:${fake.port}`,
    NO_PROXY: '127.0.0.1,localhost,::1',
  }
  delete env.PONOS_HOME
  let bridge = null
  try {
    bridge = await startBridge(env)
    // (1) 回环不被代理掉：桥自身 API 仍可达（若 NO_PROXY 失效，请求会被打到假代理 ⇒ 非 200）
    const cfg = await getConfig(port)
    assert.equal(cfg.network.proxy.mode, 'off', '配置面仍是 off（本用例只验证 env 轨）')

    // (2) 桥自身出网走代理：/test-provider 会向外部 URL 发请求；假代理应收到 CONNECT。
    // 用不可解析的假域名不影响结论——请求根本不出本机，先被代理截住。
    const res = await fetch(`http://127.0.0.1:${port}/test-provider`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ apiBaseUrl: 'https://egress-probe.invalid/v1', authToken: 'x', model: 'm' }),
    })
    assert.equal(res.status, 200, '探测请求本身应正常返回（连接失败是业务结果，不是 5xx）')
    // 等一下让代理侧的连接事件落地
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && fake.seen.connect.length === 0 && fake.seen.request.length === 0) await sleep(100)
    assert.ok(
      fake.seen.connect.length + fake.seen.request.length > 0,
      `假代理应收到桥的出网连接（CONNECT=${JSON.stringify(fake.seen.connect)} REQ=${JSON.stringify(fake.seen.request)}）`,
    )
    assert.ok(fake.seen.connect.some((h) => String(h).includes('egress-probe.invalid')),
      `CONNECT 目标应是探针域名：${JSON.stringify(fake.seen.connect)}`)
    // (3) 回环请求没有进代理（假代理只应看到探针那一次出网）
    assert.equal(fake.seen.connect.filter((h) => String(h).includes('127.0.0.1')).length, 0,
      '回环不得经代理（NO_PROXY 失效即"应用连不上自己的桥"）')
  } finally {
    try { bridge && bridge.proc.kill() } catch { /* 已退出 */ }
    try { fake.srv.close() } catch { /* 已关闭 */ }
    rmSyncRetry(home)
  }
})

test('真机：坏代理下回环仍通（F4 锁）+ 代理环境确实生效（防假绿对照组）', { timeout: 120000 }, async () => {
  // 本用例是"别把自己代理掉"这条红线的**可证伪**验证：
  //   ① 正例：NO_PROXY 含回环 ⇒ 坏代理（127.0.0.1:1 无人监听）下桥自身 API 仍可达；
  //   ② 反例：NO_PROXY **去掉**回环 ⇒ 同一请求必须失败。
  // 只做 ① 不做 ② 的话，断言可能因为"根本没走代理"而假绿（例如 env 开关没生效），
  // 那这条红线就等于没测 —— 故两个方向都在这里跑一次。
  const fakePortProbe = async (noProxy) => {
    const home = mkdtempSync(join(tmpdir(), 'yfw-proxy-bad-'))
    const port = await freePort()
    const env = {
      ...process.env,
      PONOS_MOCK_API: '1',
      YFW_BRIDGE_PORT: String(port),
      YFW_AUTH_FILE: join(home, 'auth.json'),
      YFWORKING_HOME: home,
      PONOS_CONFIG_DIR: home,
      YFW_BRIDGE_TOKEN: TEST_BRIDGE_TOKEN,
      NODE_USE_ENV_PROXY: '1',
      HTTP_PROXY: 'http://127.0.0.1:1',   // 坏代理：无监听 ⇒ 走它就 ECONNREFUSED
      HTTPS_PROXY: 'http://127.0.0.1:1',
      NO_PROXY: noProxy,
    }
    delete env.PONOS_HOME
    let bridge = null
    try {
      bridge = await startBridge(env)
      // 出网应快速失败（且是业务失败 200 + ok:false，不是 5xx 崩掉）——顺带证明"确实在走代理"
      const res = await fetch(`http://127.0.0.1:${port}/test-provider`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ apiBaseUrl: 'https://bad-proxy-probe.invalid/v1', authToken: 'x', model: 'm' }),
      })
      const probe = { status: res.status, body: await res.json().catch(() => null) }
      // 回环：桥自身 API —— 这是关键断言
      let loopbackOk = false
      let loopbackErr = ''
      try {
        const r = await fetch(`http://127.0.0.1:${port}/config`, { headers: authHeaders() })
        loopbackOk = r.ok
      } catch (e) { loopbackErr = String((e && e.message) || e) }
      return { probe, loopbackOk, loopbackErr }
    } finally {
      try { bridge && bridge.proc.kill() } catch { /* 已退出 */ }
      rmSyncRetry(home)
    }
  }

  // ① 正例：真实生效的 NO_PROXY（含回环）
  const ok = await fakePortProbe('127.0.0.1,localhost,::1')
  assert.equal(ok.loopbackOk, true, `回环必须仍通（否则应用连不上自己的桥）：${ok.loopbackErr}`)
  assert.equal(ok.probe.status, 200, '探测端点应正常返回（业务失败不算 5xx）')
  assert.equal(ok.probe.body && ok.probe.body.ok, false, '坏代理下探测应报失败（证明请求确实走了代理）')

  // ② 对照组：把回环从 NO_PROXY 拿掉。
  //    ⚠️ **实测发现（与本方案 §6.1 的假设略有差异，如实记录）**：Node 24 的 env-proxy 实现
  //    对 loopback 目标**仍然直连**，去掉 NO_PROXY 里的回环项也**不会**把桥自己的请求代理掉。
  //    因此这里**不能**断言"回环会失败" —— 那是一条永远绿的假断言，比没有更糟。
  //    对照组真正要防的假绿是"代理根本没生效"（那正例里的"回环通"就毫无意义），
  //    故断言：同一组 env 下**外网请求必须失败**（证明 NODE_USE_ENV_PROXY 确实起作用）。
  //    回环项照旧**强制并入**（成本为零的纵深防御）：curl/python/其它子进程与未来的 Node 版本
  //    不保证同样的保护，而这条红线一旦失守，症状是"应用连不上自己的桥"且报错完全不提代理。
  const bad = await fakePortProbe('example.com')
  assert.equal(bad.probe.body && bad.probe.body.ok, false,
    '对照组：外网请求必须失败，否则说明代理环境根本没生效（本用例会退化成假绿）')
  assert.equal(bad.loopbackOk, true, '实测：Node 对回环目标默认直连（去掉 NO_PROXY 回环项亦不经代理）')
})

test('静态：设置页与 i18n 的代理项齐备（避免"后端通了界面没有"）', () => {
  const ui = readSrc('src/lib/proxyUi.ts')
  assert.match(ui, /'off'/, 'UI 归约必须含 off 档')
  assert.match(ui, /chromium|system/i, 'UI 归约必须覆盖 system 档（仅 Chromium 生效）')
  const zh = readSrc('src/i18n/translations/zh-CN.ts')
  const en = readSrc('src/i18n/translations/en-US.ts')
  for (const key of ['proxyModeOff', 'proxyModeSystem', 'proxyModeManual', 'proxyUrl', 'proxyBypass', 'proxyRestartHint']) {
    assert.ok(zh.includes(key), `zh-CN 缺 ${key}`)
    assert.ok(en.includes(key), `en-US 缺 ${key}（双语必须同步）`)
  }
  const view = readSrc('src/components/settings/SettingsView.tsx')
  assert.ok(view.includes('ProxySettings'), '设置页必须挂载代理面板')
  assert.ok(view.includes("import { ProxySettings } from '@/components/settings/ProxySettings'"), '必须显式引入面板')
  assert.ok(existsSync(join(REPO_ROOT, 'src/components/settings/ProxySettings.tsx')), '面板组件必须存在')
})
