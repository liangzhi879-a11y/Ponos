import { create } from 'zustand'

export type AppView = 'boot' | 'login' | 'cockpit' | 'workspace' | 'dock'

interface ViewState {
  view: AppView
  workspaceTab: string | null
  authToken: string | null
  bootDone: () => void
  enter: () => void
  goCockpit: () => void
  goDock: () => void
  goWorkspace: (tab?: string) => void
  setAuthToken: (t: string | null) => void
}

export const useViewStore = create<ViewState>()((set) => ({
  view: 'boot',
  workspaceTab: null,
  authToken: null,
  bootDone: () => set({ view: 'login' }),
  // 登录后主窗口进入 dock 形态（导航条常驻）；驾驶舱作为独立模块窗口由 App 层打开。
  enter: () => set({ view: 'dock' }),
  goCockpit: () => set({ view: 'cockpit', workspaceTab: null }),
  goDock: () => set({ view: 'dock', workspaceTab: null }),
  goWorkspace: (tab) => set({ view: 'workspace', workspaceTab: tab ?? null }),
  setAuthToken: (t) => set({ authToken: t }),
}))
