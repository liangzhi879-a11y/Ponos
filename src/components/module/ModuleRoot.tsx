// src/components/module/ModuleRoot.tsx
// 模块窗口根：按 ?module=<id> 分发到对应组件根。
// Task 6 起：未知/缺失 moduleId（主窗口 dock 化）→ DockBar。
// Task 7 完成 chat（试点 1）、Task 8 完成 files（试点 2）；settings/cockpit 分支在 Task 9 补全（当前保留占位文本）。
import { getModuleId } from '@/lib/moduleBridge'
import { DockBar } from '@/components/dock/DockBar'
import { ChatModule } from '@/components/module/windows/ChatModule'
import { FilesModule } from '@/components/module/windows/FilesModule'

export function ModuleRoot() {
  const moduleId = getModuleId()
  switch (moduleId) {
    // Task 7：聊天模块窗口化（试点 1）
    case 'chat':
      return <ChatModule />
    // Task 8：文件模块窗口化（试点 2）
    case 'files':
      return <FilesModule />
    // 已声明但尚未实现的模块窗口：保持 Task 5 占位（Task 8-9 依次替换为组件根）。
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
