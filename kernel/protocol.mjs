// 内核 NDJSON wire 协议辅助（docs/bridge-contract.md §3/§4）
// ---------------------------------------------------------------------------
// 统一内核 → bridge 的 stdout NDJSON 事件形状：
//   system(init/...) / assistant / result / control_request(can_use_tool) /
//   bridge_request(browser)
// 以及 stdin 逐行路由（user / control_request / control_response）。
// 事件 type 名与关键字段是跨层契约（§3-§6），必须保留；内部实现原创。

export function writeLine(stream, obj) {
  try { stream.write(JSON.stringify(obj) + '\n') } catch { /* stdout 已关闭 */ }
}

// 取消中断信号：cancel 触发后置位 aborted，运行中的循环在检查点抛 AbortError
export function abortError() {
  const e = new Error('turn aborted by cancel')
  e.name = 'AbortError'
  return e
}

// 事件构造器 + 写出。extra 合并到事件体（不覆盖 type/subtype 等契约字段）。
export function makeWire(stream = process.stdout) {
  return {
    system(subtype, extra = {}) {
      writeLine(stream, { type: 'system', subtype, ...extra })
    },
    assistant(contentBlocks, extra = {}) {
      const blocks = Array.isArray(contentBlocks)
        ? contentBlocks
        : [{ type: 'text', text: String(contentBlocks) }]
      writeLine(stream, { type: 'assistant', message: { role: 'assistant', content: blocks }, ...extra })
    },
    result(usage = { input_tokens: 0, output_tokens: 0 }, extra = {}) {
      writeLine(stream, { type: 'result', subtype: 'success', usage, ...extra })
    },
    controlRequest({ requestId, toolName, toolUseId, input, reason }) {
      writeLine(stream, {
        type: 'control_request',
        request_id: requestId,
        request: {
          subtype: 'can_use_tool',
          tool_use_id: toolUseId,
          tool_name: toolName,
          input,
          decision_reason: reason,
        },
      })
    },
    bridgeRequest({ route, requestId, payload }) {
      writeLine(stream, { type: 'bridge_request', route, requestId, payload })
    },
    health(data = {}) {
      writeLine(stream, { type: 'yfw_health', ...data })
    },
    summary(text, compactCount) {
      writeLine(stream, { type: 'yfw_summary', text: String(text ?? ''), compactCount })
    },
    // —— subagent 生命周期事件（shape 对齐 release 内核，GUI useYFWCLI task_* 分支消费）——
    // S1 血缘：task_started 携带 parent_task_id/depth（主 agent 派发为 null/0，
    // GUI 可依此渲染任务树；子 lane 嵌套预留，见 subagent-collaboration-upgrade）
    taskStarted({ taskId, toolUseId, prompt, parentTaskId = null, depth = 0 }) {
      writeLine(stream, {
        type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: toolUseId, prompt: prompt || '',
        parent_task_id: parentTaskId || null, depth: Number(depth) || 0,
      })
    },
    // S2 可继续：续跑既有子任务会话时发出（Task resume / Agent resume_task_id）
    taskResumed({ taskId, prompt }) {
      writeLine(stream, { type: 'system', subtype: 'task_resumed', task_id: taskId, prompt: prompt || '' })
    },
    taskProgress({ taskId, lastToolName, description, usage = {} }) {
      writeLine(stream, {
        type: 'system', subtype: 'task_progress', task_id: taskId,
        last_tool_name: lastToolName || '', description: description || '',
        usage: { tool_uses: usage.tool_uses ?? 0, total_tokens: usage.total_tokens ?? 0, duration_ms: usage.duration_ms ?? 0 },
      })
    },
    // S3 结果承接：outputs 为子 agent 会话内全部 Write 产物路径（主 agent 中转
    // 给下家子 agent 的"接力清单"，配合共享工作区实现流水线协同）
    taskNotification({ taskId, status, summary, outputFile, usage = {}, outputs = [] }) {
      writeLine(stream, {
        type: 'system', subtype: 'task_notification', task_id: taskId,
        status: status || 'completed', summary: summary || '', output_file: outputFile || '',
        outputs: Array.isArray(outputs) ? outputs : [],
        usage: { tool_uses: usage.tool_uses ?? 0, total_tokens: usage.total_tokens ?? 0, duration_ms: usage.duration_ms ?? 0 },
      })
    },
    // 插话/排队消息接收确认：内核吸收 user 消息（工具边界注入当前轮或作为新轮）
    // 时回发，供 GUI 解除气泡悬浮态（useYFWCLI.ts command_lifecycle 分支消费）。
    commandLifecycle(uuid, state = 'started') {
      writeLine(stream, { type: 'command_lifecycle', data: { uuid, state } })
    },
  }
}
