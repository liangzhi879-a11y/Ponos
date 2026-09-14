// src/lib/knowledgeApi.test.ts
// 运行：node --test src/lib/knowledgeApi.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
//
// **不联网**：全局 fetch 一律替换成桩。每条用例前重置桩，并断言"实际发出的 URL/方法与请求体"——
// 后端的参数名是 S1 实测契约（server/knowledge-routes.mjs），写错参数名不会报错，
// 只会静默返回未过滤/空结果，所以 URL 组装必须有测试钉住。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  listSpaces, listTree, getDoc, listEntries, search, getLinks, getGraph, getStats, reindex, writeDoc,
  getRelated, getRelatedDoc, getGraphRelated, clearKnowledgeInflight, importKnowledge,
  listTrash, deleteDoc, deleteSpace, restoreTrash, purgeTrash,
} from './knowledgeApi.ts'

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

beforeEach(() => { clearKnowledgeInflight(); calls = [] })

test('listSpaces：GET /knowledge/spaces，拆包 {spaces}', async () => {
  mockFetch(() => json({ spaces: [{ id: 'experience', name: '经验', root: 'C:/k', writable: true, source: 'builtin', docCount: 3 }] }))
  const r = await listSpaces({ baseUrl: BASE })
  assert.equal(calls[0].init?.method, 'GET')
  assert.equal(url().pathname, '/knowledge/spaces')
  assert.equal(url().search, '', '无参端点不得带空查询串')
  assert.deepEqual(r, { ok: true, data: { spaces: [{ id: 'experience', name: '经验', root: 'C:/k', writable: true, source: 'builtin', docCount: 3 }] } })
})

test('listTree：space 必发、path 省略即不出现；HTTP body 是 {entries}（内核 CLI 包装）', async () => {
  const entries = [{ name: 'a.md', path: 'notes/a.md', type: 'file', docId: 'notes/notes/a.md' }]
  mockFetch(() => json({ entries }))
  const r = await listTree('notes', undefined, { baseUrl: BASE })
  assert.equal(url().pathname, '/knowledge/tree')
  assert.equal(url().searchParams.get('space'), 'notes')
  assert.equal(url().searchParams.has('path'), false, 'path 缺省不得发空串参数')
  assert.deepEqual(r, { ok: true, data: entries })

  // 容错：上游若改成裸数组（S2 计划原假设）也要能读——同一份实现不因两端契约微调而静默空列表
  mockFetch(() => json(entries))
  const r2 = await listTree('notes', 'sub', { baseUrl: BASE })
  assert.deepEqual(r2, { ok: true, data: entries })
  assert.equal(url().searchParams.get('path'), 'sub')
})

test('getDoc：拆包 {doc}；内核查不到（doc=null）→ {ok:false} 且不抛', async () => {
  const doc = { id: 'notes/a.md', spaceId: 'notes', rel: 'a.md', title: 'A', tags: [], blocks: [{ n: 1, kind: 'para', text: 'x', line: 3, tag: null, full: null }] }
  mockFetch(() => json({ doc }))
  const r = await getDoc('notes/a.md', { baseUrl: BASE })
  assert.equal(url().searchParams.get('id'), 'notes/a.md')
  assert.deepEqual(r, { ok: true, data: doc })

  mockFetch(() => json({ doc: null }))
  const miss = await getDoc('notes/gone.md', { baseUrl: BASE })
  assert.deepEqual(miss, { ok: false, error: 'doc not found' })
})

test('listEntries：拆包 {entries}；非经验文档的空数组也是成功', async () => {
  mockFetch(() => json({ entries: [{ blockId: 'notes/a.md:2', tag: 'ps材料', summary: 's', full: 'f', line: 7 }] }))
  const r = await listEntries('notes/a.md', { baseUrl: BASE })
  assert.equal(url().pathname, '/knowledge/entries')
  assert.equal(r.ok, true)
  assert.equal(r.ok && r.data[0].tag, 'ps材料')

  mockFetch(() => json({ entries: [] }))
  const empty = await listEntries('notes/a.md', { baseUrl: BASE })
  assert.deepEqual(empty, { ok: true, data: [] })
})

