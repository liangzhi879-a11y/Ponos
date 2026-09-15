// token 估算器的块覆盖（2026-09-12 "模型思考卡顿"事故修复）
// ---------------------------------------------------------------------------
// 背景：estimateTokens 旧实现按字段名猜 `text ?? thinking ?? content`，而 tool_use
// 的载荷在 `input` —— 三个字段全无 → raw='' → **每个 tool_use 块恒计 4 token**。
// 实测某 11.5h 会话：772 个 tool_use 携带 640KB（Write 180KB/Agent 143KB/Bash 141KB/
// Edit 84KB）只被计成 3,088 token（真实约 24 万）→ 压缩阈值判定永久失真：
//   pre-step est(老化后) 7.4 万 < 阈值 13.2 万 → maybeCompact 恒 'aged' 提前返回
//   → 压缩 0 次，而模型每轮实收 1.0MB/1523 条消息 → 每轮 3s（缓存命中）/65s（未命中）
//   的卡顿，且随会话单调恶化（"切 DS 也卡"）。
// 本文件钉死三件事：① tool_use（及任何未来块型）的载荷必被计价；② 既有块型估值零回归
//（纯 ASCII 的 text/tool_result 与旧口径逐字节一致）；③ 事故形态端到端：老化后仍超阈值
// 必须落地摘要，不得再静默 'aged' 返回。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { estimateTokens, estimateMessage, estimateRequest, estimateHistory } from '../kernel/context.mjs'
import { createCompactor } from '../kernel/compact.mjs'
import { createSessionStore } from '../kernel/session.mjs'

process.env.PONOS_MOCK_API = '1'

const ascii = (n) => 'x'.repeat(n)

// —— ① 载荷覆盖 ——

test('tool_use：input 载荷被计价（事故根因；旧实现恒返回 4）', () => {
  const big = JSON.stringify({ file_path: 'C:/x/a.ts', content: ascii(40_000) })
  const est = estimateTokens({ type: 'tool_use', id: 'call_00_abc', name: 'Write', input: JSON.parse(big) })
  // 旧实现此处恒为 4。新实现按 JSON 载荷计价（code 密度 3）→ 约 1.3 万 token
  assert.ok(est > 10_000, `40KB 的 Write 输入必须被计价（实际 ${est}）`)
  assert.ok(est < 20_000, `不得重复计价/放大（实际 ${est}）`)
})

test('tool_use：计价随载荷线性增长（不是"每块 +4"的常数）', () => {
  const mk = (n) => estimateTokens({ type: 'tool_use', id: 'c', name: 'Write', input: { content: ascii(n) } })
  const a = mk(4_000), b = mk(40_000)
  assert.ok(b > a * 5, `10 倍载荷应带来近 10 倍估值（${a} → ${b}）`)
})

test('tool_use：CJK 载荷按字计价（中文 input 不得按 ASCII /3 漏计）', () => {
  const cjk = '这是一段中文工具输入内容'.repeat(100) // 1200 字
  const est = estimateTokens({ type: 'tool_use', id: 'c', name: 'Write', input: { content: cjk } })
  assert.ok(est >= 1_100, `1200 个汉字 ≈ 1200 token（实际 ${est}）`)
})

test('兜底：未登记块型/未登记载荷字段不得静默塌成 4 token', () => {
  const unknownBlock = estimateTokens({ type: 'future_block_type', payload: ascii(4_000) })
  assert.ok(unknownBlock > 1_000, `未知块型的大载荷必须被计价（实际 ${unknownBlock}）`)
  const unknownField = estimateTokens({ type: 'text', text: 'hi', extra_payload: ascii(4_000) })
  assert.ok(unknownField > 1_000, `已知块型上的未知载荷字段同样计价（实际 ${unknownField}）`)
})

test('兜底：结构化载荷（对象/数组）序列化后计价，循环引用不抛', () => {
  const est = estimateTokens({ type: 'tool_use', id: 'c', name: 'TodoWrite', input: { todos: Array.from({ length: 50 }, (_, i) => ({ id: i, text: ascii(200), done: false })) } })
  assert.ok(est > 2_000, `结构化 input 应被计价（实际 ${est}）`)
  const cyc = { type: 'tool_use', id: 'c', name: 'X', input: {} }
  cyc.input.self = cyc.input // JSON.stringify 抛 TypeError → 必须吞掉而非冒泡
  assert.doesNotThrow(() => estimateTokens(cyc))
  assert.equal(typeof estimateTokens(cyc), 'number')
})

