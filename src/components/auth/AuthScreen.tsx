// src/components/auth/AuthScreen.tsx —— 登录/锁定/向导路由宿主 + 主题相关登录视觉
// 由 AuthWindowRoot（?auth=1 独立认证小窗，D11-D13/Task 6b）渲染——不再是主窗口视图：
//   · mount 即 init() 拉一次 status（占位屏时代从不触发，phase 恒 unknown——Task 5 ledger 修复点）；
//   · uninitialized → SetupWizard（首设密码向导）；locked → LockedView（lockedForMs 倒计时）；
//   · ok / setup-done → LoginView。login 成功 → IPC auth:granted（主进程关小窗、开主窗口），
//     不再 setView——主窗口视图机由主进程放行后才创建并自 'boot' 开场（bridge token 每次
//     启动失效，生产语义每次启动需登录，见 task-6-brief Interfaces）。
// 背景决策（2026-09-10 GUI 统一）：整屏 bg-app 主题底 + 两枚品牌 orb 光晕；字标按主题明暗
// 切换（dark/dark-glass → 白字标；light → 深字标），不再强制深色底。
// 卡 = cut hot topline（单对角切角 + 热边 + 签名顶线），磨砂/底色由 ci 的 --bg-elevated 接管
// （玻璃主题自动半透明）。
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Lock, RefreshCw } from 'lucide-react'
import { useTranslation } from '@/i18n/useTranslation'
import { useAuthStore } from '@/stores/authStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { Button } from '@/components/ui'
import { BOOST_LOGO_LIGHT, BOOST_LOGO_DARK } from '@/lib/assets'
import { SetupWizard } from './SetupWizard'
import { PasswordField } from './PasswordField'

/** 认证通过（login ok / setup 即解锁）→ 通知主进程关小窗、开主窗口（spec §2.0）。 */
const grant = () => { window.yfworkingWindow?.authGranted?.() }

/** 认证屏通用外框：主题底 + 品牌 orb + 明暗字标（呼吸光晕）+ 居中切角热边卡（签名顶线） */
function AuthFrame({
  title,
  subtitle,
  footer,
  children,
}: {
  title?: string
  subtitle?: string
  footer?: string
  children: ReactNode
}) {
  const theme = useSettingsStore(s => s.settings.theme)
  const darkTheme = theme === 'dark' || theme === 'dark-glass'

  return (
    <div className="h-full w-full bg-app relative flex items-center justify-center overflow-hidden">
      {/* 品牌光晕 orb（白名单④静态渐变；定位在 420×560 认证小窗内） */}
      <div className="orb" style={{ width: 340, height: 340, left: -90, top: -70 }} />
      <div className="orb" style={{ width: 300, height: 300, right: -70, bottom: -70, opacity: 0.7 }} />
      <div className="w-full max-w-sm flex flex-col items-center px-6 animate-fade-in relative">
        {/* 字标：按主题明暗切换 + 呼吸光晕（白名单①） */}
        <div className="relative mb-1">
          <div
            className="breath absolute -inset-10 rounded-full pointer-events-none"
            style={{ background: 'radial-gradient(circle, var(--halo), transparent 62%)' }}
          />
          <img src={darkTheme ? BOOST_LOGO_LIGHT : BOOST_LOGO_DARK} alt="YFWorking" className="boot-logo relative" draggable={false} />
        </div>
        <div className="micro mb-8">YFWORKING · BOOST</div>
        <div
          className="cut hot topline w-full animate-scale-in"
          style={{ filter: 'drop-shadow(var(--modal-drop))' }}
        >
          <div className="ci p-6">
            {title && <h1 className="text-lg font-semibold text-primary">{title}</h1>}
            {subtitle && <p className="mt-1.5 text-xs leading-relaxed text-secondary">{subtitle}</p>}
            <div className="mt-5 flex flex-col gap-4">{children}</div>
          </div>
        </div>
        {footer && <p className="mt-4 text-[11px] text-tertiary">{footer}</p>}
      </div>
    </div>
  )
}

