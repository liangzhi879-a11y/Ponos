import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentBridge } from './agent-bridge.cjs'

function fakeChild() {
  const c = {
    stdin: { write: () => {}, end: () => {} },
    stdout: {},
    kill: () => { c.killed = true },
    killed: false,
    on: () => {},
    pid: 42,
  }
  return c
}

test('send 写入 user 事件、cancel 写入 control_request', () => {
  const writes = []
  const c = fakeChild()
  c.stdin.write = s => writes.push(JSON.parse(s))
  const bridge = createAgentBridge({ kernelPath: 'x', spawnImpl: () => c, readlineImpl: () => ({ on() {} }) })
  bridge.start()
  bridge.send('你好')
  bridge.cancel()
  assert.equal(writes[0].type, 'user')
  assert.equal(writes[0].data.text, '你好')
  assert.equal(writes[1].type, 'control_request')
  assert.equal(writes[1].request.subtype, 'cancel')
})
