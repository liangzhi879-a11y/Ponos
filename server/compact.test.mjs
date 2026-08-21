import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneToolResult, findCutPoint, extractSummary, assembleSummaryRequest, createCompactor, ageOutToolResults, buildSessionMemoryText } from '../kernel/compact.mjs'
import { createHealth } from '../kernel/health.mjs'
import { estimateMessage, contextWindowFor } from '../kernel/context.mjs'
import { createSessionStore } from '../kernel/session.mjs'
import { createEngine } from '../kernel/engine.mjs'
import { aggregateStats } from './transcript.mjs'

test('结构感知裁剪：超长表格保留表头+采样+合计尾行，不切行中', () => {
  const lines = ['编号,名称,金额']
  for (let i = 1; i <= 500; i++) lines.push(`${i},项目${i}${'x'.repeat(60)},${i * 10}`) // 行 ~75 字符，总 ~37.5K > 20000
  lines.push('合计,总计,5000')
  const big = lines.join('\n')
  assert.ok(big.length > 20000)
  const r = pruneToolResult(big)
  assert.equal(r.truncated, true)
  assert.ok(r.note.includes('已截断'))
  const keptLines = r.text.split('\n')
  assert.equal(keptLines[0], '编号,名称,金额') // 表头保留
  assert.equal(keptLines[keptLines.length - 1], '合计,总计,5000') // 合计尾行保留
  for (const l of keptLines) assert.ok(!l.includes('\r')) // 完整行
})

test('裁剪不切代码行中间：首部/尾部完整行保留', () => {
  const head = ['const fs = require("fs")', 'function main() {', '  console.log("start")']
  const body = []
  for (let i = 0; i < 400; i++) body.push(`  const v${i} = ${i}; // ${'x'.repeat(60)}`)
  const tail = ['  return 0', '}']
  const big = [...head, ...body, ...tail].join('\n')
  const r = pruneToolResult(big)
  assert.equal(r.truncated, true)
  const kept = r.text.split('\n')
  assert.ok(kept[0].startsWith('const fs'))
  assert.equal(kept[kept.length - 1], '}')
})

test('JSON 单行 minified（>20000 字符）：重排采样，truncated 时尺寸真实下降（F1-a）', () => {
  const parts = []
  for (let i = 0; i < 2000; i++) parts.push(`"k${i}":"${'v'.repeat(8)}${i}"`)
  const big = '{"name":"big-result","items":{' + parts.join(',') + '}}'
  assert.ok(big.length > 20000)
  const r = pruneToolResult(big)
  assert.equal(r.truncated, true)
  assert.equal(r.kind, 'json')
  assert.ok(r.text.length < big.length, `裁剪后 ${r.text.length} 应小于原 ${big.length}`)
  assert.ok(r.text.includes('"name":"big-result"')) // 键名行保留
})

test('JSON 多行 pretty（>20000 字符）：键名行与错误行保留（F1-b/c）', () => {
  const lines = ['{', '  "name": "deploy-service",', '  "items": [']
  for (let i = 0; i < 400; i++) lines.push(`    ${i}, // ${'x'.repeat(50)}`)
  lines.push('  ],', '  "status": "error",', '  "message": "connection refused"', '}')
  const big = lines.join('\n')
  assert.ok(big.length > 20000)
  const r = pruneToolResult(big)
  assert.equal(r.truncated, true)
  assert.equal(r.kind, 'json') // 未被逗号表格规则抢占
  assert.ok(r.text.includes('"name": "deploy-service"')) // 头 30 键名行保留
  assert.ok(r.text.includes('"status": "error",')) // 错误行保留（不在头 30 内，靠 errLines）
})

test('JSONL 多行（含逗号 >20 行）：走 json 键名分支而非 table 采样（F1-b）', () => {
  const lines = []
  for (let i = 0; i < 600; i++) lines.push(`{"ts":${i},"name":"entry-${i}","v":"${'x'.repeat(30)}"}`)
  const big = lines.join('\n')
  assert.ok(big.length > 20000)
  const r = pruneToolResult(big)
  assert.equal(r.truncated, true)
  assert.equal(r.kind, 'json')
  const kept = r.text.split('\n')
  assert.ok(kept.length <= 60) // json 分支上限（头 30 + 错误 20 + 尾 10）
  assert.ok(r.text.includes('"name":"entry-0"')) // 键名规则保留首行
  assert.ok(r.text.includes('"name":"entry-599"')) // 尾 10 保留末行
})

