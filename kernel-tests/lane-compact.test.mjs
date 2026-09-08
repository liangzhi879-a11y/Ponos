// P2-1③ lane 压缩：开关默认关（零回归）→ [mock:lane-iter] 长 lane 正常完成；开启后
// estimate 计数触发压缩 → laneStore 出现 compaction 条目、主 transcript 零污染。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from '../kernel/engine.mjs'
import { createSessionStore } from '../kernel/session.mjs'
import { makeWire } from '../kernel/protocol.mjs'

process.env.PONOS_MOCK_API = '1'

function makeEnv({ withCtx }) {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const dir = mkdtempSync(join(tmpdir(), 'ponos-lanecompact-'))
  const configDir = join(dir, 'home')
  const store = createSessionStore({ configDir, cwd: dir, sessionId: 'main-session' })
  const opts = { model: 'mock-model', configDir, addDirs: [dir], skipPermissions: true }
  if (withCtx) {
    // estimate 计数：第 1 次调用（lane 首轮仅 prompt 1 条）低于阈值；此后巨大（触发压缩）。
    // 另需 estimateMessage/estimateHistory：compact.mjs summarize 的 findCutPoint 按
    // 单条消息估算保留预算（compact.mjs:167-183/371-373），缺任一会在摘要路径抛
    // TypeError（stub 曾缺 → 观测 compact-error）。真实字符串 user 消息估 100k tokens
    // （含 [mock:lane-iter] 的初始 prompt 与第 3 轮末守卫⑤注入的"同工具提醒"真实用户
    // 消息——lane 唯二的真 user turn，后者成为保留起点）→ findCutPoint 可切出 covered。
    // 工具轮/工具结果（数组 content）估 10 → 前几轮无第二真实 user turn 时无切点（no-cut，
    // 非失败）→ 第 4 轮起命中"提醒为保留起点"的切点，摘要落地。
    let calls = 0
    const estMessage = (m) => (m?.role === 'user' && typeof m?.content === 'string') ? 100_000 : 10
    opts.context = {
      window: 200000,
      thresholdRatio: 0.8,
      retainRatio: 0.3,
      estimate({ messages }) {
        calls++
        const n = messages?.length ?? 0
        return { total: calls <= 1 || n < 3 ? 100 : 200_000_000 } // 消息足量后触发
      },
      estimateMessage: estMessage,
      estimateHistory: (msgs) => (msgs || []).reduce((a, m) => a + estMessage(m), 0),
    }
  }
  const engine = createEngine({ opts, wire, session: store })
  engine.setSystemPrompt('你是 Ponos-turbo 测试内核。')
  const laneFile = (taskId) => join(configDir, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'), `${taskId}.jsonl`)
  const waitNotif = async (taskId, timeoutMs = 12000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const n = events.find((e) => e.type === 'system' && e.subtype === 'task_notification' && e.task_id === taskId)
      if (n) return n
      await new Promise((res) => setTimeout(res, 10))
    }
    return null
  }
  return { events, engine, store, dir, laneFile, waitNotif, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('零回归锁②：PONOS_LANE_COMPACT 未设 → lane 无压缩（transcript 无 compaction 条目）', async () => {
  delete process.env.PONOS_LANE_COMPACT
  process.env.PONOS_MOCK_LANE_ITER_N = '0' // [mock:lane-iter] 轮次计数清零（同 engine-lane-heal.test.mjs）
  const env = makeEnv({ withCtx: true })
  try {
    const r = await env.engine.spawnSubAgent(
      { subagent_type: 'general-purpose', prompt: '[mock:lane-iter]', run_in_background: true },
      { toolUseId: 'tool_use_lc_1' },
    )
    const taskId = String(r.content).match(/task_id: ([0-9a-f-]+)/)?.[1]
    const notif = await env.waitNotif(taskId)
    assert.ok(notif)
    assert.equal(notif.status, 'completed')
    const text = readFileSync(env.laneFile(taskId), 'utf-8')
    assert.ok(!text.includes('"kind":"compaction"'), '关闭态 lane 不应压缩')
  } finally { env.cleanup() }
})

test('开启态：PONOS_LANE_COMPACT=1 + engineCtx → lane 摘要落地 + lane_compaction 事件 + 主会话零污染', async () => {
  process.env.PONOS_LANE_COMPACT = '1'
  process.env.PONOS_MOCK_LANE_ITER_N = '0' // 同上：轮次计数清零（上个测试已推进计数）
  const env = makeEnv({ withCtx: true })
  try {
    const r = await env.engine.spawnSubAgent(
      { subagent_type: 'general-purpose', prompt: '[mock:lane-iter]', run_in_background: true },
      { toolUseId: 'tool_use_lc_2' },
    )
    const taskId = String(r.content).match(/task_id: ([0-9a-f-]+)/)?.[1]
    const notif = await env.waitNotif(taskId, 15000)
    assert.ok(notif, 'lane 应完成')
    assert.equal(notif.status, 'completed')
    const laneText = readFileSync(env.laneFile(taskId), 'utf-8')
    assert.match(laneText, /"kind":"compaction"/)
    assert.match(laneText, /mock 摘要/)
    // 主 transcript：无 compaction 条目（lane 压缩不影响主会话）
    const mainText = readFileSync(env.store.file, 'utf-8')
    assert.ok(!mainText.includes('"kind":"compaction"'))
    // lane_compaction 事件带摘要文本
    assert.ok(env.events.some((e) => e.type === 'system' && e.subtype === 'lane_compaction' && typeof e.text === 'string'))
  } finally {
    delete process.env.PONOS_LANE_COMPACT
    env.cleanup()
  }
})
