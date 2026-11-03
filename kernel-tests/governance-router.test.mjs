// 三层升级治理层（2026-10-06 spec loop-3layer-upgrade §4 A25）：
// 三档阈值边界 · REFLECT 无外部信号 ⇒ escalate · 低置信 ⇒ stay · 一致 ⇒ auto（免切）·
// 裁决留痕形状 · 升级卡载荷/作答判定 · 引擎级升级通道（ASK_USER 兼容卡 + 批准/超时）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.PONOS_MOCK_API = '1'
process.env.PONOS_LOOP_MAX_ITERATIONS = '2' // 迭代上限在 engine-config **模块加载时**读取 ⇒ 必须早于下方动态 import

const {
  DEFAULT_THRESHOLDS, decideGovernance, evaluateRouteGovernance, buildEscalationPayload, interpretEscalationAnswer,
} = await import('../kernel/governance-router.mjs')
const { createEngine } = await import('../kernel/engine.mjs')
const { createSessionStore } = await import('../kernel/session.mjs')
const { makeWire } = await import('../kernel/protocol.mjs')

// ── 三档阈值边界（含等号：≥ 门槛即自动）─────────────────────────────────────

test('★ 阈值边界：LOW .60 恰在门槛即 auto，差一点即 stay', () => {
  assert.equal(decideGovernance({ confidence: 0.6, impact: 'low' }).action, 'auto')
  assert.equal(decideGovernance({ confidence: 0.599, impact: 'low' }).action, 'stay')
})

test('★ 阈值边界：MED .75 / HIGH .88 同口径', () => {
  assert.equal(decideGovernance({ confidence: 0.75, impact: 'med' }).action, 'auto')
  assert.equal(decideGovernance({ confidence: 0.749, impact: 'med' }).action, 'stay')
  assert.equal(decideGovernance({ confidence: 0.88, impact: 'high' }).action, 'auto')
  assert.equal(decideGovernance({ confidence: 0.879, impact: 'high' }).action, 'stay')
})

test('★ 未知影响级别按最高门槛从严（宁可多问，不自作主张）', () => {
  assert.equal(decideGovernance({ confidence: 0.8, impact: 'critical' }).action, 'stay', '未知级别落到 .88 门槛')
  assert.equal(decideGovernance({ confidence: 0.9, impact: 'critical' }).action, 'auto')
})

test('置信度钳制：越界夹紧、非数按 0（低置信 ⇒ 不切）', () => {
  assert.equal(decideGovernance({ confidence: 1.7, impact: 'low' }).confidence, 1)
  assert.equal(decideGovernance({ confidence: NaN, impact: 'low' }).action, 'stay')
  assert.equal(decideGovernance({ confidence: 'nope', impact: 'low' }).action, 'stay')
})

test('阈值可注入覆盖（测试边界与将来调参用）', () => {
  const th = { low: 0.2, med: 0.3, high: 0.4 }
  assert.equal(decideGovernance({ confidence: 0.25, impact: 'low', thresholds: th }).action, 'auto')
  assert.equal(decideGovernance({ confidence: 0.25, impact: 'med', thresholds: th }).action, 'stay')
})

// ── 外部信号前提（D13）──────────────────────────────────────────────────────

test('★ requiresExternalSignal：无信号 ⇒ escalate（即使置信度拉满）；有信号走阈值', () => {
  const noSig = decideGovernance({ confidence: 1, impact: 'med', requiresExternalSignal: true, externalSignal: false })
  assert.equal(noSig.action, 'escalate', '无外部信号的 REFLECT 建议必须请人确认')
  const withSig = decideGovernance({ confidence: 1, impact: 'med', requiresExternalSignal: true, externalSignal: true })
  assert.equal(withSig.action, 'auto')
  const low = decideGovernance({ confidence: 0.7, impact: 'med', requiresExternalSignal: true, externalSignal: true })
  assert.equal(low.action, 'stay', '有信号但置信不足 .75 ⇒ 仍不切')
})

// ── 路由结果 → 治理裁决 ─────────────────────────────────────────────────────

const R = (mode, confidence, ok = true) => ({ ok, mode, confidence, fallback: !ok })

test('evaluateRouteGovernance：路由未产出 ⇒ stay（沿用当前）', () => {
  assert.equal(evaluateRouteGovernance({ router: null, currentMode: 'react' }).action, 'stay')
  assert.equal(evaluateRouteGovernance({ router: R(null, 0, false), currentMode: 'react' }).action, 'stay')
})

