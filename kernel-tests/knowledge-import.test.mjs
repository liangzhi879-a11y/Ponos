// kernel-tests/knowledge-import.test.mjs —— 文件知识库导入的回归
//
// 纪律：**不启动 bridge、不依赖真实 python/OCR 模型**（转换器按契约注入假实现）。
// 这里钉的是本模块负责的那一层：白名单/体积/路径防护/md 组装/台账幂等/空间校验。
// python 解析器那一层由 runtime/skills/_common/doc_to_md.py 自己的端到端实测覆盖
// （真实 PDF/Office 样本），不放进单测——否则每次跑测试都要加载 OCR 模型。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, symlinkSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, isAbsolute } from 'node:path'
import {
  importDocuments, importFiles, validateSpaceId, collectFiles, renderMarkdown, renderBody,
  outRelFor, safeOutRel, realpathInside, resolvePython, bundledPython, LEDGER_NAME,
  IMPORT_LIMITS, IMPORT_ALLOW_EXT, IMPORT_BLOCK_EXT,
  defaultConverter, parserCandidates, renderImportText,
} from '../kernel/knowledge-import.mjs'
import { createKnowledgeStore } from '../kernel/knowledge.mjs'
import { toDocId } from '../shared/knowledge-core.mjs'

function mkHome() {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-kbimp-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), '{"model":"fake"}')   // 真实的 configDir 一定非空
  return dir
}
function mkSrc(files) {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-kbsrc-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, ...rel.split('/'))
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content, 'utf-8')
  }
  return dir
}
/** 假转换器：按扩展名给不同 converter 标记，内容含中文与表格 */
const fakeConvert = ({ absPath, rel }) => Promise.resolve({
  ok: true,
  value: {
    converter: rel.endsWith('.pdf') ? 'pdf-text' : 'docx',
    title: '测试文档',
    sections: [
      { heading: '一、章节', level: 1, text: '正文内容含中文', tables: [[['科目', '金额'], ['材料费', '320']]] },
    ],
    warnings: [],
  },
})
const failConvert = () => Promise.resolve({ ok: false, error: 'convert-failed', message: '模拟解析失败' })

const ledgerOf = (root) => JSON.parse(readFileSync(join(root, '.import.json'), 'utf-8'))
const spaceRootOf = (home, id) => join(home, 'knowledge', 'spaces', id)

