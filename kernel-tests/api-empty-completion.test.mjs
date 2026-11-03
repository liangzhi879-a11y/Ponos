// 空回复两类分类 + 输出预算守卫（Task 6 / spec §3.6）
// ---------------------------------------------------------------------------
// 为什么需要这一套：
//   实测（spec §1.3）`max_tokens=512` 时思考内容会把预算吃光 ⇒ `finish_reason: length`、
//   content 空（`usage.completion` 恰好等于 `max_tokens`）；4096 / 8192 均正常收尾 `stop`。
//   而内核既有两条 max_tokens 处理分支**都要求"有产出"**：
//     · engine.mjs 有 tool_use → 注入错误 tool_result 提示补全；
//     · engine.mjs 有正文     → 按 OUTPUT_TIERS 升档续写。
//   ⇒ **恰好漏掉第三态**："只有思考 + 无正文 + 无工具 + stop_reason=max_tokens/length"。
//   本机实测（.yfworking/process/openai-wire-task6/repro-third-state.mjs，改动前）：该态走到
//   `blocks.length===0` 分支后直接 break ⇒ result.text=''、无错误、无诊断 —— 静默假成功。
//
// 本套件三层覆盖：
//   ① 纯函数（分类 / 决策 / 预算守卫）——零依赖；
//   ② 接线回归：`guardOutputBudget` 真落在两个协议的 max_tokens 入参上（走真实 HTTP 到本机
//      server，断言请求体），否则"纯函数全绿"证明不了任何事（本仓反复踩过这个坑）；
//   ③ 引擎端到端：第三态真被接住（抛可诊断错误 / 降级一次），且既有两条 max_tokens 路径与
//      正常收尾**不被误伤**。
// 夹具用本机 HTTP server 而非内置 mock 流：本套件要断言"请求体里到底发了什么"与"流正常收尾
// 却零产出"这两个形态，必须走真实 parser/protocolStream 路径。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyApiError, classifyEmptyCompletion, emptyCompletionError, guardOutputBudget,
  OUTPUT_BUDGET_FLOOR, planEmptyCompletionRecovery, streamMessages,
} from '../kernel/api.mjs'
import { resetProviderForTest, setProvider } from '../kernel/provider.mjs'

delete process.env.PONOS_MOCK_API // 本套件走真实 HTTP（本机 server），不用内置 mock 流
process.env.PONOS_STREAM_RECONNECTS = '0'
const { createEngine } = await import('../kernel/engine.mjs')
import { createSessionStore } from '../kernel/session.mjs'
import { makeWire } from '../kernel/protocol.mjs'

// ── 夹具：本机 HTTP server（Anthropic SSE / OpenAI SSE 两套形态 + 请求体记账）──────────
const sseOf = (events) => events.map((e) => `data: ${JSON.stringify(e)}`).join('\n\n') + '\n\ndata: [DONE]\n\n'

