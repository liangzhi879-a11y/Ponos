// src/components/cockpit/CockpitScreen.tsx —— 驾驶舱 iframe 容器（Task 8）
// 载荷：Task 7 资产 public/cockpit/index.html（自绘驾驶舱 UI），经 postMessage 双向通信。
// 消息契约（与资产注释逐条对齐，2026-09-10 设计语言统一后升级为全量主题 ID）：
//   父 → iframe：{type:'yfw:theme', theme:'dark'|'light'|'dark-glass',
//                  speedMode:boolean, glassOpacity:number}
//               {type:'yfw:overview', data: overview|null}
//   iframe → 父：{type:'yfw:ready'}（加载完成，listener 已就绪）
//               {type:'yfw:hub-click'}（hub 点击且无面板打开；面板开着点击只收起不上报）
//               {type:'yfw:nav', target}（功能入口：把用户真正带进对应功能，
//                 target 形状与解析规则见 cockpitNav.ts；本组件只做 source 校验，
//                 语义校验全在 resolveCockpitNav（由 ViewRouter 调用）——
//                 这里若再判一次，同一份白名单就有了第二个真相源）
// 时序铁律：iframe 在 listener 注册前会丢弃父消息——theme/overview 一律等收到 yfw:ready
// 才下发；active 重新置真时（保活切回）重推一份最新值，未重载的 iframe 重复收也无害。
// 保活：本组件由 ViewRouter 常驻渲染，active=false 时根容器 display:none 隐藏但不卸载，
// 因此 cockpit↔work 交替期间 iframe 不重载、无闪白；theme 变化只走 postMessage，
// src 在首次挂载时定型（把 theme 写进 query 后不可再变，否则 React 会因 src 变化重载 iframe）。
import { useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '@/stores/settingsStore'
import { useCockpitOverview, type CockpitOverviewData } from './useCockpitOverview'

export interface CockpitScreenProps {
  /** 视图当前是否正展示驾驶舱；false = 保活隐藏（不卸载 iframe） */
  active: boolean
  /**
   * 预热态（2026-09-11 空白期修复）：boot 启动屏期间挂载 iframe 提前加载/绘帧。
   * 与 active=false 的区别——预热态用 visibility:hidden（保留布局，iframe 视口非 0，
   * 驾驶舱 canvas 首次 layout 即为正确尺寸并在屏后完成首帧绘制），而 active=false
   * 用 display:none（work 期间保活，回切时靠 resize 重排）。二者都不卸载 iframe。
   */
  preload?: boolean
  /** hub 点击（且无面板开启）→ 通知 ViewRouter 播放 LogoMorph 并进入工作屏 */
  onEnterWork: () => void
  /**
   * 驾驶舱功能入口（2026-09-15）：iframe 点模块 → 上抛原始载荷，由宿主解析并导航。
   * 传**原始载荷**而非解析结果：校验规则（白名单/不变量）只保留在宿主一处。
   */
  onNavigate?: (raw: unknown) => void
}

export function CockpitScreen({ active, preload = false, onEnterWork, onNavigate }: CockpitScreenProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // src 仅挂载时定型：首帧主题经 query 直给全量主题 ID（资产 head 即解析，避免就绪前底色错）
  const [src] = useState(() => {
    const mountTheme = useSettingsStore.getState().settings.theme
    return `${import.meta.env.BASE_URL}cockpit/index.html?theme=${mountTheme}`
  })

  const theme = useSettingsStore(s => s.settings.theme)
  const speed = useSettingsStore(s => s.settings.speedMode)
  const glassOpacity = useSettingsStore(s => s.settings.glassOpacity)
  const overview = useCockpitOverview()

  // ready 状态：收到 yfw:ready 前不下发任何消息（资产侧丢弃早到消息）
  const [ready, setReady] = useState(false)
  // 监听器常驻（空依赖），最新 prop 走 ref 镜像，避免反复重绑
  const activeRef = useRef(active)
  activeRef.current = active
  const onEnterWorkRef = useRef(onEnterWork)
  onEnterWorkRef.current = onEnterWork
  const onNavigateRef = useRef(onNavigate)
  onNavigateRef.current = onNavigate

  // 主题/极速/玻璃透光度：ready 即推（保活隐藏期间也保持最新，回切驾驶舱不闪主题色）
  useEffect(() => {
    if (!ready) return
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'yfw:theme', theme, speedMode: speed, glassOpacity },
      '*',
    )
  }, [ready, theme, speed, glassOpacity])

  // overview：ready 且 active 时下发；数据刷新/active 翻转（保活切回）都会重推
  useEffect(() => {
    if (!ready || !active) return
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'yfw:overview', data: overview as CockpitOverviewData | null },
      '*',
    )
  }, [ready, active, overview])

  // iframe → 父：仅接受来自本 iframe 的消息（忽略认证小窗等其他 source）
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return
      const raw = (e.data ?? {}) as { type?: unknown }
      const type = typeof raw?.type === 'string' ? raw.type : ''
      if (type === 'yfw:ready') {
        setReady(true)
        return
      }
      if (type === 'yfw:hub-click' && activeRef.current) {
        onEnterWorkRef.current()
        return
      }
      // 功能入口：仅 active 期受理（预热/保活隐藏期的消息不该改变用户所在视图）
      if (type === 'yfw:nav' && activeRef.current) {
        onNavigateRef.current?.(raw)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // 三态容器类：active=可见；preload=布局保留但不可见（boot 期预热）；
  // 其余=display:none 保活（work 期，iframe 不卸载）
  const shellClass = active
    ? 'h-full w-full relative bg-app'
    : preload
      ? 'h-full w-full relative invisible'
      : 'hidden'

  return (
    <div className={shellClass} aria-hidden={!active}>
      <iframe
        ref={iframeRef}
        title="Cockpit"
        src={src}
        className="block w-full h-full border-0"
        tabIndex={-1}
      />
    </div>
  )
}
