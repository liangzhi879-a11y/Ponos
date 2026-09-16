// src/components/knowledge/KnowledgeWikiText.tsx —— 阅读视图里的内链（2026-09-14 对标 Obsidian 批次 1）
//
// 目标：`[[目标]]` / `[[目标|别名]]` 以及相对 `.md` 链接在**正文里可点**（读了就跳），
// 而不是像之前那样当普通文字（点不动）或一律 `target="_blank"` 跳出应用。
//
// 为什么用 React Context 而不是给 MD_COMPONENTS 传 props：
//   MarkdownText.tsx 文件头记着那起事故——components 表每渲染新建对象，react-markdown 会整棵
//   子树重挂载（输入抖动、滚动跳动）。表格必须**模块级稳定引用**，而"目标文档 → docId"的解析
//   又天然是每篇文档不同的数据。两个约束只能同时满足的做法就是：表格稳定（本文件顶层定义），
//   数据走 context（Provider 的值每篇文档换一次，但组件身份不变，不触发重挂载）。
//
// 断链（解析不到目标）渲染成**不可点的灰文本**并带 title 说明：Obsidian 也是这么做的
// （未解析链接显示为普通文字）。绝不做"看起来能点、点了没反应"的假按钮——那会让人反复试。
//
// 口径与内核 `shared/knowledge-core.mjs` 的 `extractLinks` / `resolveLinkTarget` 保持一致
// （候选顺序见 lib/knowledgeBlocks.wikiTargetCandidates）：解析只在**本空间内**成立
// （内核如此，跨空间链接属批次 2）。故解析不到不代表"文档不存在"，只是"不在这个空间/没链接过"。
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { MD_COMPONENTS } from '@/components/chat/MarkdownText'
import { splitWikiLinks } from '@/lib/knowledgeBlocks'
import { useDoc } from '@/hooks/useKnowledge'
import { cn } from '@/lib/utils'

/**
 * 嵌入预览最多渲染的块数（批次 2）。取 12：超过这个数，嵌入块会把正文挤到屏幕外，
 * 而它本来的角色是"顺手看一眼"——要看全文就点"打开文档"。
 */
const EMBED_MAX_BLOCKS = 12

export interface WikiResolver {
  /**
   * 链接目标 → docId；null = 断链。
   *
   * `opts.self` 是**同文档锚点** `[[#小节]]`（批次 2）：这类链接的 target 是空串（合法形态），
   * 宿主据此返回"当前文档自身"的 docId。旧实现因为 target 为空直接判断链，
   * 于是文档内部跳转全都变成不可点的灰文本。
   */
  resolve: (target: string, opts?: { self?: boolean }) => string | null
  /** 打开目标文档（宿主注入：切阅读视图 + 定位）。`anchor` 为空 = 纯打开（不定位） */
  open: (docId: string, anchor?: WikiAnchor) => void
}

export interface WikiAnchor {
  anchorRef: string
  anchorKind: 'heading' | 'block' | ''
}

const WikiLinkCtx = createContext<WikiResolver | null>(null)

export function WikiLinkProvider({ resolver, children }: { resolver: WikiResolver | null; children: ReactNode }) {
  return <WikiLinkCtx.Provider value={resolver}>{children}</WikiLinkCtx.Provider>
}

/** 取当前解析器；**没有 Provider 时返回 null**（聊天区的 MarkdownText 也复用 MD_COMPONENTS，
 *  那里没有"知识库文档"的概念，必须原样渲染，不能渲染出一堆灰文本）。 */
export function useWikiResolver(): WikiResolver | null {
  return useContext(WikiLinkCtx)
}

/**
 * 把 children 里的**字符串片段**按 `[[wiki]]` 切开，产出文本/内链混合节点；非字符串节点原样透传。
 *
 * 只处理字符串的理由：react-markdown 把段落内容给成 `[string, <strong>, string, ...]`，
 * 内链出现在**文本节点**里；它是节点属性（如链接 href）时不该再被当内链。
 * 嵌套（`**[[x]]**`）时 react-markdown 会把文本包在 `<strong>` 里，本函数看不到——属已知边界，
 * 批次 2 若要做全则需 remark 插件（引新依赖，超出批次 1 范围）。
 */
