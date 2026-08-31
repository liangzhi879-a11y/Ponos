import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, FolderOpen, MessageSquare, Sparkles, Zap } from 'lucide-react'
import { useChatStore } from '@/stores/chatStore'
import { useTokenStatsStore, toDayKey } from '@/stores/tokenStatsStore'
import { useViewStore } from '@/stores/viewStore'
import { useUIStore } from '@/stores/uiStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { fetchSkills } from '@/lib/skills'
import { DEFAULT_AGENTS } from '@/lib/agents'
import { getBridgeUrl, getDefaultHome } from '@/lib/config'
import { useTranslation } from '@/i18n/useTranslation'
import { cn } from '@/lib/utils'

/**
 * K/M 格式化（与 StatusBar 相同逻辑；Task 12 计划提取公共工具，YAGNI 暂不提取）。
 */
function formatTokens(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1000000) return `${(n / 1000).toFixed(0)}K`
  return `${(n / 1000000).toFixed(1)}M`
}

const DAY_MS = 24 * 60 * 60 * 1000

/** 取 byDay 中最近 n 天（含今天）的每日总量，返回从旧到新的数组。 */
function lastNDays(byDay: Record<string, { input: number; output: number }>, n: number): number[] {
  const out: number[] = []
  const today = Date.now()
  for (let i = n - 1; i >= 0; i--) {
    const key = toDayKey(today - i * DAY_MS)
    const d = byDay[key]
    out.push(d ? d.input + d.output : 0)
  }
  return out
}

interface CockpitLine {
  id: string
  from: { x: number; y: number }
  to: { x: number; y: number }
}

/** 卡片标识：用于 ref 测量与 SVG 连线目标 */
type CardId = 'sessions' | 'tokens' | 'files' | 'skills'