test('search：q/keywords/spaces/topK/mode 组装正确且中文被百分号编码', async () => {
  mockFetch(() => json({ items: [], count: 0, indexAge: null, degraded: false }))
  const r = await search(
    { q: 'PS表 交叉校验', keywords: ['ps材料', 'RD表'], topK: 10, mode: 'full', spaces: ['experience', 'notes'] },
    { baseUrl: BASE },
  )
  assert.equal(r.ok, true)
  assert.equal(url().pathname, '/knowledge/search')
  assert.equal(url().searchParams.get('q'), 'PS表 交叉校验')
  assert.equal(url().searchParams.get('keywords'), 'ps材料,RD表', 'keywords 必须是逗号串')
  assert.equal(url().searchParams.get('spaces'), 'experience,notes', 'spaces 必须是逗号串（内核按逗号拆多空间）')
  assert.equal(url().searchParams.get('topK'), '10')
  assert.equal(url().searchParams.get('mode'), 'full')
  assert.match(calls[0].url, /q=PS%E8%A1%A8/, '中文必须被 URLSearchParams 编码')
})

test('search：keywords/spaces 为空或空串时**不出现该参数**，且绝不下发 null', async () => {
  mockFetch(() => json({ items: [], count: 0, indexAge: null, degraded: false }))
  await search({ q: 'x' }, { baseUrl: BASE })
  assert.equal(url().searchParams.has('keywords'), false)
  assert.equal(url().searchParams.has('spaces'), false)
  assert.equal(calls[0].url.includes('null'), false, '内核 keywordScore 对 null 短路返回 0 → 传 null 会静默变成"不匹配"')

  await search({ q: 'x', keywords: [], spaces: [] }, { baseUrl: BASE })
  assert.equal(url(1).searchParams.has('keywords'), false)
  assert.equal(url(1).searchParams.has('spaces'), false)

  // 空白项全部剔空 → 退化成"不发参数"，而不是发一个空串
  await search({ q: 'x', keywords: [' ', ''], spaces: [''] }, { baseUrl: BASE })
  assert.equal(url(2).searchParams.has('keywords'), false)
  assert.equal(url(2).searchParams.has('spaces'), false)
})

test('getLinks / getGraph / getStats / reindex：路径与动词（POST 重建索引）', async () => {
  mockFetch(() => json({ out: [{ to: 'b.md', target: 'notes/b.md' }], in: [{ from: 'notes/c.md' }] }))
  const links = await getLinks('notes/a.md', { baseUrl: BASE })
  assert.deepEqual(links, { ok: true, data: { out: [{ to: 'b.md', target: 'notes/b.md' }], in: [{ from: 'notes/c.md' }] } })
  assert.equal(url().pathname, '/knowledge/links')

  mockFetch(() => json({ nodes: [{ id: 'notes/a.md', label: 'A', spaceId: 'notes', kind: 'doc' }], edges: [{ from: 'notes/a.md', to: 'notes/b.md', target: 'notes/b.md' }] }))
  await getGraph('notes', 50, { baseUrl: BASE })
  assert.equal(url().pathname, '/knowledge/graph')
  assert.equal(url().searchParams.get('space'), 'notes')
  assert.equal(url().searchParams.get('limit'), '50')

  mockFetch(() => json({ nodes: [], edges: [] }))
  await getGraph(undefined, undefined, { baseUrl: BASE })
  assert.equal(url().searchParams.has('space'), false, '全空间图谱不得发空 space 参数')
  assert.equal(url().searchParams.has('limit'), false, 'limit 缺省交给后端默认（200）')

  mockFetch(() => json({ version: 3, docs: 1, blocks: 2, grams: 9, spaces: 2, builtAt: '2026-09-13T00:00:00.000Z', indexAgeMs: 12, indexBytes: 345 }))
  const stats = await getStats({ baseUrl: BASE })
  assert.equal(url().pathname, '/knowledge/stats')
  assert.equal(stats.ok && stats.data.docs, 1)

  mockFetch(() => json({ ok: true, version: 3, docs: 1, blocks: 2, grams: 9, spaces: 2, builtAt: null, indexAgeMs: null, indexBytes: 345 }))
  const re = await reindex({ baseUrl: BASE })
  assert.equal(calls[0].init?.method, 'POST', 'reindex 是 POST')
  assert.equal(url().pathname, '/knowledge/reindex')
  assert.equal(calls[0].init?.body, undefined, 'reindex 无请求体')
  assert.equal(re.ok, true)
})

