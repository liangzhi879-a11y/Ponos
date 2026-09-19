// kit/lib/dep-rules.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDepRules } from './dep-rules.mjs'
import { syncDeps, readDeps, readJson, parseDeclaredImports, packageRootOf } from './ledger.mjs'

// ★ Rider 3 之后 `ghost` 是**必传**参数（缺省抛错）。这个夹具包装让每个用例都显式回答
//   "本次幽灵依赖算出来是什么"，而不是靠一个默认 `[]` 把 P2 静默放行；
//   同时把 `pkg` 与夹具台账对齐（P7 的对账对象），否则 `root: '.'` 会去读真仓的 package.json。
function rules({ deps: d = deps(), ghost = [], pkg = FIXTURE_PKG, ...rest } = {}) {
  return runDepRules({ root: '.', deps: d, ghost, pkg, ...rest })
}
/** 与下方 `deps()` 夹具逐项对应：react/xlsx 在 npm-runtime，@types/node 在 npm-dev */
const FIXTURE_PKG = {
  dependencies: { react: '^18', xlsx: '^0.18' },
  devDependencies: { '@types/node': '^20' },
  scripts: {},
}

const deps = (over = {}) => ({
  version: 1,
  python: { embedded: ['openpyxl', 'PyPDF2'] },
  domains: {
    'npm-runtime': { source: 'package.json#dependencies', packages: [
      { name: 'react', status: 'used', evidence: { classes: ['import'], files: ['src/a.ts'] } },
      { name: 'xlsx', status: 'unused', evidence: { classes: [], files: [] } },
    ] },
    'npm-dev': { source: 'package.json#devDependencies', packages: [
      { name: '@types/node', status: 'used', evidence: { classes: ['types'], files: ['tsconfig.json'] } },
    ] },
    kernel: { source: 'kernel/package.json#dependencies', assertZero: true, packages: [] },
    'python-embedded': { source: 'kit/manifest/deps.json#python.embedded', packages: [{ name: 'openpyxl' }, { name: 'PyPDF2' }] },
    'python-skills': { source: 'x', packages: [{ name: 'openpyxl' }, { name: 'pdfplumber' }] },
  },
  gates: { ci: [], manual: [] },
  sizes: {},
  ...over,
})

test('P1 反例：声明了但零证据 → 红（unused 判定的落地）', () => {
  const { findings } = rules()
  const p1 = findings.filter((f) => f.rule === 'P1')
  assert.equal(p1.length, 1)
  assert.match(p1[0].subject, /xlsx/)
})

test('P2 反例：幽灵依赖（源码 import 未声明）→ 红', () => {
  const { findings } = rules({ ghost: ['left-pad'] })
  assert.equal(findings.filter((f) => f.rule === 'P2').length, 1)
})

test('P3 反例：内核域出现依赖 → 红（恒为零依赖）', () => {
  const d = deps()
  d.domains.kernel = { ...d.domains.kernel, packages: [{ name: 'ws', status: 'declared' }] }
  const { findings } = rules({ deps: d })
  assert.equal(findings.filter((f) => f.rule === 'P3').length, 1)
})

test('P4：内嵌 Python 清单必须来自 deps.json（构建脚本与台账一致由测试保证）', () => {
  const d = deps()
  d.domains['python-embedded'].source = 'scripts/build-embedded-python.mjs'
  const { findings } = rules({ deps: d })
  assert.equal(findings.filter((f) => f.rule === 'P4').length, 1)
})

test('P5：两套 Python 清单差集 → 黄灯并逐项列出（不红）', () => {
  const { findings } = rules()
  const p5 = findings.filter((f) => f.rule === 'P5')
  assert.equal(p5.length, 1)
  assert.equal(p5[0].severity, 'yellow')
  assert.match(p5[0].actual, /pdfplumber/)
})

test('P6：sizes 缺失仅提示，不阻断', () => {
  const d = deps()
  d.sizes = {}
  const { findings } = rules({ deps: d })
  const p6 = findings.filter((f) => f.rule === 'P6')
  assert.equal(p6.every((f) => f.severity === 'yellow'), true)
})

