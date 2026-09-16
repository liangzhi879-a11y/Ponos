import './styles/globals.css'
import './styles/boot.css'
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { THEME_CLASS_NAMES, type ThemeMode } from '@/types'
import { migrateThemeId } from './lib/themeMap'
import { hydrateSecretsFromVault } from '@/stores/settingsStore'

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
}
const THEME_FG: Record<ThemeMode, string> = {
  'dark':         '#f0e6d8',
  'light':        '#24272c',
  'dark-glass':   '#f0e6d8',
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

// 密钥注水（2026-09-15）：模型 authToken 已从 localStorage 移入密码库（safeStorage 加密），
// 故每个渲染进程启动后都要把密钥从库注入设置状态——否则界面看到的是"没配密钥"。
// 放在这里而不是各窗口组件内：main.tsx 是所有窗口（主窗/设置窗/个人信息窗…）的唯一入口，
// 一处覆盖全部；且必须在首帧渲染之后（不阻塞启动，失败也只是本次显示为未配置，
// 下一次启动会重试迁移）。失败仅记录，不弹窗打断用户。
void hydrateSecretsFromVault().then(r => {
  if (!r.ok) console.warn('[vault] 密钥注水未完成：', r.error)
})