/** 登录视图：单密码框 + 主按钮（pending 禁用转圈）+ Enter 提交；423 锁定 → LockedView */
function LoginView() {
  const { t } = useTranslation()
  const pending = useAuthStore(s => s.pending)
  const storeError = useAuthStore(s => s.error)
  const login = useAuthStore(s => s.login)
  const [pw, setPw] = useState('')
  const [shakeKey, setShakeKey] = useState(0)

  // 每次挂载登录表单清一次陈旧 error：423 锁定期满（或并发首设）后 init() 只更新
  // phase/lockedForMs 不清 error，重挂载若仍残留上次 'bad-password' → 首帧即红框 + 抖动。
  // 用 layout effect 在浏览器绘制前清，保证用户看不到任何一帧残留错误（本文件内无其它
  // phase 路径受影响：本视图存活期间的失败登录由 login() 自行 set error，不经过此处）。
  useLayoutEffect(() => {
    useAuthStore.setState({ error: null })
  }, [])

  const submit = async () => {
    if (pending) return
    const ok = await login(pw)
    if (!ok) {
      setShakeKey(k => k + 1)
      // 423：authStore.login 已把 error/lockedForMs 写入 → setPhase('locked') 切 LockedView
      if (useAuthStore.getState().lockedForMs != null) {
        useAuthStore.getState().setPhase('locked')
        return
      }
      setPw('') // 密码错误清空重输
      return
    }
    grant() // 登录成功 → IPC auth:granted：主进程关认证小窗并创建主窗口（boot 开场）
  }

  // 服务端失败文案映射：已知 'bad-password' 走 i18n auth.error；其余（网络异常等）原样展示兜底
  const errText = !storeError ? undefined : storeError === 'bad-password' ? t('auth.error') : storeError

  return (
    <AuthFrame title={t('auth.title')} subtitle={t('auth.subtitle')} footer={t('auth.remember')}>
      <PasswordField
        label={t('auth.passwordLabel')}
        value={pw}
        onChange={setPw}
        error={errText}
        onEnter={() => void submit()}
        autoFocus
        disabled={pending}
        shakeKey={shakeKey}
      />
      {/* 主 CTA：cut-btn 切角框 + ci（Button 自带圆角被 ci 的 9px clip 裁成签名斜边） */}
      <div className="cut-btn w-full">
        <div className="ci">
          <Button className="w-full" size="lg" loading={pending} onClick={() => void submit()}>
            {t('auth.login')}
          </Button>
        </div>
      </div>
    </AuthFrame>
  )
}

/** 锁定视图：lockedForMs 倒计时（本地 1s 递减）→ 归零自动 init() 刷新；可手动重试 */
function LockedView() {
  const { t } = useTranslation()
  const lockedForMs = useAuthStore(s => s.lockedForMs)
  const init = useAuthStore(s => s.init)
  const [secs, setSecs] = useState(() => Math.max(1, Math.ceil((lockedForMs ?? 0) / 1000)))
  const autoInitRef = useRef(false)

  // init 返回仍为 locked（或 423 转入）→ lockedForMs 刷新时重设倒计时
  useEffect(() => {
    setSecs(Math.max(1, Math.ceil((lockedForMs ?? 0) / 1000)))
    autoInitRef.current = false
  }, [lockedForMs])

  // 每 1s 递减本地 state；归零自动重 init()（期间保持显示 1，避免"等待 0 秒"文案闪现）
  useEffect(() => {
    const iv = window.setInterval(() => {
      setSecs(prev => {
        if (prev > 1) return prev - 1
        if (!autoInitRef.current) {
          autoInitRef.current = true
          void init()
        }
        return 1
      })
    }, 1000)
    return () => window.clearInterval(iv)
  }, [init])

  return (
    <AuthFrame title={t('auth.title')}>
      <div className="flex flex-col items-center gap-3 py-1">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-error/15 text-error">
          <Lock className="h-4 w-4" />
        </div>
        <p className="text-sm leading-relaxed text-secondary text-center">
          {t('auth.locked', { seconds: secs })}
        </p>
        <Button
          variant="secondary"
          className="w-full mt-1"
          leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
          onClick={() => {
            autoInitRef.current = true
            void init()
          }}
        >
          {t('common.retry')}
        </Button>
      </div>
    </AuthFrame>
  )
}

export function AuthScreen() {
  const { t } = useTranslation()
  const phase = useAuthStore(s => s.phase)
  const init = useAuthStore(s => s.init)
  const [ready, setReady] = useState(false)

  // mount 时拉一次 status（含锁定剩余/是否已首设）；期间不闪任何表单
  useEffect(() => {
    let alive = true
    void init().then(() => {
      if (alive) setReady(true)
    })
    return () => {
      alive = false
    }
  }, [init])

  if (!ready) {
    return (
      <AuthFrame>
        <div className="flex items-center justify-center py-2">
          <span
            className="h-5 w-5 rounded-full border-2 border-tertiary border-t-transparent animate-spin"
            aria-label={t('common.loading')}
          />
        </div>
      </AuthFrame>
    )
  }
  if (phase === 'uninitialized') {
    return (
      <AuthFrame title={t('auth.setupTitle')} subtitle={t('auth.setupHint')}>
        <SetupWizard />
      </AuthFrame>
    )
  }
  if (phase === 'locked') return <LockedView />
  return <LoginView /> // ok / setup-done 均回登录视图
}
