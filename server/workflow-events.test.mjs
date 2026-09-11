// server/workflow-events.test.mjs —— 内核消息分类纯函数单测（UI Task 14b / 审查 I-3）
// 运行：node --test server/workflow-events.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapKernelMessage } from './workflow-events.mjs'

test('workflow 事件（subtype=workflow，type 被 ev.type 覆盖）→ workflow_event', () => {
  // 内核实际形态：wire.system('workflow', ev) → {type:'system', subtype:'workflow', ...ev}
  const nodeEv = { type: 'node', subtype: 'workflow', runId: 'r1', node: 'n1', status: 'done' }
  const m = mapKernelMessage(nodeEv)
  assert.equal(m.kind, 'workflow_event')
  assert.equal(m.payload, nodeEv, '应原样透传（不复制）')
  // 无 ev.type 的退化形态（外层 type 仍是 system）同样按事件直转，不误判成宿主回执
  assert.equal(mapKernelMessage({ type: 'system', subtype: 'workflow', runId: 'r1' }).kind, 'workflow_event')
})

test('宿主系统回执（无 subtype=workflow）→ workflow_result', () => {
  const reply = { type: 'system', subtype: 'load', requestId: 'wf-1', result: { ok: true, id: 'demo' } }
  const m = mapKernelMessage(reply)
  assert.equal(m.kind, 'workflow_result')
  assert.equal(m.payload, reply)
  // 无 requestId 的 error 回执（宿主 LIFO 结清）同属宿主通道
  assert.equal(mapKernelMessage({ type: 'system', subtype: 'error', error: 'boom' }).kind, 'workflow_result')
})

test('无关消息 → null（不吞普通会话事件）', () => {
  for (const msg of [
    { type: 'assistant', message: { content: [] } },
    { type: 'result', usage: { output_tokens: 1 } },
    { type: 'bridge_request', route: 'browser' },
    null, undefined, 'raw-line', 42,
  ]) {
    const m = mapKernelMessage(msg)
    assert.equal(m.kind, null, `不应分类: ${JSON.stringify(msg)}`)
    assert.equal(m.payload, null)
  }
  // 注意：{type:'system', subtype:'init'} 属宿主通道（宿主自按 requestId/FORWARD_SUBTYPES 过滤）
  assert.equal(mapKernelMessage({ type: 'system', subtype: 'init' }).kind, 'workflow_result')
})
