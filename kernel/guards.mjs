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
 * 系统提示的**统一机读标记**（待办「所有系统提示不允许出现在用户可见历史中，静默运行」）。
 *
 * 内核注入的一切"非用户发言"内容（守卫自愈、停滞推进、主 Agent 消息、上下文继承摘要…）
 * 在 transcript entry **顶层**带 `systemInjection: true`，让"这是不是系统提示"从
 * **靠文案正则猜**变成**可判定**。
 *
 * 为什么必须标记（此前三处正则判据的实证代价）：
 *   ① 只能按"开头字样"猜——`server/transcript.mjs` 的 `^(【系统】|【提示】)`、GUI 侧
 *      `<task-notification|system-reminder>` 信封正则；`【主 Agent 消息】`、
 *      `<compacted-summary>` 这类同样非用户发言的内容判不出来。
 *   ② 判据分散且**必然漂移**：展示路径过滤、导出路径（`tailFirst=false`）完全不过滤
 *      ⇒ 导出文件里系统自愈注入对用户可见，正是本待办要消灭的形态。
 *   ③ 新增一条守卫文案就得同步改过滤规则，漏改即泄漏。
 * 打标后：写入侧（engine.mjs 的 appendSystemUser / appendLaneSystemUser 两个出口）打标
 * 一次，读取侧单点判据（src/lib/transcriptAdapter.ts 的 isSystemInjectionEntry）——
 * GUI 的载入 / 断线重同步 / 导出 / 蒸馏全部经该适配器，判据自然共享。
 *
 * ⚠️ 语义边界：
 *   · **只影响展示层**。entry.message 原样进 `deriveMessages()`（模型上下文），
 *     transcript 原文亦不动——`planTailText()` 首句仍是 api.mjs mock 的恢复锚点。
 *   · 字段名是**跨层契约**（kernel 写 / GUI 读），两侧不一致即静默失效（过滤不生效 =
 *     系统提示又回到用户历史），故 kernel-tests/system-inject-mark.test.mjs 有跨文件守卫钉死。
 */
export const SYSTEM_INJECT_MARK = 'systemInjection'

/** 打标用的 extra（`session.appendUser(content, extra)` 的第二参，经 baseEntry 摊到 entry 顶层）。 */
export const SYSTEM_INJECT_EXTRA = Object.freeze({ [SYSTEM_INJECT_MARK]: true })

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

/**
 * 是否处于"活跃等待"：本批工具里存在**超时结束**的调用。
 *
 * 2026-09-21（长任务可靠性 P1 Task 9）：守卫⑥ 原先只看 isRealProgress（成功且非只读测量），
 * 而**超时不刷新进展** ⇒ "在跑长命令/等长工具"被等同于"停滞"：连续几个长工具就凑满
 * LOOP_STALL_MS（10min）阈值被误注入、进而收尾（用户症状①"长任务中断"）。
 * 超时是"模型做了正确的事但在等"，必须与"真失败"区分（后者仍应累计失败、触发熔断）；
 * 也只有超时算在忙 —— 否则模型能靠不断失败来逃避停滞判据。
 *
 * @param {Array<{is_error?: boolean, timeout?: boolean}>} toolResults
 * @returns {boolean}
 */
export function hasActiveWait(toolResults) {
  return (toolResults || []).some((r) => r?.timeout === true)
}

/**
 * 本批工具是否**全部**以超时结束（连击计数的输入）。
 *
 * 2026-09-21（长任务可靠性 P1 Task 9）：hasActiveWait 给"在忙"开了续命口子，续命不能变成
 * 无限拖延 —— 连续多批**全部**超时才累计连击（GuardStall 的「超时连击」分支据此兜底）。
 * 判据取"全部"而非"任一"：一批里只要有一个成功结果就是实质进展，不该计连击。
 *
 * @param {Array<{timeout?: boolean}>} toolResults
 * @returns {boolean}
 */
