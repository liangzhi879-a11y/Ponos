// 三层升级路由层（2026-10-06 spec loop-3layer-upgrade §4 A24）：
// parseRouterReply 严格校验/钳制 · classifyLoopMode 重试与兜底（超时/网络/坏 JSON）·
// 模型解析顺序 · 主动标记 harvest · 提示合并 · 引擎级接线（auto 路由 → 应用/兜底）+ 零回归。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.PONOS_MOCK_API = '1'

const {
  DEFAULT_ROUTER_TIMEOUT_MS, classifyLoopMode, parseRouterReply, resolveRouterModel, resolveRouterTimeoutMs,
  buildRouterMessages, compactHistory, harvestModeHint, parseModeMarker,
} = await import('../kernel/mode-router.mjs')
const { createEngine } = await import('../kernel/engine.mjs')
const { createSessionStore } = await import('../kernel/session.mjs')
const { makeWire } = await import('../kernel/protocol.mjs')

// ── 严格解析 ────────────────────────────────────────────────────────────────

test('parseRouterReply：合法 JSON → 归一 mode/confidence/reason', () => {
  const r = parseRouterReply('{"mode":"PLAN","confidence":0.72,"reason":"多步骤"}')
  assert.deepEqual(r, { mode: 'plan', confidence: 0.72, reason: '多步骤' })
})

test('parseRouterReply：置信度钳制到 [0,1]（不因越界判错——钳制是兜底不是放水）', () => {
  assert.equal(parseRouterReply('{"mode":"react","confidence":1.5}').confidence, 1)
  assert.equal(parseRouterReply('{"mode":"react","confidence":-0.3}').confidence, 0)
})

test('parseRouterReply：白名单外模式/坏 JSON/缺置信度 → error（错误文本回喂重试用）', () => {
  assert.match(parseRouterReply('{"mode":"turbo","confidence":0.9}').error, /白名单/)
  // ★ 2026-10-29：subagent 是**用户钉住专属**档（能不能并行派活是用户的决定），
  //   路由不得自己产出它 —— 否则用户没选过却进了该档，下一轮还可能被路由切走。
  //   normalizeLoopMode 认它（选择器/CLI 可用）与路由拒它是**两件事**，这里同时钉住。
  assert.match(parseRouterReply('{"mode":"subagent","confidence":0.9}').error, /白名单/,
    '路由输出白名单不含 subagent（见 mode-router 的 ROUTABLE_LOOP_MODES）')
  assert.match(parseRouterReply('{"mode":"plan",}').error, /JSON 解析失败/)
  assert.match(parseRouterReply('完全是散文，没有 JSON').error, /未找到 JSON 对象/)
  assert.match(parseRouterReply('{"mode":"plan"}').error, /confidence 非数值/)
  assert.match(parseRouterReply('{"confidence":0.9}').error, /白名单/)
})

test('parseRouterReply：包裹文本中的 JSON 也能取到（模型多话不算错）', () => {
  const r = parseRouterReply('分析如下：{"mode":"reflect","confidence":0.8,"reason":"反复失败"} 以上。')
  assert.equal(r.mode, 'reflect')
})

// ── 模型/超时解析 ───────────────────────────────────────────────────────────

test('resolveRouterModel：显式 > env > 当前激活模型（决策 LLM 单独可配）', () => {
  const old = process.env.PONOS_ROUTER_MODEL
  try {
    delete process.env.PONOS_ROUTER_MODEL
    assert.equal(resolveRouterModel({ routerModel: 'r1', model: 'm1' }), 'r1')
    assert.equal(resolveRouterModel({ model: 'm1' }), 'm1')
    process.env.PONOS_ROUTER_MODEL = 'r-env'
    assert.equal(resolveRouterModel({ model: 'm1' }), 'r-env')
    assert.equal(resolveRouterModel({ routerModel: 'r1', model: 'm1' }), 'r1', '显式参数仍优先于 env')
  } finally {
    if (old === undefined) delete process.env.PONOS_ROUTER_MODEL; else process.env.PONOS_ROUTER_MODEL = old
  }
})

