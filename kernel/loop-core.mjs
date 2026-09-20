// 循环体契约（S2/B1）
// ---------------------------------------------------------------------------
// 边界纪律（spec §6.4）：本模块**不得引用 engine.mjs 的闭包**。
// 一切外部依赖走 ctx 显式注入——否则「等价重构」会变成「隐式耦合搬家」。
//
// B1 冻结面（最小化）：ctx.emitInjection(text, { persist, event })
//   priority / budgetBytes / kind / phase 由 S3.5 引入，本阶段**必须拒绝**，
//   以免调用方提前依赖未定形状。
// ★ 相位内部注入走 `ctx.inject(text, meta)`：由 runPhaseGuards 装配
//   = emitInjection（记账/注入）+ ctx.onGuardInject?.(Injected)（宿主副作用钩子，
//   engine 侧对应 pushMemory / session.appendUser / wire `guard_heal`）。
//   业务守卫**不得**自造注入路径。
//
// ctx 形状（Task 2 起生效）：
//   ctx.profile             —— LoopProfile（守卫序真源）
//   ctx.pushInjection       —— 注入缓冲（可选；缺省静默，注入失败不得阻断主流程）
//   ctx.onGuardInject(I)    —— 宿主副作用钩子（可选）；I = { text, persist, event }
//   ctx.turnGuardHits       —— { push(id) }   O2 命中登记（可选）
//   ctx.turnGuardInjections —— { bump() }     O2 真注入计数（可选）
//   state（守卫入参，字段名与原实现同名，便于逐字对照）：
//     TURN_TIMEOUT_MS / turnT0 / MAX_TOOL_ITERATIONS / iter / LOOP_STALL_MS /
//     lastProgressAt / stallHeals / STALL_HEAL_MAX / iterCapHit
//   ★ 阈值与计数器**由宿主传入**（与 engine 模块加载期读 env 同源：跑同一 env 即同一批
//     常量）；命中判定（`>0` / `>=` / `<`）与文案渲染留在本模块，逐字等价。
//
// 本任务只固定「编排顺序 + 契约」；守卫体由 Task 2–4 逐相位补齐：
//   Task 2 → iterHead（MAIN/LANE 共用），Task 3 → inStream，Task 4 → afterStream。
import { KNOWN_GUARDS, MAIN_PROFILE, PHASES, resolveGuards } from './loop-profile.mjs'
// ③ 生成重复检测（每块尾部滚动查一次）：纯函数模块，无反向依赖 ⇒ 不违反上方边界纪律
import { detectGenerationRepeat } from './gen-guards.mjs'

const ALLOWED_INJECTION_OPTIONS = new Set(['persist', 'event'])

/** 每个相位归哪个补缺任务（仅用于「未实现」报错文案，便于定位漏实现项） */
const PHASE_TASK = { iterHead: 'Task 2', inStream: 'Task 3', afterStream: 'Task 4' }

/** ⑥ stall 自愈注入文案（逐字搬移自 engine.mjs:548，**勿改标点**） */
const STALL_INJECT_TEXT = '【系统】检测到你长时间没有实质进展（连续只读测量/重复调用、无新结果或文件变更）。请停止测量与重复尝试，直接执行下一步实质操作（修改文件/执行命令/完成剩余步骤），或向用户明确汇报当前卡点与结论。'

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

// ── 相位 1（iterHead）守卫体：等价搬移自 engine.mjs runTurnInternal 迭代头（Task 2）──
// 纪律：逻辑逐行照搬，**不重排、不合并条件、不改文案**；engine 闭包值一律走 ctx/state。
//
// 搬移源（2026-09-20 实测行号，计划里的 :486-516 已整体漂移 +43~+45）：
//   ① wallClock  engine.mjs:529-538（命中登记在 :532）
//   ② iterCap    engine.mjs:539-540（:540 的 `iterCapHit = true` + 命中登记）
//   ⑥ stall      engine.mjs:541-561（自愈注入 :543-554，硬停 :555-561）
//   末行 `if (loopStop) break` 在 :562（由相位驱动器/宿主统一表达）

