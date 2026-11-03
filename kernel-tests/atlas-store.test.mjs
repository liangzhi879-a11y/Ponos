// kernel-tests/atlas-store.test.mjs —— 落盘、增量、跨代校验与缓存位置
// 所有写操作都在 os.tmpdir() 的副本上进行，不碰仓库 fixture。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  buildAtlas, ensureAtlas, ensureAtlasMeta, loadAtlas, loadCacheLimitBytes, verifyAtlas,
  clearAtlasLoadCache, findScopedAtlas, readAtlasSnapshot,
} from '../kernel/atlas/store.mjs'
import {
  loadAtlasConfig, resolveAtlasDir, resolveAtlasScopeDir, isTestPath, fileKind,
} from '../kernel/atlas/config.mjs'
import { scanWorkspace, walkFiles } from '../kernel/atlas/scan.mjs'
import { fixtureRoot, tempDir, cardByPath } from './atlas-test-helpers.mjs'

function setup(name = 'zero-header') {
  const work = tempDir('ponos-atlas-store-')
  const root = path.join(work, 'ws')
  fs.cpSync(fixtureRoot(name), root, { recursive: true })
  return { work, root, cache: path.join(work, 'cache') }
}

test('构建落盘四件套，loadAtlas 读回同一代', () => {
  const { root, cache } = setup()
  const built = buildAtlas({ root, dir: cache, write: true })
  for (const f of ['nodes.json', 'edges.json', 'index.json', 'meta.json']) {
    assert.equal(fs.existsSync(path.join(cache, f)), true, f)
  }
  const loaded = loadAtlas(cache)
  assert.equal(loaded.ok, true)
  assert.equal(loaded.meta.buildId, built.meta.buildId)
  assert.equal(loaded.meta.counts.nodes, built.meta.counts.nodes)
  assert.equal(loaded.nodes.length, built.nodes.length)
})

test('无改动重建：全部 stat 命中，不重新抽取', () => {
  const { root, cache } = setup()
  const first = buildAtlas({ root, dir: cache, write: true })
  const second = buildAtlas({ root, dir: cache, write: true })
  assert.equal(second.meta.incremental.full, false)
  assert.equal(second.meta.incremental.reason, null)
  assert.equal(second.meta.incremental.extracted, 0)
  assert.equal(second.meta.incremental.reused, first.meta.filesScanned)
  assert.equal(second.meta.incremental.removed, 0)
})

test('删除缓存后重建：节点与边逐字一致（buildId 除外）', () => {
  const { root, cache } = setup()
  const first = buildAtlas({ root, dir: cache, write: true })
  fs.rmSync(cache, { recursive: true, force: true })
  const rebuilt = buildAtlas({ root, dir: cache, write: true })
  assert.equal(rebuilt.meta.incremental.reason, 'missing')
  assert.notEqual(rebuilt.meta.buildId, first.meta.buildId)
  assert.deepEqual(rebuilt.nodes, first.nodes)
  assert.deepEqual(rebuilt.edges, first.edges)
})

test('单文件改动：只重抽该文件，verify 先报 changed 后转绿', () => {
  const { root, cache } = setup()
  buildAtlas({ root, dir: cache, write: true })
  fs.appendFileSync(path.join(root, 'alpha.mjs'), '\nexport const delta = 4\n')

  const dirty = verifyAtlas({ root, dir: cache })
  assert.equal(dirty.ok, false)
  assert.ok(dirty.changed.includes('alpha.mjs'))

  const built = buildAtlas({ root, dir: cache, write: true })
  assert.equal(built.meta.incremental.full, false)
  assert.equal(built.meta.incremental.extracted, 1)
  assert.ok(cardByPath(built, 'alpha.mjs').exports.includes('delta'))
  assert.equal(verifyAtlas({ root, dir: cache }).ok, true)
})

