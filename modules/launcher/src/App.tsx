import React, { useEffect, useState } from 'react'
import { pickLaunchable, ModuleItem } from './launchable.ts'

declare global { interface Window { ponosRpc?: { call: (m: string, p?: any) => Promise<any> } } }

export function App() {
  const [mods, setMods] = useState<ModuleItem[]>([])
  const [err, setErr] = useState('')
  useEffect(() => {
    window.ponosRpc?.call('system.modules.list').then(r => {
      if (r?.ok) setMods(pickLaunchable(r.result))
      else setErr(String(r?.error || '加载失败'))
    })
  }, [])
  return (
    <div className="p-6 space-y-3">
      <h1 className="text-lg font-bold">Ponos 启动台</h1>
      {err && <p className="text-red-400">{err}</p>}
      {mods.map(m => (
        <button key={m.id} className="w-full py-2 px-4 rounded bg-[var(--bg-input)] hover:bg-[var(--bg-hover)] text-left"
          onClick={() => window.ponosRpc?.call('system.window.open', { moduleId: m.id })}>
          {m.name}
        </button>
      ))}
    </div>
  )
}
