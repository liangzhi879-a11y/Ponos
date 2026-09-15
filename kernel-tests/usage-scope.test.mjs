// K2.0 `scope=today` 日期下推契约（2026-09-13「任务运行慢」系统性优化 Task 7）
// ---------------------------------------------------------------------------
// 修复前的实况：`runUsage` 里 `scope` **只**驱动 bySession 开关，from/to 恒取自 args ⇒
// `scope='today'` 与 `'all'` 是同一件事（全量历史聚合）。而唯一的调用方把它当「今日」用：
// 驾驶舱卡每 5s 轮询 `fetchUsage({scope:'today'})`（useCockpitOverview.ts:141，GUI 侧超时
// 也正好 5s），卡片文案「今日 / requests=今日 turns」读的就是被过滤后的 totals。
//
// 本文件钉三件事：
//   ① 语义：today 真的只算当天（含 UTC 零点边界、与 to 的交集）；
//   ② **不回归**：文档化契约（specs/2026-09-08-agentloop-prod-upgrade-design.md:65 只有
//      session|project|all）里 scope 是**分组维度**不是时间窗口——`scope='session'` 的多天
//      总量必须与 `'all'` 完全相等；
//   ③ 入口：scope 经 runReadonly（cli 真实路径）能到达内核。
//
// 时间基准一律**注入 now**（`runUsage({now})`），不用真实时钟——否则跨零点抖动会让
// 「今天/昨天」的期望值瞬间失效。唯一用真实时钟的是入口用例，它只断言不等式（见末尾）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { runUsage, runReadonly, todayFrom, collectTranscriptFiles } = await import('../kernel/readonly.mjs')
const { sanitizeSegment } = await import('../kernel/session.mjs')

