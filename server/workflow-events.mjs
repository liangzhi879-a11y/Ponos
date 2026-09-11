// server/workflow-events.mjs —— 内核 stdout 消息 → 工作流分发的**纯函数**（UI Task 14b / Task 12 审查 I-3）
//
// 背景：事件转发原先内联在 bridge.mjs 的 `rl.on('line')` 巨型回调里，只能在"真起桥"的
// 集成场景下验证（bridge.mjs 顶层会 listen(51517) 并可能 taskkill 用户进程，测试不能 import）。
// 抽成纯函数后，分类规则可被 node:test 直接覆盖，bridge 只剩"按 kind 执行副作用"。
//
// 分类规则（与抽函数前的 bridge 行为逐条等价）：
//   · subtype === 'workflow'  → 'workflow_event'：内核 `wire.system('workflow', ev)` 的实际形态是
//     `{type:'system', subtype:'workflow', ...ev}`——ev.type（start/node/node_skipped/edge_taken/end）
//     会**覆盖**外层 type，故事件判定只认 subtype，不看 type。调用方广播为
//     `{type:'workflow_event', sessionId, event: payload}`。
//   · 否则 type === 'system' → 'workflow_result'：宿主会话（_wfhost）的系统回执
//     （load/save-raw/validate/run/stop 的 {requestId, result}），交 workflowHost().onKernelMessage
//     按 requestId 配对；无 requestId 的 error 回执由宿主 LIFO 结清。
//   · 其余 → null（普通会话的 assistant/result/control_request… 走既有通用转发，工作流模块不插手）。
//
// 约束：只做判定，不产生副作用；不 import server/workflow-host.mjs（避免把宿主会话依赖
// 拖进单测），也不 import kernel/*（生产包只带 kernel-dist/cli.mjs）。
const WORKFLOW_EVENT_SUBTYPE = 'workflow'

/**
 * @param {unknown} parsed 已 JSON.parse 的内核 stdout 行（解析失败则为 null/undefined）
 * @returns {{ kind: 'workflow_event' | 'workflow_result' | null, payload: any }}
 *   payload = 原消息（不复制：bridge 直接把它抛给广播/宿主，保持引用等价）；
 *   kind === null 时 payload 恒为 null。
 */
export function mapKernelMessage(parsed) {
  if (!parsed || typeof parsed !== 'object') return { kind: null, payload: null }
  if (parsed.subtype === WORKFLOW_EVENT_SUBTYPE) return { kind: 'workflow_event', payload: parsed }
  if (parsed.type === 'system') return { kind: 'workflow_result', payload: parsed }
  return { kind: null, payload: null }
}
