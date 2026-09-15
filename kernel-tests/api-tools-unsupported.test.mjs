// 工具能力未开启（2026-09-12 线上 400 事故）——分类 + 主循环/lane 收尾引导
// ---------------------------------------------------------------------------
// 事故：provider（自建 vLLM + Qwen3.8-27B）未以 --enable-auto-tool-choice
// --tool-call-parser 启动 → 任何带 tools 的 Anthropic 协议请求回 400
//   {"type":"error","error":{"type":"BadRequestError","message":""auto" tool choice
//    requires --enable-auto-tool-choice and --tool-call-parser to be set"}}
// 实测六种请求组合（.yfw-harness/toolprobe.mjs，直连 vLLM 原生 /v1/chat/completions
// 与 Anthropic 翻译层两路）只有"不带 tools"与 tool_choice:none 能过 —— 客户端无可
// 绕过的空间。旧行为：classify unknown → 用户看到裸英文内部错误，且 isCacheRejection
// 对任意 400 成立（PONOS_PROMPT_CACHE=1 时）会把同一个 400 原样重发一次。
// 本文件钉死：①分类命中且 retryable:false；②engine 主循环与子 lane 都落可操作中文引导
// （点名启动参数与换 provider 两条路），且**不自动去掉 tools**——本应用靠工具执行任务，
// 静默降级只会让模型空谈不干活，比报错更难排查。
process.env.PONOS_MOCK_API = '1'
const { createEngine } = await import('../kernel/engine.mjs')
import { classifyApiError, toolsUnsupportedError } from '../kernel/api.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore } from '../kernel/session.mjs'
import { makeWire } from '../kernel/protocol.mjs'

// 线上原报文（逐字，含转义后的双引号——分类不得依赖 JSON 是否合法）
const LIVE_400 = '内核：API 请求失败 400 {"type":"error","error":{"type":"BadRequestError","message":""auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set"}}'

test('classifyApiError：vLLM 原报文 → tools-unsupported（终局，不重试）', () => {
  const err = new Error(LIVE_400)
  err.status = 400
  assert.deepEqual(classifyApiError(err), { kind: 'tools-unsupported', retryable: false })
  // 构造器与线上报文同形（engine/mock/测试三处共用，防文案漂移）
  assert.deepEqual(classifyApiError(toolsUnsupportedError()), { kind: 'tools-unsupported', retryable: false })
})

test('classifyApiError：同类端点的"不支持工具"否定句同样命中（大小写/措辞容差）', () => {
  const cases = [
    'This model does not support tools',
    'tools are not supported by this model',
    'tool calling is not enabled for this deployment',
    'tool_choice is not available',
    'Tools are disabled on this endpoint',
  ]
  for (const msg of cases) {
    const e = new Error(`400 ${msg}`)
    e.status = 400
    assert.equal(classifyApiError(e).kind, 'tools-unsupported', `应命中：${msg}`)
  }
  const e422 = new Error('422 tool calling is not enabled')
  e422.status = 422
  assert.equal(classifyApiError(e422).kind, 'tools-unsupported')
})

test('classifyApiError：不误伤既有分类（上下文溢出/模型不存在/非工具类 not supported）', () => {
  const ctx = new Error('400 {"error":{"message":"This model\'s maximum context length is 32768 tokens."}}')
  ctx.status = 400
  assert.equal(classifyApiError(ctx).kind, 'context-window')
  const mnf = new Error('404 Model qwen-old not found')
  mnf.status = 404
  assert.equal(classifyApiError(mnf).kind, 'model-not-found')
  // 含 "not supported" 但与工具无关 → 不得吞成 tools-unsupported
  const other = new Error('400 response_format json_schema is not supported')
  other.status = 400
  assert.notEqual(classifyApiError(other).kind, 'tools-unsupported')
  // 非 400/422（5xx 瞬时故障）即便文案含工具语义也按可重试处理，防误杀合法重试
  const five = new Error('503 tools are not enabled')
  five.status = 503
  assert.equal(classifyApiError(five).kind, 'transient')
})

test('主循环：[mock:tools-unsupported] → 快速失败 + 可操作引导（不急停/不静默去 tools）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tools-unsupported-'))
  const wire = {
    assistant: () => {}, result: () => {}, controlRequest: () => {}, system: () => {},
    summary: () => {}, health: () => {}, warning: () => {},
  }
  const session = createSessionStore({ configDir: dir, cwd: 'proj', sessionId: '00000000-0000-0000-0000-00000000000f' })
  try {
    const engine = createEngine({ opts: { model: 'm', addDirs: [dir], skipPermissions: true, systemPrompt: '' }, wire, session })
    const t0 = Date.now()
    const result = await engine.runTurn({ content: '[mock:tools-unsupported]' })
    const elapsed = Date.now() - t0
    const text = String(result.text || '')
    assert.ok(text.includes('工具调用'), `应收工具调用相关提示，实际：${text.slice(0, 300)}`)
    // 可操作：点名启动参数 + 备选路径（换 provider）
    assert.ok(text.includes('--enable-auto-tool-choice'), `应给出 vLLM 启动参数，实际：${text.slice(0, 300)}`)
    assert.ok(text.includes('--tool-call-parser'), '应给出 tool-call-parser 参数')
    assert.ok(text.includes('provider'), '应给出换 provider 的备选路径')
    // 终局错误不重试（retryable:false）：mock 无重试，报错应瞬时返回而非等退避
    assert.ok(elapsed < 3000, `应快速失败，实际耗时 ${elapsed}ms`)
    // 会话保留可续聊（同其它守卫：优雅收尾不丢任务）
    const again = await engine.runTurn({ content: '继续' })
    assert.ok(typeof again.text === 'string' && again.text.length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('子 lane：[mock:agent-lane-notools] → 子任务收尾说明含同一引导（不得静默丢工具重试）', async () => {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const dir = mkdtempSync(join(tmpdir(), 'tools-unsupported-lane-'))
  const configDir = join(dir, 'home') // 子 lane store 落点（镜像 engine-guard-deadstream lane 用例）
  const session = createSessionStore({ configDir, cwd: 'proj', sessionId: '00000000-0000-0000-0000-000000000010' })
  try {
    const engine = createEngine({ opts: { model: 'm', configDir, addDirs: [dir], skipPermissions: true, systemPrompt: '' }, wire, session })
    await engine.runTurn({ content: '[mock:agent-lane-notools]' })
    const sys = events.filter((e) => e.type === 'system')
    const started = sys.find((e) => e.subtype === 'task_started')
    assert.ok(started, '应有 task_started（子 lane 已起）')
    const notif = JSON.stringify(sys.find((e) => e.subtype === 'task_notification' && e.task_id === started.task_id) || {})
    assert.ok(notif.includes('工具调用'), `lane 收尾应含工具调用语义，实际：${notif.slice(0, 400)}`)
    assert.ok(notif.includes('--enable-auto-tool-choice'), `lane 收尾应给出启动参数，实际：${notif.slice(0, 400)}`)
    assert.ok(notif.includes('provider'), 'lane 收尾应引导检查 provider')
    // 反证：不得落"输出中断/上游空流"等误分类文案（不同错误路径不得混淆）
    assert.ok(!notif.includes('推理中途停顿') && !notif.includes('上游服务空流'), `不得误分类，实际：${notif.slice(0, 400)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
