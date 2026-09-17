// server/auth-routes.test.mjs —— 身份面路由直测（P1 批次 2 新增）
// ---------------------------------------------------------------------------
// 覆盖三类：
//   1. 路径认领（不认领的必须回 null，否则会抢走别人的端点）；
//   2. 用户档案的读写（含 `raw:true` 的**原样透传**语义——换成 parse 再 stringify 会改变响应字节）；
//   3. **安全顺序守卫**：委托点必须在令牌闸门之后（这是本批次搬迁的安全前提，
//      写死成断言，避免将来有人顺手挪动位置就开出未鉴权入口）。
//
// 刻意**不**在这里测口令流程（setup/login/change-password）：那些会读写真实 home 下的
// 口令文件，属端到端范畴，已由 server/bridge-auth-token.test.mjs 等覆盖。
// 也刻意**不 import bridge.mjs**：它在 import 期就会扫真实 home。
//
// 运行：node --test server/auth-routes.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleAuthRoute, isAuthPath } from './auth-routes.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')

/** 极简 req 替身：本模块只把它转交给 readJsonBody，自身不读其属性 */
const REQ = { method: 'POST' }

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-auth-routes-'))
  try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

const call = (pathname, { method = 'GET', body = {}, profilePath = join(tmpdir(), 'nope', 'profile.json') } = {}) =>
  handleAuthRoute({ req: REQ, method, pathname, readJsonBody: async () => body, profilePath })

// ── 路径认领 ─────────────────────────────────────────────────────────────
test('isAuthPath：认领 5 个口令端点 + /api/profile，不认领相邻路径', () => {
  for (const p of ['/api/auth/status', '/api/auth/setup', '/api/auth/login', '/api/auth/logout', '/api/auth/change-password', '/api/profile']) {
    assert.equal(isAuthPath(p), true, `${p} 应被认领`)
  }
  assert.equal(isAuthPath('/api/usage'), false)
  assert.equal(isAuthPath('/api/auth'), false, '前缀本身不是端点')
  assert.equal(isAuthPath('/api/profile/x'), false)
})

test('不认领的路径一律返回 null（约定：null = 不由本模块负责）', async () => {
  assert.equal(await call('/api/usage'), null)
  assert.equal(await call('/api/sessions'), null)
  assert.equal(await call('/health'), null)
})

// ── 用户档案 GET ─────────────────────────────────────────────────────────
test('profile GET：文件不存在 → 回空档案默认值（200，不报错）', async () => {
  const r = await call('/api/profile')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { nickname: '', avatar: '', bio: '' })
})

test('profile GET：文件存在 → raw:true 且**逐字原样**透传（不 parse/不 stringify）', async () => {
  await withTmp((dir) => {
    const p = join(dir, 'userData', 'profile.json')
    mkdirSync(dirname(p), { recursive: true })
    // 刻意用「非标准格式」的内容：多余空白 + 非规范键序。
    // 若实现改成 JSON.parse→JSON.stringify，这两个特征都会被抹掉，断言即失败。
    const raw = '{   "nickname" : "阿衡",\n\t"bio":"测试",   "avatar": ""  }'
    writeFileSync(p, raw, 'utf-8')
    return handleAuthRoute({ req: REQ, method: 'GET', pathname: '/api/profile', readJsonBody: async () => ({}), profilePath: p })
      .then((r) => {
        assert.equal(r.status, 200)
        assert.equal(r.raw, true, '必须是 raw 透传，供调用方直接作为响应体发出')
        assert.equal(r.body, raw, '响应体须与文件内容逐字一致')
      })
  })
})

