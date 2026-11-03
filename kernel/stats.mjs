// kernel/stats.mjs —— 用量聚合纯函数（docs/production/observability.md O1-2/O4-2）
// 数据源 = transcript assistant entry.message.usage（engine addUsage 累计四字段）。
// 与 server/transcript.mjs aggregateStats 键名兼容（totals/byModel/byProject/byDate），
// 新增 cache 字段 + byTool/bySession/byAuthor/cacheRate。纯函数，bridge 读文件后调用。
// 【S2-D5】byAuthor = 企业版管理端"消耗量按人/团队"的直接输入；数据源是 S2-D4 落盘的会话归属
// （meta 首行的 authorId，由 kernel/readonly.mjs 逐条注入到 e.authorId），故 D5 的前提是 D4 已落盘。
const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']

function newBucket() {
  const b = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, turns: 0 }
  return b
}
function addTo(b, u) {
  for (const k of USAGE_KEYS) b[k] += u[k] ?? 0
  b.turns += 1
}
function ensure(map, k) {
  if (!map[k]) map[k] = newBucket()
  return map[k]
}

export function aggregateUsage(entries, { bySession = false } = {}) {
  const totals = newBucket()
  const byModel = {}
  const byProject = {}
  // 【S2-D5】按作者聚合。始终返回（与 byProject 同规格），不设开关——管理端需要稳定键。
  const byAuthor = {}
  const byDate = {}
  const bySessionMap = {}
  const byTool = {}
  let inputSum = 0
  let cacheReadSum = 0
  for (const e of entries || []) {
    if (e?.type !== 'assistant') continue
    const usage = e.message?.usage
    if (!usage || !Number.isFinite(usage.input_tokens)) continue
    const model = e.message?.model || 'unknown'
    const day = String(e.timestamp || '').slice(0, 10) || 'unknown'
    const u = {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    }
    addTo(totals, u)
    addTo(ensure(byModel, model), u)
    addTo(ensure(byDate, day), u)
    if (bySession && e.sessionId) addTo(ensure(bySessionMap, e.sessionId), u)
    // byProject：bridge 遍历目录时注入 e.project（按项目聚合）
    if (e.project) addTo(ensure(byProject, e.project), u)
    // 【S2-D5】byAuthor：会话归属由 S2-D4 落盘（meta 首行 authorId），readonly.mjs 逐条注入 e.authorId。
    // 旧 transcript（D4 之前无归属）落 `unknown` 桶 —— **显式成桶而非静默丢弃/或强行填默认作者**：
    // 伪造归属会把"历史数据从未记录作者"伪装成"已归属 local"，掩盖仍需迁移的部分；成桶则让
    // "还有多少数据没有归属"直接可数（迁移决策正需要这个数）。
    addTo(ensure(byAuthor, e.authorId || 'unknown'), u)
    for (const b of (e.message?.content || [])) {
      if (b?.type === 'tool_use' && b.name) byTool[b.name] = (byTool[b.name] || 0) + 1
    }
    inputSum += u.input_tokens
    cacheReadSum += u.cache_read_input_tokens
  }
  const cacheRate = inputSum + cacheReadSum > 0 ? cacheReadSum / (inputSum + cacheReadSum) : 0
  const out = { totals, byModel, byProject, byAuthor, byDate, byTool, cacheRate }
  if (bySession) out.bySession = bySessionMap
  return out
}
