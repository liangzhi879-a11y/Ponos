// yfljsj CLI — 单文件（零依赖，仅 Node 内置模块）
// Task 2：认证模块（3 种登录 + token 本地存储 + refresh 自动续期 + 401 重试 + 并发单飞）
// Task 3：通用命令执行器 runCommand + 兜底原始调用 rawRequest + 退出码映射
// Task 4：CLI 入口 — parseArgs 参数解析 + main 命令路由 + formatOutput 输出格式化
// Task 5：discover 代理 — 本地 HTTP 代理捕获浏览器真实请求，合并进命令表补漏
// Task 6：安全 — 写操作确认 / 域名白名单（防 SSRF）/ 审计日志 / 敏感字段脱敏
import https from 'node:https'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { pathToFileURL } from 'node:url'
import { inferAction, inferService, inferParams, inferKind } from './scripts/gen-apis.mjs'

// 平台网关（与 scripts/gen-apis.mjs 的 SERVICES 保持一致）
export const SERVICES = {
  oauth: 'https://gateway.yfljsj.com/api/oauth',
  upms: 'https://gateway.yfljsj.com/api/upms',
  rcms: 'https://gateway.yfljsj.com/api/rcms',
}

// =====================================================================
// HTTP 请求封装
// =====================================================================
// rejectUnauthorized：生产默认 true（校验 TLS 证书）；测试 mock 自签名证书传 false。
export function httpRequest(urlStr, opts = {}) {
  const { method = 'GET', body, headers = {}, rejectUnauthorized = true, timeout = 30000 } = opts
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(urlStr)
    } catch (e) {
      reject(e)
      return
    }
    const isHttps = u.protocol === 'https:'
    const mod = isHttps ? https : http
    const payload = body == null ? null : typeof body === 'string' ? body : JSON.stringify(body)
    const req = mod.request(
      u,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
          ...(payload != null ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        ...(isHttps ? { rejectUnauthorized } : {}),
        timeout,
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let parsed = null
          if (raw) {
            try {
              parsed = JSON.parse(raw)
            } catch {
              /* 非 JSON 响应，保留原始文本 */
            }
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw })
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy(Object.assign(new Error(`request timeout (${method} ${urlStr})`), { code: 'ETIMEOUT' }))
    })
    if (payload != null) req.write(payload)
    req.end()
  })
}

// =====================================================================
// 本地 token 存储（~/.yfljsj/config.json，chmod 600）
// =====================================================================
// 测试隔离：可用环境变量 YFLJSJ_HOME 覆盖 home 目录（默认 os.homedir()）
// config 落在 <home>/.yfljsj/config.json
export function configDir() {
  const home = process.env.YFLJSJ_HOME || os.homedir()
  return path.join(home, '.yfljsj')
}
export function configPath() {
  return path.join(configDir(), 'config.json')
}

export function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'))
  } catch {
    return {}
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(configDir(), { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
  try {
    fs.chmodSync(configPath(), 0o600) // POSIX 生效；Windows 尽力而为
  } catch {
    /* Windows 无 POSIX 权限位，忽略 */
  }
}

// =====================================================================
// Task 6：安全 — 写操作确认 / 域名白名单（防 SSRF）/ 审计日志 / 敏感字段脱敏
// =====================================================================

// config 配置读写（~/.yfljsj/config.json）：getConfigValue(key) / setConfigValue(key, value)。
//   yfljsj config set auto-confirm-write true|false 由 main 路由到 setConfigValue。
export function getConfigValue(key) {
  const cfg = readConfig()
  return key ? cfg[key] : cfg
}
export function setConfigValue(key, value) {
  const cfg = readConfig()
  cfg[key] = coerceConfigScalar(value)
  writeConfig(cfg)
  return cfg[key]
}
// CLI 传入的配置值是字符串：'true'/'false'/'数字' 做类型归一，其余保留原样
function coerceConfigScalar(v) {
  if (v === 'true') return true
  if (v === 'false') return false
  if (v !== '' && v != null && !Number.isNaN(Number(v))) return Number(v)
  return v
}

// flag 是否生效：--flag / --flag=1 / 'true' 视为开启；缺省或 'false'/'0' 视为关闭
function flagOn(opts, name) {
  const v = opts && opts[name]
  if (v === undefined || v === null) return false
  if (v === true) return true
  const s = String(v).toLowerCase()
  return !(s === 'false' || s === '0' || s === '')
}

// 写操作确认：kind=write 需显式 --confirm/--yes（或配置 auto-confirm-write=true）；
// delete/deleteBatch/remove 类还需额外显式 --force。返回 { allowed, reason }，拒绝时调用方应回退出码 2。
export function confirmWrite(cmd, opts = {}) {
  if (!cmd || cmd.kind !== 'write') return { allowed: true }
  const action = String(cmd.action || '')
  const isDeleteLike =
    /delete|remove|batchDelete/i.test(action) || /delete|remove/i.test(String(cmd.path || ''))
  const autoConfirm = getConfigValue('auto-confirm-write') === true
  const confirmed = autoConfirm || flagOn(opts, '--confirm') || flagOn(opts, '--yes')
  if (!confirmed) {
    return {
      allowed: false,
      reason: `写操作 ${cmd.action} 需显式确认：加 --confirm（或 --yes；或 config set auto-confirm-write true）`,
    }
  }
  if (isDeleteLike && !flagOn(opts, '--force')) {
    return { allowed: false, reason: `删除操作 ${cmd.action} 需额外显式 --force 确认` }
  }
  return { allowed: true }
}

// 域名白名单（防 SSRF）：仅生产网关 *.yfljsj.com 与本机回环（localhost/127.0.0.1/::1，测试 mock）。
const WHITELIST_DOMAIN = 'yfljsj.com'
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])
export function isWhitelisted(urlStr) {
  let u
  try {
    u = new URL(urlStr)
  } catch {
    return false
  }
  const host = String(u.hostname).replace(/^\[|\]$/g, '').toLowerCase()
  if (LOOPBACK_HOSTS.has(host)) return true
  return host === WHITELIST_DOMAIN || host.endsWith('.' + WHITELIST_DOMAIN)
}
export function assertWhitelist(url) {
  if (isWhitelisted(url)) return { allowed: true }
  return {
    allowed: false,
    reason: `域名不在白名单，已拒绝（防 SSRF）：${url}（仅允许 *.yfljsj.com / localhost / 127.0.0.1）`,
  }
}

// 审计日志：~/.yfljsj/audit.log 追加一行（时间戳 + 命令 + 路径 + 方法；不含 token/密码）。
//   entry: { cmd, path, method }
export function appendAudit(entry = {}) {
  const ts = new Date().toISOString()
  const cmd = entry.cmd || entry.moduleAction || ''
  const entryPath = entry.path || ''
  const method = entry.method || ''
  const line = `${ts} cmd=${cmd} method=${method} path=${entryPath}\n`
  const dir = configDir()
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(path.join(dir, 'audit.log'), line)
}
// 审计失败不阻断请求（只读文件系统等极端场景降级）
function safeAudit(entry) {
  try {
    appendAudit(entry)
  } catch {
    /* ignore */
  }
}

// 敏感字段脱敏：递归把 data 中标 sensitive 的字段替换为掩码（--human 输出分支用）。
//   基于结构化克隆（不改动调用方原始数据），仅值替换为 '******'。
export function maskSensitive(data, fields = []) {
  if (data == null || typeof data !== 'object' || !Array.isArray(fields) || fields.length === 0) return data
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (fields.includes(k) && v !== null && v !== undefined) {
          node[k] = '******'
        } else if (v && typeof v === 'object') {
          walk(v)
        }
      }
    }
    return node
  }
  return walk(structuredClone(data))
}

// 从命令表命令提取敏感字段：params 中标 sensitive 的 key + 命令级 sensitive 数组；无声明 → []
function sensitiveFieldsOf(cmd) {
  const fields = []
  const params = cmd && cmd.params
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      if (v && typeof v === 'object' && v.sensitive) fields.push(k)
    }
  }
  const extra = cmd && cmd.sensitive
  if (Array.isArray(extra)) for (const f of extra) if (!fields.includes(f)) fields.push(f)
  return fields
}

