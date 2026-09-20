// kit/lib/brand-rules.test.mjs —— CT10（品牌声明点 ↔ 品牌真源）的判据
//
// 全部用**临时目录夹具**（`mkdtempSync` + 显式 `files`，不依赖 git 与本机状态）。
// ★ 夹具的品牌名**故意与真仓不同**（`FxApp` / `fxk`）：判据若在规则里硬编码 `YFWorking` / `ponos`，
//   这里就会红 —— 即"判据全部来自真源"这条口径是**可证伪**的（这正是"改真源 = 重新定义品牌"的前提）。
// ★ 反向自证：每条"红"用例都把夹具改坏成另一种形态，并断言 finding 的 file/expected/actual/line 正确。
// ★ 夹具要造的声明点**从 `REQUIRED_DECLARATIONS` 推导**（见 `fixtureDeclarations()`）—— 真源加声明点时，
//   这里报的是"夹具缺 XXX 的取值位置定义"这句人话，而不是一堆看不出所以然的"结构不合法"红
//   （8 → 14 那次改真源就吃过这个亏：规则加了、夹具没加 ⇒ 9 条测试红，却看不出是夹具的问题）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readTracked, trackedFiles } from './scan.mjs'
import { brandCheck, BRAND_TRUTH, REQUIRED_DECLARATIONS } from './brand-rules.mjs'

/** kit/lib → 仓库根（真仓自检用） */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// ── 夹具：各声明点**行号刻意已知**（好钉住 finding.line 是真文件里的行，不是位移反推） ──────

const FX_APP = 'FxApp'
const FX_KERNEL = 'fxk'
const FX_APP_LABEL = `${FX_APP} 应用（${FX_KERNEL} 内核版）`
const FX_KERNEL_LABEL = `${FX_KERNEL} 内核`

/** 行号（1 开始）—— 与下面的 fixture 文本一一对应，测试里直接引用这些常量 */
const LINE = {
  ymlProduct: 3, ymlShortcut: 4, ymlCopyright: 5, ymlAppId: 2,
  htmlTitle: 3, htmlMeta: 4,
  pkgName: 2, pkgDescription: 3,
  kernelPkgName: 2, kernelPkgDescription: 3,
  vmAppLabel: 2, vmKernelLabel: 3,
}

const YML = `# 夹具身份（appId/productName/shortcutName/copyright 各一行）\n`
  + `appId: com.fx.desktop\n`
  + `productName: ${FX_APP}\n`
  + `shortcutName: ${FX_APP}\n`
  + `copyright: Copyright © 2026 ${FX_APP}\n`
const HTML = `<!doctype html>\n<html><head>\n  <title>${FX_APP}</title>\n`
  + `  <meta name="description" content="${FX_APP} 桌面应用（${FX_KERNEL} 内核版）">\n</head></html>\n`
const VM = `// 夹具版本线\n//   1. APP_VERSION     — ${FX_APP_LABEL}\n//   2. KERNEL_VERSION  — ${FX_KERNEL_LABEL}\n`
  + "export const APP_VERSION = 'dev 1.0.0'\nexport const KERNEL_VERSION = 'dev 0.1'\n"
const FX_DESC = `${FX_APP} 桌面应用（${FX_KERNEL} 内核版）`
const PKG = JSON.stringify({ name: 'fx-pkg', description: FX_DESC, version: '1.0.0' }, null, 2) + '\n'
const KERNEL_PKG = JSON.stringify({ name: `${FX_KERNEL}-kernel`, description: `${FX_KERNEL} 内核独立部署包（零 npm 依赖）` }, null, 2) + '\n'

/** 台账（`lines[]` 的两条 label 与真源一致；label 行号是"id 行的下一行"） */
const VERSIONS = JSON.stringify({
  version: 1,
  lines: [
    { id: 'APP_VERSION', label: FX_APP_LABEL, file: 'version.mjs', locator: { kind: 'const', name: 'APP_VERSION' }, value: 'dev 1.0.0' },
    { id: 'KERNEL_VERSION', label: FX_KERNEL_LABEL, file: 'version.mjs', locator: { kind: 'const', name: 'KERNEL_VERSION' }, value: 'dev 0.1' },
  ],
}, null, 2) + '\n'

/** 夹具造的**每个文件**的内容（key = 相对路径）*/
const FX_FILES = {
  'electron-builder.yml': YML,
  'index.html': HTML,
  'version.mjs': VM,
  'package.json': PKG,
  'kernel/package.json': KERNEL_PKG,
  'kit/manifest/versions.json': VERSIONS,
}

