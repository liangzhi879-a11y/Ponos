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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleHostRoute, isHostPath, resolveTreeVersion } from './host-routes.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

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

/* ── /app-info（P3，2026-09-18）─────────────────────────────────────────────
   为什么这些用例值得写：本端点的**四件事都容易静默错**——
     ① 版本来源：静态 import 根 `version.mjs` 在打包版（不随包）会让**桥启动即崩**，
        故要求"读不到就 null"，而"null 分支"只有人工造一个没有 version.mjs 的目录才测得到；
        同理**版本线**：调试/便携树没有 package.json，只能报 version.mjs 的应用线，
        拿它去和界面版本（GUI 线）比会做出永久假告警 ⇒ 必须回传 versionSource 让人判定；
     ② 活状态：kernelRuntime / wsClients / sessions 若被缓存成模块级快照**不报错**，
        只是界面上的数字永远停在首次取值（与 bootState 同一个坑，见上面那条用例）；
     ③ 降级：appMeta 缺失时不得抛（否则设置页整页读不出"关于"）；
     ④ 落点推导：APP_ROOT 相对本文件的位置、内核旁 version.mjs 的两种布局。              */

test('/app-info：认领路径，且回包含版本/落点/连接状态三段', async () => {
  assert.equal(isHostPath('/app-info'), true)
  const r = await call('/app-info', {
    appMeta: { port: 52311, instanceId: 'inst-abc', home: 'C:/home/.yfworking', kernelPath: '', kernelSource: 'none' },
    sessions: new Map([['s1', {}]]),
    wsClients: new Set(['a', 'b']),
    bootState: { kernelBootstrapped: true },
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.bridge.pid, process.pid)
  assert.equal(r.body.bridge.port, 52311)
  assert.equal(r.body.bridge.instanceId, 'inst-abc')
  assert.equal(r.body.bridge.home, 'C:/home/.yfworking')
  assert.equal(r.body.engine.source, 'none')
  assert.equal(r.body.engine.reported, null, '本次桥运行还没起过内核 ⇒ null（不得伪造成空对象）')
  assert.equal(r.body.connection.wsClients, 2)
  assert.equal(r.body.connection.kernelSessions, 1)
  assert.equal(r.body.connection.boot.ready, false)
})

test('/app-info：APP_ROOT 推导正确 —— 版本取自本仓库 package.json，且来源标注为 GUI 线', async () => {
  // 钉住 "host-routes.mjs 相对 appRoot 的位置"：有人把它挪进子目录 ⇒ 这里立刻红，
  // 而不是安静地变成 "" + 界面显示"未标注"（2026-09-18 评审 M-1 的教训）
  const r = await call('/app-info')
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(r.body.bridge.version, pkg.version)
  assert.equal(r.body.bridge.versionSource, 'package.json')
})

test('/app-info：版本线分层 —— 无 package.json 的树回落应用线并**显式标注**，都不在则 none', async () => {
  // 调试/便携树（release/YFWorking 等）正是"有 version.mjs、无 package.json"形态
  const appTree = mkdtempSync(join(tmpdir(), 'yfw-appinfo-appline-'))
  const bareTree = mkdtempSync(join(tmpdir(), 'yfw-appinfo-none-'))
  try {
    writeFileSync(join(appTree, 'version.mjs'), "export const APP_VERSION = 'dev 9.9.9'\nexport const KERNEL_VERSION = 'dev 8.8'\n")
    assert.deepEqual(resolveTreeVersion(appTree), { version: 'dev 9.9.9', source: 'version.mjs' })

    writeFileSync(join(appTree, 'package.json'), JSON.stringify({ version: '2.8.0' }))
    assert.deepEqual(resolveTreeVersion(appTree), { version: '2.8.0', source: 'package.json' }, '两条线都在时优先 GUI 发布线')

    assert.deepEqual(resolveTreeVersion(bareTree), { version: '', source: 'none' }, '都读不到 ⇒ 如实空值，不猜')
  } finally {
    rmSync(appTree, { recursive: true, force: true })
    rmSync(bareTree, { recursive: true, force: true })
  }
})

test('/app-info：**禁止**静态 import 根 version.mjs（打包版不随包，会让桥启动即崩）', async () => {
  // 这条守护的正是上面注释里写的故障：静态 import 在源码树里一切正常，只在打包版崩，
  // 靠跑测试永远发现不了 ⇒ 用源码文本断言把它钉死（同 bridge-auth-token.test.mjs 的做法）
  const src = readFileSync(join(ROOT, 'server', 'host-routes.mjs'), 'utf8')
  assert.doesNotMatch(src, /^\s*import .*['"][^'"]*version\.mjs['"]/m,
    'host-routes.mjs 不得 import 根 version.mjs —— 打包版不含该文件，会 ER_MODULE_NOT_FOUND 崩桥；请用 resolveTreeVersion() 就地问')
})

test('/app-info：内核未运行时报 null，起过之后必须变成自报值（每次请求现读，不得缓存快照）', async () => {
  const box = { kernelRuntime: null }
  const first = await call('/app-info', { kernelRuntime: box.kernelRuntime })
  assert.equal(first.body.engine.reported, null)

  // 模拟桥收到一次 system/init 帧后改写它自己的变量（下一次请求读到新值）
  box.kernelRuntime = { version: 'dev 0.2', buildId: 'b1', model: 'm-x', skills: 12, capacity: 10, sessionId: 'sid-1', at: 1758000000000 }
  const second = await call('/app-info', { kernelRuntime: box.kernelRuntime })
  assert.equal(second.body.engine.reported.version, 'dev 0.2')
  assert.equal(second.body.engine.reported.skills, 12)
  assert.equal(second.body.engine.reported.sessionId, 'sid-1')
})

test('/app-info：WS 客户端/会话数是**活**的 —— 事后增删必须被后续请求读到', async () => {
  const wsClients = new Set(['a'])
  const sessions = new Map()
  const first = await call('/app-info', { wsClients, sessions })
  assert.equal(first.body.connection.wsClients, 1)
  assert.equal(first.body.connection.kernelSessions, 0)

  wsClients.add('b')
  sessions.set('s1', {})
  const second = await call('/app-info', { wsClients, sessions })
  assert.equal(second.body.connection.wsClients, 2, '若把 Set 复制成副本，这里会一直是 1（且不会报错）')
  assert.equal(second.body.connection.kernelSessions, 1)
})

test('/app-info：内核声明版本从内核旁边的 version.mjs 读取（源布局与 home 缓存同规则）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yfw-appinfo-'))
  try {
    // 源布局：<app>/kernel/cli.mjs + <app>/version.mjs
    mkdirSync(join(root, 'kernel'), { recursive: true })
    writeFileSync(join(root, 'kernel', 'cli.mjs'), '// stub\n')
    writeFileSync(join(root, 'version.mjs'), "export const KERNEL_VERSION = 'dev 7.7'\n")
    const r = await call('/app-info', { appMeta: { kernelPath: join(root, 'kernel', 'cli.mjs'), kernelSource: 'install' } })
    assert.equal(r.body.engine.declared.version, 'dev 7.7')
    assert.equal(r.body.engine.source, 'install')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('/app-info：bundle 形态（内核旁边没有 version.mjs）⇒ declared=null 且不抛', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yfw-appinfo-bundle-'))
  try {
    const cli = join(root, 'cli.mjs')
    writeFileSync(cli, '// bundled kernel, 版本号已内联\n')
    const r = await call('/app-info', { appMeta: { kernelPath: cli, kernelSource: 'install' } })
    assert.equal(r.status, 200)
    assert.equal(r.body.engine.declared.version, null, '打不出声明版本时必须如实为 null —— 打包版正是这一形态')
    // 非字符串 kernelPath 也不得抛（dirname 收到非字符串会 ERR_INVALID_ARG_TYPE，穿出即 400）
    const weird = await call('/app-info', { appMeta: { kernelPath: 42 } })
    assert.equal(weird.status, 200)
    assert.equal(weird.body.engine.declared.version, null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('/app-info：home 缓存布局同样读得到声明版本（<home>/runtime/ponos-kernel + <home>/runtime/version.mjs）', async () => {
  // 与源布局是**同一条相对规则**，但输入不同 —— 镜像落点若被改，只有这条能发现
  const root = mkdtempSync(join(tmpdir(), 'yfw-appinfo-cache-'))
  try {
    mkdirSync(join(root, 'runtime', 'ponos-kernel'), { recursive: true })
    writeFileSync(join(root, 'runtime', 'ponos-kernel', 'cli.mjs'), '// stub\n')
    writeFileSync(join(root, 'runtime', 'version.mjs'), "export const KERNEL_VERSION = 'dev 6.6'\n")
    const r = await call('/app-info', {
      appMeta: { kernelPath: join(root, 'runtime', 'ponos-kernel', 'cli.mjs'), kernelSource: 'cache' },
    })
    assert.equal(r.body.engine.declared.version, 'dev 6.6')
    assert.equal(r.body.engine.source, 'cache')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('/app-info：appMeta 缺失时降级不抛（port=null / source=none）', async () => {
  const r = await call('/app-info')
  assert.equal(r.status, 200)
  assert.equal(r.body.bridge.port, null)
  assert.equal(r.body.engine.source, 'none')
  assert.equal(r.body.engine.path, '')
  assert.equal(r.body.engine.declared.file, '')
  assert.ok(Number.isFinite(r.body.bridge.uptimeMs))
})

test('/app-info：启动预热四步全绿才算 ready', async () => {
  const full = { kernelBootstrapped: true, samplesInstalled: true, workflowsInstalled: true, probeDone: true }
  const ready = await call('/app-info', { bootState: full })
  assert.equal(ready.body.connection.boot.ready, true)

  for (const key of Object.keys(full)) {
    const r = await call('/app-info', { bootState: { ...full, [key]: false } })
    assert.equal(r.body.connection.boot.ready, false, `${key} 为 false 时不得判 ready`)
  }
})
