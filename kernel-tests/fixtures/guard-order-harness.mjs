// L2 守卫序等价锁的**共用 harness**（Task 2–4 复用）
// ---------------------------------------------------------------------------
// 目的：把 iterHead 三个守卫的可观测后果收成一份**确定性快照**——
//   injections（文案/persist/事件 payload）、events（wire 序列）、
//   stop（收尾原因与文案）、action（break/continue）、state 增量（计数变化）。
// 录制器（record-guard-order-iterhead.mjs）与测试（loop-guard-order-equivalence.test.mjs）
// 共用本文件 ⇒ 「录什么」与「比什么」永远同一份口径，不会各写一遍后悄悄漂移。
// 零网络：只驱动 loop-core 的守卫体，不调 API。
import { runIterHeadGuards } from '../../kernel/loop-core.mjs'
import { MAIN_PROFILE } from '../../kernel/loop-profile.mjs'

/** 默认阈值（与 engine-config 默认值同源；显式传入 ⇒ 不受宿主 env 影响，快照可重复） */
export const DEFAULTS = Object.freeze({
  TURN_TIMEOUT_MS: 0,
  MAX_TOOL_ITERATIONS: 0,
  LOOP_STALL_MS: 0,
  STALL_HEAL_MAX: 2,
})

/** 把「依赖 Date.now() 的时间戳」规范成布尔（快照必须可重复，绝不留墙钟） */
const normState = (s, input) => ({
  iterCapHit: s.iterCapHit === true,
  stallHeals: typeof s.stallHeals === 'number' ? s.stallHeals : 0,
  // ⑥ 自愈注入后 lastProgressAt 应被刷新（注入后重开一个完整观察窗）：
  // 与**入参的旧时间戳**比较，而不是与 Date.now()（后者会引入墙钟抖动）
  progressRefreshed: typeof s.lastProgressAt === 'number'
    && typeof input.lastProgressAt === 'number'
    && s.lastProgressAt > input.lastProgressAt,
})

/**
 * 跑一次 iterHead 相位，收集可观测后果。
 * @param {object} state 覆盖 DEFAULTS 的状态（含 iter / turnT0 / lastProgressAt / stallHeals）
 */
export async function runIterHeadScenario(state) {
  const injections = []
  const events = []
  const hits = []
  let injectionsCount = 0
  const ctx = {
    profile: MAIN_PROFILE,
    turnGuardHits: { push: (id) => hits.push(id) },
    turnGuardInjections: { bump: () => { injectionsCount++ } },
    pushInjection(text, meta) {
      injections.push({ text, persist: meta?.persist === true, event: meta?.event || null })
    },
    onGuardInject(inj) {
      const ev = inj?.event
      if (ev && typeof ev.reason === 'string') events.push({ subtype: 'guard_heal', reason: ev.reason, attempt: ev.attempt, max: ev.max })
    },
  }
  const input = { ...DEFAULTS, ...state }
  const r = await runIterHeadGuards(input, ctx)
  return {
    stop: r.stop ?? null,
    action: r.action ?? null,
    state: normState(r.state ?? input, input),
    injections,
    events,
    hits,
    injectionsCount,
  }
}

/** 三个命中场景（顺序 = profile 守卫序 wallClock → iterCap → stall） */
export function scenarios() {
  const now = Date.now()
  return {
    wallClock: {
      TURN_TIMEOUT_MS: 60000, turnT0: now - 120000,
    },
    iterCap: {
      MAX_TOOL_ITERATIONS: 2, iter: 2,
    },
    stallHeal: {
      LOOP_STALL_MS: 60000, lastProgressAt: now - 120000, stallHeals: 0,
    },
    stallHardStop: {
      LOOP_STALL_MS: 60000, lastProgressAt: now - 120000, stallHeals: 2,
    },
  }
}
