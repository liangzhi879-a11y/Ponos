// server/workflow-host.test.mjs —— 常驻宿主会话单测（假 kernel 会话替身，不 spawn 真进程）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createWorkflowHost, mergeCapabilities, HOST_SID } from './workflow-host.mjs'

// 假 kernel：stdin 记命令、stdout 侧把回执投给宿主（真实链路由 bridge 调 host.onKernelMessage）。
// brief 原稿的 fake 把回执投回自己的 setReply 钩子（无人调用 host.onKernelMessage）→ 必超时；
// 这里补 attach(host) 这一行，模拟 bridge 的 stdout → 宿主 投递，其余形态保持一致。
function fakeKernel() {
  const written = []
  let handler = () => {}
  let target = null
  const session = { proc: { stdin: { write: (line) => { written.push(JSON.parse(line)); handler(JSON.parse(line)) } }, killed: false } }
  const sessions = new Map([['_wfhost', session]])
  return {
    written,
    sessions,
    attach: (h) => { target = h },
    reply: (obj) => (target ? target.onKernelMessage(obj) : handler(obj)),
    setReply: (fn) => { handler = fn },
    getOrCreateSession: () => session,
  }
}

// 真实内核回执形态：wire.system(子命令名, {...}) → { type:'system', subtype:<子命令>, requestId, ... }
const mkHost = (k, extra = {}) => {
  const h = createWorkflowHost({
    sessions: k.sessions, getOrCreateSession: k.getOrCreateSession, yfwHome: '/tmp/x', model: 'm', onEvent: () => {}, ...extra,
  })
  k.attach(h)
  return h
}

test('ensure：懒启动宿主会话并复用', () => {
  const k = fakeKernel()
  const host = createWorkflowHost({ sessions: k.sessions, getOrCreateSession: k.getOrCreateSession, yfwHome: '/tmp/x', model: 'm', onEvent: () => {} })
  const sid1 = host.ensure()
  const sid2 = host.ensure()
  assert.equal(sid1, '_wfhost')
  assert.equal(sid2, '_wfhost')
})

test('send：按 requestId 配对 workflow_result 回执（含超时）', async () => {
  const k = fakeKernel()
  k.setReply((msg) => {
    // 只答 list：'never' 需保持无回执才能验超时（brief 原稿 fake 无投递路径，故该断言恒成立；
    // 补上投递后须显式不答）
    if (msg.type === 'workflow_command' && msg.subtype === 'list') {
      k.reply({ type: 'system', subtype: 'workflow_result', requestId: msg.requestId, result: { ok: true, subtype: msg.subtype } })
    }
  })
  const host = createWorkflowHost({ sessions: k.sessions, getOrCreateSession: k.getOrCreateSession, yfwHome: '/tmp/x', model: 'm', onEvent: () => {} })
  k.attach(host)
  host.ensure()
  const r = await host.send({ subtype: 'list' })
  assert.equal(r.ok, true)
  assert.equal(r.subtype, 'list')
  await assert.rejects(() => host.send({ subtype: 'never' }, { timeoutMs: 50 }), /超时/)
})

test('run：grant 注入 + 能力清单保守合并（取并集，不放大）', async () => {
  const k = fakeKernel()
  k.setReply((msg) => {
    if (msg.type === 'workflow_command' && msg.subtype === 'run') {
      k.reply({ type: 'system', subtype: 'workflow_result', requestId: msg.requestId, result: { ok: true, status: 'completed', steps: 3, runId: msg.payload.runId } })
    }
  })
  const host = createWorkflowHost({ sessions: k.sessions, getOrCreateSession: k.getOrCreateSession, yfwHome: '/tmp/x', model: 'm', onEvent: () => {} })
  k.attach(host)
  host.ensure()
  const r = await host.run({ id: 'demo', inputs: { q: 1 }, capabilities: { tools: ['Read'], write_dirs: [], network: false } })
  assert.equal(r.ok, true)
  const sent = k.written.find((m) => m.subtype === 'run')
  assert.ok(sent.payload.grant, 'grant 应随命令注入')
  assert.deepEqual(sent.payload.grant.tools, ['Read'])

  const m = mergeCapabilities({ tools: ['Read', 'WebFetch'], write_dirs: ['/a'], network: true }, { tools: ['Read', 'Write'], write_dirs: ['/a', '/b'], network: false })
  assert.deepEqual([...m.tools].sort(), ['Read', 'WebFetch', 'Write'], '应为并集（前端勾选项 ∪ 声明项）')
  assert.equal(m.network, true)
})

