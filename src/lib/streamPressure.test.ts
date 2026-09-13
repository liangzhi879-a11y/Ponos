// 流式降频门控（R5）——纯状态机，用注入的假时钟逐毫秒断言。
// 运行：node --test src/lib/streamPressure.test.ts
//
// 这一组测试针对的是**旧判据的失效模式**：旧实现测"单帧处理耗时"，在真实负载下从未
// 置位过（计时不含 React 提交）。故这里既测阈值，也测状态机的形状——进快出慢、
// 中间带维持现状、退出需连续满足 250ms；只测阈值的话，把滞回删掉这几条照样全绿。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHeavyModeGate, nextFlushDelay, HEAVY_MODE_THRESHOLDS } from './streamPressure.ts'

const T = HEAVY_MODE_THRESHOLDS

test('稀疏事件（深度 1、年龄 16ms）不降频：慢一帧 ≠ 跟不上', () => {
  const g = createHeavyModeGate()
  for (let i = 0; i < 100; i++) assert.equal(g.observe(1, 16, i * 100), false)
  assert.equal(g.takeStats().enters, 0)
})

test('深度达阈值即降频（进档不等观察期）', () => {
  const g = createHeavyModeGate()
  assert.equal(g.observe(T.depthIn, 5, 1000), true)
  const s = g.takeStats()
  assert.equal(s.enters, 1)
  assert.equal(s.lastReason, 'depth=8', '成因要能说清是深度还是年龄触发的')
})

test('年龄达阈值即降频（深度只有 1 也能触发——单线程下"排定的 flush 晚点触发"就是这个信号）', () => {
  const g = createHeavyModeGate()
  assert.equal(g.observe(1, T.ageInMs, 1000), true)
  assert.equal(g.takeStats().lastReason, 'age=120ms')
  // 阈值下一档不触发
  const g2 = createHeavyModeGate()
  assert.equal(g2.observe(1, T.ageInMs - 1, 1000), false)
})

test('阈值是闭区间：恰好等于阈值即算越过', () => {
  assert.equal(createHeavyModeGate().observe(T.depthIn, 0, 0), true)
  assert.equal(createHeavyModeGate().observe(0, T.ageInMs, 0), true)
})

test('中间带维持现状：已降频不因一次中间值退出，未降频不因一次中间值进入', () => {
  const heavyGate = createHeavyModeGate()
  heavyGate.observe(T.depthIn, 0, 0)          // 先降频
  assert.equal(heavyGate.observe(4, 60, 10), true, '中间带（4 条 / 60ms）不得退出降频')
  assert.equal(heavyGate.observe(4, 60, 10_000), true, '中间带不给退出计时累加')

  const lightGate = createHeavyModeGate()
  assert.equal(lightGate.observe(4, 60, 0), false, '未降频时中间带不得进入降频')
  assert.equal(lightGate.observe(4, 60, 10_000), false)
})

test('退出要连续满足 exitHoldMs：249ms 仍降频，满 250ms 才恢复', () => {
  const g = createHeavyModeGate()
  g.observe(T.depthIn, 0, 0)
  assert.equal(g.observe(1, 10, 100), true, '第一次低压力只开始计时')
  assert.equal(g.observe(1, 10, 100 + T.exitHoldMs - 1), true, '还差 1ms，仍降频')
  assert.equal(g.observe(1, 10, 100 + T.exitHoldMs), false, '连续满足满时长 → 恢复满速')
  assert.equal(g.takeStats().exits, 1)
})

test('退出计时被打断就重来：一次中间带即清零', () => {
  const g = createHeavyModeGate()
  g.observe(T.depthIn, 0, 0)
  g.observe(1, 10, 100)                       // 开始计时
  g.observe(4, 60, 200)                       // 中间带 → 计时清零
  assert.equal(g.observe(1, 10, 300), true, '重新开始计时')
  // 关键断言：从 300 起算必须**重新**等满 250ms。若中间带没把计时清零（累计法），
  // 此时 now-100=449 早已过线 ⇒ 会误判成可以出档。
  assert.equal(g.observe(1, 10, 300 + T.exitHoldMs - 1), true, '不得累计中断前的那 200ms')
  assert.equal(g.observe(1, 10, 300 + T.exitHoldMs), false)
})