test('ensureAtlas：TTL 内命中；过期后校验到变化就重建', () => {
  const { root, cache } = setup()
  const cfg = loadAtlasConfig(root)
  const t0 = Date.now() - 60_000

  const first = ensureAtlas({ root, config: cfg, dir: cache, now: t0, maxAgeMs: 0, force: true })
  assert.equal(first.built, true)

  const hit = ensureAtlas({ root, config: cfg, dir: cache, now: t0 + 10, maxAgeMs: 60_000 })
  assert.equal(hit.built, false)
  assert.equal(hit.freshness.checked, false)

  const file = path.join(root, 'alpha.mjs')
  fs.writeFileSync(file, '// 新的职责：缓存过期后应被发现\n// 第二行保持头注释\n// 第三行\nexport const alpha = 2\n')
  const stale = ensureAtlas({ root, config: cfg, dir: cache, now: t0 + 20, maxAgeMs: 0 })
  assert.equal(stale.built, true)
  assert.equal(stale.meta.incremental.extracted, 1)
  assert.match(cardByPath(stale, 'alpha.mjs').purpose, /缓存过期后应被发现/)

  const freshAgain = ensureAtlas({ root, config: cfg, dir: cache, now: t0 + 30, maxAgeMs: 0 })
  assert.equal(freshAgain.built, false)
  assert.equal(freshAgain.freshness.checked, true)
})

