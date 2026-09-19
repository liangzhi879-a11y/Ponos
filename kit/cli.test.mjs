// kit/cli.test.mjs —— CLI 端到端（spawn 真进程，非 mock）
//
// 为什么必须 spawn 真进程：CLI 的全部价值都在"进程外可观察的行为"上 —— 退出码、stdout 的
// JSON 形状、以及"check 绝不写文件"。这三样 import 都测不到（process.exit 会直接杀掉测试进程）。
//
// ★ 退出码的判据必须**双向**，而 Task 12（Rider A 补 4 条声明）之后**真仓已全绿**，
//   所以"真仓 check 退 1"这个方向必须由**夹具仓**来钉（三条：缺台账 → P0/V0 红；
//   台账与 package.json 脱节 → P7 红；一致 → 退 0）。真仓侧改为钉"红灯 0 / 黄灯 1"这个
//   已知状态 —— 它本身也是断言：多一条红灯（例如 P2 幽灵依赖复发）同样会在这里变红。
//   只钉"退 0"会退化成不可能独立失败的断言（硬编码 exit(0) 也能过），故两个方向都留着。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCiChain, ciChainScripts } from '../scripts/test-tiers.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = resolve(ROOT, 'kit/cli.mjs')

/** 真进程跑 CLI；失败（非 0 退出）时把 stdout/stderr 合并返回，便于断言里看原因 */
function run(args, { cwd = ROOT, env = {} } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60000,
    })
    return { code: 0, stdout }
  } catch (e) {
    return { code: e.status ?? -1, stdout: `${e.stdout || ''}${e.stderr || ''}` }
  }
}

// ── 夹具仓：mkdtemp + 真 git（不依赖本机磁盘状态；CI 无 scratch/ release/ 也能跑） ──
// 为什么必须是真 git 仓：扫描域 = `git ls-files`（不变量 I2），未入库文件不参与判定，
// 故夹具必须 `git add` 过；用磁盘遍历冒充会掩盖"未入库即不存在"这条口径。
// ★ 第 3 批起还必须是**有提交**的仓：契约规则的真值取自**提交态 HEAD**（`kit/lib/head-tree.mjs`
//   物化检出），没提交的仓连"提交态"都不存在 ⇒ 夹具一律 `git commit`（这也让夹具的
//   "已入库"与"已提交"两种状态可分：`gitCommit(root)` 之后才是提交态，之前是在途改动）。
const gitCommit = (root, msg = 'fx') => execFileSync('git',
  ['-c', 'user.email=fx@example.com', '-c', 'user.name=fx', '-c', 'commit.gpgsign=false', 'commit', '-qm', msg],
  { cwd: root })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'yfw-kit-cli-'))
  const write = (rel, content) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  write('package.json', JSON.stringify({
    name: 'fx', version: '1.0.0',
    dependencies: { react: '^18' }, devDependencies: { '@types/node': '^20' }, scripts: {},
  }, null, 2))
  write('src/a.ts', "import { useState } from 'react'\nexport const x = useState\n")
  write('tsconfig.json', '{ "include": ["src"] }')
  write('.gitignore', 'node_modules/\n')
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', '-A'], { cwd: root })
  gitCommit(root)
  return { root, env: { YFW_KIT_ROOT: root } }
}

const readPkg = (root) => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const writePkg = (root, pkg) => writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2))
const ledgerText = (root) => readFileSync(join(root, 'kit/manifest/deps.json'), 'utf8')
/** 契约面（CT 规则关心的路径）是否有未提交改动 —— 决定真仓断言走"脏树"还是"干净树"分支 */
const dirtyTree = () => execFileSync('git', ['status', '--porcelain', '--', 'server', 'electron', 'kernel', 'src', 'shared', 'docs/bridge-contract.md'],
  { cwd: ROOT, encoding: 'utf8' }).trim().length > 0

// ── 真仓：已提交的台账 + 已提交的测试层，干净克隆里同样成立 ────────────────

test('view --json 输出稳定 schema，可被程序直接解析', () => {
  const r = run(['view', '--json'])
  assert.equal(r.code, 0)
  const j = JSON.parse(r.stdout)
  assert.equal(j.schemaVersion, 1)
  assert.equal(typeof j.ok, 'boolean')
  assert.ok(j.summary && typeof j.summary.red === 'number')
  assert.ok(j.ledgers.versions.lines >= 4)
  // ★ Task 10（B1 删 10 个未用依赖）后**不再硬编码数字**：原先写 `>= 50`，而删到第 3 个就跌破 ——
  //   与其每改一次声明就手改阈值，不如钉住更强的判据：view 报的就是**真仓 package.json#dependencies 的条数**
  //   （两侧不等即为台账与宿主脱节，正是 P7 在生产里守的那条不变量）。
  assert.equal(j.ledgers.deps['npm-runtime'], Object.keys(readPkg(ROOT).dependencies).length,
    'view 的运行时声明数必须等于 package.json#dependencies 条数（B1 后 52→42）')
  assert.ok(Array.isArray(j.findings))
})

test('check --json 与 view --json 同源（summary 逐字相等）', () => {
  const a = JSON.parse(run(['view', '--json']).stdout)
  const b = JSON.parse(run(['check', '--json']).stdout)
  assert.deepEqual(b.summary, a.summary, 'check 与 view 若各跑一套规则，就会出现"两个真相"')
})

test('check（人话）：有红灯时退 1 且渲染红灯段（用夹具仓造真红灯，不靠真仓的欠账）', () => {
  const { env } = fixture()   // 夹具仓**不** sync → 缺台账 = P0/V0 红灯
  const r = run(['check', '--verbose'], { env })
  assert.equal(r.code, 1, '有红灯必须退 1（硬编码 exit(0) 会被这条抓住）')
  assert.match(r.stdout, /DevKit 检查/)
  assert.match(r.stdout, /红灯（阻断）/)
})

