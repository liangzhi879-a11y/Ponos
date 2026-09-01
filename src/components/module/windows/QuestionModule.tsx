// src/components/module/windows/QuestionModule.tsx
// 提问模块窗口（?module=question&conversation=<id>）：独立提问卡片。
// 内核提问到达 → 主进程自动打开本窗口展示 QuestionCard，回答/关闭后自动关窗。
// 取代聊天界面内嵌卡片（ChatModule/AppShell 不再内嵌 QuestionCard），不遮挡聊天内容。
import { useEffect } from 'react'
import { HelpCircle, X } from 'lucide-react'
import QuestionCard from '@/components/chat/QuestionCard'
import { useChatStore } from '@/stores/chatStore'
import { getModuleParam, closeModule } from '@/lib/moduleBridge'
import { sendAnswer, dismissQuestion, usePonosCLI } from '@/hooks/usePonosCLI'
import { useTranslation } from '@/i18n/useTranslation'

export function QuestionModule() {
  const conversationId = getModuleParam('conversation')
  const { pendingQuestions, clearPendingQuestion } = useChatStore()
  const { t } = useTranslation()
  // 建立 WS 连接：本窗口独立收 question 事件（写 chatStore.pendingQuestions）
  usePonosCLI()

  const sid = conversationId
  const pending = sid ? pendingQuestions[sid] : undefined

  // 提问已处理（回答/关闭）→ 自动关闭提问窗口
  useEffect(() => {
    if (sid && !pendingQuestions[sid]) {
      void closeModule('question')
    }
  }, [sid, pendingQuestions])

  return (
    <div className="h-full w-full flex flex-col bg-app text-primary overflow-hidden">
      {/* 头部 */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-subtle bg-toolbar/50 shrink-0">
        <HelpCircle size={15} className="text-warning" />
        <span className="text-sm font-semibold">{t('dock.questions')}</span>
        <button
          onClick={() => { if (sid) { clearPendingQuestion(sid); dismissQuestion(sid) } }}
          className="ml-auto text-tertiary hover:text-primary"
          aria-label="close"
        >
          <X size={15} />
        </button>
      </div>

      {/* 提问卡片主体 */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {!sid ? (
          <p className="text-xs text-tertiary text-center py-8">{t('dock.noQuestions')}</p>
        ) : !pending ? (
          <p className="text-xs text-tertiary text-center py-8">{t('dock.noQuestions')}</p>
        ) : (
          <QuestionCard
            key={`${sid}:${pending.questions.map(q => `${q.id}|${q.question.slice(0, 24)}`).join('&') || 'raw'}`}
            payload={pending}
            onAnswer={(response) => {
              sendAnswer(sid, response.answers, response.notes)
              clearPendingQuestion(sid)
            }}
            onDismiss={() => {
              clearPendingQuestion(sid)
              dismissQuestion(sid)
            }}
          />
        )}
      </div>
    </div>
  )
}