/**
 * 夹具里每条声明点的**取值位置**（file / kind / 取值位置 / expects）。
 *
 * ★ 分工：id 清单**从 `REQUIRED_DECLARATIONS` 取**（不在这里再抄一遍）；本表只回答"该 id 指向
 *   哪个文件的哪个位置、期望什么"。两者不一致 ⇒ `fixtureDeclarations()` 直接抛人话。
 * ★ 为什么不能全自动推：门禁只知道"必须有这些 id"，"取值位置"是**真源的知识**，夹具必须自己给出
 *   （新 id 指向的文件得有人造出来）—— 能做到的是**"缺了就立刻指名道姓地报错"**，而不是自动补齐。
 */
const FX_DECL_SPEC = {
  'product-name': { file: 'electron-builder.yml', kind: 'yaml-scalar', key: 'productName', expects: { layer: 'app' } },
  'window-title': { file: 'index.html', kind: 'html-title', expects: { layer: 'app' } },
  // 复核后补的 6 条（用户可见 / 对外分发）：新 kind `html-meta-description`、yaml 的 shortcutName/copyright、
  // 以及两个此前**完全没纳管**的内核包声明点。
  'meta-description': { file: 'index.html', kind: 'html-meta-description', expects: { layer: 'app' } },
  'shortcut-name': { file: 'electron-builder.yml', kind: 'yaml-scalar', key: 'shortcutName', expects: { layer: 'app' } },
  'copyright': { file: 'electron-builder.yml', kind: 'yaml-scalar', key: 'copyright', expects: { layer: 'app' } },
  'pkg-description': { file: 'package.json', kind: 'json-key', key: 'description', expects: { layer: 'app' } },
  'kernel-pkg-name': { file: 'kernel/package.json', kind: 'json-key', key: 'name', expects: { layer: 'kernel' } },
  'kernel-pkg-description': { file: 'kernel/package.json', kind: 'json-key', key: 'description', expects: { layer: 'kernel' } },
  // 8 条基础声明点（字面量两条仍钉字面量：重新定义品牌**不该**顺手改安装/发布身份）
  'app-id': { file: 'electron-builder.yml', kind: 'yaml-scalar', key: 'appId', expects: { literal: 'com.fx.desktop' } },
  'npm-name': { file: 'package.json', kind: 'json-key', key: 'name', expects: { literal: 'fx-pkg' } },
  'app-label': { file: 'version.mjs', kind: 'comment-label', constName: 'APP_VERSION', expects: { layer: 'app' } },
  'kernel-label': { file: 'version.mjs', kind: 'comment-label', constName: 'KERNEL_VERSION', expects: { layer: 'kernel' } },
  'lines-label-app': { file: 'kit/manifest/versions.json', kind: 'json-pointer', pointer: 'lines[id=APP_VERSION].label', expects: { layer: 'app' } },
  'lines-label-kernel': { file: 'kit/manifest/versions.json', kind: 'json-pointer', pointer: 'lines[id=KERNEL_VERSION].label', expects: { layer: 'kernel' } },
}

/**
 * 夹具的声明点清单 = `REQUIRED_DECLARATIONS` 逐条映射（顺序也照它）。
 * 不一致时**抛人话**（否则会退化成"结构不合法"的红，看不出是夹具没跟上）。
 */
function fixtureDeclarations() {
  const missing = REQUIRED_DECLARATIONS.filter((id) => !FX_DECL_SPEC[id])
  const extra = Object.keys(FX_DECL_SPEC).filter((id) => !REQUIRED_DECLARATIONS.includes(id))
  if (missing.length || extra.length) {
    throw new Error('夹具的声明点表 FX_DECL_SPEC 与品牌规则的 REQUIRED_DECLARATIONS 不一致：'
      + `缺 ${missing.join(' / ') || '（无）'}、多 ${extra.join(' / ') || '（无）'}`
      + ' —— 请在本文件的 FX_DECL_SPEC 里补上该 id 的取值位置，并在 FX_FILES 里**真的造出**它指向的文件')
  }
  const decls = REQUIRED_DECLARATIONS.map((id) => ({ id, ...FX_DECL_SPEC[id], why: `夹具：${id}`, severityIfWrong: 'red' }))
  const lack = [...new Set(decls.map((d) => d.file))].filter((f) => !(f in FX_FILES))
  if (lack.length) {
    throw new Error(`夹具没造这些文件：${lack.join(' / ')}（声明点指向的文件必须真的存在，`
      + '否则红的是"取不到值"、验不到想验的那条判据）')
  }
  return decls
}

