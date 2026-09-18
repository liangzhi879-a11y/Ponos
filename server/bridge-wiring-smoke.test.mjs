// server/bridge-wiring-smoke.test.mjs —— 真实桥接线冒烟（P1 批次 1/2 端点的端到端接线）
// ---------------------------------------------------------------------------
// 为什么必须有这个测试：批次 1/2 把端点**搬出了 bridge**（host-files/office/collab/host/
// auth/readonly 六个模块），而各模块的单测只覆盖"模块被调用后的逻辑"（纯算响应）。
// 它们**证明不了**接线本身：
//   · 委托点写错位置（例如放在令牌闸门之前）→ 单测全绿，但**未鉴权即可访问**；
//   · 忘了 dispatch / 路径拼错 / 漏 await → 单测全绿，但真实请求 404 或挂起；
//   · `raw:true` 的响应体没被正确发出 → 单测全绿，但前端拿到坏 JSON。
// 本测试 spawn **真实 server/bridge.mjs**（临时 home + 随机空闲端口 + 注入令牌），
// 以真实 HTTP 打真实端点，锁住三件事：
//   1. **闸门顺序**（安全前提）：无令牌访问受保护端点 → 401；豁免面（/health、/api/auth/*）免令牌。
//      `401` 本身就是"委托点在闸门之后"的证据——若委托被挪到闸门之前，这里会拿到 200/400 而非 401。
//   2. **委托生效**：迁走的端点带令牌可达（不是 404）。
//   3. **端到端闭环**：profile POST → 落盘 → GET 读回**逐字一致**（覆盖 `raw:true` 透传这条红线）。
// 不 spawn 内核：usage/audit 只断言"接线通"（容忍内核侧 502/503）。
// 不触碰真实 ~/.yfworking：临时 home + YFW_BRIDGE_TOKEN 注入。
// 运行：node --test server/bridge-wiring-smoke.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const BRIDGE_ENTRY = join(REPO_ROOT, 'server', 'bridge.mjs')
const READY_TIMEOUT_MS = 20000
const TOKEN = 'wiring-smoke-token'
const TOKEN_HEADER = 'x-yfw-bridge-token'

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// Windows 并发下子进程句柄释放有延迟，rmSync 会偶发 EPERM——重试兜底（与既有测试同型）
function rmSyncRetry(path, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    try { rmSync(path, { recursive: true, force: true }); return } catch (e) {
      if (i === attempts - 1) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60)
    }
  }
}

// 随机空闲端口：listen(0) 取系统分配端口后关闭（spawn bridge 用 YFW_BRIDGE_PORT 注入）
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

