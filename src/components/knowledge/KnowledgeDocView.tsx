// src/components/knowledge/KnowledgeDocView.tsx —— 阅读视图（S2 Task 5）
//
// 正文**不**整篇丢给 react-markdown，而是按 `/doc` 的 blocks 分段渲染（见 lib/knowledgeBlocks.ts
// 文件头：块里才有 kind/tag/line）：经验条目 → 卡片、heading → 自带锚点的标题、其余 → markdown。
// markdown 渲染复用 src/components/chat/MarkdownText.tsx 导出的 MD_PLUGINS/MD_COMPONENTS
// （spec §11.1：已导出，勿重造）。
//
// 注意 components 表**必须是模块级稳定引用**：MarkdownText.tsx 头部注释记着那起事故——
// 每渲染新建 `{...MD_COMPONENTS}` 会让 react-markdown 整棵子树重挂载（输入抖动、滚动跳动）。
// 故 KB_COMPONENTS 在模块顶层建好，只补一个 p（默认表没有 p 规则，段落会吃浏览器 1em 边距）。
//
// 行定位：接收 targetLine（来自 knowledgeStore，检索命中/大纲点击时置入）→ 用 pickTargetIndex
// 找到落点块 → scrollIntoView + 高亮 1.5s（spec §6「滚动到 line 并高亮 1.5s」）。
// 高亮只用 token 底色 bg-accent-subtle + clip-sm 轮廓，**不动光效白名单**（`.breath` 等留给激活态）。
//
// S5 Task 9 增**块级**定位（targetBlockId）：关联锚点只带 blockId（内核 relSummary 的字段集合
// 被 spec §7.2 钉死，不许为跳转方便加 line），故按块匹配渲染项 —— 同样零额外请求，复用下面
// 同一套 scrollIntoView + 高亮。两条通道共用 targetIndex，故高亮/滚动只有一份实现。
// 关联锚点数据在这里**按文档一次**拉取（useRelatedDoc），再按 blockId 分发给条目卡片：
// 卡片自己拉会变成"每张卡一次内核进程"，见内核 getRelatedForDoc 的 why。
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import type { KnowledgeDoc } from '@/lib/knowledgeApi'
import { MD_COMPONENTS, MD_PLUGINS } from '@/components/chat/MarkdownText'
import { normalizeTags, pickTargetIndex, pickTargetIndexByBlock, planBlockRender } from '@/lib/knowledgeBlocks'
import { indexByBlock } from '@/lib/knowledgeRelations'
import type { KnowledgeRelatedAnchor } from '@/lib/knowledgeApi'
import { useRelatedDoc } from '@/hooks/useKnowledge'
import { useKnowledgeStore } from '@/stores/knowledgeStore'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/useTranslation'
import { KnowledgeEntryCard } from './KnowledgeEntryCard'
import { KnowledgeEmpty } from './KnowledgeEmpty'

/** 高亮持续时间；spec §6 定 1.5s（够看清落点又不会一直亮着干扰阅读） */
const HIGHLIGHT_MS = 1500

/** 段落：MD_COMPONENTS 无 p 规则，补一条紧凑版（模块级定义 = 稳定引用，见文件头） */
function MdP({ children }: { children?: React.ReactNode }) {
  return <p className="my-1.5 leading-relaxed break-words [overflow-wrap:anywhere]">{children}</p>
}
const KB_COMPONENTS: Components = { ...MD_COMPONENTS, p: MdP }

/** 标题级别 → 视觉规格（h1-h3 与 MD_COMPONENTS 的 h1-h3 对齐；h4+ 降为小节样式） */
const HEADING_CLASS: Record<number, string> = {
  1: 'text-lg font-bold text-primary mt-4 mb-2',
  2: 'text-base font-bold text-primary mt-3 mb-1.5',
  3: 'text-sm font-semibold text-primary mt-2 mb-1',
}

export interface KnowledgeDocViewProps {
  doc: KnowledgeDoc
  /** 目标行号（knowledgeStore.targetLine）；null = 不做定位 */
  targetLine?: number | null
  /** 目标块 id（knowledgeStore.targetBlockId，关联锚点跳转）；给了就优先按块定位 */
  targetBlockId?: string | null
}

