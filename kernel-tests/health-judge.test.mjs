// J1 health Judge：状态机（recordFailure/recordJudge/冷却/runJudge 注入）+ engine 集成。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHealth, shouldJudge, computeHealthScore } from '../kernel/health.mjs'
import { createEngine } from '../kernel/engine.mjs'
import { createSessionStore } from '../kernel/session.mjs'
import { makeWire } from '../kernel/protocol.mjs'

process.env.PONOS_MOCK_API = '1'

function collectHealth() {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  return { events, wire }
}

test('shouldJudge 纯函数：红档+开+冷却 → true；绿档/关/冷却内 → false', () => {
  const now = Date.now()
  assert.equal(shouldJudge({ tier: 'red', judgeEnabled: true, lastJudgeAt: 0, now }), true)
  assert.equal(shouldJudge({ tier: 'green', judgeEnabled: true, lastJudgeAt: 0, now }), false)
  assert.equal(shouldJudge({ tier: 'red', judgeEnabled: false, lastJudgeAt: 0, now }), false)
  assert.equal(shouldJudge({ tier: 'red', judgeEnabled: true, lastJudgeAt: now - 1000, now }), false)
  assert.equal(shouldJudge({ tier: 'red', judgeEnabled: true, lastJudgeAt: now - 300_100, now }), true)
})

test('recordJudge：force 发 ponos_health 且带 judge 字段一次性（下次 record 不再带）', () => {
  const { events, wire } = collectHealth()
  const h = createHealth({ wire, contextWindow: 200_000 })
  h.recordJudge({ done: true, reason: '建议继续' })
  let healthEv = events.filter((e) => e.type === 'ponos_health')
  assert.equal(healthEv.length, 1)
  assert.deepEqual(healthEv[0].judge, { done: true, reason: '建议继续' })
  // 普通 record（tier 不变不发）→ 后续事件不残留 judge
  h.record({ usage: { input_tokens: 100 }, compactCount: 0 })
  assert.equal(events.filter((e) => e.type === 'ponos_health').length, 1)
})

test('recordFailure：failures 计入 snapshotState 计分（上限 +30，tier 绿不变不发事件）', () => {
  const { events, wire } = collectHealth()
  const h = createHealth({ wire, contextWindow: 200_000 })
  // 空 recent：predictTurns 默认 growth 1000 → remainingTurns≈160（>10 无加分），
  // remainingPct=100 → score 恒 = min(failures,3)*10，档位绿 → 不发 ponos_health
  assert.equal(h.snapshotState().score, 0)
  h.recordFailure()
  assert.equal(h.snapshotState().score, 10)
  h.recordFailure(); h.recordFailure()
  assert.equal(h.snapshotState().score, 30)
  h.recordFailure(); h.recordFailure()
  assert.equal(h.snapshotState().score, 30, 'failures 计分封顶 +30')
  assert.equal(h.snapshotState().tier, 'green')
  assert.equal(events.filter((e) => e.type === 'ponos_health').length, 0, '绿档 recordFailure 不打扰（档位变化才发）')
})

test('computeHealthScore 纯函数：failures 加分封顶与 tier 边界', () => {
  assert.equal(computeHealthScore({}).tier, 'green')
  assert.equal(computeHealthScore({ failures: 3 }).score, 30)
  assert.equal(computeHealthScore({ failures: 9 }).score, 30, 'failures 封顶 +30')
  assert.equal(computeHealthScore({ remainingPct: 20 }).tier, 'amber') // 45 分
  assert.equal(computeHealthScore({ remainingPct: 20, failures: 3 }).tier, 'red') // 75 分
  assert.equal(computeHealthScore({ remainingTurns: 3 }).tier, 'red') // 30 + forceRed
})

test('runJudge 注入位：shouldRunJudge 门 + runJudge 被调 + 结果入事件（stub health）', async () => {
  // 直连 engine：传 stub health 观察接线点（真实状态机冷却另测于上）
  const dir = mkdtempSync(join(tmpdir(), 'ponos-judge-'))
  try {
    const events = []
    const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
    const store = createSessionStore({ configDir: join(dir, 'home'), cwd: dir, sessionId: 'main' })
    const calls = { judge: 0, recordFailure: 0 }
    const health = {
      record() {},
      shouldRunJudge() { return calls.judge < 1 }, // 首轮后冷却（模拟）
      async runJudge() { calls.judge++; return { done: false, reason: '健康判定完成' } },
      recordJudge(j) { calls.lastJudge = j },
      snapshotState() { return { tier: 'green' } },
      recordFailure() { calls.recordFailure++ },
    }
    const engine = createEngine({ opts: { model: 'mock-model', configDir: join(dir, 'home'), addDirs: [dir], skipPermissions: true }, wire, session: store, health })
    engine.setSystemPrompt('你是测试内核。')
    await engine.runTurn({ content: '你好' })
    assert.equal(calls.judge, 1, '首轮应触发一次 judge')
    assert.deepEqual(calls.lastJudge, { done: false, reason: '健康判定完成' })
    await engine.runTurn({ content: '再来一轮' })
    assert.equal(calls.judge, 1, '冷却内不应再触发')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('runJudge 抛异常静默：轮次照常完成（judge 不得影响主流程）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-judge-'))
  try {
    const events = []
    const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
    const store = createSessionStore({ configDir: join(dir, 'home'), cwd: dir, sessionId: 'main' })
    const health = {
      record() {},
      shouldRunJudge() { return true },
      async runJudge() { throw new Error('judge boom') },
      recordJudge() {},
      snapshotState() { return { tier: 'red' } },
      recordFailure() {},
    }
    const engine = createEngine({ opts: { model: 'mock-model', configDir: join(dir, 'home'), addDirs: [dir], skipPermissions: true }, wire, session: store, health })
    engine.setSystemPrompt('你是测试内核。')
    const r = await engine.runTurn({ content: '你好' }) // 不应抛
    assert.match(r.text, /mock:/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
