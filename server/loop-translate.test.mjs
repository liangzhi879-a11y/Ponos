// bridge /loop 转译：GUI 文本 → loop 载荷 / loop_command（零回归锁②）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { translateLoopSend } from './loop-translate.mjs'

test('GUI 旧语法 /loop 10m X → loop 载荷（everyMs 语义，非次数）', () => {
  const t = translateLoopSend('/loop 10m 检查磁盘')
  assert.equal(t.type, 'user')
  assert.equal(t.loop.everyMs, 600_000)
  assert.equal(t.loop.count, null)
  assert.equal(t.message.content, '检查磁盘')
})

test('次数式 → loop 载荷（count 语义）', () => {
  const t = translateLoopSend('/loop 3 优化函数')
  assert.equal(t.type, 'user')
  assert.equal(t.loop.count, 3)
  assert.equal(t.message.content, '优化函数')
})

test('完整参数 → loop 载荷字段齐备', () => {
  const t = translateLoopSend('/loop --goal G --done "pytest x" --max-cost 2 修 bug')
  assert.equal(t.loop.goal, 'G')
  assert.deepEqual(t.loop.doneWhen, [{ type: 'cmd', run: 'pytest x' }])
  assert.equal(t.loop.maxCostUsd, 2)
  assert.equal(t.message.content, '修 bug')
})

test('指令族 → loop_command', () => {
  assert.deepEqual(translateLoopSend('/loop status'), { type: 'loop_command', op: 'status', args: [] })
  assert.deepEqual(translateLoopSend('/loop stop 预算 不够'), { type: 'loop_command', op: 'stop', args: ['预算', '不够'] })
})

test('零回归锁②：普通文本 → null（原样直通，不吞输入）', () => {
  assert.equal(translateLoopSend('帮我修 bug'), null)
  assert.equal(translateLoopSend('/other x'), null)
  assert.equal(translateLoopSend(''), null)
  assert.equal(translateLoopSend('/loop'), null)
})
