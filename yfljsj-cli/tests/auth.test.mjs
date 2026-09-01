// 认证模块测试 — mock 网关用本地 https server（自签名证书，不联网）
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:https'
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { createDecipheriv } from 'node:crypto'

// 自签名证书用于本地 https mock
const KEY = readFileSync(new URL('./fixtures/key.pem', import.meta.url))
const CERT = readFileSync(new URL('./fixtures/cert.pem', import.meta.url))

// 测试隔离：config 写入临时目录（YFLJSJ_HOME 覆盖 os.homedir）
const TMP = mkdtempSync(path.join(os.tmpdir(), 'yfljsj-auth-'))
process.env.YFLJSJ_HOME = TMP
const CONFIG_PATH = path.join(TMP, '.yfljsj', 'config.json')

const auth = await import('../yfljsj.mjs')

// SM4-CBC 解密辅助：encryptPassword 输出 = 32hex 随机IV + SM4-CBC(key,iv) 密文hex（真机契约 2026-09-01）
const SM4_KEY = Buffer.from('9e2c5f1a8b3d7046f5a9c2e1b7d4803f', 'hex')
function sm4Decrypt(s) {
  assert.match(s, /^[0-9a-f]{32}[0-9a-f]+$/, 'SM4 密文格式应为 IV32hex + 密文hex')
  const iv = Buffer.from(s.slice(0, 32), 'hex')
  const d = createDecipheriv('sm4-cbc', SM4_KEY, iv)
  return d.update(s.slice(32), 'hex', 'utf8') + d.final('utf8')
}

function resetConfig() {
  rmSync(CONFIG_PATH, { force: true })
}

function seedConfig({ accessToken = 'AT-old', refreshToken = 'RT-old', tenantId = 'T001', expiresAt = Date.now() + 3600_000 } = {}) {
  mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify({ accessToken, refreshToken, tenantId, expiresAt }))
}

