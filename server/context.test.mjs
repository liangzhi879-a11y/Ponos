import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  contextWindowFor, isCodeLike, estimateTokens, estimateMessage, estimateHistory,
  estimateRequest, createTokenLedger, makeUsageAnchor, MODEL_CONTEXT_WINDOWS,
} from '../kernel/context.mjs'

test('窗口表与优先级：env → 模型表 → 默认', () => {
  assert.equal(contextWindowFor('x', { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '12345' }), 12345)
  assert.equal(contextWindowFor('deepseek-v4-flash', {}), 200_000)
  assert.equal(contextWindowFor('deepseek-v4-pro', {}), 1_000_000)
  assert.equal(contextWindowFor('unknown-model', {}), 200_000)
  assert.equal(MODEL_CONTEXT_WINDOWS['deepseek-v4-flash'], 200_000)
})

test('token 计价：chars/4 基准 + 块/role 加成', () => {
  assert.equal(estimateTokens({ type: 'text', text: 'abcd' }), 1 + 4) // 4 chars / 4 = 1 + 块 +4
  assert.equal(estimateTokens({ type: 'text', text: 'a'.repeat(800) }), 200 + 4)
  assert.equal(estimateMessage({ role: 'user', content: 'a'.repeat(400) }), 4 + 100 + 4)
  assert.equal(estimateMessage({ role: 'assistant', content: [] }), 4)
})

test('代码密度：tool_result 与代码特征文本按 chars/3', () => {
  assert.equal(estimateTokens({ type: 'tool_result', content: 'a'.repeat(300) }), 100 + 4)
  assert.equal(estimateTokens({ type: 'text', text: 'const x = 1;\n' + 'a'.repeat(200) }), 4 + Math.ceil(213 / 3)) // 13 字符前缀 + 200，代码密度 /3（brief 原值 204 与真实长度不符，已修正）
  assert.equal(isCodeLike('const a = 1'), true)
  assert.equal(isCodeLike('这是一段中文文本'), false)
})

test('图片/二进制固定 4800 当量', () => {
  assert.equal(estimateTokens({ type: 'image' }), 4800 + 4)
})

test('estimateRequest 四区记账：system/task/tool_result/history', () => {
  const r = estimateRequest({
    system: 'sys',
    messages: [
      { role: 'user', content: '历史问题1' },
      { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
      { role: 'user', content: [{ type: 'tool_result', content: 'big-output'.repeat(100), tool_use_id: 't' }] },
      { role: 'user', content: '本轮任务' },
    ],
  })
  assert.ok(r.sections.system > 0)
  assert.ok(r.sections.tool_result > 0)
  assert.ok(r.sections.task > 0)
  assert.ok(r.sections.history > 0)
  assert.equal(r.total, r.sections.system + r.sections.task + r.sections.tool_result + r.sections.history)
  const ledger = createTokenLedger()
  ledger.record('system', 10)
  ledger.record('tool_result', 20)
  ledger.record('history', 70)
  assert.equal(ledger.total(), 100)
  assert.equal(ledger.toolResultShare(), 0.2)
})

test('usage 锚点：同 headKey 用基线+尾部增量，异 headKey 全量', () => {
  const anchor = makeUsageAnchor()
  const history = [{ role: 'user', content: 'a'.repeat(400) }]
  const tail = [{ role: 'user', content: 'b'.repeat(400) }]
  const first = anchor.estimate({ headKey: 'k1', history })
  assert.equal(first.anchored, false)
  anchor.record({ headKey: 'k1', inputTokens: first.input })
  const second = anchor.estimate({ headKey: 'k1', history: [...history, ...tail] })
  assert.equal(second.anchored, true)
  assert.equal(second.input, first.input + estimateHistory(tail))
  const other = anchor.estimate({ headKey: 'k2', history: [...history, ...tail] })
  assert.equal(other.anchored, false)
})
