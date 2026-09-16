// kernel-tests/loop-stall-guard.test.mjs —— loop 停滞自续跑回归 + /loop 四端语法契约锁
// ---------------------------------------------------------------------------
// 背景（2026-09-15 实测复现并修复）：
//   ① 内核：onTurnEnd 的无进展分支会注入一条反思消息并把 status 置为 awaiting_approval，
//      而 awaiting_approval 属于 isActive() ⇒ cli 在**那条被注入消息**的轮末又进
//      onTurnEnd（cli.mjs `if (loop.isActive())`），指纹不变 ⇒ streak 继续增长 ⇒ 再注入
//      …… 形成"每轮一次 API 调用"的无限自续跑（管道 mock 下 60s 跑到第 19 轮仍未停）。
//      既有 loop-e2e 用 PONOS_LOOP_NOPROGRESS_N=99 关了这条分支，故此前无覆盖。
//   ② TUI：自带一套只认「次数/--until/--fresh」的旧解析，与 loop-commands.mjs 的契约
//      语法互相吞 —— `/loop status` 的 status 掉进 prompt 分支，**静默真起 3 轮 loop**。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLoopController } from '../kernel/loop.mjs'
import { parseLoopDirective } from '../kernel/loop-commands.mjs'

/** 每轮都产生**完全相同**的工具摘要 = 指纹不变 = 无进展（stall 的触发条件） */
const sameDigest = () => ({ toolDigest: [{ name: 'Read', path: 'a.txt', isError: false }] })

function makeLoop({ count = 3, env = {} } = {}) {
  const injected = []
  const frames = []
  const wire = { loop: (s, d) => frames.push({ kind: 'loop', s, d }), system: () => {}, warning: () => {} }
  const engine = { queueNext: (m) => injected.push(m), tools: {}, signal: null }
  const configDir = mkdtempSync(join(tmpdir(), 'ponos-loop-stall-'))
  const loop = createLoopController({
    wire, engine, configDir, sessionId: 'stall-guard', cwd: configDir,
    env: { PONOS_LOOP_NOPROGRESS_N: '3', ...env },
  })
  loop.start({ count, prompt: '任意任务' })
  return { loop, injected, frames }
}

test('无进展升级 awaiting_approval 后不再自续（防烧钱循环）', async () => {
  const { loop, injected } = makeLoop()
  const steps = []
  for (let i = 0; i < 3; i++) steps.push(await loop.onTurnEnd({ outcome: sameDigest() }))
  assert.equal(steps[2].rationale, 'no_progress', '第 3 轮同指纹应升级为无进展停滞')
  assert.equal(loop.status().status, 'awaiting_approval')
  assert.equal(loop.status().pendingApproval?.kind, 'no_progress')

  const indexAtStall = loop.status().index
  const streakAtStall = loop.status().noProgress.streak
  const injectedAtStall = injected.length

  // 模拟 cli：awaiting_approval ∈ isActive()，于是被注入的那条反思消息轮末**仍会**回调核心跳。
  // 修复前这里会一路 next（并再次注入），修复后必须恒为 wait。
  for (let i = 0; i < 10; i++) {
    const r = await loop.onTurnEnd({ outcome: sameDigest() })
    assert.equal(r.action, 'wait', '待审批期间不得再排下一轮')
    assert.equal(r.rationale, 'awaiting_approval')
  }
  assert.equal(loop.status().index, indexAtStall, '待审批期间不得推进轮次计数')
  assert.equal(loop.status().noProgress.streak, streakAtStall, '人工介入前的空转轮不得污染指纹连续数')
  assert.equal(injected.length, injectedAtStall, '反思消息只注入一次，不得每轮重复注入')
  assert.equal(loop.isActive(), true, '仍处于活动状态（等待 approve，不是被静默终结）')
})

