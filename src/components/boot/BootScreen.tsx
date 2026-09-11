// src/components/boot/BootScreen.tsx —— 启动品牌屏（2026-09-11 真实预热化）
// 不再做装饰性伪推进：主进程轮询 bridge /boot-status，把真实模块就绪事件
// （桥接服务 → 内核自举 → 技能/工作流安装 → 供应商实测探测）经 boot:progress
// 推给本屏逐项打勾；全部就绪（boot:ready）才 onDone 交棒——进入驾驶舱/主界面时
// 预热已完成，无"进来才卡"的冷启动体感。15s 硬兜底防任何环节挂起卡死启动屏。
// 预热期间同时预连 WS（useYFWCLI 模块级单例，连接在 boot 后持续复用）。
import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { useTranslation } from '@/i18n/useTranslation'
import { useSettingsStore } from '@/stores/settingsStore'
import { useYFWCLI } from '@/hooks/useYFWCLI'
import { BOOST_LOGO_LIGHT, BOOST_LOGO_DARK } from '@/lib/assets'

const BOOT_HARD_TIMEOUT_MS = 15_000
// 真实预热步骤（与 bridge bootState 一一对应；i18n 键 boot.step*）
const BOOT_STEPS = ['bridge', 'kernel', 'skills', 'provider'] as const
type StepId = (typeof BOOT_STEPS)[number]

interface BootProgressEvent { step: string; done: boolean }

export function BootScreen({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation()
  const theme = useSettingsStore(s => s.settings.theme)
  const darkTheme = theme === 'dark' || theme === 'dark-glass'
  const [doneSteps, setDoneSteps] = useState<Record<string, boolean>>({})
  const [ready, setReady] = useState(false)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  // 预热：预连 WS（模块级单例——boot 后进主界面直接复用，首条消息零连接等待）
  useYFWCLI()

  useEffect(() => {
    let off: (() => void) | undefined
    const win = window as unknown as { yfwBoot?: { onProgress?: (cb: (d: BootProgressEvent) => void) => () => void } }
    try {
      off = win.yfwBoot?.onProgress?.((d: BootProgressEvent) => {
        if (d?.done && typeof d.step === 'string') {
          setDoneSteps(prev => ({ ...prev, [d.step]: true }))
          if (d.step === 'ready') setReady(true)
        }
      })
    } catch { /* preload 未就绪（旧壳）→ 走硬兜底 */ }

    // 硬兜底：任何环节挂起也绝不卡死启动屏（15s 后交棒；预热完成则提前交棒）
    const fallback = window.setTimeout(() => onDoneRef.current(), BOOT_HARD_TIMEOUT_MS)
    return () => {
      off?.()
      window.clearTimeout(fallback)
    }
  }, [])

  useEffect(() => {
    if (ready) onDoneRef.current()
  }, [ready])

  const allDone = BOOT_STEPS.every(s => doneSteps[s])
  const currentStep = BOOT_STEPS.find(s => !doneSteps[s]) ?? 'provider'

  return (
    <div className="h-full w-full flex flex-col items-center justify-center relative overflow-hidden boot-bg">
      {/* 品牌光晕 orb（T9：boot 屏全主题跟随；logo 呼吸光晕沿用 .boot-logo 既有 2.4s 脉冲） */}
      <div className="orb" style={{ width: 340, height: 340, left: -90, top: -70, opacity: 0.8 }} />
      <div className="orb" style={{ width: 300, height: 300, right: -70, bottom: -70, opacity: 0.55 }} />
      <img src={darkTheme ? BOOST_LOGO_LIGHT : BOOST_LOGO_DARK} alt="YFWorking" className="boot-logo" draggable={false} />
      <div className="boot-track">
        <div className="boot-shine" />
      </div>

      {/* 真实预热步骤清单（2026-09-11）：每项 = 一个真实模块的就绪事件 */}
      <div className="mt-4 w-56 space-y-1.5">
        {BOOT_STEPS.map((s) => {
          const done = !!doneSteps[s]
          const isCurrent = s === currentStep && !done
          return (
            <div
              key={s}
              className="flex items-center gap-2 px-2 py-1 rounded-md text-[11px] transition-opacity duration-300"
              style={{ opacity: done ? 0.75 : 1 }}
            >
              {done ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0" />
              ) : isCurrent ? (
                <Loader2 className="w-3.5 h-3.5 text-brand-500 animate-spin shrink-0" />
              ) : (
                <span className="w-3.5 h-3.5 rounded-full border border-subtle shrink-0" />
              )}
              <span className={done ? 'text-tertiary' : 'text-secondary'}>{t(`boot.step${s[0].toUpperCase()}${s.slice(1)}` as never)}</span>
            </div>
          )
        })}
      </div>

      <div className="mt-2 micro text-tertiary">
        {allDone ? t('boot.ready') : t('boot.warming', { step: t(`boot.step${currentStep[0].toUpperCase()}${currentStep.slice(1)}` as never) })}
      </div>
    </div>
  )
}
