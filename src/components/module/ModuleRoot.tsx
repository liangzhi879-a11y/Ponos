// src/components/module/ModuleRoot.tsx
// 模块窗口根：按 ?module=<id> 分发到对应组件根。
// Task 6 起：未知/缺失 moduleId（主窗口 dock 化）→ DockBar。
// files/settings/cockpit 分支在 Task 8-9 逐个补全（当前保留占位文本）。
import { getModuleId } from '@/lib/moduleBridge'
import { DockBar } from '@/components/dock/DockBar'
import { ChatModule } from '@/components/module/windows/ChatModule'

export function ModuleRoot() {
  const moduleId = getModuleId()
  switch (moduleId) {
    // Task 7：聊天模块窗口化（试点 1）
    case 'chat':
      return <ChatModule />
    // 已声明但尚未实现的模块窗口：保持 Task 5 占位（Task 8-9 依次替换为组件根）。
    case 'files':
    case 'settings':
    case 'cockpit':
      return (
        <div data-module-root={moduleId} data-testid="module-root">
          {moduleId}
        </div>
      )
    default:
      return <DockBar />
  }
}
