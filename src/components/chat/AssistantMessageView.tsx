// assistant-ui 消息渲染（2026-09-09 会话 UI 标准化）
// ---------------------------------------------------------------------------
// ThreadPrimitive.Messages 的 children render 分发到本文件的三个视图。
// Parts 由 MessagePrimitive.Parts 按组件表渲染：Text→MarkdownTextPart、
// Reasoning→ReasoningPanel（折叠思考块）、tool-call→ToolCallCard（内联卡片）。
import { MessagePrimitive } from '@assistant-ui/react'
import { Bot, User, Info } from 'lucide-react'
import { MarkdownTextPart } from './MarkdownText'
import { ReasoningPanel } from './ReasoningPanel'
import { ToolCallCard } from './ToolCallCard'

const ASSISTANT_PARTS = {
  Text: MarkdownTextPart,
  Reasoning: ReasoningPanel,
  tools: { Fallback: ToolCallCard },
}

export function AssistantMessageView() {
  return (
    <MessagePrimitive.Root className="group flex gap-2.5 items-start px-1 py-1.5">
      <div className="w-7 h-7 mt-0.5 rounded-lg bg-brand-500/10 border border-brand-500/20 flex items-center justify-center shrink-0">
        <Bot className="w-4 h-4 text-brand-500" />
      </div>
      <div className="flex-1 min-w-0">
        <MessagePrimitive.Parts components={ASSISTANT_PARTS} />
      </div>
    </MessagePrimitive.Root>
  )
}

export function UserMessageView() {
  return (
    <MessagePrimitive.Root className="group flex gap-2.5 items-start px-1 py-1.5 justify-end">
      <div className="max-w-[85%] min-w-0">
        {/* 用户气泡：单对角切角（设计语言·气泡，原 rounded-xl） */}
        <div className="cut-sm">
          <div className="ci px-3.5 py-2.5">
            <MessagePrimitive.Parts components={{ Text: MarkdownTextPart }} />
          </div>
        </div>
      </div>
      <div className="w-7 h-7 mt-0.5 rounded-lg bg-elevated border border-subtle flex items-center justify-center shrink-0">
        <User className="w-4 h-4 text-secondary" />
      </div>
    </MessagePrimitive.Root>
  )
}

export function SystemMessageView() {
  return (
    <MessagePrimitive.Root className="flex gap-2.5 items-start px-1 py-1.5">
      <div className="w-7 h-7 mt-0.5 rounded-lg bg-warning/10 border border-warning/20 flex items-center justify-center shrink-0">
        <Info className="w-4 h-4 text-warning" />
      </div>
      <div className="flex-1 min-w-0 opacity-80">
        <MessagePrimitive.Parts components={{ Text: MarkdownTextPart }} />
      </div>
    </MessagePrimitive.Root>
  )
}
