// 应用智控：应用清单 store（Task 1.6）
//
// 设计要点：**导出工厂函数 + 预建实例**。
//   · createAppsStore({ api }) 让单测能注入假 api（node --test 无 window）；
//   · useAppsStore 是给组件用的预建实例，api 取 window.yfworkingAPI（preload 注入）。
// 数据来源是主进程 IPC（~/.yfworking/apps/registry.json），store 不做本地持久化
// ——唯一真源在磁盘，避免"界面显示与磁盘不一致"的双份状态。
import { create } from 'zustand'
import type { AppItem } from '@/types'

export interface AppsApi {
  appList: () => Promise<AppItem[]>
  appUpsert: (app: AppItem) => Promise<AppItem>
  appRemove: (appId: string) => Promise<{ ok: boolean }>
}

export interface AppsState {
  apps: AppItem[]
  loading: boolean
  error: string | null
  load: () => Promise<void>
  upsert: (app: AppItem) => Promise<void>
  remove: (id: string) => Promise<void>
}

export function createAppsStore({ api }: { api: AppsApi }) {
  return create<AppsState>((set, get) => ({
    apps: [],
    loading: false,
    error: null,
    load: async () => {
      set({ loading: true, error: null })
      try {
        const list = await api.appList()
        set({ apps: Array.isArray(list) ? list : [], loading: false })
      } catch (e: unknown) {
        // IPC 失败必须显式落 error（否则界面停在空列表，用户以为"没有应用"）
        set({ error: String((e as Error)?.message || e), loading: false })
      }
    },
    upsert: async (app) => {
      await api.appUpsert(app)
      await get().load()
    },
    remove: async (id) => {
      await api.appRemove(id)
      await get().load()
    },
  }))
}

/** preload 未注入（浏览器内直开 dist/ 预览）时给出空实现，避免整页崩 */
const realApi: AppsApi = (() => {
  const w = typeof window !== 'undefined' ? (window as unknown as { yfworkingAPI?: Partial<AppsApi> }) : undefined
  const api = w?.yfworkingAPI
  if (api?.appList && api?.appUpsert && api?.appRemove) return api as AppsApi
  return {
    appList: async () => [],
    appUpsert: async (a) => a,
    appRemove: async () => ({ ok: false }),
  }
})()

export const useAppsStore = createAppsStore({ api: realApi })
