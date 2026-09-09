// src/components/layout/SecondPanel.tsx —— 工作屏二级面板宿主（Task 9）
// 常驻 ~240px（SECOND_PANEL_W）竖列，按 viewStore.workState.rail 路由内容：
//   · agents/skills → 挂载既有真面板 AgentsPanel/SkillsPanel（旧 Sidebar 的唯一入口
//     本任务被移除，挂载在此保持二者可用而非死代码）；
//   · chat/task     → 本任务渲染占位（真 ChatListPanel/TaskListPanel 属后续任务范围）。
// 占位文案只吃 rail.* labelKey（rail 四项唯一新增 i18n 键，无额外硬编码文案）。
import { AgentsPanel } from '@/components/agents/AgentsPanel'
import { SkillsPanel } from '@/components/skills/SkillsPanel'
import { useViewStore } from '@/stores/viewStore'
import { useTranslation } from '@/i18n/useTranslation'
import { RAIL } from './railMeta'
import type { RailId } from '@/stores/viewStore'

export const SECOND_PANEL_W = 240

export function SecondPanel() {
  const rail = useViewStore(s => s.workState.rail)

  return (
    <aside
      className="h-full flex-shrink-0 border-r bg-app flex flex-col min-h-0 overflow-hidden"
      style={{ width: SECOND_PANEL_W }}
    >
      {rail === 'agents' && <AgentsPanel />}
      {rail === 'skills' && <SkillsPanel />}
      {(rail === 'chat' || rail === 'task') && <RailPlaceholder rail={rail} />}
    </aside>
  )
}

/** chat/task 占位：等后续任务的 ChatListPanel/TaskListPanel 替换 */
function RailPlaceholder({ rail }: { rail: RailId }) {
  const { t } = useTranslation()
  const meta = RAIL.find(r => r.id === rail)
  if (!meta) return null
  const Icon = meta.icon
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2.5 px-4 text-center">
      <Icon className="w-6 h-6 text-tertiary" />
      <span className="text-xs font-medium text-secondary">{t(meta.labelKey)}</span>
    </div>
  )
}
