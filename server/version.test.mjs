// server/version.test.mjs —— 版本号断言（A5）+ 版本号入口（scripts/bump-version.mjs）端到端
//
// ★ 下面两条 assert 的**形式是 scripts/bump-version.mjs 依赖的**：
//   该脚本用字面替换更新断言，模式为 `assert.equal(<CONST>, '<旧值>')`。
//   所以必须严格保持单行、单引号写法 ——
//   改成双引号、加空格或换行都会让 bump 脚本 fail('未找到待替换文本')。
//   （本文件在 A5 之前**不存在**，于是 bump 的"同步测试期望值"分支永远走跳过 ——
//     版本断言实际不存在，改版本号不会让任何测试变红。）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_VERSION, KERNEL_VERSION, SCHEMA_VERSION } from '../version.mjs'
import { readVersions, syncVersions } from '../kit/lib/ledger.mjs'
import { runVersionRules } from '../kit/lib/version-rules.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('应用线与内核线版本常量与发布口径一致', () => {
  assert.equal(APP_VERSION, 'dev 3.0.0')
  assert.equal(KERNEL_VERSION, 'dev 0.2')
})

test('内核线跨载体映射：dev X.Y ↔ kernel/package.json 的 X.Y.0', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'kernel', 'package.json'), 'utf8'))
  const semver = KERNEL_VERSION.replace(/^dev\s+/, '')
  const expect = semver.split('.').length === 2 ? `${semver}.0` : semver
  assert.equal(pkg.version, expect)
})

test('settings schema 版本是正整数（读取旧文件时沿迁移链升级）', () => {
  assert.equal(Number.isInteger(SCHEMA_VERSION), true)
  assert.ok(SCHEMA_VERSION >= 1)
})

// ── 形式契约：断言必须保持 bump 脚本能字面替换的形态 ────────────────────────
//
// 为什么这条必须在测试里（而不是只写在注释里）：bump 用 `file.replace(from, to)` 做替换，
// **只替换第一处**，且找不到就 fail。所以"恰好一处、单行、单引号"是脚本能工作的前提：
//   · 双引号/换行 → 模式匹配不到 → bump 直接 fail（发版被卡住）；
//   · 同一模式出现两处（例如别处又写了一遍同样的断言）→ 替换到**错误的那一处**，
//     测试断言永不更新 → 下次改版本号"测试红着却查不出为什么"。
test('形式契约：APP_VERSION/KERNEL_VERSION 断言行各恰好一处，且为单行单引号', () => {
  const src = readFileSync(join(ROOT, 'server', 'version.test.mjs'), 'utf8')
  // 判据用**拼出来**的模式（不是字面量）：本文件里不得再出现第二处同形文本
  const patternOf = (name, value) => `assert.equal(${name}, '${value}')`
  for (const [name, value] of [['APP_VERSION', APP_VERSION], ['KERNEL_VERSION', KERNEL_VERSION]]) {
    const hits = src.split(patternOf(name, value)).length - 1
    assert.equal(hits, 1, `${name} 的断言行必须恰好一处（bump 只替换第一处）：${patternOf(name, value)}`)
  }
})

// ── 版本号入口端到端（A2 pkg 目标 / A3 台账历史 / A5 断言同步）──────────────
//
// ★ 绝不在主仓真跑 bump：它会改 version.mjs / package.json / server/version.test.mjs。
//   夹具 = mkdtemp + 复制 bump 脚本与 kit/lib + **真 git**（扫描域是 `git ls-files`，
//   未入库文件不参与判定，故夹具必须 git add 过）。CI 无 scratch/ release/ 也能跑。
const BUMP = join(ROOT, 'scripts', 'bump-version.mjs')

/** 与 bump 脚本的字面替换模式同形的断言行。
 *  **拼出来、不写字面量**：否则本文件里会出现第二处 `assert.equal(APP_VERSION, '<某版本>')`，
 *  真 bump 只替换第一处（file.replace）→ 替换到测试自己的辅助串上，断言永不更新。 */
const assertLine = (name, value) => `assert.equal(${name}, '${value}')`

const gitFiles = (root) => execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter(Boolean).map((f) => f.replace(/\\/g, '/'))