test('ensureAtlasMeta：构建时预计算 L1，命中只读 meta 即可注入', () => {
  const { root, cache } = setup()
  const cfg = loadAtlasConfig(root)
  const built = ensureAtlas({ root, config: cfg, dir: cache, now: Date.now(), maxAgeMs: 0, force: true })
  assert.equal(built.built, true)
  assert.match(built.meta.l1, /^# Atlas · /)
  assert.equal(built.meta.l1Bytes, Buffer.byteLength(built.meta.l1, 'utf8'))
  // 预计算文本是完整版：包含域/代码/文档等全部段落，不是按注入预算截断的残片
  assert.match(built.meta.l1, /高重要度代码/)
  assert.match(built.meta.l1, /关系：未解析相对 import/)

  clearAtlasLoadCache()
  fs.rmSync(path.join(cache, 'nodes.json'))
  const now = Date.now() + 1
  const m = ensureAtlasMeta({ root, config: cfg, dir: cache, now, maxAgeMs: 60_000 })
  assert.equal(m.ok, true, 'nodes/edges/index 不可读也不影响只读 meta 的地图')
  assert.equal(m.metaOnly, true)
  assert.equal(m.built, false)
  assert.equal(m.l1, built.meta.l1)
  assert.equal(m.nodes, undefined)
})

test('进程缓存：构建结果直接种入缓存；clearAtlasLoadCache 后重新读盘', () => {
  const { root, cache } = setup()
  const built = buildAtlas({ root, dir: cache, write: true })
  const first = loadAtlas(cache)
  assert.equal(first.ok, true)
  assert.equal(first.nodes, built.nodes, '刚写下的构建结果应直接复用，不再解析大文件')
  const second = loadAtlas(cache)
  assert.equal(second.nodes, first.nodes, '缓存命中返回同一份解析结果')
  clearAtlasLoadCache()
  const reread = loadAtlas(cache)
  assert.equal(reread.ok, true)
  assert.notEqual(reread.nodes, first.nodes, '清缓存后必须从磁盘重新解析')
  assert.deepEqual(reread.nodes, first.nodes)
})

test('PONOS_ATLAS_CACHE_MB=0 关闭进程缓存', () => {
  const { root, cache } = setup()
  const prev = process.env.PONOS_ATLAS_CACHE_MB
  process.env.PONOS_ATLAS_CACHE_MB = '0'
  try {
    buildAtlas({ root, dir: cache, write: true })
    clearAtlasLoadCache()
    const a = loadAtlas(cache)
    const b = loadAtlas(cache)
    assert.equal(a.ok, true)
    assert.notEqual(b.nodes, a.nodes, '缓存关闭时每次都应重新解析')
  } finally {
    if (prev === undefined) delete process.env.PONOS_ATLAS_CACHE_MB
    else process.env.PONOS_ATLAS_CACHE_MB = prev
    clearAtlasLoadCache()
  }
})

test('进程缓存预算：默认 128MB 总量，空/非法 env 不误关，0 关闭', () => {
  const MB = 1024 * 1024
  assert.equal(loadCacheLimitBytes({}), 128 * MB)
  assert.equal(loadCacheLimitBytes({ PONOS_ATLAS_CACHE_MB: '0' }), 0)
  assert.equal(loadCacheLimitBytes({ PONOS_ATLAS_CACHE_MB: '64' }), 64 * MB)
  assert.equal(loadCacheLimitBytes({ PONOS_ATLAS_CACHE_MB: '' }), 128 * MB)
  assert.equal(loadCacheLimitBytes({ PONOS_ATLAS_CACHE_MB: '   ' }), 128 * MB)
  assert.equal(loadCacheLimitBytes({ PONOS_ATLAS_CACHE_MB: 'abc' }), 128 * MB)
  assert.equal(loadCacheLimitBytes({ PONOS_ATLAS_CACHE_MB: '-1' }), 128 * MB)
})

test('进程缓存：总预算按 LRU 淘汰，单份超预算不缓存', () => {
  const one = setup()
  const two = setup()
  buildAtlas({ root: one.root, dir: one.cache, write: true })
  buildAtlas({ root: two.root, dir: two.cache, write: true })
  clearAtlasLoadCache()
  const files = ['meta.json', 'nodes.json', 'edges.json', 'index.json', 'includes.bin']
  const bytes = (dir) => files.reduce((n, f) => {
    try { return n + fs.statSync(path.join(dir, f)).size } catch { return n }
  }, 0)
  const MB = 1024 * 1024
  // 单份放得下、两份合计放不下 ⇒ 必须淘汰最久未用的
  const limitMB = (Math.max(bytes(one.cache), bytes(two.cache)) + 4096) / MB

  const a1 = loadAtlas(one.cache, { cacheMB: limitMB })
  assert.equal(loadAtlas(one.cache, { cacheMB: limitMB }).nodes, a1.nodes, '预算内应命中同一解析结果')
  const b1 = loadAtlas(two.cache, { cacheMB: limitMB })
  assert.equal(loadAtlas(two.cache, { cacheMB: limitMB }).nodes, b1.nodes, '最近使用的应保留')
  assert.notEqual(loadAtlas(one.cache, { cacheMB: limitMB }).nodes, a1.nodes,
    '两份合计超过总预算时应淘汰最久未用的')

  // 单份就超过总预算 ⇒ 不缓存，每次重新解析
  clearAtlasLoadCache()
  const tinyMB = (bytes(one.cache) / 2) / MB
  const first = loadAtlas(one.cache, { cacheMB: tinyMB })
  const second = loadAtlas(one.cache, { cacheMB: tinyMB })
  assert.equal(first.ok, true)
  assert.notEqual(second.nodes, first.nodes, '单份超预算时不得缓存')
})

test('删除文件：增量移除节点，不残留边', () => {
  const { root, cache } = setup()
  buildAtlas({ root, dir: cache, write: true })
  fs.rmSync(path.join(root, 'uses-alpha.mjs'))
  const built = buildAtlas({ root, dir: cache, write: true })
  assert.equal(built.meta.incremental.removed, 1)
  assert.equal(cardByPath(built, 'uses-alpha.mjs'), null)
  const ids = new Set(built.nodes.map((n) => n.id))
  assert.equal(ids.has('code:uses-alpha.mjs'), false)
})

test('配置变化触发全量重抽；atlas.config.json 的 exclude 生效', () => {
  const { root, cache } = setup()
  buildAtlas({ root, dir: cache, write: true })
  fs.writeFileSync(path.join(root, 'atlas.config.json'), JSON.stringify({ exclude: ['empty.mjs'] }))
  const built = buildAtlas({ root, dir: cache, write: true })
  assert.equal(built.meta.incremental.full, true)
  assert.equal(built.meta.incremental.reason, 'config-changed')
  assert.equal(cardByPath(built, 'empty.mjs'), null)
})

test('cacheMB 只影响查询缓存，不参与构建指纹（不触发重建）', () => {
  const { root, cache } = setup()
  buildAtlas({ root, dir: cache, write: true })
  fs.writeFileSync(path.join(root, 'atlas.config.json'), JSON.stringify({ cacheMB: 32 }))
  const built = buildAtlas({ root, dir: cache, write: true })
  assert.equal(built.meta.incremental.full, false, 'cacheMB 变化不得触发全量重抽')
  assert.equal(built.meta.incremental.reason, null)
  assert.ok(built.meta.incremental.reused > 0)
})

test('损坏/跨代缓存：拒绝加载并重建', () => {
  const { root, cache } = setup()
  buildAtlas({ root, dir: cache, write: true })
  fs.writeFileSync(path.join(cache, 'meta.json'), '{not json')
  assert.equal(loadAtlas(cache).ok, false)
  assert.equal(loadAtlas(cache).reason, 'corrupt-meta')
  const rebuilt = buildAtlas({ root, dir: cache, write: true })
  assert.equal(rebuilt.meta.incremental.reason, 'corrupt-meta')
  assert.equal(loadAtlas(cache).ok, true)

  const nodesPath = path.join(cache, 'nodes.json')
  const doc = JSON.parse(fs.readFileSync(nodesPath, 'utf8'))
  doc.buildId = 'other-generation'
  fs.writeFileSync(nodesPath, JSON.stringify(doc))
  assert.equal(loadAtlas(cache).reason, 'generation-mismatch')
})

test('write=false 不产生缓存文件', () => {
  const { root, work } = setup()
  const dry = path.join(work, 'dry')
  buildAtlas({ root, dir: dry, write: false, force: true })
  assert.equal(fs.existsSync(path.join(dry, 'meta.json')), false)
})

test('缓存位置：显式覆盖 → configDir → 仓内（.ponos 已忽略）', () => {
  const { root, work } = setup()
  const configDir = path.join(work, 'cfg')

  const override = resolveAtlasDir(root, { env: { PONOS_ATLAS_DIR: 'cache-x' }, configDir })
  assert.equal(override.mode, 'override')
  assert.equal(override.dir, path.resolve(root, 'cache-x'))

  const fallback = resolveAtlasDir(root, { env: {}, configDir })
  assert.equal(fallback.mode, 'configDir')
  assert.ok(fallback.dir.startsWith(path.join(configDir, 'atlas') + path.sep))

  const gitRoot = path.join(work, 'gitroot')
  fs.mkdirSync(gitRoot, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: gitRoot, stdio: 'ignore' })
  fs.writeFileSync(path.join(gitRoot, '.gitignore'), '.ponos/\n')
  const repo = resolveAtlasDir(gitRoot, { env: {}, configDir })
  assert.equal(repo.mode, 'repo')
  assert.equal(repo.dir, path.join(gitRoot, '.ponos', 'atlas'))
})

