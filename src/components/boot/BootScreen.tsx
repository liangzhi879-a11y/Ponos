import { useEffect, useState } from 'react'
import { useViewStore } from '@/stores/viewStore'
import { usePonosCLI } from '@/hooks/usePonosCLI'
import { useTranslation } from '@/i18n/useTranslation'

const STEPS = ['boot.initKernel', 'boot.loadConfig', 'boot.connectModel', 'boot.ready'] as const

export function BootScreen() {
  const { t } = useTranslation()
  const bootDone = useViewStore(s => s.bootDone)
  const { connected } = usePonosCLI()
  const [step, setStep] = useState(0)

  useEffect(() => {
    // 连接成功 → 直接完成；否则每 900ms 推进一步，4 步后完成（4s 兜底）
    if (connected) { bootDone(); return }
    const timer = setInterval(() => {
      setStep(prev => {
        if (prev >= STEPS.length - 1) { clearInterval(timer); bootDone(); return prev }
        return prev + 1
      })
    }, 900)
    return () => clearInterval(timer)
  }, [connected, bootDone])

  return (
    <div className="h-full w-full flex flex-col items-center justify-center bg-app relative overflow-hidden"
      style={{ backgroundImage: 'var(--shadow-bg-image)', backgroundSize: 'cover', backgroundPosition: 'center' }}>
      <div className="absolute inset-0 bg-app/70" />
      <div className="relative flex flex-col items-center gap-6">
        {/* 漩涡 P Logo 呼吸动画 */}
        <div className="w-24 h-24 rounded-full overflow-hidden ring-2 ring-brand-500/60 shadow-[0_0_40px_rgba(255,45,148,0.5)] animate-pulse">
          <img src="/shadow-theme/icon-vortex.png" alt="Ponos" className="w-full h-full object-cover" />
        </div>
        <div className="text-center">
          <div className="font-display font-bold tracking-[0.3em] text-2xl text-primary select-none">PONOS</div>
          <div className="text-xs text-tertiary mt-2 tracking-wider">{t('login.tagline')}</div>
        </div>
        {/* 步骤指示 */}
        <div className="flex items-center gap-3">
          {STEPS.map((key, i) => (
            <div key={key} className="flex items-center gap-3">
              <span className={i <= step ? 'text-accent-cyan text-xs' : 'text-tertiary/50 text-xs'}>
                {i < step ? '✓' : i === step ? '●' : '○'} {t(key)}
              </span>
              {i < STEPS.length - 1 && <span className="w-6 h-px bg-border-subtle" />}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
