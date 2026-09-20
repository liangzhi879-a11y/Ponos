// kit/lib/brand-cmd.test.mjs —— `scripts/brand.mjs` 的三个子命令（show / check / set）
//
// 全部 spawn 真进程（退出码与 stdout 是它唯一的对外契约），并且：
//   · `show` / `check` 在**真仓**上跑（钉住"真仓品牌已统一"这件事）；
//   · `set` **只在临时夹具目录**里跑（`--root <dir>`）—— ★ 绝不在真仓跑 set（它会改品牌真源）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'yfw-brand-cmd-'))
  const write = (rel, content) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  const decl = (id, file, kind, extra, expects) => ({ id, file, kind, ...extra, expects, why: `夹具：${id}`, severityIfWrong: 'red' })
  write('kit/manifest/brand.json', JSON.stringify({
    schemaVersion: 1,
    note: '夹具品牌真源',
    layers: [{ id: 'app', name: FX_APP, note: '夹具应用层' }, { id: 'kernel', name: FX_KERNEL, note: '夹具内核层' }],
    brandZh: { name: '夹具中文名', where: '夹具' },
    declarations: [
      decl('product-name', 'electron-builder.yml', 'yaml-scalar', { key: 'productName' }, { layer: 'app' }),
      decl('window-title', 'index.html', 'html-title', {}, { layer: 'app' }),
      decl('app-id', 'electron-builder.yml', 'yaml-scalar', { key: 'appId' }, { literal: 'com.fx.desktop' }),
      decl('npm-name', 'package.json', 'json-key', { key: 'name' }, { literal: 'fx-pkg' }),
      decl('app-label', 'version.mjs', 'comment-label', { constName: 'APP_VERSION' }, { layer: 'app' }),
      decl('kernel-label', 'version.mjs', 'comment-label', { constName: 'KERNEL_VERSION' }, { layer: 'kernel' }),
      decl('lines-label-app', 'kit/manifest/versions.json', 'json-pointer', { pointer: 'lines[id=APP_VERSION].label' }, { layer: 'app' }),
      decl('lines-label-kernel', 'kit/manifest/versions.json', 'json-pointer', { pointer: 'lines[id=KERNEL_VERSION].label' }, { layer: 'kernel' }),
    ],
    retiredAliases: [{ alias: 'Ponos-Turbo', replaceWith: 'ponos', layer: 'kernel', why: '夹具', scope: 'declarations' }],
    knownWidespread: [{ alias: 'Ponos-Turbo', occurrences: 91, files: 33, why: '夹具：不在本门禁范围' }],
  }, null, 2) + '\n')
  write('electron-builder.yml', `appId: com.fx.desktop\nproductName: ${FX_APP}\n`)
  write('index.html', `<!doctype html>\n<html><head>\n  <title>${FX_APP}</title>\n</head></html>\n`)
  write('package.json', JSON.stringify({ name: 'fx-pkg', version: '1.0.0' }, null, 2) + '\n')
  write('version.mjs', `// 夹具版本线\n//   1. APP_VERSION     — ${FX_APP_LABEL}\n//   2. KERNEL_VERSION  — ${FX_KERNEL_LABEL}\n`
    + "export const APP_VERSION = 'dev 1.0.0'\nexport const KERNEL_VERSION = 'dev 0.1'\n")
  write('kit/manifest/versions.json', JSON.stringify({
    version: 1,
    lines: [
      { id: 'APP_VERSION', label: FX_APP_LABEL, file: 'version.mjs', value: 'dev 1.0.0' },
      { id: 'KERNEL_VERSION', label: FX_KERNEL_LABEL, file: 'version.mjs', value: 'dev 0.1' },
    ],
  }, null, 2) + '\n')
  return root
}

const cleanup = (t, root) => t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }))

// ── show / check（真仓）──────────────────────────────────────────────────────