/** ① 轮次墙钟：置 loopStop.reason='timeout'；**不发事件、无注入**（不经过注入出口） */
async function guardWallClock(state, ctx) {
  const { TURN_TIMEOUT_MS, turnT0 } = state
  if (!(TURN_TIMEOUT_MS > 0 && Date.now() - turnT0 >= TURN_TIMEOUT_MS)) return { state }
  ctx.turnGuardHits?.push('wallClock') // O2：如实登记（① 不发 guard_heal、无注入）
  return {
    state,
    stop: {
      reason: 'timeout',
      message: `【已达单轮时长上限（${Math.max(1, Math.round(TURN_TIMEOUT_MS / 60000))} 分钟），为防止挂起已自动收尾。任务可能未完——可发送「继续」让模型接续。】`,
    },
    action: 'break',
  }
}

/**
 * ② 单轮迭代硬上限：只置 iterCapHit=true；**不发事件、不置 loopStop**（勿脑补 reason）。
 * 收尾方式是 `action: 'break'`（原实现即 `break`——不是置 loopStop）。
 */
async function guardIterCap(state, ctx) {
  const { MAX_TOOL_ITERATIONS, iter } = state
  if (!(MAX_TOOL_ITERATIONS > 0 && iter >= MAX_TOOL_ITERATIONS)) return { state }
  ctx.turnGuardHits?.push('iterCap')
  return { state: { ...state, iterCapHit: true }, stop: null, action: 'break' }
}

/**
 * ⑥ 无进展停滞（自愈优先）：先注入"推进指令"续跑（用户无感知），耗尽 STALL_HEAL_MAX
 * 仍无进展才落可见收尾（硬停是最后防线）。注入**经唯一出口** `ctx.inject`。
 */
async function guardStall(state, ctx) {
  const { LOOP_STALL_MS, lastProgressAt, stallHeals, STALL_HEAL_MAX } = state
  if (!(LOOP_STALL_MS > 0 && Date.now() - lastProgressAt >= LOOP_STALL_MS)) return { state }
  if (stallHeals < STALL_HEAL_MAX) {
    const heals = stallHeals + 1
    // 顺序与 engine 原实现一致：先登记（hits、injections++），再注入，事件由出口触发
    ctx.turnGuardHits?.push('stall')
    ctx.turnGuardInjections?.bump() // O2：⑥ 自愈确实注入（pushMemory + guard_heal）
    ctx.inject(STALL_INJECT_TEXT, { persist: true, event: { reason: 'loop-stall', attempt: heals, max: STALL_HEAL_MAX } })
    // 注入后重开一个完整观察窗，并 `continue` 重跑本轮迭代（原实现在此 continue）
    return { state: { ...state, stallHeals: heals, lastProgressAt: Date.now() }, stop: null, action: 'continue' }
  }
  ctx.turnGuardHits?.push('stall')
  return {
    state,
    stop: {
      reason: 'loop-stall',
      message: `【检测到长时间无实质进展（${Math.max(1, Math.round(LOOP_STALL_MS / 60000))} 分钟内只有只读测量/重复调用、无新结果或文件变更），已自动收尾以防循环。可发送「继续」让模型换一种方式推进，或补充更明确的指令。】`,
    },
    action: 'break',
  }
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

  // 相位 2：流内守卫（①b 流内墙钟 / ③ gen-repeat / ③b near-repeat / idleWatchdog / 上游死亡）
  const streamed = await ctx.streamOnce(cur, phaseCtx())
  const inStream = await runInStreamGuards(cur, phaseCtx({ streamed }))
  if (inStream?.stop) return { state: inStream.state ?? cur, stop: normalizeStop(inStream.stop) }
  const afterStreamState = inStream?.state ?? cur

  // 相位 3：流后守卫（⑥ 进展维护 / ③ 重复自愈 / ⑤ 同工具提醒 / ④ 熔断）
  const after = await runAfterStreamGuards(afterStreamState, phaseCtx({ streamed }))
  if (after?.stop) return { state: after.state ?? afterStreamState, stop: normalizeStop(after.stop) }

  // 无 stop ⇒ 也要把守卫累积的 state 回传（否则调用方拿不到本轮的计数/时间戳变化）
  return { state: after?.state ?? afterStreamState, stop: null }
}

