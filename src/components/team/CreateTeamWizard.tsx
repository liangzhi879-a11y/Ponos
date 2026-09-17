// src/components/team/CreateTeamWizard.tsx —— 三层新建向导（S3，spec §5.9「新建团队」）
//
// 三步，顺序是**硬约束**（§5.9「顺序要点」原文）：**先有团队工作区实体，再配置团队源**
// （团队源是工作区的属性，不是前置条件）：
//   ① 团队名 + 本机身份（密钥对由应用自动生成，显示指纹/设备标识）
//   ② 团队源（§7 两档实现：L1 共享目录本轮可用；L2 团队服务器属 S5，按定案 14 **只留结构**）
//   ③ 初始化团队源（写 manifest + 成员日志 + 目录布局）→ 显示 9 位识别码 → **停留在邀请成员页**
//
// 判据全部来自 `src/lib/teamOnboardingUi.ts`（可 `node --test` 直测）：
//   wizardBlockers / sourceUnavailableKey / TEAM_LAYOUT_ENTRIES / formatCode。
// 本组件只做渲染与调用桥（`POST /team/create`），失败原样展示内核给的原因，**不吞错**。
import { useState } from 'react'
import { ChevronLeft, ChevronRight, Copy, Check, FolderOpen, KeyRound, Layers, UserSquare2 } from 'lucide-react'
import { Button, Input, ScrollArea } from '@/components/ui'
import { DirectoryPicker } from '@/components/chat/DirectoryPicker'
import { useTranslation } from '@/i18n/useTranslation'
import { cn } from '@/lib/utils'
import { createTeam } from '@/lib/teamApi'
import { useTeamStore } from '@/stores/teamStore'
import {
  canAdvance, formatCode, IDENT_CODE_LEN, nextStep, prevStep, sourceUnavailableKey,
  TEAM_LAYOUT_ENTRIES, TEAM_SOURCE_OPTIONS, wizardBlockers, type TeamSourceKind, type WizardStep,
} from '@/lib/teamOnboardingUi'
import { InviteMemberPanel } from './InviteMemberPanel'

const L1: TeamSourceKind = 'l1-shared-dir'

export interface CreateTeamWizardProps {
  /** 创建完成（第 ③ 步成功）后回调，宿主据此刷新状态 */
  onCreated?: (teamId: string) => void
}