test('show：exit 0，打印层级名 / 8 条声明点 / 废弃别名 / 已知广泛存在（91 处不在范围）', () => {
  const r = run(['show'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /品牌真源：kit\/manifest\/brand\.json/)
  assert.match(r.stdout, /YFWorking/)
  assert.match(r.stdout, /ponos/)
  assert.match(r.stdout, /新远方数据/, '中文品牌名要出现')
  for (const id of ['product-name', 'window-title', 'app-id', 'npm-name', 'app-label', 'kernel-label', 'lines-label-app', 'lines-label-kernel']) {
    assert.ok(r.stdout.includes(id), `8 条声明点缺 ${id}`)
  }
  assert.match(r.stdout, /Ponos-Turbo → ponos/, '废弃别名与替换目标要出现')
  assert.match(r.stdout, /91 处 \/ 33 个文件/, '已知广泛存在必须带真实数字（口径来自真源）')
  assert.match(r.stdout, /不在门禁范围/, '必须点明那 91 处不在门禁范围（否则读者以为要改全仓）')
  assert.match(r.stdout, /为什么算声明点/, '每条声明的 why 要打印（人得知道它为什么算声明点）')
})

test('check（真仓）：exit 0，8 条声明点逐条 ✔', () => {
  const r = run(['check'])
  assert.equal(r.code, 0, `真仓品牌应已统一：${r.stdout}`)
  const okLines = r.stdout.split('\n').filter((l) => l.startsWith('✔ '))
  assert.equal(okLines.length, 8, `应逐条打印 8 条 ✔：${r.stdout}`)
  for (const id of ['product-name', 'window-title', 'app-id', 'npm-name', 'app-label', 'kernel-label', 'lines-label-app', 'lines-label-kernel']) {
    assert.ok(okLines.some((l) => l.includes(id)), `缺 ${id}`)
  }
  assert.match(r.stdout, /passed=true/)
})

// ── check（夹具：反向自证 + 工作树口径）────────────────────────────────────

test('★ check 读**工作树**：夹具绿 → 改一个字母 ⇒ 立刻红（不必提交），并打印 file:line/期望/实际', (t) => {
  const root = makeFixture()
  cleanup(t, root)
  assert.equal(run(['check', '--root', root]).code, 0)
  // 只改**工作树**（不提交、也不是 git 仓）：本工具是"改完立刻反馈"的入口。
  // ★ 改成一个**不含**层名的值（层判据是"实际值里出现该层名"，`FxApp-X` 仍含 `FxApp` ⇒ 不该红）
  writeFileSync(join(root, 'electron-builder.yml'), 'appId: com.fx.desktop\nproductName: LegacyApp\n')
  const r = run(['check', '--root', root])
  assert.equal(r.code, 1, '工作树里改坏必须立刻红')
  assert.match(r.stdout, /✘ product-name/, '必须点名是哪条声明点')
  assert.match(r.stdout, /electron-builder\.yml:2/, '必须给出 file:line')
  assert.match(r.stdout, /期望 层 app 的名称 "FxApp"/)
  assert.match(r.stdout, /实际 LegacyApp/)
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
  // 改前留证：这几处是 set **不该**动的（安装/发布身份）
  const ymlBefore = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
  const htmlBefore = readFileSync(join(root, 'index.html'), 'utf8')
  const pkgBefore = readFileSync(join(root, 'package.json'), 'utf8')

  const r = run(['set', 'app', 'ZetaApp', '--root', root])
  assert.equal(r.code, 0, r.stdout)
  assert.match(r.stdout, /层 app 的名称 FxApp → ZetaApp/)

  // 1) 真源：只有 app 层的 name 变了（kernal 层原样）
  const truth = JSON.parse(readFileSync(join(root, 'kit/manifest/brand.json'), 'utf8'))
  assert.deepEqual(truth.layers.map((l) => [l.id, l.name]), [['app', 'ZetaApp'], ['kernel', FX_KERNEL]])
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
  // 4) 安装/发布身份**不许**被自动改
  assert.equal(readFileSync(join(root, 'electron-builder.yml'), 'utf8'), ymlBefore, 'productName/appId 属安装身份 ⇒ 不自动改')
  assert.equal(readFileSync(join(root, 'index.html'), 'utf8'), htmlBefore, 'HTML 正文不自动改')
  assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), pkgBefore, 'npm 包名属发布身份 ⇒ 不自动改')
  // 5) 输出必须给出"仍需手工改"的清单 + 具体建议值 + 生成点提醒
  assert.match(r.stdout, /仍需手工改的声明点/)
  for (const id of ['product-name', 'window-title', 'npm-name', 'app-id']) assert.ok(r.stdout.includes(id), `清单缺 ${id}`)
  assert.match(r.stdout, /productName: ZetaApp/, 'product-name 要给具体建议值')
  assert.match(r.stdout, /<title>ZetaApp<\/title>/, 'window-title 要给具体建议值')
  assert.match(r.stdout, /kit\/lib\/ledger\.mjs/, '必须提醒 LINE_SPECS 是 sync 的生成点（否则下一次 sync 会把标签改回去）')
  assert.match(r.stdout, /ZetaApp 应用（fxk 内核版）/, '生成点要给出**具体的**新 label 文本，别让人自己拼')
})

test('★ set 之后 check 红 2 条（正是清单里那两条没同步的声明点）—— "改一处、门禁告诉你哪里还没跟上"', (t) => {
  const root = makeFixture()
  cleanup(t, root)
  // 改**应用层**名：`set` 只自动同步"文本由层名拼出"的两处（注释 + 台账 label），
  // 于是安装产品名与窗口标题这两条立刻"没跟上" ⇒ check 必须**逐条**报出来（不是笼统说"不一致"）
  assert.equal(run(['set', 'app', 'ZetaApp', '--root', root]).code, 0)
  const r = run(['check', '--root', root])
  assert.equal(r.code, 1)
  const bad = r.stdout.split('\n').filter((l) => l.startsWith('✘ ')).map((l) => l.split(/\s+/)[1])
  assert.deepEqual(bad, ['product-name', 'window-title'], `只该剩这两条（安装身份/HTML 正文没同步）：${r.stdout}`)
  // 内核层改名后，应用线的文本也要跟着变（两级名都进文本）
  assert.equal(run(['set', 'kernel', 'zetak', '--root', root]).code, 0)
  assert.match(readFileSync(join(root, 'version.mjs'), 'utf8'), /\/\/   1\. APP_VERSION     — ZetaApp 应用（zetak 内核版）/)
  // ★ 只改内核名而应用层声明点用的是新应用名 ⇒ 那两条仍然红（同两条，不多不少）
  assert.deepEqual(run(['check', '--root', root]).stdout.split('\n').filter((l) => l.startsWith('✘ ')).map((l) => l.split(/\s+/)[1]),
    ['product-name', 'window-title'])
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
