import { create } from 'zustand'
import { persist } from 'zustand/middleware'
// NOTE: brief 原文为 '@/lib/config'；Node 原生 TS 不解析 tsconfig paths，
// 为让 `node --test src/stores/tokenStatsStore.test.ts` 可加载本模块，改用带 .ts 扩展的相对路径（Vite 构建同样生效）。
import { getBridgeUrl } from '../lib/config.ts'

export interface TokenDayStat { input: number; output: number }
export interface TokenStats {
  totalInput: number
  totalOutput: number
  byDay: Record<string, TokenDayStat>
  byConversation: Record<string, TokenDayStat>
  byModel: Record<string, TokenDayStat>
  lastUpdatedAt: number
}

export function createEmptyStats(): TokenStats {
  return { totalInput: 0, totalOutput: 0, byDay: {}, byConversation: {}, byModel: {}, lastUpdatedAt: 0 }
}

function addDim(map: Record<string, TokenDayStat>, key: string, input: number, output: number) {
  const cur = map[key] || { input: 0, output: 0 }
  map[key] = { input: cur.input + input, output: cur.output + output }
}

export function addUsage(stats: TokenStats, u: { input: number; output: number }, dims: { day: string; conversationId: string; model: string }): TokenStats {
  const s: TokenStats = {
    ...stats,
    totalInput: stats.totalInput + u.input,
    totalOutput: stats.totalOutput + u.output,
    byDay: { ...stats.byDay },
    byConversation: { ...stats.byConversation },
    byModel: { ...stats.byModel },
    lastUpdatedAt: Date.now(),
  }
  addDim(s.byDay, dims.day, u.input, u.output)
  addDim(s.byConversation, dims.conversationId, u.input, u.output)
  if (dims.model) addDim(s.byModel, dims.model, u.input, u.output)
  return s
}

export function toDayKey(ts: number): string {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 回填单个会话：拉取原始 transcript entries，解析 assistant 条目的 usage 累加。
 *  返回 { stats, ok }：ok=true 仅当 transcript 真正加载并解析到条目数组
 *  （bridge 不可达 / 响应异常时静默降级为原 stats 且 ok=false，调用方据此决定是否标记完成）。 */
export async function backfillConversation(
  stats: TokenStats, cwd: string, sessionId: string, convId: string, baseUrl?: string
): Promise<{ stats: TokenStats; ok: boolean }> {
  const base = baseUrl || getBridgeUrl()
  const url = `${base}/transcript/load?cwd=${encodeURIComponent(cwd)}&sessionId=${encodeURIComponent(sessionId)}&tailFirst=0`
  try {
    const res = await fetch(url)
    if (!res.ok) return { stats, ok: false }
    const data = await res.json()
    if (!data || data.ok !== true || !Array.isArray(data.entries)) return { stats, ok: false }
    let s = stats
    for (const e of data.entries) {
      if (e?.type !== 'assistant') continue
      const u = e.usage
      if (!u || typeof u.input_tokens !== 'number') continue
      const input = u.input_tokens || 0
      const output = u.output_tokens || 0
      const ts = typeof e.timestamp === 'number' ? e.timestamp : Date.now()
      s = addUsage(s, { input, output }, { day: toDayKey(ts), conversationId: convId, model: e.model || '' })
    }
    return { stats: s, ok: true }
  } catch {
    return { stats, ok: false }  // bridge 不可达静默降级
  }
}

/** 从 bridge /transcript/stats 全量拉取并映射进 stats（主数据源）。
 *  返回 true=成功；失败置 lastError（不吞错，驾驶舱显示重试态）。 */
export async function refreshFromServer(
  stats: TokenStats,
  baseUrl?: string
): Promise<{ stats: TokenStats; ok: boolean; error: string }> {
  const base = baseUrl || getBridgeUrl()
  try {
    const res = await fetch(`${base}/transcript/stats`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (!data || data.ok !== true || !data.totals) throw new Error('stats 响应缺 totals')
    const s: TokenStats = {
      totalInput: data.totals.input_tokens ?? 0,
      totalOutput: data.totals.output_tokens ?? 0,
      byDay: {},
      byConversation: stats.byConversation, // 服务端无 per-conversation 聚合，保留本地
      byModel: {},
      lastUpdatedAt: Date.now(),
    }
    for (const [day, v] of Object.entries(data.byDate || {})) {
      const d = v as { input_tokens?: number; output_tokens?: number }
      s.byDay[day] = { input: d.input_tokens ?? 0, output: d.output_tokens ?? 0 }
    }
    for (const [model, v] of Object.entries(data.byModel || {})) {
      const m = v as { input_tokens?: number; output_tokens?: number }
      s.byModel[model] = { input: m.input_tokens ?? 0, output: m.output_tokens ?? 0 }
    }
    return { stats: s, ok: true, error: '' }
  } catch (e) {
    return { stats, ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

interface TokenStatsStore {
  stats: TokenStats
  backfilled: Record<string, boolean>
  lastError: string | null
  recordUsage: (u: { input: number; output: number }, dims: { conversationId: string; model: string }) => void
  ensureBackfill: (convs: { id: string; cwd?: string; sessionIds?: string[] }[], baseUrl?: string) => Promise<void>
  refreshFromServer: (baseUrl?: string) => Promise<boolean>
}

export const useTokenStatsStore = create<TokenStatsStore>()(
  persist(
    (set, get) => ({
      stats: createEmptyStats(),
      backfilled: {},
      lastError: null,
      recordUsage: (u, dims) =>
        set(s => ({ stats: addUsage(s.stats, u, { day: toDayKey(Date.now()), ...dims }) })),
      ensureBackfill: async (convs, baseUrl) => {
        const { backfilled } = get()
        const todo = convs.filter(c => !backfilled[c.id] && c.sessionIds?.length)
        if (todo.length === 0) return
        let s = get().stats
        const done = { ...backfilled }
        for (const c of todo) {
          let anyOk = false
          for (const sid of (c.sessionIds || []).slice(0, 3)) {  // 大会话限 3 个 transcript 防卡顿
            const r = await backfillConversation(s, c.cwd || '', sid, c.id, baseUrl)
            s = r.stats
            if (r.ok) anyOk = true
          }
          // 仅当至少一个 transcript 真正加载成功才标记完成；
          // 否则保持未标记，下次进入驾驶舱会重试（避免 bridge 未就绪时永久放弃历史回填）。
          if (anyOk) done[c.id] = true
        }
        set({ stats: s, backfilled: done })
      },
      refreshFromServer: async (baseUrl) => {
        const cur = get()
        const r = await refreshFromServer(cur.stats, baseUrl)
        set({ stats: r.stats, lastError: r.ok ? null : r.error })
        return r.ok
      },
    }),
    { name: 'ponos-token-stats', partialize: (s) => ({ stats: s.stats, backfilled: s.backfilled }) }
  )
)
