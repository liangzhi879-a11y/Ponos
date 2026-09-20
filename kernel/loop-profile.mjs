// LoopProfile（S2/B1）：主循环与 lane 的参数化面
// ---------------------------------------------------------------------------
// 设计要点（spec §6.1）：
//   · 只参数化「守卫序 + 注入面 + 收尾方式」，不参数化业务逻辑
//   · lane 的 250 行刻意差异（无 health / 无锚点 / 无完整 preStep）在 profile 里
//     显式表达为 false，而不是靠「不传就是没有」——否则差异会变成隐形假设
//   · validateProfile 早失败：未知守卫名/未知相位一律拒绝（避免拼错守卫名后静默失效）
//
// ★ 守卫命名归一（Task 2 首步，2026-09-20 实测 kernel/engine.mjs:58-70 `GUARD_IDS`）
// ---------------------------------------------------------------------------
// 真源 = engine.mjs 的 `GUARD_IDS`（S1/O2 已落地的**可观测面**，由 turn-observability
// .test.mjs 断言 11 个且与 engine 源码登记逐一对齐）。骨架期本文件曾用「计划名」，
// 与 engine 实际 id 同物异名 —— 那是漂移源（同一守卫两个名字，命中率无法横向对比，
// 搬移时极易错配）。故此处做一次**单向归一**：计划名 → engine 实际名。
//
//   计划名（骨架期，已废弃） → engine 实际名（本文件现名）      理由
//   ───────────────────────────────────────────────────────  ──────────────────────────
//   `idleDeadRetry`          → `idleWatchdog`                  engine:65 登记名；同物
//   `meltdownStop`           → `meltdown`                      engine:68 登记名；同物
//   `failureHeal`            → `meltdown`                      engine 里 ④「失败熔断」
//                                                              的**愈合注入与硬停同属
//                                                              一个 GUARD_ID**（:68，
//                                                              含 guard_heal 与 loopStop
//                                                              两支），不存在独立的
//                                                              `failureHeal`
//   `progressRefresh`        → `stall`                        engine 里「进展刷新」
//                                                              （madeProgress → lastProgressAt
//                                                              /stallHeals 清零）是 ⑥ stall
//                                                              的**内部状态维护**，engine 不
//                                                              单独登记为 GUARD_ID
//
// 其余 7 名（wallClock / iterCap / streamWallClock / genRepeat / nearRepeat /
// upstreamDead / repeatHeal / repeatReminder）计划名与 engine 逐字一致，无需改名。
// 归一后 `KNOWN_GUARDS` 与 `GUARD_IDS` **同集同义**，不再保留两套名字。
// （同步改动：loop-core.mjs 的守卫体注册表、kernel-tests/loop-core-contract.test.mjs）

/** 允许的守卫名（= engine.mjs `GUARD_IDS` 的语义投影；**主循环与 lane 同集**，见下方 profile 说明） */
export const KNOWN_GUARDS = new Set([
  // iterHead
  'wallClock', 'iterCap', 'stall',
  // inStream（流进行中，**块级**检查）
  'streamWallClock', 'genRepeat', 'nearRepeat',
  // afterStream（流结束/异常后处理）
  // ★ `idleWatchdog`/`upstreamDead` 归此处而非 inStream（Task 3 的划分修正）：
  //   它们的**命中判定**源于流内（空闲超时/上游断流），但**处理时机在 catch 块**
  //   （流抛错后按错误分类处理，engine.mjs:739-800）⇒ 按**执行时机**归"流后"，
  //   与 repeatHeal/meltdown（同在该 catch 后续路径）同层。放进 inStream 会诱导
  //   实现者去"每块检查"，而它们本来每块都不检查。
  'repeatHeal', 'meltdown', 'stall', 'repeatReminder', 'idleWatchdog', 'upstreamDead',
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
    inStream: ['streamWallClock', 'genRepeat', 'nearRepeat'],
    // ★ 归一后 `'stall'` 在 afterStream 与 iterHead **同名出现**，这是如实登记而非笔误：
    //   engine 里 ⑥ stall 的「进展刷新」状态维护在轮末（madeProgress → lastProgressAt/
    //   stallHeals 清零，engine.mjs:1142），命中判定在迭代头。同一守卫跨相位 → 两处列出。
    afterStream: ['repeatHeal', 'meltdown', 'stall', 'repeatReminder', 'idleWatchdog', 'upstreamDead'],
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
    inStream: ['streamWallClock', 'genRepeat', 'nearRepeat'],
    afterStream: ['repeatHeal', 'meltdown', 'stall', 'repeatReminder', 'idleWatchdog', 'upstreamDead'],
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
