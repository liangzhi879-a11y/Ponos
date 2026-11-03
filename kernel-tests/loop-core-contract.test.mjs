// 循环体契约（S2/B1）：profile 校验、守卫序解析、注入出口形状
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAIN_PROFILE, LANE_PROFILE, validateProfile, resolveGuards,
} from '../kernel/loop-profile.mjs'
import { emitInjection, runOnce, shouldStop, runIterHeadGuards, runInStreamGuards, runAfterStreamGuards } from '../kernel/loop-core.mjs'

test('MAIN_PROFILE / LANE_PROFILE 合法', () => {
  assert.equal(validateProfile(MAIN_PROFILE).ok, true)
  assert.equal(validateProfile(LANE_PROFILE).ok, true)
})

test('validateProfile 拒绝未知相位与未知守卫', () => {
  const bad = { guards: { iterHead: ['wallClock', '不存在'], inStream: [], afterStream: [] } }
  const r = validateProfile(bad)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('不存在')))
})

test('validateProfile 拒绝缺失相位', () => {
  const r = validateProfile({ guards: { iterHead: [] } })
  assert.equal(r.ok, false)
})

test('resolveGuards 返回副本，外部改动不回写 profile', () => {
  const g = resolveGuards(MAIN_PROFILE, 'iterHead')
  g.push('hacked')
  assert.ok(!resolveGuards(MAIN_PROFILE, 'iterHead').includes('hacked'))
})

test('resolveGuards 对未知相位抛错（早失败优于静默）', () => {
  assert.throws(() => resolveGuards(MAIN_PROFILE, 'nope'), /unknown phase/)
})

test('LANE_PROFILE 的刻意差异只在 compactor/health/inject/stop —— 守卫集与主循环相同', () => {
  // 差异（spec §6.2 明列的四项 + 收尾方式）
  assert.equal(LANE_PROFILE.health.fidelityAnchor, false)
  assert.equal(LANE_PROFILE.compactor.preStep, false)
  assert.equal(LANE_PROFILE.inject.pendingNext, false)
  assert.equal(LANE_PROFILE.inject.inbox, true)
  assert.equal(LANE_PROFILE.stop, 'guardStop')
  // ★ 守卫集**不**是差异：lane 与主循环逐项同集（实测 engine.mjs lane 段）
  for (const phase of ['iterHead', 'inStream', 'afterStream']) {
    assert.deepEqual(
      resolveGuards(LANE_PROFILE, phase),
      resolveGuards(MAIN_PROFILE, phase),
      `lane 的 ${phase} 守卫集必须与主循环相同（漏一个 = 静默丢守卫）`,
    )
  }
})

test('★ runOnce 相位顺序：相位 1 停止时不得进入取流（A2「一处实现」的载体）', async () => {
  const order = []
  const ctx = {
    profile: MAIN_PROFILE,
    pushInjection: () => {},
    async streamOnce() { order.push('stream'); return { ok: true } },
  }
  // 【Task 2 后改写】原用例靠"守卫未实现 ⇒ 抛错"制造相位 1 中断（Task 2–4 的临时状态）。
  // 迭代头守卫现已实现 ⇒ 改用**真实停止场景**：墙钟阈值 1ms、turnT0=0 ⇒ guardWallClock
  // 立即返回 stop。判据比原来更强（验的是"真实守卫的 stop 会阻止取流"，而非"抛错会阻止"）。
  const r = await runOnce({ TURN_TIMEOUT_MS: 1, turnT0: 0 }, ctx)
  assert.equal(r.stop?.reason, 'timeout', '相位 1 应因墙钟超时停止')
  assert.deepEqual(order, [], '相位 1 停止时不得进入 streamOnce（相位顺序正确性）')
})

