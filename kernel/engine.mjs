// YFW-turbo Agent 循环（docs/bridge-contract.md §9 替换面）
// ---------------------------------------------------------------------------
// runTurn：user 消息入 session → 循环调用 api.streamMessages：
//   - 文本/思考块 → wire.assistant 流式转发
//   - tool_use 块 → 权限判定（高危 Bash → can_use_tool 挂起等 control_response）
//     → tools 执行 → tool_result 经 session.appendToolResult 落盘 → 再调 API，
//     直到模型输出纯文本
// 取消：cli 调 engine.abort()，流循环在检查点抛 AbortError → cli 输出
// '已取消。' + result（契约 §8，进程保留可续聊）。
// 消息源：transcript 是权威源——请求消息一律 session.deriveMessages() 派生；
// session 缺省时退化为内存数组（测试直连场景），无 seedHistory 机制。
// usage：chunk 逐次 addUsage 累计（input/output/cache 各字段），替代覆盖赋值。
// 观测：每轮尾部产出 turnStats（usage/durationMs/model/ts/compactCount），
// health/result/stats 三个消费者共用；result 事件由 engine 发出（cli 不再重复）。
import { streamMessages } from './api.mjs'
import { abortError } from './protocol.mjs'
import { decideToolPermission } from './permissions.mjs'
import { createToolRegistry } from './tools.mjs'

const MAX_TOOL_ITERATIONS = 10

// usage 逐次累加（input/output/cache 各字段），修复"多次 API 调用只记最后一次"
function addUsage(acc, u = {}) {
  const out = { ...acc }
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    out[k] = (acc[k] ?? 0) + (u[k] ?? 0)
  }
  return out
}

