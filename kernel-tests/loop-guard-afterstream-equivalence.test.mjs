// Task 4 等价锁：afterStream 相位（timing 门控 + 三站点 + action 语义）
// ---------------------------------------------------------------------------
// 与 inStream 锁（loop-guard-instream-equivalence.test.mjs）同构，覆盖三件事：
//   ① 守卫序与 timing 门控（profile 驱动；三站点各调一次，守卫只在自己那一刻生效）
//   ② 运行时行为与 `action` 语义（continue/break 是搬移前宿主控制流的等价物）
//   ③ 源级等价（基线钉死 SHA）+ 接线（engine 不再内联这 6 个守卫的命中登记与文案）
//
// 为什么本相位**最需要**等价锁：afterStream 的 6 个守卫散布在三个不相邻的宿主时机
// （流后·工具前 / 工具后 / catch 块），且其中 3 个带 `action`（continue 或 break）——
// "搬运时漏掉一个 `continue`" 这类错误在单元层面看不出来，只有等价锁能钉住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { MAIN_PROFILE, resolveGuards } from '../kernel/loop-profile.mjs'
import { runAfterStreamGuards } from '../kernel/loop-core.mjs'
import {
  hasMeltdownBudget, errorMeltdownText, isRealProgress, batchToolKey,
  shouldRemindRepeat, repeatRemindText,
} from '../kernel/guards.mjs'
import { canonicalToolCallKey } from '../kernel/gen-guards.mjs'
import { REPEAT_REMIND_AT } from '../kernel/engine-config.mjs'

/** 与 engine 接线同构的 ctx（★ 必须复用同一套形状：自造 ctx 会漏字段） */
function mkCtx() {
  const hits = []; const injections = []; const events = []
  return {
    hits, injections, events,
    ctx: {
      profile: MAIN_PROFILE,
      turnGuardHits: hits,
      turnGuardInjections: { bump() {} },
      pushInjection: (t) => injections.push(t),
      onGuardInject: (o) => { if (o?.event) events.push(o.event) },
    },
  }
}

/** postTools 站点的公共 state（各用例只覆盖关心的字段） */
function postToolsState(over = {}) {
  return {
    timing: 'postTools', loopStop: null, madeProgress: false,
    blocks: [], toolResults: [],
    REPEAT_REMIND_AT, batchToolKey, canonicalToolCallKey, shouldRemindRepeat, repeatRemindText,
    repeatStreak: 0, lastToolKey: null, remindedAt: new Set(),
    MAX_ERROR_ITERATIONS: 3, errorStreak: 0, MELTDOWN_HEAL_MAX: 1, meltdownHeals: 0,
    hasMeltdownBudget, errorMeltdownText, textBuf: '',
    ...over,
  }
}

// ── ① 守卫序与 timing 门控 ────────────────────────────────────────────────

test('Task4 · 守卫序 = 真实执行顺序（repeatHeal → progressRefresh → repeatReminder → meltdown → idleWatchdog → upstreamDead）', () => {
  assert.deepEqual(resolveGuards(MAIN_PROFILE, 'afterStream'),
    ['repeatHeal', 'progressRefresh', 'repeatReminder', 'meltdown', 'idleWatchdog', 'upstreamDead'])
})

test('Task4 · ★ timing 门控：postTools 站点不得触发 postStream/onError 的守卫', async () => {
  const h = mkCtx()
  // 同时满足 repeatHeal 与 idleWatchdog 的命中条件，但 timing=postTools ⇒ 两者都必须跳过
  const r = await runAfterStreamGuards(postToolsState({
    loopStop: { reason: 'gen-repeat' }, REPEAT_HEAL_MAX: -1, repeatHeals: 0,
    watchdogTripped: true, attemptData: null, idleDeadRetries: 0, IDLE_DEAD_RETRY_MAX: 1,
  }), h.ctx)
  assert.ok(!h.hits.includes('repeatHeal'), 'postStream 的守卫不得在 postTools 站点生效')
  assert.ok(!h.hits.includes('idleWatchdog'), 'onError 的守卫不得在 postTools 站点生效')
  assert.equal(r.action, null, '不得产生 action（否则宿主会跳迭代）')
})

