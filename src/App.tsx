import { useEffect } from 'react'
import { TooltipProvider } from '@/components/ui'
import { AppShell } from '@/components/layout/AppShell'
import { EditorWindowRoot } from '@/components/editor/EditorWindowRoot'
import { BootScreen } from '@/components/boot/BootScreen'
import { LoginScreen } from '@/components/login/LoginScreen'
import { CockpitView } from '@/components/cockpit/CockpitView'
import { TokenStatsPanel } from '@/components/cockpit/TokenStatsPanel'
import { useSettingsStore } from '@/stores/settingsStore'
import { useViewStore } from '@/stores/viewStore'
import { useChatStore } from '@/stores/chatStore'
import { useTokenStatsStore } from '@/stores/tokenStatsStore'
import { isEditorWindow } from '@/lib/editorBridge'
import { isModuleWindow } from '@/lib/moduleBridge'
import { ModuleRoot } from '@/components/module/ModuleRoot'

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
  // 模块化窗口（?module=<id>）：渲染对应模块根（chat/files/settings/cockpit/dock）。
  if (isModuleWindow()) {
    return <ModuleRoot />
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
  useEffect(() => {
    if (view !== 'cockpit') return
    const store = useTokenStatsStore.getState()
    let cancelled = false
    // 主数据源：/transcript/stats 全量聚合（成功则覆盖本地；refreshFromServer 返回 true=成功）
    void store.refreshFromServer().then(ok => {
      if (cancelled) return
      if (!ok) {
        // 兜底：refresh 失败时逐会话 transcript 回填
        const convs = useChatStore.getState().conversations
        void store.ensureBackfill(convs)
      }
    })
    return () => { cancelled = true }   // 防 view 切换竞态
  }, [view])
  return (
    <TooltipProvider>
      {view === 'boot' && <BootScreen />}
      {view === 'login' && <LoginScreen />}
      {view === 'cockpit' && <CockpitView />}
      {view === 'workspace' && <AppShell />}
      {/* Token 统计面板：App 根级常驻挂载，视图切换（cockpit/workspace）均可打开；
          组件内部按 useUIStore.tokenPanelOpen 自守卫，关闭时渲染 null */}
      <TokenStatsPanel />
    </TooltipProvider>
  )
}
