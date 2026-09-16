// src/components/auth/PasswordField.tsx —— 登录/首设密码共用的受控密码输入框
// 设计语言（2026-09-10）：输入框 = .cut.focusable 切角细线框（聚焦热边）+ .ci 内层；
// 错误态 = .cut.err 红线。不用共享 Input 组件（其自带 border/rounded 会与切角框双线重叠），
// 直接渲染原生 input。可见性切换（Eye/EyeOff）+ 错误红框 + 抖动（animate-shake，0.3s）：
// 每次 error 文案变化或 shakeKey 递增（视图在每次提交失败后 +1）都重播，
// 同文案连续失败也不失效；动画结束 onAnimationEnd 摘掉类，便于下次重加。
import { useEffect, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/useTranslation'

export interface PasswordFieldProps {
  value: string
  onChange: (v: string) => void
  /** 输入框上方的标签文案（走 i18n，调用方传入已翻译文本） */
  label?: string
  /** 错误文案（已本地化）；为空/undefined 时不显示错误态 */
  error?: string | null
  onEnter?: () => void
  autoFocus?: boolean
  disabled?: boolean
  /** 每次失败提交递增 → 强制抖动重播（不依赖 error 文案变化） */
  shakeKey?: number
}

export function PasswordField({
  value,
  onChange,
  label,
  error,
  onEnter,
  autoFocus,
  disabled,
  shakeKey = 0,
}: PasswordFieldProps) {
  const { t } = useTranslation()
  const [visible, setVisible] = useState(false)
  const [shaking, setShaking] = useState(false)

  // 错误抖动触发器：error 文案变化或 shakeKey 递增都重加 .animate-shake；
  // 动画放完（onAnimationEnd）后自动摘类，同一错误再次触发可重播。
  useEffect(() => {
    if (error) setShaking(true)
  }, [error, shakeKey])

  return (
    <div
      className={cn('w-full', error && shaking && 'animate-shake')}
      onAnimationEnd={() => setShaking(false)}
    >
      {label && (
        <label className="block text-xs font-medium text-secondary mb-1.5">
          {label}
        </label>
      )}
      <div className={cn('cut focusable', error && 'err')}>
        <div className="ci relative" style={{ background: 'var(--bg-input)' }}>
          <input
            type={visible ? 'text' : 'password'}
            value={value}
            disabled={disabled}
            autoFocus={autoFocus}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !disabled && !e.nativeEvent.isComposing) {
                e.preventDefault()
                onEnter?.()
              }
            }}
            className="w-full h-9 bg-transparent px-3 pr-10 text-sm text-primary placeholder:text-tertiary focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          />
          <div className="absolute right-2.5 top-1/2 -translate-y-1/2 text-tertiary">
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setVisible(v => !v)}
              className="h-6 w-6 flex items-center justify-center rounded text-tertiary hover:text-secondary transition-colors focus-visible:outline-none"
              aria-label={visible ? t('auth.hide') : t('auth.show')}
              title={visible ? t('auth.hide') : t('auth.show')}
            >
              {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>
      {error && <p className="mt-1 text-xs text-error">{error}</p>}
    </div>
  )
}
