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
import { AlertTriangle, ArrowLeft, CheckCircle2, Loader2, LogIn, Play, Radio, Settings2, ShieldCheck, Wrench } from 'lucide-react'
import { Button, Input } from '@/components/ui'
import { useTranslation } from '@/i18n/useTranslation'
import { VERDICT_COPY, groupCapabilities, normalizeSurface, reviewSummary, summarizeSpec } from '@/lib/appSurface'
import { SpecEditor } from './SpecEditor'
import type { AppSurface } from '@/lib/appSurface'
import type { AppCheckResult, AppItem, AppRepairResult, AppRunResult, AppSpec, AppSpecCommand } from '@/types'

export function AppConsole({ app, sessionId, onBack }: {
  app: AppItem
  sessionId: string | null
  onBack: () => void
}) {
  const { t } = useTranslation()
  const api = window.yfworkingAPI
  const [spec, setSpec] = useState<AppSpec | null>(null)
  const [check, setCheck] = useState<AppCheckResult | null>(null)
  // 能力清单（M5）：按需探测，不在进入控制台时自动跑——web 探测要开一次隐藏浏览器，
  // desktop 探测会真的执行 --help（最长 5s/层），"只是看一眼命令"不该付这个成本。
  const [surface, setSurface] = useState<AppSurface | null>(null)
  const [probing, setProbing] = useState(false)
  const [probeMsg, setProbeMsg] = useState<string | null>(null)
  const [checking, setChecking] = useState(true)
  const [argValues, setArgValues] = useState<Record<string, Record<string, string>>>({})
  const [pending, setPending] = useState<AppSpecCommand | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  const [result, setResult] = useState<{ action: string; r: AppRunResult } | null>(null)
  const [bound, setBound] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [repairing, setRepairing] = useState(false)
  const [repair, setRepair] = useState<AppRepairResult | null>(null)
  const [loggingIn, setLoggingIn] = useState(false)
  const [loginMsg, setLoginMsg] = useState<string | null>(null)

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

  /**
   * 探测接入路径：复用既有 app:probe（返回值在 M5 起带上 surface）。
   * 无论成功失败都给出反馈——清单是"为什么这么接"的唯一解释，静默失败等于让用户猜。
   */
  const onProbeSurface = useCallback(async () => {
    if (!spec?.target) { setProbeMsg('尚未读取到 Spec，无法探测'); return }
    setProbing(true)
    setProbeMsg(null)
    try {
      const r = await api?.appProbe?.({ target: spec.target })
      const s = normalizeSurface(r?.surface)
      setSurface(s)
      if (!r?.ok) setProbeMsg(r?.error || '探测失败')
      else if (!s) setProbeMsg(r?.error || '本次未取得能力清单（可能缺少程序路径或浏览器执行器未就绪）')
      else setProbeMsg(null)
    } catch (e) {
      setProbeMsg(String((e as Error)?.message || e))
    } finally {
      setProbing(false)
    }
  }, [api, spec])

  /**
   * 打开登录窗口（用户主动触发，与应用命令/模型探索共用同一浏览器会话）。
   * 自动化窗口平时是隐藏的，没有这个入口用户就无处登录，登录态探索也就无从谈起。
   * 无论成功失败都给出反馈——不得静默。
   */
  const openLogin = useCallback(async () => {
    const url = spec?.target?.type === 'web' ? spec.target.url : ''
    if (!url) { setLoginMsg(t('apps.loginNoUrl')); return }
    setLoggingIn(true)
    setLoginMsg(null)
    try {
      const r = await api?.appLogin?.({ url, sessionId: sessionId || undefined })
      setLoginMsg(r?.ok ? t('apps.loginOpened') : (r?.error || t('apps.loginFail')))
    } catch (e) {
      setLoginMsg(String((e as Error)?.message || e))
    } finally {
      setLoggingIn(false)
    }
  }, [api, spec, sessionId, t])

  /**
   * 漂移修复：只修"最近一次执行失败"的命令（后端按 history 判定），
   * 写盘前自动备份、修完整体再校验，不合法就整体放弃。
   * 无论成功失败都把返回结果原样展示——不得静默。
   */
  const onRepair = useCallback(async () => {
    setRepairing(true)
    setRepair(null)
    try {
      const r = await api?.appRepair?.({ appId: app.id })
      setRepair(r ?? null)
      if (r?.ok) await runCheck()
    } catch (e) {
      setRepair({ ok: false, reason: String((e as Error)?.message || e), repaired: [], failed: [], backup: null })
    } finally {
      setRepairing(false)
    }
  }, [api, app.id, runCheck])

  const commands = useMemo(() => spec?.commands ?? [], [spec])

  /**
   * 评审结论（M4 的 spec.review，质量结论要看得见）。
   * ★ review 已正式进 AppSpec 类型，这里直接用 spec?.review；老 spec.json 没这个字段时为 undefined，
   *   reviewSummary 内部按"无评审记录"处理（不编内容）。
   */
  const reviewText = reviewSummary(spec?.review)

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
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            <Settings2 className="w-3 h-3" />{t('apps.editSpec')}
          </Button>
          {/* 登录入口：自动化窗口是隐藏的，没有它就无处可登录；登录后命令与模型探索都带上该登录态 */}
          {spec?.target?.type === 'web' && (
            <Button
              size="sm"
              variant="ghost"
              disabled={loggingIn}
              title={t('apps.loginHint')}
              onClick={() => void openLogin()}
            >
              {loggingIn ? <Loader2 className="w-3 h-3 animate-spin" /> : <LogIn className="w-3 h-3" />}
              {t('apps.login')}
            </Button>
          )}
          {(check?.status === 'drifted' || check?.status === 'broken' || (check?.issues?.length ?? 0) > 0) && (
            <Button size="sm" variant="ghost" disabled={repairing || check?.status === 'broken'}
              title={check?.status === 'broken' ? t('apps.repairBroken') : undefined}
              onClick={() => void onRepair()}>
              {repairing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wrench className="w-3 h-3" />}{t('apps.repair')}
            </Button>
          )}
        </div>
        {!!check?.issues?.length && (
          <ul className="flex flex-col gap-1 px-3 py-2 rounded bg-warning/10">
            {check.issues.map((i, idx) => <li key={idx} className="text-[10px] text-warning">{i}</li>)}
          </ul>
        )}

        {/* 接入路径（能力清单，M5）：三段与后端 renderSurfaceReport 一一对应——
            已实测 / 待确认 / 已排除。三分措辞由 VERDICT_COPY 统一供给，
            weak（证据不足）不得被降级说成不可接入——该措辞协议由 src/lib/appSurface.test.ts 钉住。 */}
        <div className="rounded-lg border border-subtle bg-elevated p-3 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold text-tertiary uppercase tracking-wider">接入路径（能力清单）</span>
            {surface && (
              <span className={
                surface.verdict === 'connectable' ? 'text-[9px] px-1 py-0.5 rounded bg-success/20 text-success'
                  : surface.verdict === 'weak' ? 'text-[9px] px-1 py-0.5 rounded bg-warning/20 text-warning'
                    : 'text-[9px] px-1 py-0.5 rounded bg-error/20 text-error'
              }>{VERDICT_COPY[surface.verdict].label}</span>
            )}
            <div className="flex-1" />
            <Button size="sm" variant="ghost" disabled={probing} onClick={() => void onProbeSurface()}>
              {probing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Radio className="w-3 h-3" />}
              探测接入路径
            </Button>
          </div>
          <div className="text-[10px] text-secondary">{summarizeSpec(spec)}</div>
          {surface && <p className="text-[10px] text-secondary">{VERDICT_COPY[surface.verdict].detail}</p>}
          {probeMsg && <div className="text-[10px] text-warning">{probeMsg}</div>}
          {!surface && !probeMsg && (
            <p className="text-[10px] text-tertiary">点「探测接入路径」查看该应用有哪些可控通道、各自的证据与下一步（探测会真实访问目标，可能需要几秒）。</p>
          )}
          {surface && (() => {
            const g = groupCapabilities(surface)
            const Section = ({ title, items, tone }: { title: string; items: typeof g.verified; tone: string }) => (
              items.length === 0 ? null : (
                <div className="flex flex-col gap-0.5">
                  <div className={`text-[10px] ${tone}`}>{title}</div>
                  {items.map((c) => (
                    <div key={c.channel} className="text-[10px] text-secondary">
                      <span className="font-mono">{c.channel}</span>
                      {c.driver ? <span className="text-tertiary">{` → ${c.driver}`}</span> : null}
                      {'：'}{c.label}
                      {c.evidence ? <span className="text-tertiary">{'（'}{c.evidence}{'）'}</span> : null}
                      {c.next ? <div className="text-tertiary pl-3">下一步：{c.next}</div> : null}
                    </div>
                  ))}
                </div>
              )
            )
            return (
              <>
                <Section title="已实测可用" items={g.verified} tone="text-success" />
                <Section title="待进一步确认（证据不足，尚不能断言可行）" items={g.probable} tone="text-warning" />
                <Section title="已排查且不成立" items={g.dead} tone="text-tertiary" />
              </>
            )
          })()}
        </div>

        {/* 评审结论（M4 写入 spec.review）：质量结论在面板上要看得见，而不是只留在生成过程里 */}
        {reviewText && (
          <div className="px-3 py-2 rounded bg-input text-[10px] text-secondary">{reviewText}</div>
        )}

        {/* 登录反馈：无论成功失败都要说清（登录态探索依赖它） */}
        {loginMsg && (
          <div className="px-3 py-2 rounded bg-info/10 text-[10px] text-secondary">{loginMsg}</div>
        )}

        {/* 修复结果：改动明细必须展示出来，不能"修了但不说改了啥" */}
        {repair && (
          <div className={'rounded-lg border p-3 flex flex-col gap-1.5 ' + (repair.ok ? 'border-success/40 bg-success/10' : 'border-warning/40 bg-warning/10')}>
            <div className={'text-[11px] ' + (repair.ok ? 'text-success' : 'text-warning')}>
              {repair.ok
                ? t('apps.repairDone', { n: repair.repaired.length })
                : (repair.reason || t('apps.repairNone'))}
            </div>
            {repair.ok && !!repair.repaired.length && (
              <div className="flex flex-col gap-0.5">
                <div className="text-[10px] text-tertiary">{t('apps.repairDetail')}</div>
                {repair.repaired.map((x) => (
                  <div key={x.action} className="text-[10px] text-secondary">
                    <span className="font-mono">{x.action}</span>
                    {'：'}{x.from.title || '(无标题)'}{' → '}{x.to.title || '(无标题)'}
                    <span className="text-tertiary">{'（'}{x.reason}{'）'}</span>
                  </div>
                ))}
              </div>
            )}
            {!!repair.failed.length && (
              <div className="text-[10px] text-warning">
                {t('apps.repairFailed', { n: repair.failed.length })}
                {'：'}{repair.failed.map((f) => `${f.action}（${f.reason}）`).join('；')}
              </div>
            )}
            {repair.backup && <div className="text-[10px] text-tertiary">{t('apps.repairBackup', { name: repair.backup })}</div>}
            {!repair.ok && <div className="text-[10px] text-tertiary">{t('apps.repairNotRun')}</div>}
          </div>
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
                  <span className="text-[9px] px-1 py-0.5 rounded bg-input text-tertiary font-mono" title="这条命令的执行后端">
                    {spec?.driver || '—'}
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
        {editing && (
          <SpecEditor appId={app.id} appName={app.name}
            onClose={() => setEditing(false)}
            onSaved={() => void runCheck()} />
        )}

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