test('★RiderA：真仓红灯 0 / 黄灯 = P5 + CT8 在途差异（多一条红灯也要在这里变红）', () => {
  const r = run(['check', '--json'])
  const j = JSON.parse(r.stdout)
  assert.equal(r.code, 0, `真仓必须零红灯（Rider A 已给 4 个包补声明），实测 findings=${JSON.stringify(j.findings)}`)
  assert.equal(j.summary.red, 0)
  // ★ 第 3 批：契约规则的真值取自**提交态 HEAD** ⇒ 主树上的他人在途改动**不再**产生任何红灯
  //   （也就不再需要"为在途差异加的红灯基线"）。在途改动一律由 CT8 逐条报黄、只报不拦。
  assert.deepEqual([...new Set(j.findings.filter((f) => f.severity === 'red').map((f) => f.rule))], [])
  // 黄灯只可能来自 P5（两套 Python 清单差集，属预期）与 CT8（工作树 ∖ HEAD 的在途差异）
  const yellows = [...new Set(j.findings.filter((f) => f.severity === 'yellow').map((f) => f.rule))].sort()
  assert.deepEqual(yellows, dirtyTree() ? ['CT8', 'P5'] : ['P5'],
    `黄灯规则集只允许 P5（+ 脏树时的 CT8），实测 ${JSON.stringify(yellows)}`)
  assert.equal(j.summary.yellow, j.findings.filter((f) => f.severity === 'yellow').length, 'summary 必须与实际逐条一致')
  // CT9 的差集（黄、只报不拦）必须**逐条**落在基线里（条数随渲染层调用点变化 ⇒ 不硬编码条数）
  const ct9 = j.findings.filter((f) => f.rule === 'CT9')
  assert.equal(ct9.length > 0, true, 'CT9 至少应报出 /save-temp-image 这类差集')
  assert.deepEqual([...new Set(ct9.map((f) => f.severity))], ['baselined'],
    `CT9 的每条都必须登记进 drift-baseline（不许裸黄），实测 ${JSON.stringify(ct9)}`)
  // ★ 本批的判据（第 2 批审查的两个漏洞的反面）：**CT1/CT2/CT4 不得再因为"工作树脏"出现在报告里**，
  //   更不许靠红线基线放行 —— 那正是"基线为在途差异兜底"的做法，已被本批根治。
  assert.deepEqual(j.findings.filter((f) => ['CT1', 'CT2', 'CT4'].includes(f.rule)), [],
    '在途改动不得让 CT1/CT2/CT4 报出（真值取提交态 ⇒ 它们只反映"提交物与台账的关系"）')
  // 在途差异必须**逐条**列出（不是只报总数）：脏树时 CT8 至少有 1 条，且每条都带方向
  for (const f of j.findings.filter((x) => x.rule === 'CT8')) {
    assert.match(String(f.subject), /\S/, 'CT8 的 subject 必须带键名（计数式 subject 会被一把基线认领任意同类）')
    assert.match(String(f.expected), /^HEAD (有|缺)$/)
    assert.match(String(f.actual), /^工作树 (有|缺)$/)
  }
  if (!dirtyTree()) {
    // 干净工作树（= CI 与评审克隆跑的那棵树）：只允许 P5（黄）+ CT9（基线里逐条，条数随渲染层调用点变化，
    // ★ 故**不硬编码条数**：铁律 4 —— 该数字由 src/ 的现场内容决定，会随他人改动漂移）
    assert.deepEqual(j.findings.filter((f) => f.rule === 'CT8'), [], '干净工作树不得有在途差异')
    assert.deepEqual([...new Set(j.findings.map((f) => f.rule))].sort(), ['CT9', 'P5'],
      '干净工作树只允许 P5（黄）+ CT9（已登记基线）')
    assert.deepEqual(j.findings.filter((f) => f.severity !== 'baselined').map((f) => f.rule), ['P5'])
  }
})

test('check --verbose 逐条列出每条规则的判定结果（--verbose 必须真的多说点什么）', () => {
  const plain = run(['check'])
  const verbose = run(['check', '--verbose'])
  assert.match(verbose.stdout, /规则逐条/)
  assert.match(verbose.stdout, /P7/)
  assert.match(verbose.stdout, /台账包集与 package\.json 双向一致/)
  // P1：CT 规则也必须逐条出现在 --verbose 里（否则"契约对账有没有接线"看不出来）
  assert.match(verbose.stdout, /\[CT1\] 快照可从\*\*提交态\*\*代码现场重算/)
  assert.match(verbose.stdout, /\[CT4\] scope members/)
  assert.match(verbose.stdout, /\[CT8\] 在途差异/)
  // ★ 在途差异恒打印一行（无差异时也要**明说"无"**：不打印 ≠ 没有）
  assert.match(verbose.stdout, /（契约）在途差异（CT8，黄、只报不拦）：/)
  assert.ok(verbose.stdout.length > plain.stdout.length, '--verbose 的输出必须严格多于默认输出')
})

// ── P1（T9）：契约侧的可见性 / sync 边界 / 夹具真红真绿 ──────────────────────
//
// 三条判据各自对应一个**不许做假**的反例：
//   ① 报告只打 scope 总数不打逐条（反例⑦）⇒ 逐条 kind/ns/count/docSection/reason 必须在人类可读报告里能找到；
//   ② `sync` 会写 `contract-scope.json`（反例③：members 自动生成 ⇒ 登记永远自洽、失去意义）⇒ 逐字节断言；
//   ③ 契约规则只在真仓"看起来绿"、夹具里根本不会红（恒绿）⇒ 夹具必须能造出**真红**再转绿。

const readScopeFile = () => JSON.parse(readFileSync(join(ROOT, 'kit/manifest/contract-scope.json'), 'utf8'))

test('★P1-①：契约范围登记段恒打印，且**逐条**列 kind/ns/键数/docSection/reason（只报总数即反例⑦）', () => {
  const scope = readScopeFile()
  const keys = scope.entries.reduce((n, e) => n + e.members.length, 0)
  const human = run(['check']).stdout
  assert.ok(human.includes(`── 契约范围登记（${scope.entries.length} 组 / ${keys} 键）──`),
    `人类可读报告必须有"N 组 / M 键"段（N/M 由登记文件本身算出，不硬编码数字 —— 铁律 4）`)
  for (const e of scope.entries) {
    assert.ok(human.includes(`  [${e.kind}] ${e.ns}  ${e.members.length} 键  docSection=`),
      `${e.kind} ${e.ns} 必须逐条出现（缺一条 = 边界被藏起来）`)
    assert.ok(human.includes(e.reason.slice(0, 16)), `${e.kind} ${e.ns} 的 reason 必须打印出来`)
  }
  // view --json 同源：scope 摘要必须一起输出（AI 侧也要看得见边界）
  const j = JSON.parse(run(['view', '--json']).stdout)
  assert.equal(j.scope.total, scope.entries.length)
  assert.equal(j.scope.keys, keys)
  assert.deepEqual(j.scope.groups.map((g) => `${g.kind}|${g.ns}|${g.count}`),
    scope.entries.map((e) => `${e.kind}|${e.ns}|${e.members.length}`))
})

