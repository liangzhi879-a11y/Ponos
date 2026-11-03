// P3 · 度量看板（纯函数，零 IO）。设计稿 §P3「度量看板」。
//
// 三个数字决定这套自愈能不能长期开着：
//   ① **复发率**：修过之后又出现的比例 —— 越高说明"修得快"只是假象；
//   ② **修复有效率**：修完 7 天内没再出现 —— 与复发率互补，但分母不同（按修复次数算，不按指纹算）；
//   ③ **打扰率**：推给用户的候选里被 dismiss 的比例 —— 目标 ≤30%，>50% 是红线（那就该少推、提阈值）。
//
// 口径纪律：**算不出来就说算不出来**（分母为 0 ⇒ 返回 null，不返回 0%）。
//   0% 会被读成"完美"，而"没有数据"和"没有复发"是两件完全不同的事。

export const METRICS_V = 1

/** 打扰率红线（设计稿：目标 ≤30%，>50% ⇒ 首屏 3→1 条并上调阈值） */
export const INTERRUPTION_TARGET = 0.3
export const INTERRUPTION_RED_LINE = 0.5

const ratio = (num, den) => (Number.isFinite(num) && Number.isFinite(den) && den > 0 ? Number((num / den).toFixed(4)) : null)

/**
 * @param {{ attribution?: {items?: object[], window?: object}, candidates?: object[], now?: string }} [o]
 *   attribution = 归因视图（含 fixes/origin 与 recurring/immediate 标记）
 *   candidates  = 候选行（state ∈ new|seen|dismissed|actioned）
 */
export function computeMetrics({ attribution = null, candidates = [], now = '' } = {}) {
  const items = Array.isArray(attribution?.items) ? attribution.items : []
  const rows = Array.isArray(candidates) ? candidates : []

  // ① 复发：只看"修过"的指纹（没修过的谈不上复发）
  let fixed = 0
  let recurring = 0
  let immediate = 0
  let fixesTotal = 0
  for (const it of items) {
    const fixes = Array.isArray(it?.fixes) ? it.fixes.length : 0
    fixesTotal += fixes
    if (!fixes) continue
    fixed += 1
    if (it.recurring === true) recurring += 1
    if (it.immediate === true) immediate += 1
  }

  // ② 修复有效率：按**修复次数**看"修完 7 天内是否又出现"。
  //    同一指纹多次修复 ⇒ 每次修复都可能复发，故分母是修复次数，分子是"没引发复发"的次数。
  //    归因层只给指纹级的 recurring/immediate（不是每次修复一份），这里按最保守口径记：
  //    一个指纹只要复发过，就把它记成"有 1 次无效修复"（宁可低估有效率，不要高估）。
  const ineffective = items.filter((it) => it?.recurring === true && (it?.fixes?.length || 0) > 0).length
  const effectiveRate = ratio(Math.max(0, fixesTotal - ineffective), fixesTotal)

  // ③ 打扰率：被 dismiss 的候选 / 已经露过面的候选（new 还没被看到，不计入分母）
  const surfaced = rows.filter((r) => r?.state === 'seen' || r?.state === 'dismissed' || r?.state === 'actioned').length
  const dismissed = rows.filter((r) => r?.state === 'dismissed').length
  const interruption = ratio(dismissed, surfaced)

  return {
    v: METRICS_V,
    generatedAt: now || null,
    window: attribution?.window ?? null,
    faults: {
      total: items.length,
      fixed,                                   // 修过的指纹数
      recurring,
      recurringRate: ratio(recurring, fixed),
      immediate,
      immediateRate: ratio(immediate, fixed),
    },
    fixes: {
      total: fixesTotal,
      effective: Math.max(0, fixesTotal - ineffective),
      effectiveRate,
    },
    interruption: {
      surfaced,
      dismissed,
      rate: interruption,
      // 只在有数据时给判定（没数据 ⇒ verdict = null，界面显示"暂无样本"而不是绿勾）
      verdict: interruption === null ? null
        : interruption > INTERRUPTION_RED_LINE ? 'red'
          : interruption > INTERRUPTION_TARGET ? 'watch' : 'ok',
    },
  }
}
