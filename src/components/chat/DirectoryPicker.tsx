// src/components/chat/DirectoryPicker.tsx —— 工作目录选择器（资源管理器形态）
//
// spec：docs/superpowers/specs/2026-09-15-workdir-picker-design.md
//
// 为什么按资源管理器的样子改：选择器出现在 4 处容器（ChatWindow / RightStatusRail /
// TaskCwdBar / TaskStartCard），用户的第一次上手路径各不相同；照搬 Explorer 的三件套
// （左导航窗格、面包屑地址栏、前进后退）比自创交互省学习成本。
//
// 三条纪律：
//   ① 纯逻辑全部来自 `@/lib/dirPicker`：面包屑切分、折叠、历史栈、快捷入口归一、
//      地址栏清洗、向下判定都在那边被 `node --test` 覆盖。本文件是 `.tsx`，进不了
//      `node --test` —— 在这里再实现一遍就是"两份实现、一份没测试"。
//   ② 跳转失败不许把当前目录弄丢：手输路径是出错率最高的入口（D5/A4）。
//      取数只有 `load()` 一个入口，它**只在成功时**改 entries/parent/loaded，
//      失败只写错误条；因此"当前目录不变"是结构上成立的，不靠调用方自觉。
//   ③ 快捷入口不在渲染层拼路径：桌面/文档在哪只有 bridge 知道（homedir + 平台差异），
//      渲染层拼 `C:/Users/xxx/Documents` 在非 C 盘 / 非英文用户名 / Mac / Linux 上必错（D1）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentType } from 'react'
import {
  AlertTriangle, ArrowLeft, ArrowRight, ArrowUp, Check, ChevronRight, Download, File,
  FileText, Film, Folder, FolderOpen, HardDrive, Home, Image, Music, Monitor, PanelLeft,
  Pencil, RefreshCw, X,
} from 'lucide-react'
import { Button, ScrollArea } from '@/components/ui'
import { cn, formatSize } from '@/lib/utils'
import { getBridgeUrl, getDefaultHome } from '@/lib/config'
import {
  breadcrumbSegments, canGoBack, canGoForward, cleanPathInput, currentPath, foldBreadcrumb,
  goBack, goForward, initHistory, isSameOrUnder, normalizeFolders, normalizePath, pushHistory,
  type HistoryState, type QuickFolder,
} from '@/lib/dirPicker'

interface DirEntry {
  name: string
  path: string
  type: 'directory' | 'file'
  size?: number
}

interface DriveEntry {
  name: string
  path: string
}

/** `/list-dir` 的返回形状（bridge.mjs）：注意**没有** dirCount/fileCount，计数得自己数 */
interface DirResult {
  path: string
  parent: string | null
  entries: DirEntry[]
  truncated?: boolean
}

interface Props {
  value: string
  onChange: (path: string) => void
  onClose: () => void
}

/** 快捷入口图标：按 kind 取，认不出的 kind 兜底成文件夹（bridge 日后加项也不会渲染成空白行） */
const KIND_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  home: Home,
  desktop: Monitor,
  documents: FileText,
  downloads: Download,
  pictures: Image,
  music: Music,
  videos: Film,
}

/** 弹层窄于这个宽度就自动收起导航窗格：几百 px 的容器里窗格会把列表挤得没法看（D7） */
const NAV_AUTO_COLLAPSE_WIDTH = 560

/** 与 bridge 的 MAX_LIST_ENTRIES 对齐，只用于截断文案（限制在服务端，这里不重复设限） */
const LIST_LIMIT_HINT = 2000

/** 双击会先派发两次 click 再派发 dblclick：不去重就会对同一路径并发两次读目录 */
const DOUBLE_CLICK_MS = 400

/** 导航窗格里的盘符：不信任 bridge 形状（字段缺/类型错都不该渲染成可点项） */
const isDriveEntry = (x: unknown): x is DriveEntry => {
  if (!x || typeof x !== 'object') return false
  const d = x as { name?: unknown; path?: unknown }
  return typeof d.name === 'string' && !!d.name && typeof d.path === 'string' && !!d.path
}

/** 导航窗格的一行：快捷入口与盘符共用（样式/高亮只有一份，改起来不会漏） */
function NavRow({ icon: Icon, label, path, active, onClick }: {
  icon: ComponentType<{ className?: string }>
  label: string
  path: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={path}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
        active ? 'bg-brand-500/15 text-brand-500' : 'text-secondary hover:bg-hover'
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  )
}