test('★P1-②：`kit:sync` 不得改写 contract-scope.json（逐字节），且不冲掉 channels 的人工封顶值', () => {
  const scopePath = join(ROOT, 'kit/manifest/contract-scope.json')
  const versionsPath = join(ROOT, 'kit/manifest/versions.json')
  const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
  const before = sha(scopePath)
  const vBackup = readFileSync(versionsPath)
  try {
    assert.equal(run(['sync']).code, 0)
    assert.equal(sha(scopePath), before, 'sync 改了 scope 文件 = members 可被自动生成（反例③），登记失去意义')
    const ch = JSON.parse(readFileSync(versionsPath, 'utf8')).channels
    assert.equal(typeof ch.scopeCount, 'number', 'channels.scopeCount 是人工封顶值：sync 不得冲成 undefined')
    assert.equal(typeof ch.scopeRedCount, 'number')
    assert.ok(ch.snapshotAt && Object.keys(ch.routes).length > 0, '快照本体必须在（CT0/CT1 的前提）')
  } finally {
    // ★ 真仓 sync 在"工作树带他人在途端点"时会更新 channels（那正是它的职责，见 drift-baseline 里的 CT1 条目）；
    //   本用例只关心 scope 文件，故把 versions.json 还原到测试前状态 —— **测试不得把仓库改脏**。
    if (!readFileSync(versionsPath).equals(vBackup)) writeFileSync(versionsPath, vBackup)
  }
  // 幂等口径放在**夹具**（与台账自洽的树）里判：连跑两次，第二次必须逐字节不变
  const { root, env } = fixture()
  mkdirSync(join(root, 'kit/manifest'), { recursive: true })
  writeFileSync(join(root, 'kit/manifest/contract-scope.json'), JSON.stringify({ version: 1, entries: [] }, null, 2))
  execFileSync('git', ['add', '-A'], { cwd: root })
  assert.equal(run(['sync'], { env }).code, 0)
  const p = join(root, 'kit/manifest/versions.json')
  const scopeP = join(root, 'kit/manifest/contract-scope.json')
  const first = readFileSync(p, 'utf8')
  const scopeFirst = readFileSync(scopeP, 'utf8')
  assert.equal(run(['sync'], { env }).code, 0)
  assert.equal(readFileSync(p, 'utf8'), first, 'sync 必须幂等：快照无变化时不得重写 snapshotAt')
  assert.equal(readFileSync(scopeP, 'utf8'), scopeFirst, '夹具侧同样：sync 不得写 scope 文件')
  // --dry-run 同样不落盘
  const dry = run(['sync', '--dry-run'], { env })
  assert.equal(dry.code, 0)
  assert.equal(readFileSync(p, 'utf8'), first)
})

test('★P1-③：夹具仓契约**真红真绿** —— 新增端点未登记 → CT2/CT4 红；登记后转绿', () => {
  const { root, env } = fixture()
  mkdirSync(join(root, 'server'), { recursive: true })
  writeFileSync(join(root, 'server/fx-routes.mjs'),
    ["export function route(pathname) {", "  if (pathname === '/fx') return 1", '  return null', '}', ''].join('\n'))
  execFileSync('git', ['add', '-A'], { cwd: root })
  // ★ 必须**提交**：契约规则的真值取提交态（HEAD）—— 端点只在 `git add` 过而没提交时属"在途"，
  //   那由 CT8 报黄、不红（本文件下面有专门用例）。这里要造的是"提交了但没登记"⇒ 红。
  gitCommit(root)
  assert.equal(run(['sync'], { env }).code, 0)

  const red = run(['check', '--json'], { env })
  assert.equal(red.code, 1, '代码里有端点而 scope 文件不存在 ⇒ 未覆盖的契约面必须报红')
  const rj = JSON.parse(red.stdout)
  assert.deepEqual([...new Set(rj.findings.filter((f) => f.severity === 'red').map((f) => f.rule))].sort(), ['CT2', 'CT4'],
    `实测红灯：${JSON.stringify(rj.findings.filter((f) => f.severity === 'red'))}`)
  // ★ 逐条 + 带成员名（计数式 subject 会被一把基线认领"任意同类单条" —— 第 2 批审查的 M2）
  assert.deepEqual(rj.findings.filter((f) => f.rule === 'CT4').map((f) => f.subject), ['routes 未登记 ANY /fx'])

  // 登记后转绿 —— 登记的"可放行"能力是真的，且只对它登记的那些键生效
  mkdirSync(join(root, 'kit/manifest'), { recursive: true })
  writeFileSync(join(root, 'kit/manifest/contract-scope.json'), JSON.stringify({
    version: 1,
    entries: [{
      kind: 'routes', ns: '/fx', members: ['ANY /fx'], docSection: null,
      reason: '夹具：端点 /fx 未在文档声明（夹具无 bridge-contract.md），按精确键登记',
      at: '2026-09-19',
    }],
  }, null, 2))
  const green = run(['check', '--json'], { env })
  assert.equal(green.code, 0, `登记后必须转绿：${green.stdout}`)
  assert.deepEqual(JSON.parse(green.stdout).findings.filter((f) => f.severity === 'red'), [])
  // 反向：把成员改成前缀（通配）→ CT4C 红（登记不许放宽到"放行一切"）
  writeFileSync(join(root, 'kit/manifest/contract-scope.json'), JSON.stringify({
    version: 1,
    entries: [{ kind: 'routes', ns: '/fx', members: ['ANY /fx*'], docSection: null, reason: '夹具：故意写成通配', at: '2026-09-19' }],
  }, null, 2))
  const wild = run(['check', '--json'], { env })
  assert.equal(wild.code, 1)
  assert.ok(JSON.parse(wild.stdout).findings.some((f) => f.rule === 'CT4C' && f.severity === 'red'))
})

// ── 第 3 批：提交态真值 + CT8 在途差异 + 基线不再被滥用 ─────────────────────
//
// 背景（第 2 批审查）：台账按 committed 落盘、规则却读工作树 ⇒ 主树上的在途改动与台账打架，
// 于是给"在途差异"加了 3 条**红灯基线**。审查实测出两个真漏洞：① 基线按真实端点键认领 ⇒
// `ANY /app-info` 这类键的差异在**任意方向**被永久降级；② 计数式 subject ⇒ 能认领**任意同类**单条。
// 本批把规则真值改成提交态（物化 HEAD），在途差异改由 CT8 报黄、并把那 3 条红基线删掉。
// 下面四条用例分别钉住"黄不红 / 提交后漏登记 → 红 / 假端点 → 红 / 假成员 → 红"。

/** 夹具仓里写一个端点文件（`staged` 只 add 不 commit ⇒ 在途；否则提交 ⇒ 提交态）
 *  `stage:false` = **只写盘、不 git add**（第 4 批的盲区形态：磁盘有、索引无）；`quote` 选引号形态。 */
function writeEndpoint(root, rel, path, { commit = true, stage = true, quote = "'" } = {}) {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), [
    'export function route(pathname) {',
    `  if (pathname === ${quote}${path}${quote}) return 1`,
    '  return null',
    '}',
    '',
  ].join('\n'))
  if (stage) execFileSync('git', ['add', '-A'], { cwd: root })
  // `stage:false, commit:true` 是矛盾组合（什么都没暂存就 commit 会直接失败）⇒ 显式禁掉
  if (commit && !stage) throw new Error('writeEndpoint: commit 需要 stage（否则 git commit 无事可提交）')
  if (commit) gitCommit(root)
}