test('全绿基线：无未用、无幽灵、内核零依赖、台账与宿主一致 → 无红灯', () => {
  const d = deps()
  d.domains['npm-runtime'].packages = [d.domains['npm-runtime'].packages[0]]
  d.domains['python-skills'].packages = [{ name: 'openpyxl' }, { name: 'PyPDF2' }]
  d.sizes = { 'node_modules': 1, 'runtime/python': 1, 'runtime/skills': 1 }
  // P7（Rider 2）落地后，"全绿"必须把宿主包集也造齐 —— 上面把 xlsx 从台账摘掉了，
  // 若 pkg 仍声明它，P7 会（正确地）报红。这条正是 P7 判据有约束力的旁证。
  const pkg = { dependencies: { react: '^18' }, devDependencies: { '@types/node': '^20' } }
  const { findings } = rules({ deps: d, pkg })
  assert.deepEqual(findings.filter((f) => f.severity === 'red'), [])
  assert.equal(rules({ deps: d, pkg }).checks.find((c) => c.rule === 'P7').passed, true)
})

// ── R4（Task 5 复审 rider）：真仓数字必须被规则钉住，不能只有夹具测试 ──────────
// 用**已提交的** ledger（kit/manifest/deps.json）而不是现场扫描：干净克隆里稳定，
// 且不依赖 scratch/ release/ 这类磁盘状态。
// ⚠️ B1（Task 10）按 spec 删掉这 10 个未用运行时依赖后，本测试必须同步更新为 0 条
//    —— 这是刻意的：真仓数字要有人负责，删完不更新就报红。
test('R4：真仓台账的实测数字被 P1 覆盖（51+13 声明 / 9 未用，逐条报红）', () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const depsData = readDeps({ root: ROOT })
  assert.ok(depsData, 'kit/manifest/deps.json 必须存在（干净克隆里它是已跟踪文件）')
  const counts = Object.fromEntries(Object.entries(depsData.domains).map(([k, d]) => [k, (d.packages || []).length]))
  assert.equal(counts['npm-runtime'], 51, '运行时声明数（Task 5 实测）')
  assert.equal(counts['npm-dev'], 13, 'dev 声明数（Task 5 实测）')
  assert.equal(counts.kernel, 0, '内核域恒零依赖')

  const { findings, checks } = runDepRules({ root: ROOT, deps: depsData, ghost: [],
    pkg: readJson({ root: ROOT, rel: 'package.json' }) })
  const p1 = findings.filter((f) => f.rule === 'P1').map((f) => f.subject).sort()
  assert.deepEqual(p1, [
    '@radix-ui/react-collapsible@npm-runtime', '@radix-ui/react-context-menu@npm-runtime',
    '@radix-ui/react-popover@npm-runtime', '@tanstack/react-virtual@npm-runtime',
    'classic-level@npm-runtime', 'diff@npm-runtime', 'mammoth@npm-runtime', 'nanoid@npm-runtime',
    'xlsx@npm-runtime'
  ], '真仓"零引用证据"的 9 条必须逐条报红（B1 的删除清单就是它）')
  assert.equal(findings.filter((f) => f.rule === 'P3' || f.rule === 'P4').length, 0)
  // P5 的差集是黄灯（内嵌 13 个 vs requirements 的差集），绝不是红
  assert.equal(findings.filter((f) => f.severity === 'red' && f.rule === 'P5').length, 0)
})

// ── R4（Task 5 复审 rider）：规则必须能发现"台账与宿主不一致" ─────────────────
// 上面 8 条里有 7 条是手写台账对象（夹具直接给 `status` / 直接给 `ghost`），证明不了
// "check 时真读宿主文件"这条路径。以下两条走**真扫描**：fixture 仓 → syncDeps 写台账 →
// 现场扫宿主算 ghost → 喂给 runDepRules，即 Task 7 `collect()` 的实际链路。

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'yfw-deprules-'))
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content)
  }
  return root
}

