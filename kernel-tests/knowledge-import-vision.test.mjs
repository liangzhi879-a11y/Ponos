// kernel-tests/knowledge-import-vision.test.mjs —— 扫描件/图片的**视觉模型表格提取**回归
//
// 纪律（与 knowledge-import.test.mjs 同）：**不启动 bridge、不真的调模型、不加载 OCR 模型**。
// 视觉调用是注入的假实现（`visionCall`），转换器也是注入的假实现 —— 这里钉的是本模块
// 负责的那一层：开关判定（配了才调）、表格回填到"对的那一页"、页数护栏、失败不影响导入、
// 临时页面图片目录的清理、以及 env 名兼容（PONOS_VISION_* / YFW_VISION_*）。
//
// 为什么这几条必须钉住（都是会静默出错、且用户看不出来的）：
//   · 开关判定错了（没配也调）→ 每次导入都白等一次网络超时；
//   · 表格落到别的页 → 用户看到"第 2 页有表"而实际是第 1 页的内容（比没有更坏：看起来是对的）；
//   · 临时 PNG 不清理 → 每次导入往系统临时目录里留几十 MB，没人会发现；
//   · 视觉失败让导入失败 → 明明正文 OCR 成功了，却因为"表格"这一增益丢掉整篇。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import {
  importDocuments, augmentTablesViaVision, parseMarkdownTables, safeRmDir, IMPORT_LIMITS,
} from '../kernel/knowledge-import.mjs'
import { visionEnv, visionAvailable, visionFromEnv } from '../kernel/provider.mjs'

const KERNEL = join(dirname(fileURLToPath(import.meta.url)), '..', 'kernel', 'cli.mjs')

// 本文件建的临时目录统一登记、**跑完即清**。
// 为什么必须清：跑一轮就留一批目录在系统临时目录里（实测 7~16 个），谁都不会去删。
// 这里**不用** safeRmDir：它的守卫只认 `yfw-kbimg-` 前缀（那是生产侧"只删自己渲的页面图目录"的
// 护栏，另有专门用例覆盖）；而夹具还有 `yfw-kbvis-`/`yfw-kbvsrc-` 等前缀，是测试自己的东西，
// 直接 rmSync 即可 —— 不能为了清理方便去放宽生产守卫。
const createdDirs = []
function mkTmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix))
  createdDirs.push(d)
  return d
}
after(() => {
  for (const d of createdDirs) rmSync(d, { recursive: true, force: true })
})

function mkHome() {
  const dir = mkTmp('yfw-kbvis-')
  writeFileSync(join(dir, 'config.json'), '{"model":"fake"}')
  return dir
}
function mkSrc(files) {
  const dir = mkTmp('yfw-kbvsrc-')
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, ...rel.split('/'))
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content, 'utf-8')
  }
  return dir
}

/** 假的"扫描件 PDF 解析结果"：两页，页面图由测试自己造（真文件，`augmentTablesViaVision` 会 stat 它们） */
function scannedData(imgDir, pages = 2) {
  mkdirSync(imgDir, { recursive: true })
  const pageImages = []
  for (let i = 1; i <= pages; i += 1) {
    const p = join(imgDir, `page-${i}.png`)
    writeFileSync(p, 'fakepng')
    pageImages.push({ page: i, path: p })
  }
  return {
    converter: 'pdf-ocr', title: '扫描件', pages, pageImages,
    sections: Array.from({ length: pages }, (_, i) => ({
      heading: `第 ${i + 1} 页`, level: 1, text: `第${i + 1}页的OCR文字`, tables: [],
    })),
    warnings: [],
  }
}
/** 假转换器：返回给定的 data（并记录收到的 pageImagesDir，用于验证"没配置就不渲染"） */
const convReturning = (data, seen) => (o) => {
  if (seen) seen.push(o)
  return Promise.resolve({ ok: true, value: data })
}
/** 假转换器：把图片渲进调用方给的目录（模拟 python 的 --emit-page-images 行为） */
const convScan = (seen) => (o) => {
  if (seen) seen.push(o)
  const data = scannedData(o.pageImagesDir || mkTmp('yfw-kbimg-fake-'), 2)
  // 调用方没给目录（= 不该渲染）时不留页面图，模拟"未请求就不产出图"
  if (!o.pageImagesDir) delete data.pageImages
  return Promise.resolve({ ok: true, value: data })
}

