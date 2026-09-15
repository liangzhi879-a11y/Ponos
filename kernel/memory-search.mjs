// kernel/memory-search.mjs —— MemorySearch 工具检索实现（spec MS1）
// ---------------------------------------------------------------------------
// local 直检：遍历经验根 *.md → 解析 `- [会话|标签] 摘要 -- 全文` 条目 → 与 query 做
// 无模型余弦相似度（graph.mjs gramTokens/vectorizeText/cosine，tagBoost 强化标签命中）
// → 输出 topK。scope：personal=个人根；project=项目根（memory/project，当前无写入方，
// 目录不存在即 0 命中）；all=两库合并。纯本地无网络。对应 IGraphBackend 接口的
// search(query, { topK })——本实现为 local 直检，external 后端未来经工厂替换。
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { gramTokens, vectorizeText, cosine } from './graph.mjs'
import { parseEntryLine } from './memory.mjs'

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
  const qv = vectorizeText(q)
  const scored = entries.map((e) => {
    const text = `${e.theme} ${e.tag} ${e.summary} ${e.full}`
    const sv = vectorizeText(text, { tagBoost: 2 })
    return { ...e, score: Number(cosine(qv, sv).toFixed(4)) }
  }).filter((e) => e.score > 0)
  scored.sort((a, b) => b.score - a.score)
  const items = scored.slice(0, Math.min(Math.max(1, Number(topK) || 5), 10)).map(({ theme, tag, summary, full, file, score }) => ({ theme, tag, summary, full, file, score }))
  return { items, count: scored.length }
}
