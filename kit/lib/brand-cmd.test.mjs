// kit/lib/brand-cmd.test.mjs —— `scripts/brand.mjs` 的三个子命令（show / check / set）
//
// 全部 spawn 真进程（退出码与 stdout 是它唯一的对外契约），并且：
//   · `show` / `check` 在**真仓**上跑（钉住"真仓品牌已统一"这件事）；
//   · `set` **只在临时夹具目录**里跑（`--root <dir>`）—— ★ 绝不在真仓跑 set（它会改品牌真源）。
//
// ★ 夹具的声明点清单**从 `REQUIRED_DECLARATIONS` 推导**（不在这里再抄一遍 id 数组）：
//   真源从 8 条扩到 14 条那次，规则加了、夹具没加 ⇒ 一堆看不懂的"结构不合法"红。
//   现在若真源再加声明点，这里会抛出"夹具缺 XXX 的取值位置定义"这句人话。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REQUIRED_DECLARATIONS } from './brand-rules.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CMD = resolve(ROOT, 'scripts/brand.mjs')

/** spawn 真进程（`--root` 作为**参数**传，与真实用法一致）；失败时把 stdout/stderr 合并返回便于看原因 */
function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [CMD, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60000 })
    return { code: 0, stdout }
  } catch (e) {
    return { code: e.status ?? -1, stdout: `${e.stdout || ''}${e.stderr || ''}` }
  }
}

// ── 夹具（品牌齐全的小仓；`set` 的靶子）──────────────────────────────────────

const FX_APP = 'FxApp'
const FX_KERNEL = 'fxk'
const FX_APP_LABEL = `${FX_APP} 应用（${FX_KERNEL} 内核版）`
const FX_KERNEL_LABEL = `${FX_KERNEL} 内核`
const FX_DESC = `${FX_APP} 桌面应用（${FX_KERNEL} 内核版）`

/** 夹具文件内容（`electron-builder.yml` 刻意让 `productName` 落在第 2 行 ⇒ 好钉 file:line） */
const YML = `appId: com.fx.desktop\nproductName: ${FX_APP}\nshortcutName: ${FX_APP}\n`
  + `copyright: Copyright © 2026 ${FX_APP}\n`
const HTML = `<!doctype html>\n<html><head>\n  <title>${FX_APP}</title>\n`
  + `  <meta name="description" content="${FX_DESC}">\n</head></html>\n`
const VM = `// 夹具版本线\n//   1. APP_VERSION     — ${FX_APP_LABEL}\n//   2. KERNEL_VERSION  — ${FX_KERNEL_LABEL}\n`
  + "export const APP_VERSION = 'dev 1.0.0'\nexport const KERNEL_VERSION = 'dev 0.1'\n"
const PKG = JSON.stringify({ name: 'fx-pkg', description: FX_DESC, version: '1.0.0' }, null, 2) + '\n'
const KERNEL_PKG = JSON.stringify({ name: `${FX_KERNEL}-kernel`, description: `${FX_KERNEL} 内核独立部署包（零 npm 依赖）` }, null, 2) + '\n'
const VERSIONS = JSON.stringify({
  version: 1,
  lines: [
    { id: 'APP_VERSION', label: FX_APP_LABEL, file: 'version.mjs', value: 'dev 1.0.0' },
    { id: 'KERNEL_VERSION', label: FX_KERNEL_LABEL, file: 'version.mjs', value: 'dev 0.1' },
  ],
}, null, 2) + '\n'

/** 夹具文件的相对路径 → 内容 */
const FX_FILES = {
  'electron-builder.yml': YML,
  'index.html': HTML,
  'package.json': PKG,
  'kernel/package.json': KERNEL_PKG,
  'version.mjs': VM,
  'kit/manifest/versions.json': VERSIONS,
}

/**
 * 声明点的取值位置（file / kind / 取值位置 / expects）—— id 清单从 `REQUIRED_DECLARATIONS` 取。
 * 与 brand-rules.test.mjs 里的 FX_DECL_SPEC 同口径（两份夹具各自独立，但都由 REQUIRED 驱动）。
 */
