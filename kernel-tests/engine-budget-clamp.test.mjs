// 调用时输出预算钳制（2026-09-10 小窗口本地模型适配；pi clampMaxTokensToContext 语义）
// ---------------------------------------------------------------------------
// 背景：本地小窗口模型（32K-64K）配大默认输出预算（64K）时，input+max_tokens 恒超
// 窗口——阈值解析对"预算近乎占满窗口"退化回纯比例，est 低于阈值但请求必 400。
// 修复：engine preStep 每次模型调用前按 window − est(input) − 余量 收窄 attemptMaxTokens，
// 窗口在调用时真正生效，不再依赖 400 溢出兜底。
process.env.PONOS_MOCK_API = '1'
const { createEngine } = await import('../kernel/engine.mjs')
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore } from '../kernel/session.mjs'
import { createCompactor } from '../kernel/compact.mjs'
import { estimateRequest, estimateMessage, estimateHistory } from '../kernel/context.mjs'

// 环境工厂：window 可配；compactor 的 estimate 恒低于阈值（只测钳制不测压缩）
function makeEnv({ window }) {
  const events = []
  const wire = {
    assistant: () => {}, result: () => {}, controlRequest: () => {},
    system: (subtype, payload) => events.push({ subtype, ...(payload || {}) }),
    summary: () => {}, health: () => {}, warning: () => {},
  }
  const dir = mkdtempSync(join(tmpdir(), 'budget-clamp-'))
  const session = createSessionStore({ configDir: dir, cwd: dir, sessionId: 'clamp-session' })
  const context = {
    window,
    thresholdRatio: 0.8,
    retainRatio: 0.16,
    estimate: () => ({ total: 100 }), // 恒低于阈值 → maybeCompact 恒 none
    estimateMessage,
    estimateHistory,
  }
  const compactor = createCompactor({
    session, context, model: 'mock-model', maxTokens: 64000, wire,
    health: undefined, signal: undefined, env: process.env, sessionMemoryPath: null,
  })
  const engine = createEngine({
    opts: { model: 'mock-model', addDirs: [dir], skipPermissions: true, systemPrompt: '', context },
    wire, session, compactor,
  })
  return {
    events, engine, dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('小窗口：est + 默认预算超窗 → 每轮调用前收窄 max_tokens（output_budget_clamped 事件）', async () => {
  const env = makeEnv({ window: 5000 })
  try {
    // 系统提示 3000 字符 ≈ 754 tokens：输入 + 64K 预算必超 5K 窗口
    env.engine.setSystemPrompt('x'.repeat(3000))
    const result = await env.engine.runTurn({ content: 'hello' })
    assert.ok(String(result.text || '').includes('mock:'), '钳制后请求正常完成（mock 回显）')
    const clampEvts = env.events.filter((e) => e.subtype === 'output_budget_clamped')
    assert.ok(clampEvts.length >= 1, '应发出预算钳制事件')
    const e = clampEvts[0]
    assert.ok(e.maxTokens < 64000, `应从 64000 收窄（实际 ${e.maxTokens}）`)
    assert.ok(e.maxTokens >= 1024, '不低于 floor')
    assert.ok(e.maxTokens <= e.window - e.estInputTokens - 2048 + 1, `钳制值应 ≤ window−est−2048（${JSON.stringify(e)}）`)
    assert.ok(e.estInputTokens >= 700, `输入估算应含系统提示（实际 ${e.estInputTokens}）`)
  } finally { env.cleanup() }
})

test('大窗口：预算装得下 → 不钳制（无事件，云端行为零回归）', async () => {
  const env = makeEnv({ window: 1_000_000 })
  try {
    env.engine.setSystemPrompt('x'.repeat(3000))
    const result = await env.engine.runTurn({ content: 'hello' })
    assert.ok(String(result.text || '').includes('mock:'))
    assert.equal(env.events.some((e) => e.subtype === 'output_budget_clamped'), false, '装得下时不得钳制')
  } finally { env.cleanup() }
})
