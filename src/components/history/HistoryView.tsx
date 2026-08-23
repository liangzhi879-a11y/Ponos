import { useMemo } from 'react'
import { Clock, MessageSquare, User, Bot } from 'lucide-react'
import { ScrollArea } from '@/components/ui'
import { useChatStore } from '@/stores/chatStore'
import { formatDate } from '@/lib/utils'
import { cn } from '@/lib/utils'
import type { Message, ContentBlock } from '@/types'

function scrollToMessage(messageId: string) {
  (window as any).__scrollToMessageId = messageId
  window.dispatchEvent(new CustomEvent('ponos:scroll-message'))
}

interface TurnEntry {
  id: string
  userMsg: Message
  assistantMsgs: Message[]
  assistantPreview: string
  /** 本次轮次总共的消息数 (user + assistant 之间所有消息) */
  turnMsgCount: number
  /** 本次轮次消耗的 token */
  turnTokens: number
  /** 并入本轮的纯工具回传消息数（tool_result 类 user 消息，不单独成卡） */
  toolCount: number
}

function getFirstText(blocks: ContentBlock[]): string {
  return blocks.filter(b => b.type === 'text').map(b => b.content).join(' ').trim()
}

/** 压缩空白，便于单行预览（tool_result 内容多为多行输出）。 */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * 用户消息正文摘要：优先 text 块；编码代理会话里用户消息多为 tool_result/tool_use，
 * 无 text 时回退展示工具结果摘要/工具名，避免时间线整排 "(空消息)"。
 */
function userMessageText(blocks: ContentBlock[]): string {
  const t = getFirstText(blocks)
  if (t) return t
  const tr = blocks.find(b => b.type === 'tool_result')
  if (tr && typeof tr.content === 'string') {
    const s = collapse(tr.content)
    if (s) return `工具结果: ${s.slice(0, 120)}`
  }
  const tu = blocks.find(b => b.type === 'tool_use')
  if (tu?.metadata?.toolName) return `调用工具: ${tu.metadata.toolName}`
  return ''
}

/**
 * 轮次预览：取该轮第一个带 text 的 assistant 消息（真正的答复）；
 * 无 text 则回退到首个 tool_use / tool_result 摘要。
 */
function turnPreview(assistantMsgs: Message[]): string {
  for (const m of assistantMsgs) {
    const t = getFirstText(m.content)
    if (t) return t.slice(0, 100)
  }
  for (const m of assistantMsgs) {
    const tu = m.content.find(b => b.type === 'tool_use')
    if (tu?.metadata?.toolName) return `调用工具: ${tu.metadata.toolName}`
  }
  for (const m of assistantMsgs) {
    const tr = m.content.find(b => b.type === 'tool_result')
    if (tr && typeof tr.content === 'string') {
      const s = collapse(tr.content)
      if (s) return `工具结果: ${s.slice(0, 80)}`
    }
  }
  return ''
}

/**
 * 时间线按"真实用户提问"成轮：只有带正文的用户消息开启新轮次；
 * 纯工具回传（tool_result 类 user 消息）并入当前轮计数，避免编码代理会话里
 * 90%+ 的工具消息各自成卡，把时间线刷成整排"工具结果"。
 */
function buildTurnTimeline(messages: Message[]): TurnEntry[] {
  const turns: TurnEntry[] = []
  let current: TurnEntry | null = null

  for (const msg of messages) {
    if (msg.role === 'user') {
      // 只有真实 text 块才开启新轮；userMessageText 的回退标签（工具结果…）不算正文
      if (getFirstText(msg.content) || !current) {
        current = {
          id: msg.id,
          userMsg: msg,
          assistantMsgs: [],
          assistantPreview: '',
          turnMsgCount: 1,
          turnTokens: msg.tokensUsed || 0,
          toolCount: 0,
        }
        turns.push(current)
      } else {
        current.turnMsgCount += 1
        current.turnTokens += msg.tokensUsed || 0
        current.toolCount += 1
      }
    } else if (msg.role === 'assistant' && current) {
      current.assistantMsgs.push(msg)
      current.turnMsgCount += 1
      current.turnTokens += msg.tokensUsed || 0
    }
  }

  for (const t of turns) {
    t.assistantPreview = t.assistantMsgs.length > 0 ? turnPreview(t.assistantMsgs) : ''
  }

  return turns.reverse()
}

