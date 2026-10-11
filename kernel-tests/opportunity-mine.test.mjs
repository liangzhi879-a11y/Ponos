// 演化 P1 机会挖掘（kernel/opportunity-mine.mjs）纯函数测试
// ---------------------------------------------------------------------------
// 设计真源：docs/superpowers/specs/2026-10-08-runtime-evolution-loop-design.md §4.3/§4.4；
// 施工 brief：docs/superpowers/plans/2026-10-09-p1-opportunity-layer.md（D2/D3/D4/D8）。
// 纪律：本文件不 spawn、不写盘——构造 TaskRecord 形状的最小夹具，逐规则钉正反例与**边界值**
// （K−1 不出、K 出；轮距 3 内命中、第 4 轮不命中；相似度 0.79 不算、0.8 算）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CANDIDATE_STATES, EVIDENCE_CAP, MINE_V, RULE_KINDS, THRESHOLDS,
  candidateIdOf, freshnessOf, mergeCandidateLines, mineCandidates, planScanAppends, scoreOf, tierOf,
} from '../kernel/opportunity-mine.mjs'

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

test('常量面：MINE_V=1 / 四规则 kind 映射 / 阈值=spec 值（K₁=5、K₂=3 轮、K₃=2）', () => {
  assert.equal(MINE_V, 1)
  assert.deepEqual(RULE_KINDS, {
    'OPP-1': 'tool-failure', 'OPP-2': 'skill-correction', 'OPP-3': 'same-task-retry', 'OPP-4': 'guard-heal',
  })
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
  assert.equal(c.v, 1)
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

// ── planScanAppends（D8：不复活、防膨胀）─────────────────────────────────────

test('planScanAppends：新 id ⇒ 整行落，state=new', () => {
  const mined = [{ id: 'n1', count: 5, score: 0.6, state: 'new' }]
  assert.deepEqual(planScanAppends(mined, new Map()), [{ id: 'n1', count: 5, score: 0.6, state: 'new' }])
})

test('planScanAppends：已知 id 且 count/score 未变 ⇒ 不落（防膨胀）', () => {
  const mined = [{ id: 'n1', count: 5, score: 0.6, state: 'new' }]
  assert.deepEqual(planScanAppends(mined, new Map([['n1', { id: 'n1', count: 5, score: 0.6, state: 'seen' }]])), [])
})

test('planScanAppends：已知 id 有变 ⇒ 落新行但继承最新 state（dismissed 不复活）', () => {
  const mined = [{ id: 'n1', count: 6, score: 0.7, state: 'new' }]
  const rows = planScanAppends(mined, new Map([['n1', { id: 'n1', count: 5, score: 0.6, state: 'dismissed' }]]))
  assert.deepEqual(rows, [{ id: 'n1', count: 6, score: 0.7, state: 'dismissed' }])
})

test('planScanAppends：最新行 state 非法/缺失 ⇒ 回落 new；支持普通对象索引', () => {
  const mined = [{ id: 'n1', count: 6, score: 0.7, state: 'new' }]
  assert.equal(planScanAppends(mined, { n1: { id: 'n1', count: 5, score: 0.6, state: 'zzz' } })[0].state, 'new')
  assert.equal(planScanAppends(mined, { n1: { id: 'n1', count: 5, score: 0.6 } })[0].state, 'new')
})
