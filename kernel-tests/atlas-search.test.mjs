// kernel-tests/atlas-search.test.mjs —— 正文检索 v1（作用域 / filesOnly / 截断 / 文档正文）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { buildAtlas } from '../kernel/atlas/store.mjs'
import { loadAtlasConfig } from '../kernel/atlas/config.mjs'
import { searchContent, renderSearch } from '../kernel/atlas/search.mjs'
import { tempDir } from './atlas-test-helpers.mjs'

function write(root, rel, text) {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

function setup(t) {
  const work = tempDir('atlas-search-')
  const root = path.join(work, 'ws')
  fs.mkdirSync(root, { recursive: true })
  write(root, 'src/alpha.mjs', '// alpha 入口\nexport function runAlpha() {\n  return "needle here"\n}\n')
  write(root, 'src/beta.mjs', '// 调用 alpha 的 needle 路径\nexport const b = 1\n')
  write(root, 'docs/guide.md', '# 使用指南\n\n这里提到 Needle 与 needle 两次。\n')
  write(root, 'tests/alpha.test.mjs', '// needle 覆盖\nimport "../src/alpha.mjs"\n')
  // 二进制文件：即使包含 needle 也不能被当正文命中（用普通扩展名确保它进索引）
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(root, 'assets/blob.dat'), Buffer.from([0x00, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00]))
  t.after(() => fs.rmSync(work, { recursive: true, force: true }))

  const atlas = buildAtlas({
    root,
    dir: path.join(work, 'cache'),
    write: false,
    docText: { enabled: false },
  })
  return { root, atlas, config: loadAtlasConfig(root) }
}

test('search：大小写不敏感、按行给 path:line、二进制跳过', (t) => {
  const { atlas, config } = setup(t)
  const res = searchContent(atlas, 'NEEDLE', { config })
  assert.equal(res.ok, true)
  const hits = res.matches.map((m) => `${m.path}:${m.line}`)
  assert.ok(hits.includes('src/alpha.mjs:3'), hits.join(','))
  assert.ok(hits.includes('src/beta.mjs:1'), hits.join(','))
  assert.ok(hits.includes('docs/guide.md:3'), hits.join(','))
  assert.ok(hits.includes('tests/alpha.test.mjs:1'), hits.join(','))
  assert.ok(!hits.some((h) => h.startsWith('assets/blob.dat')), '二进制不得命中')
  assert.ok(res.skipped.some((s) => s.reason === 'binary'), JSON.stringify(res.skipped))
  // 同一行命中两次只算一行；文档里的两次 needle 计为 1 行
  assert.equal(res.files.find((f) => f.path === 'docs/guide.md').hits, 1)
  assert.equal(res.files.find((f) => f.path === 'src/alpha.mjs').firstLine, 3)
})

test('search：path/kind 作用域直接裁节点，避免全仓扫描', (t) => {
  const { atlas, config } = setup(t)
  const docsOnly = searchContent(atlas, 'needle', { path: 'docs', config })
  assert.deepEqual(docsOnly.files.map((f) => f.path), ['docs/guide.md'])
  assert.equal(docsOnly.candidates, 1)

  const codeOnly = searchContent(atlas, 'needle', { kind: 'code', config })
  assert.ok(codeOnly.files.every((f) => f.kind === 'code'))
  assert.ok(!codeOnly.files.some((f) => f.path.startsWith('docs/')))

  const badScope = searchContent(atlas, 'needle', { path: 'nope', config })
  assert.equal(badScope.ok, true)
  assert.equal(badScope.files.length, 0)
  assert.equal(badScope.candidates, 0)
})

test('search：filesOnly 只回文件清单；limit 到顶显式标记截断', (t) => {
  const { atlas, config } = setup(t)
  const files = searchContent(atlas, 'needle', { filesOnly: true, config })
  assert.equal(files.filesOnly, true)
  assert.deepEqual(files.matches, [])
  assert.ok(files.files.length >= 4)
  assert.ok(files.files.every((f) => f.hits >= 1 && f.firstLine >= 1))

  const capped = searchContent(atlas, 'needle', { filesOnly: true, limit: 1, config })
  assert.equal(capped.files.length, 1)
  assert.equal(capped.truncated, true)
  assert.equal(capped.stopReason, 'limit')

  const empty = searchContent(atlas, '   ', { config })
  assert.equal(empty.ok, false)
  assert.equal(empty.reason, 'empty-query')
})

test('search：渲染文本含文件行号与跳过原因', (t) => {
  const { atlas, config } = setup(t)
  const text = renderSearch(searchContent(atlas, 'needle', { config }))
  assert.match(text, /Atlas 内容检索 · needle/)
  assert.match(text, /src\/alpha\.mjs:3: .*needle/)
  assert.match(text, /不可检索（已跳过）：binary 1/)

  const truncated = renderSearch(searchContent(atlas, 'needle', { limit: 1, config }))
  assert.match(truncated, /达到结果数上限/)
})

test('search：docx 正文复用 OOXML 抽取（不只搜路径）', async (t) => {
  const work = tempDir('atlas-search-docx-')
  const root = path.join(work, 'ws')
  fs.mkdirSync(root, { recursive: true })
  t.after(() => fs.rmSync(work, { recursive: true, force: true }))
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>')
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="w"><w:body>' +
    '<w:p><w:r><w:t>员工手册</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>季度复盘提到 NEEDLE_TOKEN 这个标记。</w:t></w:r></w:p>' +
    '</w:body></w:document>')
  fs.writeFileSync(path.join(root, '员工手册.docx'), await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))

  const atlas = buildAtlas({ root, dir: path.join(work, 'cache'), write: false, docText: { enabled: false } })
  const res = searchContent(atlas, 'needle_token', { config: loadAtlasConfig(root) })
  assert.equal(res.ok, true)
  assert.equal(res.files.length, 1)
  assert.equal(res.files[0].path, '员工手册.docx')
  assert.match(res.matches[0].text, /NEEDLE_TOKEN/)
})
