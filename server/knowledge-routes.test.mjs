// /knowledge/* 路由测试：**直调 handler + 注入假 callKernel**。
// 纪律：不起 bridge、不起内核子进程（本仓库有"测试起桥误杀运行中应用"的前车之鉴）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleKnowledgeRoute, safeRelPath } from './knowledge-routes.mjs'
import { writeZip } from '../shared/pack-zip.mjs'

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

// ── S4 Task 4：知识包生态路由（市场/详情/安装/卸载/导出）─────────────────────
// 纪律同前：**注入 home（临时目录）+ 假 fetcher**，不起 bridge、不真联网。
// 前 210 行是 S1/S2/S3 的既有用例，它们**不注入** home/fetcher —— 那批必须继续全绿，
// 这才是"既有路由行为不变"的守卫（新注入点只被 /knowledge/packs* 消费）。

function packsCtx({ method = 'GET', url = '/knowledge/packs', body = null, home, fetcher, config, appVersion, callKernel } = {}) {
  const u = new URL(`http://x${url}`)
  return {
    method, pathname: u.pathname, searchParams: u.searchParams,
    readJsonBody: async () => body,
    callKernel: callKernel || (async () => '{}'),
    home,   // 必须注入：缺省是真实 resolveYfwHome()，测试绝不碰真实 home
    fetcher, config, appVersion,
  }
}

const packZipBuf = (id = 'gaoqi-2026', version = '1.0.0', extra = {}) => writeZip([
  { name: 'pack.json', data: JSON.stringify({ id, name: '高企包', version, license: 'MIT', source: 'content', ...extra }) },
  { name: 'README.md', data: '# 读我\n' },
  { name: 'content/a.md', data: '# 研发费用占比\n' },
])

