// /knowledge/* 路由测试：**直调 handler + 注入假 callKernel**。
// 纪律：不起 bridge、不起内核子进程（本仓库有"测试起桥误杀运行中应用"的前车之鉴）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleKnowledgeRoute, safeRelPath } from './knowledge-routes.mjs'

function ctx({ method = 'GET', url = '/knowledge/spaces', body = null, callKernel } = {}) {
  const u = new URL(`http://x${url}`)
  return {
    method,
    pathname: u.pathname,
    searchParams: u.searchParams,
    readJsonBody: async () => body,
    callKernel: callKernel || (async () => '{}'),
  }
}

/** 假内核：把 argsList 记录在 calls 里，按预设应答 */
function fakeKernel(responses = {}) {
  const calls = []
  const fn = async (argsList) => {
    calls.push(argsList)
    const key = argsList.filter((a) => a.startsWith('--knowledge'))[0] + ':' + argsList[1]
    const val = responses[argsList[1]] ?? responses[key] ?? {}
    return typeof val === 'string' ? val : JSON.stringify(val)
  }
  fn.calls = calls
  return fn
}

test('未匹配路径返回 null（交给后续路由）', async () => {
  const r = await handleKnowledgeRoute(ctx({ url: '/files' }))
  assert.equal(r, null)
})

test('方法不符（POST 读端点）也返回 null，不冒充 405', async () => {
  const r = await handleKnowledgeRoute(ctx({ method: 'POST', url: '/knowledge/spaces' }))
  assert.equal(r, null)
})

test('GET /knowledge/spaces 转发到内核并回传 spaces', async () => {
  const callKernel = fakeKernel({ spaces: { spaces: [{ id: 'experience', docCount: 7, writable: true }] } })
  const r = await handleKnowledgeRoute(ctx({ callKernel }))
  assert.equal(r.status, 200)
  assert.equal(r.body.spaces[0].id, 'experience')
  assert.deepEqual(callKernel.calls[0], ['--knowledge', 'spaces'])
})

test('GET /knowledge/search 组装参数字典序（含 keywords 与 topK）', async () => {
  const callKernel = fakeKernel({ search: { items: [], count: 0, degraded: false, indexAge: 1 } })
  const r = await handleKnowledgeRoute(ctx({
    url: '/knowledge/search?q=%E5%9B%9B%E8%A1%A8&keywords=a,b&topK=3&mode=full&spaces=experience',
    callKernel,
  }))
  assert.equal(r.status, 200)
  const args = callKernel.calls[0]
  assert.equal(args[1], 'search')
  assert.equal(args[args.indexOf('--query') + 1], '四表')
  assert.equal(args[args.indexOf('--keywords') + 1], 'a,b')
  assert.equal(args[args.indexOf('--topK') + 1], '3')
  assert.equal(args[args.indexOf('--mode') + 1], 'full')
  assert.equal(args[args.indexOf('--space') + 1], 'experience')
})

test('内核报错时返回 500 且带 error 文案（不抛给调用方）', async () => {
  const callKernel = async () => { throw new Error('kernel boom') }
  const r = await handleKnowledgeRoute(ctx({ url: '/knowledge/stats', callKernel }))
  assert.equal(r.status, 500)
  assert.match(String(r.body.error), /kernel boom/)
})

test('内核返回非 JSON 时返回 502（不把垃圾塞给前端）', async () => {
  const callKernel = async () => 'not json at all'
  const r = await handleKnowledgeRoute(ctx({ url: '/knowledge/stats', callKernel }))
  assert.equal(r.status, 502)
})

test('safeRelPath 拒绝穿越/绝对路径/非 md，接受正常相对路径', () => {
  assert.equal(safeRelPath('a/b.md'), 'a/b.md')
  assert.equal(safeRelPath('a\\b.md'), 'a/b.md')
  assert.equal(safeRelPath('../etc/passwd.md'), null)
  assert.equal(safeRelPath('a/../../x.md'), null)
  assert.equal(safeRelPath('/abs/x.md'), null)
  assert.equal(safeRelPath('C:/x.md'), null)
  assert.equal(safeRelPath('a/b.txt'), null)
  assert.equal(safeRelPath(''), null)
})