// 读取已存 token（未登录返回 null）
export function getToken() {
  const cfg = readConfig()
  if (!cfg.accessToken) return null
  return {
    accessToken: cfg.accessToken,
    refreshToken: cfg.refreshToken || null,
    tenantId: cfg.tenantId || null,
    expiresAt: cfg.expiresAt || null,
  }
}

// 清空本地 token（保留其余配置字段）
export function clearToken() {
  const cfg = readConfig()
  for (const k of ['accessToken', 'refreshToken', 'tenantId', 'expiresAt']) delete cfg[k]
  writeConfig(cfg)
}

// =====================================================================
// token 提取：兼容「响应体 data / 响应体根 / 响应头」三处位置
// =====================================================================
export function extractTokens(res) {
  const out = { accessToken: null, refreshToken: null, tenantId: null, expiresAt: null }
  const root = res.body && typeof res.body === 'object' ? res.body : {}
  const data = root.data && typeof root.data === 'object' ? root.data : null
  const src = data || root // 优先 data，其次 body 根
  out.accessToken = src.accessToken || src.access_token || src.token || src.jwt || null
  out.refreshToken = src.refreshToken || src.refresh_token || null
  out.tenantId = src.tenantId || src.tenant_id || src.tenant || null
  const expiresIn = src.expiresIn || src.expires_in || src.expiresInSeconds
  if (src.expiresAt && !Number.isNaN(Number(src.expiresAt))) {
    // 时间戳量级判定（合并前审阅修复）：1e11 区分「绝对毫秒」与「秒级/相对秒」
    //   v > 1e11        → 绝对毫秒时间戳（如 1788222223000），直接用
    //   1e9 < v ≤ 1e11  → 绝对秒级时间戳（如 1788222223，约 1.7e9），*1000
    //   v ≤ 1e9         → 相对秒（expiresIn 语义，如 7200=2h），Date.now()+v*1000
    const v = Number(src.expiresAt)
    if (v > 1e11) out.expiresAt = v
    else if (v > 1e9) out.expiresAt = v * 1000
    else out.expiresAt = Date.now() + v * 1000
  } else if (expiresIn) {
    out.expiresAt = Date.now() + Number(expiresIn) * 1000
  }
  // 响应头兜底（网关可能把 JWT 放 header）
  const h = res.headers || {}
  if (!out.accessToken) {
    const a = h['access-token'] || h['access_token'] || h['x-access-token']
    out.accessToken = a || (h.authorization && h.authorization.replace(/^Bearer\s+/i, '')) || null
  }
  if (!out.refreshToken) out.refreshToken = h['refresh-token'] || h['refresh_token'] || null
  if (!out.tenantId) out.tenantId = h['tenant-id'] || h['tenant_id'] || h['x-tenant-id'] || null
  return out
}

const DEFAULT_EXPIRES_MS = 2 * 60 * 60 * 1000 // 未给 expiresIn 时默认 2h

// SM4 密码加密（平台契约，真机联调破解 2026-09-01）：
//   格式 = 16字节随机IV(hex,32字符) + SM4-CBC(key, iv) 加密明文(hex)
//   密钥固定 9e2c5f1a8b3d7046f5a9c2e1b7d4803f（前端 Login chunk xA() 逆向）
import { randomBytes, createCipheriv } from 'node:crypto'
const SM4_KEY = Buffer.from('9e2c5f1a8b3d7046f5a9c2e1b7d4803f', 'hex')
export function encryptPassword(pw) {
  if (!pw) return ''
  const iv = randomBytes(16).toString('hex') // 32 字符 hex 作 IV
  const cipher = createCipheriv('sm4-cbc', SM4_KEY, Buffer.from(iv, 'hex'))
  return iv + cipher.update(pw, 'utf8', 'hex') + cipher.final('hex')
}

// =====================================================================
// 登录（3 种方式）
//   method 1 = 密码（username/password）
//   method 2 = 验证码（user/code）
//   method 3 = 租户（user/tenantId）
// =====================================================================
export async function login({ method, user, password, code, tenant, userId, baseUrl, rejectUnauthorized = true, input, output } = {}) {
  const m = Number(method)
  let body
  if (m === 1) {
    // 非交互守卫（合并前审阅修复）：非 TTY 且未传 password 时不再挂起等待 stdin，
    // 直接返回用法错（CLI 映射 exit 2）。显式注入的 input 流（测试/工具）视为可控交互。
    if (password == null || password === '') {
      const interactive = input != null || !!(process.stdin && process.stdin.isTTY)
      if (!interactive) {
        return { ok: false, code: 'USAGE_ERROR', error: '非交互模式必须显式传 --password' }
      }
    }
    const pw = password != null && password !== '' ? password : await promptPassword({ input, output })
    // 平台契约：loginName 字段 + 密码 SM4 加密（真机联调破解）
    body = { loginMethod: 1, loginName: user, password: encryptPassword(pw) }
  } else if (m === 2) {
    // 平台契约：验证码也 SM4 加密，字段 opsLoginToken
    body = { loginMethod: 2, loginName: user, opsLoginToken: encryptPassword(code) }
  } else if (m === 3) {
    // 平台契约：租户登录用 userId + companyTenantId
    body = { loginMethod: 3, userId: userId || user, companyTenantId: tenant }
  } else {
    return { ok: false, error: `method 必须是 1(密码)/2(验证码)/3(租户)，收到：${method}` }
  }
  const svc = baseUrl || SERVICES.oauth
  try {
    const res = await httpRequest(`${svc}/auth/login`, { method: 'POST', body, rejectUnauthorized })
    if (res.status !== 200 || (res.body && typeof res.body === 'object' && res.body.success === false)) {
      return {
        ok: false,
        error: (res.body && typeof res.body === 'object' && (res.body.msg || res.body.message)) || `login HTTP ${res.status}`,
      }
    }
    const t = extractTokens(res)
    if (!t.accessToken) {
      return { ok: false, error: '登录成功但响应中未找到 accessToken（已探测响应体 data/根/响应头）' }
    }
    const cfg = readConfig()
    const updated = {
      ...cfg,
      accessToken: t.accessToken,
      refreshToken: t.refreshToken || cfg.refreshToken || null,
      tenantId: t.tenantId || cfg.tenantId || null,
      expiresAt: t.expiresAt || cfg.expiresAt || Date.now() + DEFAULT_EXPIRES_MS,
    }
    writeConfig(updated)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message, network: isNetworkError(e) }
  }
}

// 网络层错误判定（合并前审阅修复）：CLI 据此把登录网络错误映射 exit 4（而非 1）。
// 覆盖 Node 常见 socket/DNS/TLS 错误码与 fetch 兼容层语义。
export function isNetworkError(e) {
  const s = String((e && (e.code || e.message)) || '')
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|timeout|fetch failed|socket hang up|TLS|certificate|self signed/i.test(s)
}

// 密码交互输入（隐藏回显，零依赖：拦截 output.write 吞掉回显）
export function promptPassword({ input = process.stdin, output = process.stdout, prompt = 'Password: ' } = {}) {
  return new Promise((resolve, reject) => {
    // 非 TTY 守卫（合并前审阅修复）：默认 process.stdin 非 TTY（agent 子进程管道/EOF）时
    // 拒绝而非挂起，避免 readline 在无数据/EOF 的 stdin 上永不回调。
    if (input === process.stdin && !(process.stdin && process.stdin.isTTY)) {
      const err = new Error('非交互模式必须显式传 --password')
      err.code = 'USAGE_ERROR'
      reject(err)
      return
    }
    const rl = readline.createInterface({ input, output, terminal: true })
    let restore = null
    if (output && typeof output.write === 'function') {
      const orig = output.write.bind(output)
      restore = () => {
        output.write = orig
      }
      output.write = (chunk, ...rest) => {
        const s = String(chunk)
        if (s.includes(prompt)) return orig(chunk, ...rest) // 只放行提示符
        return true // 吞掉输入回显
      }
    }
    rl.on('error', (e) => {
      if (restore) restore()
      rl.close()
      reject(e)
    })
    rl.question(prompt, (answer) => {
      if (restore) restore()
      rl.close()
      resolve(answer)
    })
  })
}

