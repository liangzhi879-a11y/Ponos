// 子 lane P0-2 截断拒执（审计 #1）：lane 流产出 tool_use 后 stop_reason=length 时，
// 残缺参数的 Bash 不得执行成功，而应转为 is_error tool_result（内容含"截断"）提示重发。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from '../kernel/engine.mjs'
import { createSessionStore } from '../kernel/session.mjs'
import { makeWire } from '../kernel/protocol.mjs'

process.env.PONOS_MOCK_API = '1'

function makeEnv() {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const dir = mkdtempSync(join(tmpdir(), 'ponos-lane-trunc-'))
  const configDir = join(dir, 'home')
  const store = createSessionStore({ configDir, cwd: dir, sessionId: 'main-session' })
  const engine = createEngine({
    opts: { model: 'mock-model', configDir, addDirs: [dir], skipPermissions: true },
    wire,
    session: store,
  })
  engine.setSystemPrompt('你是 Ponos-turbo 测试内核。')
  // 子 lane transcript 路径（同 subagent.test.mjs laneFile 规则）
  const laneFile = (taskId) => join(configDir, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'), `${taskId}.jsonl`)
  return { events, engine, store, dir, laneFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('子 lane：stop_reason=length 的 tool_use 不执行，落 is_error 提示后正常完成', async () => {
  const env = makeEnv()
  try {
    const r = await env.engine.runTurn({ content: '[mock:agent-lane-trunc]' })
    const sys = env.events.filter((e) => e.type === 'system')
    const started = sys.find((e) => e.subtype === 'task_started')
    assert.ok(started, '应有 task_started')
    // 前台子任务完成后通知存在
    const notif = sys.find((e) => e.subtype === 'task_notification' && e.task_id === started.task_id)
    assert.ok(notif, '应有 task_notification')
    // lane transcript 必须含"截断拒执"的 is_error tool_result
    const lane = readFileSync(env.laneFile(started.task_id), 'utf-8')
    assert.ok(lane.includes('截断'), `lane 转录应含截断拒执说明，实际：${lane.slice(-400)}`)
    assert.ok(lane.includes('"is_error":true') || lane.includes('is_error: true'), '拒执 tool_result 应为 is_error')
    // 主线程正常收尾
    assert.ok(String(r.text).length > 0)
  } finally { env.cleanup() }
})
