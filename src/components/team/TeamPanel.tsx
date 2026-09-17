// src/components/team/TeamPanel.tsx —— 设置窗「团队」分区（S3 的开通/加入/成员管理宿主）
//
// 三态：
//   ① 没加入任何团队 → **空态引导**（创建 / 加入二选一，§10 S3-1）
//   ② 创建向导（三步，`CreateTeamWizard`）
//   ③ 已加入 → 团队清单（识别码 / 我的角色 / 成员表 / 完整性告警 / 同步盘警告 / 搜索根）
//        + 每个团队一张「邀请成员」卡（含强制小字，见 `InviteMemberPanel`）
//
// 诚实边界（§5.9 / §11）：成员管理在单机版是**软权限** —— 应用拦不住直接改文件的用户，
// 故本页只承诺"登记与留痕"，不画任何"权限已生效"的暗示。完整性告警（签名链验不过）
// **必须显式告警**：那是本设计唯一能真的发现"文件被改过"的地方。
import { useEffect, useState } from 'react'
import { AlertTriangle, Check, Copy, Plus, RefreshCw, UserMinus, Users } from 'lucide-react'
import { Button, Input } from '@/components/ui'
import { useTranslation } from '@/i18n/useTranslation'
import { revokeTeamMember, setTeamSearchRoot, type TeamSummary } from '@/lib/teamApi'
import { ensureTeamsLoaded, useTeamStore } from '@/stores/teamStore'
import { formatCode, IDENT_CODE_LEN } from '@/lib/teamOnboardingUi'
import { sanitizeTeamIntent, SETTINGS_TEAM_INTENT_KEY } from '@/lib/teamModeUi'
import { CreateTeamWizard } from './CreateTeamWizard'
import { JoinTeamPanel } from './JoinTeamPanel'
import { InviteMemberPanel } from './InviteMemberPanel'

/** 角色 → i18n 键（内核值域：owner/admin/editor/commenter/viewer，其余落"未知角色"）。 */
const ROLE_KEY: Record<string, string> = {
  owner: 'team.roleOwner',
  admin: 'team.roleAdmin',
  editor: 'team.roleEditor',
  commenter: 'team.roleCommenter',
  viewer: 'team.roleViewer',
}

