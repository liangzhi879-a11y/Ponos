// 注入总账（S1+ / O4）
// ---------------------------------------------------------------------------
// 目的：让每一次注入都有账 —— "注了什么、占了多少、走哪条渠道、来自哪个来源"。
//
// A13 要求"可归因到 5% 以内"，故维度必须齐备：
//   · 渠道五分 channels.{static,bridge,guard,derived,payload}（**注入渠道**维度）
//     ★ 不是 legacy/unified —— 那是**检索策略**维度，用它记账无法归因到渠道
//   · 来源归因 bySource（systemPrompt/toolSchema/skill/experience/knowledge/protocol/payload）
//   · 场景三元组 promptTier/sessionMode/kb（跨场景混算会让 5% 假红）
//
// 硬约束（spec O4）：
//   ① 只取长度，**不得重排提示词**（本模块不持有提示词，只接收已算好的字节数）
//   ② 不删 metrics.json 既有 inject/search 段（本模块不写 metrics.json）
//   ③ 不改 build 预算口径（字符→字节的换算唯一归属 S4.5 / 批1 Task 5）
//
// 纯函数、无 IO ⇒ 可单测、可重放。

export const CHANNELS = ['static', 'bridge', 'guard', 'derived', 'payload']
export const BY_SOURCE = ['systemPrompt', 'toolSchema', 'skill', 'experience', 'knowledge', 'protocol', 'payload']

/** 分段计量的固定段序（只读计量用；段名即 prompt.mjs 能测到的粒度） */
const SEGMENT_ORDER = ['systemPrompt', 'toolSchema', 'skill', 'injected']
const SEGMENT_KEYS = {
  systemPrompt: 'systemPromptBytes',
  toolSchema: 'toolSchemaBytes',
  skill: 'skillBytes',
  injected: 'injectedBytes',
}

/** 非负整数化：缺失/非数字/负值一律按 0（口径宽容，不抛错） */
function n(v) {
  const x = Number(v)
  return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0
}

/** 只读分段计量。固定段序，缺失按 0。 */
export function buildSegmentMeters(input) {
  const src = input || {}
  return SEGMENT_ORDER.map((id) => ({ id, bytes: n(src[SEGMENT_KEYS[id]]) }))
}

function normalizeChannel(ch) {
  if (!ch || typeof ch !== 'object') return null
  return { calls: n(ch.calls), hits: n(ch.hits), injectedBytes: n(ch.injectedBytes) }
}

function normalizeBySource(bs) {
  const out = {}
  for (const k of BY_SOURCE) out[k] = n(bs?.[k])
  return out
}

/**
 * 规范化一条注入快照，供 appendMeta('inject_snapshot', ...) 使用。
 * 渠道缺失为 null（区分"未走该渠道"与"走了但 0 命中"）；
 * ★ 但显式传入的 0 必须保留（"记忆注入关闭 ⇒ 记 0 而非不记"，spec :211）。
 */
export function summarizeInjection({
  turn, seq, segments, channels, bySource, promptTier, sessionMode, kb, ts,
} = {}) {
  const segs = Array.isArray(segments) ? segments.map((s) => ({ id: String(s.id), bytes: n(s.bytes) })) : []
  const ch = channels || {}
  const outChannels = {}
  for (const name of CHANNELS) outChannels[name] = normalizeChannel(ch[name])
  return {
    turn: Number.isFinite(turn) ? Math.floor(turn) : null,
    seq: Number.isFinite(seq) ? Math.floor(seq) : null,
    ts: Number.isFinite(ts) ? Math.floor(ts) : Date.now(),
    segments: segs,
    totalBytes: segs.reduce((a, s) => a + s.bytes, 0),
    channels: outChannels,
    bySource: normalizeBySource(bySource),
    promptTier: promptTier ?? null,
    sessionMode: sessionMode ?? null,
    kb: kb ?? null,
  }
}

/** 汇总多条快照（观察期统计用） */
export function ledgerTotals(records) {
  const bySegment = {}
  const byChannel = {}
  const bySource = {}
  // ★ 零形状：即使没有任何记录，来源七项也必须存在（避免 undefined 漏进面板/日志）
  for (const k of BY_SOURCE) bySource[k] = 0
  let totalBytes = 0
  for (const rec of records || []) {
    totalBytes += n(rec.totalBytes)
    for (const s of rec.segments || []) bySegment[s.id] = (bySegment[s.id] || 0) + n(s.bytes)
    for (const name of CHANNELS) {
      const c = rec.channels?.[name]
      if (!c) continue
      byChannel[name] = byChannel[name] || { calls: 0, hits: 0, injectedBytes: 0 }
      byChannel[name].calls += n(c.calls)
      byChannel[name].hits += n(c.hits)
      byChannel[name].injectedBytes += n(c.injectedBytes)
    }
    for (const k of BY_SOURCE) bySource[k] = (bySource[k] || 0) + n(rec.bySource?.[k])
  }
  return { totalBytes, bySegment, byChannel, bySource }
}

// ── 逐轮序号（resetInjectStats 是**进程级累计**，逐轮读会拿到累计值）─────────
// 语义：seq 随每次轮末快照递增，调用方可据此判断"快照是否连续"（丢轮即断号）。
let __turnSeq = 0
export function nextTurnSeq() { return ++__turnSeq }
export function resetTurnSeq() { __turnSeq = 0 }
