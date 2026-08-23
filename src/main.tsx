import './styles/globals.css'
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { THEMES, THEME_CLASS_NAMES, type ThemeMode } from '@/types'

/* ------------------------------------------------------------
   Pre-mount: migrate old localStorage keys, then read the
   persisted theme so we can swap the theme class on <html>
   before React paints.
   ------------------------------------------------------------ */

// One-way migration: copy old claude-code-* keys to ponos-* if new key doesn't exist yet
;(function migrateStorageKeys() {
  const pairs: Array<[string, string]> = [
    ['claude-code-settings', 'ponos-settings'],
    ['claude-code-chat', 'ponos-chat'],
    ['claude-code-ui-v2', 'ponos-ui'],
  ]
  for (const [oldKey, newKey] of pairs) {
    const oldVal = localStorage.getItem(oldKey)
    if (oldVal && !localStorage.getItem(newKey)) {
      localStorage.setItem(newKey, oldVal)
    }
  }
})()
const THEME_BG: Record<ThemeMode, string> = {
  'shadow': '#0d0d11',
}
const THEME_FG: Record<ThemeMode, string> = {
  'shadow': '#f0f0f6',
}

try {
  const raw = localStorage.getItem('ponos-settings') || localStorage.getItem('claude-code-settings')
  if (raw) {
    const parsed = JSON.parse(raw) as {
      state?: { settings?: { theme?: string } }
    }
    const theme = parsed?.state?.settings?.theme
    if (THEMES.some(t => t.id === theme)) {
      const t = theme as ThemeMode
      const root = document.documentElement
      root.classList.remove(...THEME_CLASS_NAMES)
      root.classList.add(`theme-${t}`)
      document.body.style.background = THEME_BG[t]
      document.body.style.color = THEME_FG[t]
    }
  }
} catch {
  // localStorage may be unavailable (e.g. private mode) — keep default
}

const container = document.getElementById('root')
if (!container) {
  throw new Error('Mount failed: <div id="root"> not found')
}

const root = createRoot(container)
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
