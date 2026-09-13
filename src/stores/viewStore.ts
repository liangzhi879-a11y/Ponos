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
// Task 1.1（应用智控）：第六 rail 'apps'，与会话/任务/智能体/技能/工作流平级。
// S2 Task 1（知识 GUI）：第七 rail 'knowledge'——**RailId 与 RAIL_IDS 必须同时加**，
// 只加类型不漏白名单时 TS 不报错，但 sanitizeRail 会把落盘的 'knowledge' 清成 'task'，
// 表现为"用户选中知识 rail 后刷新/重启回退到任务 rail"（静默故障）。
export type RailId = 'chat' | 'task' | 'agents' | 'skills' | 'workflows' | 'apps' | 'knowledge'
/** 次级浮层（Task 10）：任务面板头部四枚次级图标钮 → 420px 抽屉（文件/历史/用量/工作树）。null=关闭。 */
export type SecondTabId = 'files' | 'history' | 'usage' | 'worktree'
export interface WorkState { rail: RailId; secondTab: SecondTabId | null }
export const RAIL_IDS: readonly RailId[] = ['chat', 'task', 'agents', 'skills', 'workflows', 'apps', 'knowledge']
export const SECOND_TAB_IDS: readonly SecondTabId[] = ['files', 'history', 'usage', 'worktree']

/** 落盘 rail 清洗：7 合法值透传，非法/缺省 → 'task'（供 merge 与单测）。 */
export function sanitizeRail(rail: unknown): RailId {
  return RAIL_IDS.includes(rail as RailId) ? (rail as RailId) : 'task'
}

/** 落盘 secondTab 清洗：4 合法值透传，非法/缺省 → null（抽屉关闭态，null 兜底安全往返）。 */
export function sanitizeSecondTab(secondTab: unknown): SecondTabId | null {
  return SECOND_TAB_IDS.includes(secondTab as SecondTabId) ? (secondTab as SecondTabId) : null
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
    workState: { rail: 'task', secondTab: null },
    setView: (view) => set({ view }),
    // enterWork 整建 workState：进工作屏总是从浮层关闭态起（secondTab 只在任务 rail 内可开）
    enterWork: (rail) => set({ view: 'work', workState: { rail: rail ?? 'task', secondTab: null } }),
  }), {
    name: 'yfworking-view',
    partialize: (s) => {
      const out: Partial<ViewState> = { workState: s.workState }
      if (s.view === 'cockpit' || s.view === 'work') out.view = s.view  // boot 不入 persist（spec §7）
      return out
    },
    merge: (persisted, current) => {
      const p = (persisted ?? {}) as { workState?: { rail?: unknown; secondTab?: unknown } }
      // boot 门禁：persist 的 view 永不恢复——主窗口每次认证后从 'boot' 起（spec §7），
      // 只恢复工作区 rail/secondTab；persist 的 view 字段（仅 cockpit|work）为信息性记录。
      return {
        ...current,
        view: current.view,
        workState: { rail: sanitizeRail(p.workState?.rail), secondTab: sanitizeSecondTab(p.workState?.secondTab) },
      }
    },
  }),
)