// ── 用户档案 POST ────────────────────────────────────────────────────────
test('profile POST：落盘成功并回 ok', async () => {
  await withTmp(async (dir) => {
    const p = join(dir, 'userData', 'profile.json')
    const r = await handleAuthRoute({
      req: REQ, method: 'POST', pathname: '/api/profile',
      readJsonBody: async () => ({ nickname: '阿衡', avatar: 'data:image/png;base64,AAA', bio: '你好' }),
      profilePath: p,
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.deepEqual(JSON.parse(readFileSync(p, 'utf-8')), { nickname: '阿衡', avatar: 'data:image/png;base64,AAA', bio: '你好' })
  })
})

test('profile POST：目录不存在时递归创建', async () => {
  await withTmp(async (dir) => {
    const p = join(dir, 'a', 'b', 'c', 'profile.json')   // 深层不存在
    const r = await handleAuthRoute({ req: REQ, method: 'POST', pathname: '/api/profile', readJsonBody: async () => ({ nickname: 'x' }), profilePath: p })
    assert.equal(r.status, 200)
    assert.equal(JSON.parse(readFileSync(p, 'utf-8')).nickname, 'x')
  })
})

test('profile POST：nickname/bio 超长被裁剪（64 / 500），不是拒绝', async () => {
  await withTmp(async (dir) => {
    const p = join(dir, 'profile.json')
    const r = await handleAuthRoute({
      req: REQ, method: 'POST', pathname: '/api/profile',
      readJsonBody: async () => ({ nickname: 'n'.repeat(100), bio: 'b'.repeat(600) }),
      profilePath: p,
    })
    assert.equal(r.status, 200)
    const saved = JSON.parse(readFileSync(p, 'utf-8'))
    assert.equal(saved.nickname.length, 64)
    assert.equal(saved.bio.length, 500)
  })
})

test('profile POST：头像超过 400KB 被拒（400），且**不落盘**', async () => {
  await withTmp(async (dir) => {
    const p = join(dir, 'profile.json')
    const r = await handleAuthRoute({
      req: REQ, method: 'POST', pathname: '/api/profile',
      readJsonBody: async () => ({ avatar: 'a'.repeat(400_001) }),
      profilePath: p,
    })
    assert.equal(r.status, 400)
    assert.equal(r.body.ok, false)
    assert.throws(() => readFileSync(p, 'utf-8'), '被拒的请求不得留下文件')
  })
})

test('profile POST：请求体解析失败（readJsonBody 抛错）→ 退化为空档案，不 500', async () => {
  await withTmp(async (dir) => {
    const p = join(dir, 'profile.json')
    const r = await handleAuthRoute({ req: REQ, method: 'POST', pathname: '/api/profile', readJsonBody: async () => { throw new Error('bad json') }, profilePath: p })
    assert.equal(r.status, 200)
    assert.deepEqual(JSON.parse(readFileSync(p, 'utf-8')), { nickname: '', avatar: '', bio: '' })
  })
})

// ── 安全顺序守卫 ─────────────────────────────────────────────────────────
// ⚠️ 用**调用点专属的代码形态**（而非裸函数名）定位：裸 `isAllowedOrigin(` / `authorizeBridgeRequest(`
// 会命中注释里提到的同名字符串（本文件与 bridge 里都有这类注释），从而断言出一个虚假的顺序。
// 这是我们踩过的坑（源码守卫被注释干扰），故这里一律匹配含实参的完整调用。
test('安全守卫：auth 委托点必须在令牌闸门之后（否则 /api/auth/* 成未鉴权入口）', () => {
  const src = readFileSync(join(REPO, 'server', 'bridge.mjs'), 'utf8')
  const originGate = src.indexOf('if (origin && !isAllowedOrigin(origin))')   // 第一道：外部来源 403
  const tokenGate = src.indexOf('const authz = authorizeBridgeRequest(req, BRIDGE_TOKEN)')  // 第二道：令牌
  const delegate = src.indexOf('await handleAuthRoute({')                      // 身份面委托点
  assert.ok(originGate > 0, '前置条件：应存在 isAllowedOrigin 白名单调用')
  assert.ok(tokenGate > 0, '前置条件：应存在令牌闸门调用')
  assert.ok(delegate > 0, '接入守卫的委托点应存在')
  assert.ok(originGate < tokenGate, 'isAllowedOrigin 白名单必须在令牌闸门之前（外部来源先被 403 拦下）')
  assert.ok(
    delegate > tokenGate,
    'handleAuthRoute 的调用点跑到了令牌闸门之前 —— 这会让 /api/auth/* 暴露为未鉴权入口。'
    + '（闸门的豁免判定按 pathname 走、与路由写在哪个文件无关，因此搬迁本身安全；但顺序不能变。）',
  )
})
