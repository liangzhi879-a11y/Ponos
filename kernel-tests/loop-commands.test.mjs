// loop 指令解析（纯函数）：语法矩阵 + GUI 旧语法兼容 + 零回归锁①。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDuration, parseLoopDirective, LOOP_OPS, formatLoopStatus, formatLoopReplay } from '../kernel/loop-commands.mjs'

test('parseDuration：支持的四种单位与非法输入', () => {
  assert.equal(parseDuration('10m'), 600_000)
  assert.equal(parseDuration('30s'), 30_000)
  assert.equal(parseDuration('2h'), 7_200_000)
  assert.equal(parseDuration('1d'), 86_400_000)
  assert.equal(parseDuration('abc'), null)
  assert.equal(parseDuration('10x'), null)
  assert.equal(parseDuration(''), null)
})

test('零回归锁①：既有 TUI 语法解析结果不变', () => {
  const a = parseLoopDirective('/loop 3 优化这个函数')
  assert.equal(a.kind, 'start')
  assert.equal(a.opts.count, 3)
  assert.equal(a.opts.prompt, '优化这个函数')
  assert.equal(a.opts.until, '')
  assert.equal(a.opts.fresh, false)
  assert.equal(a.opts.everyMs, 0)

  const b = parseLoopDirective('/loop 5 --until 测试全部通过 修复 bug')
  assert.equal(b.opts.count, 5)
  assert.equal(b.opts.until, '测试全部通过')
  assert.equal(b.opts.prompt, '修复 bug')

  const c = parseLoopDirective('/loop 3 --fresh 重新实现')
  assert.equal(c.opts.fresh, true)
  assert.equal(c.opts.count, 3)
  assert.equal(c.opts.prompt, '重新实现')
})

test('GUI 旧语法兼容：首个 token 为时长 → --every 语义（非次数）', () => {
  const d = parseLoopDirective('/loop 10m 检查磁盘')
  assert.equal(d.kind, 'start')
  assert.equal(d.opts.everyMs, 600_000)
  assert.equal(d.opts.count, null, '持续运行（无限轮）')
  assert.equal(d.opts.prompt, '检查磁盘')
})

test('新增参数：--done 可重复 / --goal / --max-cost / --max-steps / --max-wall', () => {
  const d = parseLoopDirective('/loop --goal 修复登录 --done "pytest tests/test_login.py" --done "ruff check ." --max-cost 2.0 --max-steps 30 --max-wall 1h 请修复 bug')
  assert.equal(d.kind, 'start')
  assert.equal(d.opts.goal, '修复登录')
  assert.deepEqual(d.opts.doneWhen, [
    { type: 'cmd', run: 'pytest tests/test_login.py' },
    { type: 'cmd', run: 'ruff check .' },
  ])
  assert.equal(d.opts.maxCostUsd, 2.0)
  assert.equal(d.opts.maxSteps, 30)
  assert.equal(d.opts.maxWallMs, 3_600_000)
  assert.equal(d.opts.prompt, '请修复 bug')
})

test('指令族：11 个 op 全部可解析', () => {
  assert.deepEqual(LOOP_OPS, ['start', 'status', 'pause', 'resume', 'stop', 'budget', 'approve', 'inject', 'rollback', 'replay', 'memory'])
  assert.deepEqual(parseLoopDirective('/loop status'), { kind: 'op', op: 'status', args: [] })
  assert.deepEqual(parseLoopDirective('/loop pause'), { kind: 'op', op: 'pause', args: [] })
  // 注：计划文档原文为 '/loop stop 预算不够'（无分隔空格）却期望两个 arg，与 tokenize 契约矛盾；
  // 此处补一个空格以表达原意（args 按空白切分），实现保持逐字不变。
  assert.deepEqual(parseLoopDirective('/loop stop 预算 不够'), { kind: 'op', op: 'stop', args: ['预算', '不够'] })
  assert.deepEqual(parseLoopDirective('/loop replay --last 5'), { kind: 'op', op: 'replay', args: ['--last', '5'] })
  assert.equal(parseLoopDirective('/loop inject 改用 v2 接口').op, 'inject')
  assert.equal(parseLoopDirective('/loop budget --max-cost 1.5').op, 'budget')
})

test('非 /loop 文本与不可解析输入 → null（零回归锁②：交调用方直通）', () => {
  assert.equal(parseLoopDirective('帮我修复登录 bug'), null)
  assert.equal(parseLoopDirective('/other 3 x'), null)
  assert.equal(parseLoopDirective(''), null)
  assert.equal(parseLoopDirective('/loop'), null)
})

test('formatLoopStatus / formatLoopReplay：文本回执含关键字段', () => {
  const s = formatLoopStatus({
    status: 'running', goal: '修复登录', index: 2, count: 5, steps: 12,
    costUsd: 0.4321, budget: { maxCostUsd: 2 }, noProgress: { streak: 1, threshold: 3 },
    history: [{ index: 1, ts: '2026-09-14T10:00:00Z', costUsd: 0.2, steps: 5, filesChanged: 2, verify: { passed: false } }],
  })
  assert.match(s, /running/)
  assert.match(s, /修复登录/)
  assert.match(s, /2\/5/)
  assert.match(s, /0\.4321/)
  const r = formatLoopReplay([{ index: 1, ts: '2026-09-14T10:00:00Z', costUsd: 0.2, steps: 5, filesChanged: 2, verify: { passed: true }, judged: false, note: 'ok' }], 5)
  assert.match(r, /#1/)
  assert.match(r, /0\.20/)
  assert.match(r, /通过/)
})
