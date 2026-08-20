import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aggregateStats, costUsd } from '../server/transcript.mjs'

test('aggregateStats：多会话/多模型 transcript 按 项目/模型/日期 聚合', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stats-'))
  try {
    const projA = join(dir, 'proj-a')
    const projB = join(dir, 'proj-b')
    mkdirSync(projA, { recursive: true })
    mkdirSync(projB, { recursive: true })
    const entry = (model, input, output, ts) =>
      JSON.stringify({ type: 'assistant', id: 'x', timestamp: ts, message: { role: 'assistant', content: [], model, usage: { input_tokens: input, output_tokens: output } } })
    writeFileSync(join(projA, '11111111-1111-1111-1111-111111111111.jsonl'), [
      entry('deepseek-v4-flash', 100, 50, '2026-08-20T01:00:00Z'),
      entry('deepseek-v4-flash', 200, 100, '2026-08-20T02:00:00Z'),
      entry('deepseek-v4-pro', 500, 250, '2026-08-21T01:00:00Z'),
      '',
    ].join('\n'))
    writeFileSync(join(projB, '22222222-2222-2222-2222-222222222222.jsonl'), [
      entry('deepseek-v4-flash', 50, 25, '2026-08-20T03:00:00Z'),
      '',
    ].join('\n'))
    const s = aggregateStats(dir)
    assert.equal(s.totals.input_tokens, 850)
    assert.equal(s.totals.output_tokens, 425)
    assert.equal(s.totals.sessions, 2)
    assert.equal(s.byModel['deepseek-v4-flash'].input_tokens, 350)
    assert.equal(s.byModel['deepseek-v4-pro'].input_tokens, 500)
    assert.equal(s.byDate['2026-08-20'].input_tokens, 350)
    assert.equal(s.byProject['proj-a'].output_tokens, 400)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('costUsd：按价格表换算', () => {
  const priceTable = { 'deepseek-v4-flash': { input_per_mtok: 0.1, output_per_mtok: 0.2 } }
  const c = costUsd({ model: 'deepseek-v4-flash', input_tokens: 1000, output_tokens: 500 }, priceTable)
  assert.ok(Math.abs(c - (1000 / 1e6 * 0.1 + 500 / 1e6 * 0.2)) < 1e-9)
})
