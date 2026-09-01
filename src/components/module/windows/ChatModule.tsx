// src/components/module/windows/ChatModule.tsx
// 聊天模块窗口（?module=chat&conversation=<id>）。
// 该窗口持有内核 WS 连接（usePonosCLI 模块级单例），任务/提问/审批事件
// 经 StateBus 发布到 dock 气泡。
import { useEffect } from 'react'
import { TooltipProvider } from '@/components/ui'
import { ChatWindow } from '@/components/chat/ChatWindow'
import { ChatInput } from '@/components/chat/ChatInput'
import QuestionCard from '@/components/chat/QuestionCard'
import { useChatStore } from '@/stores/chatStore'
import { getModuleParam } from '@/lib/moduleBridge'
import { sendAnswer, dismissQuestion, usePonosCLI } from '@/hooks/usePonosCLI'

/**
 * 聊天模块窗口（?module=chat&conversation=<id>）。
 * 该窗口持有内核 WS 连接（usePonosCLI 模块级单例），任务/提问/审批事件
 * 经 StateBus 发布到 dock 气泡。
 */
export function ChatModule() {
  const conversationId = getModuleParam('conversation')
  const { activeConversationId, createConversation, setActiveConversation, pendingQuestions, clearPendingQuestion } = useChatStore()

  // 无 conversation 参数 → 激活/新建会话
  useEffect(() => {
    if (!conversationId) {
      if (!activeConversationId) createConversation()
    } else {
      setActiveConversation(conversationId)
    }
  }, [conversationId])  // eslint-disable-line react-hooks/exhaustive-deps

  const sid = conversationId || activeConversationId
  const pendingQuestion = sid ? pendingQuestions[sid] : undefined
  usePonosCLI() // 确保 WS 连接建立

  return (
    <TooltipProvider>
      <div className="h-full flex flex-col bg-app text-primary">
        {sid ? (
          <>
            <ChatWindow conversationId={sid} />
            {pendingQuestion && (
              <div className="px-3 flex justify-center">
                <QuestionCard
                  key={`${sid}:${pendingQuestion.questions.map(q => `${q.id}|${q.question.slice(0, 24)}`).join('&') || 'raw'}`}
                  payload={pendingQuestion}
                  onAnswer={(response) => {
                    sendAnswer(sid, response.answers, response.notes)
                    clearPendingQuestion(sid)
                  }}
                  onDismiss={() => {
                    clearPendingQuestion(sid)
                    dismissQuestion(sid)
                  }}
                />
              </div>
            )}
            <ChatInput conversationId={sid} />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-tertiary text-sm">创建会话中…</div>
        )}
      </div>
    </TooltipProvider>
  )
}
