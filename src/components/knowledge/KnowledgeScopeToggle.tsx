// src/components/knowledge/KnowledgeScopeToggle.tsx —— 「全部空间 / 本空间」二选一（S2 Task 7-8 共用）
//
// 检索与图谱都吃「跨空间 or 只看当前空间」这一个开关（`spaces=` / `space=` 参数）。抽成组件而不是
// 各写一遍：两处文案/视觉要完全一致（用户会把它当成同一个概念），且都只有十几行，重复两遍
// 迟早漂移成"一边能切一边不能"。
//
// 为什么默认全库（scopeAll=true，由调用方决定）：知识库的价值就在**跨空间**召回——
// 经验空间的一条经验往往要回答产品空间里的问题；默认锁在单空间会让"搜不到"成为误解。
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/useTranslation'

export interface KnowledgeScopeToggleProps {
  /** true = 全部空间；false = 仅当前空间 */
  all: boolean
  onChange: (all: boolean) => void
  className?: string
}

export function KnowledgeScopeToggle({ all, onChange, className }: KnowledgeScopeToggleProps) {
  const { t } = useTranslation()
  const options: Array<{ value: boolean; label: string }> = [
    { value: false, label: t('knowledge.scopeSpace') },
    { value: true, label: t('knowledge.scopeAll') },
  ]
  return (
    <div className={cn('flex items-center gap-0.5 shrink-0', className)} role="group" aria-label={t('knowledge.scopeAll')}>
      {options.map(o => (
        <button
          key={String(o.value)}
          type="button"
          aria-pressed={all === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            // clip-sm 只裁剪轮廓（不吃底色），激活态才能显示 bg-active；切角是本仓库设计语言
            'clip-sm px-1.5 py-0.5 text-[10px] transition-colors',
            all === o.value ? 'bg-active text-primary' : 'text-tertiary hover:text-secondary hover:bg-hover',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
