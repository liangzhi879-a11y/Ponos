import { useState, useEffect } from 'react'
import { Zap, Search, ChevronRight, ArrowRight, Plus, Download, Trash2, FolderOpen, BookOpen, Star, FolderPlus, MoreHorizontal, Check, Folder, Edit3, X } from 'lucide-react'
import { ScrollArea, Badge, Button } from '@/components/ui'
import { useUIStore } from '@/stores/uiStore'
import { useChatStore } from '@/stores/chatStore'
import { useTranslation } from '@/i18n/useTranslation'
import { cn } from '@/lib/utils'
import { getBridgeUrl } from '@/lib/config'
import { fetchSkills, buildSkillPrompt, type SkillEntry } from '@/lib/skills'

export function SkillsPanel() {
  const { t } = useTranslation()
  const [skills, setSkills] = useState<SkillEntry[]>([])
  const [skillsDir, setSkillsDir] = useState('~/.yfworking/skills')
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [showExamples, setShowExamples] = useState(false)
  const [builtin, setBuiltin] = useState<SkillEntry[]>([])
  const { setPendingInput } = useUIStore()
  const { pinnedSkills, togglePinSkill, skillFolders, skillFolderMap, addSkillFolder, removeSkillFolder, renameSkillFolder, setSkillFolder } = useUIStore()
  const { conversations, activeConversationId } = useChatStore()
  const activeConv = conversations.find(c => c.id === activeConversationId)
  const projectRoot = activeConv?.cwd || '.'

  // Listen for pin-limit exceeded event and show a warning alert
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {}
      const limit = detail.limit || 10
      setTimeout(() => {
        window.alert(`最多只能收藏 ${limit} 个常用技能，请先取消其他收藏再添加。`)
      }, 100)
    }
    window.addEventListener('yfworking:pin-limit', handler)
    return () => window.removeEventListener('yfworking:pin-limit', handler)
  }, [])

  // Click-outside to close dropdowns (mousedown to avoid race with button clicks)
  useEffect(() => {
    const handler = () => {
      setFolderPickerSkillId(null)
      setFolderMenuId(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Folder management UI state
  const [newFolderInput, setNewFolderInput] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [editingFolder, setEditingFolder] = useState<string | null>(null)
  const [editFolderName, setEditFolderName] = useState('')
  const [folderMenuId, setFolderMenuId] = useState<string | null>(null)
  const [folderPickerSkillId, setFolderPickerSkillId] = useState<string | null>(null)

  // Default folder assignment heuristic: Working vs Coding
  const getDefaultFolder = (skillId: string): string => {
    if (/^(gxtz-|yfwdoc-|yfwweb-|yfwx-)/.test(skillId)) return 'Working'
    return 'Coding'
  }

  // Resolve a skill's folder (explicit assignment > default heuristic)
  const getSkillFolder = (skillId: string): string => {
    return skillFolderMap[skillId] || getDefaultFolder(skillId)
  }

  const quickRun = (skillId: string) => {
    setPendingInput(buildSkillPrompt(skillsDir, skillId), true)
  }

  const insertSkill = (skillId: string) => {
    setPendingInput('/' + skillId + ' ')
  }

  const loadSkills = async () => {
    const list = await fetchSkills(projectRoot, setSkillsDir)
    setSkills(list)
    setLoading(false)
  }

  const installSkill = async () => {
    try {
      const fileApi = window.yfworkingFile
      if (!fileApi?.openSkillPackage) {
        alert('Skill install requires Electron environment.')
        return
      }
      const packagePath = await fileApi.openSkillPackage()
      if (!packagePath) return
      
      setLoading(true)
      const r = await fetch(`${getBridgeUrl()}/install-skill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: packagePath }),
      })
      const data = await r.json()
      if (data.ok) {
        alert(`Skill "${data.skillId}" v${data.version} installed successfully.${data.hasDeps ? '\n\nNote: This skill has Python dependencies. Run: pip install -r ' + skillsDir + '/' + data.skillId + '/_scripts/requirements.txt' : ''}`)
        // Refresh skill list
        loadSkills()
      } else {
        alert(`Install failed: ${data.error}`)
      }
    } catch (e: any) {
      alert(`Install error: ${e.message}`)
    }
    setLoading(false)
  }

  const uninstallSkill = async (skillId: string) => {
    if (!confirm(`Are you sure you want to uninstall "${skillId}"? This cannot be undone.`)) return
    try {
      setLoading(true)
      const r = await fetch(`${getBridgeUrl()}/uninstall-skill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: skillId }),
      })
      const data = await r.json()
      if (data.ok) {
        setSelected(null)
        loadSkills()
      } else {
        alert(`Uninstall failed: ${data.error}`)
      }
    } catch (e: any) {
      alert(`Uninstall error: ${e.message}`)
    }
    setLoading(false)
  }

  const installFromExample = async (exampleName: string) => {
    try {
      setLoading(true)
      // Use the bundled sample-skills path
      const samplePath = `${import.meta.env.BASE_URL}sample-skills/${exampleName}`
      // For Electron, resolve from the app directory
      const r = await fetch(`${getBridgeUrl()}/install-skill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: samplePath, isExample: true }),
      })
      const data = await r.json()
      if (data.ok) {
        alert(`Skill "${data.skillId}" v${data.version} installed successfully!`)
        setShowExamples(false)
        loadSkills()
        loadBuiltin()
      } else {
        alert(`Install failed: ${data.error}`)
      }
    } catch (e: any) {
      alert(`Install error: ${e.message}`)
    }
    setLoading(false)
  }

  // Load built-in skill packages (installable from the app bundle)
  const loadBuiltin = async () => {
    try {
      const r = await fetch(`${getBridgeUrl()}/sample-skills`)
      const data = await r.json()
      setBuiltin(Array.isArray(data.skills) ? data.skills : [])
    } catch { setBuiltin([]) }
  }

  useEffect(() => {
    loadSkills()
    loadBuiltin()
  }, [projectRoot])

  const matches = (s: SkillEntry) =>
    !filter ||
    s.id.toLowerCase().includes(filter.toLowerCase()) ||
    s.description.toLowerCase().includes(filter.toLowerCase()) ||
    s.triggers.some(t => t.includes(filter))

  // 顶层可见技能 = 无 parent 的父/独立技能；搜索时若某子技能命中，其父技能一并带出
  const filtered = skills.filter(s => !s.parent && (matches(s) || (s.subskills || []).some(c => {
    const child = skills.find(x => x.id === c)
    return !!child && matches(child)
  })))

  const selectedSkill = skills.find(s => s.id === selected)

  // Group skills by folder (dynamic)
  const folderGroups: Record<string, SkillEntry[]> = {}
  // Initialise from skillFolders order; also collect any orphan folder assignments
  for (const f of skillFolders) {
    folderGroups[f] = []
  }
  for (const s of filtered) {
    const f = getSkillFolder(s.id)
    if (!folderGroups[f]) folderGroups[f] = []
    folderGroups[f].push(s)
  }
  // Remove empty default folders from display? No — show all folders (even empty) so user can organise

  // Frequently-used skills pinned to the top (max 10), filtered to those still installed
  const pinnedList = pinnedSkills.map(id => skills.find(s => s.id === id)).filter((s): s is SkillEntry => !!s).slice(0, 10)

  // Reusable skill list item — used by both the pinned (常用技能) and category sections.
  // Parent skills (subskills declared) show a fold arrow on the left; clicking toggles
  // expansion + selects. Child/standalone skills keep the existing Zap + right chevron.
  const renderSkillItem = (skill: SkillEntry, isParent = false, isExpanded = false, onToggle?: () => void) => {
    const isPinned = pinnedSkills.includes(skill.id)
    return (
      <div key={skill.id} className={cn('group relative', isPinned && 'bg-warning/10')}>
        <button
          onClick={() => { if (isParent && onToggle) onToggle(); setSelected(selected === skill.id ? null : skill.id) }}
          className={cn(
            'w-full flex items-start gap-2 px-3 py-2 text-left transition-colors',
            selected === skill.id
              ? 'bg-brand-500/10'
              : 'hover:bg-elevated'
          )}
        >
          <div className={cn(
            'w-6 h-6 rounded-md flex items-center justify-center shrink-0 mt-0.5',
            selected === skill.id ? 'bg-brand-500/10' : 'bg-transparent'
          )}>
            {isParent ? (
              <ChevronRight className={cn(
                'w-3 h-3 transition-transform',
                isExpanded ? 'rotate-90 text-brand-500/90' : 'text-tertiary'
              )} />
            ) : (
              <Zap className={cn('w-3 h-3', selected === skill.id ? 'text-brand-500/90' : 'text-tertiary')} />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-medium text-primary">{skill.id}</span>
              {isParent && skill.subskills && (
                <span className="text-[9px] text-tertiary/80 font-mono">{skill.subskills.length} 子</span>
              )}
              <span className="text-[9px] text-tertiary font-mono">{skill.version}</span>
              {isPinned && <Star className="w-2.5 h-2.5 fill-warning text-warning shrink-0" />}
            </div>
            <p className="text-[10px] text-tertiary line-clamp-2 mt-0.5 leading-relaxed">
              {skill.description}
            </p>
            {skill.triggers.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {skill.triggers.slice(0, 4).map(t => (
                  <span key={t} className="text-[9px] px-1 py-0.5 rounded bg-input text-tertiary">{t}</span>
                ))}
              </div>
            )}
          </div>
          {!isParent && (
            <ChevronRight className={cn(
              'w-3 h-3 text-tertiary shrink-0 mt-1 transition-transform',
              selected === skill.id && 'rotate-90'
            )} />
          )}
        </button>
        {/* Action buttons — visible on hover */}
        <div className="absolute right-6 top-1.5 hidden group-hover:flex items-center gap-1 animate-fade-in">
          <button
            onClick={e => { e.stopPropagation(); togglePinSkill(skill.id) }}
            className={cn(
              'px-1.5 py-1 rounded transition-colors text-[10px] font-medium',
              isPinned
                ? 'bg-brand-500/25 text-brand-500 ring-1 ring-brand-500/30'
                : 'bg-input hover:bg-brand-500/10 text-secondary hover:text-brand-500/80'
            )}
            title={isPinned ? t('skills.unpinSkill') : t('skills.pinSkill')}
          >
            <Star className={cn('w-3.5 h-3.5', isPinned && 'fill-brand-500 text-brand-500')} />
          </button>
          {/* Folder picker */}
          <div className="relative">
            <button
              onClick={e => { e.stopPropagation(); setFolderPickerSkillId(folderPickerSkillId === skill.id ? null : skill.id) }}
              className="px-1.5 py-1 rounded bg-input hover:bg-active text-[10px] text-secondary transition-colors"
              title="Move to folder"
            >
              <Folder className="w-3 h-3" />
            </button>
            {folderPickerSkillId === skill.id && (
              <div
                className="absolute right-0 top-full mt-1 w-32 bg-popover border border rounded-lg shadow-xl z-50 py-1 animate-scale-in origin-top-right"
                onMouseDown={e => e.stopPropagation()}
              >
                {skillFolders.map(f => (
                  <button
                    key={f}
                    onClick={e => {
                      e.stopPropagation()
                      setSkillFolder(skill.id, f)
                      setFolderPickerSkillId(null)
                    }}
                    className={cn(
                      'w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
                      getSkillFolder(skill.id) === f ? 'text-brand-500 bg-brand-500/5' : 'text-secondary hover:bg-elevated'
                    )}
                  >
                    {getSkillFolder(skill.id) === f && <Check className="w-3 h-3 text-brand-500" />}
                    <span className={getSkillFolder(skill.id) === f ? '' : 'ml-5'}>{f}</span>
                  </button>
                ))}
                <div className="border-t border-subtle my-0.5" />
                <button
                  onClick={e => {
                    e.stopPropagation()
                    setNewFolderInput(true)
                    setFolderPickerSkillId(null)
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-tertiary hover:bg-elevated transition-colors"
                >
                  <FolderPlus className="w-3 h-3" />
                  <span>新建分类…</span>
                </button>
              </div>
            )}
          </div>
          <button
            onClick={e => { e.stopPropagation(); insertSkill(skill.id) }}
            className="px-1.5 py-0.5 rounded bg-brand-500/15 hover:bg-brand-500/30 text-[9px] text-brand-500/90 transition-colors"
            title="Insert into chat input"
          >
            <Plus className="w-3 h-3" />
          </button>
          <button
            onClick={e => { e.stopPropagation(); quickRun(skill.id) }}
            className="px-1.5 py-0.5 rounded bg-input hover:bg-active text-[9px] text-secondary transition-colors"
            title="Run skill directly"
          >
            <ArrowRight className="w-3 h-3" />
          </button>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-tertiary text-xs">
        <Zap className="w-4 h-4 animate-pulse mr-1.5" /> Loading skills...
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-2 border-b border-subtle">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-brand-500" />
            <span className="text-sm font-semibold text-primary">Skills</span>
            <Badge variant="primary">{skills.length}</Badge>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowExamples(!showExamples)}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium text-secondary hover:bg-elevated transition-colors"
              title="Install from Examples"
            >
              <BookOpen className="w-3 h-3" />
              Examples
            </button>
            <button
              onClick={installSkill}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium text-brand-500/90 hover:bg-brand-500/10 transition-colors"
              title="Install Skill"
            >
              <Download className="w-3 h-3" />
              Install
            </button>
          </div>
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-tertiary" />
          <input
            type="text"
            placeholder="Search skills..."
            value={filter}
            onChange={e => { setFilter(e.target.value); setSelected(null) }}
            className="w-full h-7 bg-elevated border border-subtle rounded-md pl-6 pr-2 text-xs text-primary placeholder:text-tertiary focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent"
          />
        </div>
        {showExamples && (
          <div className="mb-2 p-2 rounded-md border border bg-elevated space-y-1 max-h-52 overflow-y-auto">
            <div className="text-[10px] text-tertiary mb-1">Built-in skills ({builtin.length}):</div>
            {builtin.map(s => {
              const isInstalled = (s as any).installed
              return (
                <div key={s.id} className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-input transition-colors text-left">
                  <BookOpen className="w-3 h-3 text-brand-500/80 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-primary truncate">{s.id}</div>
                    <div className="text-[10px] text-tertiary truncate">{s.description}</div>
                  </div>
                  {isInstalled ? (
                    <span className="text-[10px] text-tertiary shrink-0">已安装</span>
                  ) : (
                    <button
                      onClick={() => installFromExample(s.id)}
                      className="flex items-center gap-0.5 text-[10px] text-brand-500 hover:text-brand-400 shrink-0"
                    >
                      <Plus className="w-3 h-3" /> 安装
                    </button>
                  )}
                </div>
              )
            })}
            {builtin.length === 0 && (
              <div className="text-[10px] text-tertiary px-2 py-1">No built-in skills available</div>
            )}
          </div>
        )}
      </div>

      {/* List */}
      <ScrollArea className="flex-1">
        <div className="py-1">
          {/* Frequently-used skills pinned to the top */}
          {pinnedList.length > 0 && (
        <div key="pinned">
          <div
            className="h-px mx-3 my-1"
            style={{ background: 'linear-gradient(to right, transparent, var(--warning) 15%, var(--warning) 85%, transparent)' }}
          />
          <div className="px-3 py-1.5 text-[10px] font-semibold text-warning/90 uppercase tracking-wider flex items-center gap-1">
            <Star className="w-3 h-3 fill-warning text-warning" />
            {t('skills.pinnedSkillsTitle')}
          </div>
          {pinnedList.map(s => renderSkillItem(s))}
          <div
            className="h-px mx-3 my-1"
            style={{ background: 'linear-gradient(to right, transparent, var(--warning) 15%, var(--warning) 85%, transparent)' }}
          />
        </div>
      )}
          {Object.entries(folderGroups).map(([folderName, items]) => {
            const isEditing = editingFolder === folderName
            return (
              <div key={folderName}>
                <div className="px-3 py-1.5 text-[10px] font-semibold text-tertiary uppercase tracking-wider flex items-center justify-between group/folder">
                  {isEditing ? (
                    <div className="flex items-center gap-1 flex-1">
                      <input
                        type="text"
                        value={editFolderName}
                        onChange={e => setEditFolderName(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            renameSkillFolder(folderName, editFolderName)
                            setEditingFolder(null)
                            setEditFolderName('')
                          }
                          if (e.key === 'Escape') {
                            setEditingFolder(null)
                            setEditFolderName('')
                          }
                        }}
                        className="flex-1 h-5 bg-elevated border border rounded px-1.5 text-[10px] text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                        autoFocus
                        onBlur={() => {
                          if (editFolderName.trim() && editFolderName !== folderName) {
                            renameSkillFolder(folderName, editFolderName)
                          }
                          setEditingFolder(null)
                          setEditFolderName('')
                        }}
                      />
                    </div>
                  ) : (
                    <>
                      <span>
                        <FolderOpen className="w-3 h-3 inline mr-1 -mt-0.5 text-tertiary/60" />
                        {folderName} ({items.length})
                      </span>
                      <div className="relative">
                        <button
                          onClick={e => { e.stopPropagation(); setFolderMenuId(folderMenuId === folderName ? null : folderName) }}
                          className="opacity-0 group-hover/folder:opacity-100 p-0.5 rounded hover:bg-input transition-all"
                        >
                          <MoreHorizontal className="w-3 h-3 text-tertiary" />
                        </button>
                        {folderMenuId === folderName && (
                          <div
                            className="absolute right-0 top-full mt-0.5 w-28 bg-popover border border rounded-lg shadow-xl z-50 py-1 animate-scale-in origin-top-right"
                            onMouseDown={e => e.stopPropagation()}
                          >
                            <button
                              onClick={e => {
                                e.stopPropagation()
                                setEditingFolder(folderName)
                                setEditFolderName(folderName)
                                setFolderMenuId(null)
                              }}
                              className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-secondary hover:bg-elevated transition-colors"
                            >
                              <Edit3 className="w-3 h-3" />
                              重命名
                            </button>
                            {folderName !== 'Working' && folderName !== 'Coding' && (
                              <button
                                onClick={e => {
                                  e.stopPropagation()
                                  if (confirm(`确定要删除分类「${folderName}」吗？其中的技能将移回 "Working"。`)) {
                                    removeSkillFolder(folderName)
                                  }
                                  setFolderMenuId(null)
                                }}
                                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-error hover:bg-error/5 transition-colors"
                              >
                                <Trash2 className="w-3 h-3" />
                                删除
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
                {items.map(s => {
                  // 子技能折叠在父技能条目下，不在 folder 层平铺
                  if (s.parent) return null
                  const isParent = (s.subskills || []).length > 0
                  const parentMatched = matches(s)
                  // 子技能匹配双来源：父技能的 subskills id 列表为主（大多数子技能不写 parent），
                  // parent 反推为辅（如 yfwx-project-eval 声明了 parent: yfwx-suite）
                  const childIds = s.subskills || []
                  const children = isParent
                    ? skills.filter(c => (childIds.includes(c.id) || c.parent === s.id) && (!filter || parentMatched || matches(c)))
                    : []
                  // 手动展开优先；搜索时命中父或其任一子技能 → 自动展开
                  const isExpanded = expanded[s.id] || (filter ? parentMatched || children.length > 0 : false)
                  return (
                    <div key={s.id}>
                      {renderSkillItem(
                        s, isParent, isExpanded,
                        () => setExpanded(e => ({ ...e, [s.id]: !e[s.id] }))
                      )}
                      {isParent && isExpanded && children.length > 0 && (
                        <div className="pl-4">
                          {children.map(c => renderSkillItem(c))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
          {/* New folder button / input */}
          <div className="px-3 py-2">
            {newFolderInput ? (
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  value={newFolderName}
                  onChange={e => setNewFolderName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && newFolderName.trim()) {
                      addSkillFolder(newFolderName.trim())
                      setNewFolderName('')
                      setNewFolderInput(false)
                    }
                    if (e.key === 'Escape') {
                      setNewFolderName('')
                      setNewFolderInput(false)
                    }
                  }}
                  placeholder="分类名称…"
                  className="flex-1 h-6 bg-elevated border border rounded-md px-2 text-xs text-primary placeholder:text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
                  autoFocus
                />
                <button
                  onClick={() => {
                    if (newFolderName.trim()) {
                      addSkillFolder(newFolderName.trim())
                      setNewFolderName('')
                      setNewFolderInput(false)
                    }
                  }}
                  className="px-2 py-1 rounded text-[10px] font-medium text-brand-500 hover:bg-brand-500/10 transition-colors"
                  disabled={!newFolderName.trim()}
                >
                  <Check className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => { setNewFolderName(''); setNewFolderInput(false) }}
                  className="px-2 py-1 rounded text-[10px] text-tertiary hover:bg-input transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => setNewFolderInput(true)}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-dashed border-subtle text-[10px] text-tertiary hover:text-secondary hover:border-active hover:bg-elevated transition-colors"
              >
                <FolderPlus className="w-3.5 h-3.5" />
                新建分类文件夹
              </button>
            )}
          </div>
        </div>
      </ScrollArea>

      {/* Detail panel */}
      {selectedSkill && (
        <div className="border-t border-subtle bg-app p-3 animate-slide-up max-h-[40%] overflow-y-auto shrink-0">
          <h4 className="text-xs font-semibold text-primary mb-1">{selectedSkill.id}</h4>
          <p className="text-[10px] text-tertiary mb-2 leading-relaxed">{selectedSkill.description}</p>
          <div className="flex gap-2 mb-2">
            <Button variant="primary" size="xs" onClick={() => insertSkill(selectedSkill.id)} leftIcon={<Plus className="w-3 h-3" />}>
              Insert /{selectedSkill.id}
            </Button>
            <Button variant="secondary" size="xs" onClick={() => quickRun(selectedSkill.id)} leftIcon={<ArrowRight className="w-3 h-3" />}>
              Quick Run
            </Button>
            <Button variant="ghost" size="xs" onClick={() => uninstallSkill(selectedSkill.id)} leftIcon={<Trash2 className="w-3 h-3 text-error" />}>
              <span className="text-error">Uninstall</span>
            </Button>
          </div>
          <div className="space-y-1 text-[10px]">
            <div className="flex justify-between">
              <span className="text-tertiary">Version</span>
              <span className="text-secondary font-mono">{selectedSkill.version}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-tertiary">Size</span>
              <span className="text-secondary">{selectedSkill.size_kb} KB ({selectedSkill.lines} lines)</span>
            </div>
            <div className="flex justify-between">
              <span className="text-tertiary">Invoke</span>
              <span className="text-brand-500/85 font-mono">/{selectedSkill.id}</span>
            </div>
            {(selectedSkill as any).installed_from && (
              <div className="flex justify-between">
                <span className="text-tertiary">Source</span>
                <span className="text-secondary">{(selectedSkill as any).installed_from === 'file' ? 'Installed' : (selectedSkill as any).installed_from}</span>
              </div>
            )}
            {(selectedSkill as any).installed_at && (
              <div className="flex justify-between">
                <span className="text-tertiary">Installed</span>
                <span className="text-secondary">{new Date((selectedSkill as any).installed_at).toLocaleDateString()}</span>
              </div>
            )}
            {(selectedSkill as any).scripts_dir && (
              <div className="flex justify-between">
                <span className="text-tertiary">Scripts</span>
                <span className="text-secondary">{((selectedSkill as any).scripts_dir)}/</span>
              </div>
            )}
          </div>
          {selectedSkill.triggers.length > 0 && (
            <div className="mt-2">
              <span className="text-[10px] text-tertiary">Trigger words:</span>
              <div className="flex flex-wrap gap-1 mt-1">
                {selectedSkill.triggers.map(t => (
                  <span key={t} className="text-[9px] px-1.5 py-0.5 rounded bg-brand-500/10 text-brand-500/85">{t}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
