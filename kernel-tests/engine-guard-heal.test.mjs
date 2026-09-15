// 无感愈合族（2026-09-10 模型异常愈合原则）：连续失败熔断 + 上游空流
// ---------------------------------------------------------------------------
// 原则：模型异常优先注入指令自愈续跑（用户无感知），恢复即清零；耗尽预算才落
// 可见收尾（硬停是最后防线）。本文件钉死两条新愈合路径：
//   · 守卫④ 连续全败熔断：达阈值先注入"排查失败原因"指令（重开失败预算），
//     耗尽 MELTDOWN_HEAL_MAX 才可见收尾；
//   · 上游空流（vLLM 引擎加载中/崩溃）：退避后静默重试 UPSTREAM_DEAD_HEAL_MAX
//     次才可见收尾（retryStream 的 1 次快重试之外的长退避层）。
process.env.PONOS_MOCK_API = '1'
process.env.PONOS_UPSTREAM_DEAD_HEAL_BACKOFF_MS = '100'
// 有限预算路径测试（2026-09-11）：熔断愈合默认已改持久无限（-1，安全网=守卫⑥，
// 见 engine-guard-heal-persistent.test.mjs）——本文件显式设 1 验证"预算耗尽落可见
// 收尾"的有限语义仍可用。
process.env.PONOS_MELTDOWN_HEAL_MAX = '1'
const { createEngine } = await import('../kernel/engine.mjs')
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore } from '../kernel/session.mjs'

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'guard-heal-'))
  const events = []
  const wire = {
    assistant: () => {}, result: () => {}, controlRequest: () => {},
    system: (subtype, payload) => events.push({ subtype, ...(payload || {}) }),
    summary: () => {}, health: () => {}, warning: () => {},
  }
  const session = createSessionStore({ configDir: dir, cwd: dir, sessionId: 'heal-session' })
  const engine = createEngine({
    opts: { model: 'm', addDirs: [dir], skipPermissions: true, systemPrompt: '' },
    wire, session,
  })
  return { engine, events, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('守卫④ 熔断愈合：连续全败达阈值 → 注入排查指令（guard_heal）→ 耗尽才可见收尾', async () => {
  process.env.PONOS_MOCK_LOOP = 'fail'
  const env = makeEnv()
  try {
    const t0 = Date.now()
    const result = await env.engine.runTurn({ content: '[mock:loop]' })
    const elapsed = Date.now() - t0
    // MELTDOWN_HEAL_MAX=1：6 连败 → 愈合注入（重开预算）→ 再 6 连败 → 可见收尾
    assert.ok(result.text.includes('全部失败'), `应落熔断收尾文案，实际: ${result.text.slice(0, 200)}`)
    const heals = env.events.filter((e) => e.subtype === 'guard_heal' && e.reason === 'error-meltdown')
    assert.equal(heals.length, 1, '应先注入 1 次排查指令（MELTDOWN_HEAL_MAX=1）')
    assert.equal(heals[0].attempt, 1)
    assert.ok(elapsed < 30000, `应快速收敛（实际 ${elapsed}ms）`)
    // 愈合注入已落 transcript（模型可见排查引导）
    const again = await env.engine.runTurn({ content: '继续' })
    assert.ok(typeof again.text === 'string' && again.text.length > 0)
  } finally {
    delete process.env.PONOS_MOCK_LOOP
    env.cleanup()
  }
})

test('上游空流愈合：退避静默重试 2 次（guard_heal）→ 耗尽才可见收尾', async () => {
  const env = makeEnv()
  try {
    const t0 = Date.now()
    const result = await env.engine.runTurn({ content: '[mock:deadstream]' })
    const elapsed = Date.now() - t0
    assert.ok(result.text.includes('上游服务空流'), `应落空流收尾文案，实际: ${result.text.slice(0, 200)}`)
    const heals = env.events.filter((e) => e.subtype === 'guard_heal' && e.reason === 'upstream-dead')
    assert.equal(heals.length, 2, '应先退避重试 2 次（UPSTREAM_DEAD_HEAL_MAX=2）')
    assert.ok(elapsed < 30000, `应快速收敛（实际 ${elapsed}ms）`)
  } finally { env.cleanup() }
})
