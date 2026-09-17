// server/readonly-routes.test.mjs —— 只读聚合路由直测（P1 批次 2 新增）
// ---------------------------------------------------------------------------
// 测的是本模块**自己的职责**：query→flags 的参数拼装、三种状态到 HTTP 状态码的映射
// （fresh/stale → 200、computing → 503、failed → 502）、以及正常态的 raw 透传。
// 这些都**不需要真起内核子进程**（单测 spawn 内核既慢又违反本仓库"单测不起内核"的纪律），
// 故通过 runner/cache 注入口喂入桩。内核自身的行为由 kernel-readonly 的测试覆盖。
//
// 也刻意**不 import bridge.mjs**（它在 import 期就会扫真实 home）。
// 运行：node --test server/readonly-routes.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleReadonlyRoute, isReadonlyPath } from './readonly-routes.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')

/** 直通缓存桩：立刻执行 fetcher，不缓存（本测试关心装配与映射，不关心缓存策略） */
const passThroughCache = () => ({ get: async (_key, fetcher) => fetcher() })

/** 记录被调用的 runner 桩 */
function recordingRunner(result) {
  const calls = []
  const runner = async (args, opts) => { calls.push({ args, opts }); return result }
  return { runner, calls }
}

const call = (pathname, search, { result = { payload: '{"ok":1}' }, cache = passThroughCache() } = {}) => {
  const { runner, calls } = recordingRunner(result)
  return handleReadonlyRoute({
    pathname,
    searchParams: new URLSearchParams(search),
    buildChildEnv: () => ({ STUB_ENV: '1' }),
    runner,
    cache,
  }).then((res) => ({ res, calls }))
}

// ── 路径认领 ─────────────────────────────────────────────────────────────
test('isReadonlyPath：只认领 /api/usage 与 /api/audit', () => {
  assert.equal(isReadonlyPath('/api/usage'), true)
  assert.equal(isReadonlyPath('/api/audit'), true)
  assert.equal(isReadonlyPath('/api/usage/x'), false)
  assert.equal(isReadonlyPath('/api/auth/status'), false)
})

test('不认领的路径返回 null（不得抢走身份面等端点）', async () => {
  const { res, calls } = await call('/api/auth/status', '')
  assert.equal(res, null)
  assert.equal(calls.length, 0, '不认领时不得触发任何子进程调用')
})

// ── 参数拼装 ─────────────────────────────────────────────────────────────
test('/api/usage → 子命令 --usage；/api/audit → --audit', async () => {
  const a = await call('/api/usage', '')
  assert.deepEqual(a.calls[0].args, ['--usage'])
  const b = await call('/api/audit', '')
  assert.deepEqual(b.calls[0].args, ['--audit'])
})

test('query 白名单转 flags：scope/sessionId/project/from/to 按序出现', async () => {
  const { calls } = await call('/api/usage', 'scope=session&sessionId=abc&project=p1&from=2026-01-01&to=2026-02-01')
  assert.deepEqual(calls[0].args, ['--usage', '--scope', 'session', '--sessionId', 'abc', '--project', 'p1', '--from', '2026-01-01', '--to', '2026-02-01'])
})

test('query 空值被跳过（不产出 `--scope ` 这种空参）', async () => {
  const { calls } = await call('/api/usage', 'scope=&sessionId=s1')
  assert.deepEqual(calls[0].args, ['--usage', '--sessionId', 's1'])
})

test('未知 query 参数被忽略（不透传给内核，避免子命令解析报错）', async () => {
  const { calls } = await call('/api/usage', 'scope=x&evil=--rm-rf&__proto__=1')
  assert.deepEqual(calls[0].args, ['--usage', '--scope', 'x'])
})

test('每次调用都重新求值 buildChildEnv（配置热改必须生效）', async () => {
  const seen = []
  await handleReadonlyRoute({
    pathname: '/api/usage', searchParams: new URLSearchParams(),
    buildChildEnv: () => { seen.push(1); return { N: String(seen.length) } },
    runner: async () => ({ payload: '{}' }), cache: passThroughCache(),
  })
  assert.equal(seen.length, 1, 'buildChildEnv 应由本次请求求值一次')
  assert.deepEqual((await (async () => {
    // 第二次调用应得到不同的 env —— 证明传的是函数而非求值快照
    let captured
    await handleReadonlyRoute({
      pathname: '/api/usage', searchParams: new URLSearchParams(),
      buildChildEnv: () => ({ N: 'fresh' }),
      runner: async (_a, o) => { captured = o.env; return { payload: '{}' } },
      cache: passThroughCache(),
    })
    return captured
  })()), { N: 'fresh' })
})

// ── 状态映射 ─────────────────────────────────────────────────────────────
test('正常态：200 + raw:true，body 逐字透传内核输出（大 payload 不做二次 stringify）', async () => {
  const payload = '{"sessions":[{"id":"a","n":1}]}'   // 刻意含换行/紧凑格式
  const { res } = await call('/api/usage', '', { result: { payload } })
  assert.equal(res.status, 200)
  assert.equal(res.raw, true)
  assert.equal(res.body, payload)
})

test('computing（冷启动未就绪）→ 503，而非 502：语义是"稍后重试"不是"失败"', async () => {
  const { res } = await call('/api/usage', '', { result: { state: 'computing' } })
  assert.equal(res.status, 503)
  assert.match(res.body.error, /计算中/)
})

test('failed → 502，并带上原始错误信息（便于定位内核侧问题）', async () => {
  const { res } = await call('/api/audit', '', { result: { state: 'failed', error: new Error('kernel exploded') } })
  assert.equal(res.status, 502)
  assert.equal(res.body.error, 'kernel exploded')
})

test('failed 且 error 非 Error 实例时也能取到字符串（不抛）', async () => {
  const { res } = await call('/api/audit', '', { result: { state: 'failed', error: 'plain string failure' } })
  assert.equal(res.status, 502)
  assert.equal(res.body.error, 'plain string failure')
})

test('stale（回旧值 + 后台刷新）对调用方就是 200', async () => {
  const { res } = await call('/api/usage', '', { result: { state: 'stale', payload: '{"old":true}' } })
  assert.equal(res.status, 200)
  assert.equal(res.body, '{"old":true}')
})

// ── 安全顺序守卫 ─────────────────────────────────────────────────────────
// 用**调用点专属的代码形态**定位，避免命中注释里的裸函数名（源码守卫被注释干扰是踩过的坑）。
test('安全守卫：只读聚合委托点必须在令牌闸门之后', () => {
  const src = readFileSync(join(REPO, 'server', 'bridge.mjs'), 'utf8')
  const tokenGate = src.indexOf('const authz = authorizeBridgeRequest(req, BRIDGE_TOKEN)')
  const delegate = src.indexOf('await handleReadonlyRoute({')
  assert.ok(tokenGate > 0, '前置条件：应存在令牌闸门调用')
  assert.ok(delegate > 0, '接入守卫的委托点应存在')
  assert.ok(delegate > tokenGate, 'handleReadonlyRoute 的调用点跑到了令牌闸门之前——用量/审计数据会被未鉴权请求读到')
})
