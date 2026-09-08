// P2-2 预算护栏：会话级累计 + 单价 env 覆盖 + 跨阈值单次事件 + 阈值未达不发。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from '../kernel/engine.mjs'
import { createSessionStore } from '../kernel/session.mjs'
import { makeWire } from '../kernel/protocol.mjs'
import { costOf } from '../kernel/cost.mjs'

process.env.PONOS_MOCK_API = '1'
// mock 每轮 usage = { input_tokens: 10, output_tokens: 20 }（api.mjs MOCK_USAGE）
const MOCK_ROUND_USD = costOf({ input_tokens: 10, output_tokens: 20 })

// 引擎在 createEngine 时读取 PRICES/BUDGET_USD env 常量（快照），故 env 必须在
// makeEngine 之前设置——三个用例统一先 cleanEnv + setEnv 再建引擎。
function makeEngine() {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const dir = mkdtempSync(join(tmpdir(), 'ponos-budget-'))
  const store = createSessionStore({ configDir: join(dir, 'home'), cwd: dir, sessionId: 'main' })
  const engine = createEngine({ opts: { model: 'mock-model', configDir: join(dir, 'home'), addDirs: [dir], skipPermissions: true }, wire, session: store })
  engine.setSystemPrompt('你是 Ponos-turbo 测试内核。')
  const warnings = () => events.filter((e) => e.type === 'ponos_warning' && e.level === 'budget')
  return { events, engine, warnings, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
const BUDGET_ENVS = ['PONOS_BUDGET_USD', 'PONOS_PRICE_PER_M_INPUT', 'PONOS_PRICE_PER_M_OUTPUT', 'PONOS_CACHE_READ_RATIO']
const cleanEnv = () => { for (const k of BUDGET_ENVS) delete process.env[k] }

test('累计正确性 + 跨阈值单次告警（2 轮跨阈才发、第 3 轮不重复）', async () => {
  cleanEnv()
  // 预算 = 1.5 轮成本：第 2 轮累计才跨阈
  process.env.PONOS_BUDGET_USD = String((MOCK_ROUND_USD * 1.5).toFixed(6))
  const env = makeEngine() // env 已设 → 引擎快照 budget 生效
  try {
    await env.engine.runTurn({ content: '一' })
    assert.equal(env.warnings().length, 0, '未跨阈不发')
    await env.engine.runTurn({ content: '二' })
    assert.equal(env.warnings().length, 1, '跨阈发一次')
    const w = env.warnings()[0]
    assert.ok(w.usd > 0)
    assert.ok(w.budgetUsd > 0)
    await env.engine.runTurn({ content: '三' })
    assert.equal(env.warnings().length, 1, '不重复告警')
  } finally { cleanEnv(); env.cleanup() }
})

test('单价 env 覆盖：输出单价调高 → 单轮即跨阈', async () => {
  cleanEnv()
  process.env.PONOS_PRICE_PER_M_OUTPUT = '1000' // 输出 20 token → 0.02 USD/轮
  process.env.PONOS_BUDGET_USD = '0.01'
  const env = makeEngine()
  try {
    await env.engine.runTurn({ content: '一' })
    assert.equal(env.warnings().length, 1)
  } finally { cleanEnv(); env.cleanup() }
})

test('阈值未设（PONOS_BUDGET_USD=0）→ 恒不发', async () => {
  cleanEnv()
  const env = makeEngine()
  try {
    await env.engine.runTurn({ content: '一' })
    await env.engine.runTurn({ content: '二' })
    assert.equal(env.warnings().length, 0)
  } finally { cleanEnv(); env.cleanup() }
})

test('costOf 纯函数：cache 计费与单价参数', () => {
  const c = costOf({ input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 })
  assert.ok(Math.abs(c - (0.2 + 1.2 + 0.2 * 0.1 + 0.2)) < 1e-9, `cache 计费错误: ${c}`)
})
