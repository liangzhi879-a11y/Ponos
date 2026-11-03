// 演化 P1 机会挖掘（kernel/opportunity-mine.mjs）纯函数测试
// ---------------------------------------------------------------------------
// 设计真源：docs/superpowers/specs/2026-10-08-runtime-evolution-loop-design.md §4.3/§4.4；
// 施工 brief：docs/superpowers/plans/2026-10-09-p1-opportunity-layer.md（D2/D3/D4/D8）。
// 纪律：本文件不 spawn、不写盘——构造 TaskRecord 形状的最小夹具，逐规则钉正反例与**边界值**
// （K−1 不出、K 出；轮距 3 内命中、第 4 轮不命中；相似度 0.79 不算、0.8 算）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ADVICE_ROUTES, CANDIDATE_STATES, EVIDENCE_CAP, MINE_V, RULE_KINDS, THRESHOLDS,
  adviceOf, candidateIdOf, freshnessOf, mergeCandidateLines, mineCandidates, planScanAppends, scoreOf, tierOf, RULE_V } from '../kernel/opportunity-mine.mjs'

const NOW = '2026-10-09T00:00:00.000Z'
const day = (n) => new Date(Date.parse(NOW) - n * 86400000).toISOString()
const WIN = { window: { from: day(30), to: NOW, days: 30 }, now: NOW }
const ref = (sid, seq, ts = NOW) => ({ sessionId: sid, seq, ts })

/** 最小 TaskRecord 夹具（mine 只读相关字段；其余字段缺失 = 防御性零值） */
const rec = (over = {}) => ({ v: 1, sessionId: 's1', turns: 0, ...over })
const fail = (tool, count, firstRef) => ({ tool, count, firstRef })
/** 调用数（错误率的分母；2026-10-10 起 OPP-1 判据需要它，见 THRESHOLDS 注释） */
const calls = (tool, count) => ({ tool, count })

/**
 * ★ 2026-10-10 OPP-1 降噪重定：判据从"绝对失败次数"改成"**错误率 ≥ 3×其余工具基线 或 ≥15%**"。
 * 本文件相应改动的口径说明（不是"为过测试改期望"，是**判据与输入面同时变更**）：
 *   · 夹具必须带分母（tools.callsByTool）——没有分母就算不出错误率，该记录整个不参与 OPP-1；
 *   · 每个 OPP-1 用例的失败次数不变，额外给出调用数 ⇒ 期望值按新公式重算，并逐条注明算法；
 *   · 新增 5 条降噪专用用例（常态率不出 / 地板门 / leave-one-out 不自指 / 最小样本 / 分母缺失）。
 * 实测基线（142 会话 / 30d）：全局 4.01%；Bash 4.32% · Edit 2.15% · Read 2.00% · Grep 3.12%
 * · Write 4.13%（常态）；WebFetch 37.76%（真热点）。
 */

// ── 常量面（规格钉死的字面量）────────────────────────────────────────────────

// ★ 2026-10-14 A2/Task 6：本用例原是 `assert.deepEqual(RULE_KINDS, {四条})` 的**全等**比较，
//   新增 OPP-7 后必然红。改为「逐条存在性 + 键集合精确比对」——这是**加强**不是放宽：
//   键集合仍精确比对（多一个少一个都红），既有四条逐字不动（防"顺手改旧规则 kind"）。
test('常量面：规则 kind 映射齐全（新增规则只加不改，既有四条逐字不动）', () => {
  assert.equal(RULE_KINDS['OPP-1'], 'tool-failure')
  assert.equal(RULE_KINDS['OPP-2'], 'skill-correction')
  assert.equal(RULE_KINDS['OPP-3'], 'same-task-retry')
  assert.equal(RULE_KINDS['OPP-4'], 'guard-heal')
  assert.equal(RULE_KINDS['OPP-7'], 'capability-gap')
  assert.equal(RULE_KINDS['OPP-8'], 'skill-crystallize')
  // ★ 2026-10-19：第一条**非建件**规则（上下文预算压力）。kind 名字要能一眼看出"这不是能力缺口"。
  assert.equal(RULE_KINDS['OPP-11'], 'context-budget')
  // ★ 2026-10-19：第二条非建件规则（模型维度）—— 同样是"换配置"而不是"建件"
  assert.equal(RULE_KINDS['OPP-12'], 'model-mismatch')
  // ★ 2026-10-27（P3）：第三条非建件规则 —— **修复没治好**（复发）。kind 要能一眼看出"这不是缺能力"。
  assert.equal(RULE_KINDS['OPP-13'], 'fault-recurrence')
  assert.deepEqual(Object.keys(RULE_KINDS).sort(),
    ['OPP-1', 'OPP-2', 'OPP-3', 'OPP-4', 'OPP-7', 'OPP-8', 'OPP-11', 'OPP-12', 'OPP-13'].sort())
})

test('常量面：MINE_V=3 / RULE_V=1 / 阈值=spec 值（K₁=5、K₂=3 轮、K₃=2）', () => {
  // ★ 2026-10-14：1 → 2。理由（与"放宽断言"无关，是**形状变更**）：候选行新增/改变了字段形状
  //   （OPP-1 的 metrics.multiple、OPP-7 的 metrics.sessionId/tools）⇒ 必须升版本，
  //   否则 append-only 的存量行永远拿不到新字段（用户实测：事实行渲染成「会话 <机器码>：— 反复失败 N 次」）。
  //   变更规矩见 kernel/opportunity-mine.mjs#MINE_V 的注释：改行形状 ⇒ +1 + 补"老版本行被重物化"的测试。
  // ★ 2026-10-18（EVO-09）：2 → 3。候选行新增 `rv`（判据语义版本）字段 —— 又是**形状变更**，
  //   按 MINE_V 注释里的规矩必须 +1，否则存量行拿不到 rv、退休机制对历史行失效。
  assert.equal(MINE_V, 3)
  // RULE_V 与 MINE_V 是**两个不同维度**：前者管判据语义（变了要退休旧候选）、后者管字段形状。
  assert.equal(RULE_V, 1)
  assert.equal(THRESHOLDS['OPP-1'].minFailures, 5)
  // 2026-10-10 降噪：OPP-1 增加两个门（绝对地板 + 相对基线倍数），依据见 THRESHOLDS 注释
  assert.equal(THRESHOLDS['OPP-1'].minErrorRate, 0.15)
  assert.equal(THRESHOLDS['OPP-1'].minErrorRate, 0.15)
  // 留痕：相对基线门（baselineRatio）曾短暂存在又被移除（自指 + 互相抬高，见 THRESHOLDS 注释）。
  // 断言它**不在**配置里，防止将来"顺手加回来"而无人复核那两个陷阱。
  assert.equal('baselineRatio' in THRESHOLDS['OPP-1'], false, 'OPP-1 判据不得含相对基线门（会自指/互相抬高）')
  assert.equal(THRESHOLDS['OPP-2'].withinTurns, 3)
    assert.equal(THRESHOLDS['OPP-2'].minHits, 2)
  assert.equal(THRESHOLDS['OPP-3'].similarity, 0.8)
  assert.equal(THRESHOLDS['OPP-3'].minPairs, 2)
  assert.equal(THRESHOLDS['OPP-4'].minStallHeals, 3)
  assert.equal(THRESHOLDS['OPP-4'].minErrorStreak, 5)
  // A2/Task 6：OPP-7 门槛（单工具失败 ≥2 次；同会话同题累计 ≥2）
  assert.equal(THRESHOLDS['OPP-7'].minPerToolFailure, 2)
  // ★ 2026-10-14 判据重做：minHits 2→5、**新增 minSessions=2**（跨会话复现门）。
  //   理由见 THRESHOLDS 注释与分支注释：原判据只在单会话内累加 ⇒ 一次事故就够 5 次被当成能力缺失
  //   （用户质疑："5次7次复现的问题到底能否判断为能力缺失，是否需要多会话的评判机制"）。
  assert.equal(THRESHOLDS['OPP-7'].minHits, 5)
  assert.equal(THRESHOLDS['OPP-7'].minSessions, 2, '★ 必须跨 ≥2 个会话才算"能力缺失"（单会话重复失败可能只是一次事故）')
  // A2/Task 7 + 2026-10-14 加强：OPP-8 从"跨 ≥3 会话"扩成**四道门**
  // （会话数 / 体量两项 / 显著性）——治"一个工具链三次会话就提议做工作流"（用户实测反馈）
  assert.equal(THRESHOLDS['OPP-8'].crossSessions, 5)
  assert.equal(THRESHOLDS['OPP-8'].minDistinctTools, 4)
  assert.equal(THRESHOLDS['OPP-8'].minCalls, 15)
  assert.equal(THRESHOLDS['OPP-8'].maxUbiquity, 0.5)
  assert.equal(THRESHOLDS['OPP-8'].sev, 1.1)
  assert.ok(Object.isFrozen(THRESHOLDS) && Object.isFrozen(THRESHOLDS['OPP-1']))
  assert.deepEqual([...CANDIDATE_STATES], ['new', 'seen', 'dismissed', 'actioned'])
})

// ── OPP-1 工具失败热点（K₁=5 + 错误率门）────────────────────────────────────

test('OPP-1 反例：4 次失败（K−1）⇒ 0 条（即便错误率 100%）', () => {
  const out = mineCandidates([rec({ tools: { errors: [fail('Bash', 4, ref('s1', 3))], callsByTool: [calls('Bash', 4)] } })], WIN)
  assert.deepEqual(out, [])
})