test('★第3批-①：在途端点（只 add 未 commit）→ 红 0、CT8 逐条黄；提交后漏登记 → CT2/CT4 红', () => {
  const { root, env } = fixture()
  writeEndpoint(root, 'server/wip-routes.mjs', '/zzz-wip', { commit: false })

  const sync = run(['sync'], { env })
  assert.equal(sync.code, 0)
  assert.match(sync.stdout, /在途契约差异\*\*未落盘\*\*/, `sync 必须明说"在途改动没落盘"：${sync.stdout}`)
  const ledger = JSON.parse(readFileSync(join(root, 'kit/manifest/versions.json'), 'utf8'))
  assert.equal(Object.hasOwn(ledger.channels.routes, 'ANY /zzz-wip'), false,
    'sync 落盘的是**提交态**快照 ⇒ 在途端点不得进台账（否则台账描述了未提交的代码）')

  const c = run(['check', '--json'], { env })
  assert.equal(c.code, 0, `在途改动不得让门禁变红：${c.stdout}`)
  const j = JSON.parse(c.stdout)
  assert.deepEqual(j.findings.filter((f) => f.severity === 'red'), [])
  assert.deepEqual(j.findings.filter((f) => f.rule === 'CT8').map((f) => f.subject), ['routes ANY /zzz-wip'])
  assert.deepEqual(j.findings.filter((f) => f.rule === 'CT8').map((f) => f.severity), ['yellow'])

  // 提交之后：它成了"提交物里有、scope 没登记" ⇒ CT2/CT4 必须红（这就是"漏登记"该有的下场）
  gitCommit(root)
  assert.equal(run(['sync'], { env }).code, 0)
  const c2 = run(['check', '--json'], { env })
  assert.equal(c2.code, 1)
  const j2 = JSON.parse(c2.stdout)
  assert.deepEqual(j2.findings.filter((f) => f.rule === 'CT4').map((f) => f.subject), ['routes 未登记 ANY /zzz-wip'])
  assert.deepEqual([...new Set(j2.findings.filter((f) => f.severity === 'red').map((f) => f.rule))].sort(), ['CT2', 'CT4'])
})

// ── 第 4 批（收口）：CT8 的域必须含"未忽略的未跟踪文件"（plan §6 D7 的承诺） ──────────────
//
// 审查实测的盲区：`server/zzz-wip-routes.mjs` **没 `git add`** 时，CT8 完全没反应，
// 人类可读报告还打印「无 —— 工作树契约面与 HEAD 一致」，而 `git status` 明明有 `??`；
// `git add` 之后立刻报出。根因：文件集取 `git ls-files`（**索引**，不含未跟踪）。
// 修法只改 **CT8 的工作树侧文件集**（`git ls-files --cached --others --exclude-standard`）——
// 契约真值侧仍是索引域（I2 不变），也不许退化成 readdirSync 磁盘遍历（D4：`release/`
// `kernel-dist/` 里的 `*-routes.mjs` 是镜像副本，卷进来就是"把副本当真相"）。

test('★第4批-②：未 `git add` 的新路由模块 → CT8 报出（修前静默：打印"与 HEAD 一致"）', () => {
  const { root, env } = fixture()
  assert.equal(run(['sync'], { env }).code, 0)
  writeEndpoint(root, 'server/zzz-wip-routes.mjs', '/zzz-wip', { stage: false, commit: false })   // 只写盘，不 add
  assert.match(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }),
    /\?\? server\/zzz-wip-routes\.mjs/, '前提：必须是"磁盘有、索引无"（未 git add）')

  const c = run(['check', '--json'], { env })
  assert.equal(c.code, 0, `在途改动只报黄、不拦：${c.stdout}`)
  const j = JSON.parse(c.stdout)
  assert.deepEqual(j.findings.filter((f) => f.rule === 'CT8').map((f) => f.subject), ['routes ANY /zzz-wip'],
    `未跟踪的新端点必须由 CT8 报出（修前这里是 []，报告还谎报"与 HEAD 一致"）：${JSON.stringify(j.findings.filter((f) => f.rule === 'CT8'))}`)
  assert.deepEqual([...new Set(j.findings.filter((f) => f.rule === 'CT8').map((f) => f.severity))], ['yellow'],
    '仍**只报黄**：未跟踪文件不得产生任何红（plan D7 写的就是"黄灯提示（不拦）"）')
  assert.deepEqual(j.findings.filter((f) => f.severity === 'red'), [], '未跟踪新文件不得让任何规则报红')
  // 打印行必须注明扫描域：否则读者会把"无差异"读成"磁盘上的新文件也算过了"
  const human = run(['check', '--verbose'], { env }).stdout
  assert.match(human, /在途差异（CT8，黄、只报不拦）：1 条/)
  assert.match(human, /扫描域：git 跟踪 \+ 未忽略的未跟踪文件/, `打印行必须写明扫描域：${human.split('\n').filter((l) => l.includes('在途差异')).join('|')}`)
})

test('★第4批-②（域边界）：被 .gitignore 覆盖的文件不在 CT8 域（不报，域由 git 决定不是磁盘遍历）', () => {
  const { root, env } = fixture()
  assert.equal(run(['sync'], { env }).code, 0)
  writeFileSync(join(root, '.gitignore'), 'node_modules/\nscratch/\n')
  mkdirSync(join(root, 'scratch'), { recursive: true })
  writeFileSync(join(root, 'scratch/zzz-routes.mjs'), "export const r = (p) => p === '/zzz-ignored'\n")
  const c = run(['check', '--json'], { env })
  assert.equal(c.code, 0)
  assert.deepEqual(JSON.parse(c.stdout).findings.filter((f) => f.rule === 'CT8'), [],
    '`scratch/` 被 .gitignore 覆盖 ⇒ 域外（`release/` `kernel-dist/` 这类副本目录同理：D4 明令禁止把它们卷进来）')
  assert.match(run(['check', '--verbose'], { env }).stdout,
    /无 —— 扫描域：git 跟踪 \+ 未忽略的未跟踪文件，与 HEAD 契约面一致/,
    '无差异时的措辞必须**如实**（既不能再说"工作树契约面一致"这种含糊话，也不能漏掉域边界）')
})

test('★第3批-②（审查 M1）：往台账塞一个 HEAD 里没有的端点 → CT1 红（删掉红基线后无法再被认领）', () => {
  const { root, env } = fixture()
  assert.equal(run(['sync'], { env }).code, 0)
  const vPath = join(root, 'kit/manifest/versions.json')
  const v = JSON.parse(readFileSync(vPath, 'utf8'))
  v.channels.routes['ANY /zzz-fake'] = null            // 审查的 M1：台账与代码不符（代码里根本没有）
  writeFileSync(vPath, JSON.stringify(v, null, 2))

  const c = run(['check', '--json'], { env })
  assert.equal(c.code, 1, '台账里的键必须能从提交态代码复算出来 —— 塞假键必须红')
  const ct1 = JSON.parse(c.stdout).findings.filter((f) => f.rule === 'CT1')
  assert.deepEqual(ct1.map((f) => f.subject), ['routes ANY /zzz-fake'])
  assert.deepEqual(ct1.map((f) => f.severity), ['red'])
  // 真仓的 `drift-baseline.json` 不得再为这类键留任何条目（旧的做法：给 `ANY /app-info` 加红灯基线）
  const real = JSON.parse(readFileSync(join(ROOT, 'kit/manifest/drift-baseline.json'), 'utf8'))
  assert.deepEqual(real.entries.filter((e) => String(e.subject).includes('/app-info')), [],
    '在途端点键不得出现在基线里（"为在途差异加基线"已被本批根治）')
  assert.deepEqual(real.entries.filter((e) => e.severity === 'red'), [], '基线里不得再有红灯条目')
})

