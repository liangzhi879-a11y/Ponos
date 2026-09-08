// src/lib/usageUi.test.ts
// node --test src/lib/usageUi.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fmtTokens, fmtUsd, fmtSession, projectOptions, auditView, usageTotalsView, buildUsageQuery } from './usageUi.ts'

test('fmtTokens：千分位/k/M 阈值', () => {
  assert.equal(fmtTokens(12345), '12.3k')
  assert.equal(fmtTokens(1500000), '1.5M')
  assert.equal(fmtTokens(2000000), '2M')
  assert.equal(fmtTokens(1234), '1.2k')
  assert.equal(fmtTokens(999), '999')
  assert.equal(fmtTokens(10000), '10k')
})

test('fmtUsd：四位小数', () => {
  assert.equal(fmtUsd(1.23456789), '1.2346')
  assert.equal(fmtUsd(0), '0.0000')
})

test('fmtSession：>10 位取前 8 + …', () => {
  assert.equal(fmtSession('0123456789abcdef'), '01234567…')
  assert.equal(fmtSession('short'), 'short')
})

test('projectOptions：按名称排序', () => {
  assert.deepEqual(projectOptions({ byProject: { b: { input_tokens: 1 }, a: { input_tokens: 2 } } } as any), ['a', 'b'])
  assert.deepEqual(projectOptions(null), [])
})

test('auditView：ts desc、同 ts seq desc、cap 截断', () => {
  const rows = [
    { ts: '2026-09-08T01:00:00.000Z', seq: 1, session: 's', type: 'tool_use' as const, tool: 'Read' },
    { ts: '2026-09-08T01:00:00.000Z', seq: 2, session: 's', type: 'tool_result' as const },
    { ts: '2026-09-07T01:00:00.000Z', seq: 1, session: 's', type: 'tool_use' as const, tool: 'Grep' },
  ]
  const out = auditView(rows, 10)
  assert.deepEqual(out.map(r => r.seq), [2, 1, 1])
  assert.equal(auditView(rows, 2).length, 2)
})

test('usageTotalsView：缺键兜底 0/[] + 排序', () => {
  const v = usageTotalsView(null)
  assert.equal(v.input, 0)
  assert.equal(v.costUsd, 0)
  assert.deepEqual(v.models, [])
  assert.deepEqual(v.tools, [])
  const full = usageTotalsView({
    totals: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 0, turns: 3 },
    cacheRate: 0.1234, costUsd: 1.5, budgetUsd: 1, overBudget: true,
    byModel: { m2: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, turns: 1 }, m1: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, turns: 2 } },
    byModelCostUsd: { m2: 0.9, m1: 0.6 },
    byTool: { Grep: 3, Read: 5 },
    byProject: { p1: { input_tokens: 1 } },
    byDate: {}, byProjectDummy: 0,
  } as any)
  assert.equal(full.input, 100)
  assert.equal(full.cacheRatePct, 12.3)
  assert.equal(full.overBudget, true)
  assert.deepEqual(full.models.map(m => m.name), ['m2', 'm1']) // costUsd desc
  assert.deepEqual(full.tools.map(x => x.name), ['Read', 'Grep']) // count desc
  assert.deepEqual(full.projects, ['p1'])
})

test('buildUsageQuery：非空参数 URL 编码、空参返回空串', () => {
  assert.equal(buildUsageQuery({}), '')
  assert.equal(buildUsageQuery({ project: 'a b' }), '?project=a%20b')
  assert.equal(buildUsageQuery({ project: 'p', scope: 'session' }), '?project=p&scope=session')
})
