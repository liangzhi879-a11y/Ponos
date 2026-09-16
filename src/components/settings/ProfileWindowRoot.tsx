// src/components/settings/ProfileWindowRoot.tsx —— 独立个人信息窗口（?profile=1，2026-09-10）
// 功能：头像（上传→dataURL 落盘，上限 400KB）、昵称、简介、修改密码（验旧设新，
// 未初始化时直接设置）、认证状态展示。档案经 bridge /api/profile 落盘
// <YFW_HOME>/userData/profile.json；密码经 /api/auth/change-password 改盐重哈希。
import { useEffect, useRef, useState } from 'react'
import { User, Lock, Camera, CheckCircle2, AlertTriangle, X, KeyRound } from 'lucide-react'
import { TooltipProvider, Button, Input, Textarea } from '@/components/ui'
import { getBridgeUrl } from '@/lib/config'
import { UtilityWindowShell } from './UtilityWindowShell'
import { VaultPanel } from '@/components/vault/VaultPanel'

interface ProfileData { nickname: string; avatar: string; bio: string }
interface AuthStatusData { phase: 'uninitialized' | 'ok' | 'locked'; lockedForMs?: number }

export function ProfileWindowRoot() {
  // 顶层标签：个人信息（账号本身）/ 密码库（用户在各站点·应用的账号密码，2026-09-15 新增）
  // 放在同一个窗口而不是另开一窗：两者都是"我的"数据，且密码库需要一个长列表的稳定容器，
  // 复用已有工具窗的尺寸/主题/外壳，少一套窗口生命周期要维护。
  const [tab, setTab] = useState<'profile' | 'vault'>('profile')
  const [profile, setProfile] = useState<ProfileData>({ nickname: '', avatar: '', bio: '' })
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [authPhase, setAuthPhase] = useState<string>('ok')
  const [oldPwd, setOldPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [pwdMsg, setPwdMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetch(`${getBridgeUrl()}/api/profile`).then(r => r.json()).then(p => setProfile({ nickname: p.nickname || '', avatar: p.avatar || '', bio: p.bio || '' })).catch(() => {})
    fetch(`${getBridgeUrl()}/api/auth/status`).then(r => r.json()).then(s => setAuthPhase(s.phase || 'ok')).catch(() => {})
  }, [])

  const pickAvatar = () => {
    const f = fileRef.current?.files?.[0]
    if (!f) return
    if (!/^image\//.test(f.type)) { setSaveMsg('请选择图片文件'); return }
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result || '')
      if (dataUrl.length > 400_000) { setSaveMsg('图片过大（>400KB），请压缩后重试'); return }
      setProfile(p => ({ ...p, avatar: dataUrl }))
      setSaveMsg('')
    }
    reader.readAsDataURL(f)
  }

  const save = async () => {
    setSaving(true)
    try {
      const r = await fetch(`${getBridgeUrl()}/api/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profile),
      })
      const data = await r.json()
      setSaveMsg(data.ok ? '已保存' : `保存失败：${data.error || ''}`)
    } catch (e) { setSaveMsg(`保存失败：${String(e)}`) }
    setSaving(false)
  }

  const changePwd = async () => {
    setPwdMsg(null)
    if (newPwd.length < 4) { setPwdMsg({ ok: false, text: '新密码至少 4 位' }); return }
    try {
      const r = await fetch(`${getBridgeUrl()}/api/auth/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword: oldPwd, newPassword: newPwd }),
      })
      const data = await r.json()
      if (data.ok) {
        setPwdMsg({ ok: true, text: data.wasUninitialized ? '已设置密码' : '密码已更新' })
        setOldPwd(''); setNewPwd(''); setAuthPhase('ok')
      } else {
        setPwdMsg({ ok: false, text: data.lockedForMs ? `尝试过多，已锁定 ${Math.round(data.lockedForMs / 1000)}s` : '旧密码不正确' })
      }
    } catch (e) { setPwdMsg({ ok: false, text: String(e) }) }
  }

  return (
    <TooltipProvider>
      <UtilityWindowShell>
        {/* 标签切换（密码库面板自带页头，故此处只在个人信息态显示页头） */}
        <div className="px-6 pt-3 flex items-center gap-1 border-b shrink-0">
          {([['profile', '个人信息', User], ['vault', '密码库', KeyRound]] as const).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 -mb-px text-sm rounded-t transition-colors border-b-2 ${
                tab === id
                  ? 'text-primary border-brand-500 font-medium'
                  : 'text-tertiary border-transparent hover:text-secondary'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
        </div>
        {tab === 'vault' && <VaultPanel />}
        {tab === 'profile' && (
        <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">
          {/* 页头 */}
          <div className="px-6 py-4 border-b flex items-center gap-2">
            <User className="w-5 h-5 text-brand-500" />
            <span className="text-base font-semibold text-primary">个人信息</span>
          </div>

          <div className="px-6 py-5 space-y-6 max-w-xl">
            {/* 头像 + 昵称 */}
            <div className="flex items-start gap-5">
              <div className="relative shrink-0">
                {profile.avatar ? (
                  <img src={profile.avatar} alt="头像" className="w-20 h-20 rounded-full object-cover border-2 border-brand-500/40" />
                ) : (
                  <div className="w-20 h-20 rounded-full bg-elevated border-2 border-dashed border-subtle flex items-center justify-center">
                    <User className="w-8 h-8 text-tertiary" />
                  </div>
                )}
                <button
                  onClick={() => fileRef.current?.click()}
                  className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-brand-500 text-white flex items-center justify-center hover:bg-brand-600 transition-colors shadow"
                  title="更换头像"
                >
                  <Camera className="w-3.5 h-3.5" />
                </button>
                <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={pickAvatar} />
              </div>
              <div className="flex-1 space-y-3 pt-1">
                <div>
                  <label className="block text-[11px] font-medium text-secondary mb-1">昵称</label>
                  <Input
                    value={profile.nickname}
                    onChange={e => setProfile(p => ({ ...p, nickname: e.target.value.slice(0, 64) }))}
                    placeholder="设置你的昵称"
                    className="h-8 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-secondary mb-1">简介</label>
                  <Textarea
                    value={profile.bio}
                    onChange={e => setProfile(p => ({ ...p, bio: e.target.value.slice(0, 500) }))}
                    placeholder="一句话介绍自己（可选）"
                    className="min-h-[64px] text-sm resize-y"
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Button variant="primary" size="sm" onClick={save} disabled={saving}>{saving ? '保存中…' : '保存资料'}</Button>
              {saveMsg && <span className="text-xs text-tertiary">{saveMsg}</span>}
            </div>

            {/* 认证状态 */}
            <div className="border-t pt-4">
              <div className="flex items-center gap-2 text-sm font-medium text-primary mb-3">
                <Lock className="w-4 h-4 text-brand-500" />
                账号安全
              </div>
              <div className="flex items-center gap-1.5 text-xs mb-4">
                {authPhase === 'uninitialized' ? (
                  <>
                    <AlertTriangle className="w-3.5 h-3.5 text-warning" />
                    <span className="text-warning">尚未设置登录密码</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5 text-success" />
                    <span className="text-secondary">已启用密码保护</span>
                  </>
                )}
              </div>
              <div className="space-y-2.5 max-w-sm">
                {authPhase !== 'uninitialized' && (
                  <div>
                    <label className="block text-[11px] font-medium text-secondary mb-1">当前密码</label>
                    <Input type="password" value={oldPwd} onChange={e => setOldPwd(e.target.value)} placeholder="输入当前密码" className="h-8 text-sm" />
                  </div>
                )}
                <div>
                  <label className="block text-[11px] font-medium text-secondary mb-1">新密码（至少 4 位）</label>
                  <Input type="password" value={newPwd} onChange={e => setNewPwd(e.target.value)} placeholder="输入新密码" className="h-8 text-sm" />
                </div>
                <div className="flex items-center gap-3">
                  <Button variant="primary" size="sm" onClick={changePwd} disabled={!newPwd}>{authPhase === 'uninitialized' ? '设置密码' : '修改密码'}</Button>
                  {pwdMsg && (
                    <span className={`text-xs ${pwdMsg.ok ? 'text-success' : 'text-error'}`}>{pwdMsg.text}</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
        )}
      </UtilityWindowShell>
    </TooltipProvider>
  )
}
