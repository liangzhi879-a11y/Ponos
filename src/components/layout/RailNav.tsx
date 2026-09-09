// src/components/layout/RailNav.tsx —— 工作屏常驻 rail 列（Task 9）
// 垂直固定宽 48px（w-12），四项导航 chat/task/agents/skills（来自 railMeta.RAIL），
// 点击 → useViewStore.setState 更新 workState.rail（SecondPanel 据此刻切换宿主内容）。
// 无底部设置项：设置入口在 Header 齿轮（避免与 rail 图标语义重复，决策见 task-9 brief）。
import { RAIL } from './railMeta'
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
                className={cn(
                  'h-9 w-9 flex items-center justify-center rounded-lg transition-colors',
                  active
                    ? 'text-white shadow-sm'
                    : 'text-tertiary hover:text-secondary hover:bg-surface',
                )}
                style={active
                  ? { background: 'linear-gradient(135deg, var(--brand-500), var(--brand-600))' }
                  : undefined}
              >
                <Icon className="w-[18px] h-[18px]" />
              </button>
            </Tooltip>
          )
        })}
      </div>
    </nav>
  )
}
