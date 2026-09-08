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

export function runUsage({ configDir = '', sessionId = '', project = '', from = '', to = '', scope = 'all' } = {}) {
  const entries = collectTranscriptFiles({ configDir, sessionId, project, from, to })
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
