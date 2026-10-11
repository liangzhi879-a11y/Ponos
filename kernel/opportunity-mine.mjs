// kernel/opportunity-mine.mjs —— 演化环 P1 机会挖掘（纯函数）
// ---------------------------------------------------------------------------
// 设计真源：docs/superpowers/specs/2026-10-08-runtime-evolution-loop-design.md
//   §4.3 规则 v1（OPP-1..4）/ §4.4 候选 schema / §4.5 端点口径。
// 施工 brief：docs/superpowers/plans/2026-10-09-p1-opportunity-layer.md（D2/D3/D4/D8 为已决偏离）。
//
// 纪律：
//  · 纯函数、零 IO、无时钟（now 由调用方注入）——同一输入必得同一输出（可复现、可单测）。
//  · 阈值集中一处（THRESHOLDS，冻结）；规则判定只看 TaskRecord 的**统计与引用**，
//    不读对话正文（隐私口径：报告/候选 = 统计 + 引用，不复制文本）。
//  · 空输入 = 空输出（精确 0 条，不造数据）——自举期"空窗口 = 0 条"是特性不是故障（spec §6）。
//  · id 稳定：sha256(ruleId|subject) 截断 12 位 ⇒ 跨扫描同题候选归并到同一 id（状态可继承）。
//  · score = clamp01(min(1, freqRatio/1.5) × sev(rule) × fresh)；
//    tier：≥.75 pin / ≥.60 list / 其余 collapsed（与 governance-router 的 .60/.75 词汇对齐）。
//
// 规则 v1 口径（brief D2/D3/D4；OPP-1 于 2026-10-10 降噪重定，见 THRESHOLDS 注释）：
//  · OPP-1 工具失败热点：同工具窗口内失败 ≥ K₁=5 次**且错误率 ≥ 15%**
//    （分母 = TaskRecord.tools.callsByTool 的调用数；判据依据见 THRESHOLDS 注释）。
//    subject=工具名；聚类粒度=工具名（TaskRecord 不存错误正文 ⇒"摘要前 N 字符聚类"推迟，见 brief D2）。
//  · OPP-2 技能加载后接着纠错：技能加载后 ≤ K₂=3 **轮内**出现用户纠正，同技能 ≥ K₃=2 次。
//    subject=技能 id；轮距换算用 record.turnSeq（inject_snapshot 条目 seq = 轮界）。
//  · OPP-3 同题重试：相邻用户消息字符 4-gram Jaccard ≥ 0.8（投影期算好，落 nearRepeatPairs），
//    同会话 ≥ K₃'=2 对。subject=会话 id；间隔重试不入 v1（只认相邻对）。
//  · OPP-4 守卫自愈热点：stallHeals ≥ 3 **或** errorStreakMax ≥ 5（满足其一即候选）。
//    subject=会话 id；count=stallHeals+errorStreakMax（综合强度，非单一频次——metrics 带拆分）。
import { createHash } from 'node:crypto'

export const MINE_V = 1

/** 候选状态机（§4.4）：new 新出 / seen 已看 / dismissed 忽略 / actioned 已处置 */
export const CANDIDATE_STATES = Object.freeze(['new', 'seen', 'dismissed', 'actioned'])

/** 证据引用上限（候选行体积受控；聚合计数不受限） */
export const EVIDENCE_CAP = 5

/** 频次项缩放：freqRatio=1（恰在阈值）⇒ freq=1/1.5；freqRatio≥1.5（1.5 倍阈值）⇒ freq=1 */
export const FREQ_SCALE = 1.5

/** 新鲜度下限（lastAt 过老/不可解析时不再往 0 掉，避免"大热点因旧被埋"） */
export const FRESH_FLOOR = 0.3

/** 分档阈值（可治理的三档词汇；与 governance-router DEFAULT_THRESHOLDS 的 low/med 对齐） */
export const TIER_PIN_MIN = 0.75
export const TIER_LIST_MIN = 0.6

/** 规则 → 领域词汇（kind）单一映射；THRESHOLDS 的键即规则清单 */
export const RULE_KINDS = Object.freeze({
  'OPP-1': 'tool-failure',
  'OPP-2': 'skill-correction',
  'OPP-3': 'same-task-retry',
  'OPP-4': 'guard-heal',
})

