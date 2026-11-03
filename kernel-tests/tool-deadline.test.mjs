// 工具 deadline 分级 + 超时真取消（2026-09-21 长任务可靠性 P1 Task 8）。
//
// 两个真实缺陷：
// ① 一刀切 300s：实测「工具执行超时（300000ms）」60 次，其中 **57 次是 Agent 子代理**
//    —— 一个正经跑十分钟的子代理会被 300s 抢答；而 Task 6 刚让 Bash 的 timeout_ms 可到
//    30min，若 deadline 恒 300s，那个"可配"就形同虚设（deadline 先砍）。
// ② 超时只 resolve 一个字符串、**不取消底层**（原注释自陈"不取消底层执行"）⇒ 工具仍在
//    跑，与"已中止"的回执不符。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const engineSrc = readFileSync(join(here, '..', 'kernel', 'engine.mjs'), 'utf8')
const cfgSrc = readFileSync(join(here, '..', 'kernel', 'engine-config.mjs'), 'utf8')
const { withToolDeadline } = await import('../kernel/stream-runtime.mjs')
const { deadlineForTool, TOOL_DEADLINE_MS, TOOL_DEADLINE_LONG_MS } = await import('../kernel/engine-config.mjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── ① 超时真取消（withToolDeadline 第三参）────────────────────────────────────

test('行为：超时时调用 onTimeout（宿主据此取消底层工具）', async () => {
  let cancelled = false
  const never = new Promise(() => {}) // 永不返回，模拟"挂死的工具"
  const r = await withToolDeadline(never, 200, () => { cancelled = true })
  assert.equal(r.isError, true, '超时应返回错误结果')
  assert.equal(r.meta?.timeout, true, '应带 timeout 标记')
  assert.equal(cancelled, true, '★ 必须回调 onTimeout —— 否则底层继续跑，"已中止"是假的')
})

test('行为：正常返回时不调用 onTimeout，且结果原样透传', async () => {
  let cancelled = false
  const r = await withToolDeadline(Promise.resolve({ content: 'ok', isError: false }), 5000, () => { cancelled = true })
  assert.equal(r.content, 'ok')
  assert.equal(cancelled, false, '未超时不得取消')
})

test('行为：onTimeout 缺席时不抛异常（向后兼容两参调用）', async () => {
  const never = new Promise(() => {})
  const r = await withToolDeadline(never, 150)
  assert.equal(r.meta?.timeout, true)
})

test('行为：超时后 onTimeout 抛错不得改变返回结果', async () => {
  const never = new Promise(() => {})
  const r = await withToolDeadline(never, 150, () => { throw new Error('abort 炸了') })
  assert.equal(r.meta?.timeout, true, '回调抛错不应影响超时回执')
})

test('行为：底层拒绝（reject）仍照原样传播，不被 deadline 吞掉', async () => {
  await assert.rejects(
    () => withToolDeadline(Promise.reject(new Error('工具自身失败')), 5000, () => {}),
    /工具自身失败/,
  )
})

// ── ② 分级（deadlineForTool）──────────────────────────────────────────────────

test('Agent 子代理走长 deadline（57/60 次超时都是它）', () => {
  assert.equal(deadlineForTool('Agent', { prompt: 'x' }), TOOL_DEADLINE_LONG_MS)
  assert.ok(TOOL_DEADLINE_LONG_MS > TOOL_DEADLINE_MS, '长档必须大于默认档')
})

test('OCR / Workflow 同样走长档（都是分钟级以上的活）', () => {
  assert.equal(deadlineForTool('OCR', {}), TOOL_DEADLINE_LONG_MS)
  assert.equal(deadlineForTool('Workflow', {}), TOOL_DEADLINE_LONG_MS)
})

test('普通工具（Read/Edit/Grep）走默认档', () => {
  for (const n of ['Read', 'Edit', 'Grep', 'Glob', 'WebFetch']) {
    assert.equal(deadlineForTool(n, {}), TOOL_DEADLINE_MS, `${n} 不该走长档`)
  }
})

test('★ Bash 显式声明 timeout_ms 时，deadline 必须比它长（否则"可配超时"形同虚设）', () => {
  const ms = 600_000
  const d = deadlineForTool('Bash', { command: 'x', timeout_ms: ms })
  assert.ok(d > ms, `deadline(${d}) 必须 > 声明的超时(${ms})，否则先被 deadline 砍掉`)
})

test('Bash 未声明 timeout_ms 时走默认档（Bash 自身 120s 超时足够）', () => {
  assert.equal(deadlineForTool('Bash', { command: 'x' }), TOOL_DEADLINE_MS)
})

test('Bash 声明超大 timeout_ms 时，deadline 有上限约束（不得无限）', () => {
  const d = deadlineForTool('Bash', { command: 'x', timeout_ms: 999_999_999 })
  assert.ok(d <= TOOL_DEADLINE_LONG_MS + 60_000, `应有上限约束，实际 ${d}`)
})

test('非法 timeout_ms 不污染分级（字符串/负数/NaN）', () => {
  assert.equal(deadlineForTool('Bash', { timeout_ms: 'abc' }), TOOL_DEADLINE_MS)
  assert.equal(deadlineForTool('Bash', { timeout_ms: -5 }), TOOL_DEADLINE_MS)
  assert.equal(deadlineForTool('Bash', { timeout_ms: NaN }), TOOL_DEADLINE_MS)
})

// ── ③ 接线对账 ────────────────────────────────────────────────────────────────

test('engine 改用配置层常量与分级函数（不再硬编码 300_000）', () => {
  assert.doesNotMatch(engineSrc, /Number\(process\.env\.PONOS_TOOL_TIMEOUT_MS \|\| 300_000\)/, '不应再在 engine 内联解析')
  assert.match(engineSrc, /deadlineForTool\(/, 'engine 应调用分级函数')
  assert.match(cfgSrc, /PONOS_TOOL_TIMEOUT_LONG_MS/, '应有长档 env')
})

test('engine 为每次工具调用建独立 controller 并把 signal 传下去（取消精确到该工具）', () => {
  assert.match(engineSrc, /withToolDeadline\(/, '应仍经 withToolDeadline 执行')
  // 必须是**独占** controller：不能直接复用整批/整轮 signal（那会取消同批其它工具）
  assert.match(engineSrc, /toolCtl\.abort\(\)|toolController\.abort\(\)/, '超时应 abort 该工具独占 controller')
})
