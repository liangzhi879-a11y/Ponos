// 应用智控：**http 执行后端**（M3）——主进程直调接口，不经过浏览器。
//
// ★ 为什么需要（用户点名）：站点/应用的数据大多来自它自己的 JSON 接口（含 JS chunk 里反解出的路径）。
//   走浏览器自动化去"打开页面 + 取快照"拿到的是一坨文本，取不了数也存不了库；而接口直调返回结构化数据、
//   快 10 倍、也不受页面改版影响。
//
// ★ 与 browser + js 的分工（取舍写进提示词与契约说明）：
//   http **不带登录态**（脱离浏览器就没有 cookie），只用于公开/同源接口；
//   需要登录态的接口继续用 browser + js（自带会话）。
//
// ★ 安全硬约束（SSRF 防护，**不可放宽**，逐条有测试）：
//   ① 禁止任意 URL：默认只允许与 target 同源（含 www/apex 变体），或用户在 Spec 的
//      `http.allowHosts` 里显式加白的 host；
//   ② 本机/内网/保留地址一律拒（localhost、127.0.0.1、::1、10/8、172.16/12、192.168/16、169.254/16、
//      0/8、224+、*.local、*.internal），**白名单也不能放行**；
//   ③ 只允许 http/https；URL 不得带账号密码；
//   ④ 重定向不交给 fetch 自动跟随（redirect:'manual'），**每一跳都重新过 ①②③**——否则外部站点
//      一个 302 就能把请求引到内网；
//   ⑤ 超时（默认 20s）与响应体上限（256KB，超出截断并如实标注）；
//   ⑥ 敏感头双向过滤：请求头丢掉 cookie/authorization，响应头只回传白名单里的几个——
//      cookie/token 明文既不出站、也不进模型上下文。
//      例外：用户在 Spec 里**显式写的自定义头**（如 x-api-key）允许发送——design §10 认可"带密钥接口"，
//      而生成提示词本身已硬约束"绝不写入口令、令牌、密钥"；cookie/authorization 则一律丢弃（那是浏览器会话凭据）。
'use strict'
const { interpolate, checkRequired } = require('./app-util.cjs')

const HTTP_TIMEOUT_MS = 20000
const HTTP_MAX_BYTES = 256 * 1024
const HTTP_MAX_REDIRECTS = 3
/** 允许回传给调用方的响应头白名单（其余一律不回传，避免 cookie/token 明文进上下文） */
const SAFE_RESPONSE_HEADERS = ['content-type', 'content-length', 'date', 'server', 'location', 'cache-control']
/** 请求头黑名单：**浏览器会话凭据**写了也不发（http 后端刻意不带登录态） */
const FORBIDDEN_REQUEST_HEADERS = ['cookie', 'authorization', 'proxy-authorization']
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

/**
 * 本机 / 私网 / 保留地址判定。
 * 只按字面量与常见私网段判（不做 DNS 解析）：判不了的一律**不是**"安全"，而是交给 ① 的同源/白名单规则——
 * 域名必须由用户授权过才允许访问，因此"解析到内网"这条路已经被授权环节挡住了。
 */
function isBlockedHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const [a, b] = h.split('.').map(Number)
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a >= 224) return true            // 组播 / 保留
    return false
  }
  // IPv6 字面量（::1 / fc00::/7 / fe80::/10 等）一律拒：本功能没有正当的 IPv6 直连需求
  if (h.includes(':')) return true
  return false
}

/** 同站点的两种常见写法：apex 与 www（与 app-ipc.hostVariants 同口径） */
function hostVariants(host) {
  const h = String(host || '').toLowerCase()
  if (!h) return []
  return h.startsWith('www.') ? [h, h.slice(4)] : [h, `www.${h}`]
}

/**
 * 允许访问的主机集合 = target 同源（含变体） ∪ spec.http.allowHosts。
 * ★ 与 app-ipc.cjs 的 hostVariants 是同一口径的两份实现（**不能 require app-ipc：会形成循环依赖**），
 *   app-runner-route.test.mjs 里有一条"两份实现同结果"的对照断言防止漂移。
 */
