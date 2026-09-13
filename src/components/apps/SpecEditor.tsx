// Spec 编辑器（Task 3.3）：表单 / JSON 双视图 + 历史版本回滚
//
// 两条硬要求：
//   ① 保存前先校验（appCheckSpec → 后端 validateSpecBasic），**不合法就不保存**；
//     合法性的最终真源仍是内核 kernel/app-spec.mjs 的 validateSpec（工具挂载时会再校验一次）。
//   ② 回滚本身也要能回滚——主进程的 restoreSpec 复用 writeSpec，恢复前自动备份当前版本。
'use client'
import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, History, Loader2, RotateCcw } from 'lucide-react'
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input, Textarea } from '@/components/ui'
import { useTranslation } from '@/i18n/useTranslation'
import type { AppBackupInfo, AppSpec } from '@/types'

type Tab = 'form' | 'json'

export function SpecEditor({ appId, appName, onClose, onSaved }: {
  appId: string
  appName: string
  onClose: () => void
  onSaved?: () => void
}) {
  const { t } = useTranslation()
  const api = window.yfworkingAPI
  const [spec, setSpec] = useState<AppSpec | null>(null)
  const [draft, setDraft] = useState('')
  const [tab, setTab] = useState<Tab>('form')
  const [backups, setBackups] = useState<AppBackupInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const load = useCallback(async () => {
    const s = (await api?.appReadSpec?.(appId)) ?? null
    setSpec(s)
    setDraft(s ? JSON.stringify(s, null, 2) : '')
    setBackups((await api?.appListBackups?.(appId)) ?? [])
  }, [api, appId])

  useEffect(() => { void load() }, [load])

  /** 表单视图的字段修改：整体结构化克隆后再改，避免直接改到旧引用 */
  const patch = (fn: (s: AppSpec) => void) => {
    setSpec((prev) => {
      if (!prev) return prev
      const next = JSON.parse(JSON.stringify(prev)) as AppSpec
      fn(next)
      return next
    })
  }
  const patchCmd = (action: string, fn: (c: AppSpec['commands'][number]) => void) =>
    patch((s) => { const c = (s.commands || []).find((x) => x.action === action); if (c) fn(c) })

  async function onSave() {
    setMsg(null)
    let next: AppSpec | null = null
    if (tab === 'json') {
      try {
        next = JSON.parse(draft) as AppSpec
      } catch (e) {
        setMsg({ kind: 'err', text: `${t('apps.saveBlocked')}：JSON 语法错误 ` + String((e as Error)?.message || '') })
        return
      }
    } else {
      next = spec
    }
    if (!next) return
    setBusy(true)
    try {
      // ① 先校验（非法不保存）
      // 显式选择「全局可用」时才放行 public（默认拒绝，避免绕过控制台绑定）
      const v = await api?.appCheckSpec?.({ spec: next, allowPublic: next.expose?.mode === 'public' })
      if (!v?.ok) {
        setMsg({ kind: 'err', text: `${t('apps.saveBlocked')}：${(v?.errors || ['未知原因']).join('；')}` })
        return
      }
      await api?.appWriteSpec?.({ appId, spec: next })
      await load()
      onSaved?.()
      setMsg({ kind: 'ok', text: t('apps.savedSpec') })
    } catch (e) {
      setMsg({ kind: 'err', text: String((e as Error)?.message || e) })
    } finally { setBusy(false) }
  }

  async function onRollback(name: string) {
    if (!window.confirm(t('apps.rollbackConfirm'))) return
    setBusy(true); setMsg(null)
    try {
      const r = await api?.appRestoreSpec?.({ appId, backupName: name })
      if (!r?.ok) setMsg({ kind: 'err', text: t('apps.rollbackFailed', { msg: String(r?.error || '') }) })
      else { await load(); onSaved?.(); setMsg({ kind: 'ok', text: t('apps.rollbackDone') }) }
    } finally { setBusy(false) }
  }

  const modes: { key: 'console' | 'public' | 'private'; label: string }[] = [
    { key: 'console', label: t('apps.exposeConsole') },
    { key: 'public', label: t('apps.exposePublic') },
    { key: 'private', label: t('apps.exposePrivate') },
  ]

  return (
    <Dialog open onOpenChange={(v: boolean) => { if (!v) onClose() }}>
      <DialogContent size="lg">
        <DialogHeader><DialogTitle>{t('apps.specEditorTitle')} · {appName}</DialogTitle></DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-1">
              <Button size="sm" variant={tab === 'form' ? 'primary' : 'secondary'} onClick={() => setTab('form')}>{t('apps.tabForm')}</Button>
              <Button size="sm" variant={tab === 'json' ? 'primary' : 'secondary'} onClick={() => setTab('json')}>{t('apps.tabJson')}</Button>
              <span className="flex-1" />
              <span className="text-[10px] text-tertiary">{appId}</span>
            </div>

            {!spec ? (
              <div className="text-[11px] text-tertiary">{t('apps.noSpecYet')}</div>
            ) : tab === 'json' ? (
              <Textarea value={draft} onChange={(e) => setDraft(e.target.value)}
                className="w-full text-[11px] font-mono bg-input border rounded p-2 text-primary min-h-[280px]" />
            ) : (
              <div className="flex flex-col gap-2.5">
                <Field label={t('apps.name')}>
                  <Input value={spec.name || ''} onChange={(e) => patch((s) => { s.name = e.target.value })} className="h-7 text-xs flex-1" />
                </Field>
                <Field label={t('apps.desc')}>
                  <Input value={spec.desc || ''} onChange={(e) => patch((s) => { s.desc = e.target.value })} className="h-7 text-xs flex-1" />
                </Field>
                <Field label={spec.target?.type === 'desktop' ? t('apps.exePath') : t('apps.url')}>
                  <Input
                    value={String((spec.target?.type === 'desktop' ? spec.target?.exePath : spec.target?.url) || '')}
                    onChange={(e) => patch((s) => {
                      if (s.target?.type === 'desktop') s.target.exePath = e.target.value
                      else if (s.target) s.target.url = e.target.value
                    })}
                    className="h-7 text-xs flex-1"
                  />
                </Field>
                <Field label={t('apps.expose')}>
                  <div className="flex items-center gap-1">
                    {modes.map((m) => (
                      <Button key={m.key} size="sm" variant={spec.expose?.mode === m.key ? 'primary' : 'secondary'}
                        onClick={() => patch((s) => { s.expose = { ...(s.expose || {}), mode: m.key } })}>{m.label}</Button>
                    ))}
                  </div>
                </Field>
                <p className="text-[10px] text-tertiary">{t('apps.exposeHint')}</p>
                {spec.expose?.mode === 'public' && (
                  <p className="text-[10px] text-warning">{t('apps.exposePublicWarn')}</p>
                )}

                <div className="text-[11px] font-semibold text-tertiary uppercase tracking-wider">
                  {t('apps.commands')}（{spec.commands?.length || 0}）
                </div>
                <div className="flex flex-col gap-1.5">
                  {(spec.commands || []).map((c) => (
                    <div key={c.action} className="rounded bg-elevated border border-subtle px-2.5 py-1.5 flex flex-col gap-1.5">
                      <div className="flex items-center gap-2">
                        <button className="text-tertiary hover:text-primary" onClick={() => setOpen(open === c.action ? null : c.action)}>
                          {open === c.action ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                        </button>
                        <span className="text-[9px] font-mono text-tertiary">{c.action}</span>
                        <Input value={c.title || ''} onChange={(e) => patchCmd(c.action, (x) => { x.title = e.target.value })} className="h-6 text-[11px] flex-1" />
                        <div className="flex items-center gap-0.5">
                          {(['read', 'write'] as const).map((k) => (
                            <Button key={k} size="sm" variant={c.kind === k ? 'primary' : 'secondary'}
                              onClick={() => patchCmd(c.action, (x) => { x.kind = k })}>{k}</Button>
                          ))}
                        </div>
                      </div>
                      {open === c.action && (
                        <Textarea
                          value={JSON.stringify({ params: c.params || [], steps: c.steps || [] }, null, 2)}
                          onChange={(e) => {
                            try {
                              const j = JSON.parse(e.target.value) as { params?: unknown[]; steps?: unknown[] }
                              patchCmd(c.action, (x) => {
                                if (Array.isArray(j.params)) x.params = j.params as typeof x.params
                                if (Array.isArray(j.steps)) x.steps = j.steps as typeof x.steps
                              })
                            } catch { /* 正在输入，允许暂时不是合法 JSON */ }
                          }}
                          className="w-full text-[10px] font-mono bg-input border rounded p-2 text-primary min-h-[110px]"
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 历史版本：回滚入口 */}
            <div className="rounded-lg border border-subtle bg-elevated p-2.5">
              <div className="flex items-center gap-1.5 text-[11px] text-secondary mb-1.5">
                <History className="w-3 h-3" />{t('apps.backups')}（{backups.length}）
              </div>
              {backups.length === 0 ? (
                <div className="text-[10px] text-tertiary">{t('apps.noBackups')}</div>
              ) : (
                <div className="flex flex-col gap-1 max-h-32 overflow-auto">
                  {backups.map((b) => (
                    <div key={b.name} className="flex items-center gap-2 text-[10px]">
                      <span className="text-tertiary">{new Date(b.ts).toLocaleString()}</span>
                      <span className="font-mono text-tertiary/70 truncate flex-1">{b.name}</span>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void onRollback(b.name)}>
                        <RotateCcw className="w-3 h-3" />{t('apps.rollback')}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {msg && (
              <div className={'flex items-start gap-1 text-[11px] ' + (msg.kind === 'ok' ? 'text-success' : 'text-error')}>
                {msg.kind === 'ok' ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5" /> : <AlertCircle className="w-3.5 h-3.5 mt-0.5" />}
                <span>{msg.text}</span>
              </div>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('apps.cancel')}</Button>
          <Button size="sm" onClick={() => void onSave()} disabled={busy || !spec}>
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : null}{t('apps.saveSpec')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-[11px] text-secondary w-20 shrink-0 truncate">{label}</span>
      {children}
    </label>
  )
}
