import { useEffect, useRef, useState, useCallback } from 'react'
import { ArrowDown, FolderOpen, Code2, FileSearch, Table2, ShieldCheck, Gauge, Puzzle } from 'lucide-react'
import { Button } from '@/components/ui'
import { ScrollArea } from '@/components/ui'
import { MessageBubble } from './MessageBubble'
import { DirectoryPicker } from './DirectoryPicker'
import { RunningAgentsBar } from './RunningAgentsBar'
import { HealthGlow } from './HealthGlow'
import { CompressedToast } from './CompressedToast'
import { KernelStallBar } from './KernelStallBar'
import { LoopStatusBar } from './LoopStatusBar'
import { BrowserStatusBar } from '@/components/browser/BrowserStatusBar'
import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/uiStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useTranslation } from '@/i18n/useTranslation'
import { cn } from '@/lib/utils'
import { getDefaultHome } from '@/lib/config'
import { getAgentById } from '@/lib/agents'
import { useAgentStore } from '@/stores/agentStore'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import type { ContentBlock } from '@/types'
import { useVirtualizer } from '@tanstack/react-virtual'

interface Props {
  conversationId: string
}

const SUGGESTION_ICONS = [FileSearch, Table2, ShieldCheck, Gauge, Code2, Puzzle]

