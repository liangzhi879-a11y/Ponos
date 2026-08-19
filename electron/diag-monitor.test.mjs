import test from 'node:test'
import assert from 'node:assert/strict'
import { createDiagMonitor, CHECKS } from './diag-monitor.cjs'

function mkCtx(overrides = {}) {
  return {
    appPaths: { kernel: '/x/cli.mjs', bun: '/x/bun.exe', python: '/x/python.exe' },
    executorStatus: async () => ({ connected: true, windows: 1 }),
    petAlive: () => true,
    gpuCrashCount: () => 0,
    renderCrashCount: () => 0,
    bridgeRestartCount: () => 0,
    ...overrides,
  }
}

test('CHECKS 注册表：25 项、id 唯一、分组合法', () => {
  assert.equal(CHECKS.length, 25)
  const ids = new Set(CHECKS.map(c => c.id))
  assert.equal(ids.size, 25)
  for (const c of CHECKS) assert.match(c.id, /^[a-z][a-z0-9-]*$/)
})

test('状态聚合：任一 error → overall=error', async () => {
  const ctx = mkCtx({ gpuCrashCount: () => 1 })  // 不算 error，但用一个必错的项验证
  // 用 fs 缺失路径制造 kernel-files error
  const mon = createDiagMonitor({ ctx: { ...ctx, appPaths: { kernel: '/nonexistent/cli.mjs', bun: '/nonexistent/bun.exe', python: '/x/python.exe' } } })
  const snap = await mon.runAll()
  assert.equal(snap.overall, 'error')
  const kf = snap.checks.find(c => c.id === 'kernel-files')
  assert.equal(kf.status, 'error')
})

test('内核自检：返回 stdout/exitCode 结构', async () => {
  const ctx = mkCtx()
  const mon = createDiagMonitor({ ctx })
  const r = await mon.runKernelCheck()
  assert.ok('ok' in r && 'stdout' in r && 'stderr' in r && 'exitCode' in r && 'latencyMs' in r)
})

test('exportReport：不传 logTee 也能出报告（缺省空日志尾）', async () => {
  const mon = createDiagMonitor({ ctx: mkCtx() })
  const r = await mon.exportReport()
  assert.ok(typeof r.text === 'string')
  assert.match(r.text, /YFWorking diagnostic report/)
  assert.match(r.text, /--- log tail/)
})

test('onEvent 推送语义：overall 未变不推送，首次必推', async () => {
  const mon = createDiagMonitor({ ctx: mkCtx() })
  let calls = 0
  mon.setOnChange(() => { calls++ })
  try {
    // start 的初始 runAll：prev=null → 必推一次
    await mon.start({ intervalMs: 999999 })
    assert.equal(calls, 1, '首次快照（prev=null）应推送一次')
    // gpuCrashCount 恒 0 → gpu-health 不变 → overall 恒 error → 不应再推
    const snap0 = mon.getSnapshot()
    const gpuBefore = snap0.checks.find(c => c.id === 'gpu-health').lastCheckedAt
    const renderBefore = snap0.checks.find(c => c.id === 'render-health').lastCheckedAt
    await new Promise(r => setTimeout(r, 10))  // 拉开毫秒级时间窗，保证 lastCheckedAt 可严格递增
    await mon.onEvent('gpu-crash')
    const snap = mon.getSnapshot()
    const gpu = snap.checks.find(c => c.id === 'gpu-health')
    const render = snap.checks.find(c => c.id === 'render-health')
    assert.ok(gpu.lastCheckedAt > gpuBefore, 'gpu-health 应被事件驱动组级重测（lastCheckedAt 更新）')
    assert.equal(render.lastCheckedAt, renderBefore, '非目标项 render-health 不应被重跑（未全量刷新）')
    assert.equal(calls, 1, 'overall 未变时事件驱动不应重复推送')
  } finally {
    mon.stop()
  }
})

test('超时路径：永不 resolve 的注入点 → error + timeout（~3s）', async () => {
  const mon = createDiagMonitor({ ctx: mkCtx({ executorStatus: () => new Promise(() => {}) }) })
  const t0 = Date.now()
  const res = await mon.rerun('executor-connected')
  const elapsed = Date.now() - t0
  assert.equal(res.status, 'error')
  assert.match(res.detail, /timeout/)
  assert.ok(elapsed >= 2500, `应在 ~3s 超时返回，实际 ${elapsed}ms`)
})
