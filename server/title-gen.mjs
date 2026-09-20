// 会话/任务标题生成的服务端实现（2026-09-18，清单项「标题没有实现总结，只是前几个字截取」修复）
// ---------------------------------------------------------------------------
// **为什么搬来服务端**（这是本次修复的核心判断）：
//   渲染层原本直接 `fetch(provider.apiBaseUrl + '/v1/chat/completions')` 去问模型 —— 而全仓
//   **只有这一处**从渲染层直连外部 provider：其它所有 provider 调用（`/probe-provider`、
//   `/verify-provider`、`/test-provider`）都经桥转发。渲染层直连有三个现实问题：
//     ① **打包后页面 origin 是 `file://`**（app 未开 `webSecurity:false`，`contextIsolation:true`），
//        Chromium 对 file:// 页面发出的跨域请求按不透明源处理、预检与凭证规则都很脆，
//        失败方式是 `fetch` reject —— 被 `.catch(() => {})` 吞掉，表现就是"标题永远是截断的首句"；
//     ② **基址约定不一致**：本项目 provider 基址**不含** `/v1`（内核是 `base + '/v1/messages'`），
//        但用户从 OpenAI 兼容文档/B 站教程抄来的基址常常**带** `/v1`（本地 vLLM 更常见），
//        于是拼出 `<base>/v1/v1/chat/completions` → 404，退到 `/v1/messages` 还是 404 ⇒ 静默降级；
//     ③ 密钥要下发到渲染层才能发这个请求，而服务端本来就有（磁盘 config）。
//   搬到服务端后：① 不存在；② 用与 `provider-probe.mjs` **同一套**"剥掉尾缀"约定修掉；③ 不必下发。
//
// 契约（刻意做得很薄）：`POST /generate-title { prompt, providerId? }` → `{ ok, text }`。
//   **文本策略（prompt 构造、清洗、12 字截断）仍留在渲染层**（`src/lib/titleGen.ts`），
//   服务端只负责"把一段话发给模型、把答案原文带回来"—— 这样两处不会各存一份清洗规则。
//
// 隐私：**绝不记录 prompt 与模型输出**（会话内容是用户隐私）。日志只允许出现端点、HTTP 状态、
//   耗时与错误类型。
import { resolveProviderProfile } from './provider-profile.mjs'

/** 去掉尾部斜杠（用户手填常带） */
function trimSlashes(u) {
  return String(u || '').trim().replace(/\/+$/, '')
}

/**
 * 从基址推导"根地址"：剥掉用户可能自己带上的 `/v1`、`/anthropic`、`/anthropic/v1` 尾缀。
 * 与 `server/provider-probe.mjs` 的 `modelMetaUrlCandidates` 同一约定（那边也是这么剥的），
 * 目的是**修掉 `<base>/v1/v1/...` 这种双段拼接**。
 */
export function rootOf(baseUrl) {
  return trimSlashes(baseUrl).replace(/(?:\/anthropic(?:\/v1)?|\/v1)$/i, '')
}

/**
 * 候选端点（去重、保持顺序）。两种协议都可能：
 *   · openai 风格：`<root>/v1/chat/completions`（本地 vLLM / Ollama / LM Studio / 多数中转）
 *   · anthropic 风格：`<root>/v1/messages`（真 Anthropic）、`<root>/anthropic/v1/messages`
 *     （DeepSeek/MiniMax 的 anthropic 兼容入口就在 `/anthropic` 下）
 * **一律以 `<root>` 拼装，不用用户原样的 `<base>`** —— 基址自带 `/v1` 时（OpenAI 兼容文档与
 * 本地 vLLM 的常见写法）用 `<base>` 会拼出 `/v1/v1/...` → 404，那正是"标题一直不好"的主因。
 * 顺序：基址以 `/anthropic` 结尾 ⇒ 先试 anthropic（明确信号）；否则先试 openai（多数情况）。
 */
export function titleUrlCandidates(baseUrl) {
  const b = trimSlashes(baseUrl)
  if (!b) return []
  const root = rootOf(b)
  const openai = { kind: 'openai', url: `${root}/v1/chat/completions` }
  const anthropic = [
    { kind: 'anthropic', url: `${root}/anthropic/v1/messages` },
    { kind: 'anthropic', url: `${root}/v1/messages` },
  ]
  const ordered = /\/anthropic(\/v1)?$/i.test(b) ? [...anthropic, openai] : [openai, ...anthropic]
  const seen = new Set()
  return ordered.filter(c => (seen.has(c.url) ? false : (seen.add(c.url), true)))
}

