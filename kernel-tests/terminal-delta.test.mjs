// runShell 的终端增量通道（Task 2）：onChunk 收到输出、全量落盘，**tool_result 语义不变**。
// 边界：只测「增量回调 + 日志」这一层；超时 / 截断提示 / 后台 Bash 的既有语义另有用例
//   （kernel-tests/bash-timeout.test.mjs 等），本文件不改也不重复断言它们。
// 后 2 条钉"旁路不得反噬主路"：onChunk 抛错不影响结果、toolUseId 不可造成写入逃逸。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createToolRegistry } from '../kernel/tools.mjs'
import { readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('onChunk 收到输出，tool_result 内容不受影响，日志落盘', async () => {
  const dir = tmpdir()
  const chunks = []
  const reg = createToolRegistry({ cwd: dir, runDir: dir })
  const r = await reg.run(
    { name: 'Bash', input: { command: 'echo hello' } },
    { toolUseId: 't1', onToolOutput: (f) => chunks.push(f) },
  )
  assert.equal(r.isError, false)
  assert.match(String(r.content), /hello/)
  assert.ok(chunks.some((f) => `${f.stdout}${f.stderr}`.includes('hello')))
  assert.match(readFileSync(join(dir, 't1.log'), 'utf8'), /hello/)
})

test('没有 onToolOutput 时行为与改动前一致（不抛错）', async () => {
  const dir = tmpdir()
  const reg = createToolRegistry({ cwd: dir })
  const r = await reg.run({ name: 'Bash', input: { command: 'echo plain' } }, { toolUseId: 't2' })
  assert.equal(r.isError, false)
  assert.match(String(r.content), /plain/)
})

test('onChunk 抛错时命令仍成功返回（旁路异常不影响结果）', async () => {
  const dir = tmpdir()
  const reg = createToolRegistry({ cwd: dir })
  const r = await reg.run(
    { name: 'Bash', input: { command: 'echo boom' } },
    { toolUseId: 't3', onToolOutput: () => { throw new Error('wire broken') } },
  )
  assert.equal(r.isError, false)
  assert.match(String(r.content), /boom/)
})

test('toolUseId 含路径分隔符时不落盘（防逃逸）', async () => {
  const dir = tmpdir()
  const reg = createToolRegistry({ cwd: dir, runDir: dir })
  const r = await reg.run(
    { name: 'Bash', input: { command: 'echo safe' } },
    { toolUseId: '../../evil', onToolOutput: () => {} },
  )
  assert.equal(r.isError, false)
  assert.equal(existsSync(join(dir, '..', '..', 'evil.log')), false)
})
