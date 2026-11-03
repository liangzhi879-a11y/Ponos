// 过程文件归集：**判据与计划**的纯函数直测（待办 860）
// ---------------------------------------------------------------------------
// 为什么这一层必须先测纯函数：归集要动用户的文件，「什么算过程物」「什么绝对不能动」
// 是本能力的全部安全边界。把它写进带 IO 的执行层，就只能靠"搭一个临时目录跑一遍"
// 来验证——正例好写，**反例（不该动的文件绝不动）几乎测不全**，而反例恰恰是风险所在。
//
// 本文件钉三件事：
//   ① 模式判据正反例：过程物形态命中；**用户的正常文件（源码/文档/表格/照片）绝不命中**；
//   ② 计划的不变量：git 已跟踪 → 跳过；目标已存在 → 跳过；带路径分隔符 → 拒绝（防下钻）；
//   ③ 提示词文案与目录常量同源（改了目录名却忘改提示词 = agent 把过程物写到不存在的约定里，
//      而且不报错，只会"看起来照做了"）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  PROCESS_CONTAINER_DIR, PROCESS_LAYOUT, PROCESS_ARTIFACT_PATTERNS,
  matchProcessArtifact, isProcessArtifactName, normalizePhaseName, processRoot, processPhaseDir,
  relProcessRoot, planProcessCollection, planProcessRestore, mergeManifest, markRestored,
  renderProcessIndex, processHygieneRuleText, restoreCommandLine, toPosixRel,
} from '../shared/process-artifacts.mjs'
import { TEAM_CONTAINER_DIR } from '../shared/team-source.mjs'

// ---------------------------------------------------------------------------
// ① 目录约定只有一个真源
// ---------------------------------------------------------------------------
test('顶层容器复用团队模式的既有约定（不得另立第二套隐藏目录）', () => {
  assert.equal(PROCESS_CONTAINER_DIR, '.ponos')
  assert.equal(PROCESS_CONTAINER_DIR, TEAM_CONTAINER_DIR, '容器名必须与 shared/team-source.mjs 同源')
  assert.equal(PROCESS_LAYOUT.DIR, 'process')
  assert.equal(relProcessRoot(), '.ponos/process')
  assert.equal(relProcessRoot('阶段1-勘察'), '.ponos/process/阶段1-勘察')
  assert.equal(toPosixRel('a\\b\\c.json'), 'a/b/c.json')
})

test('processRoot / processPhaseDir：项目根子目录，不逃逸', () => {
  const root = processRoot('D:/proj')
  assert.ok(root.endsWith('.ponos\\process') || root.endsWith('.ponos/process'), root)
  assert.equal(processPhaseDir('D:/proj', '阶段1'), `${root}${processRoot('D:/proj').includes('\\') ? '\\' : '/'}阶段1`)
})

test('阶段名归一：路径穿越与非法字符一律被削平', () => {
  assert.equal(normalizePhaseName('阶段1-勘察'), '阶段1-勘察')
  assert.ok(!normalizePhaseName('../../etc').includes('..'), '父目录引用必须被削平')
  assert.ok(!normalizePhaseName('a/b').includes('/'), '分隔符必须被削平')
  assert.ok(!normalizePhaseName('C:evil').includes(':'), '盘符冒号必须被削平')
  assert.ok(!normalizePhaseName('...').startsWith('.'), '不得造出隐藏目录 / 相对目录')
  assert.equal(normalizePhaseName('   '), 'unlabeled', '空白 → 兜底名（不抛错：收尾动作不该因命名失败')
  assert.equal(normalizePhaseName('', 'sess-abcd1234'), 'sess-abcd1234')
  assert.ok(normalizePhaseName('x'.repeat(200)).length <= 64, '长度受限（Windows 路径上限）')
})

