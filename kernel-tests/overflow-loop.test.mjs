// 长会话溢出"无限重发"（2026-09-12 UI 上下文压缩条闪烁事故）
// ---------------------------------------------------------------------------
// 事故：DS 大上下文会话切到自建 vLLM（Qwen3.8-27B，max_model_len=180000）后，
// 历史 1604 条消息（估 583K token）远超窗口，每一轮请求必 400 context-window：
//   · 摘要请求自身也超窗 → 压缩永不落地（会话文件 0 条 compaction 条目）
//   · 溢出分支的硬适配（fitRequestToWindow）算得出装得下的请求面（实测 3 条 / 估 36K）
//   · 但副本在 `continue` 之前被**无条件清空**（`overflowTrimmed = null`）→
//     下一迭代又发原始 985KB 请求 → 400 → 再硬适配 → 再清空 …… 无限
//   · 线上实测 7 分钟重发同一份 985KB 请求 240 次 + 摘要请求 200 次；用户侧是
//     压缩条 ~1Hz 闪烁（每次摘要 start/done(ok:false) 一对）+ 服务端被持续轰炸，
//     会话文件 0 条新记录（turn 永不结束），错误类型一变（服务端宕机）才收尾。
// 本文件钉死两条：
//   ① 瘦身副本必须被当次重试**真正用上**（too-big：只有硬适配副本能过）；
//   ② 极端形态（瘦身后依旧装不下）必须收敛到终局可见文案 + 调用次数有界，
//      且预算耗尽后不再付摘要成本（每次摘要都是一次完整 API 请求）。
// mock 形态见 api.mjs 的 too-big 门控（放摘要检测分支之前——端点不会因为请求是
// "压缩用的"就放宽窗口，这正是事故形态）。
process.env.PONOS_MOCK_API = '1'
const { createEngine } = await import('../kernel/engine.mjs')
import { createCompactor } from '../kernel/compact.mjs'
import { estimateRequest, estimateMessage, estimateHistory } from '../kernel/context.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore } from '../kernel/session.mjs'
import { makeWire } from '../kernel/protocol.mjs'

const MOCK_ENVS = ['PONOS_MOCK_OVERFLOW', 'PONOS_MOCK_OVERFLOW_COUNT', 'PONOS_MOCK_OVERFLOW_CONSUMED']
function clearMock() { for (const k of MOCK_ENVS) delete process.env[k] }

