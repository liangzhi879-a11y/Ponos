// src/stores/disabledStore.ts —— 全局停用清单的界面态（2026-09-15，P1 D 条款）。
//
// ## 职责边界
//
// 内核是唯一执行者（`<configDir>/disabled.json` 由 `kernel/disabled.mjs` 读，`resolveAgents` /
// `discoverSkillsAll` / `Skill` 工具据此收窄）。本 store 只负责**界面与那个文件保持一致**：
// 读一次、写时乐观更新、失败回滚并出声。
//
// ## 为什么乐观更新 + 回滚，而不是"等后端返回"
//
// 开关是高频、低风险的操作，等一个 HTTP 往返会让界面迟钝；但**失败必须回滚**——否则用户看到
// "已停用"而内核照旧加载，正是这个需求要消灭的"假开关"。
//
// ## 为什么不缓存到 localStorage
//
// 注册表的真相在文件里（内核读它）。把停用清单再持久化到前端 localStorage 会制造**第二个真相源**：
// 用户手改文件、或换机器后，界面会显示与内核实际生效不一致的状态。故每次挂载重新拉取。
import { create } from 'zustand'
import { fetchDisabled, saveDisabled, toggleDisabledId } from '@/lib/disabledApi'

interface DisabledState {
  agents: string[]
  skills: string[]
  /** false = 注册表存在但读不出来（界面需说明"当前按全部启用处理"） */
  readable: boolean
  loaded: boolean
  loading: boolean
  load: () => Promise<void>
  isSkillDisabled: (id: string) => boolean
  isAgentDisabled: (id: string) => boolean
  /** @returns 失败时返回错误文案（成功返回 null） */
  setSkillDisabled: (id: string, disabled: boolean) => Promise<string | null>
  /** 同步全量 agent 停用清单（与 agentStore 的 enabled 状态对齐） */
  setDisabledAgents: (ids: string[]) => Promise<string | null>
}

export const useDisabledStore = create<DisabledState>((set, get) => ({
  agents: [],
  skills: [],
  readable: true,
  loaded: false,
  loading: false,

  load: async () => {
    if (get().loading) return
    set({ loading: true })
    const s = await fetchDisabled()
    set({ agents: s.agents, skills: s.skills, readable: s.readable, loaded: true, loading: false })
  },

  isSkillDisabled: (id) => get().skills.includes(String(id ?? '').trim()),
  isAgentDisabled: (id) => get().agents.includes(String(id ?? '').trim()),

  setSkillDisabled: async (id, disabled) => {
    const prev = get().skills
    const next = toggleDisabledId(prev, id, disabled)
    set({ skills: next })                       // 乐观更新：界面立即响应
    const err = await saveDisabled({ skills: next })
    // 回滚：失败却留在"已停用"的界面状态 = 用户以为生效了（本需求要消灭的假开关）。
    if (err) set({ skills: prev })
    return err
  },

  setDisabledAgents: async (ids) => {
    const prev = get().agents
    set({ agents: ids })
    const err = await saveDisabled({ agents: ids })
    if (err) set({ agents: prev })
    return err
  },
}))
