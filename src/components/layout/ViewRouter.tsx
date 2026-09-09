// src/components/layout/ViewRouter.tsx —— 顶层视图路由宿主（viewStore 状态机：boot→cockpit→work）
// Task 5：boot/cockpit 两态；work 分支渲染现 AppShell（Task 9 换 WorkShell）。
// Task 6：AuthScreen 曾以 login 视图在主窗内渲染；D11-D13（Task 6b）认证移入独立小窗
//         （?auth=1，App.tsx isAuthWindow 分支，不经本组件），主窗口视图机删除 login——
//         boot 只通向 cockpit/work；boot 交棒由 BootScreen onDone → setView('cockpit')。
// settings.speedMode === true 时短路跳过 boot（同帧渲染 cockpit 分支，不挂载 BootScreen），
// 再经 useEffect 把 store 落为 'cockpit'（下次整页重载不再回 boot）。
import { useEffect } from 'react'
import { useViewStore } from '@/stores/viewStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { THEME_CLASS_NAMES, THEMES } from '@/types'
import { BootScreen } from '@/components/boot/BootScreen'
import { CockpitPlaceholder } from '@/components/boot/PlaceholderScreens'
import { AppShell } from './AppShell'

export function ViewRouter() {
  const view = useViewStore(s => s.view)
  const speed = useSettingsStore(s => s.settings.speedMode)
  const settings = useSettingsStore(s => s.settings)

  useEffect(() => {
    if (view === 'boot' && speed) useViewStore.getState().setView('cockpit')
  }, [view, speed])

  // 主题落盘给主进程：下次启动据此决定透明窗口与否（仅 glass 需真透明）。
  // 独立 effect（仅依赖 theme）：原来混在下方样式 effect 里，fontSize/玻璃/极速
  // 等任一设置变化都会连带触发主进程同步写盘（滑块拖动会连发）。
  // 【自 AppShell 上移（Task 6）】挂在本宿主以保证 boot/cockpit 也有主题变量生效。
  useEffect(() => {
    const themeMode = THEMES.find(t => t.id === settings.theme)?.mode ?? 'dark'
    window.yfworkingWindow?.saveTheme?.(settings.theme, themeMode)
  }, [settings.theme])

  // Theme + chat font
  useEffect(() => {
    const root = document.documentElement
    root.classList.remove(...THEME_CLASS_NAMES)
    root.classList.add(`theme-${settings.theme}`)
    root.style.setProperty('--chat-font', settings.fontSize + 'px')
    // Glass 主题设置：透光度变量 + 色调偏移 + 光晕动画开关（非 glass 主题无效果，不产生副作用）
    root.style.setProperty('--glass-opacity', String(settings.glassOpacity))
    root.style.setProperty('--glass-hue-shift', settings.glassHueShift + 'deg')
    root.classList.toggle('glass-aurora-off', !settings.glassAurora)
    // 极速形态：关闭全部动效/毛玻璃/光晕/阴影（任意主题下生效）
    root.classList.toggle('speed-mode', settings.speedMode)
    // 必须同时覆盖 html 与 body 背景：index.html 的内联防闪白样式
    // 给 html 设置了不透明背景 #171109，body 透明后它会露出并挡住窗口透明合成，
    // 导致桌面无法透出（glass 主题下两处都应透明，其余主题为各自背景色）。
    document.documentElement.style.background = 'var(--bg-app)'
    document.body.style.background = 'var(--bg-app)'
    document.body.style.color = 'var(--text-primary)'
  }, [settings.theme, settings.fontSize, settings.glassOpacity, settings.glassHueShift, settings.glassAurora, settings.speedMode])

  if (view === 'boot' && speed) return <CockpitPlaceholder />  // effect 同步落 'cockpit'（speed 跳加载屏）
  if (view === 'boot' && !speed) return <BootScreen onDone={() => useViewStore.getState().setView('cockpit')} />
  if (view === 'cockpit') return <CockpitPlaceholder />  // Task 8 替换为 CockpitScreen
  return <AppShell /> // work
}
