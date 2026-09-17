// 前台子代理并发闸的**上限**语义（第 10 项）。
// 独立文件 = 独立进程（node --test 每文件一进程），故这里能把上限固定为 1。
//
// 这一组是上一组（subagent-frontend-concurrency.test.mjs）的反向用例：证明"允许并发"
// 不等于"无脑并发"——用户把上限压到 1 时必须老实串行，且槽位不泄漏。
process.env.PONOS_MOCK_API = '1'
process.env.PONOS_LANE_MAX_CONCURRENT = '1' // 上限 1 = 同时只允许一个子代理在跑
const { createEngine } = await import('../kernel/engine.mjs')
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore } from '../kernel/session.mjs'
const { LANE_MAX_CONCURRENT } = await import('../kernel/engine-config.mjs')

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'subagent-cap-'))
  const events = []
  const wire = {
    assistant: () => {}, result: () => {}, controlRequest: () => {}, system: () => {},
    summary: () => {}, health: () => {}, warning: () => {},
    taskStarted: (e) => events.push({ kind: 'start', taskId: e?.taskId }),
    taskResumed: () => {},
    taskNotification: (e) => events.push({ kind: 'notify', taskId: e?.taskId, status: e?.status }),
    warning: (e) => events.push({ kind: 'warn', level: e?.level, message: e?.message }),
  }
  const session = createSessionStore({ configDir: dir, cwd: dir, sessionId: 'cap-session' })
  session.appendUser('主任务：两个子任务')
  const engine = createEngine({
    opts: { model: 'm', addDirs: [dir], skipPermissions: true, systemPrompt: '', configDir: dir },
    wire, session,
  })
  return { engine, session, dir, events, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('上限 1：同轮两个 Agent 串行——第二个必须等第一个释放槽位', async () => {
  assert.equal(LANE_MAX_CONCURRENT, 1, '本用例前提：上限被固定为 1')
  const env = makeEnv()
  try {
    await env.engine.runTurn({ content: '[mock:agent-pair]' })

    const starts = env.events.filter((e) => e.kind === 'start')
    const notifies = env.events.filter((e) => e.kind === 'notify')
    assert.equal(starts.length, 2, `应派发 2 个子代理（实际 ${starts.length}）`)
    assert.equal(notifies.length, 2, `两个子代理都应跑完（实际 ${notifies.length}）`)
    assert.ok(notifies.every((n) => n.status === 'completed'), '上限 1 不应导致失败或丢弃')

    // 判据说明：不能用 taskStarted 的先后判串行——spawn 时即发该事件、取槽在其后，
    // 故上限 1 时两个 taskStarted 仍会相继同步发出。真正可观测的是"谁等过槽位"：
    // 上限 1 时第二个必然等待 ⇒ 恰好出现 1 条等待告警。
    const waits = env.events.filter((e) => e.kind === 'warn' && e.level === 'subagent_concurrency')
    assert.equal(waits.length, 1,
      `上限 1 时应有且仅有 1 个子任务等待槽位（实际 ${waits.length} 条等待告警；事件序 ${env.events.map((e) => e.kind).join('→')}）`)
    assert.match(waits[0].message, /上限 1/, '告警须写明上限值，便于用户判断是否需要调大')
  } finally { env.cleanup() }
})

test('槽位不泄漏：串行跑完两个子代理后，下一轮派发仍能正常执行', async () => {
  const env = makeEnv()
  try {
    await env.engine.runTurn({ content: '[mock:agent-pair]' })
    const before = env.events.filter((e) => e.kind === 'start').length
    // 若释放逻辑有漏（未走 finally），槽位会被永久占用 → 本轮会卡死到超时或返回错误。
    await env.engine.runTurn({ content: '[mock:agent]' })
    const after = env.events.filter((e) => e.kind === 'start')
    assert.equal(after.length, before + 1, '后续轮次的子代理应能取到槽位（不泄漏）')
    const last = env.events.filter((e) => e.kind === 'notify').at(-1)
    assert.equal(last.status, 'completed', '后续轮次的子代理应正常完成')
  } finally { env.cleanup() }
})