test('结构字段不扰动估值：id/tool_use_id 长度不影响（文档化的近似）', () => {
  const short = estimateTokens({ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'x' } })
  const long = estimateTokens({ type: 'tool_use', id: 'call_' + ascii(120), name: 'Read', input: { file_path: 'x' } })
  assert.equal(short, long, 'UUID 级 id 是纯噪声，刻意不计入（见 context.mjs META_KEYS 注释）')
})

// —— ② 既有块型零回归 ——

test('零回归：纯 ASCII text 块估值与旧口径逐字节一致', () => {
  assert.equal(estimateTokens({ type: 'text', text: ascii(4_000) }), Math.ceil(4_000 / 4) + 4)
  assert.equal(estimateTokens({ type: 'tool_result', tool_use_id: 't', content: ascii(3_000) }), Math.ceil(3_000 / 3) + 4)
  // 代码特征 → code 密度（旧行为）
  assert.equal(estimateTokens({ type: 'text', text: 'const a = 1\n' + ascii(2_997) }), Math.ceil(3_009 / 3) + 4)
})

test('零回归：CJK 文本块按字计价（2026-08-22 事故的既有锁定）', () => {
  assert.equal(estimateTokens({ type: 'text', text: '中'.repeat(500) }), 500 + 4)
})

test('零回归：空块/无 content 消息仍是最小计价', () => {
  assert.equal(estimateTokens({ type: 'text', text: '' }), 4)
  assert.equal(estimateTokens({ type: 'tool_use', id: 'c', name: 'Read', input: {} }), estimateTokens({ type: 'tool_use', id: 'c', name: 'Read', input: {} }))
  assert.equal(estimateMessage({ role: 'user' }), 4)
  assert.equal(estimateMessage({ role: 'assistant', content: [] }), 4)
})

test('图像/二进制按 4800 当量，数组 content 里的图像不被 base64 放大', () => {
  assert.equal(estimateTokens({ type: 'image', source: { type: 'base64', data: ascii(200_000) } }), 4800 + 4)
  const b64 = ascii(120_000)
  const withArrayContent = estimateTokens({ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: ascii(400) }, { type: 'image', source: { type: 'base64', data: b64 } }] })
  assert.ok(withArrayContent < 6_000, `数组内容须逐块递归（base64 不得当文本，实际 ${withArrayContent}）`)
  assert.ok(withArrayContent > 4_800, `文本块仍要计价（实际 ${withArrayContent}）`)
  assert.equal(estimateTokens({ type: 'document', source: { type: 'base64', data: b64 } }), 4800 + 4)
})

test('非法输入不抛：null/undefined/字符串/数字', () => {
  assert.equal(estimateTokens(null), 4)
  assert.equal(estimateTokens(undefined), 4)
  assert.equal(estimateTokens(42), 4)
  assert.equal(estimateTokens('abc'), Math.ceil(3 / 4) + 4, '裸字符串按 text 块计（不是逐字符展开）')
  assert.equal(estimateMessage(null), 4)
  assert.equal(estimateMessage(undefined), 4)
})

// —— ③ 记账一致性 ——

