import { useState, useEffect } from 'react'
import { Zap, Search, ChevronRight, ArrowRight, Plus, Download, Trash2, FolderOpen, BookOpen, Star, FolderPlus, MoreHorizontal, Check, Folder, Edit3, X, Ban, Play } from 'lucide-react'
import { ScrollArea, Badge, Button } from '@/components/ui'
import { useUIStore } from '@/stores/uiStore'
import { useDisabledStore } from '@/stores/disabledStore'
import { PinnedSkillsRow } from './PinnedSkillsRow'
import { SkillDetailPanel } from './SkillDetailPanel'
import { useChatStore } from '@/stores/chatStore'
import { useViewStore } from '@/stores/viewStore'
import { useTranslation } from '@/i18n/useTranslation'
import { cn } from '@/lib/utils'
import { getBridgeUrl } from '@/lib/config'
import { fetchSkills, buildSkillPrompt, type SkillEntry } from '@/lib/skills'
// 父子归属与分类的纯逻辑（2026-09-15，批次二 C）：抽到 .ts 才能被 node --test 直测
// （.tsx 无法 import，实测 ERR_UNKNOWN_FILE_EXTENSION）。同时统一了原先分散在三处的父级判据
// —— 判据不一致会导致"只被 parent 反指的父级不带子项"与"孤儿技能在界面上彻底消失"，
// 详见 skillTree.ts 头注。
import { topLevelSkills, defaultFolderOf, resolveFolder, isParentSkill, childrenToShow } from '@/lib/skillTree'

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
  // 全局停用清单（2026-09-15，D 条款）：挂载时拉一次（不持久化到前端——真相在内核读的那个文件里）
  const disabledSkills = useDisabledStore(s => s.skills)
  const loadDisabled = useDisabledStore(s => s.load)
  const setSkillDisabled = useDisabledStore(s => s.setSkillDisabled)
  // 详情面板展开态（2026-09-15，批次二 C）：只存一个 id —— 同时只展开一个技能，
  // 避免多个详情面板堆叠把列表撑得极长（这页的问题本来就是"不占版面"）。
  const [detailId, setDetailId] = useState<string | null>(null)
  useEffect(() => { void loadDisabled() }, [loadDisabled])
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

  // 分类口径（2026-09-15，批次二 C）：抽到 `@/lib/skillTree`（纯函数，可被 node --test 直测）
  // ——「人工指派优先，其次前缀启发式」的规则只此一处（原先内联在此，且与顶层过滤/渲染处的
  // 父级判据不一致，详见 skillTree.ts 头注）。
  const getDefaultFolder = (skillId: string): string => defaultFolderOf(skillId)

  // Resolve a skill's folder (explicit assignment > default heuristic)
  const getSkillFolder = (skillId: string): string => resolveFolder(skillId, skillFolderMap)

  const quickRun = (skillId: string) => {
    setPendingInput(buildSkillPrompt(skillsDir, skillId), true)
    // 2026-09-10 主标签化：技能页为全主界面浏览，一键运行需切回 chat rail
    // 让输入落进对话（无会话时由 ViewRouter 兜底建空会话）
    useViewStore.setState(s => ({ workState: { ...s.workState, rail: 'chat' } }))
  }

  const insertSkill = (skillId: string) => {
    setPendingInput('/' + skillId + ' ')
    useViewStore.setState(s => ({ workState: { ...s.workState, rail: 'chat' } }))
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

  // 顶层可见技能（2026-09-15，批次二 C）：口径抽到 `@/lib/skillTree` 的 `topLevelSkills`
  // —— 原先内联在这里 + 另有两处各自判断，导致「父级判据不一致」与「孤儿技能消失」两个缺陷
  // （详见 skillTree.ts 头注）。规则：无 parent → 顶层；**孤儿**（parent 指向不存在的技能）也留顶层。
  const filtered = topLevelSkills(skills, matches)

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
  // childCount（2026-09-15，批次二 C）：统一父级判据后新增——原先只显示 `skill.subskills.length`，
  // 于是"只被子技能用 parent 反指"的父级会显示为父级却没有计数（自相矛盾）。现在由调用方传入
  // 合并双来源后的真实子项数。
  const renderSkillItem = (skill: SkillEntry, isParent = false, isExpanded = false, onToggle?: () => void, childCount = 0) => {
    const isPinned = pinnedSkills.includes(skill.id)
    // 停用态（2026-09-15，D 条款）：从全局注册表派生，故"文件被手改/换机器"后界面也会如实反映。
    const skillDisabled = disabledSkills.includes(skill.id)
    return (
      <div
        key={skill.id}
        className={cn(
          // 2026-09-10 设计语言统一：单对角切角卡 + 选中热边 / 固定项警示边 + hover 柔光
          'group relative cut-sm transition-all',
          isPinned && selected !== skill.id && 'warn',
          selected === skill.id && 'hot glow-hover'
        )}
      >
        <div className="ci">
        <button
          onClick={() => { if (isParent && onToggle) onToggle(); setSelected(selected === skill.id ? null : skill.id) }}
          className={cn(
            'w-full flex items-start gap-2 px-3 py-2.5 text-left transition-colors',
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
              {isParent && childCount > 0 && (
                <span className="text-[9px] text-tertiary/80 font-mono">{childCount} 子</span>
              )}
              <span className="text-[9px] text-tertiary font-mono">{skill.version}</span>
              {isPinned && <Star className="w-2.5 h-2.5 fill-warning text-warning shrink-0" />}
              {/* 停用徽标常驻（不只在 hover 操作区）：停用状态必须在列表里一眼可见，
                  否则用户会以为技能还能用（而它是被内核静默排除的）。 */}
              {skillDisabled && (
                <span className="text-[9px] px-1 py-0.5 rounded bg-warning/15 text-warning shrink-0">
                  {t('skills.disabledBadge')}
                </span>
              )}
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
            {/* 详情面板（2026-09-15，批次二 C）：只读展示触发规则 / 关联脚本 / 来源目录 + 系统打开。
                放在内容列内（而不是卡片外）以保证与卡片左对齐、不破坏 flex 行布局。 */}
            {detailId === skill.id && (
              <div onClick={e => e.stopPropagation()}>
                <SkillDetailPanel
                  skillId={skill.id}
                  disabled={skillDisabled}
                  folder={getSkillFolder(skill.id)}
                />
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
          {/* 详情开关（2026-09-15，批次二 C）：展开显示只读的触发规则与关联脚本 */}
          <button
            onClick={e => { e.stopPropagation(); setDetailId(detailId === skill.id ? null : skill.id) }}
            className={cn(
              'px-1.5 py-1 rounded transition-colors text-[10px] font-medium',
              detailId === skill.id
                ? 'bg-brand-500/20 text-brand-400 ring-1 ring-brand-500/30'
                : 'bg-input hover:bg-brand-500/10 text-secondary hover:text-brand-400'
            )}
            title={t('skills.detailToggle')}
          >
            <BookOpen className="w-3.5 h-3.5" />
          </button>
          {/* 全局启用/停用（2026-09-15，D 条款）：技能此前**完全没有**开关，
              停用后内核不再把它列入提示词技能清单，也不能按名调用。 */}
          <button
            onClick={e => {
              e.stopPropagation()
              void (async () => {
                const err = await setSkillDisabled(skill.id, !skillDisabled)
                // 失败必须出声：静默失败会长期停留在"我明明停用了它"的错觉里。
                if (err) alert(t('skills.toggleFailed', { error: err }))
              })()
            }}
            className={cn(
              'px-1.5 py-1 rounded transition-colors text-[10px] font-medium',
              skillDisabled
                ? 'bg-warning/20 text-warning ring-1 ring-warning/30'
                : 'bg-input hover:bg-warning/10 text-secondary hover:text-warning/80'
            )}
            title={skillDisabled ? t('skills.enableHint') : t('skills.disableHint')}
          >
            {skillDisabled ? <Play className="w-3.5 h-3.5" /> : <Ban className="w-3.5 h-3.5" />}
          </button>
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
                className="absolute right-0 top-full mt-1 w-32 cut-sm cut-pop z-50 animate-scale-in origin-top-right"
                style={{ filter: 'drop-shadow(var(--modal-drop))' }}
                onMouseDown={e => e.stopPropagation()}
              >
                <div className="ci py-1">
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
      <div className="px-4 py-3 border-b border-subtle">
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

      {/* List（2026-09-10 全主界面卡片化：响应式卡片网格，分组标题占满整行） */}
      <ScrollArea className="flex-1">
        <div className="p-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 content-start">
          {/* Frequently-used skills pinned to the top */}
          {pinnedList.length > 0 && (
        <div key="pinned" className="contents">
          <div
            className="col-span-full h-px my-1"
            style={{ background: 'linear-gradient(to right, transparent, var(--warning) 15%, var(--warning) 85%, transparent)' }}
          />
          <div className="col-span-full py-1.5 text-[11px] font-semibold text-warning/90 uppercase tracking-wider flex items-center gap-1">
            <Star className="w-3 h-3 fill-warning text-warning" />
            {t('skills.pinnedSkillsTitle')}
          </div>
          {/* 紧凑卡片行（2026-09-15，批次二 B）：改前这里用与主体列表相同的整卡渲染，
              收藏几个就把主体列表挤下去大半屏。现在只占一行小卡。 */}
          <div className="col-span-full pb-1">
            <PinnedSkillsRow
              skills={pinnedList}
              onOpen={(s) => {
                // 收藏小卡点击 = "带我去看它"（紧凑区不该再承载编辑/安装等操作）。
                // 若它是父级技能则先展开（折叠状态下来找会很困惑），再滚动定位到主体列表里那一项。
                // 判据统一走 `isParentSkill`（2026-09-15，批次二 C）：此处原先是第三份内联副本，
                // 与顶层过滤/渲染循环各自实现同一语义 —— 判据一分散就必然出现"某一处漏了新来源"的缺陷。
                if (isParentSkill(s, skills)) setExpanded(e => ({ ...e, [s.id]: true }))
                requestAnimationFrame(() => {
                  document.getElementById(`skill-item-${s.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                })
              }}
              onUnpin={(id) => togglePinSkill(id)}
              isDisabled={(id) => disabledSkills.includes(id)}
            />
          </div>
          <div
            className="col-span-full h-px my-1"
            style={{ background: 'linear-gradient(to right, transparent, var(--warning) 15%, var(--warning) 85%, transparent)' }}
          />
        </div>
      )}
          {Object.entries(folderGroups).map(([folderName, items]) => {
            const isEditing = editingFolder === folderName
            return (
              <div key={folderName} className="contents">
                <div className="col-span-full pt-2 pb-1 text-[11px] font-semibold text-tertiary uppercase tracking-wider flex items-center justify-between group/folder">
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
                            className="absolute right-0 top-full mt-0.5 w-28 cut-sm cut-pop z-50 animate-scale-in origin-top-right"
                            style={{ filter: 'drop-shadow(var(--modal-drop))' }}
                            onMouseDown={e => e.stopPropagation()}
                          >
                            <div className="ci py-1">
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
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
                {items.map(s => {
                  // 父级判据统一走 isParentSkill（双来源合并）：**不能**只认 `subskills`，
                  // 否则"只被子技能用 parent 反指"的父级会被当普通技能 ⇒ 子项不渲染。
                  const isParent = isParentSkill(s, skills)
                  const parentMatched = matches(s)
                  // 子技能双来源合并 + 去重 + 剔除不存在与自指（`childIdsOf`），并按搜索态过滤。
                  const children = childrenToShow(s, skills, matches, !!filter)
                  // 手动展开优先；搜索时命中父或其任一子技能 → 自动展开
                  const isExpanded = expanded[s.id] || (filter ? parentMatched || children.length > 0 : false)
                  return (
                    <div key={s.id} id={`skill-item-${s.id}`}>
                      {renderSkillItem(
                        s, isParent, isExpanded,
                        () => setExpanded(e => ({ ...e, [s.id]: !e[s.id] })),
                        // 真实子项数（双来源合并后的 children），用于"n 子"计数
                        children.length
                      )}
                      {isParent && isExpanded && children.length > 0 && (
                        <div className="pl-4">
                          {/* 子项调用不传 childCount：本层不递归展开孙项，
                              给了计数却不能展开反而是误导（默认 0 即不显示）。 */}
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
