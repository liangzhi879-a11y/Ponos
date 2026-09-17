// 阶段②b 分块摘要（map-reduce；2026-09-10 小窗口模型切换适配）
// ---------------------------------------------------------------------------
// 背景：云端大窗口（1M/200K）会话切到本地小窗口模型（32K）时，covered 远超摘要
// 请求容量——单发摘要自身必 400（A4 限幅最多翻倍保留预算 4 次仍装不下），压缩
// 永不落地、每轮撞 400。分块：covered 按 turn 边界切成每块 ≤ 容量（limit − 输出
// 预算 − 余量）的段落，逐块滚动合并摘要（前块摘要作 <compacted-summary> 前缀注入
// 下一块），压缩请求恒装得下小窗口。本文件钉死：切块纪律（turn 边界/tool 配对）、
// 分块触发与落地、以及"装得下时不走分块"（单发路径零回归）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { splitCoveredIntoChunks, createCompactor, chunkMergeInstruction } from '../kernel/compact.mjs'
import { estimateMessage, estimateHistory, estimateRequest } from '../kernel/context.mjs'
import { createSessionStore } from '../kernel/session.mjs'

process.env.PONOS_MOCK_API = '1'

const user = (content) => ({ role: 'user', content })
const assistantText = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] })
const assistantTool = (id, name) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] })
const toolResultMsg = (id, text) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] })

test('splitCoveredIntoChunks：按 turn 边界切块，并集=covered、保序、每块从 turn 起点开始', () => {
  const covered = []
  for (let i = 0; i < 10; i++) {
    covered.push(user(`task ${i} ` + 'x'.repeat(200)))
    covered.push(assistantText('a'.repeat(200)))
  }
  // 每 turn ≈ 2×(50+4+4)=116 tokens；chunkBudget 350 → 每 3 个 turn 一块（4 块）
  const chunks = splitCoveredIntoChunks({ covered, chunkBudget: 350, estimateMessage })
  assert.equal(chunks.length, 4)
  assert.deepEqual(chunks.flat(), covered, '并集保序等于 covered')
  for (const c of chunks) {
    assert.equal(c[0].role, 'user', '每块从真实 user turn 起点开始')
    assert.ok(c.every((m, i) => i % 2 === 0 ? m.role === 'user' : m.role === 'assistant'), 'turn 结构完整')
  }
})

test('splitCoveredIntoChunks：tool_use/tool_result 配对不拆（预算边界落在配对中间也同块）', () => {
  const covered = [
    user('t1 ' + 'x'.repeat(200)), assistantText('a'.repeat(200)),   // turn 1 ≈ 116
    user('t2 ' + 'x'.repeat(200)), assistantTool('u1', 'Read'),      // turn 2：tool_use ≈ 116
    toolResultMsg('u1', 'r'.repeat(300)),                            // 结果 ≈ 80（预算边界将落在此处）
    user('t3 ' + 'x'.repeat(200)), assistantText('b'.repeat(200)),   // turn 3
  ]
  const chunks = splitCoveredIntoChunks({ covered, chunkBudget: 250, estimateMessage })
  // turn 2 的 tool_use 与 tool_result 必须同块：t2 前已达 116，t2+tool_use=232 ≤ 250
  // 仍同块，tool_result 使 232+80>250 但 tool_result 非 turn 起点 → 继续同块收进 chunk 1
  assert.equal(chunks.length, 2)
  const turn2 = chunks[0].slice(2)
  assert.equal(turn2.length, 3, 't2 的 user/assistant(tool_use)/user(tool_result) 同块')
  assert.equal(turn2[1].content[0].type, 'tool_use')
  assert.equal(turn2[2].content[0].type, 'tool_result')
  assert.equal(chunks[1][0], covered[5], '下一块从 t3 turn 起点开始')
})

test('splitCoveredIntoChunks：单条超预算消息自成一块（不拆消息）', () => {
  const covered = [user('huge ' + 'x'.repeat(3000)), assistantText('small')]
  const chunks = splitCoveredIntoChunks({ covered, chunkBudget: 100, estimateMessage })
  assert.equal(chunks.length, 1)
  assert.deepEqual(chunks[0], covered, '超预算 turn 不撕裂')
})

test('splitCoveredIntoChunks：空/非法输入 → 空数组', () => {
  assert.deepEqual(splitCoveredIntoChunks({ covered: [], chunkBudget: 100, estimateMessage }), [])
  assert.deepEqual(splitCoveredIntoChunks({ covered: null, chunkBudget: 100, estimateMessage }), [])
})

