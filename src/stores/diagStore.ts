// 诊断工具状态 store：快照/总体/错误数/启动摘要 + 打开开关。
// 终审裁决（2026-08-19）：uiStore 的 diagOpen 副本无消费者，已移除；面板开关只走本 store。

import { create } from 'zustand'
import type { DiagBootSummary, DiagSnapshot } from '@/types'

interface DiagState {
  snapshot: DiagSnapshot | null
  bootSummary: DiagBootSummary | null
  overall: DiagSnapshot['overall'] | null
  errorCount: number
  diagOpen: boolean
  setSnapshot: (s: DiagSnapshot) => void
  setBootSummary: (b: DiagBootSummary | null) => void
  openDiagnostics: () => void
  closeDiagnostics: () => void
}

export const useDiagStore = create<DiagState>((set) => ({
  snapshot: null,
  bootSummary: null,
  overall: null,
  errorCount: 0,
  diagOpen: false,
  setSnapshot: (s) => set({ snapshot: s, overall: s.overall, errorCount: s.checks.filter(c => c.status === 'error').length }),
  setBootSummary: (b) => set({ bootSummary: b }),
  openDiagnostics: () => set({ diagOpen: true }),
  closeDiagnostics: () => set({ diagOpen: false }),
}))

// 启动时订阅主进程状态推送
if (typeof window !== 'undefined' && window.yfwDiag?.onStatusChanged) {
  window.yfwDiag.onStatusChanged((s) => useDiagStore.getState().setSnapshot(s))
}
