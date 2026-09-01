// src/components/dock/DockPanel.tsx
// DockBar 的气泡弹出面板：点击 task/question/approval 气泡在导航栏旁展开。
// 数据源：chatStore（同 origin localStorage 共享，zustand persist）——
// 运行任务（backgroundTasks）/ 待提问（pendingQuestions）/ 待审批（pendingPermissions）。
import { useEffect, useState } from 'react'
import { ListTodo, HelpCircle, ShieldCheck, Loader2, X } from 'lucide-react'
import { useChatStore } from '@/stores/chatStore'
import { useDockStore, type DockChannel } from '@/stores/dockStore'
import { openModule, closeModule } from '@/lib/moduleBridge'
import { useTranslation } from '@/i18n/useTranslation'

const CHANNEL_META: Record<DockChannel, { titleKey: string; icon: typeof ListTodo }> = {
  task: { titleKey: 'dock.tasks', icon: ListTodo },
  question: { titleKey: 'dock.questions', icon: HelpCircle },
  approval: { titleKey: 'dock.approvals', icon: ShieldCheck },
  module: { titleKey: 'dock.modules', icon: ListTodo },
}

/**
 * 气泡面板：显示对应通道的实时内容。
 * - task：运行任务列表（chatStore.backgroundTasks 中 running 的）
 * - question：待提问列表（pendingQuestions 各会话首个）
 * - approval：待审批列表（pendingPermissions）
 */
export function DockPanel({ channel }: { channel: Exclude<DockChannel, 'module'> }) {
  const { t } = useTranslation()
  const backgroundTasks = useChatStore(s => s.backgroundTasks)
  const pendingQuestions = useChatStore(s => s.pendingQuestions)
  const pendingPermissions = useChatStore(s => s.pendingPermissions)
  const conversations = useChatStore(s => s.conversations)
  const [mounted, setMounted] = useState(false)
  const { setPanel, panel } = useDockStore()
  useEffect(() => setMounted(true), [])

  const meta = CHANNEL_META[channel]
  const Icon = meta.icon
  const close = () => setPanel(null)

  // 运行中任务
  const runningTasks = backgroundTasks.filter(x => x.status === 'running')

  // 待提问（按会话，取每个会话最近一个）
  const questionEntries = Object.entries(pendingQuestions)

  return (
    <div
      className="absolute right-full top-2 w-72 rounded-xl border border-subtle bg-app text-primary shadow-lg z-50 overflow-hidden animate-slide-in"
      style={{ boxShadow: 'var(--shadow-modal)', backdropFilter: 'blur(var(--popover-blur))' }}
    >
      {/* 头部 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-subtle bg-toolbar/50">
        <Icon size={14} className="text-brand-500" />
        <span className="text-xs font-semibold">{t(meta.titleKey)}</span>
        <button onClick={close} className="ml-auto text-tertiary hover:text-primary" aria-label="close">
          <X size={14} />
        </button>
      </div>

      {/* 内容 */}
      <div className="max-h-72 overflow-y-auto p-2">
        {channel === 'task' && (
          runningTasks.length === 0 ? (
            <p className="text-xs text-tertiary px-2 py-3 text-center">{t('dock.noTasks')}</p>
          ) : (
            runningTasks.map(task => (
              <div key={task.id} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-hover">
                <Loader2 size={12} className="text-accent animate-spin shrink-0" />
                <span className="text-xs text-secondary truncate flex-1">{task.name || task.id.slice(0, 16)}</span>
              </div>
            ))
          )
        )}

        {channel === 'question' && (
          questionEntries.length === 0 ? (
            <p className="text-xs text-tertiary px-2 py-3 text-center">{t('dock.noQuestions')}</p>
          ) : (
            questionEntries.map(([sid, q]) => {
              const conv = conversations.find(c => c.id === sid)
              return (
                <div key={sid} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-hover">
                  <HelpCircle size={12} className="text-warning shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-secondary truncate">{q.context || conv?.title || sid.slice(0, 12)}</div>
                    <div className="text-[10px] text-tertiary">{q.questions?.length ?? 0} 题</div>
                  </div>
                  <button
                    onClick={() => void openModule('chat', { conversation: sid })}
                    className="text-[10px] text-accent hover:underline shrink-0"
                  >
                    {t('dock.open')}
                  </button>
                </div>
              )
            })
          )
        )}

        {channel === 'approval' && (
          pendingPermissions.length === 0 ? (
            <p className="text-xs text-tertiary px-2 py-3 text-center">{t('dock.noApprovals')}</p>
          ) : (
            pendingPermissions.map(p => (
              <div key={p.id} className="px-2 py-1.5 rounded-md hover:bg-hover flex items-center gap-2">
                <ShieldCheck size={12} className="text-brand-500 shrink-0" />
                <span className="text-xs text-secondary truncate flex-1 font-mono">{p.target}</span>
                <button
                  onClick={() => { void closeModule('approval'); void openModule('approval') }}
                  className="text-[10px] text-accent hover:underline shrink-0"
                >
                  {t('dock.open')}
                </button>
              </div>
            ))
          )
        )}
      </div>
    </div>
  )
}
