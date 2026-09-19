// kit/lib/dep-rules.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDepRules } from './dep-rules.mjs'
import { syncDeps, readDeps, parseDeclaredImports, packageRootOf } from './ledger.mjs'

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
  const { findings } = runDepRules({ root: '.', deps: deps() })
  const p1 = findings.filter((f) => f.rule === 'P1')
  assert.equal(p1.length, 1)
  assert.match(p1[0].subject, /xlsx/)
})

test('P2 反例：幽灵依赖（源码 import 未声明）→ 红', () => {
  const { findings } = runDepRules({ root: '.', deps: deps(), ghost: ['left-pad'] })
  assert.equal(findings.filter((f) => f.rule === 'P2').length, 1)
})

test('P3 反例：内核域出现依赖 → 红（恒为零依赖）', () => {
  const d = deps()
  d.domains.kernel = { ...d.domains.kernel, packages: [{ name: 'ws', status: 'declared' }] }
  const { findings } = runDepRules({ root: '.', deps: d })
  assert.equal(findings.filter((f) => f.rule === 'P3').length, 1)
})

test('P4：内嵌 Python 清单必须来自 deps.json（构建脚本与台账一致由测试保证）', () => {
  const d = deps()
  d.domains['python-embedded'].source = 'scripts/build-embedded-python.mjs'
  const { findings } = runDepRules({ root: '.', deps: d })
  assert.equal(findings.filter((f) => f.rule === 'P4').length, 1)
})

test('P5：两套 Python 清单差集 → 黄灯并逐项列出（不红）', () => {
  const { findings } = runDepRules({ root: '.', deps: deps() })
  const p5 = findings.filter((f) => f.rule === 'P5')
  assert.equal(p5.length, 1)
  assert.equal(p5[0].severity, 'yellow')
  assert.match(p5[0].actual, /pdfplumber/)
})

test('P6：sizes 缺失仅提示，不阻断', () => {
  const d = deps()
  d.sizes = {}
  const { findings } = runDepRules({ root: '.', deps: d })
  const p6 = findings.filter((f) => f.rule === 'P6')
  assert.equal(p6.every((f) => f.severity === 'yellow'), true)
})

test('全绿基线：无未用、无幽灵、内核零依赖 → 无红灯', () => {
  const d = deps()
  d.domains['npm-runtime'].packages = [d.domains['npm-runtime'].packages[0]]
  d.domains['python-skills'].packages = [{ name: 'openpyxl' }, { name: 'PyPDF2' }]
  d.sizes = { 'node_modules': 1, 'runtime/python': 1, 'runtime/skills': 1 }
  const { findings } = runDepRules({ root: '.', deps: d })
  assert.deepEqual(findings.filter((f) => f.severity === 'red'), [])
})

// ── R4（Task 5 复审 rider）：真仓数字必须被规则钉住，不能只有夹具测试 ──────────
// 用**已提交的** ledger（kit/manifest/deps.json）而不是现场扫描：干净克隆里稳定，
// 且不依赖 scratch/ release/ 这类磁盘状态。
// ⚠️ B1（Task 10）按 spec 删掉这 10 个未用运行时依赖后，本测试必须同步更新为 0 条
//    —— 这是刻意的：真仓数字要有人负责，删完不更新就报红。
test('R4：真仓台账的实测数字被 P1 覆盖（52+13 声明 / 10 未用，逐条报红）', () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const depsData = readDeps({ root: ROOT })
  assert.ok(depsData, 'kit/manifest/deps.json 必须存在（干净克隆里它是已跟踪文件）')
  const counts = Object.fromEntries(Object.entries(depsData.domains).map(([k, d]) => [k, (d.packages || []).length]))
  assert.equal(counts['npm-runtime'], 52, '运行时声明数（Task 5 实测）')
  assert.equal(counts['npm-dev'], 13, 'dev 声明数（Task 5 实测）')
  assert.equal(counts.kernel, 0, '内核域恒零依赖')

  const { findings } = runDepRules({ root: ROOT, deps: depsData })
  const p1 = findings.filter((f) => f.rule === 'P1').map((f) => f.subject).sort()
  assert.deepEqual(p1, [
    '@radix-ui/react-collapsible@npm-runtime', '@radix-ui/react-context-menu@npm-runtime',
    '@radix-ui/react-popover@npm-runtime', '@radix-ui/react-separator@npm-runtime',
    '@tanstack/react-virtual@npm-runtime', 'classic-level@npm-runtime', 'diff@npm-runtime',
    'mammoth@npm-runtime', 'nanoid@npm-runtime', 'xlsx@npm-runtime',
  ], '真仓"零引用证据"的 10 条必须逐条报红（B1 的删除清单就是它）')
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
  assert.deepEqual(runDepRules({ root, deps: depsData, ghost: ghostOf({ root, files, depsData }) })
    .findings.filter((f) => f.severity === 'red'), [])

  // 制造不一致：台账（=已提交的 deps.json）里把 react 整条删掉（等价于"改声明后忘了 sync"）
  const stale = JSON.parse(JSON.stringify(depsData))
  stale.domains['npm-runtime'].packages = []
  const { findings } = runDepRules({ root, deps: stale, ghost: ghostOf({ root, files, depsData: stale }) })
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
  const { findings, checks } = runDepRules({ root, deps: data })
  const p1 = findings.filter((f) => f.rule === 'P1')
  assert.deepEqual(p1.map((f) => f.subject), ['classic-level@npm-runtime', 'xlsx@npm-runtime'],
    '宿主零证据的声明必须逐条报红（subject 带域，才能指回 package.json#dependencies）')
  assert.equal(p1[0].severity, 'red')
  assert.equal(checks.find((c) => c.rule === 'P1').passed, false, 'P1 的 check 也必须标失败（summary.green 靠它）')
  assert.equal(runDepRules({ root, deps: data }).findings.filter((f) => f.rule === 'P2').length, 0)
})