test('resolveRouterTimeoutMs：显式 > env > 缺省；非法值按缺省', () => {
  const old = process.env.PONOS_ROUTER_TIMEOUT_MS
  try {
    delete process.env.PONOS_ROUTER_TIMEOUT_MS
    assert.equal(resolveRouterTimeoutMs(), DEFAULT_ROUTER_TIMEOUT_MS)
    assert.equal(resolveRouterTimeoutMs(123), 123)
    process.env.PONOS_ROUTER_TIMEOUT_MS = '250'
    assert.equal(resolveRouterTimeoutMs(), 250)
    process.env.PONOS_ROUTER_TIMEOUT_MS = 'abc'
    assert.equal(resolveRouterTimeoutMs(), DEFAULT_ROUTER_TIMEOUT_MS)
    assert.equal(resolveRouterTimeoutMs(-5), DEFAULT_ROUTER_TIMEOUT_MS)
  } finally {
    if (old === undefined) delete process.env.PONOS_ROUTER_TIMEOUT_MS; else process.env.PONOS_ROUTER_TIMEOUT_MS = old
  }
})

// ── classifyLoopMode（注入 callModel，不打网络）─────────────────────────────

const okReply = '{"mode":"plan","confidence":0.81,"reason":"三步改造"}'

test('classifyLoopMode：一次成功 → ok:true、attempts=1', async () => {
  const calls = []
  const r = await classifyLoopMode({
    messages: [{ role: 'user', content: '帮我重构三个模块' }], model: 'm',
    callModel: async (p) => { calls.push(p); return okReply },
  })
  assert.deepEqual({ ok: r.ok, mode: r.mode, confidence: r.confidence, fallback: r.fallback, attempts: r.attempts },
    { ok: true, mode: 'plan', confidence: 0.81, fallback: false, attempts: 1 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].model, 'm', '未配路由模型 ⇒ 用当前激活模型')
  assert.equal(calls[0].maxTokens > 0 && calls[0].maxTokens <= 512, true, '路由调用必须小预算')
})

test('★ classifyLoopMode：校验失败 → 恰一次重试（错误文本回喂），二次成功仍 ok', async () => {
  const calls = []
  const r = await classifyLoopMode({
    messages: [{ role: 'user', content: 'x' }], model: 'm',
    callModel: async (p) => {
      calls.push(p)
      return calls.length === 1 ? '我不太确定，可能是 plan 吧' : okReply
    },
  })
  assert.equal(r.ok, true)
  assert.equal(r.attempts, 2)
  assert.equal(calls.length, 2)
  const retryMsgs = calls[1].messages
  assert.ok(retryMsgs.length > calls[0].messages.length, '重试须在原提示后追加校验反馈')
  assert.match(String(retryMsgs[retryMsgs.length - 1].content), /未通过校验/, '反馈必须是校验错误原文（retry-prompt 模式）')
})

test('★ classifyLoopMode：两次都坏 → fallback:true、mode:null（由引擎沿用当前模式）', async () => {
  let n = 0
  const r = await classifyLoopMode({
    messages: [], model: 'm',
    callModel: async () => { n++; return '还是散文' },
  })
  assert.equal(n, 2, '校验失败只重试一次（总两次）')
  assert.equal(r.ok, false)
  assert.equal(r.mode, null, '兜底不得替引擎猜模式（D14：沿用当前）')
  assert.equal(r.fallback, true)
  assert.match(r.error, /校验失败/)
})

test('★ classifyLoopMode：传输失败（网络错）不重试，立即兜底', async () => {
  let n = 0
  const r = await classifyLoopMode({
    messages: [], model: 'm',
    callModel: async () => { n++; throw new Error('ECONNREFUSED') },
  })
  assert.equal(n, 1, '网络错重试只会加倍延迟 ⇒ 恰一次')
  assert.equal(r.ok, false)
  assert.equal(r.fallback, true)
  assert.match(r.error, /路由请求失败.*ECONNREFUSED/)
})

test('★ classifyLoopMode：超时即中止（内部 AbortController），兜底且不悬挂', async () => {
  const t0 = Date.now()
  const r = await classifyLoopMode({
    messages: [], model: 'm', timeoutMs: 30,
    callModel: ({ signal }) => new Promise((_res, rej) => {
      signal.addEventListener('abort', () => rej(new Error('aborted by test')))
    }),
  })
  assert.equal(r.ok, false)
  assert.equal(r.fallback, true)
  assert.ok(Date.now() - t0 < 2000, `超时必须及时返回（实际 ${Date.now() - t0}ms）`)
  assert.match(r.error, /中止|超时/)
})

