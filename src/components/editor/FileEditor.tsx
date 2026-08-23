import { useState, useEffect, useRef } from 'react'
import { X, Save, FileCode, ExternalLink, Circle, FileText, FileImage, Globe } from 'lucide-react'
import { Tooltip } from '@/components/ui'
import { useUIStore } from '@/stores/uiStore'
import { useTranslation } from '@/i18n/useTranslation'
import { cn, getFileLanguage, isEditableFile } from '@/lib/utils'
import { getBridgeUrl } from '@/lib/config'
import type { FileTab } from '@/types'
import { CodeEditor } from './CodeEditor'
import { SheetEditor, type SheetEditorHandle } from './SheetEditor'
import { DocxEditor, type DocxEditorHandle } from './DocxEditor'

// 独立原生无边框窗口（BrowserWindow）内的文件编辑器：
// - 窗口拖动由系统标题栏 -webkit-app-region: drag 承担（可超出主应用界面）
// - 缩放由系统原生边缘拖拽承担（frame:false + resizable:true）
// - 关闭按钮 / 标签全关闭后自动收起 → 通知主进程关闭窗口
export function FileEditor() {
  const {
    openFiles, activeFileId, closeFile, setActiveFile,
    updateFileContent, markFileSaved,
  } = useUIStore()
  const { t } = useTranslation()
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // html 文件打开默认渲染预览（互动展示），可切换回源码编辑
  const [htmlMode, setHtmlMode] = useState<'preview' | 'source'>('preview')
  // Excel/Word 编辑器的保存句柄（内部走 /write-sheet /write-docx 写回）
  const sheetRef = useRef<SheetEditorHandle>(null)
  const docxRef = useRef<DocxEditorHandle>(null)

  // 通过本地 bridge 真实写入磁盘；成功后才标记为已保存。sheet/docx 由子编辑器写回
  const saveFile = async (file: FileTab) => {
    setSaving(true)
    setSaveError(null)
    try {
      if (/\.(xlsx|xls)$/i.test(file.name)) {
        await sheetRef.current?.save()
        return
      }
      if (/\.docx$/i.test(file.name)) {
        await docxRef.current?.save()
        return
      }
      const res = await fetch(`${getBridgeUrl()}/write-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: file.path, content: file.content }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
      markFileSaved(file.id)
    } catch (e: any) {
      setSaveError(e?.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const activeFile = openFiles.find(f => f.id === activeFileId)
  const editable = activeFile ? isEditableFile(activeFile.name) : true
  const isHtml = activeFile ? /\.(html|htm)$/i.test(activeFile.name) : false
  const isSheet = activeFile ? /\.(xlsx|xls)$/i.test(activeFile.name) : false
  const isDocx = activeFile ? /\.docx$/i.test(activeFile.name) : false

  // 关闭按钮：通知主进程关闭本窗口
  const closeWindow = () => {
    ;(window as any).ponosAPI?.closeEditorWindow?.()
  }

  // 右上角按钮：直接用本地系统默认应用打开源文件
  const openInSystemApp = () => {
    if (!activeFile) return
    const api = (window as any).ponosAPI
    if (api?.openInExplorer) api.openInExplorer(activeFile.path)
  }

  return (
    <div
      className="h-full w-full flex flex-col overflow-hidden text-primary"
      style={{ background: 'var(--modal-bg)' }}
    >
      {/* Title bar（系统拖动把手，-webkit-app-region: drag；按钮区 no-drag） */}
      <div
        className="flex items-center h-9 bg-modal border-b shrink-0 select-none"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex items-center gap-1.5 px-3 min-w-0 flex-1">
          <FileCode className="w-3.5 h-3.5 shrink-0 text-brand-500" />
          <span className="truncate text-xs text-primary">
            {activeFile ? activeFile.name : t('editor.title')}
          </span>
          {activeFile?.modified && <span className="text-warning/80 text-xs">•</span>}
        </div>
        <div className="flex items-center shrink-0" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          {/* 右侧按钮组：保存（可编辑且有改动）→ 关闭窗口 → 系统应用打开（最右） */}
          {activeFile?.modified && (editable || isSheet || isDocx) && (
            <Tooltip content={t('editor.save') + ' (⌘S)'}>
              <button
                onClick={() => saveFile(activeFile)}
                disabled={saving}
                className="h-9 px-2 text-tertiary hover:text-primary hover:bg-elevated border-l border disabled:opacity-40"
              >
                <Save className="w-3.5 h-3.5" />
              </button>
            </Tooltip>
          )}
          {isHtml && (
            <Tooltip content={htmlMode === 'preview' ? '查看源码' : '渲染预览'}>
              <button
                onClick={() => setHtmlMode(m => (m === 'preview' ? 'source' : 'preview'))}
                className="h-9 px-2 text-tertiary hover:text-primary hover:bg-elevated border-l border"
              >
                {htmlMode === 'preview' ? <FileCode className="w-3.5 h-3.5" /> : <Globe className="w-3.5 h-3.5" />}
              </button>
            </Tooltip>
          )}
          <button
            onClick={closeWindow}
            className="h-9 px-2 text-tertiary hover:text-primary hover:bg-elevated border-l border"
            title={t('editor.close')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={openInSystemApp}
            className="h-9 px-2 text-tertiary hover:text-primary hover:bg-elevated border-l border"
            title={t('editor.openInSystem')}
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Tab strip */}
      <div className="flex items-center h-8 bg-app border-b shrink-0 select-none">
        <div className="flex items-center flex-1 overflow-x-auto">
          {openFiles.map(file => (
            <div
              key={file.id}
              onClick={() => setActiveFile(file.id)}
              className={cn(
                'flex items-center gap-1.5 px-3 h-8 text-xs cursor-pointer border-r border transition-colors group',
                'hover:bg-elevated',
                file.id === activeFileId
                  ? 'bg-modal text-primary border-t-2 border-t-brand-500'
                  : 'text-tertiary'
              )}
            >
              <Circle
                className={cn('w-2 h-2', file.modified ? 'fill-warning text-warning' : 'fill-transparent text-tertiary')}
              />
              <FileCode className="w-3 h-3 shrink-0" />
              <span className="truncate max-w-[120px]">{file.name}</span>
              <button
                onClick={e => { e.stopPropagation(); closeFile(file.id) }}
                className="p-0.5 rounded hover:bg-input opacity-0 group-hover:opacity-100"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {activeFile && (
        <>
          {/* File info bar */}
          <div className="flex items-center justify-between px-3 py-1 bg-modal text-xs text-tertiary border-b shrink-0">
            <div className="flex items-center gap-2">
              <span className="truncate">{activeFile.path}</span>
              <span className="text-tertiary">{getFileLanguage(activeFile.name)}</span>
              {activeFile.modified && <span className="text-warning/80">• {t('editor.modified')}</span>}
            </div>
            {saveError && <span className="text-error truncate max-w-[260px]" title={saveError}>⚠ {saveError}</span>}
          </div>

          {/* Body：xlsx/docx → 应用内编辑器（写回原文件）；html 默认渲染预览（可切源码）；其他可编辑 → CodeMirror；其余 → 只读预览 */}
          {isSheet ? (
            <SheetEditor key={activeFile.id} ref={sheetRef} file={activeFile} />
          ) : isDocx ? (
            <DocxEditor key={activeFile.id} ref={docxRef} file={activeFile} />
          ) : editable ? (
            isHtml && htmlMode === 'preview' ? (
              <HtmlPreview key={'pv-' + htmlMode} path={activeFile.path} />
            ) : (
              <CodeEditor
                key={activeFile.id}
                file={activeFile}
                onChange={(c) => updateFileContent(activeFile.id, c)}
                onSave={() => saveFile(activeFile)}
              />
            )
          ) : (
            <PreviewPane path={activeFile.path} name={activeFile.name} />
          )}
        </>
      )}
    </div>
  )
}

// html 渲染预览：以文件基准 URL 加载，放行 JS 支持互动展示（brainstorming 等）
function HtmlPreview({ path }: { path: string }) {
  const fileUrl = getBridgeUrl() + '/raw-file?path=' + encodeURIComponent(path)
  return (
    <iframe
      src={fileUrl}
      className="flex-1 min-h-0 w-full border-0 bg-surface"
      sandbox="allow-scripts allow-same-origin"
      title="html preview"
    />
  )
}

// 非可编辑文件（图片/PDF/Office）在编辑器窗口内的只读预览
function PreviewPane({ path, name }: { path: string; name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  const fileUrl = getBridgeUrl() + '/raw-file?path=' + encodeURIComponent(path)

  if (/^(png|jpg|jpeg|gif|svg|webp|bmp|ico)$/i.test(ext)) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center p-4 bg-elevated overflow-auto">
        <img src={fileUrl} alt={name} className="max-w-full max-h-full object-contain rounded" />
      </div>
    )
  }
  if (ext === 'pdf') {
    return <iframe src={fileUrl} className="flex-1 min-h-0 w-full border-0 bg-surface" title={name} />
  }
  if (/^(docx|xlsx|xls)$/i.test(ext)) {
    return <OfficePreview path={path} />
  }
  return (
    <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 text-tertiary text-sm p-4">
      <FileText className="w-12 h-12 opacity-20" />
      <p className="text-secondary">{name.split('.').pop()?.toUpperCase()} 格式暂不支持预览</p>
      <a
        href={fileUrl}
        download={name}
        className="text-brand-500 hover:text-brand-600 text-xs flex items-center gap-1"
      >
        <FileImage className="w-3 h-3" /> 下载 / 打开
      </a>
    </div>
  )
}

function OfficePreview({ path }: { path: string }) {
  const { t } = useTranslation()
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    fetch(getBridgeUrl() + '/convert-office?path=' + encodeURIComponent(path))
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error)
        setHtml(d.html || '')
      })
      .catch((e: any) => setError(e?.message || '转换失败'))
  }, [path])
  if (error) {
    return <div className="flex-1 min-h-0 flex items-center justify-center text-error text-sm p-4">{error}</div>
  }
  if (html === null) {
    return <div className="flex-1 min-h-0 flex items-center justify-center text-tertiary text-sm">{t('common.loading')}</div>
  }
  return (
    <div className="flex-1 min-h-0 overflow-auto p-6 bg-surface">
      <div
        className="max-w-4xl mx-auto text-sm leading-relaxed text-primary"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
