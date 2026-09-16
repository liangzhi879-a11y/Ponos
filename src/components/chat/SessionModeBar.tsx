import { useChatStore } from '@/stores/chatStore'
import { useTranslation } from '@/i18n/useTranslation'
import { cn } from '@/lib/utils'
import { EffortPicker } from './EffortPicker'

interface Props {
  conversationId: string
}

/**
 * 会话模式徽标条（Task 11 Conversation.mode）：当前会话模式只读徽章。
 * - chat = 纯聊受限（禁本地工具，仅联网只读）——灰底圆角 chip；
 * - task = 全工具（可执行本地操作）——品牌橙浅底 chip。
 * 纯文字 chip 不引入图标（图标唯一性约束）。挂在 ChatWindow 消息滚动区上方
 * （系统提示条之下），不随消息滚动；无活动会话不渲染。Task 13 会在此行右侧
 * 放 effort 选择器，故容器为 h-7 流式行。
 */
export function SessionModeBar({ conversationId }: Props) {
  const conversation = useChatStore(s => s.conversations.find(c => c.id === conversationId))
  const { t } = useTranslation()

  // 无活动会话 → 不占位（ChatWindow 仅在 activeConversationId 存在时挂载本组件，
  // 此处兜底 undefined/删除竞态）
  if (!conversation) return null

  // mode undefined（旧数据/导入）按 task 语义展示：全工具现状
  const isChat = conversation.mode === 'chat'

  return (
    <div className="flex items-center justify-between gap-2 h-7 px-3 shrink-0 select-none">
      {/* 左：会话模式只读徽标（chat/task 文字 chip） */}
      <span
        className={cn(
          'inline-flex items-center rounded-full px-2.5 h-[18px] text-[11px] font-medium whitespace-nowrap leading-none border',
          isChat
            ? 'bg-elevated text-secondary border-subtle'
            : 'bg-brand-500/10 text-brand-500 border-brand-500/25'
        )}
      >
        {t(isChat ? 'sessionMode.chat' : 'sessionMode.task')}
      </span>
      {/* 右：思考深度热切选择器（Task 13；conversationId 兜底交给 sendEffort） */}
      <div className="flex items-center gap-2 min-w-0">
        {/* 会话知识库徽标（2026-09-15，P1）：**仅在已关联时渲染**——未关联是绝大多数会话的
            常态，常驻一个"知识库 0"只会白占版面（这一行还同时挤着模式徽标与 effort 选择器）。
            title 里列出库名而非另开 popover：要回答的问题是"这个会话能用哪些库"（只读信息），
            为此引入一个受控浮层不划算。库名清单来自会话字段，与传给内核的**同一份**数据。 */}
        {(conversation.knowledgeSpaces?.length ?? 0) > 0 && (
          <span
            className="inline-flex items-center rounded-full px-2 h-[18px] text-[11px] leading-none border bg-elevated text-secondary border-subtle max-w-[200px] truncate"
            title={`${t('knowledge.sessionChipTitle')}：${(conversation.knowledgeSpaces ?? []).join('、')}`}
          >
            {t('knowledge.sessionChip', { count: conversation.knowledgeSpaces!.length })}
          </span>
        )}
        <EffortPicker conversationId={conversationId} />
      </div>
    </div>
  )
}
