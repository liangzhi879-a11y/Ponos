import { useEffect, useRef, useState, useCallback } from 'react'
import { ArrowDown, Lightbulb, FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui'
import { DirectoryPicker } from '@/components/chat/DirectoryPicker'
import { ThreadPrimitive } from '@assistant-ui/react'
import { HealthGlow } from './HealthGlow'
import { SessionModeBar } from './SessionModeBar'
import { LoopStatusBar } from './LoopStatusBar'
import { ChatRuntimeProvider } from '@/lib/chatRuntime'
import { ChatContext } from './MarkdownText'
import { AssistantMessageView, UserMessageView, SystemMessageView } from './AssistantMessageView'
import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/uiStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useTranslation } from '@/i18n/useTranslation'
import { cn } from '@/lib/utils'
import { getAgentById } from '@/lib/agents'
import { useAgentStore } from '@/stores/agentStore'
import { AgentAvatar } from '@/components/agents/AgentAvatar'

interface Props {
  conversationId: string
}

// 欢迎屏「使用提示」储备池：基于应用真实可用能力编写（工作目录/排队插话/轮次与子
// Agent 状态/自动压缩/历史检索/智能体档案/技能库/自然语言拆解）。空态每次只展示
// 随机一条（含去重轮换），供用户快速建立正确使用心智，而非推荐任务。
const TIPS_POOL = {
  'zh-CN': [
    '提问前先设定工作目录——agent 会在该目录内读写文件，结果落盘位置可预期。',
    '流式回复生成中随时按 Enter 排队补充要求，不会打断当前输出。',
    '多轮任务推进时留意轮次状态条与子 Agent 悬浮条，可随时停止纠偏。',
    '长会话会自动压缩并携带摘要延续，无需手动清理历史。',
    '侧边栏可重命名、置顶、按会话集归类对话；在「历史」中搜索可跳回任一条消息。',
    '对话可绑定不同智能体档案，任务类型不匹配时换一个再问。',
    '内置技能覆盖文档处理、浏览器抓取、企业资质申报等场景，可在「技能」面板浏览启用。',
    '把任务描述清楚（目标、范围、产出、验收标准），agent 会自动拆解成多轮步骤推进。',
  ],
  'en-US': [
    'Set the working directory first — the agent reads and writes files under it, so results land where you expect.',
    'While a reply is streaming, press Enter to queue extra instructions without interrupting output.',
    'Watch the round status bar and running sub-agent bar on multi-round tasks; you can stop or redirect anytime.',
    'Long conversations auto-compact and carry summaries forward — no manual cleanup needed.',
    'Rename, pin, and group conversations from the sidebar; search History to jump back to any message.',
    'Each conversation can bind a different agent profile — switch when the task type does not match.',
    'Built-in skills cover documents, web scraping, qualification filing and more — browse them in the Skills view.',
    'Describe the task clearly (goal, scope, output, acceptance) and the agent breaks it into multi-round steps.',
  ],
} as const
function pickRandomTip(pool: readonly string[], exclude?: string): string {
  // 排除当前展示条（去重轮换）；池空时退化为任意一条
  const candidates = pool.filter(t => t !== exclude)
  const source = candidates.length > 0 ? candidates : pool
  return source[Math.floor(Math.random() * source.length)]
}