// ---------------------------------------------------------------------------
// parseMarkdownTables
// ---------------------------------------------------------------------------

test('表格解析：标准 Markdown 表格 → 表格数组（外层=多个表格，内层=行）', () => {
  const md = [
    '| 科目 | 2025年 | 2026年 |',
    '| --- | --- | --- |',
    '| 人员人工 | 100 | 120 |',
    '| 直接投入 | 50 | 66 |',
  ].join('\n')
  // 形状与 `section.tables` / `renderBody` 的契约一致：一个 section 可以有多个表格
  assert.deepEqual(parseMarkdownTables(md), [[
    ['科目', '2025年', '2026年'],
    ['人员人工', '100', '120'],
    ['直接投入', '50', '66'],
  ]])
})

test('表格解析：多个表格各自成表；解释性文字被自然丢弃；NONE → 空', () => {
  const md = [
    '这是第一个表：',
    '| A | B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '说明文字（不该进表格）',
    '| C | D |',
    '| - | - |',
    '| 3 | 4 |',
  ].join('\n')
  assert.deepEqual(parseMarkdownTables(md), [
    [['A', 'B'], ['1', '2']],
    [['C', 'D'], ['3', '4']],
  ])
  assert.deepEqual(parseMarkdownTables('NONE'), [])
  assert.deepEqual(parseMarkdownTables(''), [])
  assert.deepEqual(parseMarkdownTables(null), [])
})

test('表格解析：单元格里的转义竖线不当列分隔；空行不成表', () => {
  assert.deepEqual(parseMarkdownTables('| a\\|b | c |\n| --- | --- |\n| 1 | 2 |'),
    [[['a|b', 'c'], ['1', '2']]])
  assert.deepEqual(parseMarkdownTables('|  |  |\n| --- | --- |'), [])
})

// ---------------------------------------------------------------------------
// augmentTablesViaVision
// ---------------------------------------------------------------------------

test('视觉取表：表格回填到**对应页**的章节（不是第一页）', async () => {
  const data = scannedData(mkTmp('yfw-kbimg-'))
  const warnings = []
  const summary = await augmentTablesViaVision({
    data, warnings,
    visionCall: async (p) => (p.endsWith('page-2.png')
      ? '| 项目 | 金额 |\n| --- | --- |\n| 材料费 | 320 |'
      : 'NONE'),
  })
  assert.equal(summary.tables, 1)
  assert.equal(summary.pages, 2)          // 两页都成功处理过（第 1 页答 NONE 也算处理成功）
  assert.equal(summary.attempted, 2)
  assert.deepEqual(data.sections[0].tables, [], '第 1 页不该有表')
  assert.deepEqual(data.sections[1].tables, [[['项目', '金额'], ['材料费', '320']]])
  assert.equal(warnings.length, 0)
})

test('视觉取表：单张图片（无标题章节）→ 落到唯一章节', async () => {
  const dir = mkTmp('yfw-kbimg-')
  const img = join(dir, 'scan.png')
  writeFileSync(img, 'fakepng')
  const data = {
    converter: 'ocr', title: null, pages: 1, pageImages: [{ page: 1, path: img }],
    sections: [{ heading: null, level: 0, text: 'OCR 文字', tables: [] }],
  }
  const s = await augmentTablesViaVision({ data, visionCall: async () => '| A |\n| --- |\n| 1 |' })
  assert.equal(s.tables, 1)
  assert.deepEqual(data.sections[0].tables, [[['A'], ['1']]])
})

test('视觉取表：页数超上限 → 截断 + 出声（不静默少给）', async () => {
  const data = scannedData(mkTmp('yfw-kbimg-'), 5)
  const warnings = []
  const calls = []
  const s = await augmentTablesViaVision({
    data, maxPages: 2, warnings,
    visionCall: async (p) => { calls.push(p); return 'NONE' },
  })
  assert.equal(calls.length, 2, '只该调 2 次（页数上限）')
  assert.equal(s.truncated, true)
  assert.equal(s.attempted, 2)
  assert.ok(warnings.some((w) => w.includes('2/5')), `应有截断提示，实际：${JSON.stringify(warnings)}`)
})