// =====================================================================
// refresh 自动续期（expiresAt < now+5min 触发）+ 并发单飞
// =====================================================================
let refreshInFlight = null

function needsRefresh(cfg) {
  if (!cfg.expiresAt) return true
  return cfg.expiresAt - Date.now() < 5 * 60 * 1000
}

// 单飞实现：同一时刻只允许一个 refresh 请求，其余调用共享同一 Promise
function refreshTokenNow({ baseUrl, rejectUnauthorized }) {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const cfg = readConfig()
        const svc = baseUrl || SERVICES.oauth
        const res = await httpRequest(`${svc}/auth/refresh-token`, {
          method: 'POST',
          body: { refreshToken: cfg.refreshToken },
          rejectUnauthorized,
        })
        const failed =
          res.status !== 200 || (res.body && typeof res.body === 'object' && res.body.success === false)
        if (failed) {
          clearToken()
          const err = new Error(
            (res.body && typeof res.body === 'object' && (res.body.msg || res.body.message)) || `refresh HTTP ${res.status}`
          )
          err.code = 'AUTH_REQUIRED'
          throw err
        }
        const t = extractTokens(res)
        if (!t.accessToken || !t.refreshToken) {
          clearToken()
          const err = new Error('refresh 响应缺少 accessToken/refreshToken')
          err.code = 'AUTH_REQUIRED'
          throw err
        }
        const updated = {
          ...cfg,
          accessToken: t.accessToken,
          refreshToken: t.refreshToken,
          tenantId: t.tenantId || cfg.tenantId || null,
          expiresAt: t.expiresAt || Date.now() + DEFAULT_EXPIRES_MS,
        }
        writeConfig(updated)
        return updated
      } finally {
        refreshInFlight = null
      }
    })()
  }
  return refreshInFlight
}

// 确保有可用 token；过期/将过期时自动 refresh。force=true 强制续期（401 场景）。
export function ensureToken({ baseUrl, force = false, rejectUnauthorized = true } = {}) {
  const cfg = readConfig()
  if (!cfg.accessToken) return Promise.resolve(null)
  if (!force && !needsRefresh(cfg)) return Promise.resolve(cfg)
  if (!cfg.refreshToken) {
    const err = new Error('refreshToken 缺失，无法续期，请重新登录')
    err.code = 'AUTH_REQUIRED'
    return Promise.reject(err)
  }
  return refreshTokenNow({ baseUrl, rejectUnauthorized })
}

// 带认证的请求：附加 Bearer token；401 → 强制 refresh（单飞）→ 重试一次
//   baseUrl：Task 2 兼容语义，仅用于 refresh 续期（refreshBaseUrl 缺省时的回退）
//   refreshBaseUrl：refresh 续期固定走的服务前缀（如 oauth）；缺省回退 baseUrl，再回退 SERVICES.oauth
export async function authenticatedRequest({ url, method = 'POST', body, headers = {}, baseUrl, refreshBaseUrl, rejectUnauthorized = true, timeout = 30000 } = {}) {
  const cfg = readConfig()
  if (!cfg.accessToken) {
    const err = new Error('未登录：请先执行 auth login')
    err.code = 'AUTH_REQUIRED'
    throw err
  }
  const doReq = (token) =>
    httpRequest(url, { method, body, headers: { ...headers, Authorization: `Bearer ${token}` }, rejectUnauthorized, timeout })
  let res = await doReq(cfg.accessToken)
  if (res.status === 401) {
    await ensureToken({ baseUrl: refreshBaseUrl || baseUrl, force: true, rejectUnauthorized })
    const cfg2 = readConfig()
    res = await doReq(cfg2.accessToken)
  }
  return res
}

// =====================================================================
// 登出 / 发验证码
// =====================================================================
export async function logout({ baseUrl, rejectUnauthorized = true } = {}) {
  const cfg = readConfig()
  if (!cfg.accessToken && !cfg.refreshToken) return { ok: true } // 未登录，无需登出
  const svc = baseUrl || SERVICES.oauth
  try {
    const res = await httpRequest(`${svc}/auth/logout`, {
      method: 'POST',
      body: { refreshToken: cfg.refreshToken || null, accessToken: cfg.accessToken || null },
      rejectUnauthorized,
    })
    clearToken()
    const ok = res.status === 200 && (!res.body || typeof res.body !== 'object' || res.body.success !== false)
    return ok ? { ok: true } : { ok: false, error: (res.body && res.body.msg) || `logout HTTP ${res.status}` }
  } catch (e) {
    clearToken() // 网络异常也清理本地 token，避免残留
    return { ok: false, error: e.message }
  }
}

