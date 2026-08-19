// src/components/chat/HealthMeter.tsx
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/i18n/useTranslation'
import { useHealthStore } from '@/stores/healthStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { meterState, type MeterColor } from '@/lib/healthUi'
import { Tooltip } from '@/components/ui'
import { cn } from '@/lib/utils'

/** 档位填充用主题令牌 var(--health-tier-{color})（themes.css 定义）
 *  彻底扁平：fill 为纯色（var(--health-tier-{color})），不再叠"顶部亮/底部暗"的
 *  立体感渐变（80%白→主题色→72%黑）——后者用户视角就是"内部阴影/凹陷感"。
 *  玻璃主题仅在 .health-meter-glass 外层保留外辉光（0 0 6px + 0 0 18px）作装饰。
 *  字体颜色 var(--health-meter-text) 也按主题设定（浅主题亮字 / 深主题暖白字）。 */
const FILL_GRADIENT: Record<MeterColor, string> = {
  green: 'var(--health-tier-green)',
  amber: 'var(--health-tier-amber)',
  red:   'var(--health-tier-red)',
}
/** 玻璃主题专属辉光：随档位发光 */
const GLOW_COLOR: Record<MeterColor, string> = {
  green: 'color-mix(in srgb, var(--health-tier-green) 68%, transparent)',
  amber: 'color-mix(in srgb, var(--health-tier-amber) 68%, transparent)',
  red:   'color-mix(in srgb, var(--health-tier-red) 68%, transparent)',
}

/** 输入框下方常驻上下文血条（游戏 HP 风格）：宽度=remainingPct，颜色=tier，
 *  血条上覆盖文字显示压缩次数，跳变由 transition 衔接；玻璃主题带霓虹辉光+光泽。
 *  conversationId=当前查看的会话：健康数据按会话隔离存储，多会话并行时只显示本会话 */
export function HealthMeter({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation()
  const health = useHealthStore(s => s.healthBySession[conversationId]) ?? null
  const summaryCompactCount = useHealthStore(s => s.summaryCompactCountBySession[conversationId]) ?? 0
  const theme = useSettingsStore(s => s.settings.theme)
  const isGlass = theme === 'glass' || theme === 'glass-warm'
  const [flash, setFlash] = useState(false)
  const prevCount = useRef(summaryCompactCount)

  // 压缩信号（yfw_summary 先于下一轮 yfw_health 到达）：血条一次性高亮脉冲，宽度随后回涨
  useEffect(() => {
    if (summaryCompactCount > prevCount.current) {
      prevCount.current = summaryCompactCount
      setFlash(true)
      const timer = setTimeout(() => setFlash(false), 1200)
      return () => clearTimeout(timer)
    }
    prevCount.current = summaryCompactCount
  }, [summaryCompactCount])

  const { widthPct, color } = meterState(health)
  // 双源取 max：yfw_health 快照的 compactCount 与 yfw_summary 压缩事件计数都可能
  // 较新（summary 先于下一轮 health 到达；进程重启后 seed 恢复的 health 更新快照）。
  const compactCount = Math.max(health?.compactCount ?? 0, summaryCompactCount)
  const label = health
    ? `${t('health.remainingPct', { pct: health.remainingPct })} · ${t('health.remainingTurns', { turns: health.remainingTurns })}`
    : ''

  return (
    <Tooltip content={label}>
      <div className="absolute left-0 right-0 top-[1.5px] bottom-[1.5px] z-0 flex items-center px-1">
        <div
          className={cn('health-meter', isGlass && 'health-meter-glass')}
          style={{ ['--meter-glow' as string]: GLOW_COLOR[color] }}
        >
          {/* 压缩脉冲挂 fill：scaleX 压扁只作用于填充层（轨道不随之变形） */}
          <div
            className={cn('health-meter-fill', flash && 'health-meter-flash')}
            style={{
              width: `${widthPct}%`,
              background: FILL_GRADIENT[color],
              color: 'var(--health-meter-text)',
            }}
          >
            {compactCount > 0 && <span className="health-meter-text">{t('health.compactCount', { n: compactCount })}</span>}
          </div>
        </div>
      </div>
    </Tooltip>
  )
}
