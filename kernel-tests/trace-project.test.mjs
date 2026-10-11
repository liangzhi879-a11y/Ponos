// 演化 P0 观测投影器（kernel/trace-project.mjs）纯函数测试
// ---------------------------------------------------------------------------
// 设计真源：docs/superpowers/specs/2026-10-08-runtime-evolution-loop-design.md §4.1。
// 纪律：本文件不 spawn、不写盘——只构造 entry 行对象、断言 TaskRecord/汇总的精确形状。
// 每个断言都钉"派生源"（哪一行 meta/哪种块决定该字段），防回归成"看起来对"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildEvolutionReport, projectRecords, projectSession, summarizeRecords, TASK_RECORD_V } from '../kernel/trace-project.mjs'

const base = Date.parse('2026-10-01T00:00:00.000Z')
const at = (min) => new Date(base + min * 60_000).toISOString()

function entry(o, { sid = 'sess-1', project = 'proj-a', seq = null, min = 0 } = {}) {
  return { id: `e-${seq}`, seq, timestamp: at(min), sessionId: sid, project, ...o }
}
const userText = (text, seq, min) => entry({ type: 'user', message: { role: 'user', content: text }, surfaceOp: 'append' }, { seq, min })
const asst = (blocks, seq, min, model = 'model-x') => entry({ type: 'assistant', message: { role: 'assistant', content: blocks, model }, surfaceOp: 'append' }, { seq, min })
const toolResult = (toolUseId, isError, seq, min) => entry({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: isError ? 'err' : 'ok', is_error: isError }] }, surfaceOp: 'append' }, { seq, min })
const meta = (kind, extra, seq, min) => entry({ type: 'meta', kind, ...extra }, { seq, min })
const tu = (id, name, input) => ({ type: 'tool_use', id, name, input })
const text = (t) => ({ type: 'text', text: t })

// ── outcome 五态（三态不退化：每条都有证据规则，不许退化成一种）───────────────

test('outcome=error：尾轮工具结果为 is_error（最后一条 assistant 之后的 tool_result 有错）', () => {
  const list = [
    userText('做X', 1, 0),
    asst([tu('c1', 'Bash', { cmd: 'x' })], 2, 1),
    toolResult('c1', true, 3, 2),
  ]
  assert.equal(projectSession('sess-1', list).outcome, 'error')
})

test('outcome=ok：纯文本正常收束（尾条目为 text-only assistant）', () => {
  const list = [userText('问', 1, 0), asst([text('答')], 2, 1)]
  assert.equal(projectSession('sess-1', list).outcome, 'ok')
})

test('outcome=ok：尾部 meta（如轮末台账）不影响收束判定', () => {
  const list = [userText('问', 1, 0), asst([text('答')], 2, 1), meta('inject_snapshot', { totalBytes: 1 }, 3, 1)]
  assert.equal(projectSession('sess-1', list).outcome, 'ok')
})

test('outcome=unknown：成功工具结果后断流（有工具轨迹无收束，不猜 error 也不猜 ok）', () => {
  const list = [userText('做X', 1, 0), asst([tu('c1', 'Bash', {})], 2, 1), toolResult('c1', false, 3, 2)]
  assert.equal(projectSession('sess-1', list).outcome, 'unknown')
})

test('outcome=unknown：发了工具调用、结果未落盘', () => {
  const list = [userText('做X', 1, 0), asst([tu('c1', 'Bash', {})], 2, 1)]
  assert.equal(projectSession('sess-1', list).outcome, 'unknown')
})

test('outcome=unknown：用户又发言、模型未回应', () => {
  const list = [userText('问', 1, 0), asst([text('答')], 2, 1), userText('追问', 3, 2)]
  assert.equal(projectSession('sess-1', list).outcome, 'unknown')
})

test('outcome=unknown：无 assistant 条目（li<0）', () => {
  assert.equal(projectSession('sess-1', [userText('问', 1, 0)]).outcome, 'unknown')
})

test('outcome=aborted：取消证据 meta 优先（预留 kind，出现即认）', () => {
  const list = [userText('问', 1, 0), asst([text('答')], 2, 1), meta('abort', { source: 'user' }, 3, 1)]
  assert.equal(projectSession('sess-1', list).outcome, 'aborted')
})