function makeTokens(at, rt, tenantId = 'T001') {
  return { accessToken: at, refreshToken: rt, tenantId, expiresIn: 7200 }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 可配置的本地 https mock 网关
function startMock() {
  const state = {
    requests: [], // 全部请求记录 {method, path, headers, body}
    refreshCount: 0,
    logoutCount: 0,
    sendCodeCount: 0,
    loginHandler: null,
    refreshHandler: null,
    logoutHandler: null,
    sendCodeHandler: null,
    genericHandler: null,
  }
  const server = createServer({ key: KEY, cert: CERT }, (req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const u = new URL(req.url, 'https://localhost')
      let body = null
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {
        body = raw
      }
      const entry = { method: req.method, path: u.pathname, headers: req.headers, body }
      state.requests.push(entry)
      const respond = (status, json, extraHeaders = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders })
        res.end(json === undefined ? '' : JSON.stringify(json))
      }
      const route = u.pathname.replace(/^\/api\/oauth/, '')
      if (route === '/auth/login') {
        if (state.loginHandler) return state.loginHandler(entry, respond, state)
        return respond(200, { success: true, code: 200, msg: 'ok', data: makeTokens('AT-login', 'RT-login') })
      }
      if (route === '/auth/refresh-token') {
        state.refreshCount++
        if (state.refreshHandler) return state.refreshHandler(entry, respond, state)
        return respond(200, { success: true, code: 200, msg: 'ok', data: makeTokens('AT-refresh', 'RT-refresh') })
      }
      if (route === '/auth/logout') {
        state.logoutCount++
        if (state.logoutHandler) return state.logoutHandler(entry, respond, state)
        return respond(200, { success: true, code: 200, msg: 'ok', data: null })
      }
      if (route === '/auth/sendCode') {
        state.sendCodeCount++
        if (state.sendCodeHandler) return state.sendCodeHandler(entry, respond, state)
        return respond(200, { success: true, code: 200, msg: 'ok', data: null })
      }
      if (state.genericHandler) return state.genericHandler(entry, respond, state)
      return respond(404, { success: false, code: 404, msg: 'not found', data: null })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        state,
        server,
        baseUrl: `https://127.0.0.1:${port}/api/oauth`,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

let mock
beforeEach(async () => {
  mock = await startMock()
  resetConfig()
})
afterEach(async () => {
  await mock.close()
})

const loginBody = () => mock.state.requests.find((r) => r.path === '/api/oauth/auth/login').body

// ==================== 3 种登录 ====================

test('login method=1 密码：请求体正确 + token 存储 config.json', async () => {
  const res = await auth.login({ method: 1, user: 'alice', password: 'pw123', baseUrl: mock.baseUrl, rejectUnauthorized: false })
  assert.equal(res.ok, true)
  const b = loginBody()
  assert.equal(b.loginMethod, 1)
  // 平台契约：loginName 字段 + 密码 SM4 加密（IV32hex+密文）
  assert.equal(b.loginName, 'alice')
  assert.equal(sm4Decrypt(b.password), 'pw123')
  assert.ok(!('user' in b) && !('username' in b))
  // 存储校验
  const tok = auth.getToken()
  assert.equal(tok.accessToken, 'AT-login')
  assert.equal(tok.refreshToken, 'RT-login')
  assert.equal(tok.tenantId, 'T001')
  assert.ok(tok.expiresAt > Date.now())
  // config.json 文件存在且可读
  const raw = readFileSync(CONFIG_PATH, 'utf8')
  const cfg = JSON.parse(raw)
  assert.equal(cfg.accessToken, 'AT-login')
  if (process.platform !== 'win32') {
    assert.equal(statSync(CONFIG_PATH).mode & 0o777, 0o600) // chmod 600（POSIX）
  }
})

test('login method=2 验证码：请求体正确', async () => {
  const res = await auth.login({ method: 2, user: 'alice', code: '123456', baseUrl: mock.baseUrl, rejectUnauthorized: false })
  assert.equal(res.ok, true)
  const b = loginBody()
  assert.equal(b.loginMethod, 2)
  // 平台契约：loginName 字段 + 验证码也 SM4 加密（opsLoginToken）
  assert.equal(b.loginName, 'alice')
  assert.equal(sm4Decrypt(b.opsLoginToken), '123456')
  assert.ok(!('user' in b) && !('code' in b) && !('password' in b) && !('tenantId' in b))
})

test('login method=3 租户：请求体正确', async () => {
  const res = await auth.login({ method: 3, user: 'alice', tenant: 'TENANT_X', baseUrl: mock.baseUrl, rejectUnauthorized: false })
  assert.equal(res.ok, true)
  const b = loginBody()
  assert.equal(b.loginMethod, 3)
  // 平台契约：租户登录用 userId + companyTenantId
  assert.equal(b.userId, 'alice')
  assert.equal(b.companyTenantId, 'TENANT_X')
  assert.ok(!('user' in b) && !('tenantId' in b))
})

test('encryptPassword：输出 = IV32hex + SM4-CBC 密文（随机IV），可解密回原密码', () => {
  assert.equal(auth.encryptPassword(''), '')
  for (const pw of ['pw123', 's3cret!', 'P@ssw0rd中文']) {
    const enc = auth.encryptPassword(pw)
    assert.match(enc, /^[0-9a-f]{32}[0-9a-f]+$/)
    assert.equal(sm4Decrypt(enc), pw)
  }
  // 随机 IV：同一明文两次加密结果不同
  assert.notEqual(auth.encryptPassword('pw123'), auth.encryptPassword('pw123'))
})

test('login method 非法 → ok:false', async () => {
  const res = await auth.login({ method: 9, baseUrl: mock.baseUrl, rejectUnauthorized: false })
  assert.equal(res.ok, false)
  assert.match(res.error, /method 必须是 1/)
  assert.equal(auth.getToken(), null)
})

// ==================== JWT 位置兼容 ====================

test('login 失败（success=false）→ ok:false 且不落 token', async () => {
  mock.state.loginHandler = (_e, respond) => respond(200, { success: false, code: 401, msg: '用户名或密码错误', data: null })
  const res = await auth.login({ method: 1, user: 'x', password: 'y', baseUrl: mock.baseUrl, rejectUnauthorized: false })
  assert.equal(res.ok, false)
  assert.match(res.error, /用户名或密码错误/)
  assert.equal(auth.getToken(), null)
})

test('JWT 在响应头时也能提取（access/refresh/tenant 头）', async () => {
  mock.state.loginHandler = (_e, respond) =>
    respond(
      200,
      { success: true, code: 200, msg: 'ok', data: null },
      { 'Access-Token': 'AT-header', 'Refresh-Token': 'RT-header', 'Tenant-Id': 'T-HDR' }
    )
  const res = await auth.login({ method: 2, user: 'alice', code: '1', baseUrl: mock.baseUrl, rejectUnauthorized: false })
  assert.equal(res.ok, true)
  const tok = auth.getToken()
  assert.equal(tok.accessToken, 'AT-header')
  assert.equal(tok.refreshToken, 'RT-header')
  assert.equal(tok.tenantId, 'T-HDR')
})

// ==================== 发验证码 / 登出 ====================

test('sendCode 携带 user', async () => {
  const res = await auth.sendCode({ user: '13800138000', baseUrl: mock.baseUrl, rejectUnauthorized: false })
  assert.equal(res.ok, true)
  const e = mock.state.requests.find((r) => r.path === '/api/oauth/auth/sendCode')
  assert.ok(e)
  assert.equal(e.body.user, '13800138000')
})

test('logout 清 token（含服务端登出请求）', async () => {
  seedConfig()
  const res = await auth.logout({ baseUrl: mock.baseUrl, rejectUnauthorized: false })
  assert.equal(res.ok, true)
  assert.equal(mock.state.logoutCount, 1)
  assert.equal(mock.state.requests.find((r) => r.path === '/api/oauth/auth/logout').body.refreshToken, 'RT-old')
  assert.equal(auth.getToken(), null)
  // config.json 已无 token 字段
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  assert.ok(!('accessToken' in cfg))
})

test('logout 未登录 → ok:true 且不发请求', async () => {
  const res = await auth.logout({ baseUrl: mock.baseUrl, rejectUnauthorized: false })
  assert.equal(res.ok, true)
  assert.equal(mock.state.logoutCount, 0)
})

// ==================== refresh 续期 ====================

test('ensureToken：expiresAt 已过期 → 自动 refresh 续期', async () => {
  seedConfig({ expiresAt: Date.now() - 1000 })
  mock.state.refreshHandler = (_e, respond) => respond(200, { success: true, code: 200, msg: 'ok', data: makeTokens('AT-new', 'RT-new') })
  const tok = await auth.ensureToken({ baseUrl: mock.baseUrl, rejectUnauthorized: false })
  assert.equal(tok.accessToken, 'AT-new')
  assert.equal(tok.refreshToken, 'RT-new')
  assert.ok(tok.expiresAt > Date.now() + 60_000)
  assert.equal(mock.state.refreshCount, 1)
  // 存储已更新
  assert.equal(auth.getToken().accessToken, 'AT-new')
  // refresh 请求体携带 refreshToken
  const req = mock.state.requests.find((r) => r.path === '/api/oauth/auth/refresh-token')
  assert.equal(req.body.refreshToken, 'RT-old')
})

test('ensureToken：expiresAt < now+5min 也触发 refresh', async () => {
  seedConfig({ expiresAt: Date.now() + 2 * 60_000 })
  await auth.ensureToken({ baseUrl: mock.baseUrl, rejectUnauthorized: false })
  assert.equal(mock.state.refreshCount, 1)
})

test('ensureToken：未过期（>5min）不刷新', async () => {
  seedConfig({ expiresAt: Date.now() + 3600_000 })
  const tok = await auth.ensureToken({ baseUrl: mock.baseUrl, rejectUnauthorized: false })
  assert.equal(tok.accessToken, 'AT-old')
  assert.equal(mock.state.refreshCount, 0)
})

test('ensureToken：无 token → null', async () => {
  const tok = await auth.ensureToken({ baseUrl: mock.baseUrl, rejectUnauthorized: false })
  assert.equal(tok, null)
})

test('refresh 失败（success=false）→ 清 token + AUTH_REQUIRED', async () => {
  seedConfig({ expiresAt: Date.now() - 1000 })
  mock.state.refreshHandler = (_e, respond) => respond(200, { success: false, code: 401, msg: 'refresh 失效', data: null })
  await assert.rejects(
    () => auth.ensureToken({ baseUrl: mock.baseUrl, rejectUnauthorized: false }),
    (err) => err.code === 'AUTH_REQUIRED'
  )
  assert.equal(auth.getToken(), null)
})

// ==================== 401 重试 ====================

test('authenticatedRequest：401 → 强制 refresh → 重试一次成功', async () => {
  seedConfig({ accessToken: 'AT-old', refreshToken: 'RT-old', expiresAt: Date.now() + 3600_000 })
  mock.state.refreshHandler = (_e, respond) => respond(200, { success: true, code: 200, msg: 'ok', data: makeTokens('AT-new', 'RT-new') })
  mock.state.genericHandler = (entry, respond) => {
    const authz = entry.headers.authorization || ''
    if (authz === 'Bearer AT-old') return respond(401, { success: false, code: 401, msg: 'unauthorized', data: null })
    return respond(200, { success: true, code: 200, msg: 'ok', data: { echo: authz } })
  }
  const res = await auth.authenticatedRequest({
    url: `${mock.baseUrl}/test/echo`,
    method: 'POST',
    body: { a: 1 },
    baseUrl: mock.baseUrl,
    rejectUnauthorized: false,
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.data.echo, 'Bearer AT-new')
  assert.equal(mock.state.refreshCount, 1)
  const echoReqs = mock.state.requests.filter((r) => r.path === '/api/oauth/test/echo')
  assert.equal(echoReqs.length, 2) // 首次 401 + 重试
})

test('并发 refresh 单飞：多个请求同时 401 只发一次 refresh', async () => {
  seedConfig({ accessToken: 'AT-old', refreshToken: 'RT-old', expiresAt: Date.now() - 5000 }) // 已过期
  // refresh 延迟 50ms，确保并发 401 都落在同一 refresh 窗口内
  mock.state.refreshHandler = async (_e, respond) => {
    await sleep(50)
    respond(200, { success: true, code: 200, msg: 'ok', data: makeTokens('AT-new', 'RT-new') })
  }
  let echoHits = 0
  mock.state.genericHandler = (entry, respond) => {
    const authz = entry.headers.authorization || ''
    if (authz === 'Bearer AT-old') return respond(401, { success: false, code: 401, msg: 'unauthorized', data: null })
    echoHits++
    return respond(200, { success: true, code: 200, msg: 'ok', data: { echo: authz } })
  }
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      auth.authenticatedRequest({ url: `${mock.baseUrl}/test/echo`, method: 'POST', body: { n: 1 }, baseUrl: mock.baseUrl, rejectUnauthorized: false })
    )
  )
  assert.equal(results.every((r) => r.status === 200), true)
  assert.equal(mock.state.refreshCount, 1) // 只发一次 refresh
  assert.equal(echoHits, 5) // 5 个请求都用新 token 重试成功
})

test('authenticatedRequest：未登录 → AUTH_REQUIRED', async () => {
  await assert.rejects(
    () => auth.authenticatedRequest({ url: `${mock.baseUrl}/test/echo`, baseUrl: mock.baseUrl, rejectUnauthorized: false }),
    (err) => err.code === 'AUTH_REQUIRED'
  )
})

// ==================== 密码交互输入 ====================

function fakeTTYOutput() {
  const writes = []
  const out = new EventEmitter()
  Object.assign(out, {
    columns: 80,
    rows: 24,
    isTTY: true,
    write(chunk) {
      writes.push(String(chunk))
      return true
    },
    clearLine() {},
    moveCursor() {},
    cursorTo() {},
    clearScreenDown() {},
    getWindowSize() {
      return [80, 24]
    },
  })
  return { out, writes }
}

test('login 缺省密码 → readline 交互输入且隐藏回显', async () => {
  const { out, writes } = fakeTTYOutput()
  const input = Readable.from(['s3cret!\n'])
  const res = await auth.login({ method: 1, user: 'alice', input, output: out, baseUrl: mock.baseUrl, rejectUnauthorized: false })
  assert.equal(res.ok, true)
  assert.equal(sm4Decrypt(loginBody().password), 's3cret!')
  // 回显被隐藏：输出流不含密码
  assert.ok(!writes.join('').includes('s3cret!'))
  assert.ok(writes.join('').includes('Password:'))
})

test('promptPassword 直接调用：返回输入且不泄露回显', async () => {
  const { out, writes } = fakeTTYOutput()
  const input = Readable.from(['topsecret\n'])
  const ans = await auth.promptPassword({ input, output: out, prompt: '输入密码: ' })
  assert.equal(ans, 'topsecret')
  assert.ok(!writes.join('').includes('topsecret'))
})

// ==================== clearToken ====================

test('clearToken 清除本地 token', async () => {
  seedConfig()
  assert.ok(auth.getToken())
  auth.clearToken()
  assert.equal(auth.getToken(), null)
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  assert.ok(!('accessToken' in cfg))
})