test('OPP-1 正例：跨会话同工具合计 15 次失败 / 100 次调用（恰在 15% 阈值）⇒ 1 条（字段全钉）', () => {
  // 判据 = failures ≥ 5 且 errRate ≥ 15%（绝对门）；此处 15/100 = 15% 恰在门线上 ⇒ 命中
  const recs = [
    rec({ sessionId: 's1', tools: { errors: [fail('Bash', 10, ref('s1', 3, day(1)))], callsByTool: [calls('Bash', 60)] } }),
    rec({ sessionId: 's2', tools: { errors: [fail('Bash', 5, ref('s2', 7, day(2)))], callsByTool: [calls('Bash', 40)] } }),
  ]
  const out = mineCandidates(recs, WIN)
  assert.equal(out.length, 1)
  const c = out[0]
  assert.equal(c.v, 3, '★ v3（2026-10-18）：新增 rv（判据语义版本）字段 ⇒ 升版本触发存量行重物化（见 MINE_V 注释）')
  assert.equal(c.ruleId, 'OPP-1')
  assert.equal(c.kind, 'tool-failure')
  assert.equal(c.subject, 'Bash')
  assert.equal(c.id, candidateIdOf('OPP-1', 'Bash'))
  assert.equal(c.count, 15)
  // 分母/阈值全在 metrics（读侧可解释"为什么它是热点"）
  assert.equal(c.metrics.sessions, 2)
  assert.equal(c.metrics.calls, 100)
  assert.equal(c.metrics.errRate, 0.15)
  assert.equal(c.metrics.needRate, 0.15)
  assert.equal(c.metrics.needRate, 0.15)
  // freqRatio = 0.15/0.15 = 1 ⇒ freq=1/1.5；lastAt=day(1) ⇒ fresh=1−1/30；score=0.6667×0.9667≈0.6444 → list
  assert.equal(c.lastAt, day(1))
  assert.equal(c.firstAt, day(2)) // 注意 day(n) 越大越早：day(2) < day(1)
  assert.equal(c.score, 0.6444)
  assert.equal(tierOf(c.score), 'list')
  assert.deepEqual(c.evidence, [ref('s1', 3, day(1)), ref('s2', 7, day(2))])
  assert.deepEqual(c.window, { from: day(30), to: NOW, days: 30 })
  assert.equal(c.state, 'new')
})

test('OPP-1 边界：错误率远超阈值（30% vs need 15%）⇒ freq 饱和 ⇒ score 1（pin）', () => {
  // 30/100 = 30% ≥ 15% ⇒ freqRatio=2 ⇒ min(1, 2/1.5)=1 ⇒ 1×1×fresh(day0=1) = 1
  const out = mineCandidates([rec({ tools: { errors: [fail('Read', 30, ref('s1', 1, day(0)))], callsByTool: [calls('Read', 100)] } })], WIN)
  assert.equal(out.length, 1)
  assert.equal(out[0].score, 1)
  assert.equal(tierOf(out[0].score), 'pin')
})

test('OPP-1 新鲜度：恰在阈值但 lastAt 在窗口边缘（30 天前）⇒ fresh 落下限 ⇒ collapsed', () => {
  const out = mineCandidates([rec({ tools: { errors: [fail('Grep', 15, ref('s1', 1, day(30)))], callsByTool: [calls('Grep', 100)] } })], WIN)
  assert.equal(out.length, 1)
  assert.equal(out[0].score, 0.2) // 0.6667×1×0.3
  assert.equal(tierOf(out[0].score), 'collapsed')
})

test('OPP-1 evidence 封顶：7 个会话 ⇒ count 7 但 evidence 只留 5 条，metrics.sessions=7', () => {
  const recs = Array.from({ length: 7 }, (_, i) =>
    rec({ sessionId: `s${i}`, tools: { errors: [fail('Bash', 1, ref(`s${i}`, 1))], callsByTool: [calls('Bash', 1)] } }))
  const out = mineCandidates(recs, WIN)
  assert.equal(out.length, 1)
  assert.equal(out[0].count, 7)
  assert.equal(out[0].evidence.length, EVIDENCE_CAP)
  assert.equal(out[0].metrics.sessions, 7)
})

// ── OPP-1 降噪（2026-10-10 新增：实测驱动，五条防回归）──────────────────────

test('★ 降噪①：常态错误率不产出——复刻实测分布（Bash 216/5005=4.32% 不出；WebFetch 54/143=37.76% 出）', () => {
  // 这是本仓真实数据（142 会话 / 9103 次调用）的比例复刻，是本次降噪的**验收样例**
  const recs = [
    rec({ sessionId: 's1', tools: { errors: [fail('Bash', 216, ref('s1', 1))], callsByTool: [calls('Bash', 5005)] } }),
    rec({ sessionId: 's1', tools: { errors: [fail('WebFetch', 54, ref('s1', 2))], callsByTool: [calls('WebFetch', 143)] } }),
    rec({ sessionId: 's1', tools: { errors: [fail('Read', 22, ref('s1', 3))], callsByTool: [calls('Read', 1100)] } }),
  ]
  const out = mineCandidates(recs, WIN)
  assert.deepEqual(out.map((c) => c.subject), ['WebFetch'], '只有错误率显著高于基线的工具才出候选')
  assert.equal(out[0].count, 54)
  assert.equal(out[0].metrics.errRate, 0.3776)
})

test('★ 降噪②：绝对地板门——10% 也不够（防"错误率不高却被当热点"）', () => {
  const recs = [
    rec({ sessionId: 's1', tools: { errors: [fail('Grep', 10, ref('s1', 1))], callsByTool: [calls('Grep', 100)] } }),
    rec({ sessionId: 's1', tools: { errors: [], callsByTool: [calls('Bash', 900)] } }),
    rec({ sessionId: 's1', tools: { errors: [fail('Bash', 5, ref('s1', 2))], callsByTool: [calls('Bash', 100)] } }),
  ]
  const out = mineCandidates(recs, WIN)
  assert.deepEqual(out, [], 'Grep 10% < 15% ⇒ 不出；Bash 5/1000=0.5% ⇒ 也不出')
})

test('★ 降噪②b：绝对门不"互相抬高"——环境整体劣化时，两个高错误率工具都应被看见', () => {
  // 留痕：这条用例是从**相对基线门的失败构造**改来的（Flaky 40% 会被 Grep 20% 抬到 need=60% 而不出）。
  // 绝对门下两者各自对 15% 比较 ⇒ 都出（"整体劣化"该被看见，不该因彼此为基线而互相抵消）。
  const recs = [
    rec({ sessionId: 's1', tools: { errors: [fail('Grep', 20, ref('s1', 1))], callsByTool: [calls('Grep', 100)] } }),
    rec({ sessionId: 's1', tools: { errors: [fail('Flaky', 400, ref('s1', 2))], callsByTool: [calls('Flaky', 1000)] } }),
  ]
  const out = mineCandidates(recs, WIN)
  assert.deepEqual(out.map((c) => c.subject).sort(), ['Flaky', 'Grep'])
  assert.equal(out.find((c) => c.subject === 'Grep').metrics.needRate, 0.15, '判定阈值恒为地板，不随基线浮动')
})

test('★ 降噪③：单工具项目里高错误率必须出（防"自指基线"陷阱：拿自身当基线则真热点永不出）', () => {
  const out = mineCandidates([rec({ tools: { errors: [fail('WebFetch', 40, ref('s1', 1))], callsByTool: [calls('WebFetch', 100)] } })], WIN)
  assert.equal(out.length, 1, '绝对门下 40% ≥ 15% 必须命中（判定不依赖任何"基线"，故无自指可能）')
  assert.equal(out[0].metrics.needRate, 0.15)
  assert.equal(out[0].metrics.baselineRate, 0.4, '基线仍被算出（此处 = 自身 40%）——只作展示，不参与判定')
})

test('★ 降噪④：最小样本门——错误率 100% 但只有 1 次失败 ⇒ 不出（小样本不算热点）', () => {
  const out = mineCandidates([rec({ tools: { errors: [fail('OCR', 1, ref('s1', 1))], callsByTool: [calls('OCR', 1)] } })], WIN)
  assert.deepEqual(out, [])
})

test('★ 降噪⑤：缺分母 ⇒ 不产出（旧投影保护：只贡献分子会抬高错误率、造假热点）', () => {
  const out = mineCandidates([rec({ tools: { errors: [fail('Bash', 99, ref('s1', 1))] } })], WIN)
  assert.deepEqual(out, [], '无 callsByTool 的记录整个不参与 OPP-1（分子分母必须同源）')
})

// ── OPP-2 技能加载后接着纠错（≤3 轮内、≥2 次）───────────────────────────────

const turnSeq = [10, 20, 30, 40, 50, 60]

test('OPP-2 反例：命中 1 次（K−1）⇒ 0 条', () => {
  const r = rec({
    skills: { loads: [{ id: 'gxtz-1', seq: 12, ts: NOW }] },
    turnSeq,
    corrections: [{ turnRef: ref('s1', 25) }],
  })
  assert.deepEqual(mineCandidates([r], WIN), [])
})

test('OPP-2 正例：两次纠正各在 3 轮内 ⇒ 1 条；轮距 4 的不算（边界两侧各钉一次）', () => {
  const r = rec({
    skills: { loads: [{ id: 'gxtz-1', seq: 12, ts: NOW }] }, // 轮序 1（≤12 的轮界=10）
    turnSeq,
    corrections: [
      { turnRef: ref('s1', 30) }, // 轮序 3 ⇒ 距 2，命中
      { turnRef: ref('s1', 40) }, // 轮序 4 ⇒ 距 3，命中（K₂ 边界内）
      { turnRef: ref('s1', 50) }, // 轮序 5 ⇒ 距 4，**不命中**
    ],
  })
  const out = mineCandidates([r], WIN)
  assert.equal(out.length, 1)
  assert.equal(out[0].ruleId, 'OPP-2')
  assert.equal(out[0].kind, 'skill-correction')
  assert.equal(out[0].subject, 'gxtz-1')
  assert.equal(out[0].count, 2)
  assert.deepEqual(out[0].evidence, [ref('s1', 30), ref('s1', 40)])
  assert.equal(out[0].score, 0.8) // freqRatio=1 ⇒ 0.6667×1.2×1（fresh=1，ts=NOW）
  assert.equal(tierOf(out[0].score), 'pin')
})