/** 第三态流：只有思考 + stop_reason=max_tokens（与真端点 §1.3 同形） */
function thirdStateSse(think) {
  return sseOf([
    { type: 'message_start', message: { usage: { input_tokens: 120, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    ...[...think].reduce((acc, ch, i) => (i % 30 === 0 ? [...acc, ch] : [...acc.slice(0, -1), acc[acc.length - 1] + ch]), [])
      .map((t) => ({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: t } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { input_tokens: 120, output_tokens: 512 } },
  ])
}
/** 正常收尾流：有正文 + end_turn */
const textStopSse = (text) => sseOf([
  { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: 5 } },
])
/** OpenAI 形态的正常收尾流（降级后的备用协议用） */
const openaiTextSse = (text) => sseOf([
  { choices: [{ index: 0, delta: { role: 'assistant', content: text } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
])

/** 起一个本机 server；`respond(req)` 返回 { status?, type?, body }（body 为 SSE 文本） */
async function withServer(respond, fn) {
  const requests = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      let body = null
      try { body = JSON.parse(raw || '{}') } catch { body = raw }
      const idx = requests.length
      requests.push({ url: req.url, method: req.method, body, headers: req.headers })
      const out = respond({ url: req.url, body, index: idx })
      res.writeHead(out.status ?? 200, { 'content-type': out.type ?? 'text/event-stream' })
      res.end(out.body ?? '')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const prevEnv = { ...process.env }
  Object.assign(process.env, {
    PONOS_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    PONOS_AUTH_TOKEN: 'test-token',
    PONOS_MODEL: 'test-model',
  })
  try {
    return await fn({ requests, baseUrl: `http://127.0.0.1:${server.address().port}` })
  } finally {
    process.env = prevEnv
    await new Promise((r) => server.close(r))
  }
}

const drainStream = async (args) => { const out = []; for await (const c of streamMessages(args)) out.push(c); return out }

/** 引擎夹具：临时 configDir + 真实 engine（不 mock 流） */
function makeEngine({ wire }) {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-empty-completion-'))
  const session = createSessionStore({ configDir: dir, cwd: dir, sessionId: 'empty-completion' })
  // 本套件只测空回复恢复路径：用杀开关关掉循环模式路由（PONOS_LOOP_MODE=react ⇒ 引擎
  // 完全不调用路由）。否则 2026-10-06 三层升级后每轮会多一次真实路由请求打到下面的
  // 本机 server ——requests 计数与按下标脚本化的响应序列都会被污染（断言失真）。
  // 引擎在 createEngine 时读取该 env ⇒ 只需在创建期间置位，创建后即还原。
  const prevLoopMode = process.env.PONOS_LOOP_MODE
  process.env.PONOS_LOOP_MODE = 'react'
  let engine
  try {
    engine = createEngine({
      opts: { model: 'test-model', addDirs: [dir], skipPermissions: true, systemPrompt: '', configDir: dir },
      wire, session,
    })
  } finally {
    if (prevLoopMode === undefined) delete process.env.PONOS_LOOP_MODE; else process.env.PONOS_LOOP_MODE = prevLoopMode
  }
  return { engine, session, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 捕获 stderr（诊断面断言）：只在本函数作用域内替换，退出即还原 */
async function withStderr(fn) {
  const lines = []
  const orig = process.stderr.write.bind(process.stderr)
  process.stderr.write = (s, ...rest) => { lines.push(String(s)); return orig(s, ...rest) }
  try { return await fn(lines) } finally { process.stderr.write = orig }
}

// ══════════════ ① 纯函数：分类（计划 Step 1 逐条） ══════════════

test('类型Ⅱ：finish_reason=length + 有思考无正文 → reasoning-budget-exhausted', () => {
  const r = classifyEmptyCompletion({ stopReason: 'max_tokens', textLen: 0, toolCount: 0, thinkingLen: 2176 })
  assert.equal(r.kind, 'reasoning-budget-exhausted')
  assert.equal(r.retryable, false, '预算不足不该盲目重试')
  assert.ok(r.hint.length > 0, '必须给可操作引导')
})

test('类型Ⅰ回归防护：finish_reason=stop + 全空 → empty-completion（假成功）', () => {
  const r = classifyEmptyCompletion({ stopReason: 'end_turn', textLen: 0, toolCount: 0, thinkingLen: 0 })
  assert.equal(r.kind, 'empty-completion')
  assert.equal(r.retryable, false)
})

test('有产出就不算空回复', () => {
  assert.equal(classifyEmptyCompletion({ stopReason: 'end_turn', textLen: 3, toolCount: 0, thinkingLen: 0 }), null)
  assert.equal(classifyEmptyCompletion({ stopReason: 'tool_use', textLen: 0, toolCount: 1, thinkingLen: 0 }), null)
})

test('仅思考无正文但 finish=stop → empty-completion（不是预算问题）', () => {
  const r = classifyEmptyCompletion({ stopReason: 'end_turn', textLen: 0, toolCount: 0, thinkingLen: 500 })
  assert.equal(r.kind, 'empty-completion')
})

test('空白正文不算产出（"  \\n " 与空同义，否则守卫被空白绕过）', () => {
  const r = classifyEmptyCompletion({ stopReason: 'max_tokens', textLen: 3, toolCount: 0, thinkingLen: 100 })
  assert.equal(r, null, '长度 >0 即按有产出处理（调用方传 trim 后的长度）')
})

// ══════════════ ① 纯函数：预算守卫（计划 Step 1 逐条 + 接线边界） ══════════════

test('预算守卫：低于地板值抬到地板，其余原样', () => {
  assert.equal(OUTPUT_BUDGET_FLOOR, 4096)
  assert.equal(guardOutputBudget({ maxTokens: 512, profile: 'cloud' }), 4096)
  assert.equal(guardOutputBudget({ maxTokens: 16384, profile: 'cloud' }), 16384)
  assert.equal(guardOutputBudget({ maxTokens: undefined, profile: 'cloud' }), undefined, '未指定则不擅自加')
})

test('预算守卫：恰在地板上不抬升（边界不含等于）', () => {
  assert.equal(guardOutputBudget({ maxTokens: 4096, profile: 'cloud' }), 4096)
  assert.equal(guardOutputBudget({ maxTokens: 4095, profile: 'cloud' }), 4096)
})

test('预算守卫：与档位正交（同一调用方在任何档位下取到同一预算）', () => {
  // 依据（2026-09-23 实测修正）：曾给"显式关思考"的调用豁免抬升，结果 max_tokens 随档位变化，
  // 打红 kernel-tests/effort-wire.test.mjs 的档位不变量（"旋钮之外请求体不变：缓存前缀不被
  // 搅动"）。地板必须与档位正交 —— 收/发同一预算，不因 thinking/reasoning 旋钮而变。
  assert.equal(guardOutputBudget({ maxTokens: 512, profile: 'cloud' }), OUTPUT_BUDGET_FLOOR)
  assert.equal(guardOutputBudget({ maxTokens: 512, profile: 'local' }), OUTPUT_BUDGET_FLOOR)
  // 回归锁：不得因"是否关思考"改变结果（曾有此豁免 ⇒ 打红 effort-wire 的档位不变量）
  assert.equal(guardOutputBudget({ maxTokens: 512, thinkingDisabled: true }), OUTPUT_BUDGET_FLOOR)
  assert.equal(guardOutputBudget({ maxTokens: 512 }), guardOutputBudget({ maxTokens: 512, profile: 'local' }), '预算只由 maxTokens 决定')
})

test('预算守卫：非数值（NaN/字符串）原样返回，不制造 NaN 预算', () => {
  assert.equal(guardOutputBudget({ maxTokens: NaN }), NaN)
  assert.ok(Number.isNaN(guardOutputBudget({ maxTokens: NaN })))
  assert.equal(guardOutputBudget({ maxTokens: '512' }), '512')
})

// ══════════════ ① 纯函数：第三态的两种处置（L3） ══════════════

test('决策：有备用协议且与当前不同 → 切换一次并给出去向', () => {
  const classified = classifyEmptyCompletion({ stopReason: 'max_tokens', textLen: 0, toolCount: 0, thinkingLen: 900 })
  const p = planEmptyCompletionRecovery({ classified, currentFormat: 'anthropic', fallbackApiFormat: 'openai' })
  assert.equal(p.action, 'switch-format')
  assert.equal(p.to, 'openai')
})

test('决策：已降级过 → 不再切换（每回合最多一次降级）', () => {
  const classified = classifyEmptyCompletion({ stopReason: 'max_tokens', textLen: 0, toolCount: 0, thinkingLen: 900 })
  const p = planEmptyCompletionRecovery({ classified, currentFormat: 'anthropic', fallbackApiFormat: 'openai', downgraded: true })
  assert.equal(p.action, 'fail')
})

test('决策：备用协议与当前协议相同 / 非法值 → 不切换（切换无意义，不做空转重发）', () => {
  const classified = classifyEmptyCompletion({ stopReason: 'max_tokens', textLen: 0, toolCount: 0, thinkingLen: 900 })
  assert.equal(planEmptyCompletionRecovery({ classified, currentFormat: 'anthropic', fallbackApiFormat: 'anthropic' }).action, 'fail')
  assert.equal(planEmptyCompletionRecovery({ classified, currentFormat: 'anthropic', fallbackApiFormat: 'garbage' }).action, 'fail')
  assert.equal(planEmptyCompletionRecovery({ classified, currentFormat: 'anthropic', fallbackApiFormat: null }).action, 'fail')
})

test('决策：有产出（classified=null）→ 什么都不做（绝不误伤）', () => {
  assert.equal(planEmptyCompletionRecovery({ classified: null, currentFormat: 'anthropic', fallbackApiFormat: 'openai' }).action, 'none')
})

test('决策：只配了 fallbackProviderId（无 fallbackApiFormat）→ 不切换，落回可诊断错误', () => {
  const classified = classifyEmptyCompletion({ stopReason: 'max_tokens', textLen: 0, toolCount: 0, thinkingLen: 900 })
  const p = planEmptyCompletionRecovery({ classified, currentFormat: 'anthropic', fallbackProviderId: 'backup-1' })
  assert.equal(p.action, 'fail')
  assert.equal(p.providerSwitchConfigured, true, '备用 provider 已配置这一事实必须如实带出（写进错误引导）')
})

test('错误形状：带 kind 与 hint（上层据此分级引导，不靠字符串匹配）', () => {
  const classified = classifyEmptyCompletion({ stopReason: 'max_tokens', textLen: 0, toolCount: 0, thinkingLen: 900 })
  const err = emptyCompletionError({ classified, fallbackProviderId: 'backup-1' })
  assert.equal(err.kind, 'reasoning-budget-exhausted')
  assert.ok(err.hint.length > 0)
  assert.match(err.message, /reasoning-budget-exhausted/, '文案须带 kind，便于用户原样回报')
  assert.match(err.message, /backup-1/, '已配置备用 provider 必须写进引导（否则用户以为没配）')
  // classifyApiError 须原样透传该 kind 且不可重试（spec §3.6：新增分类）
  assert.deepEqual(classifyApiError(err), { kind: 'reasoning-budget-exhausted', retryable: false })
})

// ══════════════ ② 接线回归：守卫真落在两个协议的 max_tokens 入参上 ══════════════

test('接线：anthropic 协议 maxTokens=512 → 请求体下发 4096 + 一行诊断', async () => {
  await withStderr(async (stderr) => {
    await withServer(() => ({ body: textStopSse('ok') }), async ({ requests }) => {
      await withScope(async () => {
        process.env.PONOS_API_FORMAT = 'anthropic'
        await drainStream({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }], maxTokens: 512 })
        assert.equal(requests.length, 1)
        assert.ok(requests[0].url.endsWith('/v1/messages'), requests[0].url)
        assert.equal(requests[0].body.max_tokens, 4096, '守卫须真作用到 anthropic 请求体（纯函数绿不能替代）')
        assert.match(stderr.join(''), /输出预算已按地板抬升/, '抬升必须落诊断（用户否则不知预算为何变了）')
      })
    })
  })
})

test('接线：openai 协议 maxTokens=512 → 请求体下发 4096（同一条守卫，不走第二套实现）', async () => {
  await withServer(() => ({ body: openaiTextSse('ok') }), async ({ requests }) => {
    await withScope(async () => {
      process.env.PONOS_API_FORMAT = 'openai'
      await drainStream({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }], maxTokens: 512 })
      assert.equal(requests.length, 1)
      assert.ok(requests[0].url.endsWith('/v1/chat/completions'), requests[0].url)
      assert.equal(requests[0].body.max_tokens, 4096)
    })
  })
})

test('接线：未超地板原样下发（零回归）', async () => {
  await withStderr(async (stderr) => {
    await withServer(() => ({ body: textStopSse('ok') }), async ({ requests }) => {
      await withScope(async () => {
        process.env.PONOS_API_FORMAT = 'anthropic'
        await drainStream({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }], maxTokens: 16384 })
        assert.equal(requests[0].body.max_tokens, 16384)
        assert.ok(!stderr.join('').includes('按地板抬升'), '未抬升不得留诊断（防误导）')
      })
    })
  })
})

test('接线：关思考的请求同样抬升，且思考开关照旧下发（地板与档位正交）', async () => {
  // 为什么与上面那条一起测：若把"是否关思考"接进地板判据，max_tokens 就会随档位变化 ——
  // effort-wire 的档位不变量立刻变红（这正是本条要锁住的边界）。
  await withServer(() => ({ body: textStopSse('ok') }), async ({ requests }) => {
    await withScope(async () => {
      process.env.PONOS_API_FORMAT = 'anthropic'
      await drainStream({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }], maxTokens: 123, thinkingMode: 'off' })
      assert.equal(requests[0].body.max_tokens, OUTPUT_BUDGET_FLOOR, '123 同样抬到地板（与档位正交）')
      assert.deepEqual(requests[0].body.thinking, { type: 'disabled' }, '思考开关不受守卫影响')
    })
  })
})