const read = (root, rel) => readFileSync(join(root, rel), 'utf8')

function bumpFixture({ singleQuoteAssert = true, kernelPkg = '{ "name": "fx-kernel", "version": "0.2.0" }\n' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yfw-bump-'))
  const write = (rel, content) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  mkdirSync(join(root, 'scripts'), { recursive: true })
  cpSync(BUMP, join(root, 'scripts', 'bump-version.mjs'))
  cpSync(join(ROOT, 'kit', 'lib'), join(root, 'kit', 'lib'), { recursive: true })
  // ledger.mjs 写台账走 shared/atomic-write.mjs（tmp + rename），夹具必须带上它，
  // 否则 bump 走到台账同步会 ERR_MODULE_NOT_FOUND —— 那时版本号文件已改、台账没改。
  mkdirSync(join(root, 'shared'), { recursive: true })
  cpSync(join(ROOT, 'shared', 'atomic-write.mjs'), join(root, 'shared', 'atomic-write.mjs'))
  write('version.mjs', [
    "export const APP_VERSION = 'dev 3.0.0'",
    "export const KERNEL_VERSION = 'dev 0.2'",
    'export const SCHEMA_VERSION = 1',
    '',
  ].join('\n'))
  write('package.json', '{\n  "name": "fx",\n  "version": "2.8.0",\n  "private": true\n}\n')
  write('kernel/package.json', kernelPkg)
  write('public/skills.json', '[]\n')
  write('skills-lock.json', '{ "skills": {} }\n')
  // 断言行的引号风格可切换：双引号形态 = bump 的字面替换必然找不到（A5 的硬约束反例）
  const q = (v) => (singleQuoteAssert ? `'${v}'` : `"${v}"`)
  write('server/version.test.mjs', [
    "import { test } from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { APP_VERSION, KERNEL_VERSION } from '../version.mjs'",
    '',
    "test('版本常量', () => {",
    `  assert.equal(APP_VERSION, ${q('dev 3.0.0')})`,
    `  assert.equal(KERNEL_VERSION, ${q('dev 0.2')})`,
    '})',
    '',
  ].join('\n'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', '-A'], { cwd: root })
  // 先建台账（= `kit/cli.mjs sync` 做的事：从宿主文件发现事实，值 + history）
  syncVersions({ root, files: gitFiles(root) })
  execFileSync('git', ['add', '-A'], { cwd: root })
  return root
}

function runBump(root, args) {
  try {
    const stdout = execFileSync(process.execPath, [join(root, 'scripts', 'bump-version.mjs'), ...args],
      { cwd: root, encoding: 'utf8', timeout: 60000 })
    return { code: 0, out: stdout }
  } catch (e) {
    return { code: e.status ?? -1, out: `${e.stdout || ''}${e.stderr || ''}` }
  }
}

const WATCHED = ['version.mjs', 'package.json', 'kernel/package.json', 'server/version.test.mjs',
  'kit/manifest/versions.json']
const snapshot = (root) => Object.fromEntries(WATCHED.map((rel) => [rel, read(root, rel)]))

const v3Of = (root) => {
  const versions = readVersions({ root })
  const { findings } = runVersionRules({ root, versions, files: gitFiles(root) })
  return { versions, reds: (rule) => findings.filter((f) => f.rule === rule), }
}

test('★A3：bump app → 台账 history.records 非空（from/to 齐备），V1/V3 当场全绿', () => {
  const root = bumpFixture()
  const r = runBump(root, ['app', '3.0.1'])
  assert.equal(r.code, 0, r.out)

  assert.match(read(root, 'version.mjs'), /export const APP_VERSION = 'dev 3\.0\.1'/)
  const { versions, reds } = v3Of(root)
  const rec = versions.history.records
  assert.equal(rec.length, 1, `bump 必须写 history.records（V3 的判据，为空则 V3 永远空跑）：${JSON.stringify(rec)}`)
  assert.deepEqual([rec[0].key, rec[0].from, rec[0].to],
    ['APP_VERSION@version.mjs', 'dev 3.0.0', 'dev 3.0.1'])
  assert.match(String(rec[0].at), /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(versions.lines.find((l) => l.id === 'APP_VERSION').value, 'dev 3.0.1')
  assert.deepEqual(reds('V1').map((f) => f.subject), [])
  assert.deepEqual(reds('V3').map((f) => f.subject), [])
})

test('★A2：bump pkg → GUI 发布线 package.json version 可写（原先根本没有这条路径）', () => {
  const root = bumpFixture()
  const r = runBump(root, ['pkg', '2.9.0'])
  assert.equal(r.code, 0, r.out)

  assert.equal(JSON.parse(read(root, 'package.json')).version, '2.9.0')
  assert.match(read(root, 'package.json'), /"private": true/,
    '必须只替换 version 字面量，不得 JSON.stringify 重写（否则每次发版都产生一整片格式 diff）')
  const { versions, reds } = v3Of(root)
  assert.equal(versions.lines.find((l) => l.id === 'GUI_VERSION').value, '2.9.0')
  const rec = versions.history.records.at(-1)
  assert.deepEqual([rec.key, rec.from, rec.to], ['GUI_VERSION@package.json', '2.8.0', '2.9.0'])
  assert.deepEqual(reds('V1').map((f) => f.subject), [])
  assert.deepEqual(reds('V3').map((f) => f.subject), [])
})

test('★A5：bump app → server/version.test.mjs 的断言被真替换（该分支不再走"跳过"）', () => {
  const root = bumpFixture()
  assert.ok(read(root, 'server/version.test.mjs').includes(assertLine('APP_VERSION', 'dev 3.0.0')))
  const r = runBump(root, ['app', '3.0.1'])
  assert.equal(r.code, 0, r.out)

  const after = read(root, 'server/version.test.mjs')
  assert.ok(after.includes(assertLine('APP_VERSION', 'dev 3.0.1')), `断言未同步：${after}`)
  assert.ok(!after.includes(assertLine('APP_VERSION', 'dev 3.0.0')))
  // 内核线不该被 app 目标的 bump 动到（多改 = 越权）
  assert.ok(after.includes(assertLine('KERNEL_VERSION', 'dev 0.2')))
})

test('★A5 反例：断言写成双引号 → bump 必须**明确失败**，绝不静默跳过', () => {
  const root = bumpFixture({ singleQuoteAssert: false })
  const r = runBump(root, ['app', '3.0.1'])
  assert.notEqual(r.code, 0, `字面替换找不到就必须 fail：${r.out}`)
  assert.match(r.out, /未找到待替换文本/)
})

test('bump kernel → 内核线三处一起动（常量 + kernel/package.json + 台账镜像值）', () => {
  const root = bumpFixture()
  const r = runBump(root, ['kernel', '0.3'])
  assert.equal(r.code, 0, r.out)

  assert.match(read(root, 'version.mjs'), /export const KERNEL_VERSION = 'dev 0\.3'/)
  assert.equal(JSON.parse(read(root, 'kernel/package.json')).version, '0.3.0')
  const { versions, reds } = v3Of(root)
  assert.equal(versions.lines.find((l) => l.id === 'KERNEL_VERSION').mirrorValue, '0.3.0')
  assert.equal(versions.history.records.at(-1).key, 'KERNEL_VERSION@version.mjs')
  assert.deepEqual(reds('V3').map((f) => f.subject), [])
  assert.deepEqual(reds('V4').map((f) => f.subject), [])
})

test('三线 --dry-run 都不改任何文件（预演比不做更坏：会污染工作树）', () => {
  for (const [target, ver] of [['app', '3.0.1'], ['kernel', '0.3'], ['pkg', '2.9.0']]) {
    const root = bumpFixture()
    const before = snapshot(root)
    const r = runBump(root, [target, ver, '--dry-run'])
    assert.equal(r.code, 0, r.out)
    assert.deepEqual(snapshot(root), before, `${target} --dry-run 改了文件`)
  }
})

test('非法输入（未知目标 / 非法版本号 / 缺版本号）→ 非 0 退出且不改文件', () => {
  const root = bumpFixture()
  const before = snapshot(root)
  for (const args of [['nope', '1.0'], ['app', '3.x'], ['app'], ['pkg', '']]) {
    const r = runBump(root, args)
    assert.notEqual(r.code, 0, `${JSON.stringify(args)} 必须失败：${r.out}`)
    assert.deepEqual(snapshot(root), before, `${JSON.stringify(args)} 失败时不得改文件`)
  }
})

// ── Task 9 rider 1（治理）：台账 ≠ 宿主时 bump 必须 fail-loud，不许把漂移洗白 ──
//
// 修前实测的漏洞：history 记录的 `from` 取自**台账旧值**（`entry.value`）。于是
//   ① 手改台账 APP_VERSION = 'dev 2.0.0'（此时 V1 已红：台账 ≠ 宿主真值 'dev 3.0.0'）
//   ② 跑 `bump app 3.0.1` → history 记 from:'dev 2.0.0'（**与宿主真值不符**）
//   ③ sync 之后 V1/V3 全绿 —— 漂移无痕消失，history 里还留下一段假历史。
// 这与前几轮修掉的"基线抹平红灯""ghost 静默放行"同族：**一次动作把检查结果擦干净**。
// 本仓取 fail-loud：带着脏台账发版必须在入口被挡住，而不是被一次 bump 顺手抹平。
test('★Rider1：台账与宿主不一致 → bump 明确失败，且不把台账改成一致', () => {
  const root = bumpFixture()
  const ledgerPath = join(root, 'kit', 'manifest', 'versions.json')
  const led = JSON.parse(readFileSync(ledgerPath, 'utf8'))
  led.lines.find((l) => l.id === 'APP_VERSION').value = 'dev 2.0.0'   // 只改台账，宿主 version.mjs 仍是 dev 3.0.0
  writeFileSync(ledgerPath, JSON.stringify(led, null, 2) + '\n')

  const before = snapshot(root)
  const r = runBump(root, ['app', '3.0.1'])
  assert.notEqual(r.code, 0, `台账与宿主不一致时必须 fail-loud：${r.out}`)
  assert.match(r.out, /台账与宿主不一致/, '必须说清是"台账≠宿主"这一类问题，而不是笼统报错')
  assert.deepEqual(snapshot(root), before, '失败时宿主文件与台账都不得被改（改了就等于把漂移擦掉）')
  // 反向：漂移必须仍被 V1 报红 —— 证明 bump 没能把它藏起来（否则这条测试自己就成了"洗白"的帮凶）
  assert.equal(v3Of(root).reds('V1').length, 1, '漂移必须仍被 V1 报红（"台账≠宿主"的场景必须留在门禁视野里）')
})

// ── Task 9 rider 2：非原子 —— 先全量预检再落盘（某一路失败则其它文件一字节未改）──
//
// 修前实测：`patch()` 是"边找边写"。双引号反例下 version.mjs 已写、而 version.test.mjs 的
// 断言找不到 → fail 退出，仓库停在"四分之三改了"的半成品状态；**重跑同命令不自愈**
// （第二次从新值找旧文本，必然再失败），只能手改。下面两条分别打第 ② 路与第 ③ 路。
test('★Rider2-②：断言写法替换不到 → 预检拦在落盘前，其它文件一字节未改', () => {
  const root = bumpFixture({ singleQuoteAssert: false })
  const before = snapshot(root)
  const r = runBump(root, ['app', '3.0.1'])
  assert.notEqual(r.code, 0, r.out)
  assert.match(r.out, /未找到待替换文本/)
  assert.deepEqual(snapshot(root), before, '预检失败时 version.mjs / 台账 / 断言文件都不得被改')
})

test('★Rider2-③：内核镜像文件替换不到 → version.mjs 的常量也不得被改（全量预检）', () => {
  // kernel/package.json 写成 `"version" : "0.2.0"`（冒号前多一空格）：JSON.parse 读得出 0.2.0，
  // 但 bump 的字面替换 `"version": "0.2.0"` 找不到 —— 第 ③ 路失败。
  const root = bumpFixture({ kernelPkg: '{ "name": "fx-kernel", "version" : "0.2.0" }\n' })
  const before = snapshot(root)
  const r = runBump(root, ['kernel', '0.3'])
  assert.notEqual(r.code, 0, r.out)
  assert.match(r.out, /未找到/, '失败必须是"文本找不到"这一类可诊断的原因')
  assert.deepEqual(snapshot(root), before, '第 ③ 路失败时 version.mjs（第 ① 路）必须保持未改')
})
