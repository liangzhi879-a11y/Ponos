import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  Menu, Settings, Sun, Moon, Palette, Check, Sparkles,
  Search, Terminal, ChevronDown, Minus, Square, Copy, X,
} from 'lucide-react'
import { Button } from '@/components/ui'
import { Tooltip } from '@/components/ui'
import { useUIStore } from '@/stores/uiStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useChatStore } from '@/stores/chatStore'
import { useTranslation } from '@/i18n/useTranslation'
import { cn } from '@/lib/utils'
import { THEMES, type ThemeMode, type ThemeMeta } from '@/types'

export function Header() {
  const { toggleSidebar, openCommandPalette, openSearch } = useUIStore()
  const { settings, updateSettings } = useSettingsStore()
  const { activeConversationId, conversations } = useChatStore()
  const { t } = useTranslation()
  const activeConv = conversations.find(c => c.id === activeConversationId)

  const activeTheme = THEMES.find(t => t.id === settings.theme) ?? THEMES[0]
  const ThemeIcon = settings.theme === 'light' || settings.theme === 'yuanfang-light' ? Sun : settings.theme === 'dark' ? Moon : Palette

  // Frameless window: track maximized state for the toggle icon
  const [isMax, setIsMax] = useState(false)
  // Track whether `window.ponosWindow` has been exposed by the preload
  // script. contextBridge runs before page scripts so it should be available
  // immediately in Electron; polling is a safety net for edge cases.
  const [hasWindowAPI, setHasWindowAPI] = useState(typeof window !== 'undefined' && !!window.ponosWindow)
  useEffect(() => {
    if (window.ponosWindow) {
      setHasWindowAPI(true)
      const sync = () => { window.ponosWindow?.isMaximized().then(setIsMax).catch(() => {}) }
      sync()
      window.addEventListener('resize', sync)
      return () => window.removeEventListener('resize', sync)
    }
    // Poll until preload attaches — fast for 10s then slow indefinitely so
    // window controls never stay missing in case of a slow preload init.
    let cancelled = false
    let fastInterval: number | undefined
    let slowInterval: number | undefined
    const tick = () => {
      if (cancelled) return
      if (window.ponosWindow) {
        setHasWindowAPI(true)
        clearInterval(fastInterval)
        clearInterval(slowInterval)
      }
    }
    fastInterval = window.setInterval(tick, 100)
    // After 10s switch to slow poll (every 2s) — keeps looking forever but
    // burns almost no CPU. In a browser dev server this is harmless; the
    // component just won't show window controls.
    const switchToSlow = window.setTimeout(() => {
      clearInterval(fastInterval)
      if (!cancelled) slowInterval = window.setInterval(tick, 2000)
    }, 10000)
    return () => {
      cancelled = true
      clearInterval(fastInterval)
      clearInterval(slowInterval)
      clearTimeout(switchToSlow)
    }
  }, [])

  return (
    // titleBarStyle:'hidden' 后系统 1px 边框四边对称（含顶部），不再需要 CSS 补顶线
    <header className="h-11 flex items-center gap-2 px-3 border-b bg-app drag-region shrink-0 relative">
      {/* Logo + Sidebar toggle */}
      <div className="flex items-center gap-2">
        {/* 品牌 Logo：透明底，直接展示不加背景衬套 */}
        <img src={`${import.meta.env.BASE_URL}logo.png`} alt="Ponos" className="w-7 h-7 object-contain shrink-0 no-drag glass-logo" />
        <Tooltip content={t('header.toggleSidebar') + ' (⌘B)'}>
          <Button variant="ghost" size="xs" onClick={toggleSidebar} className="no-drag" aria-label={t('header.toggleSidebar')}>
            <Menu className="w-4 h-4" />
          </Button>
        </Tooltip>
      </div>

      {/* Conversation title */}
      <div className="flex-1 min-w-0 text-sm font-medium text-secondary truncate ml-1">
        {activeConv?.title || 'Ponos dev'}
      </div>

      <div className="flex items-center gap-0.5 no-drag shrink-0">
        {/* Search */}
        <Tooltip content={t('search.title') + ' (⌘⇧F)'}>
          <Button variant="ghost" size="xs" onClick={openSearch} aria-label={t('search.title')}>
            <Search className="w-4 h-4" />
          </Button>
        </Tooltip>

        {/* Command Palette */}
        <Tooltip content={t('commandPalette.title') + ' (⌘K)'}>
          <Button variant="ghost" size="xs" onClick={openCommandPalette} aria-label={t('commandPalette.title')}>
            <Terminal className="w-4 h-4" />
          </Button>
        </Tooltip>

        {/* Theme switcher dropdown (rendered via portal — see below) */}
        <ThemeSwitcher
          activeTheme={activeTheme}
          ThemeIcon={ThemeIcon}
          currentThemeId={settings.theme}
          onChange={t => updateSettings({ theme: t })}
          t={t}
        />

        {/* Settings */}
        <Tooltip content={t('settings.title') + ' (⌘,)'}>
          <Button variant="ghost" size="xs" onClick={() => useUIStore.getState().openSettings()} aria-label={t('settings.title')}>
            <Settings className="w-4 h-4" />
          </Button>
        </Tooltip>
      </div>

      {/* Window controls (frameless) — only visible when running inside Electron
         (preload has attached window.ponosWindow). Browser dev mode hides them. */}
      {hasWindowAPI && (
        <div className="flex items-center -mr-3 no-drag shrink-0">
          <button
            onClick={() => window.ponosWindow?.minimize()}
            className="w-10 h-11 flex items-center justify-center text-tertiary hover:bg-elevated hover:text-primary transition-colors"
            aria-label="Minimize"
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => window.ponosWindow?.maximizeToggle()}
            className="w-10 h-11 flex items-center justify-center text-tertiary hover:bg-elevated hover:text-primary transition-colors"
            aria-label="Maximize"
          >
            {isMax ? <Copy className="w-3 h-3" /> : <Square className="w-3 h-3" />}
          </button>
          <button
            onClick={() => window.ponosWindow?.close()}
            className="window-close-btn w-10 h-11 flex items-center justify-center text-tertiary hover:bg-error hover:text-inverse transition-colors"
            aria-label="Close"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </header>
  )
}

/* ============================================================
   ThemeSwitcher — trigger button + portal-rendered dropdown
   ============================================================
   The dropdown is rendered into document.body via React Portal so
   it escapes any parent stacking context (in particular, the
   header's bg-app + drag-region which would otherwise trap it
   behind the main content's chat input border + background).
   ============================================================ */

const DROPDOWN_WIDTH = 320
const DROPDOWN_GAP = 6 // px between button and dropdown

interface ThemeSwitcherProps {
  activeTheme: ThemeMeta
  ThemeIcon: typeof Palette
  currentThemeId: ThemeMode
  onChange: (t: ThemeMode) => void
  t: (key: string) => string
}

function ThemeSwitcher({ activeTheme, ThemeIcon, currentThemeId, onChange, t }: ThemeSwitcherProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // Position of the dropdown in viewport coordinates. Updated on
  // open, on window scroll/resize, and on any scroll inside the app.
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)

  const updatePos = useCallback(() => {
    const btn = triggerRef.current
    if (!btn) return
    const r = btn.getBoundingClientRect()
    const right = Math.max(8, window.innerWidth - r.right)
    const top = r.bottom + DROPDOWN_GAP
    setPos({ top, right })
  }, [])

  // Compute position right after opening (before paint) so the
  // dropdown doesn't flash at the wrong place.
  useLayoutEffect(() => {
    if (open) updatePos()
  }, [open, updatePos])

  // Track scroll/resize while open so the dropdown follows the
  // button (otherwise it would be stranded in one spot).
  useEffect(() => {
    if (!open) return
    const onScroll = () => updatePos()
    const onResize = () => updatePos()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open, updatePos])

  // Close on outside click / Escape
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target)) return
      const panel = document.getElementById('theme-switcher-panel')
      if (panel?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <>
      <Tooltip
        content={t('settings.theme') + ': ' + activeTheme.name + (activeTheme.variant ? ' · ' + activeTheme.variant : '')}
      >
        <Button
          ref={triggerRef}
          variant="ghost"
          size="xs"
          onClick={() => setOpen(v => !v)}
          aria-label={t('settings.theme')}
          className={cn(
            'gap-1 px-2 min-w-[64px]',
            open && 'bg-elevated text-primary',
          )}
        >
          <ThemeIcon className="w-3.5 h-3.5" style={{ color: activeTheme.primary }} />
          <span className="text-[11px] font-medium">{activeTheme.name}</span>
          {activeTheme.variant && (
            <span className="text-[10px] text-tertiary">·{activeTheme.variant[0]}</span>
          )}
          <ChevronDown className={cn(
            'w-3 h-3 text-tertiary transition-transform duration-150',
            open && 'rotate-180',
          )} />
        </Button>
      </Tooltip>

      {open && pos && createPortal(
        <div
          id="theme-switcher-panel"
          role="menu"
          style={{
            position: 'fixed',
            top: pos.top,
            right: pos.right,
            width: DROPDOWN_WIDTH,
            zIndex: 100,
            background: 'var(--popover-bg)',
            backdropFilter: 'blur(var(--popover-blur))',
            WebkitBackdropFilter: 'blur(var(--popover-blur))',
          }}
          className={cn(
            'origin-top-right rounded-xl overflow-hidden',
            'border border',
            'shadow-2xl shadow-black/40',
            'animate-slide-down backdrop-blur-md',
          )}
        >
          {/* Menu header */}
          <div className="px-3.5 py-3 border-b border bg-elevated">
            <div className="flex items-center gap-2">
              <Palette className="w-3.5 h-3.5 text-tertiary" />
              <div className="text-[10px] font-bold text-secondary uppercase tracking-wider">
                {t('settings.theme')}
              </div>
            </div>
            <div className="text-[11px] text-tertiary mt-1 leading-snug">
              {t('themeSwitcher.title')} · {activeTheme.name} {activeTheme.isDefault ? t('common.default') : ''}
            </div>
          </div>

          {/* Theme rows */}
          <div className="p-2 space-y-1">
            {THEMES.map(theme => (
              <ThemeRow
                key={theme.id}
                theme={theme}
                active={currentThemeId === theme.id}
                onSelect={() => {
                  onChange(theme.id)
                  setOpen(false)
                }}
              />
            ))}
          </div>

          {/* Footer hint */}
          <div className="px-3.5 py-2.5 border-t border bg-elevated">
            <div className="text-[10px] text-tertiary leading-snug">
              {t('settings.title')}: <kbd>⌘,</kbd>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

/* ============================================================
   ThemeRow — one row in the theme switcher dropdown
   ============================================================ */
function ThemeRow({
  theme,
  active,
  onSelect,
}: {
  theme: ThemeMeta
  active: boolean
  onSelect: () => void
}) {
  const { t } = useTranslation()
  return (
    <button
      onClick={onSelect}
      role="menuitemradio"
      aria-checked={active}
      className={cn(
        'group w-full flex items-center gap-3 px-2.5 py-2 rounded-lg text-left transition-colors',
        active
          ? 'bg-brand-500/20 text-primary ring-1 ring-brand-500/30'
          : 'text-secondary hover:bg-elevated',
      )}
    >
      {/* Mini swatch — cleaner 3-pane app preview */}
      <div
        className="relative shrink-0 w-11 h-11 rounded-md overflow-hidden ring-1 ring-border"
        style={{ background: theme.surface }}
      >
        {/* faux sidebar */}
        <div
          className="absolute inset-y-0 left-0 w-3"
          style={{ background: theme.primary, opacity: 0.85 }}
        />
        {/* faux content lines */}
        <div className="absolute left-4 right-1.5 top-2 space-y-1">
          <div
            className="h-[3px] rounded-sm"
            style={{ background: theme.primary, opacity: 0.45, width: '85%' }}
          />
          <div
            className="h-[3px] rounded-sm"
            style={{ background: theme.primary, opacity: 0.30, width: '60%' }}
          />
          <div
            className="h-[3px] rounded-sm"
            style={{ background: theme.primary, opacity: 0.20, width: '70%' }}
          />
        </div>
        {/* deep accent dot */}
        <div
          className="absolute right-1.5 bottom-1.5 w-1.5 h-1.5 rounded-full"
          style={{ background: theme.deep }}
        />
      </div>

      {/* Text */}
      <div className="flex-1 min-w-0">
        {/* Title row */}
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className="text-sm font-semibold text-primary truncate">
            {theme.name}
            {theme.variant && (
              <span className="text-tertiary font-normal ml-1">
                {theme.variant}
              </span>
            )}
          </span>
          {theme.isDefault && (
            <span
              className="inline-flex items-center gap-0.5 px-1.5 h-4 rounded text-[9px] font-bold uppercase tracking-wider shrink-0"
              style={{
                background: theme.primary,
                color: 'var(--text-inverse)',
              }}
              title={t('common.default')}
            >
              <Sparkles className="w-2 h-2" />
              {t('common.default')}
            </span>
          )}
        </div>
        {/* Tagline */}
        <div className="text-[11px] text-tertiary truncate leading-tight">
          {theme.tagline}
        </div>
      </div>

      {/* Active check */}
      <div className="shrink-0 w-4 h-4 flex items-center justify-center">
        {active && (
          <Check
            className="w-4 h-4"
            style={{ color: theme.primary }}
            strokeWidth={3}
          />
        )}
      </div>
    </button>
  )
}