test('getRelated：GET /knowledge/related?id=&limit=&，拆包 {related}（CLI 包装层）', async () => {
  const related = [{ blockId: 'a.md#1', docId: 'a.md', title: 'A', why: { kind: 'tag', tag: '应用智控' }, score: null }]
  mockFetch(() => json({ blockId: 'a.md#0', validate: true, limit: 8, count: 1, related }))
  const r = await getRelated('a.md#0', {}, { baseUrl: BASE })
  assert.equal(calls[0].init?.method, 'GET')
  assert.equal(url().pathname, '/knowledge/related')
  assert.equal(url().searchParams.get('id'), 'a.md#0')
  assert.equal(url().searchParams.has('limit'), false, 'limit 缺省交给内核 MAX_RELATED，前端不硬编码')
  assert.deepEqual(r, { ok: true, data: related })

  // 空集是**成功**（"没有锚点"不是错误）——UI 据此不渲染关联行，而不是显示加载失败
  mockFetch(() => json({ blockId: 'a.md#9', count: 0, related: [] }))
  assert.deepEqual(await getRelated('a.md#9', { limit: 3 }, { baseUrl: BASE }), { ok: true, data: [] })
  assert.equal(url(0).searchParams.get('limit'), '3', 'mockFetch 每次重置 calls：这里第 0 条就是本次请求')

  // 400（非法 blockId 形状）必须原样透出 status，UI 才区分得开"参数错"与"没数据"
  mockFetch(() => json({ error: 'invalid id: a.md' }, 400))
  const bad = await getRelated('a.md', {}, { baseUrl: BASE })
  assert.deepEqual(bad, { ok: false, error: 'invalid id: a.md', status: 400 })
})

test('getRelatedDoc：GET /knowledge/related?doc=&limit=，拆包 {blocks}（GUI 批量口）', async () => {
  const blocks = [{ blockId: 'a.md#0', related: [{ blockId: 'b.md#2', docId: 'b.md', title: 'B', why: { kind: 'content', score: 0.21, shared: ['功能'] }, score: 0.21 }] }]
  mockFetch(() => json({ docId: 'a.md', validate: true, limit: 8, count: 1, blocks }))
  const r = await getRelatedDoc('a.md', {}, { baseUrl: BASE })
  assert.equal(url().pathname, '/knowledge/related')
  assert.equal(url().searchParams.get('doc'), 'a.md', 'doc 参数名必须与路由一致（写错=静默空数组）')
  assert.equal(url().searchParams.has('id'), false, '批量口不得带 id（两个都给时路由按 id 走）')
  assert.deepEqual(r, { ok: true, data: blocks })
  const warn = await getRelatedDoc('b.md', { limit: 2 }, { baseUrl: BASE })
  assert.equal(url(1).searchParams.get('limit'), '2')
  assert.equal(warn.ok, true)
})

test('getGraphRelated：GET /knowledge/graph?related=1，只取 related 数组（图层开关专用）', async () => {
  const related = [{ from: 'a.md', to: 'b.md', kind: 'tag', score: null, count: 3 }]
  mockFetch(() => json({ nodes: [], edges: [], related }))
  const r = await getGraphRelated('notes', undefined, { baseUrl: BASE })
  assert.equal(url().pathname, '/knowledge/graph')
  assert.equal(url().searchParams.get('related'), '1', '图层必须显式 related=1（缺省关，spec §7.5）')
  assert.equal(url().searchParams.get('space'), 'notes')
  assert.deepEqual(r, { ok: true, data: related })

  mockFetch(() => json({ nodes: [], edges: [] }))
  const all = await getGraphRelated(undefined, undefined, { baseUrl: BASE })
  assert.deepEqual(all, { ok: true, data: [] }, '缺 related 字段 → 空数组（不抛）')
})

test('writeDoc：POST /knowledge/doc，请求体用 `space` 字段（非 spaceId），不含多余字段', async () => {
  mockFetch(() => json({ ok: true, docId: 'notes/a.md', updated: true }))
  const r = await writeDoc({ space: 'notes', path: 'a.md', content: '# A\n' }, { baseUrl: BASE })
  assert.equal(calls[0].init?.method, 'POST')
  assert.equal(url().pathname, '/knowledge/doc')
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { space: 'notes', path: 'a.md', content: '# A\n' })
  assert.equal(String(calls[0].init?.body).includes('spaceId'), false, '统一用 space（GET 系列同名字段，少一处踩坑点）')
  assert.deepEqual(r, { ok: true, data: { docId: 'notes/a.md', updated: true } })
})

