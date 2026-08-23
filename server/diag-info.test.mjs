import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// PONOS_BRIDGE_NO_LISTEN 必须在 import bridge.mjs 之前设置：模块求值（1983 行附近）
// 会据此跳过顶层 listen，避免端口冲突。测试自行 listen(0) 起随机端口。
process.env.PONOS_BRIDGE_NO_LISTEN = '1'
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
// 会话中触发，本测试环境无会话，故为全零初值）。O3-1 扩展后新增字段独立断言
// （transcriptMB 依赖真实目录大小，不做精确 deepEqual）。
test('GET /diag/info 返回初始零值结构', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/diag/info`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(
    {
      firstTokenOk: body.data.firstTokenOk,
      firstTokenTotal: body.data.firstTokenTotal,
      kernelCrashCount: body.data.kernelCrashCount,
      lastApiSuccessAt: body.data.lastApiSuccessAt,
    },
    { firstTokenOk: 0, firstTokenTotal: 0, kernelCrashCount: 0, lastApiSuccessAt: null }
  )
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

test('O3-1 /diag/info 补全：configSummary 脱敏 + skillsLockVersion + transcriptMB', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/diag/info`)
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.ok('configSummary' in body.data, 'diag 应含 configSummary')
  // 脱敏：任何键值不含明文 sk-
  const joined = JSON.stringify(body.data.configSummary)
  assert.ok(!/sk-[A-Za-z0-9]{8,}/.test(joined), 'configSummary 不得含明文密钥')
  assert.ok('skillsLockVersion' in body.data)
  assert.ok('transcriptMB' in body.data)
  assert.ok(Number.isFinite(body.data.transcriptMB))
})

test('O3-2 /diag/export：环境脱敏 + transcript 摘要 + 无明文密钥', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/diag/export`)
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.ok(body.ok)
  assert.ok('env' in body.exported)
  assert.ok(!/sk-[A-Za-z0-9]{8,}/.test(JSON.stringify(body.exported.env)))
  assert.ok('sessions' in body.exported)
  assert.ok('transcriptMB' in body.exported)
})
