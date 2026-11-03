/**
 * 归因聚合（P1 · Task 3）：把三源事件按 `fp` 归到一件事，并标出"修过又坏"。
 *
 * 为什么单独一层：`fp` 只说明"是同一类错误"，**变没变好**要由 `journal` 的 act/rollback 与
 * 之后是否再现来判定 —— 这就是 §4.3 R1 的复发升级，也是 §8.2 复发率/误修率的唯一来源。
 *
 * 纯函数：不读盘、不看时钟（`now` 由调用方给），因此可重放、可单测。
 */

const DAY = 86400000
const HOUR = 3600000

/** 事件里的 `at` 统一成毫秒；认不出来 ⇒ null（调用方计 dropped.badAt，不猜）。 */
function toMs(at) {
  if (typeof at === 'number' && Number.isFinite(at)) return at
  if (typeof at === 'string') {
    const t = Date.parse(at)
    return Number.isFinite(t) ? t : null
  }
  return null
}

/**
 * @param {{
 *   events?: Array<object>,
 *   candidates?: Array<object>,
 *   now?: number,
 *   windowDays?: number,
 *   recurrenceDays?: number,
 *   immediateHours?: number,
 * }} [opts]
 * @returns {{
 *   items: Array<object>,
 *   dropped: { nullFp: number, outOfWindow: number, badAt: number },
 *   window: { from: string, to: string, days: number },
 *   generatedAt: string,
 * }}
 */
