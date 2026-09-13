// src/components/knowledge/KnowledgeToolbar.tsx —— 知识面板头部
//
// 与 rail 其它面板的头部同构（PanelToolbar.tsx：h-9 + border-b + `.micro` 装饰微标 +
// 右侧 `.cut-xs` 切角图标钮），但**没有直接复用 PanelToolbar 组件**，原因有三：
//   1) PanelToolbar 的 `count` 只吃一个数字；知识面板要并排显示"文档 / 块"两个计数；
//   2) 主操作钮需要 disabled（只读空间无新建）与 loading 态（转圈），PanelToolbar 的接口没有；
//   3) 它的标题槽是单个字符串，塞不下"空间名 + 只读徽标"。
// 强行扩 PanelToolbar 的接口会牵动 chat/task 两个既有面板——所以只沿用其**结构与类名规格**。
import { Library, RefreshCw } from 'lucide-react'
import { Button, Tooltip } from '@/components/ui'
import { useTranslation } from '@/i18n/useTranslation'
import { cn } from '@/lib/utils'

export interface KnowledgeToolbarProps {
  /** 当前空间显示名（未选空间传 null → 显示「未选择空间」） */
  spaceName: string | null
  /** 当前空间是否只读（true 时标题旁挂 .micro 标） */
  readonly?: boolean
  /** 统计数据（来自 useStats；未加载完传 undefined，不显示占位数字避免跳动） */
  stats?: { docs: number; blocks: number }
  loading?: boolean
  onRefresh: () => void
}

export function KnowledgeToolbar({ spaceName, readonly = false, stats, loading = false, onRefresh }: KnowledgeToolbarProps) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-1.5 px-2 h-9 border-b border-default shrink-0 bg-app">
      {/* 图标与 rail 图标保持同一个语义（Library），让"我在哪"一眼可认 */}
      <Library className="w-[13px] h-[13px] text-secondary shrink-0" />
      <span className="text-xs font-semibold text-primary shrink-0">{t('knowledge.title')}</span>
      <span className="flex-1 min-w-0 truncate text-[11px] text-tertiary">
        {spaceName ?? t('knowledge.spaceNone')}
      </span>
      {readonly && <span className="micro shrink-0">{t('knowledge.readonly')}</span>}
      {stats && (
        <span className="text-[10px] text-tertiary tabular-nums shrink-0">
          {stats.docs} {t('knowledge.statDocs')} · {stats.blocks} {t('knowledge.statBlocks')}
        </span>
      )}
      <Tooltip content={t('knowledge.actionRefresh')} side="bottom">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('knowledge.actionRefresh')}
          onClick={onRefresh}
          disabled={loading}
          // 与 PanelToolbar 的新建钮同规格：6px 单对角切角细线框（.cut-xs + 内层 .ci）
          className="cut-xs shrink-0 !h-[22px] !w-[22px] hover:text-primary"
        >
          <span className="ci !bg-transparent flex items-center justify-center w-full h-full">
            <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} />
          </span>
        </Button>
      </Tooltip>
    </div>
  )
}
