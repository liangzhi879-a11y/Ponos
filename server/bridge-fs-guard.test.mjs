// 桥文件端点路径闸门（P0-1 / P0-2）攻击用例
// ---------------------------------------------------------------------------
// 依据：docs/superpowers/specs/2026-09-17-bridge-fs-hardening-and-arch-cleanup-design.md §7.1
//
// 改前事实：`/list-dir` `/read-file` `/raw-file` `/write-file` `/convert-office`
// `/read-sheet` `/write-sheet` `/read-docx` `/write-docx` `/install-skill` 共 **10 个**
// 路径端点全部只做 `resolve(path)`（相对转绝对），没有任何"是否在允许根内"的判断
// ⇒ 持令牌方可任意读写本机文件；写能力 = 持久化 RCE（覆盖 preload/启动项/shell 配置）。
// 另有 `/raw-file` **无体积上限**且用 `readFileSync` 全量入内存（同文件 /read-file 有 512KB、
// /write-file 有 2MB，唯独它没有）⇒ 一个 2GB 文件既 OOM 又阻塞事件循环。
//
// 本文件钉六件事：
//   ① 越界读被拒（EOUTSIDE）；② 前缀绕过被拒（必须 path.relative 而非字符串前缀）；
//   ③ 符号链接出根被拒（realpath）；④ 控制字符被拒；⑤ 写侧拒凭据/系统目录（denyRoots）；
//   ⑥ /raw-file 体积上限 + mime 收紧（svg 降级、html 带 CSP sandbox）。
// 并同时断言**正例**（根内读写仍通），否则"全拒"也会假绿。
//
// 不 spawn 内核、不出网（PONOS_MOCK_API=1 + 隔离 home）；finally 收进程清临时目录。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import http from 'node:http'
import { TEST_BRIDGE_TOKEN, authHeaders } from './test-bridge-auth.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const BRIDGE_ENTRY = join(REPO_ROOT, 'server', 'bridge.mjs')
const READY_TIMEOUT_MS = 15000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

/** spawn 桥；`extraEnv` 用于注入 YFW_FS_* 与 YFW_RAW_FILE_MAX_BYTES。 */
function spawnBridge(home, port, extraEnv = {}) {
  const env = {
    ...process.env,
    PONOS_MOCK_API: '1',
    YFW_BRIDGE_PORT: String(port),
    YFW_AUTH_FILE: join(home, 'auth.json'),
    YFWORKING_HOME: home,
    PONOS_CONFIG_DIR: home,
    // 测试客户端（node http）是"无 Origin 的本机客户端"，按 D2 必须持令牌；
    // 用既有回归网的同一常量（server/test-bridge-auth.mjs），让失败信息可读。
    YFW_BRIDGE_TOKEN: TEST_BRIDGE_TOKEN,
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
  return { proc, state, stdout: () => out.join(''), stderrTail: () => errTail }
}

async function waitReady(b, port) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (b.stdout().includes(`[bridge] listening 127.0.0.1:${port} (loopback only)`) || b.stdout().includes(`http+ws://localhost:${port}`)) return
    if (b.state.exitInfo) throw new Error(`bridge exited before ready: ${JSON.stringify(b.state.exitInfo)}; stderr: ${b.stderrTail()}`)
    await sleep(50)
  }
  throw new Error(`bridge 未在 ${READY_TIMEOUT_MS}ms 内就绪；stderr: ${b.stderrTail()}`)
}

async function stopBridge(b) {
  try { b.proc.kill() } catch {}
  await new Promise((resolve) => {
    if (b.state.exitInfo) return resolve()
    const t = setTimeout(resolve, 3000)
    b.proc.once('exit', () => { clearTimeout(t); resolve() })
  })
}

/** 发一次 HTTP 请求；返回 { status, body, headers }（status 0 = 连接层失败）。 */
function httpReq(port, path, { method = 'GET', headers = {}, body = null, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    let req
    try {
      req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        const chunks = []
        res.on('data', (d) => chunks.push(d))
        res.on('end', () => resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: res.headers,
        }))
      })
    } catch (e) { return resolve({ status: 0, error: e.message }) }
    req.on('error', (e) => resolve({ status: 0, error: e.message }))
    req.setTimeout(timeoutMs, () => { try { req.destroy(new Error('timeout')) } catch {} })
    if (body != null) req.write(body)
    req.end()
  })
}

