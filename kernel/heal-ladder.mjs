// 自愈阶梯（heal ladder）：把散落在守卫/引擎里的自愈动作统一为 **L0–L4 五级**，
// 让"内核现在自愈到哪一级了"成为**可读事实**（纯函数，无 IO/无定时器，可单测）。
//
// ── 为什么要统一（排障成本）────────────────────────────────────────────────
// 2026-09-21 长任务可靠性工作线盘点发现：自愈点已有 9 处（见下表），但它们的**级差**只存在于
// 注释里——预算常量分散在 engine-config，升级条件各写各的，痕迹有的进 wire（guard_heal）、
// 有的只进 stderr（日志）。后果是排障时无法回答最基本的一问："这个卡住的任务，内核已经救到
// 第几级了？还能再救吗？"——只能翻三层日志拼图。同一件事（"内核在自愈"）在五个地方各说各话。
// 本模块把级差**显式化**，并给出一个机器可判的判据 `judgeEscalation`。
//
// ── 五级阶梯（语义即"代价递增、侵入性递增、最后必然有终态出口"）──────────────
//   L0 静默重试   不打断、用户无感：退避后重发（上游空流/零数据空闲）。代价最低，最优先尝试。
//   L1 注入改策略 同一轮内注入推进/纠正指令（停滞、重复退化、熔断、推理中断、截断续写）。
//   L2 降规模     减少单次工作量（超时连击 → 缩短目标/拆批/降输出档）。仍不打断用户。
//   L3 有界收尾   可见收尾 + 保留已产出 + 给"可继续"入口（各守卫预算耗尽的硬停）。
//   L4 外围重启/唤醒 超出内核自愈能力：宿主自动唤醒（后台任务完成）、桥重 spawn、端口自愈。
//
// ── 动作域（阶梯由 `reasonToLevel(reason, action)` 按动作查表）──────────────────
//   既有三域：`inject` / `stop` / `signal`。
//   · 第四域 `disk`（2026-09-23 会话健康快照）：落盘慢/失败的 L0 重试 → L1 换策略 → L2 舍次保关键
//     → L3 有界告警。落盘域同样遵守三条纪律（尤其"多数问题自愈、严重才提醒"）。
//
// ── 三条纪律（否则"统一阶梯"会变成"统一放水"）────────────────────────────────
//   ① **级差是事实，不是策略**：本模块只**标注**与**汇总**，不改任何预算与控制流。
//      （改控制流要动 9 处守卫的收敛判据，风险与本工作线的"低爆炸半径"原则冲突。）
//   ② **自愈不得刷新实质进展判据**：各级自愈的记账必须与"进展"分账——升级不是靠"等得更久"，
//      而是靠"确实换了手段"。故 `judgeEscalation` 只看**手段用了几次**，不看时间。
//   ③ **未登记的 reason 一律返回 null，绝不猜级**：猜错级比不给级更糟（会把"还在重试"读成
//      "已收尾"）。静态对账测试（kernel-tests/heal-ladder.test.mjs）扫 loop-core 的 reason
//      字面量必须全部已登记，防新增守卫忘登记。

/** 级序（数值越大侵入性越强）；`null` 表示"不适用/未登记"。 */
export const HEAL_LEVELS = Object.freeze({
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4,
})

/** 各级语义（给日志/文档/界面用；文案是给人看的，勿用于判定）。 */
export const HEAL_LEVEL_NAMES = Object.freeze({
  L0: '静默重试',
  L1: '注入改策略',
  L2: '降规模',
  L3: '有界收尾',
  L4: '外围重启/唤醒',
})

/**
 * 注入型自愈（`guard_heal` 事件的 reason）→ 级别。
 * ★ 键集必须与 `kernel/loop-core.mjs` 的 reason 字面量逐字对账（有静态测试钉住）。
 * ★ 为什么 `upstream-dead` 是 L0 而 `idle-interrupted` 是 L1：前者是"重发一次请求"（手段不变、
 *   不打断、不注入文本）；后者是"注入续写指令"（改变了对话内容）——判别标准是**手段是否改变**，
 *   不是"发生在哪个守卫里"（同一个 idleWatchdog 守卫同时做这两件事）。
 */
