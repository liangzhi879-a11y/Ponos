// K3 线协议断言：档位 / 思考策略**真的**换了请求字段（真 HTTP 层，非 mock）
// ---------------------------------------------------------------------------
// 为什么不用 PONOS_MOCK_API：mock 在 anthropicStream 之前短路，请求体根本不会构造，
// 断言不了「请求里到底带了什么」——而本任务要修的恰是「用户档位从未发出去」这类
// 静默短路（bridge 注入 THINKING_ENABLED=1 后 effortParam 直接 return，用户把档位
// 从 low 拉到 max 线上请求一字未变）。故直连本地 http server 发真实请求并抓 body，
// 范式见 kernel-tests/api-empty-stream.test.mjs。
delete process.env.PONOS_MOCK_API
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { effortDroppedNotice, effortParam, streamMessages } from '../kernel/api.mjs'
import { createCompactor } from '../kernel/compact.mjs'
import { estimateHistory, estimateMessage, estimateRequest } from '../kernel/context.mjs'
import { createSessionStore } from '../kernel/session.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MSG = [{ role: 'user', content: 'hi' }]

let captured = []
async function withServer(fn) {
  captured = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      try { captured.push(JSON.parse(raw)) } catch { captured.push({ __unparsable: raw.slice(0, 200) }) }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const sse = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`)
      sse({ type: 'message_start', message: { role: 'assistant', content: [], usage: { input_tokens: 2, output_tokens: 0 } } })
      sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })
      sse({ type: 'content_block_stop', index: 0 })
      sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
      sse({ type: 'message_stop' })
      res.end()
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const saved = { ...process.env }
  try {
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token'
    process.env.ANTHROPIC_MODEL = 'test-model'
    return await fn()
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
    await new Promise((r) => server.close(r))
  }
}

// 发一次真实请求，返回上游收到的那份 body
const ask = async (opts) => {
  for await (const _ of streamMessages({ model: 'test-model', messages: MSG, maxTokens: 16, ...opts })) { /* drain */ }
  const body = captured.at(-1)
  assert.ok(body && !body.__unparsable, `上游未收到可解析的请求体：${JSON.stringify(body)}`)
  return body
}

// 只取两个旋钮做比较：期望值显式写 undefined ⇒ 断言「该字段完全不存在」
const knobs = (body) => ({ thinking: body.thinking, reasoning_effort: body.reasoning_effort })
const OFF = { thinking: { type: 'disabled' }, reasoning_effort: undefined }
const enabled = (budget) => ({ thinking: { type: 'enabled', budget_tokens: budget }, reasoning_effort: undefined })
const NONE = { thinking: undefined, reasoning_effort: undefined }

// 矩阵：每行 = 一个 (env, 档位) 组合 → 期望真正发出去的两个旋钮
// env 值 null 表示「显式删掉该变量」。①/②/③ 是 effortParam 的优先级编号（见 api.mjs）。
const CASES = [
  { n: '①默认：无档位、无 thinking env → 两个旋钮都不发', env: { PONOS_THINKING_ENABLED: null }, opts: {}, want: NONE },
  { n: '①档位 auto → 不发（模型原生自适应）', env: {}, opts: { reasoningEffort: 'auto' }, want: NONE },
  { n: '①未知档位 medium → 不发（api 层不认识；engine 的 normalizeEffort 已把 medium→high）', env: {}, opts: { reasoningEffort: 'medium' }, want: NONE },
  { n: '③档位 low → reasoning_effort', env: {}, opts: { reasoningEffort: 'low' }, want: { thinking: undefined, reasoning_effort: 'low' } },
  { n: '③档位 max → reasoning_effort', env: {}, opts: { reasoningEffort: 'max' }, want: { thinking: undefined, reasoning_effort: 'max' } },
  { n: '①档位 off → thinking:disabled', env: {}, opts: { reasoningEffort: 'off' }, want: OFF },
  { n: '①thinkingMode=off → thinking:disabled（策略层新入口）', env: {}, opts: { thinkingMode: 'off' }, want: OFF },
  { n: '①thinkingMode=off 压过档位 low（优先级 ① > ③）', env: {}, opts: { thinkingMode: 'off', reasoningEffort: 'low' }, want: OFF },
  { n: '②thinking env → enabled+budget 4096（默认）', env: { PONOS_THINKING_ENABLED: '1' }, opts: {}, want: enabled(4096) },
  { n: '②budget 随 provider 配置下发', env: { PONOS_THINKING_ENABLED: '1', PONOS_THINKING_BUDGET: '2048' }, opts: {}, want: enabled(2048) },
  { n: '②budget 非法值 → 回落 4096（不得发出 NaN）', env: { PONOS_THINKING_ENABLED: '1', PONOS_THINKING_BUDGET: 'abc' }, opts: {}, want: enabled(4096) },
  { n: '②thinking env 下档位 max 仍走 thinking 分支（旧实现静默吃掉，现为显式契约）', env: { PONOS_THINKING_ENABLED: '1' }, opts: { reasoningEffort: 'max' }, want: enabled(4096) },
  { n: '①thinkingMode=off 压过 thinking env（本任务要的降思考杠杆）', env: { PONOS_THINKING_ENABLED: '1' }, opts: { thinkingMode: 'off' }, want: OFF },
  { n: '①thinkingMode=off 同时压过 thinking env 与用户档位', env: { PONOS_THINKING_ENABLED: '1' }, opts: { thinkingMode: 'off', reasoningEffort: 'max' }, want: OFF },
]

test('诊断每进程只落一行，且只对「显式档位被吃掉」说话', () => {
  // 本用例必须**最先**声明：它消费的是模块级一次性标志 effortDiagDone
  const lines = []
  const real = console.error
  console.error = (...a) => { lines.push(a.join(' ')) }
  const dropped = () => lines.filter((l) => l.includes('未随请求发出')).length
  try {
    process.env.PONOS_THINKING_ENABLED = '1'
    process.env.PONOS_THINKING_BUDGET = '2048'
    effortParam(null)            // auto：本就不注入，不算「被吃掉」→ 不提示
    effortParam('auto')
    assert.equal(dropped(), 0, 'auto 档位不应产生提示（否则是误报）')
    effortParam('max')
    assert.equal(dropped(), 1, '显式档位被 thinking 开关吃掉时应落一行')
    assert.ok(lines.some((l) => l.includes('budget_tokens:2048')), '提示应带上实际发出去的 budget')
    effortParam('high')          // 同一进程内不再重复
    effortParam('max')
    assert.equal(dropped(), 1, '每进程只提示一次，避免逐步刷屏')
  } finally {
    console.error = real
    delete process.env.PONOS_THINKING_ENABLED
    delete process.env.PONOS_THINKING_BUDGET
  }
})

test('effortDroppedNotice：纯函数，整张真值表（不受一次性标志影响）', () => {
  const on = { thinkingEnabled: true, budget: 4096 }
  for (const e of ['low', 'high', 'max']) assert.ok(effortDroppedNotice(e, on), `${e} 应提示`)
  for (const e of [null, undefined, 'auto', 'medium', 'off']) {
    assert.equal(effortDroppedNotice(e, on), null, `${e} 不应提示`)
  }
  assert.equal(effortDroppedNotice('max', { thinkingEnabled: false }), null, '未开 thinking 时无话可说')
})

for (const c of CASES) {
  test(`线协议：${c.n}`, async () => {
    for (const [k, v] of Object.entries(c.env)) {
      if (v === null) delete process.env[k]
      else process.env[k] = v
    }
    await withServer(async () => {
      const body = await ask(c.opts)
      assert.deepEqual(knobs(body), c.want)
    })
    for (const [k, v] of Object.entries(c.env)) if (v === null) delete process.env[k]
  })
}

test('不变量：两个旋钮绝不同时出现在同一请求里（同步发会 400）', async () => {
  const bodies = []
  for (const c of CASES) {
    for (const [k, v] of Object.entries(c.env)) {
      if (v === null) delete process.env[k]
      else process.env[k] = v
    }
    await withServer(async () => { bodies.push(await ask(c.opts)) })
  }
  assert.equal(bodies.length, CASES.length)
  for (const b of bodies) {
    assert.ok(!(b.thinking && b.reasoning_effort), `两个旋钮同时出现：${JSON.stringify(knobs(b))}`)
  }
})

test('旋钮之外请求体不变：不同档位只改这两个字段（缓存前缀不被搅动）', async () => {
  const strip = (b) => { const { thinking, reasoning_effort, ...rest } = b; return rest }
  delete process.env.PONOS_THINKING_ENABLED
  delete process.env.PONOS_THINKING_BUDGET
  const a = await withServer(() => ask({}))
  const b = await withServer(() => ask({ reasoningEffort: 'max' }))
  const c = await withServer(() => ask({ reasoningEffort: 'off' }))
  assert.deepEqual(strip(b), strip(a), 'low/high/max 档位不得改动档位以外的任何字段')
  assert.deepEqual(strip(c), strip(a), 'off 档位不得改动档位以外的任何字段')
})

// ---------------------------------------------------------------------------
// 第二层：策略 → 压缩器 → 真实请求体（端到端）
// 判据表（effort-policy.test.mjs）证明"该关"，这里证明"真的关了"——起本地 http server
// 驱动真 compactor，抓它发出的摘要请求。夹具照 kernel-tests/compact-chunked.test.mjs。
// ---------------------------------------------------------------------------
const CJK = '这是一段用于撑满上下文的压缩测试文本内容，包含足够多的汉字来让估算器按中文字符密度计价。'

function makeCompactorEnv({ limit = 32768, turns = 6 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'effort-wire-'))
  const store = createSessionStore({ configDir: dir, cwd: dir, sessionId: 'effort-wire' })
  for (let i = 0; i < turns; i++) {
    store.appendUser(`第 ${i} 轮任务：${CJK.repeat(10)}`)
    store.appendAssistant([{ type: 'text', text: `第 ${i} 轮回答：${CJK.repeat(10)}` }])
  }
  const context = {
    window: limit, thresholdRatio: 0.8, retainRatio: 0.16,
    estimate: ({ system, messages }) => estimateRequest({ system, messages }),
    estimateMessage, estimateHistory,
  }
  const compactor = createCompactor({
    session: store, context, model: 'test-model', maxTokens: 8192,
    wire: { system: () => {}, summary: () => {} },
    health: undefined, signal: undefined, env: process.env, sessionMemoryPath: null,
  })
  return { store, compactor, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// 跑一次真实压缩，返回上游收到的全部请求体（最后一条 = 保真审计）
// expectBodies(r)：要等几条（审计是 fire-and-forget，不进 await 链，必须轮询等它发出）
async function runCompaction({ expectBodies = () => 2, ...envOpts } = {}) {
  const h = makeCompactorEnv(envOpts)
  try {
    let result = null
    await withServer(async () => {
      result = await h.compactor.forceCompact({
        system: 'sys', messages: h.store.deriveMessages(), limit: envOpts.limit ?? 32768,
      })
      assert.equal(result.action, 'summarized', `压缩应落地：${JSON.stringify(result).slice(0, 300)}`)
      const need = expectBodies(result)
      const t0 = Date.now()
      while (captured.length < need && Date.now() - t0 < 5000) await new Promise((r2) => setTimeout(r2, 20))
    })
    return { bodies: [...captured], result }
  } finally { h.cleanup() }
}

test('端到端：策略生效 → 摘要步真的不带思考（provider 开着 thinking 也一样）', async () => {
  delete process.env.PONOS_EFFORT_POLICY // 默认 graded
  process.env.PONOS_THINKING_ENABLED = '1'
  process.env.PONOS_THINKING_BUDGET = '4096'
  try {
    const bodies = (await runCompaction()).bodies
    assert.ok(bodies.length >= 1, '摘要请求必须真的发出去')
    assert.deepEqual(knobs(bodies[0]), {
      thinking: { type: 'disabled' },
      reasoning_effort: undefined,
    }, '摘要/压缩步应显式 thinking:disabled（K3.1 唯一启用点）')
  } finally {
    delete process.env.PONOS_THINKING_ENABLED
    delete process.env.PONOS_THINKING_BUDGET
  }
})

test('端到端：回退开关 PONOS_EFFORT_POLICY=off → 摘要步回到现状（enabled+budget）', async () => {
  process.env.PONOS_EFFORT_POLICY = 'off'
  process.env.PONOS_THINKING_ENABLED = '1'
  process.env.PONOS_THINKING_BUDGET = '4096'
  try {
    const bodies = (await runCompaction()).bodies
    assert.deepEqual(knobs(bodies[0]), enabled(4096), '一键回退：策略不干预，走 provider 思考开关')
  } finally {
    delete process.env.PONOS_EFFORT_POLICY
    delete process.env.PONOS_THINKING_ENABLED
    delete process.env.PONOS_THINKING_BUDGET
  }
})

test('端到端：分块摘要（map-reduce）的每一块也都降思考', async () => {
  // covered 超单块容量时走分块路径（夹具照 compact-chunked.test.mjs：35 轮 ≈29K > 20.5K）。
  // 这条单列，是因为决策漏在分块分支上时**只有这类会话**（小窗口模型 / 大 covered）会继续
  // 思考——单发路径的用例抓不到它（首版就是这么漏的，变异 M2 存活才发现）。
  delete process.env.PONOS_EFFORT_POLICY
  process.env.PONOS_THINKING_ENABLED = '1'
  process.env.PONOS_THINKING_BUDGET = '4096'
  try {
    const { bodies, result } = await runCompaction({
      limit: 32768, turns: 35,
      expectBodies: (r) => r.chunks + 1, // 每块一次摘要调用 + 末尾一次审计
    })
    assert.equal(result.mode, 'chunked', `夹具应走分块路径：${JSON.stringify(result).slice(0, 200)}`)
    assert.ok(result.chunks >= 2, `应分 ≥2 块（实际 ${result.chunks}）`)
    assert.equal(bodies.length, result.chunks + 1, `请求数应 = 块数 + 审计（实际 ${bodies.length}）`)
    for (const [i, b] of bodies.entries()) {
      const want = i === bodies.length - 1 ? enabled(4096) : { thinking: { type: 'disabled' }, reasoning_effort: undefined }
      assert.deepEqual(knobs(b), want, `第 ${i} 次请求（共 ${bodies.length}）旋钮不符`)
    }
  } finally {
    delete process.env.PONOS_THINKING_ENABLED
    delete process.env.PONOS_THINKING_BUDGET
  }
})

test('端到端：保真审计步不受策略影响（抓坏摘要的安全网不得被悄悄削弱）', async () => {
  delete process.env.PONOS_EFFORT_POLICY // graded：摘要步已降
  process.env.PONOS_THINKING_ENABLED = '1'
  process.env.PONOS_THINKING_BUDGET = '4096'
  try {
    const bodies = (await runCompaction()).bodies
    assert.ok(bodies.length >= 2, `应有摘要 + 审计两次请求（实际 ${bodies.length}）`)
    assert.deepEqual(knobs(bodies[0]), { thinking: { type: 'disabled' }, reasoning_effort: undefined })
    assert.deepEqual(knobs(bodies[1]), enabled(4096), '审计步是判断步：必须保留思考')
  } finally {
    delete process.env.PONOS_THINKING_ENABLED
    delete process.env.PONOS_THINKING_BUDGET
  }
})
