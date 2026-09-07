// 子 lane 补 R3-2 失败续跑注入 与 ⑤ 同工具提醒（审计 #10）：行为镜像主循环
// r3-guard.test.mjs（失败工具轮 → 无工具收尾 → 注入"请立即重试"续跑 → 恢复执行）与
// engine-guard-iter.test.mjs（连续同工具计数命中 REPEAT_REMIND_AT 注入提醒不 veto）。
// harness 镜像 engine-lane-meltdown/engine-lane-trunc（makeEnv + laneFile 规则）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// —— env 冻结须先于 engine 求值（镜像 engine-lane-meltdown 的动态 import 布局）——
process.env.PONOS_MOCK_API = '1'
process.env.PONOS_LOOP_REPEAT_REMIND = '3'    // ⑤ 阈值只留 3：连 3 命中即提醒、连 4/5 不再提醒
process.env.PONOS_LOOP_MAX_ITERATIONS = '40'  // 防迭代上限先触发（镜像 engine-lane-meltdown）
process.env.PONOS_LOOP_MAX_ERROR_ITERATIONS = '10' // 防熔断先触发（healcap 场景连败 4 < 10）

const { createEngine } = await import('../kernel/engine.mjs')
const { createSessionStore } = await import('../kernel/session.mjs')
const { makeWire } = await import('../kernel/protocol.mjs')

