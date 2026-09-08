// src/components/boot/BootScreen.tsx —— 启动品牌动画屏（装饰动画）
// 决策：内部不做 network 等待；~1.6s 定时到点后 onDone() 交棒 ViewRouter。
// settings.speedMode === true 时 ViewRouter 短路不挂载本屏（见 ViewRouter.tsx）。
// 底部阶段小字三个状态 400ms 步进伪推进；结束前由 boot.css 的 .boot-bg 淡出收尾。
import { useEffect, useState } from 'react'
import { useTranslation } from '@/i18n/useTranslation'
import { BOOST_LOGO_LIGHT } from '@/lib/assets'

const PHASE_INTERVAL_MS = 400
const BOOT_DURATION_MS = 1600
const PHASE_KEYS = ['boot.phaseBridge', 'boot.phaseEnv', 'boot.phaseReady'] as const

export function BootScreen({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation()
  const [phase, setPhase] = useState(0)

  useEffect(() => {
    const iv = window.setInterval(() => {
      setPhase(p => (p < PHASE_KEYS.length - 1 ? p + 1 : p))
    }, PHASE_INTERVAL_MS)
    const done = window.setTimeout(onDone, BOOT_DURATION_MS)
    return () => {
      window.clearInterval(iv)
      window.clearTimeout(done)
    }
  }, [onDone])

  return (
    <div className="h-full w-full flex flex-col items-center justify-center relative overflow-hidden boot-bg">
      <img src={BOOST_LOGO_LIGHT} alt="YFWorking" className="boot-logo" draggable={false} />
      <div className="boot-track">
        <div className="boot-shine" />
      </div>
      <div className="mt-3 text-xs boot-phase">{t(PHASE_KEYS[phase])}</div>
    </div>
  )
}