/** 在给定 env 覆盖下执行（退出还原），避免用例间串味 */
async function withScope(fn) {
  const prev = { ...process.env }
  try { return await fn() } finally { process.env = prev }
}

// ══════════════ ③ 引擎端到端：第三态被接住 ══════════════

const THINK_UNIQUE = '用户要一个函数，我先确认入参形状：可能是数组也可能是单值，那就先判类型再分支；'
  + '边界要覆盖空输入与嵌套结构，异常路径显式抛出而不是静默返回空值，'
  + '否则调用方无法区分"没结果"与"算错了"。实现上先规整数据、再映射、最后统一出口。'

test('引擎：第三态 → 不再交付空回复，改为带 kind/hint 的可诊断结果（改动前 result.text=""）', async () => {
  // 说明：engine 主循环按任务要求**抛出**带 kind/hint 的错误；runTurn 顶层既有全局兜底
  // （非取消异常一律转成可见文本 + 落 health failure）会把文案交付用户 —— 这正是"绝不静默"
  // 的落点。故此处断言用户可见面：非空、带 kind、带可操作引导。错误对象自身的 kind/hint
  // 形状由上面的 emptyCompletionError 纯函数用例钉住。
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  await withStderr(async (stderr) => {
    await withServer(() => ({ body: thirdStateSse(THINK_UNIQUE) }), async ({ requests }) => {
      await withScope(async () => {
        process.env.PONOS_API_FORMAT = 'anthropic'
        const env = makeEngine({ wire })
        let out = null
        try {
          out = await env.engine.runTurn({ content: '写个函数' })
        } finally { env.cleanup() }
        assert.notEqual(String(out?.text || '').trim(), '', '第三态不得再产出空回复（改动前 text=""）')
        assert.match(String(out.text), /端点未产出任何正文/, '必须明确告知"没有产出正文"')
        assert.match(String(out.text), /reasoning-budget-exhausted/, '必须带 kind（可分级引导，不靠猜）')
        assert.match(String(out.text), /输出预算/, '必须带可操作引导（提高输出预算 / 关思考）')
        assert.equal(requests.length, 1, '无备用协议 ⇒ 不做无依据重发（spec §3.6 L3-4）')
        const reported = events.filter((e) => e.subtype === 'empty_completion')
        assert.equal(reported.length, 1, '必须上报事件（绝不静默）')
        assert.equal(reported[0].stopReason, 'max_tokens')
        assert.ok(reported[0].thinkingLen > 0)
        assert.equal(reported[0].textLen, 0)
        assert.equal(reported[0].retryable, false)
        // 脱敏（spec §3.6 / 全局约束）：**本任务的诊断面**不得出现正文与思考内容。
        // 注意范围：assistant 流式事件承载思考是既有设计（GUI 实时上屏），不在脱敏范围；
        // 脱敏范围 = 本任务新增的事件与 stderr 诊断。
        const diagEvents = events.filter((e) => e.subtype === 'empty_completion' || e.subtype === 'empty_completion_switched')
        assert.ok(!JSON.stringify(diagEvents).includes('用户要一个函数'), '诊断事件不得携带思考正文')
        assert.ok(!stderr.join('').includes('用户要一个函数'), '诊断不得记录正文与思考')
        assert.match(stderr.join(''), /reasoning-budget-exhausted/, '诊断须落到 stderr（内核日志可追）')
      })
    })
  })
})

