// 固定前缀（system + tools）进估算 + 工具面按窗口预算（2026-10-26）
// ---------------------------------------------------------------------------
// 事故现场（真实会话，非构造）：本地 Qwen3.8-27B / 131,072 窗口 + 一个 MCP 服务器
// （lottifiles-creator，110 个工具）。首请求服务端计 **103,650 token**，其中
// system + tools 约 **101,000**，而 5 条对话消息只占 **2,667** —— 79% 的窗口被固定前缀
// 吃掉。同时 `estimateRequest` 只算 system + messages ⇒ est ≈ 20K，永远低于阈值
// 104,857 ⇒ **压缩 0 次**；溢出兜底也只能裁 messages，裁不掉工具面。
// ⇒ 同一份 411,898 B 的请求体被原样重发了 7 次以上，用户看到的就是"又撑爆了"。
//
// 本文件锁两件事：
//   ① tools 必须计入请求面估算（且 null/空数组时**逐字零回归**）；
//   ② 工具面预算必须随窗口缩放（未知窗口时不裁 = 既有默认行为不变）。
process.env.PONOS_MOCK_API = '1'
const { estimateRequest } = await import('../kernel/context.mjs')
const { dynamicToolBudgetForWindow, applyDynamicToolBudget, TOOLS_BUDGET_FLOOR_BYTES } = await import('../kernel/tool-desc.mjs')
const { createToolRegistry } = await import('../kernel/tools.mjs')
import { test } from 'node:test'
import assert from 'node:assert/strict'

// 干净的密度环境：不被开发机上的 PONOS_TOKEN_DENSITY_* 干扰
const CLEAN_ENV = {}

const asciiSchema = (n = 1) => Array.from({ length: n }, (_, i) => ({
  name: `tool_${i}`,
  description: 'd'.repeat(200),
  input_schema: { type: 'object', properties: { a: { type: 'string' } } },
}))

// ── ① tools 进估算 ──────────────────────────────────────────────────────────

test('★ tools 计入请求面：含工具面的 total 必须明显大于不含（本次修复的核心）', () => {
  const messages = [{ role: 'user', content: 'hello' }]
  const without = estimateRequest({ system: 'sys', messages, opts: { env: CLEAN_ENV } })
  const tools = asciiSchema(10)
  const withTools = estimateRequest({ system: 'sys', messages, tools, opts: { env: CLEAN_ENV } })
  assert.ok(withTools.total > without.total, '含 tools 的估算必须更大')
  // 10 个 schema ≈ 3KB JSON ≈ 700+ token；漏计 tools 时两者相等（这正是事故形态）
  assert.ok(withTools.total - without.total >= 500, `差额应达工具面量级（实际 ${withTools.total - without.total}）`)
  // 分区可见：tools 段单独可读（重装排查时要能直接看到"固定前缀里工具占多少"）
  assert.equal(withTools.sections.tools, without.total === withTools.total ? 0 : withTools.sections.tools)
  assert.ok(withTools.sections.tools > 0, 'tools 分区必须 > 0')
})

test('tools 为 null / 空数组 ⇒ 与旧口径逐字一致（零回归）', () => {
  const messages = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'text', text: 'yo' }] }]
  const base = estimateRequest({ system: 'sys', messages, opts: { env: CLEAN_ENV } })
  for (const tools of [null, undefined, []]) {
    const got = estimateRequest({ system: 'sys', messages, tools, opts: { env: CLEAN_ENV } })
    assert.equal(got.total, base.total, `tools=${JSON.stringify(tools)} 时 total 必须不变`)
    assert.equal(got.sections.tools, 0)
  }
})

test('total == system + tools + task + tool_result + history（五区记账自洽）', () => {
  const messages = [
    { role: 'user', content: 'task' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(500) }] },
    { role: 'user', content: 'latest task' },
  ]
  const r = estimateRequest({ system: 's'.repeat(100), messages, tools: asciiSchema(3), opts: { env: CLEAN_ENV } })
  const s = r.sections
  assert.equal(r.total, s.system + s.tools + s.task + s.tool_result + s.history)
  assert.ok(s.tools > 0 && s.system > 0 && s.task > 0 && s.tool_result > 0, '五区都应非零')
})

test('工具面中文描述按字计价（不被 ASCII /3 密度低报）', () => {
  const cjk = [{ name: 'a', description: '中文描述'.repeat(100), input_schema: { type: 'object' } }]
  const ascii = [{ name: 'a', description: 'x'.repeat(400), input_schema: { type: 'object' } }]
  const tCjk = estimateRequest({ messages: [], tools: cjk, opts: { env: CLEAN_ENV } }).sections.tools
  const tAscii = estimateRequest({ messages: [], tools: ascii, opts: { env: CLEAN_ENV } }).sections.tools
  assert.ok(tCjk > tAscii, `同长度下中文工具面应更贵（cjk=${tCjk} ascii=${tAscii}）`)
})

test('同一 schemas 数组重复估算结果稳定（引用缓存不影响正确性）', () => {
  const tools = asciiSchema(5)
  const a = estimateRequest({ messages: [], tools, opts: { env: CLEAN_ENV } }).sections.tools
  const b = estimateRequest({ messages: [], tools, opts: { env: CLEAN_ENV } }).sections.tools
  assert.equal(a, b)
  // 不同数组（内容相同）也必须给出同一结果 —— 缓存键是引用，但计算是确定的
  const c = estimateRequest({ messages: [], tools: asciiSchema(5), opts: { env: CLEAN_ENV } }).sections.tools
  assert.equal(a, c)
})

// ── ② 工具面预算随窗口缩放 ─────────────────────────────────────────────────

