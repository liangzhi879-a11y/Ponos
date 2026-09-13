// 新增应用对话框（Task 1.6 表单 + Task 3.1/3.2 生成与试跑 + 如实进度展示）
//
// 流程：填目标 → 「生成命令」（**后台取页面素材** → LLM ≤3 轮 → 结构校验 → read 试跑）
//      → 预览确认（试跑未通过默认不允许保存，可显式选择「仍要保存（未验证）」）
//      → 保存 / 重新生成 / 手工改 JSON
//
// ★ 素材获取不需要打开浏览器（2026-09-13 真实反馈后的调整）：
//   原先必须先经内置浏览器探测，而它受自动化白名单保护（默认 *.gov.cn/localhost）；
//   给 kimi.com 这类站点生成命令会直接失败。现在主进程在**后台用普通 HTTP** 取页面素材，
//   用户无感；只有"静态素材不足且域名在白名单内"时才额外用浏览器取真实 DOM（可选增强）。
//
// ★ 进度展示的原则是「如实」：
//   · 阶段（取素材/浏览器探测/请求模型/接收/解析/回喂/试跑）全部来自主进程真实代码路径的事件；
//   · 字符数与耗时是真实计数，**没有百分比进度条**（百分比只能靠编）；
//   · 模型输出实时尾部是**真实流式内容**（不是假打字机效果）；
//   · 失败时显示模型说的真实原因，并把"收到一半就断了"的部分文本一并展示；
//   · 未取得素材时**明说**"命令是推断的、需核对"，不假装探测过。
'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowRight, CheckCircle2, FileJson, Loader2, RefreshCw, Sparkles } from 'lucide-react'
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input, Textarea } from '@/components/ui'
import { useTranslation } from '@/i18n/useTranslation'
import type { AppGenerateProgress, AppGenerateResult, AppProbeResult, AppSpec, AppTargetType, AppVerifyResult } from '@/types'

const ID_RE = /^[a-zA-Z0-9_-]+$/
/** 阶段顺序（用于把"已到达"的阶段点亮；只是展示顺序，不代表会全部发生） */
const PHASE_ORDER: AppGenerateProgress['phase'][] = ['fetch', 'probe', 'round', 'explore', 'stream', 'parse', 'invalid', 'quality', 'parsed', 'verify', 'done']

/**
 * 网址归一：用户从地址栏复制的常常不带协议头（`kimi.com`），而取素材与域名授权都要能解析它——
 * 不补协议头，两步都会静默降级（素材空 + 未授权），表现就是"生成了但完全没效果"。
 * 主进程还会再归一一次（权威），这里只为让**界面上显示的就是实际会访问的地址**。
 * 规则与 electron/app-util.cjs 的 normalizeUrl 保持一致。
 */
