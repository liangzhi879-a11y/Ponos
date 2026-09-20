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

// ── Task 4：afterStream（由三个不相邻的宿主时机共同支撑）─────────────────────────
//
// ★ 为何 afterStream 需要 `timing` 门控（Task 4 实测，计划未预见）：
//   本相位的 6 个守卫**不在同一时刻执行** —— 原实现里它们分别位于
//     ① 流后·工具前（`:947` repeatHeal，夹在流结束与工具执行之间）
//     ② 工具后（`:1133-1183` progressRefresh / repeatReminder / meltdown）
//     ③ catch 块（`:739-800` idleWatchdog / upstreamDead，流抛错后按错误分类）
//   三段之间夹着工具执行与内存写入 ⇒ **无法用一次调用包住**。
//   若拆成三个相位，要改 `PHASES` 与全部相位集断言（结构代价大，且 `runOnce` 编排随之复杂）；
//   故用 `state.timing` 门控：宿主在三个时机各调一次 `runAfterStreamGuards`，
//   守卫体只在自己那一刻生效（不匹配即跳过），**顺序仍在 profile 里定义**（单一真源不变）。
//   `state.timing` 缺省时**全放行**（向后兼容直接单测守卫体的用法）。

/** 守卫名 → 生效时机（`afterStream` 专用；未列出 = 不限时机） */
const GUARD_TIMING = {
  repeatHeal: 'postStream',
  progressRefresh: 'postTools', repeatReminder: 'postTools', meltdown: 'postTools',
  idleWatchdog: 'onError', upstreamDead: 'onError',
}

/** repeatHeal 自愈注入文案（逐字搬移自 engine.mjs:955，**勿改标点**） */
const REPEAT_HEAL_INJECT_TEXT = '【系统】检测到你刚才的回复在反复复述近似内容（疑似陷入生成循环），该部分已被丢弃。请立即停止复述，直接推进当前任务——执行下一步具体行动或直接给出最终结论。'

/** ① 流后·工具前：R3-2 重复自愈 —— 退化流丢弃 + 注入推进指令 + `continue`（有上限） */
async function guardRepeatHeal(state, ctx) {
  const { loopStop, REPEAT_HEAL_MAX, repeatHeals } = state
  if (!loopStop) return { state }
  if (REPEAT_HEAL_MAX === 0) return { state }
  if (!(REPEAT_HEAL_MAX < 0 || repeatHeals < REPEAT_HEAL_MAX)) return { state }
  if (!(loopStop.reason === 'gen-repeat' || loopStop.reason === 'near-repeat')) return { state }
  ctx.turnGuardHits?.push('repeatHeal')
  ctx.turnGuardInjections?.bump()
  const healReason = loopStop.reason
  ctx.inject?.(REPEAT_HEAL_INJECT_TEXT, {
    persist: true,
    event: { name: 'guard_heal', payload: { reason: healReason, attempt: repeatHeals + 1, max: REPEAT_HEAL_MAX } },
  })
  // ★ `loopStop` 必须**清空**并 `continue` —— 只"返回 stop"会误收尾（本次已由单测钉住）；
  //   同时 `textBuf` 清空 = 退化内容不落模型输入（与收尾路径"不落退化内容"同哲学）。
  return {
    state: { ...state, repeatHeals: repeatHeals + 1, healedLastIter: true, loopStop: null, textBuf: '' },
    action: 'continue',
  }
}

/** ② 工具后：进展刷新 ——**纯状态更新**，无 stop、无注入、不登记命中（原实现亦不登记） */
async function guardProgressRefresh(state) {
  if (!state.madeProgress) return { state }
  return { state: { ...state, lastProgressAt: Date.now(), stallHeals: 0 } }
}

/** ② 工具后：守卫⑤ 连续同工具提醒（仅提醒不否决，硬性由迭代上限兜底） */
async function guardRepeatReminder(state, ctx) {
  if (state.loopStop) return { state }
  const { REPEAT_REMIND_AT, blocks, batchToolKey, canonicalToolCallKey, shouldRemindRepeat, repeatRemindText } = state
  if (!REPEAT_REMIND_AT?.length || !blocks?.length) return { state }
  const key = batchToolKey(blocks, canonicalToolCallKey)
  let repeatStreak = state.repeatStreak ?? 0
  let lastToolKey = state.lastToolKey
  let remindedAt = state.remindedAt
  if (key && key === lastToolKey) {
    repeatStreak++
  } else {
    repeatStreak = 1
    lastToolKey = key
    remindedAt = new Set()
  }
  const next = { ...state, repeatStreak, lastToolKey, remindedAt }
  if (!shouldRemindRepeat(repeatStreak, REPEAT_REMIND_AT, remindedAt)) return { state: next }
  remindedAt.add(repeatStreak)
  ctx.turnGuardHits?.push('repeatReminder')
  ctx.turnGuardInjections?.bump()
  ctx.inject?.(repeatRemindText(repeatStreak, blocks[0].name), { persist: true })
  return { state: next }
}

