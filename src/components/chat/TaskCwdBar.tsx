// src/components/chat/TaskCwdBar.tsx —— 任务模式工作目录条（2026-09-10）
// 任务与对话是两种不同的功能设计思路：任务绑定工作目录，目录必须在任务工作台
// 可见、可换——空态新建走 TaskStartCard（目录必选），会话内经本条随时更换。
// 更换目录 = 切换工作根：更新会话 cwd 并使会话失效（下次发送以新目录重 spawn
// 内核会话；旧目录 transcript 仍在磁盘不丢）。
import { useState } from 'react'
import { FolderOpen, PencilLine } from 'lucide-react'
import { DirectoryPicker } from '@/components/chat/DirectoryPicker'
import { useChatStore } from '@/stores/chatStore'
import { useTranslation } from '@/i18n/useTranslation'

interface Props { conversationId: string }

export function TaskCwdBar({ conversationId }: Props) {
  const { t } = useTranslation()
  const cwd = useChatStore(s => s.conversations.find(c => c.id === conversationId)?.cwd || '')
  const [showPicker, setShowPicker] = useState(false)

  const changeDir = (path: string) => {
    const st = useChatStore.getState()
    st.setConversationCwd(conversationId, path)
    st.invalidateSession(conversationId) // 新目录 → 新内核会话（下次发送生效）
    setShowPicker(false)
  }

  return (
    <div className="flex items-center gap-2 px-3 h-8 border-b border-subtle shrink-0 bg-app/60">
      <FolderOpen className="w-3.5 h-3.5 text-brand-500/70 shrink-0" />
      <span
        className="text-[11px] font-mono text-tertiary truncate flex-1 min-w-0"
        title={cwd || t('chat.workingDirectory')}
      >
        {cwd || t('chat.workingDirectory')}
      </span>
      <button
        onClick={() => setShowPicker(true)}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium text-brand-500/80 hover:text-brand-500 hover:bg-brand-500/10 transition-colors shrink-0"
        aria-label={t('chat.changeDirectory')}
        title={t('chat.changeDirectory')}
      >
        <PencilLine className="w-3 h-3" />
        {t('chat.changeDirectory')}
      </button>

      {showPicker && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center animate-fade-in"
          onClick={() => setShowPicker(false)}
          style={{
            backgroundColor: 'var(--overlay-bg)',
            backdropFilter: `blur(var(--overlay-blur))`,
            WebkitBackdropFilter: `blur(var(--overlay-blur))`,
          }}
        >
          <div className="w-[420px] max-h-[450px]" onClick={e => e.stopPropagation()}>
            <DirectoryPicker
              value={cwd}
              onChange={changeDir}
              onClose={() => setShowPicker(false)}
            />
          </div>
        </div>
      )}
    </div>
  )
}
