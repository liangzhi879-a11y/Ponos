// 评分模块：综合评分计算（report.mjs 与 dashboard.mjs 共用）
// ---------------------------------------------------------------------------
// 评分体系（每 agent 汇总分 0-100）：
//   完成率   40%   pass 任务占比
//   探索效率 20%   平均耗时归一化（最快 agent 满分，越慢越低）
//   验证能力 20%   自测率（主动运行测试/verify）
//   改动质量 20%   改动聚焦度（只碰任务相关文件=高分；越界改动扣分）
// ---------------------------------------------------------------------------

// 任务相关文件白名单（agent 改动越界程度的评判依据）
export const TASK_FILES = {
  'T001-usage-dup': ['kernel/api.mjs', 'server/'],
  'T002-resume-filter': ['kernel/engine.mjs', 'kernel/cli.mjs', 'server/'],
  'T003-json-trim': ['kernel/compact.mjs', 'kernel/engine.mjs', 'server/'],
  'T004-transcript-stats': ['server/', 'kernel/'],
  'T005-cache-control': ['kernel/api.mjs', 'server/'],
  'T006-health-failures': ['server/', 'kernel/health.mjs'],
}

/** 单个 agent 的四维原始指标（未归一化） */
export function agentScore(summary, agent) {
  const rs = summary.filter((x) => x.agent === agent)
  if (!rs.length) return null
  // 1. 完成率 40
  const passRate = rs.filter((x) => x.status === 'pass').length / rs.length
  // 2. 探索效率 20（相对最快的平均耗时；超时按 15min 计最差）
  const avgMs = rs.reduce((s, x) => s + (x.timedOut ? 15 * 60 * 1000 : x.durationMs || 0), 0) / rs.length
  // 3. 验证能力 20
  const selfTestRate = rs.filter((x) => x.selfTested).length / rs.length
  // 4. 改动质量 20（聚焦度：未越界改动的任务占比）
  // 白名单键是任务目录名（'T003-json-trim'），结果里 r.task 是任务 id（'T003'）——
  // 以 id 前缀匹配目录键（r.taskDir 优先，兼容新旧结果格式）
  let focused = 0
  for (const r of rs) {
    if (r.status === 'workspace-error') continue
    const ns = r.diff?.nameStatus || ''
    const files = ns.split('\n').filter(Boolean).map((l) => l.split('\t')[1] || l.split(/\s+/)[1] || '')
    const allowed =
      TASK_FILES[r.taskDir] ||
      Object.entries(TASK_FILES).find(([k]) => k.startsWith((r.task || '') + '-'))?.[1] ||
      TASK_FILES[r.task] ||
      []
    // 无白名单的任务（如 SWE-bench：改动目标是外部仓库、合法改动面不可枚举）不判聚焦度，
    // 计入分母但不惩罚，避免该维度被整类任务拖成 0%
    if (!allowed.length) { focused++; continue }
    const ok = files.every((f) => allowed.some((p) => p.endsWith('/') ? f.startsWith(p) : f === p))
    if (ok) focused++
  }
  const focusRate = rs.length ? focused / rs.length : 0
  return { passRate, avgMs, selfTestRate, focusRate, n: rs.length }
}

/**
 * 计算所有 agent 的综合评分（含跨 agent 归一化与排名）。
 * @param {string[]} agents agent 名列表
 * @param {object[]} summary 结果数组（每条含 agent/task/status/durationMs/timedOut/selfTested/diff）
 * @returns {{ scores: object, fastestAvg: number }}
 *   scores[agent] = { passRate, avgMs, selfTestRate, focusRate, n, effScore, total, rank }
 */
export function computeScores(agents, summary) {
  const scores = {}
  for (const a of agents) {
    const s = agentScore(summary, a)
    if (s) scores[a] = s
  }
  const vals = Object.values(scores).map((s) => s.avgMs)
  const fastestAvg = vals.length ? Math.min(...vals) : 0
  for (const a of agents) {
    if (!scores[a]) continue
    const s = scores[a]
    // 探索效率：最快=100，越慢越低；分母取 max(最快, 60s) 避免过快抖动
    const eff = fastestAvg > 0 ? Math.max(0, 1 - (s.avgMs - fastestAvg) / Math.max(fastestAvg, 60 * 1000)) : 0
    s.total = Math.round(s.passRate * 40 + eff * 20 + s.selfTestRate * 20 + s.focusRate * 20)
    s.effScore = Math.round(eff * 100)
    s.rank = 1 + agents.filter((b) => scores[b] && scores[b].total > s.total).length
  }
  return { scores, fastestAvg }
}