test('evaluateRouteGovernance：与当前一致 ⇒ auto（无需切换，也不算停留）', () => {
  const d = evaluateRouteGovernance({ router: R('plan', 0.3), currentMode: 'plan' })
  assert.equal(d.action, 'auto')
  assert.match(d.reason, /一致/)
})

test('★ evaluateRouteGovernance：切换到 PLAN/REACT 是 LOW 影响（.6 即可自动）', () => {
  assert.equal(evaluateRouteGovernance({ router: R('plan', 0.6), currentMode: 'react' }).action, 'auto')
  assert.equal(evaluateRouteGovernance({ router: R('plan', 0.59), currentMode: 'react' }).action, 'stay')
})

test('★ evaluateRouteGovernance：进入 REFLECT = MED 影响 + 必须有外部信号', () => {
  // 无信号：一律升级（哪怕 .95——无失败证据不反思，D13）
  assert.equal(evaluateRouteGovernance({ router: R('reflect', 0.95), currentMode: 'react', externalSignal: false }).action, 'escalate')
  // 有信号：按 MED 门槛 .75
  assert.equal(evaluateRouteGovernance({ router: R('reflect', 0.75), currentMode: 'react', externalSignal: true }).action, 'auto')
  assert.equal(evaluateRouteGovernance({ router: R('reflect', 0.7), currentMode: 'react', externalSignal: true }).action, 'stay',
    'REFLECT 用 MED 门槛：.7 过得了 LOW(.6) 但过不了 MED(.75)——证明档次没走错')
})

test('裁决留痕：confidence/impact/threshold/reason 形状齐全（可落 turn meta）', () => {
  const d = evaluateRouteGovernance({ router: R('plan', 0.61), currentMode: 'react' })
  assert.deepEqual(Object.keys(d).sort(), ['action', 'confidence', 'externalSignal', 'impact', 'reason', 'requiresExternalSignal', 'threshold'].sort())
  assert.equal(d.threshold, DEFAULT_THRESHOLDS.low)
})

// ── 升级卡与作答判定 ────────────────────────────────────────────────────────

test('buildEscalationPayload：ASK_USER 兼容形状（questions[].options 非空）', () => {
  const p = buildEscalationPayload({ mode: 'reflect', confidence: 0.91, reason: '两次失败', currentMode: 'react' })
  assert.equal(typeof p.context, 'string')
  assert.equal(p.questions.length, 1)
  assert.equal(p.questions[0].question.includes('REFLECT'), true)
  assert.equal(p.questions[0].question.includes('91%'), true)
  assert.ok(p.questions[0].options.length >= 2)
  for (const o of p.questions[0].options) assert.ok(typeof o.label === 'string' && o.label.length > 0)
})

test('★ interpretEscalationAnswer：批准需显式肯定，否定优先（安全默认不切）', () => {
  assert.equal(interpretEscalationAnswer('切换并继续'), true)
  assert.equal(interpretEscalationAnswer('保持当前模式'), false)
  assert.equal(interpretEscalationAnswer(''), false)
  assert.equal(interpretEscalationAnswer('先不用了'), false)
  assert.equal(interpretEscalationAnswer('拒绝'), false)
  assert.equal(interpretEscalationAnswer('好的，切吧'), true)
})

// ── 引擎级升级通道（复用 ASK_USER 帧；批准/超时两条路）──────────────────────