// ---------------------------------------------------------------------------
// ② 模式判据：正例（该收）与**反例（绝不能收）**
// ---------------------------------------------------------------------------
test('过程物形态命中（每条代表一个真实见过的命名）', () => {
  const hits = [
    'tmp-probe.mjs', 'tmp_scan.py', 'cache-age-probe.mjs', 'diag-1.txt', 'debug-run.ps1',
    'work-tmp.json', 'state.tmp', '.tmp-ag.json', '.tmp-test9.log', 'run.log',
    '_exp_append2.md', '_p2_append.md', 'commit-msg.txt', 'verify-final.mjs', 'tmp-wfdiag',
  ]
  for (const n of hits) {
    const hit = matchProcessArtifact(n)
    assert.ok(hit, `${n} 应判为过程物`)
    assert.ok(hit.id && hit.why, `${n} 的命中必须带 id 与理由（账本要写"为什么收它"）`)
    assert.equal(isProcessArtifactName(n), true)
  }
})

test('★ 反例：用户的正常文件一个都不能命中（误收 = 把用户的成果藏起来）', () => {
  const misses = [
    // 源码 / 文档 / 配置
    'index.ts', 'main.py', 'app.cjs', 'README.md', 'package.json', 'tsconfig.json',
    'AGENTS.md', 'requirements.txt', 'vite.config.ts', 'LICENSE',
    // 交付物 / 数据（申报场景的真实形态）
    '营业执照.jpg', '资料要求.xlsx', '2024_财务审计报告.pdf', 'IP01_一种装置.pdf',
    '人员名单.docx', '高企申报书.docx', '汇总表.xlsx',
    // 看起来"像但不该收"的：刻意排除的形态（见模块头注释的剔除理由）
    'data.bak', 'notes.bak', 'app.log.1', 'logs', 'out', 'err', 'nul', 'scratch',
    'probe.docx',            // probe 前缀但**非脚本**：只有 probe-/diag-/debug- + 扩展名才算
    'verify.py',             // 裸 verify.py 无横线：不是"verify-xxx"一次性脚本形态
    'tmp.docx',              // 有 tmp 前缀但扩展名是交付物格式？—— 见下方单独说明
  ]
  for (const n of misses) {
    const hit = matchProcessArtifact(n)
    // tmp.docx 是刻意保留的"灰区"：tmp- 前缀本身已是通行的一次性命名约定，即使扩展名
    // 是交付格式，也归过程物（用户要留就改名）。这一条**不**在反例里断言，单独说明。
    if (n === 'tmp.docx') continue
    assert.equal(hit, null, `${n} 不该被归集（命中规则：${hit?.id}）`)
  }
})

test('模式表本身无重复 id（id 要能唯一定位"为什么收"）', () => {
  const ids = PROCESS_ARTIFACT_PATTERNS.map((p) => p.id)
  assert.equal(new Set(ids).size, ids.length, `重复 id：${ids.join(',')}`)
  for (const p of PROCESS_ARTIFACT_PATTERNS) assert.ok(p.why && p.why.length > 4, `${p.id} 必须写清理由`)
})

test('空名 / 纯点 / 空白不命中（不误判成垃圾）', () => {
  for (const n of ['', '   ', '.', '..', null, undefined]) assert.equal(matchProcessArtifact(n), null)
})

// ---------------------------------------------------------------------------
// ③ 归集计划的不变量
// ---------------------------------------------------------------------------
test('planProcessCollection：命中即收，且带着来源/时间/命中理由', () => {
  const plan = planProcessCollection({
    files: ['tmp-probe.mjs', 'README.md', 'src/index.ts'],
    tracked: new Set(),
    phase: '阶段1',
    at: '2026-09-22T00:00:00.000Z',
    source: 'unit-test',
    probe: () => ({ bytes: 42, sha256: 'a'.repeat(64) }),
  })
  assert.equal(plan.collected.length, 1)
  assert.deepEqual(plan.collected[0].from, 'tmp-probe.mjs')
  assert.equal(plan.collected[0].to, '.ponos/process/阶段1/tmp-probe.mjs')
  assert.equal(plan.collected[0].bytes, 42)
  assert.equal(plan.collected[0].source, 'unit-test')
  assert.equal(plan.collected[0].at, '2026-09-22T00:00:00.000Z')
  assert.ok(plan.collected[0].why)
  const reasons = plan.skipped.map((s) => `${s.path}:${s.reason}`)
  // `src/index.ts` 带分隔符 ⇒ 在"是否过程物"之前就被 `not-root-level` 挡下（**更早、更严**
  // 的一道闸）：深层路径根本不该进候选。断言这一点，而不是把它算成 not-artifact。
  assert.deepEqual(reasons.sort(), ['README.md:not-artifact', 'src/index.ts:not-root-level'])
})

