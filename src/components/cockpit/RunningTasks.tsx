import { Loader2 } from 'lucide-react'
import { useChatStore } from '@/stores/chatStore'
import { useTranslation } from '@/i18n/useTranslation'

/** 驾驶舱右侧：运行中任务区（与左侧任务栏同源 backgroundTasks）。 */
export function RunningTasks() {
  const { t } = useTranslation()
  const tasks = useChatStore(s => s.backgroundTasks)
  const running = tasks.filter(x => x.status === 'running')
  if (running.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-[11px] uppercase tracking-wider text-tertiary">{t('cockpit.runningTasks')}</h3>
      {running.map(task => (
        <div key={task.id} className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-elevated/60 border border-subtle">
          <Loader2 className="w-3.5 h-3.5 text-brand-500 animate-spin shrink-0" />
          <span className="text-xs text-secondary truncate flex-1">{task.name}</span>
          <span className="text-[10px] text-tertiary tabular-nums shrink-0">
            {task.progress != null ? `${task.progress}%` : ''}
          </span>
        </div>
      ))}
    </div>
  )
}
