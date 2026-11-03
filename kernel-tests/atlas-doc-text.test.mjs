// kernel-tests/atlas-doc-text.test.mjs —— P1 文档正文适配
// OOXML 用 JSZip（devDependency）现场生成，验证读取器与真实 ZIP 写入器兼容；
// PDF 走注入接口，测试不依赖开发机是否装了 pdftotext / 自带 Python。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { buildAtlas } from '../kernel/atlas/store.mjs'
import { extractOoxmlText, preparePdfText } from '../kernel/atlas/doc-text.mjs'
import { loadAtlasConfig } from '../kernel/atlas/config.mjs'
import { cardByPath, tempDir } from './atlas-test-helpers.mjs'

async function writeOoxml(file, entries) {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(entries)) zip.file(name, content)
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
}

function injected(pdfText = new Map(), reasons = new Map()) {
  return { enabled: true, pdfText, pdfTruncated: new Map(), reasons }
}

test('OOXML：docx/xlsx/pptx 抽正文并生成有据职责', async (t) => {
  const root = tempDir('atlas-ooxml-')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  await writeOoxml(path.join(root, '员工手册.docx'), {
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    // 中文版 Word 的 styleId 是 "1"/"2"，标题语义只在 styles.xml 的 name 里。
    'word/styles.xml': '<?xml version="1.0"?><w:styles xmlns:w="w">' +
      '<w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="2"><w:name w:val="heading 2"/></w:style>' +
      '</w:styles>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="w"><w:body>' +
      '<w:p><w:pPr><w:pStyle w:val="1"/></w:pPr><w:r><w:t>员工手册</w:t></w:r></w:p>' +
      '<w:p><w:pPr><w:pStyle w:val="2"/></w:pPr><w:r><w:t>第一章 考勤与休假制度</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>本手册适用于全体员工。</w:t></w:r></w:p>' +
      '</w:body></w:document>',
  })
  await writeOoxml(path.join(root, '合同台账.xlsx'), {
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="x"><sheets>' +
      '<sheet name="合同台账" sheetId="1"/><sheet name="付款记录" sheetId="2"/>' +
      '</sheets></workbook>',
    'xl/sharedStrings.xml': '<?xml version="1.0"?><sst xmlns="x">' +
      '<si><t>合同编号</t></si><si><t>美宝药业</t></si><si><t>付款日期</t></si>' +
      '</sst>',
  })
  await writeOoxml(path.join(root, '季度汇报.pptx'), {
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    'ppt/slides/slide1.xml': '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>' +
      '<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody>' +
      '<a:p><a:r><a:t>季度汇报</a:t></a:r></a:p></p:txBody></p:sp>' +
      '<p:sp><p:txBody><a:p><a:r><a:t>本季度完成情况</a:t></a:r></a:p></p:txBody></p:sp>' +
      '</p:spTree></p:cSld></p:sld>',
    'ppt/slides/slide2.xml': '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>' +
      '<p:sp><p:txBody><a:p><a:r><a:t>本季度完成情况</a:t></a:r></a:p></p:txBody></p:sp>' +
      '</p:spTree></p:cSld></p:sld>',
  })

  const atlas = buildAtlas({
    root,
    dir: path.join(root, '.atlas'),
    write: false,
    docText: injected(),
  })

  const docx = cardByPath(atlas, '员工手册.docx')
  assert.equal(docx.content, true)
  assert.equal(docx.noText, false)
  assert.equal(docx.textSource, 'ooxml')
  assert.equal(docx.title, '员工手册')
  assert.deepEqual(docx.headings, [
    { level: 1, text: '员工手册', line: 1 },
    { level: 2, text: '第一章 考勤与休假制度', line: 2 },
  ])
  assert.match(docx.purpose, /员工手册/)
  assert.match(docx.purpose, /本手册适用于全体员工/)
  assert.equal(docx.confidence, 'medium')

  const rawDocx = extractOoxmlText(path.join(root, '员工手册.docx'), '.docx')
  assert.equal(rawDocx.ok, true)
  assert.match(rawDocx.text, /^# 员工手册/m)
  assert.match(rawDocx.text, /^## 第一章 考勤与休假制度/m)

  const xlsx = cardByPath(atlas, '合同台账.xlsx')
  assert.equal(xlsx.content, true)
  assert.equal(xlsx.textSource, 'ooxml')
  assert.match(xlsx.purpose, /合同台账/)
  assert.equal(xlsx.confidence, 'low')

  const pptx = cardByPath(atlas, '季度汇报.pptx')
  assert.equal(pptx.content, true)
  assert.equal(pptx.textSource, 'ooxml')
  assert.equal(pptx.title, '季度汇报')
  assert.deepEqual(pptx.headings, [{ level: 1, text: '季度汇报', line: 1 }])
  assert.match(pptx.purpose, /季度汇报/)
  assert.match(pptx.purpose, /本季度完成情况/)
  // 标题占位符的文本从正文 run 中移除：摘要不得重复成“季度汇报 — 季度汇报”。
  assert.equal(pptx.purpose.includes('季度汇报 — 季度汇报'), false)

  assert.deepEqual(atlas.coverage.docText.bySource, { text: 0, ooxml: 3, pdf: 0 })
  assert.equal(atlas.coverage.docText.covered, 3)
  assert.equal(atlas.meta.timings.docTextMs >= 0, true)
})

test('docx 无 styles.xml：outlineLvl 与 HeadingN 命名约定仍识别标题', async (t) => {
  const root = tempDir('atlas-docx-outline-')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  await writeOoxml(path.join(root, '制度.docx'), {
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="w"><w:body>' +
      '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>第一章 总则</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>本制度自发布之日起施行。</w:t></w:r></w:p>' +
      '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>第二节 适用范围</w:t></w:r></w:p>' +
      '</w:body></w:document>',
  })
  const atlas = buildAtlas({ root, dir: path.join(root, '.atlas'), write: false, docText: injected() })
  const card = cardByPath(atlas, '制度.docx')
  assert.equal(card.content, true)
  assert.deepEqual(card.headings, [
    { level: 1, text: '第一章 总则', line: 1 },
    { level: 2, text: '第二节 适用范围', line: 3 },
  ])
  assert.equal(card.title, '第一章 总则')
  assert.match(card.purpose, /本制度自发布之日起施行/)
})

test('OOXML 解压总量超限：单条都不超、合计超 → too-large', async (t) => {
  const root = tempDir('atlas-ooxml-cap-')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, '大演示.pptx')
  await writeOoxml(file, {
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    'ppt/slides/slide1.xml': `<a:t>${'x'.repeat(300)}</a:t>`,
    'ppt/slides/slide2.xml': `<a:t>${'y'.repeat(300)}</a:t>`,
  })
  const r = extractOoxmlText(file, '.pptx', { maxUncompressedBytes: 600 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'too-large')
})

test('PDF：文本层注入生成正文卡；无文本层/扫描件明确标 noText', async (t) => {
  const root = tempDir('atlas-pdf-')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, '方案.pdf'), '%PDF-1.4\n%%EOF\n')
  fs.writeFileSync(path.join(root, '扫描件.pdf'), '%PDF-1.4\n%%EOF\n')

  const atlas = buildAtlas({
    root,
    dir: path.join(root, '.atlas'),
    write: false,
    docText: injected(
      new Map([['方案.pdf', '1\n项目实施方案\n第一阶段：需求调研与资料盘点']]),
      new Map([['扫描件.pdf', 'no-text-layer']]),
    ),
  })

  const pdf = cardByPath(atlas, '方案.pdf')
  assert.equal(pdf.content, true)
  assert.equal(pdf.textSource, 'pdf')
  assert.match(pdf.purpose, /项目实施方案/)
  assert.match(pdf.purpose, /需求调研/)
  assert.equal(pdf.docTextReason, null)

  const scanned = cardByPath(atlas, '扫描件.pdf')
  assert.equal(scanned.noText, true)
  assert.equal(scanned.content, false)
  assert.equal(scanned.docTextReason, 'no-text-layer')
  assert.match(scanned.purpose, /^未导入正文：/)

  assert.deepEqual(atlas.coverage.docText.bySource, { text: 0, ooxml: 0, pdf: 1 })
  assert.equal(atlas.coverage.docText.skipped['no-text-layer'], 1)
})

