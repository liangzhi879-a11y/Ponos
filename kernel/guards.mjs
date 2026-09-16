// 共享循环守卫判定与文案（P1-6，2026-09-16）
// ---------------------------------------------------------------------------
// 背景：`engine.mjs` 的**主循环**（runTurnInternal）与**子 lane**（runSubAgentLoop）
// 此前各有一份守卫实现 —— engine.mjs 内注释逐条自认「子 lane 镜像主循环」
// 「审计 #10（子 lane 镜像）」。这是"同一逻辑两处维护"：改一处忘另一处，会让子
// lane 的守卫长期落后于主循环（审计 #4 即记录了这种落后：子 lane 曾无错误熔断，
// 连续全败一路空转到迭代上限）。
//
// 本模块收敛**两侧必须一致的两类东西**：
//   ① 判据（progress 口径、阈值命中、预算是否还有）—— 口径不一致＝两侧行为漂移；
//   ② 注入文案（同一条提醒两侧各写一份模板串，改一处就分叉）。
//
// 提取边界（为什么只提这些、不提状态推进与副作用）：
//   - **状态推进**（`streak++` / `= new Set()` 之类的赋值）留在 engine.mjs：它是一行
//     直白赋值，抽成函数只会增加间接层，且需要把可变状态在两侧传来传去，风险更大。
//     故本模块的函数都返回"判定结果/文本"，由调用方自己改状态。
//   - **副作用**（pushMemory / session.appendUser / store.appendUser / wire.system 事件）
//     留在原地：两侧**故意不同**——主循环面向交互用户（发 guard_heal 事件、可继续交互），
//     子 lane 面向后台任务（以 guardStop 收尾）。强行统一会改变既有行为。
//   - 阈值常量（MAX_ERROR_ITERATIONS / REPEAT_REMIND_AT / MELTDOWN_HEAL_MAX）仍以
//     engine.mjs 为单一真相源，**由调用方传入**，本模块不复制常量值。
//
// 约束：本模块为纯函数集合，无 IO、无状态、不导入 engine.mjs（避免循环依赖）。

/**
 * 守卫⑥：本轮是否取得**实质进展**。
 * 口径：有任一"成功且非只读测量"的工具结果即为进展。
 * - `Browser` 的 `js`/`snapshot` 是**只读测量**（用于观察而非改变状态）→ 不算进展，
 *   于是"测量打转"循环会被停滞守卫（LOOP_STALL_MS）拦下。
 * - 失败结果不算进展。
 * @param {Array<{name?: string, input?: object}>} blocks 本轮 tool_use 块（与 toolResults 同序）
 * @param {Array<{is_error?: boolean}>} toolResults
 */
export function isRealProgress(blocks, toolResults) {
  return blocks.some((b, i) => {
    if (toolResults[i]?.is_error) return false
    if (b.name !== 'Browser') return true
    const a = String(b.input?.action || '')
    return !(a === 'js' || a === 'snapshot')
  })
}

/** 守卫④：本轮工具结果是否**全部失败**（空结果不算"全部失败"）。 */
export function allToolResultsFailed(toolResults) {
  return toolResults.length > 0 && toolResults.every((r) => r.is_error)
}

/**
 * R3-2：更新"上一轮存在工具错误"标记（三态）。
 * - 本轮有任一失败 → true（模型下一轮若认错即停，守卫会强制重试）
 * - 本轮有结果但全成功 → false（错误已恢复，不再触发守卫）
 * - 本轮无结果 → 保持原值（无信息，不改变判断）
 */
export function nextHadToolError(prev, toolResults) {
  if (toolResults.some((r) => r.is_error)) return true
  if (toolResults.length) return false
  return prev
}

/**
 * 守卫⑤：是否**应发"连续同工具"提醒**。
 * 到阈值、且该档位未提醒过（`reminded` 防重复注入同一档）。
 */
export function shouldRemindRepeat(streak, thresholds, reminded) {
  return Array.isArray(thresholds) && thresholds.includes(streak) && !reminded.has(streak)
}

/**
 * 守卫⑤注入文案（两侧**逐字相同**——原本就是复制粘贴，故收敛为唯一实现）。
 * @param {number} streak
 * @param {string} toolName
 */
export function repeatRemindText(streak, toolName) {
  return `【提示】你已连续 ${streak} 次调用同一工具（${toolName}）且未见方向变化。`
    + '若前几次未取得实质进展，请换一种方法（其他工具、拆解子任务或直接向用户说明卡点），不要重复无进展的调用。'
}

/**
 * 守卫④熔断愈合注入文案。两侧**故意不同**（故用 variant 区分，而非强行统一）：
 * - `'main'`：面向交互用户，含明确排查手段（Read 文件/日志、看上一轮 tool_result 的
 *   stderr）与"向用户说明阻塞原因"的收尾要求；
 * - `'lane'`：面向后台子任务（无交互对象），文案更简、要求"输出阻塞说明"。
 */
export function errorMeltdownText(variant) {
  if (variant === 'lane') {
    return '【系统】检测到连续多轮工具调用全部失败。请停止原样重试：先读取最新失败的具体错误信息，'
      + '分析失败原因（权限/环境/参数/路径），改用修正后的调用重试；仍无法推进时输出阻塞说明。'
  }
  return '【系统】检测到连续多轮工具调用全部失败。请停止原样重试：先读取最新失败的具体错误信息'
    + '（Read 相关文件/日志，或查看上一轮 tool_result 的 stderr），分析失败原因（权限/环境/参数/路径），'
    + '改用修正后的调用重试；仍无法推进时向用户说明阻塞原因。'
}

/**
 * 守卫④：是否仍有愈合预算（`max < 0` = 不限次）。
 * 两侧共用同一判据——原本各写一遍，符号方向写反即成为"愈合不生效"类隐性缺陷。
 */
export function hasMeltdownBudget(heals, max) {
  return max < 0 || heals < max
}
