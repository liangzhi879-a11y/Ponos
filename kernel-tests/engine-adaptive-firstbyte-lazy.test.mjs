// K1.3 惰性首字节窗口契约（2026-09-13「任务运行慢」系统性优化 Task 4）
// ---------------------------------------------------------------------------
// 背景：`makeIdleWatchdog(STREAM_IDLE_MS, adaptiveFirstByteMs(requestMessages, …))` 每个
// 请求都**无条件**求值一次自适应窗口，其内部 `JSON.stringify(messagesProvider())` 实测
// **16.7ms/次**（2.5MB 历史）——而这个值只在"首个 chunk 前、已等到 STREAM_IDLE_MS 仍无数据"
// 这一罕见形态下才用得上（正常首字节 0.3–0.6s，远小于 300s）。
//
// 本文件锁四件事（真实 timer，无假时钟）：
//   1) **零求值**：立即 stop() / 守卫关闭（ms<=0）⇒ 提供者调用次数 0。
//   2) **放宽态只求值一次**：阈值放宽（600s）时 `tripped===false` 且求值恰好 1 次（有缓存）。
//   3) **常量路径逐字不变**：`firstByteMs < ms` 的历史用法仍按小阈值 trip（含检查门槛与周期）。
//   4) **提供者抛错不抛穿**：退回 ms（底层 setInterval 里抛异常会变成进程级错误）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
const { makeIdleWatchdog, adaptiveFirstByteMs } = await import('../kernel/engine.mjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('立即 stop()：提供者调用次数 0（那次 16.7ms 的 stringify 根本不该发生）', () => {
  let calls = 0
  const w = makeIdleWatchdog(1000, () => { calls++; return 600_000 })
  w.stop()
  assert.equal(calls, 0)
  assert.equal(w.tripped, false)
})

test('守卫关闭（ms<=0）：全 no-op，提供者永不被调用', async () => {
  let calls = 0
  const w = makeIdleWatchdog(0, () => { calls++; return 600_000 })
  assert.equal(w.controller, null)
  await sleep(40)
  w.tick()
  w.stop()
  assert.equal(calls, 0, 'no-op 形态不得求值（也就不该起 timer）')
  assert.equal(w.tripped, false)
})

test('阈值放宽（600s）：不 trip，且提供者只求值 1 次', async () => {
  let calls = 0
  const w = makeIdleWatchdog(40, () => { calls++; return 600_000 })
  try {
    await sleep(200) // 远超 ms=40（旧实现早已 trip）+ 5 个 timer 周期
    assert.equal(w.tripped, false, '放宽窗口内不得 trip（否则长 prefill 被误杀）')
    assert.equal(calls, 1, `求值应恰好 1 次（有缓存，实际 ${calls}）`)
  } finally { w.stop() }
})

test('有数据后按 ms 判生成停顿（两阶段语义不变）', async () => {
  let calls = 0
  const w = makeIdleWatchdog(40, () => { calls++; return 600_000 })
  try {
    w.tick() // 首 chunk 已到 → 切到 ms 窗口
    await sleep(120)
    assert.equal(w.tripped, true, '首 chunk 后的停顿仍须按 ms 收尾')
    assert.equal(calls, 0, '有数据后不再需要自适应窗口 ⇒ 一次都不求值')
  } finally { w.stop() }
})

test('提供者返回 < ms（窄窗口）：仍会 trip，不会永久不触发', async () => {
  const w = makeIdleWatchdog(40, () => 10)
  try {
    await sleep(140)
    assert.equal(w.tripped, true, '解析出的阈值小于 ms 时也必须能 trip')
  } finally { w.stop() }
})

test('提供者抛错：退回 ms，不抛穿（setInterval 内抛异常是进程级错误）', async () => {
  let calls = 0
  const w = makeIdleWatchdog(40, () => { calls++; throw new Error('estimate boom') })
  try {
    await sleep(140)
    assert.equal(calls, 1, '抛错后应缓存兜底值，不每周期重试')
    assert.equal(w.tripped, true, '兜底为 ms ⇒ 仍按 ms 收尾')
  } finally { w.stop() }
})

test('常量路径逐字不变：firstByteMs < ms 仍按小阈值 trip', async () => {
  // 旧实现：阈值 = firstByteMs(30)，检查门槛与 timer 周期 = min(ms, firstMs, 5000) = 30
  const w = makeIdleWatchdog(600_000, 30)
  try {
    await sleep(120)
    assert.equal(w.tripped, true, '常量小阈值必须与旧版一致（不能被 ms 门槛拖后）')
  } finally { w.stop() }
})

test('常量路径：ms 内不 trip（首个 chunk 前按常量宽限）', async () => {
  const w = makeIdleWatchdog(500, 10_000)
  try {
    await sleep(150)
    assert.equal(w.tripped, false)
  } finally { w.stop() }
})

test('adaptiveFirstByteMs 仍是惰性提供者的后端（签名与语义未变）', () => {
  const small = adaptiveFirstByteMs(() => [{ role: 'user', content: 'hi' }], 300_000)
  assert.equal(small, 300_000)
  const big = adaptiveFirstByteMs(() => [{ role: 'user', content: 'x'.repeat(300_000) }], 300_000)
  assert.equal(big, 600_000)
  // 组合形态 = 引擎调用点：提供者内部才做那 16.7ms
  let called = 0
  const w = makeIdleWatchdog(1000, () => { called++; return adaptiveFirstByteMs(() => [{ role: 'user', content: 'x'.repeat(300_000) }], 300_000) })
  w.stop()
  assert.equal(called, 0, '引擎调用点（懒包装）在正常路径上一次都不求值')
})
