// 后台任务完成 → 自动唤醒的决策纯函数（照 server/kernel-loop-reap.mjs 范式：判定与接线分离）。
//
// 背景症状（2026-09-21）：agent 派后台子代理/后台程序后结束轮次；任务完成只有 UI 通知
// （task_notification 帧），**没有任何机制唤醒主 agent**，用户必须手打一条消息才能续上
// —— 用户反馈"要人工发送指令唤起，不舒服"。
//
// 为什么独立成纯函数：判定逻辑（该不该唤醒、注入什么文本）可穷举单测；
// 接线（合并窗口 setTimeout、入队、拉起 handleUser）留在 kernel/cli.mjs。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldAutoWake, buildWakeText, WAKE_MERGE_WINDOW_MS, WAKE_SUMMARY_MAX } from '../kernel/auto-wake.mjs'

test('轮次空闲 + 有预算 → 允许唤醒', () => {
  assert.equal(shouldAutoWake({ turnActive: false, queueLen: 0, wakeUsed: 0, max: 5 }), true)
})

test('轮次活跃 → 不唤醒（轮内工具边界会自然吸收，唤醒会变成插话干扰）', () => {
  assert.equal(shouldAutoWake({ turnActive: true, queueLen: 0, wakeUsed: 0, max: 5 }), false)
})

test('已有排队消息 → 不唤醒（避免重复注入：那条消息自己会启动下一轮）', () => {
  assert.equal(shouldAutoWake({ turnActive: false, queueLen: 1, wakeUsed: 0, max: 5 }), false)
})

test('预算已用尽 → 不唤醒', () => {
  assert.equal(shouldAutoWake({ turnActive: false, queueLen: 0, wakeUsed: 5, max: 5 }), false)
})

test('预算未用尽 → 仍可唤醒（边界：wakeUsed=4 / max=5）', () => {
  assert.equal(shouldAutoWake({ turnActive: false, queueLen: 0, wakeUsed: 4, max: 5 }), true)
})

test('max<=0 → 恒不唤醒（回滚开关 PONOS_AUTO_WAKE=0 语义）', () => {
  assert.equal(shouldAutoWake({ turnActive: false, queueLen: 0, wakeUsed: 0, max: 0 }), false)
  assert.equal(shouldAutoWake({ turnActive: false, queueLen: 0, wakeUsed: 0, max: -1 }), false)
})

test('buildWakeText：单条含 taskId/status/摘要，并带"继续推进"指示（模型据此接续）', () => {
  const text = buildWakeText([{ taskId: 't1', status: 'completed', summary: '已生成 RD 表' }])
  assert.ok(text.includes('t1'), '应含 taskId')
  assert.ok(text.includes('completed'), '应含状态')
  assert.ok(text.includes('已生成 RD 表'), '应含摘要')
  assert.ok(text.includes('继续推进'), '应指示模型继续推进')
})

test('buildWakeText：kind=bash 时标注为后台命令（与子代理区分）', () => {
  const text = buildWakeText([{ taskId: 'bg1', status: 'completed', summary: '退出码 0', kind: 'bash' }])
  assert.ok(text.includes('后台命令'), '后台 Bash 应标为后台命令')
})

test('buildWakeText：多条合并为一段，并按 WAKE_SUMMARY_MAX 截断超长摘要', () => {
  const long = 'x'.repeat(WAKE_SUMMARY_MAX + 500)
  const text = buildWakeText([
    { taskId: 't1', status: 'completed', summary: 'A' },
    { taskId: 't2', status: 'failed', summary: long },
  ])
  assert.ok(text.includes('t1') && text.includes('t2'), '两条任务都应出现（合并注入）')
  assert.ok(text.length < WAKE_SUMMARY_MAX + 1000, '超长摘要应被截断，防灌爆主上下文')
})

test('buildWakeText：空入参不抛异常（防御性）', () => {
  assert.equal(typeof buildWakeText([]), 'string')
  assert.equal(typeof buildWakeText(undefined), 'string')
})

test('常量：合并窗口为正数（接线侧 setTimeout 依赖它）', () => {
  assert.ok(WAKE_MERGE_WINDOW_MS > 0)
  assert.equal(WAKE_SUMMARY_MAX, 2000)
})
