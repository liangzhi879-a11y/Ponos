// 工具内联卡片（2026-09-09 会话 UI 标准化）：assistant-ui tool-call part 渲染器。
// 状态机：running（执行中）/ 完成（有 result）/ 失败（isError 或 incomplete）。
// 参数与结果独立折叠（>500 字符默认折叠），随消息流内嵌，不再堆积会话底部。
import { useState } from 'react'
import { Wrench, ChevronDown, ChevronRight, CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import { useToolCallElapsed } from '@assistant-ui/react'
import { SubAgentPanel } from './SubAgentPanel'
import { ChatContext } from './MarkdownText'
import { useContext } from 'react'
import { useTranslation } from '@/i18n/useTranslation'
import { cn } from '@/lib/utils'

export function ToolCallCard(props: ToolCallMessagePartProps) {
  const { toolName, args, argsText, result, isError, status, toolCallId } = props
  const { t } = useTranslation()
  const { conversationId } = useContext(ChatContext)
  const elapsed = useToolCallElapsed()

  const argsJson = argsText || JSON.stringify(args ?? {}, null, 2)
  const resultText = typeof result === 'string' ? result : result != null ? JSON.stringify(result, null, 2) : ''
  // live 时序：tool_use 先到（无 result）→ tool_result 回填。无结果且未失败
  // 即视为执行中（含 result 尚未回传的窗口），避免闪现"完成"误标。
  const running = (status.type === 'running' || (resultText === '' && status.type !== 'incomplete')) && isError !== true
  const failed = isError === true || status.type === 'incomplete'

  const [openArgs, setOpenArgs] = useState<boolean | null>(null)
  const [openResult, setOpenResult] = useState<boolean | null>(null)
  const argsOpen = openArgs !== null ? openArgs : argsJson.length <= 500
  const resultOpen = openResult !== null ? openResult : resultText.length > 0 && resultText.length <= 800

  return (
    // 2026-09-11 设计语言统一：工具卡容器 rounded-lg → 单对角切角（ci 内层承载底/边）
    <div className="my-1.5 cut-sm">
      <div className="ci overflow-hidden !bg-elevated/30">
      {/* 头部：工具名 + 状态徽标 + 耗时 */}
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Wrench className="w-3.5 h-3.5 text-secondary/70 shrink-0" />
        <span className="text-xs font-mono font-medium text-secondary">{toolName}</span>
        {running ? (
          <span className="inline-flex items-center gap-1 text-[10px] text-brand-500">
            <Loader2 className="w-3 h-3 animate-spin" />
            {t('chat.toolRunning')}
          </span>
        ) : failed ? (
          <span className="inline-flex items-center gap-1 text-[10px] text-danger">
            <XCircle className="w-3 h-3" />
            {t('chat.toolFailed')}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[10px] text-success">
            <CheckCircle2 className="w-3 h-3" />
            {t('chat.toolDone')}
          </span>
        )}
        {elapsed != null && !running && (
          <span className="text-[10px] text-tertiary/70 font-mono">{elapsed}s</span>
        )}
        <button
          type="button"
          onClick={() => setOpenArgs(!argsOpen)}
          className="ml-auto inline-flex items-center gap-0.5 text-[10px] text-tertiary hover:text-secondary transition-colors"
        >
          {t('chat.toolArgs')}
          {argsOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </button>
        {resultText && (
          <button
            type="button"
            onClick={() => setOpenResult(!resultOpen)}
            className={cn('inline-flex items-center gap-0.5 text-[10px] transition-colors', failed ? 'text-danger hover:text-danger/80' : 'text-tertiary hover:text-secondary')}
          >
            {t('chat.toolResult')}
            {resultOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </button>
        )}
      </div>

      {/* Agent 工具：嵌入子任务面板（终态任务承接，运行中由底部悬浮条展示） */}
      {toolName === 'Agent' && toolCallId && (
        <SubAgentPanel conversationId={conversationId} toolUseIds={[toolCallId]} />
      )}

      {/* 参数（流式 argsText 或静态 JSON） */}
      {argsOpen && (
        <pre className="px-3 pb-2 pt-1 border-t border-subtle text-[11px] font-mono text-tertiary/90 whitespace-pre-wrap break-all max-h-64 overflow-y-auto">
          {argsJson}
        </pre>
      )}

      {/* 结果（失败红框） */}
      {resultOpen && resultText && (
        <pre className={cn(
          'px-3 pb-2 pt-1 border-t border-subtle text-[11px] font-mono whitespace-pre-wrap break-all max-h-72 overflow-y-auto',
          failed ? 'text-danger/90' : 'text-tertiary/90',
        )}>
          {resultText}
        </pre>
      )}
      </div>
    </div>
  )
}