test('stop / confirm 转发到内核命令', async () => {
  const k = fakeKernel()
  k.setReply((msg) => {
    if (msg.type === 'workflow_command') k.reply({ type: 'system', subtype: 'workflow_result', requestId: msg.requestId, result: { ok: true } })
  })
  const host = createWorkflowHost({ sessions: k.sessions, getOrCreateSession: k.getOrCreateSession, yfwHome: '/tmp/x', model: 'm', onEvent: () => {} })
  k.attach(host)
  host.ensure()
  await host.stop('run-1')
  await host.confirm({ runId: 'run-1', node: 'gate', action: 'approved' })
  assert.ok(k.written.some((m) => m.type === 'workflow_command' && m.subtype === 'stop' && m.payload.runId === 'run-1'))
  assert.ok(k.written.some((m) => m.type === 'workflow_confirm' && m.payload.node === 'gate'))
})

test('grant 生命周期：运行结束即失效', async () => {
  const k = fakeKernel()
  k.setReply((msg) => {
    if (msg.type === 'workflow_command') k.reply({ type: 'system', subtype: 'workflow_result', requestId: msg.requestId, result: { ok: true, status: 'completed' } })
  })
  const host = createWorkflowHost({ sessions: k.sessions, getOrCreateSession: k.getOrCreateSession, yfwHome: '/tmp/x', model: 'm', onEvent: () => {} })
  k.attach(host)
  host.ensure()
  await host.run({ id: 'demo', inputs: {}, capabilities: { tools: ['Bash'] } })
  const runId = [...host._grants.keys()][0]
  assert.equal(runId, undefined, '运行结束应回收全部 grant')
})

// ============ 补测（brief 未覆盖） ============

test('ensure：无会话时按宿主参数懒启动（cwd=<yfwHome>/workflow-runtime、mode=task）', () => {
  const calls = []
  const sessions = new Map()
  const hi = fakeKernel()
  const getOrCreateSession = (sid, cwd, resumeId, sysPrompt, model, compact, mode) => {
    calls.push({ sid, cwd, resumeId, sysPrompt, model, compact, mode })
    sessions.set(sid, hi.sessions.get('_wfhost'))
  }
  const host = createWorkflowHost({ sessions, getOrCreateSession, yfwHome: '/tmp/x', model: 'm', onEvent: () => {} })
  assert.equal(host.ensure(), HOST_SID)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].sid, HOST_SID)
  assert.equal(calls[0].cwd, join('/tmp/x', 'workflow-runtime'))
  assert.equal(calls[0].mode, 'task')
  host.ensure()
  assert.equal(calls.length, 1, '已存在则不再 spawn')
})

test('onKernelMessage：真实回执形态（subtype=子命令、结果平铺）也能配对解包', async () => {
  const k = fakeKernel()
  k.setReply((msg) => {
    if (msg.subtype === 'list') k.reply({ type: 'system', subtype: 'list', requestId: msg.requestId, workflows: [{ id: 'demo' }] })
    else if (msg.subtype === 'load') k.reply({ type: 'system', subtype: 'load', requestId: msg.requestId, result: { ok: true, id: 'demo', yml: 'name: demo', validation: { ok: true, errors: [] } } })
  })
  const host = mkHost(k)
  const list = await host.send({ subtype: 'list' })
  assert.deepEqual(list.workflows, [{ id: 'demo' }], '平铺回执应去掉 type/subtype/requestId 后解包')
  const l = await host.load('demo')
  assert.equal(l.ok, true)
  assert.equal(l.yml, 'name: demo')
  assert.equal(l.validation.ok, true)
  assert.equal(host.onKernelMessage({ type: 'assistant' }), false, '非 system 消息不认领')
  assert.equal(host.onKernelMessage({ type: 'system', subtype: 'init' }), false, '无关 system 消息不认领')
})

test('save：发 save-raw（payload 只带 id/yaml），当前内核返回无 requestId 的未知子命令错误', async () => {
  const k = fakeKernel()
  k.setReply((msg) => {
    if (msg.subtype === 'save-raw') k.reply({ type: 'system', subtype: 'error', error: '未知 /wf 子命令: save-raw' })
  })
  const host = mkHost(k)
  await assert.rejects(() => host.save({ id: 'demo', yaml: 'name: demo\n' }), /未知 \/wf 子命令: save-raw/)
  const sent = k.written.find((m) => m.subtype === 'save-raw')
  assert.equal(sent.payload.id, 'demo')
  assert.equal(sent.payload.yaml, 'name: demo\n')
  assert.equal(Object.keys(sent.payload).length, 2, 'save 不得在宿主侧落盘/附带额外字段')
})

