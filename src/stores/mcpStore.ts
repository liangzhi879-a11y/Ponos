// src/stores/mcpStore.ts —— MCP 面板的状态源（内核上报 + GET /mcp/status）。
//
// 沿用本仓库既有模式（见 useYFWCLI.ts 的 health/warning）：hook 收内核事件 → 写 zustand store
// → 面板读 store。**不轮询**：轮询是"定期问"，后端本来就会推，既多余又会在用户没做任何事时
// 反复发请求。
import { create } from 'zustand'
import { getMcpStatus } from '@/lib/mcpApi'
import type { McpKernelSnapshot, McpStatusCache } from '@/components/mcp/mcpStatus'

// 纯逻辑从 mcpStatus 再导出：面板（McpView）只 import 本模块即可，
// 不必同时记住"状态判定在 components/mcp/mcpStatus、数据在 stores/mcpStore"两处。
export { stalenessOf, kernelSummary } from '@/components/mcp/mcpStatus'
export type { McpKernelSnapshot, McpStatusCache } from '@/components/mcp/mcpStatus'

type State = {
  status: McpStatusCache | null
  loading: boolean
  setStatus: (v: McpStatusCache | null) => void
  /** 内核推送的 mcp_status：只更新 kernel 部分，避免把 config/stale 覆盖成过时值 */
  setKernelStatus: (snap: McpKernelSnapshot) => void
  load: () => Promise<void>
}

export const useMcpStore = create<State>((set, get) => ({
  status: null,
  loading: false,
  setStatus: (v) => set({ status: v }),
  setKernelStatus: (snap) => {
    const cur = get().status
    // 还没拉到配置信息：等 load() 回来时会带上最新的 kernel（桥侧有缓存），
    // 此处若自己拼一个 status，config.path/sig 就是编的，stale 判定会跟着错。
    if (!cur) return
    // 事件里没有磁盘签名，故这里用"内核签名 vs 已知磁盘签名"重算 stale，
    // 使"刚生效"的提示能立刻消失，而不必等下一次 load()。
    // 只有 cur.config.sig 存在时才可能判为 fresh：磁盘签名读不出来（null）时无法判定，
    // 此时 !!(null && ...) === false 会把 stale 清成 false —— 那正是"谎称已生效"，
    // 所以 sig 为空时**保留原有 stale**（宁可继续提示"待生效"，也不要假装已生效）。
    const stale = cur.config.sig ? snap.configSig !== cur.config.sig : cur.stale
    set({ status: { ...cur, kernel: snap, stale } })
  },
  load: async () => {
    set({ loading: true })
    try {
      const r = await getMcpStatus()
      if (r && typeof r === 'object' && 'config' in r) set({ status: r as McpStatusCache })
    } catch { /* 拉取失败不清空旧值：面板宁可显示略旧的真值，也不要变空 */ } finally {
      set({ loading: false })
    }
  },
}))
