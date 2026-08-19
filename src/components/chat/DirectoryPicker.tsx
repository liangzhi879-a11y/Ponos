import { useState, useEffect, useCallback } from 'react'
import { Folder, FolderOpen, File, HardDrive, ChevronRight, ArrowUp, Home, RefreshCw, X, Check } from 'lucide-react'
import { Button, ScrollArea } from '@/components/ui'
import { cn, formatSize } from '@/lib/utils'
import { getDefaultHome, getBridgeUrl } from '@/lib/config'

interface DirEntry {
  name: string
  path: string
  type: 'directory' | 'file' | 'drive'
  size?: number
}

interface DirResult {
  path: string
  parent: string | null
  entries: DirEntry[]
  dirCount: number
  fileCount: number
  isRoot: boolean
}

interface Props {
  value: string
  onChange: (path: string) => void
  onClose: () => void
}


export function DirectoryPicker({ value, onChange, onClose }: Props) {
  const [currentPath, setCurrentPath] = useState(value)
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [parent, setParent] = useState<string | null>(null)
  const [dirCount, setDirCount] = useState(0)
  const [fileCount, setFileCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const fetchDir = useCallback(async (path: string) => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(getBridgeUrl() + '/list-dir?path=' + encodeURIComponent(path))
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Failed to read directory')
      }
      const data: DirResult = await res.json()
      setCurrentPath(data.path)
      setEntries(data.entries)
      setParent(data.parent)
      setDirCount(data.dirCount)
      setFileCount(data.fileCount)
    } catch (e: any) {
      setError(e.message)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    if (value !== 'This PC') fetchDir(value)
  }, [value])

  const handleEnter = (entry: DirEntry) => {
    if (entry.type === 'file') return // Can't enter files
    fetchDir(entry.path)
  }

  const goUp = () => {
    if (parent) fetchDir(parent)
  }

  const goHome = () => {
    fetchDir(getDefaultHome())
  }

  const goDrives = () => {
    setCurrentPath('This PC')
    setParent(null)
    setFileCount(0)
    // Show drives as entries
    fetch(getBridgeUrl() + '/drives')
      .then(r => r.json())
      .then(d => {
        setEntries(d.drives || [])
        setDirCount(d.drives?.length || 0)
      })
      .catch(() => {})
  }

  const isSelected = (path: string) => path === value

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
        className="w-[520px] border border rounded-xl animate-scale-in overflow-hidden backdrop-blur-md"
        style={{
          boxShadow: 'var(--shadow-modal)',
          background: 'var(--modal-bg)',
          backdropFilter: 'blur(var(--popover-blur))',
          WebkitBackdropFilter: 'blur(var(--popover-blur))',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b">
          <FolderOpen className="w-5 h-5 text-warning/75 shrink-0" />
          <h3 className="text-sm font-semibold text-primary">Browse Directory</h3>
          <button onClick={onClose} className="ml-auto text-tertiary hover:text-primary">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-1 px-2 py-1.5 bg-toolbar border-b">
          <Button variant="ghost" size="xs" onClick={goUp} disabled={!parent} title="Up"><ArrowUp className="w-3.5 h-3.5" /></Button>
          <Button variant="ghost" size="xs" onClick={goHome} title="Home"><Home className="w-3.5 h-3.5" /></Button>
          <Button variant="ghost" size="xs" onClick={goDrives} title="This PC"><HardDrive className="w-3.5 h-3.5" /></Button>
          <Button variant="ghost" size="xs" onClick={() => fetchDir(currentPath)} title="Refresh"><RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} /></Button>
          {/* Breadcrumb path */}
          <span className="ml-2 text-xs text-secondary font-mono truncate flex-1">{currentPath}</span>
        </div>

        {/* Directory listing */}
        <ScrollArea className="h-[320px]">
          {loading ? (
            <div className="flex items-center justify-center h-full text-tertiary text-xs">
              <RefreshCw className="w-4 h-4 animate-spin mr-2" /> Loading...
            </div>
          ) : error ? (
            <div className="flex items-center justify-center h-full text-error text-xs px-4 text-center">{error}</div>
          ) : entries.length === 0 ? (
            <div className="flex items-center justify-center h-full text-tertiary text-xs">Empty directory</div>
          ) : (
            <div className="py-1">
              {entries.map(entry => {
                const active = isSelected(entry.path)
                return (
                  <button
                    key={entry.path}
                    onClick={() => entry.type !== 'file' ? handleEnter(entry) : null}
                    onDoubleClick={() => {
                      if (entry.type !== 'file') {
                        onChange(entry.path)
                        onClose()
                      }
                    }}
                    className={cn(
                      'w-full flex items-center gap-2.5 px-4 py-1.5 text-sm text-left transition-colors',
                      entry.type === 'file' ? 'cursor-default' : 'cursor-pointer',
                      active
                        ? 'bg-brand-500/15 text-brand-500'
                        : entry.type === 'file'
                          ? 'text-tertiary'
                          : 'text-secondary hover:bg-hover'
                    )}
                  >
                    {entry.type === 'drive' ? (
                      <HardDrive className="w-4 h-4 text-warning/75 shrink-0" />
                    ) : entry.type === 'directory' ? (
                      <Folder className="w-4 h-4 text-warning/75 shrink-0" />
                    ) : (
                      <File className="w-4 h-4 text-tertiary shrink-0" />
                    )}
                    <span className="truncate flex-1">{entry.name}</span>
                    {entry.size !== undefined && entry.size > 0 && (
                      <span className="text-[10px] text-tertiary shrink-0">{formatSize(entry.size)}</span>
                    )}
                    {entry.type !== 'file' && !active && (
                      <ChevronRight className="w-3.5 h-3.5 text-tertiary shrink-0" />
                    )}
                    {active && (
                      <Check className="w-3.5 h-3.5 text-brand-500 shrink-0" />
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </ScrollArea>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t bg-toolbar">
          <span className="text-[10px] text-tertiary">
            {dirCount} folders, {fileCount} files
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" size="xs" onClick={onClose}>Cancel</Button>
            <Button variant="primary" size="xs" onClick={() => { onChange(currentPath); onClose() }} leftIcon={<Check className="w-3.5 h-3.5" />}>
              Select Folder
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

