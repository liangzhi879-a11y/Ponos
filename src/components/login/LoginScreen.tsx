import { useViewStore } from '@/stores/viewStore'
import { useTranslation } from '@/i18n/useTranslation'

export function LoginScreen() {
  const { t } = useTranslation()
  const enter = useViewStore(s => s.enter)
  return (
    <div className="h-full w-full flex flex-col items-center justify-center bg-app relative overflow-hidden"
      style={{ backgroundImage: 'var(--shadow-bg-image)', backgroundSize: 'cover', backgroundPosition: 'center' }}>
      <div className="absolute inset-0 bg-app/70" />
      <div className="relative flex flex-col items-center gap-8 animate-fade-in">
        <div className="w-28 h-28 rounded-full overflow-hidden ring-2 ring-brand-500/60 shadow-[0_0_50px_rgba(255,45,148,0.55)]">
          <img src="/logo.png" alt="Ponos" className="w-full h-full object-cover" />
        </div>
        <div className="text-center">
          <div className="font-display font-bold tracking-[0.3em] text-3xl text-primary select-none">PONOS</div>
          <div className="text-sm text-secondary mt-2">{t('login.tagline')}</div>
        </div>
        <button
          onClick={enter}
          className="px-10 py-3 rounded-full text-sm font-semibold text-inverse transition-all hover:scale-[1.03] active:scale-[0.98]"
          style={{ background: 'linear-gradient(135deg, var(--brand-500), var(--brand-600))', boxShadow: '0 0 24px rgba(255,45,148,0.4)' }}
        >
          {t('login.enter')}
        </button>
        <div className="text-[10px] text-tertiary">{t('login.version')} {__APP_VERSION__}</div>
      </div>
    </div>
  )
}
