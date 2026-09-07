// src/components/chat/CompressedToast.tsx
// 压缩提醒：右下角轻量 toast，2.4s 自动消失，不占据整个下方。
// 触发：summaryCompactCountBySession[conversationId] 增长（内核 yfw_summary）。
// 与血条 HealthMeter 的"一次性脉冲"形成"短文本反馈"，互不冲突。
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/i18n/useTranslation'
import { useHealthStore } from '@/stores/healthStore'
import { Minimize2 } from 'lucide-react'

const VISIBLE_MS = 2400

export function CompressedToast({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation()
  const compactCount = useHealthStore(s => s.summaryCompactCountBySession[conversationId]) ?? 0
  const prev = useRef(compactCount)
  const [visible, setVisible] = useState(false)
  const [shown, setShown] = useState(compactCount)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    if (compactCount > prev.current) {
      prev.current = compactCount
      setShown(compactCount)
      setVisible(true)
      if (timer.current) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setVisible(false), VISIBLE_MS)
    } else {
      prev.current = compactCount
    }
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [compactCount])

  if (!visible) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 pointer-events-none animate-slide-up"
    >
      <div
        className="flex items-center gap-2 rounded-xl border bg-popover/95 px-3 py-2 shadow-2xl backdrop-blur-xl"
        style={{
          borderColor: 'color-mix(in srgb, var(--brand-500) 28%, transparent)',
        }}
      >
        <Minimize2 className="w-3.5 h-3.5" style={{ color: 'var(--brand-500)' }} />
        <span className="text-xs font-medium text-primary">
          {t('health.toastCompressed', { n: shown })}
        </span>
      </div>
    </div>
  )
}