test('Task4 · ★ timing 缺省 = 全放行（便于直接单测守卫体）', async () => {
  const h = mkCtx()
  const r = await runAfterStreamGuards(postToolsState({
    timing: undefined, errorStreak: 3, MAX_ERROR_ITERATIONS: 3,
  }), h.ctx)
  assert.ok(h.hits.includes('meltdown'), 'timing 缺省时守卫应生效（无门控）')
  assert.equal(r.action, 'continue')
})

// ── ② 运行时行为与 action 语义 ───────────────────────────────────────────

test('Task4 · repeatHeal：清 loopStop + textBuf、注入、事件、action=continue', async () => {
  const h = mkCtx()
  const r = await runAfterStreamGuards({
    timing: 'postStream', loopStop: { reason: 'gen-repeat' }, REPEAT_HEAL_MAX: -1, repeatHeals: 0, textBuf: '退化内容',
  }, h.ctx)
  assert.deepEqual(h.hits, ['repeatHeal'])
  assert.equal(r.action, 'continue')
  assert.equal(r.state.loopStop, null, '★ 必须清空 loopStop —— 只返回 stop 不清空会误收尾')
  assert.equal(r.state.textBuf, '', '退化内容不落模型输入')
  assert.equal(r.state.repeatHeals, 1)
  assert.equal(r.state.healedLastIter, true)
  assert.equal(h.injections.length, 1)
  assert.equal(h.events[0]?.payload?.reason, 'gen-repeat')
  assert.equal(h.events[0]?.payload?.max, -1)
})

test('Task4 · repeatHeal 上限耗尽 ⇒ 不 action（交宿主收尾，不得无限自愈）', async () => {
  const h = mkCtx()
  const r = await runAfterStreamGuards({
    timing: 'postStream', loopStop: { reason: 'gen-repeat' }, REPEAT_HEAL_MAX: 2, repeatHeals: 2, textBuf: '',
  }, h.ctx)
  assert.equal(r.action, null)
  assert.deepEqual(h.hits, [])
})

test('Task4 · repeatHeal 只对 gen-repeat/near-repeat 生效（其它 reason 不自愈）', async () => {
  const h = mkCtx()
  for (const reason of ['timeout', 'stall', 'error-meltdown', 'idle']) {
    const r = await runAfterStreamGuards({
      timing: 'postStream', loopStop: { reason }, REPEAT_HEAL_MAX: -1, repeatHeals: 0, textBuf: '',
    }, h.ctx)
    assert.equal(r.action, null, `reason=${reason} 不应触发重复自愈`)
  }
  assert.deepEqual(h.hits, [])
})

test('Task4 · progressRefresh：纯状态更新（无 stop/action/注入/命中）', async () => {
  const h = mkCtx()
  const r = await runAfterStreamGuards(postToolsState({ madeProgress: true }), h.ctx)
  assert.ok(r.state.lastProgressAt > 0, '恢复进展应刷新时间戳')
  assert.equal(r.state.stallHeals, 0, '恢复进展应清零停滞愈合计数')
  assert.equal(r.stop, null); assert.equal(r.action, null)
  assert.deepEqual(h.hits, []); assert.deepEqual(h.injections, [])
})

test('Task4 · repeatReminder：到阈值才提醒（仅提醒不否决，无 stop）', async () => {
  const h = mkCtx()
  const blocks = [{ name: 'Bash', input: { command: 'ls' } }]
  let st = postToolsState({ blocks })
  let r = null
  // 首轮建立链键（streak=1），后续同键累加，到 REPEAT_REMIND_AT 首个阈值触发
  for (let i = 0; i < REPEAT_REMIND_AT[0] + 1; i++) {
    r = await runAfterStreamGuards(st, h.ctx)
    st = { ...r.state, timing: 'postTools' }
  }
  assert.ok(h.hits.includes('repeatReminder'), `连续同工具到 ${REPEAT_REMIND_AT[0]} 次应提醒`)
  assert.equal(h.injections.length >= 1, true)
  assert.equal(r.stop, null, '⑤ 只提醒不否决（硬性由迭代上限兜底）')
})

