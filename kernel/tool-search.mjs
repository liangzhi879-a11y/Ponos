// 工具按需加载（deferred tools）的检索层 —— 纯函数，无状态、无 IO。
// ---------------------------------------------------------------------------
// 范式来源（2026-10-26 调查 C:/Users/T203-15/agents 下四家成熟产品后确定）：
//   · Claude Code：MCP 工具**一律 deferred**（`ToolSearchTool/prompt.ts#isDeferredTool`：
//     `if (tool.isMcp === true) return true`），只投**工具名**（`formatDeferredToolLine`
//     直接 `return tool.name`，连 searchHint 都不渲染 —— 其 A/B 实验证明 hint 无收益），
//     由 `ToolSearch` 元工具按 `select:a,b` 或关键词取回完整 JSONSchema。
//     其源码注释旁证了问题是同量级的：`caches.ts` 写 "full tool prompts, ~500KB for 50 MCP tools"。
//   · Codex：`mcp_tool_exposure.rs` 里 `if search_tool_enabled { Deferred } else { Direct }`
//     —— **全有或全无**，没有"留 N 个"的中间态；`ToolExposure::Deferred` 的注释明确
//     "Deferred tools must provide search metadata"；检索用 BM25，
//     `TOOL_SEARCH_DEFAULT_LIMIT = 8`。
//
// 我们为什么不照抄 BM25：Ponos 的 deferred 集合规模是"十到百量级"，且 query 形态集中在
//   `select:名字`（模型已知名字）与两三个关键词。为此引入索引/依赖不划算，且 BM25 对
//   `mcp__server__tool_name` 这种带命名空间的长标识符并不天然更好（分词后 server 名会
//   污染排序）。故用**确定性打分**：必需词（`+x`）过滤 → 名字命中 > 描述命中 →
//   前缀/子串加分 → 同名次按字典序（可复现，与本仓 T1.5 裁剪的稳定性纪律一致）。
//
// 与裁剪（applyDynamicToolBudget）的分工：
//   · 裁剪 = 丢能力（被丢的工具模型再也看不到，也无从取回）
//   · deferred = 延迟投递（schema 不在前缀里，但**能力一直在**，随时可取回）
//   两者都保留：静态工具面若真的超预算，仍由裁剪兜底（deferred 已把 MCP 移出前缀，
//   正常情况下不会再触发；但第三方插件/工作流工具爆炸时它仍是最后一道闸）。
/** ToolSearch 工具自身的名字（唯一真源；tools.mjs 注册与 prompt 声明都取这里） */
export const TOOL_SEARCH_NAME = 'ToolSearch'

/** 单次检索默认返回条数（对齐 Codex 的 TOOL_SEARCH_DEFAULT_LIMIT） */
export const TOOL_SEARCH_DEFAULT_LIMIT = 8
/** 硬上限：防模型传个巨大 max_results 把整个 deferred 面一次性灌回前缀 */
export const TOOL_SEARCH_MAX_LIMIT = 40

/**
 * 解析查询串。
 * 支持三种形态（与 Claude Code 的 query forms 对齐）：
 *   · `select:Read,Edit,Grep` —— 点名取回（大小写不敏感）
 *   · `notebook jupyter`       —— 关键词，全部参与排序
 *   · `+slack send`            —— `+` 前缀 = **必须命中**（在名字或描述里），其余词参与排序
 * @param {string} query
 * @returns {{ mode: 'select'|'keywords', names: string[], required: string[], terms: string[] }}
 */
export function parseToolSearchQuery(query) {
  const raw = String(query ?? '').trim()
  if (!raw) return { mode: 'keywords', names: [], required: [], terms: [] }
  const sel = /^select\s*[:：]\s*(.+)$/i.exec(raw)
  if (sel) {
    const names = sel[1].split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
    return { mode: 'select', names, required: [], terms: [] }
  }
  const required = []
  const terms = []
  for (const tok of raw.split(/\s+/)) {
    const t = tok.trim().toLowerCase()
    if (!t) continue
    if (t.startsWith('+') && t.length > 1) required.push(t.slice(1))
    else terms.push(t)
  }
  return { mode: 'keywords', names: [], required, terms }
}

/** 在 haystack（小写）里判断某个词是否命中；兼容下划线/连字符：'read_scene' ⊃ 'read' */
function hits(haystack, term) {
  if (!term) return false
  if (haystack.includes(term)) return true
  // 词边界松散匹配：把分隔符视作空格，允许 'send message' 命中 'send_message'
  const spaced = term.replace(/[_\-.]/g, ' ')
  return spaced !== term && haystack.replace(/[_\-.]/g, ' ').includes(spaced)
}