/** 品牌真源（夹具版；14 条声明点由 `fixtureDeclarations()` 推导，取值位置指向夹具里的已知行） */
function fixtureTruth({ layers = null, declarations = null } = {}) {
  const derived = fixtureDeclarations()   // ★ 先跑一致性守卫（即便本用例传了自定义 declarations）
  return {
    schemaVersion: 1,
    note: '夹具品牌真源',
    layers: layers || [
      { id: 'app', name: FX_APP, note: '夹具应用层' },
      { id: 'kernel', name: FX_KERNEL, note: '夹具内核层' },
    ],
    brandZh: { name: '夹具中文名', where: '夹具标识资源用此名' },
    declarations: declarations || derived,
    retiredAliases: [{ alias: 'Ponos-Turbo', replaceWith: 'ponos', layer: 'kernel', why: '夹具：内核层统一为 ponos（无 turbo）', scope: 'declarations' }],
    // ★ 真源结构现在会真校验这两块（`counts` 要带口径、`recompute` 要可复算、`why` 要说明为何不纳管）
    knownWidespread: [{
      alias: 'Ponos-Turbo',
      counts: { exactCaseSensitive: { lines: 7, files: 3 }, aliasFamily: { lines: 9, files: 4 } },
      measuredAt: 'abc1234',
      recompute: 'git grep -F "Ponos-Turbo" HEAD | wc -l',
      why: '夹具：散在 kernel/、kernel-tests/ 与 docs 的叙述文本里（不在本门禁范围）',
    }],
  }
}

/**
 * 写一个"品牌齐全"的夹具仓。
 * @param {{overrides?:object, truth?:object, drop?:string[]}} opts
 *   `overrides` 按**相对路径**覆盖文件内容（`null` = 删掉该文件）；`truth` 覆盖品牌真源对象。
 */
function makeFixture({ overrides = {}, truth = null, drop = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yfw-brand-'))
  const files = { 'kit/manifest/brand.json': JSON.stringify(truth || fixtureTruth(), null, 2) + '\n', ...FX_FILES }
  for (const [rel, content] of Object.entries({ ...files, ...overrides })) {
    if (drop.includes(rel) || content === null) continue
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
  }
  const list = Object.keys(files).filter((rel) => !drop.includes(rel))
  return { root, files: list, run: () => brandCheck({ readTracked: (f) => readTracked({ root, file: f }), files: list }) }
}

const cleanup = (t, root) => t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }))

/** 某段文本里含 `needle` 的那一行（1 开始）—— 纯文本搜索，不经被测实现（行号断言的独立期望值） */
const lineWith = (text, needle) => text.split('\n').findIndex((l) => l.includes(needle)) + 1

// ── 全绿基线 ────────────────────────────────────────────────────────────────

test('夹具全绿：14 条声明点逐条对账（evaluated === 14），一条 finding 都没有', (t) => {
  const fx = makeFixture()
  cleanup(t, fx.root)
  const out = fx.run()
  assert.deepEqual(out.findings, [], `夹具应当全绿：${JSON.stringify(out.findings)}`)
  assert.equal(out.check.rule, 'CT10')
  assert.equal(out.check.passed, true)
  // ★ evaluated 必须如实 = 实际检查的声明点数（真源里 declaration 的条数）
  assert.equal(out.check.evaluated, 14)
  assert.equal(REQUIRED_DECLARATIONS.length, 14, '必须凑齐的 id 名单就是这 14 条（8 条基础 + 复核后补的 6 条对外/用户可见声明点）')
  assert.match(out.check.title, /品牌声明点/)
})

test('★ 判据全部来自真源：把**层名**改掉（连注释/台账/label/各声明点一起改）⇒ 仍全绿，规则里没有硬编码品牌名', (t) => {
  const app = 'ZetaApp'
  const kernel = 'zetak'
  const appLabel = `${app} 应用（${kernel} 内核版）`
  const kernelLabel = `${kernel} 内核`
  const truth = fixtureTruth({
    layers: [{ id: 'app', name: app, note: '重新定义' }, { id: 'kernel', name: kernel, note: '重新定义' }],
  })
  const fx = makeFixture({
    truth,
    overrides: {
      // **所有**带层名的声明点都按新层名改写（14 条里 12 条是层名型；两条字面量型不动）
      'version.mjs': `// 版本线\n//   1. APP_VERSION     — ${appLabel}\n//   2. KERNEL_VERSION  — ${kernelLabel}\n`
        + "export const APP_VERSION = 'dev 1.0.0'\nexport const KERNEL_VERSION = 'dev 0.1'\n",
      'electron-builder.yml': `appId: com.fx.desktop\nproductName: ${app}\nshortcutName: ${app}\n`
        + `copyright: Copyright © 2026 ${app}\n`,
      'index.html': `<!doctype html>\n<html><head>\n  <title>${app}</title>\n`
        + `  <meta name="description" content="${app} 桌面应用（${kernel} 内核版）">\n</head></html>\n`,
      'package.json': JSON.stringify({ name: 'fx-pkg', description: `${app} 桌面应用（${kernel} 内核版）`, version: '1.0.0' }, null, 2) + '\n',
      'kernel/package.json': JSON.stringify({ name: `${kernel}-kernel`, description: `${kernel} 内核独立部署包（零 npm 依赖）` }, null, 2) + '\n',
      'kit/manifest/versions.json': JSON.stringify({
        version: 1,
        lines: [
          { id: 'APP_VERSION', label: appLabel, file: 'version.mjs', value: 'dev 1.0.0' },
          { id: 'KERNEL_VERSION', label: kernelLabel, file: 'version.mjs', value: 'dev 0.1' },
        ],
      }, null, 2) + '\n',
    },
  })
  cleanup(t, fx.root)
  const out = fx.run()
  assert.deepEqual(out.findings, [], `层名改了、声明点跟着改了 ⇒ 必须全绿：${JSON.stringify(out.findings)}`)
  assert.equal(out.check.evaluated, 14, 'evaluated 不受层名影响（仍是 14 条）')
})

