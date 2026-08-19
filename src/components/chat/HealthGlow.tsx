import { useHealthStore } from '@/stores/healthStore'
import { shouldShowRedAlert } from '@/lib/healthUi'

/** 红档时消息区四边呼吸红色光晕（pointer-events-none，不拦截交互）。
 *  颜色用主题令牌 var(--health-tier-red) 派生，避免浅主题下硬编码 rgba 红显得突兀。
 *  conversationId=当前查看的会话：红档判断只针对本会话的健康快照 */
export function HealthGlow({ conversationId }: { conversationId: string }) {
  const health = useHealthStore(s => s.healthBySession[conversationId]) ?? null
  const dismissedUntil = useHealthStore(s => s.dismissedUntilBySession[conversationId]) ?? 0
  if (!shouldShowRedAlert(health, dismissedUntil)) return null
  return (
    <div
      className="pointer-events-none absolute inset-0 z-0 rounded-lg animate-pulse"
      style={{
        boxShadow:
          'inset 0 0 24px 4px color-mix(in srgb, var(--health-tier-red) 22%, transparent)',
      }}
    />
  )
}