/** 从响应体里取纯文本（两种协议、以及"content 是分片数组"的变体） */
export function extractTitleFromResponse(kind, json) {
  if (!json || typeof json !== 'object') return ''
  if (kind === 'anthropic') {
    const parts = Array.isArray(json.content) ? json.content : []
    const text = parts.map(p => (typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : ''))).join('')
    if (text.trim()) return text
    // 有些中转把 anthropic 响应包了一层，或直接给 OpenAI 形状
    return extractTitleFromResponse('openai', json)
  }
  const ch = Array.isArray(json.choices) ? json.choices[0] : null
  if (ch) {
    if (typeof ch.text === 'string' && ch.text.trim()) return ch.text
    const c = ch.message && ch.message.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      const t = c.map(p => (typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : ''))).join('')
      if (t.trim()) return t
    }
  }
  // 兜底：少数网关直接回 { content: [{type:'text',text}] } / { output_text }
  if (typeof json.output_text === 'string') return json.output_text
  const parts = Array.isArray(json.content) ? json.content : []
  const t = parts.map(p => (p && typeof p.text === 'string' ? p.text : '')).join('')
  return t
}

/** 组装请求（协议差异只在 header 与 body 形状） */
export function buildTitleRequest(kind, { authToken, model, prompt, localProfile }) {
  const headers = { 'Content-Type': 'application/json' }
  if (kind === 'anthropic') {
    if (authToken) headers['x-api-key'] = authToken
    headers['anthropic-version'] = '2023-06-01'
  } else if (authToken) {
    headers.Authorization = `Bearer ${authToken}`
  }
  const body = kind === 'anthropic'
    ? { model, max_tokens: 64, messages: [{ role: 'user', content: prompt }] }
    : {
      model, max_tokens: 64, temperature: 0.3, stream: false,
      messages: [{ role: 'user', content: prompt }],
      // 本地部署多为 Qwen3 等"默认开思考"的模型：thinking 会吃掉 max_tokens 让正文为空。
      // **只对本地画像下发**这个非标准字段 —— 云端中转/网关对未知字段有 400 的先例，
      // 而云端模型本来就是非思考款（DeepSeek 的 reasoner 也不靠这个开关）。
      ...(localProfile ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    }
  return { headers, body }
}

/**
 * 依次试候选端点，返回模型原文。
 * 语义：**只要有一个候选给出了非空文本就算成功**；全部失败才算失败，并把"试过哪些端点、
 * 各返回什么状态"带回去（这是"效果一直不好"时唯一能排障的信息 —— 之前是彻底静默）。
 */
export async function requestTitleText({ baseUrl, authToken, model, prompt, timeoutMs = 10000, fetchImpl = fetch, log = () => {} }) {
  const candidates = titleUrlCandidates(baseUrl)
  if (candidates.length === 0) return { ok: false, error: 'no base url', tried: [] }
  if (!model) return { ok: false, error: 'no model', tried: [] }
  const localProfile = resolveProviderProfile({ apiBaseUrl: baseUrl }) === 'local'
  const tried = []
  for (const cand of candidates) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    const t0 = Date.now()
    try {
      const { headers, body } = buildTitleRequest(cand.kind, { authToken, model, prompt, localProfile })
      const res = await fetchImpl(cand.url, {
        method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal,
      })
      const status = res.status
      if (!res.ok) {
        // 只记端点与状态（**不记 prompt/输出**：会话内容是隐私）
        tried.push({ url: cand.url, kind: cand.kind, status })
        log(`[title-gen] ${cand.kind} ${status} ${cand.url} (${Date.now() - t0}ms)`)
        continue
      }
      const json = await res.json().catch(() => null)
      const text = extractTitleFromResponse(cand.kind, json)
      tried.push({ url: cand.url, kind: cand.kind, status, empty: !text.trim() })
      log(`[title-gen] ${cand.kind} ${status} ${cand.url} (${Date.now() - t0}ms) text=${text.trim() ? 'yes' : 'empty'}`)
      if (text.trim()) return { ok: true, text, endpoint: cand.url, kind: cand.kind, tried }
    } catch (e) {
      tried.push({ url: cand.url, kind: cand.kind, error: (e && e.message) || String(e) })
      log(`[title-gen] ${cand.kind} error ${cand.url}: ${(e && e.message) || e}`)
    } finally {
      clearTimeout(timer)
    }
  }
  return { ok: false, error: 'all endpoints failed', tried }
}