test('chunkMergeInstruction：含压缩指令关键字（mock 摘要检测依赖）与分段序号', () => {
  const s = chunkMergeInstruction(2, 5)
  assert.ok(s.includes('系统压缩指令'), 'mock 摘要检测按此关键字分流')
  assert.ok(s.includes('第 2/5 段'), '分段序号可见')
  assert.ok(s.includes('<compacted-summary>'), '输出格式要求保留')
})

// —— 端到端：covered ≫ 小窗口 → 分块滚动合并落地 ——
// entityTurns > 0 时在前 N 个 turn 写入**真实形态的关键事实**（Write 工具调用 + TodoWrite +
// 决策文本），供保真门禁（P0-2）用例复现"摘要丢了关键事实"；
// 默认 0 → 纯 CJK 无关键事实，既有用例零影响（无基准时 audit 走 skipped，门禁必 pass）。
// 2026-09-17 口径变更：判定基准已是 key-info 契约（任务清单/文件变更/最近决策），
// **只把路径塞进 user 文本不再构成基准**（那正是"压缩一次就误报"的旧口径，已废弃）。
function makeCompactorEnv({ turns = 35, limit = 32768, entityTurns = 0 } = {}) {
  const events = []
  const wire = {
    system: (subtype, payload) => events.push({ subtype, ...(payload || {}) }),
    summary: () => {},
  }
  const dir = mkdtempSync(join(tmpdir(), 'ponos-chunked-'))
  const store = createSessionStore({ configDir: dir, cwd: dir, sessionId: 'chunked-session' })
  // CJK 文本（密度 1/字）：每消息 ≈ 410 字 ≈ 414 tokens，每 turn ≈ 836 tokens，
  // 35 turns ≈ 29K tokens > 单块容量 20.5K（limit 32768 时）→ 触发分块
  const cjk = '这是一段用于撑满上下文的压缩测试文本内容，包含足够多的汉字来让估算器按中文字符密度计价。'
  const ENT = '请修改 C:/Users/T203-15/yfworking/kernel/compact.mjs 与 '
    + 'C:/Users/T203-15/yfworking/server/bridge.mjs，端口 ports=8080，超时 timeoutMs=45000。'
  const ENT_FILES = [
    'C:/Users/T203-15/yfworking/kernel/compact.mjs',
    'C:/Users/T203-15/yfworking/server/bridge.mjs',
  ]
  for (let i = 0; i < turns; i++) {
    store.appendUser(`第 ${i} 轮任务：${i < entityTurns ? ENT : ''}${cjk.repeat(10)}`)
    const blocks = [{ type: 'text', text: `第 ${i} 轮回答：${cjk.repeat(10)}` }]
    if (i < entityTurns) {
      for (const p of ENT_FILES) {
        blocks.push({ type: 'tool_use', id: `w:${i}:${p}`, name: 'Write', input: { file_path: p, content: 'x' } })
      }
      blocks.push({
        type: 'tool_use', id: `todo:${i}`, name: 'TodoWrite',
        input: { todos: [{ content: '修改 compact.mjs 与 bridge.mjs' }] },
      })
    }
    store.appendAssistant(blocks)
  }
  const context = {
    window: limit,
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
  return {
    events, store, context, compactor, dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('端到端：covered 超单块容量 → 分块摘要落地（mode=chunked，compaction 事件带分块数）', async () => {
  const env = makeCompactorEnv()
  try {
    const r = await env.compactor.forceCompact({ system: 'sys', messages: env.store.deriveMessages(), limit: 32768 })
    assert.equal(r.action, 'summarized', `应压缩落地：${JSON.stringify(r).slice(0, 300)}`)
    assert.equal(r.mode, 'chunked')
    assert.ok(r.chunks >= 2, `covered ≈25K > 单块容量 20.5K，应分 ≥2 块（实际 ${r.chunks}）`)
    assert.ok(r.coveredTokens > 20000)
    // 事件：start 带 mode/chunks，done 对称收尾
    assert.ok(env.events.some((e) => e.subtype === 'compaction' && e.state === 'start' && e.mode === 'chunked' && e.chunks === r.chunks))
    assert.ok(env.events.some((e) => e.subtype === 'compaction' && e.state === 'done' && e.ok === true))
    // transcript 落 compaction 条目（lane 测试同口径）
    const text = readFileSync(env.store.file, 'utf-8')
    assert.match(text, /"kind":"compaction"/)
    assert.match(text, /mock 摘要/)
  } finally { env.cleanup() }
})

test('端到端：covered 装得下单块容量 → 不走分块（单发路径零回归）', async () => {
  // 90 turns ≈ 75K tokens；limit 200K 时保留预算 32K → covered ≈ 43K ∈ (0, 单块容量 187K)
  // 有真实切点、装得下 → 走单发摘要（A4 限幅路径不变）
  const env = makeCompactorEnv({ turns: 90, limit: 200_000 })
  try {
    const r = await env.compactor.forceCompact({ system: 'sys', messages: env.store.deriveMessages(), limit: 200_000 })
    assert.equal(r.action, 'summarized', JSON.stringify(r).slice(0, 300))
    assert.notEqual(r.mode, 'chunked', '装得下时保持单发摘要（A4 限幅路径不变）')
  } finally { env.cleanup() }
})

// ---------------------------------------------------------------------------
// P0-2 保真门禁（2026-09-16）：审计从"落地后观测"改为"写入决策的输入"
// ---------------------------------------------------------------------------
// 关键：mock 摘要恒为 `mock 摘要`（无任何实体），若被覆盖区间含高信号实体（路径/端口/
// 阈值），确定性审计必然报"大面积丢失" → 门禁不通过 → 换切点重压。
// 两条用例成对，缺一则结论不成立：
//   ① 有实体 → 门禁必须**触发重压**（否则说明门禁根本没接线）
//   ② 无实体 → 门禁必须**不误拦**（否则说明判据过于激进，会白烧摘要调用）
// ①②都要求"压缩仍然落地"——"宁可有损，不无限重试"是硬不变量。
test('P0-2 保真门禁：审计不通过 → 换切点重压；且压缩仍然落地（不变量）', async () => {
  const env = makeCompactorEnv({ turns: 90, limit: 200_000, entityTurns: 8 })
  try {
    const r = await env.compactor.forceCompact({ system: 'sys', messages: env.store.deriveMessages(), limit: 200_000 })
    // ① 门禁真的拦下了（**防"门禁没接线"假绿**：若判据恒 pass，这里会是 0）
    assert.ok(
      r.gateFailures >= 1,
      `覆盖区间含高信号实体而摘要全丢，门禁应触发换切点重压；实际 gateFailures=${r.gateFailures}，返回=${JSON.stringify(r).slice(0, 300)}`,
    )
    // ② 压缩仍然落地（硬不变量：宁可有损，不无限重试烧时间）
    assert.equal(r.action, 'summarized', `门禁不该让压缩不落地：${JSON.stringify(r).slice(0, 300)}`)
    assert.equal(env.store.compactCount(), 1,  '压缩必须恰好落地一次')
    // ③ 预算耗尽如实降级，不静默（mock 摘要恒丢实体 → 重压到达上限后只能带病落地）
    assert.equal(r.gateExhausted, true, '重压预算耗尽后应 gateExhausted=true（不静默降级）')
    // transcript 仍留下 compaction 条目（落地证据）
    const text = readFileSync(env.store.file, 'utf-8')
    assert.match(text, /"kind":"compaction"/)
  } finally { env.cleanup() }
})

test('P0-2 保真门禁：覆盖区间无高信号实体时不误拦（防误报白烧调用）', async () => {
  // 说明：本用例**不用**会话夹具构造"无实体"场景——夹具消息必然含"第 N 轮"这类数字，
  // 而数字属高信号实体（`extractEntities(kinds:'key')`），会被审计计入 → 门禁必然拦。
  // 因此"skipped / 实体不足 / 缺失率不足"这三种"不该拦"的情形由纯函数判据单测精确覆盖
  // （见 compact-fidelity.test.mjs 的 fidelityGate 用例），本文件只保留 e2e 正向用例。
  const env = makeCompactorEnv({ turns: 90, limit: 200_000, entityTurns: 1 })
  try {
    const r = await env.compactor.forceCompact({ system: 'sys', messages: env.store.deriveMessages(), limit: 200_000 })
    assert.equal(r.action, 'summarized', JSON.stringify(r).slice(0, 300))
    // 无论门禁拦或不拦，压缩都必须落地且计数可见（不变量 + 可观测）
    assert.equal(env.store.compactCount(), 1)
    assert.equal(typeof r.gateFailures, 'number')
    assert.equal(typeof r.gateExhausted, 'boolean')
  } finally { env.cleanup() }
})