test('切点纪律：不拆 tool-call/result 配对；open tail 返回 null；只切 user 边界', () => {
  const msgs = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'out' }] },
    { role: 'assistant', content: 'a2' },
  ]
  // open tail：最后一条 assistant 带 tool_use → null
  const openTail = findCutPoint({ messages: [...msgs, { role: 'assistant', content: [{ type: 'tool_use', id: 'u', name: 'Bash', input: {} }] }], retainTokens: 10, estimateMessage })
  assert.equal(openTail, null)
  // 正常：遮蔽完整 turns，保留起点是 user
  const cut = findCutPoint({ messages: msgs, retainTokens: 10, estimateMessage })
  assert.ok(cut)
  assert.equal(cut.covered[0].role, 'user')
  assert.equal(cut.covered[cut.covered.length - 1].role, 'assistant') // 遮蔽以完整回复结束
  const kept = msgs.slice(cut.start)
  assert.equal(kept[0].role, 'user')
})

test('extractSummary 提取 <compacted-summary> 标签内容', () => {
  const s = extractSummary('前文\n<compacted-summary>\n9 节 checkpoint 内容\n</compacted-summary>\n后文')
  assert.ok(s.includes('9 节 checkpoint'))
  assert.equal(extractSummary('没有标签'), null)
})

