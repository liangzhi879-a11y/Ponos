// LoopMode 路由层（2026-10-06 三层循环升级）：决策 LLM 判定下一轮执行模式
// ---------------------------------------------------------------------------
// 设计纪律（spec docs/superpowers/specs/2026-10-06-loop-3layer-upgrade-design.md §1.2/§3）：
//   · 决策 LLM 与执行模型**解耦**：解析顺序 opts.routerModel → PONOS_ROUTER_MODEL → 当前激活模型
//   · 每次调用**短超时**（PONOS_ROUTER_TIMEOUT_MS 缺省 5000）且**绝不阻塞轮**：
//     任何失败/超时/坏 JSON → `{ ok:false, fallback:true, mode:null }`，
//     由引擎**沿用当前 effectiveMode**（D14：连续性优先，非强制回落 react）
//   · 严格校验 + **校验失败一次性重试**（Pydantic AI retry-prompt 模式：把校验错误
//     作为新消息回问一次）；传输类失败（超时/网络）**不重试**（重试只会加倍延迟）
//   · 无副作用、无闭包依赖：LLM 调用经 `callModel` 注入（默认走 api.mjs 的 streamMessages），
//     故本模块可纯单测（不起内核、不碰网络）
//
// 模型主动切换（D11）：模型可在回复里写闭合标记 `<!--PONOS_LOOP_MODE PLAN reason="…"-->`。
//   · 只作**路由提示**（合并进下一次判定），不单独生效（A1：引擎发起才是权威）
//   · 只认**已闭合**标记（半截标记留待后续流片补齐——与 server/askuser.mjs 同口径）
//   · kill switch：PONOS_LOOP_MODE_MARKER=0（引擎侧读取，harvestModeHint 始终可解析）
import { LOOP_MODES } from './loop-modes.mjs'

/**
 * 路由**可判**的模式集（2026-10-29 新增 subagent 档时拆出来）。
 * ★ 为什么不是直接用 LOOP_MODES：`subagent` 与 `custom:<id>` 同属"用户钉住专属"——
 *   是否并行派子 Agent 是**用户对工作方式的决定**，不该由裁决 LLM 每轮猜着切换
 *   （真被路由选中 ⇒ 用户没选过它却进了该档，且下一轮还可能被路由切走 = 档位自己在动）。
 *   故路由输出白名单 = 三模式；subagent 只能由用户在选择器里钉住（或 CLI --loop-mode）。
 */
export const ROUTABLE_LOOP_MODES = ['react', 'plan', 'reflect']

/** 缺省路由超时（ms）。超时可经参数或 PONOS_ROUTER_TIMEOUT_MS 覆盖。 */
export const DEFAULT_ROUTER_TIMEOUT_MS = 5000

/** 路由调用输出预算（token）：只够吐一个 JSON 对象，防止路由模型长篇大论。 */
export const ROUTER_MAX_TOKENS = 300

/** 校验失败时的总尝试次数（初判 + 一次性重试）。 */
export const ROUTER_MAX_ATTEMPTS = 2

/** 判定提示词（代码维护，非 LLM 生成）：白名单 + 三模式语义 + "拿不准给低置信"。 */
export const ROUTER_SYSTEM_PROMPT = [
  '你是 Ponos 内核的循环模式路由器（决策层）。你的唯一职责：根据对话上下文判断**下一轮**应采用的执行模式，并给出置信度。',
  '可选模式（白名单，不得发明新值）：',
  '- react：常规直接执行——目标清晰、进展正常，直接推进即可。',
  '- plan：多步骤任务且需要先规划（改动面大、依赖多，或用户明确要求先给方案/计划）。',
  '- reflect：此前链路反复失败或停滞，需要先复盘失败原因、换一条与已失败做法不同的路径再推进。',
  '只输出一个 JSON 对象，不要输出任何其他文本：',
  '{"mode":"react|plan|reflect","confidence":0 到 1 之间的小数,"reason":"一句话理由"}',
  '规则：拿不准时 mode 给 react 且 confidence 给低值——绝不为"显得聪明"而高置信。',
].join('\n')

