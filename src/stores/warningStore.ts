// src/stores/warningStore.ts —— 统一系统提示条状态
// warning 是内核进程生命周期事件（budget 每会话单次 crossing / skill_version 仅启动 /
// agent_spec 每 lane 至多一次），故不 persist；同 level 后到事件覆盖先到（set）。
// 新会话内核（system/init 且无旧 sessionId）reset（useYFWCLI init 分支消费）。
import { create } from 'zustand'
import type { KernelWarning } from '../lib/warningUi.ts'

interface WarningState {
  warningBySession: Record<string, KernelWarning>
  set: (sid: string, w: KernelWarning) => void
  dismiss: (sid: string) => void
  /** 新内核进程启动（会话重置）时清除该会话告警，防旧进程残留 */
  reset: (sid: string) => void
}

function withoutKey(rec: Record<string, KernelWarning>, sid: string): Record<string, KernelWarning> {
  if (!(sid in rec)) return rec
  const next = { ...rec }
  delete next[sid]
  return next
}

export const useWarningStore = create<WarningState>()((set) => ({
  warningBySession: {},
  set: (sid, w) => set((s) => ({ warningBySession: { ...s.warningBySession, [sid]: w } })),
  dismiss: (sid) => set((s) => ({ warningBySession: withoutKey(s.warningBySession, sid) })),
  reset: (sid) => set((s) => ({ warningBySession: withoutKey(s.warningBySession, sid) })),
}))
