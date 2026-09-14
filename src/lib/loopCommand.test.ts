// src/lib/loopCommand.test.ts
// node --test src/lib/loopCommand.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
// 断言面板组装出的指令文本形态。文本即契约：kernel/loop-commands.mjs 的 parseLoopDirective
// 按 `[次数] [--every v] [--until v] [--done v]... <任务>` 解析，故这里锁定该文本格式。
// （不在此文件 import 内核 .mjs：tsc 会因缺少 .mjs 类型声明报 TS7016。）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLoopCommand, validateLoopInput, quoteLoopValue, DURATION_RE } from './loopCommand.ts'

const build = (o: Partial<Parameters<typeof buildLoopCommand>[0]>) =>
  buildLoopCommand({ count: '3', interval: '5m', task: '修复登录', ...o })

test('次数为主 + 可选间隔：`/loop 3 --every 5m <任务>`', () => {
  assert.equal(build({}), '/loop 3 --every 5m 修复登录')
})

test('次数 + 无间隔 = 连续执行（不加 --every）', () => {
  assert.equal(build({ interval: '' }), '/loop 3 修复登录')
})

test('不限次数 + 间隔 = 持续运行', () => {
  assert.equal(build({ count: '', interval: '10m' }), '/loop --every 10m 修复登录')
})

test('--until / --done：带空格的值被引号包裹，多行 done 展开为重复 --done', () => {
  const cmd = build({ until: '全部测试通过', done: 'npm test\nnpm run build' })
  assert.equal(cmd, '/loop 3 --every 5m --until "全部测试通过" --done "npm test" --done "npm run build" 修复登录')
})

test('值内双引号归一为单引号（防破坏引号配对导致截断）', () => {
  assert.equal(quoteLoopValue('a "b" c'), '"a \'b\' c"')
})

test('参数顺序：次数在最前、任务在最后（内核位置解析依赖）', () => {
  const cmd = build({ until: 'x', done: 'npm test' })
  const i = (s: string) => cmd.indexOf(s)
  assert.ok(i('3') < i('--every'), '次数须在 --every 之前')
  assert.ok(i('--every') < i('--until'), '--every 在 --until 前')
  assert.ok(i('--until') < i('--done'), '--until 在 --done 前')
  assert.ok(i('--done') < cmd.indexOf('修复登录'), '任务文本须在末尾')
})

test('引号包裹的值内含空格时整体成对（`--until "a b"`，不被空格截断）', () => {
  const cmd = build({ until: '全部 测试 通过' })
  assert.ok(cmd.includes('--until "全部 测试 通过"'), cmd)
  assert.equal((cmd.match(/"/g) || []).length % 2, 0, '引号必须成对')
})

test('校验：纯数字次数、间隔格式、不限+无间隔', () => {
  assert.equal(validateLoopInput({ count: '3', interval: '5m', task: 'x' }), '')
  assert.equal(validateLoopInput({ count: '', interval: '10m', task: 'x' }), '')
  assert.match(validateLoopInput({ count: 'abc', interval: '5m', task: 'x' }), /正整数/)
  assert.match(validateLoopInput({ count: '0', interval: '5m', task: 'x' }), /不小于 1/)
  assert.match(validateLoopInput({ count: '3', interval: '5' , task: 'x' }), /间隔格式/)
  assert.match(validateLoopInput({ count: '', interval: '', task: 'x' }), /需选一个执行间隔/)
})

test('间隔格式与内核一致（覆盖 s/m/h/d 与小数值）', () => {
  for (const v of ['30s', '5m', '2h', '1d', '1.5h']) assert.ok(DURATION_RE.test(v), v)
  for (const v of ['5', 'm5', '5 m', '', '5mm']) assert.ok(!DURATION_RE.test(v), v)
})
