// kit/lib/agent-entry-rules.test.mjs —— CT11 的判据测试（agent 自动注入入口 ↔ 真源一致）
//
// 本文件里每条断言都要**能失败**，重点是这几件事：
//   · 入口缺了某个必备锚点 ⇒ 红，且指出**缺哪条**（不是笼统"入口不对"）；
//   · 入口长成第二份清单（超行数）⇒ 红；
//   · 入口整个消失 ⇒ 红且 **不抛异常**（fail-closed）；
//   · 真源把锚点清空 ⇒ 红（否则"扫 0 条"会变成**恒真通过** —— 本仓最忌的做假形态）；
//   · ★ **入口能随更新进便携版（调试版）**：同步清单里少了 AGENTS.md ⇒ 红
//     （用户口径：人工测试跑的就是 release 里的便携版 ⇒ 入口进不去 = 调试版里 agent 静默不受约束）；
//   · ★ 真仓自检：真仓的 `AGENTS.md` 现在就是绿的，且 `evaluated` = 锚点数 + 同步路径数（**不写死**）。
// 另外钉一句"反向说明"：CT11 **只**核真源登记的锚点/路径，不去评价入口的文风排版 —— 免得规则变成风格警察。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { agentEntryCheck, DEFAULT_ENTRY_FILE } from './agent-entry-rules.mjs'
import { AGENT_GUIDE } from './agent-guide.mjs'

const ROOT = new URL('../../', import.meta.url)
/** 真仓入口正文 */
const realEntry = () => readFileSync(new URL(`${DEFAULT_ENTRY_FILE}`, ROOT), 'utf8')
/** 读**工作树**的读取器：CT11 在门禁里读提交态；测试里读工作树（两者在提交后一致，这样测试不必等提交） */
const worktree = (f) => { try { return readFileSync(new URL(f, ROOT), 'utf8') } catch { return null } }

/** 造一个"读哪份文件都返回给定内容"的读取器 */
const reader = (map) => (f) => (f in map ? map[f] : null)

/** 夹具真源：从真仓真源复制后改（保证锚点/路径都来自真源，而不是在测试里另抄一份） */
const fixtureGuide = (mutate) => {
  const g = JSON.parse(JSON.stringify(AGENT_GUIDE))
  mutate(g)
  return g
}

/** 便携版同步路径的**合格**夹具内容：直接从真源派生 ⇒ 真源改了夹具自动跟上（不会出现"规则加了、夹具没加"）
 *  ★ 必须**同时**包含 `pending[]`：它们也是判据的一部分（入库后自动生效），夹具漏了它们会让
 *    `evaluated` 与真源口径差一截 —— 那会表现为"像规则错"的假红。 */
const syncOk = () => ({
  ...Object.fromEntries(
    [...AGENT_GUIDE.entry.portableSync.paths, ...(AGENT_GUIDE.entry.portableSync.pending || [])]
      .map((p) => [p.file, p.mustContain.join('\n')])),
  // ★ 送达链路判据要读内核文件（`entry.delivery.file`）⇒ 夹具必须放**真实内容**，否则所有用例都会
  //   因"读不到内核文件"而假红（那是夹具的问题，不是规则的问题）。
  [AGENT_GUIDE.entry.delivery.file]: worktree(AGENT_GUIDE.entry.delivery.file) ?? '',
})

/** 真仓自检的期望核验点数：必备锚点 + 送达链路 + `paths[]` + **可读的** `pending[]`（★ 从真源算，不写死） */
const expectedEvaluated = () => AGENT_GUIDE.entry.mustMention.length
  + (worktree(AGENT_GUIDE.entry.delivery.file) !== null ? 1 : 0)
  + AGENT_GUIDE.entry.portableSync.paths.length
  + (AGENT_GUIDE.entry.portableSync.pending || []).filter((p) => worktree(p.file) !== null).length

test('真仓自检：CT11 全绿，且 evaluated = 锚点数 + 同步路径数（不是写死的数字）', () => {
  const r = agentEntryCheck({ readTracked: worktree })
  assert.equal(r.check.rule, 'CT11')
  assert.deepEqual(r.findings, [], '真仓入口必须满足全部锚点、且两条同步路径都带着它')
  assert.equal(r.check.passed, true)
  assert.equal(r.check.evaluated, expectedEvaluated(),
    'evaluated 必须等于真源登记的（锚点 + 同步路径）数 —— 写死数字会让"加了检查却没核"蒙过去')
})

