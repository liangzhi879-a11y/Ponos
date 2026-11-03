// T4.6 子项 B（治理计划 2026-10-20-token-context-governance）：版本前后窗。
//
// 问题（问0）：一次改动（技能/工作流/策略上线）到底有没有让"每成功任务成本"变好？
// 一个全局数字答不了 —— 必须拿**改之前**与**改之后**的同类会话比。此前仓内没有任何窗口切分。
//
// 本文件钉住 7 条（前 5 条在改动前必红）：
//   ① 基本切分：< 边界归前窗，>= 边界归后窗（边界本身归后窗，不许两边都算）
//   ② 前窗取**最靠近边界**的 N 个；后窗取**最早**的 N 个（远端会话干扰大，不进来）
//   ③ 时间不可解析的记录**两侧都不进**（不猜归属），且计数如实上报
//   ④ 非法边界 ⇒ 空窗口 + reason（不静默给"两边都空"的假结论）
//   ⑤ ★ 样本 = 有成本证据且成功的会话（不是全部会话）
//   ⑥ ★ 本函数不下结论（不产 improved/regressed —— 判定唯一真源在 evolution-ledger）
//   ⑦ 空集合判红：无记录 ⇒ 两侧空、样本 0（不得造数据）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectSession, splitWindowAround, compareWindowCost } from '../kernel/trace-project.mjs'

/** 1 美元/百万 input 的固定价：断言只靠 token 数就能精确验算 */
const priceOf = () => ({ pricePerMInput: 1, pricePerMOutput: 0, cacheReadRatio: 0.1 })

/** 造一条"成功且有 usage"的会话：1M input = $1 */
function session(id, ts, usd, { withUsage = true, ok = true } = {}) {
  const blocks = ok ? [{ type: 'text', text: '完成' }] : [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }]
  const entries = [
    { type: 'assistant', timestamp: ts, message: { model: 'm', content: blocks, ...(withUsage ? { usage: { input_tokens: Math.round(usd * 1e6), output_tokens: 0 } } : {}) } },
  ]
  // ok=false ⇒ 尾轮 tool_use 无收口 ⇒ outcome='unknown'（非 ok，不进 C_success 分母）
  return projectSession(id, entries, { priceOf })
}

const B = '2026-10-10T00:00:00Z'

test('① 基本切分：< 边界归前窗，>= 边界归后窗（边界本身归后窗）', () => {
  const recs = [session('a', '2026-10-09T23:59:59Z', 1), session('b', B, 2), session('c', '2026-10-10T00:00:01Z', 3)]
  const r = splitWindowAround(recs, { boundaryIso: B })
  assert.deepEqual(r.after.map((x) => x.sessionId).sort(), ['b', 'c'], '边界时刻本身必须归后窗（否则两边都算）')
  assert.deepEqual(r.before.map((x) => x.sessionId), ['a'])
  assert.equal(r.boundary.beforeTotal, 1)
  assert.equal(r.boundary.afterTotal, 2)
})

test('★ ② 前窗取最靠近边界的 N 个；后窗取最早的 N 个（远端干扰不进来）', () => {
  const recs = [
    session('old1', '2026-10-01T00:00:00Z', 1),   // 远端：不应进前窗
    session('old2', '2026-10-02T00:00:00Z', 1),   // 远端：不应进前窗
    session('near1', '2026-10-08T00:00:00Z', 1),  // 前窗（最靠近边界）
    session('near2', '2026-10-09T00:00:00Z', 1),  // 前窗（最近）
    session('new1', '2026-10-10T00:00:00Z', 1),   // 后窗（最早）
    session('new2', '2026-10-11T00:00:00Z', 1),   // 后窗
    session('far', '2026-11-01T00:00:00Z', 1),    // 远端：不应进后窗
  ]
  const r = splitWindowAround(recs, { boundaryIso: B, beforeN: 2, afterN: 2 })
  assert.deepEqual(r.before.map((x) => x.sessionId).sort(), ['near1', 'near2'], '★ 前窗必须取最近边界的两条')
  assert.deepEqual(r.after.map((x) => x.sessionId).sort(), ['new1', 'new2'], '★ 后窗必须取紧接边界的两条')
  assert.equal(r.boundary.beforeTruncated, true, '被截断这件事必须可见')
  assert.equal(r.boundary.afterTruncated, true)
})

test('★ ③ 时间不可解析的记录两侧都不进（不猜归属），计数如实上报', () => {
  const bad = projectSession('no-ts', [{ type: 'assistant', message: { model: 'm', content: [{ type: 'text', text: 'x' }] } }], { priceOf })
  const recs = [session('a', '2026-10-09T00:00:00Z', 1), session('c', '2026-10-11T00:00:00Z', 1), bad]
  const r = splitWindowAround(recs, { boundaryIso: B })
  assert.equal(r.before.length, 1)
  assert.equal(r.after.length, 1)
  assert.equal(r.boundary.skippedNoTimestamp, 1, '★ 剔除了几条必须能看见（不静默吞）')
})

