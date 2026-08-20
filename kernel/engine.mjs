// YFW-turbo Agent 循环（docs/bridge-contract.md §9 替换面）
// ---------------------------------------------------------------------------
// runTurn：user 消息入历史 → 循环调用 api.streamMessages：
//   - 文本/思考块 → wire.assistant 流式转发
//   - tool_use 块 → 权限判定（高危 Bash → can_use_tool 挂起等 control_response）
//     → tools 执行 → tool_result 回填历史 → 再调 API，直到模型输出纯文本
// 取消：cli 调 engine.abort()，流循环在检查点抛 AbortError → cli 输出
// '已取消。' + result（契约 §8，进程保留可续聊）。
import { streamMessages } from './api.mjs'
import { abortError } from './protocol.mjs'
import { decideToolPermission } from './permissions.mjs'
import { createToolRegistry } from './tools.mjs'

const MAX_TOOL_ITERATIONS = 10

export function createEngine({ opts = {}, wire }) {
  const signal = { aborted: false }
  const model = opts.model || process.env.ANTHROPIC_MODEL || ''
  const maxTokens = Math.max(1, Number(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || 64000))
  const tools = createToolRegistry({ cwd: opts.addDirs?.[0], addDirs: opts.addDirs, skipPermissions: opts.skipPermissions })
  // 会话消息历史（里程碑 3 起由 cli 从 transcript 恢复/落盘）
  const history = []
  if (opts.systemPrompt) history.push({ role: 'system', content: opts.systemPrompt })
  // 审批挂起队列：toolUseId → resolve（cli 的 control_response 解除）
  const approvalWaiters = new Map()

  async function runTurnInternal({ content }) {
    let usage = {}
    let textBuf = ''
    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      const blocks = []
      for await (const chunk of streamMessages({ model, messages: history, maxTokens, signal })) {
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
          usage = chunk.usage
        }
      }
      if (blocks.length === 0) break
      // 该轮 assistant 历史：文本块 + tool_use 块（Anthropic API 要求）
      const assistantBlocks = [...(textBuf.trim() ? [{ type: 'text', text: textBuf }] : []), ...blocks]
      history.push({ role: 'assistant', content: assistantBlocks })
      // 逐个执行工具，结果回填为 user(tool_result) 消息
      for (const b of blocks) {
        const result = await executeToolUse(b)
        history.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: b.id, content: result.content, is_error: result.isError }] })
      }
      // 继续下一轮 API 调用（模型看到 tool_result 后产出新回复）
    }
    if (textBuf.trim()) history.push({ role: 'assistant', content: textBuf })
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
    abort() { signal.aborted = true },
    seedHistory(entries) {
      history.push(...entries.filter((m) => m.role !== 'system'))
    },
    // cli 的 control_response 路由：解除对应 tool_use 的审批挂起
    resolveApproval(toolUseId, inner) {
      const w = approvalWaiters.get(toolUseId)
      if (w) {
        approvalWaiters.delete(toolUseId)
        w(inner)
      }
    },
    async runTurn({ content, msg }) {
      // 新轮次重置取消标志：abort() 只影响发出时正在进行的轮次
      signal.aborted = false
      history.push({ role: 'user', content: String(content ?? '') })
      const { usage, model: turnModel, text } = await runTurnInternal({ content })
      return { usage, model: turnModel, text }
    },
  }
}
