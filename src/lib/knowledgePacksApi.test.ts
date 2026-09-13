// src/lib/knowledgePacksApi.test.ts
// 运行：node --test src/lib/knowledgePacksApi.test.ts（Node 原生 TS，相对导入必须带 .ts）
//
// **不联网**：全局 fetch 一律替换成桩（照 src/lib/knowledgeApi.test.ts 的先例）。
// 断言的是"实际发出的 URL/方法/请求体字段名"——后端参数名写错不会报错，只会静默装错/装不上。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  listPacks, packDetail, installPack, installPackFromFile, uninstallPack, exportPack,
} from './knowledgePacksApi.ts'

const BASE = 'http://localhost:51517'
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface Call { url: string; init?: RequestInit }
let calls: Call[] = []

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  calls = []
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    return handler(url, init)
  }) as typeof fetch
}

const url = (i = 0) => new URL(calls[i].url)
const bodyOf = (i = 0) => JSON.parse(String(calls[i].init?.body ?? '{}'))

beforeEach(() => { calls = [] })

test('listPacks：GET /knowledge/packs，不拆包（顶层字段即 data）', async () => {
  const payload = {
    ok: true, source: 'remote', registry: 'https://r.invalid/kp', registryOrigin: 'config',
    hasLocalIndex: false, updatedAt: null, indexError: null, warnings: [], appVersion: 'dev 2.8.0',
    packs: [{ id: 'gaoqi-2026', name: '高企包', version: '1.2.0', installedVersion: '1.0.0', onDisk: true, updateAvailable: true }],
  }
  mockFetch(() => json(payload))
  const r = await listPacks({ baseUrl: BASE })
  assert.equal(calls[0].init?.method, 'GET')
  assert.equal(url().pathname, '/knowledge/packs')
  assert.equal(url().search, '', '无参端点不得带空查询串')
  assert.equal(r.ok, true)
  assert.deepEqual(r.ok === true && r.data, payload)
})

test('listPacks：清单拉不到（indexError）仍是 ok:true —— UI 要当提示而非失败', async () => {
  mockFetch(() => json({ ok: true, source: 'remote', indexError: '清单拉取失败：HTTP 404', packs: [] }))
  const r = await listPacks({ baseUrl: BASE })
  assert.equal(r.ok, true)
  assert.equal(r.ok === true && r.data.indexError, '清单拉取失败：HTTP 404')
})

test('packDetail：GET + id 走查询串并百分号编码（`../` 等危险输入由后端 400，前端不拼路径）', async () => {
  mockFetch(() => json({ ok: true, pack: { id: 'a-b' }, readme: '', versions: null, version: { ok: true, reason: 'current' } }))
  await packDetail('a-b', { baseUrl: BASE })
  assert.equal(url().pathname, '/knowledge/packs/detail')
  assert.equal(url().searchParams.get('id'), 'a-b')

  mockFetch(() => json({ ok: true }))
  await packDetail('../etc', { baseUrl: BASE })
  assert.equal(url().pathname, '/knowledge/packs/detail', 'id 必须留在查询串里，不得出现在路径段上')
  assert.equal(url().searchParams.get('id'), '../etc')
})

test('installPack：POST + 请求体字段名 {id, version?, mode?}（version/mode 省略即不发）', async () => {
  mockFetch(() => json({ ok: true, status: 'installed', packId: 'gaoqi-2026', version: '1.0.0', spaceId: 'pack-gaoqi-2026', files: 3 }))
  const r = await installPack({ id: 'gaoqi-2026' }, { baseUrl: BASE })
  assert.equal(calls[0].init?.method, 'POST')
  assert.equal(url().pathname, '/knowledge/packs/install')
  assert.deepEqual(bodyOf(), { id: 'gaoqi-2026' }, '可选字段省略时不得发空值（后端会当成显式指定）')
  assert.equal(r.ok, true)
  assert.equal(r.ok === true && r.data.status, 'installed')

  mockFetch(() => json({ ok: true, status: 'updated' }))
  await installPack({ id: 'gaoqi-2026', version: '1.2.0', mode: 'overwrite' }, { baseUrl: BASE })
  assert.deepEqual(bodyOf(), { id: 'gaoqi-2026', version: '1.2.0', mode: 'overwrite' })
})