/**
 * 阈值集中一处（冻结）。K₃'=2 为 v1 自定（spec 未给，取与"≥2 次"同保守度；brief D3）。
 * sev = 严重度权重（score 的乘积因子；>1 表示该类机会更值得看）。
 *
 * ★ 2026-10-10 OPP-1 降噪重定（判据从"绝对失败次数"改为"**错误率显著高于基线**"）：
 *   实测依据（142 会话 / 9103 次工具调用 / 30d 窗口，报告见 .ponos/process/演化诊断/）：
 *     Bash 216/5005=4.32% · Edit 36/1678=2.15% · Read 22/1100=2.00%
 *     Grep 15/481=3.12% · Write 13/315=4.13%  —— 全部**≈全局基线 4.01%**；
 *     WebFetch 54/143=37.76%（基线的 9.4 倍）。
 *   旧口径 `count ≥ 5` 对上面 6 条一视同仁 ⇒ 6 条常态错误全部顶到 pin 档（score 0.996），
 *   与 spec §6「自举期候选应近零」正好相反（首日满屏）——这就是"噪声"的量化定义。
 *   新判据：**最小样本门 + 绝对错误率门**（failures ≥ 5 且 errRate ≥ 15%）。
 *     · minFailures  保最小样本（样本太小不算热点，如 OCR 1 次错）；
 *     · minErrorRate 绝对地板 15%：可直接讲给人听的量级（"每 7 次调用就错 1 次"）。
 *   ★ 为什么**不用"相对基线"**（设计过程中的两次实测负结果，留痕防回退）：
 *     ① 若基线取"全局错误率"（含被测工具自身）⇒ 该工具主导调用量时，自己的错误率≈基线，
 *        `3×基线` 永远达不到 ⇒ **真热点永远不出**（单工具项目必现的自指陷阱）；
 *     ② 改用 leave-one-out（排除自身）后，自指消失，但**多个高错误率工具会互相抬高门槛**：
 *        实测构造 Flaky 40% + Grep 20% ⇒ Flaky 的 others=20% ⇒ need=60% ⇒ 40% 反而不出；
 *        Grep 的 others=40% ⇒ need=120% ⇒ 也不出 ⇒ **整体劣化时一个都看不见**（与本判据
 *        "找异常工具"的定位相反：环境整体劣化属于 E3/守卫信号的面，不是 OPP-1 的面）。
 *     ⇒ 判定用**绝对门**（简单、可解释、无自指、不互相抬高）；基线仍算出来放 metrics
 *       （`baselineRate`/`rates`），供界面显示"是基线的 9.4 倍"——**信息给用户，判定保持简单**。
 *   实测校验（15% 门）：WebFetch 37.76% ≥ 15% ⇒ 命中（真热点留下）；
 *             Bash 4.32% / Edit 2.15% / Read 2.00% / Grep 3.12% / Write 4.13% ⇒ 全部不命中
 *             （噪声去掉）；OCR 11.11% 因 minFailures 门被挡（1 次错，样本不足）。
 */
export const THRESHOLDS = Object.freeze({
  'OPP-1': Object.freeze({ minFailures: 5, minErrorRate: 0.15, sev: 1.0 }),
  'OPP-2': Object.freeze({ withinTurns: 3, minHits: 2, sev: 1.2 }),
  'OPP-3': Object.freeze({ similarity: 0.8, minPairs: 2, sev: 0.9 }),
  'OPP-4': Object.freeze({ minStallHeals: 3, minErrorStreak: 5, sev: 1.1 }),
})

const DAY_MS = 86400000
const num = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)
const seqOf = (v) => (Number.isInteger(v) && v >= 0 ? v : null)
const clamp01 = (n) => {
  const v = Number(n)
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0
}
const earlierOf = (a, b) => {
  if (typeof b !== 'string' || !b) return a || null
  if (!a) return b
  return b < a ? b : a
}
const laterOf = (a, b) => {
  if (typeof b !== 'string' || !b) return a || null
  if (!a) return b
  return b > a ? b : a
}

/** 候选 id：sha256(ruleId|subject) 截断 12 位（稳定、与扫描时间无关） */
export function candidateIdOf(ruleId, subject) {
  return createHash('sha256').update(`${ruleId}|${subject}`).digest('hex').slice(0, 12)
}

/**
 * 新鲜度 ∈ [FRESH_FLOOR, 1]：1 − ageDays/windowDays；lastAt 不可解析/now 缺失 ⇒ 落下限
 * （保守，不虚高——brief D4）。
 */
export function freshnessOf(lastAt, { nowMs, windowDays }) {
  const t = Date.parse(String(lastAt ?? ''))
  if (!Number.isFinite(t) || !Number.isFinite(nowMs) || !(Number(windowDays) > 0)) return FRESH_FLOOR
  const ageDays = Math.max(0, (nowMs - t) / DAY_MS)
  return Math.max(FRESH_FLOOR, clamp01(1 - ageDays / Number(windowDays)))
}

