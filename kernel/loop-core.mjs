// 循环体契约（S2/B1）
// ---------------------------------------------------------------------------
// 边界纪律（spec §6.4）：本模块**不得引用 engine.mjs 的闭包**。
// 一切外部依赖走 ctx 显式注入——否则「等价重构」会变成「隐式耦合搬家」。
//
// B1 冻结面（最小化）：ctx.emitInjection(text, { persist, event })
//   priority / budgetBytes / kind / phase 由 S3.5 引入，本阶段**必须拒绝**，
//   以免调用方提前依赖未定形状。
//
// 本任务只固定「编排顺序 + 契约」；守卫体由 Task 2–4 逐相位补齐：
//   Task 2 → iterHead（MAIN/LANE 共用），Task 3 → inStream，Task 4 → afterStream。
import { KNOWN_GUARDS, MAIN_PROFILE, PHASES, resolveGuards } from './loop-profile.mjs'

const ALLOWED_INJECTION_OPTIONS = new Set(['persist', 'event'])

/** 每个相位归哪个补缺任务（仅用于「未实现」报错文案，便于定位漏实现项） */
const PHASE_TASK = { iterHead: 'Task 2', inStream: 'Task 3', afterStream: 'Task 4' }

/** 守卫名 → 所属相位（从 MAIN_PROFILE 反查，单一真源） */
const GUARD_PHASE = Object.create(null)
for (const phase of PHASES) {
  for (const name of MAIN_PROFILE.guards[phase]) GUARD_PHASE[name] = phase
}

/**
 * 唯一注入出口（B1 冻结面）。
 * ★ 冻结：只接受 `text` + `{ persist, event }`；多余键**抛错**（防调用方提前依赖 S3.5 形状）。
 * ★ 无 `ctx.pushInjection` 时**静默**：记账/注入失败绝不能阻断主流程。
 * @param {object} ctx  需含 pushInjection(text, meta)（由宿主提供）
 * @param {string} text 注入文本
 * @param {{persist?: boolean, event?: object|null}} [meta]
 */
export function emitInjection(ctx, text, meta = {}) {
  for (const k of Object.keys(meta || {})) {
    if (!ALLOWED_INJECTION_OPTIONS.has(k)) throw new Error(`unknown option: ${k}`)
  }
  const fn = ctx && typeof ctx.pushInjection === 'function' ? ctx.pushInjection : null
  if (!fn) return  // 无缓冲时静默：注入失败不得阻断主流程
  fn(String(text), {
    persist: meta.persist === true,
    event: meta.event || null,
  })
}

/** 归一化 stop 形状：`null | { reason: string, message: any }`（reason 缺失 → 'unknown'） */
function normalizeStop(stop) {
  if (!stop) return null
  return { reason: String(stop.reason || 'unknown'), message: stop.message }
}

/**
 * 一轮迭代的执行体（B1 契约，spec §6.1 / A2）。
 *
 * ★ 设计要点（这是「一处实现」的载体，**不是** no-op 骨架）：
 *   · 主循环与 lane **都调本函数** —— 差异只由 `ctx.profile` 表达
 *   · 本函数**不引用 engine 闭包**：IO 走 `ctx.streamOnce`，注入走 `ctx.emitInjection`
 *   · 按 profile 的相位顺序驱动三段守卫；任一守卫命中即返回 `stop`
 *   · 返回形状固定：`{ state, stop }`，`stop` 为 `null` 或 `{ reason, message? }`
 *
 * Task 2–4 逐相位填 `GUARD_BODIES` 里的守卫体；本任务只把**编排顺序与契约**固定下来。
 * @returns {Promise<{state: object, stop: null | {reason: string, message?: any}}>}
 */