// ── 守卫体注册表（Task 2–4 逐个把 `未实现` 占位替换为真实实现）──
// ★ 纪律：**未实现必须抛错**，不得静默跳过 —— 静默跳过 = 等价重构失效且无人发现。
// 表以**函数名**为键：守卫与函数一一对应，故 profile 里的守卫名直接查表。
const GUARD_BODIES = Object.create(null)
for (const name of KNOWN_GUARDS) {
  GUARD_BODIES[name] = async function notImplemented() {
    const task = PHASE_TASK[GUARD_PHASE[name]] || '后续任务'
    throw new Error(`守卫 ${name} 未实现（${task} 补齐）`)
  }
}

/**
 * 注册某相位已实现（已搬移）的守卫体；重复注册/未声明名一律抛错（防拼错后静默失效）。
 * ★ 同名守卫出现在多个相位时（归一后 `stall` 同属 iterHead 与 afterStream），
 *   注册表按名唯一 ⇒ 两相位共用同一实现（与 profile 里同名同义一致）。
 */
function registerGuards(bodies) {
  for (const [name, body] of Object.entries(bodies)) {
    if (!KNOWN_GUARDS.has(name)) throw new Error(`注册了未声明的守卫: ${name}`)
    if (GUARD_BODIES[name].isReal) throw new Error(`守卫 ${name} 重复注册`)
    GUARD_BODIES[name] = Object.assign(body, { isReal: true })
  }
}

// ── Task 3：inStream（①b 流内墙钟 / ③ 生成重复 / ③b 近重复）────────────────────
// 与 iterHead 的关键差异：本相位**不产生 break/continue** —— 命中只置 stop 并中断当前流，
// 由宿主在轮末 finalize 统一收尾。这与搬移前**逐字等价**：原实现在流内设 loopStop 后，
// 流仍会自然结束或被 abort，控制流从不走 break（break 在迭代头）。
// 调用粒度不同：iterHead 是迭代级，本相位是**块级**（每块尾部调一次）。
//
// state 需带 `loopStop`：原实现三处都有 `!loopStop &&` 前置（已停就不再重复检查），
// 此处由守卫首行复现——不能省（省了会在已停后继续 push 命中、重复 abort）。

/** ①b 流内墙钟：拦「块持续流动但整体久拖不完」（迭代边界的墙钟检查拦不住单次超长生成） */
async function guardStreamWallClock(state, ctx) {
  if (state.loopStop) return { state }
  if (!(state.TURN_TIMEOUT_MS > 0)) return { state }
  if (Date.now() - state.turnT0 < state.TURN_TIMEOUT_MS) return { state }
  ctx.turnGuardHits?.push('streamWallClock') // O2：如实登记（①b 无注入）
  ctx.abort?.() // 终止当前流，不再消费后续块
  return {
    state,
    stop: {
      reason: 'timeout',
      message: `【已达单轮时长上限（${Math.max(1, Math.round(state.TURN_TIMEOUT_MS / 60000))} 分钟），为防止挂起已自动收尾。任务可能未完——可发送「继续」让模型接续。】`,
    },
  }
}

