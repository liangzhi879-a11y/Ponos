// src/components/settings/PermissionsPanel.tsx —— 设置页「权限」分区（2026-09-12）
// 写**全局持久化**档位（settings.approvalMode → handleSave 并入 cfg → config.json）。
// 与状态栏的分工：状态栏改本会话临时档（只发 WS、不落盘）；这里是唯一改全局档的入口。
// 提级（放宽方向）到 loose/bypass 必须二次确认：越宽松越容易"忘了自己在哪档"，
// 而这两个档意味着写文件/联网/高危命令不再逐次询问。reasons 见 requiresConfirm。
//
// 诚实性文案（写死在这里，不进 i18n 模板）：auto 只约束工具层写文件；bypass 仍拦灾难命令。

import { useState } from 'react'
import { ShieldCheck, ShieldAlert, ShieldOff, Shield, AlertTriangle } from 'lucide-react'
import { useSettingsStore } from '@/stores/settingsStore'
import { useTranslation } from '@/i18n/useTranslation'
import {
  APPROVAL_MODE_OPTIONS, normalizeApprovalMode, requiresConfirm, type ApprovalMode,
} from '@/lib/approvalModeUi'
import { cn } from '@/lib/utils'

const TONE_RING: Record<string, string> = {
  default: 'border-border',
  warning: 'border-warning/50',
  danger: 'border-error/50',
}
const TONE_TEXT: Record<string, string> = {
  default: 'text-primary',
  warning: 'text-warning',
  danger: 'text-error',
}
const TONE_ICON = {
  manual: ShieldCheck, auto: Shield, loose: ShieldOff, bypass: ShieldAlert,
} as const

export function PermissionsPanel() {
  const { t } = useTranslation()
  const settings = useSettingsStore(s => s.settings)
  const updateSettings = useSettingsStore(s => s.updateSettings)

  const current = normalizeApprovalMode(settings.approvalMode)
  // 待确认的档位（非空 = 已选但未确认，保存前不会写进 settings）
  const [pending, setPending] = useState<ApprovalMode | null>(null)

  const select = (next: ApprovalMode) => {
    if (next === current) return
    if (requiresConfirm(current, next)) {
      setPending(next)   // 放宽方向：先确认再落
      return
    }
    setPending(null)
    updateSettings({ approvalMode: next })
  }

  const confirmPending = () => {
    if (!pending) return
    updateSettings({ approvalMode: pending })
    setPending(null)
  }

  const pendingOption = APPROVAL_MODE_OPTIONS.find(o => o.value === pending)

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-primary mb-1 flex items-center gap-2">
          <Shield className="w-4 h-4" />
          {t('approvalMode.globalTitle')}
        </h3>
        <p className="text-xs text-tertiary">{t('approvalMode.globalDesc')}</p>
        <p className="text-[10px] text-tertiary mt-1">
          {t('approvalMode.effectiveNow', {
            mode: t(APPROVAL_MODE_OPTIONS.find(o => o.value === current)?.labelKey ?? 'approvalMode.loose'),
          })}
        </p>
      </div>

      <div className="space-y-2">
        {APPROVAL_MODE_OPTIONS.map(o => {
          const active = o.value === current
          const Icon = TONE_ICON[o.value]
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => select(o.value)}
              aria-pressed={active}
              className={cn(
                'w-full text-left flex items-start gap-3 px-3 py-2.5 rounded-lg border transition-colors',
                active ? 'bg-brand-500/10 border-brand-500/50' : 'hover:bg-elevated',
                !active && TONE_RING[o.tone]
              )}
            >
              <Icon className={cn('w-4 h-4 mt-0.5 shrink-0', active ? 'text-brand-500' : TONE_TEXT[o.tone])} />
              <span className="flex-1 min-w-0">
                <span className={cn('block text-xs', active ? 'text-primary font-medium' : 'text-secondary')}>
                  {t(o.labelKey)}
                </span>
                <span className="block text-[10px] text-tertiary mt-0.5 leading-snug">{t(o.descKey)}</span>
              </span>
              {active && <span className="text-[10px] text-brand-500 mt-0.5">{t('approvalMode.current')}</span>}
            </button>
          )
        })}
      </div>

      {/* 二次确认（放宽方向）：确认前只显示提示条，不写入 settings */}
      {pending && pendingOption && (
        <div className="rounded-lg border border-warning/50 bg-warning/10 px-3 py-2.5 space-y-2">
          <p className="text-xs text-warning font-medium">
            {t('approvalMode.confirmTitle', { mode: t(pendingOption.labelKey) })}
          </p>
          <p className="text-[10px] text-secondary leading-snug">
            {t('approvalMode.confirmBody', { desc: t(pendingOption.descKey) })}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={confirmPending}
              className="px-2.5 py-1 rounded text-[11px] bg-warning/20 text-warning hover:bg-warning/30 transition-colors"
            >
              {t('approvalMode.confirmOk')}
            </button>
            <button
              type="button"
              onClick={() => setPending(null)}
              className="px-2.5 py-1 rounded text-[11px] text-secondary hover:bg-elevated transition-colors"
            >
              {t('approvalMode.confirmCancel')}
            </button>
          </div>
        </div>
      )}

      {/* 灾难级硬黑名单：四档都不放行，且仍会弹窗（可单次放行） */}
      <div className="rounded-lg border border-error/40 bg-error/5 px-3 py-2.5">
        <p className="text-xs text-error font-medium flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5" />
          {t('approvalMode.hardTitle')}
        </p>
        <p className="text-[10px] text-secondary mt-1 leading-snug">{t('approvalMode.hardList')}</p>
        <p className="text-[10px] text-tertiary mt-1 leading-snug">{t('approvalMode.hardNote')}</p>
      </div>

      {/* 诚实性说明：不许诺 UI 做不到的事 */}
      <div className="rounded-lg border border-border px-3 py-2.5 space-y-1">
        <p className="text-[10px] text-tertiary leading-snug">{t('approvalMode.autoHonest')}</p>
        <p className="text-[10px] text-tertiary leading-snug">{t('approvalMode.scopeNote')}</p>
      </div>
    </div>
  )
}
