// benchmark/lib/compare.test.mjs —— B5 对比逻辑单测（node --test）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareResults } from './compare.mjs'

test('compareResults：退化/改善/变慢/新增/缺失 判定', () => {
  const baseline = [
    { agent: 'ponos', task: 'T001', status: 'pass', durationMs: 100000, toolCalls: 30 },
    { agent: 'ponos', task: 'T002', status: 'pass', durationMs: 200000, toolCalls: 40 },
    { agent: 'ponos', task: 'T003', status: 'fail', durationMs: 50000, toolCalls: 20 },
    { agent: 'ponos', task: 'T004', status: 'pass', durationMs: 60000, toolCalls: 10 },
  ]
  const current = [
    { agent: 'ponos', task: 'T001', status: 'fail', durationMs: 90000, toolCalls: 20 },   // pass→fail = regressed
    { agent: 'ponos', task: 'T002', status: 'pass', durationMs: 330000, toolCalls: 45 },  // 耗时 >1.5× = slower
    { agent: 'ponos', task: 'T003', status: 'pass', durationMs: 40000, toolCalls: 15 },   // fail→pass = improved
    { agent: 'ponos', task: 'T005', status: 'pass', durationMs: 60000, toolCalls: 10 },   // 新增
  ]
  const r = compareResults({ current, baseline })
  assert.equal(r.regressed.length, 1)
  assert.equal(r.regressed[0].task, 'T001')
  assert.equal(r.improved.length, 1)
  assert.equal(r.improved[0].task, 'T003')
  assert.equal(r.slower.length, 1)
  assert.equal(r.slower[0].task, 'T002')
  assert.deepEqual(r.summary, { total: 5, regressed: 1, improved: 1, slower: 1, same: 0, new: 1, missing: 1 })
  // missing：T004 在 current 缺失
  assert.equal(r.summary.missing, 1)
})

test('compareResults：timeout/salvage 状态参与退化判定（非 pass 非 pass 不误判退化）', () => {
  const baseline = [{ agent: 'ponos', task: 'T006', status: 'timeout', durationMs: 900000, toolCalls: 0 }]
  const current = [{ agent: 'ponos', task: 'T006', status: 'fail', durationMs: 800000, toolCalls: 5 }]
  const r = compareResults({ current, baseline })
  // timeout→fail：两者都非 pass → 不判 regressed；无 pass 状态转换
  assert.equal(r.regressed.length, 0)
  assert.equal(r.summary.same, 1)
})

test('compareResults：空输入容错', () => {
  assert.equal(compareResults({ current: [], baseline: [] }).summary.total, 0)
  assert.equal(compareResults({}).summary.total, 0)
})