/** 与 Task 7 `ghostOf()` 同口径：现场扫宿主源码，减去台账里声明的包名 */
function ghostOf({ root, files, depsData }) {
  const declared = new Set(Object.values(depsData.domains).flatMap((d) => (d.packages || []).map((p) => p.name)))
  return [...new Set(parseDeclaredImports({ root, files }).map(packageRootOf))]
    .filter((n) => n && !n.startsWith('node:') && !n.startsWith('@/') && !declared.has(n))
    .sort()
}

test('R4：台账与宿主不一致（宿主在用、台账未声明）→ P2 红，且 subject 就是那个包', () => {
  const root = fixture({
    'package.json': JSON.stringify({ dependencies: { react: '^18' }, devDependencies: {}, scripts: {} }),
    'src/a.ts': "import { x } from 'react'\n",
    'kernel/package.json': '{}',
  })
  const files = ['package.json', 'src/a.ts', 'kernel/package.json']
  syncDeps({ root, files })
  const depsData = readDeps({ root })

  // 台账自洽：只有 react 声明、且在用时零红
  assert.deepEqual(runDepRules({ root, deps: depsData, ghost: ghostOf({ root, files, depsData }), pkg: readJson({ root, rel: 'package.json' }) })
    .findings.filter((f) => f.severity === 'red'), [])

  // 制造不一致：台账（=已提交的 deps.json）里把 react 整条删掉（等价于"改声明后忘了 sync"）
  const stale = JSON.parse(JSON.stringify(depsData))
  stale.domains['npm-runtime'].packages = []
  const { findings } = runDepRules({ root, deps: stale, ghost: ghostOf({ root, files, depsData: stale }), pkg: readJson({ root, rel: 'package.json' }) })
  const p2 = findings.filter((f) => f.rule === 'P2')
  assert.deepEqual(p2.map((f) => f.subject), ['react'], '宿主在 import、台账没声明 → 必须报红并指名到包')
  assert.equal(p2[0].severity, 'red')
})

test('R4：sync 后的台账必须与宿主一致 —— 无用包落成 P1 红，且在用的包一条都不红（真仓 52/13/10 走的就是这条）', () => {
  const root = fixture({
    'package.json': JSON.stringify({
      dependencies: { react: '^18', 'classic-level': '^3', xlsx: '^0.18' },
      devDependencies: { '@types/node': '^20' },
      scripts: {},
    }),
    'src/a.ts': "import { x } from 'react'\n",
    'tsconfig.json': '{ "include": ["src"] }',
    'kernel/package.json': '{}',
  })
  const files = ['package.json', 'src/a.ts', 'tsconfig.json', 'kernel/package.json']
  const { data } = syncDeps({ root, files })
  const { findings, checks } = runDepRules({ root, deps: data, ghost: [], pkg: readJson({ root, rel: 'package.json' }) })
  const p1 = findings.filter((f) => f.rule === 'P1')
  assert.deepEqual(p1.map((f) => f.subject), ['classic-level@npm-runtime', 'xlsx@npm-runtime'],
    '宿主零证据的声明必须逐条报红（subject 带域，才能指回 package.json#dependencies）')
  assert.equal(p1[0].severity, 'red')
  assert.equal(checks.find((c) => c.rule === 'P1').passed, false, 'P1 的 check 也必须标失败（summary.green 靠它）')
  // ★ Rider 3：不传 ghost 不再是"P2 静默全绿"，而是**抛错**（见下方专门的测试）
  assert.equal(runDepRules({ root, deps: data, ghost: [], pkg: readJson({ root, rel: 'package.json' }) }).findings.filter((f) => f.rule === 'P2').length, 0)
})

