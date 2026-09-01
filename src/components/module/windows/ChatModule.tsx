// src/components/module/windows/ChatModule.tsx
// 聊天模块窗口（?module=chat&conversation=<id>）。
// 该窗口持有内核 WS 连接（usePonosCLI 模块级单例），任务/提问/审批事件
// 经 StateBus 发布到 dock 气泡。
// 提问卡片不再内嵌在聊天界面（统一走独立提问窗口 QuestionModule），
// 聊天窗口只保留消息流 + 输入框，不遮挡内容。
import { useEffect } from 'react'
import { TooltipProvider } from '@/components/ui'
import { ChatWindow } from '@/components/chat/ChatWindow'
import { ChatInput } from '@/components/chat/ChatInput'
import { useChatStore } from '@/stores/chatStore'
import { getModuleParam } from '@/lib/moduleBridge'
import { usePonosCLI } from '@/hooks/usePonosCLI'

/**
 * 聊天模块窗口（?module=chat&conversation=<id>）。
 * 该窗口持有内核 WS 连接（usePonosCLI 模块级单例），任务/提问/审批事件
 * 经 StateBus 发布到 dock 气泡；提问由独立 QuestionModule 窗口展示。
 */
export function ChatModule() {
  const conversationId = getModuleParam('conversation')
  const isNew = getModuleParam('new') === '1'
  const { activeConversationId, createConversation, setActiveConversation } = useChatStore()

  // 无 conversation 参数 → 激活/新建会话；new=1 → 强制新建会话
  useEffect(() => {
    if (isNew) {
      createConversation()
    } else if (!conversationId) {
      if (!activeConversationId) createConversation()
    } else {
      setActiveConversation(conversationId)
    }
  }, [conversationId])  // eslint-disable-line react-hooks/exhaustive-deps

  const sid = conversationId || activeConversationId
  usePonosCLI() // 确保 WS 连接建立

  return (
    <TooltipProvider>
      <div className="h-full flex flex-col bg-app text-primary">
        {sid ? (
          <>
            <ChatWindow conversationId={sid} />
            <ChatInput conversationId={sid} />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-tertiary text-sm">创建会话中…</div>
        )}
      </div>
    </TooltipProvider>
  )
}