/** 只对"连接层失败/超时"（status 0）重试：启动期事件循环忙会偶发首个请求超时。 */
async function req(port, path, opts = {}, { budgetMs = 20000 } = {}) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const last = await httpReq(port, path, opts)
    if (last.status !== 0) return last
    if (Date.now() > deadline) return last
    await sleep(250)
  }
}

const j = (obj) => JSON.stringify(obj)
const readFileUrl = (p) => `/read-file?path=${encodeURIComponent(p)}`
const rawFileUrl = (p) => `/raw-file?path=${encodeURIComponent(p)}`

// ── 全局夹具（一次建好，供两个桥实例共用）───────────────────────────────
const BASE = mkdtempSync(join(tmpdir(), 'fsguard-http-'))
const HOME = join(BASE, 'home')                 // 数据根（denyRoots 的默认成员）
const WS = join(BASE, 'ws')                     // 允许根
const EVIL = join(BASE, 'ws-evil')              // 前缀绕过用：字面量以 WS 开头
mkdirSync(HOME, { recursive: true })
mkdirSync(join(WS, 'sub'), { recursive: true })
mkdirSync(EVIL, { recursive: true })

const INSIDE = join(WS, 'ok.txt')
writeFileSync(INSIDE, 'hello-inside')
const EVIL_FILE = join(EVIL, 'pwn.txt')
writeFileSync(EVIL_FILE, 'pwn')

const HTML_FILE = join(WS, 'page.html')
writeFileSync(HTML_FILE, '<html><body><script>1</script></body></html>')
const SVG_FILE = join(WS, 'pic.svg')
writeFileSync(SVG_FILE, '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')

const BIG_CAP = 1024
const BIG_FILE = join(WS, 'big.bin')
writeFileSync(BIG_FILE, Buffer.alloc(BIG_CAP * 2, 0x41)) // 2KB > 1KB 上限

const NEW_INSIDE = join(WS, 'sub', 'created.txt')
const NEW_OUTSIDE = join(EVIL, 'created.txt')
const CREDS = join(HOME, 'settings.json')       // 数据根内的凭据文件
// 位于允许根**内部**，但被 denyRoots 保护 ⇒ 用于隔离验证 denyRoots 本身生效
const PROTECTED = join(WS, 'protected')
mkdirSync(PROTECTED, { recursive: true })
// 位于允许根**内部**、且被 YFW_FS_DENY_PATHS 指定为凭据文件 ⇒ 隔离验证 denyPaths 生效
const SECRET = join(WS, 'secret.json')
writeFileSync(SECRET, '{"token":"leak-me"}')

// 符号链接（Windows 需权限，失败则该用例跳过）
const LINK = join(WS, 'escape-link')
let linkOk = false
try { symlinkSync(EVIL, LINK, 'junction'); linkOk = true } catch { /* 跳过该用例 */ }

process.on('exit', () => { try { rmSyncRetry(BASE) } catch {} })

// ── 实例 1：显式 enforce + 限定 roots（确定性判定）──────────────────────
let B1, P1
test('前置：以 enforce + 限定 roots 启动桥', async () => {
  P1 = await freePort()
  B1 = spawnBridge(HOME, P1, {
    YFW_FS_GUARD: 'enforce',
    YFW_FS_ROOTS: WS,
    YFW_FS_WRITE_ROOTS: WS,
    YFW_FS_DENY_ROOTS: PROTECTED,
    YFW_FS_DENY_PATHS: SECRET,
    YFW_RAW_FILE_MAX_BYTES: String(BIG_CAP),
  })
  await waitReady(B1, P1)
})

test('正例：根内文件可读（防止"全拒"假绿）', async () => {
  const r = await req(P1, readFileUrl(INSIDE), { headers: authHeaders() })
  assert.equal(r.status, 200, `body=${r.body}`)
  assert.equal(JSON.parse(r.body).content, 'hello-inside')
})

test('攻击 1：越界读 → 403 EOUTSIDE', async () => {
  const r = await req(P1, readFileUrl(join(EVIL, 'pwn.txt')), { headers: authHeaders() })
  assert.equal(r.status, 403, `body=${r.body}`)
  assert.equal(JSON.parse(r.body).code, 'EOUTSIDE')
})

test('攻击 2：前缀绕过（/ws-evil 不得被 /ws 放行）→ 403', async () => {
  assert.ok(EVIL.startsWith(WS), '夹具应构造出前缀相同的情形')
  const r = await req(P1, readFileUrl(EVIL_FILE), { headers: authHeaders() })
  assert.equal(r.status, 403, `body=${r.body}`)
})