function allowedHostsFor(spec) {
  const out = new Set()
  const add = (raw) => { for (const h of hostVariants(raw)) out.add(h) }
  try { const h = new URL(String(spec?.target?.url || '')).hostname; if (h) add(h) } catch { /* 没有 url（desktop 目标）⇒ 只认白名单 */ }
  const allow = spec?.http?.allowHosts
  if (Array.isArray(allow)) for (const h of allow) { if (h) out.add(String(h).toLowerCase()) }
  return out
}

/** URL 守卫：协议 / 账号密码 / 本机内网 / 授权集合。违规**抛错**（调用方转成结构化失败） */
function assertAllowedUrl(rawUrl, spec) {
  let u
  try { u = new URL(String(rawUrl || '')) } catch { throw new Error(`url 不合法：${String(rawUrl)}（要写完整地址，如 https://api.example.com/items）`) }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`只允许 http/https：${u.protocol}`)
  if (u.username || u.password) throw new Error('url 不得带账号密码（凭据请交给 browser + 登录态，不要写进 Spec）')
  const host = u.hostname.toLowerCase()
  if (isBlockedHost(host)) throw new Error(`拒绝访问本机/内网地址：${host}（SSRF 防护；需要本机服务请改用 browser 或其他方式）`)
  const allowed = allowedHostsFor(spec)
  if (!allowed.has(host)) {
    throw new Error(`主机不在允许范围：${host}（默认只允许 target 站点同源；如需该公开接口，请在 Spec 里加 http.allowHosts: ["${host}"]）`)
  }
  return u
}

function filterRequestHeaders(headers) {
  const out = {}
  for (const [rawName, rawVal] of Object.entries(headers && typeof headers === 'object' ? headers : {})) {
    const name = String(rawName).toLowerCase()
    if (FORBIDDEN_REQUEST_HEADERS.includes(name)) continue
    if (rawVal == null) continue
    out[name] = String(rawVal)
  }
  return out
}

function filterResponseHeaders(headers) {
  const out = {}
  for (const name of SAFE_RESPONSE_HEADERS) {
    const v = typeof headers?.get === 'function' ? headers.get(name) : headers?.[name]
    if (v != null && v !== '') out[name] = String(v)
  }
  return out
}

/** 读正文并截断（先 arrayBuffer 再切片；环境没有 arrayBuffer 时退回 text） */
async function readCappedBody(res, maxBytes = HTTP_MAX_BYTES) {
  if (typeof res?.arrayBuffer === 'function') {
    const buf = Buffer.from(await res.arrayBuffer())
    const slice = buf.subarray(0, Math.min(buf.length, maxBytes))
    return { text: slice.toString('utf8'), bytes: buf.length, truncated: buf.length > maxBytes }
  }
  if (typeof res?.text === 'function') {
    const t = String(await res.text())
    const bytes = Buffer.byteLength(t, 'utf8')
    return { text: t.slice(0, maxBytes), bytes, truncated: bytes > maxBytes }
  }
  return { text: '', bytes: 0, truncated: false }
}

/** 拼 query（值用 ${参数名} 插值后的结果） */
function withQuery(url, query, args) {
  const u = new URL(url)
  for (const [k, v] of Object.entries(query && typeof query === 'object' ? query : {})) {
    if (v == null) continue
    u.searchParams.set(k, interpolate(String(v), args))
  }
  return u.toString()
}

/**
 * 取 fetch 实现：**显式注入优先**。
 * `deps.fetchImpl = null`（或 `deps.fetch = null`）表示"调用方明确要求没有 fetch 环境"，
 * 此时**不回落**到全局 fetch——否则测试里的"无 fetch 环境"用例会真去发外网请求。
 */
function resolveFetch(deps) {
  if (deps && 'fetchImpl' in deps) return deps.fetchImpl
  if (deps && 'fetch' in deps) return deps.fetch
  return globalThis.fetch
}