/** score = clamp01(min(1, freqRatio/1.5) × sev × fresh)（4 位小数，稳定序列化） */
export function scoreOf({ freqRatio, sev, fresh }) {
  const fr = Number.isFinite(freqRatio) && freqRatio > 0 ? freqRatio : 0
  return Number((clamp01(Math.min(1, fr / FREQ_SCALE) * Number(sev) * clamp01(fresh))).toFixed(4))
}

/** 分档：≥.75 pin / ≥.60 list / 其余 collapsed */
export function tierOf(score) {
  const s = Number(score) || 0
  if (s >= TIER_PIN_MIN) return 'pin'
  if (s >= TIER_LIST_MIN) return 'list'
  return 'collapsed'
}

/** seq → 轮序（turnSeq=每轮 inject_snapshot 的条目 seq，升序；轮序=≤seq 的轮界条数） */
function turnIndexOf(seq, turnSeq) {
  let n = 0
  for (const t of turnSeq) if (t <= seq) n++
  return n
}

/** 候选行构造（字段全部可溯源；evidence 引用去文本化——只有 sessionId/seq/ts） */
function buildCandidate(ruleId, subject, ctx, { count, freqRatio, refs, firstAt, lastAt, metrics }) {
  const th = THRESHOLDS[ruleId]
  const fresh = freshnessOf(lastAt, { nowMs: ctx.nowMs, windowDays: ctx.windowDays })
  return {
    v: MINE_V,
    id: candidateIdOf(ruleId, subject),
    ruleId,
    kind: RULE_KINDS[ruleId],
    subject,
    score: scoreOf({ freqRatio, sev: th.sev, fresh }),
    count: num(count),
    metrics: metrics && typeof metrics === 'object' ? metrics : {},
    window: { from: ctx.window.from, to: ctx.window.to, days: ctx.windowDays },
    evidence: (Array.isArray(refs) ? refs : []).slice(0, EVIDENCE_CAP)
      .map((r) => ({ sessionId: typeof r?.sessionId === 'string' ? r.sessionId : null, seq: seqOf(r?.seq), ts: typeof r?.ts === 'string' && r.ts ? r.ts : null })),
    firstAt: firstAt || null,
    lastAt: lastAt || null,
    state: 'new',
  }
}

/**
 * 规则 v1 挖掘。窗口裁剪责任在上游（--window 已裁 entry 流；mine 只做规则判定）——
 * opts.window 只随行记录口径，不再二次裁窗。
 *
 * @param {object[]} records TaskRecord[]（trace-project.mjs 产物）
 * @param {{window?: {from?: string, to?: string, days?: number}, now?: string}} [opts]
 *   now = ISO 时刻（新鲜度基准；缺省/不可解析 ⇒ 新鲜度落下限）
 * @returns {object[]} 候选行（确定性排序：score 降序 → id 升序；空输入=[]）
 */
