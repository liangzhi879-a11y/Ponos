// 工具按需加载（deferred tools）—— 2026-10-26
// ---------------------------------------------------------------------------
// 范式来源：Claude Code 的 ToolSearch / Codex 的 tool_search（详见 kernel/tool-search.mjs 顶部）。
// 本文件锁四件事：
//   ① MCP 工具默认**不进** toolSchemas()（不占前缀），但名字可从 deferredToolNames() 取到；
//   ② ToolSearch 取回后，工具**粘性**进入后续每轮的 toolSchemas()（能力从未消失）；
//   ③ ToolSearch 自身永不 deferred（模型得先用它才能加载别的 —— CC 同款规则）；
//   ④ 检索是确定性的（同一输入同一结果），空查询不得把整个 deferred 面一次性灌回来。
process.env.PONOS_MOCK_API = '1'
const { createToolRegistry } = await import('../kernel/tools.mjs')
const { searchDeferredTools, parseToolSearchQuery, TOOL_SEARCH_NAME, TOOL_SEARCH_DEFAULT_LIMIT } = await import('../kernel/tool-search.mjs')
import { test } from 'node:test'
import assert from 'node:assert/strict'

/** 造一个"像 MCP 那样"的动态工具视图：默认 deferred */
function mcpView(defs) {
  const view = {}
  for (const [short, desc] of defs) {
    view[`mcp__demo__${short}`] = {
      description: `[MCP:demo] ${desc}`,
      input_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      deferred: true,
      concurrencySafe: false,
      run: async () => ({ content: 'ok', isError: false }),
    }
  }
  return view
}

const DEMO = [
  ['read_scene', 'Read the current scene, layers and selection'],
  ['apply_keyframes', 'Animate a property with keyframes'],
  ['update_slot_value', 'Update a design token slot value'],
]
const ALL_NAMES = DEMO.map(([n]) => `mcp__demo__${n}`)

// ── ① 默认不投递 ────────────────────────────────────────────────────────────
test('★ MCP 工具默认不进 toolSchemas（不占前缀），但名字可投递', () => {
  const reg = createToolRegistry({ dynamicTools: () => mcpView(DEMO) })
  const delivered = reg.toolSchemas().map((s) => s.name)
  for (const n of ALL_NAMES) {
    assert.equal(delivered.includes(n), false, `${n} 不应出现在初始工具面（deferred）`)
    assert.ok(reg.toolNames.includes(n), `${n} 仍在注册表里（能力没被删）`)
  }
  // 名字必须能从 deferred 出口拿到 —— 否则模型不知道有它们（等于删掉）
  assert.deepEqual(reg.deferredToolNames().sort(), [...ALL_NAMES].sort())
  // ToolSearch 自身必须是**静态可见**的（否则没有取回通道）
  assert.ok(delivered.includes(TOOL_SEARCH_NAME), 'ToolSearch 必须在初始工具面里')
  assert.equal(reg.deferredToolNames().includes(TOOL_SEARCH_NAME), false, 'ToolSearch 自身永不 deferred')
})

test('静态工具一个不少（deferred 只作用于动态工具）', () => {
  const reg = createToolRegistry({ dynamicTools: () => mcpView(DEMO) })
  const delivered = reg.toolSchemas().map((s) => s.name)
  for (const must of ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob']) {
    assert.ok(delivered.includes(must), `静态工具 ${must} 必须在`)
  }
})

// ── ② 取回 + 粘性 ──────────────────────────────────────────────────────────
test('★ ToolSearch 取回后工具粘性进入后续 toolSchemas（能力从未丢失）', () => {
  const reg = createToolRegistry({ dynamicTools: () => mcpView(DEMO) })
  const search = reg.registry[TOOL_SEARCH_NAME]
  assert.ok(search?.run, 'ToolSearch 必须注册在 registry 里')

  const before = reg.toolSchemas().map((s) => s.name)
  assert.equal(before.includes('mcp__demo__read_scene'), false)

  const out = search.run({ query: 'select:mcp__demo__read_scene' })
  assert.ok(String(out.content).includes('mcp__demo__read_scene'), '结果应回显取回的工具名')
  assert.ok(String(out.content).includes('<functions>'), '结果应带完整 schema 的 <functions> 块')
  assert.ok(String(out.content).includes('"parameters"'), '必须是完整参数结构（否则模型无法调用）')

  // 解锁状态
  assert.deepEqual(reg.loadedDeferredNames(), ['mcp__demo__read_scene'])
  // 粘性：后续每轮都投递
  const after = reg.toolSchemas().map((s) => s.name)
  assert.ok(after.includes('mcp__demo__read_scene'), '取回后必须进入 toolSchemas（粘性）')
  assert.equal(after.includes('mcp__demo__apply_keyframes'), false, '未取回的仍不投递')
  // 幂等：再取一次不重复、不报错
  search.run({ query: 'select:mcp__demo__read_scene' })
  assert.deepEqual(reg.loadedDeferredNames(), ['mcp__demo__read_scene'])
})

