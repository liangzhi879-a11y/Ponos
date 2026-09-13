// 流式降频门控（R5，2026-09-13「任务运行慢」系统性优化）
// ---------------------------------------------------------------------------
// 病根：旧实现用「本次 flush 的处理耗时 > 50ms」当降频判据（useYFWCLI.ts 原 641-643 行），
// 而那个计时只包住 store 循环、**不含 React 提交**，于是它在真实负载下从未置位过一次
// ——降频形同虚设，UI 该卡还是卡。判据本身要换，不只是换计时口径。
//
// 换成什么：测**队列压力**，不测单帧耗时。成熟实现（codex
// `tui/src/streaming/chunking.rs:85-116`、`tui/frame_rate_limiter.rs:13,23-36`）用
// 「待渲染队列深度 / 最老未渲染项年龄」进降频，配不对称滞回退出。理由：慢一帧不代表
// 跟不上——真正要处理的病是**持续落后**（新内容来得比渲染快）。单帧耗时高但事件稀疏时
// 降频毫无收益，只会白白牺牲响应性；而队列在涨时降频是真有用。
//
// 单线程 JS 的等价物：事件到达与渲染在同一线程，队列不会在"渲染期间"继续变长，
// 所以
//   · 深度 = 本次待处理批次里的事件条数（可见）
//   · 年龄 = 最老那条从入队到本次 flush 之间经过的墙钟
// 二者合起来正是"等了我多久"：主线程被 React 提交占住时，排定的 flush 定时器会晚点
// 触发，年龄随之变大——这就是单线程版的队列积压。
//
// 滞回按成熟实现的形状（进快出慢，且退出要连续满足一段时间）：
//   进：深度 ≥ 8 **或** 年龄 ≥ 120ms  → 立即降频（不等观察期）
//   出：深度 ≤ 2 **且** 年龄 ≤ 40ms，**连续满足 250ms** → 才恢复满速
// 中间带（如深度 4、年龄 60ms）维持现状：没有它，阈值附近的抖动会让帧率反复横跳。
//
// 本模块是纯函数 + 纯状态机，时间从参数传入 ⇒ 可用注入的假时钟逐毫秒断言。
export interface HeavyModeThresholds {
  /** 进降频的队列深度阈值 */
  depthIn: number
  /** 进降频的最老待处理项年龄阈值（ms） */
  ageInMs: number
  /** 退出降频的深度阈值 */
  depthOut: number
  /** 退出降频的年龄阈值（ms） */
  ageOutMs: number
  /** 退出降频需连续满足的时长（ms），防阈值附近抖动 */
  exitHoldMs: number
  /** 降频期的合帧间隔（ms）——进取档取 120（原实现 250 显得迟钝） */
  coalesceMs: number
  /** 满速期的目标帧间隔（ms）。调度用 16ms 定时器而非 rAF：后台/失焦窗口 rAF 会停摆 */
  targetFrameMs: number
}

export const HEAVY_MODE_THRESHOLDS: HeavyModeThresholds = {
  depthIn: 8,
  ageInMs: 120,
  depthOut: 2,
  ageOutMs: 40,
  exitHoldMs: 250,
  coalesceMs: 120,
  targetFrameMs: 16,
}

export interface HeavyModeStats {
  /** 进/出降频次数（累计，takeStats 后归零） */
  enters: number
  exits: number
  /** 观察到的峰值（用于 5s 汇总上报，不逐帧 IO） */
  maxDepth: number
  maxAgeMs: number
  /** 上一次进/出降频的成因，便于事后解释"为什么降了/没降" */
  lastReason: string
}

export interface HeavyModeGate {
  /** 每次 flush 取走批次前调用：depth = 批次条数，ageMs = 最老一条已等待的墙钟 */
  observe(depth: number, ageMs: number, now: number): boolean
  readonly heavy: boolean
  /** 取走并归零统计（供 5s 汇总） */
  takeStats(): HeavyModeStats
  /** 流结束/断线时复位：立即回满速，不等 exitHold */
  reset(): void
}

export function createHeavyModeGate(t: HeavyModeThresholds = HEAVY_MODE_THRESHOLDS): HeavyModeGate {
  let heavy = false
  // 低压力状态的起始时刻；null = 当前不处于"连续满足退出条件"的区间
  // （不用 0 当哨兵：注入的假时钟完全可能从 0 起算）
  let lowSince: number | null = null
  const stats: HeavyModeStats = { enters: 0, exits: 0, maxDepth: 0, maxAgeMs: 0, lastReason: '' }

  return {
    get heavy() { return heavy },

    observe(depth, ageMs, now) {
      if (depth > stats.maxDepth) stats.maxDepth = depth
      if (ageMs > stats.maxAgeMs) stats.maxAgeMs = ageMs

      const over = depth >= t.depthIn || ageMs >= t.ageInMs
      const under = depth <= t.depthOut && ageMs <= t.ageOutMs

      if (over) {
        lowSince = null
        if (!heavy) {
          heavy = true
          stats.enters++
          stats.lastReason = depth >= t.depthIn ? `depth=${depth}` : `age=${Math.round(ageMs)}ms`
        }
        return heavy
      }
      if (!under) {
        // 中间带：维持现状。进档后不因一次中间值就退出，出档后也不因一次中间值就进档。
        lowSince = null
        return heavy
      }
      // 低压力：需连续满足 exitHoldMs 才退出（进快出慢）
      if (lowSince === null) { lowSince = now; return heavy }
      if (heavy && now - lowSince >= t.exitHoldMs) {
        heavy = false
        stats.exits++
        stats.lastReason = `exit after ${Math.round(now - lowSince)}ms low`
      }
      return heavy
    },

    takeStats() {
      const out = { ...stats }
      stats.enters = 0
      stats.exits = 0
      stats.maxDepth = 0
      stats.maxAgeMs = 0
      stats.lastReason = ''
      return out
    },

    reset() {
      heavy = false
      lowSince = null
    },
  }
}

/** 下一次 flush 的调度延迟：降频期用固定合帧间隔；满速期补足到目标帧间隔（不为负）。 */
export function nextFlushDelay(gate: HeavyModeGate, elapsedSinceLastFlushMs: number, t: HeavyModeThresholds = HEAVY_MODE_THRESHOLDS): number {
  if (gate.heavy) return t.coalesceMs
  return Math.max(0, t.targetFrameMs - elapsedSinceLastFlushMs)
}
