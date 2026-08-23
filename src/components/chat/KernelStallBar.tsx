// src/components/chat/KernelStallBar.tsx
// 内核失速告警条：bridge 失速看门狗（KERNEL_STALL_WARN_MS 静默阈值）发出
// kernel-stall 事件后钉在消息区上方，提示用户内核疑似挂起（AV/驱动阻塞、
// 工具调用半途等），可手动取消或重启会话（--resume 无缝续聊）。
// 后续任何内核输出（event）到达时由 hook 自动清除，无需手动关闭。
// 样式沿用玻璃主题 tokens，与 BrowserStatusBar 一致的胶囊布局。
import { AlertTriangle, X } from 'lucide-react'
import { useUIStore } from '@/stores/uiStore'
import { useChatStore } from '@/stores/chatStore'
import { usePonosCLI } from '@/hooks/usePonosCLI'

interface Props {
  conversationId: string
}

export function KernelStallBar({ conversationId }: Props) {
  const silentMs = useUIStore(s => s.kernelStalls[conversationId])
  const { stop } = usePonosCLI()
  if (typeof silentMs !== 'number') return null

  const silentMin = Math.max(1, Math.round(silentMs / 60000))
  const onCancel = () => {
    useChatStore.getState().stopStreaming(conversationId)
    stop(conversationId)
  }

  return (
    <div className="absolute top-0 left-0 right-0 z-30 flex justify-center px-4 pt-3 pointer-events-none">
      <div className="pointer-events-auto flex items-center gap-2 max-w-[720px] rounded-full border border-error/40 bg-elevated/95 px-3 py-1.5 shadow-lg backdrop-blur animate-slide-down">
        <AlertTriangle className="w-3.5 h-3.5 text-error shrink-0" />
        <span className="text-[11px] font-medium text-primary whitespace-nowrap">
          内核可能失速（已静默 {silentMin} 分钟）— 可取消后重发恢复
        </span>
        <button
          onClick={onCancel}
          className="px-2 py-0.5 rounded-full text-[11px] font-medium text-error hover:bg-error/10 border border-error/30 transition-colors whitespace-nowrap"
        >
          取消任务
        </button>
        <button
          onClick={() => useUIStore.getState().clearKernelStall(conversationId)}
          title="关闭提示"
          aria-label="关闭提示"
          className="inline-flex items-center justify-center w-5 h-5 rounded-full text-tertiary hover:text-secondary hover:bg-elevated border border-transparent hover:border-subtle transition-colors"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    </div>
  )
}
