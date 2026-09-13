// kernel/readonly.mjs —— kernel 只读子命令（spec 2026-09-08 agentloop U1/AS1）
// ---------------------------------------------------------------------------
// --usage / --audit / --agents 的聚合实现。数据源 = kernel 自身 transcript
// （<configDir>/projects/<cwd-san>/<sessionId>.jsonl）。纯本地只读，由 cli.mjs
// 在进入 loop 前短路调用（stdout JSON）。bridge 只做 HTTP 薄转发，不做跨模块 import。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { aggregateUsage } from './stats.mjs'
import { buildAuditReport } from './audit.mjs'
import { costOf } from './cost.mjs'
import { resolveAgents, discoverUserAgents } from './agents.mjs'

// 遍历 <configDir>/projects/<dir>/*.jsonl，逐行读 transcript 并注入 e.sessionId
// （文件名去 .jsonl）与 e.project（子目录名）；from/to 按 entry.timestamp 前 10 位
// （YYYY-MM-DD）过滤；sessionId/project 过滤在调用方传入后于此处合并执行。
export function collectTranscriptFiles({ configDir = '', sessionId = '', project = '', from = '', to = '' } = {}) {
  const entries = []
  const root = join(configDir, 'projects')
  if (!existsSync(root)) return entries
  let dirs = []
  try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()) } catch { return entries }
  for (const d of dirs) {
    const dirName = d.name
    if (project && dirName !== project) continue
    const dirPath = join(root, dirName)
    let files = []
    try { files = readdirSync(dirPath).filter((f) => f.endsWith('.jsonl')) } catch { continue }
    for (const f of files) {
      const sid = f.slice(0, -'.jsonl'.length)
      if (sessionId && sid !== sessionId) continue
      let text = ''
      try { text = readFileSync(join(dirPath, f), 'utf-8') } catch { continue }
      for (const line of text.split('\n')) {
        const t = line.trim()
        if (!t) continue
        let e = null
        try { e = JSON.parse(t) } catch { continue }
        const ts = String(e.timestamp || '')
        if (from && ts.slice(0, 10) < from) continue
        if (to && ts.slice(0, 10) > to) continue
        entries.push({ ...e, sessionId: sid, project: dirName })
      }
    }
  }
  return entries
}

function readPriceEnv(env = process.env) {
  return {
    pricePerMInput: Number(env.PONOS_PRICE_PER_M_INPUT) || 0.2,
    pricePerMOutput: Number(env.PONOS_PRICE_PER_M_OUTPUT) || 1.2,
    cacheReadRatio: Number(env.PONOS_CACHE_READ_RATIO) || 0.1,
  }
}

// 今日窗口的 UTC 日界（K2.0，2026-09-13 系统性优化）。**三处必须同源**：transcript 的
// timestamp 由 session.mjs 的 `new Date().toISOString()` 写入，stats.mjs byDate 按
// `ts.slice(0,10)` 分桶，日期过滤也按 `ts.slice(0,10)` 比较（见上）⇒ 同一个 UTC 日界。
// **不可改成本地日界**：本地 from 配 UTC 切片，会把「本地今天 00:00–08:00（UTC+8 的上午）」
// 的条目当成昨天而漏掉——错误方向是**静默少算**，比现在的多算更隐蔽。now 可注
// （测试用，避开跨零点抖动）。
export function todayFrom(now = new Date()) {
  return now.toISOString().slice(0, 10)
}

