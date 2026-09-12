// src/components/settings/LogsPanel.tsx —— 设置页「日志」分区（2026-09-12）
// 运行日志本地持久化策略：开关 / 等级 / 三项上限 + [打开日志目录] [立即清理]
// + 文件表 + 只读查看器（最近 200 行，可刷新可复制）。
//
// 数据流：策略存在 config.json（桥 config），本面板改的就是 settings.logPolicy →
// 由 SettingsView.handleSave 一并落盘；写入端（桥/主进程）按 TTL(5s) 重读，无需重启。
// 文件表/查看器/清理走 /logs/* 端点（server/logs-routes.mjs）。
// persist:false = **只停止写入，绝不删除已有日志** → 表格与查看器照常可用。

import { useCallback, useEffect, useState } from 'react'
import { FileText, FolderOpen, Trash2, RefreshCw, Copy, AlertTriangle, Check } from 'lucide-react'
import { useSettingsStore } from '@/stores/settingsStore'
import { useTranslation } from '@/i18n/useTranslation'
import {
  LOG_LEVELS, LOG_POLICY_LIMITS, bytesToMb, clampInt, formatBytes, formatLogAge,
  mbToBytes, normalizeLogPolicyUi, pickDefaultLogFile, type LogFileInfo, type LogLevel,
} from '@/lib/logUi'
import { fetchLogsList, fetchLogTail, pruneLogs } from '@/lib/logs'
import { cn } from '@/lib/utils'

/** 查看器固定 200 行：够看现场，又不至于把 DOM 塞爆（内核侧上限 500） */
const VIEW_LINES = 200

const LEVEL_LABEL_KEY: Record<LogLevel, string> = {
  debug: 'logs.levelDebug', info: 'logs.levelInfo', warn: 'logs.levelWarn', error: 'logs.levelError',
}