test('planProcessCollection：git 已跟踪的过程物**不动**（动了就毁 diff）', () => {
  const plan = planProcessCollection({
    files: ['tmp-script.mjs'], tracked: ['tmp-script.mjs'], phase: 'p',
  })
  assert.equal(plan.collected.length, 0)
  assert.equal(plan.skipped[0].reason, 'git-tracked')
})

test('planProcessCollection：归集目录已有同名文件 → 跳过（绝不覆盖）', () => {
  const plan = planProcessCollection({
    files: ['probe-x.mjs'], tracked: [], existingTargets: ['probe-x.mjs'], phase: 'p',
  })
  assert.equal(plan.collected.length, 0)
  assert.equal(plan.skipped[0].reason, 'target-exists')
})

test('planProcessCollection：带分隔符的输入被拒绝（防"下钻子目录"从后门漏进来）', () => {
  const plan = planProcessCollection({
    files: ['logs/tmp-a.log', 'sub\\probe-b.mjs'], tracked: [], phase: 'p',
  })
  assert.equal(plan.collected.length, 0, '深层路径绝不能被归集（可能是用户的真实数据）')
  assert.deepEqual(plan.skipped.map((s) => s.reason), ['not-root-level', 'not-root-level'])
})

test('planProcessCollection：probe 抛错只让元信息缺失，不让计划失败', () => {
  const plan = planProcessCollection({
    files: ['tmp-a.mjs'], tracked: [], phase: 'p',
    probe: () => { throw new Error('EACCES') },
  })
  assert.equal(plan.collected.length, 1)
  assert.equal(plan.collected[0].bytes, null, '读不到就如实记 null，不编造')
  assert.equal(plan.collected[0].sha256, null)
})

test('planProcessCollection：重复文件名只处理一次（幂等）', () => {
  const plan = planProcessCollection({ files: ['tmp-a.mjs', 'tmp-a.mjs'], tracked: [], phase: 'p' })
  assert.equal(plan.collected.length, 1)
})

// ---------------------------------------------------------------------------
// ④ 回退计划的不变量
// ---------------------------------------------------------------------------
const mkManifest = (entries) => ({ version: 1, phase: 'p', projectRoot: 'D:/proj', entries })

test('planProcessRestore：正常回退；**原处已有文件则跳过不覆盖**；已回退过则跳过', () => {
  const manifest = mkManifest([
    { from: 'tmp-a.mjs', to: '.ponos/process/p/tmp-a.mjs', status: 'collected', restoredAt: null },
    { from: 'tmp-b.mjs', to: '.ponos/process/p/tmp-b.mjs', status: 'collected', restoredAt: null },
    { from: 'tmp-c.mjs', to: '.ponos/process/p/tmp-c.mjs', status: 'collected', restoredAt: null },
    { from: 'tmp-d.mjs', to: '.ponos/process/p/tmp-d.mjs', status: 'restored', restoredAt: '2026-09-22' },
  ])
  const present = new Set(['tmp-b.mjs', '.ponos/process/p/tmp-a.mjs', '.ponos/process/p/tmp-b.mjs'])
  const plan = planProcessRestore({ manifest, exists: (p) => present.has(p) })
  assert.deepEqual(plan.restored, [{ from: 'tmp-a.mjs', to: '.ponos/process/p/tmp-a.mjs' }])
  const byFrom = new Map(plan.skipped.map((s) => [s.from, s.reason]))
  assert.equal(byFrom.get('tmp-b.mjs'), 'origin-exists', '原处已有文件 ⇒ 绝不覆盖')
  assert.equal(byFrom.get('tmp-c.mjs'), 'collected-file-missing')
  assert.equal(byFrom.get('tmp-d.mjs'), 'already-restored')
})

