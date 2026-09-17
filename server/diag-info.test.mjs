import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { TEST_BRIDGE_TOKEN, withToken } from './test-bridge-auth.mjs'
import { allRouteSource } from './test-route-sources.mjs'

// YFW_BRIDGE_NO_LISTEN 必须在 import bridge.mjs 之前设置：模块求值（1983 行附近）
// 会据此跳过顶层 listen，避免端口冲突。测试自行 listen(0) 起随机端口。
// YFW_BRIDGE_TOKEN 同理必须在这之前设置（D2 起桥在模块求值时解析令牌，顺序错了
// 桥会自生成令牌并落盘，本测试的无 Origin 请求就会 401）。
process.env.YFW_BRIDGE_NO_LISTEN = '1'
process.env.YFW_BRIDGE_TOKEN = TEST_BRIDGE_TOKEN
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
// 会话中触发，本测试环境无会话，故计数类为全零初值）。
test('GET /diag/info 返回初始零值结构', async () => {
  const res = await fetch(withToken(`http://127.0.0.1:${port}/diag/info`))
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  const d = body.data
  // loopDriftMs/loopDriftMaxMs = K0.2 事件循环漂移探针（2026-09-13 系统性优化）：
  // 它们是**实时测量**而非计数器——探针按周期采样，机器一有负载（同机并发跑别的
  // 测试/内核）首帧就可能非零（2026-09-14 实测 83ms）。此前断言"恰为 0"，在忙机器上
  // 必红：一个偶然的假红会把真正的回归埋掉。这里改为断言**字段集 + 下界**。
  assert.deepEqual(Object.keys(d).sort(), [
    'firstTokenOk', 'firstTokenTotal', 'kernelCrashCount', 'lastApiSuccessAt', 'loopDriftMaxMs', 'loopDriftMs',
  ])
  assert.equal(d.firstTokenOk, 0)
  assert.equal(d.firstTokenTotal, 0)
  assert.equal(d.kernelCrashCount, 0)
  assert.equal(d.lastApiSuccessAt, null)
  assert.ok(Number.isFinite(d.loopDriftMs) && d.loopDriftMs >= 0, `loopDriftMs 应为非负数，实际 ${d.loopDriftMs}`)
  assert.ok(Number.isFinite(d.loopDriftMaxMs) && d.loopDriftMaxMs >= 0, `loopDriftMaxMs 应为非负数，实际 ${d.loopDriftMaxMs}`)
})

// 结构断言：diagInfo 各埋点触发点只在真实内核会话生命周期中出现（首 token /
// usage result / 内核 close），无法在单测中触发，此处断言源码存在以保证埋点落地。
//
// 扫描范围是**全部路由模块**（bridge.mjs + server/*-routes.mjs），不是单读 bridge.mjs：
// P1 的拆分正把端点陆续搬出 bridge（/diag/info 去了 host-routes、用量埋点去了 readonly-routes），
// 而本断言的意图是"这段埋点存在"，与它落在哪个文件无关。扫全量后，后续继续搬家也不会误伤；
// 反过来若某段埋点被**整个删掉**，拼起来的源码里同样找不到，断言照样失败。
const src = allRouteSource()

test('路由模块含 /diag/info 端点与崩溃埋点', () => {
  assert.match(src, /\/diag\/info/)
  assert.match(src, /diagInfo\.kernelCrashCount/)
})

test('路由模块含首 token 与 usage 埋点', () => {
  assert.match(src, /diagInfo\.firstTokenTotal/)
  assert.match(src, /diagInfo\.firstTokenOk/)
  assert.match(src, /diagInfo\.lastApiSuccessAt/)
})

// K0.2/K0.3 埋点落地（2026-09-13 系统性优化）：漂移探针与只读端点耗时日志都只在
// 真实阻塞/真实轮询中出现，单测触发不到，故断言源码存在（与上面两条同策略）。
test('路由模块含事件循环漂移探针与只读端点耗时日志', () => {
  assert.match(src, /diagInfo\.loopDriftMaxMs/)
  assert.match(src, /\[bridge\]\[readonly\]/)
})
