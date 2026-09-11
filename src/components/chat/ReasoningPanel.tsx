// 思考折叠块（2026-09-09 会话 UI 标准化）：assistant-ui reasoning part 渲染器。
// 流式（status running）自动展开、结束自动收起；用户手动点按后以手动状态为准。
import { useState } from 'react'
import { Brain, ChevronDown, ChevronRight } from 'lucide-react'
import type { ReasoningMessagePartProps } from '@assistant-ui/react'
import { useTranslation } from '@/i18n/useTranslation'
import { cn } from '@/lib/utils'

export function ReasoningPanel({ status, text }: ReasoningMessagePartProps) {
  const { t } = useTranslation()
  const running = status.type === 'running'
  const [manual, setManual] = useState<boolean | null>(null)
  const open = manual !== null ? manual : running

  return (
    // 2026-09-11 设计语言统一：思考块容器 rounded-lg → 单对角切角（ci 内层承载底/边）
    <div className="my-1.5 cut-sm">
      <div className="ci overflow-hidden !bg-elevated/40">
      <button
        type="button"
        onClick={() => setManual(!open)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-tertiary hover:bg-elevated transition-colors"
      >
        <Brain className={cn('w-3.5 h-3.5 text-brand-500/70 shrink-0', running && 'animate-pulse')} />
        <span className="font-medium">{running ? t('chat.thinking') : t('chat.thinkingDone')}</span>
        {running && (
          <span className="inline-block w-3 h-3 border border-brand-500/30 border-t-brand-500 rounded-full animate-spin" />
        )}
        <span className="ml-auto text-tertiary/60">
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-2 pt-2 border-t border-subtle text-xs text-tertiary/90 leading-relaxed whitespace-pre-wrap max-h-60 overflow-y-auto select-text">
          {text}
        </div>
      )}
      </div>
    </div>
  )
}