export async function sendCode({ user, baseUrl, rejectUnauthorized = true } = {}) {
  const svc = baseUrl || SERVICES.oauth
  try {
    const res = await httpRequest(`${svc}/auth/sendCode`, { method: 'POST', body: { user }, rejectUnauthorized })
    const ok = res.status === 200 && (!res.body || typeof res.body !== 'object' || res.body.success !== false)
    return ok
      ? { ok: true }
      : { ok: false, error: (res.body && typeof res.body === 'object' && (res.body.msg || res.body.message)) || `sendCode HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// =====================================================================
// Task 3：命令表加载 + 参数解析（通用命令执行器）
// =====================================================================
const APIS_SEED_URL = new URL('./apis.seed.json', import.meta.url)
let apisCache = null

// 用户命令表路径：~/.yfljsj/apis.json（discover 合并产物，与 config 同目录）
export function apisPath() {
  return path.join(configDir(), 'apis.json')
}

/** v1 → v2 命令表迁移：params 字符串形式升级为对象定义；无损 */
export function migrateApis(apis) {
  if (!apis || apis.version >= 2) return apis
  const out = { ...apis, version: 2 }
  for (const m of Object.values(out.modules || {})) {
    for (const c of (m.commands || [])) {
      if (!c.params || typeof c.params !== 'object') continue
      const v2 = {}
      for (const [k, v] of Object.entries(c.params)) {
        if (v && typeof v === 'object' && v.type) v2[k] = v // 已是 v2
        else v2[k] = { type: typeof v === 'string' ? v : 'string', required: true, desc: '' }
      }
      c.params = v2
    }
  }
  return out
}

// 加载命令表：~/.yfljsj/apis.json（discover 补漏产物）存在时优先，否则回退静态 seed。
// force=true 强制重读（discover 写回后需要刷新缓存）。
export function loadApis({ force = false } = {}) {
  if (!apisCache || force) {
    const seedApis = JSON.parse(fs.readFileSync(APIS_SEED_URL, 'utf8'))
    let apis = seedApis
    try {
      const p = apisPath()
      if (fs.existsSync(p)) {
        const user = JSON.parse(fs.readFileSync(p, 'utf8'))
        // 用户表结构校验：modules 非空对象才覆盖 seed（空表/损坏表回退 seed，避免空表吞掉 535 命令）
        if (user && user.modules && typeof user.modules === 'object' && Object.keys(user.modules).length > 0) {
          apis = user
          // 旧版用户表（早期 explore 产物）缺元数据 → 从 seed 补入，避免升级后 relations/doc 空转
          apis.operations = apis.operations || seedApis.operations
          apis.relations = apis.relations || seedApis.relations
        }
      }
    } catch {
      /* 用户 apis.json 缺失/损坏 → 回退静态 seed */
    }
    apis = migrateApis(apis)
    apisCache = apis
  }
  return apisCache
}

// 写回用户命令表（discover 产物）
export function writeApis(apis) {
  fs.mkdirSync(configDir(), { recursive: true })
  fs.writeFileSync(apisPath(), JSON.stringify(apis, null, 2) + '\n')
}

// 解析命令级 args → { params, flags, data }。args 支持：
//   - 对象：{ key: value }；key='--data'/'data' 为显式 body，'--xxx' 为 flag，其余进 params
//   - CLI token 数组：['key=value', '--data', '{json}', '--flag'/'--flag=value']
// 除 --flag 外的键值进 params（GET→query；POST/PUT→body）；--data 显式 JSON 覆盖 body
// 注：Task 4 起 CLI 级 parseArgs 负责 argv 解析；本函数专供 runCommand 消费命令参数。
export function parseCommandArgs(args = {}) {
  const params = {}
  const flags = {}
  let data // 显式 body（--data），undefined 表示未提供
  if (Array.isArray(args)) {
    let i = 0
    while (i < args.length) {
      const tok = String(args[i])
      if (tok === '--data') {
        data = parseJsonSafe(String(args[i + 1]))
        i += 2
      } else if (tok.startsWith('--data=')) {
        data = parseJsonSafe(tok.slice('--data='.length))
        i += 1
      } else if (tok.startsWith('--')) {
        const eq = tok.indexOf('=')
        if (eq !== -1) flags[tok.slice(0, eq)] = tok.slice(eq + 1)
        else flags[tok] = true
        i += 1
      } else if (tok.includes('=')) {
        const eq = tok.indexOf('=')
        params[tok.slice(0, eq)] = tok.slice(eq + 1)
        i += 1
      } else {
        flags[tok] = true // 裸 token 视为 flag
        i += 1
      }
    }
  } else {
    for (const [k, v] of Object.entries(args)) {
      if (k === '--data' || k === 'data') {
        data = typeof v === 'string' ? parseJsonSafe(v) : v
      } else if (k.startsWith('--')) {
        flags[k] = v
      } else {
        params[k] = v
      }
    }
  }
  return { params, flags, data }
}

function parseJsonSafe(s) {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

// 按命令表 params 类型做值转换（CLI 字符串 → number/boolean）
function coerceBySchema(params, schema) {
  const out = {}
  for (const [k, v] of Object.entries(params)) {
    const t = schema[k]
    const type = t && typeof t === 'object' ? t.type : t
    if (type === 'number' && typeof v === 'string') {
      const n = Number(v)
      out[k] = Number.isNaN(n) ? v : n
    } else if (type === 'boolean' && typeof v === 'string') {
      if (v === 'true') out[k] = true
      else if (v === 'false') out[k] = false
      else out[k] = v
    } else {
      out[k] = v
    }
  }
  return out
}

// 结果格式化 → { exitCode, json }。退出码契约：0=成功 / 1=业务错 / 2=用法错 / 3=认证失败 / 4=网络错
function formatResult(res) {
  const { status } = res
  const body = res.body
  // HTTP 401 优先判为认证失败（refresh 重试后仍 401 → 需重新登录）
  if (status === 401) {
    const msg = (body && typeof body === 'object' && (body.msg || body.message)) || '未授权（401）'
    return { exitCode: 3, json: { success: false, code: 3, msg, data: null } }
  }
  if (body && typeof body === 'object' && 'success' in body) {
    return body.success === false ? { exitCode: 1, json: body } : { exitCode: 0, json: body }
  }
  if (status >= 200 && status < 300) {
    return { exitCode: 0, json: body !== null && body !== undefined ? body : { success: true, data: res.raw } }
  }
  return {
    exitCode: 1,
    json: {
      success: false,
      code: status,
      msg: (body && typeof body === 'object' && (body.msg || body.message)) || `HTTP ${status}`,
      data: null,
    },
  }
}

function usageResult(msg) {
  return { exitCode: 2, json: { success: false, code: 2, msg, data: null } }
}

function errorResult(e) {
  if (e && e.code === 'AUTH_REQUIRED') {
    return { exitCode: 3, json: { success: false, code: 3, msg: e.message || '未登录：请先执行 auth login', data: null } }
  }
  return { exitCode: 4, json: { success: false, code: 4, msg: (e && e.message) || '网络错误', data: null } }
}

// refresh 续期固定走 oauth 服务前缀：
//   默认取请求 base 同 origin 的 /api/oauth（生产即 SERVICES.oauth，测试可落到 mock 网关）；
//   显式 refreshBaseUrl 优先（定制网关/单测注入）。
function oauthRefreshBase(requestBase, refreshBaseUrl) {
  if (refreshBaseUrl) return refreshBaseUrl
  try {
    return `${new URL(requestBase).origin}/api/oauth`
  } catch {
    return SERVICES.oauth
  }
}

// 通用命令执行器：查命令表 → 校验必填 → 拼 URL（services[service]+path）→ 带认证请求 → 格式化
//   GET→query 参数；POST/PUT→body JSON（args 除已知 --flag 外全进 body；--data 显式覆盖 body）
export async function runCommand(module, action, args = {}, opts = {}) {
  const { baseUrl, refreshBaseUrl, rejectUnauthorized = true, timeout, headers = {} } = opts
  const apis = loadApis()
  const mod = apis.modules[module]
  if (!mod) {
    return usageResult(`未知模块：${module}（可用模块：${Object.keys(apis.modules).join('、')}）`)
  }
  const cmd = (mod.commands || []).find((c) => c.action === action)
  if (!cmd) return usageResult(`未知命令：${module} ${action}（可用 action：${mod.commands.map((c) => c.action).join('、')}）`)

  // 安全钩子：写操作确认（kind=write 需 --confirm/--yes；delete/remove 类还需 --force）
  const confirm = confirmWrite(cmd, opts)
  if (!confirm.allowed) return usageResult(confirm.reason)

  const { params, data } = parseCommandArgs(args)
  const schema = cmd.params || {}

  // 必填校验：命令表 params 中的字段（对象 schema 可用 required:false 豁免；--data 显式 body 时跳过）
  const missing =
    data !== undefined
      ? []
      : Object.keys(schema).filter((k) => {
          const s = schema[k]
          const required = s && typeof s === 'object' ? s.required !== false : true
          return required && (params[k] === undefined || params[k] === null || params[k] === '')
        })
  if (missing.length) return usageResult(`缺少必填参数：${missing.join('、')}`)

  const typed = coerceBySchema(params, schema)
  // 平台契约：多数接口要求 tenantId（真机联调 2026-09-01 发现 rdItem/psItem 等缺 tenantId 报 C_PARAM_INVALID）。
  // 自动从登录态配置注入（用户显式传 --tenantId 时以用户为准）。
  if (typed.tenantId === undefined || typed.tenantId === null || typed.tenantId === '') {
    const cfg = readConfig()
    if (cfg.tenantId != null) typed.tenantId = cfg.tenantId
  }
  const base = baseUrl || SERVICES[mod.service] || SERVICES.rcms
  const method = (cmd.method || 'POST').toUpperCase()
  let url = `${base}${cmd.path}`
  let body
  if (method === 'GET' && data === undefined) {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(typed)) {
      qs.append(k, v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v))
    }
    const q = qs.toString()
    if (q) url += `?${q}`
  } else {
    body = data !== undefined ? data : typed
  }
  // 安全钩子：域名白名单（防 SSRF）——请求前校验目标 host
  const wl = assertWhitelist(url)
  if (!wl.allowed) return usageResult(wl.reason)
  // 审计条目：只记录命令/路径/方法，绝不落 token/密码
  const auditEntry = { cmd: `${module} ${action}`, path: cmd.path, method }
  try {
    // 命令请求走 base（服务前缀）；refresh 续期固定走 oauth（refreshBaseUrl），不随命令服务前缀
    const res = await authenticatedRequest({ url, method, body, refreshBaseUrl: oauthRefreshBase(base, refreshBaseUrl), rejectUnauthorized, headers, timeout })
    const result = formatResult(res)
    // 安全钩子：审计日志（请求后）
    safeAudit(auditEntry)
    // 附带命令表标 sensitive 的字段（--human 输出脱敏用）
    return { ...result, sensitive: sensitiveFieldsOf(cmd) }
  } catch (e) {
    safeAudit(auditEntry)
    return errorResult(e)
  }
}

// 兜底原始调用：不查命令表，按 {path, method, data, service} 直接发认证请求
export async function rawRequest({ path, method = 'POST', data, service = 'rcms', baseUrl, refreshBaseUrl, rejectUnauthorized = true, timeout, headers = {} } = {}) {
  const base = baseUrl || SERVICES[service] || SERVICES.rcms
  const p = path.startsWith('/') ? path : `/${path}`
  const url = `${base}${p}`
  // 安全钩子：域名白名单（防 SSRF）——请求前校验目标 host
  const wl = assertWhitelist(url)
  if (!wl.allowed) return usageResult(wl.reason)
  // 审计条目：只记录路径/方法，绝不落 token/密码
  const auditEntry = { cmd: `raw ${p}`, path: p, method: String(method).toUpperCase() }
  try {
    const res = await authenticatedRequest({ url, method, body: data, refreshBaseUrl: oauthRefreshBase(base, refreshBaseUrl), rejectUnauthorized, headers, timeout })
    const result = formatResult(res)
    // 安全钩子：审计日志（请求后）
    safeAudit(auditEntry)
    return result
  } catch (e) {
    safeAudit(auditEntry)
    return errorResult(e)
  }
}

// =====================================================================
// Task 4：CLI 入口 — 参数解析 / 命令路由 / 输出格式化
// =====================================================================
export const VERSION = '0.5.0'

// CLI 级参数解析：argv = process.argv.slice(2)
//   => { command, sub, args, opts, positional }
//   command/sub：命令树前两个 token（'--help'/'-h' 等顶层 flag 直接作为 command）
//   args：command/sub 之后的原始 token 数组（透传给 runCommand 桥接层）
//   opts：{ '--key': value, '--flag': true, '--data': 'json 字符串' }
//   positional：非 -- 前缀的零散 token
export function parseArgs(argv = []) {
  const tokens = Array.isArray(argv) ? argv.map(String) : []
  const command = tokens[0] || null
  if (command === null) return { command: null, sub: null, args: [], opts: {}, positional: [] }
  const rest = tokens.slice(1)
  let sub = null
  let args = rest
  if (rest.length && !rest[0].startsWith('--')) {
    sub = rest[0]
    args = rest.slice(1)
  }
  const { opts, positional } = parseFlagTokens(args)
  return { command, sub, args, opts, positional }
}

// flag token 解析：--key value / --key=value / --flag / --data 'json' / key=value / 裸 token
function parseFlagTokens(tokens) {
  const opts = {}
  const positional = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '--data') {
      opts['--data'] = tokens[i + 1]
      i += 1
    } else if (t.startsWith('--data=')) {
      opts['--data'] = t.slice('--data='.length)
    } else if (t.startsWith('--') && t.includes('=')) {
      const eq = t.indexOf('=')
      opts[t.slice(0, eq)] = t.slice(eq + 1)
    } else if (t.startsWith('--')) {
      const next = tokens[i + 1]
      if (next !== undefined && next !== '' && !next.startsWith('--')) {
        opts[t] = next // --key value
        i += 1
      } else {
        opts[t] = true // --flag（布尔）
      }
    } else if (t.includes('=')) {
      const eq = t.indexOf('=')
      opts[t.slice(0, eq)] = t.slice(eq + 1)
    } else {
      positional.push(t)
    }
  }
  return { opts, positional }
}

// CLI flag → runCommand 可识别的参数对象（--key value → { key: value }；--data 显式 body）。
// --human/--json 为 CLI 输出开关；--confirm/--yes/--force 为安全确认开关，均不进入命令参数。
function toCommandArgs(tokens) {
  const { opts } = parseFlagTokens(tokens)
  const out = {}
  for (const [k, v] of Object.entries(opts)) {
    if (k === '--data') out['--data'] = v
    else if (k === '--human' || k === '--json' || k === '--confirm' || k === '--yes' || k === '--force') continue
    else if (k.startsWith('--')) out[k.slice(2)] = v
    else out[k] = v
  }
  return out
}

// 输出格式化：--json（默认）JSON.stringify 单行；--human 表格（数组字段自动表头）。
//   sensitive：命令表标 sensitive 的字段名数组，仅 --human 分支脱敏（--json 保留原始）。
export function formatOutput(json, { human = false, sensitive = [] } = {}) {
  if (!human) return JSON.stringify(json) + '\n'
  return humanTable(maskSensitive(json, sensitive))
}

function humanTable(json) {
  const { data } = json
  if (Array.isArray(data) && data.length > 0) {
    const rows = data.map((d) => (d !== null && typeof d === 'object' ? d : { value: d }))
    const keys = []
    for (const r of rows) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k)
    const cell = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))
    const widths = keys.map((k) => Math.max(String(k).length, ...rows.map((r) => cell(r[k]).length)))
    const fmt = (arr) => '| ' + arr.map((c, i) => c.padEnd(widths[i])).join(' | ') + ' |'
    const sep = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+'
    return [sep, fmt(keys), sep, ...rows.map((r) => fmt(keys.map((k) => cell(r[k])))), sep].join('\n')
  }
  // 非数组：key: value 平铺
  return Object.entries(json).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join('\n')
}

// 环境覆盖（测试/自定义网关）：YFLJSJ_GATEWAY 替换网关 baseUrl；YFLJSJ_INSECURE=1 关闭 TLS 校验
function envOverrides(env = process.env) {
  const opts = {}
  if (env.YFLJSJ_GATEWAY) opts.baseUrl = env.YFLJSJ_GATEWAY
  if (env.YFLJSJ_INSECURE === '1') opts.rejectUnauthorized = false
  return opts
}

function helpText() {
  const mods = Object.keys(loadApis().modules)
  return [
    `yfljsj v${VERSION} — yfljsj 业务网关 CLI（命令表驱动，零依赖）`,
    '',
    '用法：yfljsj <command> [options]',
    '',
    '命令：',
    '  auth login --method password|captcha|tenant --user X (--password P|--code C|--tenant T)',
    '  auth logout',
    '  auth status',
    '  auth send-code --user X',
    '  discover [--port 8899]               代理捕获浏览器请求，接口补漏并合并命令表',
    '  config set <key> <value>             写配置项（如 auto-confirm-write true|false）',
    '  config get <key> / config list       读配置项',
    "  raw <path> [--method POST] [--data 'json'] [--service rcms]",
    '  <module> <action> [--param value]...  命令表驱动调用',
    '  schema <module> <action>        查看命令字段定义（类型/必填/枚举/来源）',
    '  relations [对象]                业务对象关联图谱与创建顺序',
    '  explore <path> [--dry-run]      交互探测接口必填字段并沉淀',
    '  doc [手册]                      操作手册（步骤+示例）',
    '  --help / --version',
    '',
    '选项：',
    '  --json                                JSON 输出（默认）',
    '  --human                               表格输出（数组字段自动表头；命令表标 sensitive 字段脱敏）',
    '  --confirm / --yes                     写操作显式确认（kind=write 必需）',
    '  --force                               删除/移除类操作额外强制确认',
    "  --data 'json'                         显式请求体",
    '',
    '安全：写操作需显式确认；请求域名仅白名单（*.yfljsj.com / localhost / 127.0.0.1）；',
    '      请求记录审计日志 ~/.yfljsj/audit.log（不含 token/密码）；config set auto-confirm-write true 可免确认。',
    '',
    '退出码：0=成功 1=业务错误 2=用法错误 3=认证失败 4=网络错误',
    '',
    `可用模块（${mods.length}）：${mods.join(' ')}`,
    '',
  ].join('\n')
}

/** schema：查看命令完整字段定义（类型/必填/描述/枚举/来源） */
export function schemaCommand(module, action, { output = process.stdout } = {}) {
  const apis = loadApis()
  const mod = apis.modules[module]
  if (!mod) { output.write(`未知模块：${module}\n`); return 2 }
  const cmd = (mod.commands || []).find(c => c.action === action)
  if (!cmd) { output.write(`未知命令：${module} ${action}\n可用：${mod.commands.map(c => c.action).join('、')}\n`); return 2 }
  const lines = [`命令: ${cmd.action} (${cmd.method} ${cmd.path}) [${cmd.kind}]`, `字段:`]
  const params = cmd.params || {}
  for (const [k, v] of Object.entries(params)) {
    const d = v && typeof v === 'object' ? v : { type: 'string', desc: '' }
    const parts = [`  ${k.padEnd(18)} ${String(d.type || 'string').padEnd(8)} ${d.required ? '必填' : '可选'}`]
    if (d.auto) parts[0] += ' [自动注入]'
    if (d.desc) parts.push(` ${d.desc}`)
    if (Array.isArray(d.enum)) parts.push(` = ${d.enum.join('|')}`)
    if (d.source) parts.push(` ← ${d.source}`)
    lines.push(parts.join(''))
  }
  if (cmd.relations) lines.push(`关联: ${cmd.relations}`)
  output.write(lines.join('\n') + '\n')
  return 0
}

/** relations：业务对象关联图谱 */
export function relationsCommand(object, { output = process.stdout } = {}) {
  const apis = loadApis()
  const rels = apis.relations || {}
  if (!object) {
    output.write('可用对象: ' + Object.keys(rels).join('、') + '\n')
    output.write('用法: yfljsj relations <对象>\n')
    return 0
  }
  const r = rels[object]
  if (!r) { output.write(`未知对象: ${object}\n可用: ${Object.keys(rels).join('、')}\n`); return 2 }
  output.write(`${object} (${r.title})\n`)
  for (const [k, v] of Object.entries(r.children || {})) {
    output.write(` ├─ ${k} (${v.title})  via ${v.via}\n`)
  }
  if (r.createOrder?.length) output.write(`创建顺序: ${r.createOrder.join(' → ')}\n`)
  return 0
}

/** doc：完整操作手册 */
export function docCommand(object, { output = process.stdout } = {}) {
  const apis = loadApis()
  const ops = apis.operations || {}
  if (!object) {
    output.write('可用手册: ' + Object.keys(ops).join('、') + '\n')
    output.write('用法: yfljsj doc <手册名>\n')
    return 0
  }
  const op = ops[object]
  if (!op) { output.write(`未知手册: ${object}\n可用: ${Object.keys(ops).join('、')}\n`); return 2 }
  output.write(`${object} — ${op.title}\n`)
  output.write('步骤:\n')
  for (const s of op.steps || []) output.write(`  ${s.desc} (${s.cmd})\n`)
  if (op.examples?.length) {
    output.write('示例:\n')
    for (const e of op.examples) output.write(`  ${e}\n`)
  }
  return 0
}

// =====================================================================
// Task 4（字段级增强）：explore 子命令 — 交互式字段探测
//   替代手工下载前端 chunk 逆向：发空请求读报错 → 解析必填字段 → 逐个补字段迭代
// =====================================================================

/** 网关共享校验模板的噪音字段（Source/column 等非业务字段名，误探入 seed 的历史来源）→ 探测时忽略 */
const NOISE_FIELD_RE = /^source$|^column$/i

/** 解析参数校验报错：[xxx:must not be null, yyy:must not be blank] → ['xxx','yyy'] */
export function parseValidationMsg(msg) {
  const fields = []
  if (msg && typeof msg === 'string') {
    const m = msg.match(/\[([^\]]+)\]/)
    if (m) {
      for (const part of m[1].split(',')) {
        // trim：平台报错逗号后带空格（' xxx:...'），逐字实现会漏掉首字段后的字段
        const fm = part.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*):/)
        if (fm && !NOISE_FIELD_RE.test(fm[1])) fields.push(fm[1])
      }
    }
  }
  return [...new Set(fields)]
}

/** 字段类型猜测：按字段名启发式（与 guessValue 取值逻辑一致） */
export function guessType(f) {
  const l = f.toLowerCase()
  if (l.includes('id') && !l.includes('ids')) return 'number'
  if (l.includes('year')) return 'number'
  if (l.includes('date') || l.includes('time')) return 'string'
  if (l.includes('name') || l.includes('code') || l.includes('content')) return 'string'
  if (l === 'current' || l === 'size') return 'number'
  if (l.endsWith('flag') || l.startsWith('is')) return 'boolean'
  return 'string'
}

/** 探测接口必填字段：发空 body → 解析报错 → 逐个补字段迭代（最多 5 轮） */
export async function probeFields(path, { method = 'POST', service = 'rcms', baseUrl, rejectUnauthorized = true } = {}) {
  const base = baseUrl || SERVICES[service] || SERVICES.rcms
  const known = new Set()
  const attempts = []
  for (let round = 0; round < 5; round++) {
    const body = { tenantId: readConfig().tenantId }
    for (const f of known) body[f] = guessValue(f)
    const res = await authenticatedRequest({ url: base + path, method, body, rejectUnauthorized, timeout: 10000 })
    const b = res.body && typeof res.body === 'object' ? res.body : {}
    if (b.success === true) break // 字段全满足（或接口宽容）
    const newFields = parseValidationMsg(String(b.msg || ''))
    const added = newFields.filter(f => !known.has(f))
    if (added.length === 0) break // 无新字段，停止
    for (const f of added) known.add(f)
    attempts.push({ body: { ...body }, fields: newFields })
  }
  return { fields: [...known], attempts }
}

/** 字段值猜测：按字段名启发式 */
function guessValue(f) {
  const l = f.toLowerCase()
  if (l.includes('id') && !l.includes('ids')) return 0
  if (l.includes('year')) return new Date().getFullYear()
  if (l.includes('date') || l.includes('time')) return '2026-01-01 00:00:00'
  if (l.includes('name') || l.includes('code') || l.includes('content')) return '测试'
  if (l === 'current') return 1
  if (l === 'size') return 10
  if (l.endsWith('flag') || l.startsWith('is')) return 0
  return ''
}

/** explore：交互探测接口必填字段并（可选）写入命令表 */
export async function exploreCommand(path, { output = process.stdout, dryRun = false, method = 'POST', service = 'rcms', module, action, baseUrl, rejectUnauthorized = true } = {}) {
  output.write(`探测 ${path} (${method} ${service})\n`)
  const { fields, attempts } = await probeFields(path, { method, service, baseUrl, rejectUnauthorized })
  output.write(`已探明字段: ${fields.join(', ') || '(无必填字段或接口宽容)'}\n`)
  if (dryRun) return 0
  // 写入命令表：匹配现有命令或新增
  const apis = loadApis()
  const modKey = module || path.split('/')[1] || 'other'
  if (!apis.modules[modKey]) apis.modules[modKey] = { title: modKey, service, commands: [] }
  let cmd = apis.modules[modKey].commands.find(c => c.path === path)
  if (!cmd) {
    cmd = { action: path.split('/').slice(-2).join('-'), method, path, kind: /delete|remove|add|modify|update|save|import/.test(path) ? 'write' : 'read', params: {} }
    apis.modules[modKey].commands.push(cmd)
  }
  for (const f of fields) {
    if (!cmd.params[f]) cmd.params[f] = { type: guessType(f), required: true, desc: '' }
  }
  writeApis(apis)
  output.write(`已写入命令表 ${modKey}.${cmd.action}（${fields.length} 个必填字段）\n`)
  return 0
}

// auth login 子命令：--method 名称 → 登录方式编号，校验必填后调 login()
async function authLogin(opts, emit, usage, env) {
  const methodMap = { password: 1, captcha: 2, tenant: 3 }
  const methodName = String(opts['--method'] || 'password').toLowerCase()
  const method = methodMap[methodName]
  if (!method) {
    return usage(`auth login --method 非法：${opts['--method']}（password|captcha|tenant）`)
  }
  const user = opts['--user']
  if (!user) return usage('auth login 缺少参数 --user')
  const required = { 1: '--password', 2: '--code', 3: '--tenant' }[method]
  if (!opts[required]) return usage(`auth login 缺少参数 ${required}`)
  const res = await login({ method, user, password: opts['--password'], code: opts['--code'], tenant: opts['--tenant'], ...env })
  if (res.ok) return emit(0, { success: true, code: 0, msg: 'ok', data: { loggedIn: true, method: methodName } })
  // 合并前审阅修复：用法错 → exit 2；网络错误（连接拒绝/超时/DNS）→ exit 4；其余凭证/业务错 → exit 1
  if (res.code === 'USAGE_ERROR') return usage(res.error || '非交互模式必须显式传 --password')
  if (res.network) return emit(4, { success: false, code: 4, msg: res.error || '网络错误', data: null })
  return emit(1, { success: false, code: 1, msg: res.error || '登录失败', data: null })
}

// 主入口：命令分发。stdout 只写 JSON（process.stdout.write），诊断/错误走 stderr。
export async function main(argv = process.argv.slice(2)) {
  const { command, sub, args, opts, positional } = parseArgs(argv)
  const human = opts['--human'] === true || (opts['--human'] !== undefined && opts['--human'] !== 'false')

  const emit = (exitCode, json, sensitive = []) => {
    process.stdout.write(formatOutput(json, { human, sensitive }))
    return exitCode
  }
  const usage = (msg) => {
    process.stderr.write(`yfljsj：${msg}\n`)
    return emit(2, { success: false, code: 2, msg, data: null })
  }

  if (command === null) {
    process.stderr.write('yfljsj：缺少命令。用法：yfljsj <command> [options]（--help 查看命令树）\n')
    return emit(2, { success: false, code: 2, msg: '缺少命令：yfljsj <command> [options]', data: null })
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(helpText())
    return 0
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  const env = envOverrides()

  if (command === 'auth') {
    if (sub === 'login') return authLogin(opts, emit, usage, env)
    if (sub === 'logout') {
      const res = await logout(env)
      if (res.ok) return emit(0, { success: true, code: 0, msg: 'ok', data: { loggedOut: true } })
      return emit(1, { success: false, code: 1, msg: res.error || '登出失败', data: null })
    }
    if (sub === 'status') {
      const tok = getToken()
      if (!tok) return emit(3, { success: false, code: 3, msg: '未登录：请先执行 auth login', data: null })
      return emit(0, {
        success: true,
        code: 0,
        msg: 'ok',
        data: { ...tok, expired: !!(tok.expiresAt && tok.expiresAt < Date.now()) },
      })
    }
    if (sub === 'send-code') {
      const user = opts['--user']
      if (!user) return usage('auth send-code 缺少参数 --user')
      const res = await sendCode({ user, ...env })
      if (res.ok) return emit(0, { success: true, code: 0, msg: 'ok', data: { sent: true } })
      return emit(1, { success: false, code: 1, msg: res.error || '发送验证码失败', data: null })
    }
    if (sub === '--help') {
      process.stdout.write(helpText())
      return 0
    }
    return usage('auth 需要子命令：login / logout / status / send-code')
  }

  if (command === 'config') {
    // 配置项读写（~/.yfljsj/config.json）：config set auto-confirm-write true|false
    if (sub === 'set') {
      const key = positional[0]
      const value = positional[1]
      if (!key || value === undefined) {
        return usage('config set 用法：yfljsj config set <key> <value>（如 auto-confirm-write true）')
      }
      const stored = setConfigValue(key, value)
      return emit(0, { success: true, code: 0, msg: 'ok', data: { key, value: stored } })
    }
    if (sub === 'get') {
      const key = positional[0]
      if (!key) return usage('config get 用法：yfljsj config get <key>')
      return emit(0, { success: true, code: 0, msg: 'ok', data: { key, value: getConfigValue(key) } })
    }
    if (sub === 'list' || sub === null) {
      return emit(0, { success: true, code: 0, msg: 'ok', data: getConfigValue() })
    }
    return usage('config 需要子命令：set / get / list')
  }

  if (command === 'schema') {
    if (!sub) return usage('schema 需要 <module> <action>')
    return schemaCommand(sub, args[0] || '', { output: process.stdout })
  }

  if (command === 'relations') return relationsCommand(sub, { output: process.stdout })

  if (command === 'doc') return docCommand(sub, { output: process.stdout })

  if (command === 'explore') {
    if (!sub) return usage('explore 需要 <path>')
    try {
      return await exploreCommand(sub, { dryRun: opts['--dry-run'] === true, method: opts['--method'] || 'POST', service: opts['--service'] || 'rcms', module: opts['--module'] })
    } catch (e) {
      return errorResult(e).exitCode
    }
  }

  if (command === 'discover') {
    // Task 5：本地 HTTP 代理捕获浏览器对网关的真实请求 → 合并进命令表补漏
    const portRaw = opts['--port'] === undefined ? '' : String(opts['--port'])
    const port = portRaw === '' ? 8899 : Number(portRaw)
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      return usage(`discover --port 非法：${portRaw}（0-65535）`)
    }
    try {
      await runDiscover({ port, output: process.stderr, baseUrl: env.baseUrl, rejectUnauthorized: env.rejectUnauthorized })
      return 0
    } catch (e) {
      return errorResult(e).exitCode
    }
  }

  if (command === 'raw') {
    if (!sub) return usage("raw 需要 path 参数。用法：yfljsj raw <path> [--method POST] [--data 'json'] [--service rcms]")
    const method = String(opts['--method'] || 'POST').toUpperCase()
    const service = String(opts['--service'] || 'rcms')
    const data = opts['--data'] === undefined ? undefined : opts['--data']
    const r = await rawRequest({ path: sub, method, data, service, ...env })
    return emit(r.exitCode, r.json)
  }

  // <module> <action> [--param value]...  命令表驱动调用
  if (sub) {
    // 安全确认开关（--confirm/--yes/--force）从 CLI opts 透传 runCommand，不进入命令参数
    const secFlags = {}
    for (const k of ['--confirm', '--yes', '--force']) if (opts[k] !== undefined) secFlags[k] = opts[k]
    const r = await runCommand(command, sub, toCommandArgs(args), { ...env, ...secFlags })
    if (r.exitCode === 2) process.stderr.write(`yfljsj：${r.json.msg}\n`)
    return emit(r.exitCode, r.json, r.sensitive)
  }

  process.stderr.write(`yfljsj：未知命令 ${command}。可用：auth / discover / raw / schema / relations / explore / doc / <module> <action> / --help / --version\n`)
  return emit(2, { success: false, code: 2, msg: `未知命令：${command}`, data: null })
}

// =====================================================================
// Task 5：discover 代理 — 捕获浏览器真实请求，补漏静态命令表
// =====================================================================
// 代理方案（实施选择并文档化）：
//   不实现 HTTPS CONNECT 隧道（浏览器系统代理的 https 走 CONNECT，需 TLS 中间人）。
//   改为「baseURL 替换」非标准代理：提示用户把前端网关 baseURL 指向
//   http://127.0.0.1:<port>（替换 https://gateway.yfljsj.com），本地收 http 请求 →
//   原样转发真实网关（https 出站）→ 记录 method/path/body 样例。
//   同时兼容标准 HTTP 代理的绝对 URL 请求形式（req.url 为完整 URL 时直接透传）。
//   浏览器对 https 的 CONNECT 会收到 501 + 引导文案。
const GATEWAY_ORIGIN = 'https://gateway.yfljsj.com'

// 读取请求体（上限 10MB 防滥用）
function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        req.destroy()
        reject(new Error('request body too large'))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// 捕获记录：{ method, path, body样例, contentType }
//   path 取 pathname（去掉 query）；body 样例为解析后的 JSON 对象，超大/非 JSON 截断
function makeCaptureRecord(method, pathname, rawBody, contentType) {
  let body样例 = null
  if (rawBody && rawBody.length) {
    const looksJson = /json/i.test(contentType || '') || /^\s*[\[{]/.test(rawBody)
    if (looksJson) {
      try {
        body样例 = JSON.parse(rawBody)
      } catch {
        body样例 = rawBody.slice(0, 2048)
      }
    } else {
      body样例 = rawBody.slice(0, 2048)
    }
  }
  return { method, path: pathname, body样例, contentType: contentType || null }
}

// 透传时过滤逐跳（hop-by-hop）头，避免 host/content-length 等干扰
const HOP_HEADERS = ['host', 'connection', 'content-length', 'transfer-encoding', 'proxy-connection', 'keep-alive', 'upgrade', 'te', 'trailer']
function forwardHeaders(headers) {
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase()
    if (HOP_HEADERS.includes(lk) || lk.startsWith('proxy-')) continue
    out[k] = v
  }
  return out
}

// 本地 HTTP 代理：接收浏览器请求 → 透传真实网关 → 返回响应；逐请求捕获记录。
//   onCapture(record) 每捕获一条调用；返回 { server, port, captured, close }
export function startProxy({ port = 0, onCapture, baseUrl = GATEWAY_ORIGIN, rejectUnauthorized = true } = {}) {
  const captured = []
  const server = http.createServer((req, res) => {
    readBody(req)
      .then((rawBody) => {
        let pathname
        let target
        try {
          if (/^https?:\/\//.test(req.url)) {
            // 标准 HTTP 代理的绝对 URL 形式 → 原样透传目标
            pathname = new URL(req.url).pathname
            target = req.url
          } else {
            // baseURL 替换形式（origin-form）→ 解析到 baseUrl 真实网关
            pathname = new URL(req.url, 'http://localhost').pathname
            target = new URL(req.url, baseUrl).href
          }
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, code: 400, msg: `discover 代理无法解析请求 URL：${e.message}`, data: null }))
          return
        }
        const record = makeCaptureRecord(req.method, pathname, rawBody, req.headers['content-type'])
        captured.push(record)
        if (typeof onCapture === 'function') {
          try {
            onCapture(record)
          } catch {
            /* 回调异常不影响代理 */
          }
        }
        const payload = rawBody && rawBody.length ? rawBody : undefined
        httpRequest(target, { method: req.method, body: payload, headers: forwardHeaders(req.headers), rejectUnauthorized })
          .then((up) => {
            const outHeaders = {}
            if (up.headers['content-type']) outHeaders['Content-Type'] = up.headers['content-type']
            res.writeHead(up.status, outHeaders)
            res.end(up.raw)
          })
          .catch((e) => {
            res.writeHead(502, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, code: 502, msg: `discover 代理转发失败：${e.message}`, data: null }))
          })
      })
      .catch((e) => {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, code: 400, msg: `discover 代理读取请求失败：${e.message}`, data: null }))
      })
  })
  // 浏览器系统代理对 https 走 CONNECT 隧道（需 TLS 中间人）→ 明确 501 + 引导文案，不捕获不转发。
  // Node http server 对 CONNECT 走 'connect' 事件而非 'request'。
  server.on('connect', (req, socket) => {
    const msg = `CONNECT 隧道（HTTPS 系统代理）未支持：请把前端网关 baseURL 直接指向 http://127.0.0.1:${server.address().port}（替换 https://gateway.yfljsj.com），而非使用系统代理`
    socket.end(`HTTP/1.1 501 Not Implemented\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n${msg}`)
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        captured,
        close: () =>
          new Promise((r) => {
            if (typeof server.closeAllConnections === 'function') {
              try {
                server.closeAllConnections()
              } catch {
                /* ignore */
              }
            }
            server.close(() => r())
          }),
      })
    })
  })
}

