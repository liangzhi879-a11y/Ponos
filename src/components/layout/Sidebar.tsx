import { useState, useEffect, useRef, useLayoutEffect, memo } from 'react'
import { createPortal } from 'react-dom'
import {
  MessageSquare, History, FolderTree, Bot, Plus, Search, GitFork,
  Pin, Trash2, Edit3, Puzzle, MessageSquarePlus, CalendarClock,
  Wand2, ChevronRight, FolderOpen, FolderPlus, Share2, ArrowUpDown, Check,
} from 'lucide-react'
import { Button } from '@/components/ui'
import { ScrollArea } from '@/components/ui'
import { Tooltip } from '@/components/ui'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui'
import { useChatStore } from '@/stores/chatStore'
import { fetchTranscript } from '@/lib/transcriptLoader'
import { useUIStore } from '@/stores/uiStore'
import { useTranslation } from '@/i18n/useTranslation'
import { HistoryView } from '@/components/history/HistoryView'
import { FileBrowser } from '@/components/files/FileBrowser'
import { AgentsPanel } from '@/components/agents/AgentsPanel'
import { WorktreePanel } from '@/components/worktree/WorktreePanel'
import { SkillsPanel } from '@/components/skills/SkillsPanel'
import { formatDate, cn } from '@/lib/utils'
import type { Conversation, ConversationProgress, ConversationSet, Message } from '@/types'

const TABS = [
  { id: 'chats' as const, icon: MessageSquare, labelKey: 'sidebar.chats' },
  { id: 'files' as const, icon: FolderTree, labelKey: 'sidebar.files' },
  { id: 'worktrees' as const, icon: GitFork, labelKey: 'sidebar.worktrees' },
  { id: 'history' as const, icon: History, labelKey: 'sidebar.history' },
  { id: 'agents' as const, icon: Bot, labelKey: 'sidebar.agents' },
  { id: 'skills' as const, icon: Puzzle, labelKey: 'sidebar.skills' },
]

// 导出会话（单个/整个会话集）为 zip：dev 模式无 preload，直接返回。
// v2：消息体不再在 localStorage——逐会话从内核 transcript 全量读取（tailFirst=0, crop=false，
// 完整消息，非展示级裁剪）组装 chatsJson，与旧导出格式兼容（{ state: { conversations, ... } }）。
const exportChats = async (chatsFilter: { conversationIds?: string[]; setId?: string }) => {
  if (!window.ponosAPI) return
  const st = useChatStore.getState()
  const all = st.conversations
  const picked = chatsFilter?.conversationIds
    ? all.filter(c => chatsFilter.conversationIds!.includes(c.id))
    : chatsFilter?.setId
      ? all.filter(c => c.setId === chatsFilter.setId)
      : all
  const withMessages: Conversation[] = []
  for (const c of picked) {
    let messages: Message[] = []
    const ids = c.sessionIds || []
    const parts: Message[][] = []
    for (const sid of ids) {
      const r = await fetchTranscript(sid, c.cwd || '', { tailFirst: false, crop: false })
      if (r.ok) parts.push(r.messages)
    }
    // ext 兜底（导入的无 transcript 会话）合并
    try {
      const raw = window.localStorage.getItem('ponos-chat-ext-' + c.id)
      if (raw) parts.push(JSON.parse(raw) as Message[])
    } catch { /* ignore */ }
    const flat = parts.flat().sort((a, b) => a.timestamp - b.timestamp)
    const seen = new Set<string>()
    for (const m of flat) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      messages.push(m)
    }
    withMessages.push({ ...c, messages })
  }
  const chatsJson = JSON.stringify({
    state: {
      conversations: withMessages.map(c => ({ ...c, messages: c.messages.slice(-100) })),
      conversationSets: st.conversationSets,
      activeConversationId: st.activeConversationId,
      lastCwd: st.lastCwd,
    },
  })
  window.ponosAPI.exportExperience({
    included: ['chats'],
    chatsJson,
    chatsFilter,
    configRedact: true,
  }).then(res => {
    if (!res.ok) { /* 静默或 console.warn：取消时不打扰 */ console.warn('导出取消或失败', res.error) }
  })
}

