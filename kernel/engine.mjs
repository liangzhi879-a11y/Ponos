// 净室内核 Agent 循环（docs/bridge-contract.md §9 替换面）
// ---------------------------------------------------------------------------
// runTurn：把 user 消息加入历史 → api.streamMessages 流式生成 → wire.assistant
// 转发（text/thinking 块）→ 返回 usage。取消：cli 收到 control_request(cancel)
// 调 engine.abort()，流循环在检查点抛 AbortError，cli 输出 '已取消。' + result。
// 工具调用（tool_use → 执行器 → 继续循环）在里程碑 4（tools/permissions）接入，
// 本文件对外接口保持不变。
import { streamMessages } from './api.mjs'
import { abortError } from './protocol.mjs'

export function createEngine({ opts = {}, wire }) {
  const signal = { aborted: false }
  const model = opts.model || process.env.ANTHROPIC_MODEL || ''
  const maxTokens = Math.max(1, Number(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || 64000))
  // 会话消息历史（里程碑 3 落盘；当前内存态，--resume 时由 cli 注入恢复）
  const history = []
  if (opts.systemPrompt) history.push({ role: 'system', content: opts.systemPrompt })

  return {
    signal,
    abort() { signal.aborted = true },
    // 测试/调试钩子：直接注入历史（会话持久化恢复用）
    seedHistory(entries) {
      history.push(...entries.filter((m) => m.role !== 'system'))
    },
    async runTurn({ content, msg }) {
      // 新轮次重置取消标志：abort() 只影响发出时正在进行的轮次
      signal.aborted = false
      history.push({ role: 'user', content: String(content ?? '') })
      let usage = {}
      let textBuf = ''
      try {
        for await (const chunk of streamMessages({ model, messages: history, maxTokens, signal })) {
          if (signal.aborted) throw abortError()
          if (chunk.type === 'text') {
            textBuf += chunk.text
            wire.assistant([{ type: 'text', text: chunk.text }])
          } else if (chunk.type === 'thinking') {
            wire.assistant([{ type: 'thinking', thinking: chunk.text }])
          } else if (chunk.type === 'usage') {
            usage = chunk.usage
          }
        }
      } catch (err) {
        if (err?.name === 'AbortError') throw err
        throw err
      }
      // 流式多段文本合并为单条历史（多轮对话上下文完整性）
      if (textBuf.trim()) history.push({ role: 'assistant', content: textBuf })
      return { usage, model }
    },
  }
}
