import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react'
import { useUIStore } from '@/stores/uiStore'
import { useTranslation } from '@/i18n/useTranslation'
import { cn } from '@/lib/utils'
import { getBridgeUrl } from '@/lib/config'
import type { FileTab } from '@/types'

export interface DocxEditorHandle {
  save: () => Promise<boolean>
}

interface DocxBlock {
  kind: 'h1' | 'h2' | 'h3' | 'p' | 'table'
  text?: string
  rows?: string[][]
}

const STYLE: Record<string, string> = {
  h1: 'text-xl font-bold text-primary',
  h2: 'text-lg font-semibold text-primary',
  h3: 'text-base font-medium text-primary',
  p: 'text-sm text-primary',
}

const resize = (el: HTMLTextAreaElement) => {
  el.style.height = 'auto'
  el.style.height = Math.max(el.scrollHeight, 28) + 'px'
}

// Word 块结构编辑器：标题/段落自适应 textarea + 表格网格，保存写回原 .docx
export const DocxEditor = forwardRef<DocxEditorHandle, { file: FileTab }>(function DocxEditor(
  { file },
  ref
) {
  const { markFileModified, markFileSaved } = useUIStore()
  const { t } = useTranslation()
  const [blocks, setBlocks] = useState<DocxBlock[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saveError, setSaveError] = useState('')
  const dirtyRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    fetch(getBridgeUrl() + '/read-docx?path=' + encodeURIComponent(file.path))
      .then(r => r.json())
      .then(d => {
        if (cancelled) return
        if (d.error) throw new Error(d.error)
        setBlocks(d.blocks || [])
        setLoading(false)
      })
      .catch((e: any) => {
        if (!cancelled) { setError(e?.message || t('common.loading')); setLoading(false) }
      })
    return () => { cancelled = true }
  }, [file.path])

  const updateText = (i: number, text: string) => {
    dirtyRef.current = true
    setBlocks(prev => prev!.map((b, bi) => (bi === i ? { ...b, text } : b)))
    markFileModified(file.id)
  }
  const updateCell = (i: number, r: number, c: number, value: string) => {
    dirtyRef.current = true
    setBlocks(prev =>
      prev!.map((b, bi) =>
        bi === i
          ? { ...b, rows: b.rows!.map((row, ri) => (ri === r ? row.map((v, ci) => (ci === c ? value : v)) : row)) }
          : b
      )
    )
    markFileModified(file.id)
  }

  useImperativeHandle(ref, () => ({
    save: async () => {
      if (!blocks) return false
      if (!dirtyRef.current) return true
      try {
        const res = await fetch(getBridgeUrl() + '/write-docx', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: file.path, blocks }),
        })
        const data = await res.json()
        if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
        dirtyRef.current = false
        setSaveError('')
        markFileSaved(file.id)
        return true
      } catch (e: any) {
        setSaveError(e?.message || '保存失败')
        return false
      }
    },
  }))

  if (loading) {
    return <div className="flex-1 min-h-0 flex items-center justify-center text-tertiary text-sm">{t('common.loading')}</div>
  }
  if (error) {
    return <div className="flex-1 min-h-0 flex items-center justify-center text-error text-sm p-4">{error}</div>
  }
  if (!blocks) {
    return <div className="flex-1 min-h-0 flex items-center justify-center text-tertiary text-sm">{t('fileBrowser.empty')}</div>
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-surface">
      <div className="flex items-center gap-2 px-3 py-1 bg-modal text-xs text-tertiary border-b shrink-0">
        <span>段落/表格文本编辑（图片与嵌入对象不受影响）</span>
        {dirtyRef.current && <span className="text-warning/80">• 有改动</span>}
        {saveError && <span className="text-error truncate" title={saveError}>⚠ {saveError}</span>}
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-6">
        <div className="max-w-4xl mx-auto space-y-1.5">
          {blocks.map((b, i) => {
            if (b.kind === 'table') {
              return (
                <table key={i} className="w-full border-collapse mb-3">
                  <tbody>
                    {(b.rows || []).map((row, r) => (
                      <tr key={r}>
                        {row.map((v, c) => (
                          <td key={c} className="border border-weak p-1">
                            <input
                              value={v}
                              onChange={e => updateCell(i, r, c, e.target.value)}
                              className="w-full bg-transparent text-primary text-[13px] px-1 py-0.5 outline-none focus:bg-input"
                              spellCheck={false}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            }
            return (
              <textarea
                key={i}
                value={b.text || ''}
                onChange={e => { resize(e.target); updateText(i, e.target.value) }}
                onInput={e => resize(e.target as HTMLTextAreaElement)}
                ref={el => { if (el) resize(el) }}
                className={cn(
                  'w-full bg-transparent outline-none resize-none leading-relaxed px-1 rounded focus:bg-elevated/60',
                  STYLE[b.kind] || STYLE.p
                )}
                spellCheck={false}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
})
