// src/stores/viewStore.ts —— 顶层视图状态机（boot→cockpit→work，无 login）+ 工作区 rail 持久化
// persist key 'yfworking-view'。
// D11-D13（Task 6b）：登录已移出主窗口视图机——认证在独立小窗（?auth=1）完成，
// 主窗口认证后才创建并以 'boot' 开场，故 AppView 收敛为 boot|cockpit|work 三态。
// persist 语义（spec §7）：
//   · partialize 只落 'cockpit'|'work' 的 view 与 workState——'boot' 不入 persist；
//   · merge 恒定 view: current.view（即 'boot'）——boot 门禁：persist 的 view 永不恢复，
//     主窗口每次认证后从加载屏起，只恢复工作区 rail（合法值清洗）。
// 注：GUI 纯函数单测纪律下 sanitizeRail 放在本文件顶部导出即可测——前提是 node import 本文件时
// 模块级 zustand create(persist(...)) 可安全执行（无 localStorage 时 persist 自动降级为 noop storage）。
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type AppView = 'boot' | 'cockpit' | 'work'
export type RailId = 'chat' | 'task' | 'agents' | 'skills'
export interface WorkState { rail: RailId }
export const RAIL_IDS: readonly RailId[] = ['chat', 'task', 'agents', 'skills']

/** 落盘 rail 清洗：4 合法值透传，非法/缺省 → 'task'（供 merge 与单测）。 */
export function sanitizeRail(rail: unknown): RailId {
  return RAIL_IDS.includes(rail as RailId) ? (rail as RailId) : 'task'
}

interface ViewState {
  view: AppView
  workState: WorkState
  setView: (v: AppView) => void
  enterWork: (rail?: RailId) => void
}

export const useViewStore = create<ViewState>()(
  persist((set) => ({
    view: 'boot',
    workState: { rail: 'task' },
    setView: (view) => set({ view }),
    enterWork: (rail) => set({ view: 'work', workState: { rail: rail ?? 'task' } }),
  }), {
    name: 'yfworking-view',
    partialize: (s) => {
      const out: Partial<ViewState> = { workState: s.workState }
      if (s.view === 'cockpit' || s.view === 'work') out.view = s.view  // boot 不入 persist（spec §7）
      return out
    },
    merge: (persisted, current) => {
      const p = (persisted ?? {}) as { workState?: { rail?: unknown } }
      // boot 门禁：persist 的 view 永不恢复——主窗口每次认证后从 'boot' 起（spec §7），
      // 只恢复工作区 rail；persist 的 view 字段（仅 cockpit|work）为信息性记录。
      return { ...current, view: current.view, workState: { rail: sanitizeRail(p.workState?.rail) } }
    },
  }),
)