test('★ 缺锚点 ⇒ 红，且**逐条指名**缺的是哪个 id', () => {
  const stripped = realEntry().split('git add -A').join('（此处被抠掉）')
  const r = agentEntryCheck({ readTracked: reader({ ...syncOk(), [DEFAULT_ENTRY_FILE]: stripped }) })
  assert.equal(r.check.passed, false)
  assert.equal(r.findings.length, 1, '只缺一条就该只报一条')
  assert.equal(r.findings[0].subject, 'no-add-all', 'findings 的 subject 要指出**缺哪个锚点 id**')
  assert.match(r.findings[0].expected, /git add -A/, 'expected 要给出"应出现的原文"')
  assert.match(r.findings[0].hint, /他人在途/, 'hint 要说清**为什么需要它**（理由来自真源，不在规则里另写一份）')
  assert.equal(r.findings[0].severity, 'red')
})

test('★ 缺多条 ⇒ 红多条（不是"发现一处就停"）', () => {
  let text = realEntry()
  for (const a of AGENT_GUIDE.entry.mustMention) text = text.split(a.contains).join('（抠掉）')
  const r = agentEntryCheck({ readTracked: reader({ ...syncOk(), [DEFAULT_ENTRY_FILE]: text }) })
  assert.equal(r.findings.length, AGENT_GUIDE.entry.mustMention.length,
    `锚点全缺就该报 ${AGENT_GUIDE.entry.mustMention.length} 条`)
  assert.deepEqual(r.findings.map((f) => f.subject).sort(), AGENT_GUIDE.entry.mustMention.map((a) => a.id).sort())
})

test('★ 入口长成第二份清单（超行数）⇒ 红（这是"单一真源"的结构性保障）', () => {
  const base = realEntry()
  const bloated = base + '\n' + Array.from({ length: AGENT_GUIDE.entry.maxLines + 5 }, (_, i) => `补一行 ${i}`).join('\n')
  const r = agentEntryCheck({ readTracked: reader({ ...syncOk(), [DEFAULT_ENTRY_FILE]: bloated }) })
  assert.equal(r.check.passed, false)
  const f = r.findings.find((x) => x.subject === 'entry-too-long')
  assert.ok(f, '必须有 entry-too-long 这条红')
  assert.match(f.expected, new RegExp(`≤ ${AGENT_GUIDE.entry.maxLines}`))
  assert.match(f.actual, new RegExp(`${AGENT_GUIDE.entry.maxLines + base.split('\n').length + 5} 行`))
  assert.match(f.hint, /第二份清单/, 'hint 要讲清"为什么不能长"（否则人只会把行数上限当成形式主义）')
})

test('★ 入口消失 ⇒ 红且**不抛异常**（fail-closed：入口没了不是"没问题"）', () => {
  const r = agentEntryCheck({ readTracked: () => null })
  assert.equal(r.check.passed, false)
  assert.equal(r.check.evaluated, 0, '读不到时 evaluated 必须是 0（不许报成"全都过"）')
  assert.equal(r.findings.length, 1)
  assert.equal(r.findings[0].subject, 'entry-missing')
  assert.match(r.findings[0].hint, /仓库根/, 'hint 要提醒"子目录无效：工具只看根"（本批用户实际问过这点）')
})

test('★ 读取器直接抛异常也要兜住（不许把栈崩当成"门禁变红"）', () => {
  const r = agentEntryCheck({ readTracked: () => { throw new Error('boom') } })
  assert.equal(r.check.passed, false)
  assert.equal(r.findings[0].subject, 'entry-missing')
})

test('★ 恒真防护：真源把锚点清空 ⇒ 红（否则"扫 0 条"会恒真通过）', () => {
  const g = fixtureGuide((x) => { x.entry.mustMention = [] })
  const r = agentEntryCheck({ readTracked: reader({ ...syncOk(), [DEFAULT_ENTRY_FILE]: realEntry() }), guide: g })
  assert.equal(r.check.passed, false, '锚点列表为空必须红 —— 不然本规则会变成"扫 0 条也通过"的假门禁')
  assert.equal(r.findings[0].subject, 'no-anchors')
})

