// src/components/rail/PanelToolbar.tsx —— rail 面板通用头部（Task 10）
// 结构：标题 + 计数 ｜ 次级图标行（可选，任务面板四枚浮层钮用）｜ 主操作钮（新建对话/新建任务）。
// 两个 rail 面板（chat/task）共用同一实现；tooltip/aria-label 一律吃 i18n 键，组件内无硬编码文案。
import { Button, Tooltip } from '@/components/ui'
import type { LucideIcon } from 'lucide-react'

export interface RailToolbarIconAction {
  /** 唯一 key（含同 key 数组渲染；同组件内图标唯一） */
  key: string
  tooltip: string
  icon: LucideIcon
  onClick: () => void
  /** 激活态（浮层已开同 tab 时高亮） */
  active?: boolean
}

export interface PanelToolbarProps {
  title: string
  /** 标题右侧固定英文微标（装饰，不进 i18n，如 TASKS/CHATS） */
  en?: string
  count?: number
  /** 主操作钮（面板最右） */
  newIcon: LucideIcon
  newLabel: string
  onNew: () => void
  /** 主操作钮左侧的次级图标行（可选） */
  secondary?: RailToolbarIconAction[]
}

export function PanelToolbar({ title, en, count, newIcon: NewIcon, newLabel, onNew, secondary }: PanelToolbarProps) {
  return (
    <div className="flex items-center gap-1.5 px-2 h-9 border-b shrink-0 bg-app">
      <span className="flex-1 min-w-0 truncate text-xs font-semibold text-primary">
        {title}
        {en && <span className="micro ml-1.5">{en}</span>}
      </span>
      {typeof count === 'number' && count > 0 && (
        <span className="text-[10px] text-tertiary tabular-nums shrink-0">{count}</span>
      )}
      {secondary && secondary.length > 0 && (
        <div className="flex items-center gap-0.5 shrink-0">
          {secondary.map(a => {
            const Icon = a.icon
            return (
              <Tooltip key={a.key} content={a.tooltip} side="bottom">
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label={a.tooltip}
                  onClick={a.onClick}
                  className={a.active ? 'text-brand-500' : 'text-tertiary hover:text-secondary'}
                >
                  <Icon className="w-3.5 h-3.5" />
                </Button>
              </Tooltip>
            )
          })}
        </div>
      )}
      <Tooltip content={newLabel} side="bottom">
        {/* 设计语言：新建钮 = 6px 单对角切角细线框（.plus 规格） */}
        <Button variant="ghost" size="icon" aria-label={newLabel} onClick={onNew} className="cut-xs shrink-0 !h-[22px] !w-[22px] hover:text-primary">
          <span className="ci !bg-transparent flex items-center justify-center w-full h-full">
            <NewIcon className="w-3.5 h-3.5" />
          </span>
        </Button>
      </Tooltip>
    </div>
  )
}
