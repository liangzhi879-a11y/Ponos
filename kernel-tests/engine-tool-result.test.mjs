// agent loop wire 协议——工具结果 live 回传（2026-09-09 会话 UI 标准化 Q4）
// ---------------------------------------------------------------------------
// 背景：wire 协议此前只发 text/thinking/tool_use，工具结果仅落盘 transcript
// （GUI 历史回放才可见）。新增 tool_result 通道后，GUI 内联工具卡片可实时展示
// "执行中/完成/失败"状态与结果。本测试用 mock API（[mock:loop] 每次请求产出
// Bash 工具）驱动真实 runToolBatch 执行，断言 wire.toolResult 被正确发射。
// 注意：PONOS_* 阈值在 engine 模块求值期冻结 → env 必须在 import 前设定。
process.env.PONOS_MOCK_API = '1'
process.env.PONOS_MOCK_LOOP = 'ok'            // mock 每请求产出 Bash(echo mock-loop-ok)（api.mjs 每调用读 env）
process.env.PONOS_LOOP_MAX_ITERATIONS = '2'   // mock 每请求都产 Bash，限制迭代防无限
process.env.PONOS_STREAM_IDLE_MS = '5000'
const { createEngine } = await import('../kernel/engine.mjs')
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore } from '../kernel/session.mjs'

test('[mock:loop] 工具执行后 wire 发射 tool_result（成功态，含内容与 toolUseId）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-tool-result-'))
  const toolResults = []
  const wire = {
    assistant: () => {}, result: () => {}, controlRequest: () => {}, system: () => {},
    summary: () => {}, health: () => {}, warning: () => {},
    toolResult: (e) => { toolResults.push(e) },
  }
  const session = createSessionStore({ configDir: dir, cwd: 'proj', sessionId: '00000000-0000-0000-0000-000000000010' })
  try {
    const engine = createEngine({ opts: { model: 'm', addDirs: [dir], skipPermissions: true, systemPrompt: '' }, wire, session })
    await engine.runTurn({ content: '[mock:loop]' })
    assert.ok(toolResults.length >= 1, `应发射至少 1 条 tool_result，实际 ${toolResults.length}`)
    const first = toolResults[0]
    assert.ok(first.toolUseId, 'tool_result 必须携带 toolUseId')
    assert.equal(first.isError, false, 'echo mock-loop-ok 应成功')
    assert.ok(String(first.content).includes('mock-loop-ok'), `结果应含命令输出，实际: ${String(first.content).slice(0, 80)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('[mock:loop] 失败工具发射 is_error=true 的 tool_result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-tool-result-fail-'))
  const toolResults = []
  const wire = {
    assistant: () => {}, result: () => {}, controlRequest: () => {}, system: () => {},
    summary: () => {}, health: () => {}, warning: () => {},
    toolResult: (e) => { toolResults.push(e) },
  }
  const session = createSessionStore({ configDir: dir, cwd: 'proj', sessionId: '00000000-0000-0000-0000-000000000011' })
  try {
    process.env.PONOS_MOCK_LOOP = 'fail' // Bash exit 1 → is_error
    const engine = createEngine({ opts: { model: 'm', addDirs: [dir], skipPermissions: true, systemPrompt: '' }, wire, session })
    await engine.runTurn({ content: 'x' })
    const failed = toolResults.filter((r) => r.isError === true)
    assert.ok(failed.length >= 1, `应发射至少 1 条失败 tool_result，实际失败条数 ${failed.length}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