// ── (a) 层名 / 字面量不符 ⇒ 红（含 file / line / expected / actual）──────────

test('productName 改一个字母 ⇒ 红 1 条，file/line/expected/actual 都指向该声明点', (t) => {
  const fx = makeFixture({ overrides: { 'electron-builder.yml': YML.replace(`productName: ${FX_APP}`, 'productName: XFApp') } })
  cleanup(t, fx.root)
  const out = fx.run()
  assert.equal(out.check.passed, false)
  assert.equal(out.findings.length, 1, `只该有一条（安装身份那条仍然对）：${JSON.stringify(out.findings)}`)
  const f = out.findings[0]
  assert.equal(f.rule, 'CT10')
  assert.equal(f.severity, 'red')
  assert.equal(f.subject, 'product-name')
  assert.equal(f.file, 'electron-builder.yml')
  assert.equal(f.line, LINE.ymlProduct, '行号必须是真文件里的行号')
  assert.equal(f.expected, `层 app 的名称 "${FX_APP}"`)
  assert.equal(f.actual, 'XFApp')
  assert.match(f.hint, /electron-builder\.yml/, 'hint 必须说清改哪个文件')
  assert.match(f.hint, /brand\.json/, 'hint 必须给出"或改真源重新定义"这条出路')
  // evaluated 仍如实：14 条都检查了（1 条没过）
  assert.equal(out.check.evaluated, 14)
})

test('窗口标题写错 ⇒ 红（html-title 的行号取自 <title> 那一行）', (t) => {
  const fx = makeFixture({ overrides: { 'index.html': HTML.replace(`<title>${FX_APP}`, '<title>Legacy App') } })
  cleanup(t, fx.root)
  const f = fx.run().findings.find((x) => x.subject === 'window-title')
  assert.ok(f, '窗口标题错必须报红')
  assert.equal(f.file, 'index.html')
  assert.equal(f.line, LINE.htmlTitle)
  assert.equal(f.actual, 'Legacy App')
  assert.equal(f.expected, `层 app 的名称 "${FX_APP}"`)
})

test('appId / npm 包名（字面量型）改掉 ⇒ 红，expected 是字面量而不是层名', (t) => {
  const fx = makeFixture({
    overrides: {
      'electron-builder.yml': YML.replace('appId: com.fx.desktop', 'appId: com.other.app'),
      // ★ 只改**字面量**那条（name）；description 保持含层名 ⇒ 只有 name 该红
      'package.json': JSON.stringify({ name: 'renamed-pkg', description: FX_DESC, version: '1.0.0' }, null, 2),
    },
  })
  cleanup(t, fx.root)
  const out = fx.run()
  const appId = out.findings.find((x) => x.subject === 'app-id')
  const npm = out.findings.find((x) => x.subject === 'npm-name')
  assert.equal(appId.expected, '字面量 "com.fx.desktop"')
  assert.equal(appId.actual, 'com.other.app')
  assert.equal(appId.file, 'electron-builder.yml')
  assert.equal(appId.line, LINE.ymlAppId)
  assert.equal(npm.expected, '字面量 "fx-pkg"')
  assert.equal(npm.actual, 'renamed-pkg')
  assert.equal(npm.file, 'package.json')
  assert.equal(npm.line, LINE.pkgName)
  assert.equal(out.findings.length, 2)
})

