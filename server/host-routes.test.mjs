// server/host-routes.mjs 直测（P1 批次 1 新增 /health、/boot-status 后补）
// ---------------------------------------------------------------------------
// 为什么直测而不是只靠端到端：端到端能证明"通"，但证明不了**按引用传活状态**这一条——
// 而后者是本仓库拆分时踩过的坑：`bootState` / `diagInfo` 若被传成副本，代码不报错、
// 端到端也可能过（只是进度永远停在初始态），问题要到用户看见"启动卡在第一步"才暴露。
// 所以这里直接断言：**调用之后**对同一对象的改动，必须能被下一次请求读到。
//
// 运行：node --test server/host-routes.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleHostRoute, isHostPath } from './host-routes.mjs'

const call = (pathname, extra = {}) => handleHostRoute({
  method: 'GET', pathname, searchParams: new URLSearchParams(), body: null,
  sep: '/', diagInfo: {}, sessions: new Map(), bootState: {}, createTranscriptHandlers: () => ({}),
  ...extra,
})

test('isHostPath：认领 /health 与 /boot-status，不认领无关路径', () => {
  assert.equal(isHostPath('/health'), true)
  assert.equal(isHostPath('/boot-status'), true)
  assert.equal(isHostPath('/known-folders'), true)
  assert.equal(isHostPath('/transcript/list'), true)
  assert.equal(isHostPath('/api/usage'), false)
  assert.equal(isHostPath('/healthz'), false)   // 前缀不得误命中
})

test('/health：200 且给出存活状态与 pid', async () => {
  const r = await call('/health')
  assert.equal(r.status, 200)
  assert.equal(r.body.status, 'ok')
  assert.equal(r.body.pid, process.pid)
})

test('/boot-status：把 bootState 的内容摊平回包（ok 恒为 true）', async () => {
  const r = await call('/boot-status', { bootState: { kernel: true, skills: false } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true, kernel: true, skills: false })
})

test('活状态不变量：bootState 按**引用**传入 —— 事后的改动必须被后续请求读到', async () => {
  const bootState = { kernel: false }
  const first = await call('/boot-status', { bootState })
  assert.equal(first.body.kernel, false)

  // 模拟 boot 流程继续推进（桥持有同一个对象）
  bootState.kernel = true
  bootState.skills = true

  const second = await call('/boot-status', { bootState })
  assert.equal(second.body.kernel, true, '若把 bootState 复制成副本，这里会一直是 false（且不会报错）')
  assert.equal(second.body.skills, true)
})

test('未知路径返回 null（约定：null = 不由本模块负责）', async () => {
  assert.equal(await call('/api/usage'), null)
  assert.equal(await call('/nope'), null)
})
