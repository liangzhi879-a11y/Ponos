import { useState, useEffect, useCallback } from 'react'
import { GitBranch, Plus, Trash2, RefreshCw, GitFork } from 'lucide-react'
import { Button, Badge, ScrollArea } from '@/components/ui'
import { useChatStore } from '@/stores/chatStore'
import { cn } from '@/lib/utils'
import { getDefaultHome, getBridgeUrl } from '@/lib/config'


interface Worktree {
  path: string
  branch: string
  head: string
  bare: boolean
}

interface Props {
  repoPath?: string
}

export function WorktreePanel({ repoPath }: Props) {
  const { activeConversationId, conversations, createConversation, setActiveConversation } = useChatStore()
  const activeConv = conversations.find(c => c.id === activeConversationId)
  const cwd = repoPath || activeConv?.cwd || getDefaultHome()

  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const [branches, setBranches] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [createBranch, setCreateBranch] = useState('')
  const [createName, setCreateName] = useState('')
  const [isGitRepo, setIsGitRepo] = useState(true)

  const fetchWorktrees = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(getBridgeUrl() + '/worktrees?path=' + encodeURIComponent(cwd))
      const data = await res.json()
      if (data.isNotRepo) { setIsGitRepo(false); setError('Not a git repository') }
      else { setIsGitRepo(true); setWorktrees(data.worktrees || []) }
    } catch (e: any) { setError(e.message) }
    setLoading(false)
  }, [cwd])

  const fetchBranches = useCallback(async () => {
    try {
      const res = await fetch(getBridgeUrl() + '/branches?path=' + encodeURIComponent(cwd))
      const data = await res.json()
      if (data.branches) setBranches(data.branches)
    } catch { /* ignore */ }
  }, [cwd])

  useEffect(() => { fetchWorktrees(); fetchBranches() }, [cwd])

  const handleCreate = async () => {
    if (!createBranch) return
    const name = createName || createBranch.replace(/[^a-zA-Z0-9_-]/g, '-')
    try {
      const res = await fetch(getBridgeUrl() + '/worktree/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoPath: cwd, branch: createBranch, name }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      // Create a new conversation for this worktree
      const convId = createConversation(data.path)
      setActiveConversation(convId)
      setShowCreate(false)
      setCreateBranch('')
      setCreateName('')
      fetchWorktrees()
    } catch (e: any) { setError(e.message) }
  }

  const handleRemove = async (wt: Worktree) => {
    if (!confirm(`Remove worktree "${wt.branch}" at ${wt.path}?`)) return
    try {
      await fetch(getBridgeUrl() + '/worktree/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wtPath: wt.path }),
      })
      fetchWorktrees()
    } catch (e: any) { setError(e.message) }
  }

  const openInNewConv = (wt: Worktree) => {
    const convId = createConversation(wt.path)
    setActiveConversation(convId)
  }

  // Group conversations by worktree
  const worktreeConvs = new Map<string, number>()
  conversations.forEach(c => {
    if (c.cwd) {
      worktreeConvs.set(c.cwd, (worktreeConvs.get(c.cwd) || 0) + 1)
    }
  })

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-2 border-b">
        <div className="flex items-center gap-2 mb-2">
          <GitFork className="w-4 h-4 text-success" />
          <span className="text-sm font-semibold text-primary">Worktrees</span>
          {isGitRepo && (
            <Button variant="primary" size="xs" onClick={() => { setShowCreate(true); fetchBranches() }}>
              <Plus className="w-3 h-3" />
            </Button>
          )}
        </div>
        <div className="text-[10px] text-tertiary font-mono truncate">{cwd}</div>
      </div>

      {/* Create panel */}
      {showCreate && (
        <div className="px-3 py-2 border-b bg-modal animate-slide-down space-y-2">
          <label className="text-[10px] text-tertiary">Branch / Ref</label>
          <select
            value={createBranch}
            onChange={e => setCreateBranch(e.target.value)}
            className="w-full h-7 bg-elevated border border rounded text-xs text-primary px-2"
          >
            <option value="">Select branch or type below...</option>
            {branches.map(b => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Or type a custom ref (e.g. origin/feature-x)"
            value={createBranch}
            onChange={e =>  setCreateBranch(e.target.value)}
            className="w-full h-7 bg-elevated border border rounded text-xs text-primary px-2 font-mono placeholder:text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <input
            type="text"
            placeholder="Directory name (optional)"
            value={createName}
            onChange={e => setCreateName(e.target.value)}
            className="w-full h-7 bg-elevated border border rounded text-xs text-primary px-2 font-mono placeholder:text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <div className="flex gap-2">
            <Button variant="primary" size="xs" onClick={handleCreate} disabled={!createBranch}>Create Worktree</Button>
            <Button variant="ghost" size="xs" onClick={() => setShowCreate(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {/* Content */}
      <ScrollArea className="flex-1">
        {!isGitRepo ? (
          <div className="flex flex-col items-center justify-center py-8 text-tertiary text-xs gap-1">
            <GitBranch className="w-8 h-8 opacity-20" />
            <p>Not a git repository</p>
            <p className="text-tertiary">Worktrees require a git repo</p>
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center py-8 text-tertiary text-xs">
            <RefreshCw className="w-3.5 h-3.5 animate-spin mr-1.5" /> Loading...
          </div>
        ) : error ? (
          <div className="py-4 text-center text-xs text-error px-3">{error}</div>
        ) : worktrees.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-tertiary text-xs gap-2">
            <GitBranch className="w-8 h-8 opacity-20" />
            <p>No worktrees</p>
            <Button variant="outline" size="xs" onClick={() => setShowCreate(true)}>
              <Plus className="w-3 h-3 mr-1" /> Create First Worktree
            </Button>
          </div>
        ) : (
          <div className="py-1">
            {worktrees.map(wt => {
              const convCount = worktreeConvs.get(wt.path) || 0
              const isActive = activeConv?.cwd === wt.path
              return (
                <div
                  key={wt.path}
                  className={cn(
                    'flex items-center gap-2 px-3 py-2 border-b border-default transition-colors',
                    isActive ? 'bg-brand-500/15' : 'hover:bg-elevated'
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <GitBranch className="w-3.5 h-3.5 text-success/80 shrink-0" />
                      <span className="text-xs font-medium text-primary truncate">{wt.branch}</span>
                      {convCount > 0 && <Badge variant="primary" className="text-[9px]">{convCount}</Badge>}
                    </div>
                    <div className="text-[10px] text-tertiary font-mono truncate mt-0.5">{wt.path}</div>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      onClick={() => openInNewConv(wt)}
                      className="p-1 rounded hover:bg-input text-tertiary hover:text-secondary"
                      title="Open conversation"
                    >
                      <Plus className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => handleRemove(wt)}
                      className="p-1 rounded hover:bg-error/20 text-tertiary hover:text-error"
                      title="Remove worktree"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </ScrollArea>

      {/* Info bar */}
      {worktrees.length > 0 && (
        <div className="px-3 py-1.5 border-t bg-app text-[10px] text-tertiary">
          {worktrees.length} worktree{worktrees.length !== 1 ? 's' : ''} · Parallel sessions supported
        </div>
      )}
    </div>
  )
}
