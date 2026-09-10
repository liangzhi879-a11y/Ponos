import './styles/globals.css'
import './styles/boot.css'
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { THEME_CLASS_NAMES, type ThemeMode } from '@/types'
import { migrateThemeId } from './lib/themeMap'

/* ------------------------------------------------------------
   Pre-mount: migrate old localStorage keys, then read the
   persisted theme so we can swap the theme class on <html>
   before React paints.
   ------------------------------------------------------------ */

// One-way migration: copy old claude-code-* keys to yfworking-* if new key doesn't exist yet
;(function migrateStorageKeys() {
  const pairs: Array<[string, string]> = [
    ['claude-code-settings', 'yfworking-settings'],
    ['claude-code-chat', 'yfworking-chat'],
    ['claude-code-ui-v2', 'yfworking-ui'],
  ]
  for (const [oldKey, newKey] of pairs) {
    const oldVal = localStorage.getItem(oldKey)
    if (oldVal && !localStorage.getItem(newKey)) {
      localStorage.setItem(newKey, oldVal)
    }
  }
})()
const THEME_BG: Record<ThemeMode, string> = {
  'dark':         '#0b0e14',
  'light':        '#fdf9f5',
  'dark-glass':   '#11161f',   // 玻璃主题取面板基色兜底（首帧由 class 接管）
  'light-glass':  '#fffdfb',
}
const THEME_FG: Record<ThemeMode, string> = {
  'dark':         '#f0e6d8',
  'light':        '#24272c',
  'dark-glass':   '#f0e6d8',
  'light-glass':  '#24272c',
}

try {
  const raw = localStorage.getItem('yfworking-settings') || localStorage.getItem('claude-code-settings')
  if (raw) {
    const parsed = JSON.parse(raw) as {
      state?: { settings?: { theme?: string } }
    }
    const tid = migrateThemeId(parsed?.state?.settings?.theme)
    if (THEME_BG[tid]) {
      const root = document.documentElement
      root.classList.remove(...THEME_CLASS_NAMES)
      root.classList.add(`theme-${tid}`)
      document.body.style.background = THEME_BG[tid]
      document.body.style.color = THEME_FG[tid]
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