const FX_DECL_SPEC = {
  'product-name': { file: 'electron-builder.yml', kind: 'yaml-scalar', key: 'productName', expects: { layer: 'app' } },
  'window-title': { file: 'index.html', kind: 'html-title', expects: { layer: 'app' } },
  'meta-description': { file: 'index.html', kind: 'html-meta-description', expects: { layer: 'app' } },
  'shortcut-name': { file: 'electron-builder.yml', kind: 'yaml-scalar', key: 'shortcutName', expects: { layer: 'app' } },
  'copyright': { file: 'electron-builder.yml', kind: 'yaml-scalar', key: 'copyright', expects: { layer: 'app' } },
  'pkg-description': { file: 'package.json', kind: 'json-key', key: 'description', expects: { layer: 'app' } },
  'kernel-pkg-name': { file: 'kernel/package.json', kind: 'json-key', key: 'name', expects: { layer: 'kernel' } },
  'kernel-pkg-description': { file: 'kernel/package.json', kind: 'json-key', key: 'description', expects: { layer: 'kernel' } },
  'app-id': { file: 'electron-builder.yml', kind: 'yaml-scalar', key: 'appId', expects: { literal: 'com.fx.desktop' } },
  'npm-name': { file: 'package.json', kind: 'json-key', key: 'name', expects: { literal: 'fx-pkg' } },
  'app-label': { file: 'version.mjs', kind: 'comment-label', constName: 'APP_VERSION', expects: { layer: 'app' } },
  'kernel-label': { file: 'version.mjs', kind: 'comment-label', constName: 'KERNEL_VERSION', expects: { layer: 'kernel' } },
  'lines-label-app': { file: 'kit/manifest/versions.json', kind: 'json-pointer', pointer: 'lines[id=APP_VERSION].label', expects: { layer: 'app' } },
  'lines-label-kernel': { file: 'kit/manifest/versions.json', kind: 'json-pointer', pointer: 'lines[id=KERNEL_VERSION].label', expects: { layer: 'kernel' } },
}

/** 夹具的 14 条声明点 = `REQUIRED_DECLARATIONS` 逐条映射；不一致时抛人话（不是一堆莫名的红） */
function fixtureDeclarations() {
  const missing = REQUIRED_DECLARATIONS.filter((id) => !FX_DECL_SPEC[id])
  const extra = Object.keys(FX_DECL_SPEC).filter((id) => !REQUIRED_DECLARATIONS.includes(id))
  if (missing.length || extra.length) {
    throw new Error('夹具的声明点表 FX_DECL_SPEC 与品牌规则的 REQUIRED_DECLARATIONS 不一致：'
      + `缺 ${missing.join(' / ') || '（无）'}、多 ${extra.join(' / ') || '（无）'}`
      + ' —— 请在本文件的 FX_DECL_SPEC 里补上该 id 的取值位置，并在 FX_FILES 里**真的造出**它指向的文件')
  }
  const decls = REQUIRED_DECLARATIONS.map((id) => ({
    id, ...FX_DECL_SPEC[id], why: `夹具：${id}`, severityIfWrong: 'red',
  }))
  const lack = [...new Set(decls.map((d) => d.file))].filter((f) => !(f in FX_FILES))
  if (lack.length) throw new Error(`夹具没造这些文件：${lack.join(' / ')}（声明点指向的文件必须真的存在）`)
  return decls
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'yfw-brand-cmd-'))
  const write = (rel, content) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  write('kit/manifest/brand.json', JSON.stringify({
    schemaVersion: 1,
    note: '夹具品牌真源',
    layers: [{ id: 'app', name: FX_APP, note: '夹具应用层' }, { id: 'kernel', name: FX_KERNEL, note: '夹具内核层' }],
    brandZh: { name: '夹具中文名', where: '夹具' },
    declarations: fixtureDeclarations(),
    retiredAliases: [{ alias: 'Ponos-Turbo', replaceWith: 'ponos', layer: 'kernel', why: '夹具', scope: 'declarations' }],
    knownWidespread: [{ alias: 'Ponos-Turbo', counts: { exactCaseSensitive: { lines: 7, files: 3 }, aliasFamily: { lines: 9, files: 4 } }, measuredAt: 'abc1234', recompute: 'git grep -F "Ponos-Turbo" HEAD | wc -l', why: '夹具：不在本门禁范围' }],
  }, null, 2) + '\n')
  for (const [rel, content] of Object.entries(FX_FILES)) write(rel, content)
  return root
}

const cleanup = (t, root) => t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }))

/** 读**真仓**的品牌真源（`show`/`check` 按设计跑真仓，断言因此也要对着真源、而不是写死字面量） */
const truth = () => JSON.parse(readFileSync(join(ROOT, 'kit/manifest/brand.json'), 'utf8'))