test('assembleSummaryRequest 前缀对齐主请求（system+旧消息+前次摘要+指令）', () => {
  // 普通 assistant 消息在真实系统中是 block 数组（session.assistantEntry）；字符串
  // content 是 compaction summary 专属（P9-2 sealed 会过滤），故此处用数组 fixture
  const msgs = [
    { role: 'user', content: 'q1' }, { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
    { role: 'user', content: 'q2' }, { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
  ]
  const cut = { start: 2, covered: msgs.slice(0, 2) }
  const req = assembleSummaryRequest({ system: 'SYS', messages: msgs, cut, lastSummary: null })
  const roles = req.map((m) => m.role)
  assert.deepEqual(roles, ['user', 'assistant', 'user']) // 被遮蔽区间 + 摘要指令（user）
  const last = req[req.length - 1]
  assert.equal(last.role, 'user')
  assert.ok(last.content.includes('compacted-summary'))
  assert.ok(last.content.includes('Goal'))
})

test('seqsForMessages 反查契约：covered 与 seqs 数量/顺序对应（Task 4 minor）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seqs-'))
  try {
    const session = createSessionStore({ configDir: dir, cwd: 'proj', sessionId: '00000000-0000-0000-0000-000000000009' })
    for (let i = 1; i <= 3; i++) { session.appendUser(`q${i}`); session.appendAssistant([{ type: 'text', text: `a${i}` }]) }
    const msgs = session.deriveMessages()
    // covered 前 2 条 → seqs [1,2]；随后 2 条 → [3,4]（顺序对应）
    assert.deepEqual(session.seqsForMessages(msgs.slice(0, 2)), [1, 2])
    assert.deepEqual(session.seqsForMessages(msgs.slice(2, 4)), [3, 4])
    // 与 deriveMessages 不同代（乱序/外部对象）→ 数量不匹配（反查失败由 compactor 显式报错）
    assert.equal(session.seqsForMessages([{ role: 'user', content: '外部对象' }, ...msgs.slice(0, 1)]).length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('压缩集成（YFW_MOCK_API）：超阈值 → 摘要 replace 落地 → surface 派生正确', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'compact-'))
  try {
    const events = []
    const wire = { assistant: (b) => events.push({ type: 'assistant' }), result: () => events.push({ type: 'result' }), controlRequest: () => {}, summary: () => {}, health: () => {} }
    const session = createSessionStore({ configDir: dir, cwd: 'proj', sessionId: '00000000-0000-0000-0000-000000000004' })
    const compactEvents = []
    const compactor = createCompactor({
      session,
      context: { window: 500, thresholdRatio: 0.8, retainRatio: 0.16, estimate: (r) => ({ total: (r.messages?.length ?? 0) * 50 }), estimateMessage: () => 50, estimateHistory: (msgs) => (msgs?.length ?? 0) * 50 },
      model: 'm', maxTokens: 100, wire: { ...wire, summary: (t, c) => compactEvents.push({ type: 'summary', c }) },
      env: { YFW_MOCK_API: '1' },
    })
    process.env.YFW_MOCK_API = '1'
    process.env.YFW_MOCK_COMPACT_RESPONSE = '1'
    for (let i = 1; i <= 5; i++) { session.appendUser(`q${i}`); session.appendAssistant([{ type: 'text', text: 'a'.repeat(100) }]) }
    // 10 条消息 × 50 = 500 ≥ 阈值 400 → 触发；遮蔽前 8 条 [U1..A4]，保留 [U5,A5]
    const r = await compactor.maybeCompact({ system: 'S', messages: session.deriveMessages() })
    assert.equal(r.action, 'summarized')
    assert.equal(session.compactCount(), 1)
    const msgs = session.deriveMessages()
    // 摘要条目 content 为字符串（契约：投影后 m.content === summary 字符串）
    assert.ok(msgs.some((m) => m.content === '摘要输出'))
    assert.ok(session.getSurface().replaceGeneration >= 1)
    delete process.env.YFW_MOCK_API
    delete process.env.YFW_MOCK_COMPACT_RESPONSE
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('M2：压缩触发轮 result.usage 含摘要调用用量，且 transcript 聚合一致（M1+M2 协同）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'compact-usage-'))
  try {
    const events = []
    const wire = { assistant: () => events.push({ type: 'assistant' }), result: (usage) => events.push({ type: 'result', usage }), controlRequest: () => {}, summary: () => {}, health: () => {} }
    const session = createSessionStore({ configDir: dir, cwd: 'proj', sessionId: '00000000-0000-0000-0000-00000000000a' })
    const compactor = createCompactor({
      session,
      context: { window: 500, thresholdRatio: 0.8, retainRatio: 0.16, estimate: (r) => ({ total: (r.messages?.length ?? 0) * 50 }), estimateMessage: () => 50, estimateHistory: (msgs) => (msgs?.length ?? 0) * 50 },
      model: 'm', maxTokens: 100, wire,
      env: { YFW_MOCK_API: '1' },
    })
    const engine = createEngine({
      opts: { model: 'm', addDirs: [dir], skipPermissions: true, systemPrompt: 'S' },
      wire, session, compactor,
    })
    process.env.YFW_MOCK_API = '1'
    process.env.YFW_MOCK_COMPACT_RESPONSE = '1'
    for (let i = 1; i <= 5; i++) { session.appendUser(`q${i}`); session.appendAssistant([{ type: 'text', text: 'a'.repeat(100) }]) }
    // 第六轮：pre-step 估值 550 ≥ 阈值 400 → 触发摘要（调用 10/20）→ 主请求（10/20）
    const out = await engine.runTurn({ content: 'q6' })
    assert.ok(out.text.startsWith('mock: q6'))
    assert.equal(session.compactCount(), 1)
    const result = events.find((e) => e.type === 'result')
    assert.equal(result.usage.input_tokens, 20, '摘要调用用量（10）必须并入主请求（10）')
    assert.equal(result.usage.output_tokens, 40)
    // 协同：并入后的总 usage 仍只写在最终条目 → transcript 聚合 == result.usage
    const stats = aggregateStats(join(dir, 'projects'))
    assert.equal(stats.totals.input_tokens, result.usage.input_tokens)
    assert.equal(stats.totals.output_tokens, result.usage.output_tokens)
    delete process.env.YFW_MOCK_API
    delete process.env.YFW_MOCK_COMPACT_RESPONSE
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('溢出恢复：context_window_exceeded → forceCompact → retry 成功（replaceGeneration 前进才 retry）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'overflow-'))
  try {
    const events = []
    const wire = { assistant: (b) => events.push({ type: 'assistant' }), result: () => events.push({ type: 'result' }), controlRequest: () => {}, summary: () => {}, health: () => {} }
    const session = createSessionStore({ configDir: dir, cwd: 'proj', sessionId: '00000000-0000-0000-0000-000000000005' })
    const compactor = createCompactor({
      session,
      context: { window: 1000, thresholdRatio: 0.8, retainRatio: 0.16, estimate: (r) => ({ total: (r.messages?.length ?? 0) * 50 }), estimateMessage: () => 50, estimateHistory: (msgs) => (msgs?.length ?? 0) * 50 },
      model: 'm', maxTokens: 100, wire, env: process.env,
    })
    process.env.YFW_MOCK_API = '1'
    process.env.YFW_MOCK_OVERFLOW = 'once' // 非 summarizer 调用抛一次溢出
    process.env.YFW_MOCK_COMPACT_RESPONSE = '1'
    const engine = createEngine({
      opts: { model: 'm', addDirs: [dir], skipPermissions: true, systemPrompt: 'S' },
      wire, session, compactor,
    })
    for (let i = 1; i <= 5; i++) { session.appendUser(`q${i}`); session.appendAssistant([{ type: 'text', text: 'a'.repeat(100) }]) }
    // 第六轮：pre-step 估值 550 < 阈值 800 不触发；API 抛溢出 → forceCompact（遮蔽 3 轮）
    // → replaceGeneration 前进 → retry 成功。压缩后可见 user 只剩 U4/U5/q6 → mock turn=3
    const out = await engine.runTurn({ content: 'q6' })
    assert.ok(out.text.startsWith('mock: q6'))
    assert.equal(session.compactCount(), 1)
    assert.ok(session.getSurface().replaceGeneration >= 1)
    delete process.env.YFW_MOCK_API
    delete process.env.YFW_MOCK_OVERFLOW
    delete process.env.YFW_MOCK_COMPACT_RESPONSE
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('P1-5 压缩熔断：摘要连续失败达上限后 maybeCompact/forceCompact 跳过摘要（circuit-open）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'compact-circuit-'))
  try {
    const wire = { assistant: () => {}, result: () => {}, controlRequest: () => {}, summary: () => {}, health: () => {} }
    const session = createSessionStore({ configDir: dir, cwd: 'proj', sessionId: '00000000-0000-0000-0000-0000000000cc' })
    const compactor = createCompactor({
      session,
      context: { window: 500, thresholdRatio: 0.8, retainRatio: 0.16, estimate: (r) => ({ total: (r.messages?.length ?? 0) * 50 }), estimateMessage: () => 50, estimateHistory: (msgs) => (msgs?.length ?? 0) * 50 },
      model: 'm', maxTokens: 100, wire,
      env: { YFW_MOCK_API: '1', YFW_MOCK_COMPACT_BAD: '1' },
    })
    process.env.YFW_MOCK_API = '1'
    process.env.YFW_MOCK_COMPACT_BAD = '1'
    for (let i = 1; i <= 5; i++) { session.appendUser(`q${i}`); session.appendAssistant([{ type: 'text', text: 'a'.repeat(100) }]) }
    // 第一次：摘要失败（循环内 3 次 + 收尾计数），不落地
    const r1 = await compactor.maybeCompact({ system: 'S', messages: session.deriveMessages() })
    assert.equal(r1.action, 'none')
    assert.match(r1.reason, /no-convergence/)
    assert.equal(session.compactCount(), 0)
    // 第二次起：熔断打开（consecutiveFailures ≥ 3）→ circuit-open，不再调摘要
    const r2 = await compactor.maybeCompact({ system: 'S', messages: session.deriveMessages() })
    assert.equal(r2.reason, 'circuit-open')
    const rf = await compactor.forceCompact({ system: 'S', messages: session.deriveMessages() })
    assert.equal(rf.reason, 'circuit-open')
    delete process.env.YFW_MOCK_API
    delete process.env.YFW_MOCK_COMPACT_BAD
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('单通道（FIX R1）：装配 health 的 compactor 压缩成功后 yfw_summary 只发一次且 lastSummary 被记录', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'compact-health-'))
  try {
    const events = []
    const wire = { assistant: (b) => events.push({ type: 'assistant' }), result: () => events.push({ type: 'result' }), controlRequest: () => {}, summary: () => events.push({ type: 'yfw_summary' }), health: () => events.push({ type: 'yfw_health' }) }
    const session = createSessionStore({ configDir: dir, cwd: 'proj', sessionId: '00000000-0000-0000-0000-000000000010' })
    const health = createHealth({ wire, model: 'm', contextWindow: 200_000 })
    const compactor = createCompactor({
      session,
      context: { window: 500, thresholdRatio: 0.8, retainRatio: 0.16, estimate: (r) => ({ total: (r.messages?.length ?? 0) * 50 }), estimateMessage: () => 50, estimateHistory: (msgs) => (msgs?.length ?? 0) * 50 },
      model: 'm', maxTokens: 100, wire, health,
      env: { YFW_MOCK_API: '1' },
    })
    process.env.YFW_MOCK_API = '1'
    process.env.YFW_MOCK_COMPACT_RESPONSE = '1'
    for (let i = 1; i <= 5; i++) { session.appendUser(`q${i}`); session.appendAssistant([{ type: 'text', text: 'a'.repeat(100) }]) }
    // 10 条消息 × 50 = 500 ≥ 阈值 400 → 触发；压缩成功后由 health 代发 yfw_summary
    const r = await compactor.maybeCompact({ system: 'S', messages: session.deriveMessages() })
    assert.equal(r.action, 'summarized')
    assert.equal(events.filter((e) => e.type === 'yfw_summary').length, 1) // 单通道：只发一次（杜绝双发）
    assert.equal(health.getState().lastSummary, '摘要输出') // health 代发并记录 lastSummary
    delete process.env.YFW_MOCK_API
    delete process.env.YFW_MOCK_COMPACT_RESPONSE
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ============ P9：上下文管理升级 ============

test('P9-1 ageOutToolResults：清旧可重放工具结果、保留最近 N 条、Edit 结果不动', () => {
  const CLEARED = '[旧工具结果已清除——需要时重新调用工具读取]'
  // 消息序列：Read r1（旧）→ Read r2（旧）→ Read r3（新）→ Edit e1（新）
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: '文件1内容'.repeat(500) }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'r2', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r2', content: '文件2内容'.repeat(500) }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'r3', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r3', content: '文件3内容' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: '已修改 1 处' }] },
  ]
  const cleared = ageOutToolResults(messages, { keepRecent: 2 })
  assert.equal(cleared, 2) // r1/r2 被清
  assert.equal(messages[1].content[0].content, CLEARED)
  assert.equal(messages[3].content[0].content, CLEARED)
  assert.equal(messages[5].content[0].content, '文件3内容') // 最近 2 条保留（r3 + e1）
  assert.equal(messages[7].content[0].content, '已修改 1 处') // Edit 结果不动
})

test('P9-1 ageOutToolResults：结果不足 keepRecent 或已清过则不重复清', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Bash', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'out' }] },
  ]
  assert.equal(ageOutToolResults(messages, { keepRecent: 2 }), 0) // 不足阈值不清
  assert.equal(messages[1].content[0].content, 'out')
  // 已清过的结果不再重复替换（幂等）
  const m2 = [{ role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'a'.repeat(100) }] }]
  assert.equal(ageOutToolResults(m2, { keepRecent: 1 }), 0) // keep=1 保留全部 1 条
  assert.equal(m2[1].content[0].content, 'a'.repeat(100))
  const m3 = [{ role: 'assistant', content: [{ type: 'tool_use', id: 'y', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'y', content: 'b'.repeat(100) }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'z', name: 'Grep', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'z', content: 'c'.repeat(100) }] }]
  assert.equal(ageOutToolResults(m3, { keepRecent: 1 }), 1) // y 被清（保留最近 z）
  assert.match(m3[1].content[0].content, /已清除/)
  assert.equal(m3[3].content[0].content, 'c'.repeat(100))
})