const HOME = () => mkdtempSync(join(tmpdir(), 'usage-scope-'))
/** 一条可被 aggregateUsage 计入的 assistant 条目（usage.input_tokens 必须是有限数） */
const row = (day, inp, sid = 's') => JSON.stringify({
  type: 'assistant', id: `e-${day}-${inp}`, seq: inp, timestamp: `${day}T12:00:00.000Z`,
  message: { role: 'assistant', content: [], usage: { input_tokens: inp, output_tokens: 1 }, model: 'm' }, sessionId: sid,
})
/** 写一个 transcript（home/projects/<cwd-san>/<sid>.jsonl）；rows 直接给行数组 */
function seed(home, { sid = 's-a', cwd = 'proj-a', rows = [] } = {}) {
  const dir = join(home, 'projects', sanitizeSegment(cwd))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${sid}.jsonl`), rows.join('\n') + '\n')
  return join(dir, `${sid}.jsonl`)
}

test('todayFrom：取给定时刻的 UTC 日（与 transcript 写入、byDate 分桶同一日界）', () => {
  assert.equal(todayFrom(new Date('2026-03-05T23:59:59.999Z')), '2026-03-05')
  assert.equal(todayFrom(new Date('2026-03-06T00:00:00.000Z')), '2026-03-06')
})

test('核心：跨两天的 transcript → scope=today 只算今天；省略 scope 时口径不变（全量）', () => {
  const home = HOME()
  try {
    seed(home, { rows: [row('2026-09-12', 100), row('2026-09-13', 7), row('2026-09-11', 1000)] })
    const now = new Date('2026-09-13T10:00:00Z')
    const today = runUsage({ configDir: home, scope: 'today', now })
    assert.equal(today.totals.input_tokens, 7, 'today 必须只算 2026-09-13')
    assert.equal(today.totals.turns, 1)
    // 口径不变：默认（不传 scope）与显式 all 都仍是全量
    assert.equal(runUsage({ configDir: home, now }).totals.input_tokens, 1107)
    assert.equal(runUsage({ configDir: home, scope: 'all', now }).totals.input_tokens, 1107)
    // 同一天的多条要合起来（不是只取一条）
    assert.equal(runUsage({ configDir: home, scope: 'today', now }).byDate['2026-09-13'].turns, 1)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('UTC 零点为界：昨天 23:59:59Z 不计入今天，今天 00:00:00Z 计入', () => {
  const home = HOME()
  try {
    seed(home, {
      rows: [
        row('2026-09-12', 500),                     // 昨天正午
        row('2026-09-12', 500),                     // 昨天（再一条，确保不是"取最后一天"）
        row('2026-09-13', 3),                       // 今天 00:00Z
      ],
    })
    const r = runUsage({ configDir: home, scope: 'today', now: new Date('2026-09-13T00:00:00Z') })
    assert.equal(r.totals.input_tokens, 3, '零点整必须算今天')
    // 边界另一侧：同一份数据在零点前一刻求值 → 只有昨天的 1000
    const before = runUsage({ configDir: home, scope: 'today', now: new Date('2026-09-12T23:59:59Z') })
    assert.equal(before.totals.input_tokens, 1000, '零点前一刻只有昨天')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('按行过滤而非按文件：同一条 transcript 里跨天的条目各归各天', () => {
  const home = HOME()
  try {
    seed(home, { rows: [row('2026-09-10', 1), row('2026-09-13', 2), row('2026-09-14', 4)] })
    const r = runUsage({ configDir: home, scope: 'today', now: new Date('2026-09-13T08:00:00Z') })
    assert.equal(r.totals.input_tokens, 2, '只应取中间那条（同文件内的今天条目）')
    assert.deepEqual(Object.keys(r.byDate), ['2026-09-13'], 'byDate 也应只剩今天')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('显式 from 优先于 scope=today 的推导（from 是文档化契约里更具体的参数）', () => {
  const home = HOME()
  try {
    seed(home, { rows: [row('2026-09-12', 100), row('2026-09-13', 7)] })
    const now = new Date('2026-09-13T10:00:00Z')
    assert.equal(runUsage({ configDir: home, scope: 'today', from: '2026-09-01', now }).totals.input_tokens, 107,
      '显式 from 必须赢')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('today 与 to 是交集：to 早于今天 → 空集（两个过滤都真的在生效）', () => {
  const home = HOME()
  try {
    seed(home, { rows: [row('2026-09-12', 100), row('2026-09-13', 7)] })
    const now = new Date('2026-09-13T10:00:00Z')
    const empty = runUsage({ configDir: home, scope: 'today', to: '2026-09-12', now })
    assert.equal(empty.totals.turns, 0, 'from=今天 & to=昨天 必为空——若今日推导丢了这里会有 1 条')
    const capped = runUsage({ configDir: home, scope: 'today', to: '2026-09-13', now })
    assert.equal(capped.totals.input_tokens, 7)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('不回归：scope=session 仍是**分组维度**，不是时间窗口（多天总量必须等于 all）', () => {
  const home = HOME()
  try {
    // 两个会话、跨三天
    seed(home, { sid: 's-a', rows: [row('2026-09-11', 10, 's-a'), row('2026-09-13', 20, 's-a')] })
    seed(home, { sid: 's-b', rows: [row('2026-09-12', 30, 's-b')] })
    const now = new Date('2026-09-13T10:00:00Z')
    const sess = runUsage({ configDir: home, scope: 'session', now })
    assert.equal(sess.totals.input_tokens, 60, 'scope=session 不得附带任何日期窗口')
    assert.equal(sess.totals.input_tokens, runUsage({ configDir: home, scope: 'all', now }).totals.input_tokens)
    assert.equal(sess.bySession['s-a'].input_tokens, 30)
    assert.equal(sess.bySession['s-b'].input_tokens, 30)
    // project / all 同样不构成窗口
    assert.equal(runUsage({ configDir: home, scope: 'project', now }).totals.input_tokens, 60)
    // 且 today 时 bySession 仍按 scope 语义缺席（两个维度正交）
    assert.equal(runUsage({ configDir: home, scope: 'today', now }).bySession, undefined)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('today 与 project/sessionId 过滤正交（不会互相吃掉）', () => {
  const home = HOME()
  try {
    seed(home, { sid: 's-a', cwd: 'proj-a', rows: [row('2026-09-13', 5, 's-a')] })
    seed(home, { sid: 's-b', cwd: 'proj-b', rows: [row('2026-09-13', 50, 's-b'), row('2026-09-12', 500, 's-b')] })
    const now = new Date('2026-09-13T10:00:00Z')
    assert.equal(runUsage({ configDir: home, scope: 'today', project: sanitizeSegment('proj-b'), now }).totals.input_tokens, 50)
    assert.equal(runUsage({ configDir: home, scope: 'today', sessionId: 's-a', now }).totals.input_tokens, 5)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('入口：scope 经 runReadonly 抵达内核；today 的子集严格小于全量（真实时钟，只断不等式）', () => {
  // 本用例走 cli 的真实入口且**不注入 now**（runReadonly 无该参数）：故只断言不等式——
  // 旧条目固定在 2020 年（任何时刻都不可能是"今天"），今天那条用真实时钟写；即便评测瞬间
  // 跨了零点，也只可能把今天那条排除掉，不等式仍成立、不会假红。
  const home = HOME()
  try {
    seed(home, { rows: [row('2020-01-01', 900), row('2020-01-02', 900), row(new Date().toISOString().slice(0, 10), 1)] })
    const all = runReadonly({ mode: 'usage', args: {}, configDir: home })
    const today = runReadonly({ mode: 'usage', args: { scope: 'today' }, configDir: home })
    assert.equal(all.code, 0)
    assert.equal(all.output.totals.turns, 3, '默认口径 = 全量（3 条）')
    assert.ok(today.output.totals.turns <= 1, 'today 至多含今天那条')
    assert.ok(today.output.totals.turns < all.output.totals.turns, 'today 必须是全量的真子集')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('文件遍历层：collectTranscriptFiles 的 from 语义就是 today 所用的那一套（同源）', () => {
  // today 的推导复用的正是这里的 `ts.slice(0,10) < from` 比较——两者一旦分家，today 就会
  // 静默偏移一天。这条钉住底层语义，今日推导只是给它喂了一个 from。
  const home = HOME()
  try {
    seed(home, { rows: [row('2026-09-12', 1), row('2026-09-13', 2)] })
    const only = collectTranscriptFiles({ configDir: home, from: '2026-09-13' })
    assert.equal(only.length, 1)
    assert.equal(only[0].timestamp.slice(0, 10), '2026-09-13')
    assert.equal(runUsage({ configDir: home, scope: 'today', now: new Date('2026-09-13T10:00:00Z') }).totals.turns,
      only.filter((e) => e.type === 'assistant').length, 'today 的条目集必须与直接传 from 完全一致')
    assert.equal(runUsage({ configDir: home, scope: 'today', from: '2026-09-13', now: new Date('2026-09-13T10:00:00Z') }).totals.turns,
      runUsage({ configDir: home, scope: 'today', now: new Date('2026-09-13T10:00:00Z') }).totals.turns,
      '显式传与推导出的同一个 from 必须得到同一结果（推导值本身是对的）')
  } finally { rmSync(home, { recursive: true, force: true }) }
})