test('installPackFromFile：POST {localPath, mode?}（离线安装：zip 或目录）', async () => {
  mockFetch(() => json({ ok: true, status: 'installed', packId: 'p', version: '1.0.0', spaceId: 'pack-p', files: 2 }))
  await installPackFromFile('C:/Users/x/高企包.zip', undefined, { baseUrl: BASE })
  assert.equal(url().pathname, '/knowledge/packs/install')
  assert.deepEqual(bodyOf(), { localPath: 'C:/Users/x/高企包.zip' })

  mockFetch(() => json({ ok: true, status: 'to-my-space' }))
  await installPackFromFile('/tmp/pack-dir', 'to-my-space', { baseUrl: BASE })
  assert.deepEqual(bodyOf(), { localPath: '/tmp/pack-dir', mode: 'to-my-space' })
})

test('installPack：403 kept-user-modified → ok:false + status + conflict（三选原样带回 UI），不抛', async () => {
  mockFetch(() => json({
    ok: false, error: 'kept-user-modified', status: 'kept-user-modified',
    conflicts: ['content/a.md'], options: ['overwrite', 'keep', 'to-my-space'],
    message: '目标包内文件与安装台账不符',
  }, 403))
  const r = await installPack({ id: 'gaoqi-2026' }, { baseUrl: BASE })
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.error, 'kept-user-modified')
  assert.equal(r.ok === false && r.status, 403)
  assert.deepEqual(r.ok === false && r.conflict, { conflicts: ['content/a.md'], options: ['overwrite', 'keep', 'to-my-space'], message: '目标包内文件与安装台账不符' })
})

test('installPack：400 校验失败带 errors[]（原因逐条透出，不吞错）', async () => {
  mockFetch(() => json({ ok: false, error: 'install rejected', errors: ['非法条目名：条目名含上跳路径段：../a.md'], status: 'rejected' }, 400))
  const r = await installPack({ id: 'evil-pack' }, { baseUrl: BASE })
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.status, 400)
  assert.deepEqual(r.ok === false && r.errors, ['非法条目名：条目名含上跳路径段：../a.md'])
  assert.equal(r.ok === false && r.conflict, undefined, '非冲突态不得造出 conflict')
})

test('uninstallPack：POST {id}', async () => {
  mockFetch(() => json({ ok: true, packId: 'gaoqi-2026', removed: ['content/a.md'], removedCount: 1, ledgerCleared: true }))
  const r = await uninstallPack('gaoqi-2026', { baseUrl: BASE })
  assert.equal(url().pathname, '/knowledge/packs/uninstall')
  assert.deepEqual(bodyOf(), { id: 'gaoqi-2026' })
  assert.equal(r.ok === true && r.data.removedCount, 1)
})

test('exportPack：POST 原样带 meta（spaceId/id/version/license/author/repo/tags）', async () => {
  mockFetch(() => json({ ok: true, packId: 'my-pack', zipPath: 'C:/home/knowledge/exports/my-pack-1.0.0.zip', zipBytes: 123, packJson: { source: 'content' } }))
  const r = await exportPack({ spaceId: 'my-space', id: 'my-pack', version: '1.0.0', license: 'MIT', author: '张三', repo: 'https://github.com/x/y', tags: ['政策'] }, { baseUrl: BASE })
  assert.equal(url().pathname, '/knowledge/packs/export')
  assert.deepEqual(bodyOf(), { spaceId: 'my-space', id: 'my-pack', version: '1.0.0', license: 'MIT', author: '张三', repo: 'https://github.com/x/y', tags: ['政策'] })
  assert.equal(r.ok === true && r.data.zipBytes, 123)
  assert.match(r.ok === true ? r.data.zipPath : '', /\.zip$/)
})

test('非 2xx 且响应体非 JSON → 回落 `HTTP <status>`（不因解析失败把错误咽掉）', async () => {
  mockFetch(() => new Response('<html>500</html>', { status: 500 }))
  const r = await listPacks({ baseUrl: BASE })
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.error, 'HTTP 500')
  assert.equal(r.ok === false && r.status, 500)
})

test('网络异常 → {ok:false, error}（不抛）；超时 → 中文超时文案', async () => {
  globalThis.fetch = (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch
  let r = await listPacks({ baseUrl: BASE })
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.error, 'ECONNREFUSED')

  mockFetch((_u, init) => new Promise<Response>((_res, rej) => {
    init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  }))
  r = await listPacks({ baseUrl: BASE, timeoutMs: 10 })
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.error : '', /超时/)
})

test('getBridgeUrl 在无 Vite 环境下抛错时也返回结构化失败（不把异常抛给调用方）', async () => {
  // 不传 baseUrl ⇒ 走 config.getBridgeUrl()（纯 node 下依赖 Vite 注入，必然抛）
  globalThis.fetch = (async () => json({ ok: true, packs: [] })) as typeof fetch
  const r = await listPacks()
  assert.equal(r.ok, false)
  assert.ok(r.ok === false && typeof r.error === 'string' && r.error.length > 0)
})