test('OPP-2 反例：纠正发生在加载之前 ⇒ 不算', () => {
  const r = rec({
    skills: { loads: [{ id: 'k', seq: 45, ts: NOW }] },
    turnSeq,
    corrections: [{ turnRef: ref('s1', 25) }, { turnRef: ref('s1', 35) }, { turnRef: ref('s1', 55) }],
  })
  // seq45 之前的两条剔除；只剩 55（轮序 5 vs 加载轮序 4 ⇒ 距 1）⇒ 1 次 < 2
  assert.deepEqual(mineCandidates([r], WIN), [])
})

test('OPP-2 去重口径：同技能加载两次、同一纠正落在两次窗口内 ⇒ 只算 1 次', () => {
  const r = rec({
    skills: { loads: [{ id: 'k', seq: 12, ts: NOW }, { id: 'k', seq: 45, ts: NOW }] },
    turnSeq,
    corrections: [{ turnRef: ref('s1', 52) }], // 对 load(12): 距 5 不命中；对 load(45): 距 1 命中
  })
  assert.deepEqual(mineCandidates([r], WIN), [])
})

test('OPP-2 防御：无 turnSeq（旧记录）⇒ 轮距不可算，跳过不猜', () => {
  const r = rec({
    skills: { loads: [{ id: 'k', seq: 12, ts: NOW }] },
    corrections: [{ turnRef: ref('s1', 30) }, { turnRef: ref('s1', 40) }],
  })
  assert.deepEqual(mineCandidates([r], WIN), [])
})

// ── OPP-3 同题重试（Jaccard ≥0.8 的相邻对 ≥2）───────────────────────────────

const pair = (firstSeq, secondSeq, similarity) => ({ firstSeq, secondSeq, similarity })

test('OPP-3 反例：相似度全为 0.79（阈值下）⇒ 0 条', () => {
  const r = rec({ nearRepeatPairs: [pair(1, 2, 0.79), pair(3, 4, 0.79), pair(5, 6, 0.79)] })
  assert.deepEqual(mineCandidates([r], WIN), [])
})

test('OPP-3 反例：恰好 0.8 但只有 1 对（K−1）⇒ 0 条', () => {
  const r = rec({ nearRepeatPairs: [pair(1, 2, 0.8)] })
  assert.deepEqual(mineCandidates([r], WIN), [])
})

test('OPP-3 正例：0.8 两对 ⇒ 1 条（subject=会话 id；refs 指向 secondSeq）', () => {
  const r = rec({
    sessionId: 'sess-a',
    startedAt: day(2),
    endedAt: NOW, // ← lastAt 源；fresh=1
    nearRepeatPairs: [pair(1, 2, 0.8), pair(3, 4, 0.81), pair(5, 6, 0.5)],
  })
  const out = mineCandidates([r], WIN)
  assert.equal(out.length, 1)
  assert.equal(out[0].ruleId, 'OPP-3')
  assert.equal(out[0].kind, 'same-task-retry')
  assert.equal(out[0].subject, 'sess-a')
  assert.equal(out[0].count, 2)
  assert.equal(out[0].metrics.maxSimilarity, 0.81)
  assert.deepEqual(out[0].evidence, [
    { sessionId: 'sess-a', seq: 2, ts: null },
    { sessionId: 'sess-a', seq: 4, ts: null },
  ])
  assert.equal(out[0].score, 0.6) // 0.6667×0.9×1 ⇒ 恰在 list 下界
  assert.equal(tierOf(out[0].score), 'list')
})

// ── OPP-4 守卫自愈热点（stallHeals≥3 或 errorStreakMax≥5）───────────────────

test('OPP-4 反例：stallHeals=2 且 errorStreak=4（双阈值之下）⇒ 0 条', () => {
  const r = rec({ guard: { stallHeals: 2, errorStreakMax: 4, worstLevel: 2 } })
  assert.deepEqual(mineCandidates([r], WIN), [])
})

test('OPP-4 正例：stallHeals=3 ⇒ 1 条（count=3+0；metrics 带拆分）', () => {
  const r = rec({ sessionId: 'sess-g', guard: { stallHeals: 3, errorStreakMax: 0, repeatStreakMax: 0, worstLevel: 2, firstRef: ref('sess-g', 5) } })
  const out = mineCandidates([r], WIN)
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'guard-heal')
  assert.equal(out[0].subject, 'sess-g')
  assert.equal(out[0].count, 3)
  assert.deepEqual(out[0].metrics, { stallHeals: 3, errorStreakMax: 0, worstLevel: 2 })
  assert.deepEqual(out[0].evidence, [ref('sess-g', 5)])
  assert.equal(out[0].score, 0.7333) // 0.6667×1.1×1 ⇒ 差一点到 pin
  assert.equal(tierOf(out[0].score), 'list')
})

test('OPP-4 正例：stallHeals=0 但 errorStreakMax=5 ⇒ 1 条（count=5，强度按 5/5 归一）', () => {
  const r = rec({ sessionId: 'sess-e', endedAt: NOW, guard: { stallHeals: 0, errorStreakMax: 5, worstLevel: 3 } })
  const out = mineCandidates([r], WIN)
  assert.equal(out.length, 1)
  assert.equal(out[0].count, 5)
  assert.equal(out[0].metrics.errorStreakMax, 5)
  assert.equal(out[0].score, 0.7333)
})

test('OPP-4 防御：无任何时间戳（firstRef/startAt/endAt 全缺）⇒ 新鲜度落下限（保守不虚高）', () => {
  const r = rec({ sessionId: 'sess-t', guard: { stallHeals: 3, errorStreakMax: 0 } })
  const out = mineCandidates([r], WIN)
  assert.equal(out.length, 1)
  assert.equal(out[0].lastAt, null)
  assert.equal(out[0].score, 0.22) // 0.6667×1.1×0.3（fresh 下限）
  assert.equal(tierOf(out[0].score), 'collapsed')
})

test('OPP-4 强度饱和：stallHeals=6 ⇒ freqRatio=2 ⇒ score clamp 到 1（pin）', () => {
  const r = rec({ sessionId: 'sess-x', guard: { stallHeals: 6, errorStreakMax: 0, firstRef: ref('sess-x', 5) } })
  const out = mineCandidates([r], WIN)
  assert.equal(out.length, 1)
  assert.equal(out[0].score, 1)
  assert.equal(tierOf(out[0].score), 'pin')
})

test('OPP-4 防御：guard=null（无守卫记录）⇒ 跳过，不造 0 假', () => {
  assert.deepEqual(mineCandidates([rec({ guard: null })], WIN), [])
})

// ── A2：OPP-7 能力缺口（零技能加载 + 同题失败 ⇒ 建议新建）─────────────────────

// ── OPP-7 能力缺口（2026-10-14 判据重做：跨会话复现 + 可读 subject）────────────
// ★ 为什么重做：原判据按 `会话id:工具指纹` 聚合 ⇒ ① subject 是机器码（用户看不到"缺的是什么能力"）；
//   ② 单会话内凑够次数就命中（一次事故被当成能力缺失）。现在按**反复失败的工具集合**聚合、
//   并要求**跨 ≥2 个会话**（用户的质疑："是否需要多会话的评判机制"）。
const opp7Rec = (sid, o = {}) => rec({
  sessionId: sid, turns: 4,
  tools: { calls: o.calls ?? 8, errors: [{ tool: o.tool ?? 'Grep', count: o.count ?? 3, firstRef: ref(sid, 5) }], callsByTool: [calls(o.tool ?? 'Grep', o.calls ?? 8)] },
  skills: { loaded: [], triggerHits: [], loads: [] },
})

test('★ OPP-7：**跨 2 会话**零技能加载 + 同工具反复失败 ⇒ 候选；subject = 工具集合（**可读**）', () => {
  const out = mineCandidates([opp7Rec('s7'), opp7Rec('s8')], WIN).filter((x) => x.ruleId === 'OPP-7')
  assert.equal(out.length, 1, '同一工具集合跨会话 ⇒ 合并为一条（那才是"缺这个能力"）')
  const c = out[0]
  assert.equal(c.kind, 'capability-gap')
  assert.equal(c.subject, 'Grep', '★ subject = 反复失败的工具集合（可读），不再是 会话id:哈希 机器码')
  assert.equal(c.count, 6, '失败次数跨会话累计（3+3）')
  assert.equal(c.metrics.sessions, 2, '跨了 2 个会话（事实行要给用户看这个）')
  assert.deepEqual(c.metrics.tools, ['Grep'])
  // ★★ 2026-10-14 三（用户："给建议加「先判断属于哪一类」"）：
//   本规则的判据是"零技能加载 + 反复失败" ⇒ **天然自证**为"缺能力"（只因没加载技能就说该加技能）。
//   而反复失败至少三类成因，处置完全不同、其中两类**不该新建任何件**。
//   ⇒ hypoth 改为三条 `class-*`（各自带**判别证据**），不再用 `missing-skill` 断言"缺技能"。
test('★★ OPP-7 建议：先分类（三类成因各自的判别证据），不再断言"缺技能"', () => {
  const a = adviceOf('OPP-7', { failures: 51, sessions: 3, tools: ['Bash', 'Edit'] })
  assert.deepEqual(a.hypoth.map((h) => h.code),
    ['class-tool-usage', 'class-task-nature', 'class-missing-knowledge', 'skill-catalog-cost'],
    '三类成因 + （多会话时）代价提示；不含 missing-skill（那是自证）')
  // ① 类要带**具体工具**（"失败集中在同一个动作上（Bash、Edit）"）—— 否则用户无法判断属不属于这一 类
  assert.deepEqual(a.hypoth[0].args, { tools: 'Bash、Edit' })
  // 单会话（不构成目录压力）⇒ 不提代价（避免噪声）
  const single = adviceOf('OPP-7', { failures: 9, sessions: 1, tools: ['Bash'] })
  assert.ok(!single.hypoth.some((h) => h.code === 'skill-catalog-cost'), '单会话不构成目录压力 ⇒ 不提代价')
  // 反向：三类缺一不可（漏一类就等于把"先分类"又变回"直接建议建件"）
  for (const must of ['class-tool-usage', 'class-task-nature', 'class-missing-knowledge']) {
    assert.ok(a.hypoth.some((h) => h.code === must), `缺分类假设：${must}`)
  }
})

// ★ 2026-10-14 二轮：顺序改为**成本升序**（用户担忧："判定几乎都是新建 skill，会不会污染上下文"）。
  //   对 system 提示词的开销差一个量级：check-usage **0** / revise-existing **0 新增** /
  //   create-workflow ~150B（进工作流清单）/ create-skill ~163B/个（进技能清单，本机 89 技能 ≈14.5KB）。
  //   首条 = 默认通道 ⇒ 决定 agent 先做什么，故最便宜的在前。
  assert.deepEqual(c.advice.actions.map((a) => a.route), ['advice', 'draft:skill', 'draft:workflow', 'draft:skill'],
    '★ 成本升序：先查用法(0) → 修订既有(0新增) → 做流程(清单小) → 新建技能(清单最大，最后)')
  assert.deepEqual(c.advice.actions.map((a) => a.code), ['check-usage', 'revise-existing', 'create-workflow', 'create-skill'],
    '首条必须是 check-usage（不建件）；最贵的 create-skill 必须排最后')
})

