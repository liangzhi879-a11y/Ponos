// src/components/knowledge/KnowledgeDocView.tsx —— 阅读视图（S2 Task 5）
//
// 正文**不**整篇丢给 react-markdown，而是按 `/doc` 的 blocks 分段渲染（见 lib/knowledgeBlocks.ts
// 文件头：块里才有 kind/tag/line）：经验条目 → 卡片、heading → 自带锚点的标题、其余 → markdown。
// markdown 渲染复用 src/components/chat/MarkdownText.tsx 导出的 MD_PLUGINS/MD_COMPONENTS
// （spec §11.1：已导出，勿重造）。
//
// ⚠️ components 表**必须是模块级稳定引用**：MarkdownText.tsx 头部注释记着那起事故——
// 每渲染新建 `{...MD_COMPONENTS}` 会让 react-markdown 整棵子树重挂载（输入抖动、滚动跳动）。
// 故 KB_COMPONENTS 在模块顶层建好，只补一个 p（默认表没有 p 规则，段落会吃浏览器 1em 边距）。
//
// 行定位：接收 targetLine（来自 knowledgeStore，检索命中/大纲点击时置入）→ 用 pickTargetIndex
// 找到落点块 → scrollIntoView + 高亮 1.5s（spec §6「滚动到 line 并高亮 1.5s」）。
// 高亮只用 token 底色 bg-accent-subtle + clip-sm 轮廓，**不动光效白名单**（`.breath` 等留给激活态）。
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import type { KnowledgeDoc } from '@/lib/knowledgeApi'
import { MD_COMPONENTS, MD_PLUGINS } from '@/components/chat/MarkdownText'
import { normalizeTags, pickTargetIndex, planBlockRender } from '@/lib/knowledgeBlocks'
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
}

export function KnowledgeDocView({ doc, targetLine = null }: KnowledgeDocViewProps) {
  const { t } = useTranslation()
  const renders = useMemo(() => planBlockRender(doc.blocks), [doc.blocks])
  const tags = useMemo(() => normalizeTags(doc.tags), [doc.tags])
  const targetIndex = useMemo(() => pickTargetIndex(renders, targetLine), [renders, targetLine])

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
                <KnowledgeEntryCard tag={r.tag} summary={r.summary} full={r.full} />
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