export function ChatWindow({ conversationId }: Props) {
  // 选择器订阅（非整 store）：流式风暴下每事件 set() 只重建 conversations 等受影响
  // 切片，避免 pendingPermissions/backgroundTasks 等无关字段变化连带重渲染本组件。
  const conversations = useChatStore(s => s.conversations)
  const streamingConversations = useChatStore(s => s.streamingConversations)
  const retryMessage = useChatStore(s => s.retryMessage)
  const editMessage = useChatStore(s => s.editMessage)
  const { setPendingInput } = useUIStore()
  const { settings } = useSettingsStore()
  const { t } = useTranslation()
  const subAgentTasks = useChatStore(s => s.subAgentTasks[conversationId])
  // v2 按需加载：切换会话时消息异步从内核 transcript 拉取，加载中显示轻量占位而非空态
  const conversationLoading = useChatStore(s => !!s.conversationLoading[conversationId])
  // 响应式订阅 agents：修改头像后徽章即时更新
  const allAgents = useAgentStore(s => s.agents)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [selectedSuggestion, setSelectedSuggestion] = useState<string | null>(null)
  const [highlightId, setHighlightId] = useState<string | null>(null)

  const conversation = conversations.find(c => c.id === conversationId)
  const messages = conversation?.messages || []
  const isEmpty = messages.length === 0
  // 加载中但历史非空（索引里 messageCount>0）：显示占位，不闪"新对话"空态
  const loadingWithHistory = conversationLoading && isEmpty && (conversation?.messageCount ?? 0) > 0
  const [showDirPicker, setShowDirPicker] = useState(false)

  // Virtualized message list: only the visible window is rendered inside the
  // radix ScrollArea viewport (the real scroll container), so a 10k-message
  // conversation no longer forces a full `messages.map` DOM tree.
  const virtualizer = useVirtualizer({
    count: messages.length,
    // Re-query on every call so the viewport is picked up after mount (refs are
    // attached before this layout effect runs); a captured render-time value
    // would be null on the first pass and never observe the scroller.
    getScrollElement: () =>
      (scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null) ?? null,
    estimateSize: () => 96, // lower bound for dynamic content; corrected by measureElement
    overscan: 6,
    getItemKey: (index) => messages[index]?.id ?? index,
  })
  // Latest values for the once-registered search listener (HistoryView event).
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const virtualizerRef = useRef(virtualizer)
  virtualizerRef.current = virtualizer

  const welcomeSuggestions = SUGGESTION_ICONS.map((Icon, i) => ({
    icon: Icon,
    text: t(`chat.suggestion${i + 1}` as const),
  }))

  // Smart auto-scroll: only follow when the user is pinned to the bottom.
  // Once the user scrolls up to read history, stop forcing — the "scroll to
  // bottom" button appears and they can re-engage by clicking it (which also
  // re-pins).  A new message arriving (new turn) also re-pins automatically.
  const isPinnedRef = useRef(true)
  const prevMessageCountRef = useRef(messages.length)
  const convIdRef = useRef(conversationId)
  const sigRef = useRef('')
  const subTasksRef = useRef(subAgentTasks)

  // Track whether the user is pinned to the bottom via scroll events.
  // Must use a ref (not state) so the effect below reads the live value
  // synchronously — setState is batched and would be stale inside the effect.
  const handleScrollWithPin = useCallback(() => {
    const el = scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null
    if (!el) return
    const { scrollTop, scrollHeight, clientHeight } = el
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight
    isPinnedRef.current = distanceFromBottom < 50
    setShowScrollButton(distanceFromBottom > 100)
  }, [])

  // Signature of THIS conversation's visible content. Other conversations
  // streaming updates produce a new `messages` array reference without
  // changing this signature — so we don't yank the user's scroll position
  // while they're reading a different conversation.
  const lastMsg = messages[messages.length - 1]
  const lastBlocks = lastMsg?.content as ContentBlock[] | undefined
  const lastTextLen = lastBlocks?.[lastBlocks.length - 1]?.content?.length ?? 0
  const signature = `${messages.length}:${lastMsg?.id || ''}:${lastBlocks?.length ?? 0}:${lastTextLen}`

  // 贴底定位：虚拟列表真实高度随 measureElement 逐项测量后增长（初始按
  // estimateSize 96px 估算）。若只用 scrollToIndex 按估算值定位一次，测量撑高
  // 列表后视口会停在历史中间（用户反馈"定位在不知道哪个中间的对话"）。
  // 改为直接读真实 scrollHeight 贴底，并用 rAF 多轮追赶直到高度稳定，
  // 保证冷启动/切换会话/新消息时最终都落在真实底部（最新消息贴视口底边）。
  const settleToBottom = useCallback(() => {
    if (messages.length === 0) return
    let prev = -1
    let guard = 0
    const tick = () => {
      if (++guard > 30) return
      const el = scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null
      if (!el) {
        requestAnimationFrame(tick)
        return
      }
      if (el.scrollHeight !== prev) {
        prev = el.scrollHeight
        el.scrollTop = el.scrollHeight - el.clientHeight
      }
      requestAnimationFrame(tick)
    }
    tick()
  }, [messages.length])

  useEffect(() => {
    const el = scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null
    if (!el) return

    const convChanged = convIdRef.current !== conversationId
    convIdRef.current = conversationId

    // New message arrives: re-pin so the user sees the assistant's first reply
    const isNewMessageTurn = messages.length > prevMessageCountRef.current
    prevMessageCountRef.current = messages.length
    if (isNewMessageTurn) {
      isPinnedRef.current = true
    }

    const subTasksChanged = subAgentTasks !== subTasksRef.current
    subTasksRef.current = subAgentTasks
    const contentChanged = convChanged || signature !== sigRef.current || subTasksChanged
    sigRef.current = signature
    if (!contentChanged) return

    // Switching conversation: jump to the bottom of the freshly rendered one
    if (convChanged) {
      isPinnedRef.current = true
      settleToBottom()
      return
    }

    // Only auto-scroll when pinned to the bottom
    if (settings.autoScroll && isPinnedRef.current) {
      settleToBottom()
    }
  }, [signature, messages.length, conversationId, settings.autoScroll, subAgentTasks, virtualizer, settleToBottom])

  // Scroll to message id triggered from HistoryView
  useEffect(() => {
    const handler = () => {
      const id = (window as any).__scrollToMessageId
      if (!id) return
      delete (window as any).__scrollToMessageId
      // Virtualized: locate by index (the target may not be rendered yet),
      // scroll it into the viewport center, then flash a highlight.
      const index = messagesRef.current.findIndex((m) => m.id === id)
      if (index === -1) return
      virtualizerRef.current.scrollToIndex(index, { align: 'center' })
      setHighlightId(id)
      setTimeout(() => setHighlightId((cur) => (cur === id ? null : cur)), 1500)
    }
    window.addEventListener('ponos:scroll-message', handler)
    return () => window.removeEventListener('ponos:scroll-message', handler)
  }, [])

  const scrollToBottom = () => {
    isPinnedRef.current = true
    if (messages.length > 0) {
      virtualizer.scrollToIndex(messages.length - 1, { align: 'end', behavior: 'smooth' })
    }
  }

  const handleSuggestionClick = (suggestion: { icon: any; text: string }) => {
    setSelectedSuggestion(suggestion.text)
    setPendingInput(suggestion.text, true)
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 relative">
      <HealthGlow conversationId={conversationId} />
      {/* 内置浏览器自动化精简状态条（消息区上方；无事件不占位） */}
      <BrowserStatusBar conversationId={conversationId} />
      {/* 内核失速告警条（bridge kernel-stall 事件；有输出自动消失） */}
      <KernelStallBar conversationId={conversationId} />
      {/* /loop 连续迭代状态条（内核 loop 事件；无 loop 不占位） */}
      <LoopStatusBar conversationId={conversationId} />
      <ScrollArea ref={scrollRef} className="flex-1 pl-1" onScroll={handleScrollWithPin}>
        {loadingWithHistory ? (
          /* v2 按需加载占位：历史会话消息拉取中 */
          <div className="flex-1 flex flex-col items-center justify-center h-full px-6 py-8 select-none">
            <div className="w-8 h-8 rounded-full border-2 border-subtle border-t-brand-500 animate-spin" />
            <p className="mt-4 text-sm text-tertiary">加载会话中…</p>
          </div>
        ) : isEmpty ? (
          /* Ponos branded empty state */
          <div className="flex-1 flex flex-col items-center justify-center h-full px-6 py-8 animate-fade-in select-none">
            {/* Brand hero */}
            <div className="relative mb-8">
              <div
                className="w-20 h-20 rounded-3xl flex items-center justify-center"
                style={{
                  background: 'linear-gradient(135deg, var(--brand-500), var(--brand-600))',
                  boxShadow: '0 8px 32px var(--brand-500, rgba(255,106,0,0.35)), inset 0 1px 0 rgba(255,255,255,0.2)',
                }}
              >
                <span className="text-3xl font-bold text-inverse tracking-tight select-none"
                  style={{ fontFamily: '"Sora", "Inter", system-ui, sans-serif' }}
                >YF</span>
              </div>
              {/* Decorative ring（旋转已静态化：旋转动画每帧改包围盒，旧 GPU 上触发整层重绘级负载） */}
              <div
                className="absolute -inset-3 rounded-[20px] -z-10 opacity-30"
                style={{
                  border: '2px dashed var(--brand-500, rgba(255,106,0,0.5))',
                }}
              />
            </div>

            {/* Title */}
            <div className="flex items-center justify-center gap-2 mb-1">
              <h1
                className="text-2xl font-bold tracking-tight"
                style={{
                  fontFamily: '"Sora", "Inter", system-ui, sans-serif',
                  background: 'linear-gradient(135deg, var(--brand-500), var(--brand-300))',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                }}
              >
                Ponos dev
              </h1>
              {/* Turbo 内核标识：区分稳定旧版 */}
              <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold tracking-widest text-brand-500 bg-brand-500/10 border border-brand-500/30 select-none">
                TURBO
              </span>
            </div>
            <p className="text-sm text-tertiary mb-6 max-w-md text-center leading-relaxed">
              {t('chat.welcomeSubtitle')}
            </p>

            {/* Working directory selector */}
            <div className="mb-8 w-full max-w-md">
              <label className="block text-[11px] text-tertiary mb-2 font-semibold uppercase tracking-wider">
                {t('chat.workingDirectory')}
              </label>
              <div className="relative">
                <button
                  onClick={() => setShowDirPicker(!showDirPicker)}
                  className="w-full flex items-center gap-3 h-10 bg-elevated border border hover:border rounded-lg px-4 text-sm text-secondary font-mono transition-all duration-200 hover:shadow-sm"
                >
                  <FolderOpen className="w-4 h-4 text-brand-500/70 shrink-0" />
                  <span className="truncate">{conversation?.cwd || getDefaultHome()}</span>
                  <span className="text-[10px] text-brand-500/70 ml-auto shrink-0 font-medium">{t('chat.browse')}</span>
                </button>
                {showDirPicker && (
                  <div
                    className="fixed inset-0 z-50 flex items-center justify-center animate-fade-in"
                    onClick={() => setShowDirPicker(false)}
                    style={{
                      backgroundColor: 'var(--overlay-bg)',
                      backdropFilter: `blur(var(--overlay-blur))`,
                      WebkitBackdropFilter: `blur(var(--overlay-blur))`,
                    }}
                  >
                    <div className="w-[420px] max-h-[450px]" onClick={e => e.stopPropagation()}>
                      <DirectoryPicker
                        value={conversation?.cwd || getDefaultHome()}
                        onChange={(path) => {
                          useChatStore.getState().setConversationCwd(conversationId, path)
                          setShowDirPicker(false)
                        }}
                        onClose={() => setShowDirPicker(false)}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Active professional agent */}
            {(() => {
              const activeAgent = getAgentById(allAgents, conversation?.agentId)
              if (!activeAgent) return null
              return (
                <div className="mb-8 w-full max-w-md">
                  <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-brand-500/30 bg-brand-500/10 text-[11px] font-medium text-brand-500">
                    <AgentAvatar agent={activeAgent} size={16} />
                    Agent：{activeAgent.name}
                  </div>
                </div>
              )
            })()}

            {/* Suggestions */}
            <div className="w-full max-w-lg">
              <p className="text-[11px] text-tertiary mb-3 font-semibold uppercase tracking-wider text-center">
                {t('chat.quickStart')}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {welcomeSuggestions.map((suggestion) => {
                  const Icon = suggestion.icon
                  return (
                    <button
                      key={suggestion.text}
                      onClick={() => handleSuggestionClick(suggestion)}
                      className={cn(
                        'flex items-center gap-3 text-left px-4 py-3 rounded-xl border border-subtle',
                        'hover:bg-elevated hover:border transition-all duration-200 hover:shadow-sm',
                        'group',
                        selectedSuggestion === suggestion.text
                          ? 'border-brand-500/40 bg-brand-500/8 shadow-sm'
                          : 'text-tertiary hover:text-primary',
                      )}
                    >
                      <Icon className={cn(
                        'w-4 h-4 shrink-0 transition-colors',
                        selectedSuggestion === suggestion.text
                          ? 'text-brand-500'
                          : 'text-tertiary group-hover:text-brand-500/60',
                      )} />
                      <span className="text-sm leading-snug">{suggestion.text}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Footer hint */}
            <p className="text-[11px] text-tertiary mt-8 text-center">
              {t('chat.welcomeFooterHint')}
            </p>
          </div>
        ) : (
          /* Messages (virtualized: only the visible window is rendered) */
          <div
            className="pb-2 min-w-0 overflow-hidden"
            style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
          >
            {virtualizer.getVirtualItems().map((vi) => {
              const msg = messages[vi.index]
              return (
                <div
                  key={msg.id}
                  ref={virtualizer.measureElement}
                  data-index={vi.index}
                  data-message-id={msg.id}
                  className={cn(highlightId === msg.id && 'animate-pulse')}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  <MessageBubble
                    message={msg}
                    isStreaming={streamingConversations[conversationId] === msg.id}
                    onRetry={msg.role === 'assistant' ? () => retryMessage(conversationId, msg.id) : undefined}
                    onEdit={msg.role === 'user' ? () => {
                      const textBlocks = msg.content.filter(b => b.type === 'text')
                      const text = textBlocks.map(b => b.content).join('\n')
                      editMessage(conversationId, msg.id, msg.content)
                      setPendingInput(text)
                    } : undefined}
                  />
                </div>
              )
            })}
          </div>
        )}
      </ScrollArea>

      {/* Scroll to bottom button */}
      {showScrollButton && (
        <Button
          variant="secondary"
          size="xs"
          onClick={scrollToBottom}
          className="absolute bottom-2 right-4 z-10 rounded-full shadow-lg animate-slide-up"
        >
          <ArrowDown className="w-4 h-4" />
        </Button>
      )}

      {/* 运行中子 Agent 悬浮条（终态后由消息下方嵌入面板承接） */}
      <RunningAgentsBar conversationId={conversationId} />

      {/* 压缩提醒：右下角轻量 toast，2.4s 自动消失 */}
      <CompressedToast conversationId={conversationId} />
    </div>
  )
}
