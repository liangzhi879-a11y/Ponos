import { useEffect, useMemo, useState } from 'react'
import { Activity, CheckCircle2, AlertTriangle, XCircle, HelpCircle, RotateCw, Bug, FileText, FolderOpen, ChevronDown } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, Button, ScrollArea } from '@/components/ui'
import { useDiagStore } from '@/stores/diagStore'
import { useTranslation } from '@/i18n/useTranslation'
import { cn } from '@/lib/utils'
import type { DiagCheck } from '@/types'

const STATUS_ICON = {
  ok: CheckCircle2, warn: AlertTriangle, error: XCircle, unknown: HelpCircle,
} as const
const STATUS_COLOR = {
  ok: 'text-success', warn: 'text-warning', error: 'text-error', unknown: 'text-tertiary',
} as const

export function DiagnosticPanel() {
  const { diagOpen, closeDiagnostics, snapshot, bootSummary, errorCount, setSnapshot, setBootSummary } = useDiagStore()
  const { t } = useTranslation()
  const [running, setRunning] = useState(false)
  const [kernelResult, setKernelResult] = useState<{ ok: boolean; stdout: string; stderr: string } | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (!diagOpen) return
    setKernelResult(null)
    window.ponosDiag?.getStatus().then(setSnapshot).catch(() => {})
    window.ponosDiag?.getBootSummary().then(setBootSummary).catch(() => {})
  }, [diagOpen, setSnapshot, setBootSummary])

  const groups = useMemo(() => {
    const g: Record<string, DiagCheck[]> = {}
    for (const c of snapshot?.checks ?? []) (g[c.group] ??= []).push(c)
    return g
  }, [snapshot])

  const runAll = async () => {
    setRunning(true)
    try { const s = await window.ponosDiag?.rerunAll(); if (s) setSnapshot(s) } catch { /* 忽略 IPC 拒绝 */ } finally { setRunning(false) }
  }
  const rerunOne = async (id: string) => {
    try {
      const c = await window.ponosDiag?.rerun(id)
      if (c && snapshot) setSnapshot({ ...snapshot, checks: snapshot.checks.map(x => x.id === id ? c : x) })
    } catch { /* 忽略 IPC 拒绝 */ }
  }
  const runKernel = async () => {
    try {
      const r = await window.ponosDiag?.runKernelCheck()
      if (r) setKernelResult(r)
    } catch { /* 忽略 IPC 拒绝 */ }
  }
  const doExport = async () => {
    try {
      const r = await window.ponosDiag?.exportReport()
      if (!r) return
      await navigator.clipboard.writeText(r.text)
      alert(t('diagnostic.exportCopied'))
    } catch { /* 忽略 IPC/clipboard 拒绝 */ }
  }

  return (
    <Dialog open={diagOpen} onOpenChange={v => !v && closeDiagnostics()}>
      {/* 4 个直接子节点：头部/状态条/滚动区/工具栏，grid 需 4 行（brief 为 3 行会把
          状态条塞进 1fr 行导致布局错位，已适配为 auto_auto_1fr_auto） */}
      <DialogContent size="lg" className="grid grid-rows-[auto_auto_1fr_auto] max-h-[85vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Activity className="w-5 h-5" />
            {t('diagnostic.title')}
          </DialogTitle>
        </DialogHeader>

        {/* 总体状态 */}
        <div className="flex items-center justify-between px-6 pb-4 border-b border-subtle">
          <div className="flex items-center gap-3">
            {snapshot?.overall === 'ok' && <span className="inline-flex items-center gap-1.5 text-sm text-success"><CheckCircle2 className="w-4 h-4" />{t('diagnostic.overallOk')}</span>}
            {snapshot?.overall === 'warn' && <span className="inline-flex items-center gap-1.5 text-sm text-warning"><AlertTriangle className="w-4 h-4" />{t('diagnostic.overallWarn')}</span>}
            {snapshot?.overall === 'error' && <span className="inline-flex items-center gap-1.5 text-sm text-error"><XCircle className="w-4 h-4" />{t('diagnostic.overallError', { n: errorCount })}</span>}
            {!snapshot && <span className="text-sm text-tertiary">{t('diagnostic.initHint')}</span>}
            {bootSummary && !bootSummary.ok && (
              <span className="inline-flex items-center gap-1 text-xs text-warning"><AlertTriangle className="w-3.5 h-3.5" />{t('diagnostic.lastBootAbnormal')}</span>
            )}
          </div>
          <Button size="sm" variant="secondary" onClick={runAll} disabled={running}>
            <RotateCw className={cn('w-3.5 h-3.5', running && 'animate-spin')} /> {t('diagnostic.rerunAll')}
          </Button>
        </div>

        {/* 分组检测列表 */}
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-6 py-4 space-y-4">
            {Object.entries(groups).map(([group, items]) => {
              const open = collapsed[group] !== true
              return (
                <div key={group}>
                  <button className="flex items-center gap-1.5 text-[11px] font-semibold text-tertiary uppercase tracking-wider" onClick={() => setCollapsed(c => ({ ...c, [group]: !c[group] }))}>
                    <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', !open && '-rotate-90')} />
                    {group}
                  </button>
                  {open && items.map(c => {
                    const Icon = STATUS_ICON[c.status]
                    return (
                      <div key={c.id} className="flex items-start gap-2.5 py-1.5">
                        <Icon className={cn('w-4 h-4 mt-0.5 shrink-0', STATUS_COLOR[c.status])} />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-primary">{t(c.label)}</div>
                          {c.detail && <div className="text-xs text-tertiary truncate" title={c.detail}>{c.detail}</div>}
                        </div>
                        <span className="text-[10px] text-tertiary shrink-0 mt-0.5">
                          {c.lastCheckedAt ? new Date(c.lastCheckedAt).toLocaleTimeString() : '—'}
                          {c.latencyMs != null ? ` · ${c.latencyMs}ms` : ''}
                        </span>
                        <Button size="xs" variant="ghost" onClick={() => rerunOne(c.id)}>{t('diagnostic.rerun')}</Button>
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </ScrollArea>

        {/* 底部工具栏 */}
        <div className="flex flex-wrap items-center gap-2 px-6 py-4 border-t border-subtle">
          <Button size="sm" variant="secondary" onClick={runKernel}><Bug className="w-3.5 h-3.5" /> {t('diagnostic.kernelCheck')}</Button>
          <Button size="sm" variant="secondary" onClick={doExport}><FileText className="w-3.5 h-3.5" /> {t('diagnostic.exportReport')}</Button>
          <Button size="sm" variant="ghost" onClick={() => window.ponosDiag?.openLogDir()}><FolderOpen className="w-3.5 h-3.5" /> {t('diagnostic.openLogDir')}</Button>
          {kernelResult && (
            <pre className="flex-1 min-w-0 text-[11px] font-mono text-secondary bg-elevated rounded-md px-3 py-2 overflow-x-auto">
              {kernelResult.stdout || kernelResult.stderr || `exit=${kernelResult.ok ? 0 : '非0'}`}
            </pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
