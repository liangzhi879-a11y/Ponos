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

// 本计划（Phase 1）新增用例的共用夹具：返回可控的 controller + 路径 + 事件收集器。
// 与既有 makeEnv() 并存，不改动既有夹具与既有断言（零回归）。
// @param {object} env 环境变量（如 PONOS_LOOP_NOPROGRESS_N / 价格 / 复活上限）
// @param {object} [extra] 额外注入 createLoopController 的字段（如 prices / engine.tools）
function mkLoop(env = {}, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-loop-ctl-'))
  const configDir = join(dir, 'home')
  mkdirSync(configDir, { recursive: true })
  const events = []
  const engine = {
    queueNext: () => {},
    judgeUntil: async () => ({ done: false, reason: '' }),
    ...(extra.engine || {}),
  }
  const controller = createLoopController({
    wire: { loop: (state, data = {}) => events.push({ state, ...data }), warning: () => {}, system: () => {} },
    engine,
    store: null, configDir, sessionId: 'sess-1', cwd: dir, env,
    ...extra,
  })
  return { controller, engine, configDir, dir, events }
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

// GUI 排程卡走 `/loop --every 5m <任务>`（无 --goal）→ 面板"目标"行需回落显示任务文本，
// 否则 start 帧只带 goal、前端看不到任何目标，表现为"UI 没变化/面板没内容"。
test('start 帧回传 prompt（间隔式无 --goal 时前端仍能显示目标）', async () => {
  const env = makeEnv()
  try {
    env.controller.start({ count: null, everyMs: 300_000, prompt: '检查磁盘' })
    const start = env.events.find((e) => e.state === 'start')
    assert.ok(start, '应发 start 帧')
    assert.equal(start.prompt, '检查磁盘')
    assert.equal(start.goal, '', '未给 --goal 时 goal 为空，依赖 prompt 回落')
    assert.equal(start.everyMs, 300_000)
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

// P1-2：注入的 prices 生效，且 priceSource 落盘 + 随帧上报（只增字段）。
test('注入 prices 覆盖 env 默认并落盘 priceSource', async () => {
  const { controller, events, configDir } = mkLoop(
    { PONOS_PRICE_PER_M_INPUT: '0.2', PONOS_PRICE_PER_M_OUTPUT: '1.2' },
    { prices: { pricePerMInput: 10, pricePerMOutput: 20, cacheReadRatio: 0.5, source: 'provider' } },
  )
  controller.start({ prompt: 'x', count: 2 })
  await controller.onTurnEnd({ outcome: { usage: { input_tokens: 1e6, output_tokens: 1e6 }, toolDigest: [] } })
  assert.equal(controller.status().costUsd, 30) // 1e6/1e6 tokens × 10/20 USD per M
  assert.equal(controller.status().priceSource, 'provider')
  const st = JSON.parse(readFileSync(join(configDir, 'loop', 'sess-1.json'), 'utf-8'))
  assert.equal(st.priceSource, 'provider')
  const startFrame = events.find((e) => e.state === 'start' && e.priceSource)
  assert.equal(startFrame.priceSource, 'provider')
})

// 鉴别力（T2-FIX）：原用例取的 env 值（0.2/1.2）恰好等于硬编码默认 ⇒ 把 env 兜底整体
// 换成硬编码（等价于"env 被忽略"）用例仍全绿，无鉴别力。改用与硬编码默认**不同**的 env 值，
// 三个字段全覆盖（in/out/cacheReadRatio），且取二进制可精确表示的数（0.5/4/0.5）避免浮点抖动。
test('未注入 prices 时回落 env 兜底（值与硬编码默认不同），source=estimate', async () => {
  const { controller } = mkLoop({
    PONOS_PRICE_PER_M_INPUT: '0.5', PONOS_PRICE_PER_M_OUTPUT: '4', PONOS_CACHE_READ_RATIO: '0.5',
  })
  controller.start({ prompt: 'x', count: 2 })
  await controller.onTurnEnd({
    outcome: {
      usage: { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6 },
      toolDigest: [],
    },
  })
  // 0.5（in）+ 4（out）+ 1×0.5×0.5（cache_read）= 4.75；若 env 被忽略 → 0.2+1.2+0.02 ≈ 1.42
  assert.equal(controller.status().costUsd, 4.75)
  assert.equal(controller.status().priceSource, 'estimate')
})

// T2-FIX 缺陷 1：注入的 prices 缺字段时不得采纳（原先只校验 pricePerMInput）——否则
// costUsd = NaN ⇒ 帧上 costUsd = null、落盘 null，且 `NaN > maxCostUsd` 恒 false ⇒ 预算硬停静默失效。
test('注入 prices 缺字段 → 整体回落 env 兜底，costUsd 有限且预算硬停仍生效', async () => {
  const { controller, events, configDir } = mkLoop(
    { PONOS_PRICE_PER_M_INPUT: '0.5', PONOS_PRICE_PER_M_OUTPUT: '2' },
    { prices: { pricePerMInput: 10, source: 'provider' } }, // 缺 pricePerMOutput / cacheReadRatio
  )
  controller.start({ prompt: 'x', maxCostUsd: 1 })
  await controller.onTurnEnd({
    outcome: { usage: { input_tokens: 1e6, output_tokens: 1e6 }, toolDigest: [] },
  })
  const st = controller.status()
  assert.ok(Number.isFinite(st.costUsd), `costUsd 必须有限（实际 ${st.costUsd}）`)
  // 「整体回落」而非混合：若把注入的 input=10 与 env 的 output=2 混用会得 12，若保留 NaN 则得 NaN
  assert.equal(st.costUsd, 2.5) // 1e6/1e6 × 0.5（in）+ 1e6/1e6 × 2（out）
  // 预算硬停必须真的触发（NaN 会让它永不触发 = 钱数不设上限）
  assert.equal(st.status, 'budget_exceeded')
  assert.equal(st.endReason, 'budget_exceeded')
  assert.equal(events.find((e) => e.state === 'end').reason, 'budget_exceeded')
  // 落盘数字也不能是 null（GUI/主管读盘会看到"没有花费"）
  const disk = JSON.parse(readFileSync(join(configDir, 'loop', 'sess-1.json'), 'utf-8'))
  assert.ok(Number.isFinite(disk.costUsd), `落盘 costUsd 必须有限（实际 ${disk.costUsd}）`)
})

// T2-FIX 缺陷 2：priceSource 与价字段同源判定 —— 只声明 source 而无有效价时不得标 'provider'
//（否则 UI 标"provider 价"而数字是估算值，属假精度误导）。
test('priceSource 与实算单价同源：无效价时忽略 source 标签，有效价才采纳', async () => {
  // ① 只给 source、无任何价格字段 → 必须回落 estimate
  const a = mkLoop({}, { prices: { source: 'provider' } })
  a.controller.start({ prompt: 'x', count: 2 })
  assert.equal(a.controller.status().priceSource, 'estimate')
  assert.equal(a.events.find((e) => e.state === 'start').priceSource, 'estimate')
  // ② 只给部分价格字段（校验不过）→ 同样不得标 provider
  const b = mkLoop({}, { prices: { pricePerMInput: 1, source: 'builtin' } })
  b.controller.start({ prompt: 'x', count: 2 })
  assert.equal(b.controller.status().priceSource, 'estimate')
  // ③ 三字段齐备 → 采纳注入的 source（含内置价表来源）
  const c = mkLoop({}, { prices: { pricePerMInput: 1, pricePerMOutput: 2, cacheReadRatio: 0.1, source: 'builtin' } })
  c.controller.start({ prompt: 'x', count: 2 })
  assert.equal(c.controller.status().priceSource, 'builtin')
})

// T2-FIX 缺陷 3：load() 合并后必须刷新 priceSource —— 否则 `{...freshState(), ...parsed}` 让磁盘
// 旧值覆盖构造解析值，resume 后首轮标签（provider）与实际单价（按新注入价重算）错配。
test('load() 刷新 priceSource：resume 后标签与新注入单价同源，且 resumed start 帧带该键', async () => {
  // run1：以 provider 价落盘
  const run1 = mkLoop({}, { prices: { pricePerMInput: 3, pricePerMOutput: 15, cacheReadRatio: 0.1, source: 'provider' } })
  run1.controller.start({ prompt: 'x', count: 5 })
  await run1.controller.onTurnEnd({ outcome: { usage: { input_tokens: 1e6, output_tokens: 0 }, toolDigest: [] } })
  assert.equal(JSON.parse(readFileSync(join(run1.configDir, 'loop', 'sess-1.json'), 'utf-8')).priceSource, 'provider')

  // run2：同一状态文件，注入 estimate 价（0.5/2）并 load()（= --resume）
  const events2 = []
  const c2 = createLoopController({
    wire: { loop: (state, data = {}) => events2.push({ state, ...data }), warning: () => {}, system: () => {} },
    engine: { queueNext: () => {}, judgeUntil: async () => ({ done: false, reason: '' }) },
    store: null, configDir: run1.configDir, sessionId: 'sess-1', cwd: run1.dir, env: {},
    prices: { pricePerMInput: 0.5, pricePerMOutput: 2, cacheReadRatio: 0.1, source: 'estimate' },
  })
  assert.equal(c2.load(), true)
  // 标签必须与本次进程采用的单价同源（旧代码：磁盘值 'provider' 覆盖 → 错配）
  assert.equal(c2.status().priceSource, 'estimate')
  const startFrame = events2.find((e) => e.state === 'start' && e.resumed === true)
  assert.ok(startFrame, 'resume 必须发 resumed start 帧')
  assert.ok('priceSource' in startFrame, 'resumed start 帧必须带 priceSource 键')
  assert.equal(startFrame.priceSource, 'estimate')
  // 且 costUsd 确实按新注入价重算（run1 累计 1e6 input → 再 1e6 ⇒ 2e6/1e6 × 0.5 = 1）
  await c2.onTurnEnd({ outcome: { usage: { input_tokens: 1e6, output_tokens: 0 }, toolDigest: [] } })
  assert.equal(c2.status().costUsd, 1)
  assert.equal(c2.status().priceSource, 'estimate')
})

// P1-4：指纹纳入内容签名 —— 同路径内容变更算进展，同路径同内容才算无进展。
test('同路径内容变更 → 不计无进展（误报修正）', async () => {
  const { controller } = mkLoop({ PONOS_LOOP_NOPROGRESS_N: '3' })
  controller.start({ prompt: 'x', count: 10 })
  // 三轮都写同一个文件，但 sig 各不相同 = 内容在变 = 有进展
  for (const sig of ['a1', 'b2', 'c3']) {
    await controller.onTurnEnd({ outcome: { usage: {}, toolDigest: [{ name: 'Write', path: 'f.txt', isError: false, sig }] } })
  }
  assert.equal(controller.status().noProgress.streak, 1)
  assert.equal(controller.status().status, 'running')
})

test('同路径同内容 → 计无进展', async () => {
  const { controller } = mkLoop({ PONOS_LOOP_NOPROGRESS_N: '3' })
  controller.start({ prompt: 'x', count: 10 })
  for (let i = 0; i < 3; i++) {
    await controller.onTurnEnd({ outcome: { usage: {}, toolDigest: [{ name: 'Write', path: 'f.txt', isError: false, sig: 'same' }] } })
  }
  assert.equal(controller.status().noProgress.streak, 3)
  assert.equal(controller.status().status, 'awaiting_approval')
})

test('重复读同一文件 → 计无进展（结果签名相同）', async () => {
  const { controller } = mkLoop({ PONOS_LOOP_NOPROGRESS_N: '3' })
  controller.start({ prompt: 'x', count: 10 })
  for (let i = 0; i < 3; i++) {
    await controller.onTurnEnd({ outcome: { usage: {}, toolDigest: [{ name: 'Read', path: 'f.txt', isError: false, sig: 'r:1200' }] } })
  }
  assert.equal(controller.status().noProgress.streak, 3)
})

test('重复相同错误 → 计无进展', async () => {
  const { controller } = mkLoop({ PONOS_LOOP_NOPROGRESS_N: '3' })
  controller.start({ prompt: 'x', count: 10 })
  for (let i = 0; i < 3; i++) {
    await controller.onTurnEnd({ outcome: { usage: {}, toolDigest: [{ name: 'Bash', path: '', isError: true, errorText: 'boom' }] } })
  }
  assert.equal(controller.status().noProgress.streak, 3)
})

test('缺 sig 字段（旧内核帧）→ 回落旧行为（同路径即无进展）', async () => {
  const { controller } = mkLoop({ PONOS_LOOP_NOPROGRESS_N: '3' })
  controller.start({ prompt: 'x', count: 10 })
  for (let i = 0; i < 3; i++) {
    await controller.onTurnEnd({ outcome: { usage: {}, toolDigest: [{ name: 'Write', path: 'f.txt', isError: false }] } })
  }
  assert.equal(controller.status().noProgress.streak, 3)
})

// ★ 回归（2026-11-01 真 bug）：指纹"为空"的语义必须是**空串**。
//   原实现总返回 `${files}|${errs}`（最少 `'|'`）⇒ "本轮无工具调用"被判成"与前一轮同指纹"，
//   于是 3 个纯文本轮就被升级成 awaiting_approval（等人工审批），用户表现为"没干什么就被挂起"。
test('无工具轮 → 不计无进展（指纹为空，不升级待审批）', async () => {
  const { controller } = mkLoop({ PONOS_LOOP_NOPROGRESS_N: '3' })
  controller.start({ prompt: 'x', count: 10 })
  for (let i = 0; i < 5; i++) {
    await controller.onTurnEnd({ outcome: { usage: {}, toolDigest: [] } })
  }
  assert.equal(controller.status().noProgress.streak, 0, '空工具轮不得累加无进展')
  assert.equal(controller.status().status, 'running', '空工具轮不得升级为待审批')
})

// ★ 回归（同一次真 bug 的另一半）：Bash/Agent 等**无 path** 的执行类工具参与过指纹过滤，
//   于是"连续三轮只跑 Bash"与"三轮空转"同形。现在签名侧给它们补了输入哈希，必须算进展。
test('只跑 Bash 且命令各不相同 → 算进展（有 path 过滤时代码会把它们全丢掉）', async () => {
  const { controller } = mkLoop({ PONOS_LOOP_NOPROGRESS_N: '3' })
  controller.start({ prompt: 'x', count: 10 })
  for (const sig of ['x:aaa', 'x:bbb', 'x:ccc']) {
    await controller.onTurnEnd({ outcome: { usage: {}, toolDigest: [{ name: 'Bash', path: '', isError: false, sig }] } })
  }
  assert.equal(controller.status().noProgress.streak, 1)
  assert.equal(controller.status().status, 'running')
})

// —— P1-1 前提：nextRunAt / aliveAt 落盘，供 bridge 主管判定「下次该跑的时刻」——
// 语义（spec §3.2）：nextRunAt = 0/缺失 ⇒ 无待触发（不该被主管唤醒：已完成/已暂停/
// 待审批/正在跑）；只有 status==='running' 且处于「等下次触发」窗口才写未来时间戳。

test('返回 next 时落盘 nextRunAt（含 --every 延迟）', async () => {
  const { controller, configDir } = mkLoop({})
  controller.start({ prompt: 'x', count: 5, everyMs: 60_000 })
  const before = Date.now()
  const d = await controller.onTurnEnd({ outcome: { usage: {}, toolDigest: [] } })
  assert.equal(d.action, 'next')
  const st = JSON.parse(readFileSync(join(configDir, 'loop', 'sess-1.json'), 'utf-8'))
  assert.ok(st.nextRunAt >= before + 60_000, 'nextRunAt 应约为 now + everyMs')
  assert.ok(st.nextRunAt <= Date.now() + 60_000 + 2000)
})

test('--every 为 0 → nextRunAt 约等于当前时刻', async () => {
  const { controller, configDir } = mkLoop({})
  controller.start({ prompt: 'x', count: 5 })
  const before = Date.now()
  await controller.onTurnEnd({ outcome: { usage: {}, toolDigest: [] } })
  const st = JSON.parse(readFileSync(join(configDir, 'loop', 'sess-1.json'), 'utf-8'))
  assert.ok(st.nextRunAt >= before && st.nextRunAt <= Date.now() + 2000)
})

test('收尾（次数耗尽）→ nextRunAt 清零且 status 终态', async () => {
  const { controller, configDir } = mkLoop({})
  controller.start({ prompt: 'x', count: 1 })
  const d = await controller.onTurnEnd({ outcome: { usage: {}, toolDigest: [] } })
  assert.equal(d.action, 'stop')
  const st = JSON.parse(readFileSync(join(configDir, 'loop', 'sess-1.json'), 'utf-8'))
  assert.equal(st.status, 'done')
  assert.equal(st.nextRunAt, 0)
})

test('aliveAt 随每次 persist 刷新', async () => {
  const { controller, configDir } = mkLoop({})
  controller.start({ prompt: 'x', count: 5 })
  const st1 = JSON.parse(readFileSync(join(configDir, 'loop', 'sess-1.json'), 'utf-8'))
  assert.ok(typeof st1.aliveAt === 'string' && st1.aliveAt.length > 0)
  await new Promise((r) => setTimeout(r, 5))
  await controller.onTurnEnd({ outcome: { usage: {}, toolDigest: [] } })
  const st2 = JSON.parse(readFileSync(join(configDir, 'loop', 'sess-1.json'), 'utf-8'))
  assert.ok(st2.aliveAt >= st1.aliveAt)
})

test('旧状态文件（无 nextRunAt）加载后字段补默认，不误判为待触发', () => {
  const { controller, configDir } = mkLoop({})
  const dir = join(configDir, 'loop')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'sess-1.json'), JSON.stringify({
    version: 1, status: 'running', prompt: 'x', index: 1, count: 5,
    budget: { maxCostUsd: 0, maxSteps: 0, maxWallMs: 0 },
    noProgress: { streak: 1, lastFingerprint: '', threshold: 3 },
    history: [], usageAcc: {}, costUsd: 0, steps: 0, injections: [],
  }), 'utf-8')
  assert.equal(controller.load(), true)
  assert.equal(controller.status().nextRunAt, 0)
})

// 防双投递（spec §4.3）：一轮**开始执行**时等待窗口即结束 —— cli 在投递载荷前调
// markTurnStart() 把 nextRunAt 清零。否则磁盘上出现「正在跑 + 已到点」的组合，
// bridge 主管会据此把内核当成挂了的循环来唤醒 → 与内核双投递连跑两轮。
test('开始执行一轮（markTurnStart）→ nextRunAt 清零，不留已到点时间戳', async () => {
  const { controller, configDir } = mkLoop({})
  const read = () => JSON.parse(readFileSync(join(configDir, 'loop', 'sess-1.json'), 'utf-8'))
  controller.start({ prompt: 'x', count: 5, everyMs: 60_000 })
  await controller.onTurnEnd({ outcome: { usage: {}, toolDigest: [] } })
  assert.ok(read().nextRunAt > Date.now(), '等待窗口内应为未来时间戳')
  controller.markTurnStart()
  const st = read()
  assert.equal(st.nextRunAt, 0, '执行期不得留已到点时间戳')
  assert.equal(st.status, 'running', '只是结束等待窗口，不改状态机')
})

// P1-5：--until 判定移入控制器（原先在 cli 侧），终止逻辑单点收口。
test('--until 达成 → until_hit 收尾，且发第二条只含 judged 字段的 iter 帧', async () => {
  const events = []
  const dir = mkdtempSync(join(tmpdir(), 'ponos-loop-'))
  const configDir = join(dir, 'home')
  mkdirSync(configDir, { recursive: true })
  const c = createLoopController({
    wire: { loop: (state, data = {}) => events.push({ state, ...data }), warning: () => {}, system: () => {} },
    engine: { queueNext: () => {}, judgeUntil: async () => ({ done: true, reason: '已达目标' }) },
    store: null, configDir, sessionId: 'sess-u', cwd: dir, env: {},
  })
  c.start({ prompt: 'x', count: 5, until: '测试通过' })
  const d = await c.onTurnEnd({ outcome: { usage: {}, toolDigest: [] } })
  assert.equal(d.action, 'stop')
  assert.equal(d.rationale, 'until_hit')
  assert.equal(c.status().endReason, 'until_hit')
  assert.equal(c.status().nextRunAt, 0)
  const judged = events.filter((e) => e.state === 'iter' && 'judged' in e)
  assert.equal(judged.length, 1)
  assert.equal(judged[0].judged, true)
  assert.equal(judged[0].reason, '已达目标')
  assert.equal(judged[0].error, false)
  assert.equal(judged[0].steps, undefined) // 旧帧不含 steps（零回归锁③：形状逐字保留）
  rmSync(dir, { recursive: true, force: true })
})

test('--until 判定异常 → judge_error 收尾（不无限重试）', async () => {
  const { controller, engine } = mkLoop()
  engine.judgeUntil = async () => { throw new Error('boom') }
  controller.start({ prompt: 'x', count: 5, until: 'x' })
  const d = await controller.onTurnEnd({ outcome: { usage: {}, toolDigest: [] } })
  assert.equal(d.rationale, 'judge_error')
  assert.equal(controller.status().endReason, 'judge_error')
})

test('--until 未达成 → 正常继续下一轮', async () => {
  const { controller, engine } = mkLoop()
  engine.judgeUntil = async () => ({ done: false, reason: '还没好' })
  controller.start({ prompt: 'x', count: 5, until: 'x' })
  const d = await controller.onTurnEnd({ outcome: { usage: {}, toolDigest: [] } })
  assert.equal(d.action, 'next')
  assert.ok(controller.status().nextRunAt > 0)
})

test('doneWhen 与 until 同时存在 → doneWhen 优先（验证通过即收尾，不判 until）', async () => {
  let judgedCount = 0
  // doneWhen 走命令式验真：复用五段式管线，经 engine.tools.run（此处注入成功结果）。
  // 注 1：spec 必须带 type:'cmd' —— 验真器对未知条件类型 fail-closed（与 --done 的产出形状一致）。
  // 注 2：两个注入点都挂在同一个 engine 实例上（mkLoop 的 engine 即控制器持有的实例），
  //       否则 judgedCount 只是"控制器压根没拿到判词函数"的假绿。
  const { controller, engine } = mkLoop()
  engine.tools = { run: async () => ({ isError: false }) }
  engine.judgeUntil = async () => { judgedCount++; return { done: true } }
  controller.start({ prompt: 'x', count: 5, until: 'x', doneWhen: [{ type: 'cmd', run: 'true' }] })
  const d = await controller.onTurnEnd({ outcome: { usage: {}, toolDigest: [] } })
  assert.equal(d.rationale, 'verify_hit')
  assert.equal(judgedCount, 0, 'doneWhen 通过后不得再调 until 判词')
})

// 宽幅审查（M-2 加固补全）：T2-FIX 的守卫用 `Number.isFinite(Number(x))`，但 `Number(null) === 0`
// 且 `isFinite(0) === true` ⇒ 注入全 null 的价会被判"合法"，单价全 0 ⇒ costUsd 恒 0 ⇒
// `0 > maxCostUsd` 恒 false ⇒ 预算硬停在**加固之后**依然能静默失效。故须拒绝 null/0。
test('M-2 注入全 null 单价 → 不得当作合法 0 价，整体回落 env 兜底', async () => {
  const { controller, events } = mkLoop(
    { PONOS_PRICE_PER_M_INPUT: '0.5', PONOS_PRICE_PER_M_OUTPUT: '2' },
    { prices: { pricePerMInput: null, pricePerMOutput: null, cacheReadRatio: null, source: 'provider' } },
  )
  controller.start({ prompt: 'x', maxCostUsd: 1 })
  await controller.onTurnEnd({ outcome: { usage: { input_tokens: 1e6, output_tokens: 1e6 }, toolDigest: [] } })
  const st = controller.status()
  assert.ok(Number.isFinite(st.costUsd), `costUsd 必须有限（实际 ${st.costUsd}）`)
  assert.equal(st.costUsd, 2.5, '必须整体回落 env（0.5/2），不得被 null→0 覆盖')
  assert.equal(st.status, 'budget_exceeded', '预算硬停必须仍能触发（0 单价会让它永不触发）')
  assert.equal(st.priceSource, 'estimate', '未采纳注入价时不得标 provider')
  assert.equal(events.find((e) => e.state === 'end').reason, 'budget_exceeded')
})

test('M-2 注入 0 单价 → 同样视为未配置（0 成本会让预算硬停失效）', async () => {
  const { controller } = mkLoop(
    { PONOS_PRICE_PER_M_INPUT: '0.5', PONOS_PRICE_PER_M_OUTPUT: '2' },
    { prices: { pricePerMInput: 0, pricePerMOutput: 0, cacheReadRatio: 0, source: 'provider' } },
  )
  controller.start({ prompt: 'x', maxCostUsd: 1 })
  await controller.onTurnEnd({ outcome: { usage: { input_tokens: 1e6, output_tokens: 1e6 }, toolDigest: [] } })
  assert.equal(controller.status().costUsd, 2.5, '0 单价的注入必须整体回落 env')
})

test('M-2 守卫不得过严：合法注入仍被采纳，且 cacheReadRatio 允许为 0', async () => {
  const { controller } = mkLoop({}, {
    prices: { pricePerMInput: 3, pricePerMOutput: 15, cacheReadRatio: 0, source: 'provider' },
  })
  controller.start({ prompt: 'x', count: 3 })
  const st = controller.status()
  assert.equal(st.priceSource, 'provider', '三字段合法时必须采纳注入价（含来源）')
  await controller.onTurnEnd({ outcome: { usage: { input_tokens: 1e6, output_tokens: 1e6 }, toolDigest: [] } })
  // 3 + 15 = 18；cacheReadRatio=0 表示缓存读不折扣（0 是合法语义，不得被当作"未配置"）
  assert.equal(controller.status().costUsd, 18)
})

// 宽幅审查（M-3）：`nextRunAt` 的"不推进 ⇔ 0"不变式必须钉在**生产者侧**。
// 暂停/待审批这三条分支此前只 persist() 不清零，安全仅靠消费者的 `status !== 'running'` 守卫兜住；
// 一旦后续出现只看 nextRunAt 的消费者（Phase 2/3 的全局循环列表、改间隔热操作），
// 就会把"已暂停"或"等人审批"的循环判成待触发 —— 后者还会**绕过审批门**。
test('M-3 暂停落定（paused）→ nextRunAt 必须清零（内存与落盘一致）', async () => {
  const { controller, configDir } = mkLoop()
  controller.start({ prompt: 'x', count: 5, everyMs: 60_000 })
  await controller.onTurnEnd({ outcome: { usage: {}, toolDigest: [] } })
  assert.ok(controller.status().nextRunAt > 0, '先证明确实处于待触发窗口（否则本用例无鉴别力）')

  controller.pause()
  await controller.onTurnEnd({ outcome: { usage: {}, toolDigest: [] } })
  assert.equal(controller.status().status, 'paused')
  assert.equal(controller.status().nextRunAt, 0, '暂停后不得残留"未来要触发"的时间戳')
  const disk = JSON.parse(readFileSync(join(configDir, 'loop', 'sess-1.json'), 'utf-8'))
  assert.equal(disk.nextRunAt, 0, '落盘也必须清零（主管/回收宽限读的是磁盘）')
})

test('M-3 待审批（awaiting_approval）→ nextRunAt 必须清零，不得被主管当作待触发唤醒', async () => {
  // 用「无进展」升级为待审批这条真实路径触发（连续 3 轮**同指纹** ⇒ 第 3 轮升级）。
  // ★ 触发用的指纹必须是"真的在重复同一件无进展的事"（同工具/同路径/同签名），
  //   不能用 `toolDigest: []`：空工具轮按语义**不计**无进展（纯文本轮无法判定是否实质推进，
  //   见 loop.mjs#fingerprintOf 与同文件"无工具轮不升级"用例）。
  // 必须带 everyMs：无 --every 的按次数循环 delayMs 本就是 0，nextRunAt 恒 0，
  // 那样本用例会**空过**（无法区分"修了"与"没修"）。everyMs 让它先真的进入待触发窗口。
  const sameNoProgress = { usage: {}, toolDigest: [{ name: 'Write', path: 'f.txt', isError: false, sig: 'same' }] }
  const { controller, configDir } = mkLoop({ PONOS_LOOP_NOPROGRESS_N: '3' })
  controller.start({ prompt: 'x', count: 9, everyMs: 60_000 })
  await controller.onTurnEnd({ outcome: sameNoProgress })
  assert.ok(controller.status().nextRunAt > 0, '先证明确实处于待触发窗口（否则本用例无鉴别力）')

  await controller.onTurnEnd({ outcome: sameNoProgress })
  await controller.onTurnEnd({ outcome: sameNoProgress })
  const st = controller.status()
  assert.equal(st.status, 'awaiting_approval', `应已升级为待审批（实际 ${st.status}）`)
  assert.equal(st.nextRunAt, 0, '待审批时不得残留待触发时间戳（否则主管可能唤醒它 = 绕过审批门）')
  const disk = JSON.parse(readFileSync(join(configDir, 'loop', 'sess-1.json'), 'utf-8'))
  assert.equal(disk.nextRunAt, 0)
})
