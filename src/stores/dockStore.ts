import { create } from 'zustand'

export type DockChannel = 'task' | 'question' | 'approval' | 'module'
export type DockPanelChannel = Exclude<DockChannel, 'module'>

interface DockState {
  expanded: boolean
  locked: boolean
  counts: Record<DockChannel, number>
  panel: DockPanelChannel | null   // 当前打开的气泡面板
  setExpanded: (v: boolean) => void
  setLocked: (v: boolean) => void
  bump: (ch: DockChannel) => void
  reset: (ch: DockChannel) => void
  setPanel: (ch: DockPanelChannel | null) => void
}

export const useDockStore = create<DockState>()((set) => ({
  expanded: false,
  locked: false,
  counts: { task: 0, question: 0, approval: 0, module: 0 },
  panel: null,
  setExpanded: (v) => set({ expanded: v }),
  setLocked: (v) => set({ locked: v }),
  bump: (ch) => set(s => ({ counts: { ...s.counts, [ch]: s.counts[ch] + 1 } })),
  reset: (ch) => set(s => ({ counts: { ...s.counts, [ch]: 0 } })),
  setPanel: (ch) => set({ panel: ch }),
}))