test('★ ④ 非法边界 ⇒ 空窗口 + reason（不静默给出"两边都空"的假结论）', () => {
  const recs = [session('a', '2026-10-09T00:00:00Z', 1)]
  for (const bad of ['', 'not-a-date', null, undefined]) {
    const r = splitWindowAround(recs, { boundaryIso: bad })
    assert.equal(r.before.length, 0)
    assert.equal(r.after.length, 0)
    assert.equal(r.boundary.reason, 'invalid-boundary', `边界 ${String(bad)} 必须如实报错，而不是当成"没有会话"`)
    assert.equal(r.boundary.iso, null)
  }
})

test('★ ⑤ 样本 = 有成本证据且成功的会话；但**失败会话的花费仍进分子**', () => {
  const recs = [
    // 前窗：1 条有证据且成功（$1）、1 条无证据、1 条有证据但失败（$5）
    session('b-ok', '2026-10-09T00:00:00Z', 1),
    session('b-noev', '2026-10-09T01:00:00Z', 1, { withUsage: false }),
    session('b-fail', '2026-10-09T02:00:00Z', 5, { ok: false }),
    // 后窗：2 条有证据且成功（各 $0.5）
    session('a-ok1', '2026-10-11T00:00:00Z', 0.5),
    session('a-ok2', '2026-10-11T01:00:00Z', 0.5),
  ]
  const r = compareWindowCost(recs, { boundaryIso: B, beforeN: 5, afterN: 5 })
  // 分母只数"有证据且成功"：前窗 3 条会话里只有 1 条
  assert.equal(r.base.samples, 1, '★ 前窗样本只算"有证据且成功"（3 条会话里只有 1 条）')
  assert.equal(r.cand.samples, 2)
  // ★ 分子含全部有证据的花费（含失败会话的 $5）：C_success 的语义是"得到一个成功任务
  //   平均要付多少钱"——失败烧掉的 token 也是为它付的代价。剔掉会让"失败越多显得越便宜"。
  assert.equal(r.base.costPerSuccess, 6, '★ 失败会话的 $5 **必须**进分子（1 + 5，分母 1）')
  assert.equal(r.cand.costPerSuccess, 0.5)
  // 无证据的那条两侧都不算（既不算钱也不算样本）
  assert.equal(r.windows.before.sessions, 3, '会话总数如实（含无证据与失败）')
  assert.equal(r.windows.before.okWithUsage, 1)
})

test('★ ⑥ 本函数不下结论：不产 verdict 字段（判定唯一真源在 evolution-ledger）', () => {
  const recs = [session('b', '2026-10-09T00:00:00Z', 1), session('a', '2026-10-11T00:00:00Z', 0.1)]
  const r = compareWindowCost(recs, { boundaryIso: B })
  assert.equal('verdict' in r, false, '★ 窗口层不得自己判 improved/regressed（同一套判据两处实现 = 必然分叉）')
  assert.equal('costPerSuccess' in r.base, true, '只给事实')
  assert.equal('samples' in r.base, true)
  assert.equal('quality' in r.base, true)
})

test('★ ⑦ 空集合判红：无记录 ⇒ 两侧空、样本 0、成本 null', () => {
  const r = compareWindowCost([], { boundaryIso: B })
  assert.equal(r.base.samples, 0)
  assert.equal(r.cand.samples, 0)
  assert.equal(r.base.costPerSuccess, null, '★ 空集合 ⇒ null（0 会被误读成"免费"）')
  assert.equal(r.cand.costPerSuccess, null)
  assert.equal(r.windows.before.sessions, 0)
  // 全无证据同样 null
  const noEv = compareWindowCost([session('x', '2026-10-11T00:00:00Z', 1, { withUsage: false })], { boundaryIso: B })
  assert.equal(noEv.cand.costPerSuccess, null)
  assert.equal(noEv.cand.samples, 0)
})

test('质量侧车如实带出（成本降但质量劣化时由上层否决，本层不判）', () => {
  // 造一条真正 outcome='error' 的会话：尾轮有 tool_result 且 is_error=true
  // （只发 tool_use 不收口 ⇒ outcome='unknown'，不计进 errorRate —— 既有口径，别混）
  const failing = projectSession('a-err', [
    { type: 'assistant', timestamp: '2026-10-11T03:00:00Z', message: { model: 'm', usage: { input_tokens: 200_000, output_tokens: 0 }, content: [{ type: 'tool_use', id: 't9', name: 'Bash', input: {} }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't9', content: 'boom', is_error: true }] } },
  ], { priceOf })
  assert.equal(failing.outcome, 'error', '夹具自检：这条必须真是 error（否则质量侧车断言恒绿）')
  const recs = [
    session('b1', '2026-10-09T00:00:00Z', 1), session('b2', '2026-10-09T01:00:00Z', 1),
    session('a1', '2026-10-11T00:00:00Z', 0.2), session('a2', '2026-10-11T01:00:00Z', 0.2),
    failing,
  ]
  const r = compareWindowCost(recs, { boundaryIso: B })
  assert.equal(r.base.quality.errorRate, 0)
  assert.ok(r.cand.quality.errorRate > 0, '★ 质量侧车必须如实带出（上层据此否决成本改进）')
  // 成本确实降了（0.2+0.2+0.2 的花费 / 2 个成功），但质量差了 —— 上层（evolution-ledger）会否决
  assert.ok(r.cand.costPerSuccess < r.base.costPerSuccess)
})
