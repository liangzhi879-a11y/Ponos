// src/lib/firstByteUi.test.ts —— 等待态判定纯逻辑单测（T8）
// 运行：node --test src/lib/firstByteUi.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
// 注意：npm test 只跑 server/ + electron/（package.json:19），本文件需手动跑。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveWaitView, secondsOf, type WaitSnapshot } from './firstByteUi.ts'

const EMPTY: WaitSnapshot = {
  approvalCount: 0, hasQuestion: false, stallMs: 0, firstByteMs: 0, compacting: false,
}
const snap = (p: Partial<WaitSnapshot>): WaitSnapshot => ({ ...EMPTY, ...p })

test('无任何等待态时返回 null（调用方据此不占位）', () => {
  assert.equal(deriveWaitView(EMPTY), null)
})

test('审批优先于提问/失速/首字节/压缩，且不显示秒数（等的是人）', () => {
  const v = deriveWaitView(snap({
    approvalCount: 1, hasQuestion: true, stallMs: 120_000, firstByteMs: 30_000, compacting: true,
  }))
  assert.equal(v?.kind, 'approval')
  assert.equal(v?.i18nKey, 'firstByteWait.waitingApproval')
  assert.equal(v?.showSeconds, false)
  assert.equal(v?.sinceMs, 0)
})

test('提问优先于失速/首字节/压缩，且不显示秒数', () => {
  const v = deriveWaitView(snap({ hasQuestion: true, stallMs: 100_000, firstByteMs: 9_000, compacting: true }))
  assert.equal(v?.kind, 'question')
  assert.equal(v?.showSeconds, false)
})

test('失速优先于首字节等待（桥侧 90s 升级语义）并带秒数', () => {
  const v = deriveWaitView(snap({ stallMs: 96_000, firstByteMs: 30_000 }))
  assert.equal(v?.kind, 'stall')
  assert.equal(v?.i18nKey, 'kernelStall.title')
  assert.equal(v?.showSeconds, true)
  assert.equal(v?.sinceMs, 96_000)
  assert.equal(v?.i18nParams.secs, 96)
})

test('仅首字节等待时给「等待模型」文案 + 秒数基准', () => {
  const v = deriveWaitView(snap({ firstByteMs: 5_000 }))
  assert.equal(v?.kind, 'firstByte')
  assert.equal(v?.i18nKey, 'firstByteWait.waitingModel')
  assert.equal(v?.showSeconds, true)
  assert.equal(v?.sinceMs, 5_000)
  assert.equal(v?.i18nParams.secs, 5)
})

test('仅压缩时不显示秒数（compress 只有布尔态，无时间基准）', () => {
  const v = deriveWaitView(snap({ compacting: true }))
  assert.equal(v?.kind, 'compact')
  assert.equal(v?.i18nKey, 'compacting.title')
  assert.equal(v?.showSeconds, false)
})

test('优先级全序：审批 > 提问 > 失速 > 首字节 > 压缩', () => {
  const order = [
    snap({ approvalCount: 1, hasQuestion: true, stallMs: 1, firstByteMs: 1, compacting: true }),
    snap({ hasQuestion: true, stallMs: 1, firstByteMs: 1, compacting: true }),
    snap({ stallMs: 1, firstByteMs: 1, compacting: true }),
    snap({ firstByteMs: 1, compacting: true }),
    snap({ compacting: true }),
  ]
  assert.deepEqual(
    order.map(s => deriveWaitView(s)?.kind),
    ['approval', 'question', 'stall', 'firstByte', 'compact'],
  )
})

test('secondsOf：锚点后平滑递增（不是每 30s 才跳一次）', () => {
  // 桥发来 5000ms 的那一刻起，本地每 1s 应各自递增
  assert.equal(secondsOf(5_000, 0), 5)
  assert.equal(secondsOf(5_000, 900), 5)
  assert.equal(secondsOf(5_000, 1_000), 6)
  assert.equal(secondsOf(5_000, 25_000), 30)
  // 下一次桥帧到达（30000 → 值变化触发重新锚定）后仍是连续的
  assert.equal(secondsOf(30_000, 0), 30)
  assert.equal(secondsOf(30_000, 1_000), 31)
})

test('secondsOf：永不为 0（首帧 1000ms 以内也显示 1 秒）', () => {
  assert.equal(secondsOf(0, 0), 1)
  assert.equal(secondsOf(0, 400), 1)
  assert.equal(secondsOf(1, 0), 1)
})
