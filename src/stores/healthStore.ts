// src/stores/healthStore.ts
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { mergeIssues } from '../lib/healthUi.ts'
import type { DistortionInfo } from '../lib/healthUi.ts'

export type HealthTier = 'green' | 'amber' | 'red'

export interface HealthInfo {
  score: number
  tier: HealthTier
  compactCount: number
  remainingPct: number
  remainingTurns: number
  suggestNewSession: boolean
  reason: string
  /** 失真档（可选字段：老内核不下发 → 缺省即 green，前端不显示任何失真提示） */
  distortion?: DistortionInfo
}

/**
 * 健康状态按会话（sessionId=conversationId）隔离存储：
 * 多会话并行（各自独立内核进程、独立 yfw_health/yfw_summary 事件流）时
 * 各会话上下文健康度互不串线；血条/光晕/建议卡只读取当前查看会话的数据。
 */
interface HealthState {
  healthBySession: Record<string, HealthInfo>
  summaryBySession: Record<string, string>
  summaryCompactCountBySession: Record<string, number>
  /** 用户关闭红档横幅后的 5 分钟冷却截止时间（按会话） */
  dismissedUntilBySession: Record<string, number>
  /** 已展示过失真卡的证据去抖键（按会话）：同键不重复弹，避免红档反复打断用户 */
  distortionShownIdsBySession: Record<string, string[]>
  /** 用户关闭失真卡后的冷却截止时间（按会话）；失真泛光复用同一冷却 */
  dismissedDistortionUntilBySession: Record<string, number>
  update: (sessionId: string, info: HealthInfo) => void
  setSummary: (sessionId: string, text: string, compactCount: number) => void
  dismiss: (sessionId: string) => void
  /** 标记该证据键已展示（下次同键不再弹卡） */
  markDistortionShown: (sessionId: string, id: string) => void
  /** 关闭失真卡：进入冷却（泛光同时熄灭） */
  dismissDistortion: (sessionId: string) => void
  /** 内核新进程启动（会话重新计分）时清空该会话健康状态，防止旧红档横幅复活 */
  reset: (sessionId: string) => void
  /**
   * 丢弃该会话的**失真**快照与失真 UI 状态（压力快照保留）。
   * 用于"内核进程换了"的时刻：失真证据只存在于内核进程内（不落盘），新进程失真态是空的
   * （green），而它只在档位变化时发事件 → 不清理的话，旧的红色卡片/角标/泛光会永久赖着
   * （"关闭"也只冷却 5 分钟，到期又冒出来），且 anchorText 是上一个进程的过期文本。
   */
  clearDistortion: (sessionId: string) => void
}

