// src/components/knowledge/KnowledgePackList.tsx —— 市场左栏清单（S4 Task 6）
//
// 筛选状态（搜索词 / 标签）自持而不是从宿主下发：宿主只在"选中哪个包"上有话语权，
// 关键词是纯展示态——放宿主会让宿主多四个 state + 每次键入重建整棵详情树。
//
// 角标只有一个（`packBadge` 的优先级：可更新 > 已安装 > 可安装）：条目上挂两个徽标时，
// "已安装"和"可更新"并排出现会让人以为是两个包。
import { useMemo, useState } from 'react'
import { Package, Search } from 'lucide-react'
import { Input } from '@/components/ui'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/useTranslation'
import type { KnowledgePackIndexItem } from '@/lib/knowledgePacksApi'
import { PACK_TAG_ALL, collectPackTags, filterPacks, packBadge } from '@/lib/knowledgeMarket'
import { KnowledgeEmpty } from './KnowledgeEmpty'

export interface KnowledgePackListProps {
  packs: KnowledgePackIndexItem[]
  selectedId: string | null
  onSelect: (id: string) => void
}

export function KnowledgePackList({ packs, selectedId, onSelect }: KnowledgePackListProps) {
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const [tag, setTag] = useState<string>(PACK_TAG_ALL)
  const tags = useMemo(() => collectPackTags(packs), [packs])
  const shown = useMemo(() => filterPacks(packs, { q, tag }), [packs, q, tag])

  const badgeText = (p: KnowledgePackIndexItem) => {
    const b = packBadge(p)
    if (b === 'update') return { text: t('knowledge.marketBadgeUpdate'), cls: 'text-brand-500' }
    if (b === 'installed') return { text: t('knowledge.marketBadgeInstalled'), cls: 'text-success' }
    return null
  }

  return (
    <div className="w-[248px] shrink-0 border-r border-default flex flex-col min-w-0">
      <div className="shrink-0 px-2 py-1.5 space-y-1 border-b border-default">
        <div className="relative">
          <Search className="w-3 h-3 absolute left-1.5 top-1.5 text-tertiary" />
          <Input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder={t('knowledge.marketSearch')}
            aria-label={t('knowledge.marketSearch')}
            className="h-6 pl-6 text-[11px]"
          />
        </div>
        {/* 标签过滤用原生 select：仓库 ui/ 无 select（spec §11.1），为它新造组件不值当 */}
        <select
          value={tag}
          onChange={e => setTag(e.target.value)}
          aria-label={t('knowledge.marketTagAll')}
          className="clip-sm h-6 w-full bg-elevated border border-default px-1 text-[11px] text-secondary"
        >
          <option value={PACK_TAG_ALL}>{t('knowledge.marketTagAll')}</option>
          {tags.map(tagName => <option key={tagName} value={tagName}>{tagName}</option>)}
        </select>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {shown.length === 0 ? (
          <KnowledgeEmpty title={t('knowledge.marketListEmpty')} className="!py-6" />
        ) : shown.map((p) => {
          const badge = badgeText(p)
          const active = p.id === selectedId
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onSelect(p.id)}
              className={cn(
                'w-full text-left px-2 py-1.5 border-b border-subtle transition-colors',
                active ? 'bg-active' : 'hover:bg-hover',
              )}
            >
              <div className="flex items-center gap-1">
                <Package className="w-3 h-3 shrink-0 text-tertiary" />
                <span className="flex-1 min-w-0 truncate text-[11px] text-primary">{p.name}</span>
                {/* 官方标识只由清单条目的 official 决定（"冒充官方"防护的展示侧） */}
                {p.official && <span className="micro shrink-0 text-brand-500">{t('knowledge.marketOfficial')}</span>}
                {badge && <span className={cn('micro shrink-0', badge.cls)}>{badge.text}</span>}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-tertiary">
                <span className="truncate">{p.id}</span>
                <span className="shrink-0 tabular-nums">v{p.version || '?'}</span>
                {p.installedVersion && p.installedVersion !== p.version && (
                  <span className="shrink-0 tabular-nums">({p.installedVersion})</span>
                )}
                <span className="flex-1" />
                <span className="shrink-0 tabular-nums">{p.docCount}</span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