test('approve 后恢复推进，且开启新的无进展计数窗口', async () => {
  const { loop } = makeLoop({ count: 10 })
  for (let i = 0; i < 3; i++) await loop.onTurnEnd({ outcome: sameDigest() })
  assert.equal(loop.status().status, 'awaiting_approval')

  loop.approve() // /loop approve 在 cli 侧即 resume()
  assert.equal(loop.status().status, 'running')
  assert.equal(loop.status().pendingApproval, null)
  assert.equal(loop.status().noProgress.streak, 0, 'approve 应重置计数窗口')

  const r = await loop.onTurnEnd({ outcome: sameDigest() })
  assert.equal(r.action, 'next', 'approve 后应能继续推进（而不是立刻再次升级停滞）')
  assert.equal(loop.status().status, 'running')
  assert.equal(loop.status().noProgress.streak, 1)
})

test('--done 未达成跑满次数上限即失败收尾（不得无限跑）', async () => {
  const { loop } = makeLoop({ count: 2 })
  const injected = []
  loop.engine.queueNext = (m) => injected.push(m)
  loop.__setVerifyForTest(async () => ({ passed: false, results: [], reason: '测试固定未通过' }))
  loop.start({ count: 2, prompt: '任意任务', doneWhen: [{ run: 'true' }] })
  let r = await loop.onTurnEnd({ outcome: { toolDigest: [{ name: 'Edit', path: 'b.txt' }] } })
  assert.equal(r.action, 'next')
  r = await loop.onTurnEnd({ outcome: { toolDigest: [{ name: 'Edit', path: 'c.txt' }] } })
  assert.equal(r.action, 'stop')
  assert.equal(r.rationale, 'failed')
  assert.equal(loop.status().status, 'done')
})

test('/loop 四端语法契约：TUI 与内核共用同一份解析（禁止再分叉）', () => {
  const tui = readFileSync(new URL('../kernel/tui.mjs', import.meta.url), 'utf-8')
  assert.match(tui, /import \{ parseLoopDirective \} from '\.\/loop-commands\.mjs'/, 'TUI 必须复用内核解析器')
  assert.doesNotMatch(tui, /let until = ''/, '旧 TUI 自带解析不得复活（会与内核语法互相吞）')
  assert.match(tui, /loop_result/, 'TUI 必须处理 loop 指令族回执帧')
  assert.match(tui, /case 'tool_result'/, 'TUI 必须处理工具结果帧（否则工具卡片详情恒为空）')

  // 指令族：曾经 `/loop status` 的 status 掉进 prompt 分支 → 静默真起 3 轮 loop
  for (const op of ['status', 'pause', 'resume', 'approve', 'stop', 'budget', 'inject', 'rollback', 'replay', 'memory']) {
    const d = parseLoopDirective(`/loop ${op}`)
    assert.ok(d, `/loop ${op} 应可解析`)
    assert.equal(d.kind, 'op', `/loop ${op} 必须识别为指令族`)
    assert.equal(d.op, op)
  }
  // GUI 旧语法与新增旗标（旧 TUI 解析全部不认）
  const every = parseLoopDirective('/loop 10m 巡检')
  assert.equal(every.kind, 'start')
  assert.equal(every.opts.everyMs, 600000)
  assert.equal(every.opts.prompt, '巡检')

  const rich = parseLoopDirective('/loop 5 --until 全部通过 --done "pytest -q" --goal 修复登录 --max-cost 1.5 --max-steps 40 --max-wall 30m 修 bug')
  assert.equal(rich.opts.count, 5)
  assert.equal(rich.opts.until, '全部通过')
  assert.equal(rich.opts.doneWhen.length, 1)
  assert.equal(rich.opts.doneWhen[0].run, 'pytest -q')
  assert.equal(rich.opts.goal, '修复登录')
  assert.equal(rich.opts.maxCostUsd, 1.5)
  assert.equal(rich.opts.maxSteps, 40)
  assert.equal(rich.opts.maxWallMs, 1800000)
  assert.equal(rich.opts.prompt, '修 bug')
})