export function DirectoryPicker({ value, onChange, onClose }: Props) {
  // 起手目录：传入空串或旧版的伪路径 'This PC' 时落到用户主目录，而不是让 /list-dir
  // 拿空路径去猜 —— bridge 会把 '' 解析成**它自己的工作目录**，那是用户没输入过的地方。
  const [initialPath] = useState(() => normalizePath(value === 'This PC' ? '' : value) || getDefaultHome())
  const [history, setHistory] = useState<HistoryState>(() => initHistory(initialPath))
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [parent, setParent] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  // 是否成功读到过列表：空态文案（"此文件夹为空"）只在 true 时才敢说 ——
  // 读失败还说"空"，用户会以为目录里真没东西（失败态与空态必须分开）
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [folders, setFolders] = useState<QuickFolder[]>([])
  const [drives, setDrives] = useState<DriveEntry[]>([])
  const [navPicked, setNavPicked] = useState(false)
  const [foldersFailed, setFoldersFailed] = useState(false)
  const [drivesFailed, setDrivesFailed] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [navOverride, setNavOverride] = useState<boolean | null>(null)
  const [narrow, setNarrow] = useState(false)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const lastEnter = useRef<{ path: string; at: number }>({ path: '', at: 0 })
  const curRef = useRef('')

  const cur = currentPath(history)
  curRef.current = cur
  const navCollapsed = navOverride ?? narrow

  /**
   * 唯一的取数入口。返回"服务端确认过的路径"（bridge 会 resolve，可能与入参不同），
   * 失败返回 null 且**不碰** entries/parent/loaded —— 于是"跳转失败 ⇒ 当前目录不变"
   * 是结构上的事实，而不依赖每个调用点自己记得回滚（A4）。
   */
  const load = useCallback(async (path: string): Promise<string | null> => {
    const target = normalizePath(path)
    if (!target) return null
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${getBridgeUrl()}/list-dir?path=${encodeURIComponent(target)}`)
      if (!res.ok) {
        // 路径不存在 / 无权限时 bridge 用顶层 catch 回 400 {error}（readdir 抛错），
        // 据此判失败即可：渲染层再 stat 一次只会多一个"两次探测之间目录变了"的竞态
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error || `无法读取该文件夹（HTTP ${res.status}）`)
      }
      const data = (await res.json()) as DirResult
      setEntries(Array.isArray(data.entries) ? data.entries : [])
      setParent(typeof data.parent === 'string' ? data.parent : null)
      setTruncated(!!data.truncated)
      setLoaded(true)
      return normalizePath(data.path) || target
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  /** 跳转：成功才记历史。历史里必须是服务端确认过的路径，否则前后退会跳到别名路径 */
  const navigate = useCallback(async (path: string): Promise<boolean> => {
    const resolved = await load(path)
    if (!resolved) return false
    setHistory(h => pushHistory(h, resolved))
    return true
  }, [load])

  /** 取快捷入口与盘符：两个端点互相独立，一项失败不清空另一项（旧 bridge 无 /known-folders） */
  const loadNav = useCallback(async () => {
    try {
      const res = await fetch(`${getBridgeUrl()}/known-folders`)
      if (res.ok) {
        const list = normalizeFolders(await res.json())
        setFolders(list)
        setFoldersFailed(false)
        // 起手目录为空时的兜底：浏览器 dev 里没有 preload，getDefaultHome() 会返回 ''，
        // 若就此停住，用户打开选择器只看到一片"尚未读到目录内容"（没有任何起手点）。
        // 用 bridge 给的"主目录"落位 —— 它的答案比渲染层猜的准（D1）。
        const home = list.find(f => f.kind === 'home') ?? list[0]
        if (!curRef.current && home) void navigate(home.path)
      } else setFoldersFailed(true)
    } catch {
      setFoldersFailed(true)
    }
    try {
      const res = await fetch(`${getBridgeUrl()}/drives`)
      if (res.ok) {
        const body = (await res.json()) as { drives?: unknown }
        setDrives(Array.isArray(body?.drives) ? body.drives.filter(isDriveEntry) : [])
        setDrivesFailed(false)
      } else setDrivesFailed(true)
    } catch {
      setDrivesFailed(true)
    }
    setNavPicked(true)
  }, [navigate])

  useEffect(() => { void load(initialPath) }, [load, initialPath])
  useEffect(() => { void loadNav() }, [loadNav])

  // 外部 value 变化（内核侧 cwd 更新）时对齐视图。依赖里刻意**不含** history：
  // 否则用户每点一个目录都会被这个效果弹回 value，表现为"点了没反应"。
  useEffect(() => {
    const target = normalizePath(value === 'This PC' ? '' : value)
    if (!target || target === curRef.current) return
    void navigate(target)
  }, [value, navigate])

  // 盯**弹层自己**的宽度而不是 window.innerWidth：容器宽度才是决定量（D7）。
  // 无 ResizeObserver（老 WebView）时退化为"手动折叠也能用"，不报错。
  useEffect(() => {
    const el = dialogRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(list => {
      const w = list[0]?.contentRect.width ?? 0
      if (w > 0) setNarrow(w < NAV_AUTO_COLLAPSE_WIDTH)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const upTarget = parent && parent !== cur ? parent : null

  const stepHistory = useCallback(async (dir: 'back' | 'forward') => {
    const next = dir === 'back' ? goBack(history) : goForward(history)
    if (next === history) return               // 已在边界：不发请求、不动状态
    // 成功才动历史：目标是历史里记过的路径，理论上不会失败，但目录可能刚被删掉——
    // 那种情况下"位置跳过去、列表还是旧的"比报错更让人困惑
    if (await load(currentPath(next))) setHistory(next)
  }, [history, load])

  const handleEnter = useCallback((path: string) => {
    const now = Date.now()
    if (lastEnter.current.path === path && now - lastEnter.current.at < DOUBLE_CLICK_MS) return
    lastEnter.current = { path, at: now }
    void navigate(path)
  }, [navigate])

  const refreshAll = useCallback(() => {
    void load(cur)      // 当前目录
    void loadNav()      // U 盘/映射盘刚插拔，盘符也一起重取
  }, [cur, load, loadNav])

  const startEdit = () => {
    setDraft(cur)
    setEditing(true)
    // 光标全选：点地址栏几乎总是想整条替换（粘贴新路径），不选中还得先 Ctrl+A
    requestAnimationFrame(() => inputRef.current?.select())
  }

  const commitDraft = async () => {
    const cleaned = cleanPathInput(draft)
    if (!cleaned) {
      // 空输入直接判错、不发请求：bridge 会把空路径 resolve 成它自己的工作目录
      setError('请输入要跳转的路径')
      return
    }
    if (await navigate(cleaned)) {
      setEditing(false)
      setDraft('')
    }
    // 失败时故意留在编辑态：错误条在下方说明原因，输入内容还在，改个字符就能重试
  }

  const crumbs = useMemo(() => foldBreadcrumb(breadcrumbSegments(cur)), [cur])
  const activeNav = useMemo(() => {
    // 只高亮最深的那个入口：cur 落在"文档"下时同样落在"主目录"与 "C:/" 之下，
    // 全亮会让用户分不清自己在哪（Explorer 也只亮选中的那个节点）
    return [...folders.map(f => f.path), ...drives.map(d => d.path)]
      .filter(p => isSameOrUnder(cur, p))
      .sort((a, b) => b.length - a.length)[0] ?? ''
  }, [folders, drives, cur])

  const folderCount = useMemo(() => entries.filter(e => e.type !== 'file').length, [entries])
  const fileCount = entries.length - folderCount
  const navEmptyText = (failed: boolean, none: string) =>
    !navPicked ? '加载中…' : failed ? '读取失败' : none

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
        ref={dialogRef}
        className="w-[760px] max-w-[94vw] cut cut-modal animate-scale-in"
        style={{ filter: 'drop-shadow(var(--modal-drop))' }}
        onClick={e => e.stopPropagation()}
      >
        <div
          className="ci flex flex-col"
          style={{
            background: 'var(--modal-bg)',
            backdropFilter: 'blur(var(--popover-blur))',
            WebkitBackdropFilter: 'blur(var(--popover-blur))',
          }}
        >
          {/* 标题栏：把"单击/双击分别做什么"写在明面上 —— 上手难度主要来自这里 */}
          <div className="flex items-center gap-2 border-b px-4 py-3">
            <FolderOpen className="h-5 w-5 shrink-0 text-warning/75" />
            <h3 className="shrink-0 text-sm font-semibold text-primary">选择工作目录</h3>
            <span className="min-w-0 truncate text-[10px] text-tertiary">
              单击进入文件夹，双击直接选定并关闭
            </span>
            <button
              onClick={onClose}
              aria-label="关闭"
              className="ml-auto shrink-0 text-tertiary hover:text-primary"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* 主体：左导航窗格 + 右（工具条 / 错误条 / 列表） */}
          <div className="flex min-h-0">
            {!navCollapsed && (
              <div className="flex w-40 shrink-0 flex-col border-r">
                <ScrollArea className="flex-1">
                  <div className="py-1">
                    <div className="px-3 py-1 text-[10px] font-medium text-tertiary">快捷入口</div>
                    {folders.length === 0 ? (
                      <div className="px-3 py-1 text-[11px] text-tertiary">
                        {navEmptyText(foldersFailed, '暂无快捷入口')}
                      </div>
                    ) : folders.map(f => (
                      <NavRow
                        key={f.path}
                        icon={KIND_ICONS[f.kind] ?? Folder}
                        label={f.name}
                        path={f.path}
                        active={f.path === activeNav}
                        onClick={() => void navigate(f.path)}
                      />
                    ))}
                    <div className="mt-2 border-t px-3 py-1 text-[10px] font-medium text-tertiary">
                      此电脑
                    </div>
                    {drives.length === 0 ? (
                      <div className="px-3 py-1 text-[11px] text-tertiary">
                        {navEmptyText(drivesFailed, '未发现盘符')}
                      </div>
                    ) : drives.map(d => (
                      <NavRow
                        key={d.path}
                        icon={HardDrive}
                        label={d.name}
                        path={d.path}
                        active={d.path === activeNav}
                        onClick={() => void navigate(d.path)}
                      />
                    ))}
                  </div>
                </ScrollArea>
              </div>
            )}

            <div className="flex min-w-0 flex-1 flex-col">
              {/* 工具条：← → ↑ [地址栏] 主目录 刷新 窗格开关 */}
              <div className="flex items-center gap-1 border-b bg-toolbar px-2 py-1.5">
                <Button
                  variant="ghost" size="xs" title="后退" aria-label="后退"
                  onClick={() => void stepHistory('back')}
                  disabled={!canGoBack(history)}
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost" size="xs" title="前进" aria-label="前进"
                  onClick={() => void stepHistory('forward')}
                  disabled={!canGoForward(history)}
                >
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost" size="xs" title="上一级" aria-label="上一级"
                  onClick={() => upTarget && void navigate(upTarget)}
                  disabled={!upTarget}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>

                {/* 地址栏：面包屑 ⇄ 可编辑输入框 */}
                {editing ? (
                  <input
                    ref={inputRef}
                    autoFocus
                    spellCheck={false}
                    value={draft}
                    onChange={e => { setDraft(e.target.value); if (error) setError('') }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') void commitDraft()
                      else if (e.key === 'Escape') setEditing(false)
                    }}
                    onBlur={() => setEditing(false)}
                    placeholder="输入或粘贴路径后回车"
                    className="h-7 min-w-0 flex-1 rounded border bg-input px-2 font-mono text-xs text-primary placeholder:text-tertiary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                  />
                ) : (
                  <div
                    onClick={startEdit}
                    title="点击输入路径"
                    className="group flex h-7 min-w-0 flex-1 cursor-text items-center gap-0.5 overflow-hidden rounded border border-transparent px-1 font-mono text-xs text-secondary hover:bg-hover"
                  >
                    {crumbs.length === 0 ? (
                      <span className="truncate px-1 text-tertiary">未选择目录</span>
                    ) : crumbs.map((c, i) => {
                      const last = i === crumbs.length - 1
                      // 折叠占位段（path 为空）不可点：它代表"这里被省略了若干级"，
                      // 点它没有确定的目标（要跳到哪一级？）——宁可只做视觉提示
                      if (!c.path) {
                        return <span key={`fold-${i}`} className="shrink-0 px-1 text-tertiary">…</span>
                      }
                      return (
                        <span key={c.path} className="flex min-w-0 items-center gap-0.5">
                          {i > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-tertiary" />}
                          <button
                            type="button"
                            onClick={e => { e.stopPropagation(); void navigate(c.path) }}
                            onDoubleClick={e => e.stopPropagation()}
                            title={c.path}
                            className={cn(
                              'max-w-[160px] truncate rounded px-1 hover:bg-active hover:text-primary',
                              last && 'font-medium text-primary'
                            )}
                          >
                            {c.label}
                          </button>
                        </span>
                      )
                    })}
                    <Pencil className="ml-auto h-3 w-3 shrink-0 text-tertiary opacity-0 group-hover:opacity-100" />
                  </div>
                )}

                <Button
                  variant="ghost" size="xs" title="主目录" aria-label="主目录"
                  onClick={() => void navigate(getDefaultHome())}
                >
                  <Home className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="xs" title="刷新" aria-label="刷新" onClick={refreshAll}>
                  <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
                </Button>
                <Button
                  variant="ghost" size="xs"
                  title={navCollapsed ? '显示导航窗格' : '隐藏导航窗格'}
                  aria-label={navCollapsed ? '显示导航窗格' : '隐藏导航窗格'}
                  aria-pressed={!navCollapsed}
                  onClick={() => setNavOverride(!navCollapsed)}
                >
                  <PanelLeft className="h-3.5 w-3.5" />
                </Button>
              </div>

              {/* 错误条：不替换列表 —— 跳转失败时"原来的目录还在那儿"本身就是给用户的交代（A4） */}
              {error && (
                <div className="flex items-start gap-1.5 border-b bg-error/10 px-3 py-1.5 text-[11px] text-error">
                  <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 break-all">
                    {error}
                    {loaded && <span className="text-tertiary">（当前目录未改变）</span>}
                  </span>
                  <button
                    onClick={() => setError('')}
                    aria-label="关闭错误提示"
                    className="shrink-0 text-tertiary hover:text-primary"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              )}

              {/* 目录列表 */}
              <ScrollArea className="h-[320px]">
                {loading ? (
                  <div className="flex h-full items-center justify-center text-xs text-tertiary">
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />加载中…
                  </div>
                ) : !loaded ? (
                  <div className="flex h-full items-center justify-center px-4 text-center text-xs text-tertiary">
                    尚未读到目录内容
                  </div>
                ) : entries.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-xs text-tertiary">
                    此文件夹为空
                  </div>
                ) : (
                  <div className="py-1">
                    {entries.map(entry => {
                      const active = entry.path === value
                      const isDir = entry.type !== 'file'
                      return (
                        <button
                          key={entry.path}
                          onClick={() => { if (isDir) handleEnter(entry.path) }}
                          onDoubleClick={() => {
                            if (isDir) {
                              handleEnter(entry.path)
                              onChange(entry.path)
                              onClose()
                            }
                          }}
                          title={isDir ? '单击进入，双击选定' : entry.path}
                          className={cn(
                            'flex w-full items-center gap-2.5 px-4 py-1.5 text-left text-sm transition-colors',
                            isDir ? 'cursor-pointer' : 'cursor-default',
                            active
                              ? 'bg-brand-500/15 text-brand-500'
                              : isDir ? 'text-secondary hover:bg-hover' : 'text-tertiary'
                          )}
                        >
                          {isDir ? (
                            <Folder className="h-4 w-4 shrink-0 text-warning/75" />
                          ) : (
                            <File className="h-4 w-4 shrink-0 text-tertiary" />
                          )}
                          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                          {entry.size !== undefined && entry.size > 0 && (
                            <span className="shrink-0 text-[10px] text-tertiary">{formatSize(entry.size)}</span>
                          )}
                          {isDir && !active && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-tertiary" />}
                          {active && (
                            <span title="当前工作目录" className="shrink-0">
                              <Check className="h-3.5 w-3.5 text-brand-500" />
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                )}
              </ScrollArea>
            </div>
          </div>

          {/* 页脚：计数由前端数（/list-dir 不回 dirCount/fileCount，旧代码渲染出的是 "undefined"）；
              bridge 每类各 2000 条上限，所以文案说"已显示"而不是"共 N 个" */}
          <div className="flex items-center justify-between gap-3 border-t bg-toolbar px-4 py-2.5">
            <span className="min-w-0 truncate text-[10px] text-tertiary">
              已显示 {folderCount} 个文件夹 · {fileCount} 个文件
              {truncated && (
                <span className="ml-2 text-warning/80">条目过多，仅显示前 {LIST_LIMIT_HINT} 项</span>
              )}
            </span>
            <div className="flex shrink-0 gap-2">
              <Button variant="ghost" size="xs" onClick={onClose}>取消</Button>
              <Button
                variant="primary" size="xs"
                disabled={!cur}
                onClick={() => { onChange(cur); onClose() }}
                leftIcon={<Check className="w-3.5 h-3.5" />}
              >
                选择此文件夹
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
