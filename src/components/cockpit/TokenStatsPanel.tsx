import { useEffect, useMemo, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useTranslation } from '@/i18n/useTranslation'
import { useChatStore } from '@/stores/chatStore'
import { useTokenStatsStore, toDayKey } from '@/stores/tokenStatsStore'
import { useUIStore } from '@/stores/uiStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { cn } from '@/lib/utils'

/**
 * K/M 格式化（与 CockpitView/StatusBar 相同逻辑；Task 12 计划提取公共工具，YAGNI 暂不提取）。
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

/** 环形图三色：粉 / 青 / 红（语义主题变量，无硬编码 hex） */
const DONUT_COLORS = ['var(--brand-500)', 'var(--accent-cyan)', 'rgb(var(--error-rgb))']

/** 面板卡片外壳 */
function Card({ title, children, className }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-xl bg-elevated/80 border border-subtle p-4', className)}>
      {title && <h3 className="text-[11px] uppercase tracking-wider text-tertiary mb-3">{title}</h3>}
      {children}
    </section>
  )
}

/** 维度 2：近 30 日趋势 — SVG polyline + 面积渐变（按最高值归一化） */
function TrendChart({ values, labels }: { values: number[]; labels: string[] }) {
  const W = 600
  const H = 150
  const PAD_L = 6
  const PAD_R = 6
  const PAD_T = 12
  const PAD_B = 22
  const n = values.length
  const max = Math.max(1, ...values)
  const innerW = W - PAD_L - PAD_R
  const innerH = H - PAD_T - PAD_B
  const x = (i: number) => (n <= 1 ? PAD_L : PAD_L + (i / (n - 1)) * innerW)
  const y = (v: number) => PAD_T + (1 - v / max) * innerH
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const areaPath =
    n > 0
      ? `M ${x(0).toFixed(1)} ${y(values[0]).toFixed(1)} ` +
        values.map((v, i) => `L ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ') +
        ` L ${x(n - 1).toFixed(1)} ${(PAD_T + innerH).toFixed(1)} L ${x(0).toFixed(1)} ${(PAD_T + innerH).toFixed(1)} Z`
      : ''
  const labelIdx = n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1]

  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-40" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="tsp-stroke" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" style={{ stopColor: 'var(--accent-cyan)' }} />
            <stop offset="100%" style={{ stopColor: 'var(--brand-500)' }} />
          </linearGradient>
          <linearGradient id="tsp-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: 'var(--brand-500)', stopOpacity: 0.28 }} />
            <stop offset="100%" style={{ stopColor: 'var(--brand-500)', stopOpacity: 0.02 }} />
          </linearGradient>
        </defs>
        {n > 0 && (
          <>
            <path d={areaPath} fill="url(#tsp-fill)" />
            <polyline
              points={points}
              fill="none"
              stroke="url(#tsp-stroke)"
              strokeWidth={1.8}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {values.map((v, i) => (
              <circle key={i} cx={x(i)} cy={y(v)} r={1.8} fill="var(--accent-cyan)">
                <title>{`${labels[i] ?? ''} · ${v.toLocaleString()} tokens`}</title>
              </circle>
            ))}
          </>
        )}
      </svg>
      {/* 日期刻度放 SVG 外，避免 preserveAspectRatio="none" 拉伸变形 */}
      <div className="mt-1 flex justify-between text-[10px] text-tertiary">
        {labelIdx.map(i => (
          <span key={i}>{labels[i] ?? ''}</span>
        ))}
      </div>
    </>
  )
}

/** 维度 4：模型拆分 — circle stroke-dasharray 环形图 */
function DonutChart({
  segments,
  centerValue,
}: {
  segments: { label: string; value: number }[]
  centerValue: number
}) {
  const total = segments.reduce((a, s) => a + s.value, 0)
  let acc = 0
  const arcs = segments.map((s, i) => {
    const len = total > 0 ? (s.value / total) * 100 : 0
    const start = acc
    acc += len
    return { ...s, len, start, color: DONUT_COLORS[i % DONUT_COLORS.length] }
  })

  return (
    <div className="flex items-center gap-4">
      <div className="relative w-32 h-32 shrink-0">
        <svg viewBox="0 0 100 100" className="w-full h-full">
          <g transform="rotate(-90 50 50)">
            <circle cx="50" cy="50" r="40" fill="none" stroke="var(--bg-input)" strokeWidth="12" pathLength={100} />
            {arcs.map(a => (
              <circle
                key={a.label}
                cx="50"
                cy="50"
                r="40"
                fill="none"
                stroke={a.color}
                strokeWidth="12"
                pathLength={100}
                strokeDasharray={`${Math.max(0, a.len - 0.5)} ${100 - Math.max(0, a.len - 0.5)}`}
                strokeDashoffset={-a.start}
              />
            ))}
          </g>
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-semibold tabular-nums text-primary">{formatTokens(centerValue)}</span>
          <span className="text-[10px] text-tertiary">tokens</span>
        </div>
      </div>
      <div className="flex-1 space-y-1.5 min-w-0">
        {segments.length === 0 && <p className="text-xs text-tertiary">—</p>}
        {arcs.map(a => (
          <div key={a.label} className="flex items-center gap-2 text-xs">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: a.color }} />
            <span className="text-secondary truncate flex-1" title={a.label}>
              {a.label}
            </span>
            <span className="text-tertiary tabular-nums shrink-0">{total > 0 ? `${Math.round(a.len)}%` : '0%'}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Task 7: Token 用量六维详情面板。
 * 由 useUIStore.tokenPanelOpen 控制（驾驶舱 Token 卡 / 状态栏 TK 打开），
 * 通过 createPortal 挂载到 body；Task 8 在 App 根组件正式挂载本组件。
 */
export function TokenStatsPanel() {
  const { t } = useTranslation()
  const tokenPanelOpen = useUIStore(s => s.tokenPanelOpen)
  const closeTokenPanel = useUIStore(s => s.closeTokenPanel)
  const stats = useTokenStatsStore(s => s.stats)
  const conversations = useChatStore(s => s.conversations)
  const settings = useSettingsStore(s => s.settings)

  // Esc 关闭
  useEffect(() => {
    if (!tokenPanelOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeTokenPanel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tokenPanelOpen, closeTokenPanel])

  const total = stats.totalInput + stats.totalOutput

  // 维度 1：总量卡（累计 / 今日 / 近 7 日）
  const day30 = useMemo(() => lastNDays(stats.byDay, 30), [stats.byDay])
  const today = day30[day30.length - 1] ?? 0
  const week7 = day30.slice(-7).reduce((a, b) => a + b, 0)
  const trendLabels = useMemo(
    () =>
      day30.map((_, i) => {
        const d = new Date(Date.now() - (29 - i) * DAY_MS)
        return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      }),
    [day30],
  )

  // 维度 3：会话 Top 10（input+output 降序）
  const topSessions = useMemo(
    () =>
      Object.entries(stats.byConversation)
        .map(([id, d]) => ({ id, total: d.input + d.output }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 10),
    [stats.byConversation],
  )
  const topMax = Math.max(1, ...topSessions.map(s => s.total))
  const convTitle = (id: string) => {
    const c = conversations.find(x => x.id === id)
    return c && c.title && c.title.trim() ? c.title : id.slice(0, 8)
  }

  // 维度 4：模型拆分
  const models = useMemo(
    () =>
      Object.entries(stats.byModel)
        .map(([name, d]) => ({ name: name || '—', total: d.input + d.output }))
        .filter(m => m.total > 0)
        .sort((a, b) => b.total - a.total),
    [stats.byModel],
  )
  const modelTotal = models.reduce((a, m) => a + m.total, 0)

  // 维度 6：水位（最新 updatedAt 会话 估算 token / provider contextWindow）
  const activeConv = useMemo(() => {
    let best: (typeof conversations)[number] | null = null
    for (const c of conversations) {
      if (!best || c.updatedAt > best.updatedAt) best = c
    }
    return best
  }, [conversations])
  const activeUsage = activeConv ? stats.byConversation[activeConv.id] : undefined
  const estimated = activeUsage ? activeUsage.input + activeUsage.output : 0
  const contextWindow = settings.providers.find(p => p.id === settings.activeProvider)?.contextWindow ?? 1000000
  const pct = contextWindow > 0 ? Math.min(100, (estimated / contextWindow) * 100) : 0
  const waterColor =
    pct >= 95 ? 'rgb(var(--error-rgb))' : pct >= 80 ? 'rgb(var(--warning-rgb))' : 'linear-gradient(90deg, var(--accent-cyan), var(--brand-500))'

  // 维度 5：输入 / 输出
  const inputPct = total > 0 ? (stats.totalInput / total) * 100 : 0
  const outputPct = total > 0 ? (stats.totalOutput / total) * 100 : 0

  if (!tokenPanelOpen) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[80] backdrop-blur p-4 sm:p-6"
      style={{ background: 'var(--overlay-bg)' }}
      onClick={closeTokenPanel}
    >
      <div
        className="mx-auto max-w-5xl h-full bg-surface border border-subtle rounded-2xl overflow-auto shadow-modal animate-scale-in"
        onClick={e => e.stopPropagation()}
      >
        {/* 面板头部 + 右上角关闭 */}
        <header className="sticky top-0 z-10 flex items-center justify-between px-5 sm:px-6 py-4 border-b border-subtle bg-surface/95 backdrop-blur">
          <h2 className="font-display font-bold text-lg text-primary tracking-wide">{t('tokenPanel.title')}</h2>
          <button
            type="button"
            onClick={closeTokenPanel}
            aria-label={t('tokenPanel.close')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-secondary hover:bg-hover hover:text-primary transition-colors"
          >
            <X className="w-4 h-4" />
            <span className="hidden sm:inline">{t('tokenPanel.close')}</span>
          </button>
        </header>

        {total === 0 ? (
          <div className="h-[70%] flex flex-col items-center justify-center gap-3 text-tertiary">
            <span className="text-5xl font-light opacity-30">∅</span>
            <p className="text-sm">{t('tokenPanel.empty')}</p>
          </div>
        ) : (
          <div className="p-4 sm:p-6 space-y-4">
            {/* 维度 1：总量卡 */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[
                { label: t('tokenPanel.total'), value: formatTokens(total), raw: total.toLocaleString() },
                { label: t('tokenPanel.today'), value: formatTokens(today), raw: today.toLocaleString() },
                { label: t('tokenPanel.week7'), value: formatTokens(week7), raw: week7.toLocaleString() },
              ].map(s => (
                <Card key={s.label}>
                  <div className="text-[11px] uppercase tracking-wider text-tertiary">{s.label}</div>
                  <div className="mt-2 text-3xl font-semibold tabular-nums text-primary">{s.value}</div>
                  <div className="mt-1 text-xs tabular-nums text-tertiary">{s.raw}</div>
                </Card>
              ))}
            </div>

            {/* 维度 2 + 4：近 30 日趋势 + 模型拆分 */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <Card title={t('tokenPanel.trend')} className="lg:col-span-2">
                <TrendChart values={day30} labels={trendLabels} />
              </Card>
              <Card title={t('tokenPanel.byModel')}>
                <DonutChart segments={models.map(m => ({ label: m.name, value: m.total }))} centerValue={modelTotal} />
              </Card>
            </div>

            {/* 维度 3：会话 Top 10 */}
            <Card title={t('tokenPanel.topSessions')}>
              {topSessions.length === 0 ? (
                <p className="text-xs text-tertiary">—</p>
              ) : (
                <div className="space-y-2">
                  {topSessions.map((s, i) => (
                    <div key={s.id} className="flex items-center gap-2">
                      <span className="w-5 text-right text-xs text-tertiary tabular-nums shrink-0">{i + 1}</span>
                      <span className="text-xs text-secondary truncate w-32 sm:w-56 shrink-0" title={convTitle(s.id)}>
                        {convTitle(s.id)}
                      </span>
                      <div className="flex-1 h-2 rounded-full bg-input/50 overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${(s.total / topMax) * 100}%`,
                            background: 'linear-gradient(90deg, var(--accent-cyan), var(--brand-500))',
                          }}
                        />
                      </div>
                      <span className="text-xs text-tertiary tabular-nums w-16 text-right shrink-0">
                        {formatTokens(s.total)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {/* 维度 5 + 6：输入/输出 + 水位 */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card title={t('tokenPanel.ioSplit')}>
                <div className="flex h-3 w-full rounded-full bg-input/50 overflow-hidden">
                  <div
                    className="h-full transition-all"
                    style={{ width: `${inputPct}%`, background: 'var(--accent-cyan)' }}
                  />
                  <div
                    className="h-full transition-all"
                    style={{ width: `${outputPct}%`, background: 'var(--brand-500)' }}
                  />
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: 'var(--accent-cyan)' }} />
                    <span className="text-xs text-secondary">{t('tokenPanel.input')}</span>
                    <span className="ml-auto text-xs text-primary tabular-nums">{formatTokens(stats.totalInput)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: 'var(--brand-500)' }} />
                    <span className="text-xs text-secondary">{t('tokenPanel.output')}</span>
                    <span className="ml-auto text-xs text-primary tabular-nums">{formatTokens(stats.totalOutput)}</span>
                  </div>
                </div>
                <div className="mt-3 text-[11px] text-tertiary tabular-nums">
                  {stats.totalInput.toLocaleString()} / {stats.totalOutput.toLocaleString()} · {inputPct.toFixed(1)}% /{' '}
                  {outputPct.toFixed(1)}%
                </div>
              </Card>

              <Card title={t('tokenPanel.window')}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs text-secondary truncate" title={activeConv?.title ?? ''}>
                    {activeConv ? activeConv.title : '—'}
                  </span>
                  <span className="text-xs text-tertiary tabular-nums shrink-0">
                    {formatTokens(estimated)} / {formatTokens(contextWindow)}
                  </span>
                </div>
                <div className="mt-3 flex h-3 w-full rounded-full bg-input/50 overflow-hidden">
                  <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: waterColor }} />
                </div>
                <div className="mt-3 flex items-center justify-between text-[11px] text-tertiary">
                  <span className="tabular-nums">{pct.toFixed(1)}%</span>
                  <span>{t('tokenPanel.window')}</span>
                </div>
              </Card>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
