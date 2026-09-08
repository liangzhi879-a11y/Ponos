// src/stores/viewStore.ts —— 顶层视图状态机（boot→login→cockpit→work）+ 工作区 rail 持久化
// persist key 'yfworking-view'；partialize { view, workState }。
// view 落盘值只在 'cockpit'|'work' 间持久；rehydrate 读到 boot/login/未知 → 归一 'login'（normalizeStoredView）。
// 注：GUI 纯函数单测纪律下 normalizeStoredView 放在本文件顶部导出即可测——前提是 node import 本文件时
// 模块级 zustand create(persist(...)) 可安全执行（无 localStorage 时 persist 自动降级为 noop storage）。
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type AppView = 'boot' | 'login' | 'cockpit' | 'work'
export type RailId = 'chat' | 'task' | 'agents' | 'skills'
export interface WorkState { rail: RailId }

/** rehydrate 兜底：只有 'cockpit'|'work' 视为合法落盘视图，其余（含 boot/login/未知）归一到 'login' */
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
      return {
        ...current,
        view: normalizeStoredView(p.view),
        workState: {
          rail: rail === 'chat' || rail === 'task' || rail === 'agents' || rail === 'skills' ? rail : 'task',
        },
      }
    },
  }),
)
