// 应用卡片（Task 1.6）
//
// 视觉语言与 SkillsPanel 的卡片一致：group + hover 显现操作、rounded + bg-elevated、
// 文本用既有语义色（text-primary/secondary/tertiary）。
// 卡片本体是 button 语义（可键盘聚焦 + Enter 打开），不是 div+onClick——面板内首个
// 可交互元素必须能被 Tab 到。
import { Globe, Monitor, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/useTranslation'
import type { AppItem } from '@/types'

export function AppCard({ app, onOpen, onRemove }: {
  app: AppItem
  onOpen: () => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const isWeb = app.targetType === 'web'
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      className={cn(
        'group relative flex flex-col gap-2 p-3 rounded-lg bg-elevated border border-subtle text-left',
        'hover:bg-active hover:border-brand-500/40 transition-colors cursor-pointer focus-ring',
        app.enabled === false && 'opacity-60',
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <div className="w-6 h-6 rounded bg-input flex items-center justify-center shrink-0">
          {isWeb ? <Globe className="w-3.5 h-3.5 text-brand-500" /> : <Monitor className="w-3.5 h-3.5 text-brand-500" />}
        </div>
        <span className="text-xs font-medium text-primary truncate flex-1">{app.name || app.id}</span>
        <button
          type="button"
          aria-label={t('apps.remove')}
          title={t('apps.remove')}
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          className="hidden group-hover:flex items-center justify-center w-5 h-5 rounded hover:bg-error/20 transition-colors"
        >
          <Trash2 className="w-3 h-3 text-tertiary hover:text-error" />
        </button>
      </div>
      <p className="text-[10px] text-tertiary line-clamp-2 leading-relaxed min-h-[26px]">
        {app.desc || t('apps.noDesc')}
      </p>
      <div className="flex items-center gap-1.5">
        <span className="text-[9px] px-1 py-0.5 rounded bg-input text-tertiary">
          {isWeb ? t('apps.targetWeb') : t('apps.targetDesktop')}
        </span>
        <span className="text-[9px] font-mono text-tertiary/70 truncate">{app.id}</span>
      </div>
    </div>
  )
}

/** 「新增应用」卡位（虚线边框，与卡片同尺寸，网格里自然占位） */
export function AddAppCard({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex flex-col items-center justify-center gap-1.5 p-3 rounded-lg min-h-[96px]',
        'border border-dashed border-subtle hover:border-brand-500/50 hover:bg-active/40 transition-colors',
      )}
    >
      <span className="text-lg leading-none text-brand-500/90">+</span>
      <span className="text-[11px] text-secondary">{t('apps.add')}</span>
    </button>
  )
}
