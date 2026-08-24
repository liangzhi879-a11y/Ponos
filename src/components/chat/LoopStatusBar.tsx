import { useChatStore } from '@/stores/chatStore'

/**
 * /loop 连续迭代状态条（消息区上方；无 loop 进行中不占位）
 * 由内核 loop 事件驱动（usePonosCLI.handleMessage → chatStore.loopStates）
 */
export function LoopStatusBar({ conversationId }: { conversationId: string }) {
  const loop = useChatStore(s => s.loopStates[conversationId])

  if (!loop?.active) return null

  const reasonMap: Record<string, string> = {
    completed: '次数耗尽',
    until_hit: '达成目标',
    cancelled: '已取消',
    judge_error: '判定失败',
  }

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 mx-1 mt-1 rounded-lg border border-brand-500/30 bg-brand-500/10 select-none">
      <span className="text-[11px] font-bold tracking-widest text-brand-500">LOOP</span>
      <span className="text-xs text-secondary">
        第 <span className="font-semibold text-primary">{loop.index}</span> / {loop.total} 轮
      </span>
      {loop.until && (
        <span className="text-[11px] text-tertiary truncate max-w-[40%]" title={loop.until}>
          直到「{loop.until}」
        </span>
      )}
      {loop.judgeReason && (
        <span className="text-[11px] text-tertiary truncate max-w-[30%]" title={loop.judgeReason}>
          — {loop.judgeReason}
        </span>
      )}
      {loop.reason && (
        <span className="text-[11px] text-brand-500/80">{reasonMap[loop.reason] || loop.reason}</span>
      )}
      <span className="ml-auto flex gap-0.5">
        {Array.from({ length: Math.min(loop.total, 8) }).map((_, i) => (
          <span
            key={i}
            className={`w-1.5 h-1.5 rounded-full ${i < loop.index ? 'bg-brand-500' : 'bg-subtle'}`}
          />
        ))}
      </span>
    </div>
  )
}
