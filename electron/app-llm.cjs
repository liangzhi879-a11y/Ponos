// 应用智控：模型调用（Task 3.1 的 `callLlm` 真实实现）
//
// ★ 为什么不照抄计划里的 `import('../kernel/provider.mjs').callProvider`：
//   该导出**不存在**（provider.mjs 只有 getProvider/setProvider/authHeaders/seedFromFile），
//   照抄会直接抛错。内核真正入口是 kernel/api.mjs 的 streamMessages，但它跑在内核进程里，
//   主进程 import 不到（打包产物也不含 kernel/ 源码）。
//
// 故此处按内核同一套协议自建最小客户端（与 kernel/provider.mjs:18-25、api.mjs:1314 对齐）：
//   POST ${baseUrl}/v1/messages ，headers = content-type + x-api-key|authorization + anthropic-version
//   baseUrl 取自 $YFW_HOME/config.json 的 activeProvider（与 bridge 的 YFW_CONFIG_PATH 同源）。
// 流式解析同时兼容 Anthropic（content_block_delta）与 OpenAI（choices[].delta.content）两种 delta，
// 因为同一份 config 里可能挂两种网关（实测 providers 里既有 anthropic 端点也有 8900 代理）。
'use strict'
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { resolveYfwHome } = require('../server/yfw-home.cjs')

const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_TIMEOUT_MS = 180000
const DEFAULT_MAX_TOKENS = 8000
const ERROR_BODY_CAP = 400

/** 读取激活 provider；返回结构化结果而非抛错（调用方要能给出人话提示） */
function loadProvider({ home } = {}) {
  const file = join(home || resolveYfwHome(), 'config.json')
  let cfg
  try {
    cfg = JSON.parse(readFileSync(file, 'utf-8'))
  } catch (e) {
    return { ok: false, error: `读不到模型配置（${file}）：${String(e?.message || e)}` }
  }
  const list = Array.isArray(cfg.providers) ? cfg.providers : []
  const active = list.find((p) => p?.id === cfg.activeProvider) || list[0]
  if (!active) return { ok: false, error: `模型配置里没有可用 provider（${file}）` }
  const baseUrl = String(active.apiBaseUrl || '').replace(/\/+$/, '')
  const authToken = String(active.authToken || '')
  if (!baseUrl || !authToken) {
    return { ok: false, error: `provider「${active.id || '?'}」缺少 apiBaseUrl 或 authToken，请在应用设置里补全` }
  }
  const model = String(active.primaryModel || active.model || '')
  if (!model) return { ok: false, error: `provider「${active.id || '?'}」未配置模型名（primaryModel）` }
  return { ok: true, provider: { id: active.id, baseUrl, authToken, authScheme: active.authScheme, model } }
}

/** 与 kernel/provider.mjs:18-25 同口径 */
function authHeaders(provider = {}) {
  const token = String(provider.authToken || '')
  if (String(provider.authScheme || '').toLowerCase() === 'bearer') {
    return { authorization: /^Bearer\s/i.test(token) ? token : `Bearer ${token}` }
  }
  return { 'x-api-key': token }
}

/** 从一行 SSE 数据里抠出增量文本；返回 {text, done, error} */
function parseDelta(line) {
  if (!line.startsWith('data:')) return null
  const payload = line.slice(5).trim()
  if (!payload || payload === '[DONE]') return payload === '[DONE]' ? { done: true } : null
  let j
  try {
    j = JSON.parse(payload)
  } catch {
    return null
  }
  if (j.type === 'error') return { error: String(j.error?.message || JSON.stringify(j.error || {})) }
  if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') return { text: String(j.delta.text || '') }
  const oa = j.choices?.[0]?.delta?.content
  if (typeof oa === 'string') return { text: oa }
  if (j.type === 'message_stop') return { done: true }
  return null
}

/** 非流式响应体 → 文本（有的网关忽略 stream 参数直接回整个 JSON） */
function textFromWholeBody(text) {
  try {
    const j = JSON.parse(text)
    if (Array.isArray(j.content)) return j.content.filter((c) => c?.type === 'text').map((c) => c.text).join('')
    const oa = j.choices?.[0]?.message?.content
    if (typeof oa === 'string') return oa
  } catch {
    /* 不是 JSON，交给调用方当错误处理 */
  }
  return ''
}

/**
 * 调模型拿一段文本（流式，边收边回调）。
 * @returns {Promise<{ok:boolean, text:string, error:string|null, chars:number}>}
 */
async function callLlmStream({ system, user, onDelta, maxTokens, timeoutMs, provider, fetchImpl } = {}) {
  const resolved = provider ? { ok: true, provider } : loadProvider()
  if (!resolved.ok) return { ok: false, text: '', error: resolved.error, chars: 0 }
  const p = resolved.provider
  if (!p.model) return { ok: false, text: '', error: 'provider 未配置模型名', chars: 0 }

  const f = fetchImpl || globalThis.fetch
  if (typeof f !== 'function') return { ok: false, text: '', error: '当前运行环境没有 fetch', chars: 0 }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs || DEFAULT_TIMEOUT_MS)
  let text = ''
  try {
    const resp = await f(`${p.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(p), 'anthropic-version': ANTHROPIC_VERSION },
      body: JSON.stringify({
        model: p.model,
        max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: user }],
        stream: true,
      }),
      signal: ac.signal,
    })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      return { ok: false, text: '', error: `模型接口 ${resp.status}：${String(body).slice(0, ERROR_BODY_CAP)}`, chars: 0 }
    }

    if (!resp.body || typeof resp.body.getReader !== 'function') {
      // 非流式回退：一次性读完
      const whole = await resp.text()
      text = textFromWholeBody(whole)
      if (text) onDelta?.(text, text.length)
      return text
        ? { ok: true, text, error: null, chars: text.length }
        : { ok: false, text: '', error: '模型返回无法解析（非流式且无文本）', chars: 0 }
    }

    const reader = resp.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let streamError = null
    const handle = (line) => {
      const d = parseDelta(line.trim())
      if (!d) return
      if (d.error) { streamError = d.error; return }
      if (d.text) { text += d.text; onDelta?.(d.text, text.length) }
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        handle(buf.slice(0, idx))
        buf = buf.slice(idx + 1)
      }
    }
    if (buf.trim()) handle(buf)

    if (streamError && !text) return { ok: false, text: '', error: streamError, chars: 0 }
    if (!text) return { ok: false, text: '', error: '模型没有输出任何文本', chars: 0 }
    return { ok: true, text, error: null, chars: text.length }
  } catch (e) {
    const msg = e?.name === 'AbortError' ? `模型调用超时（${Math.round((timeoutMs || DEFAULT_TIMEOUT_MS) / 1000)}s）` : String(e?.message || e)
    // 已有部分文本时如实返回：让界面能展示"收到一半就断了"，而不是整段丢弃
    return { ok: false, text, error: msg, chars: text.length }
  } finally {
    clearTimeout(timer)
  }
}

module.exports = {
  callLlmStream, loadProvider, authHeaders, parseDelta, textFromWholeBody,
  ANTHROPIC_VERSION, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_TOKENS,
}
