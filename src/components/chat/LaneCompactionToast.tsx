import { useCallback, useEffect } from 'react'
import { Layers } from 'lucide-react'
import { useChatStore } from '@/stores/chatStore'
import { useTranslation } from '@/i18n/useTranslation'

const VISIBLE_MS = 5000

interface Props { conversationId: string }

/**
 * 子任务压缩提示（agentloop lane_compaction）：右下角轻量胶囊，5s 自消。
 * 队列 laneNotesBySession[conversationId] 头部即当前展示；头部被 dismiss（超时/新 note
 * 顶替）即换下一条。与 CompressedToast（主压缩）错位：本条 bottom-14 在 CompressedToast
 * bottom-4 之上。非压缩期/无 note 不占位。
 */
export function LaneCompactionToast({ conversationId }: Props) {
  const note = useChatStore(s => s.laneNotesBySession[conversationId]?.[0])
  const { t } = useTranslation()
  const dismiss = useCallback(() => {
    useChatStore.getState().dismissLaneNote(conversationId)
  }, [conversationId])

  useEffect(() => {
    if (!note) return
    const timer = window.setTimeout(dismiss, VISIBLE_MS)
    return () => window.clearTimeout(timer)
  }, [note?.key, dismiss, note])

  if (!note) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-14 right-4 z-50 pointer-events-none animate-slide-up"
    >
      <div
        className="flex items-center gap-2 max-w-[380px] rounded-xl border bg-popover/95 px-3 py-2 shadow-2xl backdrop-blur-xl"
        style={{ borderColor: 'color-mix(in srgb, var(--brand-500) 28%, transparent)' }}
      >
        <Layers className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--brand-500)' }} />
        <span className="text-[11px] font-semibold text-primary whitespace-nowrap">
          {t('laneCompact.title', { n: note.compactCount })}
        </span>
        <span className="text-[11px] text-tertiary truncate min-w-0" title={note.text}>
          {note.text}
        </span>
      </div>
    </div>
  )
}