export function allToolsTimedOut(toolResults) {
  const rs = toolResults || []
  return rs.length > 0 && rs.every((r) => r?.timeout === true)
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

/**
 * 计划尾（R3-2）注入文案：两侧**逐字相同**（原本只在主循环内联，2026-09-16 补子 lane
 * 时收敛为唯一实现，避免同一文案两处维护）。
 *
 * ⚠️ 文案首句 `【系统】你在上一轮承诺了后续动作` 是 api.mjs mock 的**恢复触发锚点**
 * （自带 R3-2 守卫恢复测试分支按该串匹配历史），改动此串必须同步 api.mjs 的匹配串，
 * 否则 mock e2e 会退化为"注入后无恢复"。
 */
export function planTailText() {
  return '【系统】你在上一轮承诺了后续动作（先…/接下来…/开始…）但未执行工具调用就结束了回合。'
    + '任务型轮次必须以实际工具调用收尾——请立即落实你提到的计划，或明确说明任务已完成并给出结果摘要。'
}

/**
 * 守卫⑤ 链键（2026-09-16 口径收紧）：以**整批工具调用**的规范键集合为基准，
 * 而非「每轮第一个 tool_use」。
 *
 * 旧口径的误报形态（活跃度巡检实测）：模型每轮以同一调用开头（固定的状态检查命令、
 * 同一文件 Read）时，**即使后续调用完全不同**，也会被判"连续同工具同参数"并注入
 * 【提示】——该提示是出现频率最高的循环守卫注入（近 3 天 53 次，高于熔断 52 / 计划尾 29）。
 * 整批键要求"整批一模一样"才累计：真死循环（同一调用反复）仍被抓，批量同类改造
 * （多调用但每轮相同）同样命中，而"开头相同 + 后续不同"的正常工作流不再误报。
 *
 * @param {Array} blocks 本轮 tool_use 块
 * @param {(b: object) => string} keyOf 单块规范键函数（调用方注入 `canonicalToolCallKey`）
 *   ——本模块保持**零依赖纯函数**（见文件头约束），故不自行 import 生成侧实现。
 */
export function batchToolKey(blocks, keyOf) {
  const list = Array.isArray(blocks) ? blocks : []
  if (!list.length || typeof keyOf !== 'function') return ''
  return list.map((b) => keyOf(b)).sort().join('|')
}

/**
 * R3-2 失败自愈的「收尾出口」判据（2026-09-16）：文本是否已明确收尾（完成声明 /
 * 交付结果 / 请示用户）？
 *
 * 为什么必须有这条：注入文案自己就承诺了这条出路——计划尾注入写的是"…请立即落实你
 * 提到的计划，**或明确说明任务已完成并给出结果摘要**"。而判据此前只认「有工具错误 +
 * 纯文本收尾」，不认模型**照做**给出的结果摘要 ⇒ 形成"提示 → 照做 → 再提示"的循环。
 * 实测代价被放大：`tools.mjs` 把 Bash 非零退出码一律记 `is_error`，而日常 `grep -c`
 * 无匹配返回 1 ⇒「工具报错 → 模型给出结论收尾」是常态，却被反复拉回工具轮
 * （单会话实测 16 次失败自愈注入）。
 *
 * 刻意**不**收 "无法继续/阻塞/卡住" 这类措辞：那正是 R3-2 要抓的"认错即停"，判为
 * 已收尾会让守卫失效（原有的强制重试价值）。只认三类明确出路：完成声明 / 交付结果 /
 * 请示用户。判据口径：末尾 300 字符内出现收尾语，**且收尾语之后不再出现计划尾巴**——
 * 收尾语后接计划（"前一步已完成。接下来我准备继续读下一个文件并验证。"）不算收尾：
 * 它仍是待推进的计划尾巴，交给计划尾守卫处理；而"以下是整理结果：\n- 项 A\n- 项 B"
 * 这类**交付清单**算收尾（收尾语在清单首行，清单本身不是承诺）。
 * 计划判据由调用方注入（`isPlanTailFn`）——本模块保持零依赖纯函数（见文件头约束），
 * 同时避免把 PLAN_TAIL_RE 抄一份造成两处判据漂移；缺省不传则退化为"只认收尾语"。
 */
export const CLOSED_OUT_RE = /(已完成|已全部完成|全部完成|任务完成|已生成|已产出|已整理|已修复|已落地|已保存|以上是|以下是(?:完成|整理|结果|汇总)|总结如下|结果如下|汇总如下|需要你(?:确认|决定|提供)|请你确认|请确认后|等待你)/
export function isClosedOut(text, isPlanTailFn) {
  const tail = String(text ?? '').trim().slice(-300)
  if (!tail) return false
  const m = tail.match(CLOSED_OUT_RE)
  if (!m) return false
  const after = tail.slice(tail.indexOf(m[0]) + m[0].length)
  if (after && typeof isPlanTailFn === 'function' && isPlanTailFn(after)) return false
  return true
}
