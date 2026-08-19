import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Agent } from '@/lib/agents'
import { DEFAULT_AGENTS, getDefaultAgent } from '@/lib/agents'

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