test('★ 恒真防护：真源把便携版同步路径清空 ⇒ 红（否则"扫 0 条"同样恒真）', () => {
  const g = fixtureGuide((x) => { x.entry.portableSync = { paths: [] } })
  const r = agentEntryCheck({ readTracked: reader({ ...syncOk(), [DEFAULT_ENTRY_FILE]: realEntry() }), guide: g })
  assert.equal(r.check.passed, false)
  assert.equal(r.findings[0].subject, 'no-portable-sync')
})

test('★ 真源没登记 entry 段 ⇒ 两条"扫 0 条"防护都要报（不静默跳过）', () => {
  const g = fixtureGuide((x) => { delete x.entry })
  const r = agentEntryCheck({ readTracked: reader({ ...syncOk(), [DEFAULT_ENTRY_FILE]: realEntry() }), guide: g })
  assert.equal(r.check.passed, false)
  assert.equal(r.check.evaluated, 0)
  assert.deepEqual(r.findings.map((f) => f.subject).sort(), ['no-anchors', 'no-delivery', 'no-portable-sync'])
})

// ── ★ 用户口径（2026-09-20）："人工测试跑的是 release 中的便携版（调试版）" + "确保调试版更新了不会掉" ──
//    下面四条就是这件事的牙齿：谁把 AGENTS.md 从同步清单里删掉、或哪条路径失效，都会红。

test('★ 打包同步清单里删掉 AGENTS.md ⇒ 红（该文件已入库 ⇒ `pending` 自动转为正式判据）', () => {
  // `scripts/package-portable-zip.mjs` 在真源里登记于 `pending[]`（当初**未被 git 跟踪** ⇒ 登记进 paths 会让门禁永远红）。
  // 本用例模拟"它已入库、但清单被删" ⇒ 必须红（证明 pending 不是永久借口，而是**自动生效**的条件判据）。
  const pendingFile = AGENT_GUIDE.entry.portableSync.pending[0].file
  const broken = { ...syncOk(), [pendingFile]: "const SYNC_DIRS = ['kernel', 'server']  // 清单里没有入口" }
  const r = agentEntryCheck({ readTracked: reader({ ...broken, [DEFAULT_ENTRY_FILE]: realEntry() }) })
  assert.equal(r.check.passed, false)
  assert.equal(r.findings.length, 1)
  assert.equal(r.findings[0].subject, `portable-sync:${pendingFile}`)
  assert.match(r.findings[0].hint, /静默/, 'hint 要点明"症状是静默的"（面板上看不出来，所以必须靠门禁）')
})

test('★ 启动 autoSync 清单里删掉 AGENTS.md ⇒ 红（这条路径才是调试版"每次启动"实际走的）', () => {
  const broken = { ...syncOk() }
  broken['electron/dev-source-sync.cjs'] = "const SYNC_DIRS = ['kernel', 'shared', 'server', 'electron', 'dist']"
  const r = agentEntryCheck({ readTracked: reader({ ...broken, [DEFAULT_ENTRY_FILE]: realEntry() }) })
  assert.equal(r.check.passed, false)
  assert.equal(r.findings[0].subject, 'portable-sync:electron/dev-source-sync.cjs')
})

test('★ 布局校验里删掉断言 ⇒ 红（否则"掉了"没人红，只能靠人打开目录看）', () => {
  const broken = { ...syncOk() }
  broken['scripts/verify-portable-layout.mjs'] = "const requiredFile = ['node.exe']"
  const r = agentEntryCheck({ readTracked: reader({ ...broken, [DEFAULT_ENTRY_FILE]: realEntry() }) })
  assert.equal(r.check.passed, false)
  assert.equal(r.findings[0].subject, 'portable-sync:scripts/verify-portable-layout.mjs')
})

test('★ 同步路径文件整个读不到 ⇒ 红且**不抛**（路径失效要出声）', () => {
  const map = { ...syncOk(), [DEFAULT_ENTRY_FILE]: realEntry() }
  delete map['electron/dev-source-sync.cjs']
  const r = agentEntryCheck({ readTracked: reader(map) })
  assert.equal(r.check.passed, false)
  assert.equal(r.findings[0].subject, 'portable-sync-missing:electron/dev-source-sync.cjs')
  assert.equal(r.check.evaluated, expectedEvaluated() - 1,
    '读不到的路径不计入 evaluated（如实：核到了几条才算几条）')
})