test('★ 新 kind html-meta-description：摘要里没跟上层名 ⇒ 红（行号落在 <meta> 那一行）', (t) => {
  const fx = makeFixture({
    overrides: { 'index.html': HTML.replace(`content="${FX_APP} 桌面应用`, 'content="旧名 桌面应用') },
  })
  cleanup(t, fx.root)
  const f = fx.run().findings.find((x) => x.subject === 'meta-description')
  assert.ok(f, '页面摘要里的名字没跟上必须红')
  assert.equal(f.file, 'index.html')
  assert.equal(f.line, LINE.htmlMeta)
  assert.equal(f.actual, '旧名 桌面应用（fxk 内核版）')
  assert.equal(f.expected, `层 app 的名称 "${FX_APP}"`)
})

test('★ 新声明点 shortcut-name / copyright / 两个包摘要：各自错各自红（不是"只看 productName 就够了"）', (t) => {
  const fx = makeFixture({
    overrides: {
      'electron-builder.yml': YML.replace(`shortcutName: ${FX_APP}`, 'shortcutName: Legacy Shortcut'),
      'package.json': JSON.stringify({ name: 'fx-pkg', description: '另一个产品', version: '1.0.0' }, null, 2),
      'kernel/package.json': JSON.stringify({ name: 'ponos-old-kernel', description: `${FX_KERNEL} 内核独立部署包` }, null, 2),
    },
  })
  cleanup(t, fx.root)
  const out = fx.run()
  const shortcut = out.findings.find((x) => x.subject === 'shortcut-name')
  const pkgDesc = out.findings.find((x) => x.subject === 'pkg-description')
  const kernelName = out.findings.find((x) => x.subject === 'kernel-pkg-name')
  // copyright 的值仍然含 app 名 ⇒ 不许红（"只红该红的"）
  assert.equal(out.findings.some((x) => x.subject === 'copyright'), false, 'copyright 没坏就不该红')
  assert.ok(shortcut, '快捷方式名没跟上必须红（它与 productName 是**两个**字段，各自会漂移）')
  assert.equal(shortcut.line, LINE.ymlShortcut)
  assert.equal(shortcut.actual, 'Legacy Shortcut')
  assert.ok(pkgDesc, 'npm 包摘要没跟上必须红')
  assert.equal(pkgDesc.line, LINE.pkgDescription)
  assert.ok(kernelName, '内核包名没跟着内核层名必须红')
  assert.equal(kernelName.file, 'kernel/package.json')
  assert.equal(kernelName.line, LINE.kernelPkgName)
  assert.equal(kernelName.expected, `层 kernel 的名称 "${FX_KERNEL}"`)
  assert.equal(kernelName.actual, 'ponos-old-kernel')
  assert.equal(out.findings.length, 3)
})

test('★ 内核包摘要里出现废弃别名 ⇒ 红（这正是"没登记的声明点会悄悄漂移"那个洞）', (t) => {
  // 刻意保留层名（`fxk 内核独立部署包（原 Ponos-turbo 版）`）⇒ 层判据**过**、只有别名判据该红
  const drifted = `${FX_KERNEL} 内核独立部署包（原 Ponos-turbo 版）`
  const fx = makeFixture({
    overrides: { 'kernel/package.json': JSON.stringify({ name: `${FX_KERNEL}-kernel`, description: drifted }, null, 2) + '\n' },
  })
  cleanup(t, fx.root)
  const out = fx.run()
  const f = out.findings.find((x) => x.subject === 'kernel-pkg-description')
  assert.ok(f, `内核包摘要里残留废弃别名必须红：${JSON.stringify(out.findings)}`)
  assert.equal(f.file, 'kernel/package.json')
  assert.equal(f.line, LINE.kernelPkgDescription)
  assert.equal(f.expected, '不含废弃别名 "Ponos-Turbo"（应替换为 "ponos"）')
  assert.equal(f.actual, drifted)
  assert.equal(out.findings.length, 1)

  // 另一半：摘要里**没有**内核层名（漂移）⇒ 层判据红
  const fx2 = makeFixture({
    overrides: { 'kernel/package.json': JSON.stringify({ name: `${FX_KERNEL}-kernel`, description: '独立的微内核运行时' }, null, 2) + '\n' },
  })
  cleanup(t, fx2.root)
  const f2 = fx2.run().findings.find((x) => x.subject === 'kernel-pkg-description')
  assert.ok(f2, '摘要里没有内核层名必须红')
  assert.equal(f2.expected, `层 kernel 的名称 "${FX_KERNEL}"`)
  assert.equal(f2.actual, '独立的微内核运行时')
  assert.equal(f2.line, LINE.kernelPkgDescription)
})

