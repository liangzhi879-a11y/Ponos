import { useMemo } from 'react'
import { MessageSquare } from 'lucide-react'
import { useChatStore } from '@/stores/chatStore'
import { useViewStore } from '@/stores/viewStore'
import { useTranslation } from '@/i18n/useTranslation'
import { cn } from '@/lib/utils'

function timeAgo(ts: number, t: (k: string) => string): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return t('cockpit.justNow')
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  return new Date(ts).toLocaleDateString()
}

/** 驾驶舱右侧：最近会话列表（updatedAt 倒序，点选直达工作台对应会话）。 */
export function RecentSessions({ limit = 6 }: { limit?: number }) {
  const { t } = useTranslation()
  const conversations = useChatStore(s => s.conversations)
  const goWorkspace = useViewStore(s => s.goWorkspace)
  const recent = useMemo(
    () => [...conversations].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, limit),
    [conversations, limit],
  )
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-[11px] uppercase tracking-wider text-tertiary">{t('cockpit.recentSessions')}</h3>
      {recent.length === 0 ? (
        <p className="text-xs text-tertiary">{t('cockpit.noRecent')}</p>
      ) : (
        recent.map(c => (
          <button
            key={c.id}
            onClick={() => goWorkspace('chats')} // 实际进入并激活会话由工作台处理
            className={cn(
              'flex items-center gap-2.5 px-3 py-2 rounded-lg text-left',
              'hover:bg-hover transition-colors group',
            )}
          >
            <MessageSquare className="w-3.5 h-3.5 text-tertiary shrink-0 group-hover:text-brand-500 transition-colors" />
            <div className="min-w-0 flex-1">
              <div className="text-xs text-secondary truncate" title={c.title}>{c.title || c.id.slice(0, 12)}</div>
              <div className="text-[10px] text-tertiary tabular-nums">{timeAgo(c.updatedAt || c.createdAt, t)}</div>
            </div>
          </button>
        ))
      )}
    </div>
  )
}