function makeEnv() {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const dir = mkdtempSync(join(tmpdir(), 'ponos-lane-heal-'))
  const configDir = join(dir, 'home')
  const store = createSessionStore({ configDir, cwd: dir, sessionId: 'main-session' })
  const engine = createEngine({
    opts: { model: 'mock-model', configDir, addDirs: [dir], skipPermissions: true },
    wire,
    session: store,
  })
  engine.setSystemPrompt('你是 Ponos-turbo 测试内核。')
  // 子 lane transcript 路径（同 engine-lane-trunc.test.mjs laneFile 规则）
  const laneFile = (taskId) => join(configDir, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'), `${taskId}.jsonl`)
  return { events, engine, store, dir, laneFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('子 lane R3-2：失败轮后注入"请立即重试"续跑，lane 继续执行到成功轮（非纯文本收尾）', async () => {
  const env = makeEnv()
  try {
    const r = await env.engine.runTurn({ content: '[mock:agent-lane-heal]' })
    const sys = env.events.filter((e) => e.type === 'system')
    const started = sys.find((e) => e.subtype === 'task_started')
    assert.ok(started, '应有 task_started')
    const notif = sys.find((e) => e.subtype === 'task_notification' && e.task_id === started.task_id)
    assert.ok(notif, '应有 task_notification')
    // ① lane 继续执行到成功轮：任务通知摘要含恢复成功的工具结果（mock 收到续跑注入后补发
    // 正确调用，镜像主循环 r3-guard 的 guard-recovered 断言）
    const notifText = JSON.stringify(notif)
    assert.ok(notifText.includes('guard-recovered'), `通知摘要应含恢复结果，实际：${notifText.slice(0, 400)}`)
    // ② lane 转录含系统续跑注入（"请立即重试"类文案，镜像 r3-guard 的"失败/被取消"断言）
    const lane = readFileSync(env.laneFile(started.task_id), 'utf-8')
    assert.ok(lane.includes('请立即重试或补发正确的工具调用'), `lane 转录应含续跑注入，实际：${lane.slice(-400)}`)
    assert.ok(lane.includes('guard-recovered'), `lane 转录应含恢复成功的工具结果，实际：${lane.slice(-400)}`)
    assert.ok(lane.includes('"is_error":true'), 'lane 转录应先有失败工具记录')
    // 主线程正常收尾
    assert.ok(String(r.text).length > 0, '主线程正常收尾')
  } finally { env.cleanup() }
})

test('子 lane R3-2 guardInjections 上限：连续"失败→纯文本收尾"只注入至多 3 次后收尾', async () => {
  const env = makeEnv()
  try {
    process.env.PONOS_MOCK_LANE_HEALCAP_N = '0'
    const r = await env.engine.runTurn({ content: '[mock:agent-lane-healcap]' })
    const sys = env.events.filter((e) => e.type === 'system')
    const started = sys.find((e) => e.subtype === 'task_started')
    assert.ok(started, '应有 task_started')
    const notif = sys.find((e) => e.subtype === 'task_notification' && e.task_id === started.task_id)
    assert.ok(notif, '应有 task_notification')
    const lane = readFileSync(env.laneFile(started.task_id), 'utf-8')
    // ① 注入次数 == 上限（PONOS_GUARD_MAX 默认 3）：第 4 次"纯文本收尾"不再注入
    const injectCount = (lane.match(/请立即重试或补发正确的工具调用/g) || []).length
    assert.ok(injectCount === 3, `续跑注入应至多 3 次（上限），实际 ${injectCount} 次：${lane.slice(-500)}`)
    // ② 失败轮继续发生（4 次连败），但未触发熔断（MAX_ERROR_ITERATIONS=10 未达）——
    // 由注入上限兜底收尾，不与守卫④抢触发
    const isErrCount = (lane.match(/"is_error":true/g) || []).length
    assert.ok(isErrCount >= 4, `lane 转录应含至少 4 条失败工具记录，实际 ${isErrCount} 条`)
    assert.ok(!lane.includes('连续工具调用全部失败'), '不应走到守卫④熔断（上限兜底先收尾）')
    assert.ok(String(r.text).length > 0, '主线程正常收尾')
  } finally {
    delete process.env.PONOS_MOCK_LANE_HEALCAP_N
    env.cleanup()
  }
})

test('子 lane 守卫⑤：连续 3 次同一工具注入提醒（不 veto），换工具计数复位不再提醒', async () => {
  const env = makeEnv()
  try {
    process.env.PONOS_MOCK_LANE_ITER_N = '0'
    const r = await env.engine.runTurn({ content: '[mock:agent-lane-iter]' })
    const sys = env.events.filter((e) => e.type === 'system')
    const started = sys.find((e) => e.subtype === 'task_started')
    assert.ok(started, '应有 task_started')
    const notif = sys.find((e) => e.subtype === 'task_notification' && e.task_id === started.task_id)
    assert.ok(notif, '应有 task_notification')
    // ① lane 未被提醒 veto、自然完成到摘要文本（换工具后纯文本收尾）
    const notifText = JSON.stringify(notif)
    assert.ok(notifText.includes('[mock:lane-iter-done]'), `通知摘要应含完成文本，实际：${notifText.slice(0, 400)}`)
    // ② lane 转录含同工具提醒注入（镜像 engine-guard-iter 的"连续 3 次调用同一工具"断言）
    const lane = readFileSync(env.laneFile(started.task_id), 'utf-8')
    const remindCount = (lane.match(/你已连续 3 次调用同一工具/g) || []).length
    assert.ok(remindCount === 1, `同工具提醒应恰注入 1 次，实际 ${remindCount} 次：${lane.slice(-500)}`)
    // ③ 同一工具链 3 轮后换工具（计数复位）：工具 A×3、工具 B×2，B 出现在提醒之后
    const aCount = (lane.match(/echo lane-iter-A/g) || []).length
    const bCount = (lane.match(/echo lane-iter-B/g) || []).length
    assert.ok(aCount === 3, `同工具 A 应连续 3 轮，实际 ${aCount} 轮`)
    assert.ok(bCount === 2, `换工具 B 应执行 2 轮，实际 ${bCount} 轮`)
    assert.ok(lane.indexOf('echo lane-iter-B') > lane.indexOf('你已连续 3 次调用同一工具'),
      '提醒注入后 lane 应继续执行（不 veto），B 工具轮应在提醒之后')
    assert.ok(String(r.text).length > 0, '主线程正常收尾')
  } finally {
    delete process.env.PONOS_MOCK_LANE_ITER_N
    env.cleanup()
  }
})
