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
import { createConversionCache, messageToThreadMessageLike, incrementalConvert } from './chatParts'
import type { Message } from '../types'

// 会话内所有消息的转换缓存：跨渲染/跨会话常驻（键是消息对象身份，不会串味），
// WeakMap ⇒ 消息被替换后旧条目随 GC 回收，无泄漏。
const threadCache = createConversionCache<Message, ThreadMessage>()

function appendText(app: AppendMessage): string {
  const content = app.content
  if (typeof content === 'string') return content
  return (content as TextMessagePart[])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

// 会话不存在时的兜底数组必须是**常量**：`?? []` 每次新建 ⇒ 选择器结果永不与上次相等
// （zustand 按 Object.is 比），"会话还没建好"期间的每一次 store 写入都会连坐本组件重渲染。
const EMPTY_MESSAGES: Message[] = []

export function ChatRuntimeProvider({ conversationId, children }: { conversationId: string; children: ReactNode }) {
  const messages = useChatStore((s) => {
    const conv = s.conversations.find((c) => c.id === conversationId)
    return conv?.messages ?? EMPTY_MESSAGES
  })
  const isRunning = useChatStore((s) => Boolean(s.streamingConversations[conversationId]))
  const { send } = useYFWCLI()

  // 转换在外部层完成，**按消息身份增量**（R3，2026-09-13）：流式每 chunk 只有被追加的那
  // 一条是新对象，其余 N-1 条直接复用上次结果（旧实现在每帧把所有消息重转一遍，N 随会话增长）。
  // fromThreadMessageLike 归一为严格 ThreadMessage（保留同 id，流式 mutate 稳定键）。
  // 2026-09-10 修复：此前全部消息标记 complete——流式消息被当成"已完成"，ReasoningPanel
  // 的 running 状态恒 false（思考块不自动展开、无进行态），assistant-ui 对 complete
  // 消息的流式渲染语义退化（观感为"消息内容不更新/思考不完整"）。流式期间最后一条
  // 消息标记 running。
  const threadMessages = useMemo(() => {
    // 状态按**位置**算，两处必须同源（statusKey 与真正构造的 status）——否则缓存会
    // 把"该翻成 complete 的最后一条"永远留在 running。
    const statusAt = (i: number) => ((isRunning && i === messages.length - 1) ? 'running' : 'complete')
    return incrementalConvert<Message, ThreadMessage>(
      messages,
      (_m, i) => statusAt(i),
      (m, i) => fromThreadMessageLike(
        { ...messageToThreadMessageLike(m), id: m.id },
        m.id || `msg-${i}`,
        statusAt(i) === 'running' ? { type: 'running' } : { type: 'complete', reason: 'unknown' },
      ),
      threadCache,
    )
  }, [messages, isRunning])

  const runtime = useExternalStoreRuntime({
    messages: threadMessages,
    isRunning,
    onNew: async (app) => { send(conversationId, appendText(app)) },
  })

  return createElement(AssistantRuntimeProvider, { runtime }, children)
}
