import { useEffect, useRef } from 'react'
import { ExternalLink, Trash2, X } from 'lucide-react'
import { useBrowserStore } from '@/stores/browserStore'
import { useChatStore } from '@/stores/chatStore'
import { useYFWCLI } from '@/hooks/useYFWCLI'
import { useTranslation } from '@/i18n/useTranslation'

interface Props {
  conversationId: string
}

/**
 * 内置浏览器自动化精简状态条：钉在消息区上方（输入框上方），
 * 收到 browser:event 时显示当前操作文本 + 徽标（人工接管中/拟真模式）+
 * 控制按钮（打开窗口 / 暂停·继续 / 清空会话 / 隐藏）。
 * 无事件时返回 null，不占位。样式沿用玻璃主题 tokens（bg-elevated/
 * border-brand-500/30/backdrop-blur，与 RunningAgentsBar 一致）。
 *
 * 任务流式结束自动收起胶囊（见组件内 effect）；隐藏（X）仅收 UI，
 * 不关窗口/不销毁会话，后续 browser:event 自动重现。
 *
 * 暂停/继续控制的是内核 agent 循环（browser_pause/browser_resume），
 * 经 bridge browser_control 通道下发，不触碰执行器。
 */
export function BrowserStatusBar({ conversationId }: Props) {
  const current = useBrowserStore(s => s.current)
  const isStreaming = useChatStore(s => !!s.streamingConversations[conversationId])
  const { browserControl } = useYFWCLI()
  const { t } = useTranslation()

  // 任务流式结束（result 到达）→ 自动收起浏览器状态胶囊：内核任务完成时不会
  // 自动执行 close 动作（窗口/会话需保留登录态），executor 不发 closed 事件，
  // 若不收起胶囊会一直钉在消息区上方。仅在 true→false 转换时触发（手动打开
  // 窗口等非流式场景不会误收）；浏览器会话保留，后续 browser:event 会自动重现。
  const prevStreamingRef = useRef(isStreaming)
  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming && useBrowserStore.getState().current) {
      useBrowserStore.getState().clear()
    }
    prevStreamingRef.current = isStreaming
  }, [isStreaming])

  if (!current) return null

  const onTogglePause = () => browserControl(conversationId, current.humanMode ? 'resume' : 'pause')
  const onOpenWindow = () => window.browser?.openWindow(conversationId)
  const onClearSession = () => {
    if (window.confirm(t('browser.clearConfirm'))) {
      window.browser?.clearSession(conversationId)
    }
  }

  return (
    <div className="absolute top-0 left-0 right-0 z-20 flex justify-center px-4 pt-3 pointer-events-none">
      <div className="pointer-events-auto flex flex-wrap items-center gap-2 max-w-[900px] rounded-full border border-brand-500/30 bg-elevated/90 px-3 py-1.5 shadow-lg backdrop-blur animate-slide-down">
        {/* 动态指示点：正常模式 animate-pulse（玻璃面板动态元素规范） */}
        <span className="w-1.5 h-1.5 rounded-full bg-brand-500 shrink-0 animate-pulse" />
        <span
          className="text-[11px] font-semibold whitespace-nowrap"
          style={{
            background: 'linear-gradient(135deg, var(--brand-500), var(--brand-300))',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}
        >
          {t('browser.currentOperation')}
        </span>
        {current.text && (
          <span className="text-[11px] text-primary truncate max-w-[240px]">{current.text}</span>
        )}
        {current.humanMode && (
          <span className="px-2 py-0.5 rounded-full border border-amber-500/40 bg-amber-500/10 text-[10px] font-semibold text-amber-500 whitespace-nowrap animate-pulse">
            {t('browser.humanMode')}
          </span>
        )}
        {current.imitation && (
          <span className="px-2 py-0.5 rounded-full border border-brand-500/30 bg-brand-500/10 text-[10px] font-semibold text-brand-500 whitespace-nowrap">
            {t('browser.imitationMode')}
          </span>
        )}
        <span className="mx-0.5 w-px h-3.5 bg-border" aria-hidden />
        <button
          onClick={onOpenWindow}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium text-brand-500 hover:bg-brand-500/10 hover:border-brand-500/30 border border-transparent transition-colors whitespace-nowrap"
        >
          <ExternalLink className="w-3 h-3" />
          {t('browser.openWindow')}
        </button>
        <button
          onClick={onTogglePause}
          className="px-2 py-0.5 rounded-full text-[11px] font-medium text-secondary hover:text-primary hover:bg-elevated border border-transparent hover:border-subtle transition-colors whitespace-nowrap"
        >
          {current.humanMode ? t('browser.resume') : t('browser.pause')}
        </button>
        <button
          onClick={onClearSession}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium text-tertiary hover:text-red-400 hover:bg-red-500/10 border border-transparent hover:border-red-500/30 transition-colors whitespace-nowrap"
        >
          <Trash2 className="w-3 h-3" />
          {t('browser.clearSession')}
        </button>
        {/* 手动隐藏状态胶囊（仅收 UI，不关窗口/不销毁会话；后续 browser:event 自动重现） */}
        <button
          onClick={() => useBrowserStore.getState().clear()}
          title={t('browser.dismiss')}
          aria-label={t('browser.dismiss')}
          className="inline-flex items-center justify-center w-5 h-5 rounded-full text-tertiary hover:text-secondary hover:bg-elevated border border-transparent hover:border-subtle transition-colors"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    </div>
  )
}