test('大文件：文档保留元数据卡，代码仍按 too-large 排除', async (t) => {
  const root = tempDir('atlas-large-')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, '大文档.md'), '# 大文档\n' + '正文'.repeat(300))
  fs.writeFileSync(path.join(root, 'big.js'), '// ' + 'x'.repeat(600))

  const cfg = {
    ...loadAtlasConfig(root),
    maxFileBytes: 100,
    maxDocExtractBytes: 50,
  }
  const atlas = buildAtlas({ root, dir: path.join(root, '.atlas'), write: false, config: cfg })

  const doc = cardByPath(atlas, '大文档.md')
  assert.ok(doc, '超过 maxFileBytes 的文档必须仍有卡片')
  assert.equal(doc.tooLarge, true)
  assert.equal(doc.noText, true)
  assert.equal(doc.content, false)
  assert.equal(doc.docTextReason, 'too-large')
  assert.equal(doc.loc, 0)

  assert.equal(cardByPath(atlas, 'big.js'), null)
  const tooLarge = (atlas.meta.excluded || []).find((e) => e.rule === 'too-large')
  assert.ok(tooLarge)
  assert.deepEqual(tooLarge.sample, ['big.js'])
})

test('Office 锁文件（~$ / .~）按 system-file 排除', async (t) => {
  const root = tempDir('atlas-lock-')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, '~$合同台账.xlsx'), 'lock')
  fs.writeFileSync(path.join(root, '.~lock.方案.odt#'), 'lock')
  fs.writeFileSync(path.join(root, '正常文档.md'), '# 正常文档')

  const atlas = buildAtlas({ root, dir: path.join(root, '.atlas'), write: false })
  assert.equal(cardByPath(atlas, '~$合同台账.xlsx'), null)
  assert.equal(cardByPath(atlas, '.~lock.方案.odt#'), null)
  assert.ok(cardByPath(atlas, '正常文档.md'))
  const system = (atlas.meta.excluded || []).find((e) => e.rule === 'system-file')
  assert.ok(system)
  assert.equal(system.count, 2)
})