// 捕获路径归一化：去掉 /api/<service> 或 /api 前缀（前端 baseURL 含服务前缀），
// 得到命令表使用的相对 path（运行时由 services[service] 前缀拼接）。
export function normalizeCapturedPath(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) return p
  let s = p
  const m = s.match(/^\/api\/(?:rcms|upms|oauth)\//)
  if (m) {
    s = s.slice(m[0].length - 1) // 去掉 /api/<svc>，保留尾部 /path
  } else if (s.startsWith('/api/')) {
    s = s.slice('/api/'.length - 1)
  }
  return s.startsWith('/') ? s : `/${s}`
}

// 由 body 样例反推参数 schema（分页接口优先保留 page/list 参数）
function paramsFromSample(path, sample) {
  const params = inferParams(path)
  if (sample && typeof sample === 'object' && !Array.isArray(sample)) {
    for (const [k, v] of Object.entries(sample)) {
      if (k in params) continue
      const t = v === null || Array.isArray(v) ? 'object' : typeof v
      params[k] = t === 'object' ? 'object' : t
    }
  }
  return params
}

// 把捕获的接口并入现有命令表：按 path 去重（不重复），返回新命令表（不改入参）。
//   captured: [{ method, path, body样例, contentType }]
// Task 7 修复：保留 existing 的 operations/relations（业务元数据），与 version/services/modules 一并带出，
//   避免 discover 合并写回后 relations/doc 子命令丢失人工沉淀的图谱/手册。
export function mergeApis(existing, captured) {
  const out = {
    version: (existing && existing.version) || 1,
    services: (existing && existing.services) || { ...SERVICES },
    operations: (existing && existing.operations) || {},
    relations: (existing && existing.relations) || {},
    modules: {},
  }
  for (const [modKey, mod] of Object.entries((existing && existing.modules) || {})) {
    out.modules[modKey] = { title: (mod && mod.title) || modKey, service: mod && mod.service, commands: [...((mod && mod.commands) || [])] }
  }
  for (const rec of Array.isArray(captured) ? captured : []) {
    const rawPath = rec && typeof rec.path === 'string' ? rec.path : null
    if (!rawPath) continue
    const path = normalizeCapturedPath(rawPath)
    if (!path || path === '/') continue
    const parts = path.split('/').filter(Boolean)
    const modKey = parts[0] || 'other'
    if (!out.modules[modKey]) out.modules[modKey] = { title: modKey, service: inferService(path), commands: [] }
    if (out.modules[modKey].commands.some((c) => c.path === path)) continue // 按 path 去重
    const method = typeof rec.method === 'string' ? rec.method.toUpperCase() : 'POST'
    out.modules[modKey].commands.push({
      action: inferAction(path),
      method,
      path,
      params: paramsFromSample(path, rec.body样例),
      desc: path,
      kind: inferKind(path),
    })
  }
  return out
}

