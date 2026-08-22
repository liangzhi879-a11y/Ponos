// P8 插话链路 + 浏览器桥 正式测试（mock API，无网络）
// ---------------------------------------------------------------------------
// 覆盖：
//   - queueNext：吸收即发 command_lifecycle(uuid, started)；工具边界注入当前轮
//     （appendUser 落 transcript，请求面可见）
//   - 纯文本阶段残余：pendingNextCount / drainNextPending 兜底为新轮
//   - Browser 工具：registry 无 browserDriver 时报错；engine 链路发
//     bridge_request(browser) → resolveBrowser 回写 → 工具结果回填模型
//   - health env seed：YFW_HEALTH_COMPACT_COUNT 恢复压缩史（resume 血条）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from '../kernel/engine.mjs'
import { createSessionStore } from '../kernel/session.mjs'
import { makeWire } from '../kernel/protocol.mjs'
import { createToolRegistry } from '../kernel/tools.mjs'
import { createHealth } from '../kernel/health.mjs'

process.env.YFW_MOCK_API = '1'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeEnv() {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const dir = mkdtempSync(join(tmpdir(), 'yfw-interj-test-'))
  const configDir = join(dir, 'home')
  const store = createSessionStore({ configDir, cwd: dir, sessionId: 'main-session' })
  const engine = createEngine({
    opts: { model: 'mock-model', configDir, addDirs: [dir], skipPermissions: true },
    wire,
    session: store,
  })
  engine.setSystemPrompt('你是 YFW-turbo 测试内核。')
  return { events, engine, store, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('queueNext：吸收即发 command_lifecycle started；工具边界注入当前轮', async () => {
  const { events, engine, store, cleanup } = makeEnv()
  try {
    // 先入队插话（模拟 turnActive 中 cli 吸收 next 消息），再启动含工具调用的轮次
    engine.queueNext('【用户插话】补充：改用 B 方案', 'interj-uuid-1')
    const cmdLifecycle = events.find((e) => e.type === 'command_lifecycle' && e.data?.uuid === 'interj-uuid-1')
    assert.ok(cmdLifecycle, 'queueNext 应立即发 command_lifecycle')
    assert.equal(cmdLifecycle.data.state, 'started')

    const r = await engine.runTurn({ content: '[mock:tool-safe] 继续执行' })
    assert.equal(r.usage.input_tokens ?? 0, 10)
    // 插话已在第一次 API 调用前注入历史（appendUser 落 transcript）
    const msgs = store.deriveMessages()
    const injected = msgs.find((m) => m.role === 'user' && String(m.content).includes('改用 B 方案'))
    assert.ok(injected, '排队插话应在工具边界注入 transcript')
    // 轮次正常完成（mock 第二轮回显工具结果）
    assert.ok(events.some((e) => e.type === 'result'), '轮次应正常结束')
  } finally { cleanup() }
})

test('queueNext 无 uuid：不发 command_lifecycle（now 紧急插话不依赖气泡落位）', () => {
  const { events, engine, cleanup } = makeEnv()
  try {
    engine.queueNext('无 uuid 插话', undefined)
    assert.ok(!events.some((e) => e.type === 'command_lifecycle'))
    assert.equal(engine.pendingNextCount(), 1)
  } finally { cleanup() }
})

test('纯文本轮次同样注入：queueNext 在轮次开始前入队 → 首轮 API 前吸收', async () => {
  const { engine, store, cleanup } = makeEnv()
  try {
    engine.queueNext('普通插话', 'interj-uuid-2')
    await engine.runTurn({ content: '普通问题' })
    assert.equal(engine.pendingNextCount(), 0, '轮次开始时队列已清空（注入当前轮）')
    const injected = store.deriveMessages().find((m) => m.role === 'user' && String(m.content).includes('普通插话'))
    assert.ok(injected, '插话应注入 transcript')
  } finally { cleanup() }
})

test('残余兜底 API：未启动轮次时 pendingNext 保留，drain 取出供新轮处理', () => {
  const { engine, cleanup } = makeEnv()
  try {
    engine.queueNext('残余插话', 'interj-uuid-3')
    assert.equal(engine.pendingNextCount(), 1)
    const drained = engine.drainNextPending()
    assert.equal(drained.length, 1)
    assert.equal(drained[0].content, '残余插话')
    assert.equal(drained[0].uuid, 'interj-uuid-3')
    assert.equal(engine.pendingNextCount(), 0)
  } finally { cleanup() }
})

test('Browser 工具：无 browserDriver 时明确报错（执行器不可用）', async () => {
  const reg = createToolRegistry({ cwd: '/tmp', addDirs: ['/tmp'], skipPermissions: false })
  const r = await reg.run({ name: 'Browser', input: { action: 'goto', params: { url: 'https://example.com' } } }, {})
  assert.equal(r.isError, true)
  assert.match(r.content, /浏览器执行器不可用/)
})

test('Browser 引擎链路：bridge_request(browser) 挂起 → resolveBrowser 回写 → 结果回填', async () => {
  const { events, engine, cleanup } = makeEnv()
  try {
    const turn = engine.runTurn({ content: '[mock:browser] 打开页面' })
    // 等待 bridge_request(browser) 发出（挂起等待 browser_response）
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !events.some((e) => e.type === 'bridge_request' && e.route === 'browser')) {
      await sleep(10)
    }
    const br = events.find((e) => e.type === 'bridge_request' && e.route === 'browser')
    assert.ok(br, 'Browser 工具应发 bridge_request(browser)')
    assert.equal(br.payload.action, 'goto')
    assert.equal(br.payload.params.url, 'https://example.com')
    assert.ok(br.requestId)

    // 模拟 bridge 回写 browser_response（shape 对齐 browser-routing.mjs 回写）
    engine.resolveBrowser(br.requestId, { requestId: br.requestId, ok: true, snapshot: { url: 'https://example.com', title: 'Example', refs: [] } })
    await turn
    // 工具结果已回填模型（mock 第二轮回显"工具执行完成"），轮次正常结束
    assert.ok(events.some((e) => e.type === 'result'), '浏览器挂起解除后轮次应正常结束')
  } finally { cleanup() }
})

test('Browser 引擎链路：回写失败（ok:false）→ 工具结果 is_error 不卡死', async () => {
  const { events, engine, cleanup } = makeEnv()
  try {
    const turn = engine.runTurn({ content: '[mock:browser] 打开页面' })
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !events.some((e) => e.type === 'bridge_request' && e.route === 'browser')) {
      await sleep(10)
    }
    const br = events.find((e) => e.type === 'bridge_request' && e.route === 'browser')
    engine.resolveBrowser(br.requestId, { requestId: br.requestId, ok: false, error: '页面导航失败：ERR_NAME_NOT_RESOLVED' })
    await turn
    assert.ok(events.some((e) => e.type === 'result'))
  } finally { cleanup() }
})

test('health env seed：YFW_HEALTH_COMPACT_COUNT 恢复压缩史（resume 血条不丢）', () => {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const h = createHealth({ wire, model: 'mock', env: { YFW_HEALTH_COMPACT_COUNT: '3' } })
  assert.equal(h.getState().compactCount, 3)
  assert.equal(h.getState().tier, 'green') // 初始不发事件；首轮 record 后档位变化才 emit
  h.record({ usage: {}, durationMs: 1, model: 'mock', ts: new Date().toISOString(), compactCount: 3 })
  const healthEvt = events.find((e) => e.type === 'yfw_health')
  assert.ok(healthEvt, '压缩史恢复后档位非绿应发 yfw_health')
  assert.equal(healthEvt.compactCount, 3)
  // 未设置 env → 0
  const h2 = createHealth({ wire, model: 'mock', env: {} })
  assert.equal(h2.getState().compactCount, 0)
})
