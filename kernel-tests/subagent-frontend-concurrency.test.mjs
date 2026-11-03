// 前台多子代理并发（第 10 项核实 + 修复）。
//
// 【核实结论（修复前实测）】前台**不可能**并发：`runToolBatch` 只把 `concurrencySafe === true`
// 的工具放进并发批，而 `Agent` 工具没声明该标志 ⇒ 同一轮里的多个 Agent 调用被逐个 `await`
// （串行）。后台路径不受影响——它另有 `LANE_MAX_CONCURRENT` 槽位 + FIFO 队列。
//
// 【本文件的判据】不看墙钟耗时，只看 **wire 事件顺序**（确定性）：
//   · `wire.taskStarted`      —— spawn 时同步发出（前/后台都有）
//   · `wire.taskNotification` —— runLaneExecution 收尾时发出（前/后台都有）
// 若两个子任务真的重叠执行，则「第二个 taskStarted」必然早于「第一个 taskNotification」；
// 串行时则相反（第二个 spawn 要等第一个跑完）。同一轮内 Promise.all 会先同步启动两个
// spawn，所以并发时两个 taskStarted 落在同一 tick，不存在计时抖动导致的假阴性/假阳性。
process.env.PONOS_MOCK_API = '1'
process.env.PONOS_LANE_MAX_CONCURRENT = '4' // 显式固定，避免受系统默认值影响
const { createEngine } = await import('../kernel/engine.mjs')
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore } from '../kernel/session.mjs'

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'subagent-conc-'))
  const events = []
  const wire = {
    assistant: () => {}, result: () => {}, controlRequest: () => {}, system: () => {},
    summary: () => {}, health: () => {}, warning: () => {},
    taskStarted: (e) => events.push({ kind: 'start', taskId: e?.taskId }),
    taskResumed: () => {},
    taskNotification: (e) => events.push({ kind: 'notify', taskId: e?.taskId, status: e?.status }),
    warning: (e) => events.push({ kind: 'warn', level: e?.level, message: e?.message }),
  }
  const session = createSessionStore({ configDir: dir, cwd: dir, sessionId: 'conc-session' })
  session.appendUser('主任务：请并行分派两个子任务')
  const engine = createEngine({
    opts: { model: 'm', addDirs: [dir], skipPermissions: true, systemPrompt: '', configDir: dir },
    wire, session,
  })
  return { engine, session, dir, events, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('前台同轮多个 Agent：必须并发执行（第二个 taskStarted 早于第一个 taskNotification）', async () => {
  const env = makeEnv()
  try {
    await env.engine.runTurn({ content: '[mock:agent-pair]' })

    const starts = env.events.filter((e) => e.kind === 'start')
    const notifies = env.events.filter((e) => e.kind === 'notify')
    assert.equal(starts.length, 2, `同轮应派发 2 个子代理（实际 ${starts.length}）`)
    assert.equal(notifies.length, 2, `两个子代理都应跑完并回报（实际 ${notifies.length}）`)
    assert.ok(notifies.every((n) => n.status === 'completed'),
      `两个子代理都应成功完成（实际 ${notifies.map((n) => n.status).join(',')}）`)

    // 关键判据：事件交织顺序。索引越小越早。
    const firstStart = env.events.findIndex((e) => e.kind === 'start')
    const secondStart = env.events.findIndex((e, i) => e.kind === 'start' && i > firstStart)
    const firstNotify = env.events.findIndex((e) => e.kind === 'notify')
    assert.ok(secondStart !== -1 && firstNotify !== -1, '事件序列应同时含两次 spawn 与一次完成回报')
    assert.ok(secondStart < firstNotify,
      `前台子代理仍是串行：第 2 个 spawn 发生在第 1 个跑完之后（事件序 ${env.events.map((e) => e.kind).join('→')}）。`
      + '期望两者重叠：start→start→notify→notify')

    // 上限充裕时不该有人等槽位（等待会发 subagent_concurrency 告警）
    const waits = env.events.filter((e) => e.kind === 'warn' && e.level === 'subagent_concurrency')
    assert.equal(waits.length, 0, `上限 4 下两个子代理不应排队等待（实际 ${waits.length} 条等待告警）`)
  } finally { env.cleanup() }
})
