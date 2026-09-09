// src/components/layout/ViewRouter.tsx —— 顶层视图路由宿主（viewStore 状态机：boot→cockpit→work）
// Task 5：boot/cockpit 两态；work 分支渲染现 WorkShell（Task 9，三段式外壳，取代 AppShell）。
// Task 6：AuthScreen 曾以 login 视图在主窗内渲染；D11-D13（Task 6b）认证移入独立小窗
//         （?auth=1，App.tsx isAuthWindow 分支，不经本组件），主窗口视图机删除 login——
//         boot 只通向 cockpit/work；boot 交棒由 BootScreen onDone → setView('cockpit')。
// settings.speedMode === true 时短路跳过 boot（同帧渲染 cockpit 分支，不挂载 BootScreen），
// 再经 useEffect 把 store 落为 'cockpit'（下次整页重载不再回 boot）。
// Task 8：cockpit 分支替换为真实 CockpitScreen（iframe 容器）；驾驶舱层常驻保活——
//   cockpit↔work 交替时 iframe 不卸载/不重载（active=false 仅 display:none）；
//   过渡 morph 由本组件持有（LogoMorph over everything），hub 点击 → 动画 → enterWork。
// Task 9：work Header logo → cockpit 复用同一 morph 机制——WorkShell 经 onGoCockpit 把
//   Header logo rect 上抛，本组件 playMorph('hub', rect, commit=setView('cockpit')) 完成回切，
//   与 hub→work 的 playMorph('top-left', hubRect, commit) 互为反向；playMorph 自带并发守卫。
import { useCallback, useEffect, useRef, useState } from 'react'
import { useViewStore } from '@/stores/viewStore'
import { useChatStore } from '@/stores/chatStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { THEME_CLASS_NAMES, THEMES } from '@/types'
import { BootScreen } from '@/components/boot/BootScreen'
import { LogoMorph, type MorphTarget } from '@/components/boot/LogoMorph'
import { CockpitScreen } from '@/components/cockpit/CockpitScreen'
import { WorkShell } from './WorkShell'

// 过渡 Logo：与 Header 品牌 logo 同一资源（end-state 视觉一致）
const COCKPIT_LOGO = `${import.meta.env.BASE_URL}logo.png`

interface MorphState {
  to: MorphTarget
  fromRect: DOMRect
  /** 动画完成后的视图落点动作（本任务：enterWork(savedRail)） */
  commit: () => void
}

/** hub 球所在视口矩形：驾驶舱 hub 位于屏幕中心（92px 圆，LogoMorph to==='hub' 同源） */
function hubRect(): DOMRect {
  return new DOMRect(window.innerWidth / 2 - 46, window.innerHeight / 2 - 46, 92, 92)
}

export function ViewRouter() {
  const view = useViewStore(s => s.view)
  const speed = useSettingsStore(s => s.settings.speedMode)
  const settings = useSettingsStore(s => s.settings)

  const [morph, setMorph] = useState<MorphState | null>(null)
  // morph 镜像：事件处理器里读最新态（commit 在 onDone 事件中执行，不写渲染期）
  const morphRef = useRef<MorphState | null>(null)

  useEffect(() => {
    if (view === 'boot' && speed) useViewStore.getState().setView('cockpit')
  }, [view, speed])

  // 主题落盘给主进程：下次启动据此决定透明窗口与否（仅 glass 需真透明）。
  // 独立 effect（仅依赖 theme）：原来混在下方样式 effect 里，fontSize/玻璃/极速
  // 等任一设置变化都会连带触发主进程同步写盘（滑块拖动会连发）。
  // 【自 AppShell 上移（Task 6；AppShell 主体 Task 9 起在 WorkShell）】挂在本宿主
  // 以保证 boot/cockpit 也有主题变量生效。
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

  // 无历史默认新对话（spec D4）：进入 work 且本地无任何会话/无活动会话时，
  // 自动建一个空白 chat 会话（mode='chat'，Task 11 语义），满足"默认新对话"。
  // 持久化现场已有活动会话 → 不动（恢复由 chatStore rehydrate 负责）。
  useEffect(() => {
    if (view !== 'work') return
    const st = useChatStore.getState()
    if (!st.activeConversationId || st.conversations.length === 0) {
      useChatStore.getState().createConversation(undefined, undefined, 'chat')
    }
  }, [view])

  /** LogoMorph 动画完成：执行落点动作并卸载 overlay */
  const finishMorph = useCallback(() => {
    const m = morphRef.current
    morphRef.current = null
    setMorph(null)
    m?.commit()
  }, [])

  /** 统一过渡入口：Task 9（work Header logo → cockpit）也调它 */
  const playMorph = useCallback((to: MorphTarget, fromRect: DOMRect, commit: () => void) => {
    if (morphRef.current) return // 过渡进行中：忽略并发触发
    const m: MorphState = { to, fromRect, commit }
    morphRef.current = m
    setMorph(m)
  }, [])

  /** cockpit hub 点击 → 过渡到工作屏（保留上次 rail） */
  const handleEnterWork = useCallback(() => {
    playMorph('top-left', hubRect(), () => {
      const st = useViewStore.getState()
      st.enterWork(st.workState.rail)
    })
  }, [playMorph])

  /** work Header logo 点击 → 过渡回驾驶舱（Task 9：hub→work 的反向 morph） */
  const handleGoCockpit = useCallback((rect: DOMRect) => {
    playMorph('hub', rect, () => useViewStore.getState().setView('cockpit'))
  }, [playMorph])

  if (view === 'boot' && !speed) return <BootScreen onDone={() => useViewStore.getState().setView('cockpit')} />

  // 到达这里：view ∈ {cockpit, work, boot&&speed}——驾驶舱层常驻，work 时隐藏保活
  const inWork = view === 'work'
  return (
    <>
      {/* 驾驶舱层：boot&&speed 短路首帧即 active；work 期间保活隐藏（iframe 不卸载） */}
      <CockpitScreen active={!inWork} onEnterWork={handleEnterWork} />
      {inWork && <WorkShell onGoCockpit={handleGoCockpit} />}
      {morph && (
        <LogoMorph
          src={COCKPIT_LOGO}
          fromRect={morph.fromRect}
          to={morph.to}
          onDone={finishMorph}
        />
      )}
    </>
  )
}