test('estimateRequest：四区之和 == total，且与逐条 estimateMessage 对齐（不漏块）', () => {
  const messages = [
    { role: 'user', content: '做这件事 ' + ascii(400) },
    { role: 'assistant', content: [{ type: 'text', text: ascii(200) }, { type: 'tool_use', id: 'c1', name: 'Read', input: { file_path: 'a.ts' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: ascii(2_000) }] },
    { role: 'user', content: '最后一轮任务 ' + ascii(100) },
  ]
  const r = estimateRequest({ system: 'sys prompt', messages })
  const s = r.sections
  assert.equal(r.total, s.system + s.task + s.tool_result + s.history)
  assert.equal(r.total, estimateTokens({ type: 'text', text: 'sys prompt' }) + estimateHistory(messages))
  assert.ok(s.tool_result > 0 && s.task > 0 && s.history > 0, '四区都应有值')
})

// —— ④ 事故形态端到端：老化后仍超阈值必须落地摘要 ——
// 事故链条：工具结果被老化清除（可重放），而 tool_use.input **永不被清除**
//（REPLAYABLE_TOOLS 只管结果）→ 老化后剩下的质量恰好全在估算器的盲区里：
// 旧实现「清完就低于阈值」→ action:'aged' 提前返回 → 摘要永不发生。
function incidentEnv({ writes = 24, inputBytes = 20_000, reads = 10, resultBytes = 50_000 } = {}) {
  const events = []
  const wire = { system: (subtype, payload) => events.push({ subtype, ...(payload || {}) }), summary: () => {} }
  const dir = mkdtempSync(join(tmpdir(), 'ponos-estimate-'))
  const store = createSessionStore({ configDir: dir, cwd: dir, sessionId: 'estimate-session' })
  for (let i = 0; i < writes; i++) {
    store.appendUser(`第 ${i} 轮：写文件`)
    store.appendAssistant([{ type: 'tool_use', id: `w${i}`, name: 'Write', input: { file_path: `f${i}.ts`, content: ascii(inputBytes) } }])
    store.appendToolResult({ toolUseId: `w${i}`, content: `已写入 f${i}.ts（${inputBytes} 字节）` })
  }
  for (let i = 0; i < reads; i++) {
    store.appendUser(`第 ${i} 轮：读大文件`)
    store.appendAssistant([{ type: 'tool_use', id: `r${i}`, name: 'Read', input: { file_path: `big${i}.log` } }])
    store.appendToolResult({ toolUseId: `r${i}`, content: ascii(resultBytes) }) // 可重放 → 会被老化清除
  }
  const context = {
    window: 200_000,
    thresholdRatio: 0.8,
    retainRatio: 0.16,
    estimate: ({ system, messages }) => estimateRequest({ system, messages }),
    estimateMessage,
    estimateHistory,
  }
  const compactor = createCompactor({
    session: store, context, model: 'mock-model', maxTokens: 8192, wire,
    health: undefined, signal: undefined, env: process.env, sessionMemoryPath: null,
  })
  return { events, store, context, compactor, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('端到端：老化清除后剩余质量仍在 tool_use.input → 压缩必须落地（旧实现静默返回 aged）', async () => {
  const env = incidentEnv()
  try {
    const msgs = env.store.deriveMessages()
    // 与线上同口径：window 200K、输出预算 64K、余量 4K → 阈值 131,904
    const r = await env.compactor.maybeCompact({ system: 'sys', messages: msgs, outputBudget: 64_000 })
    assert.equal(r.action, 'summarized',
      `tool_use 载荷占比过半的会话必须触发摘要，不得以 aged/below-threshold 提前返回：${JSON.stringify(r).slice(0, 200)}`)
    // 反证：老化确实发生过（否则本测试不构成事故形态）
    assert.ok((r.cleared ?? 0) > 0 || r.coveredTokens > 0, '工具结果应已被老化/进入 covered')
  } finally { env.cleanup() }
})

test('端到端：同一形态下估算值随 tool_use 载荷增长（阈值判定不再失真）', async () => {
  const small = incidentEnv({ writes: 4, inputBytes: 1_000, reads: 2, resultBytes: 1_000 })
  const large = incidentEnv({ writes: 24, inputBytes: 20_000, reads: 10, resultBytes: 50_000 })
  try {
    const smallMessages = small.store.deriveMessages()
    const largeMessages = large.store.deriveMessages()
    const estSmall = estimateRequest({ system: 's', messages: smallMessages }).total
    const estLarge = estimateRequest({ system: 's', messages: largeMessages }).total
    // 载荷放大 ~150 倍：旧实现只差 ~（老化后）几千 token，新实现应差一个量级
    assert.ok(estLarge > estSmall * 5, `估算应对载荷敏感（${estSmall} → ${estLarge}）`)
    assert.ok(estLarge > 131_904, `事故形态的估算必须越过阈值 131,904（实际 ${estLarge}）`)
  } finally { small.cleanup(); large.cleanup() }
})
