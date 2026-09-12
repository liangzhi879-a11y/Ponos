// src/components/layout/ApprovalModePicker.tsx —— 状态栏「审批」档位选择器（2026-09-12）
// 位置：状态栏右侧（原假徽标处，见 StatusBar 内的注释）。这就是需求里说的界面下方
// 的 "manual" 处——旧徽标读的 settings.autoApproveBash 从来没人写、也从不发给桥/内核，
// 所以它显示什么与真实行为无关。现在它说真话：档位以桥上报为准。
//
// 语义边界（重要）：
//   · 状态栏 = **本会话临时覆盖**（仅内存）→ 只发 WS，**绝不写 config.json**；
//   · 设置页 → 全局持久化档位（写 config.json）。
//   会话结束后桥清掉覆盖并广播 scope:'cleared'，徽标可见地弹回全局档。
// 视觉：沿用状态栏微标（9.5px / .05em / 等宽数字），tone 决定颜色——
//   loose 警示色（已放宽）、bypass 危险色（近乎全放行，避免"忘了自己在哪档"）。
// 无活动会话：菜单仍可打开但选项禁用并提示去设置页（临时通道无对象可作用）。

import { Shield, ShieldAlert, ShieldOff, ShieldCheck } from 'lucide-react'
import { useTranslation } from '@/i18n/useTranslation'
import { useSettingsStore } from '@/stores/settingsStore'
import { useChatStore } from '@/stores/chatStore'
import { sendApprovalMode } from '@/hooks/useYFWCLI'
import {
  APPROVAL_MODE_OPTIONS, effectiveModeForSession, normalizeApprovalMode, type ApprovalMode,
} from '@/lib/approvalModeUi'
import { cn } from '@/lib/utils'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel,
} from '@/components/ui/dropdown-menu'

interface Props {
  /** 当前对话 id（无活动会话传 null：临时切档无对象可作用） */
  conversationId: string | null
}

/** tone → 徽标配色（Tailwind 类须全字面量，不可运行时拼） */
const TONE_CLASS: Record<string, string> = {
  default: 'text-tertiary',
  warning: 'text-warning',
  danger: 'text-error',
}

export function ApprovalModePicker({ conversationId }: Props) {
  const { t } = useTranslation()
  const globalMode = useSettingsStore(s => s.settings.approvalMode)
  const session = useChatStore(s => (conversationId ? s.sessionApprovalModes[conversationId] : undefined))

  const { mode, isOverride, global } = effectiveModeForSession({ session, globalMode })
  const option = APPROVAL_MODE_OPTIONS.find(o => o.value === mode) ?? APPROVAL_MODE_OPTIONS[0]
  const disabled = !conversationId

  const pick = (value: ApprovalMode | null) => {
    if (disabled) return
    // 选中的值 == 全局值 → 视为「跟随全局」（清覆盖）而不是挂一个与全局同值的临时档：
    // 否则用户只是想把临时档还原，徽标却会一直显示「临时」，语义失真。
    const next = value === null || value === normalizeApprovalMode(globalMode) ? null : value
    // 只发 WS：桥记入会话覆盖 → 热切内核 → 广播 approval-mode-changed 回来。
    // 不做本地乐观写（chatStore 只认桥上报），避免"界面显示 bypass、内核还在 loose"。
    sendApprovalMode(conversationId ?? undefined, next)
  }

  const Icon = mode === 'bypass' ? ShieldAlert : mode === 'loose' ? ShieldOff : ShieldCheck

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('approvalMode.label')}
          title={t('approvalMode.scopeNote')}
          className={cn(
            'flex items-center gap-1.5 px-2 py-0.5 rounded transition-colors select-none',
            'text-[9.5px] tracking-[.05em] whitespace-nowrap hover:bg-elevated',
            'outline-none focus-visible:ring-1 focus-visible:ring-accent',
            TONE_CLASS[option.tone] ?? TONE_CLASS.default,
            disabled && 'opacity-60'
          )}
        >
          <Icon className="w-3 h-3" />
          <span>{t(option.labelKey)}</span>
          {isOverride && (
            <span className="px-1 rounded bg-warning/20 text-warning text-[9px]">
              {t('approvalMode.temporary')}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" sideOffset={6} className="min-w-[240px]">
        {disabled && (
          <>
            <DropdownMenuLabel className="text-[10px] font-normal leading-snug whitespace-normal text-warning">
              {t('approvalMode.noSession')}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        )}
        {APPROVAL_MODE_OPTIONS.map(o => {
          const active = o.value === mode
          return (
            <DropdownMenuItem
              key={o.value}
              disabled={disabled}
              onSelect={() => pick(o.value)}
              className={cn('text-xs items-start', active ? 'text-primary font-medium' : 'text-secondary')}
            >
              <span
                aria-hidden
                className={cn(
                  'mt-1.5 w-1.5 h-1.5 rounded-full shrink-0',
                  active
                    ? (o.tone === 'danger' ? 'bg-error' : o.tone === 'warning' ? 'bg-warning' : 'bg-brand-500')
                    : 'bg-transparent'
                )}
              />
              <span className="flex-1 min-w-0">
                <span className="block">{t(o.labelKey)}</span>
                <span className="block text-[10px] text-tertiary whitespace-normal leading-snug">{t(o.descKey)}</span>
              </span>
            </DropdownMenuItem>
          )
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={disabled || !isOverride}
          onSelect={() => pick(null)}
          className="text-xs text-secondary"
        >
          {t('approvalMode.followGlobal', { mode: t(APPROVAL_MODE_OPTIONS.find(o => o.value === global)?.labelKey ?? 'approvalMode.loose') })}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[10px] font-normal leading-snug whitespace-normal text-tertiary">
          {t('approvalMode.scopeNote')}
        </DropdownMenuLabel>
        {/* 用 Item 而非 Label 内的按钮：Item 自带选中即收起（Radix），
            且 openUtility 是主进程 IPC（设置页已外置为独立窗口，旧的
            uiStore.settingsOpen 标志全仓库已无消费者，点了不会有反应）。 */}
        <DropdownMenuItem
          onSelect={() => window.yfworkingWindow?.openUtility?.('settings')}
          className="text-xs text-accent"
        >
          {t('approvalMode.openSettings')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
