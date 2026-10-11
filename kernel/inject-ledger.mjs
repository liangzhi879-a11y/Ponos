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

// ★ 技能清单（【可用技能】段）的观测字节数（`summarizeInjection` 的 **顶层字段**，不是第 5 个
//   segment）—— 2026-09-26 终审修复轮；兑现 spec §5 S1.4 验收项「技能清单字节数进台账」。
//   why 顶层字段而不是 `segments` 里加一段：`skillCatalogBytes`（`prompt.mjs#getPromptSegmentMeters`）
//   是 `skill` 段的**子集** —— 技能目录本就属于那四段之和，只是为了给目录单独设限才"再计一次"。
//   若把它塞进 `segments`：① `totalBytes = Σ segments.bytes` 会**重复计数** ⇒ A13 的
//   「`channels`/`bySource` 字节和 = 实测提示词 + 派生注入（≤5%）」立刻失真；② `SEGMENT_ORDER` 是
//   "**互斥**分段"的口径（四段之和 = static 渠道字节），插一个重叠段会把它破坏。
//   ⇒ 只增一个**顶层观测字段**；`SEGMENT_ORDER` / `totalBytes` 一字不动（`segments` 仍四段）。
//   语义：非负整数（与 `segments[].bytes` 同款 `n()` 归一化）；0 = 本轮没有渲染目录段（chat 会话 /
//   无技能），与"未记录"不做区分 —— `getPromptSegmentMeters()` 恒给出数字，不存在"未记录"这一态。

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
 * `skillCatalogBytes`：**顶层观测字段**（不在 `segments` 里，理由见其上方长注释）；缺失/非法按 0。
 * @param {{ turn?: number, seq?: number, segments?: any[], channels?: any, bySource?: any, promptTier?: any, sessionMode?: any, kb?: any, ts?: number, [key: string]: any }} [opts]
 */
export function summarizeInjection({
  turn, seq, segments, channels, bySource, promptTier, sessionMode, kb, ts, ...observed
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
    // ★ totalBytes **只**数 segments（skillCatalogBytes 是 skill 段的子集，计进来会重复计数）
    totalBytes: segs.reduce((a, s) => a + s.bytes, 0),
    // ★ 技能清单（【可用技能】段）字节 —— 顶层观测字段（不进 segments，理由见文件内长注释）。
    //   为什么不写进上面的解构列表：本函数的入参被 TS 视为 `{}`（`= {}` 这个默认值使然），
    //   **每多解构一个字段就多一条 `does not exist on type '{}'` 的欠账**（既有那 9 条已计入
    //   kit 的 T1 棘轮基线；新增一条会顶格棘轮 —— 本门禁"只许降不许升"）。故用 `...observed` 收下，
    //   用一次内联类型断言取值：既不新增欠账，也不改动既有 9 条的口径。
    skillCatalogBytes: n(/** @type {{ skillCatalogBytes?: number }} */ (observed).skillCatalogBytes),
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