test('真实桥接线冒烟：闸门顺序 + 委托生效 + profile 端到端闭环', { timeout: 90000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-wiring-'))
  const port = await freePort()
  const env = {
    ...process.env,
    PONOS_MOCK_API: '1',
    YFW_BRIDGE_PORT: String(port),
    YFWORKING_HOME: home,
    PONOS_CONFIG_DIR: home,
    YFW_AUTH_FILE: join(home, 'auth.json'),
    YFW_BRIDGE_TOKEN: TOKEN,   // 注入已知令牌，测试据此验证闸门
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

  const base = `http://127.0.0.1:${port}`
  const withToken = (extra = {}) => ({ ...extra, [TOKEN_HEADER]: TOKEN })

  try {
    // ── 等桥监听就绪 ──
    const deadline = Date.now() + READY_TIMEOUT_MS
    let ready = false
    while (Date.now() < deadline) {
      if (out.join('').includes(`http+ws://localhost:${port}`)) { ready = true; break }
      if (state.exitInfo) throw new Error(`bridge exited before ready: ${JSON.stringify(state.exitInfo)}; stderr tail: ${errTail}`)
      await sleep(50)
    }
    if (!ready) throw new Error(`bridge ready timeout; stdout tail: ${out.join('').slice(-400)}; stderr tail: ${errTail}`)

    // ── ① 豁免面：无需令牌即可访问（也是"登记表与闸门豁免清单一致"的回归）──
    const health = await fetch(`${base}/health`)
    assert.equal(health.status, 200, `/health 应免令牌（批次 1 迁入 host-routes）; stderr: ${errTail}`)

    const authStatus = await fetch(`${base}/api/auth/status`)
    assert.equal(authStatus.status, 200, `/api/auth/status 应免令牌（登录发生在拿到令牌之前）; stderr: ${errTail}`)
    const authBody = await authStatus.json()
    assert.ok(typeof authBody === 'object' && authBody !== null, '/api/auth/status 应回 JSON 对象（证明 auth-routes 委托生效）')

    // ── ② 闸门顺序（安全前提）：受保护端点无令牌必须 401 ──
    // 这条同时是"委托点在闸门之后"的证据：若 /api/profile 的处理被挪到闸门之前，
    // 无令牌就会拿到 200/400/404 而非 401。
    for (const p of ['/api/profile', '/api/usage', '/api/audit']) {
      const res = await fetch(`${base}${p}`)
      assert.equal(res.status, 401, `${p} 无令牌必须 401（证明委托点在令牌闸门之后）; 实际 ${res.status}`)
    }

    // ── ③ 外部来源一律 403（第一道闸门：白名单，先于令牌校验）──
    const evil = await fetch(`${base}/api/profile`, { headers: { origin: 'https://evil.example' } })
    assert.equal(evil.status, 403, '白名单之外的 Origin 必须 403（且发生在令牌校验之前）')

    // ── ④ 委托生效 + 端到端闭环：profile POST → 落盘 → GET 逐字读回 ──
    const profilePayload = { nickname: '接线冒烟', avatar: '', bio: 'round-trip' }
    const put = await fetch(`${base}/api/profile`, {
      method: 'POST',
      headers: withToken({ 'content-type': 'application/json' }),
      body: JSON.stringify(profilePayload),
    })
    assert.equal(put.status, 200, `POST /api/profile 应 200; 实际 ${put.status}; stderr: ${errTail}`)
    assert.equal((await put.json()).ok, true)

    const profileFile = join(home, 'userData', 'profile.json')
    assert.ok(existsSync(profileFile), '档案必须真实落盘到 <home>/userData/profile.json')
    assert.deepEqual(JSON.parse(readFileSync(profileFile, 'utf8')), profilePayload, '落盘内容应与提交一致')

    const got = await fetch(`${base}/api/profile`, { headers: withToken() })
    assert.equal(got.status, 200, 'GET /api/profile 应 200')
    const gotText = await got.text()
    // **红线复核**：profile GET 是 `raw:true` 原样透传 → 响应体应与文件文本**逐字一致**。
    assert.equal(gotText, readFileSync(profileFile, 'utf8'), 'GET 响应应逐字等于落盘文件（raw 透传红线）')
    assert.deepEqual(JSON.parse(gotText), profilePayload, '且可被 JSON 解析（前端拿得到值）')

    // ── ⑤ usage/audit 委托生效（不要求内核成功：502/503 亦证明"接线通"）──
    for (const p of ['/api/usage', '/api/audit']) {
      const res = await fetch(`${base}${p}`, { headers: withToken() })
      assert.ok(
        [200, 502, 503].includes(res.status),
        `${p} 带令牌应可达（200/502/503 均说明 readonly-routes 委托生效）；实际 ${res.status}; stderr: ${errTail}`,
      )
      assert.notEqual(res.status, 404, `${p} 不得 404 —— 那说明委托没接上`)
    }
  } finally {
    if (proc && !state.exitInfo) {
      try { proc.kill() } catch { /* 已退出 */ }
      await Promise.race([exitPromise, sleep(3000)])
    }
    rmSyncRetry(home)
  }
})