// 超时护栏：修复前 runTurn 永不返回（无限重发），护栏把挂起变成明确失败
async function withTimeout(promise, ms, label) {
  let timer
  const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label}：${ms}ms 内未收敛（疑似无限重发）`)), ms) })
  try { return await Promise.race([promise, guard]) } finally { clearTimeout(timer) }
}

// 长会话夹具：60 条消息 / 184KB / 估 61K token，窗口 40K → 远超窗口且
// 摘要请求（保留 + covered）同样 >50KB，复现"压缩请求自身也超窗"（事故形态）。
function setup({ pairs = 30, window = 40000 } = {}) {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const dir = mkdtempSync(join(tmpdir(), 'overflow-loop-'))
  const configDir = join(dir, 'home')
  const session = createSessionStore({ configDir, cwd: 'proj', sessionId: '00000000-0000-0000-0000-0000000000aa' })
  const filler = '历史工具输出：' + '这是一段足够长的历史内容，用于把估算撑到窗口之上。'.repeat(40)
  for (let i = 0; i < pairs; i++) {
    session.appendUser(`${filler}（第 ${i} 轮）`)
    session.appendAssistant([{ type: 'text', text: filler }], { model: 'm' })
  }
  const context = {
    window,
    thresholdRatio: 0.8,
    retainRatio: 0.16,
    estimate: ({ system, messages }) => estimateRequest({ system, messages }),
    estimateMessage,
    estimateHistory,
  }
  const compactor = createCompactor({ session, context, model: 'm', maxTokens: 8192, wire, health: null, signal: undefined, env: process.env, sessionMemoryPath: null })
  const engine = createEngine({
    opts: { model: 'm', configDir, addDirs: [dir], skipPermissions: true, systemPrompt: '', context },
    wire, session, compactor,
  })
  return { dir, events, session, engine }
}
const compactionStarts = (events) => events.filter((e) => e.type === 'system' && e.subtype === 'compaction' && e.state === 'start').length
const hasReason = (events, reason) => events.some((e) => e.type === 'system' && e.subtype === 'request_trimmed' && e.reason === reason)

test('溢出重试：瘦身副本必须被当次重试用上（旧实现清空副本 → 同一超窗请求无限重发）', async () => {
  clearMock()
  process.env.PONOS_MOCK_OVERFLOW = 'too-big' // >50KB 的请求（含摘要请求）一律 400
  const { dir, events, session, engine } = setup()
  try {
    const before = session.deriveMessages().length
    // 修复前：全量请求 400 → 硬适配出瘦身面 → 被清空 → 全量再发 …… runTurn 永不返回
    const result = await withTimeout(engine.runTurn({ content: '继续' }), 10_000, '溢出重试')
    // 瘦身面（系统提示 + 最近一轮 + <history-index>，≈10KB）能过 → 正常收尾，不落放弃文案
    const text = String(result.text || '')
    assert.ok(text.length > 0, '瘦身后应正常作答，实际空结果')
    assert.ok(!text.includes('上下文已超出模型窗口'), `不应落到放弃文案：${text.slice(0, 200)}`)
    // 确实走的是溢出分支（否则本用例可能因夹具不再超窗而空过）
    assert.ok(hasReason(events, 'hard-fit'), '应发出 request_trimmed:hard-fit（硬适配副本被真正使用）')
    // 压缩未落地（摘要请求自身超窗）→ 请求面瘦身不得改写 transcript
    assert.equal(session.compactCount(), 0, '摘要请求自身超窗时应 0 次压缩落地')
    assert.equal(session.deriveMessages().length, before + 2, 'transcript 只应新增本轮 user/assistant 两条')
    // 调用次数有界（修复前无界：线上实测 240 次全量请求 + 200 次摘要请求）
    const calls = Number(process.env.PONOS_MOCK_OVERFLOW_COUNT || 0)
    assert.ok(calls > 0 && calls <= 10, `调用次数应远小于无界重发，实际 ${calls}`)
  } finally {
    clearMock()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('溢出重试：瘦身后依旧装不下 → 收敛到可见文案 + 调用次数有界（不再无界空转）', async () => {
  clearMock()
  process.env.PONOS_MOCK_OVERFLOW = 'too-big:1' // 任何请求都超窗：连瘦身面也装不下
  const { dir, events, session, engine } = setup()
  try {
    const before = session.deriveMessages().length
    const t0 = Date.now()
    const result = await withTimeout(engine.runTurn({ content: '继续' }), 20_000, '溢出重试上限')
    const elapsed = Date.now() - t0
    const text = String(result.text || '')
    // 终局可见文案：会话保留、原因可见（空结果会让 GUI 静默卡死）
    assert.ok(text.includes('上下文已超出模型窗口'), `应落终局可见文案，实际：${text.slice(0, 300)}`)
    assert.ok(elapsed < 20_000, `应快速收敛，实际 ${elapsed}ms`)
    // 调用次数有界：溢出重试上限 12（每次重试至多 1 主请求 + 1 摘要请求）
    const calls = Number(process.env.PONOS_MOCK_OVERFLOW_COUNT || 0)
    assert.ok(calls > 0 && calls <= 40, `调用次数应受上限约束，实际 ${calls}`)
    // 压缩空转（用户侧的压缩条闪烁）同样有界
    assert.ok(compactionStarts(events) <= 20, `摘要尝试次数应受约束，实际 ${compactionStarts(events)}`)
    assert.equal(session.compactCount(), 0)
    assert.equal(session.deriveMessages().length, before + 2, '放弃文案落 transcript，历史不被改写')
  } finally {
    clearMock()
    rmSync(dir, { recursive: true, force: true })
  }
})
