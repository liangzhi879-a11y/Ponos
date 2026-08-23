import { useState, useEffect } from 'react'
import { FileImage, FileText, FileCode, X, ExternalLink } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useTranslation } from '@/i18n/useTranslation'
import { getBridgeUrl } from '@/lib/config'

interface Props {
  path: string
  name: string
  onClose: () => void
}


type PreviewMode = 'loading' | 'image' | 'pdf' | 'text' | 'code' | 'markdown' | 'office' | 'unsupported'

export function FilePreview({ path, name, onClose }: Props) {
  const [mode, setMode] = useState<PreviewMode>('loading')
  const [content, setContent] = useState('')
  const [error, setError] = useState('')
  const { t } = useTranslation()

  const ext = name.split('.').pop()?.toLowerCase() || ''
  const isImage = /^(png|jpg|jpeg|gif|svg|webp|bmp|ico)$/i.test(ext)
  const isPdf = ext === 'pdf'
  const isMd = /^(md|markdown)$/i.test(ext)
  const isHtml = /^(html|htm)$/i.test(ext)
  const isCode = /^(ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|hpp|rb|php|swift|kt|sql|sh|bash|zsh|ps1)$/i.test(ext)
  const isOffice = /^(docx|xlsx|xls)$/i.test(ext)
  const isUnsupportedOffice = /^(doc|ppt|pptx)$/i.test(ext)

  useEffect(() => {
    if (isImage) { setMode('image'); return }
    if (isPdf) { setMode('pdf'); return }
    if (isHtml) {
      // 直接以文件基准 URL 渲染（相对资源可加载），放行 JS 支持互动展示
      setMode('office')
      return
    }
    if (isUnsupportedOffice) { setMode('unsupported'); return }
    if (isOffice) {
      setMode('loading')
      fetch(getBridgeUrl() + '/convert-office?path=' + encodeURIComponent(path))
        .then(r => r.json())
        .then(d => {
          if (d.error) throw new Error(d.error)
          setContent(d.html || '')
          setMode('office')
        })
        .catch(e => { setError(e.message); setMode('unsupported') })
      return
    }
    // Text/code/markdown — fetch content
    setMode('loading')
    fetch(getBridgeUrl() + '/read-file?path=' + encodeURIComponent(path))
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error)
        setContent(d.content || '')
        setMode(isMd ? 'markdown' : isCode ? 'code' : 'text')
      })
      .catch(e => { setError(e.message); setMode('unsupported') })
  }, [path])

  const fileUrl = getBridgeUrl() + '/raw-file?path=' + encodeURIComponent(path)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center animate-fade-in"
      onClick={onClose}
      style={{
        backgroundColor: 'var(--overlay-bg)',
        backdropFilter: `blur(var(--overlay-blur))`,
        WebkitBackdropFilter: `blur(var(--overlay-blur))`,
      }}
    >
      <div
        className="bg-modal border border rounded-xl overflow-hidden animate-scale-in flex flex-col"
        style={{
          width: '90vw',
          maxWidth: '1100px',
          height: '85vh',
          maxHeight: '800px',
          boxShadow: 'var(--shadow-modal)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b shrink-0">
          {mode === 'image' ? <FileImage className="w-4 h-4 text-success/80" /> :
           mode === 'pdf' ? <FileText className="w-4 h-4 text-error/80" /> :
           mode === 'office' ? <FileText className="w-4 h-4 text-info/80" /> :
           <FileCode className="w-4 h-4 text-info/80" />}
          <span className="text-xs font-medium text-primary truncate flex-1">{name}</span>
          <span className="text-[10px] text-tertiary font-mono">{ext.toUpperCase()}</span>
          <button
            onClick={() => (window as any).ponosAPI?.openInExplorer?.(path)}
            className="p-1 text-tertiary hover:text-primary"
            title={t('editor.openInSystem')}
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
          <button onClick={onClose} className="p-1 text-tertiary hover:text-primary"><X className="w-4 h-4" /></button>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-hidden bg-elevated">
          {mode === 'loading' && (
            <div className="flex items-center justify-center h-full text-tertiary text-sm">{t('common.loading')}</div>
          )}
          {mode === 'image' && (
            <div className="flex items-center justify-center h-full p-4 bg-elevated">
              <img src={fileUrl} alt={name} className="max-w-full max-h-full object-contain rounded" />
            </div>
          )}
          {mode === 'pdf' && (
            <iframe src={fileUrl} className="w-full h-full border-0 bg-surface" title={name} />
          )}
          {mode === 'markdown' && (
            <div className="h-full overflow-auto p-6 prose prose-sm max-w-none text-primary bg-app">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            </div>
          )}
          {mode === 'code' && (
            <textarea
              readOnly
              value={content}
              className="w-full h-full text-primary font-mono text-[13px] leading-relaxed p-4 resize-none focus:outline-none border-0 bg-code"
              spellCheck={false}
            />
          )}
          {mode === 'office' && (
            isHtml ? (
              <iframe
                src={fileUrl}
                className="w-full h-full border-0 bg-surface"
                sandbox="allow-scripts allow-same-origin"
                title={name}
              />
            ) : (
              <div className="h-full overflow-auto p-6 bg-surface">
                <div
                  className="max-w-4xl mx-auto text-sm leading-relaxed text-primary"
                  dangerouslySetInnerHTML={{ __html: content }}
                />
              </div>
            )
          )}
          {mode === 'text' && (
            <div className="h-full overflow-auto p-4 font-mono text-[13px] text-secondary leading-relaxed whitespace-pre-wrap bg-app">
              {content}
            </div>
          )}
          {mode === 'unsupported' && (
            <div className="flex flex-col items-center justify-center h-full text-tertiary text-sm gap-3">
              {isUnsupportedOffice ? (
                <>
                  <FileText className="w-12 h-12 opacity-20" />
                  <p className="text-secondary font-medium">{t('fileBrowser.legacyOffice')}</p>
                  <p className="text-xs text-tertiary max-w-sm text-center">
                    {t('fileBrowser.legacyOfficeDesc', { ext })}
                  </p>
                </>
              ) : error ? (
                <>
                  <p className="text-error">⚠ {error}</p>
                </>
              ) : (
                <>
                  <FileText className="w-12 h-12 opacity-20" />
                  <p>{t('fileBrowser.previewUnavailable')}</p>
                </>
              )}
              <a
                href={fileUrl}
                download={name}
                className="text-brand-500 hover:text-brand-600 text-xs flex items-center gap-1 mt-1"
              >
                <ExternalLink className="w-3 h-3" /> {t('fileBrowser.openDownload')}
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
