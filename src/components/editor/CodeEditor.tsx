import { useEffect, useRef } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor } from '@codemirror/view'
import { EditorState, type Extension } from '@codemirror/state'
import { indentOnInput, bracketMatching, foldGutter, foldKeymap, syntaxTree, HighlightStyle, syntaxHighlighting, indentUnit } from '@codemirror/language'
import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { lintGutter, linter, lintKeymap, type LintSource, type Diagnostic } from '@codemirror/lint'
import { tags } from '@lezer/highlight'
import { python } from '@codemirror/lang-python'
import { javascript } from '@codemirror/lang-javascript'
import { json, jsonParseLinter } from '@codemirror/lang-json'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { markdown } from '@codemirror/lang-markdown'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import { cpp } from '@codemirror/lang-cpp'
import { sql } from '@codemirror/lang-sql'
import { java } from '@codemirror/lang-java'
import { rust } from '@codemirror/lang-rust'
import { php } from '@codemirror/lang-php'
import { vue } from '@codemirror/lang-vue'
import { less } from '@codemirror/lang-less'
import { sass } from '@codemirror/lang-sass'
import type { FileTab } from '@/types'

/* ------------------------------------------------------------------ */
/* 语法高亮：中间调色板，深色/浅色主题均保持可读                          */
/* ------------------------------------------------------------------ */
const editorHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#b48eff' },
  { tag: [tags.name, tags.deleted, tags.character, tags.propertyName, tags.macroName], color: '#7ec8ff' },
  { tag: [tags.function(tags.variableName), tags.labelName], color: '#ffd166' },
  { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: '#ffb454' },
  { tag: [tags.definition(tags.name), tags.separator], color: '#e8d6b8' },
  { tag: [tags.typeName, tags.className, tags.number, tags.changed, tags.annotation, tags.modifier, tags.self, tags.namespace], color: '#4dd0e1' },
  { tag: [tags.operator, tags.operatorKeyword, tags.url, tags.escape, tags.regexp, tags.link, tags.special(tags.string)], color: '#f472b6' },
  { tag: [tags.meta, tags.comment], color: '#8a8f98', fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: '#6ea8fe', textDecoration: 'underline' },
  { tag: tags.heading, fontWeight: 'bold', color: '#b48eff' },
  { tag: [tags.atom, tags.bool, tags.contentSeparator, tags.labelName], color: '#7ec8ff' },
  { tag: [tags.inserted, tags.attributeName], color: '#7ee0a3' },
  { tag: tags.invalid, color: '#f87171' },
])

/* ------------------------------------------------------------------ */
/* 主题：全部使用应用语义 CSS 变量，随主题（深色/浅色/玻璃）自动适配        */
/* ------------------------------------------------------------------ */
const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
    backgroundColor: 'var(--bg-code)',
    color: 'var(--code-text)',
  },
  '.cm-scroller': {
    fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', ui-monospace, 'Segoe UI Mono', monospace",
    lineHeight: '1.6',
    overflow: 'auto',
  },
  '.cm-content': { caretColor: 'var(--accent-default)', padding: '8px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent-default)' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection-bg)' },
  '.cm-activeLine': { backgroundColor: 'var(--bg-hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--bg-hover)', color: 'var(--text-secondary)' },
  '.cm-gutters': { backgroundColor: 'var(--bg-code)', color: 'color-mix(in srgb, var(--code-text) 60%, transparent)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '2.6em', padding: '0 0.5em 0 0.6em' },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 0.3em', color: 'var(--text-tertiary)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--selection-bg)' },
  '.cm-nonmatchingBracket': { backgroundColor: 'rgb(var(--error-rgb) / 0.35)' },
  '.cm-searchMatch': { backgroundColor: 'rgb(var(--warning-rgb) / 0.25)', outline: '1px solid rgb(var(--warning-rgb) / 0.6)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgb(var(--warning-rgb) / 0.5)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--bg-popover)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-md)',
    overflow: 'hidden',
  },
  '.cm-panels': {
    backgroundColor: 'var(--bg-surface)',
    color: 'var(--text-primary)',
    borderBottom: '1px solid var(--border-subtle)',
    fontSize: '12px',
  },
  '.cm-panels input': {
    backgroundColor: 'var(--bg-input)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-sm)',
    padding: '2px 6px',
    fontSize: '12px',
  },
  '.cm-panels button': {
    backgroundColor: 'var(--bg-elevated)',
    color: 'var(--text-secondary)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-sm)',
    padding: '2px 8px',
    fontSize: '12px',
    cursor: 'pointer',
  },
  '.cm-panels label': { color: 'var(--text-tertiary)' },
  '.cm-lintRange-error': { textDecoration: 'underline wavy rgb(var(--error-rgb) / 0.7) 1px' },
  '.cm-lintRange-warning': { textDecoration: 'underline wavy rgb(var(--warning-rgb) / 0.7) 1px' },
  '.cm-lint-marker-error': { color: 'rgb(var(--error-rgb))' },
  '.cm-lint-marker-warning': { color: 'rgb(var(--warning-rgb))' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--bg-elevated)', border: 'none', color: 'var(--text-tertiary)', borderRadius: 'var(--radius-sm)' },
}, { dark: true })

