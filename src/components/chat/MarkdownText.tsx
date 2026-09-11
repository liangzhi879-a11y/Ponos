// 消息文本渲染共享模块（2026-09-09 会话 UI 标准化）
// ---------------------------------------------------------------------------
// 从 MessageBubble 抽出的 markdown 渲染三件套（MD_PLUGINS/MD_COMPONENTS/
// truncatePartialAskUser）+ assistant-ui 的 Text part 渲染组件（MarkdownTextPart）。
// 原组件流式期重建 components/插件对象会引发 ReactMarkdown 子树全量重挂载，
// 故保持模块级稳定引用；filePathP 依赖会话 cwd，经 ChatCwdContext 注入。
import { createContext, useContext, useCallback, type ReactNode } from 'react'
import ReactMarkdown, { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { FolderOpen } from 'lucide-react'
import { CodeBlock } from './CodeBlock'
import { BoxdrawTable } from './BoxdrawTable'
import QuestionCard from './QuestionCard'
import { extractAskUserCards } from '@/lib/askUser'
import { preprocessBoxDrawingTables, detectFilePaths, parseBoxDrawingTable } from '@/lib/utils'
import { openFileInEditor } from '@/lib/editorBridge'
import type { TextMessagePartProps } from '@assistant-ui/react'

export const MD_PLUGINS = [remarkGfm]

// 流式半截标记兜底：文本中出现未闭合的 <!--ASK_USER（尚无 -->）时截断到标记起点，
// 防止流式渲染闪现原始标记代码。已闭合的块由 extractAskUserCards 先行剥离。
export function truncatePartialAskUser(text: string): string {
  const m = /<!--\s*ASK_USER\b/.exec(text)
  if (!m) return text
  if (text.indexOf('-->', m.index + m[0].length) !== -1) return text
  return text.slice(0, m.index)
}

export const MD_COMPONENTS: Components = {
  pre({ children }) {
    return <>{children}</>
  },
  code({ className, children, node, ...props }) {
    const match = /language-(\w+)/.exec(className || '')
    const isInline = !match && !className
    if (isInline) {
      return <code className="bg-elevated px-1 py-0.5 rounded text-[0.85em] text-brand-500/85 font-mono break-all [overflow-wrap:anywhere]" {...props}>{children}</code>
    }
    const lang = match?.[1]

    // Recursively extract all text content from children
    const extractText = (node: any): string => {
      if (node == null || node === false || node === undefined) return ''
      if (typeof node === 'string') return node
      if (typeof node === 'number') return String(node)
      if (Array.isArray(node)) {
        return node.map(extractText).join('')
      }
      if (typeof node === 'object') {
        if (node.props && node.props.children != null) {
          return extractText(node.props.children)
        }
        if (node.children != null) {
          return extractText(node.children)
        }
        if (node.value != null && typeof node.value === 'string') {
          return node.value
        }
      }
      return ''
    }

    let codeStr = extractText(children)
    if (!codeStr && node) {
      codeStr = extractText(node)
    }
    codeStr = codeStr.replace(/\n$/, '')

    if (lang === 'boxdraw') {
      const parsed = parseBoxDrawingTable(codeStr)
      if (parsed) {
        return <BoxdrawTable table={parsed} />
      }
      return <CodeBlock code={codeStr} language="boxdraw" />
    }
    return <CodeBlock code={codeStr} language={lang} />
  },
  a({ href, children }) {
    return <a href={href} target="_blank" rel="noopener noreferrer" className="text-brand-500/90 hover:text-[var(--accent-red)] underline decoration-brand-500/30 hover:decoration-[var(--accent-red)]/60 underline-offset-2">{children}</a>
  },
  table({ children }) {
    return <div className="overflow-x-auto my-2 max-w-full"><table className="min-w-full border-collapse border border text-sm">{children}</table></div>
  },
  th({ children }) {
    return <th className="border border bg-elevated px-3 py-1.5 text-left font-semibold">{children}</th>
  },
  td({ children }) {
    return <td className="border border px-3 py-1.5">{children}</td>
  },
  h1({ children }) { return <h1 className="text-lg font-bold mt-4 mb-2 text-primary">{children}</h1> },
  h2({ children }) { return <h2 className="text-base font-bold mt-3 mb-1.5 text-primary">{children}</h2> },
  h3({ children }) { return <h3 className="text-sm font-semibold mt-2 mb-1 text-primary">{children}</h3> },
  ul({ children }) { return <ul className="list-disc pl-5 my-1 space-y-0.5">{children}</ul> },
  ol({ children }) { return <ol className="list-decimal pl-5 my-1 space-y-0.5">{children}</ol> },
  blockquote({ children }) {
    return <blockquote className="border-l-2 border-brand-500/25 pl-3 my-2 text-tertiary italic">{children}</blockquote>
  },
  hr() { return <hr className="my-3 border" /> },
}

/** 会话上下文（cwd + conversationId），由 ChatWindow 提供，供 part 渲染器使用。 */
export const ChatContext = createContext<{ cwd: string; conversationId: string }>({ cwd: '', conversationId: '' })

function makeFilePathP(cwd: string) {
  return function filePathP(props: any) {
    const children = props.children
    const textContent = typeof children === 'string' ? children : Array.isArray(children) ? children.map((c: any) => typeof c === 'string' ? c : '').join('') : ''
    if (!textContent) return <p className="my-1 leading-relaxed">{children}</p>

    const paths = detectFilePaths(textContent, cwd)
    if (paths.length === 0) return <p className="my-1 leading-relaxed">{children}</p>

    const segments: ReactNode[] = []
    let lastEnd = 0
    for (const fp of paths) {
      if (fp.start > lastEnd) {
        segments.push(textContent.slice(lastEnd, fp.start))
      }
      const fname = fp.text.split(/[/\\]/).pop() || fp.text
      segments.push(
        <span key={fp.start} className="inline-flex items-center gap-0.5 group/filepath">
          <FolderOpen className="w-3.5 h-3.5 text-warning/70 shrink-0" />
          <a
            href="#"
            onClick={e => {
              e.preventDefault()
              e.stopPropagation()
              const api = (window as any).yfworkingAPI
              if (api?.openFile) api.openFile(fp.path, fp.text)
              else openFileInEditor(fp.path, fp.text)
            }}
            onContextMenu={e => {
              e.preventDefault()
              e.stopPropagation()
              const api = (window as any).yfworkingAPI
              if (api?.openInExplorer) api.openInExplorer(fp.path)
            }}
            className="text-brand-500/90 hover:text-brand-500 underline decoration-brand-500/30 hover:decoration-brand-500/60 underline-offset-2 cursor-pointer"
            title={fp.path + '\nClick to open in editor  |  Right-click → Open in Explorer'}
          >{fname}</a>
        </span>
      )
    }
    if (lastEnd < textContent.length) {
      segments.push(textContent.slice(lastEnd))
    }
    return <p className="my-1 leading-relaxed">{segments}</p>
  }
}

/** assistant-ui Text part 渲染：ASK_USER 剥离 + 流式半截截断 + markdown + 文件路径链接。 */
export function MarkdownTextPart({ text }: TextMessagePartProps) {
  const { cwd } = useContext(ChatContext)
  const filePathP = useCallback(makeFilePathP(cwd), [cwd])
  const { cards, clean } = extractAskUserCards(typeof text === 'string' ? text : '')
  const safeText = truncatePartialAskUser(clean)
  return (
    <>
      {cards.map((card, i) => (
        <QuestionCard key={`ask-${i}`} payload={card} readOnly />
      ))}
      {safeText.trim() ? (
        <div className="prose max-w-none text-primary leading-relaxed break-words [overflow-wrap:break-word] [word-break:break-word]" style={{ fontSize: 'var(--chat-font, 14px)' }}>
          <ReactMarkdown
            remarkPlugins={MD_PLUGINS}
            components={{ ...MD_COMPONENTS, p: filePathP }}
          >
            {preprocessBoxDrawingTables(safeText)}
          </ReactMarkdown>
        </div>
      ) : null}
    </>
  )
}