test('★第4批-④：双引号端点不得静默漏抓 —— 未跟踪时 CT8 报出；提交后不 sync/不登记 ⇒ CT1/CT2/CT4 红', () => {
  const { root, env } = fixture()
  assert.equal(run(['sync'], { env }).code, 0)
  // 真形态（审查核实：真仓 0 处双引号 / 77 处单引号）：`if (pathname === "/zzz-dq")`
  writeEndpoint(root, 'server/dq-routes.mjs', '/zzz-dq', { stage: false, commit: false, quote: '"' })
  const c = run(['check', '--json'], { env })
  assert.deepEqual(JSON.parse(c.stdout).findings.filter((f) => f.rule === 'CT8').map((f) => f.subject),
    ['routes ANY /zzz-dq'], '双引号端点必须与单引号同待遇（修前：提取器认不出它 ⇒ CT8 也是空的）')
  execFileSync('git', ['add', '-A'], { cwd: root })
  gitCommit(root)
  const c2 = run(['check', '--json'], { env })
  assert.equal(c2.code, 1, '提交了却没 sync、没登记 ⇒ 必须红（修前这条路 CT1/CT2/CT4 全绿）')
  assert.deepEqual([...new Set(JSON.parse(c2.stdout).findings.filter((f) => f.severity === 'red').map((f) => f.rule))].sort(),
    ['CT1', 'CT2', 'CT4'], `双引号端点提交后必须被 CT1/CT2/CT4 抓住：${c2.stdout}`)
})

test('★第4批-③：关闭"用基线把契约红灯变绿"的通路 —— CT1 红即使被条目显式认领 severity:red 也必须红', () => {
  const { root, env } = fixture()
  assert.equal(run(['sync'], { env }).code, 0)
  // 造一条真 CT1 红（审查 M1 的做法：台账里塞一个提交态代码里没有的键）
  const vPath = join(root, 'kit/manifest/versions.json')
  const v = JSON.parse(readFileSync(vPath, 'utf8'))
  v.channels.routes['ANY /zzz-red'] = null
  v.history = { ...(v.history || {}), baselineCount: 1, baselineRedCount: 1 }   // 数量护栏不越界 ⇒ 红只能来自 CT1/基线禁豁免
  writeFileSync(vPath, JSON.stringify(v, null, 2))
  writeFileSync(join(root, 'kit/manifest/drift-baseline.json'), JSON.stringify({
    version: 1,
    entries: [{ rule: 'CT1', subject: 'routes ANY /zzz-red', severity: 'red', reason: '变异：用基线把契约红灯降级（第 2 批删掉 3 条走的就是这条路）' }],
  }, null, 2))

  const c = run(['check', '--json'], { env })
  assert.equal(c.code, 1, `契约红灯不得被基线变绿（修前实测 EXIT=0，只有一行"⚠ 基线放行"）：${c.stdout}`)
  const j = JSON.parse(c.stdout)
  assert.deepEqual(j.findings.filter((f) => f.rule === 'CT1').map((f) => [f.subject, f.severity]),
    [['routes ANY /zzz-red', 'red']], 'CT1 必须如实保持红（没被降级成 baselined）')
  assert.deepEqual(j.findings.filter((f) => f.rule === 'BASELINE_FORBIDDEN').map((f) => [f.subject, f.severity]),
    [['CT1 routes ANY /zzz-red', 'red']], '该条目本身必须报红（"该规则不支持豁免"，不许静默忽略）')
  assert.deepEqual(JSON.parse(run(['check', '--json'], { env }).stdout).findings.filter((f) => f.severity === 'baselined'), [],
    '契约类条目不得生效 ⇒ 一条 baselined 都不该有')
})

test('★第3批-③（审查 M2）：往 scope 塞一个假成员 → CT4 红，且 subject 带成员名（计数式会被一把基线认领）', () => {
  const { root, env } = fixture()
  assert.equal(run(['sync'], { env }).code, 0)
  mkdirSync(join(root, 'kit/manifest'), { recursive: true })
  writeFileSync(join(root, 'kit/manifest/contract-scope.json'), JSON.stringify({
    version: 1,
    entries: [{ kind: 'routes', ns: '/zzz-bogus', members: ['ANY /zzz-bogus'], docSection: null, reason: '夹具：故意登记一个不存在的端点' }],
  }, null, 2))
  const c = run(['check', '--json'], { env })
  assert.equal(c.code, 1)
  const ct4 = JSON.parse(c.stdout).findings.filter((f) => f.rule === 'CT4')
  assert.deepEqual(ct4.map((f) => f.subject), ['routes 多登记 ANY /zzz-bogus'])
  assert.equal(/多登记 \d+ 条/.test(ct4[0].subject), false, 'subject 不得是计数（否则一条基线能认领任意同类单条）')
})

