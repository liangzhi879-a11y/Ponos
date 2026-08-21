// server/compact-keyinfo.test.mjs —— P5 L1-1 关键信息保留 + L2-1 预算配置化
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assembleSummaryRequest, extractKeyInfo, keyInfoBlock, resolveCompactSettings } from '../kernel/compact.mjs'

const messages = [
  { role: 'user', content: '实现导出功能' },
  { role: 'assistant', content: '先梳理现有模块' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'A' }, { content: 'B' }] } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: 'src/export.js' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'written' }] },
  { role: 'assistant', content: '已决定采用流式导出，接口名 exportStream' },
]

test('extractKeyInfo：TodoWrite 清单 / Write/Edit 文件 / 最近 assistant 决策', () => {
  const key = extractKeyInfo(messages)
  assert.deepEqual(key.todos, ['A / B'])
  assert.deepEqual(key.files, ['Write src/export.js'])
  assert.equal(key.decisions.length, 2) // 最后两条 assistant 文本
  assert.ok(key.decisions[1].includes('exportStream'))
})

test('keyInfoBlock：结构化提示块 + 空 key 返回空串', () => {
  const block = keyInfoBlock(extractKeyInfo(messages))
  assert.ok(block.includes('<key-info>'))
  assert.ok(block.includes('任务清单：A / B'))
  assert.ok(block.includes('文件变更：Write src/export.js'))
  assert.equal(keyInfoBlock({ todos: [], files: [], decisions: [] }), '')
})

test('assembleSummaryRequest：keyInfo 追加在压缩指令之后', () => {
  const cut = { covered: messages.slice(0, 2) }
  const req = assembleSummaryRequest({ system: 'sys', messages, cut, lastSummary: null, keyInfo: '<key-info>\n- 任务清单：A\n</key-info>' })
  const last = req[req.length - 1]
  assert.ok(last.content.includes('系统压缩指令'))
  assert.ok(last.content.includes('<key-info>'))
  assert.ok(last.content.indexOf('系统压缩指令') < last.content.indexOf('<key-info>'))
})

test('resolveCompactSettings：settings.compact 覆盖 ratio + 预算', () => {
  const r = resolveCompactSettings({ window: 200_000, settings: { compact: { thresholdTokens: 100_000, reserveTokens: 10_000, maxToolResults: 5000 } }, env: {} })
  assert.equal(r.thresholdRatio, 0.5)
  assert.equal(r.retainRatio, 0.05)
  assert.equal(r.toolResultBudget, 5000)
})

test('resolveCompactSettings：未配置 → 默认 0.8/0.16 + env 预算', () => {
  const r = resolveCompactSettings({ window: 200_000, settings: {}, env: { CLAUDE_CODE_TOOL_RESULT_BUDGET_BYTES: '8888' } })
  assert.equal(r.thresholdRatio, 0.8)
  assert.equal(r.retainRatio, 0.16)
  assert.equal(r.toolResultBudget, 8888)
  const d = resolveCompactSettings({ window: 200_000, settings: {}, env: {} })
  assert.equal(d.toolResultBudget, 20000)
})