/**
 * 解析路由模型：显式 routerModel → PONOS_ROUTER_MODEL → 当前激活模型（缺省）。
 * @param {{ routerModel?: string, model?: string }} [p]
 * @returns {string}
 */
export function resolveRouterModel({ routerModel = '', model = '' } = {}) {
  return String(routerModel || process.env.PONOS_ROUTER_MODEL || model || '').trim()
}

/**
 * 解析路由超时：显式参数 → PONOS_ROUTER_TIMEOUT_MS → 缺省 5000ms。非法值（非数/≤0）按缺省。
 * @param {unknown} [explicit]
 * @returns {number}
 */
export function resolveRouterTimeoutMs(explicit) {
  const n = Number(explicit ?? process.env.PONOS_ROUTER_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ROUTER_TIMEOUT_MS
}

/** 单条消息渲染成路由提示词可读文本（工具块只留短标记——路由不需要正文）。 */
function renderMessage(m) {
  const c = m?.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c.map((b) => {
    if (!b || typeof b !== 'object') return ''
    if (b.type === 'text') return String(b.text ?? '')
    if (b.type === 'tool_use') return `[调用工具 ${b.name ?? '?'}]`
    if (b.type === 'tool_result') return `[工具结果 ${typeof b.content === 'string' ? b.content.slice(0, 120) : ''}]`
    return ''
  }).filter(Boolean).join(' ')
}

/** 最近 N 条消息压成短文本（跳过 system——路由有自己的系统提示；单条 600 字符封顶）。 */
export function compactHistory(messages, { keep = 10, perMessage = 600 } = {}) {
  const out = []
  const list = Array.isArray(messages) ? messages : []
  for (const m of list.slice(-keep)) {
    if (!m || m.role === 'system') continue
    const text = renderMessage(m).replace(/\s+/g, ' ').trim().slice(0, perMessage)
    if (text) out.push({ role: String(m.role || '?'), text })
  }
  return out
}

/**
 * 组装路由提示词（system + 一段 user）。`hint` = 上一轮模型主动标记（只作参考）。
 * @param {{ messages?: any[], hint?: {mode:string, reason?:string}|null }} [p]
 */
export function buildRouterMessages({ messages = [], hint = null } = {}) {
  const lines = compactHistory(messages).map((m) => `${m.role}: ${m.text}`)
  const tail = ['请判定下一轮应采用的执行模式，只输出 JSON。']
  if (hint && LOOP_MODES.includes(hint.mode)) {
    tail.unshift(`【模型主动提示】上一轮模型输出中请求切换到 ${hint.mode}${hint.reason ? `（理由：${String(hint.reason).slice(0, 120)}）` : ''}。这只作参考，仍须你独立判定。`)
  }
  const user = (lines.length ? `【最近对话】\n${lines.join('\n')}\n` : '（无历史对话）\n') + tail.join('\n')
  return [
    { role: 'system', content: ROUTER_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ]
}

/**
 * 严格解析路由回复。返回 `{ mode, confidence, reason }` 或 `{ error }`（错误文本将回喂重试）。
 * 校验：必须含 JSON 对象；mode ∈ ROUTABLE_LOOP_MODES（大小写归一；subagent 不在路由白名单——
 * 那是用户钉住专属档，见该常量注释）；confidence 数值且**钳制**到 [0,1]；
 * reason 截断 200 字符（不因超长判错——那是显示字段，不是判据）。
 * @param {string} text
 */
export function parseRouterReply(text) {
  const m = String(text ?? '').match(/\{[\s\S]*\}/)
  if (!m) return { error: '未找到 JSON 对象' }
  let j
  try { j = JSON.parse(m[0]) } catch (e) { return { error: `JSON 解析失败：${e?.message || e}` } }
  const mode = String(j?.mode ?? '').trim().toLowerCase()
  if (!ROUTABLE_LOOP_MODES.includes(mode)) return { error: `mode 不在路由白名单（react|plan|reflect）：${JSON.stringify(j?.mode)}` }
  const confRaw = Number(j?.confidence)
  if (!Number.isFinite(confRaw)) return { error: `confidence 非数值：${JSON.stringify(j?.confidence)}` }
  return { mode, confidence: Math.min(1, Math.max(0, confRaw)), reason: String(j?.reason ?? '').slice(0, 200) }
}

/** 默认 LLM 调用：走 api.mjs 的 streamMessages（tools 空、小预算）。返回累积文本。 */
async function defaultCallModel({ model, messages, maxTokens, signal }) {
  // 测试基建（PONOS_MOCK_API）下的**默认不打 mock 流**：mock 的各类计数/接管分支
  // （overflow/truncate/cata-retry 计数、lane 场景…）会被路由请求污染，令既有断言
  // 失真——路由是**额外新增的每轮一调**，不能悄悄改变既有用例的可观测面。
  // 引擎级路由用例改为显式脚本化：PONOS_MOCK_ROUTER='{"mode":"plan","confidence":0.9}'。
  // 生产（无 PONOS_MOCK_API）逐字走下方真流，无任何分叉。
  if (process.env.PONOS_MOCK_ROUTER) return process.env.PONOS_MOCK_ROUTER
  if (process.env.PONOS_MOCK_API === '1') return ''
  const { streamMessages } = await import('./api.mjs')
  let out = ''
  for await (const chunk of streamMessages({ model, messages, maxTokens, signal, tools: [] })) {
    if (chunk?.type === 'text') out += chunk.text
  }
  return out
}

/** 带超时的单次调用：内部 AbortController + 外部信号转发（不依赖 AbortSignal.any，兼容旧 Node）。 */
async function callWithTimeout({ callModel, model, messages, signal, timeoutMs }) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(new Error(`路由超时（${timeoutMs}ms）`)), timeoutMs)
  const ext = signal?.rawSignal || signal
  const onAbort = () => ctl.abort(ext?.reason ?? new Error('aborted'))
  if (ext && typeof ext.addEventListener === 'function') {
    if (ext.aborted) onAbort()
    else ext.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const text = await callModel({ model, messages, maxTokens: ROUTER_MAX_TOKENS, signal: ctl.signal })
    if (ctl.signal.aborted) return { error: `路由调用被中止：${ctl.signal.reason?.message || ctl.signal.reason || 'aborted'}` }
    return { text: String(text ?? '') }
  } catch (err) {
    if (ctl.signal.aborted) return { error: `路由调用被中止：${ctl.signal.reason?.message || ctl.signal.reason || err?.message || String(err)}` }
    return { error: `路由请求失败：${err?.message || String(err)}` }
  } finally {
    clearTimeout(timer)
    try { ext?.removeEventListener?.('abort', onAbort) } catch { /* 无 removeEventListener 的旧对象 */ }
  }
}

