import { useState, useEffect, useCallback } from 'react'
import { Folder, FolderOpen, File, FileCode, FileText, FileImage, ChevronRight, ChevronDown, RefreshCw, Home, ArrowUp, HardDrive, Paperclip, Eye, ExternalLink } from 'lucide-react'
import { ScrollArea } from '@/components/ui'
import { useUIStore } from '@/stores/uiStore'
import { useChatStore } from '@/stores/chatStore'
import { useTranslation } from '@/i18n/useTranslation'
import { cn, generateId, formatSize } from '@/lib/utils'
import { getDefaultHome, getBridgeUrl } from '@/lib/config'
import { openFileInEditor } from '@/lib/editorBridge'

interface DirEntry {
  name: string; path: string; type: 'directory' | 'file' | 'drive'; size?: number
}


export function FileBrowser() {
  const { conversations, activeConversationId } = useChatStore()
  const activeConv = conversations.find(c => c.id === activeConversationId)
  const cwd = activeConv?.cwd || getDefaultHome()
  const [rootPath, setRootPath] = useState(cwd)
  const [tree, setTree] = useState<Record<string, { entries: DirEntry[]; loaded: boolean; expanded: boolean }>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [ctxMenu, setCtxMenu] = useState<{ entry: DirEntry; x: number; y: number } | null>(null)
  const { setPreviewFile } = useUIStore()
  const { t } = useTranslation()

  // Fetch a directory
  const fetchDir = useCallback(async (path: string) => {
    if (path === 'This PC') return
    if (tree[path]?.loaded) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch(getBridgeUrl() + '/list-dir?path=' + encodeURIComponent(path))
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      const data = await res.json()
      setTree(prev => ({
        ...prev,
        [path]: { entries: data.entries || [], loaded: true, expanded: true },
      }))
    } catch (e: any) {
      console.error('[FileBrowser] error:', e.message)
      setError(e.message || 'Failed to load directory')
    }
    setLoading(false)
  }, [tree])

  // Sync cwd with active conversation
  useEffect(() => {
    if (cwd && cwd !== rootPath) {
      setRootPath(cwd)
      setTree({})
      fetchDir(cwd)
    }
  }, [cwd, activeConversationId])

  // Load root on mount
  useEffect(() => { if (rootPath !== 'This PC') fetchDir(rootPath) }, [rootPath])

  const toggleExpand = (path: string) => {
    if (path === 'This PC') return
    setTree(prev => {
      const node = prev[path]
      if (!node) {
        fetchDir(path)
        return prev
      }
      return { ...prev, [path]: { ...node, expanded: !node.expanded } }
    })
  }

  // 打开文件 → 原生独立编辑器窗口（可拖出主应用界面；二进制/Office 走窗口内只读预览）
  const openFile = (entry: DirEntry) => {
    openFileInEditor(entry.path, entry.name)
  }

  const attachToChat = (entry: DirEntry) => {
    const isImage = /\.(png|jpg|jpeg|gif|svg|webp|bmp|ico)$/i.test(entry.name)
    const cleanPath = entry.path.replace(/\\/g, '/')
    useUIStore.getState().addPendingAttachment({
      id: generateId(),
      name: entry.name,
      path: cleanPath,
      type: isImage ? 'image' : 'file',
      content: cleanPath,
    })
  }

  const goHome = () => setRootPath(getDefaultHome())
  const goParent = () => {
    if (rootPath === 'This PC') { goHome(); return }
    const parent = rootPath.replace(/[/\\][^/\\]+$/, '') || rootPath.replace(/[/\\]$/, '')
    if (parent && parent !== rootPath) {
      setRootPath(parent)
    } else {
      goDrives()
    }
  }
  const goDrives = () => {
    fetch(getBridgeUrl() + '/drives').then(r => r.json()).then(d => {
      setTree({ ['This PC']: { entries: d.drives || [], loaded: true, expanded: true } })
      setRootPath('This PC')
    })
  }

  const handleContextMenu = (e: React.MouseEvent, entry: DirEntry) => {
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({ entry, x: e.clientX, y: e.clientY })
  }

  const closeCtxMenu = () => setCtxMenu(null)

  const copyPath = (path: string) => {
    navigator.clipboard.writeText(path).catch(() => {})
    closeCtxMenu()
  }

  // Close context menu on any click
  useEffect(() => {
    const handler = () => closeCtxMenu()
    if (ctxMenu) {
      document.addEventListener('click', handler)
      return () => document.removeEventListener('click', handler)
    }
  }, [ctxMenu])

  const renderNode = (entry: DirEntry, depth: number) => {
    const isDir = entry.type === 'directory' || entry.type === 'drive'
    const node = tree[entry.path]
    const expanded = node?.expanded ?? false

    return (
      <div key={entry.path}>
        <button
          onClick={() => isDir ? toggleExpand(entry.path) : openFile(entry)}
          onContextMenu={e => handleContextMenu(e, entry)}
          className={cn(
            'w-full flex items-center gap-1 py-1 pr-1 text-xs transition-colors hover:bg-elevated text-left overflow-hidden',
            isDir ? 'text-secondary' : 'text-tertiary'
          )}
          style={{ paddingLeft: Math.min(8 + depth * 12, 120) }}
        >
          {isDir ? (
            expanded ? <ChevronDown className="w-3 h-3 shrink-0 text-tertiary" /> : <ChevronRight className="w-3 h-3 shrink-0 text-tertiary" />
          ) : (
            <span className="w-3 shrink-0" />
          )}
          {entry.type === 'drive' ? <HardDrive className="w-3.5 h-3.5 text-warning/75 shrink-0" /> :
           isDir ? (expanded ? <FolderOpen className="w-3.5 h-3.5 text-warning/75 shrink-0" /> : <Folder className="w-3.5 h-3.5 text-warning/75 shrink-0" />) :
           getFileIcon(entry.name)}
          <span className="truncate flex-1 min-w-0" title={entry.name}>{entry.name}</span>
          {entry.size && <span className="text-[10px] text-tertiary shrink-0 ml-1">{formatSize(entry.size)}</span>}
        </button>
        {expanded && node?.entries && node.entries
          .filter(e => e.type === 'directory' || e.type === 'drive' || e.type === 'file')
          .map(e => renderNode(e, depth + 1))
        }
      </div>
    )
  }

  const entries = tree[rootPath]?.entries || []
  const dirs = entries.filter(e => e.type === 'directory' || e.type === 'drive')
  const files = entries.filter(e => e.type === 'file')

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-1.5 py-1 border-b bg-app">
        <button onClick={goHome} className="p-1 rounded hover:bg-elevated text-tertiary hover:text-secondary" title={t('fileBrowser.home')}><Home className="w-3.5 h-3.5" /></button>
        <button onClick={goParent} className="p-1 rounded hover:bg-elevated text-tertiary hover:text-secondary" title={t('fileBrowser.parent')}><ArrowUp className="w-3.5 h-3.5" /></button>
        <button onClick={goDrives} className="p-1 rounded hover:bg-elevated text-tertiary hover:text-secondary" title={t('fileBrowser.drives')}><HardDrive className="w-3.5 h-3.5" /></button>
        <button onClick={() => { setTree({}); if (rootPath !== 'This PC') fetchDir(rootPath); else goDrives() }} className="p-1 rounded hover:bg-elevated text-tertiary hover:text-secondary" title={t('fileBrowser.refresh')}><RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} /></button>
        <span className="ml-1 text-[10px] text-tertiary font-mono truncate">{rootPath}</span>
      </div>

      {/* Tree */}
      <ScrollArea className="flex-1">
        <div className="py-0.5">
          {error ? (
            <div className="flex flex-col items-center justify-center py-8 text-xs gap-1">
              <span className="text-error">⚠ {error}</span>
              <button onClick={() => fetchDir(rootPath)} className="text-brand-500 hover:text-brand-500 mt-1">{t('common.retry')}</button>
            </div>
          ) : loading && Object.keys(tree).length === 0 ? (
            <div className="flex items-center justify-center py-8 text-tertiary text-xs">
              <RefreshCw className="w-3.5 h-3.5 animate-spin mr-1.5" /> {t('common.loading')}
            </div>
          ) : entries.length === 0 ? (
            <div className="py-8 text-center text-tertiary text-xs">{t('fileBrowser.empty')}</div>
          ) : (
            [...dirs, ...files].map(e => renderNode(e, 0))
          )}
        </div>
      </ScrollArea>

      {/* Context Menu */}
      {ctxMenu && (
        <div
          className="fixed z-[100] w-44 bg-elevated border border rounded-lg shadow-2xl py-1 animate-scale-in"
          style={{ left: Math.min(ctxMenu.x, window.innerWidth - 200), top: Math.min(ctxMenu.y, window.innerHeight - 160) }}
        >
          <div className="px-3 py-1.5 text-[10px] text-tertiary font-mono truncate border-b">
            {ctxMenu.entry.name}
          </div>
          <button
            onClick={() => { const api = (window as any).yfworkingAPI; if (api?.openInExplorer) api.openInExplorer(ctxMenu.entry.path); closeCtxMenu() }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-secondary hover:bg-input transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5 text-info/70" /> {t('fileBrowser.openInExplorer')}
          </button>
          {ctxMenu.entry.type === 'file' && <button
            onClick={() => { setPreviewFile({ path: ctxMenu.entry.path, name: ctxMenu.entry.name }); closeCtxMenu() }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-secondary hover:bg-input transition-colors"
          >
            <Eye className="w-3.5 h-3.5 text-success" /> {t('fileBrowser.preview')}
          </button>}
          {ctxMenu.entry.type === 'file' && <button
            onClick={() => { attachToChat(ctxMenu.entry); closeCtxMenu() }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-secondary hover:bg-input transition-colors"
          >
            <Paperclip className="w-3.5 h-3.5 text-info/80" /> {t('fileBrowser.attachToChat')}
          </button>}
          {ctxMenu.entry.type === 'file' && <button
            onClick={() => { openFile(ctxMenu.entry); closeCtxMenu() }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-secondary hover:bg-input transition-colors"
          >
            <FileCode className="w-3.5 h-3.5 text-tertiary" /> {t('fileBrowser.openInEditor')}
          </button>}
          <button
            onClick={() => copyPath(ctxMenu.entry.path)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-secondary hover:bg-input transition-colors"
          >
            <FileText className="w-3.5 h-3.5 text-tertiary" /> {t('fileBrowser.copyPath')}
          </button>
        </div>
      )}
    </div>
  )
}

function getFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'ts': case 'tsx': case 'js': case 'jsx': case 'py': case 'rs': case 'go': case 'java':
      return <FileCode className="w-3.5 h-3.5 text-info/80 shrink-0" />
    case 'json': case 'yaml': case 'yml': case 'xml': case 'toml':
      return <FileCode className="w-3.5 h-3.5 text-warning/75 shrink-0" />
    case 'md': case 'txt': case 'log':
      return <FileText className="w-3.5 h-3.5 text-tertiary shrink-0" />
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'svg': case 'ico':
      return <FileImage className="w-3.5 h-3.5 text-success/80 shrink-0" />
    default:
      return <File className="w-3.5 h-3.5 text-tertiary shrink-0" />
  }
}