// ── Rider 2（Task 7）：P7 —— 台账包集 ↔ package.json 包集（双向） ────────────────
// 为什么必须有：P1/P2 **只读台账**。实测从 package.json 删掉在用声明而不重跑 sync，
// 红灯数一条不变（那 10 条 P1 反而变成陈旧误报）。Task 10 的任务就是"删 10 个依赖"，
// 没有 P7 时"删了却忘 sync"完全不可见 —— 台账与实际长期脱节（违反 I1：单一真源）。
test('★P7-①：台账与 package.json 一致 → P7 绿（正例；缺它则"永远报红"也能骗过反例）', () => {
  const { findings, checks } = rules({ pkg: FIXTURE_PKG })
  assert.deepEqual(findings.filter((f) => f.rule === 'P7'), [])
  assert.equal(checks.find((c) => c.rule === 'P7').passed, true)
  assert.equal(checks.find((c) => c.rule === 'P7').evaluated, 3, 'evaluated = 参与对账的包数（两边并集：react/xlsx/@types/node）')
})

test('★P7-②：package.json 少了一个台账声明的包 → 红，提示重跑 kit:sync', () => {
  // 等价于"从 package.json 删掉 zustand / xlsx / @types/node 却不重跑 sync"（Task 10 的真实路径）
  const { findings, checks } = rules({ pkg: { dependencies: { react: '^18' }, devDependencies: { '@types/node': '^20' } } })
  const p7 = findings.filter((f) => f.rule === 'P7')
  assert.deepEqual(p7.map((f) => f.subject), ['xlsx@npm-runtime'])
  assert.deepEqual(p7.map((f) => f.severity), ['red'])
  assert.match(p7[0].hint, /kit:sync/)
  assert.equal(checks.find((c) => c.rule === 'P7').passed, false)
})

test('★P7-③：package.json 多了一个台账没有的包 → 红（漏登记）', () => {
  const { findings } = rules({ pkg: { ...FIXTURE_PKG, dependencies: { ...FIXTURE_PKG.dependencies, zustand: '^4' } } })
  const p7 = findings.filter((f) => f.rule === 'P7')
  assert.deepEqual(p7.map((f) => f.subject), ['zustand@package.json'])
  assert.match(p7[0].hint, /kit:sync/)
})

test('★P7-④：peerDependencies 刻意**不纳入**对账（双向反例：纳入会让正常配置假红）', () => {
  // ① 只出现在 peerDependencies 的包 → 不算"宿主声明"，故台账里没有它**不**报红
  const ok = rules({ pkg: { ...FIXTURE_PKG, peerDependencies: { eslint: '^8' } } })
  assert.deepEqual(ok.findings.filter((f) => f.rule === 'P7'), [], 'peer 是消费方约束、不是本仓分发内容，不得当成漏登记')
  // ② 台账声明的包若只出现在 peerDependencies → 仍然是"台账陈旧"（红），
  //    否则 peer 会成为绕过 P7 的后门（把包从 dependencies 挪进 peer 就查不出来了）
  const bad = rules({ pkg: { dependencies: { react: '^18' }, devDependencies: { '@types/node': '^20' }, peerDependencies: { xlsx: '^0.18' } } })
  assert.deepEqual(bad.findings.filter((f) => f.rule === 'P7').map((f) => f.subject), ['xlsx@npm-runtime'])
})

test('★P7-⑤：读不到 package.json → 红（对账对象缺失不得静默变绿）', () => {
  const { findings } = rules({ pkg: null })
  assert.equal(findings.filter((f) => f.rule === 'P7').length, 1)
  assert.equal(findings.find((f) => f.rule === 'P7').severity, 'red')
})

// ── Rider 3（Task 7）：ghost 必传，禁止失败开放 ─────────────────────────────
test('★Rider3：不传 ghost 必须**抛错**（旧行为是 P2 静默全绿 —— 门禁失效却看不出来）', () => {
  assert.throws(() => runDepRules({ root: '.', deps: deps(), pkg: FIXTURE_PKG }), /ghost/,
    '默认 [] 是失败开放：Task 7 只要忘接线，P2 就永远绿')
  // 反向：显式传空数组是允许的（"我确认本次没有幽灵依赖"），不能变成"传空也抛"
  assert.deepEqual(rules({ ghost: [] }).findings.filter((f) => f.rule === 'P2'), [])
})

