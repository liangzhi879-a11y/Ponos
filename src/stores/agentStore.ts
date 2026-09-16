import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Agent } from '@/lib/agents'
import { DEFAULT_AGENTS, getDefaultAgent } from '@/lib/agents'
import { foreignDisabledAgents } from '@/lib/agentsApi'
import { useDisabledStore } from './disabledStore'

interface AgentState {
  agents: Agent[]
  toggleAgent: (id: string) => void
  addAgent: (agent: Agent) => void
  updateAgent: (id: string, updates: Partial<Agent>) => void
  deleteAgent: (id: string) => void
  resetAgent: (id: string) => void
  resetAllAgents: () => void
  /** 设置/移除 agent 头像（null = 恢复默认企业 Logo） */
  setAgentAvatar: (id: string, avatar: string | null) => void
  /**
   * 设置 agent 的工具范围（2026-09-15，P1 A 条款「每张卡片可配置关联工具控制」）。
   *
   * **为什么不复用 `updateAgent`**：那个动作按 `type === 'custom'` 收口（专业 agent 不可编辑），
   * 而"配置工具"恰恰是专业 agent 最需要的能力（内置的专业 agent 正是靠 tools 声明能力的）。
   * 故单开一个动作，对**任何**类型的 agent 都生效；`resetAgent` 仍可整体恢复默认。
   *
   * 入参是**已格式化的字面量**（`'All tools except Edit, Write'` 这类），由
   * `@/lib/agentTools` 的 `formatAgentTools` 产出——store 不碰解析细节，
   * 保证"界面写出的值"与"内核认识的格式"只有一处约定。
   */
  setAgentTools: (id: string, tools: string) => void
}

function mergeWithDefaults(persisted: Agent[]): Agent[] {
  const result: Agent[] = []
  const seen = new Set<string>()

  for (const def of DEFAULT_AGENTS) {
    const existing = persisted.find(a => a.id === def.id)
    if (existing) {
      // 保留用户设置的头像（内置/专业 agent 也可自定义头像）
      result.push({ ...def, enabled: existing.enabled, avatar: existing.avatar })
    } else {
      result.push({ ...def })
    }
    seen.add(def.id)
  }

  for (const agent of persisted) {
    if (!seen.has(agent.id)) {
      result.push(agent)
    }
  }

  return result
}

// 将 agent 注册表同步为内核 agent 文件（.md）。失败静默降级，不影响会话。
function syncAgentsToKernel(agents: Agent[]) {
  const api = (window as any).yfworkingAPI
  if (!api?.agentsSync) return
  api.agentsSync(agents).catch(() => {})
}

/**
 * 把"某个 agent 是否停用"同步进内核停用注册表（2026-09-15，D 条款；H 批次修正）。
 *
 * 语义：以**本 store 拥有的 agent** 为准重算它们的停用清单（幂等——无论此前注册表是什么，
 * 写完后本 store 拥有的那部分都等于界面上的真相），而**非本 store 拥有的 id 必须原样保留**。
 *
 * ## 为什么必须保留"外来 id"（这是批次二 H 修掉的一个真 bug）
 *
 * 注册表是**两类 agent 共用的**：本 store 的 16 个 agent，以及只在内核里存在的 5 个内置
 * agent（`researcher`/`implementer`/`reviewer`/`explorer`/`planner`，见 `src/lib/agentsApi.ts`）。
 * 修正前的实现按**本 store 全量重算**（`all.filter(a => !a.enabled)`）并整体覆盖注册表，于是：
 *   用户停用 `researcher`（内核独有）→ 回头点任意一个 GUI agent 的开关 →
 *   `researcher` 的停用项被这份"只有 GUI id"的清单**静默抹掉** → 它又可以被派发了。
 * 这类"跨区域操作互相撤销"的 bug 用户几乎不可能归因，故在此显式保留外来 id。
 *
 * 失败（桥未就绪/磁盘问题）只 `console.warn` 不抛：开关的**主路径**是 `set()`（本地状态，立即生效）
 * 与 agents:sync；注册表是让内置 agent 也能停用的补充层，它写失败不该让整个开关看起来失败。
 * 但这确实意味着极少数情况下"停用未落盘"——故此处出声，便于排查。
 */