test('视觉取表：调用抛错/图片丢失 → 记账不抛出（正文不受影响）', async () => {
  const data = scannedData(mkTmp('yfw-kbimg-'))
  data.pageImages.push({ page: 3, path: join(tmpdir(), 'not-exist-' + Date.now(), 'x.png') })
  const s = await augmentTablesViaVision({
    data,
    visionCall: async (p) => { if (p.includes('page-1')) throw new Error('模型 500'); return 'NONE' },
  })
  assert.equal(s.errors.length, 2, `应记 2 条错误，实际 ${JSON.stringify(s.errors)}`)
  assert.ok(s.errors.some((e) => e.message.includes('模型 500')))
  assert.ok(s.errors.some((e) => e.message.includes('图片不存在')))
  assert.equal(s.tables, 0)
})

test('视觉取表：没有页面图片 → skipped=no-page-images（不发调用）', async () => {
  let called = 0
  const s = await augmentTablesViaVision({
    data: { sections: [] }, visionCall: async () => { called += 1; return '' },
  })
  assert.equal(called, 0)
  assert.equal(s.skipped, 'no-page-images')
})

// ---------------------------------------------------------------------------
// importDocuments 的开关判定与整批行为
// ---------------------------------------------------------------------------

test('未配置视觉模型：不渲染页面图、不发调用，报告给出 not-configured', async () => {
  const home = mkHome()
  const src = mkSrc({ 'scan.pdf': 'x' })
  const seen = []
  const r = await importDocuments({
    configDir: home, from: src, space: '扫描件',
    converter: convScan(seen), visionAvailable: false,
    visionCall: async () => { throw new Error('不该被调用') },
  })
  assert.equal(r.ok, true)
  assert.equal(r.counts.converted, 1)
  assert.equal(seen[0].pageImagesDir, null, '未配置视觉模型时不得要求渲染页面图（省磁盘/耗时）')
  assert.equal(r.vision.configured, false)
  assert.equal(r.vision.skipped, 'not-configured')
  assert.equal(r.vision.used, false)
  assert.equal(r.vision.tables, 0)
})

test('配置了视觉模型：页面图交给视觉 → 表格进入 md，报告计数正确', async () => {
  const home = mkHome()
  const src = mkSrc({ 'scan.pdf': 'x' })
  const seen = []
  const r = await importDocuments({
    configDir: home, from: src, space: '扫描件',
    converter: convScan(seen), visionAvailable: true,
    visionCall: async (p) => (p.endsWith('page-1.png')
      ? '| 科目 | 金额 |\n| --- | --- |\n| 材料费 | 320 |' : 'NONE'),
  })
  assert.equal(r.ok, true)
  assert.equal(typeof seen[0].pageImagesDir, 'string', '配置了就该要页面图')
  assert.equal(r.vision.configured, true)
  assert.equal(r.vision.used, true)
  assert.equal(r.vision.tables, 1)
  assert.equal(r.vision.pages, 2)
  assert.equal(r.vision.skipped, null)
  assert.equal(r.converted[0].vision.tables, 1)
  const md = readFileSync(join(r.spaceRoot, ...r.converted[0].out.split('/')), 'utf-8')
  assert.ok(md.includes('| 材料费 | 320 |'), `md 里应有视觉提取的表格：\n${md}`)
})

test('visionTables=false：显式关闭（配置了也不调）', async () => {
  const home = mkHome()
  const src = mkSrc({ 'scan.pdf': 'x' })
  let called = 0
  const seen = []
  const r = await importDocuments({
    configDir: home, from: src, space: '关闭',
    converter: convScan(seen), visionAvailable: true, visionTables: false,
    visionCall: async () => { called += 1; return 'NONE' },
  })
  assert.equal(called, 0)
  assert.equal(seen[0].pageImagesDir, null)
  assert.equal(r.vision.skipped, 'disabled')
})

