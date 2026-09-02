import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSessionHost } from './core.cjs'

/** fake kernel 子进程：捕获 stdin 写入、触发 stdout 行与 error 事件（core 在 spawn 后 proc.on 注册）。 */
function fakeKernel() {
  const k = { stdin: { write() {} }, stdout: null, killed: false, kill() { this.killed = true } }
  const evCbs = {}
  k.on = (ev, cb) => { (evCbs[ev] ||= []).push(cb) }
  k.stdin.write = s => { k.writes = k.writes || []; k.writes.push(JSON.parse(s)) }
  // readline 注入器返回对象：{ on(ev, cb) }，'line' 事件由测试手动触发
  const rlCbs = {}
  k.rl = { on(ev, cb) { rlCbs[ev] = cb } }
  k.emitLine = line => rlCbs['line']?.(line)
  k.emitError = () => (evCbs['error'] || []).forEach(cb => cb(new Error('boom')))
  k.emitExit = (code) => (evCbs['exit'] || []).forEach(cb => cb(code))
  return k
}

function makeHost(over = {}) {
  const spawned = []
  const readlineImpl = k => k.rl
  const host = createSessionHost({
    spawnImpl: (node, args, opts) => { const k = fakeKernel(); k.spawnArgs = { node, args }; spawned.push(k); return k },
    readlineImpl, kernelPath: '/k/cli.mjs', nodePath: 'node',
    args: ['--print', '--output-format', 'stream-json'],
    ...over,
  })
  return { host, spawned }
}

test('spawnKernel 用 node kernelPath+args；send 写 user 行', () => {
  const { host, spawned } = makeHost()
  host.spawnKernel()
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].spawnArgs.args[0], '/k/cli.mjs')
  const res = host.handleRequest('session.send', { text: '你好' })
  assert.equal(res.ok, true)
  assert.equal(res.sessionId, '', 'init 事件前 sessionId 为空串（由 init 回填）')
  assert.equal(spawned[0].writes[0].type, 'user')
  // user 行契约（bridge-contract §3 / bridge.mjs:2295）：{ type:'user', message:{role:'user',content} }
  assert.equal(spawned[0].writes[0].message.content, '你好')
})

test('kernel init/assistant/result 行更新会话状态并透传事件', () => {
  const { host, spawned } = makeHost()
  host.spawnKernel()
  const k = spawned[0]
  const events = []
  host.onEvent(ev => events.push(ev))
  k.emitLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-9', model: 'm' }))
  assert.equal(host.status().sessionId, 's-9')
  k.emitLine(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }))
  const st = host.status()
  assert.equal(st.busy, true)
  assert.ok(st.firstTokenAt)
  k.emitLine(JSON.stringify({ type: 'result', usage: {} }))
  assert.equal(host.status().busy, false)
  // init 事件本身也透传（chat 侧按 type 过滤）
  assert.equal(events.length, 3)
  assert.equal(events[0].type, 'system')
})

test('cancel 写 control_request；kernel 崩溃（error）500ms 后 respawn 并重置状态', async () => {
  const { host, spawned } = makeHost()
  host.spawnKernel()
  const k1 = spawned[0]
  k1.emitLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'old' }))
  assert.equal(host.status().sessionId, 'old')
  const res = host.handleRequest('session.cancel', {})
  assert.equal(res.ok, true)
  assert.equal(k1.writes[0].type, 'control_request')
  // kernel spawn 失败（'error' 事件）→ 500ms respawn（core 在 spawn 后经 proc.on 注册，fake.emitError 触发）
  k1.emitError()
  await new Promise(r => setTimeout(r, 650))
  assert.equal(spawned.length, 2, '500ms 后应 respawn 新 kernel')
  // 新 kernel 就绪后状态已重置（sessionId 待新 init 事件回填）
  assert.equal(host.status().sessionId, '', 'respawn 后 sessionId 重置')
  assert.equal(host.status().busy, false)
})

test('kernel 非零退出（真实崩溃形态：exit code≠0）→ 500ms respawn', async () => {
  const { host, spawned } = makeHost()
  host.spawnKernel()
  const k1 = spawned[0]
  k1.emitLine(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }))
  assert.equal(host.status().busy, true)
  k1.emitExit(1)   // 真实 node 子进程崩溃 = exit(code≠0)，不是 'error'
  await new Promise(r => setTimeout(r, 650))
  assert.equal(spawned.length, 2, '非零退出应触发 respawn')
  assert.equal(host.status().busy, false, 'respawn 后会话状态重置（busy/firstTokenAt 清空）')
})

test('kernel 优雅退出（exit 0）→ 不 respawn（会话自然收尾）', async () => {
  const { host, spawned } = makeHost()
  host.spawnKernel()
  spawned[0].emitExit(0)
  await new Promise(r => setTimeout(r, 650))
  assert.equal(spawned.length, 1, 'exit 0 不应触发 respawn')
})
