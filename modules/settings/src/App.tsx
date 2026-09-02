import React, { useEffect, useState } from 'react'
import { DEFAULT_SETTINGS, reduceSettings, type SettingsState } from './state'

declare global { interface Window { ponosRpc?: { call: (m: string, p?: any) => Promise<any>; on: (m: string, cb: (e: any) => void) => () => void } } }

const THEMES = [
  { id: 'vaporwave', label: 'Vaporwave' },
  { id: 'dark', label: '深色' },
  { id: 'light', label: '浅色' },
]

export function App() {
  const [state, setState] = useState<SettingsState>(DEFAULT_SETTINGS)
  useEffect(() => {
    window.ponosRpc?.call('state.get', { key: 'settings' }).then(r => {
      if (r?.ok && r.result?.value) setState(s => ({ ...s, ...r.result.value }))
    })
    const off = window.ponosRpc?.on('event:state.changed', (env) => setState(s => reduceSettings(s, env?.params)))
    return () => off?.()
  }, [])
  const setTheme = (theme: string) => {
    const next = { ...state, theme }
    setState(next)
    window.ponosRpc?.call('state.set', { key: 'settings', value: next, from: 'settings' })
  }
  return (
    <div className="p-6 space-y-4">
      <h2 className="text-base font-bold">设置</h2>
      <label className="block text-sm text-[var(--text-secondary)]">主题</label>
      <select className="w-full bg-[var(--bg-input)] rounded px-3 py-2" value={state.theme} onChange={e => setTheme(e.target.value)}>
        {THEMES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
      </select>
      <p className="text-xs text-[var(--text-tertiary)]">状态经 state-manager 全局同步：打开两个设置窗口，此处修改会实时同步到所有订阅窗口。</p>
    </div>
  )
}