test('视觉调用炸了：导入仍然成功（表格是增益，正文不能跟着丢）', async () => {
  const home = mkHome()
  const src = mkSrc({ 'scan.pdf': 'x' })
  const r = await importDocuments({
    configDir: home, from: src, space: '容错',
    converter: convScan(), visionAvailable: true,
    visionCall: async () => { throw new Error('网络断了') },
  })
  assert.equal(r.ok, true)
  assert.equal(r.counts.converted, 1, '视觉失败不得让整篇导入失败')
  assert.equal(r.vision.tables, 0)
  assert.ok(r.warnings.some((w) => w.includes('网络断了')), `应有告警：${JSON.stringify(r.warnings)}`)
  const md = readFileSync(join(r.spaceRoot, ...r.converted[0].out.split('/')), 'utf-8')
  assert.ok(md.includes('第1页的OCR文字'), '正文必须还在')
})

test('视觉用过的临时页面图目录被清理（无论成败）', async () => {
  const home = mkHome()
  const src = mkSrc({ 'a.pdf': 'x', 'b.pdf': 'y' })
  const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('yfw-kbimg-')))
  // a.pdf 正常、b.pdf 视觉调用抛错 —— 两条路径都要清
  await importDocuments({
    configDir: home, from: src, space: '清理',
    converter: convScan(), visionAvailable: true,
    visionCall: async (p) => { if (p.includes('yfw-kbimg-')) throw new Error('boom'); return 'NONE' },
  })
  const after = readdirSync(tmpdir()).filter((n) => n.startsWith('yfw-kbimg-') && !before.has(n))
  assert.deepEqual(after, [], `临时目录没清干净：${JSON.stringify(after)}`)
})

test('safeRmDir：只删系统临时目录下的 yfw-kbimg-*（拒绝误删用户目录）', () => {
  // 刻意用**非** yfw-kbimg- 前缀：这正是"守卫拒绝删除"的样本，所以不能走 mkTmp（会被 after 清掉），
  // 测试末尾自己收尾。
  const keep = mkdtempSync(join(tmpdir(), 'yfw-userdata-'))
  writeFileSync(join(keep, 'important.txt'), 'x')
  assert.equal(safeRmDir(keep), false, '非 yfw-kbimg- 前缀的目录必须拒绝')
  assert.equal(existsSync(join(keep, 'important.txt')), true, '拒绝后内容必须原封不动')
  rmSync(keep, { recursive: true, force: true })
  const mine = mkTmp('yfw-kbimg-')
  writeFileSync(join(mine, 'p.png'), 'x')
  assert.equal(safeRmDir(mine), true)
  assert.equal(existsSync(mine), false)
})

test('dry-run：不调视觉（预览不产生费用），但 configured 如实', async () => {
  // 这条钉的是**提前返回路径**上的字段正确性：dry-run 在逐文件循环之前就 return，
  // 早期实现把 `configured` 放在函数结尾赋值 ⇒ dry-run 报告里恒为 false，
  // 已配好视觉模型的用户会看到"未配置"提示（实测踩到）。故断言它必须如实。
  const home = mkHome()
  const src = mkSrc({ 'scan.pdf': 'x' })
  let called = 0
  const r = await importDocuments({
    configDir: home, from: src, space: '预览',
    converter: convScan(), visionAvailable: true, dryRun: true,
    visionCall: async () => { called += 1; return 'NONE' },
  })
  assert.equal(called, 0, 'dry-run 不该发起付费的视觉调用')
  assert.equal(r.vision.configured, true, 'dry-run 也必须如实反映"配了视觉模型"')
  assert.equal(r.vision.used, false)
  assert.equal(r.vision.skipped, 'dry-run')
  // 未配置时 dry-run 的口径仍是 not-configured（GUI 据此提示去配）
  const r2 = await importDocuments({
    configDir: home, from: src, space: '预览2',
    converter: convScan(), visionAvailable: false, dryRun: true,
  })
  assert.equal(r2.vision.configured, false)
  assert.equal(r2.vision.skipped, 'not-configured')
})

