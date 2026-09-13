// 新增应用对话框（Task 1.6 最小可用版 + Task 1.7 探测接线）
//
// 流程：填目标（网址 / exe 路径）→ 探测（可选，拿 driver 与页面标题）→ 创建
//   · 创建 = appUpsert（注册表条目）+ appWriteSpec（落 spec.json，写前自动备份旧版）
//   · 也可直接粘贴完整 Spec JSON 覆盖自动骨架（Task 3.x 会换成 LLM 生成）
'use client'
import { useState } from 'react'
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input, Textarea } from '@/components/ui'
import { useTranslation } from '@/i18n/useTranslation'
import type { AppProbeResult, AppSpec, AppTargetType } from '@/types'

const ID_RE = /^[a-zA-Z0-9_-]+$/

/** 生成骨架 Spec：命令表留空（由 LLM 或用户补），但结构与 validateSpec 的要求一致 */
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
  const [specText, setSpecText] = useState('')
  const [error, setError] = useState('')
  const [probe, setProbe] = useState<AppProbeResult | null>(null)
  const [probing, setProbing] = useState(false)
  const [saving, setSaving] = useState(false)
  const api = window.yfworkingAPI

  async function onProbe() {
    setProbing(true)
    setProbe(null)
    setError('')
    try {
      const r = await api?.appProbe?.({ target: type === 'web' ? { type, url } : { type, exePath } })
      setProbe(r ?? null)
    } catch (e) {
      setError(String((e as Error)?.message || e))
    } finally {
      setProbing(false)
    }
  }

  async function onCreate() {
    setError('')
    if (!ID_RE.test(id)) return setError(t('apps.invalidId'))
    if (!name.trim()) return setError(t('apps.needName'))
    if (type === 'web' && !url.trim()) return setError(t('apps.needTarget'))
    if (type === 'desktop' && !exePath.trim()) return setError(t('apps.needTarget'))

    let spec: AppSpec
    if (specText.trim()) {
      try {
        spec = JSON.parse(specText) as AppSpec
      } catch (e) {
        return setError(t('apps.specInvalid', { msg: String((e as Error)?.message || e) }))
      }
      // appId 唯一真源是目录名（写盘时 app-registry.writeSpec 会再强制对齐一次）
      spec = { ...spec, appId: id, name: spec.name || name }
    } else {
      spec = skeletonSpec({ id, name: name.trim(), type, url: url.trim(), exePath: exePath.trim() })
      if (probe?.driver) spec.driver = probe.driver as AppSpec['driver']
    }

    setSaving(true)
    try {
      await api?.appUpsert?.({ id, name: name.trim(), desc: desc.trim(), targetType: type, enabled: true })
      await api?.appWriteSpec?.({ appId: id, spec })
      onDone()
    } catch (e) {
      setError(String((e as Error)?.message || e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(v: boolean) => { if (!v) onClose() }}>
      <DialogContent size="md">
        <DialogHeader><DialogTitle>{t('apps.addTitle')}</DialogTitle></DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-2.5">
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
            {type === 'web' ? (
              <Field label={t('apps.url')}>
                <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" className="h-7 text-xs flex-1" />
              </Field>
            ) : (
              <Field label={t('apps.exePath')}>
                <Input value={exePath} onChange={(e) => setExePath(e.target.value)} placeholder="C:\..." className="h-7 text-xs flex-1" />
              </Field>
            )}
            <Field label="">
              <Button size="sm" variant="secondary" onClick={onProbe} disabled={probing || (type === 'web' ? !url.trim() : !exePath.trim())}>
                {probing ? t('apps.probing') : t('apps.probe')}
              </Button>
              {probe && (
                <span className="text-[10px] text-tertiary ml-2">
                  {probe.reachable === false && probe.error
                    ? t('apps.probeFail', { msg: probe.error })
                    : t('apps.probeOk', { driver: String(probe.driver || '') })}
                  {probe.title ? ` · ${probe.title}` : ''}
                </span>
              )}
            </Field>
            <div>
              <div className="text-[11px] text-secondary mb-1">{t('apps.pasteSpec')}</div>
              <Textarea
                value={specText}
                onChange={(e) => setSpecText(e.target.value)}
                className="w-full text-[11px] font-mono bg-input border rounded p-2 text-primary min-h-[110px]"
                placeholder='{"specVersion":1,...}'
              />
            </div>
            {error && <div className="text-[11px] text-error">{error}</div>}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('apps.cancel')}</Button>
          <Button size="sm" onClick={onCreate} disabled={saving}>{t('apps.create')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 表单行：左侧定宽标签 + 右侧控件（面板内表单统一版式） */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-secondary w-24 shrink-0">{label}</span>
      {children}
    </div>
  )
}
