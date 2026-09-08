import { AlertTriangle, RefreshCcw, Bot, Info, X, type LucideIcon } from 'lucide-react'
import { useWarningStore } from '@/stores/warningStore'
import { useChatStore } from '@/stores/chatStore'
import { useYFWCLI } from '@/hooks/useYFWCLI'
import { useTranslation } from '@/i18n/useTranslation'

interface Props { conversationId: string }

// level → 样式/图标。Tailwind 类须全字面量（不可运行时拼 class 名），
// 未知 level 走 FALLBACK（context 级含 message，同样覆盖显示）。
const LEVEL_STYLE: Record<string, { text: string; border: string; icon: LucideIcon }> = {
  budget: { text: 'text-red-500', border: 'border-red-500/40', icon: AlertTriangle },
  skill_version: { text: 'text-amber-500', border: 'border-amber-500/40', icon: RefreshCcw },
  agent_spec: { text: 'text-amber-500', border: 'border-amber-500/40', icon: Bot },
}
const FALLBACK_STYLE = { text: 'text-amber-500', border: 'border-amber-500/40', icon: Info }

/**
 * 统一系统提示条（agentloop P3）：ponos_warning 事件（budget/skill_version/agent_spec，
 * 顺带 context）→ 会话级提示。挂载于 ChatWindow 顶部（KernelStallBar 之下、消息区之上），
 * 文档流元素：无告警不占位，有告警才占高度。
 * - budget：带「停止任务」按钮（双调 cancel 语义，同 KernelStallBar onCancel）；
 * - 其余 level：仅提示 + 关闭；未知 level 显示 message 原文或 level 名。
 * - 关闭 = dismiss（纯收 UI）；同 level 后到事件仍可再置。
 */
export function SystemWarningStrip({ conversationId }: Props) {
  const warning = useWarningStore(s => s.warningBySession[conversationId])
  const { stop } = useYFWCLI()
  const { t } = useTranslation()

  if (!warning) return null
  const meta = LEVEL_STYLE[warning.level] || FALLBACK_STYLE
  const Icon = meta.icon
  const showStop = warning.level === 'budget'

  let title: string
  if (warning.level === 'budget' && typeof warning.usd === 'number' && typeof warning.budgetUsd === 'number') {
    title = t('warnings.budget', { usd: warning.usd.toFixed(4), budgetUsd: warning.budgetUsd.toFixed(4) })
  } else if (warning.level === 'skill_version') {
    title = t('warnings.skillVersion', { n: warning.outdated?.length ?? 0 })
  } else if (warning.message) {
    title = warning.message
  } else {
    title = t('warnings.unknown', { level: warning.level })
  }

  const onStop = () => {
    useChatStore.getState().stopStreaming(conversationId)
    stop(conversationId)
  }
  const onClose = () => useWarningStore.getState().dismiss(conversationId)

  // skill_version 明细（id: lock → disk）合入 title 悬停；agent_spec message 本身可能是长句
  const detail = warning.level === 'skill_version' && warning.outdated
    ? warning.outdated.map(o => `${o.id}: ${o.lock} → ${o.disk}`).join('；')
    : undefined

  return (
    <div className="flex justify-center px-4 pt-3" role="status" aria-live="polite">
      <div className={`pointer-events-auto flex items-center gap-2 max-w-[900px] rounded-full border bg-elevated/90 px-3 py-1.5 shadow-lg backdrop-blur ${meta.border}`}>
        <Icon className={`w-3.5 h-3.5 shrink-0 ${meta.text}`} />
        <span
          className={`text-[11px] font-semibold whitespace-nowrap ${meta.text}`}
          title={detail || title}
        >
          {title}
        </span>
        {showStop && (
          <>
            <span className="mx-0.5 w-px h-3.5 bg-border" aria-hidden />
            <button
              onClick={onStop}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium text-red-500 hover:bg-red-500/10 border border-transparent hover:border-red-500/30 transition-colors whitespace-nowrap"
            >
              {t('warnings.stopTask')}
            </button>
          </>
        )}
        <button
          onClick={onClose}
          title={t('warnings.dismiss')}
          aria-label={t('warnings.dismiss')}
          className="inline-flex items-center justify-center w-5 h-5 rounded-full text-tertiary hover:text-secondary hover:bg-elevated border border-transparent hover:border-subtle transition-colors"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    </div>
  )
}