test('★★ OPP-7 反向（新门）：**单会话**反复失败 ⇒ 不产候选（一次事故不该叫能力缺失）', () => {
  // 用户质疑的核心：判据要"跨会话复现"才算能力缺失。这条与上一条成对 ⇒ 证明新门真的在挡。
  const only1 = [opp7Rec('s7', { count: 9, calls: 20 })]
  assert.equal(mineCandidates(only1, WIN).filter((x) => x.ruleId === 'OPP-7').length, 0,
    '只有 1 个会话 ⇒ 即使失败 9 次也不出（minSessions=2）')
  // 前置证明：同一批数据加上第二个会话就会出（否则上一条可能是被别的门挡的 ⇒ 恒真）
  const two = [opp7Rec('s7', { count: 9, calls: 20 }), opp7Rec('s8', { count: 3, calls: 8 })]
  assert.equal(mineCandidates(two, WIN).filter((x) => x.ruleId === 'OPP-7').length, 1, '前置：跨会话即出')
})

test('★ OPP-7：不同失败工具组合 ⇒ 不同候选（能力不同，不合并）', () => {
  const out = mineCandidates([opp7Rec('s7', { tool: 'Grep' }), opp7Rec('s8', { tool: 'Grep' }), opp7Rec('s9', { tool: 'Read' }), opp7Rec('sa', { tool: 'Read' })], WIN)
    .filter((x) => x.ruleId === 'OPP-7')
  assert.equal(out.length, 2, 'Grep 与 Read 是两种不同的能力缺口')
  assert.deepEqual(out.map((x) => x.subject).sort(), ['Grep', 'Read'])
})

test('★ OPP-7 反向：加载过技能 ⇒ 不产能力缺口候选（那是 OPP-2 的面）', () => {
  const r = rec({
    sessionId: 's7', turns: 4,
    tools: { calls: 6, errors: [{ tool: 'Grep', count: 2, firstRef: ref('s7', 5) }], callsByTool: [calls('Grep', 6)] },
    skills: { loaded: [{ id: 'foo', count: 1 }], triggerHits: [], loads: [{ id: 'foo', seq: 2, ts: NOW }] },
  })
  assert.equal(mineCandidates([r], WIN).filter((x) => x.ruleId === 'OPP-7').length, 0)
})

test('★ OPP-7 反向：失败次数 < 2 ⇒ 不产（门槛）', () => {
  const r = rec({
    sessionId: 's7', turns: 4,
    tools: { calls: 6, errors: [{ tool: 'Grep', count: 1, firstRef: ref('s7', 5) }], callsByTool: [calls('Grep', 6)] },
    skills: { loaded: [], triggerHits: [], loads: [] },
  })
  assert.equal(mineCandidates([r], WIN).filter((x) => x.ruleId === 'OPP-7').length, 0)
})

test('★ OPP-7 反向：无证据（空输入）⇒ 精确 0 条（自举期不许造创建噪声）', () => {
  assert.deepEqual(mineCandidates([], WIN).filter((x) => x.ruleId === 'OPP-7'), [])
})

// ★ 2026-10-14：原「不同失败工具组合 ⇒ 不同 subject（**同会话**的多缺口不合并）」用例已删 ——
//   它的前提是本条规则按**会话**聚合（`会话id:工具指纹`），而判据重做后改为按**工具集合**聚合
//   并要求跨 ≥2 会话。该用例的夹具（两个工具都在同一个会话 'sl'）在新判据下**不该**出候选，
//   旧的"应得 2 条"断言随之失去意义。等价且更强的守卫见上方
//   「★ OPP-7：不同失败工具组合 ⇒ 不同候选（能力不同，不合并）」（跨会话夹具 + 断言两种能力分开）。
//   ★ 不是"删断言消红"：功能语义变了 → 断言随语义改写（旧形态在新语义下无法成立），且新断言更强。

// ★ 反向断言（本仓"旧投影保护"纪律，与 OPP-1 的缺 callsByTool 同款）：
//   记录**没有技能面**（老投影 / 手工夹具）时，"全程零技能加载"**不可判定** ⇒ 必须跳过不猜。
//   若按"缺省当零加载"处理，会让所有老记录里的常态失败都变成"建议新建技能"＝造创建噪声
//   （设计稿 §3.2 注："启用前不跑——防用臆想阈值造创建噪声"），且会把 10 条既有 OPP-1 断言判红。
test('★ OPP-7 防御：无 skills 面（老投影）⇒ 不产（零加载不可判定 ⇒ 不猜，与 OPP-1 缺分母同款）', () => {
  const r = rec({
    sessionId: 's7', turns: 4,
    tools: { calls: 6, errors: [{ tool: 'Grep', count: 5, firstRef: ref('s7', 5) }], callsByTool: [calls('Grep', 6)] },
  })
  assert.equal(mineCandidates([r], WIN).filter((x) => x.ruleId === 'OPP-7').length, 0)
  const bad = rec({ sessionId: 's7', skills: { loaded: 'x' }, tools: { errors: [{ tool: 'Grep', count: 5, firstRef: ref('s7', 5) }] } })
  assert.equal(mineCandidates([bad], WIN).filter((x) => x.ruleId === 'OPP-7').length, 0, 'loaded 非数组 ⇒ 同样不可判定')
})

// ── A2：OPP-8 熟练模式结晶 ─────────────────────────────────────────────────
// ★ 2026-10-14 判据加强后的夹具（用户实测反馈"一个工具调用链三次会话重复使用了就要提议做工作流"）：
//   必须同时满足**四道门**，缺一不出——夹具若只满足旧门槛（3 会话 / 2 工具 / 2 调用 / 人人如此），
//   新判据下**不该**出候选（那正是要加强掉的噪声）。故：
//   · 5 个命中会话 ≥ crossSessions(5)
//   · 指纹含 **4** 个不同工具 ≥ minDistinctTools(4)
//   · 每会话 **20** 次调用 ≥ minCalls(15)
//   · 另有 10 个"别的模式"会话 ⇒ 命中占比 5/15 = **33%** ≤ maxUbiquity(0.5)
//     （★ 这一条必需：不加分母会话，5/5=100% 会被"日常门"挡掉——而那正是新判据要治的）
const PATTERN = 'Read>Edit>Grep>Bash'
/** 满足四道门的命中夹具：5 命中 + 10 个别的模式（后者只有 2 个工具 ⇒ 自己不会出候选） */
const patternRecs = () => [
  ...['a', 'b', 'c', 'd', 'e'].map((sid) =>
    rec({ sessionId: sid, tools: { calls: 20, errors: [], sequence: PATTERN }, skills: { loaded: [], triggerHits: [], loads: [] } })),
  ...Array.from({ length: 10 }, (_, i) =>
    rec({ sessionId: `o${i}`, tools: { calls: 20, errors: [], sequence: 'WebFetch>Read' }, skills: { loaded: [], triggerHits: [], loads: [] } })),
]

test('★ OPP-8：同模式跨 ≥5 会话、够厚（4 工具/20 调用）、且非"日常"（占 33%）⇒ 候选', () => {
  const out = mineCandidates(patternRecs(), WIN).filter((x) => x.ruleId === 'OPP-8')
  assert.equal(out.length, 1, '同指纹 ⇒ 精确 1 条')
  assert.equal(out[0].kind, 'skill-crystallize')
  assert.equal(out[0].subject, PATTERN, 'subject = 保序序列指纹（含顺序，不再是无序集合）')
  assert.equal(out[0].count, 5, 'count = 命中会话数')
  // ★ 2026-10-19（用户实测反馈："生成方案默认新建 skill，不符合使用要求"）：
  //   默认通道改为**流程** —— 这条规则识别的是"跨会话反复出现的一套工具组合"，它本质是**编排**，
  //   固化成工作流（可执行结构）比写成技能说明（模型自己照着做）更贴切。
  assert.equal(out[0].advice.actions[0].route, 'draft:workflow')
})

test('★ OPP-8：模式已被既有件覆盖（existingPatterns 命中）⇒ 不产候选', () => {
  const out = mineCandidates(patternRecs(), { ...WIN, existingPatterns: [PATTERN] }).filter((x) => x.ruleId === 'OPP-8')
  assert.equal(out.length, 0, '已固化 ⇒ 不产（否则用户会被自己已有的技能反复打扰）')
})

test('★ OPP-8 反向：无 sequence（老投影）⇒ 不出（不猜）', () => {
  const mk = (sid) => rec({ sessionId: sid, tools: { calls: 20, errors: [] }, skills: { loaded: [], triggerHits: [], loads: [] } })
  assert.equal(mineCandidates(['a', 'b', 'c', 'd', 'e'].map(mk), WIN).filter((x) => x.ruleId === 'OPP-8').length, 0, '无 sequence 不得猜')
})

