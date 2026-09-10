// src/components/chat/FloatingQuestionCard.tsx —— 提问卡片悬浮折叠容器（2026-09-10）
// 原 QuestionCard 内联在消息流与输入栏之间，长提问展开后消息可视区只剩几行、
// 严重遮挡阅读。现改为：默认折叠为输入栏上方居中小 chip（点击展开）；展开态
// 悬浮卡片 max-h-[50vh] 内滚，收起即回 chip。审批弹窗（PermissionDialog）
// 保持悬浮占屏不变。
import { useState } from 'react'
import { ChevronDown, ChevronUp, MessageCircleQuestion } from 'lucide-react'
import QuestionCard from './QuestionCard'
import type { QuestionPayload, QuestionAnswer } from '@/types'

interface Props {
  conversationId: string
  payload: QuestionPayload & { raw?: string }
  onAnswer: (response: { answers: QuestionAnswer[]; notes: string }) => void
  onDismiss: () => void
  /** 强制重挂载 key（载荷替换时清空旧卡状态，语义与原内联版一致） */
  cardKey: string
}

export function FloatingQuestionCard({ conversationId, payload, onAnswer, onDismiss, cardKey }: Props) {
  const [expanded, setExpanded] = useState(false)

  // 载荷替换 → 折叠回 chip（新问题默认收起，不遮挡阅读）
  const [lastKey, setLastKey] = useState(cardKey)
  if (lastKey !== cardKey) {
    setLastKey(cardKey)
    setExpanded(false)
  }

  if (!expanded) {
    return (
      <div className="px-3 pb-1 flex justify-center shrink-0">
        <button
          onClick={() => setExpanded(true)}
          className="flex items-center gap-1.5 px-3 py-1 rounded-full border border-brand-500/30 bg-brand-500/10 text-brand-500 text-xs font-medium hover:bg-brand-500/20 transition-colors shadow-sm animate-slide-up"
        >
          <MessageCircleQuestion className="w-3.5 h-3.5" />
          待回答问题
          <ChevronUp className="w-3 h-3 opacity-70" />
        </button>
      </div>
    )
  }

  return (
    <div className="px-3 pb-1 flex justify-center shrink-0 animate-slide-up">
      {/* 浮层卡：单对角切角中性框；内层 QuestionCard 自带 hot 卡（层级：外中性 / 内热边） */}
      <div
        className="relative w-full max-w-2xl cut overflow-hidden"
        style={{ filter: 'drop-shadow(var(--modal-drop))' }}
      >
        <div className="ci">
        {/* 折叠头 */}
        <button
          onClick={() => setExpanded(false)}
          className="w-full flex items-center justify-between px-3 py-1.5 border-b border-subtle text-xs text-tertiary hover:text-secondary transition-colors"
        >
          <span className="flex items-center gap-1.5 font-medium text-brand-500">
            <MessageCircleQuestion className="w-3.5 h-3.5" />
            待回答问题
          </span>
          <ChevronDown className="w-3.5 h-3.5" />
        </button>
        <div className="max-h-[50vh] overflow-y-auto">
          <QuestionCard
            key={cardKey}
            payload={payload}
            onAnswer={onAnswer}
            onDismiss={onDismiss}
          />
        </div>
        </div>
      </div>
    </div>
  )
}
