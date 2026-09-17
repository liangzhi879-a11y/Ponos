// src/components/team/JoinTeamPanel.tsx —— 加入团队（S3，spec §5.9「加入机制：识别码 + 验证码」）
//
// 对齐向日葵的心智模型：**两个短数字，可口头传**（9 位识别码定位 + 6 位验证码解信封）。
// 关键体验要求（§5.9 原文）：「加入者路径必须极简——普通用户不应手工配置目录路径」，
// 故主路径**没有任何路径输入框**；路径只出现在两处兜底：
//   ① 「团队目录搜索根」（一次设置、长期复用，且**记住**）；
//   ② 「手动选择目录」（搜索根不可用时兜底，§10 S3-4）。
//
// 失败态**逐项区分**（内核 `joinTeam` 给出的 reason 原样映射，见 `teamOnboardingUi.JOIN_FAILURE`）：
//   格式错 / 没设搜索根 / 识别码未找到 / 识别码歧义 / 没有可用信封 / **验证码错** /
//   **已过期** / **已被使用**（一次性）。后三者必须分开 —— 否则用户会反复重试一个永远不会成功的码。
import { useState } from 'react'
import { AlertTriangle, FolderOpen, LogIn, Search } from 'lucide-react'
import { Button, Input } from '@/components/ui'
import { DirectoryPicker } from '@/components/chat/DirectoryPicker'
import { useTranslation } from '@/i18n/useTranslation'
import { joinTeam, setTeamSearchRoot, type TeamJoinResult } from '@/lib/teamApi'
import { useTeamStore } from '@/stores/teamStore'
import {
  checkIdentCode, checkVerifyCode, digitsOnly, formatCode, IDENT_CODE_LEN, IDENT_CODE_NAME_KEY,
  joinFailure, JOIN_NETWORK_FAILURE, VERIFY_CODE_LEN, VERIFY_CODE_NAME_KEY,
} from '@/lib/teamOnboardingUi'

export function JoinTeamPanel() {
  const { t } = useTranslation()
  const searchRoot = useTeamStore((s) => s.searchRoot)
  const load = useTeamStore((s) => s.load)

  const [ident, setIdent] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<TeamJoinResult | null>(null)
  const [picking, setPicking] = useState(false)

  const identCheck = checkIdentCode(ident)
  const verifyCheck = checkVerifyCode(code)
  const canSubmit = identCheck.ok && verifyCheck.ok && !busy

  async function submit() {
    setBusy(true)
    setResult(null)
    const r = await joinTeam({ identCode: identCheck.digits, code: verifyCheck.digits })
    setBusy(false)
    setResult(r)
    if (r.ok) await load()
  }

  /** 兜底：手动选目录。选中的目录既用于本次加入（内核按 `team.json` **内容**匹配，与目录名无关，
   *  —— §5.9 批注 #10），也顺手记为搜索根（下次就回到"两个数字"体验）。 */
  async function pickDir(dir: string) {
    setPicking(false)
    if (!dir) return
    await setTeamSearchRoot(dir)
    await load()
    if (!canSubmit) return
    setBusy(true)
    const r = await joinTeam({ identCode: identCheck.digits, code: verifyCheck.digits, searchRoot: dir })
    setBusy(false)
    setResult(r)
    if (r.ok) await load()
  }

  const fail = result && !result.ok
    ? (result.reason === 'network' ? JOIN_NETWORK_FAILURE : joinFailure(result.reason))
    : null

  return (
    <div className="space-y-2" data-testid="team-join-panel">
      <div className="flex items-center gap-1.5">
        <LogIn className="w-3.5 h-3.5 text-brand-500" />
        <span className="text-xs text-primary font-medium">{t('team.joinTitle')}</span>
      </div>
      <p className="text-[10px] text-tertiary leading-relaxed">{t('team.joinHint')}</p>

      <label className="block space-y-1">
        <span className="text-xs text-secondary">{t('team.joinIdentLabel')}</span>
        <Input
          value={formatCode(ident, IDENT_CODE_LEN)}
          onChange={(e) => setIdent(digitsOnly(e.target.value).slice(0, IDENT_CODE_LEN))}
          inputMode="numeric"
          placeholder="483 920 517"
          className="h-8 text-xs font-mono tracking-wider"
          aria-label={t('team.joinIdentLabel')}
        />
        {ident !== '' && identCheck.issueKey && (
          <span className="text-[10px] text-warning">
            {t(identCheck.issueKey, { name: t(IDENT_CODE_NAME_KEY), n: IDENT_CODE_LEN })}
          </span>
        )}
      </label>

      <label className="block space-y-1">
        <span className="text-xs text-secondary">{t('team.joinVerifyLabel')}</span>
        <Input
          value={formatCode(code, VERIFY_CODE_LEN)}
          onChange={(e) => setCode(digitsOnly(e.target.value).slice(0, VERIFY_CODE_LEN))}
          inputMode="numeric"
          placeholder="739 204"
          className="h-8 text-xs font-mono tracking-wider"
          aria-label={t('team.joinVerifyLabel')}
        />
        {code !== '' && verifyCheck.issueKey && (
          <span className="text-[10px] text-warning">
            {t(verifyCheck.issueKey, { name: t(VERIFY_CODE_NAME_KEY), n: VERIFY_CODE_LEN })}
          </span>
        )}
      </label>

      <div className="flex items-center gap-1.5">
        <Button variant="primary" size="xs" disabled={!canSubmit} onClick={submit}>
          <Search className="w-3.5 h-3.5" />
          {busy ? t('team.joining') : t('team.joinSubmit')}
        </Button>
        <Button variant="ghost" size="xs" onClick={() => setPicking(true)}>
          <FolderOpen className="w-3.5 h-3.5" />
          {t('team.rootManual')}
        </Button>
      </div>
      <p className="text-[10px] text-tertiary leading-relaxed">{t('team.joinManual')}</p>

      {/* 搜索根：未设置时**显眼**（否则"两个数字加入"必然失败，而用户不知道为什么） */}
      <div className="text-[10px] text-tertiary leading-relaxed">
        <span className="text-secondary">{t('team.rootTitle')}：</span>
        {searchRoot
          ? <code className="text-[10px] break-all">{searchRoot}</code>
          : <span className="text-warning">{t('team.rootNone')}</span>}
      </div>
      {searchRoot && <p className="text-[10px] text-tertiary leading-snug">{t('team.rootHint')}</p>}

      {result?.ok && (
        <p className="text-[10px] text-success">{t('team.joinOk', { name: result.name || result.teamId || '' })}</p>
      )}

      {fail && (
        <div className="space-y-0.5" data-testid="team-join-error">
          <p className="text-[10px] text-error flex items-start gap-1">
            <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />
            <span>{t(fail.titleKey)}</span>
          </p>
          <p className="text-[10px] text-tertiary leading-snug">{t(fail.hintKey)}</p>
          {/* 识别码歧义：把候选目录列出来，否则用户不知道"手动选目录"该选哪个 */}
          {result?.hits && result.hits.length > 0 && (
            <p className="text-[10px] text-tertiary break-all">
              {t('team.joinHits', { count: result.hits.length, dirs: result.hits.join(' , ') })}
            </p>
          )}
        </div>
      )}

      {picking && <DirectoryPicker value={searchRoot ?? ''} onChange={pickDir} onClose={() => setPicking(false)} />}
    </div>
  )
}