// ── tools ───────────────────────────────────────────────────────────────────

test('tools：calls/distinct/errors 聚合，firstRef 取自首条错误结果（可回跳）', () => {
  const list = [
    userText('做X', 1, 0),
    asst([tu('c1', 'Bash', {}), tu('c2', 'Read', {})], 2, 1),
    toolResult('c1', true, 3, 2),
    toolResult('c2', false, 4, 3),
    asst([tu('c3', 'Bash', {})], 5, 4),
    toolResult('c3', true, 6, 5),
  ]
  const r = projectSession('sess-1', list)
  assert.equal(r.tools.calls, 3)
  assert.equal(r.tools.distinct, 2)
  assert.deepEqual(r.tools.errors, [{ tool: 'Bash', count: 2, firstRef: { sessionId: 'sess-1', seq: 3, ts: at(2) } }])
})

test('tools.callsByTool（2026-10-10 加）：按工具分组的调用数 = 错误率的分母', () => {
  const list = [
    userText('做X', 1, 0),
    asst([tu('c1', 'Bash', {}), tu('c2', 'Read', {})], 2, 1),
    toolResult('c1', true, 3, 2),
    toolResult('c2', false, 4, 3),
    asst([tu('c3', 'Bash', {})], 5, 4),
    toolResult('c3', true, 6, 5),
  ]
  const r = projectSession('sess-1', list)
  // 总数不变（既有字段语义零变化），新增的是**分组**视图：Bash 2 次（其中 2 次失败）、Read 1 次（0 失败）
  assert.equal(r.tools.calls, 3)
  assert.deepEqual(r.tools.callsByTool, [{ tool: 'Bash', count: 2 }, { tool: 'Read', count: 1 }])
  // 同值按工具名升序（确定性排序，便于比对与复现）
  const r2 = projectSession('sess-2', [userText('做Y', 1, 0), asst([tu('a', 'Read', {}), tu('b', 'Bash', {})], 2, 1)])
  assert.deepEqual(r2.tools.callsByTool, [{ tool: 'Bash', count: 1 }, { tool: 'Read', count: 1 }])
})

test('tools.callsByTool：无 tool_use ⇒ 空数组（不造数据）；join 不到的调用仍按实际名计数', () => {
  assert.deepEqual(projectSession('sess-3', [userText('只说话', 1, 0)]).tools.callsByTool, [])
  // tool_result 无对应 tool_use ⇒ tool_use 侧仍登记为 'unknown'（分子分母同源，均由 tool_use 决定）
  const r = projectSession('sess-4', [userText('做Z', 1, 0), toolResult('ghost', true, 2, 1)])
  assert.deepEqual(r.tools.callsByTool, [])
})

test('tools.errors：join 不到 tool_use 的结果落 unknown（不伪造工具名）', () => {
  const list = [userText('做X', 1, 0), toolResult('ghost-id', true, 2, 1)]
  const r = projectSession('sess-1', list)
  assert.equal(r.tools.errors.length, 1)
  assert.equal(r.tools.errors[0].tool, 'unknown')
  assert.equal(r.tools.errors[0].count, 1)
})

// ── approvals（P-b）─────────────────────────────────────────────────────────

test('approvals：approval_decision meta 聚合（allow/deny；timeout/cancel 数不出=0）', () => {
  const list = [
    userText('做X', 1, 0),
    meta('approval_decision', { toolUseId: 'c1', behavior: 'allow' }, 2, 1),
    meta('approval_decision', { toolUseId: 'c2', behavior: 'deny' }, 3, 2),
    meta('approval_decision', { toolUseId: 'c3', behavior: 'deny' }, 4, 3),
    meta('approval_mode', { value: 'manual' }, 5, 4),
  ]
  const r = projectSession('sess-1', list)
  assert.deepEqual(r.approvals, { asked: 3, allowed: 1, denied: 2, timeout: 0 })
})

// ── corrections（fidelity 单一真源）─────────────────────────────────────────

