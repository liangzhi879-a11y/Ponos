// 终端合帧器（Task 1）：100ms 合帧、64KB（stdout+stderr 合计）尾部截断、seq 递增、
// 空截断帧只发一次。只测纯逻辑：不碰 wire、不碰 fs，也不依赖 gitignored 目录（干净检出可跑）。
// 分工：前 4 条钉基本形状与跨帧预算；后 4 条钉「口径 / 头尾 / 时间维度 / 一次性标记」——
// 这四项是现有断言的分辨力盲区（审查 review-01.md B3 变异矩阵：M1/M2/M4/M6 均漏）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createChunkMerger, TAIL_LIMIT } from '../kernel/terminal-stream.mjs'

test('100ms 内多个 chunk 合成一帧', () => {
  const frames = []
  const m = createChunkMerger({ intervalMs: 100, flush: (f) => frames.push(f), now: () => 0 })
  m.push('stdout', 'a')
  m.push('stdout', 'b')
  m.push('stderr', 'c')
  m.flushNow()
  assert.equal(frames.length, 1)
  assert.equal(frames[0].stdout, 'ab')
  assert.equal(frames[0].stderr, 'c')
})

test('累计超过 TAIL_LIMIT 后标记 truncated 且只保留尾部', () => {
  const frames = []
  const m = createChunkMerger({ intervalMs: 100, flush: (f) => frames.push(f), now: () => 0 })
  m.push('stdout', 'x'.repeat(TAIL_LIMIT))
  m.push('stdout', 'y'.repeat(100))
  m.flushNow()
  const total = frames.reduce((n, f) => n + f.stdout.length, 0)
  assert.ok(total <= TAIL_LIMIT)
  assert.equal(frames.at(-1).truncated, true)
})

test('seq 从 1 递增', () => {
  const frames = []
  const m = createChunkMerger({ intervalMs: 100, flush: (f) => frames.push(f), now: () => 0 })
  m.push('stdout', 'a'); m.flushNow()
  m.push('stdout', 'b'); m.flushNow()
  assert.deepEqual(frames.map((f) => f.seq), [1, 2])
})

// 截断语义的细节：预算耗尽后仍要往 UI 发一个「截断标记帧」，否则前端永远看不到
// truncated（首帧已带着 truncated:false 发出去了，无法回溯改写）。
test('预算耗尽后再有输出：只发一个空的截断标记帧，累计仍不超过 TAIL_LIMIT', () => {
  const frames = []
  const m = createChunkMerger({ intervalMs: 100, flush: (f) => frames.push(f), now: () => 0 })
  m.push('stdout', 'x'.repeat(TAIL_LIMIT))
  m.push('stdout', 'dropped-1')
  m.push('stdout', 'dropped-2')
  m.flushNow()
  assert.equal(frames.length, 2)
  const total = frames.reduce((n, f) => n + f.stdout.length, 0)
  assert.ok(total <= TAIL_LIMIT)
  assert.equal(frames.at(-1).stdout, '')
  assert.equal(frames.at(-1).truncated, true)
})

// —— 以下 4 条补分辨力（review-01.md 必改项 4）——

test('预算 = TAIL_LIMIT 是 stdout+stderr 合计，不是各一份', () => {
  const frames = []
  const m = createChunkMerger({ intervalMs: 100, flush: (f) => frames.push(f), now: () => 0 })
  m.push('stdout', 'x'.repeat(TAIL_LIMIT))
  m.push('stderr', 'e'.repeat(100))
  m.flushNow()
  const total = frames.reduce((n, f) => n + f.stdout.length + f.stderr.length, 0)
  assert.ok(total <= TAIL_LIMIT)
  assert.equal(frames.at(-1).truncated, true)
})

test('超预算时丢弃最早内容、只保留块内尾部', () => {
  const frames = []
  const m = createChunkMerger({ intervalMs: 100, flush: (f) => frames.push(f), now: () => 0 })
  m.push('stdout', 'x'.repeat(60000))
  // 第二块**非同质**（1000 个 'h' + 9000 个 't'）：块内「留头 / 留尾」结果不同，
  // 才能杀死"改成 chunk.slice(0, budget)"这类变异（同质块用两种切法结果相同 ⇒ 零分辨力）。
  m.push('stdout', 'h'.repeat(1000) + 't'.repeat(9000))
  m.flushNow()
  // 预算 65536-60000 = 5536 ⇒ 只留第二块尾部：1000 个 'h' 全丢，剩 't'*5536
  assert.equal(frames[1].stdout.length, 5536)
  assert.equal(frames[1].stdout[0], 't') // 留尾 ⇒ 't'；若实现改成"块内留头" ⇒ 'h'
  assert.ok(!frames[1].stdout.includes('x')) // 更早的内容（第一块）不会被重复带进第二帧
})

test('距上次 emit ≥ intervalMs 时自动 flush（不依赖 flushNow）', () => {
  const frames = []
  let t = 0
  const m = createChunkMerger({ intervalMs: 100, flush: (f) => frames.push(f), now: () => t })
  m.push('stdout', 'a')
  assert.equal(frames.length, 0)
  t = 150
  m.push('stdout', 'b')
  assert.equal(frames.length, 1)
  assert.equal(frames[0].stdout, 'ab')
})

test('空截断帧只发一次（预算耗尽后连续输出不再产生空帧）', () => {
  const frames = []
  let t = 0
  const m = createChunkMerger({ intervalMs: 100, flush: (f) => frames.push(f), now: () => t })
  m.push('stdout', 'x'.repeat(TAIL_LIMIT))
  for (let i = 0; i < 5; i++) {
    t += 150 // 每次都走出时间分支，确保「是否重复发空帧」可见
    m.push('stdout', 'z')
  }
  m.flushNow()
  const emptyTruncated = frames.filter((f) => f.stdout === '' && f.stderr === '' && f.truncated === true)
  assert.equal(emptyTruncated.length, 1)
})
