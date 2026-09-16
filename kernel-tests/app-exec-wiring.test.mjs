// 应用即工具（Task 4.x）跨层接线测试：bridge 路由 + 主进程执行器
// ---------------------------------------------------------------------------
// 上一支测试（app-tools-mount.test.mjs）钉死内核侧（cli/engine）；本支钉死另外两层：
//   ① server/app-routing.mjs：内核 bridge_request(route=app) → executor.send('app:exec')；
//      executor 响应 → 内核 stdin 的 control_request(app_response)；executor 未连接 /
//      投递失败 → 立即结构化失败回执（不留"永不结清"的挂起）；非 app 路由不接管。
//   ② electron/app-ipc.cjs 的 handleAppExecMessage（main.cjs 的 app:exec 分支唯一实现体）：
//      与 app:run IPC 同一份执行逻辑（runAppCommand）与同一份留痕，回执形状
//      { ok, data, error, kind, durationMs } + requestId。
// 不依赖 Electron / 网络：executor 是假对象，数据根是临时目录。
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { makeAppRouter } from '../server/app-routing.mjs'

const require = createRequire(import.meta.url)
const home = mkdtempSync(join(tmpdir(), 'appexec-'))
process.env.YFWORKING_HOME = home
delete process.env.PONOS_CONFIG_DIR

const { runAppCommand, handleAppExecMessage } = require('../electron/app-ipc.cjs')
const appRegistry = require('../electron/app-registry.cjs')

const roots = () => [join(home, 'apps')]

function seedSpec({ appId = 'demo', driver = 'browser', spec } = {}) {
  appRegistry.upsertApp({ roots: roots(), app: { id: appId, name: appId, targetType: driver === 'browser' ? 'web' : 'desktop', enabled: true } })
  appRegistry.writeSpec({
    roots: roots(), appId,
    spec: spec || {
      specVersion: 1, appId, name: '演示站', driver, target: { type: 'web', url: 'https://example.com' },
      expose: { mode: 'console' },
      commands: [{ action: 'query', title: '查单', kind: 'read', params: [{ name: 'orderId', required: true }], steps: [{ act: 'goto', url: '/o/${orderId}' }, { act: 'snapshot', save: 'result' }] }],
    },
  })
}

const fakeExecutor = (calls) => ({
  exec: async (_s, act, params) => { calls.push([act, params]); return { ok: true, snapshot: { title: '示例站', text: 'body' } } },
})

process.on('exit', () => { try { rmSync(home, { recursive: true, force: true }) } catch { /* 尽力清理 */ } })

// ── ① bridge 路由 ──────────────────────────────────────────────────────────
test('bridge 路由：内核 bridge_request(route=app) → executor/app:exec；响应 → 内核 stdin app_response', () => {
  const written = []
  const sent = []
  const router = makeAppRouter({ writeKernel: (sid, msg) => written.push([sid, msg]) })
  router.registerExecutor({ send: (s) => sent.push(JSON.parse(s)) })
  // 非 app 路由不得被本路由接管（browser 走自己的模块）
  router.onKernelBridgeRequest('s1', { requestId: 'br-1', route: 'browser', payload: { action: 'goto' } })
  assert.equal(sent.length, 0)
  assert.equal(written.length, 0)

  router.onKernelBridgeRequest('s1', { requestId: 'ap-1', route: 'app', payload: { appId: 'demo', action: 'query', args: { orderId: 'A1' }, sessionId: 's1' } })
  assert.deepEqual(sent[0], {
    type: 'app:exec', requestId: 'ap-1', sessionId: 's1',
    payload: { appId: 'demo', action: 'query', args: { orderId: 'A1' }, sessionId: 's1' },
  })

  router.onExecutorResponse('ap-1', { ok: true, data: { status: 'paid' }, error: null, kind: 'read', durationMs: 7 })
  assert.equal(written.length, 1)
  const [sid, msg] = written[0]
  assert.equal(sid, 's1')
  assert.equal(msg.type, 'control_request')
  assert.deepEqual(msg.request, { subtype: 'app_response', requestId: 'ap-1', ok: true, data: { status: 'paid' }, error: null, kind: 'read', durationMs: 7 })

  // 已结清的请求再回执 = no-op（不得重复回写内核）
  router.onExecutorResponse('ap-1', { ok: false, error: 'late' })
  assert.equal(written.length, 1)
})