test('Task4 · meltdown 自愈：errorStreak 归零重开预算 + action=continue', async () => {
  const h = mkCtx()
  const r = await runAfterStreamGuards(postToolsState({ errorStreak: 3, MELTDOWN_HEAL_MAX: 1 }), h.ctx)
  assert.equal(r.action, 'continue')
  assert.equal(r.state.meltdownHeals, 1)
  assert.equal(r.state.errorStreak, 0, '★ 自愈后重开失败预算（否则下一轮立刻又被熔断）')
  assert.equal(h.events[0]?.payload?.reason, 'error-meltdown')
})

test('Task4 · meltdown 硬停：预算耗尽 ⇒ stop + action=break', async () => {
  const h = mkCtx()
  const r = await runAfterStreamGuards(postToolsState({ errorStreak: 3, MELTDOWN_HEAL_MAX: 1, meltdownHeals: 1 }), h.ctx)
  assert.equal(r.stop?.reason, 'error-meltdown')
  assert.equal(r.action, 'break', '★ 硬停必须 break（只 stop 不 break 会继续跑工具）')
  assert.ok(r.stop.message.includes('全部失败'))
})

test('Task4 · idleWatchdog 三态：零产出重试 / 已产出自愈 / 硬停', async () => {
  const base = {
    timing: 'onErrorIdle', watchdogTripped: true, loopStop: null,
    IDLE_DEAD_RETRY_MAX: 1, IDLE_DEAD_RETRY_BACKOFF_MS: 1,
    IDLE_HEAL_MAX: 1, STREAM_IDLE_MS: 60000, STREAM_FIRST_BYTE_MS: 30000,
  }
  // 态一：零产出 + 有重试预算
  const h1 = mkCtx()
  const r1 = await runAfterStreamGuards({ ...base, attemptData: null, idleDeadRetries: 0, idleHeals: 0, textBuf: '' }, h1.ctx)
  assert.equal(r1.action, 'continue'); assert.equal(r1.signal, 'idle-dead-retry')
  assert.equal(r1.backoffMs, 1); assert.equal(r1.state.idleDeadRetries, 1)
  // 态二：已产出 + 有自愈预算（★ 必须把原文交回宿主落库，否则续写丢上下文）
  const h2 = mkCtx()
  const r2 = await runAfterStreamGuards({ ...base, attemptData: { text: 'x' }, idleDeadRetries: 1, idleHeals: 0, textBuf: '已产出内容' }, h2.ctx)
  assert.equal(r2.action, 'continue'); assert.equal(r2.signal, 'idle-heal')
  assert.equal(r2.flushText, '已产出内容', '★ 交回清空前的原文（守卫体不碰会话对象）')
  assert.equal(r2.state.textBuf, '')
  assert.equal(h2.events[0]?.payload?.reason, 'idle-interrupted')
  // 态三：预算耗尽 + 已产出 ⇒ 硬停 reason=idle
  const h3 = mkCtx()
  const r3 = await runAfterStreamGuards({ ...base, attemptData: { text: 'x' }, idleDeadRetries: 1, idleHeals: 1, textBuf: '' }, h3.ctx)
  assert.equal(r3.stop?.reason, 'idle'); assert.ok(r3.stop.message.includes('无数据'))
  // 态三'：预算耗尽 + 零产出 ⇒ 硬停 reason=upstream-dead（与上面是**不同文案例**）
  const h4 = mkCtx()
  const r4 = await runAfterStreamGuards({ ...base, attemptData: null, idleDeadRetries: 1, idleHeals: 0, textBuf: '' }, h4.ctx)
  assert.equal(r4.stop?.reason, 'upstream-dead'); assert.ok(r4.stop.message.includes('连接建立后'))
})

