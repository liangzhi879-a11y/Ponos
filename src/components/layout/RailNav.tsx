// src/components/layout/RailNav.tsx —— 工作屏常驻 rail 列（Task 9）
// 垂直固定宽 48px（w-12），四项导航 chat/task/agents/skills（来自 railMeta.RAIL），
// 点击 → useViewStore.setState 更新 workState.rail（SecondPanel 据此刻切换宿主内容）。
// 2026-09-10 UX 重构：底端新增「个人（用户管理）」与「设置」两个入口（个人在上、
// 设置在下，四周留边距）——点击经 utility:open IPC 打开对应独立无边框窗口。
import { RAIL } from './railMeta'
import { CircleUserRound, Settings } from 'lucide-react'
import { Tooltip } from '@/components/ui'
import { useViewStore } from '@/stores/viewStore'
import { useTranslation } from '@/i18n/useTranslation'
import { cn } from '@/lib/utils'
import type { RailId } from '@/stores/viewStore'

export function RailNav() {
  const { t } = useTranslation()
  const rail = useViewStore(s => s.workState.rail)

  const selectRail = (id: RailId) => {
    useViewStore.setState(s => ({ workState: { ...s.workState, rail: id } }))
  }

  const openUtility = (kind: 'settings' | 'profile') => {
    if (window.yfworkingWindow?.openUtility) window.yfworkingWindow.openUtility(kind)
  }

  const railButton = (active: boolean) =>
    cn(
      'relative h-9 w-9 flex items-center justify-center rounded-lg transition-colors',
      active
        ? 'text-brand-500'
        : 'text-tertiary hover:text-secondary hover:bg-surface',
    )

  return (
    <nav className="h-full w-12 flex-shrink-0 flex flex-col items-center py-2 border-r bg-app">
      <div className="flex flex-col items-center gap-1">
        {RAIL.map(item => {
          const Icon = item.icon
          const active = rail === item.id
          return (
            <Tooltip key={item.id} content={t(item.labelKey)} side="right">
              <button
                onClick={() => selectRail(item.id)}
                aria-label={t(item.labelKey)}
                aria-current={active ? 'true' : undefined}
                className={railButton(active)}
              >
                {/* rail 激活指示条（设计语言：左侧 2.5px 品牌渐变条 + 光晕） */}
                {active && <span className="rail-ind" aria-hidden />}
                <Icon className="w-[18px] h-[18px]" />
              </button>
            </Tooltip>
          )
        })}
      </div>

      {/* 底端工具入口：个人（用户管理）在上、设置在下（2026-09-10 UX 重构） */}
      <div className="mt-auto flex flex-col items-center gap-1.5 pb-2.5 pt-3">
        <div className="w-6 h-px bg-border" aria-hidden />
        <Tooltip content={t('profile.title')} side="right">
          <button
            onClick={() => openUtility('profile')}
            aria-label={t('profile.title')}
            className={railButton(false)}
          >
            <CircleUserRound className="w-[18px] h-[18px]" />
          </button>
        </Tooltip>
        <Tooltip content={t('settings.title')} side="right">
          <button
            onClick={() => openUtility('settings')}
            aria-label={t('settings.title')}
            className={railButton(false)}
          >
            <Settings className="w-[18px] h-[18px]" />
          </button>
        </Tooltip>
      </div>
    </nav>
  )
}