test('corrections：真用户文本命中强信号；系统注入/工具结果/普通文本不计', () => {
  const list = [
    userText('我明明说过要用 A 方案', 1, 0),
    userText('【系统】检测到上一轮存在失败/被取消的工具调用，任务尚未完成。', 2, 1),
    toolResult('c1', true, 3, 2),
    userText('普通消息', 4, 3),
    userText('不做了', 5, 4),
  ]
  const r = projectSession('sess-1', list)
  assert.equal(r.corrections.length, 1)
  assert.equal(r.corrections[0].turnRef.seq, 1)
  assert.ok(typeof r.corrections[0].pattern === 'string' && r.corrections[0].pattern.length > 0, 'pattern 为命中的正则源（可溯源）')
})

test('nearRepeatPairs：相邻真用户文本 4-gram 相似（0.8 边界样例）；只落 seq+分值不落文本', () => {
  const a = '帮我修复登录页面的按钮点击问题，点了没有反应'
  const b = '帮我修复登录页面的按钮点击问题，点了没有响应'
  const r = projectSession('sess-1', [userText(a, 1, 0), asst([text('好')], 2, 1), userText(b, 3, 2)])
  assert.equal(r.nearRepeatPairs.length, 1)
  assert.deepEqual(r.nearRepeatPairs[0], { firstSeq: 1, secondSeq: 3, similarity: 0.8 })
  // 隐私判据（可证伪）：pair 只有三个数值/序号键，任一键为字符串正文即红
  assert.deepEqual(Object.keys(r.nearRepeatPairs[0]).sort(), ['firstSeq', 'secondSeq', 'similarity'])
})

test('nearRepeatPairs：系统注入不算"用户相邻"；短文本判 0（防小 gram 集假高相似）', () => {
  const a = '把报表按月份汇总一下顺便导出 CSV 文件'
  const b = '把报表按月份汇总一下顺便导出 CSV 文档'
  // 两次真用户发言之间夹一条系统注入 ⇒ 真用户序列仍相邻（注入不是用户轮）
  const r = projectSession('sess-1', [
    userText(a, 1, 0),
    userText('【系统】任务尚未完成。', 2, 1),
    userText(b, 3, 2),
  ])
  assert.deepEqual(r.nearRepeatPairs.map((p) => [p.firstSeq, p.secondSeq]), [[1, 3]])
  assert.ok(r.nearRepeatPairs[0].similarity >= 0.8, `近重复应高分（实际 ${r.nearRepeatPairs[0].similarity}）`)
  // 短消息：两侧归一化长度 <8 ⇒ 0（'继续推进' 4 字仅 1 个 gram，相同也不判近重复）
  const short = projectSession('sess-1', [userText('继续推进', 1, 0), userText('继续推进', 2, 1)])
  assert.deepEqual(short.nearRepeatPairs, [{ firstSeq: 1, secondSeq: 2, similarity: 0 }])
})

// ── skills（loaded=确凿成功；triggerHits=P-c）────────────────────────────────

test('skills：仅确凿成功的 Skill 调用计 loaded；失败/无结果不计；triggerHits 来自 meta', () => {
  const list = [
    userText('做X', 1, 0),
    asst([tu('k1', 'Skill', { skill: 'sum-x' })], 2, 1),
    toolResult('k1', false, 3, 2),
    asst([tu('k2', 'Skill', { skill: 'missing' })], 4, 3),
    toolResult('k2', true, 5, 4),
    asst([tu('k3', 'Skill', { skill: 'cut' })], 6, 5),
    meta('skill_trigger_hit', { id: 'sum-x' }, 7, 6),
    meta('skill_trigger_hit', { id: 'sum-x' }, 8, 7),
  ]
  const r = projectSession('sess-1', list)
  assert.deepEqual(r.skills.loaded, [{ id: 'sum-x', count: 1 }])
  assert.deepEqual(r.skills.triggerHits, [{ id: 'sum-x', count: 2 }])
  // P1 loads：只记确凿成功的加载，带加载条目 {seq,ts}（k2 失败/k3 无结果不入）
  assert.deepEqual(r.skills.loads, [{ id: 'sum-x', seq: 2, ts: at(1) }])
})

// ── loop / inject / guard / 血缘 ─────────────────────────────────────────────

