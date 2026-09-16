import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react'
import { useUIStore } from '@/stores/uiStore'
import { useTranslation } from '@/i18n/useTranslation'
import { cn } from '@/lib/utils'
import { getBridgeUrl } from '@/lib/config'
import type { FileTab } from '@/types'

export interface SheetEditorHandle {
  save: () => Promise<boolean>
  /** 最近一次保存失败的原因（供上层 `FileEditor` 转述）。用方法而非属性：属性会被闭包定格。 */
  lastError: () => string
}

interface SheetData {
  name: string
  rows: (string | number | boolean | null)[][]
  formulas: boolean[][]
  /** 行/列的内容指纹（服务端按内容算，插删行列后不漂移）。**提交时按它寻址，不用行号**：
   *  行号在插入/删除后会整体错位（实测 1 处插入会被误报成 19 处修改）。 */
  rowIds: string[]
  colIds: string[]
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
  // 提交时的基线版本（服务端据此判断"我读到之后有没有人改过"）
  const [baseVersion, setBaseVersion] = useState('')
  // 版本冲突与普通失败分开：冲突时用户该"重新载入"，重试保存必然再失败
  const [conflict, setConflict] = useState(false)
  // 状态驱动重载（不用 window.location.reload：那会连编辑器外壳一起重建，丢失当前上下文）
  const [reloadTick, setReloadTick] = useState(0)
  const [, forceRender] = useState(0)

  // 已编辑格（写回用）；key = "r,c"（0-based）。存的是**值**，
  // 寻址标识（rowId/colId）在保存时从基线数组取 —— 保证地址永远是"我读到的那份"的地址。
  const dirtyRef = useRef<Map<string, { value: unknown }>>(new Map())
  // 编辑态同步 ref，避免 input 卸载触发的 onBlur 读到陈旧闭包
  const editingRef = useRef(editing)
  const skipBlurRef = useRef(false)
  // 与 `saveError` 同值的 ref：句柄方法会被闭包定格，读 state 会拿到旧值；失败原因必须最新
  const saveErrorRef = useRef('')
  useEffect(() => { editingRef.current = editing }, [editing])

  useEffect(() => {
    let cancelled = false
    fetch(getBridgeUrl() + '/read-sheet?path=' + encodeURIComponent(file.path))
      .then(r => r.json())
      .then(d => {
        if (cancelled) return
        if (d.error) throw new Error(d.error)
        setSheets(d.sheets || [])
        setBaseVersion(d.baseVersion || '')
        // 载入即清空待提交改动：服务端内容成为新基线，旧的寻址标识已无意义
        dirtyRef.current.clear()
        setConflict(false)
        setSaveError('')
        saveErrorRef.current = ''
        setLoading(false)
      })
      .catch((e: any) => {
        if (!cancelled) { setError(e?.message || t('common.loading')); setLoading(false) }
      })
    return () => { cancelled = true }
  }, [file.path, reloadTick])

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
      dirtyRef.current.set(key, { value })
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
      if (dirtyRef.current.size === 0) return true
      // 把 UI 的 (r,c) 映射成**基线的内容指纹**：一旦有人插删行列，行号会漂移，
      // 而 rowId/colId 不会 —— 这正是"改动写到别人那一行"这类静默错误的根治办法。
      const ops = []
      for (const [key, d] of dirtyRef.current) {
        const [rs, cs] = key.split(',')
        const r = Number(rs), c = Number(cs)
        const rowId = sheet.rowIds?.[r]
        const colId = sheet.colIds?.[c]
        if (!rowId || !colId) continue // 越界（例如表格被外部改小）：跳过而不是猜一个地址
        ops.push({ op: 'updateCell', rowId, colId, value: d.value })
      }
      if (ops.length === 0) return true
      try {
        const res = await fetch(getBridgeUrl() + '/write-sheet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: file.path, sheet: sheet.name, baseVersion, ops }),
        })
        const data = await res.json()
        if (!res.ok || !data.ok) {
          // 409 = 版本冲突（我读到之后有人改了）：单独标记，引导用户重新载入
          if (res.status === 409 || data.code === 'base-version-mismatch') setConflict(true)
          throw new Error(data.error || `HTTP ${res.status}`)
        }
        if (data.baseVersion) setBaseVersion(data.baseVersion)
        dirtyRef.current.clear()
        saveErrorRef.current = ''
        setSaveError('')
        setConflict(false)
        forceRender(x => x + 1)
        markFileSaved(file.id)
        return true
      } catch (e: any) {
        const msg = e?.message || '保存失败'
        saveErrorRef.current = msg
        setSaveError(msg)
        return false
      }
    },
    lastError: () => saveErrorRef.current,
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
        {conflict && (
          <span className="text-error flex items-center gap-2">
            ⚠ 文件已被其他程序或协作者修改，你的改动**未**保存（避免覆盖对方内容）
            <button
              onClick={() => setReloadTick(n => n + 1)}
              className="px-2 py-0.5 rounded border border-error/50 hover:bg-error/10 text-[12px]"
            >
              重新载入
            </button>
          </span>
        )}
        {saveError && !conflict && <span className="text-error truncate" title={saveError}>⚠ {saveError}</span>}
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
