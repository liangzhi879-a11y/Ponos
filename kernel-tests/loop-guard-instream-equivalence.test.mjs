// Task 3 等价锁：inStream 相位（①b 流内墙钟 / ③ 生成重复 / ③b 近重复）
// ---------------------------------------------------------------------------
// 与 iterHead 的等价锁（loop-guard-order-equivalence.test.mjs）同构，**独立成文件**的原因：
// 迭代头有注入与事件（`guard_heal`），后果面宽，值得用 harness + golden 规范化；
// inStream 三个守卫**都不注入、都不发事件**（①b/③/③b 命中即中断流，注入记在 repeatHeal），
// 运行时后果只有 `stop` + 命中登记 ⇒ 直接断言更贴近事实，也更不容易被"规范化"抹平。
//
// 覆盖三件事：
//   ① 守卫序（profile 驱动）
//   ② 运行时行为（命中/reason/阈值门控/已停跳过/不注入）
//   ③ 源级等价（HEAD 搬移前块的文案逐字保留）+ 接线（engine 不再内联）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { MAIN_PROFILE, LANE_PROFILE, resolveGuards } from '../kernel/loop-profile.mjs'
import { runInStreamGuards } from '../kernel/loop-core.mjs'
import { createNearRepeatDetector } from '../kernel/gen-guards.mjs'

/** 造 ctx：与 engine 接线同构 —— ★ profile 必带（自造 ctx 会漏 profile ⇒ 驱动器按空守卫序抛错） */
function mkCtx() {
  const hits = []
  const injections = []
  let aborted = 0
  return {
    hits, injections,
    get aborted() { return aborted },
    ctx: { profile: MAIN_PROFILE, turnGuardHits: hits, pushInjection: (t) => injections.push(t), abort: () => { aborted++ } },
  }
}

/** inStream 的基准 state（各场景只覆盖需要的字段） */
function baseState(over = {}) {
  return { TURN_TIMEOUT_MS: 0, turnT0: Date.now(), genWindow: '', nearRep: null, chunk: { type: 'text', text: '' }, loopStop: null, ...over }
}

// ── ① 守卫序 ────────────────────────────────────────────────────────────────

test('Task3 · 守卫序：inStream = streamWallClock → genRepeat → nearRepeat（profile 驱动）', () => {
  assert.deepEqual(resolveGuards(MAIN_PROFILE, 'inStream'), ['streamWallClock', 'genRepeat', 'nearRepeat'])
  assert.deepEqual(resolveGuards(LANE_PROFILE, 'inStream'), ['streamWallClock', 'genRepeat', 'nearRepeat'],
    'lane 与 main 的 inStream 守卫集必须相同（差异只在 compactor/health/inject/stop）')
})

test('Task3 · 分工修正：idleWatchdog/upstreamDead 归 afterStream（执行时机在 catch）', () => {
  // 这两个的**命中判定**源于流内，但**处理时机在 catch 块**（流抛错后按错误分类处理）
  // ⇒ 按执行时机归"流后"。留在 inStream 会诱导实现者去"每块检查"，而它们本来每块都不检查。
  assert.ok(!resolveGuards(MAIN_PROFILE, 'inStream').includes('idleWatchdog'))
  assert.ok(!resolveGuards(MAIN_PROFILE, 'inStream').includes('upstreamDead'))
  assert.ok(resolveGuards(MAIN_PROFILE, 'afterStream').includes('idleWatchdog'))
  assert.ok(resolveGuards(MAIN_PROFILE, 'afterStream').includes('upstreamDead'))
})

// ── ② 运行时行为 ────────────────────────────────────────────────────────────

test('Task3 · ①b 命中：stop.reason=timeout + 中断流 + 命中登记', async () => {
  const h = mkCtx()
  const r = await runInStreamGuards(baseState({ TURN_TIMEOUT_MS: 60000, turnT0: Date.now() - 70000 }), h.ctx)
  assert.equal(r.stop?.reason, 'timeout')
  assert.deepEqual(h.hits, ['streamWallClock'])
  assert.equal(h.aborted, 1, '命中即中断当前流（不再消费后续块）')
})

test('Task3 · ①b 阈值门控：TURN_TIMEOUT_MS=0 ⇒ 关闭（不命中、不中断）——默认关闭语义', async () => {
  const h = mkCtx()
  const r = await runInStreamGuards(baseState({ TURN_TIMEOUT_MS: 0, turnT0: Date.now() - 999999 }), h.ctx)
  assert.equal(r.stop, null)
  assert.deepEqual(h.hits, [])
  assert.equal(h.aborted, 0)
})

test('Task3 · ③ 命中：stop.reason=gen-repeat（genWindow 满 60 字符才可能触发）', async () => {
  const h = mkCtx()
  const r = await runInStreamGuards(baseState({ genWindow: 'x'.repeat(75) }), h.ctx)
  assert.equal(r.stop?.reason, 'gen-repeat')
  assert.deepEqual(h.hits, ['genRepeat'])
  assert.equal(h.aborted, 1)
})