export const INJECTION_REASON_LEVEL = Object.freeze(Object.assign(Object.create(null), {
  // L0：不打断、不注入文本，只退避重发
  'upstream-dead': 'L0',
  // L1：注入推进/纠正/续写指令，改变后续对话内容
  'loop-stall': 'L1',
  'error-meltdown': 'L1',
  'idle-interrupted': 'L1',
  continue: 'L1',
  'repeat-heal': 'L1',
  // ★ 这两个是"借来的 reason"：收尾守卫置 `loopStop.reason='gen-repeat'`，而 repeatHeal 自愈时
  //   直接**复用同一个 reason** 去注入推进指令（`healReason = loopStop.reason`，loop-core:366）。
  //   所以 "gen-repeat" 在注入域是 L1、在收尾域是 L3 —— 正是"同一字符串两种含义"的第二个实例。
  //   （此条由 kernel-tests/heal-ladder.test.mjs 的精确对账抓出来：初版漏登记 ⇒ 该自愈路径在
  //     观测面上**没有 level**，即"统一阶梯"名存实亡。这正是对账测试存在的意义。）
  'gen-repeat': 'L1',
  'near-repeat': 'L1',
  // L2：注入"降规模"指令（缩短目标/拆批），减少单次工作量
  'loop-timeout-streak': 'L2',
}))

/**
 * 收尾型（stop reason）→ 级别。全是 L3：**有界收尾 = 保留已产出 + 可见说明 + 给"可继续"入口**。
 * ★ 与注入型同名的 reason（`loop-stall`/`gen-repeat`/`near-repeat`/`error-meltdown`/`upstream-dead`）
 *   在不同**动作**下级别不同（注入 L1 / 收尾 L3）⇒ 判定必须带动作维度，不能只按 reason 查一张表。
 *   这张表也顺带证明"同一字符串两种含义"不是笔误，而是语义确凿的两件事。
 */
export const STOP_REASON_LEVEL = Object.freeze(Object.assign(Object.create(null), {
  timeout: 'L3',
  'loop-stall': 'L3',
  'gen-repeat': 'L3',
  'near-repeat': 'L3',
  'error-meltdown': 'L3',
  idle: 'L3',
  'upstream-dead': 'L3',
}))

/** 宿主信号（不注入文本、由宿主执行的动作）→ 级别：退避重试属 L0；续写属 L1。 */
export const SIGNAL_LEVEL = Object.freeze(Object.assign(Object.create(null), {
  'idle-dead-retry': 'L0',
  'upstream-dead-retry': 'L0',
  'idle-heal': 'L1',
}))

/**
 * 落盘域（第四域）→ 级别。2026-09-23 会话健康快照 spec §4.1 复用本阶梯（不新造等级体系）。
 * ★ site 名是**参数**、不进词表 ⇒ 词表规模恒定（4 条），可静态对账（有测试钉住）。
 * ★ 判别标准仍是"手段是否改变"：L0 重试（手段不变）→ L1 换策略 → L2 舍次保关键 → L3 有界告警。
 * ★ 表是 **null 原型对象**（`Object.create(null)`）：否则 `TBL[key] ?? null` 会沿原型链取值，
 *   使 `reasonToLevel('toString', 'disk')` 返回函数、`'__proto__'` 返回对象 —— 违反纪律③
 *   （未登记一律 null）。这是**修缺陷**（原三域同样有此漏口），不是改口径。
 */