test('攻击 3：符号链接出根 → 403（realpath 生效）', async (t) => {
  if (!linkOk) return t.skip('无法创建符号链接（缺权限）')
  const r = await req(P1, readFileUrl(join(LINK, 'pwn.txt')), { headers: authHeaders() })
  assert.equal(r.status, 403, `body=${r.body}`)
})

test('攻击 4：NUL / 控制字符 → 400 EBADARG', async () => {
  const r1 = await req(P1, `/read-file?path=${encodeURIComponent('a\u0000b')}`, { headers: authHeaders() })
  assert.equal(r1.status, 400, `body=${r1.body}`)
  const r2 = await req(P1, `/list-dir?path=${encodeURIComponent('a\u001fb')}`, { headers: authHeaders() })
  assert.equal(r2.status, 400, `body=${r2.body}`)
})

test('攻击 5：越界写 → 403，且目标未被创建', async () => {
  const r = await req(P1, '/write-file', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: j({ path: NEW_OUTSIDE, content: 'x' }),
  })
  assert.equal(r.status, 403, `body=${r.body}`)
  assert.equal(existsSync(NEW_OUTSIDE), false, '越界写不得落盘')
})

test('攻击 6：写入数据根（denyRoots）→ 403，且凭据内容未被改写', async () => {
  // 注意：断言"文件不存在"是错的——桥在启动时自身会写 settings.json（loadConfig/syncKernelSettings），
  // 所以这里断言"内容未被我们的载荷改写"，才是这条攻击的真实判据。
  const before = existsSync(CREDS) ? readFileSync(CREDS, 'utf8') : null
  const r = await req(P1, '/write-file', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: j({ path: CREDS, content: '{"token":"pwned"}' }),
  })
  assert.equal(r.status, 403, `body=${r.body}`)
  const after = existsSync(CREDS) ? readFileSync(CREDS, 'utf8') : null
  assert.equal(after, before, '凭据文件内容不得被改写')
  assert.ok(!String(after).includes('pwned'), '载荷不得进入凭据文件')
})

test('攻击 6b：denyRoots 优先于允许根——即使目标在允许根内部也拒（凭据目录保护）', async () => {
  const target = join(PROTECTED, 'x.txt')
  const r = await req(P1, '/write-file', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: j({ path: target, content: 'x' }),
  })
  assert.equal(r.status, 403, `denyRoots 应压过 roots；body=${r.body}`)
  assert.equal(existsSync(target), false, '被 denyRoots 保护的目标不得落盘')
})

test('攻击 7：越界 write-docx / write-sheet 在扩展名校验前即被拒 → 403', async () => {
  for (const ep of ['/write-docx', '/write-sheet']) {
    const r = await req(P1, ep, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: j({ path: join(EVIL, 'x.docx'), content: 'x' }),
    })
    assert.equal(r.status, 403, `${ep} body=${r.body}`)
  }
})

test('正例：根内写成功且内容正确', async () => {
  const r = await req(P1, '/write-file', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: j({ path: NEW_INSIDE, content: 'created-ok' }),
  })
  assert.equal(r.status, 200, `body=${r.body}`)
  assert.equal(statSync(NEW_INSIDE).size, 'created-ok'.length)
})

test('攻击 8（P0-2）：/raw-file 超上限 → 413，且不返回内容', async () => {
  const r = await req(P1, rawFileUrl(BIG_FILE), { headers: authHeaders() })
  assert.equal(r.status, 413, `body=${r.body}`)
  assert.ok(!r.body.includes('AAAA'), '超限时不得回吐文件内容')
})

test('P0-2：/raw-file 正常返回字节 + nosniff', async () => {
  const r = await req(P1, rawFileUrl(INSIDE), { headers: authHeaders() })
  assert.equal(r.status, 200, `body=${r.body}`)
  assert.equal(r.body, 'hello-inside')
  assert.equal(r.headers['x-content-type-options'], 'nosniff')
})

test('P0-2：/raw-file 的 .svg 不再作为 image/svg+xml 返回（可含脚本）', async () => {
  const r = await req(P1, rawFileUrl(SVG_FILE), { headers: authHeaders() })
  assert.equal(r.status, 200)
  assert.notEqual(r.headers['content-type'], 'image/svg+xml')
  assert.equal(r.headers['content-type'], 'application/octet-stream')
})