async function syncDisabledAgents(_id: string, _disabled: boolean) {
  // 从 store 取最新全量状态（调用方在 set() 之后调用，故这里读到的是新状态）。
  const all = useAgentStore.getState().agents
  const localIds = all.map(a => a.id)
  const localDisabled = all.filter(a => !a.enabled).map(a => a.id)
  // 保留不属于本 store 的停用项（内核独有 agent）。取并集而非覆盖 —— 见上方注释。
  const foreign = foreignDisabledAgents(useDisabledStore.getState().agents, localIds)
  const next = [...new Set([...localDisabled, ...foreign])]
  const err = await useDisabledStore.getState().setDisabledAgents(next)
  if (err) console.warn('[agents] 停用注册表同步失败（本地状态已生效，重启后可能回退）：', err)
}

export const useAgentStore = create<AgentState>()(
  persist(
    (set, get) => ({
      agents: DEFAULT_AGENTS,

      toggleAgent: (id) => {
        set(state => ({
          agents: state.agents.map(a =>
            a.id === id ? { ...a, enabled: !a.enabled } : a
          ),
        }))
        syncAgentsToKernel(get().agents)
        // 同时登记到内核停用注册表（2026-09-15，D 条款）。**两层是互补的，不是重复**：
        //   · `enabled`（上面）控制 agents:sync 是否写出该 agent 的 .md —— 对"专业/自定义 agent"有效；
        //   · 注册表（这里）由内核在 `resolveAgents` 里过滤 —— 对**内核内置 agent**（general-purpose
        //     等，不在本 store 里、也没有 .md）同样有效，且能兜住"disable 后残留的旧 .md"。
        // 只做前者会让内置 agent 停不掉（用户"关了还在跑"）；只做后者则专业 agent 的 .md 仍在盘上。
        // 两者取并集后，用户看到的**一个开关**在所有 agent 上都真实生效。
        const next = get().agents.find(a => a.id === id)
        void syncDisabledAgents(id, next ? !next.enabled : true)
      },

      addAgent: (agent) => {
        set(state => ({
          agents: [...state.agents, { ...agent, type: 'custom' }],
        }))
        syncAgentsToKernel(get().agents)
      },

      updateAgent: (id, updates) => {
        set(state => ({
          agents: state.agents.map(a =>
            a.id === id && a.type === 'custom' ? { ...a, ...updates } : a
          ),
        }))
        syncAgentsToKernel(get().agents)
      },

      deleteAgent: (id) => {
        set(state => ({
          agents: state.agents.filter(a => a.id !== id),
        }))
        syncAgentsToKernel(get().agents)
      },

      resetAgent: (id) => {
        const def = getDefaultAgent(id)
        if (def) {
          set(state => ({
            agents: state.agents.map(a =>
              a.id === id ? { ...def } : a
            ),
          }))
          syncAgentsToKernel(get().agents)
        }
      },

      resetAllAgents: () => {
        set(state => {
          const customs = state.agents.filter(a => a.type === 'custom')
          return { agents: [...DEFAULT_AGENTS, ...customs] }
        })
        syncAgentsToKernel(get().agents)
      },

      setAgentTools: (id, tools) => {
        set(state => ({
          agents: state.agents.map(a => (a.id === id ? { ...a, tools: [tools] } : a)),
        }))
        syncAgentsToKernel(get().agents)
      },

      setAgentAvatar: (id, avatar) => {
        set(state => ({
          agents: state.agents.map(a =>
            a.id === id
              ? { ...a, avatar: avatar ?? undefined }
              : a
          ),
        }))
      },
    }),
    {
      name: 'yfworking-agents',
      onRehydrateStorage: () => (state) => {
        if (state?.agents) {
          state.agents = mergeWithDefaults(state.agents)
          syncAgentsToKernel(state.agents)
        }
      },
    }
  )
)