export function buildAttribution({
  events = [],
  candidates = [],
  now = Date.now(),
  windowDays = 30,
  recurrenceDays = 7,
  immediateHours = 48,
} = {}) {
  const from = now - windowDays * DAY
  const dropped = { nullFp: 0, fixWithoutFp: 0, outOfWindow: 0, badAt: 0 }
  /** @type {Map<string, {origin: Array<object>, fixes: Array<any>}>} */
  const groups = new Map()
  // 探针 id → 该探针**唯一**出现过的错误指纹集合（用于给"没带 fp 的修复行"归属）
  /** @type {Map<string, Set<string>>} */
  const probeFp = new Map()
  for (const e of events) {
    const fp0 = typeof e?.fp === 'string' ? e.fp : ''
    const pid = typeof e?.probeId === 'string' ? e.probeId : ''
    if (!fp0 || !pid || e?.kind === 'act' || e?.kind === 'rollback') continue
    const set = probeFp.get(pid) ?? new Set()
    set.add(fp0)
    probeFp.set(pid, set)
  }

  for (const e of events) {
    let fp = typeof e?.fp === 'string' ? e.fp : ''
    let linkedBy = fp ? 'self' : null
    if (!fp) {
      // 修复类事件（act/rollback）没带 fp：doctor 侧不许引 kernel ⇒ 它只能靠 probeId 关联。
      // 判据刻意保守：**该探针历史上只对应过一个错误指纹**才归属；多个指纹 ⇒ ambiguous，不猜。
      if (e?.kind === 'act' || e?.kind === 'rollback') {
        const set = typeof e.probeId === 'string' ? probeFp.get(e.probeId) : null
        if (set && set.size === 1) { fp = [...set][0]; linkedBy = 'probeId' } else { dropped.fixWithoutFp += 1; continue }
      } else { dropped.nullFp += 1; continue }
    }
    const at = toMs(e.at)
    if (at === null) { dropped.badAt += 1; continue }
    if (at < from || at > now) { dropped.outOfWindow += 1; continue }
    let g = groups.get(fp)
    if (!g) { g = { origin: [], fixes: [] }; groups.set(fp, g) }
    if (e.kind === 'act') {
      g.fixes.push({
        at, iso: new Date(at).toISOString(), actionId: typeof e.actionId === 'string' ? e.actionId : null,
        ok: e.ok === true, verified: e.extra?.verified === true || e.verified === true, rolledBack: false,
        ref: e.ref ?? null,
        // 这条修复是**怎么归到这个 fp** 的：`self`=行内自带 fp；`probeId`=同探针唯一指纹反推
        linkedBy,
      })
    } else if (e.kind === 'rollback') {
      // 回滚事件不单独成 origin，只用来给同 actionId 的 fix 打标记
      for (const f of g.fixes) if (f.actionId && f.actionId === e.actionId) f.rolledBack = true
      g.origin.push({ src: e.src ?? 'journal', at, iso: new Date(at).toISOString(), ref: e.ref ?? null, snippet: e.snippet ?? '', kind: 'rollback' })
    } else {
      g.origin.push({ src: e.src ?? 'unknown', at, iso: new Date(at).toISOString(), ref: e.ref ?? null, snippet: e.snippet ?? '', kind: e.kind ?? null })
    }
  }

  const items = []
  for (const [fp, g] of groups) {
    g.origin.sort((a, b) => a.at - b.at)
    g.fixes.sort((a, b) => a.at - b.at)
    const firstAt = Math.min(...g.origin.map((o) => o.at), ...g.fixes.map((f) => f.at))
    const lastAt = Math.max(...g.origin.map((o) => o.at), ...g.fixes.map((f) => f.at))

    // R1：只认**修完之后**的再现；48h 内 = 立刻复发（也算复发）
    let recurring = false
    let immediate = false
    for (const f of g.fixes) {
      for (const o of g.origin) {
        if (o.at <= f.at) continue
        if (o.at <= f.at + recurrenceDays * DAY) recurring = true
        if (o.at <= f.at + immediateHours * HOUR) immediate = true
      }
    }

    // 候选关联：**同会话 + 证据时刻紧邻（±10 分钟）**，每条 fp 最多 5 个（按时间差升序）。
    // ★ 实测教训：① 用"证据落在 [firstAt,lastAt]"⇒ 一条 fp 关联 346 个候选（跨度大，什么都能套）；
    //   ② 只按 sessionId ⇒ 仍关联 223 个（一个会话里有几十个失败、若干候选，粒度太粗）。
    //   ⇒ 宁少勿滥：给不出紧邻证据就**不关联**（UI 上少一个跳转，比指错地方好）。
    const anchors = []
    for (const o of g.origin) {
      const ref = typeof o.ref === 'string' ? o.ref : ''
      const sid = ref.includes('#') ? ref.slice(0, ref.indexOf('#')) : ''
      if (sid) anchors.push({ sid, at: o.at })
    }
    const best = new Map()
    const NEAR_MS = 10 * 60 * 1000
    for (const c of candidates) {
      const evs = Array.isArray(c?.evidence) ? c.evidence : []
      let delta = null
      for (const x of evs) {
        if (typeof x?.sessionId !== 'string') continue
        const ts = toMs(x?.ts)
        if (ts === null) continue
        for (const a of anchors) {
          if (a.sid !== x.sessionId) continue
          const d = Math.abs(a.at - ts)
          if (d <= NEAR_MS && (delta === null || d < delta)) delta = d
        }
      }
      if (delta !== null) best.set(c, delta)
    }
    const linked = [...best.entries()]
      .sort((a, b) => a[1] - b[1] || (String(a[0].id) < String(b[0].id) ? -1 : 1))
      .slice(0, 5)
      .map(([c, d]) => ({
        id: c.id ?? null, ruleId: c.ruleId ?? null, subject: c.subject ?? null,
        linkedBy: 'session+near-time', deltaMs: d,
      }))

    const sources = [...new Set(g.origin.map((o) => o.src))].sort()
    items.push({
      fp,
      count: g.origin.length + g.fixes.length,
      originCount: g.origin.length,
      firstAt: new Date(firstAt).toISOString(),
      lastAt: new Date(lastAt).toISOString(),
      sources,
      origin: g.origin,
      fixes: g.fixes,
      candidates: linked,
      recurring,
      immediate,
    })
  }

  items.sort((a, b) => (b.count - a.count) || (a.fp < b.fp ? -1 : a.fp > b.fp ? 1 : 0))

  return {
    items,
    dropped,
    window: { from: new Date(from).toISOString(), to: new Date(now).toISOString(), days: windowDays },
    generatedAt: new Date(now).toISOString(),
  }
}
