// kernel/knowledge-search.mjs —— KnowledgeSearch 工具的检索实现
// ---------------------------------------------------------------------------
// 与 MemorySearch 的关系：MemorySearch 是 S1 之前的条目级检索（每次全量读文件 + 全量
// 现算向量，O(N)）；KnowledgeSearch 走已建好的倒排索引，O(命中量)。S1 阶段两者并存
// （S3 才做收敛），但**接口语义对齐**：同样返回条目清单 + 文件路径供 Read 追全文。
//
// 同步契约：run() 不返回 Promise，故这里全程同步——store.load() 是同步函数（Task 6
// 的契约，内部无任何 await），此处**不写 await**。
import { createKnowledgeStore } from './knowledge.mjs'
import { makeSnippet } from '../shared/knowledge-core.mjs'

export function searchKnowledge({ configDir, query, keywords = [], spaces = null, topK = 5, mode = 'snippet' } = {}) {
  const q = String(query || '').trim()
  const kws = (keywords || []).map((k) => String(k).trim()).filter(Boolean)
  if (!q && !kws.length) {
    return { content: 'query 参数缺失：请描述想检索的知识主题', isError: true }
  }
  try {
    const store = createKnowledgeStore({ configDir })
    store.load({})
    const qtext = q || kws.join(' ')
    const r = store.search({ query: q, keywords: kws, spaces, topK, mode })
    if (!r.count) {
      return {
        content: `知识库无「${qtext}」相关命中。可换关键词，或确认该主题尚未沉淀过内容。`,
        isError: false,
      }
    }
    const lines = r.items.map((it) => {
      // 来源一律用**完整 docId**（= `spaceId/relPath`），Heading 与行号齐备：
      // 模型据 docId 的 relPath 就能 Read 到原文，不必自己拼空间前缀。
      const where = `${it.docId}${it.heading ? ` › ${it.heading}` : ''} · 第 ${it.line} 行`
      return `- [${where}] (${it.score.toFixed(2)}) ${makeSnippet(it.snippet, { maxLen: 300 })}`
    })
    return {
      content: `【相关知识检索】${r.count} 条命中（${new Set(r.items.map((i) => i.docId)).size} 篇文档）：\n${lines.join('\n')}`,
      isError: false,
    }
  } catch (e) {
    // 检索失败不能变成会话阻断：降级为"无命中"提示（isError 保持 false——工具自身
    // 故障不该让模型以为整个会话出错了）。
    return { content: `知识库检索暂不可用（${e?.message || e}）。可直接用 Read 打开记忆文件。`, isError: false }
  }
}