test('classifyLoopMode：外部信号已中止 → 立即兜底（不发起无谓调用）', async () => {
  const ctl = new AbortController()
  ctl.abort(new Error('用户取消'))
  let called = false
  const r = await classifyLoopMode({
    messages: [], model: 'm', signal: ctl.signal,
    callModel: async ({ signal }) => { called = true; if (signal.aborted) throw new Error('aborted'); return okReply },
  })
  assert.equal(r.fallback, true)
  assert.equal(r.ok, false)
  assert.ok(called === false || r.error, '已中止信号下不得产出 ok 结果')
})

// ── 提示合并 / 历史压缩 ─────────────────────────────────────────────────────

test('buildRouterMessages：跳过 system（不把系统提示塞给路由）；hint 合并为参考', () => {
  const msgs = buildRouterMessages({
    messages: [
      { role: 'system', content: '超长系统提示'.repeat(100) },
      { role: 'user', content: '先规划再动手' },
      { role: 'assistant', content: [{ type: 'text', text: '好的' }, { type: 'tool_use', name: 'Read', input: {} }] },
    ],
    hint: { mode: 'plan', reason: '多步任务' },
  })
  assert.equal(msgs.length, 2)
  assert.match(msgs[0].content, /react|plan|reflect/)
  assert.ok(!msgs[1].content.includes('超长系统提示'), '路由提示不得携带 system 正文')
  assert.match(msgs[1].content, /模型主动提示/, 'hint 必须合并进判定提示')
  assert.match(msgs[1].content, /plan/)
})

test('buildRouterMessages：非法 hint 模式不合并（白名单外不猜）', () => {
  const msgs = buildRouterMessages({ messages: [], hint: { mode: 'turbo' } })
  assert.ok(!msgs[1].content.includes('模型主动提示'))
})

test('compactHistory：只留最近 N 条、跳过 system、单条封顶（路由调用必须便宜）', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: `msg-${i}` }))
  const h = compactHistory([{ role: 'system', content: 'sys' }, ...many], { keep: 5, perMessage: 20 })
  assert.equal(h.length, 5)
  assert.deepEqual(h.map((x) => x.text), ['msg-25', 'msg-26', 'msg-27', 'msg-28', 'msg-29'])
  const long = compactHistory([{ role: 'user', content: 'x'.repeat(500) }], { keep: 5, perMessage: 20 })
  assert.equal(long[0].text.length, 20)
})

// ── 模型主动标记（D11：只作提示）─────────────────────────────────────────────

test('parseModeMarker：模式白名单 + 可选 reason；白名单外 → null', () => {
  assert.deepEqual(parseModeMarker(' PLAN reason="先给方案"'), { mode: 'plan', reason: '先给方案' })
  assert.deepEqual(parseModeMarker(' reflect reason=复盘'), { mode: 'reflect', reason: '复盘' })
  assert.equal(parseModeMarker(' turbo reason="x"'), null)
  assert.equal(parseModeMarker(''), null)
})

test('★ harvestModeHint：只认闭合标记；剥离干净文本；多个取末个', () => {
  const t = '正文A <!--PONOS_LOOP_MODE PLAN reason="一"--> 正文B <!--PONOS_LOOP_MODE reflect--> 正文C'
  const r = harvestModeHint(t)
  assert.equal(r.hints.length, 2)
  assert.deepEqual(r.hint, { mode: 'reflect', reason: '' }, '取最后一个（最新意图）')
  assert.equal(r.clean, '正文A  正文B  正文C')
  assert.ok(!r.clean.includes('PONOS_LOOP_MODE'), '干净文本不得残留标记')
})

test('harvestModeHint：半截标记（流式未闭合）不提取、原样保留', () => {
  const r = harvestModeHint('正文 <!--PONOS_LOOP_MODE PLAN rea')
  assert.equal(r.hint, null)
  assert.ok(r.clean.includes('<!--PONOS_LOOP_MODE'), '未闭合标记保留（与 ASK_USER 同口径）')
})

test('harvestModeHint：非法模式标记被剥离但不产提示（展示不留痕）', () => {
  const r = harvestModeHint('a <!--PONOS_LOOP_MODE TURBO--> b')
  assert.equal(r.hint, null)
  assert.equal(r.clean, 'a  b')
})