test('writeDoc：403（只读空间）与 413（超限）可区分——status 保留、error 不同', async () => {
  mockFetch(() => json({ error: 'space is read-only' }, 403))
  const ro = await writeDoc({ space: 'pkg', path: 'a.md', content: 'x' }, { baseUrl: BASE })
  mockFetch(() => json({ error: 'document too large（上限 2MB）' }, 413))
  const big = await writeDoc({ space: 'notes', path: 'a.md', content: 'x' }, { baseUrl: BASE })
  mockFetch(() => json({ error: 'invalid path（须为空间内相对 .md 路径）' }, 400))
  const bad = await writeDoc({ space: 'notes', path: '../x.md', content: 'x' }, { baseUrl: BASE })

  assert.deepEqual(ro, { ok: false, error: 'space is read-only', status: 403 })
  assert.equal(big.ok, false)
  assert.equal(big.ok === false && big.status, 413)
  assert.notEqual(ro.ok === false && ro.error, big.ok === false && big.error)
  assert.equal(bad.ok === false && bad.status, 400)
})

test('非 2xx：归一成 {ok:false, status}，不抛；非 JSON 错误体回退 HTTP <status>', async () => {
  mockFetch(() => json({ error: 'space not found' }, 404))
  const r = await listTree('ghost', undefined, { baseUrl: BASE })
  assert.deepEqual(r, { ok: false, error: 'space not found', status: 404 })

  mockFetch(() => new Response('<html>502</html>', { status: 502 }))
  const r2 = await listSpaces({ baseUrl: BASE })
  assert.equal(r2.ok, false)
  assert.equal(r2.ok === false && r2.status, 502)
  assert.equal(r2.ok === false && r2.error, 'HTTP 502')
})

test('网络异常（fetch reject）→ {ok:false} 且不抛', async () => {
  mockFetch(() => { throw new Error('ECONNREFUSED') })
  const r = await listSpaces({ baseUrl: BASE })
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.error, 'ECONNREFUSED')
})

test('超时：AbortController 到点中止 → {ok:false, error: 请求超时}', async () => {
  // 桩不主动 reject：只在收到 abort 信号后 reject，模拟真实 fetch 的中止语义
  mockFetch((_u, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  }))
  const r = await listSpaces({ baseUrl: BASE, timeoutMs: 10 })
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.error : '', /超时/)
})

test('importKnowledge：POST /knowledge/import，单源 from 是字符串、多源是数组；spaceId/name 二选一', async () => {
  const report = {
    ok: true, spaceId: 'declare', spaceName: '申报资料', spaceCreated: true, dryRun: false,
    source: 'D:/申报', counts: { total: 6, converted: 6, skipped: 0, failed: 0 },
    converted: [], skipped: [], failed: [], indexSync: 'reloaded', warnings: [],
  }
  mockFetch(() => json(report))
  const r = await importKnowledge({ from: 'D:/申报', name: '申报资料' }, { baseUrl: BASE })
  assert.equal(calls[0].init?.method, 'POST', '导入是写操作，必须 POST')
  assert.equal(url().pathname, '/knowledge/import')
  // 字段名与 server/knowledge-routes.mjs 的 handleImport **逐字对齐**：写错不会报错，
  // 只会变成"路由 400 from 必填"，或更糟——落在默认空间上。
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { from: 'D:/申报', name: '申报资料' })
  assert.deepEqual(r, { ok: true, data: report })

  // 多选文件 = 一条请求带多个源（路由把数组摊平成多个 `--src`）；已有空间用 spaceId
  mockFetch(() => json({ ...report, spaceCreated: false }))
  await importKnowledge({ from: ['a.pdf', 'b.docx'], spaceId: 'declare', dryRun: true }, { baseUrl: BASE })
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { from: ['a.pdf', 'b.docx'], spaceId: 'declare', dryRun: true })
  assert.equal(JSON.parse(String(calls[0].init?.body)).name, undefined, '给已有空间时不得同时带 name（会变成改名/新建的歧义）')
})