test('loop：modes 去连续重复；escalations = 生效模式变更次数', () => {
  const list = [
    meta('loop_mode', { value: 'plan', selected: 'plan', effective: 'plan' }, 1, 0),
    meta('loop_mode', { value: 'plan', selected: 'plan', effective: 'plan' }, 2, 1),
    meta('loop_mode', { value: 'reflect', selected: 'reflect', effective: 'reflect' }, 3, 2),
    meta('loop_mode', { value: 'auto', selected: 'auto' }, 4, 3),
  ]
  const r = projectSession('sess-1', list)
  assert.deepEqual(r.loop, { modes: ['plan', 'reflect', 'auto'], escalations: 2 })
  assert.equal(r.mode, 'auto', 'mode 取末条生效值')
})

test('inject：取末条 inject_snapshot 的当前态（非跨轮求和）', () => {
  const list = [
    meta('inject_snapshot', { totalBytes: 10, bySource: { skill: 1 } }, 1, 0),
    meta('inject_snapshot', { totalBytes: 100, bySource: { skill: 20, systemPrompt: 80 } }, 2, 1),
  ]
  const r = projectSession('sess-1', list)
  assert.deepEqual(r.inject, { totalBytes: 100, bySource: { skill: 20, systemPrompt: 80 } })
})

test('guard：P-a metas 取峰值（level 字面级名经 HEAL_LEVELS 转序数）；无记录 = null（不造 0 假）', () => {
  const list = [
    meta('guard_turn', { turnIndex: 1, level: 'L1', stallHeals: 2, errorStreak: 0, repeatStreak: 1, iterCapHit: false, loopStopReason: null }, 1, 0),
    meta('guard_turn', { turnIndex: 2, level: 'L3', stallHeals: 0, errorStreak: 5, repeatStreak: 2, iterCapHit: true, loopStopReason: 'iteration-cap' }, 2, 1),
    meta('guard_turn', { turnIndex: 3, level: null, stallHeals: 0, errorStreak: 0, repeatStreak: 0, iterCapHit: false, loopStopReason: null }, 3, 2),
  ]
  assert.deepEqual(projectSession('sess-1', list).guard,
    { worstLevel: 3, stallHeals: 2, errorStreakMax: 5, repeatStreakMax: 2, firstRef: { sessionId: 'sess-1', seq: 1, ts: at(0) } })
  assert.equal(projectSession('sess-1', [userText('问', 1, 0)]).guard, null)
})

test('血缘：subtask_meta ⇒ subagent + parentTaskId；缺失 ⇒ main/null', () => {
  const sub = [meta('subtask_meta', { parentTaskId: 'p1', depth: 0, path: ['p1', 't1'] }, 1, 0), userText('子任务', 2, 1)]
  const r1 = projectSession('lane-1', sub)
  assert.equal(r1.kind, 'subagent')
  assert.equal(r1.parentTaskId, 'p1')
  const r2 = projectSession('sess-1', [userText('问', 1, 0)])
  assert.equal(r2.kind, 'main')
  assert.equal(r2.parentTaskId, null)
})

test('turns：优先 inject_snapshot 条数；无台账退化 = assistant 条目数（compaction 不计）', () => {
  const withSnap = [
    meta('inject_snapshot', { totalBytes: 1 }, 1, 0),
    asst([text('a')], 2, 1),
    meta('inject_snapshot', { totalBytes: 1 }, 3, 2),
  ]
  assert.equal(projectSession('sess-1', withSnap).turns, 2)
  // P1 turnSeq：轮界条目 seq 列表（升序），供 OPP-2 轮距换算
  assert.deepEqual(projectSession('sess-1', withSnap).turnSeq, [1, 3])
  const noSnap = [
    asst([text('a')], 1, 0),
    asst([text('b')], 2, 1),
    { ...asst([text('c')], 3, 2), kind: 'compaction' },
  ]
  assert.equal(projectSession('sess-1', noSnap).turns, 2)
  assert.deepEqual(projectSession('sess-1', noSnap).turnSeq, [], '无台账 ⇒ turnSeq 空（轮距不可算）')
})

test('model：取末条非 compaction assistant 的 model', () => {
  const list = [
    asst([text('a')], 1, 0, 'm1'),
    asst([text('b')], 2, 1, 'm2'),
    { ...asst([text('c')], 3, 2, 'compaction-model'), kind: 'compaction' },
  ]
  assert.equal(projectSession('sess-1', list).model, 'm2')
})

// ── projectRecords 分组与确定性 ──────────────────────────────────────────────

