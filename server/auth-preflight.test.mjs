// 认证小窗 CORS 预检接线测试（Task 6b Step 1，D11-D13）
// ---------------------------------------------------------------------------
// 认证小窗（?auth=1）以 file://（打包）或 http://localhost:5173（vite dev）身份
// 对 bridge /api/auth/setup|login 发 application/json POST——浏览器先发 OPTIONS
// 预检，bridge 若只回 Access-Control-Allow-Origin 而无 -Methods/-Headers，预检即失败、
// 真实 POST 永不发出（认证窗卡在"无法登录"）。本测试锁 OPTIONS 预检响应头：
//   - spawn 本库 server/bridge.mjs（node），随机空闲口 + 临时 YFW_AUTH_FILE/
//     YFWORKING_HOME（不污染真实 auth.json / ~/.yfworking），stdout 判 ready；
//   - 以 renderer origin 发 OPTIONS /api/auth/login，断言 204 + 三个 CORS 响应头。
//   - 2026-09-12：追加对 PUT/DELETE 的预检断言（工作流模块的保存/信任清单/删除同属
//     非简单请求；Allow-Methods 缺这两个方法时 renderer 真实请求永不发出，表现为
//     「信任清单写入失败：Failed to fetch」，而 curl/直调路由的测试照不出来）。
// 不 spawn 内核、无网络、不触碰真实 ~/.yfworking；finally kill 子进程并清目录。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'

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

test('OPTIONS 预检回显 origin + 允许 methods/headers（renderer POST/PUT/DELETE 依赖）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-authpre-'))
  const authFile = join(home, 'auth.json')
  const port = await freePort()
  const env = {
    ...process.env,
    PONOS_MOCK_API: '1',
    YFW_BRIDGE_PORT: String(port),
    YFW_AUTH_FILE: authFile,
    YFWORKING_HOME: home,
    PONOS_CONFIG_DIR: home,
  }
  delete env.PONOS_HOME // 防止宿主演进到解析链
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
  try {
    // 等 bridge 监听就绪：stdout 出现监听日志行；提前退出/超时即失败
    const deadline = Date.now() + READY_TIMEOUT_MS
    let ready = false
    while (Date.now() < deadline) {
      if (out.join('').includes(`http+ws://localhost:${port}`)) { ready = true; break }
      if (state.exitInfo) throw new Error(`bridge exited before ready: ${JSON.stringify(state.exitInfo)}; stderr tail: ${errTail}`)
      await sleep(50)
    }
    if (!ready) throw new Error(`bridge ready timeout; stdout tail: ${out.join('').slice(-400)}; stderr tail: ${errTail}`)

    const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    })
    assert.equal(res.status, 204)
    const acao = res.headers.get('access-control-allow-origin') || ''
    assert.ok(acao.includes('localhost'), `Access-Control-Allow-Origin 应回显 localhost origin，实际: ${acao}`)
    const methods = res.headers.get('access-control-allow-methods')
    assert.ok(methods && methods.includes('POST'), `Access-Control-Allow-Methods 应含 POST，实际: ${methods}`)
    const allowHeaders = (res.headers.get('access-control-allow-headers') || '').toLowerCase()
    assert.ok(allowHeaders.includes('content-type'), `Access-Control-Allow-Headers 应含 content-type，实际: ${allowHeaders}`)

    // 工作流模块（PUT 保存 / PUT 信任清单 / DELETE 删除）同样依赖预检放行，
    // 且这些路径都在 /workflows 前缀下——顺带锁住前缀路由的预检不被别处短接。
    for (const m of ['PUT', 'DELETE']) {
      const pre = await fetch(`http://127.0.0.1:${port}/workflows/bindings`, {
        method: 'OPTIONS',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': m,
          'access-control-request-headers': 'content-type',
        },
      })
      assert.equal(pre.status, 204, `OPTIONS /workflows/bindings (${m}) 应 204`)
      const allow = pre.headers.get('access-control-allow-methods') || ''
      assert.ok(allow.includes(m), `Access-Control-Allow-Methods 应含 ${m}（否则 renderer 的 ${m} 请求被浏览器拦下），实际: ${allow}`)
    }

    // 端到端闭环：预检放行之后，真实 PUT 必须能写入信任清单（用户现象是"信任清单无法写入"，
    // 只验证预检不足以保证后段落盘；这里跨层跑通 预检 → 路由 → 写盘）。
    const put = await fetch(`http://127.0.0.1:${port}/workflows/bindings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ agents: {}, trusted: ['demo-wf'] }),
    })
    assert.equal(put.status, 200, `PUT /workflows/bindings 应 200（实际 ${put.status}）`)
    const bindingsFile = join(home, 'workflows', '_bindings.json')
    const saved = JSON.parse(readFileSync(bindingsFile, 'utf8'))
    assert.deepEqual(saved.trusted, ['demo-wf'], '信任清单应真实落盘')
  } finally {
    if (proc && !state.exitInfo) {
      try { proc.kill() } catch {}
      await Promise.race([exitPromise, sleep(2000)])
    }
    rmSyncRetry(home)
  }
})
