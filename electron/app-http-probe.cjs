// 应用智控：**后台页面素材获取**（不依赖内置浏览器，不受浏览器白名单约束）
//
// 为什么需要它（真实反馈）：
//   原先「生成命令」必须先开内置浏览器探测页面（app-profiler.probeWeb → BrowserExecutor）。
//   但 BrowserExecutor 的导航受**自动化白名单**保护（默认 *.gov.cn / localhost / 127.0.0.1，
//   electron/browser-common.cjs 的 isWhitelisted），于是给 kimi.com 这类站点生成命令时
//   直接死在探测：`目标域名不在白名单…已拒绝导航`。
//
//   ★ 这两件事的安全边界本就不同：
//     · 白名单保护的是「agent 自动操作浏览器」——自动化会点按钮、填表单、发请求，必须收紧；
//     · 而「生成命令」只是把**用户自己填的网址**取回一份页面素材给模型看，用户已明确授权该目标。
//   所以本模块在主进程用普通 HTTP 取页面（等价于用户在浏览器里打开一次），**不需要窗口、不需要白名单**，
//   用户全程无感；浏览器探测退化为"白名单内站点的增强手段"（可拿到 JS 渲染后的真实 DOM）。
//
// 设计约束：
//   · 纯函数 extractPageMaterial 可单测（无网络）；
//   · fetchPageMaterial **绝不抛错**，失败一律返回结构化 { ok:false, error }，由调用方决定降级；
//   · 有超时、有体积上限、只认 http/https（避免 file:// 之类被塞进来）。
'use strict'

const { normalizeUrl } = require('./app-util.cjs')