test('projectRecords：按 sessionId 分组；排序确定（startedAt → sessionId）', () => {
  const list = [
    entry({ type: 'user', message: { role: 'user', content: 'b1' } }, { sid: 'sess-b', seq: 1, min: 5 }),
    entry({ type: 'assistant', message: { role: 'assistant', content: [text('a1')], model: 'm' } }, { sid: 'sess-a', seq: 1, min: 0 }),
    entry({ type: 'user', message: { role: 'user', content: 'b2' } }, { sid: 'sess-b', seq: 2, min: 6 }),
    entry({ type: 'assistant', message: { role: 'assistant', content: [text('a2')], model: 'm' } }, { sid: 'sess-a', seq: 2, min: 1 }),
  ]
  const records = projectRecords(list)
  assert.equal(records.length, 2)
  assert.deepEqual(records.map((r) => r.sessionId), ['sess-a', 'sess-b'])
  assert.equal(records[0].turns, 2, '同会话条目聚合完整')
})

// ── summarizeRecords（基线数字）─────────────────────────────────────────────

test('summarize：失败热点/技能命中/纠正率聚合；空集合 = 精确 0', () => {
  const r1 = projectSession('sess-1', [
    userText('我明明说过', 1, 0),
    asst([tu('c1', 'Bash', {}), tu('k1', 'Skill', { skill: 'sum-x' })], 2, 1),
    toolResult('c1', true, 3, 2),
    toolResult('k1', false, 4, 3),
    toolResult('c1', true, 5, 4),
    meta('inject_snapshot', { totalBytes: 50, bySource: { skill: 30 } }, 6, 5),
    meta('guard_turn', { turnIndex: 1, level: 'L2', stallHeals: 3, errorStreak: 0, repeatStreak: 0 }, 7, 6),
  ])
  const r2 = projectSession('sess-2', [
    userText('做Y', 1, 0),
    asst([tu('c9', 'Read', {})], 2, 1),
    toolResult('c9', true, 3, 2),
    meta('inject_snapshot', { totalBytes: 20, bySource: { skill: 10 } }, 4, 3),
  ])
  const s = summarizeRecords([r1, r2], { window: { from: '2026-09-01', to: '2026-10-01', days: 30 } })
  assert.equal(s.totals.sessions, 2)
  assert.equal(s.totals.main, 2)
  assert.deepEqual(s.failures.map((f) => [f.tool, f.count, f.sessions]), [['Bash', 2, 1], ['Read', 1, 1]])
  assert.equal(s.failures[0].firstRef.sessionId, 'sess-1')
  assert.deepEqual(s.skills, [{ id: 'sum-x', loaded: 1, triggerHits: 0 }])
  assert.equal(s.correctionsTotal, 1)
  assert.equal(s.correctionsRate, 0.5)
  assert.equal(s.inject.totalBytes, 70)
  assert.deepEqual(s.inject.bySource, { skill: 40 })
  assert.deepEqual(s.guard, { sessionsWithHeals: 1, stallHealsTotal: 3, worstLevelMax: 2 })
  assert.deepEqual(s.window, { from: '2026-09-01', to: '2026-10-01', days: 30 })

  const s0 = summarizeRecords([], { window: { days: 30 } })
  assert.equal(s0.totals.sessions, 0)
  assert.deepEqual(s0.failures, [])
  assert.deepEqual(s0.skills, [])
  assert.equal(s0.correctionsTotal, 0)
  assert.equal(s0.correctionsRate, 0, '空集合判红面：分母 0 不许 NaN')
  assert.equal(s0.inject.totalBytes, 0)
})

test('buildEvolutionReport：v/generatedAt/window/records/summary 齐全', () => {
  const list = [entry({ type: 'user', message: { role: 'user', content: '问' } }, { seq: 1, min: 0 })]
  const rep = buildEvolutionReport(list, { window: { from: '2026-09-01', to: '2026-10-01', days: 30 }, now: '2026-10-01T00:00:00.000Z' })
  assert.equal(rep.v, TASK_RECORD_V)
  assert.equal(rep.generatedAt, '2026-10-01T00:00:00.000Z')
  assert.deepEqual(rep.window, { from: '2026-09-01', to: '2026-10-01', days: 30 })
  assert.equal(rep.records.length, 1)
  assert.equal(rep.summary.totals.sessions, 1)
  assert.equal(rep.records[0].v, TASK_RECORD_V)
})
