import { Loader2 } from 'lucide-react'
import { useUIStore } from '@/stores/uiStore'
import { useTranslation } from '@/i18n/useTranslation'

interface Props {
  conversationId: string
}

/**
 * 首字节等待提示条（2026-09-09 长任务挂起事故）：bridge 在轮次活跃但内核静默
 * 5s 后发 system/first_byte_pending，本组件渲染「等待首字节 Xs」胶囊——prefill
 * 阶段（大上下文实测可达数分钟）不再是零反馈。90s 静默后 bridge 升级发
 * kernel-stall（失速告警条接管），本状态被清除，两条不同屏。
 * 挂载于 ChatWindow 顶部状态区（与 KernelStallBar 同槽位；无事件不占位）。
 */
export function FirstBytePendingBar({ conversationId }: Props) {
  const silentMs = useUIStore(s => s.firstByteWait[conversationId])
  const { t } = useTranslation()

  if (typeof silentMs !== 'number' || silentMs <= 0) return null
  const seconds = Math.max(1, Math.round(silentMs / 1000))

  return (
    <div className="absolute top-0 left-0 right-0 z-20 flex justify-center px-4 pt-3 pointer-events-none">
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-auto flex items-center gap-2 max-w-[900px] rounded-full border border-sky-500/30 bg-elevated/90 px-3 py-1.5 shadow-lg backdrop-blur animate-slide-down"
      >
        <Loader2 className="w-3.5 h-3.5 text-sky-500 animate-spin shrink-0" />
        <span className="text-[11px] font-semibold text-sky-500 whitespace-nowrap">
          {t('firstByteWait.title', { secs: seconds })}
        </span>
        <span className="text-[11px] text-tertiary whitespace-nowrap hidden sm:inline">
          {t('firstByteWait.hint')}
        </span>
      </div>
    </div>
  )
}