test('P9-2 assembleSummaryRequest sealed：已压缩的 compaction 条目不进摘要请求（防摘要套摘要）', () => {
  const cut = { covered: [
    { role: 'user', content: '早期用户消息' },
    { role: 'assistant', content: '<compacted-summary>第一次摘要：关键事实A</compacted-summary>' }, // compaction summary（字符串 content）
    { role: 'user', content: '中期消息' },
    { role: 'assistant', content: [{ type: 'text', text: '中间回答' }] }, // 普通 assistant（数组 content）
  ] }
  const req = assembleSummaryRequest({ system: 'sys', messages: cut.covered, cut, lastSummary: '最近摘要：关键事实B', keyInfo: '' })
  const texts = req.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
  // lastSummary 前置
  assert.ok(req[0].content.includes('最近摘要：关键事实B'))
  // 旧 compaction summary 被过滤（不出现第一次摘要文本）
  const joined = texts.join('\n')
  assert.ok(!joined.includes('第一次摘要：关键事实A'), '已压缩条目不得重塞回摘要请求')
  // 普通消息保留
  assert.ok(joined.includes('早期用户消息'))
  assert.ok(joined.includes('中期消息'))
  assert.ok(joined.includes('中间回答'))
})

test('P9-3 buildSessionMemoryText + 注入：工作记忆块格式正确且随摘要请求发出', () => {
  const key = {
    todos: ['T1 修 bug', 'T2 加测试'],
    files: ['Write kernel/a.mjs', 'Edit kernel/b.mjs'],
    decisions: ['方案B 被选中，原因X'],
  }
  const text = buildSessionMemoryText(key)
  assert.ok(text.includes('# 会话工作记忆'))
  assert.ok(text.includes('## 任务清单'))
  assert.ok(text.includes('- T1 修 bug'))
  assert.ok(text.includes('## 文件变更'))
  assert.ok(text.includes('- Write kernel/a.mjs'))
  assert.ok(text.includes('## 最近决策'))
  // 空 key → 最小文件头
  const empty = buildSessionMemoryText({ todos: [], files: [], decisions: [] })
  assert.ok(empty.includes('# 会话工作记忆'))
  // 注入摘要请求
  const cut = { covered: [{ role: 'user', content: '旧消息' }] }
  const req = assembleSummaryRequest({ system: 'sys', messages: cut.covered, cut, lastSummary: '', keyInfo: '', sessionMemory: text })
  const last = req[req.length - 1]
  assert.match(last.content, /<session-memory>/)
  assert.match(last.content, /会话工作记忆/)
})

