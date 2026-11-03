// 前台子代理必须登记进 pendingSubAgents（否则外层工具 deadline 抢答后成"孤儿"：
// Task 查不到 / 停不了 / 续不了，且槽位要等 exec() 真正结束才释放）。
//
// 背景（2026-09-21 长任务排查）：实测"工具执行超时（300000ms）"60 次，其中 57 次是 Agent
// 子代理 —— 超时返回后子 lane 仍在跑，但 taskSystem 全部方法都走 pendingSubAgents.get()，
// 只有 run_in_background 分支登记过 ⇒ 前台任务成幽灵。
//
// ★ 关键约束：runningCount() 已经用 foregroundRunning 计入了前台任务，
// 故前台登记必须带 _foreground 标记并让 runningCount 跳过它，**不得双重计数**
// （双重计数会让后台并发预算凭空减半）。本文件用"前台在跑时计数应为 1"钉住这一点。
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
  const dir = mkdtempSync(join(tmpdir(), 'fg-lane-'))
  const wire = new Proxy({}, { get: () => () => {} })
  const session = createSessionStore({ configDir: dir, cwd: dir, sessionId: 'fg-lane' })
  const engine = createEngine({
    opts: { model: 'm', addDirs: [dir], skipPermissions: true, systemPrompt: '', configDir: dir },
    wire,
    session,
  })
  return { engine, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

async function waitFor(fn, ms = 5000) {
  const t0 = Date.now()
  while (!fn() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10))
}

/** 前台条目 = 带 _foreground 标记的登记（与后台任务区分） */
function foregroundEntries(engine) {
  return [...engine.pendingSubAgents.entries()].filter(([, t]) => t._foreground === true)
}

test('前台子代理执行期间登记进 pendingSubAgents（Task list 可查，不再孤儿）', async () => {
  const env = makeEnv()
  try {
    const p = env.engine.spawnSubAgent(
      { subagent_type: 'general-purpose', prompt: '请输出一句确认', description: '前台可观测性测试' },
      {},
    )
    // 执行期应能观测到前台条目（收口后会清出，故此处轮询捕捉）
    await waitFor(() => foregroundEntries(env.engine).length > 0)
    assert.ok(foregroundEntries(env.engine).length > 0, '前台子任务执行期间必须登记（否则成孤儿）')

    const t = foregroundEntries(env.engine)[0][1]
    assert.equal(t.status, 'running', '前台条目状态应为 running（taskSystem 全部方法依赖它）')
    assert.equal(typeof t.stop, 'function', '必须带 stop ⇒ Task stop 可中止前台任务')

    await p
  } finally {
    env.cleanup()
  }
})

test('前台子代理收口后从登记中清出（不留幽灵条目）', async () => {
  const env = makeEnv()
  try {
    await env.engine.spawnSubAgent({ subagent_type: 'general-purpose', prompt: '请输出一句确认' }, {})
    await waitFor(() => foregroundEntries(env.engine).length === 0)
    assert.equal(foregroundEntries(env.engine).length, 0, '收口后应清出登记')
    assert.equal(env.engine.taskSystem.list(), '当前无后台子 Agent 任务', 'Task list 不应残留前台条目')
  } finally {
    env.cleanup()
  }
})

test('★ 不得双重计数：前台在跑时 runningCount 仍为 1（foregroundRunning 已计过一次）', async () => {
  const env = makeEnv()
  try {
    const p = env.engine.spawnSubAgent({ subagent_type: 'general-purpose', prompt: '请输出一句确认' }, {})
    await waitFor(() => foregroundEntries(env.engine).length > 0)
    const n = env.engine.pendingSubAgentsRunningCount()
    assert.equal(n, 1, `前台在跑时计数应为 1（双重计数会让后台并发预算减半），实际: ${n}`)
    await p
  } finally {
    env.cleanup()
  }
})

test('后台任务仍走原路径：登记、计数、收口后保留终态（供 output/resume）', async () => {
  const env = makeEnv()
  try {
    const r = await env.engine.spawnSubAgent(
      { subagent_type: 'general-purpose', prompt: '请输出一句确认', run_in_background: true },
      {},
    )
    assert.ok(r, '后台派发应返回句柄')
    await waitFor(() => {
      const list = env.engine.taskSystem.list()
      return list.includes('completed') || list.includes('failed')
    })
    const list = env.engine.taskSystem.list()
    assert.ok(/completed|failed/.test(list), `后台任务收口后应保留终态条目，实际: ${list}`)
  } finally {
    env.cleanup()
  }
})
