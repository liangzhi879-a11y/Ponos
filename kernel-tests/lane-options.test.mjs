// lane 参数骨架回归锁（spec P2-1① + AS1 零回归锁①）
// options 未定义/空 = 现状行为（全量工具、全量模型、无白名单过滤）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from '../kernel/engine.mjs'
import { createSessionStore } from '../kernel/session.mjs'
import { makeWire } from '../kernel/protocol.mjs'

process.env.PONOS_MOCK_API = '1'

function makeEnv() {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const dir = mkdtempSync(join(tmpdir(), 'ponos-laneopt-'))
  const configDir = join(dir, 'home')
  const store = createSessionStore({ configDir, cwd: dir, sessionId: 'main-session' })
  const engine = createEngine({
    opts: { model: 'mock-model', configDir, addDirs: [dir], skipPermissions: true },
    wire,
    session: store,
  })
  engine.setSystemPrompt('你是 Ponos-turbo 测试内核。')
  const laneFile = (taskId) => join(configDir, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'), `${taskId}.jsonl`)
  return { events, engine, store, dir, laneFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('零回归锁①：lane 无 options（现状路径）→ 工具全量可执行、model 沿用主模型', async () => {
  const env = makeEnv()
  try {
    // 后台 spawn，prompt 触发非高危 Bash——不传任何 agent 字段 ⇒ allowedTools 未定义 ⇒ Bash 放行
    const r = await env.engine.spawnSubAgent(
      { subagent_type: 'general-purpose', prompt: '[mock:tool-safe]', run_in_background: true },
      { toolUseId: 'tool_use_laneopt_1' },
    )
    const taskId = String(r.content).match(/task_id: ([0-9a-f-]+)/)?.[1]
    assert.ok(taskId)
    const deadline = Date.now() + 8000
    let notif = null
    while (Date.now() < deadline && !notif) {
      notif = env.events.find((e) => e.type === 'system' && e.subtype === 'task_notification' && e.task_id === taskId)
      await new Promise((res) => setTimeout(res, 10))
    }
    assert.ok(notif, 'task_notification 应到达')
    assert.equal(notif.status, 'completed')
    assert.match(String(notif.summary), /工具执行完成/)
    // 子 lane transcript：assistant 条目 model = 主模型 mock-model（options.model 未定义 → loopModel=model）
    const lines = readFileSync(env.laneFile(taskId), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const asst = lines.filter((e) => e.type === 'assistant')
    assert.ok(asst.length >= 1)
    assert.equal(asst[0].message.model, 'mock-model')
  } finally { env.cleanup() }
})