test('bridge 路由：executor 未连接 / 投递失败 → 立即失败回执（不留永不结清的挂起）', () => {
  const written = []
  const router = makeAppRouter({ writeKernel: (sid, msg) => written.push([sid, msg]) })
  router.onKernelBridgeRequest('s1', { requestId: 'ap-x', route: 'app', payload: {} })
  assert.equal(written.length, 1)
  assert.equal(written[0][1].request.subtype, 'app_response')
  assert.equal(written[0][1].request.ok, false)
  assert.match(String(written[0][1].request.error), /executor 未连接/)

  const router2 = makeAppRouter({ writeKernel: (sid, msg) => written.push([sid, msg]) })
  router2.registerExecutor({ send: () => { throw new Error('socket closed') } })
  router2.onKernelBridgeRequest('s1', { requestId: 'ap-y', route: 'app', payload: {} })
  assert.equal(written.length, 2)
  assert.equal(written[1][1].request.requestId, 'ap-y')
  assert.equal(written[1][1].request.ok, false)
  assert.match(String(written[1][1].request.error), /socket closed/)
})

// ── ② 主进程执行器（main.cjs 的 app:exec 唯一实现体）────────────────────────
test('handleAppExecMessage：browser 驱动执行 + 留痕 + 回执形状 = app:run 回执', async () => {
  seedSpec({ appId: 'demo' })
  const calls = []
  const sent = []
  await handleAppExecMessage(
    { requestId: 'ap-2', payload: { appId: 'demo', action: 'query', args: { orderId: 'A1' }, sessionId: 's1' } },
    { getExecutor: () => fakeExecutor(calls), send: (o) => sent.push(o) },
  )
  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'app:exec:response')
  assert.equal(sent[0].requestId, 'ap-2')
  assert.equal(sent[0].ok, true)
  assert.equal(sent[0].kind, 'read')
  assert.equal(typeof sent[0].durationMs, 'number')
  assert.equal(sent[0].data, 'body', 'snapshot 步骤的 save 结果回传（与 app:run IPC 同口径）')
  assert.deepEqual(calls.map((c) => c[0]), ['goto', 'snapshot'])
  assert.ok(existsSync(join(home, 'apps', 'demo', 'history')), '执行必须留痕（失败也写，此处成功）')
  assert.ok(readdirSync(join(home, 'apps', 'demo', 'history')).length >= 1)
})

test('handleAppExecMessage：失败也回结构化回执（Spec 不存在 / 缺必填参数），且不抛', async () => {
  const sent = []
  await handleAppExecMessage(
    { requestId: 'ap-3', payload: { appId: 'nope', action: 'query', args: {} } },
    { getExecutor: () => fakeExecutor([]), send: (o) => sent.push(o) },
  )
  assert.equal(sent[0].ok, false)
  assert.match(String(sent[0].error), /Spec 不存在/)
  assert.equal(sent[0].kind, 'unknown')
  assert.equal(sent[0].requestId, 'ap-3')

  const calls = []
  await handleAppExecMessage(
    { requestId: 'ap-4', payload: { appId: 'demo', action: 'query', args: {} } },
    { getExecutor: () => fakeExecutor(calls), send: (o) => sent.push(o) },
  )
  assert.equal(sent[1].ok, false)
  assert.match(String(sent[1].error), /orderId|必填/)
  assert.equal(calls.length, 0, '缺必填参数不得真的发起浏览器动作')
})

test('handleAppExecMessage：发送通道失败（WS 已断）不抛、不伪造成功', async () => {
  const res = await handleAppExecMessage(
    { requestId: 'ap-5', payload: { appId: 'demo', action: 'query', args: { orderId: 'A1' } } },
    { getExecutor: () => fakeExecutor([]), send: () => { throw new Error('ws closed') } },
  )
  assert.equal(res, undefined, 'send 抛错必须被吞掉（内核侧有超时兜底），不得冒到主进程')
})

// ── ③ 与 IPC 通道同源（同一函数、同一留痕口径）──────────────────────────────
test('runAppCommand 是 IPC 与内核桥共用实现（desktop/process 驱动同样留痕）', async () => {
  seedSpec({
    appId: 'cli-app', driver: 'process',
    spec: {
      specVersion: 1, appId: 'cli-app', name: 'CLI', driver: 'process',
      target: { type: 'desktop', exePath: process.execPath },
      expose: { mode: 'console' },
      commands: [{ action: 'ver', title: '版本', kind: 'read', params: [], steps: [{ act: 'cli', argv: ['--version'], save: 'out' }] }],
    },
  })
  const r = await runAppCommand({ appId: 'cli-app', action: 'ver', args: {}, sessionId: 's1', getExecutor: () => null, roots: roots() })
  assert.equal(r.ok, true)
  assert.match(String(r.data), /v\d/, '应回传真实 node 版本（进程真的被拉起）')
  assert.ok(existsSync(join(home, 'apps', 'cli-app', 'history')), 'desktop 路径同样留痕')

  const bad = await runAppCommand({ appId: 'cli-app', action: '不存在', args: {}, getExecutor: () => null, roots: roots() })
  assert.equal(bad.ok, false)
  assert.equal(bad.kind, 'unknown')
})
