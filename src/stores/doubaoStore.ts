import { create } from 'zustand'
import { nanoid } from 'nanoid'
import { getBridgeUrl } from '@/lib/config'
import type { DoubaoStatus, DoubaoResult } from '@/types'

interface State {
  status: DoubaoStatus | null
  generating: boolean
  results: DoubaoResult[]
  history: DoubaoResult[]
  busy: boolean
  error: string | null
  refreshStatus: () => Promise<void>
  generate: (p: { prompt: string; imageBase64?: string; ratio?: string; count?: number }) => Promise<void>
  loadHistory: () => Promise<void>
  removeHistory: (id: string) => Promise<void>
  insertImage: (att: { name: string; path: string; preview?: string }) => void
}

const bridge = () => getBridgeUrl()

export const useDoubaoStore = create<State>((set, get) => ({
  status: null, generating: false, results: [], history: [], busy: false, error: null,

  refreshStatus: async () => {
    try {
      const s = await window.doubao?.getStatus?.()
      set({ status: s || { loggedIn: false, exportedAt: null } })
    } catch { set({ status: { loggedIn: false, exportedAt: null } }) }
  },

  generate: async (p) => {
    set({ generating: true, busy: true })
    try {
      const payload = { prompt: p.prompt, ratio: p.ratio, count: p.count || 1 }
      let resp
      if (p.imageBase64) {
        resp = await window.doubao?.instant?.({ prompt: p.prompt, imageBase64: p.imageBase64 })
      } else {
        resp = await window.doubao?.generate?.(payload)
      }
      if (!resp) { set({ error: 'IPC 不可用' }); return }
      if (resp.code === 401) { set({ status: { loggedIn: false, exportedAt: null }, error: null }); return }
      if (resp.code !== 0) {
        const diag = resp.diag || resp.sse
          ? ' | ' + JSON.stringify({ sse: resp.sse, diag: resp.diag }).slice(0, 500)
          : ''
        set({ error: (resp.message || '生成失败') + diag })
        return
      }
      const urls: string[] = resp.data?.images || []
      const items: DoubaoResult[] = []
      for (const u of urls) {
        // 去水印下载：经 bridge 处理并落盘，返回本地 id 与磁盘绝对路径；429 限流等 3s 重试一次
        let id: string | null = null
        let diskPath: string | undefined
        for (let attempt = 0; attempt < 2 && !id; attempt++) {
          try {
            const r = await fetch(`${bridge()}/ponos/doubao/download`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: u }),
            })
            const d = await r.json()
            if (d.ok) { id = d.id; diskPath = d.path }
            else if (r.status === 429) { await new Promise(res => setTimeout(res, 3000)) }
          } catch { id = null }
        }
        if (id) {
          items.push({ id, prompt: p.prompt, imageUrl: `${bridge()}/ponos/doubao/images/${id}`, path: diskPath, createdAt: Date.now() })
        }
      }
      set({ error: null, results: items })
      for (const it of items) {
        await fetch(`${bridge()}/ponos/doubao/history`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(it),
        }).catch(() => {})
      }
    } finally { set({ generating: false, busy: false }) }
  },

  loadHistory: async () => {
    try { const r = await fetch(`${bridge()}/ponos/doubao/history`); const d = await r.json(); set({ history: d.items || [] }) } catch {}
  },

  removeHistory: async (id) => {
    await fetch(`${bridge()}/ponos/doubao/history/${encodeURIComponent(id)}`, { method: 'DELETE' })
    set({ history: get().history.filter(h => h.id !== id) })
  },

  insertImage: (att) => { /* 由 ChatInput 注入回调：见 Task 7 */ },
}))
