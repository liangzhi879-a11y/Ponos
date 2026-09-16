// M3：非浏览器驱动的**执行分发**（唯一真源）。
// 为什么值得单列：渲染层 IPC、内核桥、生成期试跑三条路径共用它；
// 只要有一处绕过它自己判 driver，就会出现"手工能跑、试跑跑不了"这类只差一层的怪故障。
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const home = mkdtempSync(join(tmpdir(), 'approute-'))
process.env.YFWORKING_HOME = home
delete process.env.PONOS_CONFIG_DIR
const dataDir = mkdtempSync(join(tmpdir(), 'approute-data-'))
writeFileSync(join(dataDir, 'project.json'), JSON.stringify({ frames: [{ name: 'a' }] }), 'utf-8')

const { runNonBrowser } = require('../electron/app-runner-route.cjs')
const { runAppCommand, draftDriverOf, exploreRoots } = require('../electron/app-ipc.cjs')
const appRegistry = require('../electron/app-registry.cjs')
const roots = () => [join(home, 'apps')]
process.on('exit', () => { try { rmSync(home, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true }) } catch { /* 尽力清理 */ } })

test('draftDriverOf：草稿自声明的 http/file 优先于探测驱动（否则接口级 Spec 永远过不了校验）', () => {
  assert.equal(draftDriverOf({ driver: 'http' }, 'process'), 'http')
  assert.equal(draftDriverOf({ driver: 'file' }, 'uia'), 'file')
  assert.equal(draftDriverOf({ driver: 'process' }, 'process'), 'process', '其它值仍以探测结果为准')
  assert.equal(draftDriverOf({}, 'process'), 'process', '草稿没写 driver ⇒ 用探测结果')
})

test('runNonBrowser：http 驱动 → httpRunner；套现成留痕语义（res 原样返回）', async () => {
  const seen = []
  const res = await runNonBrowser({
    appId: 'h', action: 'listItems', args: {},
    spec: {
      driver: 'http', target: { type: 'web', url: 'https://api.example.com/' },
      commands: [{ action: 'listItems', title: '查询条目', kind: 'read', params: [], steps: [{ act: 'request', url: 'https://api.example.com/items', save: 'items' }] }],
    },
    roots: roots(), deps: { fetchImpl: async (url) => { seen.push(url); return { status: 200, headers: { get: () => 'application/json' }, arrayBuffer: async () => new TextEncoder().encode('{"ok":1}').buffer } } },
    persist: false,
  })
  assert.equal(res.ok, true, res.error || '')
  assert.deepEqual(res.data.body, { ok: 1 })
  assert.deepEqual(seen, ['https://api.example.com/items'])
})

test('runNonBrowser：file 驱动 → fileRunner（roots 由 exploreRoots 决定）', async () => {
  const res = await runNonBrowser({
    appId: 'f', action: 'readProject', args: {},
    spec: {
      driver: 'file', target: { type: 'desktop', exePath: join(dataDir, 'app.exe') },
      commands: [{ action: 'readProject', title: '读取工程文件', kind: 'read', params: [], steps: [{ act: 'read', path: join(dataDir, 'project.json'), format: 'json', save: 'doc' }] }],
    },
    roots: roots(), exploreRoots: () => exploreRoots({ exePath: join(dataDir, 'app.exe') }), persist: false,
  })
  assert.equal(res.ok, true, res.error || '')
  assert.deepEqual(res.data.frames.map((f) => f.name), ['a'])
})

test('runNonBrowser：未知 driver → 结构化失败，不抛（不假装跑过）', async () => {
  const res = await runNonBrowser({ appId: 'x', action: 'a', args: {}, spec: { driver: 'nope', commands: [] }, roots: roots(), persist: false })
  assert.equal(res.ok, false)
  assert.ok(res.error.includes('nope'), res.error)
})

test('★ runAppCommand：http/file 驱动同样走统一分发，并且**留痕**（与 browser/process 同口径）', async () => {
  appRegistry.upsertApp({ roots: roots(), app: { id: 'http-app', name: '接口应用', targetType: 'web', enabled: true } })
  appRegistry.writeSpec({
    roots: roots(), appId: 'http-app',
    spec: {
      specVersion: 1, appId: 'http-app', name: '接口应用', driver: 'http',
      target: { type: 'web', url: 'https://api.example.com/' }, expose: { mode: 'console' },
      commands: [{ action: 'listItems', title: '查询条目', kind: 'read', params: [], steps: [{ act: 'request', url: 'https://api.example.com/items', save: 'items' }] }],
    },
  })
  const r = await runAppCommand({
    appId: 'http-app', action: 'listItems', args: {}, sessionId: 's1', getExecutor: () => null, roots: roots(),
    deps: { fetchImpl: async () => ({ status: 200, headers: { get: () => 'application/json' }, arrayBuffer: async () => new TextEncoder().encode('{"ok":true}').buffer }) },
  })
  assert.equal(r.ok, true, r.error || '')
  const dir = join(home, 'apps', 'http-app', 'history')
  assert.equal(existsSync(dir), true, 'http 执行也要留痕（与既有执行路径一致）')
  const line = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), 'utf-8').trim().split('\n').pop())
  assert.equal(line.action, 'listItems')
  assert.equal(line.ok, true)
})

test('★ runAppCommand：试跑路径（persist:false）不写 history（生成期草稿还没落盘）', async () => {
  const day = new Date().toISOString().slice(0, 10)
  const file = join(home, 'apps', 'http-app', 'history', `${day}.jsonl`)
  // 按**行数**比较（不能断言"文件里不含某串"：上一条用例已经为同一个 appId 留过痕）
  const countLines = () => (existsSync(file) ? readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean).length : 0)
  const before = countLines()
  const r = await runNonBrowser({
    appId: 'http-app', action: 'listItems', args: {},
    spec: { driver: 'http', target: { type: 'web', url: 'https://api.example.com/' }, commands: [{ action: 'listItems', title: '查询条目', kind: 'read', params: [], steps: [{ act: 'request', url: 'https://api.example.com/items', save: 'items' }] }] },
    roots: roots(), deps: { fetchImpl: async () => ({ status: 200, headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode('{}').buffer }) },
    persist: false,
  })
  assert.equal(r.ok, true, r.error || '')
  assert.equal(countLines(), before, 'persist:false 不得新增留痕行')
})