export function withWikiLinks(children: ReactNode, resolver: WikiResolver | null): ReactNode {
  if (!resolver) return children
  // 快路径：绝大多数块里没有 `[[`，直接返回原 children（保持引用稳定，避免无谓重渲染）
  const flat = Array.isArray(children) ? children : [children]
  const hasWiki = flat.some((c) => typeof c === 'string' && c.includes('[['))
  if (!hasWiki) return children

  const out: ReactNode[] = []
  flat.forEach((child, ci) => {
    if (typeof child !== 'string') { out.push(child); return }
    splitWikiLinks(child).forEach((chunk, i) => {
      if (chunk.type === 'text') { out.push(chunk.text); return }
      const target = chunk.target ?? ''
      // 同文档锚点（`[[#小节]]`）的 target 是空串：把 self 传下去让宿主返回"当前文档"
      const docId = resolver.resolve(target, { self: chunk.self })
      const label = chunk.label || target
      const anchor = chunk.anchorRef
        ? { anchorRef: chunk.anchorRef, anchorKind: chunk.anchorKind ?? '' }
        : undefined
      if (!docId) {
        // 断链：灰文本 + 说明。不画成链接样式（不骗人），但保留原文便于照抄去别处找
        return out.push(
          <span key={`w-${ci}-${i}`} className="text-tertiary/80" title={`未解析的链接：${chunk.text}`}>
            {label}
          </span>,
        )
      }
      // 嵌入 `![[x]]`（批次 2）：**不是**普通链接。Obsidian 语义是"把内容显示在这里"，
      // 渲染成一个可展开的引用块（默认折叠）—— 默认折叠是因为自动内联渲染要为每个嵌入
      // 拉一次目标文档（= 一次内核进程/请求），长文档里几个嵌入就能把打开文档变慢。
      // 折叠态仍保留可点入口，所以"能读"这件事没丢，只是用户先决定要不要读。
      if (chunk.embed) {
        return out.push(
          <WikiEmbed key={`w-${ci}-${i}`} docId={docId} target={target} label={label}
            resolver={resolver} anchor={anchor} />,
        )
      }
      return out.push(
        <button
          key={`w-${ci}-${i}`}
          type="button"
          onClick={() => resolver.open(docId, anchor)}
          title={chunk.text}
          className="text-brand-500/90 hover:text-[var(--accent-red)] underline decoration-brand-500/30 hover:decoration-[var(--accent-red)]/60 underline-offset-2"
        >
          {label}
        </button>,
      )
    })
  })
  return out
}

/**
 * 嵌入渲染（2026-09-14 批次 2）。`![[note]]` / `![[note#小节]]`。
 *
 * 设计取舍（**默认折叠、点击才拉数据**）：
 *   · 自动内联 = 每篇文档打开时为每个嵌入起一次请求（本应用内核是子进程，代价比普通 web 高得多），
 *     而嵌入常常是"备查而已、不必每次读"。折叠态只需一次点击，代价换来的收益更大。
 *   · 展开后**只渲染纯文本前若干块**，不递归解析嵌入 —— 嵌入里嵌嵌入会形成环（a 嵌 b、b 嵌 a），
 *     递归渲染会直接爆栈。这只是展示层，用户要看完整内容有"打开文档"按钮。
 *   · 解析不到锚点时如实提示（"锚点未找到"）而不是静默跳到文档开头：静默会让人以为跳对了。
 */
