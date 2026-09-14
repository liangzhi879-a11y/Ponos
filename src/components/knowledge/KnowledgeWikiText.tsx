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
import { createContext, useContext, type ReactNode } from 'react'
import { MD_COMPONENTS } from '@/components/chat/MarkdownText'
import { splitWikiLinks } from '@/lib/knowledgeBlocks'

export interface WikiResolver {
  /** 链接原文目标（`[[x]]` 的 x，或相对路径 href）→ 已解析的 docId；null = 断链 */
  resolve: (target: string) => string | null
  /** 打开目标文档（宿主注入：切阅读视图 + 清定位，见 store 的 openDoc 类动作） */
  open: (docId: string) => void
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
      const docId = resolver.resolve(target)
      const label = chunk.label || target
      out.push(
        docId ? (
          <button
            key={`w-${ci}-${i}`}
            type="button"
            onClick={() => resolver.open(docId)}
            title={`[[${target}]]`}
            className="text-brand-500/90 hover:text-[var(--accent-red)] underline decoration-brand-500/30 hover:decoration-[var(--accent-red)]/60 underline-offset-2"
          >
            {label}
          </button>
        ) : (
          // 断链：灰文本 + 说明。不画成链接样式（不骗人），但保留原文便于照抄去别处找
          <span key={`w-${ci}-${i}`} className="text-tertiary/80" title={`未解析的链接：[[${target}]]`}>
            {label}
          </span>
        ),
      )
    })
  })
  return out
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
    const target = raw.split('#')[0]
    const docId = resolver.resolve(target)
    if (docId) {
      return (
        <button
          type="button"
          onClick={() => resolver.open(docId)}
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
