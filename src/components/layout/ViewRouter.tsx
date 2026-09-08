// src/components/layout/ViewRouter.tsx —— 顶层视图路由宿主（viewStore 状态机：boot→login→cockpit→work）
// Task 5：boot/login/cockpit 三态；work 分支渲染现 AppShell（Task 9 换 WorkShell）。
// settings.speedMode === true 时短路跳过 boot（同帧渲染 login 分支，不挂载 BootScreen），
// 再经 useEffect 把 store 落为 'login'（下次整页重载不再回 boot）。
import { useEffect } from 'react'
import { useViewStore } from '@/stores/viewStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { BootScreen } from '@/components/boot/BootScreen'
import { AuthPlaceholder, CockpitPlaceholder } from '@/components/boot/PlaceholderScreens'
import { AppShell } from './AppShell'

export function ViewRouter() {
  const view = useViewStore(s => s.view)
  const speed = useSettingsStore(s => s.settings.speedMode)

  useEffect(() => {
    if (view === 'boot' && speed) useViewStore.getState().setView('login')
  }, [view, speed])

  if (view === 'boot' && speed) return <AuthPlaceholder />
  if (view === 'boot' && !speed) return <BootScreen onDone={() => useViewStore.getState().setView('login')} />
  if (view === 'login') return <AuthPlaceholder />   // Task 6 替换为 AuthScreen
  if (view === 'cockpit') return <CockpitPlaceholder />  // Task 8 替换为 CockpitScreen
  return <AppShell /> // work
}
