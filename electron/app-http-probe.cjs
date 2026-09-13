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

const DEFAULT_TIMEOUT_MS = 15000
const MAX_HTML_BYTES = 1_500_000
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

const attr = (tag, name) => {
  const m = String(tag).match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  return m ? (m[2] ?? m[3] ?? m[4] ?? '').trim() : ''
}
const textOf = (tag) => stripTags(String(tag).replace(/^<[^>]*>/, '')).slice(0, 60)

/**
 * 从 HTML 里抽出"写命令要用到"的素材（纯函数）。
 * @returns {{title:string, description:string, headings:string[], forms:Array, buttons:string[], links:Array, text:string, interactives:number}}
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
  return { url: url || '', title, description, headings, forms, buttons, links, text, interactives }
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

/**
 * 后台取页面素材（主进程普通 HTTP，无窗口、无白名单，用户无感）。
 * @returns {Promise<{ok:boolean, status?:number, finalUrl?:string, material?:object, spa?:boolean, bytes?:number, error?:string}>}
 */
async function fetchPageMaterial({ url, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, headers } = {}) {
  let u
  try { u = new URL(String(url)) } catch { return { ok: false, error: `网址不合法：${String(url)}` } }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: `只支持 http/https：${u.protocol}` }

  const f = fetchImpl || globalThis.fetch
  if (typeof f !== 'function') return { ok: false, error: '当前运行环境没有 fetch' }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const resp = await f(u.toString(), {
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8', ...(headers || {}) },
      signal: ac.signal,
    })
    const ctype = String(resp.headers?.get?.('content-type') || '')
    const raw = await resp.text()
    const html = raw.length > MAX_HTML_BYTES ? raw.slice(0, MAX_HTML_BYTES) : raw
    if (!resp.ok) {
      return { ok: false, status: resp.status, finalUrl: resp.url || u.toString(), error: `页面返回 ${resp.status}（${ctype || '未知类型'}）` }
    }
    if (ctype && !/text\/html|application\/xhtml|text\/plain/i.test(ctype)) {
      return { ok: false, status: resp.status, finalUrl: resp.url || u.toString(), error: `返回的不是网页（${ctype}）` }
    }
    const material = extractPageMaterial(html, resp.url || u.toString())
    return { ok: true, status: resp.status, finalUrl: resp.url || u.toString(), material, spa: looksLikeSpaShell(html), bytes: raw.length }
  } catch (e) {
    const msg = e?.name === 'AbortError' ? `取页面超时（${Math.round(timeoutMs / 1000)}s）` : String(e?.message || e)
    return { ok: false, error: `取页面失败：${msg}` }
  } finally {
    clearTimeout(timer)
  }
}

module.exports = {
  fetchPageMaterial, extractPageMaterial, isMaterialRich, looksLikeSpaShell, stripTags,
  DEFAULT_TIMEOUT_MS, MAX_HTML_BYTES, RICH_MIN_INTERACTIVES,
}