/* ------------------------------------------------------------------ */
/* 语言映射：getFileLanguage() 返回值 → CodeMirror 语言扩展              */
/* ------------------------------------------------------------------ */
function getLanguageExtension(lang: string): Extension | null {
  switch (lang) {
    case 'python': return python()
    case 'javascript': return javascript()
    case 'jsx': return javascript({ jsx: true })
    case 'typescript': return javascript({ typescript: true })
    case 'tsx': return javascript({ typescript: true, jsx: true })
    case 'json': return json()
    case 'css': return css()
    case 'html': return html()
    case 'markdown': return markdown()
    case 'xml': return xml()
    case 'yaml': return yaml()
    case 'cpp': return cpp()
    case 'c': return cpp()
    case 'sql': return sql()
    case 'java': return java()
    case 'rust': return rust()
    case 'php': return php()
    case 'vue': return vue()
    case 'less': return less()
    case 'sass': return sass()
    default: return null
  }
}

/* 语言级 linter（提供更精确的错误消息；无则退回通用语法树检查） */
function getLanguageLinter(lang: string): LintSource | null {
  switch (lang) {
    case 'json':
      return jsonParseLinter()
    default:
      return null
  }
}

/* 通用语法错误检测：遍历解析树标记错误节点（适用于所有带解析器的语言，
   含 Python/JS/TS——语法错误会在输入时实时标出） */
const syntaxErrorLinter: LintSource = view => {
  const diags: Diagnostic[] = []
  syntaxTree(view.state).iterate({ enter(node) {
    if (node.type.isError) {
      const text = view.state.doc.sliceString(node.from, Math.min(node.to, node.from + 60)).trim()
      diags.push({
        from: node.from,
        to: node.to,
        severity: 'error',
        message: text ? `语法错误：${text}` : '语法错误',
        source: 'syntax',
      })
    }
  } })
  return diags
}

interface Props {
  file: FileTab
  onChange: (content: string) => void
  onSave: () => void
}

/**
 * CodeMirror 6 代码编辑器：行号、语法高亮、实时错误检测（lint）、
 * 自动缩进（Tab/回车智能缩进）、搜索与替换（Ctrl+F / Ctrl+H）。
 * 以 key={file.id} 挂载，标签切换自动重建（内容以 file.content 为准）。
 */
export function CodeEditor({ file, onChange, onSave }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  onChangeRef.current = onChange
  onSaveRef.current = onSave

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const lang = getLanguageExtension(file.language)
    const langLinter = getLanguageLinter(file.language)

    const state = EditorState.create({
      doc: file.content,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        foldGutter(),
        history(),
        drawSelection(),
        dropCursor(),
        indentOnInput(),          // 智能缩进：回车后自动延续缩进/对齐括号
        bracketMatching(),
        closeBrackets(),          // 自动补全括号/引号
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        indentUnit.of('    '),
        syntaxHighlighting(editorHighlight),
        editorTheme,
        ...(lang ? [lang] : []),
        lintGutter(),
        linter(syntaxErrorLinter),
        ...(langLinter ? [linter(langLinter)] : []),
        EditorView.contentAttributes.of({ spellcheck: 'false' }),
        EditorView.updateListener.of(update => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString())
        }),
        keymap.of([
          { key: 'Mod-s', run: () => { onSaveRef.current(); return true } },
          indentWithTab,           // Tab 缩进/反缩进
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,         // Ctrl+F 搜索 / Ctrl+H 替换 / F3 下一个
          ...historyKeymap,        // Ctrl+Z / Ctrl+Shift+Z
          ...foldKeymap,           // Ctrl+Shift+[ / ] 折叠
          ...lintKeymap,           // Ctrl+Shift+M 打开 lint 面板
        ]),
      ],
    })
    const view = new EditorView({ state, parent: container })
    viewRef.current = view
    view.focus()

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // 组件以 key={file.id} 挂载，语言/内容在挂载期内固定，仅初始化一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 外部内容更新（如打开文件后的 /read-file 异步结果）→ 同步进编辑器
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (view.state.doc.toString() !== file.content) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: file.content } })
    }
  }, [file.content])

  return <div ref={containerRef} className="flex-1 min-h-0 overflow-hidden" />
}
