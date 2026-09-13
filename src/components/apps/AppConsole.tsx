// 应用控制台（Task 2.3）
//
// 三个职责，缺一不可：
//   1. 进入即绑定 / 离开即解绑（AI 能调这个应用 ↔ 不能调），严格单开由主进程保证；
//   2. 进入前自检（app:check）——broken 时给出可见警告，但不阻断（用户常需进去改 Spec）；
//   3. 手工执行命令：read 直接跑；write 需**二次确认**（写操作会在目标应用产生真实改动）。
//
// ★ 为什么写操作要二次确认：控制台是人工点按的路径，没有内核侧审批链兜底
//   （内核侧审批只覆盖 AI 调用）。漏了这一步，用户点一下就可能真的提交/删除数据。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowLeft, CheckCircle2, Loader2, Play, ShieldCheck } from 'lucide-react'
import { Button, Input } from '@/components/ui'
import { useTranslation } from '@/i18n/useTranslation'
import type { AppCheckResult, AppItem, AppRunResult, AppSpec, AppSpecCommand } from '@/types'

export function AppConsole({ app, sessionId, onBack }: {
  app: AppItem
  sessionId: string | null
  onBack: () => void
}) {
  const { t } = useTranslation()
  const api = window.yfworkingAPI
  const [spec, setSpec] = useState<AppSpec | null>(null)
  const [check, setCheck] = useState<AppCheckResult | null>(null)
  const [checking, setChecking] = useState(true)
  const [argValues, setArgValues] = useState<Record<string, Record<string, string>>>({})
  const [pending, setPending] = useState<AppSpecCommand | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  const [result, setResult] = useState<{ action: string; r: AppRunResult } | null>(null)
  const [bound, setBound] = useState<string | null>(null)

  // ---- 绑定生命周期：进入即绑、离开即解绑、依赖 sessionId 变化重绑 ----
  useEffect(() => {
    if (!sessionId) return
    let alive = true
    void api?.appEnterConsole?.({ sessionId, appId: app.id })
      .then((r: { ok?: boolean; appId?: string } | undefined) => { if (alive) setBound(r?.appId ?? app.id) })
      .catch(() => { /* 绑定失败不阻断控制台（本地执行不需要绑定） */ })
    return () => {
      alive = false
      // 解绑必须带上 appId：主进程按 appId 校验，避免"迟到的离开事件"清掉用户刚切过去的另一个应用
      void api?.appLeaveConsole?.({ sessionId, appId: app.id })?.catch?.(() => {})
      setBound(null)
    }
  }, [api, app.id, sessionId])

  // ---- 载入 Spec + 自检 ----
  const runCheck = useCallback(async () => {
    setChecking(true)
    try {
      const s = await api?.appReadSpec?.(app.id)
      setSpec(s ?? null)
      const c = await api?.appCheck?.(app.id)
      setCheck(c ?? null)
    } finally {
      setChecking(false)
    }
  }, [api, app.id])

  useEffect(() => { void runCheck() }, [runCheck])

  const commands = useMemo(() => spec?.commands ?? [], [spec])

  function setArg(action: string, name: string, value: string) {
    setArgValues((prev) => ({ ...prev, [action]: { ...(prev[action] || {}), [name]: value } }))
  }

  async function execute(cmd: AppSpecCommand) {
    setPending(null)
    setRunning(cmd.action)
    setResult(null)
    try {
      const r = await api?.appRun?.({ appId: app.id, action: cmd.action, args: argValues[cmd.action] || {}, sessionId: sessionId || undefined })
      setResult({ action: cmd.action, r: r as AppRunResult })
    } catch (e) {
      setResult({ action: cmd.action, r: { ok: false, data: null, error: String((e as Error)?.message || e), kind: cmd.kind, durationMs: 0 } })
    } finally {
      setRunning(null)
    }
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      <div className="flex items-center gap-2 px-4 h-11 shrink-0 border-b border-subtle">
        <Button size="sm" variant="ghost" onClick={onBack} title={t('apps.back')}>
          <ArrowLeft className="w-3.5 h-3.5" />
        </Button>
        <h2 className="text-xs font-semibold text-primary truncate">{app.name || app.id}</h2>
        <span className="text-[10px] text-tertiary font-mono truncate">{spec?.driver || ''}</span>
        <div className="flex-1" />
        {sessionId ? (
          <span className="flex items-center gap-1 text-[10px] text-success" title={t('apps.aiBoundHint')}>
            <ShieldCheck className="w-3.5 h-3.5" />
            {bound ? t('apps.aiBound') : '…'}
          </span>
        ) : (
          <span className="text-[10px] text-tertiary" title={t('apps.noSession')}>—</span>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-4 flex flex-col gap-3">
        {/* 自检结果 */}
        <div className="flex items-center gap-2 text-[11px]">
          {checking ? (
            <span className="flex items-center gap-1 text-tertiary"><Loader2 className="w-3.5 h-3.5 animate-spin" />{t('apps.checking')}</span>
          ) : check?.status === 'healthy' ? (
            <span className="flex items-center gap-1 text-success"><CheckCircle2 className="w-3.5 h-3.5" />{t('apps.checkOk')}</span>
          ) : check?.status === 'drifted' ? (
            <span className="flex items-center gap-1 text-warning"><AlertTriangle className="w-3.5 h-3.5" />{t('apps.checkDrift')}</span>
          ) : (
            <span className="flex items-center gap-1 text-error"><AlertTriangle className="w-3.5 h-3.5" />{t('apps.checkBroken')}</span>
          )}
          <Button size="sm" variant="ghost" onClick={() => void runCheck()}>{t('apps.recheck')}</Button>
        </div>
        {!!check?.issues?.length && (
          <ul className="flex flex-col gap-1 px-3 py-2 rounded bg-warning/10">
            {check.issues.map((i, idx) => <li key={idx} className="text-[10px] text-warning">{i}</li>)}
          </ul>
        )}
        {!sessionId && <div className="text-[10px] text-tertiary">{t('apps.noSession')}</div>}

        {/* 命令列表 */}
        <div className="text-[11px] font-semibold text-tertiary uppercase tracking-wider">{t('apps.commands')}</div>
        {commands.length === 0 ? (
          <p className="text-[11px] text-tertiary">{t('apps.noCommands')}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {commands.map((cmd) => (
              <div key={cmd.action} className="rounded-lg bg-elevated border border-subtle p-3 flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-primary">{cmd.title || cmd.action}</span>
                  <span className="text-[9px] px-1 py-0.5 rounded bg-input text-tertiary font-mono">{cmd.action}</span>
                  <span className={cmd.kind === 'write' ? 'text-[9px] px-1 py-0.5 rounded bg-warning/20 text-warning' : 'text-[9px] px-1 py-0.5 rounded bg-input text-tertiary'}>
                    {cmd.kind}
                  </span>
                  <div className="flex-1" />
                  <Button size="sm" variant={cmd.kind === 'write' ? 'secondary' : 'primary'}
                    disabled={running !== null}
                    onClick={() => (cmd.kind === 'write' ? setPending(cmd) : void execute(cmd))}>
                    {running === cmd.action ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                    {cmd.kind === 'write' ? t('apps.runWrite') : t('apps.runRead')}
                  </Button>
                </div>
                {!!cmd.params?.length && (
                  <div className="flex flex-col gap-1.5">
                    {cmd.params.map((p) => (
                      <div key={p.name} className="flex items-center gap-2">
                        <span className="text-[10px] text-secondary w-28 shrink-0 truncate">
                          {p.name}{p.required ? ' *' : ''}
                        </span>
                        <Input
                          value={argValues[cmd.action]?.[p.name] ?? ''}
                          onChange={(e) => setArg(cmd.action, p.name, e.target.value)}
                          placeholder={p.desc || p.type || ''}
                          className="h-6 text-[11px] flex-1"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* 结果 */}
        {result && (
          <div className="flex flex-col gap-1">
            <div className="text-[11px] font-semibold text-tertiary uppercase tracking-wider">{t('apps.result')}</div>
            <div className={`rounded border p-2 text-[11px] font-mono whitespace-pre-wrap break-all ${result.r.ok ? 'border-subtle text-primary' : 'border-error/40 text-error'}`}>
              {result.r.ok
                ? (typeof result.r.data === 'string' ? result.r.data : JSON.stringify(result.r.data, null, 2))
                : result.r.error}
            </div>
            <div className="text-[10px] text-tertiary">{t('apps.duration')} {result.r.durationMs}ms</div>
          </div>
        )}

        {/* 写操作二次确认 */}
        {pending && (
          <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 flex flex-col gap-2">
            <div className="flex items-center gap-2 text-[11px] text-warning">
              <AlertTriangle className="w-3.5 h-3.5" />
              {t('apps.writeConfirm')}
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" onClick={() => setPending(null)}>{t('apps.cancel')}</Button>
              <Button size="sm" variant="danger" onClick={() => void execute(pending)}>{t('apps.confirm')}</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