test('★ `pending` 是真判据不是借口：文件读得到却没带 AGENTS.md ⇒ 红（因此"入库后自动生效"）', () => {
  const pendingFile = AGENT_GUIDE.entry.portableSync.pending[0].file
  const r = agentEntryCheck({ readTracked: reader({ ...syncOk(), [pendingFile]: '// 已入库但清单里没有入口', [DEFAULT_ENTRY_FILE]: realEntry() }) })
  assert.equal(r.check.passed, false)
  assert.equal(r.findings[0].subject, `portable-sync:${pendingFile}`)
  assert.match(r.findings[0].hint, /已经入库/, 'hint 要说明"该文件已入库 ⇒ pending 已转为正式判据"（否则没人知道为什么突然红）')
})

test('★ `pending` 文件**未入库**时跳过、不计 evaluated（否则未跟踪文件会让门禁永远红）', () => {
  const pendingFile = AGENT_GUIDE.entry.portableSync.pending[0].file
  const map = { ...syncOk(), [DEFAULT_ENTRY_FILE]: realEntry() }
  delete map[pendingFile] // 模拟"尚未入库"
  const r = agentEntryCheck({ readTracked: reader(map) })
  assert.equal(r.check.passed, true, '未入库 ⇒ 不该红（"永远红"等于没有红灯）')
  // 未入库的 pending 同步路径少算 1 点（CT11 里每条同步路径 = 1 点；★ 别套用 CT12 的"2 点"口径 ——
  // 那边一条待核规则是"引用真源 + 渠道方式"，口径不同）；其余（锚点 / 送达链路 / paths）照常计入
  assert.equal(r.check.evaluated, expectedEvaluated() - AGENT_GUIDE.entry.portableSync.pending.length,
    '未入库的 pending 不计入 evaluated，其余仍计入')
})

test('★ 同步路径登记得更少时，evaluated 必须跟着变少（证明这条判据真的在核，而不是摆设）', () => {
  // ★ 只截短 `paths`、**保留 `pending`** —— 早先这里把整个 `portableSync` 换掉，连带把 `pending` 删了，
  //   于是两边差出"pending 的 1 点"，看起来像规则错、其实是夹具自伤（多规则共用一份夹具时的典型坑）。
  const g = fixtureGuide((x) => { x.entry.portableSync.paths = x.entry.portableSync.paths.slice(0, 1) })
  const r1 = agentEntryCheck({ readTracked: reader({ ...syncOk(), [DEFAULT_ENTRY_FILE]: realEntry() }), guide: g })
  const r3 = agentEntryCheck({ readTracked: reader({ ...syncOk(), [DEFAULT_ENTRY_FILE]: realEntry() }) })
  assert.equal(r3.check.evaluated - r1.check.evaluated, AGENT_GUIDE.entry.portableSync.paths.length - 1,
    'evaluated 要随登记的同步路径条数变化 —— 否则它只是个装饰数字')
  assert.equal(r1.check.passed, true, '少登记一条 path 本身不该红（只是核得少；"有没有"由"缺一条就红"那几条管）')
})

test('真仓入口行数确实在上限内（余量可见 —— 免得哪天悄悄膨胀到刚过线）', () => {
  const n = realEntry().split('\n').length
  assert.ok(n <= AGENT_GUIDE.entry.maxLines, `入口 ${n} 行 > 上限 ${AGENT_GUIDE.entry.maxLines}`)
  assert.ok(n >= 20, `入口只有 ${n} 行？那大概率是被误清空了`)
})

// ── ★ 送达链路：内核按**内容**去重（同一份规范在多个候选路径 ⇒ 只注入一份）───────────
// 为什么在 kit 里测内核函数：CT11 的判据就是"规范能否被正确送达"，而送达的最后一公里在
// `kernel/prompt.mjs#discoverAgentsMd` —— 那个函数**没有自己的测试网**（kernel 无测试目录、
// 且 `dev-source-sync` 的 SKIP_RE 会把 `*.test.*` 排除在同步之外）。放这里至少**跑得到**，
// 而不是写一个没人执行的测试文件（那等于假测试）。

