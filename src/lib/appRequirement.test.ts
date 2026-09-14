// 需求字段的纯逻辑（与 AddAppDialog 解耦，便于 node --test 直接跑）
// 运行：node --test src/lib/appRequirement.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REQUIREMENT_MAX_CHARS, normalizeRequirement, summarizeRequirement } from './appRequirement.ts'

test('normalizeRequirement：多行文本按行拆，去空行', () => {
  assert.deepEqual(normalizeRequirement(' 导出全部图层 \n\n 批量重命名 '), ['导出全部图层', '批量重命名'])
})

test('normalizeRequirement：空输入返回空数组（前端据此判定"未填"）', () => {
  assert.deepEqual(normalizeRequirement(''), [])
  assert.deepEqual(normalizeRequirement('   \n  '), [])
  assert.deepEqual(normalizeRequirement(undefined), [])
})

test('normalizeRequirement：超长按上限截断（与主进程同一口径）', () => {
  const long = 'x'.repeat(5000)
  assert.equal(normalizeRequirement(long)[0].length, REQUIREMENT_MAX_CHARS)
  assert.equal(REQUIREMENT_MAX_CHARS, 2000)
})

test('summarizeRequirement：摘要用于列表展示', () => {
  assert.equal(summarizeRequirement(''), '未填写需求')
  assert.equal(summarizeRequirement('导出全部图层'), '导出全部图层')
  const many = summarizeRequirement('第一行\n第二行\n第三行')
  assert.ok(many.startsWith('第一行') && many.includes('等 3 项'), `多条要合并展示：${many}`)
})