/**
 * 判定下一轮执行模式（轮首调用一次；绝不抛错、绝不阻塞轮）。
 *
 * @param {object} p
 * @param {any[]}  [p.messages]    对话历史（引擎传 deriveHistory()；system 会被跳过）
 * @param {string} [p.model]       当前激活模型（routerModel/env 都缺省时的兜底）
 * @param {string} [p.routerModel] 显式路由模型（control_request 热切换 > env > model）
 * @param {any}    [p.signal]      外部取消信号（AbortSignal 或内核 signal 对象）
 * @param {number} [p.timeoutMs]   超时覆盖（缺省 env PONOS_ROUTER_TIMEOUT_MS，再缺省 5000）
 * @param {object} [p.hint]        上一轮模型主动标记 { mode, reason }（只作参考）
 * @param {Function} [p.callModel] LLM 调用注入（测试用；默认 streamMessages）
 * @returns {Promise<{ok:boolean, mode:string|null, confidence:number, reason:string,
 *                    fallback:boolean, attempts:number, error?:string, ms:number}>}
 *   ok:false ⇒ 调用方**沿用当前有效模式**（D14），并如实登记 error/fallback。
 */
export async function classifyLoopMode({ messages = [], model = '', routerModel = '', signal = null, timeoutMs, hint = null, callModel = defaultCallModel } = {}) {
  const started = Date.now()
  const useModel = resolveRouterModel({ routerModel, model })
  const budget = resolveRouterTimeoutMs(timeoutMs)
  const base = buildRouterMessages({ messages, hint })
  let feedback = null
  let lastError = ''
  for (let attempt = 1; attempt <= ROUTER_MAX_ATTEMPTS; attempt++) {
    const msgs = feedback ? [...base, { role: 'user', content: feedback }] : base
    // 传输类失败（超时/网络/取消）：重试只会加倍延迟且多半复现——立即兜底（D14）。
    const r = await callWithTimeout({ callModel, model: useModel, messages: msgs, signal, timeoutMs: budget })
    if (r.error) {
      return { ok: false, mode: null, confidence: 0, reason: '', fallback: true, attempts: attempt, error: r.error, ms: Date.now() - started }
    }
    const parsed = parseRouterReply(r.text)
    if (!parsed.error) {
      return { ok: true, mode: parsed.mode, confidence: parsed.confidence, reason: parsed.reason, fallback: false, attempts: attempt, ms: Date.now() - started }
    }
    // 校验失败：把错误文本作为新消息回问一次（Pydantic AI retry-prompt 模式）
    lastError = parsed.error
    feedback = `你上一次的输出未通过校验：${parsed.error}。请重新只输出一个合法 JSON 对象：mode 必须是 react|plan|reflect 之一，confidence 是 0 到 1 之间的数值。`
  }
  return { ok: false, mode: null, confidence: 0, reason: '', fallback: true, attempts: ROUTER_MAX_ATTEMPTS, error: `校验失败（已重试一次）：${lastError}`, ms: Date.now() - started }
}

