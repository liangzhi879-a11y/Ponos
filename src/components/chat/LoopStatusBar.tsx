import { useChatStore } from '@/stores/chatStore'
import { useTranslation } from '@/i18n/useTranslation'
import type { LoopEndReason } from '@/types'
import { cn } from '@/lib/utils'

interface Props {
  conversationId: string
}

/** loop 终止原因 → i18n 键（loop end 帧 reason 值域 8 值，语义对照 kernel/loop.mjs
 *  END_REASONS；2026-09-14 loop 运行时补 verify_hit/budget_exceeded/no_progress/failed）。
 *  导出供 LoopPanel 复用（同一个 reason 在状态条是胶囊、在面板是右上角文案——两份
 *  映射必然漂移，只留这一份）。 */
export const REASON_KEY: Record<LoopEndReason, string> = {
  completed: 'loopStatus.reasonCompleted',
  until_hit: 'loopStatus.reasonUntilHit',
  cancelled: 'loopStatus.reasonCancelled',
  judge_error: 'loopStatus.reasonJudgeError',
  verify_hit: 'loopStatus.reasonVerifyHit',
  budget_exceeded: 'loopStatus.reasonBudget',
  no_progress: 'loopStatus.reasonNoProgress',
  failed: 'loopStatus.reasonFailed',
}

/**
 * 多轮 loop 状态条（S5 ②-05 守卫接线）：loopStates[conversationId] active 时显示
 * 轮次进度（≤8 轮渲染点进度，长轮次数值 current/total）+ 目标 until + 最近一次
 * 模型判定 judgeReason（until 循环的 iter 帧 reason 字段）；非 active 不渲染。
 * 挂载于 ChatWindow 消息流下方、输入区上方（RunningAgentsBar 上方一格）。
 * 样式沿用状态胶囊 tokens（bg-elevated/backdrop-blur/brand 描边，与 RunningAgentsBar 一致）。
 */
export function LoopStatusBar({ conversationId }: Props) {
  const loop = useChatStore(s => s.loopStates[conversationId])
  const { t } = useTranslation()

  if (!loop?.active) return null

  const total = Math.max(1, loop.total)
  // index = 已完成轮次（start=0、每轮完成 iter 递增）；正在执行轮 = index+1（封顶 total）
  const current = Math.min(loop.index + 1, total)
  const dots = total <= 8

  return (
    <div className="absolute bottom-0 left-0 right-0 z-20 flex justify-center px-4 pb-[52px] pointer-events-none">
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-auto flex flex-wrap items-center gap-2 max-w-[900px] rounded-full border border-brand-500/30 bg-elevated/90 px-3 py-1.5 shadow-lg backdrop-blur animate-slide-up"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-brand-500 shrink-0 animate-pulse" />
        <span className="text-[11px] font-semibold whitespace-nowrap text-primary">
          {t('loopStatus.round')}
        </span>

        {/* 轮次进度：≤8 轮点进度（已完成实心 + 当前轮呼吸），长轮次数值 current/total */}
        {dots ? (
          <span className="inline-flex items-center gap-1">
            {Array.from({ length: total }, (_, i) => (
              <span
                key={i}
                className={cn(
                  'w-1.5 h-1.5 rounded-full transition-colors',
                  i < loop.index && 'bg-brand-500',
                  i === loop.index && 'bg-brand-500/40 animate-pulse',
                  i > loop.index && 'bg-border',
                )}
              />
            ))}
          </span>
        ) : (
          <span className="text-[11px] font-medium text-secondary tabular-nums whitespace-nowrap">
            {t('loopStatus.progress', { current, total })}
          </span>
        )}

        {/* loop 目标（start/end 帧 goal；无目标循环缺省） */}
        {loop.goal && (
          <span className="text-[10px] text-tertiary whitespace-nowrap max-w-[240px] truncate">
            {t('loopStatus.goal', { goal: loop.goal })}
          </span>
        )}

        {/* 累计成本（iter/end 帧 costUsd；仅 > 0 显示——0 成本既可能是未计量也可能是
            免费模型，显示 $0.0000 只会让人误读为"本轮没花钱"） */}
        {(loop.costUsd ?? 0) > 0 && (
          <span className="text-[10px] text-tertiary tabular-nums whitespace-nowrap">
            {t('loopStatus.cost', { usd: (loop.costUsd ?? 0).toFixed(4) })}
          </span>
        )}

        {/* loop 目标（until 非空时） */}
        {loop.until && (
          <span className="px-2 py-0.5 rounded-full border border-brand-500/30 bg-brand-500/10 text-[10px] font-medium text-brand-500 whitespace-nowrap max-w-[280px] truncate">
            {t('loopStatus.until', { until: loop.until })}
          </span>
        )}

        {/* 最近一次 until 模型判定文本（judged iter 帧 reason） */}
        {loop.judgeReason && (
          <span className="text-[10px] text-tertiary whitespace-nowrap max-w-[240px] truncate">
            {t('loopStatus.judge', { text: loop.judgeReason })}
          </span>
        )}

        {/* 终止原因（end 帧 reason；active 归 false 后本条不再渲染，此处兜底异常时序） */}
        {loop.reason && (
          <span className="px-2 py-0.5 rounded-full border border-amber-500/40 bg-amber-500/10 text-[10px] font-semibold text-amber-500 whitespace-nowrap">
            {t(REASON_KEY[loop.reason])}
          </span>
        )}
      </div>
    </div>
  )
}