function fakeFetch(routes) {
  const calls = []
  const fn = async (url) => {
    calls.push(String(url))
    const hit = routes[String(url)]
    if (hit === undefined) return new Response('nope', { status: 404 })
    if (hit instanceof Uint8Array) return new Response(hit, { status: 200 })
    return new Response(typeof hit === 'string' ? hit : JSON.stringify(hit), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  fn.calls = calls
  return fn
}

test('GET /knowledge/packs：清单不可用仍返回已装列表（离线可用）+ 在线安装缺清单 → 502', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ponos-kr-packs-'))
  try {
    let r = await handleKnowledgeRoute(packsCtx({ home, fetcher: fakeFetch({}) }))
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.packs, [])
    assert.ok(r.body.indexError, '清单拉不到要显式告知（市场仍可本地安装）')
    // 没有本地清单时 source='remote'（尝试过远程并失败）；失败原因在 indexError 里
    assert.equal(r.body.source, 'remote')

    r = await handleKnowledgeRoute(packsCtx({
      method: 'POST', url: '/knowledge/packs/install', home, fetcher: fakeFetch({}), body: { id: 'gaoqi-2026' },
    }))
    assert.equal(r.status, 502, '在线安装但清单不可用 → 502（不是 500：上游不可用）')

    const zipPath = join(home, 'p.zip')
    writeFileSync(zipPath, packZipBuf())
    r = await handleKnowledgeRoute(packsCtx({
      method: 'POST', url: '/knowledge/packs/install', home, fetcher: fakeFetch({}), body: { localPath: zipPath },
    }))
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.status, 'installed')

    r = await handleKnowledgeRoute(packsCtx({ home, fetcher: fakeFetch({}) }))
    assert.deepEqual(r.body.packs.map((p) => p.id), ['gaoqi-2026'])
    assert.equal(r.body.packs[0].onDisk, true)
    assert.equal(r.body.packs[0].installedVersion, '1.0.0')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('GET /knowledge/packs：清单条目 + 已装 → installedVersion / updateAvailable', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ponos-kr-packs2-'))
  try {
    const zipPath = join(home, 'p.zip')
    writeFileSync(zipPath, packZipBuf('gaoqi-2026', '1.0.0'))
    await handleKnowledgeRoute(packsCtx({ method: 'POST', url: '/knowledge/packs/install', home, fetcher: fakeFetch({}), body: { localPath: zipPath } }))

    const reg = 'https://registry.invalid/kp'
    const fetcher = fakeFetch({ [`${reg}/index.json`]: { packs: [{ id: 'gaoqi-2026', name: '高企包', version: '1.2.0', tags: ['政策'] }, { id: 'other-pack', name: '别的', version: '0.1.0' }] } })
    const r = await handleKnowledgeRoute(packsCtx({ home, fetcher, config: { knowledgePackRegistry: reg } }))
    assert.equal(r.status, 200)
    assert.equal(r.body.source, 'remote')
    assert.equal(r.body.registryOrigin, 'config')
    const mine = r.body.packs.find((p) => p.id === 'gaoqi-2026')
    assert.equal(mine.installedVersion, '1.0.0')
    assert.equal(mine.updateAvailable, true)
    assert.equal(r.body.packs.find((p) => p.id === 'other-pack').onDisk, false)
    assert.equal(r.body.packs.find((p) => p.id === 'other-pack').updateAvailable, false)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('POST /knowledge/packs/install：本地 zip 安装 / kept-user-modified(403) / overwrite / 卸载', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ponos-kr-packs3-'))
  try {
    const zip = join(home, 'p.zip')
    writeFileSync(zip, packZipBuf())
    let r = await handleKnowledgeRoute(packsCtx({ method: 'POST', url: '/knowledge/packs/install', home, fetcher: fakeFetch({}), body: { localPath: zip } }))
    assert.equal(r.status, 200)
    assert.equal(r.body.spaceId, 'pack-gaoqi-2026')

    // 用户改过包内文件 → 403（未写盘），错误码供前端弹三选
    writeFileSync(join(home, 'knowledge', 'packs', 'gaoqi-2026', 'content', 'a.md'), '# 我改的\n')
    writeFileSync(zip, packZipBuf('gaoqi-2026', '1.1.0'))
    r = await handleKnowledgeRoute(packsCtx({ method: 'POST', url: '/knowledge/packs/install', home, fetcher: fakeFetch({}), body: { localPath: zip } }))
    assert.equal(r.status, 403)
    assert.equal(r.body.error, 'kept-user-modified')
    assert.deepEqual(r.body.conflicts, ['content/a.md'])
    assert.equal(readFileSync(join(home, 'knowledge', 'packs', 'gaoqi-2026', 'content', 'a.md'), 'utf-8'), '# 我改的\n', '冲突态不写盘')

    r = await handleKnowledgeRoute(packsCtx({ method: 'POST', url: '/knowledge/packs/install', home, fetcher: fakeFetch({}), body: { localPath: zip, mode: 'overwrite' } }))
    assert.equal(r.status, 200)
    assert.equal(r.body.status, 'updated')

    // 参数校验：路径不存在 / 非 zip
    r = await handleKnowledgeRoute(packsCtx({ method: 'POST', url: '/knowledge/packs/install', home, fetcher: fakeFetch({}), body: { localPath: join(home, 'nope.zip') } }))
    assert.equal(r.status, 400)
    writeFileSync(join(home, 'a.md'), '# a\n')
    r = await handleKnowledgeRoute(packsCtx({ method: 'POST', url: '/knowledge/packs/install', home, fetcher: fakeFetch({}), body: { localPath: join(home, 'a.md') } }))
    assert.equal(r.status, 400)

    // 卸载
    r = await handleKnowledgeRoute(packsCtx({ method: 'POST', url: '/knowledge/packs/uninstall', home, fetcher: fakeFetch({}), body: { id: 'gaoqi-2026' } }))
    assert.equal(r.status, 200)
    assert.equal(r.body.removedCount, 3)
    r = await handleKnowledgeRoute(packsCtx({ method: 'POST', url: '/knowledge/packs/uninstall', home, fetcher: fakeFetch({}), body: { id: '../x' } }))
    assert.equal(r.status, 400)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('POST /knowledge/packs/install：恶意 zip（条目名含 ../）→ 400 且不留残留', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ponos-kr-packs4-'))
  try {
    const zip = join(home, 'evil.zip')
    // `writeZip` 自己会净化条目名，造不出 `../`——故在合法包的字节里把名字等长替换成 `../`，
    // 模拟"用户从网上抓到的恶意包"。本地头与中央目录两处都要改（否则 CRC 校验先拦，测不到穿越）。
    const buf = packZipBuf('evil-pack', '1.0.0')
    const from = Buffer.from('content/a.md', 'utf-8')
    const to = Buffer.from('../////a.md', 'utf-8')   // 12 字节，等长
    let idx = 0
    let hits = 0
    while ((idx = buf.indexOf(from, idx)) >= 0) { to.copy(buf, idx); hits += 1; idx += from.length }
    assert.ok(hits >= 2, '本地头与中央目录都要改')
    writeFileSync(zip, buf)

    const r = await handleKnowledgeRoute(packsCtx({ method: 'POST', url: '/knowledge/packs/install', home, fetcher: fakeFetch({}), body: { localPath: zip } }))
    assert.equal(r.status, 400)
    assert.ok(r.body.errors.some((e) => e.includes('上跳路径段')), JSON.stringify(r.body.errors))
    assert.equal(existsSync(join(home, 'knowledge', 'packs', 'evil-pack')), false)
    const leftovers = existsSync(join(home, 'knowledge')) ? readdirSync(join(home, 'knowledge')).filter((n) => n.startsWith('.packs-staging-')) : []
    assert.deepEqual(leftovers, [], 'staging 必须清理干净')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('GET /knowledge/packs/detail：详情 / 版本不兼容 409 / 非法 id 400 / 未知 id 404', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ponos-kr-packs5-'))
  try {
    const reg = 'https://registry.invalid/kp'
    const fetcher = fakeFetch({
      [`${reg}/index.json`]: { packs: [{ id: 'ok-pack', version: '1.0.0' }, { id: 'new-app', version: '2.0.0' }] },
      [`${reg}/packs/ok-pack/pack.json`]: { id: 'ok-pack', name: '好包', version: '1.0.0', license: 'MIT', source: 'content' },
      [`${reg}/packs/new-app/pack.json`]: { id: 'new-app', name: '新包', version: '2.0.0', license: 'MIT', source: 'content', minAppVersion: '9.0.0' },
    })
    const base = { home, fetcher, config: { knowledgePackRegistry: reg }, appVersion: '3.0.0' }
    let r = await handleKnowledgeRoute(packsCtx({ ...base, url: '/knowledge/packs/detail?id=ok-pack' }))
    assert.equal(r.status, 200)
    assert.equal(r.body.pack.id, 'ok-pack')
    assert.equal(r.body.installed, null)

    r = await handleKnowledgeRoute(packsCtx({ ...base, url: '/knowledge/packs/detail?id=new-app' }))
    assert.equal(r.status, 409, '版本不兼容且无回退 → 409（可换版本/需升级，不是坏包）')
    assert.equal(r.body.code, 'needs-higher-app')

    assert.equal((await handleKnowledgeRoute(packsCtx({ ...base, url: '/knowledge/packs/detail?id=../etc' }))).status, 400)
    assert.equal((await handleKnowledgeRoute(packsCtx({ ...base, url: '/knowledge/packs/detail?id=ghost' }))).status, 404)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('POST /knowledge/packs/export：只允许可写空间（只读包空间 403），产出 zip + 清单片段', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ponos-kr-packs6-'))
  const spaceRoot = mkdtempSync(join(tmpdir(), 'ponos-kr-space-'))
  try {
    writeFileSync(join(spaceRoot, 'a.md'), '# 政策\n')
    const callKernel = fakeKernel({ spaces: { spaces: [
      { id: 'my-space', root: spaceRoot, writable: true, source: 'user' },
      { id: 'pack-x', root: spaceRoot, writable: false, source: 'pack' },
    ] } })
    let r = await handleKnowledgeRoute(packsCtx({
      method: 'POST', url: '/knowledge/packs/export', home, fetcher: fakeFetch({}), callKernel,
      body: { spaceId: 'my-space', id: 'my-space-pack', version: '1.0.0', license: 'MIT', author: '张三' },
    }))
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.equal(existsSync(r.body.zipPath), true)
    assert.equal(r.body.packJson.source, 'content')
    assert.equal(r.body.manifestEntry.id, 'my-space-pack')

    r = await handleKnowledgeRoute(packsCtx({
      method: 'POST', url: '/knowledge/packs/export', home, fetcher: fakeFetch({}), callKernel,
      body: { spaceId: 'pack-x', id: 'x', version: '1.0.0', license: 'MIT' },
    }))
    assert.equal(r.status, 403, '只读包空间不能导出')

    r = await handleKnowledgeRoute(packsCtx({
      method: 'POST', url: '/knowledge/packs/export', home, fetcher: fakeFetch({}), callKernel,
      body: { spaceId: 'ghost', id: 'x', version: '1.0.0', license: 'MIT' },
    }))
    assert.equal(r.status, 404)

    r = await handleKnowledgeRoute(packsCtx({
      method: 'POST', url: '/knowledge/packs/export', home, fetcher: fakeFetch({}), callKernel,
      body: { spaceId: 'my-space', id: 'my-space-pack2', version: '1.0.0' },
    }))
    assert.equal(r.status, 400, '缺 license → 400')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(spaceRoot, { recursive: true, force: true })
  }
})
