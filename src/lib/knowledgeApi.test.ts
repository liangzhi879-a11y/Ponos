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
  clearKnowledgeInflight,
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
