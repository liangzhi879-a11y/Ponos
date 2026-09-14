// 应用智控：**联网确认**能力（`web_search` 工具的实现）。
//
// ★ 为什么需要（用户明确要求）：很多原生应用本身没带 CLI，但社区/官方**有**开源 CLI 或 headless 模式
//   （例如 Aseprite 就自带完整 CLI，只是探测时用户填错了路径）。"本机探不到" ≠ "没有"，
//   模型必须能联网确认后再下结论，最后才如实告知"无法接入"。
//
// ★ 为什么在 electron 内自实现：electron 打包产物不含 kernel 源码，禁止 require('../kernel/…')；
//   这里与 electron/app-llm.cjs 一样直连 provider（复用其 provider 配置加载）。
'use strict'

const SEARCH_TIMEOUT_MS = 30000
const DEFAULT_MAX_RESULTS = 5
const ANTHROPIC_VERSION = '2023-06-01'

function buildSearchBody(query, maxResults = DEFAULT_MAX_RESULTS) {
  return {
    model: undefined, // 由调用方填充（provider.model）
    max_tokens: 1024,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxResults }],
    messages: [{ role: 'user', content: `请查询并简要回答（中文）：${String(query)}` }],
  }
}

/** 抽取正文与来源；结构异常一律返回空（联网失败不该中断生成） */
function parseSearchResponse(json) {
  const content = json?.content
  if (!Array.isArray(content)) return { text: '', sources: [] }
  let text = ''
  const sources = []
  for (const block of content) {
    if (block?.type === 'text' && block.text) text += block.text
    if (block?.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const item of block.content) {
        if (item?.type === 'web_search_result' && item.url) sources.push({ title: item.title || item.url, url: item.url })
      }
    }
  }
  return { text: text.trim(), sources }
}

/** 授权头：与 electron/app-llm.cjs 的 authHeaders 同口径（bearer 网关也支持），拿不到就退回 x-api-key */
function authHeadersFor(provider) {
  let authHeaders = null
  try {
    ;({ authHeaders } = require('./app-llm.cjs'))
  } catch {
    /* 加载失败就用下面的兜底 */
  }
  if (typeof authHeaders === 'function') return authHeaders(provider)
  const token = String(provider?.token || '')
  if (String(provider?.authScheme || '').toLowerCase() === 'bearer') {
    return { authorization: /^Bearer\s/i.test(token) ? token : `Bearer ${token}` }
  }
  return { 'x-api-key': token }
}

/**
 * 取当前激活 provider 的检索配置（复用 app-llm 的配置加载，**不** require kernel）。
 * @returns {{url:string,token:string,authScheme?:string,model:string}|null} 取不到配置返回 null（如实降级）
 */
function loadSearchProvider() {
  try {
    const { loadProvider } = require('./app-llm.cjs')
    const r = loadProvider()
    if (!r?.ok) return null
    const p = r.provider
    return { url: `${String(p.baseUrl).replace(/\/+$/, '')}/v1/messages`, token: p.authToken, authScheme: p.authScheme, model: p.model }
  } catch {
    return null
  }
}

/**
 * 联网检索。
 * @returns {Promise<{ok:boolean,text?:string,sources?:Array,error?:string}>} **绝不抛**：
 *   联网只是辅助探索，失败要能降级成"没查到"，不能把整次生成打断。
 */
async function searchWeb({ query, maxResults = DEFAULT_MAX_RESULTS, provider, fetchImpl = globalThis.fetch, timeoutMs = SEARCH_TIMEOUT_MS } = {}) {
  if (!provider?.url || !provider?.token) return { ok: false, error: '未配置模型 provider（无法联网检索）' }
  if (!query || !String(query).trim()) return { ok: false, error: '缺少查询内容' }
  if (typeof fetchImpl !== 'function') return { ok: false, error: '当前运行环境没有 fetch，无法联网检索' }
  const body = buildSearchBody(query, maxResults)
  body.model = provider.model
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(provider.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeadersFor(provider), 'anthropic-version': ANTHROPIC_VERSION },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res?.ok) return { ok: false, error: `检索请求失败：HTTP ${res?.status ?? '?'}` }
    const json = await res.json()
    const { text, sources } = parseSearchResponse(json)
    return text || sources.length ? { ok: true, text, sources } : { ok: false, error: '检索未返回有效结果' }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  } finally {
    clearTimeout(timer)
  }
}

module.exports = { buildSearchBody, parseSearchResponse, searchWeb, loadSearchProvider, SEARCH_TIMEOUT_MS }