test('loadAtlasConfig：PONOS_ATLAS_CONFIG 优先；相对/缺失路径留 warning 不阻断', () => {
  const { root, work } = setup()
  fs.writeFileSync(path.join(root, 'atlas.config.json'), JSON.stringify({ maxFiles: 3 }))
  const external = path.join(work, 'atlas-external.json')
  fs.writeFileSync(external, JSON.stringify({ maxFiles: 7, exclude: ['vendor/'], includeTests: true, cacheMB: 64 }))

  const cfg = loadAtlasConfig(root, { env: { PONOS_ATLAS_CONFIG: external } })
  assert.equal(cfg.maxFiles, 7)
  assert.deepEqual(cfg.exclude, ['vendor/'])
  assert.equal(cfg.includeTests, true)
  assert.equal(cfg.cacheMB, 64, '配置文件可设置进程缓存总预算')
  // 环境变量优先于配置文件；空字符串按未设置处理，不能意外关闭缓存
  assert.equal(loadAtlasConfig(root, {
    env: { PONOS_ATLAS_CONFIG: external, PONOS_ATLAS_CACHE_MB: '32' },
  }).cacheMB, 32)
  assert.equal(loadAtlasConfig(root, {
    env: { PONOS_ATLAS_CONFIG: external, PONOS_ATLAS_CACHE_MB: '' },
  }).cacheMB, 64)

  // 没有 env 时仍读仓内配置
  assert.equal(loadAtlasConfig(root, { env: {} }).maxFiles, 3)
  assert.equal(loadAtlasConfig(root, { env: {} }).cacheMB, 128, '缺省 128MB')

  // 相对路径不猜基准：忽略并回落到仓内配置
  const rel = loadAtlasConfig(root, { env: { PONOS_ATLAS_CONFIG: 'rel.json' } })
  assert.equal(rel.maxFiles, 3)
  assert.match(rel.warnings.join('\n'), /绝对路径/)

  // 显式指向不存在的绝对路径：报 warning、用默认值，不静默改读仓内配置
  const missing = loadAtlasConfig(root, { env: { PONOS_ATLAS_CONFIG: path.join(work, 'nope.json') } })
  assert.equal(missing.maxFiles, 50000)
  assert.match(missing.warnings.join('\n'), /不存在/)
})

