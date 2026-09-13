// src/components/knowledge/KnowledgeInspector.tsx —— 右栏 Inspector（S2 Task 9）
//
// 三段式（大纲 / 反链 / 元信息），窄栏 212px，每段标题用 `.micro`-风小节头 + 分隔线
// （与 chat/RightStatusRail.tsx:178 的 `text-[11px] font-semibold text-tertiary uppercase tracking-wider`
// 同一套视觉，两栏并排时不打架）。
//
// 数据来源（四段各一路，全部走 Task 2 的缓存层，不额外发明通道）：
//   · 大纲    ← 宿主已有的 `doc.blocks`（props 下传，不重复请求；挑 heading 的判定在 lib）
//   · 反链    ← `useLinks(doc.id)` 的 `in`（后端 kernel/knowledge.mjs:589-592 给出"谁引用了我"）
//   · 关联    ← `useRelatedDoc(doc.id)`（S5 Task 9）
//   · 元信息  ← `doc` 的 spaceId/title/tags/块数 + `useStats()` 的 `indexAgeMs`
//
// **关联与反链必须分成两段**（spec §7.5 的硬要求）：语义相反——反链是别人**手写引用**了本文
// （显式、用户意图明确），关联是内核**自动派生**的相似/同主题（隐式、可能过时、要读解释）。
// 合成一栏会让用户以为关联也是手工建立的，进而在删文档时误判"这些引用不用管"。
//
// 反链为空是**常态**：知识库里绝大多数文档没有任何入链，不是错误、不是加载失败。
// 所以空态文案是中性陈述（"暂无其他文档引用它"），既不用 error 色也不给重试钮——
// 把常态渲染成异常会训练用户忽略真正的错误。
//
// 大纲点击复用 Task 5 的行定位能力：写 `targetLine` → 阅读视图的 effect 滚动并高亮 1.5s
// （锚点就是块上的 `data-line`）。这里**不自己实现一套滚动**，否则高亮与滚动会各走各的。
import { useMemo } from 'react'
import { CornerDownRight, Tag } from 'lucide-react'
import { useLinks, useRelatedDoc, useStats } from '@/hooks/useKnowledge'
import { useKnowledgeStore } from '@/stores/knowledgeStore'
import { useTranslation } from '@/i18n/useTranslation'
import { normalizeTags } from '@/lib/knowledgeBlocks'
import type { KnowledgeDoc } from '@/lib/knowledgeApi'
import { shortRef } from '@/lib/knowledgeGraph'
import { ageParts, buildOutline, dedupeSources, outlineIndent } from '@/lib/knowledgeInspector'
import { collectAnchors, formatScore, trimShared } from '@/lib/knowledgeRelations'
import type { KnowledgeRelatedAnchor } from '@/lib/knowledgeApi'
import { cn } from '@/lib/utils'
import { KnowledgeEmpty } from './KnowledgeEmpty'

export interface KnowledgeInspectorProps {
  /** 当前文档（宿主 useDoc 的结果下传；undefined = 未选中 → 整栏空态） */
  doc: KnowledgeDoc | undefined
}

