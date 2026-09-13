// src/components/knowledge/KnowledgeInspector.tsx —— 右栏 Inspector（S2 Task 9）
//
// 三段式（大纲 / 反链 / 元信息），窄栏 212px，每段标题用 `.micro`-风小节头 + 分隔线
// （与 chat/RightStatusRail.tsx:178 的 `text-[11px] font-semibold text-tertiary uppercase tracking-wider`
// 同一套视觉，两栏并排时不打架）。
//
// 数据来源（三段各一路，全部走 Task 2 的缓存层，不额外发明通道）：
//   · 大纲    ← 宿主已有的 `doc.blocks`（props 下传，不重复请求；挑 heading 的判定在 lib）
//   · 反链    ← `useLinks(doc.id)` 的 `in`（后端 kernel/knowledge.mjs:589-592 给出"谁引用了我"）
//   · 元信息  ← `doc` 的 spaceId/title/tags/块数 + `useStats()` 的 `indexAgeMs`
//
// 反链为空是**常态**：知识库里绝大多数文档没有任何入链，不是错误、不是加载失败。
// 所以空态文案是中性陈述（"暂无其他文档引用它"），既不用 error 色也不给重试钮——
// 把常态渲染成异常会训练用户忽略真正的错误。
//
// 大纲点击复用 Task 5 的行定位能力：写 `targetLine` → 阅读视图的 effect 滚动并高亮 1.5s
// （锚点就是块上的 `data-line`）。这里**不自己实现一套滚动**，否则高亮与滚动会各走各的。
import { useMemo } from 'react'
import { CornerDownRight } from 'lucide-react'
import { useLinks, useStats } from '@/hooks/useKnowledge'
import { useKnowledgeStore } from '@/stores/knowledgeStore'
import { useTranslation } from '@/i18n/useTranslation'
import { normalizeTags } from '@/lib/knowledgeBlocks'
import type { KnowledgeDoc } from '@/lib/knowledgeApi'
import { shortRef } from '@/lib/knowledgeGraph'
import { ageParts, buildOutline, dedupeSources, outlineIndent } from '@/lib/knowledgeInspector'
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

  const outline = useMemo(() => buildOutline(doc?.blocks), [doc])
  const tags = useMemo(() => normalizeTags(doc?.tags), [doc])
  // 去重：同一文档在一篇文里链接两次 → 后端 `in` 会给两条同 from 的记录（见 lib 注释）
  const backlinks = useMemo(() => dedupeSources(links?.in), [links])

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
