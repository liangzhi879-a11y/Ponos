// src/components/knowledge/KnowledgeEntryCard.tsx —— 经验条目卡片（S2 Task 5）
//
// 只在 `tag !== null` 时被 KnowledgeDocView 渲染：判定在 lib/knowledgeBlocks.ts 的
// isEntryCard()，那条是 S1 §11.4 的硬约束（`- [ ] Step N` 会被内核判成 entry，但不是经验）。
//
// 摘要常显、全文按需展开：内核 parseEntryLine（shared/knowledge-core.mjs:41-54）把
// `- [tag] 摘要 -- 全文` 拆成两段——摘要用于扫读，全文展开后才出现，避免少数长条目把阅读流冲散。
// 无 ` -- ` 的条目 summary === full，此时**不显示展开钮**（点了没有任何变化，看着像按钮坏了）。
import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useTranslation } from '@/i18n/useTranslation'

export interface KnowledgeEntryCardProps {
  tag: string
  summary: string
  full?: string | null
  /** 源文件行号 → data-line 锚点（检索/大纲跳转定位用） */
  line?: number
  /** 是否为目标定位块：仅把切角外框的 1px 细线点亮为品牌色（不动光效——白名单之外一律不用） */
  active?: boolean
}

export function KnowledgeEntryCard({ tag, summary, full, line, active = false }: KnowledgeEntryCardProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const body = String(full ?? '').trim()
  const expandable = body !== '' && body !== summary.trim()

  return (
    // 切角卡：外层 .cut-sm 只当 1px 细线（默认 --border-default），内容放内层 >.ci（globals.css:841-846）
    <div className="cut-sm" data-line={line} style={active ? { background: 'var(--accent-default)' } : undefined}>
      <div className="ci px-2.5 py-2">
        <div className="flex items-center gap-1.5">
          <span className="clip-sm bg-brand-500/15 px-1.5 py-px text-[10px] font-medium text-brand-500">{tag}</span>
          {expandable && (
            <button
              type="button"
              onClick={() => setOpen(v => !v)}
              aria-expanded={open}
              className="ml-auto flex items-center gap-0.5 text-[10px] text-tertiary hover:text-secondary transition-colors"
            >
              {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              {open ? t('knowledge.entryCollapse') : t('knowledge.entryExpand')}
            </button>
          )}
        </div>
        <p className="mt-1 text-xs leading-relaxed text-primary break-words [overflow-wrap:anywhere]">{summary}</p>
        {expandable && open && (
          <p className="mt-1.5 border-t border-default pt-1.5 text-[11px] leading-relaxed text-secondary whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
            {body}
          </p>
        )}
      </div>
    </div>
  )
}
