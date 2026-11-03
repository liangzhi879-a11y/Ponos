// kernel/memory-search.mjs —— MemorySearch 工具检索实现（spec MS1）
// ---------------------------------------------------------------------------
// local 直检：遍历经验根 *.md → 解析 `- [会话|标签] 摘要 -- 全文` 条目 → **经统一排序真源**
// `kernel/memory-rank.mjs`（`0.7×余弦 + 0.3×关键词`，idf 加权，tagBoost 3/1）打分排序 → 输出 topK。
// ★ 2026-09-30 统一经验通路：本函数原先自带一套打分（**纯余弦、无 idf、无关键词项、无全序
//   tie-break**），与 workflow 节点（memory.mjs）和 legacy 注入（graph.mjs#search）口径不同 ⇒
//   "同批数据同查询"在三处给出三种排序。现三处同源（唯一真源见 kernel/memory-rank.mjs 头注释）。
// scope：personal=个人根；project=项目根（memory/project，当前无写入方，
// 目录不存在即 0 命中）；all=两库合并。纯本地无网络。对应 IGraphBackend 接口的
// search(query, { topK })——本实现为 local 直检，external 后端未来经工厂替换。
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseEntryLine } from './memory.mjs'
import { rankRelevant } from './memory-rank.mjs'

function readEntriesFrom(root, dirLabel) {
  const out = []
  if (!root || !existsSync(root)) return out
  let files = []
  try { files = readdirSync(root).filter((f) => f.endsWith('.md')) } catch { return out }
  for (const f of files) {
    const theme = f.slice(0, -3)
    const file = join(root, f)
    let text = ''
    try { text = readFileSync(file, 'utf-8') } catch { continue }
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim()
      if (!t.startsWith('- [')) continue
      const { tag, summary, full } = parseEntryLine(t)
      if (!summary) continue
      out.push({ theme, tag: tag || '', summary, full, file })
    }
  }
  return out
}

// scope：personal（个人根）/ project（项目根）/ all（默认，两库合并）
export function searchLocalMemory({ personalRoot = '', projectRoot = '', query = '', topK = 5, scope = 'all' } = {}) {
  const q = String(query || '').trim()
  if (!q) return { items: [], count: 0 }
  const sc = String(scope || 'all')
  const entries = []
  if (sc === 'personal' || sc === 'all') entries.push(...readEntriesFrom(personalRoot, 'personal'))
  if (sc === 'project' || sc === 'all') entries.push(...readEntriesFrom(projectRoot, 'project'))
  // ★★ 2026-09-30 统一经验通路（**第四处**：本函数是 MemorySearch 工具背后的实现）：
  //   原先自带一套打分 —— 纯余弦（**无 idf、无关键词项**）、无全序 tie-break、tagBoost 与图谱节点不一致。
  //   现改走 `kernel/memory-rank.mjs`（唯一真源）：`0.7×余弦 + 0.3×关键词`、idf 加权、
  //   全序排序（score→summary→整行）。与 workflow 节点、legacy 注入**同源**。
  //   · 关键词取自查询串按分隔符切分（同一串既作向量查询、也作关键词表）；
  //   · `minScore: 0` + `score > 0` 过滤：保持"有任何正相关即入选"的原语义；
  //   · 工具层仍保留自己的 topK 夹取策略（1..10）——那是对外契约，不属于打分口径。
  const keywords = q.split(/[\s,，、;；]+/).filter(Boolean)
  const { ranked } = rankRelevant(entries, { query: q, keywords, minScore: 0 })
  const scored = ranked.filter((e) => e.score > 0)
  // 对外输出形状（工具契约，保持不变）：topK 夹取 1..10，且只暴露约定字段
  const items = scored
    .slice(0, Math.min(Math.max(1, Number(topK) || 5), 10))
    .map(({ theme, tag, summary, full, file, score }) => ({ theme, tag, summary, full, file, score }))
  return { items, count: scored.length }
}
