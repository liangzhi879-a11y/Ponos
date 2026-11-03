// 超时连击预算端到端（2026-09-21 长任务可靠性 P1 Task 9）。
//
// 双计时器给"有工具超时"开了续命口子（模型在等长命令，不该判停滞）；但续命不能变成
// 无限拖延 —— 连续多批工具**全部**超时，不是"在干活"，而是病态循环（命令规模远超超时、
// 或换了几个写法都超时）。本文件验证那条兜底真的会响，且用的是**另一套文案**
// （病根不同、对策不同：该"换策略/降规模"，而不是"别再测量"）。
//
// STALL_MS 特意设得很大：确保命中的只能是连击分支，不掺停滞分支的噪声。
// 6 轮全超时（预算 3）⇒ 第 3、6 轮各触一次连击自愈（愈合总数 2 用完），turn 仍正常收尾：
// 一条轨迹同时钉住"触发"与"预算约束"。
process.env.PONOS_MOCK_API = '1'
process.env.PONOS_LOOP_STALL_MS = '600000'
process.env.PONOS_TIMEOUT_STREAK_MAX = '3'
const { createEngine } = await import('../kernel/engine.mjs')
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore } from '../kernel/session.mjs'

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'timeout-streak-'))
  const events = []
  const wire = {
    assistant: () => {}, result: () => {}, controlRequest: () => {},
    system: (subtype, payload) => events.push({ subtype, ...(payload || {}) }),
    summary: () => {}, health: () => {}, warning: () => {},
    bridgeRequest: () => {},
  }
  const session = createSessionStore({ configDir: dir, cwd: dir, sessionId: 'timeout-streak' })
  const engine = createEngine({
    opts: { model: 'm', addDirs: [dir], skipPermissions: true, systemPrompt: '' },
    wire, session,
  })
  return { engine, events, dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}

test('★ 6 轮整批全超时（预算 3）→ 恰好 2 次连击自愈，且 turn 仍正常收尾', async () => {
  process.env.PONOS_MOCK_TIMEOUT_N = '0'
  process.env.PONOS_MOCK_TIMEOUT_ROUNDS = '6'
  const env = makeEnv()
  try {
    const result = await env.engine.runTurn({ content: '[mock:tool-timeout]' })
    const streak = env.events.filter((e) => e.reason === 'loop-timeout-streak')
    assert.equal(streak.length, 2, `6 轮全超时应恰好 2 次连击自愈（第 3、6 轮），events: ${JSON.stringify(env.events.map((e) => e.reason))}`)
    assert.ok(streak[0].streak >= 3, `事件应记录命中的连击数（≥预算 3），实际: ${streak[0]?.streak}`)
    // 病根不同、对策不同 ⇒ 不该用"无实质进展"那套文案（用错会把模型引向错误补救动作）
    const stall = env.events.filter((e) => e.reason === 'loop-stall')
    assert.equal(stall.length, 0, '本场景命中的应是连击分支，不是停滞分支')
    assert.ok(result.text.includes('timeout-done'), '愈合预算用完也不该提前掐断：turn 应正常收尾')
  } finally {
    env.cleanup()
  }
})
