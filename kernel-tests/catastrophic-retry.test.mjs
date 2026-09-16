// 内核 P0-3：审批不可绕过化 —— 灾难命令"同族重试硬拒"（kernel/engine.mjs gateToolUse）
// ---------------------------------------------------------------------------
// 背景（2026-09-16，来源：docs/2026-09-15-五引擎架构性能对比分析.md §5 P0-3）：
//   改前的 `hard:true` 只保证「每次都问」，**没有**「拒绝后同族重试不再问」的拦截层。
//   用户拒绝 `rm -rf /` 后，模型在同一轮内改写/升权再试（`rm -rf /*`、`sudo rm -rf /`、
//   `bash -c "rm -rf /"`）会**再次弹窗**——反复弹窗正是"审批疲劳"的来源（用户在第三、
//   四次点击「允许」的概率显著上升），底线拦截因此被"重试"绕过。
//
// 本文件钉住的三件事（对齐 spec §4）：
//   ① 同一轮内**只弹一次**窗，同族重试被直接硬拒（不再是"每次都问"）；
//   ② 拦截**按族**生效，能挡住**改写变体**（用例刻意让第二次换个写法：`rm -rf /*`）；
//   ③ 不越界：跨轮清空（一次拒绝不永久封禁该族）、普通命令照旧可问（不外溢）。
//
// 【防假绿纪律】断言分两半、缺一不可：
//   - "只问了一次"（asks === 1）单独看可能是假绿——若模型根本没重试，它必然成立；
//   - "重试真的发生了且走了硬拒路径"（hardDeny 结果 ≥ 1）单独看也不够——它不能证明
//     没有多弹窗。
//   二者**同时**成立才证明拦截真的生效。这也是本文件与 permission-gate-mode.test.mjs
//   的分工：那边只断言"每轮至少挂起一次"（不重复询问不成立时它照样绿）。
//
// mock：用 `[mock:catastrophic-retry]`（api.mjs 中置于"工具结果回合"分支之前）——
// 一轮内第 1 次 `rm -rf /`、第 2 次同族改写 `rm -rf /*`、第 3 次起结果回显收轮。
// 计数在 PONOS_MOCK_CATA_RETRY_N，每轮开跑前清空即复位。
process.env.PONOS_MOCK_API = '1'
const { createEngine } = await import('../kernel/engine.mjs')
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore } from '../kernel/session.mjs'
import { makeWire } from '../kernel/protocol.mjs'

const TMP_DIRS = []
after(() => { for (const d of TMP_DIRS.splice(0)) { try { rmSync(d, { recursive: true, force: true }) } catch {} } })

/** 复位"同族重试"mock 的次数计数（每轮开跑前调用，保证每轮都从第 1 次开始） */
function resetRetryMock() { delete process.env.PONOS_MOCK_CATA_RETRY_N }

// 夹具形态与 permission-gate-mode.test.mjs 一致（mock API + 空系统提示 + 手动应答）
function setup({ mode = 'manual', approve = false } = {}) {
  const events = []
  const dir = mkdtempSync(join(tmpdir(), 'cata-retry-'))
  TMP_DIRS.push(dir)
  const configDir = join(dir, 'home')
  const session = createSessionStore({ configDir, cwd: dir, sessionId: '00000000-0000-0000-0000-0000000000cc' })
  let engine
  const wire = makeWire({
    write(s) {
      const e = JSON.parse(s)
      events.push(e)
      if (e.type === 'control_request' && e.request?.subtype === 'can_use_tool') {
        const id = e.request.tool_use_id
        const ok = typeof approve === 'function' ? approve(e.request) : approve
        setImmediate(() => engine.resolveApproval(id, ok ? { behavior: 'allow' } : { behavior: 'deny' }))
      }
    },
  })
  const context = { window: 200000, thresholdRatio: 0.8, retainRatio: 0.16, estimate: () => 1000, estimateMessage: () => 10, estimateHistory: () => 10 }
  engine = createEngine({
    opts: { model: 'm', configDir, addDirs: [dir], approvalMode: mode, systemPrompt: '', context },
    wire, session, compactor: null,
  })
  return { dir, events, session, engine }
}

