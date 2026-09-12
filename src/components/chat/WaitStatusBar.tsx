import { useEffect, useRef, useState } from 'react'
import { Loader2, ShieldAlert, MessageCircleQuestion, XCircle, Zap, type LucideIcon } from 'lucide-react'
import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/uiStore'
import { useTranslation } from '@/i18n/useTranslation'
import { cn } from '@/lib/utils'
import { deriveWaitView, secondsOf, type WaitKind } from '@/lib/firstByteUi'

interface Props {
  conversationId: string
}

// 每类等待态的图标与配色，三级可辨（只用主题里确实存在的令牌）：
//   灰（中性）= 内核在正常干活，只是还没出字 → 不该让用户以为出事了
//   琥珀 warning = 在等你（审批/回答）：不动作就永远等下去
//   红 error = 真异常（失速）
// 不用 brand-500 表达"进行中"：本主题 --brand-500 是橙色 #ff7429，与
// --warning-rgb(255 197 61) 同族，肉眼分不开"等模型"和"等你操作"。
// 也不用 info：--info-rgb 虽然定义在 themes.css，但 tailwind.config 没暴露
// `info` 颜色（现有 rail 的 `text-info` 胶囊其实是死类、无色）。
const NEUTRAL = 'border-subtle bg-elevated/60 text-secondary'
const KIND_STYLE: Record<WaitKind, { icon: LucideIcon; className: string; iconClass: string }> = {
  approval: { icon: ShieldAlert, className: 'border-warning/40 bg-warning/10 text-warning', iconClass: '' },
  question: { icon: MessageCircleQuestion, className: 'border-warning/40 bg-warning/10 text-warning', iconClass: '' },
  stall: { icon: XCircle, className: 'border-error/40 bg-error/10 text-error', iconClass: 'animate-pulse' },
  firstByte: { icon: Loader2, className: NEUTRAL, iconClass: 'animate-spin' },
  compact: { icon: Zap, className: NEUTRAL, iconClass: 'animate-pulse' },
}

/**
 * 等待态常显条（T8，2026-09-12「agent 卡在思考界面」事故）
 *
 * 此前等待/失速/告警全部只挂在 RightStatusRail：该栏仅 rail==='task' 挂载
 *（WorkShell.tsx:194）、默认折叠成 36px 图标条、秒数只在 hover tooltip 里
 *（RightStatusRail.tsx:120/218-226），chat 模式零出口 ⇒ 内核静默好几分钟时
 * UI 只能显示静态「思考中…」。本组件内联在消息滚动区与输入区之间（**不悬浮、
 * 不遮挡内容**，与 2026-09-10 收栏所针对的悬浮遮挡问题不同），chat/task 两条
 * 分支都可见；无等待态时返回 null，不占位。
 *
 * 秒数平滑来源见 lib/firstByteUi.ts（桥每 30s 才重发一次，须本地 ticker 补足）。
 */
export function WaitStatusBar({ conversationId }: Props) {
  const { t } = useTranslation()
  // 审批按会话过滤：pendingPermissions 是不分会话的扁平数组（chatStore.ts:343），
  // 不过滤会让 A 会话的审批弹窗在 B 会话也显示「等待授权」
  const approvalCount = useChatStore(s => s.pendingPermissions.filter(p => p.sessionId === conversationId).length)
  const hasQuestion = useChatStore(s => !!s.pendingQuestions[conversationId])
  const compacting = useChatStore(s => s.compactingBySession[conversationId] === true)
  const stallMs = useUIStore(s => s.kernelStalls[conversationId] ?? 0)
  const firstByteMs = useUIStore(s => s.firstByteWait[conversationId] ?? 0)

  const view = deriveWaitView({ approvalCount, hasQuestion, stallMs, firstByteMs, compacting })
  const showSeconds = view?.showSeconds === true
  const sinceMs = view?.sinceMs ?? 0

  // 秒数锚点：store 里的静默毫秒是「桥发帧那一刻」的快照值（每 30s 才变一次），
  // 直接除以 1000 会 30 秒才跳一次。锚定 (快照值, 本地时刻)，由 1s ticker 补足流逝量。
  const anchorRef = useRef<{ sinceMs: number; at: number }>({ sinceMs: 0, at: 0 })
  if (anchorRef.current.sinceMs !== sinceMs) {
    anchorRef.current = { sinceMs, at: Date.now() }
  }
  const [, tick] = useState(0)
  useEffect(() => {
    if (!showSeconds) return
    const id = setInterval(() => tick(n => n + 1), 1000)
    return () => clearInterval(id)
  }, [showSeconds, sinceMs])

  if (!view) return null

  const style = KIND_STYLE[view.kind]
  const Icon = style.icon
  const params = showSeconds
    ? { ...view.i18nParams, secs: secondsOf(sinceMs, Date.now() - anchorRef.current.at) }
    : view.i18nParams
  // 秒数用 tabular-nums 固定字宽，避免逐秒递增时文字左右抖动
  const text = t(view.i18nKey, params)

  return (
    <div
      role="status"
      aria-live="polite"
      data-wait-kind={view.kind}
      className={cn(
        'shrink-0 flex items-center gap-2 px-3 py-1.5 border-t text-[11px] font-medium',
        style.className,
      )}
    >
      <Icon className={cn('w-3.5 h-3.5 shrink-0', style.iconClass)} />
      <span className="truncate tabular-nums">{text}</span>
    </div>
  )
}