export function KnowledgeInspector({ doc }: KnowledgeInspectorProps) {
  const { t } = useTranslation()
  // stats 是全局索引统计（与选中文档无关）；后端不给 indexAgeMs 时为 null → 显示"—"
  const { data: stats } = useStats()
  const { data: links } = useLinks(doc?.id ?? null)
  const { data: relatedBlocks } = useRelatedDoc(doc?.id ?? null)

  const outline = useMemo(() => buildOutline(doc?.blocks), [doc])
  const tags = useMemo(() => normalizeTags(doc?.tags), [doc])
  // 去重：同一文档在一篇文里链接两次 → 后端 `in` 会给两条同 from 的记录（见 lib 注释）
  const backlinks = useMemo(() => dedupeSources(links?.in), [links])
  // 整篇锚点汇总：按目标块去重、剔除 duplicate（去重提示不是关联，spec §5.5）
  const relatedAnchors = useMemo(() => collectAnchors(relatedBlocks), [relatedBlocks])

  const gotoLine = (line: number) => {
    const st = useKnowledgeStore.getState()
    const same = st.targetLine === line
    // 大纲是"去读这一段"的意图：在搜索/图谱视图下必须先切回阅读视图，否则点了没反应
    if (st.view !== 'read') st.setView('read')
    st.setTargetLine(line)
    // 连点同一个小节：targetLine 值没变 → 阅读视图的 effect 不会重跑，这里补一次直接滚动
    if (same) document.querySelector<HTMLElement>(`[data-line="${Math.floor(line)}"]`)?.scrollIntoView({ block: 'center' })
  }

  const openDoc = (docId: string) => {
    const st = useKnowledgeStore.getState()
    st.setDocId(docId)      // 换文档顺带清 targetLine（行号只对上一篇有意义）
    st.setView('read')
  }

  // 关联锚点跳转：与条目卡片走**同一个** store 动作（打开文档 + 切阅读视图 + 按块定位）。
  // 右栏不自己实现导航——两处各写一遍，"跳到哪一行/要不要切视图"必然漂移。
  const openAnchor = (a: KnowledgeRelatedAnchor) => useKnowledgeStore.getState().openAtBlock(a.docId, a.blockId)

  const age = ageParts(stats?.indexAgeMs)

  return (
    <div className="w-[212px] shrink-0 border-l border-default flex flex-col min-w-0">
      <div className="h-8 shrink-0 flex items-center px-2 border-b border-default">
        <span className="micro">{doc ? t('knowledge.meta') : t('knowledge.outline')}</span>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {!doc ? (
          <KnowledgeEmpty title={t('knowledge.emptyNoDoc')} className="!py-6" />
        ) : (
          <>
            <Section title={t('knowledge.outline')} count={outline.length}>
              {outline.length ? outline.map(o => (
                <button
                  key={`${o.n}-${o.line}`}
                  type="button"
                  onClick={() => gotoLine(o.line)}
                  title={`L${o.line}`}
                  style={{ paddingLeft: outlineIndent(o.level) }}
                  className={cn(
                    'w-full flex items-center gap-1.5 py-[3px] pr-2 text-left transition-colors hover:bg-hover',
                    o.level === 1 ? 'text-[11px] text-primary' : 'text-[11px] text-secondary',
                  )}
                >
                  <span className="truncate">{o.text}</span>
                </button>
              )) : (
                <Hint>{t('knowledge.outlineEmpty')}</Hint>
              )}
            </Section>

            <Section title={t('knowledge.backlinks')} count={backlinks.length}>
              {backlinks.length ? backlinks.map(from => (
                <button
                  key={from}
                  type="button"
                  onClick={() => openDoc(from)}
                  title={from}
                  className="w-full flex items-center gap-1.5 px-2 py-[3px] text-left text-[11px] text-secondary hover:bg-hover transition-colors"
                >
                  <CornerDownRight className="w-3 h-3 shrink-0 text-tertiary" />
                  <span className="truncate">{shortRef(from)}</span>
                </button>
              )) : (
                // 中性陈述：多数文档没有入链是常态，不是错误（见文件头）
                <Hint>{t('knowledge.backlinksEmpty')}</Hint>
              )}
            </Section>

            <Section title={t('knowledge.related')} count={relatedAnchors.length}>
              {relatedAnchors.length ? relatedAnchors.map(a => (
                <button
                  key={a.blockId}
                  type="button"
                  onClick={() => openAnchor(a)}
                  title={a.blockId}
                  className="w-full flex items-start gap-1.5 px-2 py-[3px] text-left transition-colors hover:bg-hover"
                >
                  {/* 图标区分两层：同主题（tag）用 Tag，内容相似用 CornerDownRight —— 只靠文字层级
                      在 212px 里不容易分辨，形状差异是零成本的第二编码 */}
                  {a.why?.kind === 'tag'
                    ? <Tag className="w-3 h-3 shrink-0 mt-px text-tertiary" />
                    : <CornerDownRight className="w-3 h-3 shrink-0 mt-px text-tertiary" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] text-secondary">{String(a.title ?? '').trim() || shortRef(a.docId)}</span>
                    <span className="block truncate text-[10px] text-tertiary">{whyLine(a, t)}</span>
                  </span>
                </button>
              )) : (
                // 中性陈述：内核判定的隐式关联，没有就是没有（多数条目本就孤立），不是加载失败
                <Hint>{t('knowledge.relatedEmpty')}</Hint>
              )}
              {/* 语义提示：关联是**自动派生**的，与上面"反链"（别人手写的引用）不是一回事。
                  这行文字是 spec §7.5「两段语义不同」在界面上的落点（用户据此判断删文档时该不该管它） */}
              {relatedAnchors.length > 0 && <Hint>{t('knowledge.relatedHint')}</Hint>}
            </Section>

            <Section title={t('knowledge.meta')}>
              <MetaRow label={t('knowledge.metaSpace')} value={doc.spaceId} />
              <MetaRow label={t('knowledge.metaPath')} value={doc.rel} />
              <MetaRow label={t('knowledge.metaTitle')} value={doc.title || '—'} />
              <MetaRow label={t('knowledge.metaTags')} value={tags.length ? tags.join(' · ') : '—'} />
              <MetaRow label={t('knowledge.metaBlocks')} value={String(doc.blocks?.length ?? 0)} />
              <MetaRow
                label={t('knowledge.metaIndex')}
                value={age
                  ? age.unit === 'now'
                    ? t('knowledge.ageNow')
                    : t(`knowledge.age${age.unit[0].toUpperCase()}${age.unit.slice(1)}`, { n: age.value })
                  // 索引还没建过 / 后端未给 indexAgeMs → 显示"—"，不显示"刚刚"（见 lib 的 ageParts 注释）
                  : '—'}
              />
            </Section>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * 关联一行的"为什么"（列宽只有 212px，故 shared 词裁到 2 个）：
 * `同主题 · <tag>` / `相似 0.21 · 功能 / 原型`。解释性文字是关联段的**主要价值**——
 * 只给一个标题的关联列表与随机推荐无异（用户无法判断该不该点）。
 */
// 参数类型必须与 i18n 的 `t` 签名一致（`Record<string, string | number>`）：写成 `unknown`
// 会因函数参数逆变而无法把 `t` 传进来（tsc TS2345）。
function whyLine(a: KnowledgeRelatedAnchor, t: (k: string, p?: Record<string, string | number>) => string): string {
  if (a.why?.kind === 'tag') return t('knowledge.relatedWhyTag', { tag: a.why.tag })
  const score = formatScore(a.score)
  const shared = trimShared(a.why?.kind === 'content' ? a.why.shared : [], 2)
  const head = score ? t('knowledge.relatedWhyContent', { score }) : t('knowledge.relatedWhyContentPlain')
  const words = shared.words.length ? ` · ${shared.words.join(' / ')}${shared.more > 0 ? ` +${shared.more}` : ''}` : ''
  return head + words
}

/** 小节：`.micro`-风标题 + 分隔线（视觉与 RightStatusRail 的折叠小节一致） */
function Section({ title, count, children }: { title: string; count?: number; children?: React.ReactNode }) {
  return (
    <section className="border-b border-default">
      <header className="flex items-center gap-1.5 px-2 h-7">
        <span className="text-[11px] font-semibold text-tertiary uppercase tracking-wider truncate">{title}</span>
        {typeof count === 'number' && <span className="micro shrink-0">{count}</span>}
      </header>
      <div className="pb-1.5">{children}</div>
    </section>
  )
}

/** 段内提示（比 KnowledgeEmpty 更小：小节里的空不是"整块空"） */
function Hint({ children }: { children?: React.ReactNode }) {
  return <p className="px-2 py-1 text-[10px] text-tertiary opacity-80">{children}</p>
}

/** 元信息一行：标签定宽 + 值截断（长路径不许把 212px 的栏撑出横向滚动） */
function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-1.5 px-2 py-[2px]">
      <span className="shrink-0 w-[38px] text-[10px] text-tertiary">{label}</span>
      <span className="flex-1 min-w-0 text-[10px] text-secondary break-all" title={value}>{value}</span>
    </div>
  )
}
