import { useChatStore } from '@/stores/chatStore'
import { useTranslation } from '@/i18n/useTranslation'

interface Props {
  conversationId: string
}

/**
 * 压缩进行中指示条（S5 ②-02 压缩可见化）：compactingBySession[conversationId] === true
 * 时渲染「正在压缩上下文…」状态胶囊 + 轻量 spinner；done/error（或取消/关闭复位）后
 * 归约置 false 即消失，压缩期外不渲染不占位。
 * 与 CompressedToast（压缩完成 toast，走 yfw_summary/healthStore）互补不冲突：
 * 本条管"进行中"，toast 管"已完成"。
 * 挂载于 ChatWindow 底部状态族（RunningAgentsBar pb-3 → LoopStatusBar pb-[52px] →
 * 本条 pb-[88px]），与 loop 胶囊上下错开避免同屏叠字。
 * 样式沿用状态胶囊 tokens（bg-elevated/backdrop-blur/brand 描边，同 RunningAgentsBar/LoopStatusBar）。
 */
export function CompactingBar({ conversationId }: Props) {
  const compacting = useChatStore(s => s.compactingBySession[conversationId] === true)
  const { t } = useTranslation()

  if (!compacting) return null

  return (
    <div className="absolute bottom-0 left-0 right-0 z-20 flex justify-center px-4 pb-[88px] pointer-events-none">
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-auto flex items-center gap-2 max-w-[900px] rounded-full border border-brand-500/30 bg-elevated/90 px-3 py-1.5 shadow-lg backdrop-blur animate-slide-up"
      >
        {/* 轻量 spinner（CSS 边框旋转，与空态加载占位同款；不依赖图标字体命名） */}
        <span className="w-3.5 h-3.5 rounded-full border-2 border-subtle border-t-brand-500 animate-spin shrink-0" />
        <span className="text-[11px] font-semibold whitespace-nowrap text-primary">
          {t('compacting.title')}
        </span>
        <span className="text-[10px] text-tertiary whitespace-nowrap max-w-[280px] truncate hidden sm:inline">
          {t('compacting.hint')}
        </span>
      </div>
    </div>
  )
}
