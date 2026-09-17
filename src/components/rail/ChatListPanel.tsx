// src/components/rail/ChatListPanel.tsx —— 对话面板（rail==='chat' 的二级内容，Task 10）
// 刻意保持简单（Task 10 决策）：isChatLike 过滤 + PanelToolbar（标题/计数/＋新建对话）+
// 扁平列表项（标题/摘要(如有)/时间/流式光标），点击 → setActiveConversation；
// 空态 = 居中提示 + 「开始对话」按钮。无搜索、无右键菜单、无会话集（chat 无集合概念）。
// 新建对话恒走 mode='chat'：createConversation(undefined, undefined, 'chat')——不绑业务 cwd。
import { memo } from 'react'
import { MessageSquare, MessageSquarePlus } from 'lucide-react'
import { Button } from '@/components/ui'
import { ScrollArea } from '@/components/ui'
import { PanelToolbar } from './PanelToolbar'
import { useChatStore } from '@/stores/chatStore'
import { useTranslation } from '@/i18n/useTranslation'
import { formatDate, cn } from '@/lib/utils'
import { isChatLike } from '@/lib/chatModeUi'
// 【S3】侧边栏默认列表按模式筛选（spec §5.9「受模式影响」一栏：会话/工作流/知识的**筛选范围**）。
// 没加入任何团队时 `useModeFilter()` 的 mode 恒为 'personal' 且判据把"缺 workspaceId 的旧数据"
// 也归个人 ⇒ 列表逐字不变（团队能力默认关闭）。
import { filterConversationsByMode } from '@/lib/teamModeUi'
import { useModeFilter } from '@/stores/teamStore'
import type { Conversation } from '@/types'

export function ChatListPanel() {
  const { t } = useTranslation()
  const conversations = useChatStore(s => s.conversations)
  const activeConversationId = useChatStore(s => s.activeConversationId)
  const streamingConversations = useChatStore(s => s.streamingConversations)
  const createConversation = useChatStore(s => s.createConversation)
  const setActiveConversation = useChatStore(s => s.setActiveConversation)

  const { mode, teamIds } = useModeFilter()
  const allChats = conversations.filter(isChatLike)
  const chats = filterConversationsByMode(allChats, mode, teamIds)
  // 团队模式下把个人内容全筛掉时**必须出声**：否则用户看到空列表会以为"数据没了"，
  // 而模式只是筛选范围、数据仍在本机（spec §5.9「模式 ≠ 隔离」）。
  const hiddenByMode = chats.length === 0 && allChats.length > 0 && mode === 'team'
  const startChat = () => createConversation(undefined, undefined, 'chat')

  return (
    <div className="flex flex-col h-full min-h-0">
      <PanelToolbar
        title={t('rail.chat')}
        en="CHATS"
        count={chats.length}
        newIcon={MessageSquarePlus}
        newLabel={t('rail.chatNew')}
        onNew={startChat}
      />
      {chats.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2.5 px-4 text-center min-h-0">
          <MessageSquare className="w-6 h-6 text-tertiary" />
          <span className="text-xs text-secondary leading-relaxed">{t('rail.chatEmpty')}</span>
          {hiddenByMode && <span className="text-[10px] text-tertiary leading-relaxed">{t('team.listFilteredEmpty')}</span>}
          <Button variant="secondary" size="xs" onClick={startChat}>
            <MessageSquarePlus className="w-3.5 h-3.5" />
            {t('rail.chatEmptyAction')}
          </Button>
        </div>
      ) : (
        <ScrollArea className="flex-1 min-h-0">
          <div className="p-1">
            {chats.map(conv => (
              <ChatRow
                key={conv.id}
                conv={conv}
                active={conv.id === activeConversationId}
                isStreaming={!!streamingConversations[conv.id]}
                onSelect={() => setActiveConversation(conv.id)}
              />
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  )
}

interface ChatRowProps {
  conv: Conversation
  active: boolean
  isStreaming: boolean
  onSelect: () => void
}

const ChatRow = memo(function ChatRow({ conv, active, isStreaming, onSelect }: ChatRowProps) {
  const { t } = useTranslation()
  return (
    <div
      data-conv-id={conv.id}
      onClick={onSelect}
      className={cn(
        'group mx-1 my-1 cut-sm cursor-pointer transition-all select-none',
        active && 'hot glow-hover',
      )}
    >
      <div className={cn('ci px-2 py-1.5', active ? 'text-primary' : 'text-tertiary hover:text-primary')}>
      <div className="flex items-center gap-1.5">
        {/* 执行中：品牌橙 + 脉冲光晕（设计语言白名单③） */}
        {isStreaming && <span className="w-1.5 h-1.5 rounded-full bg-brand-500 shrink-0 pulse-dot" style={{ boxShadow: '0 0 8px rgba(255, 116, 41, 0.8)' }} />}
        <span className="flex-1 min-w-0 truncate text-xs" title={conv.title}>{conv.title}</span>
        <span className="shrink-0 whitespace-nowrap tabular-nums">
          {isStreaming ? (
            <span className="text-[10px] text-brand-500/70 font-medium">{t('convStatus.running')}</span>
          ) : (
            <span className="text-[10px] text-tertiary">{formatDate(conv.updatedAt, true)}</span>
          )}
        </span>
      </div>
      {conv.summary ? (
        <div className="mt-0.5 pl-1 text-[10px] text-tertiary truncate" title={conv.summary}>{conv.summary}</div>
      ) : null}
      </div>
    </div>
  )
}, (prev, next) =>
  // 只比较展示字段：会话消息体（流式 token）变化不影响列表项可见输出，避免整列重渲染
  prev.conv?.title === next.conv?.title &&
  prev.conv?.updatedAt === next.conv?.updatedAt &&
  prev.conv?.summary === next.conv?.summary &&
  prev.active === next.active &&
  prev.isStreaming === next.isStreaming,
)
