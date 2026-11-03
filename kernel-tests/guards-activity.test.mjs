// 活跃等待判定（2026-09-21 长任务可靠性 P1 Task 9）。
//
// 守卫⑥（无进展停滞）原判据只看 isRealProgress = "成功且非只读测量的工具结果"，
// 而**工具超时不刷新进展** ⇒ 长任务里连续几个长工具（各 2~5 分钟）就凑满 10min 阈值，
// 被误判"长时间无实质进展" → 注入 2 次 → 收尾（用户症状①）。
//
// 修法：把"在忙（工具有结果但属超时）"与"实质进展"分开计时 —— 本文件钉住"什么算在忙"。
// ★ 只有**超时**算在忙：真失败不算（否则模型可以靠不断失败逃避停滞判据）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasActiveWait, allToolsTimedOut } from '../kernel/guards.mjs'

test('有工具超时结束 → 处于活跃等待', () => {
  assert.equal(hasActiveWait([{ is_error: true, timeout: true }]), true)
})

test('全部成功 → 非活跃等待（那是实质进展，另有 progress 判据）', () => {
  assert.equal(hasActiveWait([{ is_error: false }]), false)
})

test('真失败（非超时）→ 非活跃等待（不能拿它当"在忙"逃避停滞判据）', () => {
  assert.equal(hasActiveWait([{ is_error: true, timeout: false }]), false)
})

test('混合：只要有一个超时即算在忙（长任务常是"一个长工具 + 若干短工具"）', () => {
  assert.equal(hasActiveWait([{ is_error: false }, { is_error: true, timeout: true }]), true)
})

test('空结果 → 非活跃等待', () => {
  assert.equal(hasActiveWait([]), false)
})

test('缺省/畸形入参不抛异常（防御性）', () => {
  assert.equal(hasActiveWait(undefined), false)
  assert.equal(hasActiveWait(null), false)
  assert.equal(hasActiveWait([null, undefined, {}]), false)
})

test('超时且无 is_error 字段也算在忙（标记本身即证据，不依赖 is_error 同时在场）', () => {
  assert.equal(hasActiveWait([{ timeout: true }]), true)
})

// ── allToolsTimedOut：连击计数的输入 ──────────────────────────────────────────

test('全部超时 → 计连击', () => {
  assert.equal(allToolsTimedOut([{ timeout: true }, { timeout: true }]), true)
})

test('★ 混合批（有成功结果）→ 不计连击（有实质进展就不该累计）', () => {
  assert.equal(allToolsTimedOut([{ timeout: true }, { is_error: false }]), false)
})

test('空批 → 不计连击（没有工具调用谈不上"反复超时"）', () => {
  assert.equal(allToolsTimedOut([]), false)
  assert.equal(allToolsTimedOut(undefined), false)
})

test('真失败不算超时连击（失败另有熔断守卫兜底）', () => {
  assert.equal(allToolsTimedOut([{ is_error: true, timeout: false }]), false)
})