test('★★ 送达链路（端到端）：同一份规范出现在两个候选路径 ⇒ 只注入一份（近者优先）', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { discoverAgentsMd } = await import('../../kernel/prompt.mjs')
  const root = mkdtempSync(join(tmpdir(), 'ct11-'))
  try {
    writeFileSync(join(root, '.git'), '') // 让它成为上溯终点（模拟"仓库根"）
    mkdirSync(join(root, 'sub'), { recursive: true })
    const same = '# 同一份规范\n- npm run kit:check\n'
    writeFileSync(join(root, 'AGENTS.md'), same)
    writeFileSync(join(root, 'sub', 'AGENTS.md'), same) // 同一份规范的"副本"（如便携版在仓库内）
    const r = discoverAgentsMd({ cwd: join(root, 'sub'), addDirs: [join(root, 'sub')] })
    assert.equal(r.length, 1, '★ 内容相同 ⇒ 只注入一份（否则开发机上跑便携版时同一份规范会注入两遍）')
    assert.equal(r[0].path, join(root, 'sub', 'AGENTS.md'), '近者优先：保留离 cwd 更近的那份')

    // 反向：内容**不同** ⇒ 两份都要（多项目各自规则是设计意图，不能被去重误伤）
    writeFileSync(join(root, 'AGENTS.md'), '# 另一个项目的规范\n- 不同内容\n')
    const r2 = discoverAgentsMd({ cwd: join(root, 'sub'), addDirs: [join(root, 'sub')] })
    assert.equal(r2.length, 2, '内容不同 ⇒ 各自注入（去重只针对"同一份规范"）')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('★ 送达链路有牙齿：内核里的内容去重被删 ⇒ CT11 红（防"重复注入"静默回归）', () => {
  const deliveryFile = AGENT_GUIDE.entry.delivery.file
  const stripped = String(worktree(deliveryFile)).split('seenContent').join('/* 去重被删掉 */')
  const r = agentEntryCheck({ readTracked: reader({ ...syncOk(), [deliveryFile]: stripped, [DEFAULT_ENTRY_FILE]: realEntry() }) })
  assert.equal(r.check.passed, false)
  assert.equal(r.findings[0].subject, 'delivery-missing-needle:seenContent')
  assert.match(r.findings[0].hint, /注入两遍|互相矛盾/, 'hint 要说清后果（重复注入 / 矛盾）')
})

test('★ 送达链路 fail-closed：内核文件读不到 ⇒ 红（不是"没问题"）', () => {
  const map = { ...syncOk(), [DEFAULT_ENTRY_FILE]: realEntry() }
  delete map[AGENT_GUIDE.entry.delivery.file]
  const r = agentEntryCheck({ readTracked: reader(map) })
  assert.equal(r.check.passed, false)
  assert.equal(r.findings[0].subject, `delivery-missing:${AGENT_GUIDE.entry.delivery.file}`)
})

test('★ 恒真防护：真源把 delivery 清空 ⇒ 红（否则这条判据会静默跳过）', () => {
  const g = fixtureGuide((x) => { delete x.entry.delivery })
  const r = agentEntryCheck({ readTracked: reader({ ...syncOk(), [DEFAULT_ENTRY_FILE]: realEntry() }), guide: g })
  assert.equal(r.check.passed, false)
  assert.ok(r.findings.map((f) => f.subject).includes('no-delivery'))
})

test('CT11 只核"真源登记的锚点"，不去评价入口的文风/排版（规则不做风格警察）', () => {
  // 把入口版式打乱：标题降级、列表符号换掉、行首行尾塞空格（★ 刻意**不增加行数** ——
  // 一旦加空行就会撞上 maxLines 而红，那就变成"在检验行数上限"而不是"在检验不管版式"）
  const messy = realEntry().split('\n')
    .map((l) => `   ${l.replace(/^# /, '## ').replace(/^- /, '* ')}  `)
    .join('\n')
  const r = agentEntryCheck({ readTracked: reader({ ...syncOk(), [DEFAULT_ENTRY_FILE]: messy }) })
  assert.equal(r.check.passed, true, '锚点齐全但排版难看 ⇒ 应绿（否则门禁会变成形式主义，谁也不服）')
})
