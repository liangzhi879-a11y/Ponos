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

/**
 * 真实 API：从 window.yfworkingAPI 取。
 * ★ 缺方法时**必须显式报错**，不能静默返回空结果：
 *   本轮真实事故——11 个方法被 preload 错位暴露在 yfworkingWindow 上，若这里静默兜底成
 *   空列表，界面就表现为"列表空 + 点新增毫无反应"且零报错，排查成本极高。
 *   宁可红条报错，也不要静默空白。
 */
const MISSING_API_MSG = '应用智控 API 未注入：window.yfworkingAPI 缺少 app* 方法（preload.cjs 未同步或应用未重启）'
const realApi: AppsApi = (() => {
  const w = typeof window !== 'undefined' ? (window as unknown as { yfworkingAPI?: Partial<AppsApi> }) : undefined
  const api = w?.yfworkingAPI
  if (api?.appList && api?.appUpsert && api?.appRemove) return api as AppsApi
  const fail = async () => { throw new Error(MISSING_API_MSG) }
  return { appList: fail as unknown as AppsApi['appList'], appUpsert: fail as unknown as AppsApi['appUpsert'], appRemove: fail as unknown as AppsApi['appRemove'] }
})()

export { MISSING_API_MSG }

export const useAppsStore = createAppsStore({ api: realApi })
