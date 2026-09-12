import { useHealthStore } from '@/stores/healthStore'
import { distortionOf } from '@/lib/healthUi'

/** 红档时消息区四边呼吸红色光晕（pointer-events-none，不拦截交互）。
 *  颜色用主题令牌 var(--health-tier-red) 派生，避免浅主题下硬编码 rgba 红显得突兀。
 *  **换轴（2026-09-12）**：泛光跟"失真"走，不跟"压力"走——压力红只是"装不下"，
 *  不代表上下文已失准，不该泛红报警；压力档从此只作血条仪表；冷却复用失真卡的
 *  dismiss 键（同一提醒只该有一套冷却）。
 *  conversationId=当前查看的会话：失真判断只针对本会话的健康快照 */
export function HealthGlow({ conversationId }: { conversationId: string }) {
  const health = useHealthStore(s => s.healthBySession[conversationId]) ?? null
  const dismissedUntil = useHealthStore(s => s.dismissedDistortionUntilBySession[conversationId]) ?? 0
  if (distortionOf(health).tier !== 'red' || Date.now() < dismissedUntil) return null
  return (
    <div
      className="pointer-events-none absolute inset-0 z-0 clip-sm animate-pulse"
      style={{
        boxShadow:
          'inset 0 0 24px 4px color-mix(in srgb, var(--health-tier-red) 22%, transparent)',
      }}
    />
  )
}