// ★ 2026-10-14 新增：四道门各自的反例（逐门证明它真的在挡，而不是摆设）。
//   为什么每条都配一个"其余条件齐备"的构造：否则"不出"可能只是别的门挡住了 ⇒ 变成恒真断言。
test('★ OPP-8 反向（新门槛）：会话数 / 工具数 / 调用量 / 显著性 四道门逐条生效', () => {
  const hit = (sid, o = {}) => rec({
    sessionId: sid,
    tools: { calls: o.calls ?? 20, errors: [], sequence: o.seq ?? PATTERN },
    skills: { loaded: [], triggerHits: [], loads: [] },
  })
  const filler = Array.from({ length: 10 }, (_, i) => hit(`f${i}`, { seq: 'WebFetch>Read' }))
  const run = (recs) => mineCandidates(recs, WIN).filter((x) => x.ruleId === 'OPP-8').length
  // 前置证明：本夹具的"正例"确实出（否则下面的 0 毫无意义）
  assert.equal(run([...['a', 'b', 'c', 'd', 'e'].map((s) => hit(s)), ...filler]), 1, '前置：该夹具在四门齐备时必出')
  // ① 会话数 4 < 5
  assert.equal(run([...['a', 'b', 'c', 'd'].map((s) => hit(s)), ...filler]), 0, '① 会话数不足 ⇒ 不出')
  // ② 不同工具 3 < 4（其余全齐）
  assert.equal(run([...['a', 'b', 'c', 'd', 'e'].map((s) => hit(s, { seq: 'Read>Edit>Grep' })), ...filler]), 0, '② 工具太单一 ⇒ 不出')
  // ③ 平均调用 14 < 15（其余全齐）
  assert.equal(run([...['a', 'b', 'c', 'd', 'e'].map((s) => hit(s, { calls: 14 })), ...filler]), 0, '③ 会话太薄 ⇒ 不出')
  // ④ 显著性：15/15 = 100% > 50% ⇒ "人人都这样 = 日常"，不是可固化的机会
  assert.equal(run(Array.from({ length: 15 }, (_, i) => hit(`p${i}`))), 0, '④ 太普遍 ⇒ 不出（这条治"太松"）')
})

// ── A2/Task 11：OPP-8 的候选**同时给两个方向**（做成技能 / 做成流程）────────────
// 背景（控制器裁决，台账「修正 7」留痕）：原计划新增独立规则 **OPP-9 流程固化**（规格预留项），但其判据与 OPP-8
// **完全不可区分**（同为"同一 tools.sequence 指纹跨 ≥3 会话且未被 existingPatterns 覆盖"）
// ⇒ 加成独立规则会产**两条一模一样的候选**（同一事实报两次，用户会以为发现了两件事）。
// 故不新增规则：`actions` 本来就是数组，用它表达"可做成 A 或 B"才是它该有的用法。
// 夹具复用本节开头的 `patternRecs()`（满足加强后的四道门）。

test('★ OPP-8 双方向：同一模式给「技能」与「流程」两个方向，仍只产 1 条候选', () => {
  const out = mineCandidates(patternRecs(), WIN).filter((x) => x.ruleId === 'OPP-8')
  assert.equal(out.length, 1, '多一个方向 ≠ 多一条候选（重复提案是本裁决要消除的那个缺陷）')
  const { hypoth, actions } = out[0].advice
  assert.deepEqual(hypoth.map((h) => h.code), ['repeatable-pattern', 'repeatable-flow'],
    '两条假设 = 能力视角（像可固化的技能）+ 编排视角（像可固化的流程）')
  assert.deepEqual(actions.map((a) => [a.code, a.route]), [
    ['create-workflow', 'draft:workflow'],
    ['crystallize-skill', 'draft:skill'],
  ], '两个方向 = 新建工作流固化编排 / 新建技能固化做法')
  // ★ 顺序即默认通道：前端「生成方案」按钮的判据 = **首条** action 的 route（evolution.ts#supportsDraft），
  //   端点 `POST /evolution/draft` 也取首条 draft:*（kernel/draft-intent.mjs#draftChannelOf）。
  //   ★ 2026-10-19 起首条改为 **draft:workflow**（用户实测反馈："生成方案默认新建 skill 不符合使用要求"）：
  //     这条规则判的是"跨会话反复出现的一套工具组合"= 一段**编排**，固化成可执行的工作流才对味。
  assert.equal(actions[0].route, 'draft:workflow', '首条必须走流程通道（默认通道 = 流程优先）')
})

test('★ OPP-8 advice：code 全 kebab-case（驼峰会被机械抽取守卫漏掉）', () => {
  const out = mineCandidates(patternRecs(), WIN).filter((x) => x.ruleId === 'OPP-8')
  const codes = [...out[0].advice.hypoth, ...out[0].advice.actions].map((x) => x.code)
  assert.ok(codes.length >= 4, `前置条件：两个方向至少 4 个 code（实得 ${codes.length}）`)
  for (const code of codes) {
    // 机械抽取守卫按 `code: '<非引号串>'` 的**形态**扫源码，只认小写与连字符 ⇒ 驼峰 code 会被静默漏抽
    // ⇒ 前端映射覆盖断言失效 ⇒ 该建议永不显示（本仓先例：OPP-7/OPP-8 的 kebab-case 纪律）。
    assert.match(code, /^[a-z][a-z0-9-]*$/, `建议 code 必须 kebab-case：${code}`)
  }
})

test('★ OPP-8 advice：插值参数（证据）只挂在 hypoth 上，且带齐三项证据', () => {
  const out = mineCandidates(patternRecs(), WIN).filter((x) => x.ruleId === 'OPP-8')
  const { hypoth, actions } = out[0].advice
  // 组件对 actions 调 `t(key)` **不传 args**（EvolutionPane 的 actKeys）⇒ 给 action 挂 args 是死数据，
  // 给方向文案写占位符会**原样显示**（useTranslation 的 interpolate 找不到参数时保留 {sessions}）。
  // 故插值参数只挂在 hypoth 的那一条上（hypoth 侧成对取 key+args）。
  // ★ 2026-10-14 加强：证据从"只有会话数"扩成"会话数 + 工具数 + 平均调用"——
  //   目的是治"表述同质化"（用户实测反馈第二点）：每条候选的建议带**自己的数字**，不再逐字雷同。
  assert.deepEqual(hypoth.filter((h) => h.args).map((h) => [h.code, h.args]),
    [['repeatable-pattern', { sessions: 5, tools: 4, calls: 20 }]], '证据三项只给带占位符的那条假设')
  assert.deepEqual(actions.map((a) => a.args), [undefined, undefined], '方向条目不得带插值参数（组件不传 args）')
})

// ── 空/确定性/id 稳定 ───────────────────────────────────────────────────────

test('空输入 ⇒ 精确 0 条；无关字段的记录也不出候选', () => {
  assert.deepEqual(mineCandidates([], WIN), [])
  assert.deepEqual(mineCandidates([rec({ tools: { calls: 9, distinct: 2, errors: [] } }), rec({ guard: null })], WIN), [])
})

test('确定性：同一输入两次 ⇒ 逐字相等（含排序）；同分候选按 id 升序', () => {
  // 两条都要**命中**且**同分**（才验得到"同分按 id 升序"）。两个被测工具各 15/100=15% 恰在地板阈值；
  // 第三个工具（WebFetch）只提供大量调用、零失败 ⇒ 把它俩的 others 基线压到 0.15% ⇒ need 仍由地板 15% 主导。
  const recs = [
    rec({ sessionId: 's1', tools: { errors: [fail('Bash', 15, ref('s1', 1))], callsByTool: [calls('Bash', 100)] } }),
    rec({ sessionId: 's2', tools: { errors: [fail('Read', 15, ref('s2', 1))], callsByTool: [calls('Read', 100)] } }),
    rec({ sessionId: 's3', tools: { errors: [], callsByTool: [calls('WebFetch', 10000)] } }),
  ]
  const a = mineCandidates(recs, WIN)
  const b = mineCandidates([...recs].reverse(), WIN) // 输入顺序颠倒也应得同序（有确定性排序）
  assert.equal(JSON.stringify(a), JSON.stringify(b))
  assert.equal(a.length, 2)
  assert.equal(a[0].score, a[1].score)
  assert.ok(a[0].id < a[1].id, '同分按 id 升序')
})

test('id 稳定：与时间无关；不同 rule/subject 不同 id；形如 12 位 hex', () => {
  assert.equal(candidateIdOf('OPP-1', 'Bash'), candidateIdOf('OPP-1', 'Bash'))
  assert.notEqual(candidateIdOf('OPP-1', 'Bash'), candidateIdOf('OPP-1', 'Read'))
  assert.notEqual(candidateIdOf('OPP-1', 'Bash'), candidateIdOf('OPP-2', 'Bash'))
  assert.match(candidateIdOf('OPP-1', 'Bash'), /^[0-9a-f]{12}$/)
})

// ── score / freshness / tier 纯函数面 ───────────────────────────────────────

test('scoreOf：乘积式 + 饱和 + clamp；freqRatio=1 ⇒ 1/1.5', () => {
  assert.equal(scoreOf({ freqRatio: 1, sev: 1, fresh: 1 }), 0.6667)
  assert.equal(scoreOf({ freqRatio: 1.5, sev: 1, fresh: 1 }), 1)
  assert.equal(scoreOf({ freqRatio: 100, sev: 1, fresh: 1 }), 1)
  assert.equal(scoreOf({ freqRatio: 1, sev: 1.2, fresh: 1 }), 0.8)
  assert.equal(scoreOf({ freqRatio: 1, sev: 1, fresh: 0.5 }), 0.3333)
  assert.equal(scoreOf({ freqRatio: 0, sev: 1, fresh: 1 }), 0)
  assert.equal(scoreOf({ freqRatio: 3, sev: 1.1, fresh: 1 }), 1) // sev>1 也 clamp01
  assert.equal(scoreOf({ freqRatio: -1, sev: 1, fresh: 1 }), 0)
})

