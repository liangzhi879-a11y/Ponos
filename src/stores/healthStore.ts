// src/stores/healthStore.ts
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export type HealthTier = 'green' | 'amber' | 'red'

export interface HealthInfo {
  score: number
  tier: HealthTier
  compactCount: number
  remainingPct: number
  remainingTurns: number
  suggestNewSession: boolean
  reason: string
}

/**
 * 健康状态按会话（sessionId=conversationId）隔离存储：
 * 多会话并行（各自独立内核进程、独立 ponos_health/ponos_summary 事件流）时
 * 各会话上下文健康度互不串线；血条/光晕/建议卡只读取当前查看会话的数据。
 */
interface HealthState {
  healthBySession: Record<string, HealthInfo>
  summaryBySession: Record<string, string>
  summaryCompactCountBySession: Record<string, number>
  /** 用户关闭红档横幅后的 5 分钟冷却截止时间（按会话） */
  dismissedUntilBySession: Record<string, number>
  update: (sessionId: string, info: HealthInfo) => void
  setSummary: (sessionId: string, text: string, compactCount: number) => void
  dismiss: (sessionId: string) => void
  /** 内核新进程启动（会话重新计分）时清空该会话健康状态，防止旧红档横幅复活 */
  reset: (sessionId: string) => void
}

const RED_DISMISS_MS = 5 * 60 * 1000

/**
 * 会话健康快照持久化到 localStorage：切换会话/重启应用后血条仍能恢复各会话
 * 上次的真实上下文状态（压缩次数/剩余百分比），而非"无数据=满血"。
 * 排除 summaryBySession（压缩摘要文本大，不持久化，建议卡摘要优雅降级为空）。
 */
export const useHealthStore = create<HealthState>()(
  persist(
    (set) => ({
      healthBySession: {},
      summaryBySession: {},
      summaryCompactCountBySession: {},
      dismissedUntilBySession: {},
      update: (sessionId, info) =>
        set((s) => ({ healthBySession: { ...s.healthBySession, [sessionId]: info } })),
      setSummary: (sessionId, text, compactCount) =>
        set((s) => ({
          summaryBySession: { ...s.summaryBySession, [sessionId]: text },
          summaryCompactCountBySession: { ...s.summaryCompactCountBySession, [sessionId]: compactCount },
        })),
      dismiss: (sessionId) =>
        set((s) => ({
          dismissedUntilBySession: { ...s.dismissedUntilBySession, [sessionId]: Date.now() + RED_DISMISS_MS },
        })),
      reset: (sessionId) =>
        set((s) => {
          const healthBySession = { ...s.healthBySession }
          const summaryBySession = { ...s.summaryBySession }
          const summaryCompactCountBySession = { ...s.summaryCompactCountBySession }
          const dismissedUntilBySession = { ...s.dismissedUntilBySession }
          delete healthBySession[sessionId]
          delete summaryBySession[sessionId]
          delete summaryCompactCountBySession[sessionId]
          delete dismissedUntilBySession[sessionId]
          return { healthBySession, summaryBySession, summaryCompactCountBySession, dismissedUntilBySession }
        }),
    }),
    {
      name: 'ponos-health',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        healthBySession: s.healthBySession,
        summaryCompactCountBySession: s.summaryCompactCountBySession,
        dismissedUntilBySession: s.dismissedUntilBySession,
      }),
    },
  ),
)
