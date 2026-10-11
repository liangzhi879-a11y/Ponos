// kernel/trace-project.mjs —— 演化环 P0 观测投影器（纯函数）
// ---------------------------------------------------------------------------
// 设计真源：docs/superpowers/specs/2026-10-08-runtime-evolution-loop-design.md §4.1。
// 输入 = collectTranscriptFiles() 的 entry 流（每 entry 已注入 sessionId/project）；
// 输出 = TaskRecord[]（会话级）+ 窗口级汇总（失败热点/技能命中/纠正率基线数字）。
//
// 纪律：
//  · 纯函数（无 IO；时间由调用方注入）——便于单测与"空集合判红"。
//  · 不伪造：无证据的字段落 null / 'unknown'，不猜测（沿用 readonly.mjs 归属字段纪律）。
//  · 空输入 = 空输出（精确 0 条，不造数据）；聚合排序确定（同值按 id 升序）。
//  · 纠错模式**单一真源** = fidelity.mjs#detectUserCorrection（不另抄一份正则）。
//
// P1 增补字段（additive，v 仍 1；brief docs/superpowers/plans/2026-10-09-p1-opportunity-layer.md D1）：
//  · turnSeq：轮界条目 seq 列表（inject_snapshot 的 seq）——OPP-2 轮距换算用。
//  · skills.loads：每次**成功**加载的 {id,seq,ts}——技能加载发生在哪一轮可回跳。
//  · nearRepeatPairs：相邻真用户文本的 4-gram 相似对 {firstSeq,secondSeq,similarity}
//    ——只落 seq 与分值，**不落文本**（隐私口径）；系统注入不算"用户相邻"。
//  · guard.firstRef：首条 guard_turn 条目 ref——守卫热点证据锚点。
//  · tools.callsByTool：按工具统计**调用**次数（2026-10-10 加，additive）——错误率的分母。
//    为什么必须按工具分：既有的 tools.calls 只有**总数** ⇒ "Bash 失败 215 次"分不清
//    "调 300 次错 215"（真热点）与"调 5000 次错 215"（常态噪声）。P1 上线首日实测正是
//    后者被判成 0.996 直接 pin 档（与 spec §6"自举期候选应近零"相反）⇒ 判据需要错误率。
//    投影只提供**事实**（调用数），阈值与判定仍在 opportunity-mine（规则唯一真源）。
import { detectUserCorrection } from './fidelity.mjs'
// 自愈阶梯级名 → 序数的**单一真源**（L0–L4；不另抄一份映射）
import { HEAL_LEVELS } from './heal-ladder.mjs'
// 归一化 + Jaccard 复用 gen-guards 的既有导出（不另抄一份）
import { nrNorm, nrJaccard } from './gen-guards.mjs'

export const TASK_RECORD_V = 1

// 近重复对（OPP-3 投影期口径）：字符 4-gram；两侧归一化长度均 ≥ NR4_MIN_CHARS 才计算
// （短消息 gram 集过小会虚假高相似——如两条各 4 字的消息仅 1 个 gram，相同即 1.0）。
// 阈值（≥0.8）判定在 opportunity-mine（规则唯一真源），此处只算分值。
const NR4_K = 4
const NR4_MIN_CHARS = 8

function kGramsOf(s, k) {
  const set = new Set()
  for (let i = 0; i <= s.length - k; i++) set.add(s.slice(i, i + k))
  return set
}

/** 相邻真用户文本相似度（0..1；任一侧过短 ⇒ 0，不猜） */
function nearRepeatSimilarity(normA, normB) {
  if (normA.length < NR4_MIN_CHARS || normB.length < NR4_MIN_CHARS) return 0
  return Number(nrJaccard(kGramsOf(normA, NR4_K), kGramsOf(normB, NR4_K)).toFixed(4))
}

// transcript 里"引擎发起的单行注入"与真用户发言同为 user 条目（appendSystemUser 实现），
// 按展示前缀剔除——它们是系统注入，不是"用户纠正"。同族先例：server/transcript.mjs 展示过滤。
const SYSTEM_INJECT_PREFIXES = ['【系统】', '【提示】', '【主 Agent 消息】', '<compacted-summary>']

