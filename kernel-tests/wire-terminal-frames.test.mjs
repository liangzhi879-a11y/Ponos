// 终端两帧的 wire 形状（Task 3）：tool_output_delta / file_change。
// 边界：只钉帧形状（字段名、类型、默认值）——不发 transcript、不碰 fs，也不断言 bridge/GUI 侧消费。
// 注意：本帧的 seq 是 **wire 帧序号**（由发送方决定），与合帧器内部的 seq 不是同一个概念。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { makeWire } from '../kernel/protocol.mjs'

test('toolOutputDelta / fileChange 的帧形状', () => {
  const s = new PassThrough()
  let out = ''
  s.on('data', (d) => { out += d.toString() })
  const wire = makeWire(s)
  wire.toolOutputDelta({ toolUseId: 't1', seq: 3, stdout: 'hi', truncated: true })
  wire.fileChange({ toolUseId: 't1', tool: 'Edit', op: 'modify', path: 'a.ts', additions: 2, deletions: 1 })
  const frames = out.trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(frames[0].type, 'tool_output_delta')
  assert.equal(frames[0].tool_use_id, 't1')
  assert.equal(frames[0].seq, 3)
  assert.equal(frames[0].stdout, 'hi')
  assert.equal(frames[0].truncated, true)
  assert.equal(frames[1].type, 'file_change')
  assert.equal(frames[1].tool, 'Edit')
  assert.equal(frames[1].additions, 2)
  assert.equal(frames[1].deletions, 1)
  assert.equal(typeof frames[1].ts, 'string')
})