test('importKnowledge：逐文件失败是 200 + 三档明细（不是 error）；dryRun 报告原样透出', async () => {
  const report = {
    ok: true, spaceId: 'declare', spaceName: '申报资料', spaceCreated: false, dryRun: false,
    source: 'D:/申报',
    counts: { total: 3, converted: 1, skipped: 1, failed: 1 },
    converted: [{ source: 'D:/申报/a.pdf', out: 'a.md', converter: 'pdf' }],
    skipped: [{ source: 'D:/申报/b.docx', out: 'b.md', reason: 'unchanged' }],
    failed: [{ source: 'D:/申报/setup.exe', error: 'unsupported-type', message: '不支持的扩展名：.exe' }],
    indexSync: 'reloaded', warnings: [],
  }
  mockFetch(() => json(report))
  const r = await importKnowledge({ from: 'D:/申报', spaceId: 'declare' }, { baseUrl: BASE })
  assert.equal(r.ok, true, '部分失败是 200：整批不因一个 .exe 变红（P1-3）')
  assert.deepEqual(r.ok && r.data.counts, { total: 3, converted: 1, skipped: 1, failed: 1 })
  assert.equal(r.ok && r.data.failed[0].message, '不支持的扩展名：.exe', '失败项必须带文件名+原因（GUI 明细直接用）')
  assert.equal(r.ok && r.data.skipped[0].reason, 'unchanged', '跳过是独立一档（P1-2：GUI 要能显示"跳过"）')
})

test('importKnowledge：整批级错误保留 status 与内核错误码（403 只读空间 / 413 超批）', async () => {
  mockFetch(() => json({ error: 'readonly-space: space 不得以 "pack-" 开头（知识包空间只读）', code: 'readonly-space' }, 403))
  const ro = await importKnowledge({ from: 'D:/x', spaceId: 'pack-demo' }, { baseUrl: BASE })
  assert.deepEqual(ro, {
    ok: false, status: 403,
    error: 'readonly-space: space 不得以 "pack-" 开头（知识包空间只读）',
  })

  mockFetch(() => json({ error: 'too-many-files: 文件数 501 超出单批上限 500（请分批导入）' }, 413))
  const many = await importKnowledge({ from: 'D:/big', spaceId: 'declare' }, { baseUrl: BASE })
  assert.equal(many.ok === false && many.status, 413, '413 与 400 的处置不同（分批重试 vs 改参数），不能被压成同一个码')
  assert.match(many.ok === false ? many.error : '', /too-many-files/)
})

test('importKnowledge：不过 dedupe —— 并发同参调用是两个请求（写路径不合并意图）', async () => {
  let n = 0
  mockFetch(() => {
    n++
    return new Promise<Response>((resolve) => setTimeout(() => resolve(json({
      ok: true, spaceId: 'declare', spaceName: 'D', spaceCreated: false, dryRun: false, source: 'D:/x',
      counts: { total: 0, converted: 0, skipped: 0, failed: 0 }, converted: [], skipped: [], failed: [],
      indexSync: 'none', warnings: [],
    })), 5))
  })
  await Promise.all([
    importKnowledge({ from: 'D:/x', spaceId: 'declare' }, { baseUrl: BASE }),
    importKnowledge({ from: 'D:/x', spaceId: 'declare' }, { baseUrl: BASE }),
  ])
  assert.equal(n, 2, '导入有副作用且耗时分钟级：被 dedupe 合并会掩盖"用户改了目标空间后重试"')
})

test('同 key 并发去重：复用同一 promise，只发一次 fetch', async () => {
  let n = 0
  mockFetch(() => {
    n++
    return new Promise<Response>((resolve) => setTimeout(() => resolve(json({ spaces: [] })), 5))
  })
  const [a, b] = await Promise.all([listSpaces({ baseUrl: BASE }), listSpaces({ baseUrl: BASE })])
  assert.equal(n, 1, '并发同 key 必须只打一次（乱序覆盖同样由此根除）')
  assert.deepEqual(a, b)
  assert.deepEqual(a, { ok: true, data: { spaces: [] } })

  // 落定后从在途表摘除：下一次调用是新请求（缓存由 useKnowledge 负责，不在 http 层）
  await listSpaces({ baseUrl: BASE })
  assert.equal(n, 2)
})

// —— 删除管理 / 回收站（2026-09-14）——
// 这组用例的重点不是"能不能删"，而是**方法/参数名/严格布尔**三件事：
// 参数名写错不会报错（后端只当没收到 → 内核按"缺参"拒或按默认值走），
// 而 `all` 的严格性直接关系到"会不会一次清空整个回收站"。

test('listTrash：GET /knowledge/trash，无查询串', async () => {
  const payload = { dir: 'C:/k/.trash', count: 1, bytes: 9, stray: 0, items: [{ trashId: '20260914-1630-ab12' }] }
  mockFetch(() => json(payload))
  const r = await listTrash({ baseUrl: BASE })
  assert.equal(calls[0].init?.method, 'GET')
  assert.equal(url().pathname, '/knowledge/trash')
  assert.equal(url().search, '')
  assert.deepEqual(r, { ok: true, data: payload })
})