export function mineCandidates(records, { window: win = {}, now = '' } = {}) {
  const list = Array.isArray(records) ? records : []
  const windowDays = num(win?.days) || 30
  const nowMs = Date.parse(String(now || ''))
  const ctx = {
    window: { from: win?.from || null, to: win?.to || null, days: windowDays },
    windowDays,
    nowMs,
  }
  const out = []

  // ── OPP-1 工具失败热点（subject=工具名；**错误率显著高于基线**，见 THRESHOLDS 注释）──────
  // 分子（errors）与分母（callsByTool）必须来自**同一批记录**：只计两侧都有的会话，
  // 否则旧版投影（无 callsByTool）会只贡献分子 ⇒ 基线被低估、错误率被抬高 ⇒ 造假热点。
  const failAgg = new Map()
  const callAgg = new Map()
  let callsKnown = 0
  for (const r of list) {
    const cbt = Array.isArray(r?.tools?.callsByTool) ? r.tools.callsByTool : null
    if (!cbt) continue
    callsKnown++
    for (const c of cbt) {
      const tool = String(c?.tool || '')
      if (!tool) continue
      callAgg.set(tool, (callAgg.get(tool) || 0) + num(c.count))
    }
    for (const f of r?.tools?.errors || []) {
      const tool = String(f?.tool || '')
      if (!tool) continue
      const cur = failAgg.get(tool) || { tool, count: 0, sessions: 0, refs: [], firstAt: null, lastAt: null }
      cur.count += num(f.count)
      cur.sessions += 1
      if (f.firstRef && cur.refs.length < EVIDENCE_CAP) cur.refs.push(f.firstRef)
      cur.firstAt = earlierOf(cur.firstAt, f?.firstRef?.ts)
      cur.lastAt = laterOf(cur.lastAt, f?.firstRef?.ts)
      failAgg.set(tool, cur)
    }
  }
  {
    const th = THRESHOLDS['OPP-1']
    let totalCalls = 0
    for (const v of callAgg.values()) totalCalls += v
    let totalErrs = 0
    for (const a of failAgg.values()) totalErrs += a.count
    const globalRate = totalCalls > 0 ? totalErrs / totalCalls : 0
    for (const a of failAgg.values()) {
      if (a.count < th.minFailures) continue
      const n = callAgg.get(a.tool) || 0
      if (n <= 0) continue // 无分母 ⇒ 算不出率：不猜（宁可漏，不可造假热点）
      const errRate = a.count / n
      // 绝对门（不做相对基线判定，理由见 THRESHOLDS 注释的两次实测负结果）
      const needRate = th.minErrorRate
      if (errRate < needRate) continue
      out.push(buildCandidate('OPP-1', a.tool, ctx, {
        count: a.count,
        // 强度 = 错误率相对**命中阈值**的倍数（恰在阈值 = 1 ⇒ list 档；越显著才顶到 pin，
        // 与既有 freqRatio 语义一致——阈值处不 pin）
        freqRatio: errRate / needRate,
        refs: a.refs,
        firstAt: a.firstAt,
        lastAt: a.lastAt,
        metrics: {
          sessions: a.sessions,
          calls: n,
          errRate: Number(errRate.toFixed(4)),
          // 基线只作**展示**（"是基线的 N 倍"），不参与判定
          baselineRate: Number(globalRate.toFixed(4)),
          needRate: Number(needRate.toFixed(4)),
          callsKnownSessions: callsKnown,
          totalSessions: list.length,
        },
      }))
    }
  }

  // ── OPP-2 技能加载后接着纠错（subject=技能 id；≤3 轮内、≥2 次）─────────────
  // 命中口径 = **不同纠正次数**：同一纠正若落在同技能多次加载的窗口内只算 1 次
  // （先按 (会话 × 技能) 归集纠正 seq，去重后再并入全局计数）。
  const skillAgg = new Map()
  for (const r of list) {
    const loads = Array.isArray(r?.skills?.loads) ? r.skills.loads : []
    if (!loads.length) continue
    const turnSeq = (Array.isArray(r?.turnSeq) ? r.turnSeq : []).map(seqOf).filter((v) => v !== null)
    if (!turnSeq.length) continue // 无轮界 ⇒ 轮距不可算，跳过（不猜）
    const corrections = Array.isArray(r?.corrections) ? r.corrections : []
    const hits = new Map() // skillId → Map(cSeq → turnRef)
    for (const load of loads) {
      const loadSeq = seqOf(load?.seq)
      const skillId = String(load?.id || '')
      if (loadSeq === null || !skillId) continue
      const loadTurn = turnIndexOf(loadSeq, turnSeq)
      for (const c of corrections) {
        const cSeq = seqOf(c?.turnRef?.seq)
        if (cSeq === null || cSeq <= loadSeq) continue // 纠正必须发生在加载之后
        if (turnIndexOf(cSeq, turnSeq) - loadTurn > THRESHOLDS['OPP-2'].withinTurns) continue
        if (!hits.has(skillId)) hits.set(skillId, new Map())
        const m = hits.get(skillId)
        if (!m.has(cSeq)) m.set(cSeq, c.turnRef)
      }
    }
    for (const [skillId, m] of hits) {
      const cur = skillAgg.get(skillId) || { id: skillId, count: 0, refs: [], firstAt: null, lastAt: null }
      for (const ref of m.values()) {
        cur.count++
        if (ref && cur.refs.length < EVIDENCE_CAP) cur.refs.push(ref)
        cur.firstAt = earlierOf(cur.firstAt, ref?.ts)
        cur.lastAt = laterOf(cur.lastAt, ref?.ts)
      }
      skillAgg.set(skillId, cur)
    }
  }
  for (const a of skillAgg.values()) {
    if (a.count < THRESHOLDS['OPP-2'].minHits) continue
    out.push(buildCandidate('OPP-2', a.id, ctx, {
      count: a.count,
      freqRatio: a.count / THRESHOLDS['OPP-2'].minHits,
      refs: a.refs,
      firstAt: a.firstAt,
      lastAt: a.lastAt,
      metrics: {},
    }))
  }

  // ── OPP-3 同题重试（subject=会话 id；Jaccard ≥0.8 的相邻对 ≥2）─────────────
  for (const r of list) {
    const pairs = Array.isArray(r?.nearRepeatPairs) ? r.nearRepeatPairs : []
    const qual = pairs.filter((p) => Number.isFinite(p?.similarity) && p.similarity >= THRESHOLDS['OPP-3'].similarity)
    if (qual.length < THRESHOLDS['OPP-3'].minPairs) continue
    const sid = String(r?.sessionId || '')
    if (!sid) continue
    const refs = qual.slice(0, EVIDENCE_CAP).map((p) => ({ sessionId: sid, seq: seqOf(p.secondSeq) ?? seqOf(p.firstSeq), ts: null }))
    out.push(buildCandidate('OPP-3', sid, ctx, {
      count: qual.length,
      freqRatio: qual.length / THRESHOLDS['OPP-3'].minPairs,
      refs,
      firstAt: typeof r.startedAt === 'string' && r.startedAt ? r.startedAt : null,
      lastAt: typeof r.endedAt === 'string' && r.endedAt ? r.endedAt : null,
      metrics: { maxSimilarity: Number(Math.max(...qual.map((p) => p.similarity)).toFixed(4)) },
    }))
  }

  // ── OPP-4 守卫自愈热点（subject=会话 id；stallHeals≥3 或 errorStreak≥5）────
  for (const r of list) {
    const g = r?.guard
    if (!g) continue
    const stallHeals = num(g.stallHeals)
    const errorStreakMax = num(g.errorStreakMax)
    const triggered = stallHeals >= THRESHOLDS['OPP-4'].minStallHeals || errorStreakMax >= THRESHOLDS['OPP-4'].minErrorStreak
    if (!triggered) continue
    const sid = String(r?.sessionId || '')
    if (!sid) continue
    // 强度 = 两信号按各自阈值归一后取大（满足其一即 ≥1）
    const freqRatio = Math.max(stallHeals / THRESHOLDS['OPP-4'].minStallHeals, errorStreakMax / THRESHOLDS['OPP-4'].minErrorStreak)
    const refs = g.firstRef ? [g.firstRef] : []
    out.push(buildCandidate('OPP-4', sid, ctx, {
      count: stallHeals + errorStreakMax,
      freqRatio,
      refs,
      firstAt: earlierOf(g?.firstRef?.ts, r.startedAt),
      lastAt: laterOf(g?.firstRef?.ts, r.endedAt),
      metrics: { stallHeals, errorStreakMax, worstLevel: num(g.worstLevel) },
    }))
  }

  out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  return out
}

