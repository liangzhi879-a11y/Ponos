// src/components/team/InviteMemberPanel.tsx —— 邀请成员（S3，spec §5.9 + §11「UI 措辞风险」）
//
// 🔴 本文件承载**安全承诺的红线**，改文案前请先读这一段：
//
//   spec §5.9「单机版的『邀请』没有强制力」原文：团队源为共享目录 / 同步网盘时，读取权限由
//   **OS ACL / 网盘权限**决定，应用无权干涉。"邀请"仅为**应用层登记**，不阻止任何有该目录权限
//   的人读取全部内容。因此本界面**必须**小字明示"权限由操作系统/网盘控制，请另行设置"，
//   且**不得**使用任何暗示"数据已加密"或"仅受邀者可读"的措辞（验证码亦须说明其**仅为成员登记**）。
//
//   三条小字**成套**渲染（键收口在 `teamOnboardingUi.INVITE_DISCLOSURE_KEYS`）：
//     ① ACL 来源   ② 验证码只是成员登记、不是加密钥匙   ③ 应用层登记无强制力
//   遗漏任意一条，用户就会把"被邀请"理解成"被授权"，而实际什么都没保护 ——
//   这正是 spec §11 列为风险的「UI 措辞制造虚假安全感」。
//   回归由 `src/lib/teamOnboardingUi.test.ts` 的反向断言②守（源码级 + 文案级 + 接线级）。
//
// 数据来自 `POST /team/invite`（内核 `exportInvite`）：返回 6 位一次性验证码 + 信封路径 + 转发文案。
import { useState } from 'react'
import { Check, Copy, KeyRound, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui'
import { useTranslation } from '@/i18n/useTranslation'
import { inviteMember, type TeamInviteResult } from '@/lib/teamApi'
import { formatCode, INVITE_DISCLOSURE_KEYS, VERIFY_CODE_LEN } from '@/lib/teamOnboardingUi'

export interface InviteMemberPanelProps {
  teamId: string
  /** 生成邀请后的回调（宿主可据此刷新成员表 —— 信封已写进团队源） */
  onInvited?: (r: TeamInviteResult) => void
}

export function InviteMemberPanel({ teamId, onInvited }: InviteMemberPanelProps) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [invite, setInvite] = useState<TeamInviteResult | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState<'code' | 'text' | null>(null)

  async function generate() {
    setBusy(true)
    setError('')
    const r = await inviteMember({ teamId })
    setBusy(false)
    if (!r.ok) {
      setError(r.error || r.reason || t('team.inviteFailed'))
      return
    }
    setInvite(r)
    onInvited?.(r)
  }

  async function copy(what: 'code' | 'text') {
    const text = what === 'code' ? (invite?.code ?? '') : (invite?.copyText ?? '')
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
      setTimeout(() => setCopied(null), 1500)
    } catch { /* 剪贴板不可用：码与文案都已经明文显示，不阻断（批注 #7：本轮只提供文本方式） */ }
  }

  return (
    <div className="border rounded p-2 space-y-2" data-testid="team-invite-panel">
      <div className="flex items-center gap-1.5">
        <UserPlus className="w-3.5 h-3.5 text-brand-500" />
        <span className="text-xs text-primary font-medium">{t('team.inviteTitle')}</span>
        <div className="flex-1" />
        <Button variant="secondary" size="xs" disabled={busy} onClick={generate}>
          {busy ? t('team.inviteGenerating') : t('team.inviteGenerate')}
        </Button>
      </div>

      {invite?.ok && invite.code && (
        <div className="space-y-1">
          <div className="flex items-center gap-2 px-2 py-1 clip-sm bg-elevated">
            <KeyRound className="w-3.5 h-3.5 text-tertiary shrink-0" />
            <span className="text-[10px] text-tertiary">{t('team.inviteCode')}</span>
            <span className="text-base font-mono tracking-wider text-primary">
              {formatCode(invite.code, VERIFY_CODE_LEN)}
            </span>
            <div className="flex-1" />
            <Button variant="ghost" size="xs" onClick={() => copy('code')} aria-label={t('team.copy')}>
              {copied === 'code' ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
            </Button>
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-tertiary">
            <span>{t('team.inviteSlot', { id: invite.memberId || '—' })}</span>
            <span>·</span>
            <span>{t('team.inviteExpires', { date: String(invite.expiresAt || '').slice(0, 10) })}</span>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => copy('text')}
              className="flex items-center gap-1 text-[10px] text-tertiary hover:text-primary transition-colors"
            >
              {copied === 'text' ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
              {t('team.inviteCopyText')}
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-[10px] text-error" data-testid="team-invite-error">{error}</p>}

      {/* 🔴 强制小字（§5.9 逐字要求；三条缺一不可，见文件头） */}
      <ul className="space-y-1 pt-0.5 border-t border">
        <li className="text-[10px] text-tertiary leading-snug">{t(INVITE_DISCLOSURE_KEYS.acl)}</li>
        <li className="text-[10px] text-tertiary leading-snug">{t(INVITE_DISCLOSURE_KEYS.code)}</li>
        <li className="text-[10px] text-tertiary leading-snug">{t(INVITE_DISCLOSURE_KEYS.enforcement)}</li>
      </ul>
    </div>
  )
}
