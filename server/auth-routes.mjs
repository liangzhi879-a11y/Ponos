// server/auth-routes.mjs —— 登录屏口令、用户档案（P1 批次 2 迁出）
// ---------------------------------------------------------------------------
// 为什么这些端点归一个模块：它们共同构成"**身份面**"——口令校验与用户档案读写。
// 把它们聚到一处，安全复核只需看一个文件（此前散在 3900 行的桥里）。
//
// ⚠️ **两道闸门与本模块无关，但顺序是安全前提**（搬迁时已核实，勿在不理解前改动）：
//   桥的请求处理开头依次是
//     ① `isAllowedOrigin(origin)` 白名单 —— 外部来源（如 Origin: https://evil.com）一律 403；
//     ② `authorizeBridgeRequest(req, BRIDGE_TOKEN)` —— 令牌校验，且**按 pathname** 判定豁免
//        （豁免面含 `/health` 与 `/api/auth/*`，因为登录发生在拿到令牌之前）。
//   本模块被调用的位置在 ② 之后，而 ② 的豁免判定按 pathname 走、与"路由处理写在哪个文件"无关，
//   所以把处理逻辑搬出 bridge **不改变**鉴权行为。
//   若将来把本模块的调用点挪到 ② 之前，或调整 ①② 的先后，就会真的开出未鉴权入口。
//
// 状态归属：`authTokens` 占位表与 `issueToken()` 原先定义在 bridge 里，但**仅**被登录/登出
// 端点使用（闸门用的是另一个静态 BRIDGE_TOKEN），故一并移入本模块由它独占——
// 状态跟着它的唯一使用者走，比留在桥里再按引用注入更不易出错。
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { getAuthStatus, setupPassword, checkPassword, changePassword } from './auth.mjs'

const AUTH_PATHS = new Set([
  '/api/auth/status', '/api/auth/setup', '/api/auth/login', '/api/auth/logout', '/api/auth/change-password',
])
const PROFILE_PATH_ONLY = '/api/profile'

/** 本模块认领的路径 */
export function isAuthPath(pathname) {
  return AUTH_PATHS.has(pathname) || pathname === PROFILE_PATH_ONLY
}

// 登录 token 占位表：token -> expiry（24h）。重启即清空 → 每次启动都要口令；
// /api/auth/status 不做 token 免密判定，token 仅作为未来服务端会话换用的占位。
const authTokens = new Map() // token -> expiry（重启清空）
function issueToken() {
  const t = randomBytes(24).toString('hex')
  authTokens.set(t, Date.now() + 86_400_000)
  return t
}

const json = (status, body) => ({ status, body })

/**
 * 处理身份面端点；不由本模块负责时返回 null（约定同其它 *-routes 模块）。
 *
 * @param {object} p
 * @param {import('node:http').IncomingMessage} p.req  原请求（readJsonBody 需要它读体）
 * @param {string} p.method
 * @param {string} p.pathname
 * @param {Function} p.readJsonBody   桥的 JSON 体解析（容错口径：解析失败回 {}）
 * @param {string} p.profilePath      用户档案落盘路径（由桥解析 YFW_HOME 后传入，
 *                                    保持"home 解析"仅有一处真源）
 * @returns {Promise<{status:number,body:any,raw?:boolean}|null>}
 *   `raw:true` 表示 body 是**已就绪的字符串**，调用方直接作为响应体发出、不再 JSON.stringify。
 *   （用户档案 GET 需要原样透传文件内容，见该分支注释。）
 */
export async function handleAuthRoute({ req, method, pathname, readJsonBody, profilePath }) {
  if (!isAuthPath(pathname)) return null

  // ── 口令端点（GUI 专用）：本地 scrypt 口令（server/auth.mjs），token 仅占位 ──
  if (pathname === '/api/auth/status') {
    const st = await getAuthStatus()
    return json(200, st)
  }
  if (pathname === '/api/auth/setup' && method === 'POST') {
    const { password } = await readJsonBody(req).catch(() => ({}))
    try { await setupPassword(password); return json(200, { ok: true }) }
    catch (e) { return json(400, { ok: false, error: e?.message || String(e) }) }
  }
  if (pathname === '/api/auth/login' && method === 'POST') {
    const { password } = await readJsonBody(req).catch(() => ({}))
    try {
      const r = await checkPassword(password)
      if (r.ok) return json(200, { ok: true, token: issueToken() })
      // 锁定与口令错误要区分状态码：前端据此决定是"禁用重试并倒计时"还是"提示重输"
      const code = r.lockedForMs != null ? 423 : 401
      return json(code, { ok: false, error: r.reason, lockedForMs: r.lockedForMs ?? null })
    } catch (e) { return json(400, { ok: false, error: e?.message || String(e) }) }
  }
  if (pathname === '/api/auth/logout' && method === 'POST') {
    const { token } = await readJsonBody(req).catch(() => ({}))
    if (token) authTokens.delete(token)
    return json(200, { ok: true })
  }
  // 修改密码（2026-09-10 个人信息窗）：验证旧密 → 新盐新哈希；未初始化时直接设置。
  if (pathname === '/api/auth/change-password' && method === 'POST') {
    const { oldPassword, newPassword } = await readJsonBody(req).catch(() => ({}))
    try {
      const r = await changePassword(oldPassword, newPassword)
      if (!r.ok) {
        const code = r.lockedForMs != null ? 423 : 401
        return json(code, { ok: false, error: r.reason, lockedForMs: r.lockedForMs ?? null })
      }
      return json(200, { ok: true, wasUninitialized: r.wasUninitialized === true })
    } catch (e) { return json(400, { ok: false, error: e?.message || String(e) }) }
  }

  // ── 用户档案（2026-09-10 个人信息窗）：昵称/头像(dataURL)/简介，落盘
  // <YFW_HOME>/userData/profile.json；头像上限 400KB 防单文件膨胀。
  if (pathname === '/api/profile' && method === 'GET') {
    try {
      // raw:true —— 与迁移前逐字一致：**原样透传文件文本**，不经 JSON.parse/stringify。
      // 换成 parse 再 stringify 会改变响应字节（键序、空白、以及非标准 JSON 时的行为差异）。
      return { status: 200, body: readFileSync(profilePath, 'utf-8'), raw: true }
    } catch { return json(200, { nickname: '', avatar: '', bio: '' }) }
  }
  if (pathname === '/api/profile' && method === 'POST') {
    const body = await readJsonBody(req).catch(() => ({}))
    const nickname = String(body.nickname ?? '').slice(0, 64)
    const bio = String(body.bio ?? '').slice(0, 500)
    const avatar = String(body.avatar ?? '')
    if (avatar.length > 400_000) return json(400, { ok: false, error: 'avatar too large' })
    try {
      mkdirSync(dirname(profilePath), { recursive: true })
      writeFileSync(profilePath, JSON.stringify({ nickname, avatar, bio }, null, 2), 'utf-8')
      return json(200, { ok: true })
    } catch (e) { return json(400, { ok: false, error: String(e?.message || e) }) }
  }

  return null
}
