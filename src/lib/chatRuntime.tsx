// assistant-ui 运行时桥（2026-09-09 会话 UI 标准化）
// ---------------------------------------------------------------------------
// 用 useExternalStoreRuntime 把现有 chatStore（zustand）桥接为 assistant-ui 的
// Thread 运行时：消息数组来自 chatStore 当前会话，流式期间每条消息同 id 原地
// mutate（append 语义）——assistant-ui 官方外部存储模式。
// onNew 接现有发送链路（useYFWCLI.send），保持 Composer 语义可用（虽然本应用
// 输入条是自研 ChatInput 直发，onNew 仅作库级兜底）。
import { createElement, useMemo, type ReactNode } from 'react'
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  fromThreadMessageLike,
  type AppendMessage,
  type TextMessagePart,
  type ThreadMessage,
} from '@assistant-ui/react'
import { useChatStore } from '../stores/chatStore'
import { useYFWCLI } from '../hooks/useYFWCLI'
import { messagesToThreadMessageLikes } from './chatParts'

function appendText(app: AppendMessage): string {
  const content = app.content
  if (typeof content === 'string') return content
  return (content as TextMessagePart[])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

export function ChatRuntimeProvider({ conversationId, children }: { conversationId: string; children: ReactNode }) {
  const messages = useChatStore((s) => {
    const conv = s.conversations.find((c) => c.id === conversationId)
    return conv?.messages ?? []
  })
  const isRunning = useChatStore((s) => Boolean(s.streamingConversations[conversationId]))
  const { send } = useYFWCLI()

  // 转换在外部层完成（消息引用不变时 useMemo 命中缓存；流式每 chunk 新引用触发重算）。
  // fromThreadMessageLike 归一为严格 ThreadMessage（保留同 id，流式 mutate 稳定键）。
  // 2026-09-10 修复：此前全部消息标记 complete——流式消息被当成"已完成"，ReasoningPanel
  // 的 running 状态恒 false（思考块不自动展开、无进行态），assistant-ui 对 complete
  // 消息的流式渲染语义退化（观感为"消息内容不更新/思考不完整"）。流式期间最后一条
  // 消息标记 running。
  const threadMessages = useMemo(
    () => {
      const likes = messagesToThreadMessageLikes(messages)
      const lastIdx = likes.length - 1
      return likes.map((m, i) =>
        fromThreadMessageLike(m, (m as { id?: string }).id || `msg-${i}`,
          (isRunning && i === lastIdx) ? { type: 'running' } : { type: 'complete', reason: 'unknown' }),
      )
    },
    [messages, isRunning],
  ) as ThreadMessage[]

  const runtime = useExternalStoreRuntime({
    messages: threadMessages,
    isRunning,
    onNew: async (app) => { send(conversationId, appendText(app)) },
  })

  return createElement(AssistantRuntimeProvider, { runtime }, children)
}