test('run：payload 带宿主 cwd（grant 相对路径判定基）+ grant 在运行期间有效', async () => {
  const k = fakeKernel()
  let during = null
  k.setReply((msg) => {
    if (msg.subtype !== 'run') return
    during = { granted: host.isGranted(msg.payload.runId, 'Read'), ungranted: host.isGranted(msg.payload.runId, 'Bash'), holds: host._grants.has(msg.payload.runId) }
    k.reply({ type: 'system', subtype: 'workflow_result', requestId: msg.requestId, result: { ok: false, status: 'failed', error: 'x' } })
  })
  const host = mkHost(k)
  const r = await host.run({ id: 'demo', capabilities: { tools: ['Read'] }, runId: 'run-fixed' })
  const sent = k.written.find((m) => m.subtype === 'run')
  assert.equal(sent.payload.cwd, join('/tmp/x', 'workflow-runtime'))
  assert.equal(sent.payload.runId, 'run-fixed')
  assert.deepEqual(during, { granted: true, ungranted: false, holds: true })
  assert.equal(r.runId, 'run-fixed')
  assert.equal(host._grants.size, 0, '运行结束（含失败）也要回收 grant')
})

test('workflow 事件转发给 onEvent（GUI 广播），非 workflow 类 system 消息不外发', () => {
  const k = fakeKernel()
  const seen = []
  const host = mkHost(k, { onEvent: (m) => seen.push(m) })
  host.onKernelMessage({ type: 'system', subtype: 'workflow', runId: 'r1', event: 'step_end' })
  host.onKernelMessage({ type: 'system', subtype: 'auto_triggered', workflow: 'demo' })
  host.onKernelMessage({ type: 'system', subtype: 'init' })
  assert.deepEqual(seen.map((m) => m.subtype), ['workflow', 'auto_triggered'])
})

test('I-1 回归：无 requestId 的 error 只结清队头，不得误杀在途的 run', async () => {
  const k = fakeKernel()
  const host = mkHost(k)
  // run 长跑不答；随后一条无关命令报 error（无 requestId）
  const pendingRun = host.run({ id: 'demo', capabilities: { tools: ['Read'] }, runId: 'run-long' })
  const other = host.send({ subtype: 'save-raw', payload: { id: 'x', yaml: 'name: x' } }).catch((e) => e.message)
  await new Promise((r) => setTimeout(r, 5))
  // 无关 error 到达：应只 reject save-raw（队头之外的 run 必须仍在等）
  host.onKernelMessage({ type: 'system', subtype: 'error', error: 'unknown subtype' })
  const otherMsg = await other
  assert.match(String(otherMsg), /unknown subtype|宿主命令失败/)
  assert.equal(host._grants.has('run-long'), true, 'run 的 grant 不得被无关 error 连带回收')
  // run 随后正常回执 → 仍能成功收敛
  const sent = k.written.find((m) => m.subtype === 'run')
  k.reply({ type: 'system', subtype: 'run', requestId: sent.requestId, ok: true, status: 'completed', runId: 'run-long' })
  const r = await pendingRun
  assert.equal(r.ok, true)
  assert.equal(r.runId, 'run-long')
})

test('I-2 回归：内核回执的 runId 被保留（stop/confirm 打得到真实运行）', async () => {
  const k = fakeKernel()
  const host = mkHost(k)
  k.setReply((msg) => {
    if (msg.subtype === 'run') {
      // 内核以宿主传入的 runId 为准（cli.mjs 已转发）；此处模拟内核回执带回该 id
      k.reply({ type: 'system', subtype: 'run', requestId: msg.requestId, ok: true, status: 'completed', runId: msg.payload.runId })
    }
    if (msg.subtype === 'stop') {
      k.reply({ type: 'system', subtype: 'stop', requestId: msg.requestId, ok: true })
    }
  })
  const r = await host.run({ id: 'demo', capabilities: { tools: ['Read'] }, runId: 'run-real' })
  assert.equal(r.runId, 'run-real', '宿主返回的 runId 必须与内核回执一致（否则 stop 打空）')
  await host.stop(r.runId)
  const stopMsg = k.written.find((m) => m.subtype === 'stop')
  assert.equal(stopMsg.payload.runId, 'run-real', 'stop 必须带真实 runId')
})

test('M-2：run 接受 grant 别名（GUI 侧叫法），不静默退化为空权限', async () => {
  const k = fakeKernel()
  const host = mkHost(k)
  k.setReply((msg) => { if (msg.subtype === 'run') k.reply({ type: 'system', subtype: 'run', requestId: msg.requestId, ok: true, runId: msg.payload.runId }) })
  await host.run({ id: 'demo', grant: { tools: ['Bash'], network: true } })
  const sent = k.written.find((m) => m.subtype === 'run')
  assert.deepEqual(sent.payload.grant.tools, ['Bash'])
  assert.equal(sent.payload.grant.network, true)
})

test('M-1：mergeCapabilities 非数组入参不得按字符展开', () => {
  const m = mergeCapabilities({ tools: 'Read' }, { tools: ['Write'] })
  assert.deepEqual(m.tools, ['Write'], `字符串不得被拆成字符：${JSON.stringify(m.tools)}`)
})
