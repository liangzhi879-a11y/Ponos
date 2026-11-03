// kernel-tests/atlas-fallback.test.mjs —— 通用回退：零头注释代码 + 业务文档
// 验收重点：没有头注释时**不许编造职责**；只能降级到结构句/元数据/文件名，
// 并如实给出 confidence。业务文档（md/html/txt/csv/pdf/docx/图片）各有对应卡片。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFixture, cardByPath } from './atlas-test-helpers.mjs'

test('零头注释代码：结构句 + 低置信回退，空文件无职责', () => {
  const atlas = buildFixture('zero-header')
  const alpha = cardByPath(atlas, 'alpha.mjs')
  const util = cardByPath(atlas, 'util.mjs')
  const legacy = cardByPath(atlas, 'legacy.py')
  const empty = cardByPath(atlas, 'empty.mjs')

  assert.equal(alpha.purposeSrc, 'structure')
  assert.equal(alpha.confidence, 'medium')
  assert.match(alpha.purpose, /导出/)
  assert.deepEqual(new Set(alpha.exports), new Set(['alpha', 'beta', 'gamma']))

  assert.equal(util.purposeSrc, 'structure')
  assert.deepEqual(new Set(util.exports), new Set(['util', 'VERSION']))

  assert.equal(legacy.purposeSrc, 'structure')
  assert.equal(legacy.confidence, 'medium')
  assert.deepEqual(new Set(legacy.exports), new Set(['legacy_entry', 'LegacyRunner']))

  assert.equal(empty.purpose, null)
  assert.equal(empty.purposeSrc, 'none')
  assert.equal(empty.confidence, 'none')

  assert.equal(atlas.summary.header.covered, 0)
  assert.equal(atlas.summary.purpose.total, 6)
  assert.equal(atlas.summary.purpose.identified, 5)
  assert.equal(atlas.summary.purpose.fallback, 1)
})

test('业务文档：标题/首段、txt、csv、html 都按 T4 抽取', () => {
  const atlas = buildFixture('business-docs')
  const report = cardByPath(atlas, '报告.md')
  const txt = cardByPath(atlas, 'legacy.txt')
  const csv = cardByPath(atlas, '表格.csv')
  const html = cardByPath(atlas, '页面.html')

  assert.equal(report.kind, 'doc')
  assert.equal(report.title, '季度业务复盘')
  assert.equal(report.confidence, 'medium')
  assert.match(report.purpose, /^季度业务复盘 — 本季度重点/)
  assert.ok(report.headings.some((h) => h.text === '结论'))
  assert.ok(report.references.some((r) => r.spec === 'demo/alpha.mjs'))

  assert.equal(txt.confidence, 'low')
  assert.match(txt.purpose, /^客户访谈纪要 — 受访者/)
  assert.equal(txt.textTruncated, false)

  assert.equal(csv.confidence, 'low')
  assert.match(csv.purpose, /^CSV 列：区域 \/ 收入 \/ 同比增长/)

  assert.equal(html.title, '业务看板')
  assert.match(html.purpose, /^业务看板 — 本页展示/)
  assert.equal(html.headings.length, 2)
})

test('业务文档：office/pdf/图片只建元数据卡，不臆造正文', () => {
  const atlas = buildFixture('business-docs')
  const pdf = cardByPath(atlas, '扫描件.pdf')
  const docx = cardByPath(atlas, '合同.docx')
  const png = cardByPath(atlas, 'docs/照片.png')
  const empty = cardByPath(atlas, '空文档.md')

  for (const card of [pdf, docx]) {
    assert.equal(card.kind, 'doc')
    assert.equal(card.noText, true)
    assert.equal(card.content, false)
    assert.equal(card.confidence, 'low')
    assert.match(card.purpose, /^未导入正文：/)
  }
  assert.equal(png.noText, true)
  assert.equal(png.content, false)
  assert.match(png.purpose, /^图片：/)
  assert.equal(empty.confidence, 'low')
  assert.match(empty.purpose, /^未识别职责：/)

  assert.equal(atlas.summary.design, 'none')
  assert.ok(atlas.summary.docText.covered >= 4)
})

test('T2 元数据：package.json / README 的逐字描述优先于结构句', () => {
  const atlas = buildFixture('with-readme')
  const lib = cardByPath(atlas, 'lib.mjs')
  const tool = cardByPath(atlas, 'tool.mjs')
  const other = cardByPath(atlas, 'other.mjs')
  const pkg = cardByPath(atlas, 'package.json')

  assert.equal(lib.purposeSrc, 'metadata')
  assert.equal(lib.confidence, 'high')
  assert.ok(lib.flags.includes('entry'))
  assert.match(lib.purpose, /示例包/)

  assert.equal(tool.purposeSrc, 'metadata')
  assert.ok(tool.flags.includes('entry'))

  assert.equal(other.purposeSrc, 'metadata')
  assert.equal(other.confidence, 'medium')
  assert.match(other.purpose, /辅助工具/)

  assert.equal(pkg.kind, 'file')
  assert.equal(pkg.purposeSrc, 'metadata')
  assert.equal(pkg.confidence, 'high')
  assert.match(pkg.purpose, /readme-fixture/)
})
