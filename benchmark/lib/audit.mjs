// 语义越界审计：扫描 agent 改动代码中的"自我合理化"注释/语义决策
// ---------------------------------------------------------------------------
// 背景：LLM 即使收到明确契约（如"不做任何去重"）仍可能自创语义（T004 实测
// claude 自创 (项目,模型) 去重，注释写"去重口径，避免重复计入"自我合理化），
// 且这类越界不一定导致 verify 失败。本模块扫描 diff 新增行中的特征关键词，
// 在报告中标记潜在越界，供人工复核。
// ---------------------------------------------------------------------------

// 特征关键词：命中即提示"agent 自行发明/收窄了语义"（分组便于报告归因）
const PATTERNS = [
  {
    group: '去重/只计首',
    re: /(去重|dedup|de-dup|只计首|只取首|仅计首|仅取首|只保留首|仅首条|首条生效|first occurrence|only count.*first|count.*once|首条为准)/i,
  },
  {
    group: '防重复合理化',
    re: /(避免.*重复|防止.*重复|不重复计入|重复计入|避免.*double.?count|prevent.*duplicate|avoid.*duplicate|不重复统计|防.*重复)/i,
  },
  {
    group: '口径/语义收窄',
    re: /(口径|语义收窄|仅统计|只统计|只对.*生效|仅对.*生效|忽略.*重复|filter.*duplicate|去重后|unique.*(?:project|model))/i,
  },
]

// 否定语境（遵循契约的正向表述，如"不做去重/截断""不进行去重"）：命中即跳过该行，
// 防止把 agent 遵守"不得去重"条款的注释误报为越界
const NEGATION_RE = /(不|无|禁止|不得|勿|别|never|no|非|不进行|不做|不设)\s*[^，。；\n]{0,12}(去重|dedup|de-dup|重复|过滤|截断)/i

/**
 * 审计单条评测结果：扫描 diff patch 中新增代码（+ 开头行或未跟踪文件全文）
 * 的自我合理化关键词。
 * @param {{ diff?: { patch?: string }, agent: string, task: string }} r 评测结果
 * @returns {Array<{ group: string, file: string, line: string }>} 命中列表
 */
export function auditResult(r) {
  const patch = r?.diff?.patch || ''
  if (!patch) return []
  const hits = []
  let file = '?'
  let inUntracked = false
  for (const raw of patch.split('\n')) {
    // 文件头：diff --git a/x b/x（进入已跟踪 diff 块）或 --- path (untracked) ---
    const df = raw.match(/^diff --git a\/(.*?) b\//)
    if (df) { file = df[1]; inUntracked = false; continue }
    const uf = raw.match(/^--- (.*?) \(untracked\) ---$/)
    if (uf) { file = uf[1]; inUntracked = true; continue }
    // 已跟踪文件只扫新增行（+ 开头，排除 +++ 文件头）；未跟踪文件全文都是 agent 新增
    const line = inUntracked ? raw : /^\+\+\+/.test(raw) ? null : /^\+/.test(raw) ? raw.slice(1) : null
    if (!line || !line.trim()) continue
    if (NEGATION_RE.test(line)) continue // "不做去重"是遵循契约，不是越界
    for (const p of PATTERNS) {
      if (!p.re.test(line)) continue
      hits.push({ group: p.group, file, line: line.trim().slice(0, 160) })
      break // 一行只记一个分组，避免重复刷屏
    }
  }
  return hits
}

/**
 * 审计全部结果：按 agent×task 聚合。
 * @param {object[]} summary
 * @returns {{ total: number, byResult: Array<{ agent, task, status, hits }> }}
 */
export function auditResults(summary) {
  const byResult = []
  let total = 0
  for (const r of summary || []) {
    const hits = auditResult(r)
    if (hits.length) {
      byResult.push({ agent: r.agent, task: r.task, status: r.status, hits })
      total += hits.length
    }
  }
  return { total, byResult }
}