export function ChatWindow({ conversationId }: Props) {
  const conversations = useChatStore(s => s.conversations)
  const { setPendingInput } = useUIStore()
  const { t, lang } = useTranslation()
  const subAgentTasks = useChatStore(s => s.subAgentTasks[conversationId])
  // v2 按需加载：切换会话时消息异步从内核 transcript 拉取，加载中显示轻量占位而非空态
  const conversationLoading = useChatStore(s => !!s.conversationLoading[conversationId])
  const allAgents = useAgentStore(s => s.agents)
  const viewportRef = useRef<HTMLDivElement>(null)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [highlightId, setHighlightId] = useState<string | null>(null)
  // 任务目录选择（2026-09-11）：任务模式欢迎页 logo 下方的目录入口
  const [showDirPicker, setShowDirPicker] = useState(false)
  // 使用提示：空态单条展示。切换会话/语言时重抽一条
  const [tip, setTip] = useState<string>(() => pickRandomTip(TIPS_POOL[lang] ?? TIPS_POOL['zh-CN']))
  useEffect(() => {
    setTip(pickRandomTip(TIPS_POOL[lang] ?? TIPS_POOL['zh-CN']))
  }, [conversationId, lang])

  const conversation = conversations.find(c => c.id === conversationId)
  const messages = conversation?.messages || []
  const isEmpty = messages.length === 0
  // 任务模式（mode 缺省 'task'）：欢迎页展示目录入口；chat 纯聊不绑业务目录
  const isTaskMode = (conversation?.mode ?? 'task') === 'task'
  const cwd = conversation?.cwd || ''
  // 更换目录 = 切换工作根：更新会话 cwd 并使会话失效（下次发送以新目录重 spawn
  // 内核会话；与 TaskCwdBar 原语义一致，2026-09-11 目录入口收敛）
  const changeCwd = (path: string) => {
    const st = useChatStore.getState()
    st.setConversationCwd(conversationId, path)
    st.invalidateSession(conversationId)
    setShowDirPicker(false)
  }
  // 加载中但历史非空（索引里 messageCount>0）：显示占位，不闪"新对话"空态
  const loadingWithHistory = conversationLoading && isEmpty && (conversation?.messageCount ?? 0) > 0
  // 空态停留时缓慢轮换单条 tips（10s/条、去重），让储备池内容逐步露出
  useEffect(() => {
    if (!isEmpty) return
    const id = setInterval(() => {
      setTip(cur => pickRandomTip(TIPS_POOL[lang] ?? TIPS_POOL['zh-CN'], cur))
    }, 10_000)
    return () => clearInterval(id)
  }, [isEmpty, conversationId, lang])

  // 滚动贴底跟踪：assistant-ui Viewport 内建 autoScroll 负责跟随；这里只维护
  // "用户已上翻 → 显示回底按钮"的展示态。
  const handleViewportScroll = useCallback(() => {
    const el = viewportRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    setShowScrollButton(distanceFromBottom > 100)
  }, [])

  // HistoryView 跳转：按 data-message-id 定位（元素已在 DOM，scrollIntoView 即可）
  useEffect(() => {
    const handler = () => {
      const id = (window as any).__scrollToMessageId
      if (!id) return
      delete (window as any).__scrollToMessageId
      const el = viewportRef.current?.querySelector(`[data-message-id="${id}"]`)
      if (!el) return
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      setHighlightId(id)
      setTimeout(() => setHighlightId((cur) => (cur === id ? null : cur)), 1500)
    }
    window.addEventListener('yfworking:scroll-message', handler)
    return () => window.removeEventListener('yfworking:scroll-message', handler)
  }, [])

  const scrollToBottom = () => {
    const el = viewportRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  return (
    <ChatRuntimeProvider conversationId={conversationId}>
      <ChatContext.Provider value={{ cwd: conversation?.cwd || '', conversationId }}>
        <div className="flex-1 flex flex-col min-h-0 relative">
          <HealthGlow conversationId={conversationId} />
          {/* 浏览器状态条/失速守卫/首字节等待/系统告警已全部收进右侧折叠状态栏（2026-09-10） */}
          {/* 会话模式徽标条（chat 纯聊 / task 全工具）：位于系统条之下、消息滚动区之上，
              不随消息滚动；无活动会话不占位。Task 13 在同一行右侧放 effort 选择器。 */}
          <SessionModeBar conversationId={conversationId} />

          {/* 消息区：assistant-ui ThreadPrimitive.Viewport（内建 autoScroll 贴底与
              锚定，替换原 ScrollArea+虚拟列表+rAF 追赶逻辑） */}
          <ThreadPrimitive.Viewport
            ref={viewportRef}
            autoScroll
            turnAnchor="bottom"
            onScroll={handleViewportScroll}
            className="flex-1 min-h-0 overflow-y-auto pl-1"
          >
            {loadingWithHistory ? (
              /* v2 按需加载占位：历史会话消息拉取中 */
              <div className="flex flex-col items-center justify-center h-full px-6 py-8 select-none">
                <div className="w-8 h-8 rounded-full border-2 border-subtle border-t-brand-500 animate-spin" />
                <p className="mt-4 text-sm text-tertiary">{t('chat.loadingHistory')}</p>
              </div>
            ) : isEmpty ? (
              /* YFWorking branded empty state */
              <div className="flex flex-col items-center justify-center h-full px-6 py-8 animate-fade-in select-none">
                {/* Brand hero：boost-logo 横版整标（纯图形；品牌字标由下方 h1 承担，与 Header 图文分工一致） */}
                <img
                  src={`${import.meta.env.BASE_URL}logo.png`}
                  alt="YFWorking"
                  draggable={false}
                  className="w-44 h-auto object-contain mb-6 select-none"
                />

                {/* 任务模式：任务目录选择（2026-09-11）——欢迎页 logo 下方直接放目录
                    入口，首条消息发送前即可定目录；消息开始后会话内改目录走右侧
                    状态栏固定目录卡片 */}
                {isTaskMode && (
                  <div className="mb-6 w-full max-w-md">
                    <label className="block text-[11px] text-tertiary mb-2 font-semibold uppercase tracking-wider text-center">
                      {t('chat.workingDirectory')}
                    </label>
                    <button
                      onClick={() => setShowDirPicker(true)}
                      title={cwd || t('chat.workingDirNotSet')}
                      className="w-full h-9 cut-btn hot-hover"
                    >
                      <span className="ci flex items-center gap-2.5 px-3.5 h-full !bg-elevated/50">
                        <FolderOpen className="w-4 h-4 text-brand-500/70 shrink-0" />
                        <span className={cn('flex-1 min-w-0 truncate text-left text-[12px] font-mono', cwd ? 'text-secondary' : 'text-tertiary')}>
                          {cwd || t('chat.workingDirNotSet')}
                        </span>
                        <span className="text-[10px] text-brand-500/70 shrink-0 font-medium">{t('chat.browse')}</span>
                      </span>
                    </button>
                  </div>
                )}

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

                {/* 使用提示：非推荐任务——储备池随机单条展示（10s 轮换），引导建立正确使用心智 */}
                <div className="mb-2 w-full max-w-md">
                  <p className="text-[11px] text-tertiary mb-2 font-semibold uppercase tracking-wider text-center">
                    {t('chat.usageTips')}
                  </p>
                  {/* 2026-09-11 设计语言统一：提示卡 rounded-lg → 单对角切角 */}
                  <div className="cut-sm">
                    <div className="ci flex items-start gap-2 px-3.5 py-2.5 !bg-elevated/30">
                      <Lightbulb className="w-3.5 h-3.5 shrink-0 mt-px text-brand-500/50" />
                      <span className="text-[13px] leading-relaxed text-tertiary">{tip}</span>
                    </div>
                  </div>
                </div>

                {/* Footer hint */}
                <p className="text-[11px] text-tertiary mt-8 text-center">
                  {t('chat.welcomeFooterHint')}
                </p>
              </div>
            ) : (
              /* 消息流：assistant-ui ThreadPrimitive.Messages children render。
                 data-message-id 供 HistoryView 跳转定位与高亮。 */
              <ThreadPrimitive.Messages>
                {({ message }) => {
                  const view = message.role === 'user'
                    ? <UserMessageView />
                    : message.role === 'assistant'
                      ? <AssistantMessageView />
                      : <SystemMessageView />
                  return (
                    <div
                      data-message-id={message.id}
                      className={cn('pb-1 min-w-0', highlightId === message.id && 'animate-pulse')}
                    >
                      {view}
                    </div>
                  )
                }}
              </ThreadPrimitive.Messages>
            )}
          </ThreadPrimitive.Viewport>

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

          {/* 多轮 loop 轮次状态条（消息流/输入上方；非 active 不占位）。
              子 Agent 悬浮条/压缩指示族已移入右侧折叠状态栏（2026-09-10） */}
          <LoopStatusBar conversationId={conversationId} />

          {/* 任务目录选择器（欢迎页入口；会话内入口 = 右侧状态栏固定目录卡片） */}
          {showDirPicker && (
            <DirectoryPicker value={cwd} onChange={changeCwd} onClose={() => setShowDirPicker(false)} />
          )}
        </div>
      </ChatContext.Provider>
    </ChatRuntimeProvider>
  )
}
