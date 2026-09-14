// M1：用户需求必须真的进到模型手里。001 只生成 4 条的根因之一就是需求从未进入生成链路
// （提示词里只有 目标:{"type":"web","url":…}），模型无从知道用户要什么覆盖度。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { buildAgentSystem, buildAgentSeed, normalizeRequirement, requirementLines } =
  require('../electron/app-agent.cjs')

const TARGET = { type: 'web', url: 'https://www.yfljsj.com/' }

test('normalizeRequirement：字符串/数组都收，去空、去重、截断', () => {
  assert.deepEqual(normalizeRequirement('  导出全部图层 '), ['导出全部图层'])
  assert.deepEqual(normalizeRequirement(['a', ' a ', '', null, 'b']), ['a', 'b'])
  assert.deepEqual(normalizeRequirement(undefined), [])
  assert.equal(normalizeRequirement('x'.repeat(5000))[0].length, 2000, '超长要截断，别把提示词撑爆')
})

test('requirementLines：无需求返回空串（既有行为不变）', () => {
  assert.equal(requirementLines(null), '')
  assert.equal(requirementLines([]), '')
  assert.equal(requirementLines('   '), '')
})

test('★ buildAgentSystem：需求逐条进入提示词，并声明为覆盖度硬约束', () => {
  const sys = buildAgentSystem({ target: TARGET, driver: 'browser', requirement: ['导出全部图层', '批量重命名'] })
  assert.ok(sys.includes('【用户需求】'), '要有需求段')
  assert.ok(sys.includes('导出全部图层') && sys.includes('批量重命名'), '每条需求都要出现')
  assert.ok(sys.includes('覆盖度硬约束'), '要明确它是约束，不是参考')
  assert.ok(sys.includes('spec.notes'), '做不到的要说明原因，而不是装作支持')
})

test('buildAgentSystem：无需求不加需求段（保持既有提示词稳定）', () => {
  const a = buildAgentSystem({ target: TARGET, driver: 'browser' })
  assert.ok(!a.includes('【用户需求】'))
  assert.equal(a, buildAgentSystem({ target: TARGET, driver: 'browser', requirement: [] }),
    '空需求与未传需求必须完全一致')
})

test('buildAgentSeed：需求随种子一起给出（首轮就要看见）', () => {
  // 注：素材段走既有形参 seedSummary（buildAgentSeed 的签名是 probeMaterial/seedSummary，没有 material）
  const seed = buildAgentSeed({ target: TARGET, driver: 'browser', seedSummary: '素材：首页 3 个入口', requirement: '导出 PSD' })
  assert.ok(seed.includes('导出 PSD'), `首轮种子要带需求：${seed.slice(0, 200)}`)
  assert.ok(seed.includes('素材：首页 3 个入口'), '原有素材段不受影响')
})
