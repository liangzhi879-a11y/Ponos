import { Bot, User, RotateCcw, Edit3, Copy, Check, ChevronDown, ChevronRight, FolderOpen } from 'lucide-react'
import ReactMarkdown, { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui'
import { Tooltip } from '@/components/ui'
import { Badge } from '@/components/ui'
import { CodeBlock } from './CodeBlock'
import { ThinkingBlock } from './ThinkingBlock'
import { BoxdrawTable } from './BoxdrawTable'
import { SubAgentPanel } from './SubAgentPanel'
import QuestionCard from './QuestionCard'
import { extractAskUserCards } from '@/lib/askUser'
import { formatDate, preprocessBoxDrawingTables, detectFilePaths, parseBoxDrawingTable } from '@/lib/utils'
import { cn } from '@/lib/utils'
import { openFileInEditor } from '@/lib/editorBridge'
import { useTranslation } from '@/i18n/useTranslation'
import { useChatStore } from '@/stores/chatStore'
import { useAgentStore } from '@/stores/agentStore'
import { getAgentById } from '@/lib/agents'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import type { Message, ContentBlock } from '@/types'
import { Fragment, useState, useCallback, memo } from 'react'

// 模块级稳定引用：流式更新重渲染时避免 components/插件对象重建导致
// ReactMarkdown 子树全量重挂载（代码块、复制按钮等状态丢失）。
const MD_PLUGINS = [remarkGfm]

// 流式半截标记兜底：文本中出现未闭合的 <!--ASK_USER（尚无 -->）时截断到标记起点，
// 防止流式渲染闪现原始标记代码。已闭合的块由 extractAskUserCards 先行剥离。
function truncatePartialAskUser(text: string): string {
  const m = /<!--\s*ASK_USER\b/.exec(text)
  if (!m) return text
  if (text.indexOf('-->', m.index + m[0].length) !== -1) return text
  return text.slice(0, m.index)
}

const MD_COMPONENTS: Components = {
  pre({ children }) {
    return <>{children}</>
  },
  code({ className, children, node, ...props }) {
    const match = /language-(\w+)/.exec(className || '')
    const isInline = !match && !className
    if (isInline) {
      return <code className="bg-elevated px-1 py-0.5 rounded text-[0.85em] text-brand-500/85 font-mono break-all [overflow-wrap:anywhere]" {...props}>{children}</code>
    }
    const lang = match?.[1]

    // Recursively extract all text content from children
    const extractText = (node: any): string => {
      if (node == null || node === false || node === undefined) return ''
      if (typeof node === 'string') return node
      if (typeof node === 'number') return String(node)
      if (Array.isArray(node)) {
        return node.map(extractText).join('')
      }
      if (typeof node === 'object') {
        // Try props.children first (React elements)
        if (node.props && node.props.children != null) {
          return extractText(node.props.children)
        }
        // Try children property (hast nodes)
        if (node.children != null) {
          return extractText(node.children)
        }
        // Try value property (text nodes)
        if (node.value != null && typeof node.value === 'string') {
          return node.value
        }
      }
      return ''
    }

    // Extract content from children
    let codeStr = extractText(children)

    // Fallback: try to extract from hast node
    if (!codeStr && node) {
      codeStr = extractText(node)
    }

    codeStr = codeStr.replace(/\n$/, '')

    if (lang === 'boxdraw') {
      const parsed = parseBoxDrawingTable(codeStr)
      if (parsed) {
        return <BoxdrawTable table={parsed} />
      }
      return <CodeBlock code={codeStr} language="boxdraw" />
    }
    return <CodeBlock code={codeStr} language={lang} />
  },
  a({ href, children }) {
    return <a href={href} target="_blank" rel="noopener noreferrer" className="text-brand-500/90 hover:text-[var(--accent-red)] underline decoration-brand-500/30 hover:decoration-[var(--accent-red)]/60 underline-offset-2">{children}</a>
  },
  table({ children }) {
    return <div className="overflow-x-auto my-2 max-w-full"><table className="min-w-full border-collapse border border text-sm">{children}</table></div>
  },
  th({ children }) {
    return <th className="border border bg-elevated px-3 py-1.5 text-left font-semibold">{children}</th>
  },
  td({ children }) {
    return <td className="border border px-3 py-1.5">{children}</td>
  },
  h1({ children }) { return <h1 className="text-lg font-bold mt-4 mb-2 text-primary">{children}</h1> },
  h2({ children }) { return <h2 className="text-base font-bold mt-3 mb-1.5 text-primary">{children}</h2> },
  h3({ children }) { return <h3 className="text-sm font-semibold mt-2 mb-1 text-primary">{children}</h3> },
  ul({ children }) { return <ul className="list-disc pl-5 my-1 space-y-0.5">{children}</ul> },
  ol({ children }) { return <ol className="list-decimal pl-5 my-1 space-y-0.5">{children}</ol> },
  blockquote({ children }) {
    return <blockquote className="border-l-2 border-brand-500/25 pl-3 my-2 text-tertiary italic">{children}</blockquote>
  },
  hr() { return <hr className="my-3 border" /> },
}

interface Props {
  message: Message
  isStreaming?: boolean
  onRetry?: () => void
  onEdit?: () => void
}

function MessageBubbleImpl({ message, isStreaming, onRetry, onEdit }: Props) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const [collapsedTools, setCollapsedTools] = useState<Record<string, boolean>>({})
  const isUser = message.role === 'user'
  const isAssistant = message.role === 'assistant'
  // 排队插话悬浮态：已发送但内核尚未接收处理（command_lifecycle started 未到）
  const isPendingInterject = isUser && !!message.pending
  const activeConversationId = useChatStore(s => s.activeConversationId)
  // 订阅本会话子任务状态：task_notification 更新 subAgentTasks 时强制本组件重渲染
  // （MessageBubble 是 memo 组件，仅消息引用变化才会走父级重渲染；不订阅的话，
  // 运行中任务完成时 ChatWindow 虽因 subAgentTasks 变化重渲染，但 message 引用未变、
  // memo 命中跳过，完成态汇报卡片无法插入触发消息下方）。
  useChatStore(s => s.subAgentTasks[activeConversationId ?? '']?.filter(t => t.status !== 'running').length ?? 0)
  const cwd = useChatStore(s => s.conversations.find(c => c.id === s.activeConversationId)?.cwd || '')
  // 会话绑定的 agent（用于 assistant 头像）：agent 头像修改后即时反映。
  // 未绑定 agent 的普通会话回退到 YFWorking 内置 agent 身份——用户改了它的
  // 头像，聊天界面同样生效。
  const agentId = useChatStore(s => s.conversations.find(c => c.id === s.activeConversationId)?.agentId)
  const agents = useAgentStore(s => s.agents)
  const sessionAgent = agentId ? getAgentById(agents, agentId) : getAgentById(agents, 'yfworking')

  const handleFilePathClick = useCallback((e: React.MouseEvent, filePath: string, displayName: string) => {
    e.preventDefault()
    e.stopPropagation()
    // 会话文档点击 → 打开原生独立编辑器窗口（可编辑；二进制/Office 在窗口内只读预览）
    const name = displayName.split('/').pop() || displayName.split('\\').pop() || displayName
    openFileInEditor(filePath, name)
  }, [])

  const openInExplorer = useCallback((e: React.MouseEvent, filePath: string) => {
    e.preventDefault()
    e.stopPropagation()
    const api = (window as any).yfworkingAPI
    if (api?.openInExplorer) api.openInExplorer(filePath)
  }, [])

  const filePathP = useCallback((props: any) => {
    const children = props.children
    const textContent = typeof children === 'string' ? children : Array.isArray(children) ? children.map((c: any) => typeof c === 'string' ? c : '').join('') : ''
    if (!textContent) return <p className="my-1 leading-relaxed">{children}</p>

    const paths = detectFilePaths(textContent, cwd)
    if (paths.length === 0) return <p className="my-1 leading-relaxed">{children}</p>

    const segments: React.ReactNode[] = []
    let lastEnd = 0
    for (const fp of paths) {
      if (fp.start > lastEnd) {
        segments.push(textContent.slice(lastEnd, fp.start))
      }
      const fname = fp.text.split(/[/\\]/).pop() || fp.text
      segments.push(
        <span key={fp.start} className="inline-flex items-center gap-0.5 group/filepath">
          <FolderOpen className="w-3.5 h-3.5 text-warning/70 shrink-0" />
          <a
            href="#"
            onClick={e => handleFilePathClick(e, fp.path, fp.text)}
            onContextMenu={e => openInExplorer(e, fp.path)}
            className="text-brand-500/90 hover:text-brand-500 underline decoration-brand-500/30 hover:decoration-brand-500/60 underline-offset-2 cursor-pointer"
            title={fp.path + '\nClick to open in editor  |  Right-click → Open in Explorer'}
          >{fname}</a>
        </span>
      )
      lastEnd = fp.end
    }
    if (lastEnd < textContent.length) {
      segments.push(textContent.slice(lastEnd))
    }
    return <p className="my-1 leading-relaxed">{segments}</p>
  }, [cwd, handleFilePathClick, openInExplorer])

  const toggleTool = (id: string) => {
    setCollapsedTools(prev => ({ ...prev, [id]: !prev[id] }))
  }

  const handleCopy = async () => {
    const text = message.content
      .filter(b => b.type === 'text')
      .map(b => b.content)
      .join('\n')
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // 本消息触发的子 Agent 任务（按 toolUseId 匹配内核 task_started.tool_use_id）
  const subAgentToolUseIds = message.content
    .filter(b => b.type === 'tool_use' && b.metadata?.toolName === 'Agent')
    .map(b => b.metadata?.toolUseId)
    .filter((id): id is string => !!id)

  // Render content blocks
  const renderContent = () => {
    let subAgentPanelInserted = false
    return message.content.map((block, idx) => {
      const node = renderBlock(block)
      // 结果卡插入到 Agent tool_use 之后、工具结果（任务输出/阶段性结果）之前，
      // 与工具块同宽（面板自身不再带外层留白）。
      if (
        !subAgentPanelInserted &&
        block.type === 'tool_use' &&
        block.metadata?.toolName === 'Agent' &&
        subAgentToolUseIds.length > 0
      ) {
        subAgentPanelInserted = true
        return (
          <Fragment key={block.id ?? `agent-panel-${idx}`}>
            {node}
            <SubAgentPanel conversationId={activeConversationId ?? ''} toolUseIds={subAgentToolUseIds} />
          </Fragment>
        )
      }
      return node
    })
  }

  const renderBlock = (block: ContentBlock): React.ReactNode => {
    switch (block.type) {
        case 'text': {
          // 渲染层兜底：剥离消息文本中残留的 <!--ASK_USER...--> 标记（bridge 漏处理或
          // 历史回放时），并解析为内联只读提问卡——保证任何路径下原始 HTML 都不出现。
          // 历史/损坏恢复数据可能缺 content 字段：非字符串一律按空文本处理，
          // 避免 extractAskUserBlocks(undefined) 在 text.slice 处抛 TypeError。
          const { cards, clean } = extractAskUserCards(typeof block.content === 'string' ? block.content : '')
          // 流式半截标记（<!--ASK_USER 尚未闭合 -->）：截断到标记起点，避免闪现原始代码
          const safeText = truncatePartialAskUser(clean)
          return (
            <Fragment key={block.id}>
              {cards.map((card, i) => (
                <QuestionCard key={`ask-${block.id}-${i}`} payload={card} readOnly />
              ))}
              {safeText.trim() ? (
                <div className="prose max-w-none text-primary leading-relaxed break-words [overflow-wrap:break-word] [word-break:break-word]" style={{ fontSize: 'var(--chat-font, 14px)' }}>
                  <ReactMarkdown
                    remarkPlugins={MD_PLUGINS}
                    components={{ ...MD_COMPONENTS, p: filePathP }}
                  >
                    {preprocessBoxDrawingTables(safeText)}
                  </ReactMarkdown>
                </div>
              ) : null}
            </Fragment>
          )
        }

        case 'tool_use': {
          const toolBlock = block as any
          // 历史回放时工具结果已挂到 tool_use 块（transcriptAdapter 按 tool_use_id 匹配
          // 内核回显），优先展示结果；无结果（live 流式）退回展示输入参数 JSON。
          const resultContent = (block.result?.content || '')
          const toolContent = resultContent || block.content || ''
          const isLong = typeof toolContent === 'string' && toolContent.length > 500
          const isCollapsed = collapsedTools[block.id] ?? isLong
          return (
            <div key={block.id} className="my-1.5 rounded-lg border border bg-elevated/40 overflow-hidden">
              <button
                onClick={() => toggleTool(block.id)}
                className="w-full flex items-center gap-2 px-3 py-1.5 bg-elevated border-b border text-left hover:bg-hover transition-colors"
              >
                {isLong ? (
                  isCollapsed
                    ? <ChevronRight className="w-3 h-3 text-tertiary shrink-0" />
                    : <ChevronDown className="w-3 h-3 text-tertiary shrink-0" />
                ) : null}
                <span className="text-[10px] font-mono uppercase tracking-wider text-tertiary">
                  {toolBlock.toolName || t('chat.tool')}
                </span>
                <Badge variant={
                  toolBlock.status === 'completed' ? 'success' :
                  toolBlock.status === 'error' ? 'danger' :
                  toolBlock.status === 'running' ? 'warning' :
                  // 历史回放：结果已挂接（transcriptAdapter 回显匹配）→ 视为已完成；有错为 error
                  toolBlock.result ? (toolBlock.result.isError ? 'danger' : 'success') : 'default'
                }>
                  {toolBlock.status || (toolBlock.result ? (toolBlock.result.isError ? t('chat.error') : t('chat.result')) : 'pending')}
                </Badge>
                {toolBlock.duration && (
                  <span className="text-[10px] text-tertiary ml-auto">{toolBlock.duration}ms</span>
                )}
              </button>
              {toolContent && !isCollapsed && (
                <div className="p-2.5 text-xs font-mono text-secondary max-h-[300px] overflow-auto break-all whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {toolContent}
                </div>
              )}
              {toolContent && isCollapsed && (
                <div className="px-3 py-1.5 text-[10px] text-tertiary border-t border-subtle">
                  {typeof toolContent === 'string' ? `${toolContent.length} ${t('chat.characters')} · ${t('chat.expand')}` : `... · ${t('chat.expand')}`}
                </div>
              )}
            </div>
          )
        }

        case 'thinking':
          return <ThinkingBlock key={block.id} content={block.content} collapsed={(block as any).collapsed !== false} />

        case 'tool_result': {
          const resultBlock = block as any
          const resultContent = block.content || ''
          const isLong = typeof resultContent === 'string' && resultContent.length > 800
          const isCollapsed = collapsedTools[block.id] ?? isLong
          return (
            <div key={block.id} className={cn(
              'my-1.5 rounded-lg border overflow-hidden',
              resultBlock.isError ? 'border-error/30 bg-error/10' : 'border bg-elevated/30'
            )}>
              <button
                onClick={() => toggleTool(block.id)}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors',
                  resultBlock.isError ? 'hover:bg-error/10' : 'hover:bg-elevated'
                )}
              >
                {isLong ? (
                  isCollapsed
                    ? <ChevronRight className="w-3 h-3 text-tertiary shrink-0" />
                    : <ChevronDown className="w-3 h-3 text-tertiary shrink-0" />
                ) : null}
                <span className={cn(
                  'text-[10px] uppercase tracking-wider',
                  resultBlock.isError ? 'text-error' : 'text-tertiary'
                )}>
                  {resultBlock.isError ? t('chat.error') : t('chat.result')}
                </span>
                {resultBlock.exitCode !== undefined && (
                  <span className="text-[10px] text-tertiary">{t('chat.exitCode')}: {resultBlock.exitCode}</span>
                )}
              </button>
              {!isCollapsed && (
                <div className={cn(
                  'text-xs font-mono px-3 pb-2.5 break-all whitespace-pre-wrap [overflow-wrap:anywhere] overflow-x-auto',
                  resultBlock.isError ? 'text-error' : 'text-tertiary',
                  'max-h-[300px] overflow-auto'
                )}>
                  {resultContent}
                </div>
              )}
              {isCollapsed && (
                <div className={cn(
                  'px-3 py-1 text-[10px] border-t',
                  resultBlock.isError ? 'border-error/20 text-error/60' : 'border-subtle text-tertiary'
                )}>
                  {typeof resultContent === 'string' ? `${resultContent.length} ${t('chat.characters')} · ${t('chat.expand')}` : `... · ${t('chat.expand')}`}
                </div>
              )}
            </div>
          )
        }

        default:
          return (
            <div key={block.id} className="text-tertiary text-sm">
              {block.content}
            </div>
          )
      }
  }

  return (
    <div
      data-message-id={message.id}
      className={cn(
      // 两侧固定宽度留白（小窗 12px / 中窗 32px / 大窗 64px），中间内容随窗口自适应；
      // 超宽屏（>1600px）锁上限居中，避免整行文字过宽影响阅读。
      'group flex w-full max-w-[1600px] mx-auto min-w-0 overflow-hidden gap-3 px-3 sm:px-8 lg:px-16 py-2 animate-slide-up',
      // 用户/助手消息行均无底色（与界面其余部分一致）；仅系统消息保留淡色提示。
      isUser || isAssistant ? 'bg-app' : 'bg-warning/5'
    )}>
      {/* Avatar */}
      <div className="shrink-0 mt-0.5">
        {isUser ? (
          <div className="w-7 h-7 rounded-full bg-brand-500/15 flex items-center justify-center">
            <User className="w-4 h-4 text-brand-500" />
          </div>
        ) : isAssistant ? (
          sessionAgent ? (
            <AgentAvatar agent={sessionAgent} size={28} />
          ) : (
            <div className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #ff6a00, #ff8c33)' }}>
              <img src={`${import.meta.env.BASE_URL}logo.png`} alt="YF" className="w-4 h-4 object-contain" />
            </div>
          )
        ) : (
          <div className="w-7 h-7 rounded-full bg-warning/20 flex items-center justify-center">
            <Bot className="w-4 h-4 text-warning/80" />
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-semibold text-tertiary">
            {isUser ? 'You' : isAssistant ? 'YFWorking' : 'System'}
          </span>
          {isPendingInterject && (
            <span className="inline-flex items-center gap-1 text-[10px] font-medium text-brand-500/80">
              <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse" />
              {t('chat.interjectPending')}
            </span>
          )}
          {message.model && (
            <span className="text-[10px] text-tertiary">{message.model}</span>
          )}
          {message.edited && (
            <span className="text-[10px] text-warning">(edited)</span>
          )}
          {message.tokensUsed && (
            <span className="text-[10px] text-tertiary">{message.tokensUsed} tokens</span>
          )}
          <span className="text-[10px] text-tertiary ml-auto opacity-0 group-hover:opacity-100 transition-opacity">
            {formatDate(message.timestamp)}
          </span>
        </div>

        {/* Body — 排队插话悬浮态：虚线悬浮容器 + 轻微浮动动画，内核接收后落位 */}
        {isPendingInterject ? (
          <div className="space-y-1 min-w-0 overflow-hidden rounded-xl border border-dashed border-brand-500/40 bg-brand-500/5 px-3 py-2 shadow-sm animate-floating-bubble">
            {renderContent()}
          </div>
        ) : (
          <div className="space-y-1 min-w-0 overflow-hidden">
            {renderContent()}
          </div>
        )}

        {/* Streaming cursor */}
        {isStreaming && (
          <span className="inline-block w-2 h-4 bg-brand-400 ml-0.5 animate-streaming-cursor align-text-bottom" />
        )}

        {/* Actions (hover) */}
        {isAssistant && !isStreaming && (
          <div className="flex items-center gap-1 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
            <Tooltip content={copied ? 'Copied!' : 'Copy message'}>
              <Button variant="ghost" size="xs" onClick={handleCopy}>
                {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              </Button>
            </Tooltip>
            {onRetry && (
              <Tooltip content="Retry">
                <Button variant="ghost" size="xs" onClick={onRetry}>
                  <RotateCcw className="w-3 h-3" />
                </Button>
              </Tooltip>
            )}
          </div>
        )}
        {isUser && !isStreaming && (
          <div className="flex items-center gap-1 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
            <Tooltip content={copied ? 'Copied!' : 'Copy message'}>
              <Button variant="ghost" size="xs" onClick={handleCopy}>
                {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              </Button>
            </Tooltip>
            {onEdit && (
              <Tooltip content="Edit message">
                <Button variant="ghost" size="xs" onClick={onEdit}>
                  <Edit3 className="w-3 h-3" />
                </Button>
              </Tooltip>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// memo：仅当消息对象引用（流式 token 更新会替换该消息）或流式状态变化时才重渲染，
// 避免"某条消息流式输出时，其它所有消息的 ReactMarkdown 都跟着重跑"的浪费。
// onRetry/onEdit 为 ChatWindow 内联箭头函数（每次渲染新引用），故不参与比较。
export const MessageBubble = memo(MessageBubbleImpl, (prev, next) =>
  prev.message === next.message && prev.isStreaming === next.isStreaming,
)
