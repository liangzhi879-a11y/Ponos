// src/components/knowledge/KnowledgeEmpty.tsx —— 知识面板统一空态
//
// 为什么单独一个组件：仓库既有空态是**内联惯例**（`py-8 text-center text-tertiary text-xs`，
// 见 FileBrowser.tsx:206），`ui/` 里没有 EmptyState（spec §11.1）。四视图 + 左栏一共 6~7 处空态，
// 内联复制会让"文案层级/间距"在后续任务里各写各的；这里把它封成最小组件，只吃 i18n 文案。
// 刻意不做图标/插画/操作按钮变体——YAGNI，真需要时再加 prop。
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface KnowledgeEmptyProps {
  /** 主文案（调用方已 t() 过的成品文案，组件内不查表） */
  title: string
  /** 次级说明（可选） */
  hint?: string
  /** 可选线性图标（禁 emoji，只收 lucide） */
  icon?: LucideIcon
  className?: string
}

export function KnowledgeEmpty({ title, hint, icon: Icon, className }: KnowledgeEmptyProps) {
  return (
    <div className={cn('py-8 px-4 text-center', className)}>
      {Icon && <Icon className="w-5 h-5 mx-auto mb-2 text-tertiary opacity-70" />}
      <p className="text-xs text-tertiary">{title}</p>
      {hint && <p className="mt-1 text-[11px] text-tertiary opacity-70">{hint}</p>}
    </div>
  )
}