test('deleteDoc：DELETE /knowledge/delete，body 用 spaceId（不是 space）', async () => {
  mockFetch(() => json({ ok: true, kind: 'doc', spaceId: '研发资料', path: 'a.md', trashId: '20260914-1630-ab12' }))
  const r = await deleteDoc('研发资料', 'sub/b.md', { baseUrl: BASE })
  assert.equal(calls[0].init?.method, 'DELETE')
  assert.equal(url().pathname, '/knowledge/delete')
  // 后端同时接受 spaceId/space，但**前端只该发一个**：两个都发会让"哪个生效"变得不可判
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { spaceId: '研发资料', path: 'sub/b.md' })
  assert.equal(r.ok, true)
})

test('deleteSpace：DELETE /knowledge/delete-space，必须带上 confirm（手打库名）', async () => {
  mockFetch(() => json({ ok: true, kind: 'space', spaceId: '研发资料', trashId: '20260914-1630-ab12' }))
  await deleteSpace('研发资料', '研发资料', { baseUrl: BASE })
  assert.equal(calls[0].init?.method, 'DELETE')
  assert.equal(url().pathname, '/knowledge/delete-space')
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { spaceId: '研发资料', confirm: '研发资料' })
})

test('restoreTrash / purgeTrash：DELETE，且 purge 的 all 严格 true', async () => {
  mockFetch(() => json({ ok: true, purged: 1 }))
  await restoreTrash('20260914-1630-ab12', { baseUrl: BASE })
  assert.equal(url(0).pathname, '/knowledge/restore')
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { trashId: '20260914-1630-ab12' })

  mockFetch(() => json({ ok: true }))
  await purgeTrash({ all: true }, { baseUrl: BASE })
  assert.equal(url(0).pathname, '/knowledge/purge')
  // 必须是**布尔 true**：服务端只认 `=== true`，发 `"true"` 会被当成"单条删除"
  // （跑完才发现没清空，或更糟——以为清了其实没清）
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { all: true })

  mockFetch(() => json({ ok: true }))
  await purgeTrash({ trashId: '20260914-1630-ab12' }, { baseUrl: BASE })
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { trashId: '20260914-1630-ab12' })
})

test('删除类端点：错误响应里的 message 必须透出（否则用户只看到 confirm-mismatch）', async () => {
  mockFetch(() => json({ error: 'confirm-mismatch', message: 'delete-space: 需要 --confirm <空间id>' }, 400))
  const r = await deleteSpace('研发资料', '错的', { baseUrl: BASE })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.error, 'confirm-mismatch')   // 机器可判的码（UI 用它选文案）
  assert.equal(r.message, 'delete-space: 需要 --confirm <空间id>')  // 人类可读的补充说明
  assert.equal(r.status, 400)

  // 后端没给 message 时**不得凭空造一个空字段**：老端点的调用方按 shape 断言会被全量失配
  mockFetch(() => json({ error: 'not-found' }, 404))
  const r2 = await deleteDoc('研发资料', 'x.md', { baseUrl: BASE })
  assert.equal(r2.ok, false)
  if (r2.ok) return
  assert.equal(r2.error, 'not-found')
  assert.equal('message' in r2, false)
})

test('删除类端点：403/410/409 的状态码要原样透出（GUI 据此区分提示）', async () => {
  for (const [code, status] of [['protected-space', 403], ['payload-missing', 410], ['space-exists', 409]] as const) {
    mockFetch(() => json({ error: code }, status))
    const r = await deleteSpace('experience', 'experience', { baseUrl: BASE })
    assert.equal(r.ok, false)
    if (r.ok) continue
    assert.equal(r.status, status, code)
  }
})

test('删除类端点：不做 inflight 去重（删除有副作用，重复点必须各发一次）', async () => {
  let n = 0
  mockFetch(() => { n += 1; return json({ ok: true, trashId: `t${n}` }) })
  // 两次并发调用同一篇文档：若被去重合并成一个请求，第二次点击的"文件已不存在"
  // 反馈就永远拿不到（而用户是看着第一次的结果以为没生效才点第二次的）
  const [a, b] = await Promise.all([
    deleteDoc('研发资料', 'a.md', { baseUrl: BASE }),
    deleteDoc('研发资料', 'a.md', { baseUrl: BASE }),
  ])
  assert.equal(calls.length, 2, '删除请求不得被去重')
  assert.equal(a.ok && b.ok, true)
})