test('version.mjs 的 APP_VERSION 注释行丢了层名 ⇒ 红（comment-label 行号 = 那行注释）', (t) => {
  const fx = makeFixture({
    overrides: { 'version.mjs': VM.replace(`//   1. APP_VERSION     — ${FX_APP_LABEL}`, '//   1. APP_VERSION     — 应用线（内核版）') },
  })
  cleanup(t, fx.root)
  const f = fx.run().findings.find((x) => x.subject === 'app-label')
  assert.ok(f, '注释行不含层名必须报红')
  assert.equal(f.file, 'version.mjs')
  assert.equal(f.line, LINE.vmAppLabel)
  assert.equal(f.actual, '1. APP_VERSION     — 应用线（内核版）')
})

test('台账 lines[] 的 label 没跟上真源 ⇒ 红（json-pointer 定位到 label 那一行）', (t) => {
  const stale = JSON.parse(VERSIONS)
  stale.lines[1].label = '旧内核名 内核'
  const text = JSON.stringify(stale, null, 2) + '\n'
  const fx = makeFixture({ overrides: { 'kit/manifest/versions.json': text } })
  cleanup(t, fx.root)
  const f = fx.run().findings.find((x) => x.subject === 'lines-label-kernel')
  assert.ok(f, '台账 label 没跟上必须报红（它正是 sync 会重写的那个字段）')
  assert.equal(f.file, 'kit/manifest/versions.json')
  // 行号必须真的落在那条 label 上（且与"纯文本搜索"算出的行号一致）
  assert.equal(f.line, lineWith(text, '"label": "旧内核名 内核"'))
  assert.equal(text.split('\n')[f.line - 1].includes('旧内核名 内核'), true)
  assert.equal(f.actual, '旧内核名 内核')
  assert.equal(f.expected, `层 kernel 的名称 "${FX_KERNEL}"`)
})

// ── (b) 受管声明点里出现废弃别名 ⇒ 红（★ 不扫整文件、更不扫全仓）────────────