test('POST /knowledge/doc 落盘到可写空间并触发增量索引', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kr-'))
  const spaceRoot = join(dir, 'spaces', 'notes')
  mkdirSync(spaceRoot, { recursive: true })
  try {
    const callKernel = fakeKernel({
      spaces: { spaces: [{ id: 'notes', writable: true, root: spaceRoot }] },
      'update-doc': { updated: true },
    })
    const r = await handleKnowledgeRoute(ctx({
      method: 'POST', url: '/knowledge/doc', callKernel,
      body: { spaceId: 'notes', path: 'sub/new.md', content: '# 新文档\n\n正文。\n' },
    }))
    assert.equal(r.status, 200)
    assert.equal(r.body.docId, 'notes/sub/new.md')
    assert.equal(readFileSync(join(spaceRoot, 'sub', 'new.md'), 'utf-8'), '# 新文档\n\n正文。\n')
    assert.ok(callKernel.calls.some((a) => a[1] === 'update-doc'), '触发增量更新')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('POST /knowledge/doc 对只读空间返回 403 且不落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kr-ro-'))
  try {
    const callKernel = fakeKernel({ spaces: { spaces: [{ id: 'pack-x', writable: false, root: dir }] } })
    const r = await handleKnowledgeRoute(ctx({
      method: 'POST', url: '/knowledge/doc', callKernel,
      body: { spaceId: 'pack-x', path: 'a.md', content: 'x' },
    }))
    assert.equal(r.status, 403)
    assert.ok(!existsSync(join(dir, 'a.md')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('POST /knowledge/doc 路径穿越返回 400/403 且不落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kr-trav-'))
  const spaceRoot = join(dir, 'notes')
  mkdirSync(spaceRoot, { recursive: true })
  try {
    const callKernel = fakeKernel({ spaces: { spaces: [{ id: 'notes', writable: true, root: spaceRoot }] } })
    const r = await handleKnowledgeRoute(ctx({
      method: 'POST', url: '/knowledge/doc', callKernel,
      body: { spaceId: 'notes', path: '../escaped.md', content: 'x' },
    }))
    assert.ok(r.status === 400 || r.status === 403)
    assert.ok(!existsSync(join(dir, 'escaped.md')), '未逃出空间根')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('POST /knowledge/doc 空间内符号链接指向外部时被挡（realpath 防护）', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kr-link-'))
  const spaceRoot = join(dir, 'notes')
  const outside = join(dir, 'outside')
  mkdirSync(spaceRoot, { recursive: true })
  mkdirSync(outside, { recursive: true })
  try {
    try { symlinkSync(outside, join(spaceRoot, 'link'), 'junction') }
    catch { t.skip('本机无创建符号链接的权限，跳过 realpath 防护断言'); return }
    const callKernel = fakeKernel({ spaces: { spaces: [{ id: 'notes', writable: true, root: spaceRoot }] } })
    const r = await handleKnowledgeRoute(ctx({
      method: 'POST', url: '/knowledge/doc', callKernel,
      body: { spaceId: 'notes', path: 'link/evil.md', content: 'x' },
    }))
    assert.equal(r.status, 403)
    assert.ok(!existsSync(join(outside, 'evil.md')), '内容不得落到空间根之外')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('POST /knowledge/doc 未知空间返回 404', async () => {
  const callKernel = fakeKernel({ spaces: { spaces: [{ id: 'notes', writable: true, root: '/tmp/x' }] } })
  const r = await handleKnowledgeRoute(ctx({
    method: 'POST', url: '/knowledge/doc', callKernel,
    body: { spaceId: 'nope', path: 'a.md', content: 'x' },
  }))
  assert.equal(r.status, 404)
})

test('POST /knowledge/doc 超限内容返回 413', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kr-big-'))
  const spaceRoot = join(dir, 'notes')
  mkdirSync(spaceRoot, { recursive: true })
  try {
    const callKernel = fakeKernel({ spaces: { spaces: [{ id: 'notes', writable: true, root: spaceRoot }] } })
    const r = await handleKnowledgeRoute(ctx({
      method: 'POST', url: '/knowledge/doc', callKernel,
      body: { spaceId: 'notes', path: 'a.md', content: 'x'.repeat(3 * 1024 * 1024) },
    }))
    assert.equal(r.status, 413)
    assert.ok(!existsSync(join(spaceRoot, 'a.md')), '超限内容不落盘')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('POST /knowledge/reindex 走 force', async () => {
  const callKernel = fakeKernel({ reindex: { ok: true, docs: 4 } })
  const r = await handleKnowledgeRoute(ctx({ method: 'POST', url: '/knowledge/reindex', callKernel }))
  assert.equal(r.status, 200)
  assert.deepEqual(callKernel.calls[0], ['--knowledge', 'reindex', '--force'])
})

test('POST /knowledge/doc 接受 `space` 字段（与 GET 路由的 ?space= 命名一致）', async () => {
  // 契约歧义防护：GET 系列一律用 `space=`，若 POST 请求体只认 `spaceId`，S2 前端按 GET 的
  // 习惯发 `{space}` 会得到 404「space not found」——报错文本指向"空间不存在"而非"字段名写错"，
  // 极难定位。两种命名都应可用（`spaceId` 为主，对齐内部 Doc 模型）。
  const writes = []
  const fake = async (args) => {
    if (args.includes('spaces')) {
      return JSON.stringify({ spaces: [{ id: 'notes', root: tmpdir(), writable: true, source: 'user' }] })
    }
    if (args.includes('update-doc')) { writes.push(args); return JSON.stringify({ updated: true }) }
    return '{}'
  }
  for (const field of [{ space: 'notes' }, { spaceId: 'notes' }]) {
    const res = await handleKnowledgeRoute(ctx({
      method: 'POST', url: '/knowledge/doc', callKernel: fake,
      body: { ...field, path: 'ok.md', content: '# ok\n' },
    }))
    assert.equal(res.status, 200, `${JSON.stringify(field)} 应被接受`)
  }
  assert.equal(writes.length, 2, '两次写入都应触发增量更新')
})