const isAsk = (e) => e.type === 'control_request' && e.request?.subtype === 'can_use_tool'
const CATA_CMD = /rm\s+-rf\s+\//
const cmdOf = (e) => String(e.request?.input?.command || '')
/** 灾难命令的挂起事件（按载荷里的命令行判定，而非"是 Bash"——同轮还有自愈探针的普通 Bash） */
const cataAsks = (events) => events.filter((e) => isAsk(e) && CATA_CMD.test(cmdOf(e)))
/** 普通（非灾难）挂起事件 */
const otherAsks = (events) => events.filter((e) => isAsk(e) && !CATA_CMD.test(cmdOf(e)))
/** 被"同族重试硬拒"回填给模型的结果（内容含族名） */
const hardDenyResults = (events) => events.filter((e) => e.type === 'tool_result' && /灾难族/.test(String(e.content || '')))

test('P0-3：同一轮内灾难命令只弹一次窗，同族改写变体被直接硬拒', async () => {
  resetRetryMock()
  const { events, engine } = setup({ mode: 'manual', approve: false })
  await engine.runTurn({ content: '[mock:catastrophic-retry]' })

  const asks = cataAsks(events)
  const denied = hardDenyResults(events)

  // 断言 B：只弹一次窗（改前是"每次都问"→ 反复弹窗）
  assert.equal(
    asks.length, 1,
    `灾难命令本轮应恰好挂起 1 次，实际 ${asks.length} 次：${JSON.stringify(asks.map(cmdOf))}`,
  )
  // 变体（第二个 tool_use）绝不应当获得弹窗机会
  assert.ok(
    asks.every((a) => cmdOf(a) === 'rm -rf /'),
    `只有首次的 rm -rf / 可以弹窗，实际弹过的命令：${JSON.stringify(asks.map(cmdOf))}`,
  )
  // 断言 A：重试真的发生了、且走的是硬拒路径（**防假绿的关键**：若模型没重试，这里为 0）
  assert.ok(
    denied.length >= 1,
    `未观察到"同族重试被硬拒"的结果——模型没重试（断言 B 因此失去意义）或拦截未生效。`
    + `事件类型：${JSON.stringify(events.map((e) => e.type))}`,
  )
  // 断言 C：文案要让模型明确停止，而不是换个写法再试
  const msg = String(denied[0].content || '')
  assert.match(msg, /灾难族/, `硬拒文案应指出族归因：${msg}`)
  assert.match(msg, /已于本轮拒绝/, `硬拒文案应说明是"用户已拒绝"而非系统错误：${msg}`)
  assert.equal(denied[0].is_error, true, '硬拒应以 is_error 回填')
  // 首次挂起仍须带 hard 标记（底线拦截不被本次改动削弱）
  assert.equal(asks[0].request.hard, true, '首次挂起应带 hard 标记')
  assert.match(String(asks[0].request.decision_reason || ''), /硬黑名单/, '首次挂起原因应指明硬黑名单')
})

test('P0-3：跨轮清空——一次拒绝不得永久封禁该族命令', async () => {
  const { events, engine } = setup({ mode: 'manual', approve: false })
  resetRetryMock()
  await engine.runTurn({ content: '[mock:catastrophic-retry]' })
  const afterFirst = cataAsks(events).length
  resetRetryMock()
  await engine.runTurn({ content: '[mock:catastrophic-retry]' })
  const afterSecond = cataAsks(events).length

  assert.equal(afterFirst, 1, `第 1 轮应挂起 1 次，实际 ${afterFirst}`)
  assert.equal(
    afterSecond, 2,
    `第 2 轮应**再次**挂起（每轮各 1 次，共 2 次），实际累计 ${afterSecond} 次——`
    + '若仍是 1 次，说明"轮起点清空"失效，用户一次拒绝就永久失去放行该命令的能力',
  )
})

test('P0-3：不越界——灾难族被硬拒时，普通命令照旧弹窗（拦截不外溢）', async () => {
  // approve 只拒灾难命令、放行其余：引擎在拒绝后会做一次自愈探针（普通 Bash）。
  // 若族拦截"不外溢"成立，探针这一普通 ask 应正常出现。
  resetRetryMock()
  const { events, engine } = setup({
    mode: 'manual',
    approve: (req) => !CATA_CMD.test(String(req?.input?.command || '')),
  })
  await engine.runTurn({ content: '[mock:catastrophic-retry]' })

  assert.equal(cataAsks(events).length, 1, '灾难命令应仍只挂起 1 次')
  assert.ok(
    otherAsks(events).length >= 1,
    `普通命令应照旧可问（族拦截不得外溢到普通命令），实际普通 ask：${otherAsks(events).length}`,
  )
  for (const a of otherAsks(events)) {
    assert.notEqual(a.request?.hard, true, '普通命令不应被标为 hard')
  }
})
