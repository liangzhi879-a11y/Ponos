// src/components/knowledge/KnowledgeEntryCard.tsx —— 经验条目卡片（S2 Task 5；S5 Task 9 增关联锚点行）
//
// 只在 `tag !== null` 时被 KnowledgeDocView 渲染：判定在 lib/knowledgeBlocks.ts 的
// isEntryCard()，那条是 S1 §11.4 的硬约束（`- [ ] Step N` 会被内核判成 entry，但不是经验）。
//
// 摘要常显、全文按需展开：内核 parseEntryLine（shared/knowledge-core.mjs:41-54）把
// `- [tag] 摘要 -- 全文` 拆成两段——摘要用于扫读，全文展开后才出现，避免少数长条目把阅读流冲散。
// 无 ` -- ` 的条目 summary === full，此时**不显示展开钮**（点了没有任何变化，看着像按钮坏了）。
//
// S5 Task 9 的关联锚点行（spec §7.5）：
//   · 按 `why.kind` 分为「同主题」（tag，骨架层）与「相似」（content，覆盖层）两组，
//     **同主题默认展开、相似默认折叠**——相似的"为什么"是分数 + 共有词，默认铺开会把卡片撑成日志
//     （spec 把 GUI 默认折叠列为噪声约束之一）；
//   · 点锚点 → 调宿主下传的 onOpenAnchor（宿主接 store.openAtBlock：打开文档 + 切阅读视图 + 按块定位）。
//     本组件**不自造导航**：定位口径只能有一份，否则卡片跳的和图谱/搜索跳的一定会漂移；
//   · 无锚点 → 整行不渲染（**不留空壳**：一行"关联 0"除了占位没有任何信息）；
//   · `duplicate` 是**去重提示**（spec §5.5 明确"不是关联"），故单独一行、警示色，不混进关联区。
// 分组/排序/计数/shared 裁剪全部来自 lib/knowledgeRelations.ts 的纯函数（本仓库无 DOM 测试环境，
// 逻辑放在组件里就等于不可测）。
import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, CornerDownRight, Copy } from 'lucide-react'
import { useTranslation } from '@/i18n/useTranslation'
import type { KnowledgeRelatedAnchor } from '@/lib/knowledgeApi'
import { duplicateNotice, formatScore, splitAnchors, trimShared } from '@/lib/knowledgeRelations'
import { shortRef } from '@/lib/knowledgeGraph'

export interface KnowledgeEntryCardProps {
  tag: string
  summary: string
  full?: string | null
  /** 源文件行号 → data-line 锚点（检索/大纲跳转定位用） */
  line?: number
  /** 是否为目标定位块：仅把切角外框的 1px 细线点亮为品牌色（不动光效——白名单之外一律不用） */
  active?: boolean
  /** 本条目的锚点（由宿主**整篇一次**拉取后下传，见内核 getRelatedForDoc 的 why） */
  related?: KnowledgeRelatedAnchor[]
  /** 点锚点：打开目标条目并定位（宿主实现；本组件只管"点了"这件事） */
  onOpenAnchor?: (anchor: KnowledgeRelatedAnchor) => void
}

export function KnowledgeEntryCard({
  tag, summary, full, line, active = false, related, onOpenAnchor,
}: KnowledgeEntryCardProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [groupOpen, setGroupOpen] = useState({ themed: true, similar: false })
  const body = String(full ?? '').trim()
  const expandable = body !== '' && body !== summary.trim()

  const groups = useMemo(() => splitAnchors(related), [related])
  const dup = useMemo(() => duplicateNotice(related), [related])
  const hasRelated = groups.themed.length > 0 || groups.similar.length > 0

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

        {hasRelated && (
          <div className="mt-1.5 border-t border-default pt-1.5">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] text-tertiary">{t('knowledge.related')}</span>
              <GroupChip
                label={t('knowledge.relatedThemed')} count={groups.themed.length}
                open={groupOpen.themed} onToggle={() => setGroupOpen(s => ({ ...s, themed: !s.themed }))}
              />
              {groups.similar.length > 0 && (
                <GroupChip
                  label={t('knowledge.relatedSimilar')} count={groups.similar.length}
                  open={groupOpen.similar} onToggle={() => setGroupOpen(s => ({ ...s, similar: !s.similar }))}
                />
              )}
            </div>
            {groupOpen.themed && groups.themed.length > 0 && (
              // 同主题边没有分数（内核不编造分数），解释性信息就是 tag 名本身
              <AnchorList items={groups.themed} showShared={false} onOpen={onOpenAnchor} />
            )}
            {groupOpen.similar && groups.similar.length > 0 && (
              // 相似组展开时才给"为什么相似"：分数 + 共有词（裁剪到 3 个，多出的折成 +N）
              <AnchorList items={groups.similar} showShared onOpen={onOpenAnchor} />
            )}
          </div>
        )}

        {dup && (
          // 独立提示（spec §5.5：去重提示不是关联）：只有它自己的时候也出现——"这两条是同一件事"
          // 本身就是该做的事（去重），不是"没有关联"的沉默
          <div className="mt-1.5 clip-sm bg-warning/10 px-1.5 py-1 flex items-center gap-1 text-[10px] text-warning">
            <Copy className="w-3 h-3 shrink-0" />
            <span className="truncate">
              {formatScore(dup.score) !== null
                ? t('knowledge.duplicateHintScore', { n: dup.count, score: formatScore(dup.score) as string })
                : t('knowledge.duplicateHint', { n: dup.count })}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

/** 分组开关：「同主题 3」这样的 chip，点击展开/收起该组的锚点列表 */
function GroupChip({ label, count, open, onToggle }: { label: string; count: number; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex items-center gap-0.5 clip-sm bg-elevated px-1.5 py-px text-[10px] text-secondary hover:text-primary transition-colors"
    >
      {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
      {label} {count}
    </button>
  )
}

/**
 * 一组的锚点列表：目标条目标题（空标题退回 docId 末段）+ 可选解释行。
 * 标题为空时不能留空行 —— 空标题的锚点在列表里是一条看不见的缝。
 */
function AnchorList({ items, showShared, onOpen }: {
  items: KnowledgeRelatedAnchor[]
  showShared: boolean
  onOpen?: (anchor: KnowledgeRelatedAnchor) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="mt-0.5">
      {items.map(a => {
        const title = String(a.title ?? '').trim() || shortRef(a.docId)
        const tag = a.why?.kind === 'tag' ? a.why.tag : ''
        const shared = trimShared(a.why?.kind === 'content' ? a.why.shared : [])
        const score = formatScore(a.score)
        return (
          <button
            key={a.blockId}
            type="button"
            onClick={() => onOpen?.(a)}
            title={a.blockId}
            className="w-full flex items-start gap-1 py-[2px] text-left transition-colors hover:bg-hover"
          >
            <CornerDownRight className="w-3 h-3 shrink-0 mt-px text-tertiary" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11px] text-secondary">{title}</span>
              {showShared && (
                <span className="block truncate text-[10px] text-tertiary">
                  {score ? t('knowledge.relatedWhyContent', { score }) : t('knowledge.relatedWhyContentPlain')}
                  {shared.words.length > 0 ? ` · ${shared.words.join(' / ')}` : ''}
                  {shared.more > 0 ? ` ${t('knowledge.relatedSharedMore', { n: shared.more })}` : ''}
                </span>
              )}
              {!showShared && tag ? (
                <span className="block truncate text-[10px] text-tertiary">{t('knowledge.relatedWhyTag', { tag })}</span>
              ) : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}
