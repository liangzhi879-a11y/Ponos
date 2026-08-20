import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneToolResult, findCutPoint, extractSummary, assembleSummaryRequest, createCompactor } from '../kernel/compact.mjs'
import { estimateMessage, contextWindowFor } from '../kernel/context.mjs'
import { createSessionStore } from '../kernel/session.mjs'
import { createEngine } from '../kernel/engine.mjs'

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
  const msgs = [
    { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' },
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