export function HistoryView() {
  const { conversations, activeConversationId } = useChatStore()
  const activeConv = conversations.find(c => c.id === activeConversationId)
  const messages = activeConv?.messages || []

  const turns = useMemo(() => buildTurnTimeline(messages), [messages])

  const totalUser = useMemo(() => messages.filter(m => m.role === 'user').length, [messages])
  const totalAssistant = useMemo(() => messages.filter(m => m.role === 'assistant').length, [messages])
  const totalTokens = useMemo(() => messages.reduce((s, m) => s + (m.tokensUsed || 0), 0), [messages])
  const totalTurns = turns.length

  if (!activeConversationId || !activeConv) {
    return (
      <div className="flex flex-col h-full min-h-0 items-center justify-center p-4">
        <Clock className="w-8 h-8 text-tertiary mb-2 opacity-30" />
        <p className="text-xs text-tertiary text-center">
          {conversations.length === 0
            ? '暂无对话。在 Chats 标签页新建对话开始。'
            : '请在 Chats 标签页选择一个对话查看其时间线。'}
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Compact stats bar */}
      <div className="shrink-0 px-3 py-2 border-b">
        <div className="flex items-center gap-1 text-[10px] text-tertiary">
          <MessageSquare className="w-3 h-3" />
          <span className="truncate flex-1 font-medium text-secondary">{activeConv.title}</span>
        </div>
        <div className="flex gap-3 mt-1 text-[10px]">
          <span className="text-tertiary"><User className="w-3 h-3 inline mr-0.5 -mt-0.5" />{totalUser}</span>
          <span className="text-tertiary"><Bot className="w-3 h-3 inline mr-0.5 -mt-0.5" />{totalAssistant}</span>
          <span className="text-tertiary">{totalTokens.toLocaleString()} tokens</span>
          <span className="text-tertiary">{totalTurns} 轮</span>
        </div>
      </div>

      {/* Timeline */}
      <div className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <div className="p-3">
            {turns.length === 0 ? (
              <div className="py-8 text-center text-tertiary text-xs">
                <Clock className="w-6 h-6 mx-auto mb-1 opacity-30" />
                <p>暂无消息</p>
                <p className="text-tertiary mt-0.5">发送第一条消息后在此查看时间线</p>
              </div>
            ) : (
              <div className="relative pl-6">
                <div className="absolute left-[11px] top-2 bottom-2 w-px bg-input" />

                {turns.map((turn, idx) => (
                  <div key={turn.id} className="relative pb-5 last:pb-0">
                    {/* Dot */}
                    <div className={cn(
                      'absolute -left-[17px] top-1.5 w-2.5 h-2.5 rounded-full border-2 transition-colors',
                      idx === 0
                        ? 'bg-brand-500 border-brand-500'
                        : 'bg-elevated border group-hover:border-brand-500'
                    )} />

                    {/* Time */}
                    <div className="text-[10px] text-tertiary mb-0.5 font-mono">
                      {formatDate(turn.userMsg.timestamp)}
                      {turn.toolCount > 0 && (
                        <span className="ml-2 text-tertiary/60">工具 ×{turn.toolCount}</span>
                      )}
                      {turn.turnTokens > 0 && (
                        <span className="ml-2 text-tertiary/60">{turn.turnTokens.toLocaleString()} tok</span>
                      )}
                    </div>

                    {/* Turn card */}
                    <div
                      className="rounded-md bg-elevated/50 px-2.5 py-1.5 cursor-pointer hover:bg-elevated transition-colors"
                      onClick={() => scrollToMessage(turn.userMsg.id)}
                    >
                      {/* User input */}
                      <div className="flex items-start gap-1.5">
                        <User className="w-3 h-3 mt-0.5 text-brand-500/60 shrink-0" />
                        <div className="text-xs text-primary line-clamp-2 leading-relaxed flex-1 min-w-0">
                          {userMessageText(turn.userMsg.content).slice(0, 150) || '(空消息)'}
                        </div>
                      </div>

                      {/* Assistant response preview */}
                      {turn.assistantPreview && (
                        <div className="flex items-start gap-1.5 mt-1">
                          <Bot className="w-3 h-3 mt-0.5 text-success/60 shrink-0" />
                          <div className="text-[11px] text-secondary line-clamp-2 leading-relaxed flex-1 min-w-0">
                            {turn.assistantPreview}
                          </div>
                          {turn.assistantMsgs.length > 1 && (
                            <span className="text-[10px] text-tertiary shrink-0">
                              +{turn.assistantMsgs.length - 1}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
