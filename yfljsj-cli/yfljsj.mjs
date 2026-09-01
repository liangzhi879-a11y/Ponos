// yfljsj CLI — 单文件（零依赖，仅 Node 内置模块）
// Task 2：认证模块（3 种登录 + token 本地存储 + refresh 自动续期 + 401 重试 + 并发单飞）
// Task 3：通用命令执行器 runCommand + 兜底原始调用 rawRequest + 退出码映射
// 骨架阶段：CLI 路由由 Task 4 填充。
import https from 'node:https'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

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
    const v = Number(src.expiresAt)
    out.expiresAt = v > 1e12 ? v : Date.now() + v * 1000 // 时间戳(ms) 或 相对秒
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

// =====================================================================
// 登录（3 种方式）
//   method 1 = 密码（username/password）
//   method 2 = 验证码（user/code）
//   method 3 = 租户（user/tenantId）
// =====================================================================
export async function login({ method, user, password, code, tenant, baseUrl, rejectUnauthorized = true, input, output } = {}) {
  const m = Number(method)
  let body
  if (m === 1) {
    const pw = password != null && password !== '' ? password : await promptPassword({ input, output })
    body = { loginMethod: 1, username: user, password: pw }
  } else if (m === 2) {
    body = { loginMethod: 2, user, code }
  } else if (m === 3) {
    body = { loginMethod: 3, user, tenantId: tenant }
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
    return { ok: false, error: e.message }
  }
}

// 密码交互输入（隐藏回显，零依赖：拦截 output.write 吞掉回显）
export function promptPassword({ input = process.stdin, output = process.stdout, prompt = 'Password: ' } = {}) {
  return new Promise((resolve, reject) => {
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

// 加载命令表（Task 1 gen-apis 产物，模块级缓存）
export function loadApis() {
  if (!apisCache) apisCache = JSON.parse(fs.readFileSync(APIS_SEED_URL, 'utf8'))
  return apisCache
}

// 解析 args → { params, flags, data }。args 支持：
//   - 对象：{ key: value }；key='--data'/'data' 为显式 body，'--xxx' 为 flag，其余进 params
//   - CLI token 数组：['key=value', '--data', '{json}', '--flag'/'--flag=value']
// 除 --flag 外的键值进 params（GET→query；POST/PUT→body）；--data 显式 JSON 覆盖 body
export function parseArgs(args = {}) {
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

  const { params, data } = parseArgs(args)
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
  try {
    // 命令请求走 base（服务前缀）；refresh 续期固定走 oauth（refreshBaseUrl），不随命令服务前缀
    const res = await authenticatedRequest({ url, method, body, refreshBaseUrl: oauthRefreshBase(base, refreshBaseUrl), rejectUnauthorized, headers, timeout })
    return formatResult(res)
  } catch (e) {
    return errorResult(e)
  }
}

// 兜底原始调用：不查命令表，按 {path, method, data, service} 直接发认证请求
export async function rawRequest({ path, method = 'POST', data, service = 'rcms', baseUrl, refreshBaseUrl, rejectUnauthorized = true, timeout, headers = {} } = {}) {
  const base = baseUrl || SERVICES[service] || SERVICES.rcms
  const p = path.startsWith('/') ? path : `/${path}`
  try {
    const res = await authenticatedRequest({ url: `${base}${p}`, method, body: data, refreshBaseUrl: oauthRefreshBase(base, refreshBaseUrl), rejectUnauthorized, headers, timeout })
    return formatResult(res)
  } catch (e) {
    return errorResult(e)
  }
}

// 模块导出（各函数已单独 export；CLI 路由由 Task 4 补充）