const DEFAULT_TIMEOUT_MS = 15000
const MAX_HTML_BYTES = 1_500_000
/** 手动跟随重定向的最大跳数：登录态不能跟着跳转无限跑，更不能跑到第三方域名 */
const MAX_REDIRECTS = 5
const MAX_TEXT_CHARS = 3000
const MAX_LINKS = 40
const MAX_FORMS = 8
/** 素材"够不够rich"的判定线：至少要有这么多可交互线索，模型才不至于全靠猜 */
const RICH_MIN_INTERACTIVES = 3

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/** 去标签取纯文本（script/style/noscript 先整段剔除，避免把 JS 源码当正文喂给模型） */
function stripTags(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

// ★ 属性名必须带**左边界** `(?<![-\w])`：否则 `attr('<input data-type="password">', 'type')` 会命中
//   `data-type=` 里的 `type`，把自定义属性当成真属性（真实故障：登录墙检测据此误判"有密码框" →
//   自动弹出登录窗口，而用户明确要求"能不弹就不弹"）。同类污染还有 data-id/data-name/data-placeholder/data-value。
const attr = (tag, name) => {
  const m = String(tag).match(new RegExp(`(?<![-\\w])${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  return m ? (m[2] ?? m[3] ?? m[4] ?? '').trim() : ''
}

// ★ 密码框判定必须**严格**：`type` 前要求空白（排除 `data-type=` 这类属性名后缀相同的情况），
//   值后要求边界（排除 `type="passwordx"`）。宽松写法 `/<input[^>]+type\s*=\s*["']?password/i`
//   这两类都会误判成密码框 → 登录墙误报为 high → 自动弹登录窗口。
const PASSWORD_INPUT_RE = /<input\b[^>]*\stype\s*=\s*["']?password(?=["'\s/>])/i
const textOf = (tag) => stripTags(String(tag).replace(/^<[^>]*>/, '')).slice(0, 60)

/**
 * 从 HTML 里抽出"写命令要用到"的素材（纯函数）。
 * @returns {{title:string, description:string, headings:string[], forms:Array, buttons:string[], links:Array, text:string, interactives:number, hasPassword:boolean}}
 */
function extractPageMaterial(html, url) {
  const src = String(html || '')
  const title = (src.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim().slice(0, 200)
  const description = (attr(src.match(/<meta[^>]*name\s*=\s*["']?description["']?[^>]*>/i)?.[0] || '', 'content')
    || attr(src.match(/<meta[^>]*property\s*=\s*["']?og:description["']?[^>]*>/i)?.[0] || '', 'content')).slice(0, 300)
  const headings = [...src.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) => stripTags(m[1]).slice(0, 80)).filter(Boolean).slice(0, 20)

  // 表单与字段：写 click/type 命令的 selector 主要靠这里（name/id/placeholder 是稳定锚点）
  const forms = [...src.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)].slice(0, MAX_FORMS).map((m) => {
    const formTag = m[0].slice(0, m[0].indexOf('>') + 1)
    const body = m[1] || ''
    const fields = [...body.matchAll(/<(input|select|textarea)\b[^>]*>/gi)].map((f) => {
      const t = f[0]
      const type = (attr(t, 'type') || (f[1].toLowerCase() === 'input' ? 'text' : f[1].toLowerCase())).toLowerCase()
      if (type === 'hidden') return null
      return { tag: f[1].toLowerCase(), type, name: attr(t, 'name'), id: attr(t, 'id'), placeholder: attr(t, 'placeholder'), value: attr(t, 'value'), required: /\brequired\b/i.test(t) }
    }).filter(Boolean).slice(0, 30)
    const selectors = [...body.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)].map((b) => ({ text: stripTags(b[1]).slice(0, 40), id: attr(b[0], 'id'), type: attr(b[0], 'type') }))
    return { action: attr(formTag, 'action'), method: (attr(formTag, 'method') || 'get').toLowerCase(), id: attr(formTag, 'id'), name: attr(formTag, 'name'), fields, buttons: selectors }
  })

  const buttons = [...src.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)]
    .map((b) => ({ text: stripTags(b[1]).slice(0, 40), id: attr(b[0], 'id'), type: attr(b[0], 'type'), selector: attr(b[0], 'id') ? `#${attr(b[0], 'id')}` : '' }))
    .filter((b) => b.text || b.id).slice(0, 40)

  const links = [...src.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map((a) => {
    const href = attr(a[0], 'href')
    return { text: stripTags(a[1]).slice(0, 40), href, id: attr(a[0], 'id') }
  }).filter((l) => l.text && l.href && !/^javascript:/i.test(l.href)).slice(0, MAX_LINKS)

  const text = stripTags(src).slice(0, MAX_TEXT_CHARS)
  const interactives = forms.reduce((n, f) => n + f.fields.length + f.buttons.length, 0) + buttons.length + links.length
  // 登录墙硬信号：密码框（可能在 <form> 外，form 解析覆盖不到，故直接扫原文）
  // 严格正则：`data-type="password"` / `type="passwordx"` 都不算（见 PASSWORD_INPUT_RE 注释）
  const hasPassword = PASSWORD_INPUT_RE.test(src)
  return { url: url || '', title, description, headings, forms, buttons, links, text, interactives, hasPassword }
}

/** 素材是否"够 rich"（不够就得靠知识兜底 + 提示用户核对） */
function isMaterialRich(material) {
  if (!material) return false
  const fields = (material.forms || []).reduce((n, f) => n + (f.fields || []).length, 0)
  return (fields + (material.buttons || []).length) >= RICH_MIN_INTERACTIVES
}

/** 裸 HTML 里出现这些特征 → 页面靠 JS 渲染，静态抓取拿不到有效素材（SPA 壳） */
function looksLikeSpaShell(html) {
  const s = String(html || '')
  if (s.length > 20000) return false
  return /<div[^>]+id\s*=\s*["'](root|app)["']/i.test(s) || /__NEXT_DATA__|window\.__NUXT__|data-reactroot/i.test(s)
}

/** 单跳请求：按 url 重新索取 Cookie（**跨站绝不带**） */
async function fetchOneHop(f, url, { headers, cookieProvider, timeoutMs, ac }) {
  const h = { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8', ...(headers || {}) }
  if (typeof cookieProvider === 'function') {
    // 每跳都重新问一次：登录态可能在流程中变化（用户刚扫码/刚过期）
    const cookie = await cookieProvider(url)
    if (cookie) h.cookie = cookie
  }
  return f(url, { redirect: 'manual', headers: h, signal: ac.signal })
}

/** 缺省授权判定：仅初始 host（显式传 isAllowedHost 时以调用方为准） */
function defaultAllowedHost(initialUrl) {
  const host = (() => { try { return new URL(initialUrl).hostname.toLowerCase() } catch { return null } })()
  return (u) => { try { return new URL(u).hostname.toLowerCase() === host } catch { return false } }
}

/**
 * 后台取页面素材（主进程普通 HTTP，无窗口、无白名单，用户无感）。
 *
 * 登录态：可传 cookieProvider(url) 注入用户自己的 Cookie（登录后的页面才看得到真实控件）。
 * 因为带 Cookie 的请求相当于"以用户身份访问"，**重定向必须逐跳判断**：重定向出去的目标
 * 一旦不在授权 host 内，立即停止跟随且不向该域名发请求——绝不把登录态漏给第三方域名。
 *
 * @param {{url:string, fetchImpl?:Function, timeoutMs?:number, headers?:object,
 *          cookieProvider?:(url:string)=>(string|null|Promise<string|null>),
 *          isAllowedHost?:(url:string)=>boolean}} opts
 * @returns {Promise<{ok:boolean, status?:number, finalUrl?:string, material?:object, spa?:boolean, bytes?:number, error?:string}>}
 */
async function fetchPageMaterial({ url, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, headers, cookieProvider, isAllowedHost } = {}) {
  // 归一网址：用户常填不带协议头的写法（kimi.com）——直接 new URL() 会抛错，
  // 结果素材为空、生成只能靠猜（真实故障见 app-util.normalizeUrl 注释）
  const normalized = normalizeUrl(url)
  if (!normalized) {
    return { ok: false, error: `网址不合法：${String(url)}（只支持 http/https，请填完整网址，例如 https://example.com/）` }
  }
  const u = new URL(normalized)

  const f = fetchImpl || globalThis.fetch
  if (typeof f !== 'function') return { ok: false, error: '当前运行环境没有 fetch' }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const allowed = typeof isAllowedHost === 'function' ? isAllowedHost : defaultAllowedHost(u.toString())
    let current = u.toString()
    let resp = null
    let hops = 0
    while (true) {
      resp = await fetchOneHop(f, current, { headers, cookieProvider, timeoutMs, ac })
      const status = resp.status
      const location = resp.headers?.get?.('location')
      if (status >= 300 && status < 400 && location) {
        if (hops >= MAX_REDIRECTS) return { ok: false, status, finalUrl: current, error: `重定向次数超过上限（${MAX_REDIRECTS} 跳）` }
        let next
        try { next = new URL(location, current).toString() } catch { return { ok: false, status, finalUrl: current, error: `重定向目标不合法：${location}` } }
        if (!/^https?:/i.test(next)) return { ok: false, status, finalUrl: current, error: `重定向到不支持的协议：${next}` }
        if (!allowed(next)) {
          // 跨站跳转：把登录态发给第三方是绝不允许的，直接停止并不返回内容
          const host = (() => { try { return new URL(next).hostname } catch { return next } })()
          return { ok: false, status, finalUrl: current, error: `页面跨站跳转到未授权域名（${host}），已停止跟随且未携带 Cookie` }
        }
        current = next
        hops++
        continue
      }
      break
    }
    const ctype = String(resp.headers?.get?.('content-type') || '')
    const raw = await resp.text()
    const html = raw.length > MAX_HTML_BYTES ? raw.slice(0, MAX_HTML_BYTES) : raw
    if (!resp.ok) {
      return { ok: false, status: resp.status, finalUrl: resp.url || current, error: `页面返回 ${resp.status}（${ctype || '未知类型'}）` }
    }
    if (ctype && !/text\/html|application\/xhtml|text\/plain/i.test(ctype)) {
      return { ok: false, status: resp.status, finalUrl: resp.url || current, error: `返回的不是网页（${ctype}）` }
    }
    const material = extractPageMaterial(html, resp.url || current)
    return { ok: true, status: resp.status, finalUrl: resp.url || current, material, spa: looksLikeSpaShell(html), bytes: raw.length }
  } catch (e) {
    const msg = e?.name === 'AbortError' ? `取页面超时（${Math.round(timeoutMs / 1000)}s）` : String(e?.message || e)
    return { ok: false, error: `取页面失败：${msg}` }
  } finally {
    clearTimeout(timer)
  }
}

/** 从一批链接里挑"值得再去抓一页"的（导航类页面通常能揭示更多可控接口） */
function pickFollowLinks(material, baseUrl, max) {
  const skipRe = /\/(logout|signout|sign-out|exit|delete|remove|cancel|unsubscribe)(\/|$|\?)/i
  const keepRe = /(list|index|search|query|order|item|product|setting|config|manage|admin|report|export|dashboard|home|about|help|profile|account|user|task|job|record|history|detail)/i
  let base = null
  try { base = new URL(baseUrl) } catch { return [] }
  const scored = []
  for (const l of material?.links || []) {
    let u
    try { u = new URL(l.href, baseUrl) } catch { continue }
    if (u.origin !== base.origin) continue                      // 只跟同源：跨域属别的应用
    const path = u.pathname + u.search
    if (!path || path === '/' || path === base.pathname + base.search) continue
    if (skipRe.test(path)) continue                             // 退出/删除类绝不自动访问
    const score = (keepRe.test(path) ? 2 : 0) + (l.text && l.text.length <= 12 ? 1 : 0)
    scored.push({ url: u.toString(), score })
  }
  const seen = new Set()
  return scored
    .sort((a, b) => b.score - a.score)
    .filter((x) => (seen.has(x.url) ? false : (seen.add(x.url), true)))
    .slice(0, max)
    .map((x) => x.url)
}

/**
 * **尽可能充分**地取回一个站点的素材：首页 + 若干同源主要页面。
 *
 * 为什么需要（用户要求）：只抓首页时，模型看得到的可控制接口非常有限，生成的命令自然单薄
 *（"要让模型尽可能充分的获取所有能控制的接口信息"）。多抓几页导航/列表/设置页，模型就能
 * 把整个站点的可控入口摸出来，写出的命令更完整、更有用。用户明确表示可以慢，但要求摸全。
 *
 * 安全：只跟**同源**链接；跳过 logout/delete 等破坏性路径；页数有上限；任何一页失败都不影响整体。
 * 登录态：cookieProvider / isAllowedHost 原样透传（后续各页同样带 Cookie、同样逐跳判授权）。
 * @returns {Promise<{ok:boolean, material?:object, pages?:Array, pagesFetched?:number, failed?:Array, error?:string}>}
 */
async function harvestSite({ url, fetchImpl, maxPages = 5, timeoutMs = DEFAULT_TIMEOUT_MS, cookieProvider, isAllowedHost } = {}) {
  const first = await fetchPageMaterial({ url, fetchImpl, timeoutMs, cookieProvider, isAllowedHost })
  if (!first.ok) return { ok: false, error: first.error, status: first.status }
  const main = first.material
  const follow = pickFollowLinks(main, first.finalUrl, Math.max(0, maxPages - 1))
  const pages = []
  const failed = []
  // 并发抓取（同源、页数小，压力可控）
  const results = await Promise.all(follow.map(async (u) => ({ u, r: await fetchPageMaterial({ url: u, fetchImpl, timeoutMs, cookieProvider, isAllowedHost }) })))
  for (const { u, r } of results) {
    if (r.ok) pages.push(r.material)
    else failed.push({ url: u, error: r.error })
  }
  // 素材体积上限：多页时给更宽的上限（用户明确"可以慢，但要摸全"），但仍要有界
  const interactiveTotal = [main, ...pages].reduce((n, m) => n + (m?.interactives || 0), 0)
  return {
    ok: true,
    material: { ...main, pages, site: { pagesFetched: 1 + pages.length, interactiveTotal, followSkipped: Math.max(0, (main.links || []).length - follow.length) } },
    pages,
    pagesFetched: 1 + pages.length,
    failed,
    finalUrl: first.finalUrl,
    spa: first.spa,
    bytes: first.bytes,
  }
}

module.exports = {
  fetchPageMaterial, harvestSite, extractPageMaterial, isMaterialRich, looksLikeSpaShell, stripTags, pickFollowLinks,
  DEFAULT_TIMEOUT_MS, MAX_HTML_BYTES, MAX_REDIRECTS, RICH_MIN_INTERACTIVES,
}
