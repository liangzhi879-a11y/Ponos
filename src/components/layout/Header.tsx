import { useEffect, useState } from 'react'
import {
  Menu, Settings, Search, Terminal, Minus, Square, Copy, X,
} from 'lucide-react'
import { Button } from '@/components/ui'
import { Tooltip } from '@/components/ui'
import { useUIStore } from '@/stores/uiStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useChatStore } from '@/stores/chatStore'
import { useTranslation } from '@/i18n/useTranslation'

export function Header() {
  const { toggleSidebar, openCommandPalette, openSearch } = useUIStore()
  const { settings, updateSettings } = useSettingsStore()
  const { activeConversationId, conversations } = useChatStore()
  const { t } = useTranslation()
  const activeConv = conversations.find(c => c.id === activeConversationId)

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
    <header className="h-12 flex items-center gap-3 px-4 border-b bg-app drag-region shrink-0 relative">
      {/* SHADOW 品牌区：漩涡图标 + 品牌名 + 侧边栏开关 */}
      <div className="flex items-center gap-2.5 shrink-0">
        <div className="w-8 h-8 rounded-full overflow-hidden ring-2 ring-brand-500/60 shadow-[0_0_12px_rgba(255,45,148,0.5)] no-drag">
          <img src="/shadow-theme/icon-vortex.png" alt="SHADOW" className="w-full h-full object-cover" />
        </div>
        <span className="font-display font-bold tracking-[0.2em] text-sm text-primary no-drag select-none">
          SHADOW
        </span>
        <Tooltip content={t('header.toggleSidebar') + ' (⌘B)'}>
          <Button variant="ghost" size="xs" onClick={toggleSidebar} className="no-drag ml-1" aria-label={t('header.toggleSidebar')}>
            <Menu className="w-4 h-4" />
          </Button>
        </Tooltip>
      </div>

      {/* 会话标题 */}
      <div className="flex-1 min-w-0 text-sm font-medium text-secondary truncate ml-2">
        {activeConv?.title || 'Ponos 会话'}
      </div>

      {/* 右侧工具：搜索/命令面板/设置 */}
      <div className="flex items-center gap-0.5 no-drag shrink-0">
        <Tooltip content={t('search.title') + ' (⌘⇧F)'}>
          <Button variant="ghost" size="xs" onClick={openSearch} aria-label={t('search.title')}>
            <Search className="w-4 h-4" />
          </Button>
        </Tooltip>

        <Tooltip content={t('commandPalette.title') + ' (⌘K)'}>
          <Button variant="ghost" size="xs" onClick={openCommandPalette} aria-label={t('commandPalette.title')}>
            <Terminal className="w-4 h-4" />
          </Button>
        </Tooltip>

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
            className="w-10 h-12 flex items-center justify-center text-tertiary hover:bg-elevated hover:text-primary transition-colors"
            aria-label="Minimize"
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => window.ponosWindow?.maximizeToggle()}
            className="w-10 h-12 flex items-center justify-center text-tertiary hover:bg-elevated hover:text-primary transition-colors"
            aria-label="Maximize"
          >
            {isMax ? <Copy className="w-3 h-3" /> : <Square className="w-3 h-3" />}
          </button>
          <button
            onClick={() => window.ponosWindow?.close()}
            className="window-close-btn w-10 h-12 flex items-center justify-center text-tertiary hover:bg-error hover:text-inverse transition-colors"
            aria-label="Close"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </header>
  )
}