// ── 模型主动标记（D11：闭合文本标记，只作路由提示）───────────────────────────
// 形如：<!--PONOS_LOOP_MODE PLAN reason="…"-->（大小写不敏感；reason 可省）

/** 标记正则：只匹配**已闭合**的标记（半截标记留待后续流片补齐）。 */
export const MODE_MARKER_RE = /<!--\s*PONOS_LOOP_MODE\b([\s\S]*?)-->/g

/** 解析标记体：首词为模式（白名单外→null），可选 reason="…"。
 *  ★ 白名单用 LOOP_MODES（含 subagent）而不是 ROUTABLE_LOOP_MODES：标记只是**给路由的提示**
 *    （见文件头 D11），模型写"这一轮想并行派子 Agent"是有效信息；它不直接改档，
 *    路由仍只会回三模式之一。 */
export function parseModeMarker(body) {
  const s = String(body ?? '').trim()
  const m = s.match(/^([A-Za-z]+)/)
  if (!m) return null
  const mode = m[1].toLowerCase()
  if (!LOOP_MODES.includes(mode)) return null
  const r = s.match(/reason\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/)
  const reason = String(r?.[1] ?? r?.[2] ?? r?.[3] ?? '').slice(0, 200)
  return { mode, reason }
}

/**
 * 从文本中提取所有**已闭合**的主动切换标记，并返回剥离标记后的干净文本。
 * 与 server/askuser.mjs 的 extractAskUserBlocks 同口径：未闭合的半截标记不提取、
 * 且原样保留在 clean 里（避免流式期把用户可见文本吃掉半截）。
 * @param {string} text
 * @returns {{ hint: {mode:string,reason:string}|null, hints: Array<{mode:string,reason:string}>, clean: string }}
 */
export function harvestModeHint(text) {
  const src = String(text ?? '')
  const hints = []
  let clean = ''
  let pos = 0
  MODE_MARKER_RE.lastIndex = 0
  let m
  while ((m = MODE_MARKER_RE.exec(src)) !== null) {
    clean += src.slice(pos, m.index)
    pos = m.index + m[0].length
    const h = parseModeMarker(m[1])
    if (h) hints.push(h)
  }
  clean += src.slice(pos)
  return { hint: hints.length ? hints[hints.length - 1] : null, hints, clean }
}
