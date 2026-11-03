// 双计时器端到端（2026-09-21 长任务可靠性 P1 Task 9 —— 用户症状①的正解）。
//
// 症状①：长任务里"整轮被误判停滞"而中断。机制：守卫⑥ 原判据只看"距上次**实质进展**的
// 时长"，而**超时不刷新进展** ⇒ 模型在等长命令（Task 8 后单个工具可跑 30min）时，
// 无进展时长照涨，凑满 LOOP_STALL_MS 就被判"长时间无实质进展"→ 注入 → 收尾。
//
// 本文件用 mock [mock:tool-timeout] 驱动"每批都有工具超时"的形态，并**关掉连击预算**
// （PONOS_TIMEOUT_STREAK_MAX=-1）以单独验证双计时器：
//   8 轮超时 ≈ 2s+ 的"无实质进展"，远超阈值 1.2s —— 若没有"在忙"计时器，必然触发停滞。
process.env.PONOS_MOCK_API = '1'
process.env.PONOS_LOOP_STALL_MS = '1200'
process.env.PONOS_TIMEOUT_STREAK_MAX = '-1' // 关连击，只考察双计时器
const { createEngine } = await import('../kernel/engine.mjs')
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore } from '../kernel/session.mjs'

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'timeout-activity-'))
  const events = []
  const wire = {
    assistant: () => {}, result: () => {}, controlRequest: () => {},
    system: (subtype, payload) => events.push({ subtype, ...(payload || {}) }),
    summary: () => {}, health: () => {}, warning: () => {},
    bridgeRequest: () => {},
  }
  const session = createSessionStore({ configDir: dir, cwd: dir, sessionId: 'timeout-activity' })
  const engine = createEngine({
    opts: { model: 'm', addDirs: [dir], skipPermissions: true, systemPrompt: '' },
    wire, session,
  })
  return { engine, events, dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}

test('★ 每批都有工具超时：无进展时长超过阈值也不判停滞（"在忙"续命）', async () => {
  process.env.PONOS_MOCK_TIMEOUT_N = '0' // 复位 mock 计数（沿用本仓 mock 惯例）
  process.env.PONOS_MOCK_TIMEOUT_ROUNDS = '8'
  const env = makeEnv()
  try {
    const result = await env.engine.runTurn({ content: '[mock:tool-timeout]' })
    const stall = env.events.filter((e) => e.reason === 'loop-stall')
    assert.equal(stall.length, 0, `有超时活动不该被判"无实质进展"，实际注入 ${stall.length} 次`)
    assert.ok(result.text.includes('timeout-done'), `应正常跑完 mock 轮次，实际: ${result.text.slice(0, 200)}`)
  } finally {
    env.cleanup()
  }
})
