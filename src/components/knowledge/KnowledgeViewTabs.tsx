// src/components/knowledge/KnowledgeViewTabs.tsx —— 四视图切换（阅读/编辑/图谱/搜索）
//
// 为什么用 `ui/tabs.tsx`：仓库既有视图切换（RunDrawer.tsx:219）就吃 Radix Tabs，
// 键盘左右箭头 / roving tabindex / aria-selected 都是白拿的——手写一排 button 反而要自己补 a11y。
// 但**不用 TabsContent**：本面板是"同一时刻只挂一棵视图树"的条件渲染（Task 5-8 的视图各自带
// 自己的数据 hook，同时挂载会四条请求齐发）。Radix 的 value 用受控模式，视图内容由宿主渲染。
//
// 为什么受控（props 进、onChange 出）而不是直接读写 store：这是个纯展示组件，
// 单测/复用不受全局状态牵连；持久化由宿主 KnowledgePanel 调知识 store 的 setView 完成。
import { Waypoints, PenLine, ScrollText, Search, Package } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger, Tooltip } from '@/components/ui'
import type { KnowledgeView } from '@/stores/knowledgeStore'
import { KNOWLEDGE_VIEWS } from '@/stores/knowledgeStore'
import { useTranslation } from '@/i18n/useTranslation'

/** 视图 → 图标 + i18n 键（顺序即展示顺序，与 KNOWLEDGE_VIEWS 一致） */
const VIEW_META: Record<KnowledgeView, { icon: typeof ScrollText; labelKey: 'knowledge.viewRead' | 'knowledge.viewEdit' | 'knowledge.viewGraph' | 'knowledge.viewSearch' | 'knowledge.viewMarket' }> = {
  read: { icon: ScrollText, labelKey: 'knowledge.viewRead' },
  edit: { icon: PenLine, labelKey: 'knowledge.viewEdit' },
  graph: { icon: Waypoints, labelKey: 'knowledge.viewGraph' },
  search: { icon: Search, labelKey: 'knowledge.viewSearch' },
  // 市场视图（S4）：与当前空间无关，故在这个 tab 里也不依赖 space 是否选中
  market: { icon: Package, labelKey: 'knowledge.viewMarket' },
}

export interface KnowledgeViewTabsProps {
  value: KnowledgeView
  onChange: (view: KnowledgeView) => void
  /** 只读空间：编辑视图禁用（spec §11.3——CodeEditor 无 readOnly，只能靠"不进编辑视图"实现） */
  readonly?: boolean
}

export function KnowledgeViewTabs({ value, onChange, readonly = false }: KnowledgeViewTabsProps) {
  const { t } = useTranslation()
  return (
    <Tabs value={value} onValueChange={(v) => onChange(v as KnowledgeView)}>
      {/* 覆盖 ui/tabs 默认的圆角胶囊：本仓库设计语言是切角（clip-sm = 纯裁剪不夺底色，
          比 .cut-xs 更合适——激活态需要 bg-active 显示出来，而 .ci 会盖住它） */}
      <TabsList className="w-full justify-start gap-0.5 px-2 h-9 rounded-none bg-transparent p-0 border-b border-default">
        {KNOWLEDGE_VIEWS.map((v) => {
          const { icon: Icon, labelKey } = VIEW_META[v]
          const label = t(labelKey)
          const disabled = v === 'edit' && readonly
          const trigger = (
            <TabsTrigger
              value={v}
              disabled={disabled}
              aria-label={label}
              className="clip-sm h-[22px] rounded-none px-2.5 gap-1.5 text-[11px] font-medium text-tertiary hover:text-secondary data-[state=active]:bg-active data-[state=active]:text-primary data-[state=active]:shadow-none"
            >
              <Icon className="w-3 h-3" />
              <span>{label}</span>
            </TabsTrigger>
          )
          // 禁用态必须包一层 span 当 tooltip 的 trigger：disabled 元素在 Chromium 下不派发指针事件，
          // 直接挂在 trigger 上提示永远不弹（"为什么编辑是灰的"就没人回答了）。
          return (
            <Tooltip key={v} content={disabled ? t('knowledge.readonlyTooltip') : label} side="bottom">
              {disabled ? <span className="inline-flex">{trigger}</span> : trigger}
            </Tooltip>
          )
        })}
      </TabsList>
    </Tabs>
  )
}
