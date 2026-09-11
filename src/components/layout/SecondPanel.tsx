// src/components/layout/SecondPanel.tsx —— 工作屏二级面板宿主（Task 9 → Task 10 内容落位）
// 常驻 ~240px（SECOND_PANEL_W）竖列，按 viewStore.workState.rail 路由内容：
//   · chat/task → ChatListPanel / TaskListPanel（Task 10：旧 Sidebar chats 分支完整迁移，
//     chat 仅对话、task 全量会话管理 + 次级浮层图标行）；
//   · agents/skills → 2026-09-10 主标签化：已上移 WorkShell 全主界面卡片浏览，
//     本宿主只保留 chat/task 分支。
// Task 10 结构变更：列本身仍是 overflow-hidden，但外包一层 relative 包裹盒（宽 240）。
// 次级浮层 FilesHistoryOverlay（420px 抽屉）是包裹盒的 absolute sibling，定位 left:100%，
// 从本列右缘滑出覆盖主聊天列——不被列内 overflow-hidden 裁剪，z-[40] 低于全局 overlays。
// rail 离开 task 时 effect 强制复位 secondTab=null（浮层状态不残留，spec §7 往返语义）。
import { useEffect } from 'react'
import { ChatListPanel } from '@/components/rail/ChatListPanel'
import { TaskListPanel } from '@/components/rail/TaskListPanel'
import { FilesHistoryOverlay } from '@/components/rail/FilesHistoryOverlay'
import { useViewStore } from '@/stores/viewStore'

export const SECOND_PANEL_W = 240

export function SecondPanel() {
  const rail = useViewStore(s => s.workState.rail)
  const secondTab = useViewStore(s => s.workState.secondTab)

  // rail 离开 task → 关闭浮层（浮层图标只在 task 面板头部；状态不跨 rail 残留）
  useEffect(() => {
    if (rail !== 'task' && secondTab) {
      useViewStore.setState(s => ({ workState: { ...s.workState, secondTab: null } }))
    }
  }, [rail, secondTab])

  return (
    <div className="relative h-full flex-shrink-0 flex flex-col min-h-0" style={{ width: SECOND_PANEL_W }}>
      <aside className="w-full h-full bg-app border-r flex flex-col min-h-0 overflow-hidden">
        {rail === 'chat' && <ChatListPanel />}
        {rail === 'task' && <TaskListPanel />}
      </aside>
      {rail === 'task' && <FilesHistoryOverlay />}
    </div>
  )
}
