// 内核 NDJSON wire 协议辅助（docs/bridge-contract.md §3/§4）
// ---------------------------------------------------------------------------
// 统一内核 → bridge 的 stdout NDJSON 事件形状：
//   system(init/...) / assistant / result / control_request(can_use_tool) /
//   bridge_request(browser)
// 以及 stdin 逐行路由（user / control_request / control_response）。
// 事件 type 名与关键字段是跨层契约（§3-§6），必须保留；内部实现原创。

export function writeLine(stream, obj) {
  // result = 一轮收尾 → 轮次结束，硬看门狗解武装（轮间空闲不误杀）
  if (obj && obj.type === 'result') turnActive = false
  try {
    stream.write(JSON.stringify(obj) + '\n')
    // 只有**写成功**才推进"最近 wire 输出时刻"（2026-09-12 异步链失活事故）：旧写法
    // 在 write 之前推进，写到已关闭/已销毁的 stdout 上一样算数——看门狗被一个"实际
    // 已经说不出话"的内核骗过去。自愈帧（guard_heal）尤其危险：每次愈合都写一帧，
    // 于是"续命本身"不断重置看门狗，2006s/2911s 的纯静默窗口就是这么被延续的。
    lastWireWriteAt = Date.now()
  } catch (e) {
    wireWriteFailures++
    lastWireWriteError = e?.message || String(e)
  }
}

export function wireLastWriteAt() {
  return lastWireWriteAt
}

// 写失败计数（硬看门狗现场指纹用）：连续失败 = stdout 实际已断，静默时长不再可信
export function wireWriteStats() {
  return { failures: wireWriteFailures, lastError: lastWireWriteError }
}

export function setTurnActive(v) {
  turnActive = v === true
}

export function isTurnActive() {
  return turnActive
}

// 等待用户（审批）标记：内核发 can_use_tool control_request 前 begin，收到回执/超时/拒绝
// 全部等待者后 end。用计数而非布尔：同一批并行工具调用可能同时挂起多个审批，任何一个
// 解除都不该把"还在等"的状态抹掉。硬看门狗据此**展期**而不是暂停判定：等的是人不该被
// 内核自己的看门狗杀掉（2026-09-12：用户思考超过 600s 就被 exit(7) 杀掉、且自杀前不写
// result/error 帧，桥只见 close、作答落空），但"GUI 永不回执"必须有界——只加一个
// "审批上限"宽限窗口，超了照杀。
export function beginAwaitingUser() {
  awaitingUserCount++
}

export function endAwaitingUser() {
  if (awaitingUserCount > 0) awaitingUserCount--
}

export function isAwaitingUser() {
  return awaitingUserCount > 0
}

let lastWireWriteAt = Date.now()
let turnActive = false
let awaitingUserCount = 0
let wireWriteFailures = 0
let lastWireWriteError = ''

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
    controlRequest({ requestId, toolName, toolUseId, input, reason, hard, mode }) {
      writeLine(stream, {
        type: 'control_request',
        request_id: requestId,
        request: {
          subtype: 'can_use_tool',
          tool_use_id: toolUseId,
          tool_name: toolName,
          input,
          decision_reason: reason,
          // hard：命中灾难级硬黑名单（四档都要问、且不参与拒绝降级计数）；
          // mode：发起本次询问时生效的审批档位。弹窗据此显示"为什么问、是不是硬黑名单"。
          // 二者缺省省略，保持旧载荷逐字节不变（旧桥/GUI 解析不受影响）。
          ...(hard ? { hard: true } : {}),
          ...(mode ? { mode } : {}),
        },
      })
    },
    bridgeRequest({ route, requestId, payload }) {
      writeLine(stream, { type: 'bridge_request', route, requestId, payload })
    },
    health(data = {}) {
      writeLine(stream, { type: 'ponos_health', ...data })
    },
    // 上下文窗口余量预警（engine preStep 在接近压缩阈值时发出；GUI/TUI 可渲染
    // 黄色警示条，提醒长会话即将触发压缩）
    warning(data = {}) {
      writeLine(stream, { type: 'ponos_warning', ...data })
    },
    // loop 迭代状态事件（cli.loopRunner 发出；GUI/bridge 依 state 渲染轮次徽标）
    loop(state, data = {}) {
      writeLine(stream, { type: 'loop', state, ...data })
    },
    summary(text, compactCount) {
      writeLine(stream, { type: 'ponos_summary', text: String(text ?? ''), compactCount })
    },
    // 工具结果 live 回传（2026-09-09 会话 UI 标准化）：此前 wire 只发
    // tool_use、结果仅落盘 transcript（GUI 历史回放才可见）——内联工具卡片的
    // "执行中/完成/失败"状态机依赖本事件。bridge 转发、GUI 回填对应 part。
    toolResult({ toolUseId, content, isError = false }) {
      writeLine(stream, {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: String(content ?? ''),
        is_error: isError === true,
      })
    },
    // —— subagent 生命周期事件（shape 对齐 release 内核，GUI usePonosCLI task_* 分支消费）——
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
    // 时回发，供 GUI 解除气泡悬浮态（usePonosCLI.ts command_lifecycle 分支消费）。
    commandLifecycle(uuid, state = 'started') {
      writeLine(stream, { type: 'command_lifecycle', data: { uuid, state } })
    },
  }
}
