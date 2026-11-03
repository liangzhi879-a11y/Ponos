// kernel-tests/atlas-include.test.mjs —— Step 2b：C/C++ #include 边 / 分组 / 独立分片
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  extractIncludes, resolveInclude,
} from '../kernel/atlas/extract.mjs'
import { buildAtlas, clearAtlasLoadCache, loadAtlas } from '../kernel/atlas/store.mjs'
import { loadAtlasConfig } from '../kernel/atlas/config.mjs'
import { allEdges, clearIncludeCache, includeShardState, INCLUDE_SHARD_FILE } from '../kernel/atlas/edge-shard.mjs'
import { card, impact, related } from '../kernel/atlas/query.mjs'
import { clearTermCache } from '../kernel/atlas/term-index.mjs'
import { tempDir } from './atlas-test-helpers.mjs'

function write(root, rel, text) {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

function setup(t) {
  const work = tempDir('atlas-include-')
  const root = path.join(work, 'ws')
  fs.mkdirSync(root, { recursive: true })
  write(root, 'src/base/widget.h', 'class Widget {};\n')
  write(root, 'src/base/widget.cc', '#include "widget.h"\nclass WidgetImpl : public Widget {};\n')
  write(root, 'src/base/widget_unittest.cc', '#include "widget.h"\n// test\n')
  write(root, 'src/services/user.cc', '#include "base/widget.h"\n// uses widget\n')
  write(root, 'src/services/user_unittest.cc', '#include "base/widget.h"\n// test\n')
  write(root, 'src/mock/mock_widget.cc', '#include "base/widget.h"\n// mock\n')
  t.after(() => {
    clearAtlasLoadCache()
    clearIncludeCache()
    clearTermCache()
    fs.rmSync(work, { recursive: true, force: true })
  })
  return { work, root, cache: path.join(work, 'cache'), config: loadAtlasConfig(root) }
}

test('#include 抽取：只认引号形式；注释里的不算；非 C/C++ 为空', () => {
  const text = [
    '// #include "commented.h"',
    '/* #include "blocked.h" */',
    '#include "real.h"',
    '#include <vector>',
    '  #include "nested/other.hpp"',
  ].join('\n')
  const got = extractIncludes(text, '.cc')
  assert.deepEqual(got.map((x) => x.spec), ['real.h', 'nested/other.hpp'])
  assert.deepEqual(got.map((x) => x.line), [3, 5])
  assert.ok(got.every((x) => x.include === true))
  assert.deepEqual(extractIncludes('#include "x.js"\n', '.js'), [])
})

test('#include 解析：工作区相对 → 同目录 → 唯一后缀；歧义不连边', () => {
  const fileSet = new Set([
    'src/base/widget.h',
    'src/base/config.h',
    'src/other/config.h',
    'src/services/user.cc',
  ])
  const byBase = new Map()
  for (const p of fileSet) {
    const b = path.posix.basename(p)
    if (!byBase.has(b)) byBase.set(b, [])
    byBase.get(b).push(p)
  }
  assert.equal(resolveInclude('src/services/user.cc', 'src/base/widget.h', fileSet, byBase), 'src/base/widget.h')
  assert.equal(resolveInclude('src/services/user.cc', 'base/widget.h', fileSet, byBase), 'src/base/widget.h', '唯一后缀')
  assert.equal(resolveInclude('src/base/widget.cc', 'widget.h', fileSet, byBase), 'src/base/widget.h', '同目录')
  assert.equal(resolveInclude('src/services/user.cc', 'config.h', fileSet, byBase), null, '两个 config.h = 歧义')
  assert.equal(resolveInclude('src/services/user.cc', 'nope.h', fileSet, byBase), null)
})

test('构建：include 边写独立分片，impact 按声明/实现/mock/调用方/测试分组', (t) => {
  const { root, cache, config } = setup(t)
  const built = buildAtlas({ root, dir: cache, write: true, config })
  assert.equal(built.meta.version, 6)
  assert.ok(built.meta.includes, 'meta 必须登记 include 分片')
  assert.equal(built.meta.includes.count, 5)
  assert.ok(fs.existsSync(path.join(cache, INCLUDE_SHARD_FILE)))
  // 核心 edges.json 不再携带 include 边
  const core = JSON.parse(fs.readFileSync(path.join(cache, 'edges.json'), 'utf8'))
  assert.ok(!core.edges.some((e) => e.via === 'include'), 'include 边必须拆出 edges.json')

  clearAtlasLoadCache()
  const atlas = loadAtlas(cache)
  assert.equal(atlas.ok, true)
  assert.ok(!atlas.edges.some((e) => e.via === 'include'), '加载核心边时不背 include')
  const inc = allEdges(atlas).filter((e) => e.via === 'include')
  assert.equal(inc.length, 5, 'allEdges 才合并分片')

  const res = impact(atlas, 'src/base/widget.h', { depth: 2 })
  assert.equal(res.ok, true)
  assert.equal(res.directDependents, 5)
  assert.deepEqual(res.includeGroups.implementation.sample.map((n) => n.path), ['src/base/widget.cc'])
  assert.deepEqual(res.includeGroups.mocks.sample.map((n) => n.path), ['src/mock/mock_widget.cc'])
  assert.deepEqual(res.includeGroups.callers.sample.map((n) => n.path), ['src/services/user.cc'])
  assert.deepEqual(
    res.includeGroups.tests.sample.map((n) => n.path).sort(),
    ['src/base/widget_unittest.cc', 'src/services/user_unittest.cc'],
  )
  assert.equal(res.includeShard.ok, true)

  // 实现文件的“声明”来自真实出边，不靠文件名硬猜
  const impl = impact(atlas, 'src/base/widget.cc', { depth: 1 })
  assert.deepEqual(impl.includeGroups.declaration.sample.map((n) => n.path), ['src/base/widget.h'])

  assert.ok(related(atlas, 'src/base/widget.h').results.some((r) => r.path === 'src/services/user.cc'))
  // 卡片的“被依赖”排除 test（测试单列），5 个依赖拆成 3 + 2。
  assert.match(card(atlas, 'src/base/widget.h').text, /被依赖（3）/)
  assert.match(card(atlas, 'src/base/widget.h').text, /测试（2）/)
})

test('未解析 include 计入 unresolved，节点标 partial 而不是假装完整', (t) => {
  const { root, cache, config } = setup(t)
  write(root, 'src/base/orphan.cc', '#include "does_not_exist.h"\n')
  const built = buildAtlas({ root, dir: cache, write: true, config })
  assert.ok(built.summary.unresolved.include >= 1, JSON.stringify(built.summary.unresolved))
  const orphan = built.nodes.find((n) => n.path === 'src/base/orphan.cc')
  assert.equal(orphan.stats.importsResolved, 0)
  assert.equal(orphan.stats.importsUnresolved, 1)
  clearAtlasLoadCache()
  const atlas = loadAtlas(cache)
  const res = impact(atlas, 'src/base/orphan.cc', { depth: 1 })
  assert.equal(res.edgeCoverage.partial, true)
  assert.equal(res.edgeCoverage.reason, 'include-unresolved')
})

test('增量构建：新增 include 立即进分片，旧分片被整代替换', (t) => {
  const { root, cache, config } = setup(t)
  buildAtlas({ root, dir: cache, write: true, config })
  clearAtlasLoadCache()

  write(root, 'src/services/admin.cc', '#include "base/widget.h"\n')
  write(root, 'src/services/admin_unittest.cc', '#include "base/widget.h"\n')
  const bump = new Date(Date.now() + 2000)
  fs.utimesSync(path.join(root, 'src/services/admin.cc'), bump, bump)
  fs.utimesSync(path.join(root, 'src/services/admin_unittest.cc'), bump, bump)

  const inc = buildAtlas({ root, dir: cache, write: true, config })
  assert.equal(inc.meta.incremental.full, false, JSON.stringify(inc.meta.incremental))
  assert.equal(inc.meta.incremental.extracted, 2)
  assert.equal(inc.meta.includes.count, 7)

  clearAtlasLoadCache()
  const atlas = loadAtlas(cache)
  const res = impact(atlas, 'src/base/widget.h', { depth: 1 })
  assert.ok(res.includeGroups.callers.sample.some((n) => n.path === 'src/services/admin.cc'))
  assert.ok(res.includeGroups.tests.sample.some((n) => n.path === 'src/services/admin_unittest.cc'))
})

test('分片缺失/损坏：不静默当作没有依赖，impact/card 明说关系不完整', (t) => {
  const { root, cache, config } = setup(t)
  buildAtlas({ root, dir: cache, write: true, config })
  clearAtlasLoadCache()
  fs.rmSync(path.join(cache, INCLUDE_SHARD_FILE))

  const atlas = loadAtlas(cache)
  assert.equal(atlas.ok, true, '分片缺失不阻止核心地图加载')
  assert.deepEqual(includeShardState(atlas), { ok: false, reason: 'missing-shard' })
  const res = impact(atlas, 'src/base/widget.h', { depth: 1 })
  assert.equal(res.includeShard.ok, false)
  assert.equal(res.includeGroups.implementation.count, 0, '不能拿核心边冒充 include 关系')
  assert.match(card(atlas, 'src/base/widget.h').text, /#include 分片不可用/)

  clearIncludeCache()
  clearAtlasLoadCache()
  fs.writeFileSync(path.join(cache, INCLUDE_SHARD_FILE), 'garbage')
  const broken = loadAtlas(cache)
  assert.deepEqual(includeShardState(broken), { ok: false, reason: 'corrupt-shard' })
})