export function CockpitView() {
  const { t } = useTranslation()
  const goWorkspace = useViewStore(s => s.goWorkspace)

  const conversations = useChatStore(s => s.conversations)
  const backgroundTasks = useChatStore(s => s.backgroundTasks)
  const lastCwd = useChatStore(s => s.lastCwd)

  const stats = useTokenStatsStore(s => s.stats)

  const skillRoot = useSettingsStore(s => s.settings.skillRoot)

  // --- 会话 · 任务 卡片数据 ---
  const totalSessions = conversations.length
  const todayKey = toDayKey(Date.now())
  const todayUpdated = useMemo(
    () => conversations.filter(c => toDayKey(c.updatedAt) === todayKey).length,
    [conversations, todayKey],
  )
  const runningTasks = backgroundTasks.filter(t => t.status === 'running').length
  const completionRate =
    backgroundTasks.length > 0
      ? Math.round(((backgroundTasks.length - runningTasks) / backgroundTasks.length) * 100)
      : 100

  // --- Token 用量 卡片数据 ---
  const tokenTotal = stats.totalInput + stats.totalOutput
  const byDayValues = useMemo(() => lastNDays(stats.byDay, 7), [stats.byDay])
  const tokenToday = byDayValues[byDayValues.length - 1] ?? 0
  const token7d = byDayValues.reduce((a, b) => a + b, 0)
  const maxDay = Math.max(1, ...byDayValues)

  // --- 文件 · 目录 卡片数据（bridge /list-dir，失败显示占位 + 重试）---
  const [fs, setFs] = useState<{ dirs: number; files: number; loading: boolean; error: string }>({
    dirs: 0,
    files: 0,
    loading: true,
    error: '',
  })
  const loadDir = useCallback(async () => {
    const path = lastCwd || getDefaultHome()
    setFs(s => ({ ...s, loading: true, error: '' }))
    try {
      const res = await fetch(`${getBridgeUrl()}/list-dir?path=${encodeURIComponent(path)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const entries: Array<{ type?: string }> = Array.isArray(data?.entries) ? data.entries : []
      setFs({
        dirs: entries.filter(e => e.type === 'directory').length,
        files: entries.filter(e => e.type === 'file').length,
        loading: false,
        error: '',
      })
    } catch (e) {
      setFs({ dirs: 0, files: 0, loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  }, [lastCwd])

  useEffect(() => {
    loadDir()
  }, [loadDir])

  // --- 技能 · Agent 卡片数据 ---
  const [skillCount, setSkillCount] = useState<number | null>(null)
  useEffect(() => {
    let alive = true
    fetchSkills(skillRoot)
      .then(list => {
        if (alive) setSkillCount(list.length)
      })
      .catch(() => {
        if (alive) setSkillCount(0)
      })
    return () => {
      alive = false
    }
  }, [skillRoot])
  const agentCount = DEFAULT_AGENTS.length

  // --- SVG 连线层：测量卡片中心 + resize 重算 ---
  const gridRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef<Record<CardId, HTMLDivElement | null>>({
    sessions: null,
    tokens: null,
    files: null,
    skills: null,
  })
  const [lines, setLines] = useState<CockpitLine[]>([])
  const [hoverSessions, setHoverSessions] = useState(false)

  const updateLines = useCallback(() => {
    const grid = gridRef.current
    if (!grid) return
    const gr = grid.getBoundingClientRect()
    const center = (id: CardId): { x: number; y: number } | null => {
      const el = cardRefs.current[id]
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.left - gr.left + r.width / 2, y: r.top - gr.top + r.height / 2 }
    }
    const from = center('sessions')
    if (!from) return
    const targets: CardId[] = ['tokens', 'files', 'skills']
    const next: CockpitLine[] = []
    for (const target of targets) {
      const to = center(target)
      if (to) next.push({ id: `line-${target}`, from, to })
    }
    setLines(next)
  }, [])

  useEffect(() => {
    // 布局稳定后测量（等字体/图片加载），并在容器尺寸变化时重算
    const raf = requestAnimationFrame(() => {
      setTimeout(updateLines, 60)
    })
    const ro = new ResizeObserver(updateLines)
    if (gridRef.current) ro.observe(gridRef.current)
    window.addEventListener('resize', updateLines)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('resize', updateLines)
    }
  }, [updateLines])

  const linePath = (l: CockpitLine) => {
    const midX = (l.from.x + l.to.x) / 2
    return `M ${l.from.x} ${l.from.y} C ${midX} ${l.from.y}, ${midX} ${l.to.y}, ${l.to.x} ${l.to.y}`
  }

  const enterFileCard = () => {
    goWorkspace('chats')
    // 右侧栏（文件视图）默认开启；uiStore 无 openRightRail action，直接置状态
    useUIStore.setState({ rightRailOpen: true })
  }

  const cardBase = cn(
    'group relative z-10 flex flex-col gap-4 rounded-xl bg-elevated/80 border border-subtle',
    'p-5 cursor-pointer transition-all duration-200 hover:border-brand-500/50 hover:shadow-accent-md',
  )

  const stat = (label: string, value: string, accent?: string) => (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wider text-tertiary">{label}</span>
      <span className={cn('text-xl font-semibold tabular-nums text-primary', accent)}>{value}</span>
    </div>
  )

  return (
    <div className="h-full w-full bg-app flex flex-col overflow-hidden p-6 md:p-10">
      {/* 顶部欢迎区 */}
      <header className="flex items-center justify-between pb-6 shrink-0">
        <div>
          <h1 className="font-display font-bold text-2xl text-primary tracking-wide">{t('cockpit.welcome')}</h1>
          <p className="text-sm text-tertiary mt-1">Ponos dev</p>
        </div>
        <span className="text-xs text-tertiary/60 hidden sm:block">{t('cockpit.enter')}</span>
      </header>

      {/* 2×2 卡片网格 + SVG 连线层 */}
      <div ref={gridRef} className="relative flex-1 grid grid-cols-1 md:grid-cols-2 gap-6 min-h-0">
        {/* 连线层：会话卡 → 其余卡 */}
        <svg className="pointer-events-none absolute inset-0 z-0 h-full w-full" aria-hidden="true">
          <defs>
            <linearGradient id="gradPinkCyan" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" style={{ stopColor: 'var(--brand-500)' }} />
              <stop offset="100%" style={{ stopColor: 'var(--accent-cyan)' }} />
            </linearGradient>
          </defs>
          {lines.map(l => (
            <path
              key={l.id}
              d={linePath(l)}
              fill="none"
              stroke="url(#gradPinkCyan)"
              strokeWidth={1.5}
              strokeOpacity={hoverSessions ? 0.6 : 0.25}
              style={{ transition: 'stroke-opacity 0.2s ease' }}
            />
          ))}
        </svg>

        {/* 卡片 1：会话 · 任务 */}
        <div
          ref={el => {
            cardRefs.current.sessions = el
          }}
          className={cardBase}
          onMouseEnter={() => setHoverSessions(true)}
          onMouseLeave={() => setHoverSessions(false)}
          onClick={() => goWorkspace('chats')}
          role="button"
          tabIndex={0}
          onKeyDown={e => {
            if (e.key === 'Enter') goWorkspace('chats')
          }}
        >
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm font-medium text-primary">
              <MessageSquare className="w-4 h-4 text-brand-500" />
              {t('cockpit.sessionsTitle')}
            </span>
            <ArrowRight className="w-4 h-4 text-tertiary/60 group-hover:text-brand-500 transition-colors" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            {stat(t('cockpit.totalSessions'), String(totalSessions))}
            {stat(t('cockpit.today'), String(todayUpdated))}
            {stat(t('cockpit.runningTasks'), String(runningTasks), runningTasks > 0 ? 'text-warning' : undefined)}
            {stat(t('cockpit.completionRate'), `${completionRate}%`)}
          </div>
        </div>

        {/* 卡片 2：Token 用量 */}
        <div
          ref={el => {
            cardRefs.current.tokens = el
          }}
          className={cardBase}
          onClick={() => useUIStore.getState().openTokenPanel()}
          role="button"
          tabIndex={0}
          onKeyDown={e => {
            if (e.key === 'Enter') useUIStore.getState().openTokenPanel()
          }}
        >
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm font-medium text-primary">
              <Zap className="w-4 h-4" style={{ color: 'var(--accent-cyan)' }} />
              {t('cockpit.tokenTitle')}
            </span>
            <ArrowRight className="w-4 h-4 text-tertiary/60 group-hover:text-brand-500 transition-colors" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            {stat(t('cockpit.tokenTotal'), formatTokens(tokenTotal))}
            {stat(t('cockpit.tokenToday'), formatTokens(tokenToday))}
            {stat(t('cockpit.token7d'), formatTokens(token7d))}
          </div>
          {/* 迷你近 7 日柱状趋势（手写 SVG） */}
          <svg className="w-full h-10" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id="cockpitBarGrad" x1="0" y1="1" x2="0" y2="0">
                <stop offset="0%" style={{ stopColor: 'var(--accent-cyan)' }} />
                <stop offset="100%" style={{ stopColor: 'var(--brand-500)' }} />
              </linearGradient>
            </defs>
            {byDayValues.map((v, i) => {
              const barW = 100 / 7
              const x = i * barW + 2
              const h = (v / maxDay) * 34
              const y = 38 - h
              return (
                <rect
                  key={i}
                  x={x}
                  y={y}
                  width={barW - 4}
                  height={h}
                  rx={2}
                  fill="url(#cockpitBarGrad)"
                  opacity={i === byDayValues.length - 1 ? 1 : 0.45}
                />
              )
            })}
          </svg>
        </div>

        {/* 卡片 3：文件 · 目录 */}
        <div
          ref={el => {
            cardRefs.current.files = el
          }}
          className={cardBase}
          onClick={enterFileCard}
          role="button"
          tabIndex={0}
          onKeyDown={e => {
            if (e.key === 'Enter') enterFileCard()
          }}
        >
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm font-medium text-primary">
              <FolderOpen className="w-4 h-4" style={{ color: 'var(--accent-cyan)' }} />
              {t('cockpit.fileTitle')}
            </span>
            <ArrowRight className="w-4 h-4 text-tertiary/60 group-hover:text-brand-500 transition-colors" />
          </div>
          {fs.error ? (
            <div className="flex items-center gap-3 py-2">
              <span className="text-xs text-tertiary truncate flex-1" title={fs.error}>
                {fs.error}
              </span>
              <button
                className="px-2.5 py-1 rounded-md text-xs border border-subtle text-secondary hover:border-brand-500/50 hover:text-primary transition-colors shrink-0"
                onClick={e => {
                  e.stopPropagation()
                  loadDir()
                }}
              >
                {t('common.retry')}
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              {stat(t('cockpit.fileCount'), fs.loading ? '…' : String(fs.files))}
              {stat(t('cockpit.dirCount'), fs.loading ? '…' : String(fs.dirs))}
            </div>
          )}
        </div>

        {/* 卡片 4：技能 · Agent */}
        <div
          ref={el => {
            cardRefs.current.skills = el
          }}
          className={cardBase}
          onClick={() => goWorkspace('skills')}
          role="button"
          tabIndex={0}
          onKeyDown={e => {
            if (e.key === 'Enter') goWorkspace('skills')
          }}
        >
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm font-medium text-primary">
              <Sparkles className="w-4 h-4 text-brand-500" />
              {t('cockpit.skillTitle')}
            </span>
            <ArrowRight className="w-4 h-4 text-tertiary/60 group-hover:text-brand-500 transition-colors" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            {stat(t('cockpit.skillCount'), skillCount === null ? '…' : String(skillCount))}
            {stat(t('cockpit.agentCount'), String(agentCount))}
          </div>
        </div>
      </div>
    </div>
  )
}
