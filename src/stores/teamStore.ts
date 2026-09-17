// src/stores/teamStore.ts —— S3 团队状态的**渲染层缓存**（2026-09-17）
//
// 为什么单独一个 store（照 mcpStore/knowledgeStore 的分工）：
//   · 模式开关（header）与团队面板（设置窗）**两处**都要读同一份团队列表，
//     各自拉一次会出现"刚创建完团队，header 还没变"的不一致；
//   · 团队列表是**易失数据**（团队源可能被删/没同步到），落盘只会让过期快照无法自愈 ⇒
//     persist 只存**用户选择的模式**（`mode`），其余每次 `load()` 从桥重取。
//
// **团队能力默认关闭**（plan §2.2）：没有加载到任何团队时
//   `useEffectiveMode()` 恒返回 'personal' ⇒ 侧边栏筛选 **零影响**、界面与今日逐字相同。
//
// 纯逻辑不在这里：模式清洗/生效/筛选谓词在 `src/lib/teamModeUi.ts`（可 `node --test` 直测），
// 本文件只做"调用桥 + 存结果"。
import { useMemo } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { getTeamStatus, type TeamSummary } from '@/lib/teamApi'
import { sanitizeWorkspaceMode, effectiveMode, type WorkspaceMode } from '@/lib/teamModeUi'

const SEP = '|'

/** 团队 id 列表的稳定序列化（store 里存**字符串**而不是数组：zustand 选择器返回新数组
 *  会让 useSyncExternalStore 每次都判定"变了"⇒ 无限重渲染）。 */
export function teamKeyOf(teams: readonly TeamSummary[] | null | undefined): string {
  return (Array.isArray(teams) ? teams : []).map((t) => String(t?.teamId ?? '')).filter(Boolean).join(SEP)
}

export function teamIdsFromKey(key: unknown): string[] {
  const s = typeof key === 'string' ? key : ''
  return s ? s.split(SEP).filter(Boolean) : []
}

interface TeamState {
  /** 用户**选择**的模式（持久化）。实际生效值请用 `useEffectiveMode()` */
  mode: WorkspaceMode
  /** 当前团队（二级选择；多团队切换用）。持久化；加载后若已不在列表里则回落到第一个可用团队 */
  activeTeamId: string | null
  teams: TeamSummary[]
  /** 团队 id 的稳定串（选择器安全；见 teamKeyOf） */
  teamKey: string
  searchRoot: string | null
  deviceId: string
  loading: boolean
  /** 是否成功从桥拉到过一次（false + error 空 = 还没拉） */
  loaded: boolean
  error?: string
  load: () => Promise<void>
  setMode: (mode: WorkspaceMode) => void
  /** 选当前团队。**同时切到团队模式**——选了团队却停在个人模式，列表会立刻把它筛掉（自相矛盾） */
  setActiveTeam: (teamId: string | null) => void
}

/** 当前团队回落规则：显式选择仍在列表里就用它，否则用第一个"团队源可用"的团队。 */
export function resolveActiveTeamId(teams: readonly TeamSummary[] | null | undefined, wanted: unknown): string | null {
  const list = Array.isArray(teams) ? teams : []
  const id = typeof wanted === 'string' && wanted ? wanted : null
  if (id && list.some((t) => t.teamId === id)) return id
  const ok = list.find((t) => t.ok !== false)
  return ok ? ok.teamId : (list[0]?.teamId ?? null)
}

export const useTeamStore = create<TeamState>()(
  persist(
    (set) => ({
      mode: 'personal',
      activeTeamId: null,
      teams: [],
      teamKey: '',
      searchRoot: null,
      deviceId: '',
      loading: false,
      loaded: false,
      load: async () => {
        set({ loading: true })
        try {
          const r = await getTeamStatus()
          // 失败**不清空**已有团队列表：宁可显示略旧的列表（并带 error），
          // 也不要在团队源偶发不可达时把用户的团队"变没"。
          if (r.error) set({ error: r.error, loaded: false })
          else set({
            teams: r.teams, teamKey: teamKeyOf(r.teams), searchRoot: r.searchRoot, deviceId: r.deviceId,
            activeTeamId: resolveActiveTeamId(r.teams, useTeamStore.getState().activeTeamId),
            loaded: true, error: undefined,
          })
        } finally {
          set({ loading: false })
        }
      },
      setMode: (mode) => set({ mode: sanitizeWorkspaceMode(mode) }),
      setActiveTeam: (teamId) => set({
        activeTeamId: teamId ? String(teamId) : null,
        ...(teamId ? { mode: 'team' as WorkspaceMode } : {}),
      }),
    }),
    {
      name: 'yfworking-team',
      // 只落模式与当前团队：团队列表/搜索根都以桥为真源（落盘会让"团队目录被删"永远自愈不了）
      partialize: (s) => ({ mode: s.mode, activeTeamId: s.activeTeamId }) as unknown as TeamState,
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as { mode?: unknown; activeTeamId?: unknown }
        return {
          ...current,
          mode: sanitizeWorkspaceMode(p.mode),
          activeTeamId: typeof p.activeTeamId === 'string' && p.activeTeamId ? p.activeTeamId : null,
        }
      },
    },
  ),
)

/** 实际生效的模式：没有任何团队 ⇒ 恒 'personal'（团队能力默认关闭 ⇒ 既有用户零行为变化）。 */
export function useEffectiveMode(): WorkspaceMode {
  const mode = useTeamStore((s) => s.mode)
  const count = useTeamStore((s) => s.teams.length)
  return effectiveMode(mode, count)
}

/** 已加入团队的 teamId 列表（memorize 到稳定串上，避免选择器返回新数组）。 */
export function useTeamIds(): string[] {
  const key = useTeamStore((s) => s.teamKey)
  return useMemo(() => teamIdsFromKey(key), [key])
}

/** 侧边栏筛选需要的最小上下文：生效模式 + 团队 id 列表。 */
export function useModeFilter(): { mode: WorkspaceMode; teamIds: string[] } {
  const mode = useEffectiveMode()
  const teamIds = useTeamIds()
  return useMemo(() => ({ mode, teamIds }), [mode, teamIds])
}

/** 一次拉取（幂等）：两个入口（header / 设置窗）都调它，但只有第一次真的发请求。 */
export async function ensureTeamsLoaded(): Promise<void> {
  const st = useTeamStore.getState()
  if (st.loading) return
  if (st.loaded) return
  await st.load()
}