test('★ 预算随窗口缩放：128K 远小于 1M，且都随窗口线性增长', () => {
  const w128 = dynamicToolBudgetForWindow(131_072, CLEAN_ENV)
  const w1m = dynamicToolBudgetForWindow(1_048_576, CLEAN_ENV)
  assert.ok(w128 > 0 && w1m > w128, `128K(${w128}) 必须小于 1M(${w1m})`)
  // 15% 窗口 × 3.5 B/token ≈ 68.8 KB @128K
  assert.equal(w128, Math.floor(131_072 * 0.15 * 3.5))
  assert.equal(w1m, Math.floor(1_048_576 * 0.15 * 3.5))
})

test('窗口未知/非法 ⇒ null（退回 T1.5 的"默认不裁"，kit 门禁与旧调用点零变化）', () => {
  for (const w of [null, undefined, 0, -1, NaN, 'abc']) {
    assert.equal(dynamicToolBudgetForWindow(w, CLEAN_ENV), null, `window=${String(w)} 应返回 null`)
  }
})

test('env 可覆盖：比例可调、比例 0 = 显式关闭、极小窗口有下限', () => {
  assert.equal(dynamicToolBudgetForWindow(131_072, { PONOS_TOOLS_BUDGET_WINDOW_RATIO: '0.30' }), Math.floor(131_072 * 0.3 * 3.5))
  assert.equal(dynamicToolBudgetForWindow(131_072, { PONOS_TOOLS_BUDGET_WINDOW_RATIO: '0' }), null, '0 = 关闭按窗口推导')
  // 极小窗口不得推出"把动态工具全裁光"的预算
  assert.equal(dynamicToolBudgetForWindow(1000, CLEAN_ENV), TOOLS_BUDGET_FLOOR_BYTES)
})

// ── ③ 真实注册表：不传 window 零回归 / 传 window 不裁静态工具 ──────────────

test('★ 真实注册表：不传 window ⇒ 静态工具一个不少（旧行为逐字不变）', () => {
  const reg = createToolRegistry({})
  const schemas = reg.toolSchemas()
  const names = schemas.map((s) => s.name)
  for (const must of ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob']) {
    assert.ok(names.includes(must), `静态工具 ${must} 不得丢失`)
  }
  // 与上一行同义但更强：传一个极大的 window 也不得裁掉静态工具
  const big = reg.toolSchemas({ window: 1_000_000_000 })
  assert.deepEqual(big.map((s) => s.name), names, '大窗口下工具面应与不传 window 完全一致')
})

test('★ 真实注册表：极小窗口也只裁动态、静态全留（丢 Read/Write 等于废掉会话）', () => {
  const reg = createToolRegistry({})
  const all = reg.toolSchemas().map((s) => s.name)
  const tiny = reg.toolSchemas({ window: 1 }).map((s) => s.name)
  const statics = all.filter((n) => !/_|^[a-z]/.test(n)) // 粗分：静态工具名是 PascalCase
  for (const must of ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob']) {
    assert.ok(tiny.includes(must), `极小窗口下静态工具 ${must} 仍须保留`)
  }
  assert.ok(tiny.length <= all.length, '裁剪只减不增')
  assert.ok(statics.length > 0)
})

test('applyDynamicToolBudget 与窗口预算联动：超预算时确实按预算收支（不虚报）', () => {
  const schemas = [...asciiSchema(3).map((s) => ({ ...s, name: 'Static' + s.name })), ...asciiSchema(40)]
  const budget = 4000
  const r = applyDynamicToolBudget(schemas, { maxBytes: budget, isStatic: (n) => n.startsWith('Static') })
  assert.ok(r.dropped.length > 0, '超预算必须有裁剪')
  assert.ok(r.bytesAfter <= r.bytesBefore, '裁剪后不得变大')
  // 静态 3 个必须全留
  for (const s of schemas.filter((x) => x.name.startsWith('Static'))) {
    assert.ok(r.schemas.some((x) => x.name === s.name), `静态 ${s.name} 不得被裁`)
  }
  assert.equal(r.schemas.length, schemas.length - r.dropped.length, '保留数 + 裁掉数 == 总数')
})

// ── ④ 不裁面（子 agent 的逃生路径）────────────────────────────────────────
// 子 agent 的 `allowedTools` 是"明确圈定的刚需"。若它也走按窗口裁剪的全量面，
// 一个被预算裁掉的工具会让 `filter` 得到**空集** ⇒ retryStream 收到 tools:[]
// ⇒ 子 agent 静默失去全部工具（engine 的空集守卫判的是注册表全量名册，兜不住）。
// ⇒ lane 改用 `toolSchemas()`（不传 window = 不裁）。本用例钉住"不裁面确实存在且有效"。
test('★ 不裁面存在：同一动态工具在传 window 时被裁、不传 window 时仍在（lane 逃生路径）', () => {
  const dynamicTools = () => ({
    mcp__demo__update_slider: {
      description: '[MCP:demo] ' + 'x'.repeat(4000), // 大描述 ⇒ 必然被预算挤出
      input_schema: { type: 'object', properties: { v: { type: 'number' } } },
      run: async () => ({ content: 'ok' }),
    },
  })
  const reg = createToolRegistry({ dynamicTools })
  const capped = reg.toolSchemas({ window: 1 })          // 预算落到 floor(8192)，静态面已超 ⇒ 动态全裁
  const uncapped = reg.toolSchemas()                     // 不传 window ⇒ 既有"不裁"行为
  assert.ok(reg.toolNames.includes('mcp__demo__update_slider'), '注册表里必须有该工具')
  assert.equal(capped.some((s) => s.name === 'mcp__demo__update_slider'), false, '传 window 时应被裁掉')
  assert.equal(uncapped.some((s) => s.name === 'mcp__demo__update_slider'), true, '不传 window 时必须仍在（lane 靠它避免空集）')
})
