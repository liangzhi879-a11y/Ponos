// src/lib/conversationResync.test.ts —— 断线重连重同步的合并判定（2026-09-13「任务断掉」事故）
// 守的不变量（对应 conversationResync.ts 头部注释）：
//   · 磁盘比本地多出的尾部必须补回（netGain>0 是这次事故的正向修复）
//   · 磁盘已有的本地副本不得重复出现（id 基准两边永不相同，只能靠时间戳+宽限）
//   · 磁盘为空（拉取失败）时**原样**返回本地 —— 一次失败不许清屏
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeResyncedMessages, RESYNC_GRACE_MS } from './conversationResync.ts'
import type { Message } from '../types/index.ts'

// 固定基准时刻：不依赖真实时钟，宽限边界可精确断言
const T0 = 1_700_000_000_000
const T = (ms: number) => T0 + ms

const msg = (id: string, role: Message['role'], timestamp: number): Message =>
  ({ id, role, timestamp, content: [] })

const ids = (ms: Message[]) => ms.map((m) => m.id).join(',')

test('磁盘比本地多出尾部 → 补回（这正是断线丢帧的修复），磁盘顺序在前', () => {
  // 本地视图停在这一轮的倒数第二条：最终答复 a2 + 收尾 a3 是断线期间丢的（实证形态）
  const local = [msg('u1-local', 'user', T(0)), msg('a1-local', 'assistant', T(10))]
  const disk = [
    msg('e-u1', 'user', T(0)),
    msg('e-a1', 'assistant', T(10)),
    msg('e-a2', 'assistant', T(20)),
    msg('e-a3', 'assistant', T(25)),
  ]
  const r = mergeResyncedMessages(local, disk)
  assert.equal(ids(r.messages), 'e-u1,e-a1,e-a2,e-a3', `应以磁盘为准且保序（实际 ${ids(r.messages)}）`)
  assert.equal(r.netGain, 2, `屏幕应净增 2 行（实际 ${r.netGain}）`)
  assert.equal(r.keptLocal, 0, '没有磁盘之外的新消息时不该保留本地副本')
})

test('本地末尾有磁盘还没有的新消息（断线期间排队的用户消息）→ 保留并排在末尾', () => {
  // 本地镜像了磁盘前缀（id 不同但内容同源），末尾多一条断线期间发出的用户消息
  const local = [
    msg('u1-local', 'user', T(0)),
    msg('a1-local', 'assistant', T(10)),
    msg('u2-local', 'user', T(5000)), // 断线期间发出：重连退避 ≥2s，必然晚于宽限
  ]
  const disk = [msg('e-u1', 'user', T(0)), msg('e-a1', 'assistant', T(10))]
  const r = mergeResyncedMessages(local, disk)
  assert.equal(ids(r.messages), 'e-u1,e-a1,u2-local', `本地新消息应在末尾（实际 ${ids(r.messages)}）`)
  assert.equal(r.netGain, 0, `本地已覆盖磁盘全部内容时净增为 0（实际 ${r.netGain}）`)
  assert.equal(r.keptLocal, 1, `应保留 1 条本地新消息（实际 ${r.keptLocal}）`)
})

test('边界：本地最后一条与磁盘末条是同一内容的两份副本（id 不同、时间差在宽限内）→ 不重复', () => {
  // 实时渲染的消息落盘与投递实测只差 ~4ms，但 id 一个是 generateId() 一个是内核 entry id
  const local = [msg('e-u1', 'user', T(0)), msg('a1-stream', 'assistant', T(13))]
  const disk = [msg('e-u1', 'user', T(0)), msg('e-a1', 'assistant', T(10))]
  const r = mergeResyncedMessages(local, disk)
  assert.equal(ids(r.messages), 'e-u1,e-a1', `同一内容的本地副本应被排除（实际 ${ids(r.messages)}）`)
  assert.equal(r.keptLocal, 0, `3ms 之差必须算作同一份（实际 ${r.keptLocal}）`)
  assert.equal(r.netGain, 0, `净增应为 0（实际 ${r.netGain}）`)
})

