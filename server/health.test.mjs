import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeHealthScore, modelCap, shouldJudge, createHealth } from '../kernel/health.mjs'

test('档位边界：40/70 分界；压缩次数驱动', () => {
  const base = { chainDepth: 0, remainingPct: 50, remainingTurns: 20, failures: 0, redundancyRatio: 0, toolResultShare: 0 }
  const g = computeHealthScore({ ...base, compactCount: 0, model: 'deepseek-v4-flash' })
  assert.equal(g.tier, 'green')
  const y = computeHealthScore({ ...base, compactCount: 1, model: 'deepseek-v4-flash' }) // 70×1/3=23 → max(40,23)=40
  assert.equal(y.tier, 'yellow')
  const r = computeHealthScore({ ...base, compactCount: 3, model: 'deepseek-v4-flash' }) // 70×3/3=70
  assert.equal(r.tier, 'red')
  assert.equal(r.suggestNewSession, true)
})

test('模型自适应：flash 3 次压缩=红；pro[1m] 3 次=黄（cap 6）', () => {
  const base = { chainDepth: 0, remainingPct: 50, remainingTurns: 20, failures: 0, redundancyRatio: 0, toolResultShare: 0 }
  const f = computeHealthScore({ ...base, compactCount: 3, model: 'deepseek-v4-flash' })
  const p = computeHealthScore({ ...base, compactCount: 3, model: 'deepseek-v4-pro' })
  assert.equal(f.tier, 'red')
  assert.equal(p.tier, 'yellow')
  assert.equal(modelCap('deepseek-v4-pro'), 6)
  assert.equal(modelCap('deepseek-v4-flash'), 3)
})

test('剩余水位与剩余轮数因子；<5 轮强制红', () => {
  const base = { compactCount: 0, chainDepth: 0, failures: 0, redundancyRatio: 0, toolResultShare: 0, model: 'deepseek-v4-flash' }
  const lowWater = computeHealthScore({ ...base, remainingPct: 10, remainingTurns: 20 }) // <12% → +70
  assert.equal(lowWater.tier, 'red')
  const lowTurns = computeHealthScore({ ...base, remainingPct: 50, remainingTurns: 4 }) // <5 → +30 且强制红
  assert.equal(lowTurns.tier, 'red')
})

test('冗余率与分区失衡因子各 +10', () => {
  const base = { compactCount: 0, chainDepth: 0, remainingPct: 50, remainingTurns: 20, failures: 0, model: 'deepseek-v4-flash' }
  const red = computeHealthScore({ ...base, redundancyRatio: 0.6, toolResultShare: 0.6 })
  assert.equal(red.score, 20)
  assert.equal(red.tier, 'green') // 20 < 40 仍绿
})

test('shouldJudge：默认关不触发；红档开启后才触发且走冷却', () => {
  const now = Date.now()
  assert.equal(shouldJudge({ tier: 'red', judgeEnabled: false, lastJudgeAt: 0, now }), false)
  assert.equal(shouldJudge({ tier: 'green', judgeEnabled: true, lastJudgeAt: 0, now }), false)
  assert.equal(shouldJudge({ tier: 'red', judgeEnabled: true, lastJudgeAt: 0, now }), true)
  assert.equal(shouldJudge({ tier: 'red', judgeEnabled: true, lastJudgeAt: now, now, cooldownMs: 300000 }), false)
})

test('createHealth：非 green 档位去抖只发一次 yfw_health；recordCompaction 发 yfw_summary', () => {
  const events = []
  const wire = {
    health: (d) => events.push({ type: 'yfw_health', ...d }),
    summary: (t, c) => events.push({ type: 'yfw_summary', text: t, compactCount: c }),
  }
  const h = createHealth({ wire, model: 'deepseek-v4-flash', contextWindow: 200_000 })
  h.record({ usage: {}, durationMs: 5, model: 'deepseek-v4-flash', ts: 't', compactCount: 0 })
  assert.equal(events.filter((e) => e.type === 'yfw_health').length, 0) // green 不发
  h.recordCompaction('摘要A', 1)
  const sum = events.filter((e) => e.type === 'yfw_summary')
  assert.equal(sum.length, 1)
  assert.equal(sum[0].text, '摘要A')
  assert.ok(events.some((e) => e.type === 'yfw_health')) // 压缩后档位变化 → 发
  const before = events.length
  h.record({ usage: {}, durationMs: 5, model: 'deepseek-v4-flash', ts: 't', compactCount: 2 })
  assert.equal(events.length, before) // 同档去抖：不再发
})

import { getOpsHealth } from '../kernel/health.mjs'

test('O2-1 getOpsHealth：内存/API 状态/队列深度归一输出', () => {
  const h = getOpsHealth({
    memory: { rss: 500 * 1024 * 1024, heapUsed: 100 * 1024 * 1024 },
    lastApi: { ok: true, ms: 320 },
    pendingTurns: 2,
    diskBytes: 25 * 1024 * 1024,
  })
  assert.equal(h.rssMB, 500)
  assert.equal(h.heapMB, 100)
  assert.equal(h.lastApiOk, true)
  assert.equal(h.lastApiMs, 320)
  assert.equal(h.pendingTurns, 2)
  assert.equal(h.diskMB, 25)
})

test('O2-1 缺省输入降级：空对象返回 0/null 不抛', () => {
  const h = getOpsHealth({})
  assert.equal(h.rssMB, 0)
  assert.equal(h.lastApiOk, null)
  assert.equal(h.pendingTurns, 0)
})