test('P0-2：/raw-file 的 .html 带 CSP sandbox（不透明源）+ nosniff', async () => {
  const r = await req(P1, rawFileUrl(HTML_FILE), { headers: authHeaders() })
  assert.equal(r.status, 200)
  assert.equal(r.headers['content-security-policy'], 'sandbox allow-scripts')
  assert.equal(r.headers['x-content-type-options'], 'nosniff')
  assert.equal(r.headers['content-type'], 'text/html; charset=utf-8')
})

test('攻击 9：/raw-file 越界 → 403（与 /read-file 同闸门）', async () => {
  const r = await req(P1, rawFileUrl(EVIL_FILE), { headers: authHeaders() })
  assert.equal(r.status, 403, `body=${r.body}`)
})

test('攻击 10：凭据文件**读**也被拒（EPROTECTED）——即便它在允许根内部', async () => {
  // 这条针对"读侧默认 warn 不拦越界"的残留：若凭据可读，不受信预览拿到令牌后
  // 就能读走明文 provider 令牌并外发（opaque 源仍能发请求，CORS 只挡读响应）。
  const r = await req(P1, readFileUrl(SECRET), { headers: authHeaders() })
  assert.equal(r.status, 403, `body=${r.body}`)
  assert.equal(JSON.parse(r.body).code, 'EPROTECTED')
  assert.ok(!r.body.includes('leak-me'), '凭据内容不得出现在响应里')
})

test('攻击 10b：凭据文件写同样被拒（EPROTECTED）', async () => {
  const r = await req(P1, '/write-file', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: j({ path: SECRET, content: '{"token":"pwned"}' }),
  })
  assert.equal(r.status, 403, `body=${r.body}`)
  assert.equal(readFileSync(SECRET, 'utf8'), '{"token":"leak-me"}', '凭据内容不得被改写')
})

test('正例：同一目录下的普通文件仍可读（凭据拒绝不得过度误伤）', async () => {
  const r = await req(P1, readFileUrl(INSIDE), { headers: authHeaders() })
  assert.equal(r.status, 200, `body=${r.body}`)
})

// ── 实例 2：不设 YFW_FS_* ⇒ 走默认级别（读 warn / 写 enforce）───────────
let B2, P2
test('前置：以默认级别启动桥', async () => {
  P2 = await freePort()
  const env = { YFW_RAW_FILE_MAX_BYTES: String(BIG_CAP) }
  B2 = spawnBridge(HOME, P2, env)
  await waitReady(B2, P2)
})

test('默认级别：读侧越界放行（warn）——S1 实测 /list-dir 合法需求是"任意目录"', async () => {
  const r = await req(P2, readFileUrl(EVIL_FILE), { headers: authHeaders() })
  assert.equal(r.status, 200, `读侧默认不得强拦（会打坏 DirectoryPicker）；body=${r.body}`)
  assert.equal(JSON.parse(r.body).content, 'pwn')
})

test('默认级别：写侧对 deny 目标仍拦（数据根/凭据）', async () => {
  const before = existsSync(CREDS) ? readFileSync(CREDS, 'utf8') : null
  const r = await req(P2, '/write-file', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: j({ path: CREDS, content: '{"token":"pwned"}' }),
  })
  assert.equal(r.status, 403, `默认必须拦住凭据目录；body=${r.body}`)
  assert.equal(existsSync(CREDS) ? readFileSync(CREDS, 'utf8') : null, before)
})

test('默认级别的**已知残留**：未配置允许清单时，允许根之外的普通路径仍可写', async () => {
  // 这不是 bug，是刻意的默认取舍（无 YFW_FS_WRITE_ROOTS 时只做 deny 列表过滤）——
  // 因为合法用途是"用户打开的任意文件"。此用例把残留**显式钉住**，避免它被误当作已修复；
  // 要完全收紧请设 YFW_FS_WRITE_ROOTS（见上一组用例）。
  const target = join(EVIL, 'default-mode.txt')
  const r = await req(P2, '/write-file', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: j({ path: target, content: 'x' }),
  })
  assert.equal(r.status, 200, `默认无允许清单时应放行普通路径；body=${r.body}`)
  assert.equal(existsSync(target), true)
})

// ── 收尾 ────────────────────────────────────────────────────────────────
test('收尾：关闭两个桥实例', async () => {
  if (B1) await stopBridge(B1)
  if (B2) await stopBridge(B2)
  if (B1) assert.ok(B1.state.exitInfo || true)
})
