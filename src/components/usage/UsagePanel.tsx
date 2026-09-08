import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Gauge, RefreshCw, ArrowUp, Check, Search, Loader2, AlertCircle } from 'lucide-react'
import { useTranslation } from '@/i18n/useTranslation'
import { cn } from '@/lib/utils'
import { fetchUsage, fetchAudit } from '@/lib/usageApi'
import { usageTotalsView, auditView, fmtTokens, fmtUsd, fmtSession } from '@/lib/usageUi'
import type { UsageReport, AuditRow } from '@/lib/usageUi'

type Seg = 'usage' | 'audit'

/** 侧栏「用量」视图：用量摘要 + 审计明细（spec D3）。项目过滤 = 点按摘要段按项目表行 / 审计段下拉。 */
export function UsagePanel() {
  const { t } = useTranslation()
  const [seg, setSeg] = useState<Seg>('usage')
  const [project, setProject] = useState('')
  const [query, setQuery] = useState('')
  const [usage, setUsage] = useState<UsageReport | null>(null)
  const [rows, setRows] = useState<AuditRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)

  const loadUsage = useCallback(() => {
    let on = true
    setLoading(true)
    setError('')
    fetchUsage(project ? { project } : {})
      .then((u) => { if (on) setUsage(u) })
      .catch((e: Error) => { if (on) setError(e?.message || t('usage.error')) })
      .finally(() => { if (on) setLoading(false) })
    return () => { on = false }
  }, [project])

  const loadAudit = useCallback(() => {
    let on = true
    setLoading(true)
    setError('')
    fetchAudit(project ? { project } : {})
      .then((a) => { if (on) setRows(a) })
      .catch((e: Error) => { if (on) setError(e?.message || t('usage.error')) })
      .finally(() => { if (on) setLoading(false) })
    return () => { on = false }
  }, [project])

  // 用量：挂载 / project 变化 / 手动刷新
  useEffect(() => loadUsage(), [loadUsage, tick])
  // 审计：切到审计段时按需拉取（同样跟随 project / 刷新）
  useEffect(() => {
    if (seg !== 'audit') return
    return loadAudit()
  }, [seg, loadAudit, tick])

  const refresh = () => setTick((x) => x + 1)
  const view = usageTotalsView(usage)
  const emptyUsage = !!usage && view.turns === 0 && view.models.length === 0 && view.tools.length === 0 && view.projects.length === 0
  const shownRows = seg === 'audit' && rows
    ? auditView(rows).filter((r) => {
        if (!query.trim()) return true
        const q = query.trim().toLowerCase()
        return [r.tool, r.params, r.summary, r.session, r.type].some((v) => typeof v === 'string' && v.toLowerCase().includes(q))
      })
    : []

  const segBtn = (id: Seg, label: string) => (
    <button
      onClick={() => setSeg(id)}
      className={cn(
        'flex-1 h-7 rounded-md text-[11px] font-medium transition-colors',
        seg === id ? 'bg-elevated text-primary' : 'text-tertiary hover:text-secondary'
      )}
    >
      {label}
    </button>
  )

  const StatRow = ({ label, value, strong }: { label: string; value: string; strong?: boolean }) => (
    <div className="flex items-center justify-between gap-2 py-0.5">
      <span className="text-[11px] text-tertiary truncate">{label}</span>
      <span className={cn('text-[11px] font-medium tabular-nums shrink-0', strong ? 'text-red-500' : 'text-secondary')}>{value}</span>
    </div>
  )

  const Section = ({ title, children }: { title: string; children: ReactNode }) => (
    <div className="border-t border-border/60 pt-2 mt-2 first:border-t-0 first:pt-0 first:mt-0">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-tertiary mb-1">{title}</p>
      <div className="space-y-px">{children}</div>
    </div>
  )

  return (
    <div className="flex-1 flex flex-col min-h-0 h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b">
        <Gauge className="w-3.5 h-3.5 text-brand-500/80 shrink-0" />
        <div className="flex-1 flex rounded-md bg-elevated/60 p-0.5">
          {segBtn('usage', t('usage.segmentUsage'))}
          {segBtn('audit', t('usage.segmentAudit'))}
        </div>
        <button
          onClick={refresh}
          title={t('usage.refresh')}
          aria-label={t('usage.refresh')}
          className="inline-flex items-center justify-center w-6 h-6 rounded-md text-tertiary hover:text-secondary hover:bg-elevated transition-colors"
        >
          <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      {error ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 p-4 text-center">
          <AlertCircle className="w-5 h-5 text-red-500/80" />
          <p className="text-[11px] text-tertiary break-all">{error}</p>
          <button onClick={refresh} className="text-[11px] text-primary underline">{t('common.retry')}</button>
        </div>
      ) : seg === 'usage' ? (
        <div className="flex-1 overflow-y-auto min-h-0 px-3 py-2">
          {!usage ? (
            <div className="h-full flex items-center justify-center"><Loader2 className="w-4 h-4 text-tertiary animate-spin" /></div>
          ) : emptyUsage ? (
            <p className="text-center text-[11px] text-tertiary py-6">{t('usage.noData')}</p>
          ) : (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-1.5">
                <div className="rounded-lg border border-subtle bg-elevated/40 px-2.5 py-2">
                  <StatRow label={t('usage.cost')} value={`$${fmtUsd(view.costUsd)}`} strong={view.overBudget} />
                  {view.budgetUsd > 0 && <StatRow label={t('usage.budget')} value={`$${fmtUsd(view.budgetUsd)}`} />}
                </div>
                <div className="rounded-lg border border-subtle bg-elevated/40 px-2.5 py-2">
                  <StatRow label={t('usage.inputTokens')} value={fmtTokens(view.input)} />
                  <StatRow label={t('usage.outputTokens')} value={fmtTokens(view.output)} />
                </div>
                <div className="rounded-lg border border-subtle bg-elevated/40 px-2.5 py-2">
                  <StatRow label={t('usage.cacheRead')} value={fmtTokens(view.cacheRead)} />
                  <StatRow label={t('usage.cacheRate')} value={`${view.cacheRatePct.toFixed(1)}%`} />
                </div>
                <div className="rounded-lg border border-subtle bg-elevated/40 px-2.5 py-2">
                  <StatRow label={t('usage.turns')} value={String(view.turns)} />
                </div>
              </div>

              {view.models.length > 0 && (
                <Section title={t('usage.byModel')}>
                  {view.models.map((m) => (
                    <StatRow key={m.name} label={m.name} value={`$${fmtUsd(m.costUsd)} · ${m.turns} ${t('usage.turns')}`} />
                  ))}
                </Section>
              )}

              {view.projects.length > 0 && (
                <Section title={t('usage.byProject')}>
                  {view.projects.map((p) => (
                    <button
                      key={p}
                      onClick={() => setProject(project === p ? '' : p)}
                      className={cn(
                        'w-full flex items-center justify-between gap-2 rounded px-1.5 py-0.5 text-left transition-colors',
                        project === p ? 'bg-elevated' : 'hover:bg-elevated/60'
                      )}
                    >
                      <span className="text-[11px] text-secondary truncate">{p}</span>
                      <span className="text-[11px] text-tertiary shrink-0 tabular-nums">
                        {fmtTokens(usage!.byProject[p]?.input_tokens ?? 0)}
                      </span>
                    </button>
                  ))}
                </Section>
              )}

              {view.tools.length > 0 && (
                <Section title={t('usage.byTool')}>
                  {view.tools.map((x) => (
                    <StatRow key={x.name} label={x.name} value={String(x.count)} />
                  ))}
                </Section>
              )}

            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-h-0">
          {/* Audit filters */}
          <div className="px-3 pt-2 flex items-center gap-1.5">
            <select
              value={project}
              onChange={(e) => setProject(e.target.value)}
              className="h-6 flex-1 min-w-0 bg-elevated border border rounded-md px-1.5 text-[11px] text-primary outline-none focus:ring-1 focus:ring-accent"
            >
              <option value="">{t('usage.allProjects')}</option>
              {view.projects.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-tertiary" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="…"
                className="w-full h-6 bg-elevated border border rounded-md pl-6 pr-1.5 text-[11px] text-primary placeholder:text-tertiary outline-none focus:ring-1 focus:ring-accent"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto min-h-0 px-3 py-2">
            {!rows ? (
              <div className="h-full flex items-center justify-center"><Loader2 className="w-4 h-4 text-tertiary animate-spin" /></div>
            ) : shownRows.length === 0 ? (
              <p className="text-center text-[11px] text-tertiary py-6">{t('usage.emptyAudit')}</p>
            ) : (
              <ul className="space-y-1">
                {shownRows.map((r, i) => (
                  <li key={`${r.ts}-${r.seq}-${i}`} className="rounded-md border border-subtle bg-elevated/30 px-2 py-1.5">
                    <div className="flex items-center gap-1.5">
                      {r.type === 'tool_use'
                        ? <ArrowUp className="w-3 h-3 text-brand-500/80 shrink-0" />
                        : <Check className="w-3 h-3 text-emerald-500/80 shrink-0" />}
                      <span className="text-[11px] font-medium text-secondary truncate">
                        {r.type === 'tool_use' ? r.tool : 'tool_result'}
                      </span>
                      <span className="ml-auto text-[10px] text-tertiary shrink-0 tabular-nums">
                        {fmtSession(r.session)} · {fmtTime(r.ts)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[10px] text-tertiary truncate leading-relaxed" title={r.type === 'tool_use' ? r.params : r.summary}>
                      {r.type === 'tool_use' ? r.params : r.summary}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function fmtTime(ts: string): string {
  const s = String(ts ?? '')
  // 'YYYY-MM-DDTHH:mm:ss…' → 'MM-DD HH:mm'
  return s.length >= 16 ? `${s.slice(5, 10)} ${s.slice(11, 16)}` : s
}