export function LogsPanel() {
  const { t } = useTranslation()
  const settings = useSettingsStore(s => s.settings)
  const updateSettings = useSettingsStore(s => s.updateSettings)
  const policy = normalizeLogPolicyUi(settings.logPolicy)

  const [dir, setDir] = useState('')
  const [files, setFiles] = useState<LogFileInfo[]>([])
  const [selected, setSelected] = useState('app.log')
  const [tail, setTail] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [copied, setCopied] = useState(false)

  const patch = (up: Partial<typeof policy>) => updateSettings({ logPolicy: normalizeLogPolicyUi({ ...policy, ...up }) })

  const refresh = useCallback(async () => {
    const list = await fetchLogsList()
    if (!list.ok) { setMsg(list.error || ''); return }
    setDir(list.dir || '')
    const next = list.files || []
    setFiles(next)
    // 选中的文件可能已被清理（[立即清理] 会把主文件改名成 .1）→ 自动改选有内容的那个
    setSelected(prev => (next.some(f => f.name === prev) ? prev : pickDefaultLogFile(next)))
  }, [])

  const loadTail = useCallback(async (file: string) => {
    const r = await fetchLogTail(file, VIEW_LINES)
    setTail(r.ok ? (r.lines || []) : [`(${r.error || 'error'})`])
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => { void loadTail(selected) }, [selected, loadTail])

  const onPrune = async () => {
    setBusy(true)
    setMsg('')
    const r = await pruneLogs()
    if (r.ok) {
      setMsg((r.removed ?? 0) > 0
        ? t('logs.pruneDone', { n: r.removed ?? 0, size: formatBytes(r.freedBytes ?? 0) })
        : t('logs.pruneNone'))
    } else {
      setMsg(r.error || '')
    }
    await refresh()
    await loadTail(selected)
    setBusy(false)
    setTimeout(() => setMsg(''), 5000)
  }

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(tail.join('\n'))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* 剪贴板不可用：静默（用户可手动选中复制） */ }
  }

  const numField = (
    labelKey: string, descKey: string, value: number, toUi: (v: number) => number,
    fromUi: (v: number) => number, onSet: (v: number) => void, step = 1, descParams?: Record<string, string | number>,
  ) => (
    <div>
      <label className="text-[11px] text-secondary block mb-1">{t(labelKey)}</label>
      <input
        type="number"
        step={step}
        value={toUi(value)}
        onChange={e => onSet(fromUi(Number(e.target.value)))}
        className="w-32 px-2 py-1 rounded bg-inset border border-border text-xs text-primary tabular-nums outline-none focus:border-brand-500"
      />
      <p className="text-[10px] text-tertiary mt-1">{t(descKey, descParams)}</p>
    </div>
  )

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-primary mb-1 flex items-center gap-2">
          <FileText className="w-4 h-4" />
          {t('logs.sectionTitle')}
        </h3>
        <p className="text-xs text-tertiary">{t('logs.sectionDesc')}</p>
      </div>

      {!policy.persist && (
        <div className="rounded-lg border border-warning/50 bg-warning/10 px-3 py-2 flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-warning mt-0.5 shrink-0" />
          <p className="text-[10px] text-secondary leading-snug">{t('logs.persistOffBanner')}</p>
        </div>
      )}

      {/* 持久化开关 */}
      <div className="flex items-start gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={policy.persist}
          onClick={() => patch({ persist: !policy.persist })}
          className={cn(
            'mt-0.5 w-9 h-5 rounded-full shrink-0 transition-colors relative',
            policy.persist ? 'bg-brand-500' : 'bg-inset border border-border'
          )}
        >
          <span className={cn(
            'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all',
            policy.persist ? 'left-[18px]' : 'left-0.5'
          )} />
        </button>
        <div className="min-w-0">
          <p className="text-xs text-primary">{t('logs.persist')}</p>
          <p className="text-[10px] text-tertiary mt-0.5 leading-snug">{t('logs.persistDesc')}</p>
        </div>
      </div>

      {/* 等级 + 三项上限 */}
      <div className={cn('space-y-3', !policy.persist && 'opacity-60')}>
        <div>
          <label className="text-[11px] text-secondary block mb-1">{t('logs.level')}</label>
          <select
            value={policy.level}
            onChange={e => patch({ level: e.target.value as LogLevel })}
            className="w-48 px-2 py-1 rounded bg-inset border border-border text-xs text-primary outline-none focus:border-brand-500"
          >
            {LOG_LEVELS.map(lv => <option key={lv} value={lv}>{t(LEVEL_LABEL_KEY[lv])}</option>)}
          </select>
          <p className="text-[10px] text-tertiary mt-1">{t('logs.levelDesc')}</p>
        </div>

        <div className="flex flex-wrap gap-6">
          {numField(
            'logs.maxFile', 'logs.maxFileDesc', policy.maxFileBytes,
            bytesToMb, mbToBytes,
            v => patch({ maxFileBytes: v }), 0.5,
            { min: bytesToMb(LOG_POLICY_LIMITS.minFileBytes), max: bytesToMb(LOG_POLICY_LIMITS.maxFileBytes) },
          )}
          {numField(
            'logs.maxFiles', 'logs.maxFilesDesc', policy.maxFiles,
            v => v, v => clampInt(v, LOG_POLICY_LIMITS.minFiles, LOG_POLICY_LIMITS.maxFiles, policy.maxFiles),
            v => patch({ maxFiles: v }), 1,
            { max: LOG_POLICY_LIMITS.maxFiles },
          )}
          {numField(
            'logs.maxAge', 'logs.maxAgeDesc', policy.maxAgeDays,
            v => v, v => clampInt(v, LOG_POLICY_LIMITS.minAgeDays, LOG_POLICY_LIMITS.maxAgeDays, policy.maxAgeDays),
            v => patch({ maxAgeDays: v }), 1,
            { max: LOG_POLICY_LIMITS.maxAgeDays },
          )}
        </div>
      </div>

      {/* 操作区 */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => window.yfwDiag?.openLogDir?.()}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] text-secondary border border-border hover:bg-elevated transition-colors"
        >
          <FolderOpen className="w-3.5 h-3.5" />{t('logs.openDir')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onPrune()}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] text-secondary border border-border hover:bg-elevated transition-colors disabled:opacity-50"
        >
          <Trash2 className="w-3.5 h-3.5" />{t('logs.prune')}
        </button>
        <button
          type="button"
          onClick={() => { void refresh(); void loadTail(selected) }}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] text-secondary border border-border hover:bg-elevated transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />{t('logs.refresh')}
        </button>
        {msg && <span className="text-[10px] text-tertiary">{msg}</span>}
      </div>
      <p className="text-[10px] text-tertiary leading-snug">{t('logs.pruneDesc')}</p>

      {/* 文件表 */}
      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-[11px]">
          <thead className="bg-elevated text-tertiary">
            <tr>
              <th className="text-left font-normal px-3 py-1.5">{t('logs.file')}</th>
              <th className="text-right font-normal px-3 py-1.5 w-24">{t('logs.size')}</th>
              <th className="text-right font-normal px-3 py-1.5 w-24">{t('logs.modified')}</th>
            </tr>
          </thead>
          <tbody>
            {files.length === 0 && (
              <tr><td colSpan={3} className="px-3 py-2 text-tertiary">{t('logs.empty')}</td></tr>
            )}
            {files.map(f => (
              <tr
                key={f.name}
                onClick={() => setSelected(f.name)}
                className={cn(
                  'cursor-pointer border-t border-border transition-colors',
                  selected === f.name ? 'bg-brand-500/10 text-primary' : 'text-secondary hover:bg-elevated'
                )}
              >
                <td className="px-3 py-1.5 font-mono">{f.name}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{formatBytes(f.size)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{formatLogAge(f.mtimeMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 查看器 */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-[11px] text-secondary">
            {t('logs.viewer')} · <span className="font-mono text-tertiary">{selected}</span>
            <span className="text-tertiary"> · {t('logs.viewerHint', { n: VIEW_LINES })}</span>
          </p>
          <button
            type="button"
            onClick={() => void onCopy()}
            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] text-secondary border border-border hover:bg-elevated transition-colors"
          >
            {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            {copied ? t('logs.copied') : t('logs.copy')}
          </button>
        </div>
        <pre className="h-64 overflow-auto rounded-lg border border-border bg-inset px-3 py-2 text-[10px] leading-relaxed font-mono text-secondary whitespace-pre-wrap break-all">
          {tail.length > 0 ? tail.join('\n') : t('logs.empty')}
        </pre>
        <p className="text-[10px] text-tertiary mt-1.5 leading-snug">
          {t('logs.dirLabel')}: <span className="font-mono">{dir || '—'}</span>
        </p>
        <p className="text-[10px] text-tertiary leading-snug">{t('logs.dirHint')}</p>
      </div>
    </div>
  )
}