export function TeamPanel() {
  const { t } = useTranslation()
  const teams = useTeamStore((s) => s.teams)
  const searchRoot = useTeamStore((s) => s.searchRoot)
  const loading = useTeamStore((s) => s.loading)
  const error = useTeamStore((s) => s.error)
  const load = useTeamStore((s) => s.load)

  // header 空态引导的两个按钮语义不同（创建 ≠ 加入）：落地时按请求的子视图预开表单，
  // 否则用户点「创建团队」跳到本页还要再点一次同义按钮（两按钮同一效果 = 界面谎言）。
  const [view, setView] = useState<'idle' | 'create' | 'join'>(() => {
    try {
      const intent = sanitizeTeamIntent(localStorage.getItem(SETTINGS_TEAM_INTENT_KEY))
      localStorage.removeItem(SETTINGS_TEAM_INTENT_KEY)   // 一次性意图：读过即清
      return intent === 'create' || intent === 'join' ? intent : 'idle'
    } catch { return 'idle' }
  })
  const [rootDraft, setRootDraft] = useState('')
  const [rootMsg, setRootMsg] = useState('')
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null)
  const [revokeMsg, setRevokeMsg] = useState('')
  const [copiedTeam, setCopiedTeam] = useState<string | null>(null)

  useEffect(() => { void ensureTeamsLoaded() }, [])

  async function saveRoot() {
    const r = await setTeamSearchRoot(rootDraft.trim())
    setRootMsg(r.ok ? t('team.rootSaved') : (r.error || r.reason || t('team.loadFailed')))
    if (r.ok) await load()
  }

  async function doRevoke(team: TeamSummary, memberId: string) {
    const r = await revokeTeamMember({ teamId: team.teamId, memberId })
    setConfirmRevoke(null)
    setRevokeMsg(r.ok ? t('team.listRevoked', { id: memberId }) : (r.error || r.reason || t('team.loadFailed')))
    if (r.ok) await load()
  }

  async function copyIdent(team: TeamSummary) {
    if (!team.identCode) return
    try {
      await navigator.clipboard.writeText(team.identCode)
      setCopiedTeam(team.teamId)
      setTimeout(() => setCopiedTeam(null), 1500)
    } catch { /* 剪贴板不可用：码已明文显示 */ }
  }

  return (
    <div className="space-y-4" data-testid="team-panel">
      <div className="flex items-center gap-2">
        <Users className="w-4 h-4 text-brand-500" />
        <h3 className="text-sm font-medium text-primary">{t('team.panelTitle')}</h3>
        <div className="flex-1" />
        <Button variant="ghost" size="xs" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={loading ? 'w-3.5 h-3.5 animate-spin' : 'w-3.5 h-3.5'} />
          {t('common.refresh')}
        </Button>
      </div>
      <p className="text-xs text-secondary leading-relaxed max-w-2xl">{t('team.panelDesc')}</p>
      {error && <p className="text-[10px] text-error">{t('team.loadFailed')}：{error}</p>}

      {/* 搜索根：一次设置、长期复用（"两个数字加入"的前提）。**始终可见**——
          它不是高级选项，而是加入流程的前提条件 */}
      <div className="max-w-2xl space-y-1">
        <div className="text-xs text-secondary">{t('team.rootTitle')}</div>
        <div className="flex items-center gap-1.5">
          <Input
            value={rootDraft}
            onChange={(e) => setRootDraft(e.target.value)}
            placeholder={searchRoot ?? t('team.rootTitle')}
            className="h-8 text-xs flex-1"
          />
          <Button variant="secondary" size="xs" disabled={!rootDraft.trim()} onClick={saveRoot}>
            {t('team.rootSave')}
          </Button>
        </div>
        <p className="text-[10px] text-tertiary leading-snug">{t('team.rootHint')}</p>
        {searchRoot
          ? <p className="text-[10px] text-tertiary break-all">{t('team.rootTitle')}：<code>{searchRoot}</code></p>
          : <p className="text-[10px] text-warning">{t('team.rootNone')}</p>}
        {rootMsg && <p className="text-[10px] text-tertiary">{rootMsg}</p>}
      </div>

      {teams.length === 0 ? (
        <div className="max-w-2xl space-y-2 border rounded p-3">
          <div className="text-sm text-primary">{t('team.modeEmptyTitle')}</div>
          <p className="text-[11px] text-tertiary leading-relaxed">{t('team.modeEmptyHint')}</p>
          <div className="flex items-center gap-1.5">
            <Button variant="primary" size="xs" onClick={() => setView('create')}>
              <Plus className="w-3.5 h-3.5" />
              {t('team.modeActionCreate')}
            </Button>
            <Button variant="secondary" size="xs" onClick={() => setView('join')}>
              {t('team.modeActionJoin')}
            </Button>
          </div>
          {view === 'create' && <CreateTeamWizard onCreated={() => setView('idle')} />}
          {view === 'join' && <JoinTeamPanel />}
        </div>
      ) : (
        <div className="space-y-4">
          {teams.map((team) => (
            <div key={team.teamId} className="max-w-2xl space-y-2 border rounded p-3">
              <div className="flex items-center gap-2">
                <span className="text-sm text-primary font-medium truncate">{team.name || team.teamId}</span>
                <span className="micro truncate">{team.dir}</span>
                <div className="flex-1" />
                {team.ok === false && (
                  <span className="micro text-error flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" />
                    {t('team.loadFailed')}
                    {/* 原样带上内核的 reason（`team-dir-missing` / `not-a-member`）：
                        排障时"哪个团队的团队源不可用"比一句笼统失败有用得多 */}
                    {team.reason ? `（${team.reason}）` : ''}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2 text-[11px]">
                <span className="text-tertiary">{t('team.listIdentCode')}</span>
                <span className="font-mono tracking-wider text-primary">
                  {team.identCode ? formatCode(team.identCode, IDENT_CODE_LEN) : '—'}
                </span>
                <Button variant="ghost" size="xs" onClick={() => copyIdent(team)} aria-label={t('team.copy')}>
                  {copiedTeam === team.teamId ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
                </Button>
                <span className="text-tertiary">· {t('team.listMemberCount', { count: team.memberCount })}</span>
                <span className="text-tertiary">
                  · {t('team.listRole')}：{t(ROLE_KEY[team.me?.role ?? ''] ?? 'team.roleUnknown')}
                </span>
              </div>

              {/* 完整性：验签失败必须告警（这是本设计唯一能真的发现"文件被改过"的地方） */}
              {team.integrity.ok
                ? <p className="text-[10px] text-tertiary flex items-center gap-1"><Check className="w-3 h-3 text-success" />{t('team.listIntegrityOk')}</p>
                : <p className="text-[10px] text-error flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" />
                    {t('team.listIntegrityBad', { count: team.integrity.errors.length })}
                  </p>}

              {(team.copies > 0 || team.warnings.length > 0) && (
                <div className="text-[10px] text-tertiary leading-snug">
                  <span className="text-secondary">{t('team.listWarningsTitle')}：</span>
                  {team.copies > 0 && <span>{t('team.listCopies', { count: team.copies })} </span>}
                  {team.warnings.map((w) => <span key={w} className="break-all">{w} </span>)}
                </div>
              )}

              <div className="space-y-1">
                <div className="text-[11px] text-secondary">{t('team.listMembersTitle')}</div>
                <ul className="space-y-0.5">
                  {team.members.map((m) => (
                    <li key={m.memberId} className="flex items-center gap-2 text-[11px]">
                      <code className="text-[10px] text-tertiary">{m.memberId}</code>
                      <span className="text-secondary">{t(ROLE_KEY[m.role] ?? 'team.roleUnknown')}</span>
                      <span className={m.status === 'active' ? 'text-tertiary' : 'text-warning'}>
                        {t(m.status === 'active' ? 'team.memberActive' : 'team.memberRemoved')}
                      </span>
                      <div className="flex-1" />
                      {confirmRevoke === `${team.teamId}:${m.memberId}` ? (
                        <Button variant="danger" size="xs" onClick={() => doRevoke(team, m.memberId)}>
                          {t('team.listRevoke')}
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => setConfirmRevoke(`${team.teamId}:${m.memberId}`)}
                          aria-label={`${t('team.listRevoke')} ${m.memberId}`}
                        >
                          <UserMinus className="w-3 h-3" />
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
                {revokeMsg && <p className="text-[10px] text-tertiary">{revokeMsg}</p>}
              </div>

              {/* 邀请（含强制小字）*/}
              <InviteMemberPanel teamId={team.teamId} onInvited={() => void load()} />
            </div>
          ))}

          <div className="flex items-center gap-1.5">
            <Button variant="secondary" size="xs" onClick={() => setView(view === 'create' ? 'idle' : 'create')}>
              <Plus className="w-3.5 h-3.5" />
              {t('team.modeActionCreate')}
            </Button>
            <Button variant="secondary" size="xs" onClick={() => setView(view === 'join' ? 'idle' : 'join')}>
              {t('team.modeActionJoin')}
            </Button>
          </div>
          {view === 'create' && <CreateTeamWizard onCreated={() => setView('idle')} />}
          {view === 'join' && <JoinTeamPanel />}
        </div>
      )}
    </div>
  )
}
