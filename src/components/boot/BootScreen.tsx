// src/components/boot/BootScreen.tsx —— 启动品牌动画屏（装饰动画）
// 决策：内部不做 network 等待；~1.6s 定时到点后 onDone() 交棒 ViewRouter。
// settings.speedMode === true 时 ViewRouter 短路不挂载本屏（见 ViewRouter.tsx）。
// 底部阶段小字三个状态 400ms 步进伪推进；结束前由 boot.css 的 .boot-bg 淡出收尾。
import { useEffect, useState } from 'react'
import { useTranslation } from '@/i18n/useTranslation'
import { useSettingsStore } from '@/stores/settingsStore'
import { BOOST_LOGO_LIGHT, BOOST_LOGO_DARK } from '@/lib/assets'

const PHASE_INTERVAL_MS = 400
const BOOT_DURATION_MS = 1600
const PHASE_KEYS = ['boot.phaseBridge', 'boot.phaseEnv', 'boot.phaseReady'] as const

export function BootScreen({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation()
  const theme = useSettingsStore(s => s.settings.theme)
  const darkTheme = theme === 'dark' || theme === 'dark-glass'
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
      {/* 品牌光晕 orb（T9：boot 屏全主题跟随；logo 呼吸光晕沿用 .boot-logo 既有 2.4s 脉冲） */}
      <div className="orb" style={{ width: 340, height: 340, left: -90, top: -70, opacity: 0.8 }} />
      <div className="orb" style={{ width: 300, height: 300, right: -70, bottom: -70, opacity: 0.55 }} />
      <img src={darkTheme ? BOOST_LOGO_LIGHT : BOOST_LOGO_DARK} alt="YFWorking" className="boot-logo" draggable={false} />
      <div className="boot-track">
        <div className="boot-shine" />
      </div>
      <div className="mt-3 micro">{t(PHASE_KEYS[phase])}</div>
    </div>
  )
}