// 预留的取消证据 kind（现行写侧无此 kind；出现即认 aborted，不伪造"一定没有"）。
const ABORT_KINDS = new Set(['abort', 'aborted', 'cancel', 'cancelled'])

const num = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)
const tsOf = (e) => (typeof e?.timestamp === 'string' ? e.timestamp : '')
const isMeta = (e, kind) => e?.type === 'meta' && String(e.kind || '') === kind
const blocksOf = (e) => (Array.isArray(e?.message?.content) ? e.message.content : [])
const refOf = (e, sessionId) => ({ sessionId, seq: e?.seq ?? null, ts: tsOf(e) })

/** 失败聚合的空形状（sessions 字段只在窗口汇总层加，记录层不带） */
function freshFail() { return { tool: '', count: 0, firstRef: null } }

/**
 * 一个会话的 entry 序列 → TaskRecord（v1 schema，字段全部可溯源）。
 * @param {string} sessionId
 * @param {object[]} list 同一会话的 entries（写入顺序）
 */
export function projectSession(sessionId, list) {
  const arr = Array.isArray(list) ? list : []
  const project = String(arr[0]?.project || '')
  const startedAt = tsOf(arr[0]) || null
  const endedAt = tsOf(arr[arr.length - 1]) || null

  // ── 血缘（P-d subtask_meta；缺失 = main）────────────────────────────────────
  const subMeta = arr.find((e) => isMeta(e, 'subtask_meta'))
  const kind = subMeta ? 'subagent' : 'main'
  const parentTaskId = subMeta && typeof subMeta.parentTaskId === 'string' && subMeta.parentTaskId ? subMeta.parentTaskId : null

  // ── mode / model ────────────────────────────────────────────────────────────
  let mode = null
  for (const e of arr) {
    if (!isMeta(e, 'loop_mode')) continue
    const v = e.effective ?? e.value
    if (typeof v === 'string' && v) mode = v
  }
  let model = null
  for (const e of arr) {
    if (e?.type === 'assistant' && e.kind !== 'compaction' && typeof e.message?.model === 'string' && e.message.model) model = e.message.model
  }

  // ── turns：优先"轮末台账条数"（cli 每轮一条 inject_snapshot）；旧会话无台账则退化 = assistant 条目数
  // turnSeq（P1）：轮界条目 seq 列表（升序，与条目写入顺序一致）——OPP-2 轮距换算用。
  let snapshotCount = 0
  let assistantCount = 0
  const turnSeq = []
  for (const e of arr) {
    if (isMeta(e, 'inject_snapshot')) {
      snapshotCount++
      if (Number.isInteger(e.seq)) turnSeq.push(e.seq)
    } else if (e?.type === 'assistant' && e.kind !== 'compaction') assistantCount++
  }
  const turns = snapshotCount > 0 ? snapshotCount : assistantCount

  // ── tools（tool_use/tool_result 按 id join；join 不到落 'unknown'，不伪造名字）──
  const toolNameById = new Map()
  // callsByTool（2026-10-10，additive）：按工具统计调用数 = 错误率的分母（见文件头）。
  const callAgg = new Map()
  let calls = 0
  for (const e of arr) {
    if (e?.type !== 'assistant' || e.kind === 'compaction') continue
    for (const b of blocksOf(e)) {
      if (b?.type === 'tool_use' && typeof b.id === 'string') {
        calls++
        const name = typeof b.name === 'string' && b.name ? b.name : 'unknown'
        toolNameById.set(b.id, name)
        callAgg.set(name, (callAgg.get(name) || 0) + 1)
      }
    }
  }
  const errAgg = new Map()
  for (const e of arr) {
    if (e?.type !== 'user') continue
    for (const b of blocksOf(e)) {
      if (b?.type !== 'tool_result' || b.is_error !== true) continue
      const tool = toolNameById.get(b.tool_use_id) || 'unknown'
      const cur = errAgg.get(tool) || { ...freshFail(), tool }
      cur.count++
      if (!cur.firstRef) cur.firstRef = refOf(e, sessionId)
      errAgg.set(tool, cur)
    }
  }
  const errors = [...errAgg.values()].sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
  // 调用数按工具（降序；同值按名升序 —— 与 errors 同款确定性排序，便于比对与复现）
  const callsByTool = [...callAgg.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
  const distinct = new Set([...toolNameById.values()]).size

  // ── approvals（P-b approval_decision 聚合；timeout/cancel 现行写侧不产，数不出=0）──
  let asked = 0
  let allowed = 0
  let denied = 0
  let timeout = 0
  for (const e of arr) {
    if (!isMeta(e, 'approval_decision')) continue
    asked++
    if (e.behavior === 'allow') allowed++
    else if (e.behavior === 'deny') denied++
    else if (e.behavior === 'timeout') timeout++
  }

  // ── corrections（真用户文本 × fidelity 强信号；系统注入/tool_result 剔除）──
  // 同一次遍历收集"真用户文本"序列：corrections 与相邻近重复对（P1）共用同一过滤口径。
  const userTexts = []
  const corrections = []
  for (const e of arr) {
    if (e?.type !== 'user' || typeof e.message?.content !== 'string') continue
    const text = e.message.content
    if (!text || SYSTEM_INJECT_PREFIXES.some((p) => text.startsWith(p))) continue
    userTexts.push({ seq: Number.isInteger(e.seq) ? e.seq : null, norm: nrNorm(text) })
    const r = detectUserCorrection(text)
    if (r.corrected) corrections.push({ turnRef: refOf(e, sessionId), pattern: r.phrases.join(',') })
  }
  // 相邻真用户文本对的 4-gram 相似度（只落 seq 与分值，不落文本——隐私口径）
  const nearRepeatPairs = []
  for (let i = 1; i < userTexts.length; i++) {
    nearRepeatPairs.push({
      firstSeq: userTexts[i - 1].seq,
      secondSeq: userTexts[i].seq,
      similarity: nearRepeatSimilarity(userTexts[i - 1].norm, userTexts[i].norm),
    })
  }

  // ── skills（loaded：成功加载的 Skill 调用；triggerHits：P-c meta）──
  const skillCalls = []
  for (const e of arr) {
    if (e?.type !== 'assistant' || e.kind === 'compaction') continue
    for (const b of blocksOf(e)) {
      if (b?.type === 'tool_use' && b.name === 'Skill' && typeof b.input?.skill === 'string' && b.input.skill) {
        skillCalls.push({ id: b.id, skill: b.input.skill, seq: Number.isInteger(e.seq) ? e.seq : null, ts: tsOf(e) })
      }
    }
  }
  const resErrIds = new Set()
  const resOkIds = new Set()
  for (const e of arr) {
    if (e?.type !== 'user') continue
    for (const b of blocksOf(e)) {
      if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
      if (b.is_error === true) resErrIds.add(b.tool_use_id)
      else resOkIds.add(b.tool_use_id)
    }
  }
  const loadedMap = new Map()
  const loads = [] // P1：每次成功加载带 {id,seq,ts}——技能加载发生在哪一轮可回跳
  for (const c of skillCalls) {
    // 失败加载不算"使用"；无结果（截断/未执行）同样不计——只认确凿的成功
    if (resErrIds.has(c.id) || !resOkIds.has(c.id)) continue
    loadedMap.set(c.skill, (loadedMap.get(c.skill) || 0) + 1)
    loads.push({ id: c.skill, seq: c.seq, ts: c.ts })
  }
  const hitMap = new Map()
  for (const e of arr) {
    if (isMeta(e, 'skill_trigger_hit') && typeof e.id === 'string' && e.id) hitMap.set(e.id, (hitMap.get(e.id) || 0) + 1)
  }
  const skillIds = new Set([...loadedMap.keys(), ...hitMap.keys()])
  const byCountDesc = (a, b) => b.count - a.count || a.id.localeCompare(b.id)
  const skills = {
    loaded: [...skillIds].map((id) => ({ id, count: loadedMap.get(id) || 0 })).filter((s) => s.count > 0).sort(byCountDesc),
    triggerHits: [...skillIds].map((id) => ({ id, count: hitMap.get(id) || 0 })).filter((s) => s.count > 0).sort(byCountDesc),
    loads,
  }

  // ── loop（loop_mode metas 派生；escalations = 生效模式变更次数，v1 口径）──
  const modeSeq = []
  for (const e of arr) {
    if (!isMeta(e, 'loop_mode')) continue
    const v = e.effective ?? e.value
    if (typeof v === 'string' && v) modeSeq.push(v)
  }
  const modes = modeSeq.filter((v, i) => i === 0 || v !== modeSeq[i - 1])
  const escalations = Math.max(0, modes.length - 1)

  // ── inject（取末条 inject_snapshot 的当前态；口径注：非跨轮求和）──
  let inject = null
  for (const e of arr) {
    if (!isMeta(e, 'inject_snapshot')) continue
    const bySource = {}
    for (const [k, v] of Object.entries(e.bySource && typeof e.bySource === 'object' ? e.bySource : {})) bySource[k] = num(v)
    inject = { totalBytes: num(e.totalBytes), bySource }
  }

  // ── guard（P-a guard_turn metas 取峰值；无记录 = null，不造 0 假）──
  // level 在 meta 里是字面级名（'L0'..'L4'，heal-ladder 单一真源）；投影转序数（0-4）。
  // firstRef（P1）：首条 guard_turn 条目 ref——守卫热点候选的证据锚点。
  let guard = null
  if (arr.some((e) => isMeta(e, 'guard_turn'))) {
    let worstLevel = -1
    let stallHeals = 0
    let errorStreakMax = 0
    let repeatStreakMax = 0
    let firstRef = null
    for (const e of arr) {
      if (!isMeta(e, 'guard_turn')) continue
      if (!firstRef) firstRef = refOf(e, sessionId)
      const lv = typeof e.level === 'string' && e.level in HEAL_LEVELS ? HEAL_LEVELS[e.level] : -1
      worstLevel = Math.max(worstLevel, lv)
      stallHeals = Math.max(stallHeals, num(e.stallHeals))
      errorStreakMax = Math.max(errorStreakMax, num(e.errorStreak))
      repeatStreakMax = Math.max(repeatStreakMax, num(e.repeatStreak))
    }
    guard = { worstLevel: worstLevel < 0 ? 0 : worstLevel, stallHeals, errorStreakMax, repeatStreakMax, firstRef }
  }

  // ── outcome（三态不退化：aborted 认显式证据；error 认尾轮证据；纯文本收束 = ok；其余 unknown）──
  let aborted = false
  for (const e of arr) {
    if (e?.type === 'meta' && ABORT_KINDS.has(String(e.kind || ''))) aborted = true
  }
  let lastAssistant = -1
  for (let i = arr.length - 1; i >= 0; i--) {
    const e = arr[i]
    if (e?.type === 'assistant' && e.kind !== 'compaction') { lastAssistant = i; break }
  }
  let outcome
  if (aborted) {
    outcome = 'aborted'
  } else if (lastAssistant < 0) {
    outcome = 'unknown'
  } else {
    const hasToolUse = blocksOf(arr[lastAssistant]).some((b) => b?.type === 'tool_use')
    let tailResults = 0
    let tailErrors = 0
    let userTextAfter = false
    for (let i = lastAssistant + 1; i < arr.length; i++) {
      const e = arr[i]
      if (e?.type === 'meta' || e?.type === 'thinking' || e?.type === 'assistant') continue
      if (e?.type !== 'user') continue
      const trs = blocksOf(e).filter((b) => b?.type === 'tool_result')
      if (trs.length) {
        tailResults += trs.length
        tailErrors += trs.filter((b) => b.is_error === true).length
      } else if (typeof e.message?.content === 'string') {
        userTextAfter = true
      }
    }
    if (tailErrors > 0) outcome = 'error'
    else if (tailResults > 0) outcome = 'unknown' // 有工具轨迹但无收束（截断/进程终止）
    else if (hasToolUse) outcome = 'unknown' // 发了工具调用、结果未落盘
    else if (userTextAfter) outcome = 'unknown' // 用户又发言、模型未回应
    else outcome = 'ok' // 纯文本正常收束
  }

  return {
    v: TASK_RECORD_V,
    sessionId,
    taskId: sessionId,
    parentTaskId,
    kind,
    project,
    mode,
    model,
    startedAt,
    endedAt,
    turns,
    turnSeq,
    outcome,
    tools: { calls, distinct, errors, callsByTool },
    approvals: { asked, allowed, denied, timeout },
    corrections,
    nearRepeatPairs,
    skills,
    loop: { modes, escalations },
    inject,
    guard,
  }
}

/** entry 流 → TaskRecord[]（按 sessionId 分组；排序确定：startedAt → sessionId） */
export function projectRecords(entries) {
  const bySession = new Map()
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e !== 'object') continue
    const sid = String(e.sessionId || '')
    if (!bySession.has(sid)) bySession.set(sid, [])
    bySession.get(sid).push(e)
  }
  const records = []
  for (const [sid, list] of bySession) records.push(projectSession(sid, list))
  records.sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')) || a.sessionId.localeCompare(b.sessionId))
  return records
}