test('OOXML 坏 ZIP 返回 parse-error；非 OOXML 返回 unsupported', (t) => {
  const root = tempDir('atlas-bad-ooxml-')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const bad = path.join(root, '坏.docx')
  fs.writeFileSync(bad, 'not a zip')
  const r = extractOoxmlText(bad, '.docx')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'parse-error')
  assert.equal(extractOoxmlText(bad, '.txt').reason, 'unsupported')
})

test('PDF 上次因预算失败，下一次构建会重试并补上正文', async (t) => {
  const root = tempDir('atlas-pdf-retry-')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, '重试.pdf'), '%PDF-1.4\n%%EOF\n')
  // 缓存放 .ponos/：walk 模式会跳过它，避免把 nodes/edges/meta 当业务文件重抽。
  const dir = path.join(root, '.ponos', 'atlas')
  const cfg = { ...loadAtlasConfig(root), docTextBudgetMs: 0 }

  const first = buildAtlas({ root, dir, config: cfg })
  const before = cardByPath(first, '重试.pdf')
  assert.equal(before.noText, true)
  assert.equal(before.docTextReason, 'budget')

  const second = buildAtlas({
    root,
    dir,
    config: cfg,
    docText: injected(new Map([['重试.pdf', '重试后的正文\n第二次构建应当补上']])),
  })
  const after = cardByPath(second, '重试.pdf')
  assert.equal(after.content, true)
  assert.equal(after.textSource, 'pdf')
  assert.match(after.purpose, /重试后的正文/)
  assert.equal(second.meta.incremental.extracted, 1)
  assert.equal(second.meta.incremental.full, false)
})

test('PDF 预算为 0 时不 spawn 外部进程，逐份记 budget', () => {
  const files = [{ rel: 'a.pdf', abs: 'a.pdf', kind: 'doc', ext: '.pdf', size: 10 }]
  const r = preparePdfText({
    files,
    config: { docText: true, docTextBudgetMs: 0, maxDocTextChars: 1000, maxDocTextPages: 2 },
  })
  assert.equal(r.enabled, true)
  assert.equal(r.stats.mode, 'none')
  assert.equal(r.reasons.get('a.pdf'), 'budget')
  assert.equal(r.stats.skipped, 1)

  const off = preparePdfText({
    files,
    config: { docText: false },
  })
  assert.equal(off.enabled, false)
})