/**
 * 在 deferred 条目集合里检索。
 *
 * `entries` 形状：`[{ name, description }]`（**不需要** input_schema —— 检索只吃元数据，
 * 这也是 deferred 的核心：schema 留在内存里不投前缀）。调用方负责过滤"哪些是 deferred"。
 *
 * 打分规则（每一条都为"可解释"而写，避免出现"为什么它排第一"无从复现）：
 *   · 必需词有一个没命中 ⇒ 直接淘汰（不是降分）
 *   · 名字整体包含 query 原文 ⇒ +100；名字命中某个词 ⇒ +10/词
 *   · 描述命中某个词 ⇒ +3/词
 *   · 名字以某词开头 ⇒ 额外 +5（`read` 优先 `read_scene` 而非 `thread_read`）
 *   · 同分按 name 字典序 ⇒ 同一输入必得同一结果（与 T1.5 裁剪的确定性纪律一致）
 * @param {Array<{name: string, description?: string}>} entries
 * @param {string} query
 * @param {{ maxResults?: number }} [opts]
 * @returns {{ mode: string, matched: Array<{name: string, score: number}>, total: number, truncated: boolean }}
 */
export function searchDeferredTools(entries, query, { maxResults } = {}) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e.name === 'string') : []
  const q = parseToolSearchQuery(query)
  const limitRaw = Number(maxResults)
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(TOOL_SEARCH_MAX_LIMIT, Math.floor(limitRaw))
    : TOOL_SEARCH_DEFAULT_LIMIT

  // ① select：点名（大小写不敏感；保持查询里的顺序 —— 调用方按它回报"没找到的"）
  if (q.mode === 'select') {
    const byLower = new Map(list.map((e) => [e.name.toLowerCase(), e]))
    const matched = []
    for (const want of q.names) {
      const e = byLower.get(want.toLowerCase())
      if (e) matched.push({ name: e.name, score: 100 })
    }
    const truncated = matched.length > limit
    return { mode: 'select', matched: truncated ? matched.slice(0, limit) : matched, total: matched.length, truncated }
  }

  // ② keywords
  const scored = []
  const queryLower = String(query ?? '').trim().toLowerCase()
  for (const e of list) {
    const name = e.name.toLowerCase()
    const desc = String(e.description ?? '').toLowerCase()
    // 必需词先过滤（任一未命中即淘汰）
    if (q.required.length && !q.required.every((t) => hits(name, t) || hits(desc, t))) continue
    let score = 0
    if (queryLower && name.includes(queryLower)) score += 100
    for (const t of q.terms) {
      if (hits(name, t)) score += 10 + (name.startsWith(t) ? 5 : 0)
      if (hits(desc, t)) score += 3
    }
    // 没有任何正向词命中且也没有必需词 ⇒ 不打分（空查询不返回全部，防一次性灌回）
    if (score <= 0) continue
    scored.push({ name: e.name, score })
  }
  scored.sort((a, b) => (b.score - a.score) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const truncated = scored.length > limit
  return { mode: 'keywords', matched: truncated ? scored.slice(0, limit) : scored, total: scored.length, truncated }
}

/**
 * 生成给模型看的检索结果文本。
 *
 * 形态刻意与 Claude Code 的 `<functions>` 块一致：**每条一行完整 JSON**（name/description/
 * input_schema）。为什么整块塞进文本而不是"塞进 tools[]"：`tools[]` 是每轮全量重发的前缀，
 * 把 schema 放回去就等于把 deferred 的收益全部退还。放进对话历史则只在这一次读到时付费
 * （且后续轮次靠 KV 前缀缓存命中，成本可忽略）。
 *
 * @param {Array<object>} schemas 命中的完整 schema（name/description/input_schema）
 * @param {{ total?: number, truncated?: boolean, mode?: string, query?: string }} [meta]
 * @returns {string}
 */
export function formatToolSearchResult(schemas, { total = 0, truncated = false, query = '' } = {}) {
  const list = Array.isArray(schemas) ? schemas : []
  if (!list.length) {
    return `未匹配到工具（查询：${String(query || '').trim() || '（空）'}）。`
      + `\n提示：用 \`select:工具名\` 精确取回，或用关键词（如 \`lottie keyframe\`）检索；`
      + `\`+词\` 表示该词必须命中。`
  }
  const lines = list.map((s) => '<function>' + JSON.stringify({
    description: s.description,
    name: s.name,
    parameters: s.input_schema,
  }) + '</function>')
  const head = `已取回 ${list.length} 个工具${truncated ? `（共 ${total} 个匹配，已截断）` : ''}。`
    + '它们现在与顶层工具一样可调用（参数结构见每个 function 的 parameters）。'
  return head + '\n<functions>\n' + lines.join('\n') + '\n</functions>'
}
