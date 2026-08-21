// server/audit.test.mjs —— 审计聚合（docs/production/security.md S1-1）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAuditReport } from '../kernel/audit.mjs'

function entry(type, msg, ts, seq) {
  return { type, seq, timestamp: ts, message: msg }
}

test('buildAuditReport：tool_use/tool_result 行提取 + 参数/结果摘要截断', () => {
  const entries = [
    entry('assistant', { role: 'assistant', content: [
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'rm -rf /tmp/x' } },
    ] }, '2026-08-21T00:00:00Z', 1),
    entry('user', { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'deleted', is_error: false },
    ] }, '2026-08-21T00:00:01Z', 2),
    entry('user', { role: 'user', content: 'plain' }, '2026-08-21T00:00:02Z', 3),
  ]
  const rows = buildAuditReport(entries, { sessionId: 's1' })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].type, 'tool_use'); assert.equal(rows[0].tool, 'Bash')
  assert.match(rows[0].params, /rm -rf/)
  assert.equal(rows[1].type, 'tool_result'); assert.equal(rows[1].toolUseId, 't1')
  assert.equal(rows[1].summary, 'deleted')
  assert.equal(rows[0].session, 's1')
})

test('buildAuditReport：时间范围过滤 + 长内容截断 200 字符', () => {
  const entries = [
    entry('assistant', { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'x'.repeat(500) } }] }, '2026-08-21T00:00:00Z', 1),
    entry('assistant', { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'Read', input: { file_path: '/f' } }] }, '2026-08-21T01:00:00Z', 2),
  ]
  const rows = buildAuditReport(entries, { from: '2026-08-21T00:30:00Z' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].tool, 'Read')
  assert.ok(rows[0].params.length <= 200 + 1)   // 截断 + 省略号
})