test('Task3 · ③ 短输出不受影响（genWindow 不足阈值 ⇒ 不命中）', async () => {
  const h = mkCtx()
  const r = await runInStreamGuards(baseState({ genWindow: '短输出' }), h.ctx)
  assert.equal(r.stop, null)
  assert.deepEqual(h.hits, [])
})

test('Task3 · ③b 命中：stop.reason=near-repeat（句指纹池触发）', async () => {
  const h = mkCtx()
  // 用真检测器 + 宽松参数让重复句快速触发（算法细节有自己的测试，此处只验接线与后果）
  const nearRep = createNearRepeatDetector({ recent: 3, avg: 0.5, sim: 0.5, minChars: 6 })
  const sentence = '这是一句会被反复重述的测试句子。'
  let r = null
  for (let i = 0; i < 6 && !r?.stop; i++) {
    r = await runInStreamGuards(baseState({ nearRep, chunk: { type: 'text', text: sentence } }), h.ctx)
  }
  assert.equal(r?.stop?.reason, 'near-repeat', '重复句最终应触发 ③b')
  assert.ok(h.hits.includes('nearRepeat'))
  assert.equal(h.aborted, 1)
})

test('Task3 · ③b 块类型门控：非 text/thinking 块不喂池', async () => {
  const h = mkCtx()
  const nearRep = createNearRepeatDetector({ recent: 3, avg: 0.5, sim: 0.5, minChars: 6 })
  const r = await runInStreamGuards(baseState({ nearRep, chunk: { type: 'tool_use', text: 'x'.repeat(100) } }), h.ctx)
  assert.equal(r.stop, null)
  assert.deepEqual(h.hits, [])
})

test('Task3 · 已停跳过：loopStop 非空 ⇒ 三个守卫一律跳过（原 `!loopStop &&` 前置的等价物）', async () => {
  const h = mkCtx()
  // 三个条件**都满足命中**，但 loopStop 已置 ⇒ 一个都不许再命中/再中断
  const nearRep = createNearRepeatDetector({ recent: 3, avg: 0.5, sim: 0.5, minChars: 6 })
  const r = await runInStreamGuards(
    baseState({ TURN_TIMEOUT_MS: 60000, turnT0: Date.now() - 70000, genWindow: 'x'.repeat(75), nearRep, loopStop: { reason: 'stall' } }),
    h.ctx,
  )
  assert.equal(r.stop, null, '已停后不得产生新 stop')
  assert.deepEqual(h.hits, [], '已停后不得再登记命中（省了这层会在已停后重复 push + 重复 abort）')
  assert.equal(h.aborted, 0)
})

test('Task3 · 本相位不注入（①b/③/③b 命中都不调 emitInjection）', async () => {
  const h = mkCtx()
  await runInStreamGuards(baseState({ TURN_TIMEOUT_MS: 60000, turnT0: Date.now() - 70000 }), h.ctx)
  assert.deepEqual(h.injections, [], '①b/③/③b 都无注入（注入记在 repeatHeal 的 afterStream 相位）')
})

// ── ③ 源级等价 + 接线 ───────────────────────────────────────────────────────

test('Task3 · 源级等价：HEAD 搬移前块的文案逐字保留在 loop-core.mjs', () => {
  const old = execFileSync('git', ['show', 'HEAD:kernel/engine.mjs'], { encoding: 'utf8' })
  const core = readFileSync(new URL('../kernel/loop-core.mjs', import.meta.url), 'utf8')
  // 基线选取自检 + 搬移后文案逐字比对（改文案 = 改用户可见说明，必须是有意为之）
  const needles = ['已达单轮时长上限', '为防止挂起已自动收尾', '重复打转', '近似内容反复打转', '措辞微变重复重述']
  for (const n of needles) {
    assert.ok(old.includes(n), `HEAD 基线应含「${n}」——否则基线选错，本断言失去意义`)
    assert.ok(core.includes(n), `搬移后必须逐字保留：「${n}」`)
  }
})

test('Task3 · 接线：engine 调用契约入口，且不再内联命中登记', () => {
  const src = readFileSync(new URL('../kernel/engine.mjs', import.meta.url), 'utf8')
  assert.ok(src.includes('runInStreamGuards('), '主 loop 必须调用契约入口 runInStreamGuards')
  assert.ok(!/turnGuardHits\.push\('(streamWallClock|genRepeat|nearRepeat)'\)/.test(src),
    '不得继续内联这三个命中登记（搬移后应只由 loop-core 守卫体登记）')
  assert.ok(src.includes("from './loop-core.mjs'"), '须从 loop-core 导入')
})