export async function runOnce(state, ctx) {
  const emit = (text, meta) => emitInjection(ctx, text, meta)
  const phaseCtx = (extra) => ({ ...ctx, emit, ...extra })

  // 相位 1：迭代前守卫（① 墙钟 / ② 迭代上限 / ⑥ 停滞）—— 集合与顺序由 profile 决定
  const head = await runIterHeadGuards(state, phaseCtx())
  if (head?.stop) return { state: head.state ?? state, stop: normalizeStop(head.stop) }
  // ★ 相位间 state 必须**串起来**：iterHead 的②会把 iterCapHit 递增、⑥会刷新进展时间戳；
  //   后续相位必须看到这些变化（否则"迭代上限"这类守卫会在后续相位里读到过期值）
  const cur = head?.state ?? state

  // 相位 2：流内守卫（①b 流内墙钟 / ③ gen-repeat / ③b near-repeat / 闲置重试 / 上游死亡）
  const streamed = await ctx.streamOnce(cur, phaseCtx())
  const inStream = await runInStreamGuards(cur, phaseCtx({ streamed }))
  if (inStream?.stop) return { state: inStream.state ?? cur, stop: normalizeStop(inStream.stop) }
  const afterStreamState = inStream?.state ?? cur

  // 相位 3：流后守卫（⑥ 进展刷新 / ③ 重复自愈 / ⑤ 同工具提醒 / ④ 熔断）
  const after = await runAfterStreamGuards(afterStreamState, phaseCtx({ streamed }))
  if (after?.stop) return { state: after.state ?? afterStreamState, stop: normalizeStop(after.stop) }

  // 无 stop ⇒ 也要把守卫累积的 state 回传（否则调用方拿不到本轮的计数/时间戳变化）
  return { state: after?.state ?? afterStreamState, stop: null }
}

// —— 守卫体注册表（Task 2–4 逐个把 `未实现` 占位替换为真实实现）——
// ★ 纪律：**未实现必须抛错**，不得静默跳过 —— 静默跳过 = 等价重构失效且无人发现。
const GUARD_BODIES = Object.create(null)
for (const name of KNOWN_GUARDS) {
  GUARD_BODIES[name] = async function notImplemented() {
    const task = PHASE_TASK[GUARD_PHASE[name]] || '后续任务'
    throw new Error(`守卫 ${name} 未实现（${task} 补齐）`)
  }
}

/**
 * 相位驱动器：按 `resolveGuards(ctx.profile, phase)` 的守卫序**串行**执行。
 * 任一守卫返回 `{ stop }` 即短路返回（后续守卫不再执行）。
 * @returns {Promise<{stop: null | {reason: string, message?: any}, state?: object}>}
 */
async function runPhaseGuards(phase, state, ctx) {
  // 未知相位在此抛错（resolveGuards 早失败）；
  // 空守卫序 = profile 缺该相位 ⇒ 也是「未实现」，不得当成「无守卫通过」
  const names = resolveGuards(ctx?.profile, phase)
  if (names.length === 0) {
    throw new Error(`相位 ${phase} 无守卫体：未实现（${PHASE_TASK[phase] || '后续任务'} 补齐 / profile 缺相位）`)
  }
  let cur = state
  for (const name of names) {
    const body = GUARD_BODIES[name]
    // profile 里出现了未登记的守卫名 ⇒ 早失败，别静默跳过
    if (typeof body !== 'function') throw new Error(`守卫 ${name} 未实现（未注册实现，相位 ${phase}）`)
    const r = await body(cur, ctx)
    if (r && r.state !== undefined) cur = r.state
    if (r?.stop) return { state: cur, stop: normalizeStop(r.stop) }
  }
  return { state: cur, stop: null }
}

/** 相位 1 入口：迭代前守卫（Task 2 补齐守卫体） */
export async function runIterHeadGuards(state, ctx) {
  return runPhaseGuards('iterHead', state, ctx)
}

/** 相位 2 入口：流内守卫（Task 3 补齐守卫体） */
export async function runInStreamGuards(state, ctx) {
  return runPhaseGuards('inStream', state, ctx)
}

/** 相位 3 入口：流后守卫（Task 4 补齐守卫体） */
export async function runAfterStreamGuards(state, ctx) {
  return runPhaseGuards('afterStream', state, ctx)
}

/**
 * 收尾判定（规范化）；`ctx` 预留给后续「按 profile 决定收尾方式」（loopStop / guardStop）。
 * @returns {null | {reason: string, message?: any}}
 */
export function shouldStop(state, ctx) {
  void ctx
  return normalizeStop(state?.stop)
}
