// src/components/chat/EffortPicker.tsx —— 输入条思考深度（effort）快速选择器（Task 13）
// 位置：SessionModeBar 右侧（会话模式徽标条 h-7 行）。会话/任务共用。
// 状态：显示读全局 settings.effortLevel（一次设置全应用，normalizeEffortUi 兜底旧快照）；
//       切档 = updateSettings 即时持久化（zustand persist）+ saveBridgeConfig 同步落盘
//       config.json（bridge 新会话 spawn env 读磁盘；失败静默降级——当前会话已热切）
//       + sendEffort(conversationId, v) 向运行中会话 WS 热切换（Task 12 helper；无会话/WS 未连幂等 no-op）。
// 图标约束：无 lucide 图标——trigger 纯文字「深度 · 档名」+ 当前档位色点 span；
//           弹层内当前档也用同款小色点标记（复用 trigger 视觉语言，不引入 Check 等图标）。
// Radix：shadcn 风格 wrapper（@/components/ui/dropdown-menu），onSelect 后默认自动收起。

import { useTranslation } from '@/i18n/useTranslation'
import { useSettingsStore } from '@/stores/settingsStore'
import { sendEffort } from '@/hooks/useYFWCLI'
import { EFFORT_OPTIONS, normalizeEffortUi, type EffortLevel } from '@/lib/effortUi'
import { saveBridgeConfig } from '@/lib/config'
import { cn } from '@/lib/utils'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel,
} from '@/components/ui/dropdown-menu'

interface Props {
  conversationId: string
}

export function EffortPicker({ conversationId }: Props) {
  const { t } = useTranslation()
  const settings = useSettingsStore(s => s.settings)
  const updateSettings = useSettingsStore(s => s.updateSettings)

  const current = normalizeEffortUi(settings.effortLevel)
  const currentOption = EFFORT_OPTIONS.find(o => o.value === current) ?? EFFORT_OPTIONS[0]

  const pick = (value: EffortLevel) => {
    // 选中值持久化到全局 settings（一次设置全应用；normalize 兜底与读路径同款）；
    // 随后即时热切当前会话（Task 12 sendEffort 幂等，无会话/未连接安全 no-op）。
    updateSettings({ effortLevel: normalizeEffortUi(value) })
    sendEffort(conversationId, value)
    // Task 15 最终评审 I-1：settingsStore 只落 localStorage；bridge spawn env 读磁盘 config.json，
    // 热切须同步落盘让后续新会话生效（服务端浅合并，仅带 effortLevel 安全；失败静默降级——当前会话已热切）。
    void saveBridgeConfig({ effortLevel: value }).catch(() => {})
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('effort.label')}
          className={cn(
            'inline-flex items-center cut-xs text-[11px] whitespace-nowrap',
            'text-secondary hover:text-primary transition-colors',
            'outline-none focus-visible:ring-1 focus-visible:ring-accent'
          )}
        >
          <span className="ci flex items-center gap-1.5 h-5 px-2">
            <span
              aria-hidden
              className={cn(
                'w-1.5 h-1.5 rounded-full shrink-0',
                current === 'auto' ? 'bg-tertiary/60' : 'bg-brand-500'
              )}
            />
            {t('effort.label')} · {t(currentOption.labelKey)}
          </span>
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" sideOffset={6} className="min-w-[190px]">
        {EFFORT_OPTIONS.map(o => {
          const active = o.value === current
          return (
            <DropdownMenuItem
              key={o.value}
              onSelect={() => pick(o.value)}
              className={cn('text-xs', active ? 'text-primary font-medium' : 'text-secondary')}
            >
              <span className="flex-1">{t(o.labelKey)}</span>
              <span
                aria-hidden
                className={cn(
                  'w-1.5 h-1.5 rounded-full shrink-0',
                  active ? 'bg-brand-500' : 'bg-transparent'
                )}
              />
            </DropdownMenuItem>
          )
        })}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[10px] font-normal leading-snug whitespace-normal text-tertiary">
          {t('effort.mapNote')}
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
