import { useEffect } from 'react'
import { TooltipProvider } from '@/components/ui'
import { ViewRouter } from '@/components/layout/ViewRouter'
import { EditorWindowRoot } from '@/components/editor/EditorWindowRoot'
import { AuthWindowRoot } from '@/components/auth/AuthWindowRoot'
import { SettingsWindowRoot } from '@/components/settings/SettingsWindowRoot'
import { ProfileWindowRoot } from '@/components/settings/ProfileWindowRoot'
import { useSettingsStore } from '@/stores/settingsStore'
import { isEditorWindow } from '@/lib/editorBridge'
import { isAuthWindow } from '@/lib/authWindow'
import { isSettingsWindow, isProfileWindow } from '@/lib/utilityWindows'

export default function App() {
  // 认证小窗（?auth=1，D11-D13）：先于主窗口出现的独立登录窗，只渲染 AuthScreen
  // 完成首设/登录，不加载 MainApp/ViewRouter（AuthWindowRoot 内已包 TooltipProvider）。
  if (isAuthWindow()) return <AuthWindowRoot />
  // 独立原生编辑器窗口（?editor=1）：只渲染编辑器根组件，不加载主界面。
  // FileEditor 使用了 Tooltip，必须包 TooltipProvider，否则打开文件渲染保存按钮时报错。
  if (isEditorWindow()) {
    return (
      <TooltipProvider>
        <EditorWindowRoot />
      </TooltipProvider>
    )
  }
  // 独立设置窗口（?settings=1，2026-09-10）：设置面板从主窗口移出，主题由 main.tsx
  // 按持久化设置全局应用，与本窗内修改即时同步。
  if (isSettingsWindow()) return <SettingsWindowRoot />
  // 独立个人信息窗口（?profile=1，2026-09-10）：头像/昵称/密码管理。
  if (isProfileWindow()) return <ProfileWindowRoot />
  return <MainApp />
}

function MainApp() {
  const s = useSettingsStore(st => st.settings)
  useEffect(() => {
    const api = window.yfworkingAPI
    api?.setTrayBehavior?.(s.minimizeToTray)
    api?.setPetConfig?.({ enabled: s.petEnabled, size: s.petSize, randomChat: s.petRandomChat })
  }, [s.minimizeToTray, s.petEnabled, s.petSize, s.petRandomChat])
  return (
    <TooltipProvider>
      {/* view 状态机路由：boot→login→cockpit→work；AppShell 在 ViewRouter work 分支渲染 */}
      <ViewRouter />
    </TooltipProvider>
  )
}
