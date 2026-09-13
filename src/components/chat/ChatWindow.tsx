import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { ArrowDown, Lightbulb, FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui'
import { DirectoryPicker } from '@/components/chat/DirectoryPicker'
import { ThreadPrimitive, type MessageState } from '@assistant-ui/react'
import { HealthGlow } from './HealthGlow'
import { SessionModeBar } from './SessionModeBar'
import { LoopStatusBar } from './LoopStatusBar'
import { WaitStatusBar } from './WaitStatusBar'
import { ChatRuntimeProvider } from '@/lib/chatRuntime'
import { ChatContext } from './MarkdownText'
import { AssistantMessageView, UserMessageView, SystemMessageView } from './AssistantMessageView'
import { useChatStore } from '@/stores/chatStore'
import { useTranslation } from '@/i18n/useTranslation'
import { cn } from '@/lib/utils'
import { viewportClassName } from '@/lib/longListContainment'
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
}
// chat 模式（2026-09-12 会话模式隔离）专用提示池：上面那套里的"设定工作目录""技能
// 面板浏览启用""自动拆解成多轮步骤"在 chat 全是做不到的事（内核侧技能/工作流/本地
// 工具已关闭，见 kernel/cli.mjs --session-mode chat）——空态却拿它当"正确使用心智"
// 引导用户，等于让用户按任务模式提问再吃一记"我做不到"。
const CHAT_TIPS_POOL = {
  'zh-CN': [
    '聊天模式只做联网检索与资料整理：查资料、追新闻、比对来源都合适。',
    '需要读写本机文件或执行命令时，切到任务模式再发——聊天模式没有本地工具。',
    '涉及时效性内容（版本、价格、政策）我会先联网检索再作答，并附来源链接。',
    '想让资料成体系：先要一份要点清单，再让我逐条补来源与出处。',
  ],
  'en-US': [
    'Chat mode is web research only — good for looking things up, tracking news, and comparing sources.',
    'Switch to Task mode to read or modify local files or run commands — chat mode has no local tools.',
    'For time-sensitive facts (versions, prices, policies) I search the web first and cite sources.',
    'To build up a topic: ask for an outline first, then have me fill in each point with sources.',
  ],
} as const
function pickRandomTip(pool: readonly string[], exclude?: string): string {
  // 排除当前展示条（去重轮换）；池空时退化为任意一条
  const candidates = pool.filter(t => t !== exclude)
  const source = candidates.length > 0 ? candidates : pool
  return source[Math.floor(Math.random() * source.length)]
}

