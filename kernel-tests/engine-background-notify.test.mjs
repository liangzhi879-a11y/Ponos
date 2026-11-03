// engine 侧后台完成回调：子任务收口时必须通知宿主（cli 据此决定是否唤醒主 agent）。
//
// 背景（2026-09-21 长任务排查）：wire.taskNotification 只把完成事件写给 wire（喂 UI 的
// 任务卡片），**没有任何宿主回调** ⇒ 内核无法据此启动新一轮，用户必须手打消息才能续上。
// 本测试钉住"通知出口存在且带齐字段"，唤醒策略由 kernel/auto-wake.mjs 决定（另有其测试）。
//
// 建场范式照 kernel-tests/subagent-frontend-concurrency.test.mjs。
process.env.PONOS_MOCK_API = '1'
const { createEngine } = await import('../kernel/engine.mjs')
const { createSessionStore } = await import('../kernel/session.mjs')
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'bg-notify-'))
  const notified = []
  const notifs = []
  // wire 用 Proxy 兜底：任何未显式实现的方法都是 noop（不同 engine 版本会调不同帧），
  // 只显式收集 taskNotification（本测试关心它的同时是否有宿主回调）。
  const wire = new Proxy({}, {
    get: (_t, key) => {
      if (key === 'taskNotification') return (info) => { notifs.push(info) }
      return () => {}
    },
  })
  const session = createSessionStore({ configDir: dir, cwd: dir, sessionId: 'bg-notify' })
  const engine = createEngine({
    opts: {
      model: 'm',
      addDirs: [dir],
      skipPermissions: true,
      systemPrompt: '',
      configDir: dir,
      onBackgroundFinished: (info) => notified.push(info),
    },
    wire,
    session,
  })
  return { engine, notified, notifs, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

async function waitFor(fn, ms = 8000) {
  const t0 = Date.now()
  while (!fn() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100))
}

test('后台子任务收口时：宿主收到 onBackgroundFinished（kind=subagent、带 taskId 与状态）', async () => {
  const env = makeEnv()
  try {
    // 子 prompt 用普通文本 ⇒ mock 兜底让它快速产出文本并收口（[mock:sleep] 会挂 30s，不用）
    const r = await env.engine.spawnSubAgent(
      { subagent_type: 'general-purpose', prompt: '测试子任务：请输出一句确认', run_in_background: true },
      {},
    )
    assert.ok(r && typeof r === 'object', `后台派发应立即返回句柄对象，实际: ${JSON.stringify(r)?.slice(0, 200)}`)

    await waitFor(() => env.notified.length >= 1)
    assert.ok(env.notified.length >= 1, '宿主必须收到至少一次后台完成通知')

    const info = env.notified[0]
    assert.equal(info.kind, 'subagent', 'kind 应标识为子任务')
    assert.ok(typeof info.taskId === 'string' && info.taskId.length > 0, 'taskId 必须是非空字符串')
    assert.ok(['completed', 'failed', 'stopped'].includes(info.status), `状态取值应合法，实际: ${info.status}`)
    assert.ok(typeof info.summary === 'string', 'summary 应为字符串（供注入文本使用）')
  } finally {
    env.cleanup()
  }
})

test('wire.taskNotification 仍然照发（不得为加回调而破坏既有 UI 通知）', async () => {
  const env = makeEnv()
  try {
    await env.engine.spawnSubAgent(
      { subagent_type: 'general-purpose', prompt: '测试子任务：请输出一句确认', run_in_background: true },
      {},
    )
    await waitFor(() => env.notifs.length >= 1)
    assert.ok(env.notifs.length >= 1, '既有 taskNotification 帧不得丢失')
    assert.ok(env.notifs[0].taskId, 'taskNotification 应带 taskId')
  } finally {
    env.cleanup()
  }
})
