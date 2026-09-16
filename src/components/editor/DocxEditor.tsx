import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react'
import { useUIStore } from '@/stores/uiStore'
import { useTranslation } from '@/i18n/useTranslation'
import { cn } from '@/lib/utils'
import { getBridgeUrl } from '@/lib/config'
import type { FileTab } from '@/types'

export interface DocxEditorHandle {
  save: () => Promise<boolean>
  /** 最近一次保存失败的原因（供上层 `FileEditor` 转述）。用方法而非属性：
   *  属性会被 React 闭包定格在旧值上，而失败原因必须永远是最新的一次。 */
  lastError: () => string
}

interface DocxBlock {
  /** 稳定块 id（服务端按内容算，Word 重存也不变）。**寻址一律用它，禁用下标**：
   *  实测下标寻址在插入/删除后会整体错位（spec §6.1 记录 17/17 → 2/17）。 */
  blockId: string
  kind: 'h1' | 'h2' | 'h3' | 'p' | 'table'
  text?: string
  rows?: string[][]
}

/** 待提交的编辑操作。与 `SheetEditor` 的 dirty Map 同构：**以 id 为键**，
 *  同一块反复编辑只保留最后一条（Map 天然幂等），保存时取 values() 一次性提交。 */
type DocxOp =
  | { op: 'update'; blockId: string; text: string }
  | { op: 'update'; blockId: string; rows: string[][] }

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
  const [baseVersion, setBaseVersion] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saveError, setSaveError] = useState('')
  // 冲突态与普通失败**分开**：baseVersion 不匹配时用户该做的是"重新载入"，
  // 而不是"重试保存"（重试必然再失败）。Prompt 若混在一起，用户就会反复点保存却永远不成功。
  const [conflict, setConflict] = useState(false)
  // 冲突后必须能一键重读：`reloadTick` 变化即触发下面的载入 effect 重跑。
  // 用状态驱动重载而不是 window.location.reload()：后者会连编辑器外壳一起重建，
  // 用户会丢失"当前在编辑哪个文件"的上下文。
  const [reloadTick, setReloadTick] = useState(0)
  const dirtyRef = useRef<Map<string, DocxOp>>(new Map())
  // 与 `saveError` 同值的 ref：句柄里的方法会被闭包定格，读 state 会拿到旧值；
  // 失败原因必须是最新的，故用 ref 镜像一份。
  const saveErrorRef = useRef('')

  useEffect(() => {
    let cancelled = false
    fetch(getBridgeUrl() + '/read-docx?path=' + encodeURIComponent(file.path))
      .then(r => r.json())
      .then(d => {
        if (cancelled) return
        if (d.error) throw new Error(d.error)
        setBlocks(d.blocks || [])
        // 记录基线版本：保存时要带回它，服务端据此判断"我读到之后有没有人改过"
        setBaseVersion(d.baseVersion || '')
        // 载入即清空待提交操作 —— 服务端内容成为新基线，旧的 ops 已无意义
        dirtyRef.current = new Map()
        setConflict(false)
        setSaveError('')
        setLoading(false)
      })
      .catch((e: any) => {
        if (!cancelled) { setError(e?.message || t('common.loading')); setLoading(false) }
      })
    return () => { cancelled = true }
  }, [file.path, reloadTick])

  const updateText = (blockId: string, text: string) => {
    // 以 blockId 记账（不再用下标）：下标在经历插入/删除后会整体错位，而 id 不会
    dirtyRef.current.set(blockId, { op: 'update', blockId, text })
    setBlocks(prev => prev!.map(b => (b.blockId === blockId ? { ...b, text } : b)))
    markFileModified(file.id)
  }
  const updateCell = (blockId: string, r: number, c: number, value: string) => {
    // 从当前 state 算出新 rows 再记账：同一格连改两次时，Map 里只保留最后一条（天然幂等）
    const cur = blocks?.find(b => b.blockId === blockId)
    const rows = (cur?.rows || []).map((row, ri) => (ri === r ? row.map((v, ci) => (ci === c ? value : v)) : row))
    dirtyRef.current.set(blockId, { op: 'update', blockId, rows })
    setBlocks(prev => prev!.map(b => (b.blockId === blockId ? { ...b, rows } : b)))
    markFileModified(file.id)
  }

  useImperativeHandle(ref, () => ({
    save: async () => {
      if (!blocks) return false
      const ops = [...dirtyRef.current.values()]
      if (!ops.length) return true
      try {
        const res = await fetch(getBridgeUrl() + '/write-docx', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // 只提交 ops（不再回传整篇 blocks）：服务端按 blockId 定位。
          // 回传整篇曾导致"少发一块 ⇒ 后面全部错位写入"，且服务端无法分辨，只能静默接受。
          body: JSON.stringify({ path: file.path, baseVersion, ops }),
        })
        const data = await res.json()
        if (!res.ok || !data.ok) {
          // 409 = 版本冲突（我读到之后有人改了）。单独标记：用户该做的是"重新载入"，
          // 而不是"重试保存"——后者必然再失败，只会让用户以为功能坏了。
          if (res.status === 409 || data.code === 'base-version-mismatch') setConflict(true)
          throw new Error(data.error || `HTTP ${res.status}`)
        }
        // 服务端回传写后的新版本号：据此可继续编辑，不必立刻重读整篇
        if (data.baseVersion) setBaseVersion(data.baseVersion)
        dirtyRef.current = new Map()
        saveErrorRef.current = ''
        setSaveError('')
        setConflict(false)
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
  if (!blocks) {
    return <div className="flex-1 min-h-0 flex items-center justify-center text-tertiary text-sm">{t('fileBrowser.empty')}</div>
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-surface">
      <div className="flex items-center gap-2 px-3 py-1 bg-modal text-xs text-tertiary border-b shrink-0">
        <span>段落/表格文本编辑（图片与嵌入对象不受影响）</span>
        {dirtyRef.current.size > 0 && <span className="text-warning/80">• 有改动 {dirtyRef.current.size} 处</span>}
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
      <div className="flex-1 min-h-0 overflow-auto p-6">
        <div className="max-w-4xl mx-auto space-y-1.5">
          {blocks.map((b) => {
            if (b.kind === 'table') {
              return (
                <table key={b.blockId} className="w-full border-collapse mb-3">
                  <tbody>
                    {(b.rows || []).map((row, r) => (
                      <tr key={r}>
                        {row.map((v, c) => (
                          <td key={c} className="border border-weak p-1">
                            <input
                              value={v}
                              onChange={e => updateCell(b.blockId, r, c, e.target.value)}
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
                key={b.blockId}
                value={b.text || ''}
                onChange={e => { resize(e.target); updateText(b.blockId, e.target.value) }}
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
