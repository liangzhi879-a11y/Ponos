// ContentBlock[] → assistant-ui ThreadMessageLike 转换（2026-09-09 会话 UI 标准化）
// ---------------------------------------------------------------------------
// 纯函数层：把 chatStore 的消息块模型映射为 assistant-ui 的消息/部件模型。
//   text       → { type:'text', text }
//   thinking   → { type:'reasoning', text }（折叠壳由渲染层 ReasoningGroup 承担）
//   tool_use   → { type:'tool-call', toolName, args, argsText, result }
//   tool_result → 合并进前一个 tool_use part 的 result（历史回放已由 transcriptAdapter
//                 挂到 block.result，此处对 live 会话的独立 tool_result 块做同构合并）
//   image/file → 透传文本（当前 GUI 图片经桥接转文本，原块极少出现）
import type { ThreadMessageLike } from '@assistant-ui/react'
import type { ContentBlock, Message } from '../types'

export interface ToolCallConversion {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  argsText: string
  result?: string
  isError?: boolean
}

export type ConvertedPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | ToolCallConversion

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

/** 单条消息 → assistant-ui 消息。tool_result 块合并进前一个 tool_use 的 result。 */
export function messageToThreadMessageLike(m: Message): ThreadMessageLike {
  const parts: ConvertedPart[] = []
  let lastTool: ToolCallConversion | null = null
  for (const block of m.content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.content })
    } else if (block.type === 'thinking') {
      parts.push({ type: 'reasoning', text: block.content })
    } else if (block.type === 'tool_use') {
      const toolName = String(block.metadata?.toolName || 'Tool')
      const toolCallId = String(block.metadata?.toolUseId || block.id || `tool-${parts.length}`)
      const part: ToolCallConversion = {
        type: 'tool-call',
        toolCallId,
        toolName,
        args: safeParseArgs(block.content),
        argsText: block.content,
      }
      if (block.result) {
        // assistant-ui 0.15：result 为通用值、isError 是 part 顶层字段
        part.result = block.result.content || ''
        part.isError = block.result.isError === true
      }
      parts.push(part)
      lastTool = part
    } else if (block.type === 'tool_result') {
      if (lastTool && lastTool.type === 'tool-call' && !lastTool.result) {
        lastTool.result = block.content
        lastTool.isError = block.metadata?.isError === true
      } else {
        // 孤立 tool_result（无前置 tool_use）：降级为文本块，保信息不丢
        parts.push({ type: 'text', text: block.content })
      }
    } else if (block.type === 'image' || block.type === 'file') {
      parts.push({ type: 'text', text: block.content || '' })
    }
  }
  return { role: m.role === 'tool' ? 'assistant' : m.role, content: parts } as ThreadMessageLike
}

/** 会话消息数组 → ThreadMessageLike[]（每条消息同 id 保持稳定，流式 mutate 语义）。 */
export function messagesToThreadMessageLikes(messages: Message[]): ThreadMessageLike[] {
  return messages.map((m) => ({ ...messageToThreadMessageLike(m), id: m.id }))
}

/** 流式追加辅助：把新到达的 text/thinking 片段追加到同类型块（修复"整块替换"缺陷）。
 *  - 找到同类型最后一块 → 追加；无同类型块 → 新建。
 *  - tool_use 块不进此路径（整块一次性）。 */
export function appendStreamingBlock(
  content: ContentBlock[],
  kind: 'text' | 'thinking',
  delta: string,
): ContentBlock[] {
  // 仅当"当前最后一块"是同类型才合并（2026-09-09 交错显示修复）：旧实现按
  // lastIndexOf 找任意位置的同类型块，工具卡片插入后，后续文本仍追加回卡片
  // 之前的旧文本块——表现为"全部文字连成一段在前、工具卡片全排在后"，
  // 丢失思考/输出-工具-思考/输出的交错结构。新语义：跨块边界（工具/思考）
  // 即封块新建，交错顺序自然保留；连续同类型 delta 仍合并（流式高效）。
  const last = content[content.length - 1]
  if (last && last.type === kind) {
    return content.map((b, i) => (i === content.length - 1 ? { ...b, content: b.content + delta } : b))
  }
  return [...content, { id: `stream-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, type: kind, content: delta }]
}
