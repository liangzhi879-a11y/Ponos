// src/components/rail/TaskStartCard.tsx —— 任务标签起始卡片（2026-09-10）
// 任务起始界面必须选目录（会话保持现状不选）：目录选择器 + 新建任务按钮，
// 创建 mode='task' 会话并绑定所选工作目录。目录选择器复用 DirectoryPicker。
import { useState } from 'react'
import { FolderOpen, SquareKanban } from 'lucide-react'
import { DirectoryPicker } from '@/components/chat/DirectoryPicker'
import { useChatStore } from '@/stores/chatStore'
import { getDefaultHome } from '@/lib/config'
import { useTranslation } from '@/i18n/useTranslation'

export function TaskStartCard() {
  const { t } = useTranslation()
  const createConversation = useChatStore(s => s.createConversation)
  const [dir, setDir] = useState(getDefaultHome())
  const [showPicker, setShowPicker] = useState(false)

  const createTask = () => {
    createConversation(dir, undefined, 'task')
  }

  return (
    <div className="flex flex-col items-center justify-center h-full px-6 py-8 select-none">
      <div className="w-full max-w-md animate-fade-in">
        <div className="flex items-center justify-center gap-2 mb-6">
          <SquareKanban className="w-5 h-5 text-brand-500/70" />
          <span className="text-lg font-semibold text-primary">{t('rail.taskEmptyTitle')}</span>
        </div>

        {/* 工作目录选择（任务必选，2026-09-10） */}
        <div className="mb-4">
          <label className="block text-[11px] text-tertiary mb-2 font-semibold uppercase tracking-wider">
            {t('chat.workingDirectory')}
          </label>
          <button
            onClick={() => setShowPicker(true)}
            className="w-full h-10 cut-btn hot-hover"
          >
            <span className="ci flex items-center gap-3 px-4 h-full text-sm text-secondary font-mono">
              <FolderOpen className="w-4 h-4 text-brand-500/70 shrink-0" />
              <span className="truncate">{dir}</span>
              <span className="text-[10px] text-brand-500/70 ml-auto shrink-0 font-medium">{t('chat.browse')}</span>
            </span>
          </button>
        </div>

        <button
          onClick={createTask}
          className="w-full h-10 cut-btn glow-hover text-white text-sm font-medium"
        >
          <span className="ci grad-brand flex items-center justify-center gap-2 w-full h-full">
            <SquareKanban className="w-4 h-4" />
            {t('rail.taskEmptyAction')}
          </span>
        </button>

        <p className="text-[11px] text-tertiary mt-6 text-center">{t('rail.taskEmptyHint')}</p>
      </div>

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
              value={dir}
              onChange={(path) => { setDir(path); setShowPicker(false) }}
              onClose={() => setShowPicker(false)}
            />
          </div>
        </div>
      )}
    </div>
  )
}
