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
import { CornerDownRight, Search, Tag, Unlink } from 'lucide-react'
import { useBrokenLinks, useLinks, useMentions, useRelatedDoc, useStats } from '@/hooks/useKnowledge'
import { useKnowledgeStore } from '@/stores/knowledgeStore'
import { useTranslation } from '@/i18n/useTranslation'
import { normalizeTags } from '@/lib/knowledgeBlocks'
import type { KnowledgeDoc } from '@/lib/knowledgeApi'
import { shortRef } from '@/lib/knowledgeGraph'
import { ageParts, buildOutline, groupBacklinks, outlineIndent } from '@/lib/knowledgeInspector'
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
  /**
   * 反链（2026-09-14 批次 2 增强）：按**来源文档**分组，组内保留每处引用（行号 + 上下文片段 + 锚点）。
   *
   * 旧实现用 `dedupeSources` 只留"谁引用了我"，用户看到来源却**不知道在哪一段、说了什么**，
   * 点过去只能从文档开头自己翻。Obsidian 的反链面板之所以有用，正是因为它给上下文。
   * 这里仍然保留"同一来源只出一个文档头"的层级（列表才不至于变成一堆重复文件名），
   * 但把该文档的每处提及列在下面 —— 层级不丢，信息补全。
   */
  const backlinkGroups = useMemo(() => groupBacklinks(links?.in), [links])
  // 未链接提及（批次 2）：全库范围内"提到本文档却没打链接"的位置。发现机制 ——
  // 有了它用户才知道"该连的还没连"，这是把孤立文档织成网的主要入口。
  const { data: mentions } = useMentions(doc?.id ?? null, 20)
  /**
   * 断链清单（2026-09-14 批次 2）：`target` 为 null 的引用，按目标名聚合。
   *
   * 为什么是**全局**（跟当前空间走）而不是"本文档的断链"：断链是**待办**（补文档 / 改链接 /
   * 删引用），用户关心的是"我的库里有多少坏链接"。只显示本文档的断链会让用户永远不知道
   * 别处还有多少 —— 而那些正是需要他去修的。
   */
  const spaceId = useKnowledgeStore(s => s.spaceId)
  const { data: broken } = useBrokenLinks(spaceId ?? null, 100)
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

  /**
   * 反链/提及条目点击 = **打开来源文档并定位到那一行**。
   * 用 `setDocId` + `setTargetLine` 两步（同 store 给"检索命中"的既有口径），
   * 不复用 openAtBlock：那条路径要块 ID，而反链给的是行号（更精确且零额外请求）。
   */
  const openAtLine = (docId: string, line?: number | null) => {
    const st = useKnowledgeStore.getState()
    st.setDocId(docId)
    st.setView('read')
    if (typeof line === 'number' && Number.isFinite(line) && line > 0) st.setTargetLine(line)
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

            <Section title={t('knowledge.backlinks')} count={backlinkGroups.reduce((n, g) => n + g.refs.length, 0)}>
              {backlinkGroups.length ? backlinkGroups.map(g => (
                <div key={g.from} className="mb-0.5">
                  {/* 文档头一行：点它 = 打开来源文档（不定位）。组内每条提及再各自定位到行。 */}
                  <button
                    type="button"
                    onClick={() => openDoc(g.from)}
                    title={g.from}
                    className="w-full flex items-center gap-1.5 px-2 py-[3px] text-left text-[11px] text-secondary hover:bg-hover transition-colors"
                  >
                    <CornerDownRight className="w-3 h-3 shrink-0 text-tertiary" />
                    <span className="truncate">{shortRef(g.from)}</span>
                    {g.refs.length > 1 && <span className="micro shrink-0">×{g.refs.length}</span>}
                  </button>
                  {/* 每处引用的上下文（批次 2 的核心）：没有它，用户只能从文档开头自己翻。
                      嵌入（`![[x]]`）与带锚点的引用加显式标记 —— 它们与普通引用读法不同。 */}
                  {g.refs.map((r, i) => (
                    <button
                      key={`${g.from}-${r.line ?? i}`}
                      type="button"
                      onClick={() => openAtLine(g.from, r.line)}
                      title={r.anchorRef ? `锚点：${r.anchorRef}` : `L${r.line ?? '?'}`}
                      className="w-full flex items-start gap-1 pl-5 pr-2 py-[2px] text-left hover:bg-hover transition-colors"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[10px] text-tertiary/90">
                          {r.embed && <span className="text-brand-500/90">嵌入 </span>}
                          {r.anchorRef && <span className="text-brand-500/90">#{r.anchorRef} </span>}
                          {r.snippet || `L${r.line ?? '?'}`}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )) : (
                // 中性陈述：多数文档没有入链是常态，不是错误（见文件头）
                <Hint>{t('knowledge.backlinksEmpty')}</Hint>
              )}
            </Section>

            {/* 未链接提及（2026-09-14 批次 2）：Obsidian 的"发现本该有的连接"。
                与上面反链语义**不同**：反链是已经连上的，这里是"提到了但没连"（用户据此补链）。
                上限 20 条由内核扫到即停保证，`truncated` 时如实提示 —— 用户以为看到全部
                就不会去别处找了。 */}
            <Section title={t('knowledge.mentions')} count={mentions?.items.length ?? 0}>
              {mentions?.items.length ? mentions.items.map(m => (
                <button
                  key={`${m.docId}-${m.block}`}
                  type="button"
                  onClick={() => openAtLine(m.docId, m.line)}
                  title={`${m.docId} · L${m.line}`}
                  className="w-full flex items-start gap-1.5 px-2 py-[3px] text-left transition-colors hover:bg-hover"
                >
                  <Search className="w-3 h-3 shrink-0 mt-px text-tertiary" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] text-secondary">{String(m.title ?? '').trim() || shortRef(m.docId)}</span>
                    <span className="block truncate text-[10px] text-tertiary">{m.snippet}</span>
                  </span>
                </button>
              )) : (
                <Hint>{t('knowledge.mentionsEmpty')}</Hint>
              )}
              {mentions?.truncated && <Hint>{t('knowledge.mentionsTruncated')}</Hint>}
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

            <Section title={t('knowledge.brokenLinks')} count={broken?.broken ?? 0}>
              {broken?.items.length ? (
                <>
                  <Hint>{t('knowledge.brokenLinksCount', { n: broken.broken })}</Hint>
                  {broken.items.map(item => (
                    <div key={item.to} className="mb-0.5">
                      {/* 断链按**目标名**聚合（同一拼错常被写错好几次）：组头显示目标 + 次数，
                          组内列出每处引用（点进去改）。按行平铺只会看到重复的同一件事。 */}
                      <div className="flex items-center gap-1.5 px-2 py-[3px] text-[11px] text-secondary">
                        <Unlink className="w-3 h-3 shrink-0 text-tertiary" />
                        <span className="truncate" title={item.to}>{item.to}</span>
                        <span className="micro shrink-0">×{item.count}</span>
                      </div>
                      {item.refs.map((r, i) => (
                        <button
                          key={`${item.to}-${r.from}-${r.line ?? i}`}
                          type="button"
                          onClick={() => openAtLine(r.from, r.line)}
                          title={`${r.from} · L${r.line ?? '?'}`}
                          className="w-full flex items-center gap-1 pl-5 pr-2 py-[2px] text-left text-[10px] text-tertiary hover:bg-hover transition-colors"
                        >
                          <span className="truncate">{shortRef(r.from)}{typeof r.line === 'number' ? `:${r.line}` : ''}</span>
                        </button>
                      ))}
                    </div>
                  ))}
                  {/* 解释性提示：断链的处理动作有三种（补文档 / 改链接 / 删引用），
                      用户需要知道这不是"系统出错"，而是**待办**。 */}
                  <Hint>{t('knowledge.brokenLinksHint')}</Hint>
                </>
              ) : (
                // 无断链是好事：中性陈述（不是"加载失败"，也不是"恭喜"）
                <Hint>{t('knowledge.brokenLinksEmpty')}</Hint>
              )}
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