export function createEngine({ opts = {}, wire, session, compactor, health }) {
  const signal = { aborted: false }
  const model = opts.model || process.env.ANTHROPIC_MODEL || ''
  const maxTokens = Math.max(1, Number(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || 64000))
  const tools = createToolRegistry({ cwd: opts.addDirs?.[0], addDirs: opts.addDirs, skipPermissions: opts.skipPermissions })
  // 审批挂起队列：toolUseId → resolve（cli 的 control_response 解除）
  const approvalWaiters = new Map()
  // turnStats 记录器（内存 append-only）：health / result / stats 三个消费者共用
  const turnStats = []

  // 历史优先走 session.deriveMessages()；无 session 时退化为内存数组（测试直连场景）
  const memoryHistory = []
  const systemPrompt = opts.systemPrompt || ''

  function deriveHistory() {
    if (session) return session.deriveMessages()
    return memoryHistory.filter((m) => m.role !== 'system')
  }
  function pushMemory(m) { if (!session) memoryHistory.push(m) }

  async function runTurnInternal({ content }) {
    let usage = {}
    let textBuf = ''
    let overflowRetries = 0
    const maxOverflowRetries = Number(process.env.CLAUDE_CODE_MAX_OVERFLOW_RETRIES || 3)
    // 请求消息 = system 前缀（api.mjs 抽顶层）+ 派生历史；session/memory 两模式一致
    const requestMessages = () => {
      const msgs = deriveHistory()
      return [{ role: 'system', content: systemPrompt }].filter((m) => m.content).concat(msgs)
    }
    // pre-step 测压检查点：每轮请求前（工具结果/上轮产物已落日志之后）
    async function preStep() {
      if (!compactor || !session) return
      const msgs = session.deriveMessages()
      await compactor.maybeCompact({ system: systemPrompt || '', messages: msgs })
    }
    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      await preStep()
      const blocks = []
      let overflowed = false
      try {
        for await (const chunk of streamMessages({
          model,
          messages: requestMessages(),
          maxTokens,
          signal,
          tools: tools.toolSchemas(),
        })) {
          if (signal.aborted) throw abortError()
          if (chunk.type === 'text') {
            textBuf += chunk.text
            wire.assistant([{ type: 'text', text: chunk.text }])
          } else if (chunk.type === 'thinking') {
            wire.assistant([{ type: 'thinking', thinking: chunk.text }])
          } else if (chunk.type === 'tool_use') {
            blocks.push({ type: 'tool_use', id: chunk.id, name: chunk.name, input: chunk.input })
            // 工具调用块随 assistant 事件转发 GUI（工具卡片展示）
            wire.assistant([{ type: 'tool_use', id: chunk.id, name: chunk.name, input: chunk.input }])
          } else if (chunk.type === 'usage') {
            usage = addUsage(usage, chunk.usage)
          }
        }
      } catch (err) {
        // 溢出兜底：强制压缩 → 仅 replaceGeneration 前进（压缩真实落地）才重试同一请求
        if (/context_window_exceeded/.test(err?.message || '') && compactor && session && overflowRetries < maxOverflowRetries) {
          const genBefore = session.getSurface().replaceGeneration
          await compactor.forceCompact({ system: systemPrompt, messages: session.deriveMessages() })
          const genAfter = session.getSurface().replaceGeneration
          if (genAfter > genBefore) { overflowRetries++; overflowed = true }
          else return { usage, model, text: '', error: 'overflow-compact-failed' }
        } else {
          throw err
        }
      }
      if (overflowed) continue // 压缩落地 → 重试同一轮（deriveHistory 已含摘要条目）
      if (blocks.length === 0) break
      // 该轮 assistant 历史：文本块 + tool_use 块（Anthropic API 要求）
      const assistantBlocks = [...(textBuf.trim() ? [{ type: 'text', text: textBuf }] : []), ...blocks]
      pushMemory({ role: 'assistant', content: assistantBlocks })
      // 中间 assistant 条目落盘（工具调用轮）
      if (session) session.appendAssistant(assistantBlocks, { usage, model })
      // 逐个执行工具，结果回填为 user(tool_result) 消息（时序：tool_use → tool_result）
      for (const b of blocks) {
        const result = await executeToolUse(b)
        const toolResultMsg = { role: 'user', content: [{ type: 'tool_result', tool_use_id: b.id, content: result.content, is_error: result.isError }] }
        pushMemory(toolResultMsg)
        if (session) session.appendToolResult({ toolUseId: b.id, content: result.content, isError: result.isError })
      }
      // 继续下一轮 API 调用（模型看到 tool_result 后产出新回复）
      textBuf = ''
    }
    if (textBuf.trim()) {
      pushMemory({ role: 'assistant', content: textBuf })
      // 最终 assistant 条目由 engine 写入（带 usage/model；cli 不再重复落盘）
      if (session) session.appendAssistant([{ type: 'text', text: textBuf }], { usage, model })
    }
    return { usage, model, text: textBuf }
  }

  async function executeToolUse(toolUse) {
    const perm = decideToolPermission({ toolName: toolUse.name, input: toolUse.input, skipPermissions: opts.skipPermissions })
    if (perm.decision === 'deny') return { content: '用户拒绝执行该操作', isError: true }
    if (perm.decision === 'ask') {
      // 发 can_use_tool control_request 挂起，等 cli 经 control_response 解除
      wire.controlRequest({
        requestId: 'req-' + toolUse.id,
        toolName: toolUse.name,
        toolUseId: toolUse.id,
        input: toolUse.input,
        reason: perm.reason || '',
      })
      const decision = await new Promise((resolvePromise) => {
        approvalWaiters.set(toolUse.id, resolvePromise)
      })
      if (decision?.behavior !== 'allow') {
        return { content: decision?.message || '用户拒绝执行该操作', isError: true }
      }
    }
    return tools.run(toolUse, {})
  }

  return {
    signal,
    toolNames: tools.toolNames,
    toolSchemas: () => tools.toolSchemas(),
    abort() { signal.aborted = true },
    seedCompactCount(n) { /* session 已从日志恢复 compactCount；兼容保留 */ },
    // cli 的 control_response 路由：解除对应 tool_use 的审批挂起
    resolveApproval(toolUseId, inner) {
      const w = approvalWaiters.get(toolUseId)
      if (w) {
        approvalWaiters.delete(toolUseId)
        w(inner)
      }
    },
    getTurnStats() { return turnStats },
    async runTurn({ content, msg }) {
      // 新轮次重置取消标志：abort() 只影响发出时正在进行的轮次
      signal.aborted = false
      const t0 = Date.now()
      if (session) session.appendUser(String(content ?? ''))
      else pushMemory({ role: 'user', content: String(content ?? '') })
      const { usage, model: turnModel, text } = await runTurnInternal({ content })
      const durationMs = Date.now() - t0
      // turnStats 每轮尾部产出（health/result/stats 共用）
      turnStats.push({ usage, durationMs, model: turnModel, ts: new Date().toISOString(), compactCount: session ? session.compactCount() : 0 })
      health?.record(turnStats[turnStats.length - 1])
      // result 事件由 engine 发出（含 duration_ms；cli 不再重复 emit）
      wire.result(usage, { duration_ms: durationMs })
      return { usage, model: turnModel, text, durationMs }
    },
  }
}