export function Sidebar() {
  // 逐个 selector 订阅，避免全量订阅导致任意 store 变化（如消息流式 token）都重渲染
  const conversations = useChatStore(s => s.conversations)
  const activeConversationId = useChatStore(s => s.activeConversationId)
  const streamingConversations = useChatStore(s => s.streamingConversations)
  const pendingQuestions = useChatStore(s => s.pendingQuestions)
  const conversationProgress = useChatStore(s => s.conversationProgress)
  const createConversation = useChatStore(s => s.createConversation)
  const setActiveConversation = useChatStore(s => s.setActiveConversation)
  const deleteConversation = useChatStore(s => s.deleteConversation)
  const renameConversation = useChatStore(s => s.renameConversation)
  const pinConversation = useChatStore(s => s.pinConversation)
  const reorderConversations = useChatStore(s => s.reorderConversations)
  const conversationSets = useChatStore(s => s.conversationSets)
  const createConversationSet = useChatStore(s => s.createConversationSet)
  const setConversationSet = useChatStore(s => s.setConversationSet)
  const renameConversationSet = useChatStore(s => s.renameConversationSet)
  const deleteConversationSet = useChatStore(s => s.deleteConversationSet)
  const autoOrganize = useChatStore(s => s.autoOrganize)
  const reorderConversationSets = useChatStore(s => s.reorderConversationSets)
  const sidebarTab = useUIStore(s => s.sidebarTab)
  const setSidebarTab = useUIStore(s => s.setSidebarTab)
  const setScheduleGuideFor = useUIStore(s => s.setScheduleGuideFor)
  const chatSortMode = useUIStore(s => s.chatSortMode)
  const setChatSortMode = useUIStore(s => s.setChatSortMode)
  const { t } = useTranslation()
  const [searchQuery, setSearchQuery] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [contextMenu, setContextMenu] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [setMenuId, setSetMenuId] = useState<string | null>(null)
  const [setMenuPos, setSetMenuPos] = useState<{ left: number; top: number } | null>(null)
  const [renamingSetId, setRenamingSetId] = useState<string | null>(null)
  const [renamingSetValue, setRenamingSetValue] = useState('')
  const [moveTarget, setMoveTarget] = useState<string | null>(null)
  const [dragSetId, setDragSetId] = useState<string | null>(null)
  const [dragSetOverId, setDragSetOverId] = useState<string | null>(null)

  // Close context menu when clicking outside
  useEffect(() => {
    if (!contextMenu) return
    const handleClick = () => { setContextMenu(null); setMoveTarget(null) }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [contextMenu])

  // Close set menu when clicking outside
  useEffect(() => {
    if (!setMenuId) return
    const handleClick = () => setSetMenuId(null)
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [setMenuId])

  // 激活会话滚动定位。区分两种场景：
  // 1) 冷启动首次挂载（含 onRehydrateStorage 把 activeConversationId 设为最新会话）：
  //    用户期望"打开应用自动定位到最新会话"（2026-08-16 提问卡片确认：停视口底部）。
  //    block:'end' 让最新会话贴可见区最下沿；位置靠上时钳制为 0 → 停在置顶区正下方，
  //    并加一次 locate-flash 高亮让定位可感知。
  // 2) 常规切换会话：block:'nearest' 仅保证可见，不打断用户主动滚动。
  // 延迟到布局稳定后执行：冷启动时 ScrollArea 内容刚挂载，立即 scrollIntoView 会因
  // 目标元素未布局/视口未就绪而无效（Radix viewport 需要一轮渲染后才可滚动）。
  const didInitialScroll = useRef(false)
  useEffect(() => {
    if (!activeConversationId) return
    // 元素可能因 tab 不在 chats（列表未渲染）或布局未就绪而暂缺：
    // 短轮询重试（每 150ms，最多 12 次），避免静默丢失定位；切到 chats tab 时
    // sidebarTab 变化会重新触发本 effect，重试窗口也随之刷新。
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const tryScroll = () => {
      const el = document.querySelector(`[data-conv-id="${activeConversationId}"]`)
      if (!el) {
        if (attempts < 12) {
          attempts++
          timer = setTimeout(tryScroll, 150)
        }
        return
      }
      if (!didInitialScroll.current) {
        // 冷启动首次定位：把最新会话滚到视口底部（聊天记录式——旧会话在上、
        // 最新会话贴可见区最下沿）。用户明确选择"最新会话停视口底部"。
        // block:'end' 使元素底边对齐视口底边；当最新会话位置靠上、所需滚动量
        // 为负时浏览器钳制到 0，天然退化为"停在置顶区正下方、置顶保持可见"。
        // （此前用 block:'start' 把最新会话顶到视口顶部，用户反馈仍像"定位在
        // 中间"——顶部一行 + 下方大片旧会话被截断；center 需要负滚动量时同样
        // 会被钳制静默不滚。）
        didInitialScroll.current = true
        el.scrollIntoView({ block: 'end' })
        // 定位可感知性：数据顺序下最新会话可能本就无需滚动（钳制为 0），视觉上
        // 与"未定位"无异，短暂高亮闪现让用户一眼看到定位到了哪一行。
        el.classList.add('locate-flash')
        window.setTimeout(() => el.classList.remove('locate-flash'), 1400)
      } else {
        // 常规切换：保证可见即可，不打断用户主动滚动
        el.scrollIntoView({ block: 'nearest' })
      }
    }
    timer = setTimeout(tryScroll, 150)
    return () => { if (timer) clearTimeout(timer) }
  }, [activeConversationId, sidebarTab])

  const filtered = searchQuery
    ? conversations.filter(c => (c.title || '').toLowerCase().includes(searchQuery.toLowerCase()))
    : conversations

  const pinned = filtered.filter(c => c.pinned)
  const unpinned = filtered.filter(c => !c.pinned)
  // 排序模式仅作用于主列表（unpinned）；pinned 区保持手动顺序不参与
  const sortedUnpinned = [...unpinned].sort((a, b) => {
    switch (chatSortMode) {
      case 'updated': return (b.updatedAt || 0) - (a.updatedAt || 0)
      case 'created': return (b.createdAt || 0) - (a.createdAt || 0)
      case 'title': return (a.title || '').localeCompare(b.title || '')
      default: return 0  // manual：保持 store 顺序
    }
  })
  // 会话集仅手动顺序（store 顺序），不再按名称排序
  const filteredSets = conversationSets

  const getConvIndex = (id: string) => conversations.findIndex(c => c.id === id)

  const handleDragStart = (convId: string) => {
    // 非手动排序模式下开始拖拽：立即切回手动（列表回到 store 顺序），
    // 保证 drop 的 from/to 索引与展示一致
    if (chatSortMode !== 'manual') setChatSortMode('manual')
    setDragId(convId)
  }
  const handleDragOver = (e: React.DragEvent, convId: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (convId !== dragId) setDragOverId(convId)
  }
  const handleDragLeave = (convId: string) => {
    if (dragOverId === convId) setDragOverId(null)
  }
  const handleDrop = (convId: string) => {
    setDragOverId(null)
    if (!dragId || dragId === convId) { setDragId(null); return }
    const from = getConvIndex(dragId)
    const to = getConvIndex(convId)
    if (from >= 0 && to >= 0) reorderConversations(from, to)
    setDragId(null)
  }
  const handleDragEnd = () => { setDragId(null); setDragOverId(null) }

  // 会话集拖拽排序（仅手动顺序；会话集不参与排序模式）
  const handleSetDragStart = (setId: string) => { setDragSetId(setId) }
  const handleSetDragOver = (e: React.DragEvent, setId: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (setId !== dragSetId) setDragSetOverId(setId)
  }
  const handleSetDragLeave = (setId: string) => {
    if (dragSetOverId === setId) setDragSetOverId(null)
  }
  const handleSetDrop = (setId: string) => {
    setDragSetOverId(null)
    // 会话拖入会话集 → 分类赋值（与会话集之间重排序互斥）
    if (dragId && !dragSetId) {
      if (dragId !== setId) setConversationSet(dragId, setId)
      setDragId(null)
      return
    }
    if (!dragSetId || dragSetId === setId) { setDragSetId(null); return }
    const from = conversationSets.findIndex(s => s.id === dragSetId)
    const to = conversationSets.findIndex(s => s.id === setId)
    if (from >= 0 && to >= 0) reorderConversationSets(from, to)
    setDragSetId(null)
  }
  const handleSetDragEnd = () => { setDragSetId(null); setDragSetOverId(null); setDragId(null) }

  const handleRename = (id: string) => {
    if (renameValue.trim()) {
      renameConversation(id, renameValue.trim())
    }
    setRenamingId(null)
    setRenameValue('')
  }

  // 会话集右键菜单：仿照会话右键的 viewport 定位逻辑（用事件坐标 + 翻转）
  const openSetMenu = (e: React.MouseEvent, setId: string) => {
    const MENU_W = 144  // w-36
    const MENU_H = 120  // estimated: 3 rows + separator + padding
    const GAP = 6
    const left = Math.max(8, Math.min(e.clientX, window.innerWidth - MENU_W - 8))
    const flip = window.innerHeight - e.clientY < MENU_H + GAP
    const top = flip
      ? Math.max(8, e.clientY - MENU_H - GAP)
      : e.clientY + GAP
    setSetMenuPos({ left, top })
    setSetMenuId(setId)
  }

  const handleSetRename = (id: string) => {
    if (renamingSetValue.trim()) {
      renameConversationSet(id, renamingSetValue.trim())
    }
    setRenamingSetId(null)
    setRenamingSetValue('')
  }

  const handleSetDelete = (s: ConversationSet) => {
    if (window.confirm(`删除会话集「${s.name}」？会话不会被删除。`)) {
      deleteConversationSet(s.id)
    }
    setSetMenuId(null)
  }

  const handleMoveToSet = (conversationId: string, setId: string | null) => {
    setConversationSet(conversationId, setId)
    setMoveTarget(null)
    setContextMenu(null)
  }

  const handleNewSetAndMove = (conversationId: string) => {
    const id = createConversationSet('新会话集')
    setConversationSet(conversationId, id)
    setMoveTarget(null)
    setContextMenu(null)
  }

  // 置顶/常规两组列表共享同一组 props 绑定
  const renderItem = (conv: Conversation) => (
    <ConversationItem
      key={conv.id}
      conv={conv}
      active={conv.id === activeConversationId}
      isStreaming={!!streamingConversations[conv.id]}
      isAwaiting={!!pendingQuestions[conv.id]}
      progress={conversationProgress[conv.id]}
      renaming={renamingId === conv.id}
      renameValue={renameValue}
      contextOpen={contextMenu === conv.id}
      dragOver={dragOverId === conv.id}
      isDragging={dragId === conv.id}
      moveTarget={moveTarget}
      conversationSets={conversationSets}
      onSelect={() => setActiveConversation(conv.id)}
      onRenameStart={() => { setRenamingId(conv.id); setRenameValue(conv.title) }}
      onRenameChange={setRenameValue}
      onRenameSubmit={() => handleRename(conv.id)}
      onRenameCancel={() => setRenamingId(null)}
      onPin={() => pinConversation(conv.id)}
      onDelete={() => deleteConversation(conv.id)}
      onContextToggle={() => { setMoveTarget(null); setContextMenu(contextMenu === conv.id ? null : conv.id) }}
      onMoveTargetChange={setMoveTarget}
      onMoveToSet={handleMoveToSet}
      onNewSetAndMove={handleNewSetAndMove}
      onDragStart={() => handleDragStart(conv.id)}
      onDragOver={(e: React.DragEvent) => handleDragOver(e, conv.id)}
      onDragLeave={() => handleDragLeave(conv.id)}
      onDrop={() => handleDrop(conv.id)}
      onDragEnd={handleDragEnd}
    />
  )

  return (
    <aside className="flex flex-col h-full w-full bg-app border-r">
      {/* Tab bar */}
      <div className="flex items-center h-10 border-b px-1">
        {TABS.map(tab => {
          const Icon = tab.icon
          const active = sidebarTab === tab.id
          return (
            <Tooltip key={tab.id} content={t(tab.labelKey)}>
              <button
                onClick={() => setSidebarTab(tab.id)}
                aria-label={t(tab.labelKey)}
                className={cn(
                  'flex-1 flex items-center justify-center h-8 rounded-md transition-colors',
                  active ? 'text-primary bg-elevated' : 'text-tertiary hover:text-secondary'
                )}
              >
                <Icon className="w-4 h-4" />
              </button>
            </Tooltip>
          )
        })}
      </div>

      {/* Content by tab */}
      <div className="flex-1 flex flex-col min-h-0">
        {sidebarTab === 'chats' && (
          <>
            {/* Search + New */}
            <div className="flex items-center gap-2 p-2 border-b">
              <div className="relative flex-1">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-tertiary" />
                <input
                  type="text"
                  placeholder={t('search.placeholder')}
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="w-full h-8 bg-elevated border border rounded-md pl-7 pr-2 text-xs text-primary placeholder:text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>
              <Tooltip content={t('sidebar.organize')}>
                <Button variant="ghost" size="xs" aria-label={t('sidebar.organize')} onClick={() => autoOrganize()}>
                  <Wand2 className="w-3.5 h-3.5" />
                </Button>
              </Tooltip>
              <DropdownMenu>
                <Tooltip content={t('sidebar.sortBy')}>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="xs" aria-label={t('sidebar.sortBy')}>
                      <ArrowUpDown className="w-3.5 h-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                </Tooltip>
                <DropdownMenuContent align="end" sideOffset={6}>
                  {([
                    ['manual', 'sidebar.sortManual'],
                    ['updated', 'sidebar.sortUpdated'],
                    ['created', 'sidebar.sortCreated'],
                    ['title', 'sidebar.sortTitle'],
                  ] as const).map(([mode, labelKey]) => (
                    <DropdownMenuItem key={mode} onClick={() => setChatSortMode(mode)}>
                      <div className="flex-1 text-xs">{t(labelKey)}</div>
                      {chatSortMode === mode && <Check className="w-3.5 h-3.5 text-brand-500" />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <DropdownMenu>
                <Tooltip content={t('sidebar.newChat') + ' (⌘N)' }>
                  <DropdownMenuTrigger asChild>
                    <Button variant="primary" size="xs" aria-label={t('sidebar.newChat')}>
                      <Plus className="w-4 h-4" />
                    </Button>
                  </DropdownMenuTrigger>
                </Tooltip>
                <DropdownMenuContent align="end" sideOffset={6}>
                  <DropdownMenuItem onClick={() => createConversation()}>
                    <MessageSquarePlus className="w-4 h-4 mr-2 text-tertiary" />
                    <div>
                      <div className="text-xs font-medium">常规任务</div>
                      <div className="text-[10px] text-tertiary mt-0.5">普通对话，一问一答</div>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => {
                    const id = createConversation()
                    setScheduleGuideFor(id)
                  }}>
                    <CalendarClock className="w-4 h-4 mr-2 text-brand-500" />
                    <div>
                      <div className="text-xs font-medium">定时任务</div>
                      <div className="text-[10px] text-tertiary mt-0.5">安排指定时间自动执行</div>
                    </div>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* Conversation list */}
            <ScrollArea className="flex-1">
              <div className="p-1">
                {pinned.length > 0 && (
                  <div className="mb-1">
                    <div className="px-2 py-1 text-[10px] font-semibold text-tertiary uppercase tracking-wider">{t('sidebar.pinned')}</div>
                    {pinned.map(renderItem)}
                  </div>
                )}
                {filteredSets.map(s => {
                  const members = sortedUnpinned.filter(c => c.setId === s.id)
                  if (members.length === 0) return null
                  // 搜索时自动展开全部会话集分组
                  const open = !searchQuery ? !collapsed[s.id] : true
                  return (
                    <div key={s.id} className="mb-1">
                      <div
                        className={cn(
                          'flex items-center gap-1 px-2 py-1 rounded-md cursor-pointer hover:bg-elevated group',
                          dragSetOverId === s.id && 'ring-1 ring-brand-500/50 bg-brand-500/10',
                          dragSetId === s.id && 'opacity-50',
                        )}
                        onClick={() => setCollapsed(prev => ({ ...prev, [s.id]: !prev[s.id] }))}
                        onContextMenu={(e) => { e.preventDefault(); openSetMenu(e, s.id) }}
                        draggable
                        onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; handleSetDragStart(s.id) }}
                        onDragOver={(e) => handleSetDragOver(e, s.id)}
                        onDragLeave={() => handleSetDragLeave(s.id)}
                        onDrop={() => handleSetDrop(s.id)}
                        onDragEnd={handleSetDragEnd}
                      >
                        <ChevronRight className={cn('w-3 h-3 text-tertiary transition-transform', open && 'rotate-90')} />
                        <FolderOpen className="w-3 h-3 text-brand-500/70 shrink-0" />
                        {renamingSetId === s.id ? (
                          <input
                            autoFocus
                            value={renamingSetValue}
                            onChange={e => setRenamingSetValue(e.target.value)}
                            onBlur={() => handleSetRename(s.id)}
                            onKeyDown={e => { if (e.key === 'Enter') handleSetRename(s.id); if (e.key === 'Escape') { setRenamingSetId(null); setRenamingSetValue('') } }}
                            onClick={e => e.stopPropagation()}
                            onContextMenu={e => e.stopPropagation()}
                            className="flex-1 min-w-0 bg-input border border-brand-500/60 rounded px-1.5 py-0.5 text-xs text-primary outline-none focus:border-brand-500"
                          />
                        ) : (
                          <span className="flex-1 min-w-0 truncate text-xs text-secondary" title={s.name}>{s.name}</span>
                        )}
                        <span className="text-[10px] text-tertiary tabular-nums shrink-0 whitespace-nowrap">{members.length}</span>
                      </div>
                      {open && <div className="ml-2 border-l border-default/60 pl-1">{members.map(renderItem)}</div>}
                    </div>
                  )
                })}
                {unpinned.length > 0 && (
                  <div>
                    <div className="px-2 py-1 text-[10px] font-semibold text-tertiary uppercase tracking-wider">{t('sidebar.ungrouped')}</div>
                    {sortedUnpinned.filter(c => !c.setId).map(renderItem)}
                  </div>
                )}
                {filtered.length === 0 && (
                  <div className="p-4 text-center text-xs text-tertiary">
                    {searchQuery ? t('search.noResults') : t('sidebar.noConversations')}
                  </div>
                )}
              </div>
            </ScrollArea>

            {/* 会话集右键菜单 — portal 到 body，viewport 定位防滚动区裁剪 */}
            {setMenuId && setMenuPos && (() => {
              const s = conversationSets.find(x => x.id === setMenuId)
              if (!s) return null
              return createPortal(
                <div
                  className="fixed z-[100] w-36 border border glass-context-menu rounded-lg py-1 animate-scale-in"
                  style={{
                    left: setMenuPos.left,
                    top: setMenuPos.top,
                    backgroundColor: 'var(--popover-bg)',
                    backdropFilter: 'blur(var(--popover-blur))',
                    WebkitBackdropFilter: 'blur(var(--popover-blur))',
                  }}
                  onClick={e => e.stopPropagation()}
                >
                  <button onClick={() => { setRenamingSetId(s.id); setRenamingSetValue(s.name); setSetMenuId(null) }} aria-label={t('sidebar.rename')} className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-hover"><Edit3 className="w-3 h-3" /> {t('sidebar.rename')}</button>
                  <button onClick={() => { exportChats({ setId: s.id }); setSetMenuId(null) }} aria-label={t('sidebar.exportSet')} className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-hover"><Share2 className="w-3 h-3" /> {t('sidebar.exportSet')}</button>
                  <div className="border-t my-1" />
                  <button onClick={() => handleSetDelete(s)} aria-label={t('sidebar.delete')} className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-error hover:bg-error/10"><Trash2 className="w-3 h-3" /> {t('sidebar.delete')}</button>
                </div>,
                document.body,
              )
            })()}
          </>
        )}

        {sidebarTab === 'history' && <HistoryView />}

        {sidebarTab === 'files' && <FileBrowser />}
        {sidebarTab === 'worktrees' && <WorktreePanel />}
        {sidebarTab === 'agents' && <AgentsPanel />}
        {sidebarTab === 'skills' && <SkillsPanel />}
      </div>
    </aside>
  )
}

// --- Conversation Item Sub-component ---

interface ConvItemProps {
  conv: { id: string; title: string; updatedAt: number; pinned?: boolean; model: string; messages: { id: string }[] }
  active: boolean
  isStreaming: boolean
  isAwaiting: boolean
  progress?: ConversationProgress
  renaming: boolean
  renameValue: string
  contextOpen: boolean
  dragOver: boolean
  isDragging: boolean
  onSelect: () => void
  onRenameStart: () => void
  onRenameChange: (v: string) => void
  onRenameSubmit: () => void
  onRenameCancel: () => void
  onPin: () => void
  onDelete: () => void
  onContextToggle: () => void
  moveTarget: string | null
  conversationSets: ConversationSet[]
  onMoveTargetChange: (v: string | null) => void
  onMoveToSet: (conversationId: string, setId: string | null) => void
  onNewSetAndMove: (conversationId: string) => void
  onDragStart: () => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: () => void
  onDrop: () => void
  onDragEnd: () => void
}

const ConversationItem = memo(function ConversationItem({
  conv, active, isStreaming, isAwaiting, progress, renaming, renameValue,
  contextOpen, dragOver, isDragging, onSelect, onRenameStart, onRenameChange,
  onRenameSubmit, onRenameCancel, onPin, onDelete,
  onContextToggle, moveTarget, conversationSets,
  onMoveTargetChange, onMoveToSet, onNewSetAndMove,
  onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd,
}: ConvItemProps) {
  const { t } = useTranslation()
  const rowRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null)

  // 导出单个会话为 zip（复用模块级 exportChats，dev 无 preload 时静默返回）
  const onExportConversation = (id: string) => exportChats({ conversationIds: [id] })

  // Position the context menu in viewport coordinates when it opens,
  // flipping upward near the bottom edge so it is never clipped by the
  // sidebar's scroll area.
  useLayoutEffect(() => {
    if (!contextOpen) {
      setMenuPos(null)
      return
    }
    const el = rowRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const MENU_W = 144  // w-36
    const MENU_H = 220  // estimated: 6 rows + separator + padding
    const GAP = 6
    const left = Math.max(8, Math.min(rect.right - MENU_W, window.innerWidth - MENU_W - 8))
    const flip = window.innerHeight - rect.bottom < MENU_H + GAP
    const top = flip
      ? Math.max(8, rect.top - MENU_H - GAP)
      : rect.bottom + GAP
    setMenuPos({ left, top })
  }, [contextOpen])

  return (
    <div className="relative" ref={rowRef} data-conv-id={conv.id}>
      <div
        className={cn(
          'group flex items-center gap-1.5 px-2 py-1.5 rounded-md cursor-pointer transition-colors',
          active ? 'bg-brand-500/15 text-primary' : 'text-tertiary hover:bg-elevated hover:text-primary hover:[box-shadow:inset_2px_0_0_var(--accent-red)]',
          dragOver && 'ring-1 ring-brand-500/50 bg-brand-500/10',
          isDragging && 'opacity-50',
        )}
        onClick={onSelect}
        onContextMenu={(e) => { e.preventDefault(); onContextToggle() }}
        draggable
        onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart() }}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onDragEnd={onDragEnd}
      >
        {renaming ? (
          <input
            autoFocus
            value={renameValue}
            onChange={e => onRenameChange(e.target.value)}
            onBlur={onRenameSubmit}
            onKeyDown={e => { if (e.key === 'Enter') onRenameSubmit(); if (e.key === 'Escape') onRenameCancel() }}
            onClick={e => e.stopPropagation()}
            onContextMenu={e => e.stopPropagation()}
            className="flex-1 min-w-0 bg-input border border-brand-500/60 rounded px-1.5 py-0.5 text-xs text-primary outline-none focus:border-brand-500"
          />
        ) : (
          <>
            {conv.pinned && <Pin className="w-3 h-3 text-warning/70 shrink-0" />}
            {/* 执行中：pulse 呼吸反馈（2026-08-17 恢复核心反馈动效）；旧 animate-spin 已移除（1s 旋转逐帧全量重绘 ~48% renderer CPU） */}
            {isStreaming && <span className="w-1.5 h-1.5 rounded-full bg-brand-500 shrink-0 animate-pulse" />}
            {isAwaiting && (
              <span className="w-1.5 h-1.5 rounded-full bg-warning shrink-0 animate-pulse" />
            )}
            <span className="flex-1 min-w-0 truncate text-xs" title={conv.title}>{conv.title}</span>
            <div className="flex items-center gap-1 shrink-0 whitespace-nowrap">
              {isAwaiting ? (
                <span className="text-[10px] text-warning/90 font-medium">待回复</span>
              ) : isStreaming ? (
                <span className="text-[10px] text-brand-500/70">执行中</span>
              ) : (
                <span className="text-[10px] text-tertiary tabular-nums">{formatDate(conv.updatedAt, true)}</span>
              )}
            </div>
          </>
        )}
      </div>

      {/* 背景进度条：执行中显示（待回复时冻结当前宽度），非执行中隐藏 */}
      {(isStreaming || isAwaiting) && (
        <div
          className={cn('conv-progress', isAwaiting && 'conv-progress-paused')}
          title={progress && progress.total > 0
            ? progress.inProgress
              ? `执行中 ${progress.names[progress.inProgress - 1] || progress.names[0] || '任务'} ${progress.inProgress}/${progress.total}`
              : '计划中'
            : isStreaming ? '执行中' : undefined}
        >
          {progress && progress.total > 0 ? (
            <div
              className="conv-progress-fill"
              style={{ width: `${Math.min(100, Math.round((progress.current / progress.total) * 100))}%` }}
            />
          ) : (
            <div className="conv-progress-flow" />
          )}
        </div>
      )}

      {/* Context menu — portaled to <body> with viewport-clamped position
          so it is never clipped by the sidebar's scroll area */}
      {contextOpen && menuPos && createPortal(
        <>
          <div
            className="fixed z-[100] w-36 border border glass-context-menu rounded-lg py-1 animate-scale-in"
            style={{
              left: menuPos.left,
              top: menuPos.top,
              backgroundColor: 'var(--popover-bg)',
              backdropFilter: 'blur(var(--popover-blur))',
              WebkitBackdropFilter: 'blur(var(--popover-blur))',
            }}
            onClick={e => e.stopPropagation()}
          >
            <button onClick={onRenameStart} aria-label={t('sidebar.rename')} className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-hover"><Edit3 className="w-3 h-3" /> {t('sidebar.rename')}</button>
            <button onClick={onPin} aria-label={conv.pinned ? t('sidebar.unpin') : t('sidebar.pin')} className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-hover"><Pin className="w-3 h-3" /> {conv.pinned ? t('sidebar.unpin') : t('sidebar.pin')}</button>
            <button onClick={() => onMoveTargetChange(conv.id)} aria-label={t('sidebar.moveToSet')} className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-hover"><FolderPlus className="w-3 h-3" /> {t('sidebar.moveToSet')}</button>
            <button onClick={() => onExportConversation(conv.id)} aria-label={t('sidebar.exportShare')} className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-hover"><Share2 className="w-3 h-3" /> {t('sidebar.exportShare')}</button>
            <div className="border-t my-1" />
            <button onClick={onDelete} aria-label={t('sidebar.delete')} className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-error hover:bg-error/10"><Trash2 className="w-3 h-3" /> {t('sidebar.delete')}</button>
          </div>
          {/* 移动到会话集子菜单 — 与右键菜单同级渲染，偏移 40px；会话集多时滚动 */}
          {moveTarget === conv.id && (
            <div
              className="fixed z-[100] w-44 border border glass-context-menu rounded-lg py-1 animate-scale-in max-h-72 overflow-y-auto"
              style={{
                left: menuPos.left,
                top: (menuPos.top || 0) + 40,
                backgroundColor: 'var(--popover-bg)',
                backdropFilter: 'blur(var(--popover-blur))',
                WebkitBackdropFilter: 'blur(var(--popover-blur))',
              }}
              onClick={e => e.stopPropagation()}
            >
              <div className="overflow-y-auto" style={{ maxHeight: '12rem' }}>
                {conversationSets.map(s => (
                  <button key={s.id} onClick={() => onMoveToSet(conv.id, s.id)} className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-hover"><FolderOpen className="w-3 h-3" /> {s.name}</button>
                ))}
                <button onClick={() => onMoveToSet(conv.id, null)} className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-hover"><span className="w-3 h-3" /> {t('sidebar.ungrouped')}</button>
              </div>
              <div className="border-t my-1" />
              <button onClick={() => onNewSetAndMove(conv.id)} className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-hover"><Plus className="w-3 h-3" /> {t('sidebar.newSet')}</button>
            </div>
          )}
        </>,
        document.body,
      )}
    </div>
  )
}, (prev, next) =>
  // 只比较展示字段：conv 的消息内容变化（流式 token）不影响列表项的可见输出，
  // 避免会话列表在流式输出时整列重渲染。on* 回调为内联箭头函数（引用每次变化），
  // 不参与比较——它们闭包的是稳定的 store action 与本地状态值。
  prev.conv?.title === next.conv?.title &&
  prev.conv?.pinned === next.conv?.pinned &&
  prev.active === next.active &&
  prev.isStreaming === next.isStreaming &&
  prev.isAwaiting === next.isAwaiting &&
  prev.progress === next.progress &&
  prev.renaming === next.renaming &&
  prev.renameValue === next.renameValue &&
  prev.contextOpen === next.contextOpen &&
  prev.moveTarget === next.moveTarget &&
  prev.dragOver === next.dragOver &&
  prev.isDragging === next.isDragging,
)
