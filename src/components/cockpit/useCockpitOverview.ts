// src/components/cockpit/useCockpitOverview.ts —— 驾驶舱 overview 数据源聚合 hook（Task 8）
// 每 5s 轮询一次 + 每次 view==='cockpit' 立即拉一次，聚合成 Task 7 iframe 契约 shape
//   (public/cockpit/index.html 消息桥注释为准)：
//   { runningTasks:{title,status:'exec'|'wait'|'idle',progress?,meta?}[],
//     agents:{id,role,state:'run'|'idle'|'think'|'review'}[],
//     usage:{token,requests,costUsd}, skills:{count,sample[]}, health:{engine,kernel} }
// 数据源全部防御访问：bridge 不可达/字段缺失给兜底值（usage→'—'、health→'—'、skills→空），
// 单次失败不白屏、不抛错。GUI 侧无 per-agent 运行时状态——agents 只做「轻量在线名册」：
// 取启用 agent 前 6 个，state 由「当前流式会话绑定的 agentId」推导 run，其余防御性 idle。
import { useEffect, useState } from 'react'
import { useViewStore } from '@/stores/viewStore'
import { useChatStore } from '@/stores/chatStore'
import { useAgentStore } from '@/stores/agentStore'
import { fetchUsage } from '@/lib/usageApi'
import { fetchSkills, type SkillEntry } from '@/lib/skills'
import { fmtTokens, fmtUsd, type UsageReport } from '@/lib/usageUi'

export interface OverviewTask {
  title: string
  status: 'exec' | 'wait' | 'idle'
  progress?: number
  meta?: string
}

export interface OverviewAgent {
  id: string
  role: string
  state: 'run' | 'idle' | 'think' | 'review'
}

export interface CockpitOverviewData {
  runningTasks: OverviewTask[]
  agents: OverviewAgent[]
  usage: { token: string; requests: string; costUsd: string }
  skills: { count: number; sample: string[] }
  health: { engine: string; kernel: string }
}

const POLL_MS = 5000
const ROSTER_SIZE = 6
const SKILL_SAMPLE_SIZE = 4
const NO_USAGE: CockpitOverviewData['usage'] = { token: '—', requests: '—', costUsd: '—' }
const NO_HEALTH: CockpitOverviewData['health'] = { engine: '—', kernel: '—' }

/** 数值防御：非有限数一律按 0 计（后端字段缺失/字符串时兜底） */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** usage → cockpit 用量卡：token=输入+输出+两类缓存 token 合计（fmtTokens 缩写），
 *  requests=今日 turns，costUsd=fmtUsd。取 UsageReport.totals 原始字段，
 *  因 TotalsView 的 cacheRead 不含 cache_creation（规格要求四类之和）。 */
function usageView(report: UsageReport | null): CockpitOverviewData['usage'] {
  if (!report) return { ...NO_USAGE }
  const t = report.totals ?? ({} as UsageReport['totals'])
  const total =
    num(t.input_tokens) + num(t.output_tokens)
    + num(t.cache_read_input_tokens) + num(t.cache_creation_input_tokens)
  return {
    token: fmtTokens(total),
    requests: String(num(t.turns)),
    costUsd: fmtUsd(num(report.costUsd)),
  }
}

/** skills → 知识库卡：复用 fetchSkills（bridge 3s 超时 + bundled skills.json 兜底） */
function skillView(list: SkillEntry[]): CockpitOverviewData['skills'] {
  const items = Array.isArray(list) ? list : []
  return {
    count: items.length,
    sample: items.slice(0, SKILL_SAMPLE_SIZE).map(s => s?.name).filter((x): x is string => !!x),
  }
}

/** health：window.yfwDiag.getBootSummary() 的 nodes 中按名匹配 engine/kernel；
 *  命中节点 ok 时取节点名、失败取 name×；无匹配/API 缺省/异常一律 '—'。
 *  （实测启动打点节点名为 mainReady/bridgeSpawn/bridgeReady/windowLoad，
 *   不含 engine/kernel 字面量——保持契约字段存在但值为 '—'，详见任务报告。） */