test('★ 内核注释里出现 Ponos-Turbo ⇒ 红（别名），期望文案含"应替换为"', (t) => {
  // 刻意保留层名（`fxk 内核（旧名 Ponos-Turbo）`）⇒ 层判据**过**、只有别名判据该红：
  // 两条判据各自独立（否则"别名红"可能是被层名红带出来的假象）
  const fx = makeFixture({
    overrides: { 'version.mjs': VM.replace(`//   2. KERNEL_VERSION  — ${FX_KERNEL_LABEL}`, '//   2. KERNEL_VERSION  — fxk 内核（旧名 Ponos-Turbo），独立可运行') },
  })
  cleanup(t, fx.root)
  const out = fx.run()
  const hits = out.findings.filter((x) => x.subject === 'kernel-label')
  assert.equal(hits.length, 1, `废弃别名必须红、且只红这一条：${JSON.stringify(out.findings)}`)
  const f = hits[0]
  assert.equal(f.expected, '不含废弃别名 "Ponos-Turbo"（应替换为 "ponos"）')
  assert.equal(f.file, 'version.mjs')
  assert.equal(f.line, LINE.vmKernelLabel)
  assert.match(f.hint, /kernel\/、kernel-tests\//, 'hint 必须点明"那批叙述文本不在门禁范围"，否则读者会以为要改全仓')
})

test('★ 别名匹配不区分大小写（ponos-TURBO / PONOS-turbo 同样命中）', (t) => {
  for (const spelling of ['ponos-TURBO', 'PONOS-turbo']) {
    const fx = makeFixture({
      overrides: { 'version.mjs': VM.replace(`//   2. KERNEL_VERSION  — ${FX_KERNEL_LABEL}`, `//   2. KERNEL_VERSION  — ${spelling} 内核`) },
    })
    cleanup(t, fx.root)
    assert.ok(fx.run().findings.some((x) => x.subject === 'kernel-label'), `${spelling} 必须命中废弃别名`)
  }
})

test('★ 别名判据覆盖新声明点（copyright 段里的小写 ponos-turbo 也要红，且层判据仍过）', (t) => {
  const fx = makeFixture({
    overrides: { 'electron-builder.yml': YML.replace(`copyright: Copyright © 2026 ${FX_APP}`, `copyright: Copyright © 2026 ${FX_APP}（原 ponos-turbo 版）`) },
  })
  cleanup(t, fx.root)
  const out = fx.run()
  const f = out.findings.find((x) => x.subject === 'copyright')
  assert.ok(f, `新加进受管范围的那一段文本也要查废弃别名：${JSON.stringify(out.findings)}`)
  assert.equal(f.expected, '不含废弃别名 "Ponos-Turbo"（应替换为 "ponos"）')
  assert.equal(f.line, LINE.ymlCopyright)
  assert.match(String(f.actual), /ponos-turbo/, 'actual 如实 = 取到的那段值')
  assert.equal(out.findings.length, 1, '层名仍在 ⇒ 不许连带报层名红')
})

test('★ 只查声明点那段文本：整文件里别处出现 Ponos-Turbo 不报红（否则全仓那批叙述文本会让 CT10 永远红）', (t) => {
  // 3 处"声明点之外"的写法：版本常量行的**尾注**、另一行注释、以及上面那些行都不在声明点上
  const vm = `// 夹具版本线（本文件另一处提到 Ponos-Turbo 是叙述，不是声明点）\n`
    + `//   1. APP_VERSION     — ${FX_APP_LABEL}\n`
    + `//   2. KERNEL_VERSION  — ${FX_KERNEL_LABEL}\n`
    + `// 迁移说明：此前叫 Ponos-Turbo，现统一为 ponos\n`
    + `export const APP_VERSION = 'dev 1.0.0'  // Ponos-Turbo 时代的值\n`
    + `export const KERNEL_VERSION = 'dev 0.1'\n`
  // 同理：HTML 里别处（声明点之外）提到旧名也不该红 —— 只查 `<title>` 与 `<meta name=description>` 那两段
  const html = HTML.replace('</head>', `  <!-- 迁移说明：此前叫 Ponos-Turbo -->\n</head>`)
  const fx = makeFixture({ overrides: { 'version.mjs': vm, 'index.html': html } })
  cleanup(t, fx.root)
  assert.deepEqual(fx.run().findings, [], '声明点之外的叙述文本不在本门禁范围（那是独立工作项）')
})

// ── (c) 真源不可读 / 结构不合法 ⇒ 红（且不抛）──────────────────────────────

test('★ 删掉品牌真源 ⇒ 红（真源不可读）、evaluated=0、**不抛异常**', (t) => {
  const fx = makeFixture({ drop: [BRAND_TRUTH] })
  cleanup(t, fx.root)
  let out
  assert.doesNotThrow(() => { out = fx.run() }, '真源缺失不得抛异常（门禁崩了比红灯更坏）')
  assert.equal(out.check.passed, false)
  assert.equal(out.check.evaluated, 0, '真源不可读 = 一条声明点都没检查（不许报成"14 条都过"）')
  assert.equal(out.findings.length, 1)
  const f = out.findings[0]
  assert.equal(f.rule, 'CT10')
  assert.equal(f.severity, 'red')
  assert.equal(f.subject, 'brand.json')
  assert.match(f.actual, /读不到品牌真源/, '必须明说"读不到"而不是别的')
  assert.match(f.actual, /提交态/, '必须提醒"本规则读提交态 ⇒ 新真源要先提交"（否则人会以为规则坏了）')
})

test('真源 JSON 坏掉 ⇒ 红（不是合法 JSON），不抛', (t) => {
  const fx = makeFixture({ overrides: { [BRAND_TRUTH]: '{ "schemaVersion": 1, ' } })
  cleanup(t, fx.root)
  let out
  assert.doesNotThrow(() => { out = fx.run() })
  assert.equal(out.check.passed, false)
  assert.equal(out.check.evaluated, 0)
  assert.match(out.findings[0].actual, /不是合法 JSON/)
})

test('★ declaration 少一条（14 → 13）⇒ 红（subject = brand.json，且其余 13 条照常判定）', (t) => {
  const truth = fixtureTruth()
  truth.declarations = truth.declarations.filter((d) => d.id !== 'window-title')
  const fx = makeFixture({ truth })
  cleanup(t, fx.root)
  const out = fx.run()
  const f = out.findings.find((x) => x.subject === 'brand.json')
  assert.ok(f, `少一条声明点必须红：${JSON.stringify(out.findings)}`)
  assert.match(String(f.actual), /缺：window-title/)
  assert.equal(out.check.evaluated, 13, 'evaluated 如实 = 真源里实际存在的声明点数（13）')
  assert.equal(out.check.passed, false)
})

test('★ 新增的那 6 条同样"少一条就要红"（抽查 kernel-pkg-name：拆掉它 ⇒ 报缺、不是静默跳过）', (t) => {
  const truth = fixtureTruth()
  truth.declarations = truth.declarations.filter((d) => d.id !== 'kernel-pkg-name')
  const fx = makeFixture({ truth })
  cleanup(t, fx.root)
  const out = fx.run()
  const f = out.findings.find((x) => x.subject === 'brand.json')
  assert.ok(f, '新声明点也是"必须凑齐"的结构约束（否则会被静默摘掉）')
  assert.match(String(f.actual), /缺：kernel-pkg-name/)
  assert.equal(out.check.evaluated, 13)
})

test('真源里的层不存在（expects.layer 指向未定义的层）⇒ 红，且指到的是真源文件', (t) => {
  const truth = fixtureTruth({ layers: [{ id: 'app', name: FX_APP, note: '只剩应用层' }] })
  const fx = makeFixture({ truth })
  cleanup(t, fx.root)
  const out = fx.run()
  const f = out.findings.find((x) => x.subject === 'kernel-label')
  assert.ok(f, '引用了不存在的层必须红（绝不静默跳过）')
  assert.equal(f.file, BRAND_TRUTH)
  assert.match(String(f.actual), /没有 id=kernel/)
  assert.equal(out.findings.some((x) => x.subject === 'lines-label-kernel'), true, '引用同一层的另一个声明点也要报')
  // ★ 内核层的**新增**声明点（kernel-pkg-*）同样在引用 kernel ⇒ 一个都不许漏
  assert.equal(out.findings.some((x) => x.subject === 'kernel-pkg-name'), true, '新声明点引用了不存在的层也要红')
  assert.equal(out.findings.some((x) => x.subject === 'kernel-pkg-description'), true, '同上')
})

test('声明点的文件不存在 ⇒ 红（"取不到值"不等于"没问题"），hint 给出补回来的位置', (t) => {
  const fx = makeFixture({ drop: ['index.html'] })
  cleanup(t, fx.root)
  const out = fx.run()
  const f = out.findings.find((x) => x.subject === 'window-title')
  assert.ok(f, '窗口标题文件都没了必须红')
  // 同一个文件上的**两条**声明点都要报（不许只报第一条就完事）
  assert.ok(out.findings.some((x) => x.subject === 'meta-description'), 'index.html 上另一条声明点也要报')
  // 定位不到行 ⇒ 不给行号（`finding()` 对 falsy 的 line 不写该键 ⇒ null 与 undefined 都是"没行号"）
  assert.ok(f.line === null || f.line === undefined, `不能编行号，实测 ${String(f.line)}`)
  assert.match(String(f.actual), /取不到值/)
  assert.match(f.hint, /<title>/, 'hint 必须说清该补什么')
})

test('kernel/package.json 整个文件没了 ⇒ 两条内核包声明点都红（含 hint 指路）', (t) => {
  const fx = makeFixture({ drop: ['kernel/package.json'] })
  cleanup(t, fx.root)
  const out = fx.run()
  for (const id of ['kernel-pkg-name', 'kernel-pkg-description']) {
    const f = out.findings.find((x) => x.subject === id)
    assert.ok(f, `${id} 的文件没了必须红`)
    assert.equal(f.file, 'kernel/package.json')
    assert.match(f.hint, /kernel\/package\.json/)
  }
  assert.equal(out.findings.length, 2)
})

test('kind 不支持 / severityIfWrong 不是 red ⇒ 结构不合法红（真源自己写错也要报）', (t) => {
  const truth = fixtureTruth()
  truth.declarations[0].kind = 'toml-table'
  truth.declarations[1].severityIfWrong = 'yellow'
  const fx = makeFixture({ truth })
  cleanup(t, fx.root)
  const out = fx.run()
  const structural = out.findings.filter((x) => x.subject === 'brand.json')
  assert.ok(structural.some((x) => /kind 不支持/.test(String(x.actual))), '未知 kind 必须报（否则静默跳过一条声明点）')
  assert.ok(structural.some((x) => /severityIfWrong/.test(String(x.actual))), '品牌声明点不允许"只报不拦"')
  assert.equal(out.check.passed, false)
})

// ── 真仓自检（"门禁首次就绿"的机械证据）────────────────────────────────────

test('★ 真仓自检：对真仓跑 CT10 ⇒ 全绿且 evaluated === 14（14 条声明点都跟上了真源）', () => {
  const files = trackedFiles({ root: ROOT })
  const out = brandCheck({ readTracked: (f) => readTracked({ root: ROOT, file: f }), files })
  assert.deepEqual(out.findings, [], `真仓品牌声明点必须与真源一致：${JSON.stringify(out.findings)}`)
  assert.equal(out.check.passed, true)
  assert.equal(out.check.evaluated, 14)
  // 真源自身要合法（否则上面的"全绿"可能来自"一条都没检查"）
  const truth = JSON.parse(readFileSync(join(ROOT, BRAND_TRUTH), 'utf8'))
  assert.deepEqual(truth.declarations.map((d) => d.id).sort(), [...REQUIRED_DECLARATIONS].sort())
  assert.deepEqual(truth.layers.map((l) => [l.id, l.name]), [['app', 'YFWorking'], ['kernel', 'ponos']])
})