const RED_DISMISS_MS = 5 * 60 * 1000
/** 失真卡冷却与压力档一致（5 分钟）：失真可能长期存在，静默一段时间避免反复打断 */
const DISTORTION_DISMISS_MS = 5 * 60 * 1000
/** 每会话最多记住的已展示证据键（防止持久化快照无限增长） */
const MAX_SHOWN_IDS = 50
/** 每会话最多累积的失真证据条数（超出丢弃最旧的） */
const MAX_ISSUES = 30

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
      distortionShownIdsBySession: {},
      dismissedDistortionUntilBySession: {},
      update: (sessionId, info) =>
        set((s) => {
          const prevDist = s.healthBySession[sessionId]?.distortion
          let next = info
          if (info.distortion) {
            // 失真未消除时累积证据：内核窗口滑走后旧证据仍能在卡片里逐条可见
            //（卡片价值就在"证据可核对"）；回绿即丢弃累积，绝不显示"已消除的旧证据"。
            const issues = info.distortion.tier === 'green'
              ? info.distortion.issues
              : mergeIssues(prevDist?.issues ?? [], info.distortion.issues).slice(-MAX_ISSUES)
            next = { ...info, distortion: { ...info.distortion, issues } }
          }
          return { healthBySession: { ...s.healthBySession, [sessionId]: next } }
        }),
      setSummary: (sessionId, text, compactCount) =>
        set((s) => ({
          summaryBySession: { ...s.summaryBySession, [sessionId]: text },
          summaryCompactCountBySession: { ...s.summaryCompactCountBySession, [sessionId]: compactCount },
        })),
      dismiss: (sessionId) =>
        set((s) => ({
          dismissedUntilBySession: { ...s.dismissedUntilBySession, [sessionId]: Date.now() + RED_DISMISS_MS },
        })),
      markDistortionShown: (sessionId, id) =>
        set((s) => {
          if (!id) return {}
          const prev = s.distortionShownIdsBySession[sessionId] ?? []
          if (prev.includes(id)) return {}
          // 只保留最近的 MAX_SHOWN_IDS 个（新的在后）：去抖键会随会话推进不断新增
          const next = [...prev, id].slice(-MAX_SHOWN_IDS)
          return { distortionShownIdsBySession: { ...s.distortionShownIdsBySession, [sessionId]: next } }
        }),
      dismissDistortion: (sessionId) =>
        set((s) => ({
          dismissedDistortionUntilBySession: {
            ...s.dismissedDistortionUntilBySession,
            [sessionId]: Date.now() + DISTORTION_DISMISS_MS,
          },
        })),
      clearDistortion: (sessionId) =>
        set((s) => {
          const distortionShownIdsBySession = { ...s.distortionShownIdsBySession }
          const dismissedDistortionUntilBySession = { ...s.dismissedDistortionUntilBySession }
          delete distortionShownIdsBySession[sessionId]
          delete dismissedDistortionUntilBySession[sessionId]
          const cur = s.healthBySession[sessionId]
          if (!cur) return { distortionShownIdsBySession, dismissedDistortionUntilBySession }
          // 只摘掉 distortion 字段（血条继续用恢复的压力档，避免刚 resume 就回满）
          const { distortion: _dropped, ...rest } = cur
          return {
            healthBySession: { ...s.healthBySession, [sessionId]: rest as HealthInfo },
            distortionShownIdsBySession,
            dismissedDistortionUntilBySession,
          }
        }),
      reset: (sessionId) =>
        set((s) => {
          const healthBySession = { ...s.healthBySession }
          const summaryBySession = { ...s.summaryBySession }
          const summaryCompactCountBySession = { ...s.summaryCompactCountBySession }
          const dismissedUntilBySession = { ...s.dismissedUntilBySession }
          const distortionShownIdsBySession = { ...s.distortionShownIdsBySession }
          const dismissedDistortionUntilBySession = { ...s.dismissedDistortionUntilBySession }
          delete healthBySession[sessionId]
          delete summaryBySession[sessionId]
          delete summaryCompactCountBySession[sessionId]
          delete dismissedUntilBySession[sessionId]
          delete distortionShownIdsBySession[sessionId]
          delete dismissedDistortionUntilBySession[sessionId]
          return { healthBySession, summaryBySession, summaryCompactCountBySession, dismissedUntilBySession, distortionShownIdsBySession, dismissedDistortionUntilBySession }
        }),
    }),
    {
      name: 'yfworking-health',
      // v2：新增失真档去抖（distortionShownIdsBySession）与失真冷却
      // （dismissedDistortionUntilBySession）。旧快照缺这两个键 → migrate 补空对象，
      // 否则读取 undefined 会在 shouldShowDistortionAlert/角标处炸掉整个聊天界面。
      version: 2,
      storage: createJSONStorage(() => localStorage),
      migrate: (persisted: unknown) => {
        const p = (persisted && typeof persisted === 'object' ? persisted : {}) as Partial<HealthState>
        return {
          ...p,
          healthBySession: p.healthBySession ?? {},
          summaryCompactCountBySession: p.summaryCompactCountBySession ?? {},
          dismissedUntilBySession: p.dismissedUntilBySession ?? {},
          distortionShownIdsBySession: p.distortionShownIdsBySession ?? {},
          dismissedDistortionUntilBySession: p.dismissedDistortionUntilBySession ?? {},
        } as HealthState
      },
      partialize: (s) => ({
        healthBySession: s.healthBySession,
        summaryCompactCountBySession: s.summaryCompactCountBySession,
        dismissedUntilBySession: s.dismissedUntilBySession,
        distortionShownIdsBySession: s.distortionShownIdsBySession,
        dismissedDistortionUntilBySession: s.dismissedDistortionUntilBySession,
      }),
    },
  ),
)