test('出档要"深度低 **且** 年龄小"：深度降了就出档会漏掉仍在排队的事件', () => {
  // 深度 1（≤2 达标）但年龄 100ms（>40 未达标）——这是中间带，不是低压力。
  // 若把出档条件写成 OR（只看深度），这种情况会被误判成"可以恢复满速"，
  // 而实际上那条事件已经等了 100ms，正是降频该生效的场景。
  const g = createHeavyModeGate()
  g.observe(T.depthIn, 0, 0)
  assert.equal(g.observe(1, 100, 100), true, '年龄未达标 ⇒ 中间带，维持降频')
  assert.equal(g.observe(1, 100, 10_000), true, '中间带不给退出计时累加，再久也不出档')
  // 对照：年龄也降下来后才开始计退出时间
  assert.equal(g.observe(1, 10, 20_000), true, '刚开始计退出时间')
  assert.equal(g.observe(1, 10, 20_000 + T.exitHoldMs), false)
})

test('低压力下的重复观察不会重复计数（未降频时 lowSince 只置一次）', () => {
  const g = createHeavyModeGate()
  for (let i = 0; i < 10; i++) g.observe(1, 5, i * 1000)
  const s = g.takeStats()
  assert.equal(s.exits, 0)
  assert.equal(s.enters, 0)
})

test('进快出慢：一次高压即进档，出档要等满 hold', () => {
  const g = createHeavyModeGate()
  assert.equal(g.observe(1, 10, 0), false)
  assert.equal(g.observe(T.depthIn, 10, 16), true, '进档不需要观察期')
  assert.equal(g.observe(1, 10, 32), true, '出档要等满 250ms')
})

test('reset 立即回满速（流结束/断线不该把降频状态带进下一轮）', () => {
  const g = createHeavyModeGate()
  g.observe(T.depthIn, 0, 0)
  assert.equal(g.heavy, true)
  g.reset()
  assert.equal(g.heavy, false, 'reset 不等 exitHold')
  assert.equal(g.observe(1, 5, 10), false)
})

test('统计取走即归零，峰值独立于进出次数', () => {
  const g = createHeavyModeGate()
  g.observe(20, 400, 0)
  g.observe(1, 10, 100)
  const s = g.takeStats()
  assert.equal(s.maxDepth, 20)
  assert.equal(s.maxAgeMs, 400)
  assert.equal(s.enters, 1)
  const s2 = g.takeStats()
  assert.equal(s2.maxDepth, 0)
  assert.equal(s2.enters, 0)
})

test('调度延迟：降频期固定合帧间隔（进取档 120ms，不是旧实现的 250ms）', () => {
  const g = createHeavyModeGate()
  g.observe(T.depthIn, 0, 0)
  assert.equal(nextFlushDelay(g, 0), T.coalesceMs)
  assert.equal(nextFlushDelay(g, 500), T.coalesceMs, '降频期与距上次 flush 多久无关')
  assert.ok(T.coalesceMs <= 150, '进取档：合帧不得超过 150ms')
})

test('调度延迟：满速期补足到 16ms 目标帧间隔，且不为负', () => {
  const g = createHeavyModeGate()
  assert.equal(nextFlushDelay(g, 0), 16, '距上次 flush 0ms → 等满一帧')
  assert.equal(nextFlushDelay(g, 3), 13)
  assert.equal(nextFlushDelay(g, 16), 0, '已过一帧 → 立即执行')
  assert.equal(nextFlushDelay(g, 500), 0, '不得返回负数（setTimeout 会当 0，但语义要显式）')
})

test('差分：随机压力序列下，降频状态只由"进快出慢+滞回"这一条规则决定', () => {
  // 参考实现：把规则独立写一遍（不是复制实现），逐列比对每个时刻的状态。
  const ref = (seq: Array<[number, number, number]>) => {
    let heavy = false
    let lowSince: number | null = null
    const out: boolean[] = []
    for (const [depth, age, now] of seq) {
      const over = depth >= T.depthIn || age >= T.ageInMs
      const under = depth <= T.depthOut && age <= T.ageOutMs
      if (over) { heavy = true; lowSince = null }
      else if (!under) { lowSince = null }
      else if (lowSince === null) { lowSince = now }
      else if (heavy && now - lowSince >= T.exitHoldMs) { heavy = false }
      out.push(heavy)
    }
    return out
  }
  let seed = 12345
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  for (let trial = 0; trial < 50; trial++) {
    const seq: Array<[number, number, number]> = []
    let now = 0
    for (let i = 0; i < 60; i++) {
      now += Math.floor(rnd() * 80)
      const depth = Math.floor(rnd() * 12)
      const age = Math.floor(rnd() * 200)
      seq.push([depth, age, now])
    }
    const g = createHeavyModeGate()
    const got = seq.map(([d, a, n]) => g.observe(d, a, n))
    assert.deepEqual(got, ref(seq), `trial=${trial}`)
  }
})
