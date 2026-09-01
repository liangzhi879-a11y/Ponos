import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, FolderOpen, MessageSquare, Sparkles, Zap } from 'lucide-react'
import { useChatStore } from '@/stores/chatStore'
import { useTokenStatsStore, toDayKey } from '@/stores/tokenStatsStore'
import { useUIStore } from '@/stores/uiStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { usePonosCLI } from '@/hooks/usePonosCLI'
import { openModule } from '@/lib/moduleBridge'
import { fetchSkills, type SkillEntry } from '@/lib/skills'
import { DEFAULT_AGENTS } from '@/lib/agents'
import { getBridgeUrl, getDefaultHome } from '@/lib/config'
import { useTranslation } from '@/i18n/useTranslation'
import { cn } from '@/lib/utils'
import { TrendChart } from '@/components/charts/TrendChart'
import { DonutChart } from '@/components/charts/DonutChart'
import { BarStack } from '@/components/charts/BarStack'
import { RecentSessions } from './RecentSessions'
import { RunningTasks } from './RunningTasks'

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

/** 状态总览条单项：小标签 + 大数字（可带脉冲圆点）。 */
function StatItem({ label, value, pulse }: { label: string; value: string; pulse?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-tertiary">{label}</span>
      <span className="text-lg font-semibold tabular-nums text-primary flex items-center gap-1.5">
        {pulse && <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse" />}
        {value}
      </span>
    </div>
  )
}

export function CockpitView() {
  const { t } = useTranslation()

  const conversations = useChatStore(s => s.conversations)
  const backgroundTasks = useChatStore(s => s.backgroundTasks)
  const lastCwd = useChatStore(s => s.lastCwd)

  const stats = useTokenStatsStore(s => s.stats)
  const lastError = useTokenStatsStore(s => s.lastError)

  const skillRoot = useSettingsStore(s => s.settings.skillRoot)

  // Bridge 在线状态：直接取 CLI WS 心跳连接状态
  const bridgeOk = usePonosCLI().connected

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
  // 最近 3 条会话（updatedAt 倒序）
  const recent3 = useMemo(
    () => [...conversations].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 3),
    [conversations],
  )
  // 统一激活会话并进入工作台（Task 8 收尾统一 RecentSessions 点击）
  // 用 store 官方 action：除置 activeConversationId 外还会按需加载消息体，
  // 否则冷启动时最近会话点击进入会显示空态。
  const openConversation = (id: string) => {
    useChatStore.getState().setActiveConversation(id)
    // 独立聊天模块窗口（导航条常驻，会话在独立窗口打开）
    void openModule('chat', { conversation: id })
  }

  // --- Token 用量 卡片数据 ---
  const tokenTotal = stats.totalInput + stats.totalOutput
  const byDay30 = useMemo(() => lastNDays(stats.byDay, 30), [stats.byDay])
  const tokenToday = byDay30[byDay30.length - 1] ?? 0
  const token7d = byDay30.slice(-7).reduce((a, b) => a + b, 0)
  // 错误态重试：重新向内核 /transcript/stats 拉取（成功会自动清空 lastError）
  const retryRefresh = () => {
    void useTokenStatsStore.getState().refreshFromServer()
  }
  // 近 30 日 MM-DD 标签（与 TokenStatsPanel 同逻辑）
  const trendLabels30 = useMemo(
    () =>
      byDay30.map((_, i) => {
        const d = new Date(Date.now() - (29 - i) * DAY_MS)
        return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      }),
    [byDay30],
  )

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
  const [skills, setSkills] = useState<SkillEntry[]>([])
  const [skillCount, setSkillCount] = useState<number | null>(null)
  useEffect(() => {
    let alive = true
    fetchSkills(skillRoot)
      .then(list => {
        if (alive) {
          setSkills(list)
          setSkillCount(list.length)
        }
      })
      .catch(() => {
        if (alive) setSkillCount(0)
      })
    return () => {
      alive = false
    }
  }, [skillRoot])
  const agentCount = DEFAULT_AGENTS.length

  // 技能分类聚合：id 前缀分组（gxtz/yfwx/yfwdoc/space…）
  const skillGroups = useMemo(() => {
    const groups: Record<string, number> = {}
    for (const s of skills) {
      const prefix = s.id.split('-')[0] || 'other'
      groups[prefix] = (groups[prefix] || 0) + 1
    }
    return Object.entries(groups)
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value)
  }, [skills])

  // --- Hero 快捷操作：新建会话（独立聊天模块窗口，new=1 强制新建会话） ---
  const startNewChat = () => {
    void openModule('chat', { new: '1' })
  }

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
    // 独立文件模块窗口
    void openModule('files')
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
      {/* ① Hero：品牌欢迎区 + 快捷操作 */}
      <header className="flex items-center justify-between pb-4 shrink-0">
        <div>
          <h1 className="font-display font-bold text-2xl md:text-3xl tracking-wide bg-gradient-to-r from-brand-500 to-[var(--accent-cyan)] bg-clip-text text-transparent">
            {t('cockpit.welcome')}
          </h1>
          <p className="text-sm text-tertiary mt-1 flex items-center gap-2">
            <FolderOpen className="w-3.5 h-3.5" />
            {t('cockpit.projectDir')}: {lastCwd ? lastCwd.split(/[\\/]/).pop() : 'ponos-dev'}
            <span className="text-tertiary/60">· {t('cockpit.version')} dev 3.0.0</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={startNewChat}
            className="px-3.5 py-1.5 rounded-lg text-sm font-medium bg-brand-500/90 hover:bg-brand-500 text-white transition-colors"
          >
            {t('cockpit.newChat')}
          </button>
          <button
            onClick={() => useUIStore.getState().toggleRightRail()}
            className="px-3 py-1.5 rounded-lg text-sm border border-subtle text-secondary hover:border-brand-500/50 hover:text-primary transition-colors"
          >
            {t('cockpit.openFiles')}
          </button>
          <button
            onClick={() => useUIStore.getState().openTokenPanel()}
            className="px-3 py-1.5 rounded-lg text-sm border border-subtle text-secondary hover:border-brand-500/50 hover:text-primary transition-colors"
          >
            {t('cockpit.viewTokens')}
          </button>
        </div>
      </header>

      {/* ② 状态总览条 StatStrip */}
      <div className="flex items-center gap-6 pb-5 shrink-0 border-b border-subtle mb-5">
        <StatItem label={t('cockpit.runningTasks')} value={String(runningTasks)} pulse={runningTasks > 0} />
        <StatItem label={t('cockpit.today')} value={String(todayUpdated)} />
        <StatItem label={t('cockpit.tokenToday')} value={formatTokens(tokenToday)} />
        <StatItem label={t('cockpit.completionRate')} value={`${completionRate}%`} />
        <div className="ml-auto flex items-center gap-1.5 text-xs">
          <span className={cn('w-2 h-2 rounded-full', bridgeOk ? 'bg-[var(--accent-cyan)]' : 'bg-error animate-pulse')} />
          <span className="text-tertiary">{bridgeOk ? t('cockpit.bridgeOnline') : t('cockpit.bridgeOffline')}</span>
        </div>
      </div>

      {/* ③ 主网格 + ④ 右栏 */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-6 min-h-0">
        {/* 主网格：四张卡片 + SVG 连线层（卡片内容升级见 Task 7） */}
        <div ref={gridRef} className="relative grid grid-cols-1 md:grid-cols-2 gap-6 min-h-0">
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
            onClick={() => void openModule('chat')}
            role="button"
            tabIndex={0}
            onKeyDown={e => {
              if (e.key === 'Enter') void openModule('chat')
            }}
          >
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm font-medium text-primary">
                <span className="flex items-center justify-center w-6 h-6 rounded-md bg-brand-500/10 text-brand-500">
                  <MessageSquare className="w-3.5 h-3.5" />
                </span>
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
            {recent3.length > 0 && (
              <div className="pt-3 border-t border-subtle flex flex-col gap-1.5">
                <span className="text-[10px] uppercase tracking-wider text-tertiary">{t('cockpit.recentSessions')}</span>
                {recent3.map(c => (
                  <button
                    key={c.id}
                    onClick={e => { e.stopPropagation(); openConversation(c.id) }}
                    className="flex items-center gap-2 text-xs text-secondary hover:text-primary truncate"
                  >
                    <MessageSquare className="w-3 h-3 text-tertiary shrink-0" />
                    <span className="truncate">{c.title || c.id.slice(0, 10)}</span>
                  </button>
                ))}
              </div>
            )}
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
                <span className="flex items-center justify-center w-6 h-6 rounded-md bg-brand-500/10" style={{ color: 'var(--accent-cyan)' }}>
                  <Zap className="w-3.5 h-3.5" />
                </span>
                {t('cockpit.tokenTitle')}
              </span>
              <ArrowRight className="w-4 h-4 text-tertiary/60 group-hover:text-brand-500 transition-colors" />
            </div>
            <div className="grid grid-cols-3 gap-3">
              {stat(t('cockpit.tokenTotal'), formatTokens(tokenTotal))}
              {stat(t('cockpit.tokenToday'), formatTokens(tokenToday))}
              {stat(t('cockpit.token7d'), formatTokens(token7d))}
            </div>
            {/* 近 30 日趋势 + 输入/输出堆叠条；stats 拉取失败时显示错误态 + 重试 */}
            {lastError ? (
              <div className="flex items-center gap-2 py-2">
                <span className="text-xs text-tertiary truncate" title={lastError}>{t('cockpit.dataUnavailable')}</span>
                <button onClick={e => { e.stopPropagation(); retryRefresh() }} className="px-2 py-1 rounded text-xs border border-subtle hover:border-brand-500/50">
                  {t('cockpit.retry')}
                </button>
              </div>
            ) : (
              <>
                <TrendChart values={byDay30} labels={trendLabels30} />
                <BarStack input={stats.totalInput} output={stats.totalOutput} className="mt-3" />
              </>
            )}
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
                <span className="flex items-center justify-center w-6 h-6 rounded-md bg-brand-500/10" style={{ color: 'var(--accent-cyan)' }}>
                  <FolderOpen className="w-3.5 h-3.5" />
                </span>
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
            onClick={() => void openModule('skills')}
            role="button"
            tabIndex={0}
            onKeyDown={e => {
              if (e.key === 'Enter') void openModule('skills')
            }}
          >
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm font-medium text-primary">
                <span className="flex items-center justify-center w-6 h-6 rounded-md bg-brand-500/10 text-brand-500">
                  <Sparkles className="w-3.5 h-3.5" />
                </span>
                {t('cockpit.skillTitle')}
              </span>
              <ArrowRight className="w-4 h-4 text-tertiary/60 group-hover:text-brand-500 transition-colors" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              {stat(t('cockpit.skillCount'), skillCount === null ? '…' : String(skillCount))}
              {stat(t('cockpit.agentCount'), String(agentCount))}
            </div>
            {skillGroups.length > 0 && (
              <div className="pt-3 border-t border-subtle">
                <span className="text-[10px] uppercase tracking-wider text-tertiary">{t('cockpit.skillGroups')}</span>
                <div className="mt-2">
                  <DonutChart segments={skillGroups} centerValue={skillCount ?? 0} centerLabel={t('cockpit.skillCount')} />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 右栏：最近会话 + 运行中任务 */}
        <aside className="hidden lg:flex flex-col gap-6 overflow-y-auto pr-1 min-h-0">
          <RecentSessions />
          <RunningTasks />
        </aside>
      </div>
    </div>
  )
}
