// kernel/audit.mjs —— 审计聚合（docs/production/security.md S1-1）
// 数据源 = transcript JSONL（权威源，session.mjs 同格式）。纯函数，bridge /audit
// 读文件后调用本模块聚合——审计逻辑内核化，bridge 仅薄壳。
function summarize(v, max = 200) {
  try {
    const s = JSON.stringify(v)
    return s.length > max ? s.slice(0, max) + '…' : s
  } catch {
    return String(v).slice(0, max)
  }
}

export function buildAuditReport(entries, { from = '', to = '', sessionId = '' } = {}) {
  const rows = []
  for (const e of entries || []) {
    const ts = e.timestamp || ''
    if (from && ts < from) continue
    if (to && ts > to) continue
    const m = e.message || {}
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b?.type === 'tool_use') {
          rows.push({ ts, seq: e.seq, session: e.sessionId || sessionId || '', type: 'tool_use', tool: b.name, params: summarize(b.input) })
        }
      }
    } else if (m.role === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b?.type === 'tool_result') {
          // ★ 结构化 content（多模态/多块结果，session.mjs 落盘的正是块数组）必须走 summarize：
          //   直接 String(数组) 会得到 "[object Object],[object Object]" —— 审计行等于没有信息。
          //   同文件的 tool_use 分支已用 summarize，此处与之对齐。
          rows.push({ ts, seq: e.seq, session: e.sessionId || sessionId || '', type: 'tool_result', toolUseId: b.tool_use_id, summary: (Array.isArray(b.content) ? summarize(b.content, 200) : String(b.content ?? '')).slice(0, 200) })
        }
      }
    }
  }
  return rows
}
