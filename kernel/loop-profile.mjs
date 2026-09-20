// LoopProfile（S2/B1）：主循环与 lane 的参数化面
// ---------------------------------------------------------------------------
// 设计要点（spec §6.1）：
//   · 只参数化「守卫序 + 注入面 + 收尾方式」，不参数化业务逻辑
//   · lane 的 250 行刻意差异（无 health / 无锚点 / 无完整 preStep）在 profile 里
//     显式表达为 false，而不是靠「不传就是没有」——否则差异会变成隐形假设
//   · validateProfile 早失败：未知守卫名/未知相位一律拒绝（避免拼错守卫名后静默失效）
//
// 与 engine.mjs 现有 `GUARD_IDS`（S1/O2 观测面）的对照（2026-09-20 实测 engine.mjs:58-70）：
//   wallClock / iterCap / stall / streamWallClock / genRepeat / nearRepeat /
//   upstreamDead / repeatHeal / repeatReminder —— 与本 profile 逐字一致；
//   `idleDeadRetry` ↔ engine 的 `idleWatchdog`、`meltdownStop` ↔ engine 的 `meltdown`
//   （同物两名，Task 2–4 搬移时须做一次命名归一）；
//   `failureHeal` / `progressRefresh` 是 engine 里**不单独登记为 GUARD_ID** 的两项
//   （失败计数 / 进展刷新），此处作为相位守卫显式列出。
//   ★ 归一动作属 Task 2–4，本任务不做（避免在契约期改可观测面）。

/** 允许的守卫名（与 engine.mjs 现有守卫逐一对齐；**主循环与 lane 同集**，见下方 profile 说明） */
export const KNOWN_GUARDS = new Set([
  // iterHead
  'wallClock', 'iterCap', 'stall',
  // inStream
  'streamWallClock', 'genRepeat', 'nearRepeat', 'idleDeadRetry', 'upstreamDead',
  // afterStream
  'repeatHeal', 'failureHeal', 'progressRefresh', 'repeatReminder', 'meltdownStop',
])

/** 允许的注入相位（S3.5 才扩 priority/budgetBytes/kind/phase；此处只列相位） */
export const PHASES = ['iterHead', 'inStream', 'afterStream']

/**
 * @typedef {object} LoopProfile
 * @property {{iterHead: string[], inStream: string[], afterStream: string[]}} guards
 * @property {{preStep: boolean, laneCompact: boolean}} compactor
 * @property {{fidelityAnchor: boolean, recordTurnContent: boolean}} health
 * @property {{pendingNext: boolean, inbox: boolean}} inject
 * @property {'loopStop'|'guardStop'} stop
 */

/** @type {LoopProfile} 主循环：全量守卫 + health + 锚点 + 完整压缩 */
export const MAIN_PROFILE = {
  guards: {
    iterHead: ['wallClock', 'iterCap', 'stall'],
    inStream: ['streamWallClock', 'genRepeat', 'nearRepeat', 'idleDeadRetry', 'upstreamDead'],
    afterStream: ['repeatHeal', 'failureHeal', 'progressRefresh', 'repeatReminder', 'meltdownStop'],
  },
  compactor: { preStep: true, laneCompact: false },
  health: { fidelityAnchor: true, recordTurnContent: true },
  inject: { pendingNext: true, inbox: false },
  stop: 'loopStop',
}

/** @type {LoopProfile} lane：**守卫集与主循环相同**；差异只在 compactor/health/inject/stop */
export const LANE_PROFILE = {
  // ★ 实测（2026-09-20，engine.mjs lane 段）lane 的守卫与主循环**逐项同集**：
  //   iterHead    ① 轮次墙钟(:1637) ② 停滞自愈→guardStop(:1640-1648) ③ 迭代上限(:1661)
  //   inStream    ①b 流内墙钟(:1714) ③/③b 重复检测 → 自愈注入上限(:1793) → guardStop(:1800)
  //               闲置/上游空流/硬停：guardStop(:1755/:1762/:1780)
  //   afterStream ⑥ 进展刷新（计数清零无注入，同主循环）⑤ 同工具提醒(:1891 repeatRemindText)
  //               ④ 熔断(:1907 errorMeltdownText('lane') / :1910-1917 meltdownNotice + guardStop)
  // ⚠️ 此前的草稿把 inStream 写成「无 nearRepeat」、afterStream 写成「仅有 repeatHeal/failureHeal」
  //    ⇒ 那是**错的**，照那样实现会**静默丢掉 lane 的 4 个守卫**（③b/⑥/⑤/④）。已按实测修正。
  guards: {
    iterHead: ['wallClock', 'iterCap', 'stall'],
    inStream: ['streamWallClock', 'genRepeat', 'nearRepeat', 'idleDeadRetry', 'upstreamDead'],
    afterStream: ['repeatHeal', 'failureHeal', 'progressRefresh', 'repeatReminder', 'meltdownStop'],
  },
  compactor: { preStep: false, laneCompact: true },
  health: { fidelityAnchor: false, recordTurnContent: false },
  inject: { pendingNext: false, inbox: true },
  stop: 'guardStop',
}

/**
 * 校验 profile 形状（纯函数，不改入参）。未知守卫名/未知相位/未知 stop 一律记错误。
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateProfile(profile) {
  const errors = []
  if (!profile || typeof profile !== 'object') return { ok: false, errors: ['profile 不是对象'] }
  const g = profile.guards
  if (!g || typeof g !== 'object') return { ok: false, errors: ['缺少 guards'] }
  for (const phase of PHASES) {
    if (!Array.isArray(g[phase])) {
      errors.push(`缺少相位或不是数组: ${phase}`)
      continue
    }
    for (const name of g[phase]) {
      if (!KNOWN_GUARDS.has(name)) errors.push(`未知守卫: ${name}（相位 ${phase}）`)
    }
  }
  for (const key of Object.keys(g)) {
    if (!PHASES.includes(key)) errors.push(`未知相位: ${key}`)
  }
  if (!['loopStop', 'guardStop'].includes(profile.stop)) errors.push(`未知 stop: ${profile.stop}`)
  return { ok: errors.length === 0, errors }
}

/**
 * 取某相位的守卫序（**副本**，防外部回写 profile）。
 * 未知相位**抛错**（早失败优于静默返回空 ⇒ 悄悄丢守卫）。
 * @returns {string[]}
 */
export function resolveGuards(profile, phase) {
  if (!PHASES.includes(phase)) throw new Error(`unknown phase: ${phase}`)
  return [...(profile?.guards?.[phase] || [])]
}
