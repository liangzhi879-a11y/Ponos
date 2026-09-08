// src/components/boot/LogoMorph.tsx —— logo 过渡原语（驾驶舱 ⇄ 工作界面，task-5 Step 2）
// 用法：<LogoMorph src={logo} fromRect={source.getBoundingClientRect()} to="hub" onDone={...} />
// 调用方在过渡开始前从源 logo 元素（boot 屏 / hub 球 / Header logo）取 rect；组件把同一 logo
// 复制到 body 级 fixed overlay（z-[120], pointer-events-none），从 fromRect tween 到目标位：
//   · to==='top-left' → Header 左上 logo 位（query 实际元素；未挂载时兜底 48px 角标位）
//   · to==='hub'      → 屏幕中心 92px hub 球位
// 中段附加 brightness(1.6) 泛光；~420ms 动画完成后回调 onDone（由调用方切 view 并卸载 overlay）。
// 注：本原语为纯 DOM 组件，Task 8 接入驾驶舱后才产生调用点。
import { useMemo } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'

export type MorphTarget = 'top-left' | 'hub'

interface LogoMorphProps {
  src: string
  fromRect: DOMRect
  to: MorphTarget
  onDone: () => void
}

interface MorphRect {
  left: number
  top: number
  width: number
  height: number
}

const DURATION = 0.42 // s
const EASE = [0.22, 1, 0.36, 1] as [number, number, number, number]

/** 兜底角标位：Header 品牌 logo 未挂载时的近似落点（px，相对视口） */
const TOP_LEFT_FALLBACK: MorphRect = { left: 12, top: 8, width: 48, height: 48 }

function resolveTarget(to: MorphTarget, vw: number, vh: number): MorphRect {
  if (to === 'hub') {
    return { left: vw / 2 - 46, top: vh / 2 - 46, width: 92, height: 92 }
  }
  // 目标 = 工作屏 Header 左上 logo（AppShell 已挂载在 overlay 之下时精确命中其真实 rect）
  const el = typeof document !== 'undefined'
    ? document.querySelector<HTMLElement>('header img[alt="YFWorking"]')
    : null
  if (el) {
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  }
  return TOP_LEFT_FALLBACK
}

export function LogoMorph({ src, fromRect, to, onDone }: LogoMorphProps) {
  const target = useMemo(() => {
    if (typeof window === 'undefined') return TOP_LEFT_FALLBACK
    return resolveTarget(to, window.innerWidth, window.innerHeight)
  }, [to])

  if (typeof document === 'undefined') return null

  return createPortal(
    <div className="fixed inset-0 z-[120] pointer-events-none" aria-hidden="true">
      <motion.img
        src={src}
        alt=""
        draggable={false}
        className="absolute object-contain"
        initial={{
          left: fromRect.left,
          top: fromRect.top,
          width: fromRect.width,
          height: fromRect.height,
          opacity: 1,
          filter: 'brightness(1)',
        }}
        animate={{
          left: target.left,
          top: target.top,
          width: target.width,
          height: target.height,
          opacity: [1, 1, 0],
          filter: ['brightness(1)', 'brightness(1.6)', 'brightness(1)'],
        }}
        transition={{ duration: DURATION, ease: EASE }}
        onAnimationComplete={() => onDone()}
      />
    </div>,
    document.body,
  )
}