export function KnowledgeDocView({ doc, targetLine = null, targetBlockId = null }: KnowledgeDocViewProps) {
  const { t } = useTranslation()
  // docId 下传是为了让条目渲染项带上 blockId（锚点定位的键）；不给 docId 时渲染计划与 S2 逐字相同
  const renders = useMemo(() => planBlockRender(doc.blocks, doc.id), [doc.blocks, doc.id])
  const tags = useMemo(() => normalizeTags(doc.tags), [doc.tags])
  const { data: relatedBlocks } = useRelatedDoc(doc.id)
  const anchorsByBlock = useMemo(() => indexByBlock(relatedBlocks), [relatedBlocks])
  // 块级通道优先：store 的 openAtBlock 会同时清掉 targetLine，故正常不会两者都非空
  const targetIndex = useMemo(
    () => (pickTargetIndexByBlock(renders, targetBlockId) ?? pickTargetIndex(renders, targetLine)),
    [renders, targetLine, targetBlockId],
  )

  const itemRefs = useRef<(HTMLDivElement | null)[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const [activeLine, setActiveLine] = useState<number | null>(null)

  // 换文档把阅读位置归零：滚动容器是同一个 DOM 节点，不显式重置会留着上一篇的滚动位置
  // （表现为"点开新文档却停在中段"）。本 effect 声明在定位 effect 之前，故定位总是最后生效。
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }) }, [doc.id])

  useEffect(() => {
    // 目标变了（或无目标）先把上一次的高亮清掉：否则连点两条检索结果会同时亮两块
    setActiveLine(null)
    if (targetIndex === null) return
    const el = itemRefs.current[targetIndex]
    if (!el) return
    el.scrollIntoView({ block: 'center' })   // 最近可滚动祖先是本视图的正文容器
    setActiveLine(renders[targetIndex].line)
    const timer = setTimeout(() => setActiveLine(null), HIGHLIGHT_MS)
    return () => clearTimeout(timer)
  }, [targetIndex, renders])

  // 点锚点 = 打开目标文档 + 切阅读视图 + 按块定位，三件事一次写完（store.openAtBlock）。
  // 本视图**不开第二条跳转通道**：偏移/高亮逻辑只有上面那一个 effect。
  const openAnchor = (a: KnowledgeRelatedAnchor) => useKnowledgeStore.getState().openAtBlock(a.docId, a.blockId)

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto px-4 py-3">
      <header>
        <h2 className="text-sm font-semibold text-primary truncate">{doc.title}</h2>
        <p className="mt-0.5 text-[10px] text-tertiary truncate">{doc.rel}</p>
        {tags.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {tags.map(tag => (
              <span key={tag} className="clip-sm bg-elevated px-1.5 py-0.5 text-[10px] text-secondary">{tag}</span>
            ))}
          </div>
        )}
      </header>

      <div className="mt-3">
        {renders.length === 0 ? (
          <KnowledgeEmpty title={t('knowledge.docEmpty')} className="!py-6" />
        ) : renders.map((r, i) => (
          <div
            key={r.key}
            ref={(el) => { itemRefs.current[i] = el }}
            data-line={r.line}
            className={cn(
              // clip-sm 只裁剪轮廓不改背景：高亮块用 token 底色，避免裸 hex / 光效
              'clip-sm -mx-2 px-2 transition-colors',
              activeLine === r.line && 'bg-accent-subtle',
            )}
          >
            {r.type === 'entryCard' ? (
              <div className="py-1">
                {/* 锚点数据按块分发；没锚点的卡片拿到空数组 → 卡片自己不渲染关联行（不留空壳） */}
                <KnowledgeEntryCard
                  tag={r.tag} summary={r.summary} full={r.full}
                  related={r.blockId ? anchorsByBlock.get(r.blockId) : undefined}
                  onOpenAnchor={openAnchor}
                />
              </div>
            ) : r.type === 'heading' ? (
              // 标题自己渲染（不再回填 `# ` 交给 markdown）：级别已知、锚点可控，
              // 右栏大纲（Task 9）与检索跳转都依赖这里的 data-line
              createHeading(r.level, r.text)
            ) : (
              <ReactMarkdown remarkPlugins={MD_PLUGINS} components={KB_COMPONENTS}>{r.text}</ReactMarkdown>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/** 按级别出标签（h1-h6）；class 用查表，h4+ 回落小节样式 */
function createHeading(level: number, text: string) {
  const L = Math.min(Math.max(level, 1), 6)
  const Tag = `h${L}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
  return <Tag className={HEADING_CLASS[L] ?? 'text-xs font-semibold text-secondary mt-2 mb-1'}>{text}</Tag>
}
