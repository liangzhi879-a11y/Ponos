import { useState } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ThinkingBlockProps {
  content: string
  collapsed?: boolean
}

export function ThinkingBlock({ content, collapsed: initialCollapsed = true }: ThinkingBlockProps) {
  const [collapsed, setCollapsed] = useState(initialCollapsed)

  return (
    <div className="my-2 relative rounded-lg border border bg-elevated/40 overflow-hidden">
      {/* Subtle brand accent strip on the left — keeps the "thinking"
          identity without a loud full border. */}
      <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-brand-500/50" />

      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-2 pl-3 pr-3 py-1.5 text-xs font-medium text-secondary hover:bg-hover hover:text-primary transition-colors"
      >
        <Brain className="w-3.5 h-3.5 text-brand-500" />
        <span>Thinking</span>
        <ChevronRight
          className={cn(
            'w-3.5 h-3.5 ml-auto text-tertiary transition-transform duration-150',
            !collapsed && 'rotate-90 text-secondary'
          )}
        />
      </button>

      {!collapsed && (
        <div className="pl-3 pr-3 py-2 border-t text-xs text-tertiary leading-relaxed whitespace-pre-wrap animate-slide-down">
          {content}
        </div>
      )}
    </div>
  )
}