test('视觉页数上限：limits.maxVisionPages 传给转换器与视觉通道', async () => {
  const home = mkHome()
  const src = mkSrc({ 'scan.pdf': 'x' })
  const data = scannedData(mkTmp('yfw-kbimg-'), 4)
  let calls = 0
  const r = await importDocuments({
    configDir: home, from: src, space: '限额',
    converter: convReturning(data), visionAvailable: true,
    limits: { maxVisionPages: 1 },
    visionCall: async () => { calls += 1; return 'NONE' },
  })
  assert.equal(calls, 1)
  assert.equal(r.vision.pages, 1)
  // 截断必须**出现在报告里**（此前它被写进一个空的 data.warnings 而报告看不到 —— 属实测缺陷）
  assert.ok(r.converted[0].warnings.some((w) => w.includes('1/4')),
    `截断提示应出现在该文件的 warnings 里：${JSON.stringify(r.converted[0].warnings)}`)
})

// ---------------------------------------------------------------------------
// env 名兼容（本次修的真缺陷：bridge 注入 YFW_* 而内核只读 PONOS_*）
// ---------------------------------------------------------------------------

test('视觉 env：YFW_VISION_* 也能被内核读到（修复"用户配好了却判未配置"）', () => {
  const yfw = { YFW_VISION_BASE_URL: 'https://gw/v1', YFW_VISION_MODEL: 'MiniMax-M3', YFW_VISION_AUTH_TOKEN: 't' }
  assert.equal(visionAvailable(yfw), true, 'YFW_ 前缀必须被认（bridge 注入的就是它）')
  assert.equal(visionFromEnv(yfw)?.model, 'MiniMax-M3')
  assert.equal(visionFromEnv(yfw)?.configured, true)
  // PONOS_ 仍是权威名且优先（两个都在时以 PONOS_ 为准）
  const both = { ...yfw, PONOS_VISION_BASE_URL: 'https://gw2/v1', PONOS_VISION_MODEL: 'other' }
  assert.equal(visionEnv(both).model, 'other')
  // 缺 baseUrl 或 model 视为未配置（与 Vision 工具同一判定）
  assert.equal(visionAvailable({ YFW_VISION_MODEL: 'm' }), false)
  assert.equal(visionAvailable({ YFW_VISION_BASE_URL: 'u' }), false)
  assert.equal(visionAvailable({}), false)
})

// ---------------------------------------------------------------------------
// CLI 参数登记（真进程：漏登记会被 parseArgs 静默忽略）
// ---------------------------------------------------------------------------

test('CLI：--vision-tables 非法值必须报错（不得静默忽略后照常调模型）', () => {
  const home = mkHome()
  const src = mkSrc({ 'a.txt': 'hello' })
  const run = (extra) => execFileSync(process.execPath, [
    KERNEL, '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--knowledge', 'import', '--src', src, '--space', 'cli', ...extra,
  ], { env: { ...process.env, PONOS_HOME: home }, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
  let err = null
  try { run(['--vision-tables', 'maybe']) } catch (e) { err = String(e.stderr || e.message) }
  assert.ok(err && err.includes('bad-vision-tables'), `应报 bad-vision-tables，实际：${err}`)
  let err2 = null
  try { run(['--max-vision-pages', 'abc']) } catch (e) { err2 = String(e.stderr || e.message) }
  assert.ok(err2 && err2.includes('bad-max-vision-pages'), `应报 bad-max-vision-pages，实际：${err2}`)
  // 合法值必须被接受并进入报告（0 是合法值：显式"不交给视觉模型"）
  const out = run(['--vision-tables', 'off', '--max-vision-pages', '0'])
  const line = out.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop()
  const rep = JSON.parse(line)
  assert.equal(rep.vision.configured, false)
  assert.equal(rep.vision.skipped, 'disabled')
  assert.equal(rep.counts.converted, 1)
})

test('IMPORT_LIMITS 暴露 maxVisionPages 默认值（20）', () => {
  assert.equal(IMPORT_LIMITS.maxVisionPages, 20)
})