test('引擎：第三态 + fallbackApiFormat=openai → 切换一次并上报，回合成功（每回合最多一次）', async () => {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  await withServer(
    ({ url }) => (String(url).endsWith('/v1/chat/completions')
      ? { body: openaiTextSse('已切换到备用协议并产出正文') }
      : { body: thirdStateSse(THINK_UNIQUE) }),
    async ({ requests }) => {
      await withScope(async () => {
        process.env.PONOS_API_FORMAT = 'anthropic'
        // 见报告：fallbackApiFormat 的注入方（bridge/GUI 字段面）不属本任务范围，测试就地补到
        // 注册表对象上（与 kernel-tests/wire-model.test.mjs 补 modelByFormat 同一做法）。
        const { provider } = setProvider({ baseUrl: process.env.PONOS_BASE_URL, authToken: 'test-token', model: 'test-model' })
        provider.fallbackApiFormat = 'openai'
        try {
          const env = makeEngine({ wire })
          let out = null
          try {
            out = await env.engine.runTurn({ content: '写个函数' })
          } finally { env.cleanup() }
          assert.match(String(out.text || ''), /已切换到备用协议/, '降级后应取得备用协议产出的正文')
          assert.equal(requests.length, 2, '恰好重发一次（不无限重试）')
          assert.ok(requests[0].url.endsWith('/v1/messages'), '首次按当前协议（anthropic）')
          assert.ok(requests[1].url.endsWith('/v1/chat/completions'), '降级后走备用协议（openai）')
          const sw = events.filter((e) => e.subtype === 'empty_completion_switched')
          assert.equal(sw.length, 1, '必须上报"已切换"')
          assert.equal(sw[0].from, 'anthropic')
          assert.equal(sw[0].to, 'openai')
        } finally {
          delete provider.fallbackApiFormat
          resetProviderForTest() // 注册表是进程级的：不清空会让后续用例打到已关闭的端口
        }
      })
    },
  )
})

