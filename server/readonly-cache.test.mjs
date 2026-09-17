// server/readonly-cache.test.mjs —— K2.2 桥侧只读缓存契约（2026-09-13「任务运行慢」系统性优化 Task 9）
// ---------------------------------------------------------------------------
// 要修的**不是**"缓存没命中"，而是**每 5s 轮询都全量重算**：真机一次全量聚合 10.8–19.6s，乘数
// 是 transcript 的**文件数**（同 57MB：240 文件 731ms vs 4800 文件 3271ms），而驾驶舱每 5s
// 拉一次（src/components/cockpit/useCockpitOverview.ts）。故本文件的核心用例是直接度量那两个
// 病灶：①「过期时**立即**回旧值，不阻塞等重算」②「冷启动不把请求挂到天荒地老」。
// 只断言"返回值是合法 JSON"的话，退化成"永远重算"或"永远超时"都全绿，等于空跑。
//
// 另有两处是**这套异步设计自己引入的责任**（不是白拿的），各有独立用例：
//   - 后台刷新的 rejection **绝不可外泄**：未处理的 rejection 会掀掉整个桥——比单次返回错值严重
//     得多（故用例里挂了进程级 unhandledRejection 监听器，而不是只断言返回值）。
//   - 失败**不可伪装成 computing**：否则 502 会退化成含糊的"计算中"，诊断永久不可用。
//
// **假时钟用法的硬约束**：`waitFor` 的 deadline 由注入的 `now()` 推进，故凡是「注定等不到值」的
// 冷启动用例（fetch 失败 / 永不 resolve）**必须用真时钟**（并把 firstWaitMs 调小），否则 deadline
// 永不满足 ⇒ 用例永久挂起（这一点本身就是被测行为：用真时钟的用例负责证明它不会悬挂）。
// 注入假时钟的用例都先让 key 落值，走 fresh/stale 分支，不经过 `waitFor`。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReadonlyCache, DEFAULT_FIRST_WAIT_MS } from './readonly-cache.mjs'
import { allRouteSource, routeModuleFiles } from './test-route-sources.mjs'

const SERVER_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(SERVER_DIR, '..')

/** 可控假时钟（只在 fresh/stale 分支使用，见文件头约束） */
function fakeClock(start = 1_700_000_000_000) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

test('TTL 内命中即回缓存（零重算）', async () => {
  const clock = fakeClock()
  let n = 0
  const c = createReadonlyCache({ ttlMs: 10_000, firstWaitMs: 300, now: clock.now })
  const fetchFn = async () => { n++; return `payload-${n}` }

  const first = await c.get('k', fetchFn)
  assert.equal(first.state, 'fresh')
  assert.equal(first.payload, 'payload-1')

  clock.advance(9_000) // 仍在 TTL 内
  const b = await c.get('k', fetchFn)
  const d = await c.get('k', fetchFn)
  assert.deepEqual([b.state, d.state], ['fresh', 'fresh'])
  assert.equal(d.payload, 'payload-1')
  assert.equal(n, 1, 'TTL 内不得重算——这正是"5s 轮询不再等于 5s 一次全量扫"的兑现处')
})

test('过期 → 立即回旧值（stale）+ 后台刷新；落值后转 fresh', async () => {
  const clock = fakeClock()
  let n = 0
  const c = createReadonlyCache({ ttlMs: 10_000, firstWaitMs: 300, now: clock.now })
  const slow = () => new Promise((r) => setTimeout(() => { n++; r(`payload-${n}`) }, 200))

  const first = await c.get('k', slow) // 冷启动等一次（≤ firstWaitMs），200ms 内落值
  assert.equal(first.state, 'fresh')
  assert.equal(first.payload, 'payload-1')

  clock.advance(11_000) // 越过 TTL
  const t0 = Date.now()
  const stale = await c.get('k', slow)
  const waited = Date.now() - t0
  assert.equal(stale.state, 'stale')
  assert.equal(stale.payload, 'payload-1', '必须立刻回**旧值**')
  assert.ok(waited < 100, `stale 分支不得等重算（实测 ${waited}ms）——等 200ms 就是每次轮询都撞 GUI 的 5s 超时`)
  assert.equal(n, 1, '此刻新一轮还在飞（尚未落值）')

  await sleep(260) // 后台刷新落地
  assert.equal(n, 2, '后台刷新必须真的跑起来（只回旧值不刷新 = 永远陈旧）')
  const fresh = await c.get('k', slow)
  assert.equal(fresh.state, 'fresh')
  assert.equal(fresh.payload, 'payload-2')
  assert.equal(n, 2, '转 fresh 后不再算')
})