function WikiEmbed({ docId, target, label, resolver, anchor }: {
  docId: string
  target: string
  label: string
  resolver: WikiResolver
  anchor?: WikiAnchor
}) {
  const [expanded, setExpanded] = useState(false)
  // 只在展开后才拉（`useDoc` 传 null 时不请求）。折叠是默认态，故绝大多数嵌入零成本。
  const { data: doc, loading, error } = useDoc(expanded ? docId : null)
  const preview = useMemo(() => {
    if (!doc) return []
    const bs = Array.isArray(doc.blocks) ? doc.blocks : []
    return bs.slice(0, EMBED_MAX_BLOCKS).map((b) => String(b.text ?? '')).filter((s) => s.trim() !== '')
  }, [doc])

  return (
    <div className="my-1.5 border-l-2 border-brand-500/30 bg-surface/40 pl-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        title={`嵌入：${target ? `![[${target}]]` : '同文档'}`}
        className="flex items-center gap-1 text-[11px] text-brand-500/90 hover:text-[var(--accent-red)] transition-colors"
      >
        <ChevronRight className={cn('w-3 h-3 transition-transform', expanded && 'rotate-90')} />
        <span className="underline decoration-brand-500/30 underline-offset-2">{label}</span>
        <span className="text-tertiary/80">· 嵌入</span>
      </button>
      {expanded && (
        <div className="mt-1 pl-1">
          {loading && <div className="text-[10px] text-tertiary">…</div>}
          {error && <div className="text-[10px] text-error">{error}</div>}
          {doc && (
            <>
              <div className="text-[11px] leading-relaxed text-secondary whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                {preview.length ? preview.join('\n') : '（空文档）'}
              </div>
              {/* 嵌入只是**预览**：内容可能被截断（EMBED_MAX_BLOCKS），要给出明确出口 */}
              {(doc.blocks?.length ?? 0) > preview.length && (
                <div className="mt-0.5 text-[10px] text-tertiary">
                  仅显示前 {EMBED_MAX_BLOCKS} 块
                </div>
              )}
              <button
                type="button"
                onClick={() => resolver.open(docId, anchor)}
                className="mt-1 text-[10px] text-brand-500/90 hover:text-[var(--accent-red)] underline underline-offset-2"
              >
                打开文档
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** 段落：MD_COMPONENTS 没有 p 规则（浏览器默认 1em 边距太大），顺带在这里接内链 */
export function WikiP({ children }: { children?: ReactNode }) {
  const resolver = useWikiResolver()
  return <p className="my-1.5 leading-relaxed break-words [overflow-wrap:anywhere]">{withWikiLinks(children, resolver)}</p>
}

/** 列表项：MD_COMPONENTS 没有 li 规则；列表里出现 `[[x]]` 的概率不比段落低（清单式笔记） */
export function WikiLi({ children }: { children?: ReactNode }) {
  const resolver = useWikiResolver()
  return <li>{withWikiLinks(children, resolver)}</li>
}

/**
 * 站内/站外链接分流：
 *   · 相对 `.md`（`note.md` / `./note.md` / `sub/note.md`，可带 `#片段`）→ 尝试站内跳转
 *     （走 resolver 的候选比对）；解析不到则退回普通外链行为（不吞掉链接，用户还能复制 href）。
 *   · 其它（http/https/mailto 等）→ 原样交给聊天区的 a 规则，`target="_blank"` 语义不变。
 *
 * 为什么 ## 片段要剥掉再解析：内核的 resolveLinkTarget 也剥（只解析到文档级），
 * 这里不剥会出现"文档就在库里、却因为带了 `#标题` 而解析失败"的假断链。
 */
export function WikiA({ href, children }: { href?: string; children?: ReactNode }) {
  const resolver = useWikiResolver()
  const raw = String(href ?? '')
  const isRelMd = !!raw && !/^[a-z][a-z0-9+.-]*:/i.test(raw) && /\.mdx?(#|$)/i.test(raw)
  if (resolver && isRelMd) {
    // `#片段` 剥掉再解析（内核 resolveLinkTarget 也只解析到文档级），但**锚点要带走**：
    // 批次 2 起阅读视图能按锚点定位，剥了就丢（用户点"安装.md#安装步骤"却停在文档开头）。
    const hashAt = raw.indexOf('#')
    const target = hashAt >= 0 ? raw.slice(0, hashAt) : raw
    const frag = hashAt >= 0 ? raw.slice(hashAt + 1).trim() : ''
    const docId = resolver.resolve(target)
    if (docId) {
      const anchor = frag
        ? { anchorRef: frag.startsWith('^') ? frag.slice(1) : frag, anchorKind: (frag.startsWith('^') ? 'block' : 'heading') as 'heading' | 'block' }
        : undefined
      return (
        <button
          type="button"
          onClick={() => resolver.open(docId, anchor)}
          title={raw}
          className="text-brand-500/90 hover:text-[var(--accent-red)] underline decoration-brand-500/30 hover:decoration-[var(--accent-red)]/60 underline-offset-2"
        >
          {children}
        </button>
      )
    }
  }
  const Base = MD_COMPONENTS.a
  return Base ? <Base href={href}>{children}</Base> : <a href={href}>{children}</a>
}