test('Task4 · upstreamDead：预算内退避重试，耗尽 ⇒ 硬停（文案与 idleWatchdog 的不同）', async () => {
  const h1 = mkCtx()
  const r1 = await runAfterStreamGuards({
    timing: 'onErrorDeadStream', upstreamDeadHeals: 0, UPSTREAM_DEAD_HEAL_MAX: 2, UPSTREAM_DEAD_HEAL_BACKOFF_MS: 1, loopStop: null,
  }, h1.ctx)
  assert.equal(r1.action, 'continue'); assert.equal(r1.signal, 'upstream-dead-retry')
  assert.equal(r1.state.upstreamDeadHeals, 1)
  assert.equal(h1.events[0]?.payload?.reason, 'upstream-dead')
  assert.deepEqual(h1.injections, [], '上游死亡只发事件、无注入')
  const h2 = mkCtx()
  const r2 = await runAfterStreamGuards({
    timing: 'onErrorDeadStream', upstreamDeadHeals: 2, UPSTREAM_DEAD_HEAL_MAX: 2, UPSTREAM_DEAD_HEAL_BACKOFF_MS: 1, loopStop: null,
  }, h2.ctx)
  assert.equal(r2.stop?.reason, 'upstream-dead')
  assert.ok(r2.stop.message.includes('上游服务空流'), '★ 本站点文案是"请求已受理却空流"，与 idleWatchdog 的超时文案不同')
})

test('Task4 · 已停跳过：loopStop 非空 ⇒ idleWatchdog 不再动作（原 `!loopStop &&` 前置）', async () => {
  const h = mkCtx()
  const r = await runAfterStreamGuards({
    timing: 'onErrorIdle', watchdogTripped: true, loopStop: { reason: 'stall' },
    attemptData: null, idleDeadRetries: 0, IDLE_DEAD_RETRY_MAX: 1, idleHeals: 0, IDLE_HEAL_MAX: 1,
  }, h.ctx)
  assert.equal(r.action, null); assert.equal(r.stop, null); assert.deepEqual(h.hits, [])
})

// ── ③ 源级等价 + 接线 ───────────────────────────────────────────────────

test('Task4 · 源级等价：搬移前文案逐字保留（基线钉死 SHA，不用 HEAD）', () => {
  // ★ 基线必须用**固定 SHA**：HEAD 随提交前移，搬移入库后 HEAD 里就没有这些字面量了（实测假红）
  const BASE_REV = 'fda0d87' // Task 2 完成态（afterStream 六守卫仍在 engine 内联）
  const old = execFileSync('git', ['show', `${BASE_REV}:kernel/engine.mjs`], { encoding: 'utf8' })
  const core = readFileSync(new URL('../kernel/loop-core.mjs', import.meta.url), 'utf8')
  const needles = [
    '反复复述近似内容', // repeatHeal 注入
    '已自动收尾停止重试', // meltdown 硬停
    '中途停顿（疑似推理中断）', // idleWatchdog 自愈注入
    '秒无数据，此前已产出部分内容', // idleWatchdog 硬停（已产出）
    '连接建立后', '未收到任何数据', // idleWatchdog 硬停（零产出）
    '上游服务空流', '切换 provider 后重试', // upstreamDead 硬停（★ 与上面是两条不同文案）
  ]
  for (const n of needles) {
    assert.ok(old.includes(n), `基线 ${BASE_REV} 应含「${n}」——否则基线选错`)
    assert.ok(core.includes(n), `搬移后必须逐字保留：「${n}」`)
  }
})

test('Task4 · 接线：engine 调契约入口，且不再内联这 6 个守卫的命中登记与文案', () => {
  const src = readFileSync(new URL('../kernel/engine.mjs', import.meta.url), 'utf8')
  assert.ok(src.includes('runAfterStreamGuards('), 'engine 必须调用契约入口 runAfterStreamGuards')
  for (const g of ['repeatHeal', 'progressRefresh', 'repeatReminder', 'meltdown', 'idleWatchdog', 'upstreamDead']) {
    assert.ok(!new RegExp(`turnGuardHits\\.push\\('${g}'\\)`).test(src), `${g} 的命中登记不得再内联在 engine`)
  }
  // 三站点各自传入正确的 timing（防"只用了一个站点、另两个忘接线"）
  const timings = [...src.matchAll(/timing: '(\w+)'/g)].map((m) => m[1])
  for (const t of ['postStream', 'postTools', 'onErrorIdle', 'onErrorDeadStream']) {
    assert.ok(timings.includes(t), `engine 必须为 ${t} 站点接线（实测 timing 出现：${timings.join(', ')}）`)
  }
})
