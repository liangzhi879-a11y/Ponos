// kernel-tests/bench-knowledge-index.test.mjs —— 索引性能仪表的形状与隔离性守卫（T1）
// ---------------------------------------------------------------------------
// **为什么需要这条测试**：仪表本身若会"静默测错东西"，基线就毫无意义 —— 例如它偷偷落在
// 真实配置根上（把用户库当成 fixture 建/改），或字段改名（消费方按旧键取值得到 undefined，
// 基线对账变成静默空值）。两条断言分别钉住这两件事。
//
// ⚠️ 不碰真实 `~/.ponos`：`runBench()` 缺省用 `mkdtempSync` 造隔离 fixture，本测试断言其
// `fixtureRoot` 不含 `.yfw`（test 隔离纪律，见实施计划 Global Constraints）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runBench } from '../scripts/bench-knowledge-index.mjs'

test('bench: 隔离 fixture 上产出形状完整的结果，且不触碰真实库', async () => {
  const r = await runBench({ iterations: 2 })
  // 形状（消费方按这些键取值；改名即破坏基线对账）
  assert.equal(typeof r.corpus.docs, 'number')
  assert.equal(typeof r.corpus.blocks, 'number')
  assert.equal(typeof r.corpus.grams, 'number')
  assert.match(r.corpus.digest, /^[0-9a-f]{12}$/)
  assert.equal(typeof r.timings.coldLoadMs, 'number')
  assert.equal(typeof r.timings.searchMs, 'number')
  assert.ok(r.timings.coldLoadMs > 0)
  // 隔离：fixture 路径必须在系统临时目录下（绝不等于真实配置根）
  assert.ok(!String(r.fixtureRoot).includes('.ponos'), 'fixture 不得落在真实配置根')
  assert.match(r.backend, /^(jsonl|sqlite)$/)
})

test('bench: 两次运行同语料 → digest 相同（跨语料不可比的判据）', async () => {
  const a = await runBench({ iterations: 1 })
  const b = await runBench({ iterations: 1 })
  assert.equal(a.corpus.digest, b.corpus.digest)
})