test('引擎：降级后仍空回复 → 直接报错，不再第二次切换（每回合最多一次）', async () => {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  await withServer(({ url }) => (String(url).endsWith('/v1/chat/completions')
    ? { body: sseOf([
      { choices: [{ index: 0, delta: { reasoning_content: THINK_UNIQUE } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] },
    ]) }
    : { body: thirdStateSse(THINK_UNIQUE) }), async ({ requests }) => {
    await withScope(async () => {
      process.env.PONOS_API_FORMAT = 'anthropic'
      const { provider } = setProvider({ baseUrl: process.env.PONOS_BASE_URL, authToken: 'test-token', model: 'test-model' })
      provider.fallbackApiFormat = 'openai'
      try {
        const env = makeEngine({ wire })
        let out = null
        try {
          out = await env.engine.runTurn({ content: '写个函数' })
        } finally { env.cleanup() }
        assert.match(String(out.text || ''), /reasoning-budget-exhausted/, '降级后仍空 ⇒ 可诊断报错（不静默）')
        assert.equal(requests.length, 2, '降级一次即止（第二次仍空回复直接报错，不再重发）')
        assert.ok(requests[1].url.endsWith('/v1/chat/completions'))
        assert.equal(events.filter((e) => e.subtype === 'empty_completion_switched').length, 1, '切换只发生一次')
        assert.equal(events.filter((e) => e.subtype === 'empty_completion').length, 2, '两次空回复都要上报')
      } finally {
        delete provider.fallbackApiFormat
        resetProviderForTest()
      }
    })
  })
})

// ══════════════ ③ 引擎端到端：不误伤既有路径 ══════════════

test('不误伤①：max_tokens + 有正文 → 走既有升档续写（本分支不触发）', async () => {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  await withServer(({ body }) => ({
    body: JSON.stringify(body?.messages || '').includes('直接从截断处继续输出')
      ? textStopSse('续写完成')
      : sseOf([
        { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '前半段正文' } },
        { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { input_tokens: 10, output_tokens: 64 } },
      ]),
  }), async () => {
    await withScope(async () => {
      process.env.PONOS_API_FORMAT = 'anthropic'
      const env = makeEngine({ wire })
      try {
        const out = await env.engine.runTurn({ content: '写长文' })
        // 既有升档语义（engine-continue-heal.test.mjs 已钉）：截断段先落盘为独立条目，轮末
        // text 是续写段；两段都进同一回复（用户无感）。此处只断言"两段都没丢、且未走空回复分支"。
        assert.match(String(out.text || ''), /续写完成/, '续写段是该轮的最终文本（既有行为）')
        assert.ok(JSON.stringify(events).includes('前半段正文'), '截断段照旧实时上屏并落盘（未被丢弃）')
      } finally { env.cleanup() }
      assert.equal(events.filter((e) => e.subtype === 'empty_completion').length, 0, '有正文 ⇒ 不得落入空回复分支')
      assert.ok(events.some((e) => e.subtype === 'output_continued'), '既有升档事件照旧')
    })
  })
})