/** `check` 输出里"没跟上"的声明点 id（按打印顺序）—— 反向自证的期望值都从实际输出解析 */
const badIds = (stdout) => stdout.split('\n').filter((l) => l.startsWith('✘ ')).map((l) => l.split(/\s+/)[1])

// ── show / check（真仓）──────────────────────────────────────────────────────

test('show：exit 0，打印层级名 / 全部声明点 / 废弃别名 / 已知广泛存在（规模来自真源）', () => {
  const r = run(['show'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /品牌真源：kit\/manifest\/brand\.json/)
  assert.match(r.stdout, /YFWorking/)
  assert.match(r.stdout, /ponos/)
  assert.match(r.stdout, /新远方数据/, '中文品牌名要出现')
  // ★ 声明点逐条来自**真源**（不写死 id 清单）：真源加了声明点而 show 没渲染就会被这条抓住
  const decls = truth().declarations
  assert.equal(decls.length, 14, '真源应有 14 条声明点（8 条基础 + 复核后补的 6 条）')
  for (const d of decls) assert.ok(r.stdout.includes(d.id), `真源里的声明点缺 ${d.id}`)
  assert.match(r.stdout, /Ponos-Turbo → ponos/, '废弃别名与替换目标要出现')
  // ★ 这里**不断言具体数字**（写死的数字必然漂移 —— 本仓已吃过这个亏）。
  //   做法：从**真源**读出数字，再断言 stdout 里出现同样的一串 ⇒ 证明渲染是**读真源**而不是写死在代码里。
  //   这比"断言某个具体处数"强：数字变了测试照样绿（只要渲染跟得上真源），而渲染若写死就会被抓。
  const { counts, alias } = truth().knownWidespread[0]
  const ex = counts.exactCaseSensitive
  assert.match(r.stdout, new RegExp(`${alias}：精确写法 ${ex.lines} 处 / ${ex.files} 个文件`),
    '规模必须从真源读出来（渲染写死就会被这条抓住）')
  // ★ 复算命令必须**真的可见**（读者得能自己验证规模）；且断言的是命令本体（`git grep -F`），
  //   不依赖"复算："后面紧跟什么措辞 —— 早先写成 /复算：git grep -F/ 时，真源在口径说明后换行放了命令就误报失败。
  assert.match(r.stdout, /复算：[\s\S]*git grep -F/, '必须给出可复算命令（且命令本体要露出来）')
  assert.match(r.stdout, /不在本门禁范围的理由/, '必须说明为什么这些文本不纳入门禁')
  assert.match(r.stdout, /不在门禁范围/, '必须点明那批叙述文本不在门禁范围（否则读者以为要改全仓）')
  assert.match(r.stdout, /为什么算声明点/, '每条声明的 why 要打印（人得知道它为什么算声明点）')
})

test('check（真仓）：exit 0，14 条声明点逐条 ✔', () => {
  const r = run(['check'])
  assert.equal(r.code, 0, `真仓品牌应已统一：${r.stdout}`)
  const okLines = r.stdout.split('\n').filter((l) => l.startsWith('✔ '))
  // 条数对着真源（断言"12 条"这种写死的数字必然漂移）；同时把"当前是 14"钉住
  assert.equal(truth().declarations.length, 14, '真源应有 14 条声明点')
  assert.equal(okLines.length, 14, `应逐条打印 14 条 ✔（含新增的 meta-description/shortcut-name/copyright/pkg-description/kernel-pkg-name/kernel-pkg-description）：${r.stdout}`)
  for (const d of truth().declarations) assert.ok(okLines.some((l) => l.includes(d.id)), `缺 ${d.id}`)
  assert.match(r.stdout, /passed=true/)
})

// ── check（夹具：反向自证 + 工作树口径）────────────────────────────────────

test('★ check 读**工作树**：夹具绿 → 改一个字母 ⇒ 立刻红（不必提交），并打印 file:line/期望/实际', (t) => {
  const root = makeFixture()
  cleanup(t, root)
  assert.equal(run(['check', '--root', root]).code, 0)
  // 只改**工作树**（不提交、也不是 git 仓）：本工具是"改完立刻反馈"的入口。
  // ★ 改成一个**不含**层名的值（层判据是"实际值里出现该层名"，`FxApp-X` 仍含 `FxApp` ⇒ 不该红）
  writeFileSync(join(root, 'electron-builder.yml'), YML.replace(`productName: ${FX_APP}`, 'productName: LegacyApp'))
  const r = run(['check', '--root', root])
  assert.equal(r.code, 1, '工作树里改坏必须立刻红')
  assert.match(r.stdout, /✘ product-name/, '必须点名是哪条声明点')
  assert.match(r.stdout, /electron-builder\.yml:2/, '必须给出 file:line')
  assert.match(r.stdout, /期望 层 app 的名称 "FxApp"/)
  assert.match(r.stdout, /实际 LegacyApp/)
  // ★ 其余 13 条不许被带红（"只红该红的"——否则门禁会变噪声）
  assert.deepEqual(badIds(r.stdout), ['product-name'], `只该红这一条：${r.stdout}`)
})

test('★ check 对"真源读不到"也如实红（不抛、退出 1）', (t) => {
  const root = makeFixture()
  cleanup(t, root)
  rmSync(join(root, 'kit/manifest/brand.json'))
  const r = run(['check', '--root', root])
  assert.equal(r.code, 1)
  assert.match(r.stdout, /✘ 真源\s+kit\/manifest\/brand\.json/)
})

// ── set（重新定义；★ 只在夹具里跑）─────────────────────────────────────────

test('★ set app：改真源 + 同步注释/台账 label（两级名都进文本），并列出仍需手工改的声明点', (t) => {
  const root = makeFixture()
  cleanup(t, root)
  // 改前留证：这几处是 set **不该**动的（安装/发布/对外身份）
  const ymlBefore = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
  const htmlBefore = readFileSync(join(root, 'index.html'), 'utf8')
  const pkgBefore = readFileSync(join(root, 'package.json'), 'utf8')
  const kernelPkgBefore = readFileSync(join(root, 'kernel/package.json'), 'utf8')

  const r = run(['set', 'app', 'ZetaApp', '--root', root])
  assert.equal(r.code, 0, r.stdout)
  assert.match(r.stdout, /层 app 的名称 FxApp → ZetaApp/)

  // 1) 真源：只有 app 层的 name 变了（kernel 层原样）
  const truthAfter = JSON.parse(readFileSync(join(root, 'kit/manifest/brand.json'), 'utf8'))
  assert.deepEqual(truthAfter.layers.map((l) => [l.id, l.name]), [['app', 'ZetaApp'], ['kernel', FX_KERNEL]])
  assert.equal(truthAfter.declarations.length, 14, 'set 不得动声明点清单')
  // 2) 注释行（version.mjs）：应用线带**两级**名、内核线只用内核名
  const vm = readFileSync(join(root, 'version.mjs'), 'utf8')
  assert.match(vm, /\/\/   1\. APP_VERSION     — ZetaApp 应用（fxk 内核版）/)
  assert.match(vm, /\/\/   2\. KERNEL_VERSION  — fxk 内核，独立可运行/)
  assert.equal(vm.split('\n').filter((l) => l.startsWith('//')).length, 3, '只该有三行注释（其余行不得被改）')
  // 3) 台账 label 跟着变（且只改 label 那一行的**值**）
  const ledger = JSON.parse(readFileSync(join(root, 'kit/manifest/versions.json'), 'utf8'))
  assert.equal(ledger.lines.find((l) => l.id === 'APP_VERSION').label, 'ZetaApp 应用（fxk 内核版）')
  assert.equal(ledger.lines.find((l) => l.id === 'KERNEL_VERSION').label, 'fxk 内核')
  assert.equal(ledger.lines.find((l) => l.id === 'APP_VERSION').value, 'dev 1.0.0', '只动 label，别动值')
  // 4) 安装/发布/对外身份**不许**被自动改
  assert.equal(readFileSync(join(root, 'electron-builder.yml'), 'utf8'), ymlBefore, 'productName/shortcutName/copyright 属安装身份 ⇒ 不自动改')
  assert.equal(readFileSync(join(root, 'index.html'), 'utf8'), htmlBefore, 'HTML 正文不自动改')
  assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), pkgBefore, 'npm 包名/摘要属发布身份 ⇒ 不自动改')
  assert.equal(readFileSync(join(root, 'kernel/package.json'), 'utf8'), kernelPkgBefore, '内核包名/摘要不自动改')
  // 5) 输出必须给出"仍需手工改"的清单 + 具体建议值 + 生成点提醒
  //    ★ 这份清单是 `scripts/brand.mjs` 里**手工维护**的 4 条（安装/发布身份 + HTML 正文）；
  //      新增的 6 条声明点**不在**这份清单里（它们里外都不是"自动改会影响安装身份"的那类），
  //      但 `check` 会如实把它们报红 —— 见下面那条用例。
  assert.match(r.stdout, /仍需手工改的声明点/)
  for (const id of ['product-name', 'window-title', 'npm-name', 'app-id']) assert.ok(r.stdout.includes(id), `清单缺 ${id}`)
  assert.match(r.stdout, /productName: ZetaApp/, 'product-name 要给具体建议值')
  assert.match(r.stdout, /<title>ZetaApp<\/title>/, 'window-title 要给具体建议值')
  assert.match(r.stdout, /kit\/lib\/ledger\.mjs/, '必须提醒 LINE_SPECS 是 sync 的生成点（否则下一次 sync 会把标签改回去）')
  assert.match(r.stdout, /ZetaApp 应用（fxk 内核版）/, '生成点要给出**具体的**新 label 文本，别让人自己拼')
})