export function CreateTeamWizard({ onCreated }: CreateTeamWizardProps) {
  const { t } = useTranslation()
  const deviceId = useTeamStore((s) => s.deviceId)
  const load = useTeamStore((s) => s.load)

  const [step, setStep] = useState<WizardStep>(1)
  const [name, setName] = useState('')
  const [sourceKind, setSourceKind] = useState<TeamSourceKind>(L1)
  const [dir, setDir] = useState('')
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [created, setCreated] = useState<{ teamId: string; identCode: string; memberId: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const draft = { name, sourceKind, dir }
  const blockers = wizardBlockers(step, draft)
  const l2Blocked = sourceUnavailableKey(sourceKind)

  async function submit() {
    setBusy(true)
    setError('')
    // 识别码由内核生成（团队级固定、写在 team.json 明文里）——界面不自己造码，
    // 否则"界面上显示的识别码"与"团队源里的识别码"会有两个真源。
    const r = await createTeam({ name: name.trim(), dir: dir.trim() })
    setBusy(false)
    if (!r.ok || !r.teamId) {
      setError(r.error || r.reason || t('team.wizardFailed'))
      return
    }
    setCreated({ teamId: r.teamId, identCode: r.identCode || '', memberId: r.memberId || '' })
    await load()
    onCreated?.(r.teamId)
  }

  async function copyCode() {
    if (!created?.identCode) return
    try {
      await navigator.clipboard.writeText(created.identCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* 剪贴板不可用：识别码已经明文显示在界面上，不阻断 */ }
  }

  const stepTitle = step === 1 ? t('team.wizardStep1') : step === 2 ? t('team.wizardStep2') : t('team.wizardStep3')

  return (
    <div className="space-y-3" data-testid="team-create-wizard">
      <div className="flex items-center gap-2">
        <Layers className="w-4 h-4 text-brand-500" />
        <h3 className="text-sm font-medium text-primary">{t('team.wizardTitle')}</h3>
        <span className="micro ml-auto">{t('team.wizardStep', { n: step })}</span>
      </div>

      {/* 步骤条：只显示当前步名（三步的短名在窄窗里并排会挤成两行） */}
      <div className="flex items-center gap-1.5">
        {[1, 2, 3].map((n) => (
          <span
            key={n}
            className={cn('h-1 flex-1 clip-sm', n <= step ? 'bg-brand-500' : 'bg-elevated')}
            title={n === 1 ? t('team.wizardStep1') : n === 2 ? t('team.wizardStep2') : t('team.wizardStep3')}
          />
        ))}
      </div>
      <div className="text-xs text-secondary">{stepTitle}</div>

      {step === 1 && (
        <div className="space-y-2">
          <label className="block space-y-1">
            <span className="text-xs text-secondary">{t('team.wizardName')}</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('team.wizardNamePlaceholder')}
              className="h-8 text-xs"
            />
          </label>
          <div className="flex items-center gap-2 text-[11px] text-secondary">
            <UserSquare2 className="w-3.5 h-3.5 text-tertiary" />
            <span>{t('team.wizardFingerprint')}</span>
            <code className="text-[10px] text-tertiary truncate">{deviceId || '—'}</code>
          </div>
          <p className="text-[10px] text-tertiary leading-relaxed">{t('team.wizardFingerprintHint')}</p>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-2">
          {TEAM_SOURCE_OPTIONS.map((opt) => {
            const active = sourceKind === opt.kind
            return (
              <button
                key={opt.kind}
                type="button"
                disabled={!opt.available}
                onClick={() => opt.available && setSourceKind(opt.kind)}
                className={cn(
                  'w-full text-left px-2 py-1.5 clip-sm border transition-colors',
                  active ? 'border-brand-500/60 bg-brand-500/10' : 'border-default hover:bg-elevated',
                  !opt.available && 'opacity-60 cursor-not-allowed',
                )}
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-primary">{t(opt.labelKey)}</span>
                  {!opt.available && <span className="micro">{t('team.sourceL2Unavailable')}</span>}
                </div>
                <p className="mt-0.5 text-[10px] text-tertiary leading-snug">{t(opt.hintKey)}</p>
              </button>
            )
          })}

          <label className="block space-y-1">
            <span className="text-xs text-secondary">{t('team.wizardDir')}</span>
            <div className="flex items-center gap-1.5">
              <Input
                value={dir}
                onChange={(e) => setDir(e.target.value)}
                placeholder={t('team.wizardDirPlaceholder')}
                className="h-8 text-xs flex-1"
              />
              <Button variant="secondary" size="xs" onClick={() => setPicking(true)}>
                <FolderOpen className="w-3.5 h-3.5" />
                {t('team.wizardBrowse')}
              </Button>
            </div>
          </label>
          <p className="text-[10px] text-tertiary leading-relaxed">{t('team.wizardDirHint')}</p>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-2">
          {!created ? (
            <>
              <p className="text-[11px] text-secondary leading-relaxed">{t('team.wizardDirHint')}</p>
              {/* 目录布局契约（§7.2）：初始化**之前**就把"会出现什么"说清楚——
                  否则用户第一次看到团队目录里的七个条目会以为是什么垃圾 */}
              <div className="border rounded p-2 space-y-1">
                <div className="text-[11px] text-primary font-medium">{t('team.wizardLayoutTitle')}</div>
                <ScrollArea className="max-h-[168px]">
                  <ul className="space-y-1 pr-1">
                    {TEAM_LAYOUT_ENTRIES.map((e) => (
                      <li key={e.path} className="flex items-start gap-1.5">
                        <code className="text-[10px] text-brand-500 shrink-0">{e.path}</code>
                        <span className="text-[10px] text-tertiary leading-snug">{t(e.hintKey)}</span>
                      </li>
                    ))}
                  </ul>
                </ScrollArea>
                <p className="text-[10px] text-tertiary flex items-start gap-1">
                  <KeyRound className="w-3 h-3 shrink-0 mt-px" />
                  {t('team.layoutKeysNote')}
                </p>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 text-xs text-primary font-medium">
                <Check className="w-4 h-4 text-success" />
                {t('team.wizardDone')}
              </div>
              <div className="flex items-center gap-2 px-2 py-1.5 clip-sm bg-elevated">
                <span className="text-[10px] text-tertiary">{t('team.listIdentCode')}</span>
                <span className="text-lg font-mono tracking-wider text-primary">
                  {formatCode(created.identCode, IDENT_CODE_LEN) || created.identCode || '—'}
                </span>
                <Button variant="ghost" size="xs" onClick={copyCode} aria-label={t('team.copy')}>
                  {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
                </Button>
              </div>
              <p className="text-[10px] text-tertiary leading-relaxed">{t('team.wizardDoneHint')}</p>
              {/* 第 ③ 步**停留在邀请成员页**（§5.9）：识别码是团队级的（公开），
                  验证码才是私下的、一次性的 */}
              <InviteMemberPanel teamId={created.teamId} />
            </>
          )}
        </div>
      )}

      {blockers.length > 0 && step < 3 && (
        <p className="text-[10px] text-warning">{t(blockers[0])}</p>
      )}
      {l2Blocked && step === 2 && <p className="text-[10px] text-warning">{t(l2Blocked)}</p>}
      {error && <p className="text-[10px] text-error" data-testid="team-wizard-error">{error}</p>}

      <div className="flex items-center gap-1.5">
        <Button variant="ghost" size="xs" disabled={step === 1 || busy} onClick={() => setStep(prevStep(step))}>
          <ChevronLeft className="w-3.5 h-3.5" />
          {t('team.wizardPrev')}
        </Button>
        <div className="flex-1" />
        {step < 3 ? (
          <Button variant="secondary" size="xs" disabled={!canAdvance(step, draft)} onClick={() => setStep(nextStep(step))}>
            {t('team.wizardNext')}
            <ChevronRight className="w-3.5 h-3.5" />
          </Button>
        ) : !created ? (
          <Button variant="primary" size="xs" disabled={busy || !dir.trim()} onClick={submit}>
            {busy ? t('team.wizardCreating') : t('team.wizardCreate')}
          </Button>
        ) : null}
      </div>

      {/* 目录选择器（DirectoryPicker 自身为 fixed 全屏弹层，与 RightStatusRail 的用法一致） */}
      {picking && (
        <DirectoryPicker value={dir} onChange={setDir} onClose={() => setPicking(false)} />
      )}
    </div>
  )
}
