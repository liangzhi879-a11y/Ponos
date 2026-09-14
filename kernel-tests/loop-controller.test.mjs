// LoopController：状态机 / 预算硬停 / 无进展升级 / 次数耗尽 / 持久化 round-trip。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLoopController } from '../kernel/loop.mjs'

function makeEnv(env = {}) {
  const events = []
  const dir = mkdtempSync(join(tmpdir(), 'ponos-loop-'))
  const configDir = join(dir, 'home')
  mkdirSync(configDir, { recursive: true })
  const controller = createLoopController({
    wire: {
      loop: (state, data = {}) => events.push({ state, ...data }),
      warning: (d) => events.push({ warning: d }),
      system: (sub, d = {}) => events.push({ system: sub, ...d }),
    },
    engine: { queueNext: () => {}, judgeUntil: async () => ({ done: false, reason: '' }) },
    store: null,
    configDir,
    sessionId: 'sess-1',
    cwd: dir,
    env: { PONOS_PRICE_PER_M_INPUT: '0.2', PONOS_PRICE_PER_M_OUTPUT: '1.2', ...env },
  })
  return { events, controller, dir, configDir, file: join(configDir, 'loop', 'sess-1.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const OUTCOME = (inTok = 10, outTok = 20, extra = {}) => ({
  usage: { input_tokens: inTok, output_tokens: outTok }, text: 'ok', toolDigest: [], ...extra,
})

test('start → running + 持久化 + wire start 帧', async () => {
  const env = makeEnv()
  try {
    env.controller.start({ count: 3, prompt: '做事', goal: '修复登录' })
    const st = env.controller.status()
    assert.equal(st.status, 'running')
    assert.equal(st.count, 3)
    assert.equal(st.goal, '修复登录')
    assert.ok(env.events.some((e) => e.state === 'start' && e.goal === '修复登录'))
    assert.ok(existsSync(env.file), '应持久化')
    assert.equal(JSON.parse(readFileSync(env.file, 'utf-8')).status, 'running')
  } finally { env.cleanup() }
})

test('次数耗尽 → completed 且 stop', async () => {
  const env = makeEnv()
  try {
    env.controller.start({ count: 2, prompt: '做事' })
    const r1 = await env.controller.onTurnEnd({ outcome: OUTCOME() })
    assert.equal(r1.action, 'next')
    const r2 = await env.controller.onTurnEnd({ outcome: OUTCOME() })
    assert.equal(r2.action, 'stop')
    assert.equal(env.controller.status().status, 'done')
    assert.equal(env.controller.status().endReason, 'completed')
    assert.ok(env.events.some((e) => e.state === 'end' && e.reason === 'completed'))
  } finally { env.cleanup() }
})

test('预算硬停：成本超 maxCostUsd → budget_exceeded（先于其它判定）', async () => {
  const env = makeEnv()
  try {
    env.controller.start({ count: 99, prompt: '做事', maxCostUsd: 0.000001 })
    const r = await env.controller.onTurnEnd({ outcome: OUTCOME(10, 20) })
    assert.equal(r.action, 'stop')
    const st = env.controller.status()
    assert.equal(st.status, 'budget_exceeded')
    assert.ok(st.costUsd > 0)
    assert.ok(env.events.some((e) => e.state === 'end' && e.reason === 'budget_exceeded'))
  } finally { env.cleanup() }
})

test('无进展连续 N 轮 → awaiting_approval + 注入反思（不静默烧钱）', async () => {
  const injected = []
  const env = makeEnv({ PONOS_LOOP_NOPROGRESS_N: '2' })
  try {
    env.controller.engine.queueNext = (c) => injected.push(String(c))
    env.controller.start({ count: 99, prompt: '做事' })
    // 四轮完全相同 outcome（同名工具同路径同错误）→ 指纹不变 → streak 增长
    const same = () => OUTCOME(10, 20, { toolDigest: [{ name: 'Bash', path: 'x', isError: true, errorText: 'E1' }] })
    await env.controller.onTurnEnd({ outcome: same() })
    const r = await env.controller.onTurnEnd({ outcome: same() })
    assert.equal(r.action, 'stop')
    const st = env.controller.status()
    assert.equal(st.status, 'awaiting_approval')
    assert.equal(st.pendingApproval.kind, 'no_progress')
    assert.ok(injected.some((t) => /无实质进展|换策略|阻塞/.test(t)), '应注入反思指令')
  } finally { env.cleanup() }
})

test('pause/resume/stop 状态迁移 + 事件', async () => {
  const env = makeEnv()
  try {
    env.controller.start({ count: 5, prompt: '做事' })
    env.controller.pause()
    assert.equal(env.controller.status().status, 'pausing')
    await env.controller.onTurnEnd({ outcome: OUTCOME() })
    assert.equal(env.controller.status().status, 'paused')
    assert.equal((await env.controller.onTurnEnd({ outcome: OUTCOME() })).action, 'wait', 'paused 不推进')
    env.controller.resume()
    assert.equal(env.controller.status().status, 'running')
    env.controller.stop('用户停止')
    assert.equal(env.controller.status().status, 'cancelled')
    assert.equal(env.controller.isActive(), false)
    assert.ok(env.events.some((e) => e.state === 'end' && e.reason === 'cancelled'))
  } finally { env.cleanup() }
})

test('doneWhen 验真通过 → verify_hit（经注入的 verify 依赖）', async () => {
  const env = makeEnv()
  try {
    env.controller.start({ count: 99, prompt: '做事', doneWhen: [{ type: 'cmd', run: 'pytest x' }] })
    env.controller.__setVerifyForTest(async () => ({ passed: true, results: [{ type: 'cmd', run: 'pytest x', ok: true }], reason: 'ok' }))
    const r = await env.controller.onTurnEnd({ outcome: OUTCOME() })
    assert.equal(r.action, 'stop')
    assert.equal(env.controller.status().endReason, 'verify_hit')
  } finally { env.cleanup() }
})

test('doneWhen 未通过 → 继续下一轮且 iter 帧带 verify 摘要', async () => {
  const env = makeEnv()
  try {
    env.controller.start({ count: 99, prompt: '做事', doneWhen: [{ type: 'cmd', run: 'pytest x' }] })
    env.controller.__setVerifyForTest(async () => ({ passed: false, results: [{ type: 'cmd', run: 'pytest x', ok: false }], reason: 'failed' }))
    const r = await env.controller.onTurnEnd({ outcome: OUTCOME() })
    assert.equal(r.action, 'next')
    const iter = env.events.filter((e) => e.state === 'iter').at(-1)
    assert.equal(iter.verify.passed, false)
    assert.equal(iter.verify.results[0].run, 'pytest x')
  } finally { env.cleanup() }
})

test('持久化 round-trip：新控制器 load 恢复 running 状态', async () => {
  const env = makeEnv()
  try {
    env.controller.start({ count: 5, prompt: '做事', goal: 'G', everyMs: 1000 })
    await env.controller.onTurnEnd({ outcome: OUTCOME() })
    const before = env.controller.status()
    assert.equal(before.index, 1)
    // 同一 configDir/sessionId 建新控制器（模拟进程重启）
    const c2 = createLoopController({
      wire: { loop: () => {}, warning: () => {}, system: () => {} },
      engine: { queueNext: () => {}, judgeUntil: async () => ({ done: false }) },
      store: null, configDir: env.configDir, sessionId: 'sess-1', cwd: env.dir, env: {},
    })
    const loaded = c2.load()
    assert.equal(loaded, true)
    assert.equal(c2.status().status, 'running')
    assert.equal(c2.status().index, 1)
    assert.equal(c2.status().goal, 'G')
    assert.equal(c2.status().everyMs, 1000)
  } finally { env.cleanup() }
})

test('持久化文件损坏 → load 返回 false 且按新 loop 处理（不抛）', async () => {
  const env = makeEnv()
  try {
    mkdirSync(join(env.configDir, 'loop'), { recursive: true })
    writeFileSync(env.file, '{broken json')
    assert.equal(env.controller.load(), false)
    assert.equal(env.controller.status().status, 'idle')
  } finally { env.cleanup() }
})

test('已终结 loop 的 load → 不重启（返回 false）', async () => {
  const env = makeEnv()
  try {
    env.controller.start({ count: 1, prompt: '做事' })
    await env.controller.onTurnEnd({ outcome: OUTCOME() }) // → done
    const c2 = createLoopController({
      wire: { loop: () => {}, warning: () => {}, system: () => {} },
      engine: { queueNext: () => {}, judgeUntil: async () => ({ done: false }) },
      store: null, configDir: env.configDir, sessionId: 'sess-1', cwd: env.dir, env: {},
    })
    assert.equal(c2.load(), false)
  } finally { env.cleanup() }
})

test('inject → 追加注入并调 engine.queueNext；budget 热更新生效', async () => {
  const injected = []
  const env = makeEnv()
  try {
    env.controller.engine.queueNext = (c) => injected.push(String(c))
    env.controller.start({ count: 5, prompt: '做事' })
    env.controller.inject('改用 v2 接口')
    assert.deepEqual(env.controller.status().injections, ['改用 v2 接口'])
    assert.deepEqual(injected, ['改用 v2 接口'])
    env.controller.setBudget({ maxCostUsd: 1.5 })
    assert.equal(env.controller.status().budget.maxCostUsd, 1.5)
  } finally { env.cleanup() }
})

test('replay/memory 文本回执可用', async () => {
  const env = makeEnv()
  try {
    env.controller.start({ count: 3, prompt: '做事' })
    await env.controller.onTurnEnd({ outcome: OUTCOME() })
    assert.match(env.controller.replay(5), /#1/)
    assert.match(env.controller.memory(), /loop/i)
  } finally { env.cleanup() }
})
