import { AlertTriangle, X } from 'lucide-react'
import { useUIStore } from '@/stores/uiStore'
import { useChatStore } from '@/stores/chatStore'
import { useBrowserStore } from '@/stores/browserStore'
import { useYFWCLI } from '@/hooks/useYFWCLI'
import { useTranslation } from '@/i18n/useTranslation'

interface Props {
  conversationId: string
}

/**
 * 内核失速守卫条（S5 ②-05）：bridge 失速看门狗（默认 10min 无内核 stdout）发顶层
 * kernel-stall 后出现，提示「内核静默 Xs，可能失速」，提供取消与关闭。
 * - 取消：双调（pd 语义）—— stopStreaming 清流式状态 + hook stop 发 cancel 给内核
 *   （bridge 杀进程后 cancelled 到达 → 守卫条随会话态一并清除）；
 * - 关闭：仅收 UI（clearKernelStall）。任何内核输出到达都会自愈清除（见 useYFWCLI
 *   handleMessage），通常无需手动关闭。
 * 挂载于 ChatWindow 顶部状态区（与 BrowserStatusBar 同为悬浮胶囊；后者存在时下移避让）。
 */
export function KernelStallBar({ conversationId }: Props) {
  const silentMs = useUIStore(s => s.kernelStalls[conversationId])
  // 顶部另一枚悬浮胶囊（浏览器自动化状态条）占据 pt-3 槽位 → 本条整体下移一格，避免叠字
  const browserPillVisible = useBrowserStore(s => !!s.current)
  const { stop } = useYFWCLI()
  const { t } = useTranslation()

  if (typeof silentMs !== 'number') return null
  const seconds = Math.max(1, Math.round(silentMs / 1000))

  const onCancel = () => {
    // 双调：先清 GUI 流式状态，再经 hook stop 发 cancel（cancel 会 kill 内核进程，
    // 随后 cancelled 到达自动收起本条并清理 loop/任务态）
    useChatStore.getState().stopStreaming(conversationId)
    stop(conversationId)
  }

  const onClose = () => {
    useUIStore.getState().clearKernelStall(conversationId)
  }

  return (
    <div
      className={`absolute top-0 left-0 right-0 z-30 flex justify-center px-4 pointer-events-none ${browserPillVisible ? 'pt-14' : 'pt-3'}`}
    >
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-auto flex items-center gap-2 max-w-[900px] rounded-full border border-amber-500/40 bg-elevated/90 px-3 py-1.5 shadow-lg backdrop-blur animate-slide-down"
      >
        <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
        <span className="text-[11px] font-semibold text-amber-500 whitespace-nowrap">
          {t('kernelStall.title', { secs: seconds })}
        </span>
        <span className="mx-0.5 w-px h-3.5 bg-border" aria-hidden />
        <button
          onClick={onCancel}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium text-amber-500 hover:bg-amber-500/10 hover:border-amber-500/30 border border-transparent transition-colors whitespace-nowrap"
        >
          {t('kernelStall.cancel')}
        </button>
        <button
          onClick={onClose}
          title={t('kernelStall.dismiss')}
          aria-label={t('kernelStall.dismiss')}
          className="inline-flex items-center justify-center w-5 h-5 rounded-full text-tertiary hover:text-secondary hover:bg-elevated border border-transparent hover:border-subtle transition-colors"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    </div>
  )
}
