// src/stores/viewStore.ts —— 顶层视图状态机（boot→login→cockpit→work）+ 工作区 rail 持久化
// persist key 'yfworking-view'；partialize { view, workState }。
// view 落盘值只在 'cockpit'|'work' 间持久；rehydrate 语义（merge）：
//   · 无历史（localStorage 空/缺 key，p.view===undefined）→ 保留 current 初始 'boot'（首启显示 BootScreen）；
//   · 有显式落盘值但为 boot/login/未知 → normalizeStoredView 归一到 'login'。
// 注：GUI 纯函数单测纪律下 normalizeStoredView 放在本文件顶部导出即可测——前提是 node import 本文件时
// 模块级 zustand create(persist(...)) 可安全执行（无 localStorage 时 persist 自动降级为 noop storage）。
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type AppView = 'boot' | 'login' | 'cockpit' | 'work'
export type RailId = 'chat' | 'task' | 'agents' | 'skills'
export interface WorkState { rail: RailId }

/** 落盘视图归一（只喂「显式已落盘」值，不要喂 undefined——那代表无历史，应保留 current 'boot'）：
 *  只有 'cockpit'|'work' 视为合法，其余（含 boot/login/未知）归一到 'login'。*/
export function normalizeStoredView(v: unknown): AppView {
  return v === 'cockpit' || v === 'work' ? v : 'login'
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
    partialize: (s) => ({ view: s.view, workState: s.workState }),
    merge: (persisted, current) => {
      const p = (persisted ?? {}) as { view?: unknown; workState?: Partial<WorkState> }
      const rail = p.workState?.rail
      // 无历史（p.view===undefined，localStorage 空 key/缺 key）→ 保留 current 初始 'boot'；
      // 只有显式已落盘值才走 normalizeStoredView 归一（否则 'boot' 会被归一成 'login'，首启永远看不到 BootScreen）。
      const stored = p.view === undefined ? current.view : normalizeStoredView(p.view)
      return {
        ...current,
        view: stored,
        workState: {
          rail: rail === 'chat' || rail === 'task' || rail === 'agents' || rail === 'skills' ? rail : 'task',
        },
      }
    },
  }),
)