// ── Rider 4-③：P0（deps.json 缺失）必须有自己的测试 …………………………………………………… ──
test('★Rider4-③ P0：deps.json 缺失 → 红（人话提示重跑 kit:sync，且不抛栈）', () => {
  // ghost 仍要显式传：Rider 3 的"必传"没有例外分支（deps 缺失时也没有"忘接线没关系"的场景），
  // 这里传空数组表达的是"台账都不在，幽灵清单无意义"，是**显式决定**而非默认值兜底。
  const { findings, checks } = runDepRules({ root: '.', deps: null, ghost: [] })
  assert.deepEqual(findings.map((f) => f.rule), ['P0'])
  assert.equal(findings[0].severity, 'red')
  assert.match(findings[0].hint, /kit:sync/)
  // ★ Task 8 / B2：P0 必须也 push checkResult。原先早退只 push finding →
  //   summary.rules 报 18 而实现有 19 个规则号，且 --verbose 的逐条表里**看不到 P0**
  //   （"哪条规则真的跑过"在报告里缺一块，正是 --verbose 存在的理由）。
  assert.equal(checks.length, 1, '台账缺失时唯一可判定的规则就是 P0 —— 它必须出现在 checks 里')
  assert.equal(checks[0].rule, 'P0')
  assert.equal(checks[0].passed, false, '台账不在 → P0 未通过（红线与 checks 两处必须同口径）')
  assert.equal(checks[0].evaluated, 1)
})

test('★B2：台账在时 P0 同样进 checks（passed=true）—— 否则正常仓 rules 仍是 18', () => {
  // 若 P0 只在"台账缺失"分支里 push，两个分支互斥 → 正常仓永远少一个规则号，
  // 报告与实现依旧两套口径。这条断言钉住"无条件 push"。
  const { checks, findings } = rules({})
  assert.deepEqual(findings.filter((f) => f.rule === 'P0'), [])
  const p0 = checks.filter((c) => c.rule === 'P0')
  assert.equal(p0.length, 1)
  assert.equal(p0[0].passed, true)
  assert.equal(p0[0].evaluated, 1)
  assert.deepEqual(checks.map((c) => c.rule), ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'],
    '依赖侧 8 条规则号一条都不能少')
})

// ── Rider 4-②：P6 标题与判据对齐（旧判据 `keys.length > 0` 漏记两项也照样通过） ──────
test('★Rider4-② P6：三域体积键齐备才算通过；缺一项即未通过（旧判据只要有任意一键就绿）', () => {
  const full = rules({ deps: { ...deps(), sizes: { 'node_modules': 1, 'runtime/python': 1, 'runtime/skills': 1 } } })
  assert.equal(full.checks.find((c) => c.rule === 'P6').passed, true)
  assert.equal(full.checks.find((c) => c.rule === 'P6').evaluated, 3)

  const partial = rules({ deps: { ...deps(), sizes: { 'node_modules': 1 } } })
  const p6 = partial.findings.filter((f) => f.rule === 'P6')
  assert.deepEqual(p6.map((f) => f.subject), ['sizes.runtime/python', 'sizes.runtime/skills'],
    '漏记哪一项必须逐项列出来（旧判据下这里一条都不报、check 还 passed=true）')
  assert.equal(partial.checks.find((c) => c.rule === 'P6').passed, false)
  assert.equal(partial.checks.find((c) => c.rule === 'P6').title.includes('三域'), true, '标题必须与核对的键数一致（原写"四域"却只核 3 键）')
})

// ── 真仓：P7 必须在真仓零红（否则 Task 7 上线当天就多 10 条假红） ─────────────
test('★P7：真仓 package.json 与台账双向一致（52+13），零 P7 红', () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const depsData = readDeps({ root: ROOT })
  const pkg = readJson({ root: ROOT, rel: 'package.json' })
  const { findings } = runDepRules({ root: ROOT, deps: depsData, ghost: [], pkg })
  assert.deepEqual(findings.filter((f) => f.rule === 'P7').map((f) => f.subject), [])
})