export const DISK_REASON_LEVEL = Object.freeze(Object.assign(Object.create(null), {
  'disk-write-retry': 'L0',            // 同步写失败 ⇒ 立即重试一次（Windows 瞬时 EBUSY/EPERM）
  'disk-strategy-fallback': 'L1',      // 重试仍败 ⇒ 换写入策略（如 append → tmp+rename 原子写）
  'disk-shed-secondary': 'L2',         // 仍败 ⇒ 舍次要项（可重建），保关键项
  'disk-critical-persist-fail': 'L3',  // 关键项持续失败 ⇒ 有界收尾 + **醒目告警**
}))

/** 四个动作域 → 各自 reason 词表（单一真源：测试据此做**行为式**对账，不靠源码文本匹配）。 */
export const REASON_TABLES = Object.freeze({
  inject: INJECTION_REASON_LEVEL,
  stop: STOP_REASON_LEVEL,
  signal: SIGNAL_LEVEL,
  disk: DISK_REASON_LEVEL,
})

/**
 * 守卫 id → 该守卫**能达到的自愈级别**（观测用：回答"这个守卫最狠能救到哪一级"）。
 * ★ 只列**自愈**级别（L0–L2）；收尾（L3）是每个守卫预算耗尽后的共同出口，不在此表——
 *   否则"能达到 L3"会让人误读成"它会收尾"，而实际上大量命中都在 L1 就恢复了。
 * ★ `progressRefresh` 不在表内：它是纯状态更新（不登记命中、不注入），本就不是自愈点。
 *   `repeatReminder` 记为 L1（只提醒不否决）——提醒也是改变后续对话内容的手段。
 */
export const GUARD_HEAL_LEVELS = Object.freeze({
  wallClock: [],
  iterCap: [],
  stall: ['L1'],
  streamWallClock: [],
  genRepeat: [],
  nearRepeat: [],
  repeatHeal: ['L1'],
  progressRefresh: [],
  repeatReminder: ['L1'],
  meltdown: ['L1'],
  idleWatchdog: ['L0', 'L1'],
  upstreamDead: ['L0'],
})

/**
 * 由 reason + 动作维度定级。
 * @param {string} reason
 * @param {'inject'|'stop'|'signal'|'disk'} action
 * @returns {'L0'|'L1'|'L2'|'L3'|'L4'|null} 未登记 ⇒ null（**不猜**）
 */
export function reasonToLevel(reason, action) {
  const key = typeof reason === 'string' ? reason : ''
  if (!key) return null
  if (action === 'inject') return INJECTION_REASON_LEVEL[key] ?? null
  if (action === 'stop') return STOP_REASON_LEVEL[key] ?? null
  if (action === 'signal') return SIGNAL_LEVEL[key] ?? null
  if (action === 'disk') return DISK_REASON_LEVEL[key] ?? null
  return null
}

/** 级别可比较（数值）；null 排最后（"未登记"不参与"最高级"比较，避免污染汇总）。 */
export function levelRank(level) {
  return typeof level === 'string' && level in HEAL_LEVELS ? HEAL_LEVELS[level] : -1
}

/**
 * 汇总"本轮救到哪一级"（观测面：让 `guard_state` / 面板能答"已经救到第几级"）。
 *
 * @param {{hits?: Record<string,number>|string[], injections?: number, stops?: string[], signals?: string[]}} o
 * @returns {{counts: Record<string,number>, highest: string|null, highestName: string|null,
 *            unknown: string[], exhausted: boolean, line: string}}
 */
