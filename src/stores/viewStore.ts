import { create } from 'zustand'

export type AppView = 'boot' | 'login' | 'cockpit' | 'workspace'

interface ViewState {
  view: AppView
  workspaceTab: string | null
  authToken: string | null
  bootDone: () => void
  enter: () => void
  goCockpit: () => void
  goWorkspace: (tab?: string) => void
  setAuthToken: (t: string | null) => void
}

export const useViewStore = create<ViewState>()((set) => ({
  view: 'boot',
  workspaceTab: null,
  authToken: null,
  bootDone: () => set({ view: 'login' }),
  enter: () => set({ view: 'cockpit' }),
  goCockpit: () => set({ view: 'cockpit', workspaceTab: null }),
  goWorkspace: (tab) => set({ view: 'workspace', workspaceTab: tab ?? null }),
  setAuthToken: (t) => set({ authToken: t }),
}))