async function healthView(): Promise<CockpitOverviewData['health']> {
  try {
    const diag = window.yfwDiag
    if (!diag?.getBootSummary) return { ...NO_HEALTH }
    const summary = await diag.getBootSummary()
    const nodes = summary?.nodes
    if (!Array.isArray(nodes)) return { ...NO_HEALTH }
    const pick = (needle: string): string => {
      const hit = nodes.find(n => typeof n?.name === 'string' && n.name.toLowerCase().includes(needle))
      return hit ? (hit.ok ? hit.name : `${hit.name}×`) : '—'
    }
    return { engine: pick('engine'), kernel: pick('kernel') }
  } catch {
    return { ...NO_HEALTH }
  }
}

/** 会话/agent 快照（同步、轻量）：runningTasks = 正在流式的会话，
 *  status：'__pending__'（已排队、尚无 assistant 消息）→ wait，否则 exec；
 *  progress = conversationProgress 的 current/total 百分比（0-100）；meta = 进行中里程碑名。
 *  busyAgents = 流式会话绑定的 agentId（无 agentId 的默认会话归 yfworking 主 agent）。 */
function rosterOverview(): { tasks: OverviewTask[]; agents: OverviewAgent[] } {
  const chat = useChatStore.getState()
  const byId = new Map((chat.conversations ?? []).map(c => [c.id, c]))
  const streaming = chat.streamingConversations ?? {}
  const progress = chat.conversationProgress ?? {}

  const tasks: OverviewTask[] = []
  const busyAgents = new Set<string>()
  for (const [convId, streamVal] of Object.entries(streaming)) {
    const conv = byId.get(convId)
    if (!conv) continue
    const p = progress[convId]
    const pct = p && p.total > 0
      ? Math.max(0, Math.min(100, Math.round(((p.current ?? 0) / p.total) * 100)))
      : undefined
    const inProg = p && typeof p.inProgress === 'number' && Array.isArray(p.names)
      ? p.names[p.inProgress]
      : undefined
    tasks.push({
      title: conv.title || convId,
      status: streamVal === '__pending__' ? 'wait' : 'exec',
      ...(typeof pct === 'number' ? { progress: pct } : {}),
      ...(inProg ? { meta: inProg } : {}),
    })
    busyAgents.add(conv.agentId ?? 'yfworking')
  }

  const roster = (useAgentStore.getState().agents ?? [])
    .filter(a => a && a.enabled)
    .slice(0, ROSTER_SIZE)
    .map(a => ({
      id: a.id,
      role: a.name || a.id,
      state: (busyAgents.has(a.id) ? 'run' : 'idle') as OverviewAgent['state'],
    }))

  return { tasks, agents: roster }
}

async function loadOverview(): Promise<CockpitOverviewData> {
  const [usageReport, skills, health] = await Promise.all([
    fetchUsage({ scope: 'today' }).catch(() => null),
    fetchSkills('').catch(() => []),
    healthView(),
  ])
  const roster = rosterOverview()
  return {
    runningTasks: roster.tasks,
    agents: roster.agents,
    usage: usageView(usageReport),
    skills: skillView(skills),
    health,
  }
}

/** 驾驶舱 overview 数据：view==='cockpit' 期间 5s 轮询；离开驾驶舱即停（保活期不空跑）。 */
export function useCockpitOverview(): CockpitOverviewData | null {
  const view = useViewStore(s => s.view)
  const [data, setData] = useState<CockpitOverviewData | null>(null)

  useEffect(() => {
    if (view !== 'cockpit') return
    let dead = false
    const load = async () => {
      const next = await loadOverview()
      if (!dead) setData(next)
    }
    void load()
    const timer = window.setInterval(() => void load(), POLL_MS)
    return () => {
      dead = true
      window.clearInterval(timer)
    }
  }, [view])

  return data
}