export function ChatWindow({ conversationId }: Props) {
  // R3（2026-09-13）：**不订阅 conversations 整个数组**。chatStore 每帧追加流式片段都会
  // 产出新数组（被追加的那个会话对象已替换），订阅它 = 每来一个 delta 就重渲染整个消息区。
  // 拆成逐字段选择器：全是原始值，zustand 按 Object.is 比较 ⇒ 只在字段真的变化时重渲染。
  // 顺带清掉两个**从未被使用**的订阅（`useUIStore()` 整店 + `subAgentTasks`）——它们此前
  // 让本组件在 uiStore/chatStore 任意写入时都白重渲染一次。
  const convMode = useChatStore(s => s.conversations.find(c => c.id === conversationId)?.mode ?? 'task')
  const cwd = useChatStore(s => s.conversations.find(c => c.id === conversationId)?.cwd ?? '')
  const convAgentId = useChatStore(s => s.conversations.find(c => c.id === conversationId)?.agentId)
  const convMessageCount = useChatStore(s => s.conversations.find(c => c.id === conversationId)?.messageCount ?? 0)
  // R6（2026-09-13）：长会话给滚动容器挂 containment（离屏消息跳过 style/layout/paint）。
  // 门槛、类名与拼装都在 src/lib/longListContainment.ts（实测依据与代价也写在那一处）；挂在
  // **容器**上、由 CSS 后代选择器命中消息节点 ⇒ 不碰 renderMessage 的依赖，也不会逐条改内联样式。
  const viewportClass = useMemo(
    () => viewportClassName('flex-1 min-h-0 overflow-y-auto pl-1', convMessageCount),
    [convMessageCount],
  )
  // 空态只看**条数**（boolean），看数组本身又会被每帧的流式追加带动重渲染
  const isEmpty = useChatStore(s => ((s.conversations.find(c => c.id === conversationId)?.messages.length ?? 0) === 0))
  const { t, lang } = useTranslation()
  // v2 按需加载：切换会话时消息异步从内核 transcript 拉取，加载中显示轻量占位而非空态
  const conversationLoading = useChatStore(s => !!s.conversationLoading[conversationId])
  const allAgents = useAgentStore(s => s.agents)
  const viewportRef = useRef<HTMLDivElement>(null)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [highlightId, setHighlightId] = useState<string | null>(null)
  // 任务目录选择（2026-09-11）：任务模式欢迎页 logo 下方的目录入口
  const [showDirPicker, setShowDirPicker] = useState(false)
  // 使用提示：空态单条展示。切换会话/语言时重抽一条
  // 会话模式判定提前到此：空态提示池按模式选（下方 isTaskMode 由它派生，单一真源）
  const isChatMode = convMode === 'chat'
  const tipPool = isChatMode ? CHAT_TIPS_POOL : TIPS_POOL
  const [tip, setTip] = useState<string>(() => pickRandomTip(tipPool[lang] ?? tipPool['zh-CN']))
  useEffect(() => {
    setTip(pickRandomTip(tipPool[lang] ?? tipPool['zh-CN']))
    // tipPool 入依赖：会话内切换 chat/task（SessionModeBar）时提示池必须跟着换，
    // 否则任务模式的"设定工作目录"会留在 chat 空态里
  }, [conversationId, lang, tipPool])

  // 任务模式（mode 缺省 'task'）：欢迎页展示目录入口；chat 纯聊不绑业务目录
  const isTaskMode = !isChatMode // 与上方空态提示池同源（同一 conversation.mode）
  // 更换目录 = 切换工作根：更新会话 cwd 并使会话失效（下次发送以新目录重 spawn
  // 内核会话；与 TaskCwdBar 原语义一致，2026-09-11 目录入口收敛）
  const changeCwd = (path: string) => {
    const st = useChatStore.getState()
    st.setConversationCwd(conversationId, path)
    st.invalidateSession(conversationId)
    setShowDirPicker(false)
  }
  // 加载中但历史非空（索引里 messageCount>0）：显示占位，不闪"新对话"空态
  const loadingWithHistory = conversationLoading && isEmpty && convMessageCount > 0
  // 空态停留时缓慢轮换单条 tips（10s/条、去重），让储备池内容逐步露出
  useEffect(() => {
    if (!isEmpty) return
    const id = setInterval(() => {
      setTip(cur => pickRandomTip(tipPool[lang] ?? tipPool['zh-CN'], cur))
    }, 10_000)
    return () => clearInterval(id)
  }, [isEmpty, conversationId, lang, tipPool])

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

  // R3：<ThreadPrimitive.Messages> 的 render prop 必须是**稳定引用**。内联箭头每渲染都
  // 新建 ⇒ 该组件（NamedExoticComponent，memo 过的）props 恒不等 ⇒ 每次都重渲染，并把
  // 全部 N 条消息的视图重新创建一遍。抽成 useCallback 后只依赖 highlightId（跳转高亮，
  // 低频）；再配合 AssistantMessageView 侧的 memo，流式期只有变化的那条消息真正重渲染。
  // R3：ChatContext 的 value 对象同样要 memo——内联字面量每渲染新建，凡用 Context 的
  // 组件（MarkdownText 的文件路径渲染等）都会被无差别重渲染。
  const chatContextValue = useMemo(() => ({ cwd, conversationId }), [cwd, conversationId])

  const renderMessage = useCallback(({ message }: { message: MessageState }) => {
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
  }, [highlightId])

  return (
    <ChatRuntimeProvider conversationId={conversationId}>
      <ChatContext.Provider value={chatContextValue}>
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
            className={viewportClass}
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
                  const activeAgent = getAgentById(allAgents, convAgentId)
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
              <ThreadPrimitive.Messages>{renderMessage}</ThreadPrimitive.Messages>
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

          {/* 等待态常显条（2026-09-12 卡在思考界面事故）：内核静默/失速/等审批/
              等回答/压缩时在此内联显示（chat 与 task 两条 rail 都可见，不悬浮不
              遮挡）；无等待态不占位。此前这些状态只在右侧折叠状态栏可见，chat
              模式下零出口，UI 只能显示静态「思考中…」。 */}
          <WaitStatusBar conversationId={conversationId} />

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
