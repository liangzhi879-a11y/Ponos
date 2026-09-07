// agent loop 守卫——上游空流/空转识别（P1-11）集成测试
// ---------------------------------------------------------------------------
// 背景（2026-09-07 驾驶舱任务"无输出"复盘）：active provider（本地 vLLM Qwen，
// 218.17.137.219:8900）在引擎加载/崩溃窗口内对每个请求返回 HTTP 200 但流式响应体
// 一个事件都不下发（0 事件即断，或连接挂着 0 数据直到被空闲看门狗中止）。旧行为：
//   ① 0 事件即断（terminated）→ classify unknown → 无重试直接抛内部错误（用户看到
//      不明报错）；② 0 数据空挂 → 空闲看门狗 120s 后报"模型输出中断…可继续重试"——
//      把"上游死了"误当"模型挂起"，用户在死服务器上反复重试越拖越糟。
// 修复：
//   ① 0 事件即断/EOF 归一为 DeadStreamError（kind dead-stream）→ engine 只做 1 次
//      快速重试即收尾，提示"检查 provider"（不空等 STREAM_IDLE_MS、不狂重试）；
//   ② 空闲看门狗按"本流是否产出过内容"分流：0 产出 → 上游空转/未就绪提示；已产出
//      后停顿 → 推理中途停顿（保留"可继续重试"）。
// 测试把 STREAM_IDLE_MS 压到 400ms 加速。注意：STREAM_IDLE_MS 在 engine 模块求值期
// 冻结 → env 必须在 import 前设定。
process.env.PONOS_MOCK_API = '1'
process.env.PONOS_STREAM_IDLE_MS = '400'
const { createEngine } = await import('../kernel/engine.mjs')
import { classifyApiError, deadStreamError } from '../kernel/api.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore } from '../kernel/session.mjs'
import { makeWire } from '../kernel/protocol.mjs'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'guard-deadstream-'))
  const wire = {
    assistant: () => {}, result: () => {}, controlRequest: () => {}, system: () => {},
    summary: () => {}, health: () => {}, warning: () => {},
  }
  const session = createSessionStore({ configDir: dir, cwd: 'proj', sessionId: '00000000-0000-0000-0000-00000000000d' })
  return { dir, session, wire }
}

test('classifyApiError：DeadStreamError → kind dead-stream（空流不作瞬态重试）', () => {
  const cls = classifyApiError(deadStreamError(new Error('x')))
  assert.equal(cls.kind, 'dead-stream')
  assert.equal(cls.retryable, false)
})

test('[mock:deadstream] 0 事件即断 → 快速失败（不空等 400ms 看门狗）并提示检查 provider', async () => {
  const { dir, session, wire } = setup()
  try {
    const engine = createEngine({ opts: { model: 'm', addDirs: [dir], skipPermissions: true, systemPrompt: '' }, wire, session })
    const t0 = Date.now()
    const result = await engine.runTurn({ content: '[mock:deadstream]' })
    const elapsed = Date.now() - t0
    assert.ok(result.text.includes('上游服务空流'), `应收上游空流提示，实际: ${result.text.slice(0, 200)}`)
    assert.ok(result.text.includes('provider'), '应引导检查 provider')
    assert.ok(elapsed < 3500, `应快速失败（mock 无重试，瞬时返回），实际耗时 ${elapsed}ms`)
    // 会话保留可续聊（同其它守卫：优雅收尾不丢任务）
    const again = await engine.runTurn({ content: '继续' })
    assert.ok(typeof again.text === 'string' && again.text.length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('[mock:stall0] 全程 0 数据空挂 → 空闲看门狗收尾，提示上游空转而非"推理停顿"', async () => {
  const { dir, session, wire } = setup()
  try {
    const engine = createEngine({ opts: { model: 'm', addDirs: [dir], skipPermissions: true, systemPrompt: '' }, wire, session })
    const t0 = Date.now()
    const result = await engine.runTurn({ content: '[mock:stall0]' })
    const elapsed = Date.now() - t0
    assert.ok(result.text.includes('未收到任何数据'), `应收上游空转提示，实际: ${result.text.slice(0, 200)}`)
    assert.ok(result.text.includes('自动收尾'), '应提示已按挂起自动收尾')
    assert.ok(elapsed < 1200, `应 ~400ms 被看门狗中止，实际耗时 ${elapsed}ms`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('[mock:agent-lane-stall-think] 子 lane 只产 thinking 后停顿 → 判"推理中途停顿"而非空流（M5 判别）', async () => {
  // M5 交互核对：子 lane 看门狗判别须镜像主循环 attemptData（收到任意 chunk 含 thinking 即
  // 上游已产出）。#8 后 lane textBuf 只收 text，仅产 thinking 的 lane textBuf.length===0——
  // 若判别仍用 textBuf.length 会把"thinking 后停"误报成"上游服务空流（未收到任何数据）"。
  // 判定结果落点：guardStop → runLaneExecution status='stopped' → task_notification.summary
  // （镜像 engine-lane-meltdown/heal 断言方式；主线程 r.text 只是 tool 回执，不含 guard 文案）。
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const dir = mkdtempSync(join(tmpdir(), 'guard-deadstream-lane-'))
  const configDir = join(dir, 'home') // 子 lane store 落点（镜像 engine-lane-heal makeEnv）
  const session = createSessionStore({ configDir, cwd: 'proj', sessionId: '00000000-0000-0000-0000-00000000000e' })
  try {
    const engine = createEngine({ opts: { model: 'm', configDir, addDirs: [dir], skipPermissions: true, systemPrompt: '' }, wire, session })
    const t0 = Date.now()
    const result = await engine.runTurn({ content: '[mock:agent-lane-stall-think]' })
    const elapsed = Date.now() - t0
    const sys = events.filter((e) => e.type === 'system')
    const started = sys.find((e) => e.subtype === 'task_started')
    assert.ok(started, '应有 task_started（子 lane 已起）')
    const notif = sys.find((e) => e.subtype === 'task_notification' && e.task_id === started.task_id)
    assert.ok(notif, '应有 task_notification（子 lane 收尾）')
    const notifText = JSON.stringify(notif)
    assert.ok(notifText.includes('输出中断') && notifText.includes('推理中途停顿'),
      `lane 仅产 thinking 后停应收"推理中途停顿"语义，实际：${notifText.slice(0, 400)}`)
    assert.ok(!notifText.includes('未收到任何数据'), `不应误报"未收到任何数据"，实际：${notifText.slice(0, 400)}`)
    assert.ok(!notifText.includes('上游服务空流'), `不应误报"上游服务空流"，实际：${notifText.slice(0, 400)}`)
    // 由空闲看门狗（400ms）中止：既非死流快速失败（<100ms），也非 mock 兜底 1.5s 正常返回
    assert.ok(elapsed >= 300 && elapsed < 1500, `应 ~400ms 由看门狗中止，实际耗时 ${elapsed}ms`)
    assert.ok(typeof result.text === 'string' && result.text.length > 0, '主线程正常收尾')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