test('关键词检索同样能取回（模型不必知道精确工具名）', () => {
  const reg = createToolRegistry({ dynamicTools: () => mcpView(DEMO) })
  const out = reg.registry[TOOL_SEARCH_NAME].run({ query: 'keyframe' })
  assert.ok(String(out.content).includes('mcp__demo__apply_keyframes'), '关键词应命中 apply_keyframes')
  assert.ok(reg.loadedDeferredNames().includes('mcp__demo__apply_keyframes'))
})

test('取回不存在的工具：如实说没匹配到，且不污染解锁状态', () => {
  const reg = createToolRegistry({ dynamicTools: () => mcpView(DEMO) })
  const out = reg.registry[TOOL_SEARCH_NAME].run({ query: 'select:nope__nothing' })
  assert.ok(String(out.content).includes('未匹配到'), '应如实报告未匹配（不得假装成功）')
  assert.deepEqual(reg.loadedDeferredNames(), [])
})

// ── ③ includeDeferred（子 agent 的 allowedTools 逃生阀）────────────────────
test('★ includeDeferred：子 agent 圈定的 deferred 工具仍能取到（否则 lane 会拿到空集）', () => {
  const reg = createToolRegistry({ dynamicTools: () => mcpView(DEMO) })
  const capped = reg.toolSchemas()               // 默认：不含 deferred
  assert.equal(capped.some((s) => s.name === 'mcp__demo__read_scene'), false)
  const uncapped = reg.toolSchemas({ includeDeferred: true })
  assert.ok(uncapped.some((s) => s.name === 'mcp__demo__read_scene'), 'includeDeferred 必须能拿到未解锁的 deferred 工具')
  // 该逃生阀不改变解锁状态（它只是"传出去"，不是"取回"）
  assert.deepEqual(reg.loadedDeferredNames(), [])
})

// ── ④ 检索层纯函数 ─────────────────────────────────────────────────────────
test('parseToolSearchQuery：三种形态', () => {
  assert.deepEqual(parseToolSearchQuery('select:A,b'), { mode: 'select', names: ['A', 'b'], required: [], terms: [] })
  assert.deepEqual(parseToolSearchQuery('select：甲,乙'), { mode: 'select', names: ['甲', '乙'], required: [], terms: [] }, '全角冒号也要认')
  assert.deepEqual(parseToolSearchQuery('+slack send message'), { mode: 'keywords', names: [], required: ['slack'], terms: ['send', 'message'] })
  assert.deepEqual(parseToolSearchQuery(''), { mode: 'keywords', names: [], required: [], terms: [] })
})

test('★ 确定性 + 空查询不灌全量：同一输入两次结果逐字相同，空查询返回 0 条', () => {
  const entries = ALL_NAMES.map((n, i) => ({ name: n, description: DEMO[i][1] }))
  const a = searchDeferredTools(entries, 'read')
  const b = searchDeferredTools(entries, 'read')
  assert.deepEqual(a, b, '同一输入必须同一结果（可复现）')
  assert.deepEqual(searchDeferredTools(entries, '').matched, [], '空查询不得把整个 deferred 面一次性灌回')
  assert.deepEqual(searchDeferredTools(entries, '   ').matched, [])
})

test('必需词过滤：+slack 只留含 slack 的（不是降权）', () => {
  const entries = [
    { name: 'mcp__a__send_message', description: 'send a message' },
    { name: 'mcp__slack__send_message', description: 'send a message to slack' },
  ]
  const r = searchDeferredTools(entries, '+slack message')
  assert.equal(r.matched.length, 1)
  assert.equal(r.matched[0].name, 'mcp__slack__send_message')
})

test('返回条数受上限约束（默认 8，硬上限 40）', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ name: `mcp__x__tool_${i}`, description: 'thing' }))
  const d = searchDeferredTools(many, 'tool')
  assert.equal(d.matched.length, TOOL_SEARCH_DEFAULT_LIMIT)
  assert.equal(d.truncated, true)
  assert.ok(d.total > d.matched.length, 'total 应报告真实匹配数（不截断）')
  const big = searchDeferredTools(many, 'tool', { maxResults: 999 })
  assert.ok(big.matched.length <= 40, 'maxResults 硬上限 40（防模型一次灌回整个面）')
})
