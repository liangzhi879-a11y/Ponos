import { useChatStore } from '@/stores/chatStore'
import { useAgentStore } from '@/stores/agentStore'
import { getAgentById } from '@/lib/agents'
import { AgentAvatar } from '@/components/agents/AgentAvatar'

interface Props {
  conversationId: string
}

/**
 * 运行中子 Agent 悬浮条（原型状态 A）：钉在消息区底部（输入框上方），
 * 不占消息流滚动空间；任务进入终态后自动消失——完成态由嵌入在触发消息
 * 下方的 SubAgentPanel 结果卡承接（状态 B）。
 */
export function RunningAgentsBar({ conversationId }: Props) {
  const tasks = useChatStore(s => s.subAgentTasks[conversationId])
  const agents = useAgentStore(s => s.agents)
  if (!tasks) return null
  const running = tasks.filter(t => t.status === 'running')
  if (running.length === 0) return null
  return (
    <div className="absolute bottom-0 left-0 right-0 z-20 flex flex-col items-center px-4 pb-3 pointer-events-none">
      <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-1.5 max-w-[900px]">
        {running.map(t => {
          const agent = getAgentById(agents, t.name) ?? { avatar: undefined, name: t.name }
          return (
            <div
              key={t.taskId}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-brand-500/30 bg-elevated/90 shadow-lg backdrop-blur animate-slide-up"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-brand-500 shrink-0 animate-pulse" />
              <AgentAvatar agent={agent} size={16} />
              <span className="text-[11px] font-medium text-primary">{t.name}</span>
              <span className="text-[10px] text-tertiary truncate max-w-[200px]">
                · 当前：{t.lastToolName || '…'}
                {t.toolUseCount > 0 && ` · ${t.toolUseCount} 工具`}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
