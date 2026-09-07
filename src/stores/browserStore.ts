import { create } from 'zustand'
import type { BrowserEvent } from '@/types'

/**
 * 内置浏览器自动化状态（GUI 精简状态条数据源）。
 * 订阅 bridge 广播的 browser:event（executor → GUI），维护当前操作文本与
 * 人工接管/拟真模式徽标。download 事件不在此展示（Task 6 聊天集成用）。
 */
interface BrowserCurrent {
  /** status 事件的操作文本（如 "正在点击「查询」"、"浏览器窗口已打开"） */
  text?: string
  /** 人工接管中：收到 paused 或 mode:'human' 后置真，resumed 置假 */
  humanMode: boolean
  /** 拟真模式：mode:'imitation' 置真，mode:'normal'/'human' 置假 */
  imitation: boolean
}

interface BrowserState {
  current: BrowserCurrent | null
  setEvent: (e: BrowserEvent) => void
  clear: () => void
}

export const useBrowserStore = create<BrowserState>((set) => ({
  current: null,

  setEvent: (e) => {
    if (e.type === 'download') return // 聊天集成消费，状态条不展示
    set((state) => {
      // 浏览器退出（close/closeSession）：收起胶囊；后续任意 browser:event 会重新出现
      if (e.type === 'closed') return { current: null }
      const cur = state.current ?? { text: undefined, humanMode: false, imitation: false }
      switch (e.type) {
        case 'status':
          return { current: { ...cur, text: e.text ?? cur.text } }
        case 'paused':
          return { current: { ...cur, humanMode: true } }
        case 'resumed':
          return { current: { ...cur, humanMode: false } }
        case 'mode':
          if (e.mode === 'imitation') return { current: { ...cur, imitation: true, humanMode: false } }
          if (e.mode === 'human') return { current: { ...cur, humanMode: true, imitation: false } }
          return { current: { ...cur, humanMode: false, imitation: false } }
        default:
          return state
      }
    })
  },

  clear: () => set({ current: null }),
}))
