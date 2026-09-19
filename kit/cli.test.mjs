// kit/cli.test.mjs —— CLI 端到端（spawn 真进程，非 mock）
//
// 为什么必须 spawn 真进程：CLI 的全部价值都在"进程外可观察的行为"上 —— 退出码、stdout 的
// JSON 形状、以及"check 绝不写文件"。这三样 import 都测不到（process.exit 会直接杀掉测试进程）。
//
// ★ 退出码的判据必须**双向**：真仓现在必然有红灯（P1 10 条未用依赖 + P2 4 条真幽灵，
//   欠账 B1 未修；A7 的 V7 20 条已在 Task 9 归零），所以
//   "check 退出 1"单独看是**不可能独立失败的断言** —— 硬编码 `process.exit(1)` 也能过。
//   故这里同时钉住三个方向：
//     ① 真仓 check 退 1（红灯存在）；② 夹具仓（红灯 0）check 必须退 0；
//     ③ view（契约恒 0）不得被写成 1。三者合起来才唯一确定 `exit(report.ok ? 0 : 1)`。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  return { root, env: { YFW_KIT_ROOT: root } }
}

const readPkg = (root) => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const writePkg = (root, pkg) => writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2))
const ledgerText = (root) => readFileSync(join(root, 'kit/manifest/deps.json'), 'utf8')

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

test('check（人话）有红灯 → 退出码 1，且报告首行是 DevKit 检查', () => {
  const r = run(['check', '--verbose'])
  assert.equal(r.code, 1, '台账现状应至少含 P1/P2 的红灯（依赖欠账 B1 未修；A7 的 V7 已归零）')
  assert.match(r.stdout, /DevKit 检查/)
  assert.match(r.stdout, /红灯（阻断）/)
})

test('check --verbose 逐条列出每条规则的判定结果（--verbose 必须真的多说点什么）', () => {
  const plain = run(['check'])
  const verbose = run(['check', '--verbose'])
  assert.match(verbose.stdout, /规则逐条/)
  assert.match(verbose.stdout, /P7/)
  assert.match(verbose.stdout, /台账包集与 package\.json 双向一致/)
  assert.ok(verbose.stdout.length > plain.stdout.length, '--verbose 的输出必须严格多于默认输出')
})

// ── Task 8 / B2 + B3：规则条数口径（规则号数）必须与实现一致 ────────────────
//
// 背景：`summary.rules` 原先报 18，而实现里有 19 个规则号 —— 差的那一个是 P0
// （deps.json 缺失时早退，只 push finding 不 push checkResult）。三处口径并存
// （spec §5.3 表 9 行 + §6.3 表 8 行 = 17、报告 18、实现 19）→ 报告与实现必须对齐，
// 口径写进 spec（§5.3/§6.3 的"规则号数"一节）。
const EXPECTED_RULES = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7',
  'V1', 'V1b', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', "V8'", 'V8b']

test('★B2/B3：summary.rules = 19，且逐条规则号与 spec 口径完全一致（含表外 V1b/V8b/ P0）', () => {
  const j = JSON.parse(run(['check', '--json']).stdout)
  assert.deepEqual([...j.checks.map((c) => c.rule)].sort(), [...EXPECTED_RULES].sort(),
    '规则号集必须逐字对齐：多一个（自造号）或少一个（早退没 push）都要在这里变红')
  assert.equal(j.summary.rules, 19)
  assert.equal(new Set(j.checks.map((c) => c.rule)).size, 19, '同一个规则号不得重复计入')
  // V6 的标题必须与判据同口径（标题写三方 → 就得真核三方，见 kit/lib/version-rules.mjs）
  assert.match(j.checks.find((c) => c.rule === 'V6').title, /三方/)
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
test('★Rider1：真仓 P2 红灯恰为 4 条真幽灵，与 docs/待处理清单.md 记的 4 条同名', () => {
  const j = JSON.parse(run(['check', '--json']).stdout)
  const p2 = j.findings.filter((f) => f.rule === 'P2')
  assert.deepEqual(p2.map((f) => f.subject),
    ['@codemirror/autocomplete', '@lezer/highlight', 'esbuild', 'js-yaml'],
    '多报（`~` / jszip 之类假幽灵）或少报（忘接线 → ghost 恒空）都必须在这里变红')
  assert.ok(p2.every((f) => f.severity === 'red'))
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
  assert.deepEqual(j.checks.map((x) => x.rule), ['P0'])
  assert.equal(j.checks[0].passed, false)
  assert.equal(j.summary.rules, 1)
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
