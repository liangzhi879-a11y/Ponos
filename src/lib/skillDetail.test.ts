// src/lib/skillDetail.test.ts
// 技能详情客户端（2026-09-15，P1 批次二 C）。
//
// 重点：**失败必须可区分、可展示**（404 = 技能已被删除/移动；网络异常 = 桥未就绪；HTTP 错误 = 服务端问题）。
// 若都笼统返回空对象，界面只能渲染一张空白详情面板 —— 用户会以为是界面坏了，而不是"这个技能没了"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchSkillDetail, openLocalPath } from './skillDetail.ts'

function stubFetch(handler: (url: string, init?: RequestInit) => { status?: number; body?: unknown; throwErr?: boolean }) {
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push(String(url))
    const r = handler(String(url), init)
    if (r.throwErr) throw new Error('network down')
    const status = r.status ?? 200
    return { ok: status >= 200 && status < 300, status, json: async () => r.body, text: async () => '' } as unknown as Response
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

const DETAIL = {
  ok: true, id: 'demo', dir: '/tmp/demo', skillFile: '/tmp/demo/SKILL.md', isFlat: false,
  triggers: ['触发一'], parent: 'p1', parentSource: 'explicit' as const, subskills: [],
  scripts: [{ name: 'run.py', path: '/tmp/demo/run.py', sizeKb: 1 }], docs: [], contentLines: 10,
}

test('正常：返回详情对象，且请求带 id 参数（URL 编码防技能名含特殊字符）', async () => {
  const s = stubFetch(() => ({ body: DETAIL }))
  try {
    const d = await fetchSkillDetail('demo')
    assert.ok(!('error' in d))
    assert.equal(d.id, 'demo')
    assert.equal(d.parentSource, 'explicit')
    assert.match(s.calls[0], /\/skill-detail\?id=demo/)

    await fetchSkillDetail('a b/c')
    assert.match(s.calls[1], /id=a%20b%2Fc/, '必须编码（技能名可能含空格或斜杠）')
  } finally { s.restore() }
})

test('404 → 明确标记 not-found（界面据此说"已在磁盘上不存在"）', async () => {
  const s = stubFetch(() => ({ status: 404, body: {} }))
  try {
    const d = await fetchSkillDetail('ghost')
    assert.deepEqual(d, { error: 'not-found' }, '404 必须可区分：用户要的是"技能没了"这句解释，不是空白面板')
  } finally { s.restore() }
})

test('HTTP 5xx → 带状态码的错误（便于排查是服务端还是别的问题）', async () => {
  const s = stubFetch(() => ({ status: 500, body: {} }))
  try {
    const d = await fetchSkillDetail('demo')
    assert.ok('error' in d)
    assert.match(d.error, /500/)
  } finally { s.restore() }
})

test('网络异常 → 错误而不是抛（桥未就绪时面板不该崩）', async () => {
  const s = stubFetch(() => ({ throwErr: true }))
  try {
    const d = await fetchSkillDetail('demo')
    assert.ok('error' in d)
    assert.match(d.error, /network down/)
  } finally { s.restore() }
})

test('ok:false 的 200 响应（handler 内部错误）也按错误处理', async () => {
  const s = stubFetch(() => ({ body: { ok: false, error: '读取失败：EACCES' } }))
  try {
    const d = await fetchSkillDetail('demo')
    assert.ok('error' in d)
    assert.match(d.error, /EACCES/)
  } finally { s.restore() }
})

// ── openLocalPath（D2 的"管理"动作 = 系统打开文件）──────────────────────────

test('openLocalPath：走 Electron 既有 IPC openInExplorer', async () => {
  const g = globalThis as unknown as { yfworkingAPI?: unknown }
  const original = g.yfworkingAPI
  try {
    const seen: string[] = []
    g.yfworkingAPI = { openInExplorer: async (p: string) => { seen.push(p); return { ok: true } } }
    assert.equal(await openLocalPath('/tmp/a.md'), null, '成功返回 null')
    assert.deepEqual(seen, ['/tmp/a.md'])
  } finally { g.yfworkingAPI = original }
})

test('openLocalPath：IPC 报错时返回错误文案（不静默）', async () => {
  const g = globalThis as unknown as { yfworkingAPI?: unknown }
  const original = g.yfworkingAPI
  try {
    g.yfworkingAPI = { openInExplorer: async () => ({ ok: false, error: 'EACCES' }) }
    assert.equal(await openLocalPath('/tmp/a.md'), 'EACCES')

    g.yfworkingAPI = { openInExplorer: async () => { throw new Error('ipc down') } }
    assert.match(String(await openLocalPath('/tmp/a.md')), /ipc down/, '抛出的异常也要转成可展示文案')
  } finally { g.yfworkingAPI = original }
})

test('openLocalPath：非 Electron 环境（无 IPC）→ 明确报"不支持"', async () => {
  const g = globalThis as unknown as { yfworkingAPI?: unknown }
  const original = g.yfworkingAPI
  try {
    delete g.yfworkingAPI
    assert.match(String(await openLocalPath('/tmp/a.md')), /不支持/, '静默无反应会让用户以为这是正常的')
  } finally { g.yfworkingAPI = original }
})
