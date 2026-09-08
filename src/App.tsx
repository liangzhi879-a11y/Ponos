import { useEffect } from 'react'
import { TooltipProvider } from '@/components/ui'
import { ViewRouter } from '@/components/layout/ViewRouter'
import { EditorWindowRoot } from '@/components/editor/EditorWindowRoot'
import { useSettingsStore } from '@/stores/settingsStore'
import { isEditorWindow } from '@/lib/editorBridge'

export default function App() {
  // 独立原生编辑器窗口（?editor=1）：只渲染编辑器根组件，不加载主界面。
  // FileEditor 使用了 Tooltip，必须包 TooltipProvider，否则打开文件渲染保存按钮时报错。
  if (isEditorWindow()) {
    return (
      <TooltipProvider>
        <EditorWindowRoot />
      </TooltipProvider>
    )
  }
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
