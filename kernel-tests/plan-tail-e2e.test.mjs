// 计划尾守卫（R3-2）端到端：主循环 + 子 lane（2026-09-16 两侧对齐）
// ---------------------------------------------------------------------------
// 为什么补这个文件：`[mock:guard-tail]` 这个 mock 标记**早已存在却无任何测试使用**
// （`grep guard-tail kernel-tests/` 修复前命中 0）——即"计划尾注入"这条守卫只活在
// mock 里，主循环 e2e 从未验证，子 lane 更是**根本没有该守卫**（子任务以一句"接下来
// 我要…"收尾会被当作完成结果回传主线程）。
//
// 本文件钉死两侧同一路径：
//   ① 主循环：计划尾文本 → 注入计划尾续跑指令 → 模型照做补发工具调用 → 继续执行；
//   ② 子 lane：同样注入、同样恢复（修复前此处必挂：lane 直接 break 收尾）；
//   ③ 注入各恰 1 次——若守卫"过于活跃"（反复提醒），计数会大于 1。
//
// 恢复机制复用 api.mjs 既有 R3-2 恢复分支：历史含 `【系统】你在上一轮承诺了后续动作`
// 即产出成功 Bash（echo guard-recovered）。故本文件同时是 guards.planTailText() 文案
// 与 api.mjs mock 锚点串的**一致性守卫**：任一侧改了首句，这些断言都会红。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// —— env 冻结须先于 engine 求值（镜像 engine-lane-heal 的动态 import 布局）——
process.env.PONOS_MOCK_API = '1'

const { createEngine } = await import('../kernel/engine.mjs')
const { createSessionStore, sanitizeSegment } = await import('../kernel/session.mjs')
const { makeWire } = await import('../kernel/protocol.mjs')

const PLAN_TAIL_INJECT = '你在上一轮承诺了后续动作'

function makeEnv(sessionId) {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const dir = mkdtempSync(join(tmpdir(), 'ponos-plan-tail-'))
  const configDir = join(dir, 'home')
  const store = createSessionStore({ configDir, cwd: dir, sessionId })
  const engine = createEngine({
    opts: { model: 'mock-model', configDir, addDirs: [dir], skipPermissions: true },
    wire,
    session: store,
  })
  engine.setSystemPrompt('你是 Ponos-turbo 测试内核。')
  const projectDir = join(configDir, 'projects', sanitizeSegment(dir))
  return {
    engine,
    events,
    dir,
    mainFile: join(projectDir, `${sessionId}.jsonl`),
    laneFile: (taskId) => join(projectDir, `${taskId}.jsonl`),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const count = (s, sub) => (String(s).match(new RegExp(sub, 'g')) || []).length

test('主循环计划尾：注入续跑（恰 1 次）→ 模型照做补发工具调用 → 不再反复提醒', async () => {
  const env = makeEnv('plan-tail-main')
  try {
    // [mock:guard-tail] 产"我先看一下结构，接下来开始处理，然后再验证"（纯文本、无工具）
    const r = await env.engine.runTurn({ content: '[mock:guard-tail]' })
    const transcript = readFileSync(env.mainFile, 'utf-8')
    // ① 计划尾被识别并注入续跑指令（落 transcript，模型可见）
    assert.equal(count(transcript, PLAN_TAIL_INJECT), 1,
      `计划尾续跑注入应恰 1 次（多于 1 = 守卫反复提醒），transcript 尾部：${transcript.slice(-500)}`)
    // ② 模型"照做"补发工具调用并成功执行（恢复分支产出的 Bash 结果回显进最终文本）
    assert.ok(String(r.text).includes('guard-recovered'),
      `注入后应继续执行到工具成功轮，实际收尾：${String(r.text).slice(0, 300)}`)
    // ③ 收尾不是那句计划文本（证明确实推进了，而非把计划当结论）
    assert.ok(!String(r.text).trim().endsWith('然后再验证'),
      '收尾不应停留在计划文本上')
  } finally { env.cleanup() }
})

test('子 lane 计划尾：子任务"只承诺不执行"同样被注入续跑（修复前此处直接 break 收尾）', async () => {
  const env = makeEnv('plan-tail-lane-main')
  try {
    const r = await env.engine.runTurn({ content: '[mock:agent-lane-plan-tail]' })
    const sys = env.events.filter((e) => e.type === 'system')
    const started = sys.find((e) => e.subtype === 'task_started')
    assert.ok(started, '应有 task_started')
    const notif = sys.find((e) => e.subtype === 'task_notification' && e.task_id === started.task_id)
    assert.ok(notif, '应有 task_notification')

    const lane = readFileSync(env.laneFile(started.task_id), 'utf-8')
    // ① 子 lane 也注入了计划尾续跑指令（修复前无此分支 ⇒ 此断言为真守门）
    assert.equal(count(lane, PLAN_TAIL_INJECT), 1,
      `子 lane 计划尾注入应恰 1 次，lane 尾部：${lane.slice(-500)}`)
    // ② lane 继续执行到成功工具轮（而非以"接下来我要…"收尾）
    assert.ok(lane.includes('guard-recovered'),
      `lane 转录应含恢复成功的工具结果，实际尾部：${lane.slice(-500)}`)
    // ③ 通知摘要体现的是执行结果，不是计划文本
    assert.ok(JSON.stringify(notif).includes('guard-recovered'),
      `通知摘要应含执行结果，实际：${JSON.stringify(notif).slice(0, 400)}`)
    // ④ 主线程正常收尾
    assert.ok(String(r.text).length > 0, '主线程正常收尾')
  } finally { env.cleanup() }
})

test('对照：子 lane 的普通文本收尾（既无计划尾也无工具错误）不被注入', async () => {
  // [mock:lane-iter] 场景最终以完成文本收尾——此处只取"子任务正常结束不被计划尾钩住"
  // 这一面：若 PLAN_TAIL_RE 过宽（例如把"已准备就绪/稍等"算作计划），这条会因多出注入而红。
  const env = makeEnv('plan-tail-lane-control')
  try {
    const r = await env.engine.runTurn({ content: '[mock:agent-lane-heal]' })
    const sys = env.events.filter((e) => e.type === 'system')
    const started = sys.find((e) => e.subtype === 'task_started')
    assert.ok(started, '应有 task_started')
    const lane = readFileSync(env.laneFile(started.task_id), 'utf-8')
    assert.equal(count(lane, PLAN_TAIL_INJECT), 0,
      `R3-2 恢复场景不应出现计划尾注入（误伤），lane 尾部：${lane.slice(-400)}`)
    assert.ok(String(r.text).length > 0, '主线程正常收尾')
  } finally { env.cleanup() }
})