// ── 引擎级接线（mock：PONOS_MOCK_ROUTER 脚本化路由回复）────────────────────

function makeEngine() {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const dir = mkdtempSync(join(tmpdir(), 'ponos-mrouter-'))
  const store = createSessionStore({ configDir: join(dir, 'home'), cwd: dir, sessionId: 'main' })
  const engine = createEngine({
    opts: { model: 'mock-model', configDir: join(dir, 'home'), addDirs: [dir], skipPermissions: true },
    wire, session: store,
  })
  engine.setSystemPrompt('你是 Ponos-turbo 测试内核。')
  return {
    events, engine, store,
    systemEvents: (subtype) => events.filter((e) => e.type === 'system' && e.subtype === subtype),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}
const lastMeta = (engine) => engine.getTurnStats().at(-1).loopMode
const run = (engine, content = '只回一句话，不要调用工具') => engine.runTurn({ content })

test('★ 引擎级：auto + 路由判 plan → 本轮即切 plan（指令恰一次 + 两类事件 + meta 留痕）', async () => {
  process.env.PONOS_MOCK_ROUTER = '{"mode":"plan","confidence":0.9,"reason":"多步"}'
  const env = makeEngine()
  try {
    await run(env.engine)
    const meta = lastMeta(env.engine)
    assert.equal(meta.effective, 'plan', '置信度 .9 ≥ LOW 门槛 .6 ⇒ 自动切换')
    assert.equal(meta.router.mode, 'plan')
    assert.equal(meta.router.fallback, false)
    assert.equal(meta.governance.action, 'auto')
    assert.equal(env.systemEvents('router_decision').length, 1, '路由裁决必须发事件')
    assert.equal(env.systemEvents('loop_mode_applied').length, 1)
    const directives = env.store.deriveMessages().filter((m) => m.role === 'user' && String(m.content).includes('【循环模式·PLAN】'))
    assert.equal(directives.length, 1)
  } finally { delete process.env.PONOS_MOCK_ROUTER; env.cleanup() }
})

test('★ 引擎级：路由坏 JSON → fallback 且沿用 react（零回归，绝不因判定失败剥模式）', async () => {
  process.env.PONOS_MOCK_ROUTER = '我觉得应该用 plan 模式'  // 非 JSON ⇒ 校验失败两次 ⇒ 兜底
  const env = makeEngine()
  try {
    await run(env.engine)
    const meta = lastMeta(env.engine)
    assert.equal(meta.effective, 'react', 'D14：兜底沿用当前（初始 react）')
    assert.equal(meta.router.fallback, true)
    assert.equal(meta.governance.action, 'stay')
    assert.equal(env.systemEvents('loop_mode_applied').length, 0, '未切换 ⇒ 无应用事件、无注入')
  } finally { delete process.env.PONOS_MOCK_ROUTER; env.cleanup() }
})

test('★ 引擎级：钉住模式时完全不调用路由（杀开关语义）', async () => {
  process.env.PONOS_MOCK_ROUTER = '{"mode":"reflect","confidence":1}' // 若被调用会触发治理升级——绝不该发生
  const env = makeEngine()
  try {
    env.engine.setLoopMode('plan')
    await run(env.engine)
    const meta = lastMeta(env.engine)
    assert.equal(meta.effective, 'plan')
    assert.equal(meta.router, null, '选择态非 auto ⇒ 零路由调用（meta 如实为 null）')
    assert.equal(meta.governance, null)
    assert.equal(env.systemEvents('router_decision').length, 0)
  } finally { delete process.env.PONOS_MOCK_ROUTER; env.cleanup() }
})

test('★ 引擎级：路由模型热切换接口（setRouterModel/getRouterModel）', () => {
  const env = makeEngine()
  try {
    assert.equal(env.engine.getRouterModel(), '', '未配置 ⇒ 空串（解析时回落当前激活模型）')
    const r = env.engine.setRouterModel('router-x')
    assert.equal(r.ok, true)
    assert.equal(env.engine.getRouterModel(), 'router-x')
    env.engine.setRouterModel('')
    assert.equal(env.engine.getRouterModel(), '')
  } finally { env.cleanup() }
})
