// src/components/knowledge/KnowledgeTagsView.tsx —— 标签视图（2026-09-14 对标 Obsidian 批次 1）
//
// 数据：`useIndexTags(spaces)`（走内核 `index-tags` op，**全库文档标签**，含只读知识包）。
// 与检索视图共用「全部空间 / 本空间」开关（同一个组件、同一套文案）：标签和检索是同一件事的
// 两个入口，范围语义必须一致，否则"检索搜不到、标签里却有"会被当成 bug 报上来。
//
// 三个刻意的设计取舍：
//   ① **层级树而不是平铺云**：Obsidian 用 `/` 表达层级（`#税务/增值税`）。平铺会和内核一样
//      丢掉"父标签汇总子标签"这层信息，用户看到一堆半截路径反而更难读。
//   ② **点标签 = 去检索**：内核目前没有 `tag:` 语法（那是批次 3），所以点击走"把标签当
//      查询串 + 关键词"的路子（见 store.openSearchWithKeywords）。父节点会把后代标签一并带上
//      （Obsidian 的 `tag:#税务` 也命中 `#税务/增值税`）。
//   ③ **单例标签显式标记**：只被一篇文档用到的标签是标签体系腐烂的第一信号（S5.1 实测：
//      单例越积越多 → 条目孤立）。内核已经算好 single，这里别把它藏起来。
import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Tags } from 'lucide-react'
import { useIndexTags } from '@/hooks/useKnowledge'
import { useKnowledgeStore } from '@/stores/knowledgeStore'
import { useTranslation } from '@/i18n/useTranslation'
import { cn } from '@/lib/utils'
import { buildTagTree, tagSearchTerms, type TagNode } from '@/lib/knowledgeTags'
import { KnowledgeEmpty } from './KnowledgeEmpty'
import { KnowledgeSkeleton } from './KnowledgeSkeleton'
import { KnowledgeScopeToggle } from './KnowledgeScopeToggle'

/** 一次点击最多带多少条标签去检索（父节点会带后代，见 lib/knowledgeTags.tagSearchTerms） */
const MAX_TERMS = 8

export function KnowledgeTagsView() {
  const { t } = useTranslation()
  const spaceId = useKnowledgeStore(s => s.spaceId)
  const [allSpaces, setAllSpaces] = useState(true)

  // 与检索视图逐字同一条规则：全库 = 不发 spaces（空数组会被内核归一成"不过滤"，但显式不发更清楚）
  const scope = allSpaces || !spaceId ? undefined : [spaceId]
  const { data, loading, error } = useIndexTags(scope)

  const tree = useMemo(() => buildTagTree(data?.tags ?? []), [data])
  const total = data?.total ?? 0
  const singleCount = data?.singleCount ?? 0

  // 默认展开一层：不展开的话首屏只有顶层名字，用户要点一下才能看到"这个标签底下有什么"；
  // 全展开又会让几千标签的库一次渲染出所有节点。折中：顶层默认开，更深的默认折叠。
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const toggle = (path: string) => setCollapsed(prev => {
    const next = new Set(prev)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  })

  const openTag = (node: TagNode) => {
    useKnowledgeStore.getState().openSearchWithKeywords(tagSearchTerms(node, MAX_TERMS))
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 px-3 py-2 border-b border-default flex items-center gap-1.5">
        <KnowledgeScopeToggle all={allSpaces} onChange={setAllSpaces} />
        <span className="flex-1 min-w-0" />
        {total > 0 && (
          <span className="micro shrink-0" title={t('knowledge.tagsHint')}>
            {t('knowledge.tagsTotal', { total, single: singleCount })}
          </span>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {error ? (
          <KnowledgeEmpty title={t('knowledge.loadFailed')} hint={error} className="!py-6" />
        ) : loading && !tree.length ? (
          <KnowledgeSkeleton lines={6} />
        ) : !tree.length ? (
          <KnowledgeEmpty
            title={t('knowledge.tagsEmpty')}
            hint={t('knowledge.tagsHint')}
            icon={Tags}
            className="!py-6"
          />
        ) : (
          <div className="py-1">
            {tree.map(n => (
              <TagRow
                key={n.path}
                node={n}
                depth={0}
                collapsed={collapsed}
                onToggle={toggle}
                onOpen={openTag}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** 一行标签：折叠箭头（有子节点才给）+ 名字 + 计数 + 单例微标。整行可点 = 去检索 */
function TagRow({ node, depth, collapsed, onToggle, onOpen }: {
  node: TagNode
  depth: number
  collapsed: Set<string>
  onToggle: (path: string) => void
  onOpen: (node: TagNode) => void
}) {
  const { t } = useTranslation()
  const hasChildren = node.children.length > 0
  // 顶层（depth 0）默认展开：由 collapsed 是否含该 path 决定；更深层默认折叠（复用同一集合）
  const isOpen = depth === 0 ? !collapsed.has(node.path) : collapsed.has(node.path)

  return (
    <div>
      <div
        className="group flex items-center gap-1 pr-3 py-1 hover:bg-hover transition-colors"
        style={{ paddingLeft: `${12 + depth * 12}px` }}
      >
        {/* 折叠箭头：没有子节点时占位同宽，避免同层标签缩进错位 */}
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(node.path)}
            aria-expanded={isOpen}
            className="shrink-0 w-3.5 h-3.5 flex items-center justify-center text-tertiary hover:text-primary transition-colors"
          >
            {isOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </button>
        ) : (
          <span className="shrink-0 w-3.5 h-3.5" />
        )}
        <button
          type="button"
          onClick={() => onOpen(node)}
          title={t('knowledge.tagsHint')}
          className="flex-1 min-w-0 flex items-center gap-1.5 text-left"
        >
          <span className="text-[11px] text-primary truncate">#{node.name}</span>
          <span className="flex-1 min-w-0" />
          {node.single && (
            <span className="micro shrink-0 opacity-70" title={t('knowledge.tagsSingleTooltip')}>
              {t('knowledge.tagsSingle')}
            </span>
          )}
          <span className={cn('text-[10px] tabular-nums shrink-0', node.total > 0 ? 'text-secondary' : 'text-tertiary opacity-60')}>
            {node.total}
          </span>
        </button>
      </div>
      {hasChildren && isOpen && node.children.map(c => (
        <TagRow key={c.path} node={c} depth={depth + 1} collapsed={collapsed} onToggle={onToggle} onOpen={onOpen} />
      ))}
    </div>
  )
}
