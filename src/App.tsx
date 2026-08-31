import { useEffect } from 'react'
import { TooltipProvider } from '@/components/ui'
import { AppShell } from '@/components/layout/AppShell'
import { EditorWindowRoot } from '@/components/editor/EditorWindowRoot'
import { BootScreen } from '@/components/boot/BootScreen'
import { LoginScreen } from '@/components/login/LoginScreen'
import { CockpitView } from '@/components/cockpit/CockpitView'
import { useSettingsStore } from '@/stores/settingsStore'
import { useViewStore } from '@/stores/viewStore'
import { useChatStore } from '@/stores/chatStore'
import { useTokenStatsStore } from '@/stores/tokenStatsStore'
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
  const view = useViewStore(s => s.view)
  const s = useSettingsStore(st => st.settings)
  useEffect(() => {
    const api = window.ponosAPI
    api?.setTrayBehavior?.(s.minimizeToTray)
    api?.setPetConfig?.({ enabled: s.petEnabled, size: s.petSize, randomChat: s.petRandomChat, pet: s.petType })
  }, [s.minimizeToTray, s.petEnabled, s.petSize, s.petRandomChat, s.petType])
  // 驾驶舱首次打开时触发 Token 历史回填
  useEffect(() => {
    if (view === 'cockpit') {
      const convs = useChatStore.getState().conversations
      void useTokenStatsStore.getState().ensureBackfill(convs)
    }
  }, [view])
  return (
    <TooltipProvider>
      {view === 'boot' && <BootScreen />}
      {view === 'login' && <LoginScreen />}
      {view === 'cockpit' && <CockpitView />}
      {view === 'workspace' && <AppShell />}
    </TooltipProvider>
  )
}
