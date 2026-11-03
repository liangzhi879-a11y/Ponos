// 回归：PONOS_STALL_HEAL_MAX 必须支持 -1（无限愈合）。
//
// 事故（2026-09-21 长任务排查）：该常量曾用 envNonNeg 解析 ⇒ -1 被当非法值**静默忽略**、
// 回落默认 2。用户以为开了"无限续跑"，实际仍是注入两次后收尾，长任务照样在十几分钟停住。
// 同族常量（REPEAT_HEAL_MAX / MELTDOWN_HEAL_MAX 等）一直用 envHealMax 且支持 -1，
// 只有 ⑥ 这一个漏了 ⇒ 语义不一致导致的隐性失效。
//
// 实现要点：engine-config.mjs 在**模块顶层**读 process.env（见文件头注释
// "求值时机不变（模块顶层读 process.env）"），故每个用例用带唯一 query 的 import
// 绕过模块缓存，重新求值。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const KEYS = ['PONOS_STALL_HEAL_MAX', 'PONOS_LOOP_GUARD']

async function loadConfig(overrides) {
  for (const k of KEYS) {
    if (Object.prototype.hasOwnProperty.call(overrides, k)) {
      if (overrides[k] === undefined) delete process.env[k]
      else process.env[k] = String(overrides[k])
    } else {
      delete process.env[k]
    }
  }
  const stamp = `${Date.now()}-${Math.random()}`
  return import(`../kernel/engine-config.mjs?case=${stamp}`)
}

test('PONOS_STALL_HEAL_MAX=-1 → 无限愈合（不得回落默认 2）', async () => {
  const m = await loadConfig({ PONOS_STALL_HEAL_MAX: '-1' })
  assert.equal(m.STALL_HEAL_MAX, -1)
})

test('PONOS_STALL_HEAL_MAX=0 → 0（合法值：命中即收尾，不注入）', async () => {
  const m = await loadConfig({ PONOS_STALL_HEAL_MAX: '0' })
  assert.equal(m.STALL_HEAL_MAX, 0)
})

test('未设置 → 默认 2（保持现状行为）', async () => {
  const m = await loadConfig({ PONOS_STALL_HEAL_MAX: undefined })
  assert.equal(m.STALL_HEAL_MAX, 2)
})

test('非法值 → 回落默认 2', async () => {
  const m = await loadConfig({ PONOS_STALL_HEAL_MAX: 'abc' })
  assert.equal(m.STALL_HEAL_MAX, 2)
})

test('PONOS_LOOP_GUARD=0 → 0（总开关优先，压过显式设置）', async () => {
  const m = await loadConfig({ PONOS_LOOP_GUARD: '0', PONOS_STALL_HEAL_MAX: '5' })
  assert.equal(m.STALL_HEAL_MAX, 0)
})

test('与同族常量语义一致：STALL_HEAL_MAX 与 REPEAT_HEAL_MAX 对 -1 的处理相同', async () => {
  const m = await loadConfig({ PONOS_STALL_HEAL_MAX: '-1' })
  // ③ 重复打转的愈合预算一直是 -1（无限）——本用例钉住"两族语义不得再漂移"
  assert.equal(m.REPEAT_HEAL_MAX, -1)
  assert.equal(m.STALL_HEAL_MAX, -1)
})
