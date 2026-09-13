// Task 1.7：驱动判定与 web 探测
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { detectDriver, probeWeb, checkApp, SURFACE_ORDER } = require('../electron/app-profiler.cjs')

test('web 目标 → browser 驱动', async () => {
  const r = await detectDriver({ target: { type: 'web', url: 'https://example.com' } })
  assert.equal(r.driver, 'browser')
})

test('desktop 目标 → 由三级探测结果决定', async () => {
  const r = await detectDriver({ target: { type: 'desktop', exePath: 'C:/nope/aseprite.exe' }, probe: async () => ({ level: 'uia' }) })
  assert.equal(r.driver, 'uia')
})

test('desktop 且探测到自带 CLI → process（优先）', async () => {
  const r = await detectDriver({ target: { type: 'desktop', exePath: 'C:/x/a.exe' }, probe: async () => ({ level: 'process' }) })
  assert.equal(r.driver, 'process')
})

test('desktop 且探测到脚本接口 → script（次优先）', async () => {
  const r = await detectDriver({ target: { type: 'desktop', exePath: 'C:/x/a.exe' }, probe: async () => ({ level: 'script' }) })
  assert.equal(r.driver, 'script')
})

test('未知 target.type → 抛错（不静默兜底）', async () => {
  await assert.rejects(() => detectDriver({ target: { type: 'weird' } }))
})

test('探测返回未知 level → 收敛为 uia（fail-safe）', async () => {
  const r = await detectDriver({ target: { type: 'desktop', exePath: 'C:/x/a.exe' }, probe: async () => ({ level: 'magic' }) })
  assert.equal(r.driver, 'uia')
})

test('降级链顺序固定为 process → script → uia', () => {
  assert.deepEqual(SURFACE_ORDER, ['process', 'script', 'uia'])
})

test('probeWeb：goto + snapshot 两步，返回 title 与快照', async () => {
  const calls = []
  const executor = { exec: async (_s, act, params) => { calls.push([act, params]); return { ok: true, snapshot: { title: 'T', url: 'https://e.com' } } } }
  const r = await probeWeb({ url: 'https://e.com', executor, sessionId: 'probe' })
  assert.deepEqual(calls.map((c) => c[0]), ['goto', 'snapshot'])
  assert.equal(calls[0][1].url, 'https://e.com')
  assert.equal(r.title, 'T')
})

test('probeWeb：导航失败即抛（不静默返回空快照）', async () => {
  const executor = { exec: async () => ({ ok: false, error: '被拦截' }) }
  await assert.rejects(() => probeWeb({ url: 'https://e.com', executor, sessionId: 'probe' }), /被拦截/)
})

test('probeWeb：缺少执行器 → 明确抛错', async () => {
  await assert.rejects(() => probeWeb({ url: 'https://e.com', executor: null, sessionId: 'p' }), /browserExecutor/)
})

test('checkApp：web 合法 / 非法 URL / 无命令', async () => {
  assert.equal((await checkApp({ spec: { target: { type: 'web', url: 'https://a.com' }, commands: [{ action: 'x' }] } })).status, 'healthy')
  assert.equal((await checkApp({ spec: { target: { type: 'web', url: 'file:///c:/x' }, commands: [{ action: 'x' }] } })).status, 'broken')
  assert.equal((await checkApp({ spec: { target: { type: 'web', url: 'https://a.com' }, commands: [] } })).status, 'broken')
})

test('checkApp：desktop 目标不存在 → broken；driver 与类型矛盾 → drifted', async () => {
  const missing = await checkApp({ spec: { target: { type: 'desktop', exePath: 'C:/definitely/not/here.exe' }, commands: [{ action: 'x' }] } })
  assert.equal(missing.status, 'broken')
  const drift = await checkApp({ spec: { driver: 'browser', target: { type: 'desktop', exePath: process.execPath }, commands: [{ action: 'x' }] } })
  assert.equal(drift.status, 'drifted')
})

test('checkApp：Spec 缺失 → broken（不崩）', async () => {
  assert.equal((await checkApp({})).status, 'broken')
  assert.equal((await checkApp({ spec: null })).status, 'broken')
})