test('导入：转换落盘 + frontmatter 溯源 + 台账 + 空间元数据', async () => {
  const home = mkHome()
  const src = mkSrc({ 'a.docx': 'x', '子目录/b.pdf': 'yy' })
  const r = await importDocuments({ configDir: home, from: src, space: '资料库', converter: fakeConvert })
  assert.equal(r.ok, true)
  assert.equal(r.counts.converted, 2)
  assert.equal(r.counts.failed, 0)
  assert.equal(r.spaceCreated, true)
  const root = spaceRootOf(home, '资料库')
  assert.ok(existsSync(join(root, 'a.md')))
  assert.ok(existsSync(join(root, '子目录', 'b.md')), '目录结构必须保留')
  const md = readFileSync(join(root, 'a.md'), 'utf-8')
  // frontmatter 是溯源契约：少一个字段，日后就查不出"这篇 md 从哪个文件来"
  for (const k of ['title:', 'source: a.docx', 'sourcePath: a.docx', 'sourceHash:', 'sourceBytes:', 'converter:', 'convertedAt:']) {
    assert.ok(md.includes(k), `frontmatter 缺少 ${k}`)
  }
  assert.ok(md.includes('| 科目 | 金额 |'), '表格必须转成 Markdown 表格')
  assert.ok(md.includes('## 一、章节'), 'section 标题渲染为二级标题')
  assert.ok(existsSync(join(root, '.space.json')), '新建空间要写 .space.json')
  const led = ledgerOf(root)
  assert.equal(Object.keys(led.files).length, 2)
  rmSync(home, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
})

test('幂等：同批再导入全部跳过，不重写产物', async () => {
  const home = mkHome()
  const src = mkSrc({ 'a.docx': 'x', 'b.xlsx': 'y' })
  await importDocuments({ configDir: home, from: src, space: 's1', converter: fakeConvert })
  const mdPath = join(spaceRootOf(home, 's1'), 'a.md')
  const before = readFileSync(mdPath, 'utf-8')
  const mtimeBefore = statSync(mdPath).mtimeMs
  const r2 = await importDocuments({ configDir: home, from: src, space: 's1', converter: fakeConvert })
  assert.equal(r2.counts.converted, 0)
  assert.equal(r2.counts.skipped, 2)
  assert.equal(r2.skipped[0].reason, 'unchanged')
  assert.equal(readFileSync(mdPath, 'utf-8'), before)
  assert.equal(statSync(mdPath).mtimeMs, mtimeBefore, '跳过时不得重写文件')
  rmSync(home, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
})

test('源内容变化 → 重转覆盖；产物被删 → 重转而非误报已导入', async () => {
  const home = mkHome()
  const src = mkSrc({ 'a.docx': 'v1' })
  await importDocuments({ configDir: home, from: src, space: 's2', converter: fakeConvert })
  const mdPath = join(spaceRootOf(home, 's2'), 'a.md')
  // 场景一：产物被手工删了，台账还在 —— 必须重转（否则"文件树空着但台账说已导入"最难排查）
  rmSync(mdPath)
  const r2 = await importDocuments({ configDir: home, from: src, space: 's2', converter: fakeConvert })
  assert.equal(r2.counts.converted, 1, '产物缺失时必须重转')
  assert.ok(existsSync(mdPath))
  // 场景二：源改了 → hash 变 → 重转
  writeFileSync(join(src, 'a.docx'), 'v2')
  const r3 = await importDocuments({ configDir: home, from: src, space: 's2', converter: fakeConvert })
  assert.equal(r3.counts.converted, 1)
  rmSync(home, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
})

test('安全护栏：黑名单扩展名/不支持格式/空文件/超大文件逐条拒因，其余仍成功', async () => {
  const home = mkHome()
  const src = mkSrc({ 'good.docx': 'x', 'evil.exe': 'MZ', 'script.py': 'print(1)', 'note.xyz': 'x', 'empty.docx': '' })
  const big = join(src, 'big.pdf')
  writeFileSync(big, Buffer.alloc(1024))
  const r = await importDocuments({
    configDir: home, from: src, space: 's3', converter: fakeConvert,
    limits: { maxFileBytes: 512 },      // 把上限压到 512B，避免测试里真造 50MB 文件
  })
  assert.equal(r.counts.converted, 1, '只有 good.docx 该成功')
  const bySource = Object.fromEntries(r.failed.map((f) => [f.source, f.error]))
  assert.equal(bySource['evil.exe'], 'blocked-ext')
  assert.equal(bySource['script.py'], 'blocked-ext')
  assert.equal(bySource['note.xyz'], 'unsupported')
  assert.equal(bySource['empty.docx'], 'empty')
  assert.equal(bySource['big.pdf'], 'too-large')
  // 报错必须带**原因**（只给"失败"等于让用户自己猜）
  for (const f of r.failed) assert.ok(f.message && f.message.length > 4, `${f.source} 缺少可读原因`)
  rmSync(home, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
})

test('单文件转换失败不中断整批，报告带文件名与原因', async () => {
  const home = mkHome()
  const src = mkSrc({ 'ok1.docx': 'a', 'bad.docx': 'b', 'ok2.docx': 'c' })
  const conv = ({ rel }) => (rel === 'bad.docx' ? failConvert() : fakeConvert({ rel }))
  const r = await importDocuments({ configDir: home, from: src, space: 's4', converter: conv })
  assert.equal(r.counts.converted, 2)
  assert.equal(r.counts.failed, 1)
  assert.equal(r.failed[0].source, 'bad.docx')
  assert.equal(r.failed[0].error, 'convert-failed')
  rmSync(home, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
})

test('dry-run：只报告不落盘（不建空间、不写 md、不写台账）', async () => {
  const home = mkHome()
  const src = mkSrc({ 'a.docx': 'x' })
  const r = await importDocuments({ configDir: home, from: src, space: 'dry', dryRun: true, converter: fakeConvert })
  assert.equal(r.ok, true)
  assert.equal(r.dryRun, true)
  assert.equal(r.counts.converted, 1)
  assert.equal(r.converted[0].action, 'convert')
  assert.ok(!existsSync(spaceRootOf(home, 'dry')), 'dry-run 不得创建空间目录')
  assert.ok(!existsSync(join(home, 'knowledge')), 'dry-run 不得创建 knowledge 根')
  // 幂等预览也要能看到"将跳过谁"：只列"将处理"是一半的信息
  await importDocuments({ configDir: home, from: src, space: 'dry2', converter: fakeConvert })
  const r2 = await importDocuments({ configDir: home, from: src, space: 'dry2', dryRun: true, converter: fakeConvert })
  assert.equal(r2.counts.skipped, 1)
  rmSync(home, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
})

test('空间 id 校验：内置空间/pack- 前缀/非法字符/保留名一律拒', async () => {
  for (const bad of ['', '   ', 'experience', 'session-memory', 'skill-experience', 'pack-x', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', '.hidden', 'trail.', 'CON', 'LPT1']) {
    const v = validateSpaceId(bad)
    assert.equal(v.ok, false, `应拒绝：${JSON.stringify(bad)}`)
    assert.ok(v.message, '拒绝必须给原因')
  }
  assert.equal(validateSpaceId('资料库-2026').ok, true)
  assert.equal(validateSpaceId('研发 资料').ok, true)
  // 超长（>64）拒绝
  assert.equal(validateSpaceId('x'.repeat(65)).ok, false)
})

test('目标名冲突：不覆盖空间里既有的用户 md，改名让位', async () => {
  const home = mkHome()
  const src = mkSrc({ 'a.docx': 'x' })
  const root = spaceRootOf(home, 's5')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'a.md'), '# 用户自己写的笔记', 'utf-8')  // 台账里没有它 = 不是我方产物
  const r = await importDocuments({ configDir: home, from: src, space: 's5', converter: fakeConvert })
  assert.equal(r.counts.converted, 1)
  assert.notEqual(r.converted[0].out, 'a.md', '必须让位，不得覆盖用户文件')
  assert.equal(readFileSync(join(root, 'a.md'), 'utf-8'), '# 用户自己写的笔记')
  assert.ok(existsSync(join(root, r.converted[0].out)))
  rmSync(home, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
})

test('批次护栏：文件数超限时整批拒（不半途写一半）', async () => {
  const home = mkHome()
  const files = {}
  for (let i = 0; i < 5; i++) files[`f${i}.docx`] = 'x'
  const src = mkSrc(files)
  const r = await importDocuments({
    configDir: home, from: src, space: 's6', converter: fakeConvert, limits: { maxBatchFiles: 3 },
  })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'too-many-files')
  assert.ok(!existsSync(spaceRootOf(home, 's6')), '整批被拒时不得留下半个空间')
  rmSync(home, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
})

test('collectFiles：源不存在/是符号链接报错，隐藏项与依赖目录被跳过', () => {
  assert.equal(collectFiles(join(tmpdir(), 'definitely-not-exist-yfw')).ok, false)
  const src = mkSrc({ 'a.docx': 'x', '.hidden.docx': 'x', 'node_modules/x.docx': 'x', 'ok/b.md': 'y' })
  const got = collectFiles(src)
  assert.equal(got.ok, true)
  assert.deepEqual(got.value.files.map((f) => f.rel).sort(), ['a.docx', 'ok/b.md'])
  // 符号链接：Windows 上建 symlink 需要权限/开发者模式，建不出来就跳过该断言而不是假绿
  try {
    const link = join(src, 'link.docx')
    symlinkSync(join(src, 'a.docx'), link)
    const got2 = collectFiles(src)
    assert.equal(got2.value.files.some((f) => f.rel === 'link.docx'), false, '不得跟随符号链接')
    assert.equal(got2.value.rejected.some((r) => r.error === 'symlink'), true)
  } catch {
    // 无权限建链接：本条断言不适用
  }
  rmSync(src, { recursive: true, force: true })
})

test('渲染：标题去重、单元格转义、2MB 截断标注', () => {
  const meta = { title: '报告', source: 'a.docx', sourcePath: 'a.docx', sourceHash: 'h', sourceBytes: 1, converter: 'docx', convertedAt: 'now' }
  // 首节 heading 与文档标题同名 → 不重复渲染（否则同名标题在检索里占三条同分召回位）
  const md = renderMarkdown({
    meta,
    sections: [{ heading: '报告', level: 1, text: '正文', tables: [[['含|竖线', 'b']]] }],
  })
  assert.equal(md.content.split('# 报告').length, 2, '文档标题只出现一次（加上正文里的 heading 才 2 段）')
  assert.ok(md.content.includes('含\\|竖线'), '表格里的 | 必须转义')
  // 截断：把上限压到很小，必须给出 truncated 标记 + 提示行，而不是静默截
  const big = renderMarkdown({
    meta,
    sections: Array.from({ length: 50 }, (_, i) => ({ heading: `节${i}`, level: 1, text: 'x'.repeat(2000), tables: [] })),
    maxDocBytes: 4096,
  })
  assert.equal(big.truncated, true)
  assert.ok(big.content.includes('truncated: true'))
  assert.ok(big.content.includes('截断'), '必须显式告知被截断')
  assert.ok(big.sectionsKept > 0 && big.sectionsKept < 50)
  // 渲染器自身：无 heading 的节只出正文
  assert.equal(renderBody([{ heading: null, level: 0, text: 'abc', tables: [] }]), 'abc')
})

test('safeOutRel / outRelFor：拒绝穿越与绝对路径，冲突时让位命名', () => {
  assert.equal(safeOutRel('../evil.md'), null)
  assert.equal(safeOutRel('/abs/evil.md'), null)
  assert.equal(safeOutRel('C:/abs/evil.md'), null)
  assert.equal(safeOutRel('a/b.md'), 'a/b.md')
  assert.equal(safeOutRel('a/b.txt'), null, '只允许 .md 产物')
  assert.equal(outRelFor('a.docx'), 'a.md')
  assert.equal(outRelFor('a.docx', (c) => c === 'a.md'), 'a.docx.md')
  assert.equal(outRelFor('a.docx', (c) => c === 'a.md' || c === 'a.docx.md'), 'a.docx-2.md')
})

test('台账损坏时不误判"已导入"（损坏 → 视作空台账，重转）', async () => {
  const home = mkHome()
  const src = mkSrc({ 'a.docx': 'x' })
  await importDocuments({ configDir: home, from: src, space: 's7', converter: fakeConvert })
  writeFileSync(join(spaceRootOf(home, 's7'), '.import.json'), '{ 这不是 JSON', 'utf-8')
  const r = await importDocuments({ configDir: home, from: src, space: 's7', converter: fakeConvert })
  assert.equal(r.counts.converted, 1, '台账损坏时必须重转，不能因为"看起来已导入"就跳过')
  rmSync(home, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
})

test('single 文件导入 + 上限常量与 server 侧一致（2MB 文档上限）', async () => {
  const home = mkHome()
  const src = mkSrc({ 'one.docx': 'x' })
  const r = await importDocuments({ configDir: home, from: join(src, 'one.docx'), space: 's8', converter: fakeConvert })
  assert.equal(r.counts.converted, 1)
  assert.equal(r.sourceIsDir, false)
  assert.ok(existsSync(join(spaceRootOf(home, 's8'), 'one.md')))
  // 与 server 的 MAX_DOC_BYTES 同值：不同值会出现"导入成功但索引拒收"的分裂
  assert.equal(IMPORT_LIMITS.maxDocBytes, 2 * 1024 * 1024)
  rmSync(home, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
})

test('多源导入（GUI 多选文件/多目录）：rel 带源名前缀，同名文件互不覆盖', async () => {
  const home = mkHome()
  const a = mkSrc({ '报告.docx': 'A' })
  const b = mkSrc({ '报告.docx': 'B' })
  const r = await importDocuments({ configDir: home, from: [a, b], space: 'multi', converter: fakeConvert })
  assert.equal(r.counts.converted, 2, '两个同名源都必须落盘')
  assert.equal(r.counts.failed, 0)
  assert.ok(Array.isArray(r.source) && r.source.length === 2, '多源报告要能看出"来自哪几个地方"')
  const outs = r.converted.map((c) => c.out).sort()
  assert.equal(new Set(outs).size, 2, '同名文件不得挤到同一个输出名上')
  const root = spaceRootOf(home, 'multi')
  for (const o of outs) assert.ok(existsSync(join(root, ...o.split('/'))), `缺产物：${o}`)
  assert.equal(Object.keys(ledgerOf(root).files).length, 2, '台账要按源分别记账')
  // 多源幂等：再来一次仍全跳过
  const r2 = await importDocuments({ configDir: home, from: [a, b], space: 'multi', converter: fakeConvert })
  assert.equal(r2.counts.skipped, 2)
  // 多选单个文件（GUI 的 common case）：直接以文件名落盘，不加无谓前缀
  const r3 = await importDocuments({ configDir: home, from: [join(a, '报告.docx')], space: 'multi2', converter: fakeConvert })
  assert.equal(r3.counts.converted, 1)
  assert.equal(r3.converted[0].out, '报告.md')
  rmSync(home, { recursive: true, force: true })
  rmSync(a, { recursive: true, force: true })
  rmSync(b, { recursive: true, force: true })
})

test('多源含坏路径 → 整批拒（不静默丢掉一个源）', async () => {
  const home = mkHome()
  const a = mkSrc({ 'x.docx': 'x' })
  const r = await importDocuments({
    configDir: home, from: [a, join(tmpdir(), 'definitely-missing-yfw-src')], space: 'multi3', converter: fakeConvert,
  })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'not-found')
  assert.ok(!existsSync(spaceRootOf(home, 'multi3')), '整批拒时不得留下半个空间')
  rmSync(home, { recursive: true, force: true })
  rmSync(a, { recursive: true, force: true })
})

// ── `importFiles` 对外契约（T2 主入口：results[].status 四态 + summary）───────────────
// 下面这一组钉的是**契约面**：参数名（maxFileBytes/maxTotalBytes/maxFiles/maxMdBytes/
// runDocToMd/pythonPath）、报告形状（results/summary/targetDir）、错误码
// （invalid-space-id/readonly-space/not-found/empty-batch）。内部管线与 importDocuments 同一条。

/**
 * 假解析器（`runDocToMd` 契约：`(filePath, opts) => {ok, ...}`）。
 * 返回**扁平**结构 —— 与 python 侧单行 JSON 同形，这样"注入假实现"验证的就是真契约的形状，
 * 而不是我们内部包的 `{ok, value}` 壳（壳一旦漂移，测试不该跟着一起漂）。
 */
const fakeDocToMd = (filePath, o = {}) => Promise.resolve({
  ok: true,
  converter: filePath.endsWith('.pdf') ? 'pdf-text' : 'docx',
  title: `文档 ${basename(filePath)}`,
  sections: [
    { heading: '一、章节', level: 1, text: '正文内容含中文', tables: [[['科目', '金额'], ['材料费', '320']]] },
  ],
  warnings: [], sourceBytes: 1, pages: 1,
  __opts: o,
})

test('importFiles：导入成功（目录结构保留 + md 落盘 + 台账 + 空间元数据 + 索引自动吸收）', async () => {
  const home = mkHome()
  const src = mkSrc({ 'a.docx': 'x', '子目录/b.pdf': 'yy' })
  const seen = []
  const r = await importFiles({
    configDir: home, from: src, name: '申报资料',
    runDocToMd: (fp, o) => { seen.push({ fp, o }); return fakeDocToMd(fp, o) },
  })
  assert.equal(r.ok, true)
  assert.equal(r.space, '申报资料', 'name 缺省即空间 id')
  assert.equal(r.spaceName, '申报资料')
  assert.equal(r.spaceCreated, true)
  assert.equal(r.dryRun, false)
  assert.equal(r.targetDir, join(home, 'knowledge', 'spaces', '申报资料'))
  assert.deepEqual(r.summary, { total: 2, imported: 2, skipped: 0, rejected: 0, failed: 0 })
  assert.deepEqual(r.results.map((x) => x.status), ['imported', 'imported'])
  const byRel = Object.fromEntries(r.results.map((x) => [x.rel, x]))
  assert.equal(byRel['a.docx'].mdRel, 'a.md')
  assert.equal(byRel['子目录/b.pdf'].mdRel, '子目录/b.md', '相对目录结构必须保留、同名 .md')
  assert.equal(byRel['a.docx'].converter, 'docx')
  assert.ok(byRel['a.docx'].bytes > 0, 'bytes = 产物 md 的字节数（报告要能看出落了多大）')
  // 注入点收到的是**源文件绝对路径** + limits（pythonPath 缺省 null，由 resolvePython 兜底）
  assert.equal(seen.length, 2)
  assert.equal(seen[0].o.absPath.startsWith(src), true)
  assert.equal(seen[0].o.limits.maxFileBytes, IMPORT_LIMITS.maxFileBytes)
  assert.equal(seen[0].o.pythonPath, null)
  const root = r.targetDir
  assert.ok(existsSync(join(root, 'a.md')))
  assert.ok(existsSync(join(root, '子目录', 'b.md')), '目录结构必须保留')
  assert.equal(JSON.parse(readFileSync(join(root, '.space.json'), 'utf-8')).name, '申报资料')
  assert.equal(Object.keys(ledgerOf(root).files).length, 2, '台账按源逐条记账')
  // 验收 7：台账/空间元数据**不污染文件树与索引**（walkMd/listTree 都不收隐藏项）
  const store = createKnowledgeStore({ configDir: home })
  store.load({})
  const sp = store.getSpaces().find((s) => s.id === '申报资料')
  assert.ok(sp, '新空间无需注册即被空间发现吸收')
  assert.equal(sp.docCount, 2, '新文件无需 reindex 即被索引吸收（staleness 逐文件比对）')
  assert.deepEqual(store.listTree({ space: '申报资料' }).map((e) => e.name).sort(), ['a.md', '子目录'])
  assert.ok(store.search({ query: '材料费' }).count > 0, '导入的内容立刻可检索')
  rmSync(home, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
})

test('importFiles：重复导入全部 skipped，md 与台账都不被重写（逐字节 + mtime）', async () => {
  const home = mkHome()
  const src = mkSrc({ 'a.docx': 'x', 'b.xlsx': 'y' })
  await importFiles({ configDir: home, from: src, space: 'idem', runDocToMd: fakeDocToMd })
  const root = spaceRootOf(home, 'idem')
  const mdPath = join(root, 'a.md')
  const ledPath = join(root, LEDGER_NAME)
  const mdBefore = readFileSync(mdPath, 'utf-8')
  const mdMtime = statSync(mdPath).mtimeMs
  const ledBefore = readFileSync(ledPath, 'utf-8')
  const ledMtime = statSync(ledPath).mtimeMs
  const r2 = await importFiles({ configDir: home, from: src, space: 'idem', runDocToMd: fakeDocToMd })
  assert.deepEqual(r2.summary, { total: 2, imported: 0, skipped: 2, rejected: 0, failed: 0 })
  assert.deepEqual(r2.results.map((x) => x.status), ['skipped', 'skipped'])
  assert.equal(r2.results[0].reason, 'unchanged')
  assert.equal(r2.results[0].mdRel, 'a.md', '跳过也要回显产物名（用户要能对账"它早就在哪")')
  assert.equal(readFileSync(mdPath, 'utf-8'), mdBefore)
  assert.equal(statSync(mdPath).mtimeMs, mdMtime, '跳过时不得重写 md')
  assert.equal(readFileSync(ledPath, 'utf-8'), ledBefore)
  assert.equal(statSync(ledPath).mtimeMs, ledMtime, '跳过时不得重写台账')
  rmSync(home, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
})

test('importFiles：.exe 拒收（rejected 档 + 明确原因），同批其余文件仍成功', async () => {
  const home = mkHome()
  const src = mkSrc({ 'ok.docx': 'x', 'evil.exe': 'MZ', 'hook.ps1': 'x' })
  const r = await importFiles({ configDir: home, from: src, space: 'sec', runDocToMd: fakeDocToMd })
  assert.equal(r.ok, true, '逐文件被拒不算整批失败')
  assert.deepEqual(r.summary, { total: 3, imported: 1, skipped: 0, rejected: 2, failed: 0 })
  const byRel = Object.fromEntries(r.results.map((x) => [x.rel, x]))
  assert.equal(byRel['evil.exe'].status, 'rejected')
  assert.equal(byRel['evil.exe'].reason, 'blocked-ext')
  assert.equal(byRel['hook.ps1'].status, 'rejected')
  assert.ok(byRel['evil.exe'].message.includes('.exe'), '拒因要指名具体扩展名')
  assert.ok(!existsSync(join(spaceRootOf(home, 'sec'), 'evil.md')))
  rmSync(home, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
})

test('importFiles：体积护栏可 override（单文件 / 整批字节 / 整批文件数）', async () => {
  const home = mkHome()
  const src = mkSrc({ 'small.docx': 'x', 'big.pdf': 'y'.repeat(1024) })
  const r = await importFiles({
    configDir: home, from: src, space: 'lim', runDocToMd: fakeDocToMd, maxFileBytes: 512,
  })
  assert.deepEqual(r.summary, { total: 2, imported: 1, skipped: 0, rejected: 1, failed: 0 })
  const big = r.results.find((x) => x.rel === 'big.pdf')
  assert.equal(big.status, 'rejected')
  assert.equal(big.reason, 'too-large')
  assert.ok(big.message.includes('1.0KB') && big.message.includes('512B'), '原因要带实际体积与上限（可核对的小体积单位）')
  // 整批字节超限：整批拒（不留半个空间 —— "导了一半"比"整批没导"更难收拾）
  const home2 = mkHome()
  const r2 = await importFiles({
    configDir: home2, from: src, space: 'lim2', runDocToMd: fakeDocToMd, maxTotalBytes: 600,
  })
  assert.equal(r2.ok, false)
  assert.equal(r2.error, 'batch-too-large')
  assert.ok(!existsSync(spaceRootOf(home2, 'lim2')))
  // 整批文件数超限
  const home3 = mkHome()
  const many = mkSrc(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}.docx`, 'x'])))
  const r3 = await importFiles({
    configDir: home3, from: many, space: 'lim3', runDocToMd: fakeDocToMd, maxFiles: 3,
  })
  assert.equal(r3.ok, false)
  assert.equal(r3.error, 'too-many-files')
  assert.ok(!existsSync(spaceRootOf(home3, 'lim3')))
  rmSync(home, { recursive: true, force: true })
  rmSync(home2, { recursive: true, force: true })
  rmSync(home3, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
  rmSync(many, { recursive: true, force: true })
})

test('importFiles：单文件解析失败（加密 PDF）不拖垮整批，failed 与 rejected 分档', async () => {
  const home = mkHome()
  const src = mkSrc({ 'ok1.docx': 'a', 'locked.pdf': 'b', 'ok2.xlsx': 'c' })
  const conv = (fp, o) => (fp.endsWith('locked.pdf')
    ? Promise.resolve({ ok: false, error: 'encrypted', message: '该 PDF 已加密，无法提取内容' })
    : fakeDocToMd(fp, o))
  const r = await importFiles({ configDir: home, from: src, space: 'part', runDocToMd: conv })
  assert.equal(r.ok, true)
  assert.deepEqual(r.summary, { total: 3, imported: 2, skipped: 0, rejected: 0, failed: 1 })
  const bad = r.results.find((x) => x.rel === 'locked.pdf')
  assert.equal(bad.status, 'failed', '解析失败属 failed（不是 rejected：它本来是在白名单里的格式）')
  assert.equal(bad.reason, 'encrypted')
  assert.ok(bad.message.length > 4)
  for (const rel of ['ok1.docx', 'ok2.xlsx']) {
    assert.equal(r.results.find((x) => x.rel === rel).status, 'imported', `${rel} 必须仍然成功`)
  }
  rmSync(home, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
})

test('importFiles：dryRun 给出将处理/将跳过/将被拒三档，且不写任何文件', async () => {
  const home = mkHome()
  const src = mkSrc({ 'a.docx': 'x', 'evil.exe': 'MZ' })
  const r = await importFiles({ configDir: home, from: src, space: 'dry', dryRun: true, runDocToMd: fakeDocToMd })
  assert.equal(r.ok, true)
  assert.equal(r.dryRun, true)
  assert.deepEqual(r.summary, { total: 2, imported: 1, skipped: 0, rejected: 1, failed: 0 })
  assert.ok(!existsSync(join(home, 'knowledge')), 'dry-run 不得创建 knowledge 根（连带空间目录）')
  assert.equal(r.targetDir, join(home, 'knowledge', 'spaces', 'dry'), 'targetDir 仍要回显"将写到哪里"')
  // 幂等预览：真导一次后，dryRun 要能看出"谁会被跳过"（只列将处理是一半的信息）
  await importFiles({ configDir: home, from: src, space: 'dry2', runDocToMd: fakeDocToMd })
  const r2 = await importFiles({ configDir: home, from: src, space: 'dry2', dryRun: true, runDocToMd: fakeDocToMd })
  assert.equal(r2.summary.skipped, 1)
  assert.equal(r2.results.find((x) => x.status === 'skipped').reason, 'unchanged')
  rmSync(home, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
})

test('importFiles：只读空间（pack-* / packs 目录）与非法 id 明确报错，全程零写入', async () => {
  const home = mkHome()
  const src = mkSrc({ 'a.docx': 'x' })
  // pack- 前缀 = 知识包保留前缀（403 语义）
  const r1 = await importFiles({ configDir: home, from: src, space: 'pack-demo', runDocToMd: fakeDocToMd })
  assert.equal(r1.ok, false)
  assert.equal(r1.error, 'readonly-space')
  assert.ok(r1.message.includes('pack-'))
  // 目标 id 不以 pack- 开头，但 knowledge/packs/<id> 已存在 → 仍是只读（不能把产物写进包树）
  mkdirSync(join(home, 'knowledge', 'packs', '资料包'), { recursive: true })
  const r2 = await importFiles({ configDir: home, from: src, space: '资料包', runDocToMd: fakeDocToMd })
  assert.equal(r2.ok, false)
  assert.equal(r2.error, 'readonly-space')
  // 非法 id：含路径分隔符/穿越（400 语义）——绝不 slug 化改名后照写
  for (const bad of ['a/b', '..', 'a\\b', 'a:b', '.hidden']) {
    const r = await importFiles({ configDir: home, from: src, space: bad, runDocToMd: fakeDocToMd })
    assert.equal(r.ok, false, `应拒绝：${bad}`)
    assert.equal(r.error, 'invalid-space-id', `${bad} 的错误码`)
  }
  // 参数非法：空批次 / 源不存在
  assert.equal((await importFiles({ configDir: home, from: [], space: 'x' })).error, 'empty-batch')
  assert.equal((await importFiles({ configDir: home, space: 'x' })).error, 'empty-batch')
  const r3 = await importFiles({
    configDir: home, from: join(tmpdir(), 'definitely-missing-yfw-2'), space: 'x', runDocToMd: fakeDocToMd,
  })
  assert.equal(r3.error, 'not-found')
  // 全程零写入：连 knowledge/spaces 都不该被建出来（我建的只有上面那个 packs 夹具）
  assert.ok(!existsSync(join(home, 'knowledge', 'spaces')), '被拒的导入不得留下任何空间目录')
  rmSync(home, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
})

test('importFiles：md 超单篇上限 → 按 section 边界截断并标注 truncated: true', async () => {
  const home = mkHome()
  const src = mkSrc({ 'big.pdf': 'x' })
  const MAX = 4096
  const big = () => Promise.resolve({
    ok: true, converter: 'pdf-text', title: '大文档', warnings: [],
    sections: Array.from({ length: 50 }, (_, i) => ({ heading: `节${i}`, level: 1, text: 'x'.repeat(2000), tables: [] })),
  })
  const r = await importFiles({ configDir: home, from: src, space: 'trunc', runDocToMd: big, maxMdBytes: MAX })
  assert.equal(r.summary.imported, 1)
  const it = r.results[0]
  assert.equal(it.truncated, true, '截断必须**出声**（结果里可判定）')
  assert.ok(it.warnings.some((w) => w.includes('截断')), 'warnings 要写明按 section 截断')
  assert.ok(it.bytes <= MAX, '产物必须落在上限内（否则索引侧会拒收）')
  const md = readFileSync(join(spaceRootOf(home, 'trunc'), 'big.md'), 'utf-8')
  assert.ok(md.includes('truncated: true'), 'frontmatter 必须标注截断（文件自身可自证）')
  assert.ok(md.includes('完整内容请查阅源文件'), '正文要告知去哪里拿全文')
  assert.ok(Buffer.byteLength(md, 'utf-8') <= MAX)
  rmSync(home, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
})

test('importFiles：导入后立即索引同步（updateDoc 优先，not-found 只回落一次 load）', async () => {
  // 假 store：把两条路径的调用次数钉住 —— 只 load 一次/只增量都是错的（见模块内 why）
  const fakeStore = ({ updated }) => {
    const calls = { updateDoc: [], load: [] }
    return {
      calls,
      updateDoc: (id) => { calls.updateDoc.push(id); return updated ? { updated: true } : { updated: false, reason: 'not-found' } },
      load: (o) => { calls.load.push(o ?? null) },
    }
  }
  // 场景一：新文件 not-found → 回落 load({}) 一次（两篇都 not-found 也只 load 一次）
  const home = mkHome()
  const src = mkSrc({ 'a.docx': 'x', 'b.xlsx': 'y' })
  const s1 = fakeStore({ updated: false })
  const r1 = await importFiles({ configDir: home, from: src, space: 'sync', runDocToMd: fakeDocToMd, knowledgeIndex: s1 })
  assert.equal(r1.indexSync, 'reloaded')
  assert.equal(s1.calls.updateDoc.length, 2, '每篇都要先试增量')
  assert.deepEqual(s1.calls.load, [{}], 'not-found 回落 load({}) 且只回落一次')
  // docId 口径必须与内核一致（写错 = 静默没同步，最难查的一类"导入完搜不到"）
  assert.equal(s1.calls.updateDoc[0], toDocId('sync', 'a.md'))
  // 场景二：文档已在索引里 → 增量即可，不必整库 load
  const home2 = mkHome()
  const s2 = fakeStore({ updated: true })
  const r2 = await importFiles({ configDir: home2, from: src, space: 'sync2', runDocToMd: fakeDocToMd, knowledgeIndex: s2 })
  assert.equal(r2.indexSync, 'incremental')
  assert.equal(s2.calls.updateDoc.length, 2)
  assert.equal(s2.calls.load.length, 0)
  rmSync(home, { recursive: true, force: true })
  rmSync(home2, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
})

test('扩展名集合：白名单含 spec §6 全部、黑名单拒脚本、两者不相交、全小写含点', () => {
  for (const e of ['.md', '.txt', '.csv', '.pdf', '.docx', '.xlsx', '.xls', '.pptx', '.ppt',
    '.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff', '.webp']) {
    assert.ok(IMPORT_ALLOW_EXT.has(e), `白名单缺 ${e}`)
  }
  for (const e of ['.js', '.mjs', '.cjs', '.exe', '.dll', '.bat', '.cmd', '.ps1', '.sh', '.py', '.jar']) {
    assert.ok(IMPORT_BLOCK_EXT.has(e), `黑名单缺 ${e}`)
    assert.equal(IMPORT_ALLOW_EXT.has(e), false, `${e} 不得同时进白名单`)
  }
  for (const set of [IMPORT_ALLOW_EXT, IMPORT_BLOCK_EXT]) {
    for (const e of set) assert.match(e, /^\.[a-z0-9]+$/, `扩展名须为小写含点：${e}`)
  }
  // 与解析器能力同源（TEXT_EXTS 那几个纯文本类必须是放行的，否则"能转却不让导"）
  for (const e of ['.markdown', '.log', '.json', '.yaml', '.yml', '.html', '.htm']) {
    assert.ok(IMPORT_ALLOW_EXT.has(e), `${e} 解析器支持，导入器也应放行`)
  }
  // spec §6 的三个数值护栏：单文件 50MB / 整批 500 文件 / 300MB（改成别的值必须是有意为之）
  assert.equal(IMPORT_LIMITS.maxFileBytes, 50 * 1024 * 1024)
  assert.equal(IMPORT_LIMITS.maxBatchFiles, 500)
  assert.equal(IMPORT_LIMITS.maxBatchBytes, 300 * 1024 * 1024)
  assert.equal(IMPORT_LIMITS.maxOcrPages, 200)
})

test('realpath 越界校验 + 目标路径口径与 server safeRelPath 一致（不漂移）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yfw-kbreal-'))
  mkdirSync(join(root, 'sub'), { recursive: true })
  assert.equal(realpathInside(root, join(root, 'sub', 'a.md')), true)
  assert.equal(realpathInside(root, join(root, 'a.md')), true, '尚不存在 → 按父目录判定')
  assert.equal(realpathInside(root, join(root, '..', 'evil.md')), false)
  assert.equal(realpathInside(root, join(tmpdir(), 'elsewhere.md')), false)
  // 口径一致性：内核写侧 vs server 写侧必须同一张判定表（各写一份必然漂移）
  const { safeRelPath } = await import('../server/knowledge-routes.mjs')
  for (const c of ['a/b.md', 'a\\b.md', '../etc/passwd.md', 'a/../../x.md', '/abs/x.md', 'C:/x.md',
    'a/b.txt', '', 'a/./b.md', '子目录/文档.md', 'a//b.md']) {
    assert.equal(safeOutRel(c), safeRelPath(c), `口径不一致：${JSON.stringify(c)}`)
  }
  rmSync(root, { recursive: true, force: true })
})

test('真实存在的目录符号链接（junction）指向空间外 → 拒写 target-escape', async (t) => {
  const home = mkHome()
  const outside = mkdtempSync(join(tmpdir(), 'yfw-kbout-'))
  const src = mkSrc({ 'outing/a.docx': 'x' })
  const root = spaceRootOf(home, 'escape')
  mkdirSync(root, { recursive: true })
  try {
    symlinkSync(outside, join(root, 'outing'), 'junction')
  } catch {
    // 无权限建链接（Windows 需开发者模式）→ 本环境不适用这条断言，**跳过而不是假绿**
    t.skip('本环境不允许创建目录符号链接/junction')
    rmSync(home, { recursive: true, force: true })
    rmSync(src, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
    return
  }
  const r = await importFiles({ configDir: home, from: src, space: 'escape', runDocToMd: fakeDocToMd })
  assert.equal(r.summary.imported, 0)
  assert.equal(r.results[0].status, 'failed')
  assert.equal(r.results[0].reason, 'target-escape', '词法合法但物理越界 → 必须拒，绝不照写')
  assert.equal(existsSync(join(outside, 'a.md')), false, '空间外的目录一个字节都不能被写')
  rmSync(home, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

test('junction（嵌套目录）：空间外零写入 —— 连空目录树都不许建出来', async (t) => {
  // 只覆盖单层的 junction 用例（上一条）挡不住这个 bug：旧实现先
  // `mkdirSync(dirname(outAbs), {recursive:true})` 再 realpath 校验，源含 `outing/sub/deep/a.docx`
  // 时会在**空间根外**先建出 `sub/`、`sub/deep/` 两棵空目录，之后才判越界 ——
  // 等于承认"空间根外可以先写点东西"（验收 7：导入只写 knowledge/spaces/）。
  const home = mkHome()
  const outside = mkdtempSync(join(tmpdir(), 'yfw-kbout2-'))
  const src = mkSrc({ 'outing/sub/deep/a.docx': 'x' })
  const root = spaceRootOf(home, 'escape2')
  mkdirSync(root, { recursive: true })
  try {
    symlinkSync(outside, join(root, 'outing'), 'junction')
  } catch {
    t.skip('本环境不允许创建目录符号链接/junction')
    rmSync(home, { recursive: true, force: true })
    rmSync(src, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
    return
  }
  const r = await importFiles({ configDir: home, from: src, space: 'escape2', runDocToMd: fakeDocToMd })
  assert.equal(r.summary.imported, 0)
  assert.equal(r.results[0].reason, 'target-escape')
  assert.deepEqual(readdirSync(outside), [], '空间外必须零文件零目录（空目录树也不算"零写入"）')
  assert.equal(existsSync(join(outside, 'sub')), false, '不得先 mkdir 再校验')
  assert.equal(existsSync(join(outside, 'sub', 'deep')), false)
  rmSync(home, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

test('pythonPath 注入优先于 env 与自带解释器（契约 opts.pythonPath）', async () => {
  assert.equal(resolvePython('D:/x/python.exe'), 'D:/x/python.exe')
  assert.equal(resolvePython(''), resolvePython(null), '空串等同缺省')
  const def = resolvePython(null)
  // 缺省要么是自带解释器（存在时优先），要么是 env，要么 PATH 上的 python —— 三者都非空
  assert.ok(def.length > 0)
  if (bundledPython()) assert.equal(def, resolvePython(), '缺省不因参数缺省而变')
})

// ── 以下为 T2 审计补齐：模块在新增行为（稳定台账键 / 延迟建空间 / 逐级 realpath /
//    .doc 特例 / 子进程参数契约）之后，测试必须同步钉住，否则回归面在无声处扩大。──────────

test('遗留 .doc：扫描期放行、转换期逐文件失败（"另存为"引导），不拖垮整批', async () => {
  const home = mkHome()
  const src = mkSrc({ 'ok.docx': 'x', '旧版.doc': 'y' })
  // 解析器对 .doc 的真实返回（doc_to_md.py 的 _LEGACY_MSG）
  const conv = (fp, o) => (fp.endsWith('.doc')
    ? Promise.resolve({ ok: false, error: 'unsupported', message: '.doc 是旧版二进制 Office 格式，暂不支持（请另存为 .docx 后重试）' })
    : fakeDocToMd(fp, o))
  const r = await importFiles({ configDir: home, from: src, space: 'legacy-doc', runDocToMd: conv })
  assert.ok(IMPORT_ALLOW_EXT.has('.doc'), '.doc 必须在白名单内（否则永远拿不到"另存为"这条可执行建议）')
  assert.equal(r.summary.imported, 1, '同批其余文件必须仍然成功')
  const bad = r.results.find((x) => x.rel === '旧版.doc')
  assert.equal(bad.status, 'failed', '.doc 在白名单内 ⇒ 属"转换期失败"，不是"扫描期被拒"')
  assert.equal(bad.reason, 'unsupported')
  assert.ok(bad.message.includes('另存为'), '失败原因必须给出可执行建议（不是"不支持该格式"）')
  // .doc 与 .ppt 同口径：白名单成员不得落进黑名单
  assert.equal(IMPORT_BLOCK_EXT.has('.doc'), false)
  rmSync(home, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
})

test('台账键 = 源文件稳定标识：整目录导入与「单选同一文件」同键（幂等不因入口而失效）', async () => {
  const home = mkHome()
  const src = mkSrc({ '报告.docx': 'A' })
  const r1 = await importFiles({ configDir: home, from: src, space: 'key', runDocToMd: fakeDocToMd })
  assert.equal(r1.summary.imported, 1)
  const root = spaceRootOf(home, 'key')
  const led1 = ledgerOf(root)
  assert.equal(Object.keys(led1.files).length, 1)
  const k = Object.keys(led1.files)[0]
  // 用 rel 当键会让"两个不同目录里的同名文件"天然撞键（第二份被当成"内容变化"直接覆盖第一份）
  assert.match(k, /^[0-9a-f]{16}$/, '台账键必须是稳定标识（realpath 派生），不是源相对路径')
  assert.equal(led1.files[k].rel, '报告.docx', 'rel 仍要留在记录里（报告可读性）')
  // 同一物理文件换入口（GUI 单选该文件）→ 同键 → 跳过；不得产出第二份 md
  const r2 = await importFiles({ configDir: home, from: join(src, '报告.docx'), space: 'key', runDocToMd: fakeDocToMd })
  assert.deepEqual(r2.summary, { total: 1, imported: 0, skipped: 1, rejected: 0, failed: 0 })
  assert.deepEqual(readdirSync(root).filter((n) => n.endsWith('.md')), ['报告.md'])
  rmSync(home, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
})

test('同名不同源分别导入同一空间：不互相覆盖，第二份让位命名且报告可解释', async () => {
  const home = mkHome()
  const a = mkSrc({ '报告.docx': 'AAA' })
  const b = mkSrc({ '报告.docx': 'BBB' })
  const r1 = await importFiles({ configDir: home, from: join(a, '报告.docx'), space: 'same-name', runDocToMd: fakeDocToMd })
  const root = spaceRootOf(home, 'same-name')
  const first = readFileSync(join(root, '报告.md'), 'utf-8')
  const r2 = await importFiles({ configDir: home, from: join(b, '报告.docx'), space: 'same-name', runDocToMd: fakeDocToMd })
  assert.equal(r1.results[0].mdRel, '报告.md')
  assert.notEqual(r2.results[0].mdRel, '报告.md', '第二份必须让位（否则静默覆盖第一份的内容）')
  assert.equal(readFileSync(join(root, '报告.md'), 'utf-8'), first, '第一份产物不得被改写')
  assert.ok(r2.results[0].warnings.some((w) => w.includes('已被占用')), '改名必须出声（否则用户以为导重了）')
  assert.equal(Object.keys(ledgerOf(root).files).length, 2, '两个源各自记账')
  rmSync(home, { recursive: true, force: true })
  rmSync(a, { recursive: true, force: true })
  rmSync(b, { recursive: true, force: true })
})

test('旧台账（键 = rel、无 key 字段）→ hash 一致则认下并迁移到稳定键（不做新旧并存）', async () => {
  const home = mkHome()
  const src = mkSrc({ 'a.docx': 'x' })
  await importFiles({ configDir: home, from: src, space: 'mig', runDocToMd: fakeDocToMd })
  const root = spaceRootOf(home, 'mig')
  const led = ledgerOf(root)
  const [key, rec] = Object.entries(led.files)[0]
  // 改写成"换键之前"的形态：键 = rel，记录里没有 key 字段
  const legacyRec = { ...rec }
  delete legacyRec.key
  writeFileSync(join(root, LEDGER_NAME), JSON.stringify({ version: 1, updatedAt: null, files: { [rec.rel]: legacyRec } }, null, 2), 'utf-8')
  const mdMtime = statSync(join(root, 'a.md')).mtimeMs
  const r = await importFiles({ configDir: home, from: src, space: 'mig', runDocToMd: fakeDocToMd })
  assert.equal(r.summary.skipped, 1, 'hash 一致的旧记录必须认下（不得重复转换）')
  assert.equal(statSync(join(root, 'a.md')).mtimeMs, mdMtime, '跳过不得重写产物')
  const led2 = ledgerOf(root)
  assert.ok(led2.files[key], '必须迁移到稳定键')
  assert.equal(led2.files[rec.rel], undefined, '旧键必须清掉（新旧并存会让下次导入又得靠 hash 兜底）')
  rmSync(home, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
})

test('全批被拒（非 dryRun）→ 不建空间/不写台账，spaceCreated=false 且报告说明原因', async () => {
  const home = mkHome()
  const src = mkSrc({ 'a.exe': 'MZ', 'b.py': 'print(1)', 'c.docx': 'x' })
  const r = await importFiles({ configDir: home, from: src, space: 'allempty', runDocToMd: failConvert })
  assert.equal(r.ok, true, '逐文件被拒不是整批失败')
  assert.deepEqual(r.summary, { total: 3, imported: 0, skipped: 0, rejected: 2, failed: 1 })
  assert.equal(r.spaceCreated, false, '无产物落盘就不算"新建了空间"')
  assert.equal(r.spaceExisted, false)
  assert.ok(!existsSync(join(home, 'knowledge', 'spaces')), '一个 md 都没落盘时连 spaces/ 都不该被建出来')
  assert.ok(r.warnings.some((w) => w.includes('未创建空间')), '必须出声说明"没有创建空间"（否则 GUI 会凭空多一个空条目）')
  // 文本报告（CLI 与 agent 工具共用）：三档要能分列看出，且"未创建"必须如实回显
  const rep = await importDocuments({ configDir: home, from: src, space: 'allempty', converter: failConvert })
  const txt = renderImportText(rep)
  assert.ok(txt.includes('未创建'), txt)
  assert.ok(txt.includes('被拒（不符合导入规则）'), txt)
  assert.ok(txt.includes('失败：'), txt)
  assert.ok(txt.includes('不允许导入可执行/脚本类文件'), txt)
  rmSync(home, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
})

test('深目录 + junction 越界：拒写，且空间外连空目录都不许出现（逐级校验在 mkdir 之前）', async (t) => {
  const home = mkHome()
  const outside = mkdtempSync(join(tmpdir(), 'yfw-kbout2-'))
  const src = mkSrc({ 'outing/sub/deep/a.docx': 'x' })
  const root = spaceRootOf(home, 'esc2')
  mkdirSync(root, { recursive: true })
  try {
    symlinkSync(outside, join(root, 'outing'), 'junction')
  } catch {
    t.skip('本环境不允许创建目录符号链接/junction')
    rmSync(home, { recursive: true, force: true })
    rmSync(src, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
    return
  }
  const r = await importFiles({ configDir: home, from: src, space: 'esc2', runDocToMd: fakeDocToMd })
  assert.equal(r.summary.imported, 0)
  assert.equal(r.results[0].reason, 'target-escape')
  assert.deepEqual(readdirSync(outside), [], '空间外不得出现任何东西 —— 含 recursive mkdir 会留下的中间空目录')
  rmSync(home, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

test('defaultConverter ↔ 解析器子进程契约：argv 四项 / UTF-8 / ok 字段优先于退出码', async (t) => {
  const py = bundledPython()
  if (!py) return t.skip('本环境无自带 python，跳过子进程契约自检')
  const dir = mkdtempSync(join(tmpdir(), 'yfw-kbpy-'))
  const docx = join(dir, 'a.docx')
  writeFileSync(docx, 'x')
  const okScript = join(dir, 'fake_ok.py')
  // 故意三件事一起做：① 往 stdout 写噪音行（第三方库会这么干）② 打印中文 ③ 以**非 0 退出码**结束。
  // node 必须取"最后一个 { 开头的行"、按 UTF-8 解码、并**只看 ok 字段**（T1 契约：退出码恒为 0，
  // 不能拿它判成败；反过来"退出码非 0 但 ok:true"也必须判成功，否则信号判断就是错的）。
  writeFileSync(okScript, [
    '# -*- coding: utf-8 -*-',
    'import json, os, sys',
    'print("noise: 第三方库直接写到 stdout 的一行")',
    'sys.stdout.write(json.dumps({',
    '    "ok": True, "converter": "docx", "title": "中文标题：契约自检",',
    '    "sections": [{"heading": "H", "level": 1, "text": "正文含中文", "tables": []}],',
    '    "warnings": [], "sourceBytes": 1, "pages": 1,',
    '    "argv": sys.argv[1:],',
    '    "env": {"PYTHONIOENCODING": os.environ.get("PYTHONIOENCODING"), "PYTHONUTF8": os.environ.get("PYTHONUTF8")},',
    '}, ensure_ascii=False) + "\\n")',
    'sys.exit(3)',
  ].join('\n'), 'utf-8')
  const failScript = join(dir, 'fake_fail.py')
  // 失败方向：ok:false + 退出码 0 → 必须判失败（与上一个方向合起来才能证明"只看 ok"）
  writeFileSync(failScript, [
    'import json, sys',
    'sys.stdout.write(json.dumps({"ok": False, "error": "encrypted", "message": "该 PDF 已加密", "warnings": [], "sourceBytes": 1}) + "\\n")',
    'sys.exit(0)',
  ].join('\n'), 'utf-8')

  const oldYfw = process.env.YFW_DOC_TO_MD
  const oldPonos = process.env.PONOS_DOC_TO_MD
  try {
    process.env.YFW_DOC_TO_MD = okScript
    delete process.env.PONOS_DOC_TO_MD
    const res = await defaultConverter({
      absPath: docx, rel: 'a.docx', pythonPath: py,
      limits: { ...IMPORT_LIMITS, maxOcrPages: 7, maxTableRows: 11 },
    })
    assert.equal(res.ok, true, 'ok:true 必须判成功（即便进程退出码非 0）')
    const { argv } = res.value
    // argv 是 node → python 的**全部契约面**：漏一个 flag 就是静默降级（页数/表行护栏失效）
    for (const pair of [['--input', docx], ['--project', 'kb-import'], ['--max-ocr-pages', '7'], ['--max-table-rows', '11']]) {
      const i = argv.indexOf(pair[0])
      assert.ok(i >= 0, `argv 缺 ${pair[0]}：${JSON.stringify(argv)}`)
      assert.equal(argv[i + 1], pair[1], `${pair[0]} 的值不对`)
    }
    assert.equal(argv[0], '--input', '第一个参数就是 --input（脚本路径在 argv[0]，已由 python 侧切掉）')
    // 中文必须原样往返：不注入 PYTHONIOENCODING 时 Windows 上会按 cp936 编码 → node 按 utf8 解码成乱码
    assert.equal(res.value.title, '中文标题：契约自检')
    assert.equal(res.value.sections[0].text, '正文含中文')
    assert.equal(res.value.env.PYTHONIOENCODING, 'utf-8', '必须注入 PYTHONIOENCODING=utf-8')
    assert.equal(res.value.env.PYTHONUTF8, '1')

    process.env.YFW_DOC_TO_MD = failScript
    const res2 = await defaultConverter({ absPath: docx, rel: 'a.docx', pythonPath: py, limits: IMPORT_LIMITS })
    assert.equal(res2.ok, false, 'ok:false 必须判失败（即便退出码为 0）')
    assert.equal(res2.error, 'encrypted')
    assert.ok(res2.message.includes('加密'))
  } finally {
    if (oldYfw === undefined) delete process.env.YFW_DOC_TO_MD; else process.env.YFW_DOC_TO_MD = oldYfw
    if (oldPonos === undefined) delete process.env.PONOS_DOC_TO_MD; else process.env.PONOS_DOC_TO_MD = oldPonos
    rmSync(dir, { recursive: true, force: true })
  }
})

test('解析器候选表：env 未设时不得产出 cwd 相对路径候选', () => {
  const oldSkills = process.env.PONOS_SKILLS_DIR
  const oldHome = process.env.PONOS_HOME
  const oldDoc = process.env.PONOS_DOC_TO_MD
  const oldYfw = process.env.YFW_DOC_TO_MD
  delete process.env.PONOS_SKILLS_DIR
  delete process.env.PONOS_HOME
  delete process.env.PONOS_DOC_TO_MD
  delete process.env.YFW_DOC_TO_MD
  try {
    const cands = parserCandidates()
    assert.ok(cands.length > 0)
    // `join('', '_common', 'doc_to_md.py')` 是**相对路径**，其 existsSync 按 cwd 判定 ——
    // 谁的工作目录里恰好有同名文件，就会被当成技能目录里的解析器用上（静默换实现）
    for (const c of cands) assert.ok(isAbsolute(c), `候选必须是绝对路径：${c}`)
  } finally {
    if (oldSkills !== undefined) process.env.PONOS_SKILLS_DIR = oldSkills
    if (oldHome !== undefined) process.env.PONOS_HOME = oldHome
    if (oldDoc !== undefined) process.env.PONOS_DOC_TO_MD = oldDoc
    if (oldYfw !== undefined) process.env.YFW_DOC_TO_MD = oldYfw
  }
})

test('多选 2+ 个文件：产物平铺在空间根（不落进"以文件名命名的目录"），与整目录导入同口径', async () => {
  // 旧实现给多选文件源的 rel 也加 `${basename(文件)}/` 前缀 → 产物变成 `报告.docx/报告.md`；
  // 而同一文件"整目录导入"得到 `报告.md` ⇒ 同一物理文件入库两份、检索双命中，且两者台账键不同
  // （rel 不同 ⇒ 旧键不同）→ 第二次导入骗不过幂等，用户看到两份"报告"。
  const home = mkHome()
  const src = mkSrc({ '报告.docx': 'AAAA', 'a.docx': 'BBBB', '子目录/c.docx': 'CCCC' })
  // ① 整目录导入（目录源保留相对目录结构：前缀只对**目录源**生效）
  const byDir = await importFiles({ configDir: home, from: src, space: 'msel1', runDocToMd: fakeDocToMd })
  assert.deepEqual(byDir.results.map((x) => x.mdRel).sort(), ['a.md', '子目录/c.md', '报告.md'])
  // ② 多选 2 个文件（GUI 的 common case）：平铺进空间根，不得出现以文件名命名的目录
  const multi = await importFiles({
    configDir: home, from: [join(src, '报告.docx'), join(src, 'a.docx')], space: 'msel2', runDocToMd: fakeDocToMd,
  })
  assert.deepEqual(multi.summary, { total: 2, imported: 2, skipped: 0, rejected: 0, failed: 0 })
  assert.deepEqual(multi.results.map((x) => x.mdRel).sort(), ['a.md', '报告.md'])
  const root2 = spaceRootOf(home, 'msel2')
  assert.deepEqual(readdirSync(root2).filter((n) => !n.startsWith('.')).sort(), ['a.md', '报告.md'],
    '空间根只应有平铺的 md，不得有 报告.docx/ 这类"以文件名命名的目录"')
  // ③ 同一物理文件换入口（多选单个文件 / 再走整目录）→ 同一 mdRel + 同一台账键 → 跳过而非重复入库
  const again = await importFiles({ configDir: home, from: [join(src, '报告.docx')], space: 'msel2', runDocToMd: fakeDocToMd })
  assert.equal(again.results[0].status, 'skipped', '同一物理文件必须幂等（不因入口不同而重复入库）')
  assert.equal(again.results[0].mdRel, '报告.md')
  const byDirAgain = await importFiles({ configDir: home, from: src, space: 'msel2', runDocToMd: fakeDocToMd })
  assert.deepEqual(Object.fromEntries(byDirAgain.results.map((x) => [x.mdRel, x.status])),
    { 'a.md': 'skipped', '报告.md': 'skipped', '子目录/c.md': 'imported' },
    '整目录导入与多选导入必须共用同一台账键/同一产物名')
  assert.equal(Object.keys(ledgerOf(root2).files).length, 3)
  rmSync(home, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
})