// 统计：captured=捕获接口数（按 path 去重）、modules=涉及的模块数、added=新增命令数
export function summarizeDiscover(existing, merged, captured) {
  const existingPaths = new Set()
  for (const mod of Object.values((existing && existing.modules) || {})) {
    for (const c of (mod && mod.commands) || []) existingPaths.add(c.path)
  }
  const uniquePaths = new Set()
  const modules = new Set()
  for (const rec of Array.isArray(captured) ? captured : []) {
    if (!rec || typeof rec.path !== 'string' || !rec.path) continue
    uniquePaths.add(rec.path)
    const np = normalizeCapturedPath(rec.path)
    const seg = np.split('/').filter(Boolean)[0]
    if (seg) modules.add(seg)
  }
  let added = 0
  for (const mod of Object.values((merged && merged.modules) || {})) {
    for (const c of (mod && mod.commands) || []) {
      if (!existingPaths.has(c.path)) added++
    }
  }
  return { captured: uniquePaths.size, modules: modules.size, added }
}

// discover 生命周期：启动代理 → 打印指向提示 → 等待结束（Ctrl+C / 注入信号 / whenReady）
//   → 合并写回 apis.json + 打印统计。结束钩子优先级：signal > whenReady > 默认 SIGINT。
export async function runDiscover({ port = 8899, baseUrl, output = process.stderr, rejectUnauthorized = true, whenReady, signal } = {}) {
  const proxy = await startProxy({ port, baseUrl, rejectUnauthorized })
  if (output && typeof output.write === 'function') {
    output.write(`浏览器代理指向 http://127.0.0.1:${proxy.port}，操作前端各模块，Ctrl+C 结束\n`)
  }
  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = async () => {
      if (settled) return
      settled = true
      try {
        await proxy.close()
        const existing = loadApis({ force: true }) // 以最新命令表为底合并
        const merged = mergeApis(existing, proxy.captured)
        const stats = summarizeDiscover(existing, merged, proxy.captured)
        writeApis(merged)
        apisCache = null // 写回后下次 loadApis 读到用户产物
        if (output && typeof output.write === 'function') {
          output.write(`捕获 ${stats.captured} 接口、${stats.modules} 模块、新增 ${stats.added}\n`)
        }
        resolve({ proxy, captured: proxy.captured, merged, stats })
      } catch (e) {
        reject(e)
      }
    }
    if (signal && typeof signal.then === 'function') {
      signal.then(finish, finish)
    } else if (typeof whenReady === 'function') {
      whenReady({ proxy, finish })
    } else {
      process.once('SIGINT', finish)
      proxy.server.once('close', () => process.removeListener('SIGINT', finish))
    }
  })
}

// 直接执行（import 时跳过，测试可复用 parseArgs/main/formatOutput）。main 为 async，
// Promise 落地 exitCode；未捕获异常以 1 退出。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((err) => {
      process.stderr.write(`yfljsj: 未捕获错误：${(err && err.stack) || err}\n`)
      process.exitCode = 1
    })
}
