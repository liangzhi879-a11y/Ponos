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
// 2026-09-10（morph 退役）：驾驶舱 ⇄ 工作屏过渡改为直切（去掉 logo morph 动画——
// 驾驶舱层常驻保活、双视图切换本就无加载成本；morph overlay 反而制造延迟与闪烁）。
// onGoCockpit 回调签名保留 rect 参数（Header 不再需要量 rect，兼容旧接线）。
import { useEffect, useState } from 'react'
import { useViewStore } from '@/stores/viewStore'
import { useChatStore } from '@/stores/chatStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { THEME_CLASS_NAMES, THEMES } from '@/types'
import { BootScreen } from '@/components/boot/BootScreen'
import { CockpitScreen } from '@/components/cockpit/CockpitScreen'
import { WorkShell } from './WorkShell'

export function ViewRouter() {
  const view = useViewStore(s => s.view)
  const speed = useSettingsStore(s => s.settings.speedMode)
  const settings = useSettingsStore(s => s.settings)
  // work 组件树预热开关（见下方空闲预热 effect）
  const [workWarm, setWorkWarm] = useState(false)


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
  // 仅 chat 标签自动建空白会话；task 标签不自动建——任务必须先选工作目录
  // （两种模式是不同的功能设计思路，2026-09-10：任务空态显示 TaskStartCard
  // 目录必选 + 新建任务，不再绕过目录选择直接建会话）。
  // 持久化现场已有活动会话 → 不动（恢复由 chatStore rehydrate 负责）。
  useEffect(() => {
    if (view !== 'work') return
    const st = useChatStore.getState()
    if (!st.activeConversationId || st.conversations.length === 0) {
      const rail = useViewStore.getState().workState.rail
      if (rail === 'chat') st.createConversation(undefined, undefined, 'chat')
    }
  }, [view])

  /** cockpit hub 点击 → 直切工作屏（保留上次 rail；2026-09-10 morph 退役） */
  const handleEnterWork = () => {
    const st = useViewStore.getState()
    st.enterWork(st.workState.rail)
  }

  /** work Header logo 点击 → 直切回驾驶舱（2026-09-10 morph 退役；rect 参数兼容旧接线） */
  const handleGoCockpit = () => {
    useViewStore.getState().setView('cockpit')
  }

  // 【2026-09-11 提速】work 组件树预热：驾驶舱可见后的空闲帧挂载一次 WorkShell（hidden），
  // 把首次切换的同步挂载成本（ChatWindow/assistant-ui/ChatInput 等大树）在后台付掉，
  // 点击进入即为已挂载状态。requestIdleCallback 保证不抢驾驶舱首帧；1.5s 超时兜底。
  useEffect(() => {
    if (view !== 'cockpit') return
    let cancelled = false
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number
      cancelIdleCallback?: (id: number) => void
    }
    let idleId: number | undefined
    let timerId: number | undefined
    const run = () => { if (!cancelled) setWorkWarm(true) }
    if (typeof w.requestIdleCallback === 'function') {
      idleId = w.requestIdleCallback(run, { timeout: 1500 })
    } else {
      timerId = window.setTimeout(run, 600)
    }
    return () => {
      cancelled = true
      if (idleId !== undefined) w.cancelIdleCallback?.(idleId)
      if (timerId !== undefined) window.clearTimeout(timerId)
    }
  }, [view])

  const booting = view === 'boot' && !speed
  const inWork = view === 'work'

  return (
    <>
      {/* 驾驶舱层常驻保活：boot 期即挂载（preload = 保留布局但不可见）→ iframe 在启动屏
          背后提前完成加载与首帧绘制，boot 交棒瞬间即已就绪，消除"启动屏结束后数秒空白"。
          work 期间 display:none 保活（iframe 不卸载，回切零加载成本）。 */}
      <CockpitScreen
        active={!inWork && !booting}
        preload={booting}
        onEnterWork={handleEnterWork}
      />
      {/* work 组件树：始终 absolute inset-0（两态同构，预热→激活零重排），
          仅切可见性——预热期 invisible + pointer-events-none：布局照常计算
          （聊天视口高度/贴底测量准确），但不绘制、不抢驾驶舱点击。 */}
      {(inWork || workWarm) && (
        <div className={inWork ? 'absolute inset-0' : 'absolute inset-0 invisible pointer-events-none'}>
          <WorkShell onGoCockpit={handleGoCockpit} />
        </div>
      )}
      {/* 启动屏叠层：盖在已预热的驾驶舱之上；驾驶舱为 invisible，玻璃主题也不会穿透 */}
      {booting && (
        <div className="fixed inset-0 z-[60]">
          <BootScreen onDone={() => useViewStore.getState().setView('cockpit')} />
        </div>
      )}
    </>
  )
}
