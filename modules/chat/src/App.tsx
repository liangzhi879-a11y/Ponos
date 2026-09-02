import React, { useEffect, useRef, useState } from 'react'
import { reduceEvents, Msg, ChatState } from './events.ts'

declare global { interface Window { ponosRpc?: { call: (m: string, p?: any) => Promise<any>; on: (m: string, cb: (e: any) => void) => () => void } } }

export function App() {
  const [state, setState] = useState<ChatState>({ msgs: [], busy: false })
  const [input, setInput] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const off = window.ponosRpc?.on('agent.event', (env) => setState(s => reduceEvents(s, env.params)))
    return () => off?.()
  }, [])
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [state.msgs])
  const send = () => {
    if (!input.trim() || state.busy) return
    setState(s => ({ msgs: [...s.msgs, { role: 'user', text: input, ts: Date.now() }], busy: true }))
    window.ponosRpc?.call('agent.send', { text: input }).then(() => setState(s => ({ ...s, busy: false })))
    setInput('')
  }
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4 space-y-2" id="msg-list">
        {state.msgs.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'text-right' : 'text-left'}>
            <span className={`inline-block px-3 py-1 rounded ${m.role === 'user' ? 'bg-[var(--accent-cyan)] text-black' : 'bg-[var(--bg-input)]'}`}>{m.text}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="p-3 border-t border-[var(--border)] flex gap-2">
        <input className="flex-1 bg-[var(--bg-input)] rounded px-3 py-2" value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && send()} placeholder="输入消息，Enter 发送" />
        <button className="px-4 rounded bg-[var(--brand-500)] text-white" onClick={send} disabled={state.busy}>发送</button>
      </div>
    </div>
  )
}
