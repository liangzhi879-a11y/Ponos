import { FolderOpen } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Badge } from '@/components/ui'
import { useChatStore } from '@/stores/chatStore'
import { useAgentStore } from '@/stores/agentStore'
import { useUIStore } from '@/stores/uiStore'
import { getAgentById } from '@/lib/agents'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import type { SubAgentTask } from '@/types'

const STATUS_META: Record<SubAgentTask['status'], { label: string; variant: 'success' | 'danger' | 'warning' | 'default' }> = {
  running: { label: '运行中', variant: 'warning' },
  completed: { label: '完成', variant: 'success' },
  failed: { label: '失败', variant: 'danger' },
  stopped: { label: '已停止', variant: 'default' },
}

function fmtMs(ms: number): string {
  if (!ms) return ''
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${s % 60}s`
}

function fmtMeta(task: SubAgentTask): string {
  const parts: string[] = []
  if (task.toolUseCount > 0) parts.push(`${task.toolUseCount} 工具`)
  if (task.tokenCount > 0) parts.push(`${task.tokenCount} tokens`)
  if (task.durationMs > 0) parts.push(fmtMs(task.durationMs))
  return parts.join(' · ')
}

interface CardProps {
  task: SubAgentTask
}

/**
 * 完成态结果卡（原型状态 B）：head（agent 名 + 状态徽章 + meta）
 * + body（markdown 保留格式渲染）+ foot（summary + 输出文件）。
 * 卡片始终展开——结果本身就是要给用户看的内容，无需折叠。
 */
function SubAgentCard({ task }: CardProps) {
  const agents = useAgentStore(s => s.agents)
  const agent = getAgentById(agents, task.name) ?? { avatar: undefined, name: task.name }
  const setPreviewFile = useUIStore(s => s.setPreviewFile)
  const meta = STATUS_META[task.status]
  const metaText = fmtMeta(task)
  return (
    <div className="rounded-xl border border overflow-hidden bg-surface/80 shadow-sm">
      {/* head */}
      <div className="flex items-center gap-2 px-3.5 py-2 border-b border-subtle">
        <AgentAvatar agent={agent} size={18} />
        <span className="text-xs font-medium text-primary">{task.name}</span>
        <Badge variant={meta.variant}>{meta.label}</Badge>
        {metaText && (
          <span className="text-[10px] text-tertiary ml-auto shrink-0">{metaText}</span>
        )}
      </div>
      {/* body：markdown 保留格式 */}
      {(task.summary || task.prompt) && (
        <div className="px-3.5 py-2.5 text-[12px] leading-relaxed">
          {task.summary && (
            <div className="break-words [overflow-wrap:break-word] [word-break:break-word]">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  pre({ children }) {
                    return <>{children}</>
                  },
                  code({ className, children, ...props }) {
                    const match = /language-(\w+)/.exec(className || '')
                    const isInline = !match && !className
                    if (isInline) {
                      return <code className="bg-elevated px-1 py-0.5 rounded text-[0.85em] text-brand-500/85 font-mono break-all [overflow-wrap:anywhere]" {...props}>{children}</code>
                    }
                    return <pre className="bg-elevated border border rounded-lg px-3 py-2 my-1.5 overflow-x-auto text-[11px] font-mono text-secondary whitespace-pre-wrap break-all [overflow-wrap:anywhere]">{children}</pre>
                  },
                  h1({ children }) { return <h1 className="text-sm font-bold mt-2 mb-1 text-primary">{children}</h1> },
                  h2({ children }) { return <h2 className="text-sm font-bold mt-2 mb-1 text-primary">{children}</h2> },
                  h3({ children }) { return <h3 className="text-xs font-semibold mt-1.5 mb-0.5 text-primary">{children}</h3> },
                  ul({ children }) { return <ul className="list-disc pl-4 my-1 space-y-0.5">{children}</ul> },
                  ol({ children }) { return <ol className="list-decimal pl-4 my-1 space-y-0.5">{children}</ol> },
                  p({ children }) { return <p className="my-1 leading-relaxed">{children}</p> },
                  strong({ children }) { return <strong className="font-semibold text-primary">{children}</strong> },
                  a({ href, children }) {
                    return <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent hover:text-accent/80 underline underline-offset-2">{children}</a>
                  },
                  table({ children }) {
                    return <div className="overflow-x-auto my-2 max-w-full"><table className="min-w-full border-collapse border text-xs">{children}</table></div>
                  },
                  th({ children }) {
                    return <th className="border border bg-elevated px-2 py-1 text-left font-semibold">{children}</th>
                  },
                  td({ children }) {
                    return <td className="border border px-2 py-1">{children}</td>
                  },
                }}
              >
                {task.summary}
              </ReactMarkdown>
            </div>
          )}
          {!task.summary && task.prompt && (
            <p className="text-secondary whitespace-pre-wrap break-all [overflow-wrap:anywhere]">{task.prompt}</p>
          )}
        </div>
      )}
      {/* foot：summary 落款 + 输出文件 */}
      {(task.outputFile) && (
        <div className="flex items-center gap-3 px-3.5 py-1.5 border-t border-subtle bg-elevated/40">
          <button
            className="inline-flex items-center gap-1 text-[11px] text-accent hover:text-accent/80 cursor-pointer"
            onClick={() => setPreviewFile({ path: task.outputFile!, name: task.outputFile!.split(/[/\\]/).pop() || task.outputFile! })}
          >
            <FolderOpen className="w-3 h-3" />
            <span className="break-all [overflow-wrap:anywhere]">{task.outputFile}</span>
          </button>
        </div>
      )}
    </div>
  )
}

interface Props {
  conversationId: string
  /** 只展示 toolUseId 命中的任务；缺省时展示该会话全部任务（单面板场景） */
  toolUseIds?: string[]
}

export function SubAgentPanel({ conversationId, toolUseIds }: Props) {
  const tasks = useChatStore(s => s.subAgentTasks[conversationId])
  if (!tasks || tasks.length === 0) return null
  // 嵌入面板只承接终态任务：运行中的任务由底部 RunningAgentsBar 悬浮展示，
  // 完成后插回触发消息下方（不占用消息流以外的区域）。
  const visibleTasks = toolUseIds
    ? tasks.filter(t => t.status !== 'running' && !!t.toolUseId && toolUseIds.includes(t.toolUseId))
    : tasks.filter(t => t.status !== 'running')
  if (visibleTasks.length === 0) return null
  return (
    // 嵌入消息内容流内：与工具块同宽（不再带消息级留白），插在 Agent tool_use
    // 之后、工具结果之前。
    <div className="my-1.5 space-y-1.5 min-w-0 overflow-hidden">
      {visibleTasks.map(task => (
        <SubAgentCard key={task.taskId} task={task} />
      ))}
    </div>
  )
}