test('planProcessRestore：空/缺字段清单不抛错（幂等，不假装成功）', () => {
  assert.deepEqual(planProcessRestore({}), { restored: [], skipped: [] })
  assert.deepEqual(planProcessRestore({ manifest: { entries: [] }, exists: () => true }), { restored: [], skipped: [] })
})

// ---------------------------------------------------------------------------
// ⑤ 账本合并 / 索引渲染
// ---------------------------------------------------------------------------
test('mergeManifest：同一 from 不重复登记；跳过项只留最近 200 条（账本不无限膨胀）', () => {
  const e = { from: 'tmp-a.mjs', to: '.ponos/process/p/tmp-a.mjs', status: 'collected', restoredAt: null }
  let m = mergeManifest(null, { phase: 'p', projectRoot: 'D:/proj', collected: [e], skipped: [], at: 't1', source: 's' })
  m = mergeManifest(m, { phase: 'p', projectRoot: 'D:/proj', collected: [e], skipped: [], at: 't2', source: 's' })
  assert.equal(m.entries.length, 1, '第二轮收尾不该把同一文件登记两次')
  const many = Array.from({ length: 260 }, (_, i) => ({ path: `f${i}`, reason: 'not-artifact' }))
  m = mergeManifest(m, { phase: 'p', projectRoot: 'D:/proj', collected: [], skipped: many, at: 't3', source: 's' })
  assert.equal(m.skipped.length, 200)
  assert.equal(m.updatedAt, 't3')
  assert.equal(m.version, PROCESS_LAYOUT.SCHEMA_VERSION)
})

test('markRestored：只改被回退的条目，其余原样', () => {
  const m = mkManifest([
    { from: 'a', status: 'collected', restoredAt: null },
    { from: 'b', status: 'collected', restoredAt: null },
  ])
  const next = markRestored(m, [{ from: 'a' }], '2026-09-22T00:00:00Z')
  assert.equal(next.entries[0].status, 'restored')
  assert.equal(next.entries[0].restoredAt, '2026-09-22T00:00:00Z')
  assert.equal(next.entries[1].status, 'collected')
  assert.equal(m.entries[0].status, 'collected', '不得原地改传入对象（纯函数）')
})

test('renderProcessIndex：说清"哪个阶段、搬了什么、怎么退回"，并声明从未删除', () => {
  const m = mergeManifest(null, {
    phase: '阶段1-勘察', projectRoot: 'D:/proj',
    collected: [{ from: 'tmp-a.mjs', to: '.ponos/process/阶段1-勘察/tmp-a.mjs', bytes: 10, sha256: 'b'.repeat(64), at: 't', source: 'kernel-closeout' }],
    skipped: [{ path: 'README.md', reason: 'not-artifact' }],
    at: 't', source: 'kernel-closeout',
  })
  const md = renderProcessIndex(m)
  assert.match(md, /阶段1-勘察/)
  assert.match(md, /tmp-a\.mjs/)
  assert.match(md, /从(不|未)|没有.*删除|只移动/, '必须明确声明"从不删除"（用户最关心的承诺）')
  assert.match(md, /not-artifact/, '未归集项要给出原因表（否则用户不知道"为什么没动它"）')
  assert.ok(md.includes(restoreCommandLine('阶段1-勘察')), '索引里的回退命令必须与本模块同源')
})

test('restoreCommandLine：只回退 collected 且不覆盖已存在的原文件', () => {
  const cmd = restoreCommandLine('p')
  assert.match(cmd, /status!=='collected'/)
  assert.match(cmd, /existsSync\(e\.from\)/)
  assert.match(cmd, /\.ponos\/process\/p\/manifest\.json/)
})

