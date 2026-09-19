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

test('check（人话）：有红灯时退 1 且渲染红灯段（用夹具仓造真红灯，不靠真仓的欠账）', () => {
  const { env } = fixture()   // 夹具仓**不** sync → 缺台账 = P0/V0 红灯
  const r = run(['check', '--verbose'], { env })
  assert.equal(r.code, 1, '有红灯必须退 1（硬编码 exit(0) 会被这条抓住）')
  assert.match(r.stdout, /DevKit 检查/)
  assert.match(r.stdout, /红灯（阻断）/)
})

test('★RiderA：真仓红灯 0 / 黄灯 1（4 条 P2 幽灵依赖已补声明）—— 多一条红灯也要在这里变红', () => {
  const r = run(['check', '--json'])
  const j = JSON.parse(r.stdout)
  assert.equal(r.code, 0, `真仓必须零红灯（Rider A 已给 4 个包补声明），实测 findings=${JSON.stringify(j.findings)}`)
  assert.deepEqual([j.summary.red, j.summary.yellow], [0, 1],
    '黄灯 1 是 P5（两套 Python 清单差集，属预期，spec §6.3 已定不阻断）；红灯/黄灯数变了就必须有人来解释')
  assert.deepEqual(j.findings.map((f) => f.rule), ['P5'])
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
