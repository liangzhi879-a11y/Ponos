// assistant-ui 消息渲染（2026-09-09 会话 UI 标准化）
// ---------------------------------------------------------------------------
// ThreadPrimitive.Messages 的 children render 分发到本文件的三个视图。
// Parts 由 MessagePrimitive.Parts 按组件表渲染：Text→MarkdownTextPart、
// Reasoning→ReasoningPanel（折叠思考块）、tool-call→ToolCallCard（内联卡片）。
//
// R3（2026-09-13）流式期重渲染收口，两处：
//  ① 部件表提为**模块级常量**。`components={{ Text: MarkdownTextPart }}` 这种内联字面量
//     每渲染新建对象 ⇒ MessagePrimitive.Parts 拿到的 props 恒不相等，其内部（部件表
//     查表与分支）每次都要重走。
//  ② 三个视图全部 `memo`。它们**不收任何 props**——消息内容经 MessagePrimitive.Root 的
//     context 流入——所以 memo 的默认浅比较（比较 {} 与 {}）恰好就是"无需比较"，父级
//     （ChatWindow 或 ThreadPrimitive.Messages）主动重渲染时直接短路：N-1 条未变消息的
//     整棵子树不再重建。
//     **不会因此读到旧内容**：React 对 context 变化单独标脏消费方，memo 短路不了它，
//     被追加的那条消息照常更新（这也正是 chatRuntime 侧要保证"未变消息对象引用稳定、
//     变了的必须换新对象"的原因）。
import { memo } from 'react'
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

// user/system 视图只渲染 Text 部件：两处语义相同，共用同一张表（引用终生不变）
const TEXT_ONLY_PARTS = { Text: MarkdownTextPart }

export const AssistantMessageView = memo(function AssistantMessageView() {
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
})

export const UserMessageView = memo(function UserMessageView() {
  return (
    <MessagePrimitive.Root className="group flex gap-2.5 items-start px-1 py-1.5 justify-end">
      <div className="max-w-[85%] min-w-0">
        {/* 用户气泡：单对角切角（设计语言·气泡，原 rounded-xl） */}
        <div className="cut-sm">
          <div className="ci px-3.5 py-2.5">
            <MessagePrimitive.Parts components={TEXT_ONLY_PARTS} />
          </div>
        </div>
      </div>
      <div className="w-7 h-7 mt-0.5 rounded-lg bg-elevated border border-subtle flex items-center justify-center shrink-0">
        <User className="w-4 h-4 text-secondary" />
      </div>
    </MessagePrimitive.Root>
  )
})

export const SystemMessageView = memo(function SystemMessageView() {
  return (
    <MessagePrimitive.Root className="flex gap-2.5 items-start px-1 py-1.5">
      <div className="w-7 h-7 mt-0.5 rounded-lg bg-warning/10 border border-warning/20 flex items-center justify-center shrink-0">
        <Info className="w-4 h-4 text-warning" />
      </div>
      <div className="flex-1 min-w-0 opacity-80">
        <MessagePrimitive.Parts components={TEXT_ONLY_PARTS} />
      </div>
    </MessagePrimitive.Root>
  )
})