function normalizeWebUrl(input: string): string {
  const s = input.trim()
  if (!s) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s
  if (/^(mailto|javascript|data|tel|ftp|about|chrome):/i.test(s)) return s
  const host = s.split(/[/?#]/)[0]
  return /^(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?$/i.test(host) ? `http://${s}` : `https://${s}`
}

function skeletonSpec({ id, name, type, url, exePath }: {
  id: string; name: string; type: AppTargetType; url: string; exePath: string
}): AppSpec {
  return {
    specVersion: 1,
    appId: id,
    name,
    driver: type === 'web' ? 'browser' : 'uia',
    target: type === 'web' ? { type, url } : { type, exePath },
    expose: { mode: 'console' },
    commands: [],
  }
}

export function AddAppDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [type, setType] = useState<AppTargetType>('web')
  const [url, setUrl] = useState('')
  const [exePath, setExePath] = useState('')
  const [probe, setProbe] = useState<AppProbeResult | null>(null)
  const [probing, setProbing] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  // ---- 生成相关 ----
  const [prog, setProg] = useState<AppGenerateProgress | null>(null)
  const [seen, setSeen] = useState<AppGenerateProgress['phase'][]>([])
  const [tail, setTail] = useState('')
  const [chars, setChars] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [gen, setGen] = useState<AppGenerateResult | null>(null)
  const [jsonDraft, setJsonDraft] = useState('')
  const [showJson, setShowJson] = useState(false)
  const [verify, setVerify] = useState<AppVerifyResult | null>(null)
  /** 用户显式选择"未验证也保存"——默认关闭，避免糊里糊涂存下不可用命令 */
  const [forceSave, setForceSave] = useState(false)
  const startedAt = useRef<number | null>(null)
  const streamBuf = useRef('')

  const api = window.yfworkingAPI
  const target = type === 'web' ? { type, url: normalizeWebUrl(url) } : { type, exePath: exePath.trim() }
  const targetReady = type === 'web' ? !!normalizeWebUrl(url) : !!exePath.trim()

  // ---- 订阅真实进度事件；卸载必须退订（否则渲染层残留监听）----
  useEffect(() => {
    const off = api?.onAppGenerateProgress?.((p) => {
      setProg(p)
      setSeen((prev) => (prev.includes(p.phase) ? prev : [...prev, p.phase]))
      if (typeof p.chars === 'number') setChars(p.chars)
      // 真实流式内容追加（主进程做了节流，见 app-generate.cjs 的 150ms/200字符）
      if (p.delta) {
        streamBuf.current = (streamBuf.current + p.delta).slice(-4000)
        setTail(streamBuf.current)
      }
    })
    return () => { try { off?.() } catch { /* 已卸载 */ } }
  }, [api])

  // ---- 计时器：真实秒表（不参与进度计算，只如实显示过了多久）----
  useEffect(() => {
    if (startedAt.current == null) return
    const timer = setInterval(() => setElapsed(Date.now() - (startedAt.current || 0)), 200)
    return () => clearInterval(timer)
  }, [startedAt.current, prog?.phase])

  const onProbe = useCallback(async () => {
    setProbing(true); setProbe(null); setError('')
    try {
      setProbe((await api?.appProbe?.({ target })) ?? null)
    } catch (e) {
      setError(String((e as Error)?.message || e))
    } finally { setProbing(false) }
  }, [api, target])

  async function onGenerate() {
    setError(''); setGen(null); setVerify(null); setProg(null); setSeen([]); setTail(''); setChars(0); setShowJson(false); setForceSave(false)
    streamBuf.current = ''
    startedAt.current = Date.now(); setElapsed(0)
    // 顺手把输入框里的网址补全（kimi.com → https://kimi.com/）：让用户看到系统实际访问的地址，
    // 而不是让他以为"填了却什么都没发生"（真实反馈：输入不带协议头 → 抓取与授权双双静默失败）
    if (type === 'web') {
      const normalized = normalizeWebUrl(url)
      if (normalized && normalized !== url) setUrl(normalized)
    }
    try {
      const r = await api?.appGenerate?.({ target, appId: id || undefined })
      if (!r) { setError(t('apps.genFailed')); return }
      setGen(r)
      setVerify(r.verify ?? null)
      if (!r.ok) setError(r.error || t('apps.genFailed'))
      else setJsonDraft(JSON.stringify(r.spec, null, 2))
    } catch (e) {
      setError(String((e as Error)?.message || e))
    } finally {
      startedAt.current = null
    }
  }

  async function onSave() {
    setError('')
    if (!ID_RE.test(id)) return setError(t('apps.invalidId'))
    if (!name.trim()) return setError(t('apps.needName'))
    let spec: AppSpec
    if (showJson) {
      try { spec = JSON.parse(jsonDraft) as AppSpec } catch (e) { return setError(t('apps.specInvalid', { msg: String((e as Error)?.message || e) })) }
    } else if (gen?.spec) {
      spec = gen.spec
    } else {
      spec = skeletonSpec({ id, name: name.trim(), type, url: normalizeWebUrl(url), exePath: exePath.trim() })
      if (probe?.driver) spec.driver = probe.driver as AppSpec['driver']
    }
    spec = { ...spec, appId: id, name: spec.name || name.trim() }
    setSaving(true)
    try {
      await api?.appUpsert?.({ id, name: name.trim(), desc: desc.trim(), targetType: type, enabled: true })
      await api?.appWriteSpec?.({ appId: id, spec })
      onDone()
    } catch (e) {
      setError(String((e as Error)?.message || e))
    } finally { setSaving(false) }
  }

  const generating = startedAt.current != null
  // 试跑未通过默认禁止保存；但允许用户**显式**选择"仍要保存（未验证）"——
  // 无探测素材时试跑大概率不通过，若不给出口，用户就被卡死在对话框里（真实反馈）
  const verifyOk = verify?.ok ?? false
  const canSave = !generating && !saving && (!gen || (gen.ok && (verifyOk || forceSave)))
  const phaseLabel = (p: AppGenerateProgress['phase']) => t(`apps.phase${p.charAt(0).toUpperCase()}${p.slice(1)}`)

  return (
    <Dialog open onOpenChange={(v: boolean) => { if (!v) onClose() }}>
      <DialogContent size="lg">
        <DialogHeader><DialogTitle>{t('apps.addTitle')}</DialogTitle></DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-2.5">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              <Field label={t('apps.idLabel')}>
                <Input value={id} onChange={(e) => setId(e.target.value)} placeholder="my-app" className="h-7 text-xs flex-1" />
              </Field>
              <Field label={t('apps.name')}>
                <Input value={name} onChange={(e) => setName(e.target.value)} className="h-7 text-xs flex-1" />
              </Field>
              <Field label={t('apps.desc')}>
                <Input value={desc} onChange={(e) => setDesc(e.target.value)} className="h-7 text-xs flex-1" />
              </Field>
              <Field label={t('apps.targetType')}>
                <div className="flex items-center gap-1">
                  <Button size="sm" variant={type === 'web' ? 'primary' : 'secondary'} onClick={() => setType('web')}>{t('apps.targetWeb')}</Button>
                  <Button size="sm" variant={type === 'desktop' ? 'primary' : 'secondary'} onClick={() => setType('desktop')}>{t('apps.targetDesktop')}</Button>
                </div>
              </Field>
            </div>
            {type === 'web' ? (
              <Field label={t('apps.url')}>
                <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" className="h-7 text-xs flex-1" />
              </Field>
            ) : (
              <Field label={t('apps.exePath')}>
                <Input value={exePath} onChange={(e) => setExePath(e.target.value)} placeholder="C:\..." className="h-7 text-xs flex-1" />
              </Field>
            )}

            {/* 动作条：探测 / 生成 */}
            <div className="flex items-center gap-2 pt-0.5">
              <Button size="sm" variant="secondary" onClick={() => void onProbe()} disabled={probing || !targetReady}>
                {probing ? t('apps.probing') : t('apps.probe')}
              </Button>
              <Button size="sm" onClick={() => void onGenerate()} disabled={!targetReady || generating}>
                {generating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                {generating ? t('apps.generating') : gen ? t('apps.regenerating') : t('apps.generate')}
              </Button>
              {probe && (
                <span className="text-[10px] text-tertiary truncate">
                  {probe.reachable === false && probe.error
                    ? t('apps.probeFail', { msg: probe.error })
                    : t('apps.probeOk', { driver: String(probe.driver || '') })}
                  {probe.title ? ` · ${probe.title}` : ''}
                </span>
              )}
            </div>
            {!gen && !generating && <p className="text-[10px] text-tertiary">{t('apps.genHint')}</p>}

            {/* ---- 如实进度面板 ---- */}
            {(generating || seen.length > 0) && (
              <div className="rounded-lg border border-subtle bg-elevated p-3 flex flex-col gap-2">
                <div className="flex items-center gap-3 text-[10px] text-tertiary">
                  <span className="text-secondary">{t('apps.genPhase')}：</span>
                  <span className="text-primary">{prog ? phaseLabel(prog.phase) : '…'}</span>
                  {prog?.round && prog?.maxRounds ? (
                    <span className="px-1 py-0.5 rounded bg-input">{t('apps.genRound', { n: prog.round, total: prog.maxRounds })}</span>
                  ) : null}
                  <span className="flex-1" />
                  <span>{t('apps.genChars')} {chars}</span>
                  <span>{t('apps.genElapsed')} {(elapsed / 1000).toFixed(1)}s</span>
                </div>

                {/* 阶段亮灯：已真实发生过的阶段才亮，无百分比 */}
                <div className="flex items-center gap-1 flex-wrap">
                  {PHASE_ORDER.map((p, i) => {
                    const hit = seen.includes(p)
                    const active = prog?.phase === p && generating
                    return (
                      <span key={p} className="flex items-center gap-1">
                        {i > 0 && <ArrowRight className="w-2.5 h-2.5 text-tertiary/50" />}
                        <span className={
                          'px-1.5 py-0.5 rounded text-[9px] transition-colors ' +
                          (hit ? 'bg-brand-500/15 text-brand-500' : 'bg-input text-tertiary/60') +
                          (active ? ' animate-pulse' : '')
                        }>{phaseLabel(p)}</span>
                      </span>
                    )
                  })}
                </div>

                {/* 不确定型流动条：只表示"正在进行"，不声称进度百分比 */}
                {generating && (
                  <div className="h-0.5 rounded bg-input overflow-hidden">
                    <div className="h-full w-1/3 bg-brand-500/70 animate-[appsIndeterminate_1.2s_ease-in-out_infinite]" />
                  </div>
                )}

                {prog?.detail && <div className="text-[10px] text-secondary">{prog.detail}</div>}
                {!!prog?.issues?.length && (
                  <ul className="flex flex-col gap-0.5">
                    {prog.issues.map((s, i) => <li key={i} className="text-[10px] text-warning">· {s}</li>)}
                  </ul>
                )}

                {/* 真实流式输出尾部（不是假打字机） */}
                {chars > 0 && (
                  <div>
                    <div className="text-[10px] text-tertiary mb-1">{t('apps.genTail')}</div>
                    <pre className="text-[10px] font-mono text-tertiary bg-input/60 rounded p-2 max-h-24 overflow-auto whitespace-pre-wrap break-all">
                      {tail.slice(-600) || '…'}
                    </pre>
                  </div>
                )}
              </div>
            )}

            {/* ---- 结果预览 ---- */}
            {gen?.ok && gen.spec && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold text-tertiary uppercase tracking-wider">{t('apps.preview')}</span>
                  <span className="text-[10px] text-tertiary">{t('apps.previewCommands', { n: gen.spec.commands.length })}</span>
                  {gen.rounds ? <span className="text-[10px] text-tertiary">{t('apps.genRound', { n: gen.rounds, total: gen.rounds })}</span> : null}
                  <span className="flex-1" />
                  <Button size="sm" variant="ghost" onClick={() => setShowJson((v) => !v)}>
                    <FileJson className="w-3 h-3" />{t('apps.editJson')}
                  </Button>
                </div>

                {/* 素材来源如实告知：没拿到素材/素材很薄时必须明说，不能让用户以为已探测过 */}
                {gen.probe && gen.probe.mode !== 'browser' && gen.probe.mode !== 'http' && (
                  <div className="flex items-start gap-1.5 rounded border border-warning/30 bg-warning/10 px-2.5 py-1.5">
                    <AlertCircle className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5" />
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[10px] text-warning">{gen.probe.mode === 'none' ? t('apps.probeUntrusted') : t('apps.probeThin')}</span>
                      {gen.probe.note && <span className="text-[10px] text-tertiary">{gen.probe.note}</span>}
                    </div>
                  </div>
                )}

                {/* 试跑结论（真实结果） */}
                {verify && (
                  <div className="flex flex-col gap-1">
                    <div className={'flex items-center gap-1 text-[11px] ' + (verify.ok ? 'text-success' : 'text-error')}>
                      {verify.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
                      {verify.ok ? t('apps.verifyOk', { n: verify.tried.length }) : t('apps.verifyFail')}
                    </div>
                    {verify.failures.filter((f) => f.action !== '-').map((f) => (
                      <div key={f.action} className="text-[10px] text-error">{f.action}：{f.error}</div>
                    ))}
                    {verify.failures.filter((f) => f.action === '-').map((f, i) => (
                      <div key={i} className="text-[10px] text-warning">{f.error}</div>
                    ))}
                    {!!verify.notRun.length && <div className="text-[10px] text-tertiary">{t('apps.verifyNotRun', { list: verify.notRun.join('、') })}</div>}
                    {!!verify.skipped.length && <div className="text-[10px] text-tertiary">{t('apps.verifySkipped', { list: verify.skipped.join('、') })}</div>}
                  </div>
                )}

                {/* 封装质量提示：不拦交付，但必须让用户知道"覆盖度/说明"哪里还不够
                    （真实反馈就是"命令很少/漏了主要功能"——默默放过等于让用户踩同一个坑） */}
                {!!gen.warnings?.length && (
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-1 text-[11px] text-warning">
                      <AlertCircle className="w-3.5 h-3.5" />{t('apps.qualityWarn')}
                    </div>
                    {[...new Set(gen.warnings)].map((w) => (
                      <div key={w} className="text-[10px] text-tertiary">{w}</div>
                    ))}
                  </div>
                )}

                {showJson ? (
                  <Textarea value={jsonDraft} onChange={(e) => setJsonDraft(e.target.value)}
                    className="w-full text-[11px] font-mono bg-input border rounded p-2 text-primary min-h-[160px]" />
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {gen.spec.commands.map((c) => (
                      <div key={c.action} className="rounded bg-elevated border border-subtle px-2.5 py-1.5 flex items-center gap-2">
                        <span className="text-[11px] text-primary">{c.title || c.action}</span>
                        <span className="text-[9px] font-mono text-tertiary">{c.action}</span>
                        <span className={c.kind === 'write' ? 'text-[9px] px-1 rounded bg-warning/20 text-warning' : 'text-[9px] px-1 rounded bg-input text-tertiary'}>{c.kind}</span>
                        <span className="flex-1" />
                        {!!c.params?.length && <span className="text-[9px] text-tertiary">{c.params.map((p) => p.name).join(', ')}</span>}
                      </div>
                    ))}
                  </div>
                )}
                {!verify?.ok && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] text-warning">{t('apps.confirmBlocked')}</span>
                    <label className="flex items-center gap-1 cursor-pointer select-none">
                      <input type="checkbox" checked={forceSave} className="accent-warning"
                        onChange={(e) => setForceSave(e.target.checked)} />
                      <span className="text-[10px] text-warning underline decoration-dotted">{t('apps.confirmForce')}</span>
                    </label>
                    {forceSave && <span className="text-[10px] text-error">{t('apps.confirmForceWarn')}</span>}
                  </div>
                )}
              </div>
            )}

            {/* 手工粘贴（保留老路径：可以直接贴完整 Spec） */}
            {!gen && (
              <details className="text-[11px]">
                <summary className="cursor-pointer text-tertiary select-none">{t('apps.pasteSpec')}</summary>
                <Textarea value={showJson ? jsonDraft : ''} onChange={(e) => { setShowJson(true); setJsonDraft(e.target.value) }}
                  className="w-full mt-2 text-[11px] font-mono bg-input border rounded p-2 text-primary min-h-[110px]"
                  placeholder='{"specVersion":1,...}' />
              </details>
            )}

            {error && <div className="flex items-center gap-1 text-[11px] text-error"><AlertCircle className="w-3.5 h-3.5" />{error}</div>}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('apps.cancel')}</Button>
          {gen && !gen.ok && (
            <Button size="sm" variant="secondary" onClick={() => void onGenerate()}><RefreshCw className="w-3 h-3" />{t('apps.retry')}</Button>
          )}
          <Button size="sm" onClick={() => void onSave()} disabled={!canSave} title={!canSave && gen ? t('apps.confirmBlocked') : undefined}>
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
            {gen?.ok ? t('apps.confirmSave') : t('apps.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 表单行：左侧定宽标签 + 右侧控件 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-[11px] text-secondary w-20 shrink-0 truncate">{label}</span>
      {children}
    </label>
  )
}
