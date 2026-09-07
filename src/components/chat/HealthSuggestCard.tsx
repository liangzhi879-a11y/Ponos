// src/components/chat/HealthSuggestCard.tsx
import { useState } from 'react'
import { Minimize2 } from 'lucide-react'
import { useTranslation } from '@/i18n/useTranslation'
import { useHealthStore } from '@/stores/healthStore'
import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/uiStore'
import { shouldShowRedAlert } from '@/lib/healthUi'
import { Button } from '@/components/ui'

/** 红档时从输入框右下角向上浮出的"重新发起会话建议"卡片（非模态）。
 *  conversationId=当前查看的会话：红档判断/摘要/关闭冷却均按会话隔离。
 *  onStopSource：新建会话前停止源会话任务（kill 内核流式 + 清理前端流式状态），
 *  防止源会话继续消费上下文/输出。
 *  最小化：折叠为右下角警示小胶囊（不动 dismiss 冷却，随时可展开恢复）；
 *  关闭（dismiss）：进入冷却，冷却期内不再显示。 */
export function HealthSuggestCard({ conversationId, onStopSource }: { conversationId: string; onStopSource?: () => void }) {
  const { t } = useTranslation()
  const health = useHealthStore(s => s.healthBySession[conversationId]) ?? null
  const summary = useHealthStore(s => s.summaryBySession[conversationId]) ?? ''
  const dismissedUntil = useHealthStore(s => s.dismissedUntilBySession[conversationId]) ?? 0
  const dismiss = useHealthStore(s => s.dismiss)
  const [carrySummary, setCarrySummary] = useState(true)
  // 最小化：折叠为右下角警示小胶囊（仅状态点 + 标题），点击恢复展开卡片。
  // 与 dismiss 不同：不动 dismissedUntil 冷却，随时可展开。
  const [minimized, setMinimized] = useState(false)

  if (!health || !shouldShowRedAlert(health, dismissedUntil)) return null

  const handleNewSession = () => {
    const { conversations, activeConversationId, createConversation } = useChatStore.getState()
    const current = conversations.find(c => c.id === activeConversationId)
    // 先停源会话任务（源会话红档仍在运行）：停止内核流式并清理前端流式状态，
    // 避免它继续吞上下文；再新建会话携带摘要，源会话保持只读可回溯。
    onStopSource?.()
    createConversation(undefined, current?.agentId)
    if (carrySummary && summary) {
      useUIStore.getState().setPendingInput(summary, false)
    }
    dismiss(conversationId)
  }

  const detail = `${t('health.remainingPct', { pct: health.remainingPct })} · ${t('health.remainingTurns', { turns: health.remainingTurns })}`

  // 最小化：右下角警示小胶囊（fixed 定位，避开 CompressedToast 的 bottom-4 与回到底部按钮）
  if (minimized) {
    return (
      <button
        onClick={() => setMinimized(false)}
        title={`${t('health.restore')} · ${detail}`}
        className="fixed bottom-16 right-4 z-50 flex items-center gap-2 max-w-[300px] rounded-full border bg-popover/95 px-3 py-1.5 shadow-2xl backdrop-blur animate-slide-up"
        style={{ borderColor: 'color-mix(in srgb, var(--health-tier-red) 28%, transparent)' }}
      >
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0 animate-pulse"
          style={{ background: 'var(--health-tier-red)' }}
        />
        <span className="text-[11px] font-medium text-primary truncate">
          {health.reason || t('health.redTitle')}
        </span>
      </button>
    )
  }

  return (
    <div
      className="absolute bottom-full right-2 left-auto mb-2 z-40 w-[320px] max-w-[calc(100vw-2rem)] rounded-xl border bg-popover/95 backdrop-blur-xl shadow-2xl p-3 animate-slide-up"
      style={{ borderColor: 'color-mix(in srgb, var(--health-tier-red) 28%, transparent)' }}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium" style={{ color: 'var(--health-tier-red)' }}>
          {health.reason || t('health.redTitle')}
        </span>
        <span className="text-xs text-tertiary">{detail}</span>
      </div>
      {summary && (
        <div
          className="mt-2 max-h-20 overflow-y-auto rounded-lg px-2.5 py-1.5 text-xs text-secondary whitespace-pre-wrap"
          style={{
            background: 'color-mix(in srgb, var(--health-tier-red) 5%, transparent)',
            border: '1px solid color-mix(in srgb, var(--health-tier-red) 10%, transparent)',
          }}
        >
          {summary}
        </div>
      )}
      <div className="mt-2.5 flex items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none">
          <input type="checkbox" checked={carrySummary} onChange={e => setCarrySummary(e.target.checked)} />
          {t('health.carrySummary')}
        </label>
        <div className="ml-auto flex items-center gap-2">
          <Button onClick={handleNewSession} variant="danger" size="sm">
            {t('health.newSession')}
          </Button>
          <button
            onClick={() => setMinimized(true)}
            title={t('health.minimize')}
            aria-label={t('health.minimize')}
            className="p-1 rounded-md transition-colors"
            style={{ color: 'color-mix(in srgb, var(--health-tier-red) 70%, var(--text-primary))' }}
          >
            <Minimize2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => dismiss(conversationId)}
            className="text-xs hover:opacity-80"
            style={{ color: 'color-mix(in srgb, var(--health-tier-red) 70%, var(--text-primary))' }}
            aria-label={t('health.dismiss')}
          >
            {t('health.dismiss')}
          </button>
        </div>
      </div>
    </div>
  )
}