test('冷启动超过 firstWaitMs 即回 computing，但刷新**继续在后台跑完**（自愈）', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  let n = 0
  // 真时钟（见文件头约束：冷启动会走 waitFor）
  const c = createReadonlyCache({ ttlMs: 10_000, firstWaitMs: 120 })
  const fetchFn = async () => { n++; await gate; return 'slow-payload' }

  const t0 = Date.now()
  const first = await c.get('k', fetchFn)
  const waited = Date.now() - t0
  assert.equal(first.state, 'computing')
  assert.equal(first.payload, null)
  assert.ok(waited >= 100, `至少要等满 firstWaitMs（实测 ${waited}ms）`)
  assert.ok(waited < 900, `不得超过 firstWaitMs 太多（实测 ${waited}ms）——真机一次 10.8–19.6s，等满等于回到超时`)
  assert.equal(n, 1, '刷新必须留在后台继续，而不是被超时取消')

  const second = await c.get('k', fetchFn)
  assert.equal(second.state, 'computing', '值仍未落 → 仍 computing')
  assert.equal(n, 1, '在飞的刷新不得被重复起（否则每次轮询都多 spawn 一个内核进程）')

  release()
  await sleep(60)
  const third = await c.get('k', fetchFn)
  assert.equal(third.state, 'fresh', '自愈：下一次轮询就该有值')
  assert.equal(third.payload, 'slow-payload')
  assert.equal(n, 1, '第三次应命中缓存')
})

test('冷启动在 firstWaitMs 内落值 → 直接 fresh（不等满）', async () => {
  let n = 0
  const c = createReadonlyCache({ ttlMs: 10_000, firstWaitMs: 800 })
  const fetchFn = async () => { n++; return 'fast' }
  const t0 = Date.now()
  const got = await c.get('k', fetchFn)
  const waited = Date.now() - t0
  assert.equal(got.state, 'fresh')
  assert.equal(got.payload, 'fast')
  assert.equal(n, 1)
  assert.ok(waited < 400, `落值即返回，不该等满 firstWaitMs（实测 ${waited}ms）`)
})

test('冷启动失败 → failed 且带**真实错误**（不降级成含糊的 computing）', async () => {
  const c = createReadonlyCache({ ttlMs: 10_000, firstWaitMs: 150, onWarn: () => {} })
  const boom = async () => { throw new Error('内核路径找不到 (YFWORKING_KERNEL)') }
  const got = await c.get('k', boom) // 必须 resolve，不得 reject
  assert.equal(got.state, 'failed')
  assert.match(got.error.message, /内核路径找不到/, '真实错误必须透出去——否则 502 变成"计算中"，用户永远查不出原因')
})

test('后台刷新失败：不外泄 rejection，本次请求照常回旧值，onWarn 收到', async () => {
  const warns = []
  const rejections = []
  const onRejection = (e) => rejections.push(e)
  process.on('unhandledRejection', onRejection)
  try {
    const clock = fakeClock()
    let n = 0
    const c = createReadonlyCache({ ttlMs: 10_000, firstWaitMs: 300, now: clock.now, onWarn: (e) => warns.push(e) })
    await c.get('k', async () => { n++; return 'old' })

    clock.advance(11_000)
    const bad = async () => { n++; throw new Error('刷新时内核挂了') }
    const got = await c.get('k', bad)
    assert.equal(got.state, 'stale')
    assert.equal(got.payload, 'old', '刷新失败不该连累本次响应')

    await sleep(60)
    await new Promise((r) => setImmediate(r))
    assert.equal(warns.length, 1, 'onWarn 必须收到（否则桥侧完全静默）')
    assert.equal(rejections.length, 0, '未处理的 rejection 会掀掉整个桥，绝不能出现')
    assert.equal(n, 2, '失败的那次确实跑过')
  } finally {
    process.off('unhandledRejection', onRejection)
  }
})

test('并发冷启动只重算一次（5 个调用者共享同一次刷新）', async () => {
  let n = 0
  const c = createReadonlyCache({ ttlMs: 10_000, firstWaitMs: 400 })
  const fetchFn = () => new Promise((r) => setTimeout(() => { n++; r(`p${n}`) }, 60))
  const got = await Promise.all(Array.from({ length: 5 }, () => c.get('k', fetchFn)))
  assert.equal(n, 1, '并发冷启动必须单飞')
  assert.deepEqual(got.map((g) => g.state), Array(5).fill('fresh'))
  assert.deepEqual(got.map((g) => g.payload), Array(5).fill('p1'))
})

test('并发过期也只重算一次（5 个轮询同时到期）', async () => {
  const clock = fakeClock()
  let n = 0
  const c = createReadonlyCache({ ttlMs: 10_000, firstWaitMs: 300, now: clock.now })
  const fetchFn = () => new Promise((r) => setTimeout(() => { n++; r(`p${n}`) }, 50))
  await c.get('k', fetchFn) // 冷启动落值
  assert.equal(n, 1)

  clock.advance(11_000)
  const got = await Promise.all(Array.from({ length: 5 }, () => c.get('k', fetchFn)))
  assert.deepEqual(got.map((g) => g.state), Array(5).fill('stale'))
  assert.equal(n, 1, '此刻在飞的那次尚未落地')
  await sleep(140)
  assert.equal(n, 2, '5 个并发过期只允许起一次刷新（否则就是 5 倍内核进程）')
})