test('isTestPath：C/C++/Go/Ruby 常见测试后缀与目录；attestation/contest 不误判', () => {
  for (const rel of [
    'chrome/browser/download/download_browsertest.cc',
    'components/x/foo_unittest.cc',
    'components/x/foo_perftest.cc',
    'components/x/foo_test.cc',
    'pkg/foo_test.go',
    'spec/models/user_spec.rb',
    'src/FooTest.java',
    'src/FooTests.cs',
    'test/helpers.mjs',
    'src/widget.test.tsx',
  ]) assert.equal(isTestPath(rel), true, rel)
  for (const rel of [
    'components/x/attestation.cc',
    'src/contest.ts',
    'docs/testing.md',
    'src/widget.cc',
  ]) assert.equal(isTestPath(rel), false, rel)

  const cfg = { testPatterns: ['^fixtures/.*\\.case$'] }
  assert.equal(isTestPath('fixtures/a.case', cfg), true)
  assert.equal(isTestPath('src/a.case', cfg), false)
  assert.equal(fileKind('pkg/foo_test.go', cfg), 'test')
})

test('构建：C++ 测试后缀进入 test 节点，普通 .cc 仍是 code', () => {
  const { root, cache } = setup()
  fs.writeFileSync(path.join(root, 'widget.cc'), 'class Widget {};\n')
  fs.writeFileSync(path.join(root, 'widget_browsertest.cc'), '// 测试\n#include "widget.cc"\n')
  const atlas = buildAtlas({ root, dir: cache, write: false })
  assert.equal(cardByPath(atlas, 'widget.cc').kind, 'code')
  assert.equal(cardByPath(atlas, 'widget_browsertest.cc').kind, 'test')
})

test('范围构建：只索引子树，缓存独立，findScopedAtlas 按路径命中', () => {
  const { root, work } = setup()
  const configDir = path.join(work, 'cfg')
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(root, 'docs', 'guide.md'), '# 指南\n\n说明。\n')
  const scoped = resolveAtlasScopeDir(root, 'docs', { env: {}, configDir })
  assert.ok(scoped)
  const built = buildAtlas({
    root, dir: scoped.dir, dirMode: scoped.mode, scope: 'docs', write: true,
  })
  assert.equal(built.ok, true)
  assert.equal(built.meta.scope, 'docs')
  assert.ok(
    built.nodes.every((n) => n.kind === 'domain' || n.kind === 'layer' || !n.path || n.path.startsWith('docs/')),
    '范围外文件节点不得入索引',
  )
  assert.equal(fs.existsSync(path.join(configDir, 'atlas')), true)

  const hit = findScopedAtlas({ root, pathHint: 'docs/guide.md', env: {}, configDir })
  assert.ok(hit, '按子路径应命中范围缓存')
  assert.equal(hit.dir, scoped.dir)
  const outside = findScopedAtlas({ root, pathHint: 'alpha.mjs', env: {}, configDir })
  assert.equal(outside, null, '范围外路径不得误命中')
})

test('范围遍历：非 git 目录在 walk 时剪枝，不枚举范围外兄弟', () => {
  const { root } = setup()
  fs.mkdirSync(path.join(root, 'docs', 'deep'), { recursive: true })
  fs.writeFileSync(path.join(root, 'docs', 'deep', 'a.md'), '# a\n\n说明。\n')
  fs.mkdirSync(path.join(root, 'outside', 'nested'), { recursive: true })
  for (let i = 0; i < 40; i++) {
    fs.writeFileSync(path.join(root, 'outside', `f${i}.mjs`), `export const x${i} = 1\n`)
  }
  fs.writeFileSync(path.join(root, 'outside', 'nested', 'x.mjs'), 'export const y = 1\n')
  fs.writeFileSync(path.join(root, 'gamma'), 'not a directory\n')

  const full = walkFiles(root)
  const scoped = walkFiles(root, 'docs')
  assert.ok(scoped.rels.length > 0)
  assert.ok(scoped.rels.every((rel) => rel.startsWith('docs/')), '范围外文件不得进入 rels')
  assert.ok(scoped.rels.includes('docs/deep/a.md'))
  // 剪枝的判据不是“结果对”，而是“没枚举”：范围外 41 个条目不应被访问。
  assert.ok(
    full.visited - scoped.visited >= 41,
    `walk 应跳过范围外子树：full=${full.visited} scoped=${scoped.visited}`,
  )

  const single = walkFiles(root, 'docs/deep/a.md')
  assert.deepEqual(single.rels, ['docs/deep/a.md'], 'scope 指向文件时只产出该文件')

  // scope 还没走完时遇到同名文件：它不是范围根，不得混进 rels。
  const blocked = walkFiles(root, 'gamma/beta/x.md')
  assert.deepEqual(blocked.rels, [], '同名文件挡在 scope 中间时必须跳过')

  const cfg = loadAtlasConfig(root, { env: {} })
  const scan = scanWorkspace({ root, config: cfg, textMode: 'lazy', scope: 'docs' })
  assert.equal(scan.walked, scoped.visited, 'scanWorkspace 应透传 walk 实际枚举数')
  assert.ok(scan.files.every((f) => f.rel.startsWith('docs/')))
})