export function summarizeLadder({ hits, injections, stops, signals } = {}) {
  const counts = { L0: 0, L1: 0, L2: 0, L3: 0, L4: 0 }
  const unknown = []
  const seen = new Set()
  // 注入次数按"实际发生了几次注入"计——**不是**按时长或命中数（纪律②：升级看手段、不看时间）
  const inj = Number(injections) > 0 ? Math.floor(Number(injections)) : 0
  for (let i = 0; i < inj; i++) counts.L1 += 1
  for (const r of Array.isArray(stops) ? stops : []) {
    const lv = reasonToLevel(r, 'stop')
    if (lv) { counts[lv] += 1; seen.add(lv) } else unknown.push(`stop:${r}`)
  }
  for (const r of Array.isArray(signals) ? signals : []) {
    const lv = reasonToLevel(r, 'signal')
    if (lv) { counts[lv] += 1; seen.add(lv) } else unknown.push(`signal:${r}`)
  }
  // hits 是守卫 id 计数（观测面口径）：按其**可达到的自愈级别**折算，只用于"哪些级被碰过"
  const hitKeys = Array.isArray(hits) ? hits : (hits && typeof hits === 'object' ? Object.keys(hits) : [])
  for (const gid of hitKeys) {
    const levels = GUARD_HEAL_LEVELS[gid]
    if (!levels) { unknown.push(`guard:${gid}`); continue }
    // L0 优先（能自愈到 L0 的守卫实际多走 L0），只登记"碰过"，不虚增次数
    if (levels.length > 0) seen.add(levels[0])
  }
  const hitLevels = [...seen].sort((a, b) => levelRank(a) - levelRank(b))
  const highest = hitLevels.length > 0 ? hitLevels[hitLevels.length - 1] : null
  // `exhausted`：已走到 L3（有界收尾）——即"内核自己救不动了、已交还用户"
  const exhausted = hitLevels.includes('L3')
  return {
    counts,
    highest,
    highestName: highest ? HEAL_LEVEL_NAMES[highest] : null,
    unknown,
    exhausted,
    line: highest
      ? `自愈阶梯：最高 ${highest}（${HEAL_LEVEL_NAMES[highest]}）${exhausted ? '，已收尾交还用户' : ''}`
      : '自愈阶梯：本轮无需自愈',
  }
}

/**
 * 升级判定（**建议性**，纯函数；当前不改控制流——见纪律①）。
 * 语义：给定当前级别与"该手段已用次数/预算"，回答"下一步该做什么"。这样任何调用方
 * （未来要把 9 处守卫收敛成统一驱动器时）都能复用同一判据，而不是各写一套 if。
 *
 * 规则（刻意简单、可复述）：
 *   · 预算未耗尽 ⇒ 留在本级（`retry` / `inject`，由调用方按级别选动作）
 *   · 预算耗尽 ⇒ 升一级；L3 已是有界收尾 ⇒ 不再升级到 L4（L4 是宿主决定，内核不自行重启）
 *   · 未登记级别 ⇒ `unknown`（**不猜**，交调用方按旧逻辑处理 = 零行为变更）
 *
 * @param {{level?: string|null, attempts?: number, max?: number}} [o]
 * @returns {{action:'retry'|'inject'|'downscale'|'finalize'|'escalate'|'unknown',
 *            level:string|null, nextLevel:string|null, reason:string}}
 */
export function judgeEscalation({ level, attempts, max } = {}) {
  if (!level || !(level in HEAL_LEVELS)) return { action: 'unknown', level: null, nextLevel: null, reason: '未登记级别（不猜级）' }
  const n = Number.isFinite(Number(attempts)) ? Number(attempts) : 0
  const limit = Number(max)
  const budgetLeft = !Number.isFinite(limit) || limit < 0 ? true : n < limit
  if (budgetLeft) {
    const action = level === 'L0' ? 'retry' : level === 'L1' ? 'inject' : level === 'L2' ? 'downscale' : 'finalize'
    return { action, level, nextLevel: level, reason: `预算内（${n}/${Number.isFinite(limit) ? limit : '∞'}），留在 ${level}` }
  }
  if (level === 'L3') return { action: 'finalize', level, nextLevel: null, reason: 'L3 已是有界收尾（内核不再自行升级；L4 由宿主决定）' }
  const next = `L${Math.min(4, HEAL_LEVELS[level] + 1)}`
  return { action: 'escalate', level, nextLevel: next, reason: `预算耗尽（${n}/${Number.isFinite(limit) ? limit : '∞'}）⇒ 升级到 ${next}` }
}