test('★ set 之后 check 红 6 条（清单那 2 条 + 4 条同样要人工跟上的对外声明点）—— "改一处、门禁告诉你哪里还没跟上"', (t) => {
  const root = makeFixture()
  cleanup(t, root)
  // 改**应用层**名：`set` 只自动同步"文本由层名拼出"的两处（注释 + 台账 label），
  // 于是所有含应用层名的声明点立刻"没跟上" ⇒ check 必须**逐条**报出来（不是笼统说"不一致"）。
  // 为什么是 6 条（而不是最早的 2 条）：8 条时期只有 `productName` / `<title>` 两条含应用层名；
  // 真源扩到 14 条后，含应用层名的变成 product-name / window-title / meta-description /
  // shortcut-name / copyright / pkg-description **共 6 条** —— 数字变大是声明面变宽的**如实反映**
  // （另外：`set` 的"仍需手工改"清单仍是 4 条，那是"自动改会影响安装/发布身份"的子集，两者口径不同）。
  assert.equal(run(['set', 'app', 'ZetaApp', '--root', root]).code, 0)
  const r = run(['check', '--root', root])
  assert.equal(r.code, 1)
  assert.deepEqual(badIds(r.stdout), ['product-name', 'window-title', 'meta-description', 'shortcut-name', 'copyright', 'pkg-description'],
    `含应用层名的 6 条都该红（安装/发布身份与内核层那些不在内）：${r.stdout}`)
  // 内核层改名后，应用线的文本也要跟着变（两级名都进文本）
  assert.equal(run(['set', 'kernel', 'zetak', '--root', root]).code, 0)
  assert.match(readFileSync(join(root, 'version.mjs'), 'utf8'), /\/\/   1\. APP_VERSION     — ZetaApp 应用（zetak 内核版）/)
  // ★ 改内核名 ⇒ 内核包声明点（kernel-pkg-name / kernel-pkg-description）也立刻没跟上：
  //   它们在 14 条里**新加**、而且此前完全没纳管（`kernel/package.json` 里残留废弃别名就是证明）⇒
  //   总数从 6 变 8：应用层那 6 条仍在 + 内核层这 2 条。不多不少。
  assert.deepEqual(badIds(run(['check', '--root', root]).stdout),
    ['product-name', 'window-title', 'meta-description', 'shortcut-name', 'copyright', 'pkg-description',
      'kernel-pkg-name', 'kernel-pkg-description'])
  // 反过来验一次牙齿：把内核包那两处手工改对 ⇒ 只剩应用层那 6 条（证明上面那 2 条是**真判据**、不是恒红）
  writeFileSync(join(root, 'kernel/package.json'),
    JSON.stringify({ name: 'zetak-kernel', description: 'zetak 内核独立部署包（零 npm 依赖）' }, null, 2) + '\n')
  assert.deepEqual(badIds(run(['check', '--root', root]).stdout),
    ['product-name', 'window-title', 'meta-description', 'shortcut-name', 'copyright', 'pkg-description'])
})

test('参数校验：未知子命令 / 缺参数 / 层名不合法 ⇒ usage + exit 2（且不改任何文件）', (t) => {
  const root = makeFixture()
  cleanup(t, root)
  const truthBefore = readFileSync(join(root, 'kit/manifest/brand.json'), 'utf8')
  assert.equal(run(['nope']).code, 2)
  assert.equal(run(['set']).code, 2)
  assert.equal(run(['set', 'app']).code, 2)
  const bad = run(['set', 'gui', 'Foo', '--root', root])
  assert.equal(bad.code, 2)
  assert.match(bad.stdout, /层名不合法/, '层名必须是 app / kernel')
  assert.equal(readFileSync(join(root, 'kit/manifest/brand.json'), 'utf8'), truthBefore, '用法错时不得改真源')
})