// ---------------------------------------------------------------------------
// ⑥ 提示词文案与约定同源（跨层漂移守卫）
// ---------------------------------------------------------------------------
test('提示词规则段出现的目录 = 本模块常量（改目录名不可能漏改提示词）', () => {
  const text = processHygieneRuleText()
  assert.ok(text.includes(relProcessRoot()), `提示词必须写明归集目录 ${relProcessRoot()}`)
  assert.match(text, /阶段收尾/)
  assert.match(text, /只移动|不删除/, '必须写明"只移动不删除"（这是给模型的硬约束）')
  assert.match(text, /禁止[\s\S]*移动|禁止[\s\S]*删除/, '必须有明确的禁止项（用户文件/已跟踪文件）')
  // 反例守卫：不得诱导模型把交付物也搬走
  assert.match(text, /交付物与过程物分开/)
})

test('cli.mjs 真的注入了该规则段，且 chat 模式不注入（静态接线守卫）', () => {
  // ★ 2026-10-20 重构适配（T1.4 prompt appendix 分层）：规则段的调用链从
  //   「cli.mjs 直接调 processHygieneRuleText」变成「cli.mjs → kernel/prompt-appendix.mjs →
  //   processHygieneRuleText」（因为两段长规则（过程纪律 + 沉淀指引）要按
  //   PONOS_PROMPT_APPENDIX=compact 切换详略，且按 chat/dir 分别 skip）。
  //   ⇒ 断言**不是放宽而是改成逐环**：链上任一环断了都会红（原断言只覆盖"cli 里出现该名字"，
  //   重构后它会因为"名字挪到下一层"而假红；只删名字则会让"死代码"这个真缺陷重新隐身）。
  const cli = readFileSync(fileURLToPath(new URL('../kernel/cli.mjs', import.meta.url)), 'utf8')
  // ① cli 必须真的取附录段，并把 **chat 判定** 交给它（chat 无本地工具 ⇒ 不注入）
  assert.match(cli, /buildPromptAppendix\(\{/, 'cli 必须取提示词附录段（否则规则段无从注入）')
  assert.match(cli, /skipHygiene:\s*chatMode/, 'chat 模式必须 skipHygiene（chat 没有本地工具，教它归集过程文件是噪声）')
  // ② 取到的附录段必须真的进 append 基料（防"算了基料却没用上"）
  assert.match(cli, /appendBase\s*=\s*appendBase0\s*\+[^\n]*appendix\.hygiene/, '规则段必须进入 append 基料')
  assert.match(cli, /append:\s*appendBase\b/, 'append 通道必须使用该基料（否则只是死代码）')
  // ③ 中间层必须真的调用文案真源（防"链在、但中间层返回空串"）
  const appendixMod = readFileSync(fileURLToPath(new URL('../kernel/prompt-appendix.mjs', import.meta.url)), 'utf8')
  assert.match(appendixMod, /import\s*\{[^}]*processHygieneRuleText[^}]*\}\s*from\s*'\.\.\/shared\/process-artifacts\.mjs'/,
    'prompt-appendix 必须从文案真源 import（不得自己抄一份规则段）')
  assert.match(appendixMod, /processHygieneRuleText\(\)/, 'prompt-appendix 必须真的调用它（否则中间层空转）')
  assert.match(appendixMod, /skipHygiene\s*\?\s*''/, 'skipHygiene 必须真的把它置空（不能只是传参不用）')
})

test('engine.mjs 的自动归集挂在收尾判定上（不与守卫各写一套"什么算收尾"）', () => {
  const eng = readFileSync(fileURLToPath(new URL('../kernel/engine.mjs', import.meta.url)), 'utf8')
  assert.match(eng, /collectProcessArtifacts/, '引擎必须调用归集实现（只有提示词 = 靠模型自觉，不算落地）')
  assert.match(eng, /isClosedOut\(String\(outcome\.text \?\? ''\), isPlanTail\)/, '必须复用守卫的收尾判据')
  assert.match(eng, /processHygieneEnabled &&/, '必须有开关闸门（chat / 测试可关）')
})