/**
 * 候选行归并（唯一真源；读侧与 store 的 compact 同用此口径）：
 * append-only JSONL 行 → 按 id **字段级**合并（后行覆盖先行；state 行只动 state/ts），
 * 坏行跳过并计数（空白行=格式噪声，不计坏行）。排序确定：score 降序 → id 升序。
 *
 * @param {(string|object)[]} lines
 * @returns {{candidates: object[], bad: number}}
 */
export function mergeCandidateLines(lines) {
  const merged = new Map()
  let bad = 0
  for (const raw of Array.isArray(lines) ? lines : []) {
    let row = raw
    if (typeof raw === 'string') {
      const t = raw.trim()
      if (!t) continue
      try { row = JSON.parse(t) } catch { row = null }
    }
    if (!isValidCandidateRow(row)) { bad++; continue }
    merged.set(row.id, { ...(merged.get(row.id) || {}), ...row })
  }
  const candidates = [...merged.values()]
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || String(a.id).localeCompare(String(b.id)))
  return { candidates, bad }
}

function isValidCandidateRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false
  if (typeof row.id !== 'string' || !row.id) return false
  if (row.state !== undefined && !CANDIDATE_STATES.includes(row.state)) return false
  return true
}

/**
 * 扫描落盘计划（brief D8）：新 id ⇒ 整行落（state='new'）；已知 id ⇒ **继承最新 state**
 * （dismissed/actioned 不复活）、仅当 count/score 有变才落（防 JSONL 膨胀）。
 *
 * @param {object[]} mined mineCandidates 结果
 * @param {Map<string,object>|Record<string,object>} latestById mergeCandidateLines 结果按 id 索引
 * @returns {object[]} 待 append 的整行
 */
export function planScanAppends(mined, latestById) {
  const get = latestById instanceof Map ? (id) => latestById.get(id) : (id) => (latestById || {})[id]
  const rows = []
  for (const c of Array.isArray(mined) ? mined : []) {
    const prev = get(c.id)
    if (!prev) { rows.push({ ...c }); continue }
    if (prev.count === c.count && prev.score === c.score) continue
    const state = CANDIDATE_STATES.includes(prev.state) ? prev.state : 'new'
    rows.push({ ...c, state })
  }
  return rows
}
