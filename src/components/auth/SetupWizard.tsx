// src/components/auth/SetupWizard.tsx —— 首设密码向导表单体
// 由 AuthScreen 在 phase==='uninitialized' 时渲染（外层 AuthFrame 已给出
// setupTitle/setupHint 与品牌 logo，本组件只负责两个密码输入框 + 提交）：
//   · 客户端校验：长度 ≥4、两次一致（mismatch 挂确认框、tooShort 挂密码框）；
//   · 通过后 authStore.setup(pw) → 成功即"设置即解锁"，发 IPC auth:granted
//     （认证小窗语义，见 AuthScreen.tsx 头注释——主进程接管窗口切换，不再 setView）；
//   · setup 失败：失败文案取 store.error（服务端兜底校验，正常流程不会走到），
//     "already initialized"（并发窗口已初始化）则重 init() 刷新为登录态。
// 所有文案走 i18n（auth.*），不硬编码。
import { useState } from 'react'
import { Button } from '@/components/ui'
import { useTranslation } from '@/i18n/useTranslation'
import { useAuthStore } from '@/stores/authStore'
import { PasswordField } from './PasswordField'

/** 认证通过（login ok / setup 即解锁）→ 通知主进程关小窗、开主窗口（spec §2.0）。 */
const grant = () => { window.yfworkingWindow?.authGranted?.() }

export function SetupWizard() {
  const { t } = useTranslation()
  const setup = useAuthStore(s => s.setup)
  const init = useAuthStore(s => s.init)
  const pending = useAuthStore(s => s.pending)

  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  /** 本地校验错：'tooShort'（挂密码框）/ 'mismatch'（挂确认框） */
  const [fieldErr, setFieldErr] = useState<'tooShort' | 'mismatch' | null>(null)
  /** 服务端 setup 失败原文（走失败分支才出现；正常路径不可达） */
  const [serverErr, setServerErr] = useState<string | null>(null)
  /** 每次失败递增 → PasswordField 抖动重播（同文案连续失败也有效） */
  const [shakeKey, setShakeKey] = useState(0)

  const clearErrors = () => {
    setFieldErr(null)
    setServerErr(null)
  }

  const submit = async () => {
    if (pending) return
    if (!pw || pw.length < 4) {
      setFieldErr('tooShort')
      setShakeKey(k => k + 1)
      return
    }
    if (pw !== confirm) {
      setFieldErr('mismatch')
      setShakeKey(k => k + 1)
      return
    }
    clearErrors()
    const ok = await setup(pw)
    if (ok) {
      // setup 即解锁：IPC auth:granted → 主进程关小窗、开主窗口（bridge token 每次启动失效）
      grant()
      return
    }
    const raw = useAuthStore.getState().error
    setShakeKey(k => k + 1)
    if (raw && raw.includes('already initialized')) {
      // 并发窗口下另一侧已完成首设 → 刷新 status 让 AuthScreen 回登录视图
      setServerErr(null)
      void init()
      return
    }
    if (raw && raw.includes('too short')) {
      setFieldErr('tooShort')
    } else {
      setServerErr(raw)
    }
  }

  const errText = serverErr ?? (fieldErr === 'tooShort' ? t('auth.tooShort') : undefined)
  const confirmErr = fieldErr === 'mismatch' ? t('auth.mismatch') : undefined

  return (
    <>
      <PasswordField
        label={t('auth.passwordLabel')}
        value={pw}
        onChange={(v) => { setPw(v); clearErrors() }}
        error={errText}
        onEnter={() => void submit()}
        autoFocus
        disabled={pending}
        shakeKey={shakeKey}
      />
      <PasswordField
        label={t('auth.confirmLabel')}
        value={confirm}
        onChange={(v) => { setConfirm(v); clearErrors() }}
        error={confirmErr}
        onEnter={() => void submit()}
        disabled={pending}
        shakeKey={shakeKey}
      />
      {/* 主 CTA：cut-btn 切角框 + ci（Button 自带圆角被 ci 的 9px clip 裁成签名斜边） */}
      <div className="cut-btn w-full">
        <div className="ci">
          <Button
            className="w-full"
            size="lg"
            loading={pending}
            onClick={() => void submit()}
          >
            {t('common.confirm')}
          </Button>
        </div>
      </div>
    </>
  )
}