test('freshnessOf：now⇒1 / 半窗⇒0.5 / 到窗缘与更老⇒下限 0.3 / 坏输入⇒下限', () => {
  const nowMs = Date.parse(NOW)
  assert.equal(freshnessOf(NOW, { nowMs, windowDays: 30 }), 1)
  assert.equal(freshnessOf(day(15), { nowMs, windowDays: 30 }), 0.5)
  assert.equal(freshnessOf(day(30), { nowMs, windowDays: 30 }), 0.3)
  assert.equal(freshnessOf(day(60), { nowMs, windowDays: 30 }), 0.3)
  assert.equal(freshnessOf('垃圾', { nowMs, windowDays: 30 }), 0.3)
  assert.equal(freshnessOf(null, { nowMs, windowDays: 30 }), 0.3)
  assert.equal(freshnessOf(NOW, { nowMs: NaN, windowDays: 30 }), 0.3)
  assert.equal(freshnessOf(NOW, { nowMs, windowDays: 0 }), 0.3)
})

test('tierOf 三档边界：.75⇒pin / .7499⇒list / .6⇒list / .5999⇒collapsed', () => {
  assert.equal(tierOf(1), 'pin')
  assert.equal(tierOf(0.75), 'pin')
  assert.equal(tierOf(0.7499), 'list')
  assert.equal(tierOf(0.6), 'list')
  assert.equal(tierOf(0.5999), 'collapsed')
  assert.equal(tierOf(0), 'collapsed')
})

// ── mergeCandidateLines（append-only 归并，唯一真源）──────────────────────────

test('merge：状态行只动 state/ts，候选行字段保留（字段级合并）', () => {
  const full = { v: 1, id: 'a1', ruleId: 'OPP-1', kind: 'tool-failure', subject: 'Bash', score: 0.5, count: 5, state: 'new' }
  const { candidates, bad } = mergeCandidateLines([
    JSON.stringify(full),
    JSON.stringify({ v: 1, id: 'a1', state: 'dismissed', ts: NOW }),
  ])
  assert.equal(bad, 0)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].state, 'dismissed')
  assert.equal(candidates[0].score, 0.5)
  assert.equal(candidates[0].count, 5)
  assert.equal(candidates[0].ts, NOW)
})

test('merge：同 id 后行覆盖先行；排序 score 降序 → id 升序', () => {
  const { candidates } = mergeCandidateLines([
    { id: 'b', score: 0.2 },
    { id: 'a', score: 0.9 },
    { id: 'b', score: 0.7 }, // 覆盖上一条 b
  ])
  assert.deepEqual(candidates.map((c) => [c.id, c.score]), [['a', 0.9], ['b', 0.7]])
})

test('merge：坏行跳过并计数（非 JSON / 无 id / 非法 state）；空白行不计坏', () => {
  const { candidates, bad } = mergeCandidateLines([
    'not json',
    '{"noid":1}',
    '{"id":"x","state":"weird"}',
    '',
    '   ',
    '{"id":"ok","score":1}',
  ])
  assert.equal(bad, 3)
  assert.deepEqual(candidates.map((c) => c.id), ['ok'])
})

test('merge：空输入 ⇒ 零候选、零坏行；state 缺省不填，不伪造', () => {
  assert.deepEqual(mergeCandidateLines([]), { candidates: [], bad: 0 })
  assert.deepEqual(mergeCandidateLines(undefined), { candidates: [], bad: 0 })
  const { candidates } = mergeCandidateLines([{ id: 'z' }])
  assert.equal('state' in candidates[0], false)
})

// ── planScanAppends（D8：不复活、防膨胀、schema 版本门）──────────────────────
// ★ 2026-10-14：用例里的 prev/mined 都带 `v: MINE_V`（**当前版本**）—— 因为新增了"版本不等即重物化"
//   这道门（见下），不带 v 的老行本来就该被重物化；这两个用例要钉的是**当前版本下的防膨胀行为**。

test('planScanAppends：新 id ⇒ 整行落，state=new', () => {
  const mined = [{ v: MINE_V, id: 'n1', count: 5, score: 0.6, state: 'new' }]
  // ★ 2026-10-18 EVO-09：行新增 `rv`（判据语义版本，与 MINE_V 是不同维度）。
  //   这里**保留 deepEqual 严格性**（多/少字段都会红），只是把新字段纳入期望 ——
  //   与 MINE_V 升级时补字段的既有做法一致，不是放宽。
  assert.deepEqual(planScanAppends(mined, new Map()), [{ v: MINE_V, rv: RULE_V, id: 'n1', count: 5, score: 0.6, state: 'new' }])
})

test('planScanAppends：已知 id 且 count/score 未变、版本相同 ⇒ 不落（防膨胀）', () => {
  const mined = [{ v: MINE_V, id: 'n1', count: 5, score: 0.6, state: 'new' }]
  assert.deepEqual(planScanAppends(mined, new Map([['n1', { v: MINE_V, id: 'n1', count: 5, score: 0.6, state: 'seen' }]])), [])
})

test('planScanAppends：已知 id 有变 ⇒ 落新行但继承最新 state（dismissed 不复活）', () => {
  const mined = [{ v: MINE_V, id: 'n1', count: 6, score: 0.7, state: 'new' }]
  const rows = planScanAppends(mined, new Map([['n1', { v: MINE_V, id: 'n1', count: 5, score: 0.6, state: 'dismissed' }]]))
  assert.deepEqual(rows, [{ v: MINE_V, rv: RULE_V, id: 'n1', count: 6, score: 0.7, state: 'dismissed' }])
})

test('planScanAppends：最新行 state 非法/缺失 ⇒ 回落 new；支持普通对象索引', () => {
  const mined = [{ v: MINE_V, id: 'n1', count: 6, score: 0.7, state: 'new' }]
  assert.equal(planScanAppends(mined, { n1: { v: MINE_V, id: 'n1', count: 5, score: 0.6, state: 'zzz' } })[0].state, 'new')
  assert.equal(planScanAppends(mined, { n1: { v: MINE_V, id: 'n1', count: 5, score: 0.6 } })[0].state, 'new')
})

// ★★ 2026-10-14 schema 版本门（**通用修复**，取代"缺什么就补什么"的逐个打补丁）：
//   candidates.jsonl 是 append-only ⇒ 老行不会自己长出新字段。此前只给 advice 补了一处特例，
//   于是之后**两次**改 metrics 形状（OPP-1 的 multiple、OPP-7 的 sessionId/tools）都对存量行**沉默无效**
//   —— 用户实测看到「会话 <机器码>：— 反复失败 N 次」就是这个（事实行的插值取不到新字段）。
//   现在：`prev.v !== MINE_V` ⇒ 重物化（保留 state）。"改变行形状 ⇒ 升 MINE_V" 成为唯一要记得的事。
test('★★ planScanAppends：**schema 版本落后** ⇒ 即使 count/score 未变、advice 已有，也重物化（拿新字段）', () => {
  const mined = [{ v: MINE_V, id: 'n1', count: 5, score: 0.6, state: 'new', metrics: { sessionId: 's1', tools: ['Grep'] }, advice: { hypoth: [], actions: [] } }]
  // 老行：v=1（上一版 schema）、有 advice、count/score 都没变 —— 旧实现会**跳过**它（正是 bug）
  const prevOld = { v: 1, id: 'n1', count: 5, score: 0.6, state: 'dismissed', advice: { hypoth: [], actions: [] } }
  const rows = planScanAppends(mined, new Map([['n1', prevOld]]))
  assert.equal(rows.length, 1, '版本落后的存量行必须被重物化（否则新字段永远到不了界面）')
  assert.equal(rows[0].v, MINE_V, '重物化后带上当前版本')
  assert.deepEqual(rows[0].metrics, { sessionId: 's1', tools: ['Grep'] }, '新字段必须到位')
  assert.equal(rows[0].state, 'dismissed', '★ 重物化仍继承最新 state（不复活：D8 不受影响）')
})

test('★ planScanAppends：缺 v（v1 时代的行）同样按落后处理 ⇒ 重物化一次', () => {
  const mined = [{ v: MINE_V, id: 'n1', count: 5, score: 0.6, state: 'new' }]
  assert.equal(planScanAppends(mined, new Map([['n1', { id: 'n1', count: 5, score: 0.6, state: 'seen' }]])).length, 1,
    '无 v 的极老行也是"版本落后"')
})

test('★ planScanAppends：版本相等后回到"未变不落"（补落只发生一次，防膨胀取舍不得回退）', () => {
  const mined = [{ v: MINE_V, id: 'n1', count: 5, score: 0.6, state: 'new' }]
  assert.deepEqual(planScanAppends(mined, new Map([['n1', { v: MINE_V, id: 'n1', count: 5, score: 0.6, state: 'seen' }]])), [],
    '重物化后 prev.v === MINE_V ⇒ 不再落（否则每轮扫描都膨胀）')
})

// ★ A1（2026-10-14）：旧行缺 advice ⇒ 必须补落一次。
//   成因：A1 之前的存量候选行没有 advice 字段，而它们往往 count/score 已稳定 ⇒ 原来的
//   "仅 count/score 有变才落" 会让这些行**永远**拿不到 advice ⇒ 用户打开面板看不到建议区
//   （正是 A1 的目标效果失效）。两条断言成对：补一次(本用例) + 补完不再落(下一条用例)。
test('★ planScanAppends：已知 id 缺 advice ⇒ 即使 count/score 未变也补落一行（否则界面永不显示建议区）', () => {
  const advice = { hypoth: [{ code: 'site-unstable', args: { multiple: '9.4' } }], actions: [{ code: 'switch-to-bash', route: 'advice' }] }
  const mined = [{ v: MINE_V, id: 'n1', count: 5, score: 0.6, state: 'new', advice }]
  const rows = planScanAppends(mined, new Map([['n1', { v: MINE_V, id: 'n1', count: 5, score: 0.6, state: 'seen' }]]))
  assert.deepEqual(rows, [{ v: MINE_V, rv: RULE_V, id: 'n1', count: 5, score: 0.6, state: 'seen', advice }],
    '缺 advice 的旧行必须补落（且继承最新 state，不复活）')
})