/** ② 工具后：守卫④ 连续全败熔断 —— 先自愈（重开失败预算 + `continue`），耗尽才硬停 `break` */
async function guardMeltdown(state, ctx) {
  const { MAX_ERROR_ITERATIONS, errorStreak, hasMeltdownBudget, MELTDOWN_HEAL_MAX, errorMeltdownText } = state
  if (!(MAX_ERROR_ITERATIONS > 0 && errorStreak >= MAX_ERROR_ITERATIONS)) return { state }
  if (hasMeltdownBudget(state.meltdownHeals, MELTDOWN_HEAL_MAX)) {
    ctx.turnGuardHits?.push('meltdown')
    ctx.turnGuardInjections?.bump()
    ctx.inject?.(errorMeltdownText('main'), {
      persist: true,
      event: { name: 'guard_heal', payload: { reason: 'error-meltdown', attempt: state.meltdownHeals + 1, max: MELTDOWN_HEAL_MAX } },
    })
    // `errorStreak = 0` = 重开失败预算（愈合窗口内再给一轮完整容错）；`textBuf` 清空同自愈路径
    return {
      state: { ...state, meltdownHeals: state.meltdownHeals + 1, errorStreak: 0, textBuf: '' },
      action: 'continue',
    }
  }
  ctx.turnGuardHits?.push('meltdown')
  return {
    state,
    stop: {
      reason: 'error-meltdown',
      message: `【连续 ${errorStreak} 轮工具调用全部失败，已自动收尾停止重试。请检查失败原因（权限/环境/参数）后重新发起，或明确告知用户无法推进。】`,
    },
    action: 'break',
  }
}

/** ③ catch 块：内部空闲看门狗 —— 三态（零产出重试 / 已产出自愈 / 硬停），前两态均 `continue` */
async function guardIdleWatchdog(state, ctx) {
  const {
    watchdogTripped, attemptData, loopStop, IDLE_DEAD_RETRY_MAX, idleDeadRetries,
    IDLE_HEAL_MAX, idleHeals, STREAM_IDLE_MS, STREAM_FIRST_BYTE_MS,
  } = state
  if (loopStop) return { state }
  if (!watchdogTripped) return { state }
  // 态一：全程 0 产出（上游空转/未就绪）→ 退避重发一次常能恢复（自建服务 prefill 排队常见）
  if (!attemptData && idleDeadRetries < IDLE_DEAD_RETRY_MAX) {
    return {
      state: { ...state, idleDeadRetries: idleDeadRetries + 1 },
      action: 'continue',
      // 宿主动作：回收旧看门狗定时器 + 退避等待（新迭代重建 watchdog，首内容窗口重新计时）
      signal: 'idle-dead-retry', backoffMs: state.IDLE_DEAD_RETRY_BACKOFF_MS,
    }
  }
  // 态二：已产出后停顿（疑似推理中断）→ 保留已产出内容、注入续写指令静默续跑
  if (attemptData && (IDLE_HEAL_MAX < 0 || idleHeals < IDLE_HEAL_MAX)) {
    ctx.turnGuardHits?.push('idleWatchdog')
    ctx.turnGuardInjections?.bump()
    ctx.turnGuardHits  // （命中登记与实际注入分列，同 O2 口径）
    ctx.inject?.('【系统】检测到你的回复在中途停顿（疑似推理中断）。请从上一条回复的断点处直接继续输出剩余内容——不要从头复述，不要重新解释已完成的部分。', {
      persist: true,
      event: { name: 'guard_heal', payload: { reason: 'idle-interrupted', attempt: idleHeals + 1, max: IDLE_HEAL_MAX } },
    })
    // `flushText` 是**清空前的原文**：宿主需先把这段已产出内容落 memory/transcript
    // （用户看到"无缝续写"的前提），守卫体不碰会话对象 ⇒ 只能把原文交回宿主。
    return {
      state: { ...state, idleHeals: idleHeals + 1, textBuf: '' },
      action: 'continue',
      signal: 'idle-heal', flushText: state.textBuf,
    }
  }
  // 态三：硬停 —— 按是否已产出分两种 reason/文案（文案逐字搬移）
  ctx.turnGuardHits?.push(attemptData ? 'idleWatchdog' : 'upstreamDead')
  return {
    state,
    stop: attemptData
      ? {
          reason: 'idle',
          message: `【模型输出中断（${Math.max(1, Math.round(STREAM_IDLE_MS / 1000))} 秒无数据，此前已产出部分内容——疑似模型推理中途停顿），已按挂起自动收尾。可发送「继续」让模型重试。】`,
        }
      : {
          reason: 'upstream-dead',
          message: `【模型输出中断（连接建立后 ${Math.max(1, Math.round(STREAM_FIRST_BYTE_MS / 1000))} 秒未收到任何数据——上游疑似未就绪/空转），已按挂起自动收尾。可发送「继续」重试，或检查 provider 对应模型服务是否正常后换一种方式继续。】`,
        },
  }
}

