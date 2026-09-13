import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// YFW_BRIDGE_NO_LISTEN 必须在 import bridge.mjs 之前设置：模块求值（1983 行附近）
// 会据此跳过顶层 listen，避免端口冲突。测试自行 listen(0) 起随机端口。
process.env.YFW_BRIDGE_NO_LISTEN = '1'
const { httpServer } = await import('./bridge.mjs')

let port = 0
let server = null

before(async () => {
  await new Promise((resolve) => {
    server = httpServer.listen(0, '127.0.0.1', resolve)
  })
  port = server.address().port
  assert.ok(port > 0, 'random port should be allocated')
})

after(() => {
  return new Promise((resolve) => {
    if (server) server.close(resolve)
    else resolve()
  })
})

// 行为测试：真实 HTTP 请求 /diag/info，断言初始零值结构（埋点只在真实内核
// 会话中触发，本测试环境无会话，故为全零初值）。
test('GET /diag/info 返回初始零值结构', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/diag/info`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(body, {
    ok: true,
    // loopDriftMs/loopDriftMaxMs = K0.2 事件循环漂移探针初值（2026-09-13 系统性优化）：
    // 契约纯增量，老 GUI 忽略；这里断言初值形态（无阻塞行为 0）。
    data: {
      firstTokenOk: 0, firstTokenTotal: 0, kernelCrashCount: 0, lastApiSuccessAt: null,
      loopDriftMs: 0, loopDriftMaxMs: 0,
    },
  })
})

// 结构断言：diagInfo 各埋点触发点只在真实内核会话生命周期中出现（首 token /
// usage result / 内核 close），无法在单测中触发，此处断言源码存在以保证埋点落地。
const src = readFileSync(new URL('./bridge.mjs', import.meta.url), 'utf-8')

test('bridge.mjs 含 /diag/info 端点与崩溃埋点', () => {
  assert.match(src, /\/diag\/info/)
  assert.match(src, /diagInfo\.kernelCrashCount/)
})

test('bridge.mjs 含首 token 与 usage 埋点', () => {
  assert.match(src, /diagInfo\.firstTokenTotal/)
  assert.match(src, /diagInfo\.firstTokenOk/)
  assert.match(src, /diagInfo\.lastApiSuccessAt/)
})

// K0.2/K0.3 埋点落地（2026-09-13 系统性优化）：漂移探针与只读端点耗时日志都只在
// 真实阻塞/真实轮询中出现，单测触发不到，故断言源码存在（与上面两条同策略）。
test('bridge.mjs 含事件循环漂移探针与只读端点耗时日志', () => {
  assert.match(src, /diagInfo\.loopDriftMaxMs/)
  assert.match(src, /\[bridge\]\[readonly\]/)
})