export function runUsage({ configDir = '', sessionId = '', project = '', from = '', to = '', scope = 'all', now } = {}) {
  // K2.0 日期下推（现存 bug 修复）：`scope` 此前**只**驱动 bySession 开关（:58 的
  // `scope === 'session'`），from/to 恒取自 args ⇒ `scope='today'` 与 `'all'` 的计算量完全
  // 相同（都是全量历史聚合），而唯一的调用方把它当「今日」用：驾驶舱卡
  // （useCockpitOverview.ts:141 `fetchUsage({scope:'today'})`，每 5s 轮询、GUI 侧超时也正好
  // 5s）与卡片文案「今日 / requests=今日 turns」。故把 today 真正下推成日期过滤。
  // **收益边界（实测，勿高估）**：过滤发生在 collectTranscriptFiles 的**逐行 parse 之后**
  // （见上 `ts.slice(0,10)` 比较），故省掉的是**聚合**（48000 条 557.6ms → 477.3ms，14%），
  // **解析一分未省**（470.7ms，占绝对大头）。本改动的价值是**正确性**（数字与「今日」文案
  // 终于对得上），性能大头在 K2.2 的剪枝与水位线缓存（只解析当天文件 ≈ 14.2ms）。
  // scope 的两类语义（文档化的 2026-09-08 spec:65 只有 session|project|all，today 是 GUI 引入的）：
  //   session|project|all = **分组维度**（bySession 开关），过滤靠独立的 sessionId/project 参数；
  //   today               = **时间窗口**，是本函数新支持的语义。
  // 窗口取**闭区间** [今天, 今天]，from 与 to 都要推导——只给 from 会让窗口变成
  // `[今天, ∞)`，机器时钟回跳/NTP 校正写出的"未来条目"会被算进「今日」（静默多算，
  // 正是本次要修的病灶方向）。显式传入的 from/to 各自优先于推导值（它们是文档化契约里
  // 更具体的参数；实际没有调用方与 scope=today 同时传）。
  const isToday = scope === 'today'
  const day = isToday ? todayFrom(now) : ''
  const entries = collectTranscriptFiles({
    configDir, sessionId, project,
    from: from || day,
    to: to || day,
  })
  const agg = aggregateUsage(entries, { bySession: scope === 'session' })
  const prices = readPriceEnv()
  const byModelCostUsd = {}
  let costUsd = 0
  for (const [m, bucket] of Object.entries(agg.byModel)) {
    const c = costOf(bucket, prices)
    byModelCostUsd[m] = Number(c.toFixed(4))
    costUsd += c
  }
  const budgetUsd = Number(process.env.PONOS_BUDGET_USD) || 0
  return {
    totals: agg.totals,
    byModel: agg.byModel,
    byProject: agg.byProject,
    byDate: agg.byDate,
    byTool: agg.byTool,
    cacheRate: Number(agg.cacheRate.toFixed(4)),
    costUsd: Number(costUsd.toFixed(4)),
    byModelCostUsd,
    budgetUsd,
    overBudget: budgetUsd > 0 && costUsd > budgetUsd,
    ...(scope === 'session' ? { bySession: agg.bySession } : {}),
  }
}

export function runAudit({ configDir = '', sessionId = '', from = '', to = '' } = {}) {
  const entries = collectTranscriptFiles({ configDir, sessionId, from, to })
  return buildAuditReport(entries, { from, to, sessionId })
}

export function runAgents({ configDir = '' } = {}) {
  const userIds = new Set(discoverUserAgents({ configDir }).map((a) => a.id))
  return resolveAgents({ configDir }).map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    model: a.model || '',
    tools: a.tools || [],
    skills: a.skills || [],
    source: userIds.has(a.id) ? 'user' : 'builtin',
  }))
}

// cli 只读子命令统一入口：返回 { output, code }（code 1 = 无数据之外的失败情形预留）
export function runReadonly({ mode = '', args = {}, configDir = '' }) {
  const common = { configDir, sessionId: args.sessionId || '', project: args.project || '', from: args.from || '', to: args.to || '' }
  if (mode === 'agents') return { output: runAgents({ configDir }), code: 0 }
  if (mode === 'usage') return { output: runUsage({ ...common, scope: args.scope || 'all' }), code: 0 }
  if (mode === 'audit') return { output: runAudit(common), code: 0 }
  return { output: { error: `未知只读子命令：${mode}` }, code: 1 }
}