/** ③ 生成重复：同一片段连续重复 ≥3 次即判退化循环（genWindow 满 60 字符才可能触发） */
async function guardGenRepeat(state, ctx) {
  if (state.loopStop) return { state }
  const rep = detectGenerationRepeat(state.genWindow)
  if (!rep) return { state }
  ctx.turnGuardHits?.push('genRepeat')
  ctx.abort?.()
  return {
    state,
    stop: {
      reason: 'gen-repeat',
      message: `【检测到模型生成内容重复打转（同一片段连续重复 ${rep.repeats} 次、周期 ${rep.p} 字符），已自动收尾以防死循环。可发送「继续」让模型换一种方式接续，或补充更明确的指令。】`,
    },
  }
}

/** ③b 句级近重复：编织变体循环（措辞微变反复重述）——③ 的精确周期检测抓不到的形态 */
async function guardNearRepeat(state, ctx) {
  if (state.loopStop) return { state }
  const { nearRep, chunk } = state
  if (!nearRep || !(chunk?.type === 'text' || chunk?.type === 'thinking')) return { state }
  const nrep = nearRep.push(chunk.text)
  if (!nrep) return { state }
  ctx.turnGuardHits?.push('nearRepeat')
  ctx.abort?.()
  return {
    state,
    stop: {
      reason: 'near-repeat',
      message: `【检测到模型输出近似内容反复打转（同一批内容措辞微变重复重述，近期每句平均约 ${nrep.avgNeighbor} 句近似旧句），已自动收尾以防死循环。可发送「继续」让模型换一种方式接续，或补充更明确的指令。】`,
    },
  }
}

// Task 2：iterHead（① / ② / ⑥）—— 见上方等价搬移注释
// Task 3：inStream（①b / ③ / ③b）
registerGuards({
  wallClock: guardWallClock, iterCap: guardIterCap, stall: guardStall,
  streamWallClock: guardStreamWallClock, genRepeat: guardGenRepeat, nearRepeat: guardNearRepeat,
})

/**
 * 相位驱动器：按 `resolveGuards(ctx.profile, phase)` 的守卫序**串行**执行。
 * 任一守卫返回 `{ stop }` 即短路返回（后续守卫不再执行）。
 *
 * 返回值同时回传命中守卫要求的**迭代控制动作** `action`（`'break' | 'continue' | null`），
 * 因为它与 stop 并不等价：② 迭代上限是 `break` 而**不置 loopStop**，⑥ 自愈是
 * `continue`。原实现在这三处分别写 break/break/continue，此处**照原样**表达，不统一。
 * @returns {Promise<{stop: null | {reason: string, message?: any}, state?: object, action: null|'break'|'continue'}>}
 */
async function runPhaseGuards(phase, state, ctx) {
  // 未知相位在此抛错（resolveGuards 早失败）；
  // 空守卫序 = profile 缺该相位 ⇒ 也是「未实现」，不得当成「无守卫通过」
  const names = resolveGuards(ctx?.profile, phase)
  if (names.length === 0) {
    throw new Error(`相位 ${phase} 无守卫体：未实现（${PHASE_TASK[phase] || '后续任务'} 补齐 / profile 缺相位）`)
  }
  // 唯一注入出口在相位的装配点成型：守卫只能用这个（不得自造 pushMemory/wire 路径）
  const inject = (text, meta) => {
    emitInjection(ctx, text, meta)
    ctx.onGuardInject?.({ text, persist: meta?.persist === true, event: meta?.event || null })
  }
  const inner = { ...ctx, inject }
  let cur = state
  for (const name of names) {
    const body = GUARD_BODIES[name]
    // profile 里出现了未登记的守卫名 ⇒ 早失败，别静默跳过
    if (typeof body !== 'function') throw new Error(`守卫 ${name} 未实现（未注册实现，相位 ${phase}）`)
    const r = await body(cur, inner)
    if (r && r.state !== undefined) cur = r.state
    const action = r?.action || null
    if (r?.stop) return { state: cur, stop: normalizeStop(r.stop), action }
    // 无 stop 但要求继续跑下一迭代（⑥ 自愈）⇒ 也必须短路，否则后续守卫会叠加判定
    if (action) return { state: cur, stop: null, action }
  }
  return { state: cur, stop: null, action: null }
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