test('刷新成功后清除历史失败（旧错误不许粘住未来的请求）', async () => {
  let mode = 'fail'
  const c = createReadonlyCache({ ttlMs: 10_000, firstWaitMs: 150 })
  const fetchFn = async () => {
    if (mode === 'fail') throw new Error('第一次失败')
    return 'ok'
  }
  const got1 = await c.get('k', fetchFn)
  assert.equal(got1.state, 'failed')
  assert.equal(c.stats().errors, 1)

  mode = 'ok'
  const got2 = await c.get('k', fetchFn)
  assert.equal(got2.state, 'fresh')
  assert.equal(got2.payload, 'ok')
  assert.equal(c.stats().errors, 0, '成功后必须清除——否则未来某次冷启动超时会**报出早已过期的旧错误**')
})

test('不同 key 互不干扰：一个 key 失败不污染另一个', async () => {
  const c = createReadonlyCache({ ttlMs: 10_000, firstWaitMs: 150 })
  const boom = async () => { throw new Error('audit 挂了') }
  const ok = async () => 'B-payload'
  const a = await c.get('audit|', boom)
  const b = await c.get('usage|--scope today', ok)
  assert.equal(a.state, 'failed')
  assert.equal(b.state, 'fresh')
  assert.equal(b.payload, 'B-payload')
  const again = await c.get('usage|--scope today', ok)
  assert.equal(again.state, 'fresh')
  assert.equal(again.payload, 'B-payload')
})

test('真时钟下冷启动是**上界**：fetch 永不落地也在 ~firstWaitMs 返回（不悬挂）', async () => {
  const c = createReadonlyCache({ ttlMs: 10_000, firstWaitMs: 150 })
  const hang = () => new Promise(() => {}) // 永不 resolve
  const t0 = Date.now()
  const got = await c.get('k', hang)
  const waited = Date.now() - t0
  assert.equal(got.state, 'computing')
  assert.ok(waited < 900, `必须封顶（实测 ${waited}ms）——路由永久悬挂比超时更糟，比同步版还差`)
})

test('跨模块不变量：默认 firstWaitMs 必须 < GUI 的 5s 超时', () => {
  const src = readFileSync(join(REPO_ROOT, 'src/lib/usageApi.ts'), 'utf8')
  const m = src.match(/FETCH_TIMEOUT_MS\s*=\s*(\d+)/)
  assert.ok(m, 'usageApi.ts 里找不到 FETCH_TIMEOUT_MS —— 护栏失效，请同步更新本用例')
  const guiMs = Number(m[1])
  assert.ok(
    DEFAULT_FIRST_WAIT_MS < guiMs,
    `默认 firstWaitMs=${DEFAULT_FIRST_WAIT_MS}ms 必须**严格小于** GUI 超时 ${guiMs}ms：等到了也没人接 = 白等`,
  )
})

test('结构护栏：/api/usage 路由必须走缓存（不得退回直调内核或同步 spawn）', () => {
  // 扫描**路由模块集合**而非单读 bridge.mjs：P1 批次 2 已把 /api/usage 连同它的缓存单例
  // 一起搬到 server/readonly-routes.mjs。本护栏的意图是"这条链经缓存、且不退回同步"，
  // 与文件归属无关；扫全量后，后续继续搬家不会再误伤它。
  const files = routeModuleFiles()
  const src = allRouteSource()
  const owner = files.find((f) => readFileSync(join(SERVER_DIR, f), 'utf8').includes("'/api/usage'"))
  assert.ok(owner, '路由模块里找不到 /api/usage 路由 —— 护栏失效，请同步更新本用例')
  const ownerSrc = readFileSync(join(SERVER_DIR, owner), 'utf8')
  // 取数形态带可注入的 cache（测试口子）：`(cache || getReadonlyCache()).get(...)`。
  // 断言意图不变——**必须经过缓存这层**，只是允许注入口存在。
  assert.match(ownerSrc, /getReadonlyCache\(\)\)\.get\(/, '路由必须经缓存取数')
  assert.match(ownerSrc, /'computing'/, '必须处理冷启动未就绪态')
  assert.match(ownerSrc, /'failed'/, '必须处理失败态（不得把它并进 computing）')
  assert.doesNotMatch(ownerSrc, /kernelReadonlySync\(/, 'HTTP 路径不得退回同步 spawn（会堵死桥事件循环）')
  assert.match(src, /let _readonlyCache = null/, '缓存实例必须被真正创建（缺了它路由一跑就 ReferenceError）')
})