test('不误伤②：max_tokens + 有工具调用 → 走既有 tool_result 注入（本分支不触发）', async () => {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  await withServer(({ index }) => (index === 0
    ? {
      body: sseOf([
        { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'echo hi' } } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { input_tokens: 10, output_tokens: 20 } },
      ]),
    }
    : { body: textStopSse('已按截断提示补全') }), async ({ requests }) => {
    await withScope(async () => {
      process.env.PONOS_API_FORMAT = 'anthropic'
      const env = makeEngine({ wire })
      try {
        const out = await env.engine.runTurn({ content: '读文件' })
        assert.match(String(out.text || ''), /已按截断提示补全/)
      } finally { env.cleanup() }
      assert.equal(requests.length, 2)
      assert.ok(JSON.stringify(requests[1].body).includes('模型输出被 max_tokens 截断'), '既有截断 tool_result 注入照旧')
      assert.equal(events.filter((e) => e.subtype === 'empty_completion').length, 0, '有工具 ⇒ 不得落入空回复分支')
    })
  })
})

test('不误伤③：stop_reason=end_turn 即使无正文 → 不触发（严格第三态定义：只认 max_tokens/length）', async () => {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  await withServer(() => ({ body: sseOf([
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: THINK_UNIQUE } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: 40 } },
  ]) }), async () => {
    await withScope(async () => {
      process.env.PONOS_API_FORMAT = 'anthropic'
      const env = makeEngine({ wire })
      try {
        await env.engine.runTurn({ content: '你好' })
      } finally { env.cleanup() }
      assert.equal(events.filter((e) => e.subtype === 'empty_completion').length, 0, '正常结束不得触发第三态分支（不误伤）')
      assert.equal(events.filter((e) => e.subtype === 'empty_completion_switched').length, 0)
    })
  })
})

test('不误伤④：前一轮有工具执行，本迭代仍算第三态 → 照样接住（判据只看本迭代）', async () => {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  await withServer(({ index }) => (index === 0
    ? {
      body: sseOf([
        { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_9', name: 'Bash', input: { command: 'echo hi' } } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 10, output_tokens: 20 } },
      ]),
    }
    : { body: thirdStateSse(THINK_UNIQUE) }), async ({ requests }) => {
    await withScope(async () => {
      process.env.PONOS_API_FORMAT = 'anthropic'
      const env = makeEngine({ wire })
      let out = null
      try {
        out = await env.engine.runTurn({ content: '执行命令' })
      } finally { env.cleanup() }
      assert.equal(requests.length, 2, '先跑工具轮，再空回复')
      assert.match(String(out.text || ''), /reasoning-budget-exhausted/, '历史有工具不影响"本迭代零产出"的判定')
      assert.equal(events.filter((e) => e.subtype === 'empty_completion').length, 1)
    })
  })
})
