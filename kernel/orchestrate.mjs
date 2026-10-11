// kernel/orchestrate.mjs —— 编排轮调度（2026-10-07 编排线 T4；spec D16–D26）
// ---------------------------------------------------------------------------
// 职责（可单测的**接线层**）：把"一条用户消息"喂给会话内工作流引擎的一次运行，并合成该轮回复。
//   · 解析：wfEngine.load(workflowId) 存在与否 + `orchestrate:` 段声明（形态校验在
//     loop-modes.mjs#parseCustomLoopMode；此处只判"轮首可解析"，零状态纪律的落地侧）；
//   · 失败 ⇒ 返回 {fallback:true, reason} + emit('orchestration_unavailable')——调用方
//     （kernel/engine 轮首分支）据此落回 react 语义（D23；选择保留、下轮重试）；
//   · wall_ms 硬停（D24）：到点 wfEngine.stop(runId)——runId 预生成并随 run 传入，
//     确保 stop 打在**本轮**运行上（不依赖运行中途回传 id 的时序）；
//   · 轮信号：随 run({signal}) 透传（run 级三源合并见 workflow-engine 的 runSignal）；
//   · 回复合成（D21）：orchestrate.reply 键 → answer → result → 端出键序拼接；非字符串取
//     `.text`、仍非字符串 JSON 化；unresolved 非空附注。
// 不做的事（分层纪律）：不发射执行进度事件（wfEngine 的 onEvent 已在 cli 接 wire.system，
//   零新事件面）；不落 transcript（调用方走既有轮输出路径）；不建授权（grant=null，节点
//   工具调用走会话审批管线，D19）。
//
// 纯接线：只依赖注入的 wfEngine 接口（load/run/stop 三方法；run/stop 见 workflow-engine.mjs
// 的 api 出口），零第三方依赖、零 engine 闭包引用（可单测——假 wfEngine 即可判）。

/** 缺省运行墙钟上限（30 分钟，D24）；可被 orchestrate.limits.wall_ms 或调用方 wallMs 覆盖。 */
export const DEFAULT_ORCHESTRATION_WALL_MS = 30 * 60 * 1000

/**
 * 值 → 可读文本：string 原样；对象带 `text: string` 取它；其余 JSON 化（缩进 2 便于阅读）。
 * @param {unknown} v
 * @returns {string}
 */
function flattenText(v) {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'object' && typeof (/** @type {any} */ (v).text) === 'string') return /** @type {any} */ (v).text
  try {
    return JSON.stringify(v, null, 2) ?? String(v)
  } catch {
    return String(v)
  }
}

/**
 * 回复合成（D21）：`orchestrate.reply` 指定键 → 该键值；缺省按 `answer` → `result` →
 * 端出（finalOutput）键序拼接（null 键跳过）。unresolved 非空时附注（取值失败必须可见）。
 * @param {object|null|undefined} finalOutput
 * @param {string[]} unresolved
 * @param {{ reply?: string }|null} orchestrate
 * @returns {string}
 */
export function composeOrchestrationReply(finalOutput, unresolved, orchestrate) {
  const fo = finalOutput && typeof finalOutput === 'object' ? finalOutput : {}
  const replyKey = typeof orchestrate?.reply === 'string' && orchestrate.reply ? orchestrate.reply : null
  let text = ''
  if (replyKey && Object.hasOwn(fo, replyKey)) text = flattenText(/** @type {any} */ (fo)[replyKey])
  else if (Object.hasOwn(fo, 'answer')) text = flattenText(/** @type {any} */ (fo).answer)
  else if (Object.hasOwn(fo, 'result')) text = flattenText(/** @type {any} */ (fo).result)
  else text = Object.values(fo).map(flattenText).filter(Boolean).join('\n\n')
  if (Array.isArray(unresolved) && unresolved.length) {
    text += `${text ? '\n\n' : ''}（注：${unresolved.length} 个返回值未取到值：${unresolved.join('；')}）`
  }
  return text
}

