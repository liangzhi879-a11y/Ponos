// engine.mjs 迁移 session 派生测试（Task 5 阶段2b：usage 累计 / 中间条目落盘 / turnStats）
// ---------------------------------------------------------------------------
// 直接 import engine.mjs 用内存 store 测试，避免 spawn 开销；工具循环用法同 mock。
// 偏离 brief 两处（见 task-5-report.md §5）：
//   1. setup 返回 wire 与 bind(engine)——brief 的 setup 未返回 wire，test 1 引用
//      wire 会 ReferenceError；
//   2. controlRequest 自动回执 allow——mock 高危 Bash（rm -rf）触发 can_use_tool 挂起，
//      brief 的 no-op wire 会永久挂起 runTurn（探针实测 hang）；审批协议本身由
//      kernel-engine（工具循环+审批闭环 / deny）与 kernel-bridge（端到端）覆盖，
//      本测试只验证 usage 累计与条目落盘，故 wire 自动放行。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from '../kernel/engine.mjs'
import { createSessionStore } from '../kernel/session.mjs'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'engine-session-'))
  const events = []
  let current = null // engine 创建后 bind，供 controlRequest 回执 allow
  const wire = {
    assistant: (blocks) => events.push({ type: 'assistant', blocks }),
    result: (usage, extra) => events.push({ type: 'result', usage, extra }),
    controlRequest: (req) => {
      // 高危 Bash 审批挂起 → 自动回执 allow（审批协议由 kernel-engine/bridge 覆盖）
      if (current) queueMicrotask(() => current.resolveApproval(req.toolUseId, { behavior: 'allow' }))
    },
    system: () => {},
    summary: () => {},
    health: () => {},
  }
  const session = createSessionStore({ configDir: dir, cwd: 'proj', sessionId: '00000000-0000-0000-0000-000000000003' })
  return { dir, events, session, wire, bind(engine) { current = engine } }
}

test('usage 逐次累计：工具循环多轮 API 调用全部计入 result.usage', async () => {
  const { dir, events, session, wire, bind } = setup()
  try {
    process.env.YFW_MOCK_API = '1'
    const engine = createEngine({ opts: { model: 'm', addDirs: [dir], skipPermissions: true, systemPrompt: '' }, wire, session })
    bind(engine)
    await engine.runTurn({ content: '[mock:tool]' })
    // mock 流：工具请求回合 + 工具结果回合 = 2 次 API 调用，各 10/20 → 累计 20/40
    const result = events.find((e) => e.type === 'result')
    assert.equal(result.usage.input_tokens, 20)
    assert.equal(result.usage.output_tokens, 40)
    assert.ok(Number.isFinite(result.extra.duration_ms))
    delete process.env.YFW_MOCK_API
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('中间工具条目落盘：assistant tool_use + user tool_result 进入 session', async () => {
  const { dir, session } = setup()
  try {
    process.env.YFW_MOCK_API = '1'
    let engine
    const wire = {
      assistant: () => {},
      result: () => {},
      controlRequest: (req) => queueMicrotask(() => engine?.resolveApproval(req.toolUseId, { behavior: 'allow' })),
      summary: () => {},
      health: () => {},
    }
    engine = createEngine({ opts: { model: 'm', addDirs: [dir], skipPermissions: true }, wire, session })
    await engine.runTurn({ content: '[mock:tool]' })
    const msgs = session.deriveMessages()
    const roles = msgs.map((m) => m.role)
    assert.ok(roles.includes('assistant'))
    assert.ok(msgs.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use')))
    assert.ok(msgs.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')))
    delete process.env.YFW_MOCK_API
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('turnStats 记录器：每轮一条，含 usage/durationMs/model/ts', async () => {
  const { dir, session } = setup()
  try {
    process.env.YFW_MOCK_API = '1'
    let engine
    const wire = {
      assistant: () => {},
      result: () => {},
      controlRequest: (req) => queueMicrotask(() => engine?.resolveApproval(req.toolUseId, { behavior: 'allow' })),
      summary: () => {},
      health: () => {},
    }
    engine = createEngine({ opts: { model: 'm', addDirs: [dir], skipPermissions: true }, wire, session })
    await engine.runTurn({ content: 'hello' })
    const stats = engine.getTurnStats()
    assert.equal(stats.length, 1)
    assert.equal(stats[0].model, 'm')
    assert.ok(stats[0].usage.output_tokens >= 0)
    assert.ok(Number.isFinite(stats[0].durationMs))
    assert.ok(stats[0].ts)
    delete process.env.YFW_MOCK_API
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