test('★ planScanAppends：已有 advice 且 count/score 未变 ⇒ 不落（防 JSONL 膨胀的既有取舍不得回退）', () => {
  const advice = { hypoth: [{ code: 'task-stuck' }], actions: [{ code: 'diagnose-failure', route: 'advice' }] }
  const mined = [{ v: MINE_V, id: 'n1', count: 5, score: 0.6, state: 'new', advice }]
  assert.deepEqual(
    planScanAppends(mined, new Map([['n1', { v: MINE_V, id: 'n1', count: 5, score: 0.6, state: 'seen', advice }]])), [],
    '补落只发生一次：prev 已有 advice 且版本相同 ⇒ 回到"未变不落"',
  )
})

// ── adviceOf：候选 → 建议（纯函数；code 稳定标识符，文案在前端 i18n）────────────

// ★ 字段名必须与内核实际产出的 **metrics 块** 逐字一致（用键名锚点核对，不写行号——行号易失）：
//   · OPP-1 分支的 `metrics: { ... errRate ... baselineRate ... }` 块；
//   · OPP-3 分支的 `metrics: { maxSimilarity }` 块（内核无 pairs 键）；
//   · OPP-4 分支的 `metrics: { stallHeals, errorStreakMax, worstLevel }` 块。
//   特别注意是 errRate 不是 errorRate：写错不会报错，只会让建议区永远空白。
//   注记：OPP-2 分支的 `metrics` 曾为 `{}`（`count` 只在候选行顶层），
//   其 `count` 键已由「候选行携带 advice」任务补入（`metrics: { count: a.count }`）——
//   在此之前 adviceOf('OPP-2', 候选.metrics) 恒返空（唯一带「起草修订」按钮的规则反而无说明）。

test('advice：route 枚举冻结且与设计稿一致（少一个即分派错）', () => {
  assert.deepEqual([...ADVICE_ROUTES], ['advice', 'draft:skill', 'draft:workflow', 'draft:app', 'settings', 'dev'])
  assert.ok(Object.isFrozen(ADVICE_ROUTES))
})

test('advice：OPP-1 高错误率 ⇒ 站点/用法/环境三类假设 + 三条方向（含 draft:skill）', () => {
  const a = adviceOf('OPP-1', { errRate: 0.3776, baselineRate: 0.0401, calls: 143, sessions: 6, needRate: 0.15 })
  assert.deepEqual(a.hypoth.map((h) => h.code), ['site-unstable', 'tool-abuse', 'env-issue'])
  assert.deepEqual(a.actions.map((x) => x.route), ['advice', 'draft:skill', 'settings'])
  assert.equal(a.hypoth[0].args.multiple, '9.4')
})

test('advice：OPP-1 常态错误率（<15%）⇒ 空结构（防噪声）', () => {
  assert.deepEqual(adviceOf('OPP-1', { errRate: 0.0401, baselineRate: 0.0401 }), { hypoth: [], actions: [] })
})

test('advice：baselineRate 缺失/为 0 ⇒ 不产 multiple（不除零、不臆造倍数）', () => {
  const a = adviceOf('OPP-1', { errRate: 0.5 })
  assert.deepEqual(a.hypoth[0].args, {})
})

test('★ advice 反向断言：metrics 缺失/不可解析 ⇒ 空结构（不臆造建议）', () => {
  for (const bad of [undefined, null, {}, { errRate: 'x' }, 'nope', 0]) {
    assert.deepEqual(adviceOf('OPP-1', bad), { hypoth: [], actions: [] }, `metrics=${JSON.stringify(bad)} 不得产出伪建议`)
  }
})

test('★ advice 反向断言：未知 ruleId ⇒ 空结构（不猜）', () => {
  assert.deepEqual(adviceOf('OPP-99', { errRate: 0.9 }), { hypoth: [], actions: [] })
  assert.deepEqual(adviceOf(null, { errRate: 0.9 }), { hypoth: [], actions: [] })
})

test('advice：每条已知规则的 route 都在枚举内（防止手写错字落到"无按钮"）', () => {
  const samples = {
    'OPP-1': { errRate: 0.5, baselineRate: 0.04, calls: 18, sessions: 3 },
    'OPP-2': { count: 3 },
    'OPP-3': { maxSimilarity: 0.9 },
    'OPP-4': { stallHeals: 4, errorStreakMax: 2 },
  }
  for (const [rule, m] of Object.entries(samples)) {
    const a = adviceOf(rule, m)
    assert.ok(a.actions.length > 0, `${rule} 必须有方向`)
    for (const x of a.actions) assert.ok(ADVICE_ROUTES.includes(x.route), `${rule} 的 route 非法：${x.route}`)
  }
})

test('advice：OPP-3 用 maxSimilarity（内核无 pairs 键——写错会静默返空）', () => {
  assert.ok(adviceOf('OPP-3', { maxSimilarity: 0.85 }).actions.length > 0)
  assert.deepEqual(adviceOf('OPP-3', { pairs: 3 }), { hypoth: [], actions: [] }, 'pairs 不是内核的键')
})

// ★ 反向断言：Number(null)/Number('') 都 = 0（有限）⇒ 强转会**反而产建议**，故须钉死"不可解析 ⇒ 空"

test('★ advice：OPP-3 maxSimilarity=null ⇒ 空结构（不许强转成 0 后产建议）', () => {
  assert.deepEqual(adviceOf('OPP-3', { maxSimilarity: null }), { hypoth: [], actions: [] })
})

test("★ advice：OPP-3 maxSimilarity='' ⇒ 空结构（同 null：空串不是数字）", () => {
  assert.deepEqual(adviceOf('OPP-3', { maxSimilarity: '' }), { hypoth: [], actions: [] })
})

// ── A1：候选行携带 advice（面板建议区靠它，缺失=界面开天窗）────────────────────

test('★ 候选行必须携带 advice（OPP-1）', () => {
  // ★ 夹具必须**至少两个工具**才有多倍可算：基线 = 全局错误率 = 全部错误 / 全部调用。
  //   只有 WebFetch 一个工具时，基线 = 它自己 ⇒ multiple 恒为 1.0（不自指，只是没意义）。
  //   这里：错误 9（仅 WebFetch），调用 WebFetch 18 + Bash 100 = 118 ⇒ 基线 9/118 = 0.0763
  //   ⇒ WebFetch 错误率 9/18 = 0.5 ⇒ 倍数 0.5 / 0.0763 = 6.5529… ⇒ toFixed(1) = '6.6'
  const r = rec({
    tools: {
      calls: 10,
      errors: [{ tool: 'WebFetch', count: 9, firstRef: ref('s1', 3) }],
      callsByTool: [calls('WebFetch', 18), calls('Bash', 100)],
    },
  })
  const c = mineCandidates([r], WIN).find((x) => x.ruleId === 'OPP-1')
  assert.ok(c, 'WebFetch 9/18=50% ≥15% 且 ≥5 次 ⇒ 必出候选')
  assert.ok(Array.isArray(c.advice.hypoth) && Array.isArray(c.advice.actions))
  assert.ok(c.advice.hypoth.length > 0, '高错误率候选必须带建议')
  assert.ok(ADVICE_ROUTES.includes(c.advice.actions[0].route))
  assert.equal(c.advice.hypoth[0].args.multiple, '6.6', '基线 0.0763、错误率 0.5 ⇒ 6.6 倍')
})

test('★ OPP-2 候选必须带 advice（它是唯一有「起草修订」按钮的规则，空了等于按钮旁无说明）', () => {
  // 夹具：技能 seq=12（轮序）后 ≤3 轮内出现 2 次不同纠正 ⇒ 命中 OPP-2
  const r = rec({
    sessionId: 's2', turnSeq: [10, 20, 30, 40, 50],
    skills: { loads: [{ id: 'gxtz-1', seq: 12, ts: NOW }] },
    corrections: [
      { turnRef: { sessionId: 's2', seq: 14, ts: NOW }, pattern: 'p' },
      { turnRef: { sessionId: 's2', seq: 16, ts: NOW }, pattern: 'q' },
    ],
  })
  const c = mineCandidates([r], WIN).find((x) => x.ruleId === 'OPP-2')
  assert.ok(c, '夹具须真命中 OPP-2（若未命中，请调整纠正条数而**不是**改断言）')
  assert.equal(c.metrics.count, c.count, 'metrics.count 必须与候选 count 一致（adviceOf 靠它）')
  assert.deepEqual(c.advice.actions.map((x) => x.route), ['draft:skill'])
  assert.equal(c.advice.actions[0].args.count, c.count)
})

test('★ 候选 advice 是纯派生：同输入两次挖掘 ⇒ advice 深相等（无随机、无时钟）', () => {
  const r = rec({
    tools: {
      calls: 10,
      errors: [{ tool: 'WebFetch', count: 9, firstRef: ref('s1', 3) }],
      callsByTool: [calls('WebFetch', 18), calls('Bash', 100)],
    },
  })
  const a = mineCandidates([r], WIN).find((x) => x.ruleId === 'OPP-1')
  const b = mineCandidates([r], WIN).find((x) => x.ruleId === 'OPP-1')
  assert.deepEqual(a.advice, b.advice)
})

// ── OPP-11 上下文预算（2026-10-19，第一条**非建件**规则）────────────────────────
// 背景（用户实测反馈："演进的机会除了新建技能和其他方面的几点就没有了，需要突破性进展"）：
// 既有 6 条规则的建议**全部**落在"建件"面（建技能 / 建工作流 / 改技能正文）。
// OPP-11 判的是"每轮注入的提示词过大"——它的解法在**配置面**（精简/关闭注入源），
// 因此本组断言的核心是：**它一条 draft:* 都不给**（否则"上下文太大"的解法变成"再加一个技能"）。
const ctxRec = (sid, totalBytes, bySource, turns = 10) => rec({
  sessionId: sid, turns, inject: { totalBytes, bySource },
})