/** 单次请求（不跟随重定向；由调用方逐跳校验） */
async function requestOnce({ url, method, headers, body, timeoutMs, fetchImpl }) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetchImpl(url, {
      method, headers, body, redirect: 'manual', signal: ctrl.signal,
    })
  } catch (e) {
    // 超时必须说清是"超时"，而不是把 AbortError 原样抛给用户
    if (e?.name === 'AbortError' || /abort/i.test(String(e?.message || ''))) {
      throw new Error(`请求超时（${timeoutMs}ms）：${url}`)
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** 执行一个 request 步骤：逐跳校验重定向 → 返回 { status, headers, body, truncated, url } */
async function requestStep({ step, args, spec, fetchImpl }) {
  const timeoutMs = Number.isFinite(step.timeout) && step.timeout > 0 ? step.timeout : HTTP_TIMEOUT_MS
  const method = String(step.method || 'GET').toUpperCase()
  const headers = filterRequestHeaders(step.headers)
  let bodyText
  if (step.body != null && method !== 'GET' && method !== 'HEAD') {
    bodyText = JSON.stringify(step.body)
    if (!headers['content-type']) headers['content-type'] = 'application/json'
  }
  let current = withQuery(interpolate(step.url, args), step.query, args)
  for (let hop = 0; hop <= HTTP_MAX_REDIRECTS; hop++) {
    const u = assertAllowedUrl(current, spec)          // ★ 每一跳都重新校验（防重定向绕过）
    const res = await requestOnce({ url: u.toString(), method, headers, body: bodyText, timeoutMs, fetchImpl })
    const status = Number(res?.status || 0)
    const safeHeaders = filterResponseHeaders(res?.headers)
    if (REDIRECT_STATUS.has(status) && safeHeaders.location) {
      if (hop === HTTP_MAX_REDIRECTS) throw new Error(`重定向次数超过上限（${HTTP_MAX_REDIRECTS}）：${current}`)
      current = new URL(safeHeaders.location, u).toString()
      continue
    }
    const { text, bytes, truncated } = await readCappedBody(res)
    if (status >= 400) throw new Error(`HTTP ${status}：${text.slice(0, 200)}`)
    let parsed = text
    if (String(safeHeaders['content-type'] || '').includes('json')) {
      try { parsed = JSON.parse(text) } catch { parsed = text }   // 声明 JSON 但解析失败 ⇒ 原样给文本（模型自己看得出）
    }
    return { status, headers: safeHeaders, body: parsed, truncated, bytes, url: u.toString() }
  }
  throw new Error(`重定向次数超过上限（${HTTP_MAX_REDIRECTS}）：${current}`)
}

/**
 * 执行一条 http 驱动命令。
 * @returns {Promise<{ok:boolean, data:any, error:string|null, kind:string, durationMs:number}>}
 *   data = { status, headers, body, truncated? }（步骤写了 save 时；否则只给 status/headers）
 */
async function httpRunner({ appId, action, args = {}, spec, deps = {} } = {}) {
  const startedAt = Date.now()
  const cmd = spec?.commands?.find((c) => c.action === action)
  const kind = cmd?.kind ?? 'unknown'
  const fail = (error) => ({ ok: false, data: null, error, kind, durationMs: Date.now() - startedAt })
  if (!cmd) return fail(`未找到命令：${action}`)
  const fetchImpl = resolveFetch(deps)
  if (typeof fetchImpl !== 'function') return fail('当前运行环境没有 fetch（无法执行 http 命令）')
  const req = checkRequired(cmd.params, args)
  if (!req.ok) return fail(req.errors.join('；'))
  try {
    let saved = null
    for (const step of cmd.steps || []) {
      if (step?.act !== 'request') throw new Error(`driver=http 不支持步骤 ${String(step?.act)}（只允许 request）`)
      const r = await requestStep({ step, args, spec, fetchImpl })
      saved = step.save
        ? { status: r.status, headers: r.headers, body: r.body, ...(r.truncated ? { truncated: true } : {}) }
        : { status: r.status, headers: r.headers }
    }
    return { ok: true, data: saved, error: null, kind, durationMs: Date.now() - startedAt }
  } catch (e) {
    return fail(String(e?.message || e))
  }
}

module.exports = {
  httpRunner, isBlockedHost, hostVariants, allowedHostsFor, assertAllowedUrl,
  filterRequestHeaders, filterResponseHeaders, readCappedBody, withQuery, requestStep,
  HTTP_TIMEOUT_MS, HTTP_MAX_BYTES, HTTP_MAX_REDIRECTS, SAFE_RESPONSE_HEADERS, FORBIDDEN_REQUEST_HEADERS,
}