test('范围遍历：git 工作区用 pathspec 只列出子树', () => {
  const { work } = setup()
  const repo = path.join(work, 'git-scope')
  fs.mkdirSync(path.join(repo, 'docs', 'deep'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'outside'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'docs', 'a.md'), '# a\n\n说明。\n')
  fs.writeFileSync(path.join(repo, 'docs', 'deep', 'b.mjs'), 'export const b = 1\n')
  fs.writeFileSync(path.join(repo, 'outside', 'c.mjs'), 'export const c = 1\n')
  execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' })

  const cfg = loadAtlasConfig(repo, { env: {} })
  const scoped = scanWorkspace({ root: repo, config: cfg, textMode: 'lazy', scope: 'docs' })
  assert.equal(scoped.mode, 'git')
  assert.equal(scoped.walked, null, 'git 模式不走 walk')
  assert.deepEqual(
    scoped.files.map((f) => f.rel).sort(),
    ['docs/a.md', 'docs/deep/b.mjs'],
    'git pathspec 不得把范围外兄弟列进来',
  )

  const outside = scanWorkspace({ root: repo, config: cfg, textMode: 'lazy', scope: 'outside' })
  assert.deepEqual(outside.files.map((f) => f.rel), ['outside/c.mjs'])
})

test('构建闸：超过 maxBuildFiles 在抽取前拒绝；空范围不写缓存', () => {
  const { root, work } = setup()
  const configDir = path.join(work, 'cfg')
  const full = resolveAtlasDir(root, { env: {}, configDir }).dir
  const tooBig = buildAtlas({ root, dir: full, write: true, maxBuildFiles: 1 })
  assert.equal(tooBig.ok, false)
  assert.equal(tooBig.reason, 'build-too-large')
  assert.ok(tooBig.files > 1)
  assert.equal(fs.existsSync(path.join(full, 'meta.json')), false, '拒绝时不得留下半成品缓存')

  const empty = resolveAtlasScopeDir(root, 'does-not-exist', { env: {}, configDir })
  const none = buildAtlas({ root, dir: empty.dir, dirMode: empty.mode, scope: 'does-not-exist', write: true })
  assert.equal(none.ok, false)
  assert.equal(none.reason, 'scope-empty')
  assert.equal(fs.existsSync(path.join(empty.dir, 'meta.json')), false)
})

test('注入快照：无缓存不创建；有缓存只读 meta，源文件变化不重建', () => {
  const { root, work } = setup()
  const configDir = path.join(work, 'cfg')
  const dir = resolveAtlasDir(root, { env: {}, configDir }).dir
  const miss = readAtlasSnapshot({ root, dir })
  assert.equal(miss.ok, false)
  assert.equal(miss.reason, 'missing')
  assert.equal(fs.existsSync(path.join(dir, 'meta.json')), false, '读取快照不得创建缓存')

  const built = buildAtlas({ root, dir, write: true })
  const snap = readAtlasSnapshot({ root, dir })
  assert.equal(snap.ok, true)
  assert.equal(snap.metaOnly, true)
  assert.equal(snap.built, false)
  assert.equal(snap.meta.buildId, built.meta.buildId)

  fs.appendFileSync(path.join(root, 'alpha.mjs'), '\n// changed\n')
  const again = readAtlasSnapshot({ root, dir })
  assert.equal(again.ok, true)
  assert.equal(again.meta.buildId, snap.meta.buildId, '快照路径不得校验/重建')
})
