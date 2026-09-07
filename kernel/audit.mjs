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
          rows.push({ ts, seq: e.seq, session: sessionId || '', type: 'tool_use', tool: b.name, params: summarize(b.input) })
        }
      }
    } else if (m.role === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b?.type === 'tool_result') {
          rows.push({ ts, seq: e.seq, session: sessionId || '', type: 'tool_result', toolUseId: b.tool_use_id, summary: String(b.content || '').slice(0, 200) })
        }
      }
    }
  }
  return rows
}
