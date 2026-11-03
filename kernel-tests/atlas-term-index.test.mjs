// kernel-tests/atlas-term-index.test.mjs —— Step 2a：构建期词项索引（分片/增量段/合并）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  clearTermCache, compactSegments, createSegmentWriter, findCandidates,
  indexTokens, pathHash, pruneSegments, queryTokens,
} from '../kernel/atlas/term-index.mjs'
import { buildAtlas, clearAtlasLoadCache, loadAtlas } from '../kernel/atlas/store.mjs'
import { loadAtlasConfig } from '../kernel/atlas/config.mjs'
import { renderSearch, searchContent } from '../kernel/atlas/search.mjs'
import { tempDir } from './atlas-test-helpers.mjs'

function write(root, rel, text) {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

function hashesOf(list) {
  const out = list.map((h) => h).sort((a, b) => a - b)
  return out
}

test('indexTokens：全串 + 驼峰/下划线段 + CJK bigram，停用词不膨胀 postings', () => {
  const tokens = new Set(indexTokens('DownloadItemImpl download_item 质量验收 return string'))
  for (const t of ['downloaditemimpl', 'download', 'item', 'impl', 'download_item', '质量', '量验', '验收']) {
    assert.ok(tokens.has(t), `缺少词项 ${t}：${[...tokens].join(',')}`)
  }
  assert.ok(!tokens.has('return'), '语言关键字不进索引')
  assert.ok(!tokens.has('string'), '高频类型名不进索引')
})

test('词项对齐：复合标识符内部拼接 + 屈折词干，覆盖“子串但非完整词”的真实查询', () => {
  // MockDownloadItemImpl 必须能被 DownloadItemImpl / DownloadItem / ItemImpl 命中
  const indexed = new Set(indexTokens('MockDownloadItemImpl download_item_impl'))
  for (const t of ['downloaditemimpl', 'downloaditem', 'itemimpl', 'download_item', 'item_impl']) {
    assert.ok(indexed.has(t), `索引缺少内部拼接 ${t}`)
  }
  // cancelled/cancellation 以词干 cancel 进索引；查询 cancel 直接命中
  assert.ok(indexTokens('CANCELLED').includes('cancel'))
  assert.ok(indexTokens('cancellation').includes('cancel'))
  assert.ok(indexTokens('downloads').includes('download'))
  assert.ok(indexTokens('created').includes('create'))
  // 查询端只取全串+段，不要求文件索引任意中段拼接
  const q = new Set(queryTokens('DownloadItemImpl'))
  assert.ok(q.has('downloaditemimpl') && q.has('download') && q.has('item') && q.has('impl'))
  assert.ok(!q.has('downloaditem'), '查询端不做内部拼接，避免反向漏检')
  assert.ok(new Set(queryTokens('CANCEL')).has('cancel'))
})

test('段写入/查询：单词项、多词项交集、无命中', (t) => {
  const dir = tempDir('atlas-terms-')
  t.after(() => { clearTermCache(); fs.rmSync(dir, { recursive: true, force: true }) })
  const w = createSegmentWriter({ cacheDir: dir, buildId: 'seg1' })
  w.addText('src/a.mjs', 'alpha beta')
  w.addText('src/b.mjs', 'beta gamma')
  const seg = w.finish()
  assert.equal(seg.files, 2)
  assert.ok(seg.postings > 0)
  assert.ok(seg.bytes > 0)

  assert.deepEqual(hashesOf(findCandidates({ cacheDir: dir, segments: [seg], tokens: ['alpha', 'beta'] })), [pathHash('src/a.mjs')])
  assert.deepEqual(
    hashesOf(findCandidates({ cacheDir: dir, segments: [seg], tokens: ['beta'] })),
    hashesOf([pathHash('src/a.mjs'), pathHash('src/b.mjs')]),
  )
  assert.deepEqual(findCandidates({ cacheDir: dir, segments: [seg], tokens: ['nope'] }), [])
  assert.equal(findCandidates({ cacheDir: dir, segments: [], tokens: ['alpha'] }), null, '无段必须回 null 让调用方回退')
})

test('增量段：文件词项整组落在同一段，交集不会跨段误杀', (t) => {
  const dir = tempDir('atlas-terms-inc-')
  t.after(() => { clearTermCache(); fs.rmSync(dir, { recursive: true, force: true }) })
  const w1 = createSegmentWriter({ cacheDir: dir, buildId: 'seg1' })
  w1.addText('src/a.mjs', 'alpha beta')
  w1.addText('src/b.mjs', 'beta gamma')
  const seg1 = w1.finish()

  const w2 = createSegmentWriter({ cacheDir: dir, buildId: 'seg2' })
  w2.addText('src/c.mjs', 'delta beta')
  const seg2 = w2.finish()

  assert.deepEqual(
    hashesOf(findCandidates({ cacheDir: dir, segments: [seg1, seg2], tokens: ['alpha', 'beta'] })),
    [pathHash('src/a.mjs')],
    'a 的整组词项都在 seg1；seg2 没有 alpha，不能因此把 a 的命中抹掉',
  )
  assert.equal(findCandidates({ cacheDir: dir, segments: [seg1, seg2], tokens: ['beta'] }).length, 3)
})

test('段合并：并集后查询结果与合并前一致，旧段可清理', (t) => {
  const dir = tempDir('atlas-terms-merge-')
  t.after(() => { clearTermCache(); fs.rmSync(dir, { recursive: true, force: true }) })
  const w1 = createSegmentWriter({ cacheDir: dir, buildId: 'seg1' })
  w1.addText('src/a.mjs', 'alpha beta')
  const seg1 = w1.finish()
  const w2 = createSegmentWriter({ cacheDir: dir, buildId: 'seg2' })
  w2.addText('src/b.mjs', 'beta gamma')
  const seg2 = w2.finish()

  const before = findCandidates({ cacheDir: dir, segments: [seg1, seg2], tokens: ['beta'] })
  const merged = compactSegments({ cacheDir: dir, segments: [seg1, seg2], buildId: 'merged' })
  assert.ok(merged)
  clearTermCache()
  const after = findCandidates({ cacheDir: dir, segments: [merged], tokens: ['beta'] })
  assert.deepEqual(hashesOf(after), hashesOf(before))

  fs.mkdirSync(path.join(dir, 'terms', 'orphan'), { recursive: true })
  pruneSegments(dir, [merged])
  assert.ok(fs.existsSync(path.join(dir, 'terms', 'merged', 'shard-0.bin')))
  assert.ok(!fs.existsSync(path.join(dir, 'terms', 'orphan')), '未登记段应被清理')
  assert.ok(!fs.existsSync(path.join(dir, 'terms', 'seg1')), '被合并的旧段应被清理')
})

function setupRepo(t) {
  const work = tempDir('atlas-index-build-')
  const root = path.join(work, 'ws')
  fs.mkdirSync(root, { recursive: true })
  write(root, 'src/alpha.mjs', '// ALPHA_MARK 入口\nexport function runAlpha() { return 1 }\n')
  write(root, 'src/beta.mjs', "import './alpha.mjs'\n// BETA_MARK MockDownloadItemImpl CANCELLED\n")
  write(root, 'docs/guide.md', '# 指南\n\n质量验收说明。\n')
  t.after(() => { clearAtlasLoadCache(); clearTermCache(); fs.rmSync(work, { recursive: true, force: true }) })
  return { work, root, cache: path.join(work, 'cache'), config: loadAtlasConfig(root) }
}

test('构建集成：写入词项段，无作用域检索走索引且中文/符号都能命中', (t) => {
  const { root, cache } = setupRepo(t)
  const built = buildAtlas({ root, dir: cache, write: true })
  assert.equal(built.meta.incremental.full, true)
  assert.equal(built.meta.searchSegments.length, 1)
  assert.ok(built.meta.searchSegments[0].files >= 3)
  assert.ok(fs.existsSync(path.join(cache, 'terms', built.meta.searchSegments[0].id, 'shard-0.bin')))

  const atlas = loadAtlas(cache)
  assert.equal(atlas.ok, true)
  const alpha = searchContent(atlas, 'ALPHA_MARK', { config: loadAtlasConfig(root) })
  assert.equal(alpha.ok, true)
  assert.equal(alpha.via, 'index')
  assert.equal(alpha.files[0].path, 'src/alpha.mjs')
  assert.match(renderSearch(alpha), /索引候选 \d+，核对 \d+/)

  const beta = searchContent(atlas, 'BETA_MARK', { config: loadAtlasConfig(root) })
  assert.equal(beta.via, 'index')
  assert.deepEqual(beta.files.map((f) => f.path), ['src/beta.mjs'])

  // 复合标识符子串：MockDownloadItemImpl 能被 DownloadItemImpl 命中
  const wrapped = searchContent(atlas, 'DownloadItemImpl', { config: loadAtlasConfig(root) })
  assert.equal(wrapped.via, 'index')
  assert.deepEqual(wrapped.files.map((f) => f.path), ['src/beta.mjs'])
  // 屈折变化：CANCELLED 能被 cancel 命中（v1 子串语义）
  const inflected = searchContent(atlas, 'cancel', { config: loadAtlasConfig(root) })
  assert.equal(inflected.via, 'index')
  assert.deepEqual(inflected.files.map((f) => f.path), ['src/beta.mjs'])

  // 字面量带标点：索引按 token 召回，核对按原文
  const call = searchContent(atlas, 'runAlpha()', { config: loadAtlasConfig(root) })
  assert.equal(call.via, 'index')
  assert.equal(call.matches[0].path, 'src/alpha.mjs')

  // 中文 bigram
  const cn = searchContent(atlas, '质量验收', { config: loadAtlasConfig(root) })
  assert.equal(cn.via, 'index')
  assert.deepEqual(cn.files.map((f) => f.path), ['docs/guide.md'])
})

test('增量构建：新词项立即可查，删除的词项只留候选、核对后不假报', (t) => {
  const { root, cache, config } = setupRepo(t)
  buildAtlas({ root, dir: cache, write: true })
  clearAtlasLoadCache()

  const beta = path.join(root, 'src/beta.mjs')
  write(root, 'src/beta.mjs', "import './alpha.mjs'\n// BETA_MARK GAMMA_MARK\n")
  const bump = new Date(Date.now() + 2000)
  fs.utimesSync(beta, bump, bump)

  const inc = buildAtlas({ root, dir: cache, write: true, config })
  assert.equal(inc.meta.incremental.full, false, JSON.stringify(inc.meta.incremental))
  assert.equal(inc.meta.incremental.extracted, 1)
  assert.equal(inc.meta.searchSegments.length, 2)

  const atlas = loadAtlas(cache)
  const gamma = searchContent(atlas, 'GAMMA_MARK', { config })
  assert.equal(gamma.via, 'index')
  assert.deepEqual(gamma.files.map((f) => f.path), ['src/beta.mjs'])
  // 未变文件的旧段仍然有效
  assert.deepEqual(
    searchContent(atlas, 'ALPHA_MARK', { config }).files.map((f) => f.path),
    ['src/alpha.mjs'],
  )

  // 删除 GAMMA_MARK：旧段仍留 postings ⇒ 候选包含 beta，但逐行核对后必须 0 命中
  clearAtlasLoadCache()
  write(root, 'src/beta.mjs', "import './alpha.mjs'\n// BETA_MARK\n")
  fs.utimesSync(beta, new Date(Date.now() + 4000), new Date(Date.now() + 4000))
  const inc2 = buildAtlas({ root, dir: cache, write: true, config })
  assert.equal(inc2.meta.incremental.full, false)
  const atlas2 = loadAtlas(cache)
  const gone = searchContent(atlas2, 'GAMMA_MARK', { config })
  assert.equal(gone.via, 'index')
  assert.equal(gone.matches.length, 0)
  assert.equal(gone.files.length, 0)
})

test('段文件缺失：查询回退到逐文件扫描，下次构建强制重建', (t) => {
  const { root, cache, config } = setupRepo(t)
  const built = buildAtlas({ root, dir: cache, write: true })
  clearAtlasLoadCache()
  fs.rmSync(path.join(cache, 'terms', built.meta.searchSegments[0].id), { recursive: true, force: true })

  const atlas = loadAtlas(cache)
  const res = searchContent(atlas, 'ALPHA_MARK', { config })
  assert.equal(res.via, 'scan', '段不完整必须回退，不能拿残缺 postings 回答“没有”')
  assert.deepEqual(res.files.map((f) => f.path), ['src/alpha.mjs'])

  clearAtlasLoadCache()
  const rebuilt = buildAtlas({ root, dir: cache, write: true, config })
  assert.equal(rebuilt.meta.incremental.reason, 'index-missing')
  assert.equal(rebuilt.meta.searchSegments.length, 1)
})

test('索引代差：旧缓存没有 searchSegments 时强制全量重建，不静默漏检', (t) => {
  const { root, cache, config } = setupRepo(t)
  buildAtlas({ root, dir: cache, write: true })
  clearAtlasLoadCache()

  const metaFile = path.join(cache, 'meta.json')
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
  delete meta.searchSegments
  fs.writeFileSync(metaFile, JSON.stringify(meta))
  clearAtlasLoadCache()

  const rebuilt = buildAtlas({ root, dir: cache, write: true, config })
  assert.equal(rebuilt.meta.incremental.full, true)
  assert.equal(rebuilt.meta.incremental.reason, 'index-missing')
  assert.equal(rebuilt.meta.incremental.extracted, 3, '必须真的重抽全部文件，而不是复用旧卡')
  assert.equal(rebuilt.meta.searchSegments.length, 1)
  const atlas = loadAtlas(cache)
  assert.equal(searchContent(atlas, '质量验收', { config }).via, 'index')
})