/** ③ catch 块（dead-stream 分支）：上游空流（HTTP 200 却 0 事件）——退避静默重试，耗尽才可见收尾 */
async function guardUpstreamDead(state, ctx) {
  const { upstreamDeadHeals, UPSTREAM_DEAD_HEAL_MAX } = state
  if (!(upstreamDeadHeals < UPSTREAM_DEAD_HEAL_MAX)) {
    // 预算耗尽 ⇒ 硬停（★ 文案与 idleWatchdog 的 `upstream-dead` **不同**：
    // 那是"连接建立后超时未收到数据"，本处是"请求已受理却空流 EOF"——两个站点、两种文案，
    // 归一成一条会把用户引向错误的排查方向，故逐字保留站点各自的原文。）
    ctx.turnGuardHits?.push('upstreamDead') // O2：上游死亡硬停（同样只有事件、无注入）
    return {
      state,
      stop: {
        reason: 'upstream-dead',
        message: '【上游服务空流：请求已被受理但未返回任何数据（疑似模型服务未就绪、加载中或已崩溃），已自动收尾。请检查 provider 对应服务是否正常，或切换 provider 后重试。】',
      },
    }
  }
  ctx.turnGuardHits?.push('upstreamDead') // O2：上游死亡**只发事件、无注入** ⇒ 只登记不计数（如实，不粉饰）
  ctx.inject?.('', {
    event: { name: 'guard_heal', payload: { reason: 'upstream-dead', attempt: upstreamDeadHeals + 1, max: UPSTREAM_DEAD_HEAL_MAX } },
  })
  return {
    state: { ...state, upstreamDeadHeals: upstreamDeadHeals + 1 },
    action: 'continue',
    signal: 'upstream-dead-retry', backoffMs: state.UPSTREAM_DEAD_HEAL_BACKOFF_MS,
  }
}

// Task 2：iterHead（① / ② / ⑥）—— 见上方等价搬移注释
// Task 3：inStream（①b / ③ / ③b）
// Task 4：afterStream（按 timing 门控的三个时机）
registerGuards({
  wallClock: guardWallClock, iterCap: guardIterCap, stall: guardStall,
  streamWallClock: guardStreamWallClock, genRepeat: guardGenRepeat, nearRepeat: guardNearRepeat,
  repeatHeal: guardRepeatHeal, progressRefresh: guardProgressRefresh,
  repeatReminder: guardRepeatReminder, meltdown: guardMeltdown,
  idleWatchdog: guardIdleWatchdog, upstreamDead: guardUpstreamDead,
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
    // timing 门控：afterStream 由三个不相邻的宿主时机共同支撑，守卫只在自己那一刻生效。
    // 缺省（undefined）**全放行** —— 直接单测某守卫体时无需伪造 timing。
    const need = GUARD_TIMING[name]
    if (need && cur?.timing && cur.timing !== need) continue
    const r = await body(cur, inner)
    if (r && r.state !== undefined) cur = r.state
    const action = r?.action || null
    // `signal`/`flushText`/`backoffMs` 是**宿主专属动作**的载荷：守卫体不能碰会话对象、
    // 定时器、sleep ⇒ 只能把"要做什么"交回宿主（宿主是唯一知道怎么做的层）。
    const extra = { signal: r?.signal, flushText: r?.flushText, backoffMs: r?.backoffMs }
    if (r?.stop) return { state: cur, stop: normalizeStop(r.stop), action, ...extra }
    // 无 stop 但要求继续跑下一迭代（⑥ 自愈 / R3-2 重复自愈 / 熔断自愈 / 空闲自愈）⇒ 也必须
    // 短路，否则后续守卫会叠加判定
    if (action) return { state: cur, stop: null, action, ...extra }
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
