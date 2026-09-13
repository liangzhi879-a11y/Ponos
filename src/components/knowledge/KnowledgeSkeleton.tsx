// src/components/knowledge/KnowledgeSkeleton.tsx —— 知识面板骨架屏（**自写**）
//
// spec §6 原型里的 `.shimmer` / `--shimmer` **在本仓库不存在**（globals.css:153 只有
// `@keyframes shimmer`，全 src/ 零消费点，见 spec §11.1）→ 不照抄原型，改用
// 「切角块（.cut-sm）+ 内层 .ci 承载 animate-pulse」这套既有设计语言：
//   · 切角块让它一眼属于本仓库的视觉体系，而不是通用灰条；
//   · animate-pulse 是 Tailwind 内置（非自创光效，不触光效白名单）；
//   · 宽度用**固定循环序列**而非 Math.random()——渲染纯函数、四主题截图可复现（走查需要稳定画面）。
import { useTranslation } from '@/i18n/useTranslation'
import { cn } from '@/lib/utils'

/** 宽度循环：视觉上长短交错即可，不需要随机（见文件头注释） */
const WIDTHS = ['w-full', 'w-11/12', 'w-4/5', 'w-2/3', 'w-5/6', 'w-3/5']

export interface KnowledgeSkeletonProps {
  /** 行数（默认 6：覆盖一屏正文的观感又不至于太长） */
  lines?: number
  className?: string
}

export function KnowledgeSkeleton({ lines = 6, className }: KnowledgeSkeletonProps) {
  const { t } = useTranslation()
  return (
    // aria-busy + label：加载态对读屏可见（视觉上是灰条，无语义）
    <div className={cn('px-3 py-3 space-y-1.5', className)} aria-busy="true" aria-label={t('common.loading')}>
      {Array.from({ length: Math.max(1, lines) }, (_, i) => (
        <div key={i} className="cut-sm">
          <div className="ci px-2 py-1.5">
            <div className={cn('h-2.5 animate-pulse bg-hover', WIDTHS[i % WIDTHS.length])} />
          </div>
        </div>
      ))}
    </div>
  )
}
