// kernel-tests/atlas-graph.test.mjs —— 关系边、反向依赖与重要度
// 事实边：imports / references / tests / doc_mentions / contains；
// 测试来源不计入 reverseDeps，但会点亮 tested。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildFixture, cardByPath, edgeOf } from './atlas-test-helpers.mjs'
import { buildAtlas } from '../kernel/atlas/store.mjs'

test('代码边：import、路径引用、测试覆盖', () => {
  const atlas = buildFixture('zero-header')
  const alpha = cardByPath(atlas, 'alpha.mjs')
  const util = cardByPath(atlas, 'util.mjs')
  const testNode = cardByPath(atlas, 'alpha.test.mjs')

  assert.ok(edgeOf(atlas, 'imports', 'alpha.mjs', 'util.mjs'))
  assert.ok(edgeOf(atlas, 'imports', 'uses-alpha.mjs', 'alpha.mjs'))
  // 路径字面量（非 import）也连边
  assert.ok(edgeOf(atlas, 'references', 'uses-alpha.mjs', 'util.mjs'))
  // 测试 import 既产生 imports 边，也产生 tests 边
  assert.ok(edgeOf(atlas, 'imports', 'alpha.test.mjs', 'alpha.mjs'))
  assert.ok(edgeOf(atlas, 'tests', 'alpha.test.mjs', 'alpha.mjs'))

  assert.equal(alpha.reverseDeps, 1) // 只数非测试代码
  assert.equal(alpha.tested, true)
  assert.equal(alpha.flags.includes('tested'), true)
  assert.deepEqual(testNode.subjects, ['alpha.mjs'])
  assert.equal(util.reverseDeps, 2) // alpha import + uses-alpha 路径引用
  assert.equal(util.tested, false)
})

test('重要度公式：反向依赖 + 测试 + 入口 + 大文件', () => {
  const atlas = buildFixture('zero-header')
  const alpha = cardByPath(atlas, 'alpha.mjs')
  const util = cardByPath(atlas, 'util.mjs')
  // 1 + round(log2(1+1)*2)=2 + tested 1 = 4
  assert.equal(alpha.importance, 4)
  // util: 1 + round(log2(1+2)*2)=3 = 4
  assert.equal(util.importance, 4)
})

test('域/层聚合节点与 contains 边', () => {
  const atlas = buildFixture('zero-header')
  const domain = atlas.nodes.find((n) => n.id === 'domain:root')
  const layer = atlas.nodes.find((n) => n.id === 'layer:root')
  assert.ok(domain)
  assert.ok(layer)
  assert.equal(domain.kind, 'domain')
  assert.equal(domain.files, 6)
  // 方向必须是从域/层指向文件
  assert.equal(atlas.edges.filter((e) => e.type === 'contains' && e.from === 'code:alpha.mjs').length, 0)
  const contains = atlas.edges.filter((e) => e.type === 'contains' && e.from === 'domain:root' && e.to === 'code:alpha.mjs')
  assert.equal(contains.length, 1)
})

test('文档路径提及：doc_mentions 边指向真实文件', () => {
  const atlas = buildFixture('business-docs')
  assert.ok(edgeOf(atlas, 'doc_mentions', '报告.md', 'demo/alpha.mjs'))
  const target = cardByPath(atlas, 'demo/alpha.mjs')
  assert.equal(target.kind, 'code')
  assert.equal(target.reverseDeps, 0) // doc_mentions 不算代码反向依赖
})

test('自环边丢弃：文件 import 自己不会产生 from=to 的边', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-atlas-self-'))
  fs.writeFileSync(path.join(root, 'self.mjs'),
    "import './self.mjs'\nexport const selfValue = 1\n")
  const atlas = buildAtlas({ root, dir: path.join(root, '.cache'), write: false })
  assert.equal(atlas.edges.some((e) => e.from === e.to), false)
  assert.equal(cardByPath(atlas, 'self.mjs').exports.includes('selfValue'), true)
})

test('覆盖率统计：有据职责与 low/none 分开计数', () => {
  const atlas = buildFixture('zero-header')
  assert.equal(atlas.summary.code, 5) // alpha/util/uses-alpha/legacy/empty
  assert.equal(atlas.summary.test, 1)
  assert.equal(atlas.summary.purpose.total, 6)
  assert.equal(atlas.summary.purpose.identified, 5)
  assert.equal(atlas.summary.purpose.fallback, 1)
  // 结构兜底不是语义职责：zero-header 的 5 个有据文件全部来自 structure。
  assert.equal(atlas.summary.purpose.semantic, 0)
  assert.equal(atlas.summary.purpose.structural, 5)
  assert.equal(atlas.summary.purpose.code.semantic, 0)
  assert.equal(atlas.summary.purpose.code.structural, 4)
  assert.equal(atlas.summary.purpose.code.none, 1)
  assert.equal(atlas.summary.purpose.bySrc.structure, 5)
  assert.equal(atlas.summary.confidence.none, 1)
  assert.equal(atlas.summary.edgesByType.tests, 1)
  assert.equal(atlas.summary.design, 'none')
})