test('★ OPP-11：跨 ≥2 会话的提示词预算过大 ⇒ 出候选，subject = 主导注入源', () => {
  const recs = [
    ctxRec('a', 90000, { skill: 60000, systemPrompt: 20000, knowledge: 10000 }),
    ctxRec('b', 80000, { skill: 50000, systemPrompt: 20000, knowledge: 10000 }),
  ]
  const out = mineCandidates(recs, WIN).filter((x) => x.ruleId === 'OPP-11')
  assert.equal(out.length, 1, '同一主导源 ⇒ 精确 1 条')
  assert.equal(out[0].kind, 'context-budget')
  assert.equal(out[0].subject, 'skill', 'subject = 吃字节最多的那块（这样建议才能指到具体注入源）')
  assert.equal(out[0].count, 2, 'count = 命中会话数')
  assert.equal(out[0].metrics.avgBytes, 85000, 'avgBytes = 两会话平均（事实行要用它说"约 83 KB"）')
})

test('★★ OPP-11：**不提供任何 draft:\* 方向** —— 上下文太大不可能靠"再建一个件"解决', () => {
  const recs = [
    ctxRec('a', 90000, { skill: 60000, systemPrompt: 20000 }),
    ctxRec('b', 80000, { skill: 50000, systemPrompt: 20000 }),
  ]
  const cand = mineCandidates(recs, WIN).filter((x) => x.ruleId === 'OPP-11')[0]
  const routes = cand.advice.actions.map((a) => a.route)
  assert.deepEqual(routes, ['settings', 'advice'], '只给配置面与用法面（全都不建件）')
  assert.ok(!routes.some((r) => String(r).startsWith('draft:')), '★ 一条 draft 都不许有（否则建议自相矛盾）')
  // 首条 route = settings ⇒ 前端「生成方案」按钮不会出现（supportsDraft 按首条判），这是**期望**行为
  assert.equal(routes[0], 'settings')
})

test('★ OPP-11 反向：无 inject 实测 / 会话太短 / 字节未达门 / 只有 1 个会话 ⇒ 都不出', () => {
  const run = (recs) => mineCandidates(recs, WIN).filter((x) => x.ruleId === 'OPP-11').length
  assert.equal(run([rec({ sessionId: 'a', turns: 10 }), rec({ sessionId: 'b', turns: 10 })]), 0,
    '没有 inject 实测 ⇒ 不参与（不得把"没测到"当成 0 = 很健康）')
  assert.equal(run([ctxRec('a', 90000, { skill: 90000 }, 3), ctxRec('b', 90000, { skill: 90000 }, 3)]), 0,
    '会话太短（turns < 6）⇒ 不算"持续压力"')
  assert.equal(run([ctxRec('a', 30000, { skill: 30000 }), ctxRec('b', 30000, { skill: 30000 })]), 0,
    '字节未达门 ⇒ 不出')
  assert.equal(run([ctxRec('a', 90000, { skill: 90000 })]), 0,
    '单会话 ⇒ 不出（同 OPP-7 的跨会话复现纪律：一次不算）')
})

test('★ OPP-11 确定性：bySource 并列时按名字定序（候选 id 才稳定）', () => {
  const mk = () => [
    ctxRec('a', 80000, { knowledge: 40000, skill: 40000 }),
    ctxRec('b', 80000, { knowledge: 40000, skill: 40000 }),
  ]
  const a = mineCandidates(mk(), WIN).filter((x) => x.ruleId === 'OPP-11')
  const b = mineCandidates(mk(), WIN).filter((x) => x.ruleId === 'OPP-11')
  assert.deepEqual(a.map((x) => x.id), b.map((x) => x.id), '同输入 ⇒ 同候选 id')
  assert.equal(a[0].subject, 'knowledge', '并列时按字典序取第一个（knowledge < skill）')
})

// ── OPP-12 模型维度（2026-10-19，第二条**非建件**规则）────────────────────────
// 背景（用户选择"先补 TaskRecord 的模型分段统计再出规则"）：TaskRecord 此前只有
// `usage.byModel`（token/成本），答不了"这个模型是不是更容易把活干错"。本轮先给投影器加了
// `models:[{model,calls,errors}]`（见 kernel-tests/trace-project.test.mjs 的 models 段），
// 再据此出规则。断言的核心是：**建议必须与判据同面** —— 判"模型不合适"，就不能建议建件。
const mrec = (sid, models, turns = 10) => rec({ sessionId: sid, turns, models })

test('★ OPP-12：某模型跨 ≥2 会话、调用够量、绝对错误率 ≥12% ⇒ 出候选（subject = 模型名）', () => {
  const recs = [
    mrec('a', [{ model: 'model-bad', calls: 30, errors: 6 }, { model: 'model-good', calls: 60, errors: 1 }]),
    mrec('b', [{ model: 'model-bad', calls: 20, errors: 4 }, { model: 'model-good', calls: 40, errors: 1 }]),
  ]
  const out = mineCandidates(recs, WIN).filter((x) => x.ruleId === 'OPP-12')
  assert.equal(out.length, 1, '只有 model-bad 超门（50 次调用 / 10 次失败 = 20%）')
  assert.equal(out[0].kind, 'model-mismatch')
  assert.equal(out[0].subject, 'model-bad')
  assert.equal(out[0].count, 2, 'count = 跨会话数')
  assert.equal(out[0].metrics.calls, 50)
  assert.equal(out[0].metrics.errors, 10)
  assert.equal(out[0].metrics.errRate, 0.2)
  // 基线 = 其余模型（leave-one-out）：(1+1)/(60+40) = 2% ⇒ 倍数 10
  assert.equal(out[0].metrics.baselineRate, 0.02)
  assert.equal(out[0].metrics.multiple, 10)
})

test('★★ OPP-12：**不给任何 draft:\* 方向** —— 判"模型不合适"就不能建议建件', () => {
  const recs = [
    mrec('a', [{ model: 'model-bad', calls: 30, errors: 6 }]),
    mrec('b', [{ model: 'model-bad', calls: 20, errors: 4 }]),
  ]
  const cand = mineCandidates(recs, WIN).filter((x) => x.ruleId === 'OPP-12')[0]
  const routes = cand.advice.actions.map((a) => a.route)
  assert.deepEqual(routes, ['settings', 'advice'], '只给配置面（换模型）与用法面（查参数/权限）')
  assert.ok(!routes.some((r) => String(r).startsWith('draft:')), '★ 一条 draft 都不许有（建议必须与判据同面）')
  // 首条 route = settings ⇒ 前端「生成方案」按钮不会出现（supportsDraft 按 draft:* 判），这是**期望**行为
  assert.equal(routes[0], 'settings')
  // 证据挂在带占位符的假设上（actions 调 t 不传 args）
  const mm = cand.advice.hypoth.find((h) => h.code === 'model-mismatch')
  assert.ok(mm, '必须有 model-mismatch 假设')
  assert.equal(mm.args.rate, 20, '百分数进文案（20%）')
  assert.equal(mm.args.calls, 50)
})

test('★ OPP-12 反向：调用量不足 / 单会话 / 错误率未达门 / unknown 模型 ⇒ 都不出', () => {
  const run = (recs) => mineCandidates(recs, WIN).filter((x) => x.ruleId === 'OPP-12').length
  // ① 调用量 39 < 40（错误率同样 20%）
  assert.equal(run([mrec('a', [{ model: 'm', calls: 20, errors: 4 }]), mrec('b', [{ model: 'm', calls: 19, errors: 4 }])]), 0,
    '① 样本不足 ⇒ 不出')
  // ② 单会话
  assert.equal(run([mrec('a', [{ model: 'm', calls: 100, errors: 50 }])]), 0,
    '② 单会话 ⇒ 不出（同 OPP-7/9 的跨会话复现纪律）')
  // ③ 错误率 10% < 12%
  assert.equal(run([mrec('a', [{ model: 'm', calls: 50, errors: 5 }]), mrec('b', [{ model: 'm', calls: 50, errors: 5 }])]), 0,
    '③ 未达绝对门 ⇒ 不出')
  // ④ unknown 不是可选模型（它是"条目缺 model 字段"的占位）
  assert.equal(run([mrec('a', [{ model: 'unknown', calls: 100, errors: 80 }]), mrec('b', [{ model: 'unknown', calls: 100, errors: 80 }])]), 0,
    '④ unknown 不得被当成一个"该换掉的模型"（那是采集缺口，属另一类问题）')
})

test('★ OPP-12：其余模型零错误时不给倍数（不留 Infinity / 不造基线）', () => {
  const recs = [
    mrec('a', [{ model: 'bad', calls: 30, errors: 6 }, { model: 'good', calls: 30, errors: 0 }]),
    mrec('b', [{ model: 'bad', calls: 20, errors: 4 }, { model: 'good', calls: 30, errors: 0 }]),
  ]
  const cand = mineCandidates(recs, WIN).filter((x) => x.ruleId === 'OPP-12')[0]
  assert.equal(cand.metrics.baselineRate, undefined, '其余模型零错误 ⇒ 不给 baselineRate（0 会让倍数为 Infinity）')
  assert.equal(cand.metrics.multiple, undefined, '同样不给 multiple（前端会换一条无基线的模板）')
  const mm = cand.advice.hypoth.find((h) => h.code === 'model-mismatch')
  assert.equal(mm.args.multiple, undefined, '没有倍数就不给该占位符（否则界面露出 {multiple}）')
})

test('★ OPP-12 确定性：候选 id 稳定（同输入两次逐字相等）', () => {
  const mk = () => [
    mrec('a', [{ model: 'bad', calls: 30, errors: 6 }, { model: 'good', calls: 60, errors: 1 }]),
    mrec('b', [{ model: 'bad', calls: 20, errors: 4 }]),
  ]
  const a = mineCandidates(mk(), WIN).filter((x) => x.ruleId === 'OPP-12').map((x) => x.id)
  const b = mineCandidates(mk(), WIN).filter((x) => x.ruleId === 'OPP-12').map((x) => x.id)
  assert.deepEqual(a, b)
})