test('★第3批-④：空仓（git init 后没提交）→ CT1 红"HEAD 物化"（不假装能对账，也不静默拿工作树顶替）', () => {
  const root = mkdtempSync(join(tmpdir(), 'yfw-kit-nocommit-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '1.0.0', dependencies: {} }, null, 2))
  writeFileSync(join(root, 'src/a.ts'), 'export const x = 1\n')
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', '-A'], { cwd: root })
  const c = run(['check', '--json'], { env: { YFW_KIT_ROOT: root } })
  assert.equal(c.code, 1)
  const j = JSON.parse(c.stdout)
  const ct1 = j.findings.filter((f) => f.rule === 'CT1')
  assert.ok(ct1.some((f) => f.subject === 'HEAD 物化' && f.severity === 'red'),
    `必须明确报出"提交态读不到"：${JSON.stringify(ct1.map((f) => f.subject))}`)
  assert.equal(j.checks.find((x) => x.rule === 'CT1').passed, false)
  assert.equal(j.ok, false)
})

// ── Task 8 / B2 + B3：规则条数口径（规则号数）必须与实现一致 ────────────────
//
// 背景：`summary.rules` 原先报 18，而实现里有 19 个规则号 —— 差的那一个是 P0
// （deps.json 缺失时早退，只 push finding 不 push checkResult）。三处口径并存
// （spec §5.3 表 9 行 + §6.3 表 8 行 = 17、报告 18、实现 19）→ 报告与实现必须对齐，
// 口径写进 spec（§5.3/§6.3 的"规则号数"一节）。
const EXPECTED_RULES = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7',
  'V1', 'V1b', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', "V8'", 'V8b',
  // P1（契约快照 ↔ bridge-contract.md 对账）的 CT 号段：CT0–CT9，含 CT4 的两个子规则（CT4B 封顶 / CT4C 条目合法）
  // 与 CT8（在途差异：工作树 ∖ HEAD，黄、只报不拦 —— 第 3 批拆"基线为在途差异兜底"时补的号位）。
  'CT0', 'CT1', 'CT2', 'CT3', 'CT4', 'CT4B', 'CT4C', 'CT5', 'CT6', 'CT7', 'CT8', 'CT9']

test('★B2/B3：summary.rules = 31，且逐条规则号与 spec 口径完全一致（含表外 V1b/V8b/P0 与 CT0–CT9）', () => {
  const j = JSON.parse(run(['check', '--json']).stdout)
  assert.deepEqual([...j.checks.map((c) => c.rule)].sort(), [...EXPECTED_RULES].sort(),
    '规则号集必须逐字对齐：多一个（自造号）或少一个（早退没 push）都要在这里变红')
  assert.equal(j.summary.rules, 31)
  assert.equal(new Set(j.checks.map((c) => c.rule)).size, 31, '同一个规则号不得重复计入')
  // V6 的标题必须与判据同口径（标题写三方 → 就得真核三方，见 kit/lib/version-rules.mjs）
  assert.match(j.checks.find((c) => c.rule === 'V6').title, /三方/)
  // CT1 的标题必须写明"现场重算"—— 它是红线（读快照当答案是 plan §7 反例⑤）
  assert.match(j.checks.find((c) => c.rule === 'CT1').title, /现场重算/)
})

test('未知子命令 → 非 0 退出且给出用法；无参数 → 只给用法（不允许静默忽略）', () => {
  const bad = run(['nope'])
  assert.notEqual(bad.code, 0)
  assert.match(bad.stdout, /用法/)
  const none = run([])
  assert.equal(none.code, 0)
  assert.match(none.stdout, /用法/)
})

test('check 是纯只读门禁：不得改动 kit/manifest（brief 的反例断言）', () => {
  const before = execFileSync('git', ['status', '--porcelain', 'kit/manifest'], { cwd: ROOT, encoding: 'utf8' })
  run(['check', '--json'])
  const after = execFileSync('git', ['status', '--porcelain', 'kit/manifest'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(after, before, 'check 必须是纯只读：不得改动台账')
})

// ★ Rider 1：ghost 只能走 ledger.mjs 的 computeGhost（sync 与 check 共用一份判据）。
//   计划原文的 ghostOf() 会多报 `~`（public/sample-skills 上游示例的工程别名）与
//   `jszip`（shared/pack-zip.test.mjs:85 的 try/catch 可选探针）→ 真仓 ghost 从 4 虚增到 6。
//
//   ★ Task 12（Rider A 补声明）之后真仓 P2 归零，于是"真仓恰好 4 条"这条判据**失去了
//   发现"多报"的能力**（多报 0 条与多报 2 条现在都等价于"没有 P2 红灯"）。
//   故这里改成双向两条：
//     ① 真仓 P2 必须为空（4 条已补声明；少补一个包 → 立刻红）；
//     ② 用**夹具仓**复现真仓那两类易假阳性的写法（`~/` 别名 + try/catch 可选探针 jszip），
//        断言它们不报、而真幽灵恰好报一条 —— 这才是"不得多报"的判据所在。
test('★RiderA/1：真仓 P2 幽灵依赖归零（4 条已补声明），黄灯只剩 P5', () => {
  const j = JSON.parse(run(['check', '--json']).stdout)
  assert.deepEqual(j.findings.filter((f) => f.rule === 'P2'), [],
    '少补一个包 / 又出现新的幽灵依赖都会在这里变红')
})

test('★Rider1：P2 判据双向 —— `~/` 别名与 try/catch 可选探针不报，真幽灵必须报', () => {
  const { root, env } = fixture()
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src/a.ts'), [
    "import { useState } from 'react'",
    "import type { T } from '~/threads/thread-manager'",   // 上游技能示例的工程别名
    "import { real } from 'left-pad'",                     // 真幽灵
    'export const x = useState; export type X = T; export const y = real',
  ].join('\n'))
  writeFileSync(join(root, 'src/optional.mjs'),
    "let J = null\ntry { J = (await import('jszip')).default } catch { /* 未安装则跳过 */ }\nexport { J }\n")
  execFileSync('git', ['add', '-A'], { cwd: root })
  assert.equal(run(['sync'], { env }).code, 0)

  const j = JSON.parse(run(['check', '--json'], { env }).stdout)
  assert.deepEqual(j.findings.filter((f) => f.rule === 'P2').map((f) => f.subject), ['left-pad'],
    '多报（`~/` 别名 / jszip 这类"有意允许缺失"的探针）与少报（ghost 恒空）都要在这里变红')
})

test('退出码反向：view 必须退 0（否则"check 退 1"可能只是"一律退 1"）', () => {
  assert.equal(run(['view']).code, 0)
  assert.equal(run(['view', '--json']).code, 0)
})

// ── 夹具仓：退出码与 P7（Rider 2）的端到端证据 ────────────────────────────

test('夹具仓一致时 check 无红灯且退 0 —— 退出码真的跟随 report.ok', () => {
  const { root, env } = fixture()
  assert.equal(run(['sync'], { env }).code, 0)
  const c = run(['check', '--json'], { env })
  const j = JSON.parse(c.stdout)
  assert.deepEqual(j.findings.filter((f) => f.severity === 'red'), [], `夹具仓不该有红灯：${c.stdout}`)
  assert.equal(j.ok, true)
  assert.equal(c.code, 0, '无红灯必须退 0（硬编码 exit(1) 会被这条抓住）')
})

test('夹具仓 check 只读（内容级断言：deps.json 逐字不变）', () => {
  const { root, env } = fixture()
  run(['sync'], { env })
  const before = ledgerText(root)
  run(['check'])
  run(['check', '--json'])
  assert.equal(ledgerText(root), before, 'check 改了台账 = 跑门禁会污染仓库状态')
})

test('夹具仓无台账：check 退 1（P0/V0 红），绝不因"读不到台账"静默变绿', () => {
  const { env } = fixture()
  const c = run(['check', '--json'], { env })
  assert.equal(c.code, 1)
  const j = JSON.parse(c.stdout)
  assert.ok(j.findings.some((f) => f.rule === 'P0' && f.severity === 'red'), '缺 deps.json 必须是红灯')
  assert.ok(j.findings.some((f) => f.rule === 'V0'), '缺 versions.json 必须是红灯')
  assert.equal(j.ok, false)
  // ★ B2：P0 必须也进 checks。两条台账都缺时，唯一可判定的规则就是 P0 ——
  //   若 rules 为 0，说明 P0 又退回了"只 push finding"（--verbose 里也会缺这一格）。
  //   ★ P1 之后：契约规则（CT0–CT9）**无条件**进 checks（判据本身要报"快照缺失"），故这里逐条列全。
  assert.deepEqual(j.checks.map((x) => x.rule).sort(),
    ['CT0', 'CT1', 'CT2', 'CT3', 'CT4', 'CT4B', 'CT4C', 'CT5', 'CT6', 'CT7', 'CT8', 'CT9', 'P0'].sort())
  assert.equal(j.checks.find((x) => x.rule === 'P0').passed, false)
  assert.equal(j.summary.rules, 13)
})

// ★ Rider 2：宿主删掉声明却不重跑 sync → 旧判据（P1/P2 只读台账）一条红都不报。
//   Task 10 的任务正是"删 10 个依赖"，没有 P7 就等于删了没人管。
test('★Rider2-①：package.json 删掉台账里的在用声明 → P7 红（P1/P2 都看不见这条）', () => {
  const { root, env } = fixture()
  run(['sync'], { env })
  const pkg = readPkg(root)
  delete pkg.dependencies.react
  writePkg(root, pkg)

  const c = run(['check', '--json'], { env })
  const j = JSON.parse(c.stdout)
  const p7 = j.findings.filter((f) => f.rule === 'P7')
  assert.equal(c.code, 1, '台账与宿主脱节必须让门禁变红')
  assert.deepEqual(p7.map((f) => f.subject), ['react@npm-runtime'])
  assert.deepEqual(p7.map((f) => f.severity), ['red'])
  assert.match(p7[0].hint, /kit:sync/)
  assert.equal(j.findings.filter((f) => f.rule === 'P1').length, 0,
    '台账里 react 仍是 used —— P1 只会读到陈旧结论，这正是要 P7 的理由')
})

test('★Rider2-②：package.json 新增声明但台账没有 → P7 红（漏登记）', () => {
  const { root, env } = fixture()
  run(['sync'], { env })
  const pkg = readPkg(root)
  pkg.dependencies.lodash = '^4.17.21'
  writePkg(root, pkg)

  const c = run(['check', '--json'], { env })
  const j = JSON.parse(c.stdout)
  const p7 = j.findings.filter((f) => f.rule === 'P7')
  assert.equal(c.code, 1)
  assert.deepEqual(p7.map((f) => f.subject), ['lodash@package.json'])
  assert.match(p7[0].hint, /kit:sync/)
})

test('sync --dry-run 不落盘（否则"预演"会改仓库状态，比不做更坏）', () => {
  const { root, env } = fixture()
  const r = run(['sync', '--dry-run'], { env })
  assert.equal(r.code, 0)
  assert.equal(existsSync(join(root, 'kit/manifest/deps.json')), false, '--dry-run 不得写 deps.json')
  assert.equal(existsSync(join(root, 'kit/manifest/versions.json')), false, '--dry-run 不得写 versions.json')
})

// ── Task 9（A7）：sync 必须真的重算 skills-lock（占位实现是死代码） ──────────
//
// 为什么必须在**真进程**上钉：`kit/cli.mjs` 的 sync 分支原先写着
// `const lock = { updated: [], unchanged: [], missing: [] }` 的**占位**（注释写"Task 9 落地后替换"）。
// 占位与真实现从 stdout 的数上看分不出来（都是 0/0/0 的另一种写法），差别只体现在
// **lock 文件到底有没有被重算** —— 而 V7 的判据恒为 lock 文件，占位留着 V7 就永远红。
const SKILL_MD = '---\nname: demo\nversion: "1.0.0"\n---\n\n正文\n'

test('★A7：cli sync 真的重算 skills-lock（占位实现会让 V7 永远红）', () => {
  const { root, env } = fixture()
  mkdirSync(join(root, 'public/sample-skills/demo'), { recursive: true })
  writeFileSync(join(root, 'public/sample-skills/demo/SKILL.md'), SKILL_MD)
  writeFileSync(join(root, 'skills-lock.json'), JSON.stringify({ skills: { demo: { computedHash: 'STALE' } } }))
  execFileSync('git', ['add', '-A'], { cwd: root })

  const r = run(['sync'], { env })
  assert.equal(r.code, 0, r.stdout)
  assert.match(r.stdout, /skills-lock: updated 1 \/ unchanged 0 \/ missing 0/, `报告必须来自真实现：${r.stdout}`)
  const expected = createHash('sha256').update(SKILL_MD).digest('hex')
  assert.equal(JSON.parse(readFileSync(join(root, 'skills-lock.json'), 'utf8')).skills.demo.computedHash, expected,
    'sync 必须把 computedHash 重算成该 SKILL.md 的 sha256（占位实现会原样留着 STALE → V7 永远红）')
  // 二次 sync：幂等（updated 归零）—— 否则每次 sync 都产生无意义 diff
  assert.match(run(['sync'], { env }).stdout, /skills-lock: updated 0 \/ unchanged 1 \/ missing 0/)
})

test('stamp：要么真的盖章（写出 kit-stamp.json），要么明确报未实现 —— 绝不静默成功', () => {
  const stampFile = join(ROOT, 'release/YFWorking/kit-stamp.json')
  const r = run(['stamp'])
  if (r.code === 0) {
    assert.ok(existsSync(stampFile), '退出码 0 就必须真的写出 release/YFWorking/kit-stamp.json')
    const j = JSON.parse(readFileSync(stampFile, 'utf8'))
    assert.ok(j.commit || j.version, '章上必须带身份（commit/version）')
  } else {
    assert.match(r.stdout, /stamp|未实现|Task 13/, '不做也可以，但必须说清楚为什么')
    assert.ok(!/^\s*at /.test(r.stdout), '不得只丢一段栈就算交代')
  }
})

// ── Task 12（C2 / C3）：门禁挂载完整性 ─────────────────────────────────────
//
// C2 的原状态是**零挂载**：11 个 `scripts/verify-*.mjs` 在 package.json 里没有任何入口。
// 挂载本身不修复腐烂，但它终结了"没人跑"这件事 —— 实测干净克隆（C:\t12rev @HEAD）里
// `verify-highrisk` / `verify-knowledge-gui` / `verify-knowledge-import-gui` 三个脚本当场
// EXIT=1（断言与现行代码判据已漂移），而此前没有任何人会看到。
// 2026-09-19 P1：三条里的 `verify-knowledge-import-gui`（7 项）与 `verify-highrisk`（5 项）
// 已修绿并移入 `ci` ⇒ `gates.pendingFix` 现为空。桶集仍保留三个键（空桶是合法状态，
// 将来"跑起来就红"的脚本照同一判据登记），下面的判据则改成对**任一非空非 ci 桶**成立。
//
// 三条判据（每条都能独立失败）：
//   ① 每个脚本都能被 `npm run` 发现（G7：无"已尝试"项）；
//   ② 每个脚本**恰好**归入 `deps.json#gates` 的一个桶（ci / manual / pendingFix）；
//   ③ manual 与 pendingFix 的每条必须写 reason（I4：放行即人工，且理由必须可见）。
const verifyStems = () => execFileSync('git', ['ls-files', 'scripts/verify-*.mjs'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean).map((f) => f.replace(/^scripts\//, '').replace(/\.mjs$/, ''))

const readDepsLedger = () => JSON.parse(readFileSync(join(ROOT, 'kit/manifest/deps.json'), 'utf8'))

/** gates 段归一为 { 桶名: [{script, reason}] }（ci 桶用裸字符串登记，其余带 reason） */
const gatesOf = (deps) => {
  const out = {}
  for (const [bucket, list] of Object.entries(deps.gates || {})) {
    if (bucket.startsWith('_')) continue
    out[bucket] = (list || []).map((e) => (typeof e === 'string' ? { script: e, reason: '' } : e))
  }
  return out
}
/** `verify-<suffix>.mjs` ↔ npm script `verify:<suffix>`（命名约定，避免两处手抄映射表） */
const npmNameOf = (stem) => `verify:${stem.replace(/^verify-/, '')}`

test('★C2：11 个 verify 脚本全部挂在 npm script 上，且各自恰好归入 gates 的一个桶', () => {
  const stems = verifyStems()
  assert.equal(stems.length, 11, `verify 脚本数按实测钉住（现 11 个），实测 ${stems.length}`)
  const pkg = readPkg(ROOT)
  const gates = gatesOf(readDepsLedger())
  assert.deepEqual(Object.keys(gates).sort(), ['ci', 'manual', 'pendingFix'],
    'gates 桶集固定为三个（新增桶要同步本测试与 docs/ci.md 的口径说明）')

  for (const stem of stems) {
    const npmName = npmNameOf(stem)
    const body = pkg.scripts[npmName] || ''
    assert.ok(body.includes(`scripts/${stem}.mjs`),
      `${stem} 没有 npm script 入口（C2 欠账"零挂载"复发 —— 它会腐烂而无人发现）`)
    const hit = Object.entries(gates).filter(([, list]) => list.some((e) => e.script === stem))
    assert.equal(hit.length, 1, `${stem} 必须恰好归入一个桶，实测归入 ${hit.map(([k]) => k).join('、') || '无'}`)
  }

  // 反向：桶里登记的每个门禁都必须真实存在（防"登记了一个不存在的门禁"，那种登记只会骗人）
  for (const [bucket, list] of Object.entries(gates)) {
    for (const e of list) {
      assert.ok(stems.includes(e.script), `gates.${bucket} 登记了不存在的门禁 ${e.script}`)
      if (bucket !== 'ci') {
        assert.ok(String(e.reason || '').trim().length > 0,
          `gates.${bucket} 的 ${e.script} 必须写 reason（I4：放行即人工，且理由要能被读者看到）`)
      }
    }
  }
})

test('★C2：ci 桶 ⊆ verify:ci ⊆ test:ci；任一非空非 ci 桶都不得串进 CI', () => {
  const pkg = readPkg(ROOT)
  const gates = gatesOf(readDepsLedger())
  const ciChain = ciChainScripts(pkg.scripts)
  assert.ok(ciChain.includes('verify:ci'), `test:ci 必须真的跑 verify:ci，实测链路 ${ciChain.join(' → ')}`)
  const verifyChain = parseCiChain(pkg.scripts['verify:ci'])
  assert.ok(verifyChain.length > 0, 'verify:ci 必须能解析出脚本名，否则"CI 真的跑了"这条判据落空')

  for (const e of gates.ci) {
    assert.ok(verifyChain.includes(npmNameOf(e.script)),
      `ci 桶的 ${e.script} 必须真的在 verify:ci 链路里（否则 ci 桶只是装饰：写了不等于跑）`)
  }
  // 原断言写的是 `for (const e of gates.pendingFix)` —— P1（2026-09-19）把 pendingFix 修空后，
  // 那个循环变成**空转**：护栏看着还在，实际判据为零（"断言测空"）。故改为对所有非 ci 桶成立，
  // 并把原本靠 pendingFix 承载的具体约束**显式补回**（见下面两条）。
  for (const bucket of ['manual', 'pendingFix']) {
    for (const e of gates[bucket]) {
      assert.equal(verifyChain.includes(npmNameOf(e.script)), false,
        `gates.${bucket} 的 ${e.script} 在干净克隆里实测 EXIT=1（环境依赖或脚本腐烂），串进 verify:ci 会让 test:ci 永久红 —— 修到绿再从 ${bucket} 移入 ci`)
    }
  }
  // ★ 显式的"修好了"锁：两条从 pendingFix 修绿的脚本必须**同时**在 ci 桶与 verify:ci 链路里。
  // 只有它俩都在这儿，"pendingFix 已清空"才是真的交付，而不是把脚本从头两份名单里一起删掉。
  for (const stem of ['verify-highrisk', 'verify-knowledge-import-gui']) {
    assert.ok(gates.ci.some((e) => e.script === stem),
      `${stem} 必须在 gates.ci（2026-09-19 P1 修绿后从 pendingFix 移入；删了它等于门禁又靠"没人跑"来掩盖腐烂）`)
    assert.ok(verifyChain.includes(npmNameOf(stem)),
      `${stem} 必须在 verify:ci 链路里（ci 桶只是登记，链路才是"真的会跑"）`)
  }
})

test('★C3：构建/校验脚本都有 npm script 入口（原先 6 个脚本零入口）', () => {
  const pkg = readPkg(ROOT)
  const cmds = Object.values(pkg.scripts)
  // ★ 清单以**实测 tree** 为准：计划原文写 `scripts/package-portable.mjs`，实际文件是
  //   `scripts/package-portable.cjs`（同名 .mjs 不存在）。按计划原文抄会挂一个跑不起来的入口 ——
  //   这类"文档里的文件名与实际不符"正是本门禁要抓的，故测试里显式断言文件存在。
  for (const rel of ['scripts/build-kernel.mjs', 'scripts/build-embedded-python.mjs', 'scripts/build-installer.mjs',
    'scripts/package-portable.cjs', 'scripts/sync-builtin-skills.mjs', 'scripts/bump-version.mjs']) {
    assert.ok(existsSync(join(ROOT, rel)), `${rel} 不存在（清单须与 tree 对齐）`)
    assert.ok(cmds.some((c) => c.includes(rel)), `${rel} 没有 npm script 入口（C3 欠账）`)
  }
  // 命名空间本身也是判据：构建入口一律 `build:*` / `skills:*` / `version:*`，便于 `npm run` 发现
  for (const name of ['build:kernel', 'build:python', 'build:installer', 'build:portable', 'skills:sync', 'version:bump']) {
    assert.ok(pkg.scripts[name], `缺 npm script ${name}`)
  }
})