function makeEngine() {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const dir = mkdtempSync(join(tmpdir(), 'ponos-gov-'))
  const store = createSessionStore({ configDir: join(dir, 'home'), cwd: dir, sessionId: 'main' })
  const engine = createEngine({
    opts: { model: 'mock-model', configDir: join(dir, 'home'), addDirs: [dir], skipPermissions: true },
    wire, session: store,
  })
  engine.setSystemPrompt('你是 Ponos-turbo 测试内核。')
  return {
    events, engine, store,
    cards: () => events.filter((e) => e.type === 'assistant' && JSON.stringify(e.message ?? e.content ?? '').includes('ASK_USER')),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}
const lastMeta = (engine) => engine.getTurnStats().at(-1).loopMode

/** 等一个谓词成立（上限 2s；升级卡是异步发出的） */
async function until(fn, ms = 2000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return fn()
}

test('★ 引擎级：路由建议 REFLECT 无外部信号 → 弹升级卡；批准 ⇒ 本轮切 reflect', async () => {
  process.env.PONOS_MOCK_ROUTER = '{"mode":"reflect","confidence":0.95,"reason":"失败链"}'
  const env = makeEngine()
  try {
    const turnP = env.engine.runTurn({ content: '只回一句话，不要调用工具' })
    // 升级卡必须出现（桥按 ASK_USER 口径提取 → question 帧 → GUI 零改动）
    const seen = await until(() => env.cards().length > 0)
    assert.ok(seen, '无外部信号的 REFLECT 建议必须弹确认卡')
    const raw = JSON.stringify(env.cards()[0])
    assert.ok(raw.includes('ASK_USER') && raw.includes('循环模式确认'), '卡必须是 ASK_USER 兼容载荷')
    env.engine.queueNext('切换并继续') // 披作作答：唤醒 + 注入（与用户点选同路）
    await turnP
    const meta = lastMeta(env.engine)
    assert.equal(meta.effective, 'reflect', '批准后本轮即进入 reflect')
    assert.equal(meta.governance.action, 'escalate')
  } finally { delete process.env.PONOS_MOCK_ROUTER; env.cleanup() }
})

test('★ 引擎级：拒绝升级 ⇒ 保持当前模式（安全默认，任务照常推进）', async () => {
  process.env.PONOS_MOCK_ROUTER = '{"mode":"reflect","confidence":0.95}'
  process.env.PONOS_ASK_USER_TIMEOUT_MS = '1000'
  const env = makeEngine()
  try {
    const turnP = env.engine.runTurn({ content: '只回一句话，不要调用工具' })
    const seen = await until(() => env.cards().length > 0)
    assert.ok(seen)
    env.engine.queueNext('保持当前模式')
    await turnP
    const meta = lastMeta(env.engine)
    assert.equal(meta.effective, 'react', '拒绝 ⇒ 不切，保持当前模式继续跑')
    assert.equal(meta.governance.action, 'escalate')
  } finally { delete process.env.PONOS_MOCK_ROUTER; delete process.env.PONOS_ASK_USER_TIMEOUT_MS; env.cleanup() }
})

test('★ 引擎级：升级超时（无作答）⇒ 保持当前模式（不悬挂、不阻塞到天荒地老）', async () => {
  process.env.PONOS_MOCK_ROUTER = '{"mode":"reflect","confidence":0.95}'
  process.env.PONOS_ASK_USER_TIMEOUT_MS = '1000'
  const env = makeEngine()
  try {
    const t0 = Date.now()
    await env.engine.runTurn({ content: '只回一句话，不要调用工具' })
    const meta = lastMeta(env.engine)
    assert.equal(meta.effective, 'react', '超时 ⇒ 安全默认（保持）')
    assert.ok(Date.now() - t0 >= 900, '确实等满超时窗口才继续')
    assert.equal(env.cards().length > 0, true, '卡已发出（用户稍后仍可看到）')
  } finally { delete process.env.PONOS_MOCK_ROUTER; delete process.env.PONOS_ASK_USER_TIMEOUT_MS; env.cleanup() }
})

test('★ 引擎级：有外部信号（上一轮失败链）时 REFLECT 免确认自动进入', async () => {
  process.env.PONOS_MOCK_ROUTER = '{"mode":"reflect","confidence":0.9}'
  const env = makeEngine()
  try {
    // 第一轮：正常 react（路由就是 react）
    delete process.env.PONOS_MOCK_ROUTER
    process.env.PONOS_MOCK_LOOP = 'fail' // 工具链全败 ⇒ 上一轮 guard 留痕（errorStreak）
    process.env.PONOS_LOOP_MAX_ITERATIONS = '2'
    await env.engine.runTurn({ content: '反复调用失败工具' })
    const g = env.engine.getTurnStats().at(-1).guard
    assert.ok(g.errorStreak > 0 || g.hits.length > 0, '前置条件：上一轮必须有失败留痕')
    // 第二轮：路由建议 reflect —— 外部信号在场 ⇒ 直接自动（无卡）
    process.env.PONOS_MOCK_ROUTER = '{"mode":"reflect","confidence":0.9}'
    delete process.env.PONOS_MOCK_LOOP
    await env.engine.runTurn({ content: '继续' })
    const meta = lastMeta(env.engine)
    assert.equal(meta.governance.action, 'auto', '有失败证据 ⇒ 免确认')
    assert.equal(meta.effective, 'reflect')
    assert.equal(env.cards().length, 0, '自动路径不得弹卡')
  } finally { delete process.env.PONOS_MOCK_ROUTER; delete process.env.PONOS_MOCK_LOOP; delete process.env.PONOS_LOOP_MAX_ITERATIONS; env.cleanup() }
})