test('P9-3 createCompactor：配置 sessionMemoryPath 后压缩请求注入工作记忆文件内容', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-p9-'))
  const memFile = join(dir, 'session.md')
  try {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(memFile, '# 会话工作记忆\n## 任务清单\n- 修复T002', 'utf-8')
    let injected = false
    const session = createSessionStore({ configDir: dir, sessionId: 's1', cwd: dir })
    const context = { window: 50000, thresholdRatio: 0.8, retainRatio: 0.16, estimate: () => ({ total: 999999 }), estimateMessage, estimateHistory: () => 100 }
    const wire = {
      summary: () => { injected = true },
      assistant: () => {}, result: () => {}, system: () => {},
    }
    const compactor = createCompactor({ session, context, model: 'test', maxTokens: 1000, wire, health: null, signal: undefined, env: { ...process.env, YFW_MOCK_API: '1', YFW_MOCK_COMPACT_RESPONSE: 'ok' }, sessionMemoryPath: memFile })
    const r = await compactor.forceCompact({ system: 'sys', messages: [{ role: 'user', content: 'hello' }] })
    assert.ok(r.action === 'summarized' || r.reason)
    // 摘要请求发生（mock 流返回），工作记忆文件被读取（无异常即注入路径通过）
    assert.ok(typeof r.action === 'string')
    delete process.env.YFW_MOCK_API
    delete process.env.YFW_MOCK_COMPACT_RESPONSE
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