test('★ 未实现/未注册的守卫必须抛错而非静默跳过（防「漏实现=静默失效」）', async () => {
  // 【Task 4 后改写】原用例靠"守卫体未实现 ⇒ 抛错"制造失败（Task 2–4 的临时状态）。
  // 12 个守卫现已全部注册 ⇒ 改用**永久有效**的等价判据：profile 里引用一个**未注册**的
  // 守卫名。这条不变量（未知守卫名 → 早失败）才是"防静默失效"的真正载体，且与实现进度无关。
  const badProfile = {
    ...MAIN_PROFILE,
    guards: { ...MAIN_PROFILE.guards, iterHead: ['wallClock', 'noSuchGuard'] },
  }
  const ctx = { profile: badProfile, pushInjection: () => {}, async streamOnce() { return {} } }
  await assert.rejects(() => runIterHeadGuards({ TURN_TIMEOUT_MS: 0 }, ctx), /未实现|未注册/,
    'profile 引用未注册守卫名时必须早失败（静默跳过 = 漏实现永不被发现）')
})

test('★ 三个相位入口齐备（Task 2–4 的落点；防「漏建某个相位入口」）', () => {
  assert.equal(typeof runIterHeadGuards, 'function')
  assert.equal(typeof runInStreamGuards, 'function')
  assert.equal(typeof runAfterStreamGuards, 'function')
})

test('shouldStop：无 stop 返回 null，有 stop 时规范化 reason', () => {
  assert.equal(shouldStop({}), null)
  assert.deepEqual(shouldStop({ stop: { reason: 'loop-stall', message: 'm' } }), { reason: 'loop-stall', message: 'm' })
  assert.deepEqual(shouldStop({ stop: {} }), { reason: 'unknown', message: undefined })
})

test('emitInjection 冻结 text/persist/event：拒绝扩展字段', () => {
  const ctx = { emitInjection: null, wire: { system: () => {} } }
  // 出口由 loop-core 注入到 ctx 上；这里直接测形状校验函数
  assert.throws(
    () => emitInjection(ctx, 'x', { persist: false, event: null, priority: 1 }),
    /unknown option: priority/,
  )
})

test('emitInjection 记录到 ctx 注入缓冲，persist 语义透传', () => {
  const buf = []
  const ctx = { pushInjection: (text, meta) => buf.push({ text, ...meta }) }
  emitInjection(ctx, '自愈：继续', { persist: true, event: { reason: 'wall-clock' } })
  assert.equal(buf.length, 1)
  assert.equal(buf[0].text, '自愈：继续')
  assert.equal(buf[0].persist, true)
  assert.equal(buf[0].event.reason, 'wall-clock')
})

test('emitInjection 无 pushInjection 时静默（不抛错、不阻断主流程）', () => {
  assert.doesNotThrow(() => emitInjection({}, 'x', { persist: false, event: null }))
})

// ── Task 5 Step 1：profile 完整性（A2「不漏守卫」的静态保险）──────────────────

test('Task5 · MAIN_PROFILE 覆盖全部 12 个已实现守卫，且无重复', () => {
  const all = resolveGuards(MAIN_PROFILE, 'iterHead')
    .concat(resolveGuards(MAIN_PROFILE, 'inStream'), resolveGuards(MAIN_PROFILE, 'afterStream'))
  // 12 = engine 的 GUARD_IDS(11) + progressRefresh（非命中项，见 loop-profile 头部说明）
  assert.equal(all.length, 12, `应恰好覆盖 12 个守卫，实测 ${all.length}`)
  assert.equal(new Set(all).size, all.length, '守卫不得在两个相位重复出现（否则会执行两次）')
})

test('Task5 · LANE_PROFILE 与 MAIN_PROFILE 守卫集逐项相同（差异只允许在配置项）', () => {
  // lane 段实测同样跑全部守卫（含 genRepeat/nearRepeat/停滞/熔断）——
  // 若写成缩减集会**静默丢掉守卫**（计划草稿即如此，已按实测修正）。
  for (const phase of ['iterHead', 'inStream', 'afterStream']) {
    assert.deepEqual(resolveGuards(LANE_PROFILE, phase), resolveGuards(MAIN_PROFILE, phase),
      `${phase} 相位：lane 与 main 的守卫集与顺序都必须相同`)
  }
})

test('Task5 · 三相位齐备且非空（缺相位 = 该类检查静默失效）', () => {
  for (const p of ['iterHead', 'inStream', 'afterStream']) {
    assert.ok(resolveGuards(MAIN_PROFILE, p).length > 0, `${p} 相位不得为空`)
  }
})