/**
 * 跑一轮编排（每用户消息一次，D18）。返回形态：
 *   · 回退：`{ fallback:true, reason }`（reason ∈ engine_unavailable / load_error:* / not_found /
 *     not_orchestrable）——调用方落回 react 语义；
 *   · 运行：`{ reply, status, runId, steps, unresolved?, error? }`（status ∈ completed/failed/
 *     cancelled；cancelled 时 reply 恒为空串——"不产生假成功回复"，取消的可读说明由调用方呈现）。
 * @param {{
 *   wfEngine?: { load?: (id: string) => any, run?: (opts: object) => Promise<any>, stop?: (runId: string) => any }|null,
 *   workflowId?: string,
 *   message?: string,
 *   cwd?: string,
 *   signal?: { aborted: boolean }|null,
 *   wallMs?: number,
 *   runId?: string|null,
 *   emit?: ((type: string, payload: object) => void)|null,
 * }} args
 * @returns {Promise<{ fallback: true, reason: string } | { fallback?: false, reply: string, status: string, runId: string, steps: number, unresolved?: string[], error?: string }>}
 */
export async function runOrchestrationTurn({
  wfEngine = null, workflowId = '', message = '', cwd = '', signal = null,
  wallMs = 0, runId: presetRunId = null, emit = null,
} = {}) {
  /** 回退统一出口：事件 + 返回形状（事件失败不阻断）。 */
  const unavailable = (/** @type {string} */ reason) => {
    try { emit?.('orchestration_unavailable', { workflowId, reason }) } catch { /* 事件失败不阻断 */ }
    return { fallback: /** @type {true} */ (true), reason }
  }
  if (!wfEngine || typeof wfEngine.load !== 'function' || typeof wfEngine.run !== 'function') {
    return unavailable('engine_unavailable')
  }
  let wf = null
  try { wf = wfEngine.load(workflowId) } catch (e) {
    return unavailable(`load_error: ${/** @type {any} */ (e)?.message || String(e)}`)
  }
  if (!wf) return unavailable('not_found')
  const orch = wf.orchestrate && typeof wf.orchestrate === 'object' ? wf.orchestrate : null
  if (!orch) return unavailable('not_orchestrable') // presence = 声明（D16；缺段永不按编排跑）

  // 墙钟上限解析：调用方显式 wallMs > 定义 limits.wall_ms > 缺省 30 分钟
  const wfLimit = Number(/** @type {any} */ (orch).limits?.wall_ms)
  const limitMs = Number.isFinite(wallMs) && wallMs > 0 ? wallMs
    : (Number.isFinite(wfLimit) && wfLimit > 0 ? wfLimit : DEFAULT_ORCHESTRATION_WALL_MS)

  const runId = presetRunId || `orch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let timer = null
  if (typeof wfEngine.stop === 'function') {
    timer = setTimeout(() => { try { wfEngine.stop(runId) } catch { /* 停止失败不阻断收尾 */ } }, limitMs)
  }
  let result = null
  try {
    result = await wfEngine.run({
      id: workflowId,
      inputs: { message: String(message ?? '') }, // D22：固定注入 inputs.message（逐字，不 trim）
      cwd,
      runId,
      grant: null, // D19：会话审批管线口径——无 grantToken
      // networkDeclared 不传：按 run 缺省取 wf.permissions?.network === true
      //（spec §4.3b——编排=顶层入口口径，与定时/webhook/自动触发同链）
      ...(signal ? { signal } : {}),
    })
  } finally {
    if (timer) clearTimeout(timer)
  }
  const status = result?.status || (result?.ok ? 'completed' : 'failed')
  const unresolved = Array.isArray(result?.unresolved) ? result.unresolved : []
  const reply = status === 'cancelled' ? '' : composeOrchestrationReply(result?.finalOutput, unresolved, orch)
  return {
    reply,
    status,
    runId: result?.runId || runId,
    steps: result?.steps ?? 0,
    ...(unresolved.length ? { unresolved } : {}),
    ...(result?.error ? { error: result.error } : {}),
  }
}
