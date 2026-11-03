// kernel-tests/atlas-query.test.mjs —— 检索/单卡/影响面/关联/路径
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildFixture, fixtureRoot, tempDir } from './atlas-test-helpers.mjs'
import { buildAtlas } from '../kernel/atlas/store.mjs'
import {
  find, card, impact, related, pathBetween,
} from '../kernel/atlas/query.mjs'

test('find：文件名优先；中文 bigram；kind/limit 过滤', () => {
  const zero = buildFixture('zero-header')
  const hit = find(zero, 'alpha', { limit: 3 })
  assert.equal(hit.results[0].path, 'alpha.mjs')
  assert.ok(hit.results.every((r) => r.score > 0))
  assert.ok(hit.results.length <= 3)

  const onlyTests = find(zero, 'alpha', { kind: 'test' })
  assert.ok(onlyTests.results.length >= 1)
  assert.ok(onlyTests.results.every((r) => r.kind === 'test'))

  const docs = buildFixture('business-docs')
  const zh = find(docs, '季度 复盘')
  assert.equal(zh.results[0].path, '报告.md')
  const csv = find(docs, '区域')
  assert.ok(csv.results.some((r) => r.path === '表格.csv'))
})

test('card：按路径/id 均可；找不到时给候选/建议', () => {
  const atlas = buildFixture('zero-header')
  const byPath = card(atlas, 'alpha.mjs')
  assert.equal(byPath.ok, true)
  assert.match(byPath.text, /^\[code\] alpha\.mjs/m)
  assert.match(byPath.text, /导出/)
  assert.match(byPath.text, /util\.mjs/)
  assert.match(byPath.text, /测试/)

  const byId = card(atlas, 'code:alpha.mjs')
  assert.equal(byId.node.id, 'code:alpha.mjs')

  const missing = card(atlas, 'nope-does-not-exist.mjs')
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, 'not-found')
})

test('impact：直接依赖/测试与传递影响分开，测试不计入代码反向依赖', () => {
  const atlas = buildFixture('zero-header')
  const res = impact(atlas, 'alpha.mjs', { depth: 2 })
  assert.equal(res.ok, true)
  assert.equal(res.directCodeDependents, 1)
  assert.deepEqual(res.direct.imports.map((n) => n.path), ['uses-alpha.mjs'])
  assert.deepEqual(res.direct.tests.map((n) => n.path), ['alpha.test.mjs'])
  assert.ok(res.transitive.some((t) => t.path === 'uses-alpha.mjs'))
  assert.equal(res.directCodeDependents, 1)
  assert.equal(res.edgeCoverage.supported, true, 'JS 的 import 边已解析')
})

test('impact/card：C++ 按 #include 建边并分组；解析失败才标记不完整', () => {
  const work = tempDir('atlas-cpp-')
  const root = path.join(work, 'ws')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'widget.h'), 'class Widget {};\n')
  fs.writeFileSync(path.join(root, 'widget.cc'), '#include "widget.h"\nclass WidgetImpl : public Widget {};\n')
  fs.writeFileSync(path.join(root, 'orphan.h'), '#include "missing_header.h"\nclass Orphan {};\n')
  const atlas = buildAtlas({ root, dir: path.join(work, 'cache'), write: false, docText: { enabled: false } })

  const res = impact(atlas, 'widget.h', { depth: 2 })
  assert.equal(res.ok, true)
  assert.equal(res.directDependents, 1, 'widget.cc 的 #include 必须产生直接依赖')
  assert.deepEqual(res.direct.imports.map((n) => n.path), ['widget.cc'])
  assert.equal(res.edgeCoverage.supported, true)
  assert.equal(res.edgeCoverage.partial, false)
  assert.equal(res.includeGroups.implementation.count, 1)
  assert.deepEqual(res.includeGroups.implementation.sample.map((n) => n.path), ['widget.cc'])
  assert.match(card(atlas, 'widget.h').text, /被依赖（1）：widget\.cc/)
  assert.doesNotMatch(card(atlas, 'widget.h').text, /#include 结构边尚未解析/)

  // 引号 include 全部解析失败：不假装“没有依赖”，给出不完整提示。
  const orphan = impact(atlas, 'orphan.h', { depth: 1 })
  assert.equal(orphan.edgeCoverage.supported, true)
  assert.equal(orphan.edgeCoverage.partial, true)
  assert.equal(orphan.edgeCoverage.reason, 'include-unresolved')
  assert.match(card(atlas, 'orphan.h').text, /均未在索引内解析/)
})

test('related：双向关联去重并给出边类型', () => {
  const atlas = buildFixture('zero-header')
  const res = related(atlas, 'alpha.mjs')
  const paths = res.results.map((r) => r.path)
  assert.ok(paths.includes('util.mjs'))
  assert.ok(paths.includes('uses-alpha.mjs'))
  assert.ok(paths.includes('alpha.test.mjs'))
  const util = res.results.find((r) => r.path === 'util.mjs')
  assert.ok(util.types.includes('imports'))
})

test('path：两节点最短路径；无连接时 found=false', () => {
  const atlas = buildFixture('zero-header')
  const res = pathBetween(atlas, 'uses-alpha.mjs', 'util.mjs')
  assert.equal(res.ok, true)
  assert.equal(res.found, true)
  assert.deepEqual(res.steps.map((s) => s.path), ['uses-alpha.mjs', 'util.mjs'])

  const none = pathBetween(atlas, 'legacy.py', 'alpha.mjs')
  assert.equal(none.found, false)
})

test('文档卡：标题/小节/被文档提及', () => {
  const atlas = buildFixture('business-docs')
  const res = card(atlas, '报告.md')
  assert.equal(res.node.kind, 'doc')
  assert.equal(res.node.title, '季度业务复盘')
  assert.match(res.text, /标题：季度业务复盘/)
  assert.match(res.text, /小节：/)
})

test('查询前惰性复核：源文件变了只标 stale，不在查询路径重建', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-atlas-refresh-'))
  fs.cpSync(fixtureRoot('zero-header'), root, { recursive: true })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-atlas-refresh-cache-'))
  const atlas = buildAtlas({ root, dir, write: true })
  const file = path.join(root, 'alpha.mjs')
  fs.writeFileSync(file, `// 刷新后的职责：负责 alpha 流程\n${fs.readFileSync(file, 'utf8')}`)
  const later = new Date(Date.now() + 2000)
  fs.utimesSync(file, later, later)

  // 查询不自动构建：返回旧卡 + 明确的刷新提示，而不是同步扫全工作区。
  const res = card(atlas, 'alpha.mjs')
  assert.equal(res.ok, true)
  assert.equal(res.stale, true)
  assert.equal(res.refreshed, false)
  assert.equal(res.refreshNeeded, true)
  assert.doesNotMatch(res.text, /刷新后的职责/)

  // 显式 build 后才看到新职责。
  const rebuilt = buildAtlas({ root, dir, write: true })
  const fresh = card(rebuilt, 'alpha.mjs')
  assert.equal(fresh.ok, true)
  assert.equal(fresh.stale, false)
  assert.equal(fresh.refreshNeeded, false)
  assert.equal(fresh.node.purposeSrc, 'header')
  assert.equal(fresh.node.confidence, 'high')
  assert.match(fresh.node.purpose, /^刷新后的职责/)
  assert.match(fresh.text, /刷新后的职责/)
})
