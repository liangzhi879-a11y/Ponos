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

// —— 回归：bridge /transcript/stats 路由的 totals.cost_usd 恒为 0 缺陷（审查 R1）——
// byModel 桶不含 model 字段，totals 汇总必须显式带 model 键否则查价失败归 0。
// 直接起真实 bridge 路由断言：配置 priceTable 后 totals.cost_usd > 0 且 = Σ byModel。
test('bridge /transcript/stats：totals.cost_usd > 0 且等于 byModel 各桶 cost_usd 之和', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stats-bridge-'))
  const cfgDir = join(root, 'cfg')
  const baseDir = join(root, 'base')
  mkdirSync(cfgDir, { recursive: true })
  mkdirSync(join(baseDir, 'projects', 'proj-a'), { recursive: true })
  // 关键：YFW_HOME / CLAUDE_CONFIG_DIR / YFW_BRIDGE_NO_LISTEN 在 bridge.mjs 模块顶层求值，
  // 必须在 import 之前设置，否则读取真实 ~/.yfworking 且顶层 listen 占用真实端口。
  process.env.YFW_HOME = cfgDir
  process.env.CLAUDE_CONFIG_DIR = baseDir
  process.env.YFW_BRIDGE_NO_LISTEN = '1'
  writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({
    activeProvider: 'test-provider',
    providers: [{
      id: 'test-provider', protocol: 'anthropic',
      pricing: {
        'deepseek-v4-flash': { input_per_mtok: 0.1, output_per_mtok: 0.2 },
        'deepseek-v4-pro': { input_per_mtok: 0.5, output_per_mtok: 1 },
      },
    }],
  }))
  const entry = (model, input, output, ts) =>
    JSON.stringify({ type: 'assistant', id: 'x', timestamp: ts, message: { role: 'assistant', content: [], model, usage: { input_tokens: input, output_tokens: output } } })
  writeFileSync(join(baseDir, 'projects', 'proj-a', '11111111-1111-1111-1111-111111111111.jsonl'), [
    entry('deepseek-v4-flash', 1_000_000, 500_000, '2026-08-20T01:00:00Z'),
    entry('deepseek-v4-pro', 1_000_000, 1_000_000, '2026-08-21T01:00:00Z'),
    '',
  ].join('\n'))
  try {
    const b = await import('../server/bridge.mjs')
    await new Promise((resolve) => b.httpServer.listen(0, resolve))
    try {
      const res = await fetch(`http://127.0.0.1:${b.httpServer.address().port}/transcript/stats`)
      const body = await res.json()
      assert.equal(body.ok, true)
      assert.equal(typeof body.totals.cost_usd, 'number', 'totals.cost_usd 必须为数字（非 toFixed 字符串）')
      assert.ok(body.totals.cost_usd > 0, '配置 priceTable 后 totals.cost_usd 必须非零')
      const sum = Object.values(body.byModel).reduce((s, v) => s + v.cost_usd, 0)
      assert.ok(Math.abs(body.totals.cost_usd - sum) < 1e-3,
        `totals.cost_usd(${body.totals.cost_usd}) 应与 byModel 各桶之和(${sum})一致`)
      assert.ok(body.byModel['deepseek-v4-flash'].cost_usd > 0, 'byModel 桶 cost_usd 非零')
      assert.ok(body.byModel['deepseek-v4-pro'].cost_usd > 0, 'byModel 桶 cost_usd 非零')
    } finally {
      await new Promise((resolve) => b.httpServer.close(resolve))
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
