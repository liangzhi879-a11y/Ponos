import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react'
import { useUIStore } from '@/stores/uiStore'
import { useTranslation } from '@/i18n/useTranslation'
import { cn } from '@/lib/utils'
import { getBridgeUrl } from '@/lib/config'
import type { FileTab } from '@/types'

export interface SheetEditorHandle {
  save: () => Promise<boolean>
}

interface SheetData {
  name: string
  rows: (string | number | boolean | null)[][]
  formulas: boolean[][]
}

/** 单元格写回值：空输入 → null；原为数字且输入可解析 → 数字；其余按文本 */
function coerceCellValue(orig: unknown, input: string): unknown {
  if (input.trim() === '') return null
  if (typeof orig === 'number' && input.trim() !== '' && !Number.isNaN(Number(input))) {
    return Number(input)
  }
  return input
}

// 轻量 Excel 网格编辑器：点击编辑、Enter 下移 / Tab 右移 / Esc 取消、公式格只读
export const SheetEditor = forwardRef<SheetEditorHandle, { file: FileTab }>(function SheetEditor(
  { file },
  ref
) {
  const { markFileModified, markFileSaved } = useUIStore()
  const { t } = useTranslation()
  const [sheets, setSheets] = useState<SheetData[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null)
  const [editText, setEditText] = useState('')
  const [, forceRender] = useState(0)

  // 已编辑格（写回用）；key = "r,c"（0-based）
  const dirtyRef = useRef<Map<string, { row: number; col: number; value: unknown }>>(new Map())
  // 编辑态同步 ref，避免 input 卸载触发的 onBlur 读到陈旧闭包
  const editingRef = useRef(editing)
  const skipBlurRef = useRef(false)
  useEffect(() => { editingRef.current = editing }, [editing])

  useEffect(() => {
    let cancelled = false
    fetch(getBridgeUrl() + '/read-sheet?path=' + encodeURIComponent(file.path))
      .then(r => r.json())
      .then(d => {
        if (cancelled) return
        if (d.error) throw new Error(d.error)
        setSheets(d.sheets || [])
        setLoading(false)
      })
      .catch((e: any) => {
        if (!cancelled) { setError(e?.message || t('common.loading')); setLoading(false) }
      })
    return () => { cancelled = true }
  }, [file.path])

  const sheet = sheets?.[0]

  const beginEdit = (r: number, c: number) => {
    if (!sheet || sheet.formulas?.[r]?.[c]) return // 公式格只读
    const key = r + ',' + c
    const dirty = dirtyRef.current.get(key)
    setEditing({ r, c })
    setEditText(dirty !== undefined ? String(dirty.value ?? '') : String(sheet.rows[r]?.[c] ?? ''))
  }

  const commitEdit = (move?: { dr: number; dc: number }) => {
    const cur = editingRef.current
    if (!cur || !sheet) { setEditing(null); return }
    const { r, c } = cur
    const key = r + ',' + c
    const orig = sheet.rows[r]?.[c] ?? null
    const value = coerceCellValue(orig, editText)
    const unchanged = value === orig || (value === null && (orig === '' || orig === null))
    if (unchanged) {
      dirtyRef.current.delete(key)
    } else {
      dirtyRef.current.set(key, { row: r + 1, col: c + 1, value })
      markFileModified(file.id)
    }
    forceRender(x => x + 1)
    if (move) {
      const nr = r + move.dr
      const nc = c + move.dc
      const maxCols = sheet.rows[0]?.length || 1
      if (nr >= 0 && nc >= 0 && nr < sheet.rows.length && nc < maxCols) {
        setEditing({ r: nr, c: nc })
        setEditText(String(sheet.rows[nr]?.[nc] ?? ''))
        return
      }
    }
    setEditing(null)
  }

  useImperativeHandle(ref, () => ({
    save: async () => {
      if (!sheet) return false
      const updates = [...dirtyRef.current.values()]
      if (updates.length === 0) return true
      try {
        const res = await fetch(getBridgeUrl() + '/write-sheet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: file.path, sheet: sheet.name, updates }),
        })
        const data = await res.json()
        if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
        dirtyRef.current.clear()
        setSaveError('')
        forceRender(x => x + 1)
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
  if (!sheet) {
    return <div className="flex-1 min-h-0 flex items-center justify-center text-tertiary text-sm">{t('fileBrowser.empty')}</div>
  }

  const renderCell = (r: number, c: number, value: unknown) => {
    const key = r + ',' + c
    const dirty = dirtyRef.current.get(key)
    const display = dirty !== undefined ? dirty.value : value
    const isFormula = sheet.formulas?.[r]?.[c]
    const isEditing = editing?.r === r && editing?.c === c

    if (isEditing) {
      return (
        <input
          autoFocus
          value={editText}
          onChange={e => setEditText(e.target.value)}
          onBlur={() => {
            if (skipBlurRef.current) { skipBlurRef.current = false; return }
            commitEdit()
          }}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault()
              skipBlurRef.current = true
              commitEdit({ dr: 1, dc: 0 })
            } else if (e.key === 'Tab') {
              e.preventDefault()
              skipBlurRef.current = true
              commitEdit({ dr: 0, dc: 1 })
            } else if (e.key === 'Escape') {
              skipBlurRef.current = true
              setEditing(null)
            }
          }}
          className="w-full min-w-[80px] bg-input text-primary outline-none px-1.5 py-1 border border-brand-500 text-[13px]"
          spellCheck={false}
        />
      )
    }

    return (
      <div
        className={cn(
          'px-2 py-1 min-w-[80px] cursor-text whitespace-pre text-[13px]',
          isFormula ? 'text-info/80 bg-elevated' : 'text-primary',
          dirty !== undefined && 'bg-warning/15'
        )}
        onClick={() => beginEdit(r, c)}
        title={isFormula ? '公式格（只读，保留原公式）' : String(display ?? '')}
      >
        {display === null || display === '' ? '\u00A0' : String(display)}
        {isFormula && <span className="ml-1 text-[9px] text-info/60 select-none align-middle">fx</span>}
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-surface">
      <div className="flex items-center gap-2 px-3 py-1 bg-modal text-xs text-tertiary border-b shrink-0">
        <span className="truncate">{sheet.name}</span>
        {dirtyRef.current.size > 0 && <span className="text-warning/80">• {dirtyRef.current.size} 处改动</span>}
        {saveError && <span className="text-error truncate" title={saveError}>⚠ {saveError}</span>}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="border-collapse w-max min-w-full">
          <thead>
            <tr>
              {sheet.rows[0]?.map((v, c) => (
                <th key={c} className="border border-weak bg-elevated px-2 py-1 text-left font-semibold text-primary text-[13px] sticky top-0 z-[1]">
                  {v === null || v === '' ? '\u00A0' : String(v)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.slice(1).map((row, r) => (
              <tr key={r}>
                {row.map((v, c) => (
                  <td key={c} className="border border-weak">
                    {renderCell(r + 1, c, v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
})