test('宽限边界是严格大于：正好落在 cutoff 上的本地消息仍算副本', () => {
  const disk = [msg('e-a1', 'assistant', T(10)), msg('e-a2', 'assistant', T(20))]
  const atCutoff = [msg('x', 'user', T(20) + RESYNC_GRACE_MS)]
  assert.equal(ids(mergeResyncedMessages(atCutoff, disk).messages), 'e-a1,e-a2',
    `恰好等于 cutoff 不保留（实际 ${ids(mergeResyncedMessages(atCutoff, disk).messages)}）`)
  const past = [msg('y', 'user', T(20) + RESYNC_GRACE_MS + 1)]
  assert.equal(ids(mergeResyncedMessages(past, disk).messages), 'e-a1,e-a2,y', '超过 cutoff 才保留')
})

test('磁盘为空（拉取失败 / 无 transcript）→ 原样返回本地，绝不清屏', () => {
  const local = [msg('u1', 'user', T(0)), msg('a1', 'assistant', T(10))]
  const r = mergeResyncedMessages(local, [])
  assert.strictEqual(r.messages, local, '必须是同一个数组（不复制、不改写）')
  assert.equal(r.netGain, 0, `拉取失败不得报"补回"（实际 ${r.netGain}）`)
  assert.equal(r.keptLocal, 0, '放弃分支不产生 keptLocal 统计')
})

test('本地为空（重同步恰好先于首帧渲染）→ 结果即磁盘全量', () => {
  const disk = [msg('e-u1', 'user', T(0)), msg('e-a1', 'assistant', T(10))]
  const r = mergeResyncedMessages([], disk)
  assert.equal(ids(r.messages), 'e-u1,e-a1')
  assert.equal(r.netGain, 2, `空本地应整份补回（实际 ${r.netGain}）`)
})

test('多条本地副本被去重 → netGain 可为负（日志里别读成"丢消息"）', () => {
  // 病态输入（同一轮被本地渲染出多份副本）：净增为负是去重生效，不是丢内容
  const local = [msg('a1-stream', 'assistant', T(10)), msg('a1-stream2', 'assistant', T(11))]
  const disk = [msg('e-a1', 'assistant', T(10))]
  const r = mergeResyncedMessages(local, disk)
  assert.equal(ids(r.messages), 'e-a1', `副本全部去重后只剩磁盘版（实际 ${ids(r.messages)}）`)
  assert.equal(r.netGain, -1, `净增应为 -1（实际 ${r.netGain}）`)
})

test('宽限可注入：graceMs=0 时凡严格更新的本地消息都保留', () => {
  const local = [msg('a1-stream', 'assistant', T(10)), msg('a2-stream', 'assistant', T(11))]
  const disk = [msg('e-a1', 'assistant', T(10))]
  const r = mergeResyncedMessages(local, disk, 0)
  assert.equal(ids(r.messages), 'e-a1,a2-stream', `同刻副本排除、更新的保留（实际 ${ids(r.messages)}）`)
})

test('时间戳缺失/非法（NaN、undefined）不炸，且不污染"磁盘末条时刻"判定', () => {
  const local = [msg('bad', 'assistant', Number.NaN)]
  const disk = [msg('e-a1', 'assistant', T(10)), msg('e-bad', 'assistant', Number.NaN)]
  const r = mergeResyncedMessages(local, disk)
  // 磁盘末条时刻取有效最大值 T(10)（NaN 不得让 cutoff 变 NaN 从而把本地全丢）
  assert.equal(ids(r.messages), 'e-a1,e-bad', `NaN 时间戳的本地消息按 0 处理不保留（实际 ${ids(r.messages)}）`)
  const r2 = mergeResyncedMessages([msg('n', 'user', T(10) + RESYNC_GRACE_MS + 1)], disk)
  assert.equal(ids(r2.messages), 'e-a1,e-bad,n', 'cutoff 仍按有效最大时刻计算')
})