/**
 * 窗口级汇总（基线数字：失败热点 failures / 技能命中 skills / 纠正率 corrections*）。
 * @param {object[]} records
 * @param {{window?: {from?: string, to?: string, days?: number}}} [opts]
 */
export function summarizeRecords(records, { window: win = {} } = {}) {
  const list = Array.isArray(records) ? records : []
  const totals = { sessions: list.length, main: 0, subagent: 0, turns: 0 }
  const outcomes = { ok: 0, error: 0, aborted: 0, unknown: 0 }
  const failAgg = new Map()
  const skillAgg = new Map()
  let correctionsTotal = 0
  let injectTotalBytes = 0
  const injectBySource = {}
  let guardSessions = 0
  let stallHealsTotal = 0
  let worstLevelMax = 0
  for (const r of list) {
    if (r.kind === 'main') totals.main++
    else if (r.kind === 'subagent') totals.subagent++
    totals.turns += num(r.turns)
    if (r.outcome && outcomes[r.outcome] !== undefined) outcomes[r.outcome]++
    for (const f of r.tools?.errors || []) {
      const cur = failAgg.get(f.tool) || { ...freshFail(), tool: f.tool, sessions: 0 }
      cur.count += num(f.count)
      cur.sessions += 1
      if (!cur.firstRef && f.firstRef) cur.firstRef = f.firstRef
      failAgg.set(f.tool, cur)
    }
    for (const s of r.skills?.loaded || []) {
      const cur = skillAgg.get(s.id) || { id: s.id, loaded: 0, triggerHits: 0 }
      cur.loaded += num(s.count)
      skillAgg.set(s.id, cur)
    }
    for (const s of r.skills?.triggerHits || []) {
      const cur = skillAgg.get(s.id) || { id: s.id, loaded: 0, triggerHits: 0 }
      cur.triggerHits += num(s.count)
      skillAgg.set(s.id, cur)
    }
    correctionsTotal += (r.corrections || []).length
    if (r.inject) {
      injectTotalBytes += num(r.inject.totalBytes)
      for (const [k, v] of Object.entries(r.inject.bySource || {})) injectBySource[k] = num(injectBySource[k]) + num(v)
    }
    if (r.guard) {
      guardSessions++
      stallHealsTotal += num(r.guard.stallHeals)
      worstLevelMax = Math.max(worstLevelMax, num(r.guard.worstLevel))
    }
  }
  return {
    totals,
    outcomes,
    failures: [...failAgg.values()].sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool)),
    skills: [...skillAgg.values()].sort((a, b) => b.loaded + b.triggerHits - (a.loaded + a.triggerHits) || a.id.localeCompare(b.id)),
    correctionsTotal,
    // 基线"纠正率"（v1 口径）：每会话平均纠正次数。分母为 0 时 = 0（不 NaN）。
    correctionsRate: list.length ? Number((correctionsTotal / list.length).toFixed(4)) : 0,
    inject: { totalBytes: injectTotalBytes, bySource: injectBySource },
    guard: { sessionsWithHeals: guardSessions, stallHealsTotal, worstLevelMax },
    window: { from: win.from || null, to: win.to || null, days: num(win.days) },
  }
}

/** 报告产物（TaskRecord[] + 汇总，人可读；§4.1） */
export function buildEvolutionReport(entries, { window: win = {}, now = '' } = {}) {
  const records = projectRecords(entries)
  const summary = summarizeRecords(records, { window: win })
  return {
    v: TASK_RECORD_V,
    generatedAt: typeof now === 'string' && now ? now : null,
    window: summary.window,
    records,
    summary,
  }
}
