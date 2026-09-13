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
  // 新问题到达即展开（2026-09-13）：原先默认折叠成输入栏上方的小 chip，配合等待条那句
  // 静止的"等待你的回答"，用户极易整段错过——实证代价：9 次提问里 3 次等满内核 600s 超时
  // （内核空转 30 分钟），而其中 5 次的帧还只在 WS 重连时才到（最长迟到 7 分钟）。
  // 到达这一下必须显眼；折叠态仍可一键收起（不推翻 2026-09-10 的"不占满消息区"决策：
  // 展开态仍是 max-h-50vh 内滚的悬浮卡）。
  const [expanded, setExpanded] = useState(true)

  // 载荷替换 → 新问题同样自动展开（cardKey 对同一问题稳定、仅新问题变化 ⇒
  // WS 重连的 hello 重放不会把用户手动收起的卡再弹开）
  const [lastKey, setLastKey] = useState(cardKey)
  if (lastKey !== cardKey) {
    setLastKey(cardKey)
    setExpanded(true)
  }

  if (!expanded) {
    return (
      <div className="px-3 pb-1 flex justify-center shrink-0" data-qcard-state="collapsed">
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
    <div className="px-3 pb-1 flex justify-center shrink-0 animate-slide-up" data-qcard-state="expanded">
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
