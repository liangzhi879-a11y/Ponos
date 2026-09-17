// src/lib/teamApi.test.ts —— S3 桥面客户端的单测（2026-09-17）
//
// 为什么测这些点（不是凑覆盖率）：
//   ① **永不抛出**：桥没起/端口不通时抛出去，渲染期直接白屏，用户看不到任何原因；
//   ② **reason 必须原样透传**：内核刻意区分了 `bad-code` / `expired` / `already-used`，
//      吞成一句"加入失败"就等于把"错码可以重试、过期/用过重试也没用"这个区分抹掉；
//   ③ **不自造端点**：路由表必须与 `server/bridge.mjs` 的既有 6 段一致（源码级断言）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  TEAM_ROUTES, getTeamStatus, createTeam, joinTeam, inviteMember, revokeTeamMember,
  setTeamSearchRoot, normalizeTeamStatus,
} from './teamApi.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')

/** 用可编排 stub 替换全局 fetch（照 mcpApi.test.ts 范式） */
function stubFetch(handler: (url: string, init?: RequestInit) => { status?: number; body?: unknown; throwErr?: boolean }) {
  const original = globalThis.fetch
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const r = handler(String(url), init)
    if (r.throwErr) throw new Error('network down')
    const status = r.status ?? 200
    return { ok: status >= 200 && status < 300, status, json: async () => r.body } as unknown as Response
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

const bodyOf = (c: { init?: RequestInit }) => JSON.parse(String(c.init?.body ?? '{}')) as Record<string, unknown>

test('路由表：只有既有 6 个端点，且每个都真的存在于 server/bridge.mjs（不自造端点）', () => {
  assert.deepEqual(Object.keys(TEAM_ROUTES).sort(), ['create', 'invite', 'join', 'revoke', 'searchRoot', 'status'])
  const bridge = readFileSync(join(REPO, 'server', 'bridge.mjs'), 'utf8')
  for (const path of Object.values(TEAM_ROUTES)) {
    assert.ok(
      bridge.includes(`'${path}'`),
      `server/bridge.mjs 里没有 ${path}：渲染层不得自造端点（缺端点必须在报告里说明并只加最小端点）`,
    )
  }
  assert.equal(TEAM_ROUTES.status, '/team/status')
  assert.equal(TEAM_ROUTES.searchRoot, '/team/search-root')
})

test('getTeamStatus：归一成员表与完整性；空团队列表不是错误', async () => {
  const s = stubFetch(() => ({
    body: {
      ok: true,
      deviceId: 'd_1',
      searchRoot: 'C:/Drive',
      teams: [{
        teamId: 't_1', ok: true, name: '研发一组', dir: 'C:/Drive/team-a', identCode: '483920517',
        me: { memberId: 'u_a', role: 'owner', fingerprint: 'fp:1' },
        memberCount: 2,
        members: [
          { memberId: 'u_a', role: 'owner', status: 'active', fingerprint: 'fp:1' },
          { memberId: 'u_b', role: 'editor', status: 'removed' },
          { garbage: 1 },
        ],
        integrity: { ok: false, errors: [{ index: 3, reason: 'sig-mismatch' }] },
        copies: 2, warnings: ['git-in-team-source'],
      }],
    },
  }))
  try {
    const r = await getTeamStatus('http://127.0.0.1:1')
    assert.equal(r.ok, true)
    assert.equal(r.teams.length, 1)
    const t = r.teams[0]
    assert.equal(t.members.length, 2, '缺 memberId 的脏条目要被丢弃而不是渲染成空行')
    assert.equal(t.members[1].status, 'removed')
    assert.equal(t.integrity.ok, false, '验签失败必须透出（界面要告警，不能假装没事）')
    assert.equal(t.integrity.errors.length, 1)
    assert.equal(t.copies, 2)
    assert.deepEqual(t.warnings, ['git-in-team-source'])
    assert.equal(t.me?.role, 'owner')
  } finally { s.restore() }
})

test('getTeamStatus：脏形状不崩（桥版本不匹配/字段类型不对）', () => {
  const r = normalizeTeamStatus({ ok: true, teams: [null, 42, { teamId: 7 }, { teamId: 't', members: 'x', integrity: 5 }] })
  assert.equal(r.teams.length, 1)
  assert.deepEqual(r.teams[0].members, [])
  assert.equal(r.teams[0].integrity.ok, true, '拿不到 integrity 时按"未发现问题"处理（不误报篡改）')
  assert.equal(normalizeTeamStatus(undefined).teams.length, 0)
})

test('getTeamStatus：网络异常 → 不抛，转成可读文案且不谎报"未加入团队"', async () => {
  const s = stubFetch(() => ({ throwErr: true }))
  try {
    const r = await getTeamStatus('http://127.0.0.1:1')
    assert.equal(r.ok, false)
    assert.match(String(r.error), /无法连接本地服务/)
    assert.deepEqual(r.teams, [])
  } finally { s.restore() }
})

test('createTeam：请求体只带既有字段（name/dir/identCode），成功回执含识别码', async () => {
  const s = stubFetch(() => ({ body: { ok: true, teamId: 't_9', name: '研发', identCode: '483920517', dir: 'C:/team', memberId: 'u_a', role: 'owner' } }))
  try {
    const r = await createTeam({ name: '研发', dir: 'C:/team' }, 'http://127.0.0.1:1')
    assert.equal(r.ok, true)
    assert.equal(r.identCode, '483920517')
    assert.equal(s.calls[0].url, 'http://127.0.0.1:1/team/create')
    assert.deepEqual(bodyOf(s.calls[0]), { name: '研发', dir: 'C:/team' }, '没填识别码就不该发这个字段')
  } finally { s.restore() }
})

test('createTeam：后端 ok:false → reason 原样透传（不吞成笼统"创建失败"）', async () => {
  const s = stubFetch(() => ({ status: 400, body: { ok: false, reason: 'dir-required', message: '必须指定团队源目录' } }))
  try {
    const r = await createTeam({ name: 'x', dir: '' }, 'http://127.0.0.1:1')
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'dir-required')
  } finally { s.restore() }
})

test('joinTeam：两个数字 + 可选搜索根；失败 reason 逐项区分（错码/过期/已用过）', async () => {
  for (const reason of ['bad-code', 'expired', 'already-used', 'ident-not-found', 'ident-ambiguous', 'no-envelope']) {
    const s = stubFetch(() => ({ status: 400, body: { ok: false, reason, hits: reason === 'ident-ambiguous' ? ['C:/a', 'C:/b'] : undefined } }))
    try {
      const r = await joinTeam({ identCode: '483920517', code: '739204' }, 'http://127.0.0.1:1')
      assert.equal(r.ok, false)
      assert.equal(r.reason, reason, `reason=${reason} 必须原样透传（界面据此给出不同文案/是否诱导重试）`)
      if (reason === 'ident-ambiguous') assert.deepEqual(r.hits, ['C:/a', 'C:/b'])
    } finally { s.restore() }
  }

  const s = stubFetch(() => ({ body: { ok: true, teamId: 't_1', name: '研发一组', memberId: 'u_b', role: 'editor' } }))
  try {
    const r = await joinTeam({ identCode: '483920517', code: '739204', searchRoot: 'C:/Drive' }, 'http://127.0.0.1:1')
    assert.equal(r.ok, true)
    assert.equal(r.teamId, 't_1')
    assert.deepEqual(bodyOf(s.calls[0]), { identCode: '483920517', code: '739204', searchRoot: 'C:/Drive' })
  } finally { s.restore() }
})

test('joinTeam：网络异常 → reason=network 且有可读文案（与"验证码错"严格分开）', async () => {
  const s = stubFetch(() => ({ throwErr: true }))
  try {
    const r = await joinTeam({ identCode: '483920517', code: '739204' }, 'http://127.0.0.1:1')
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'network')
    assert.match(String(r.error), /无法连接本地服务/)
  } finally { s.restore() }
})

test('inviteMember：取回验证码与转发文案；ttlMs 只在给了才发', async () => {
  const s = stubFetch(() => ({ body: { ok: true, teamId: 't_1', memberId: 'u_c', code: '739204', expiresAt: '2026-09-24T00:00:00.000Z', envelope: 'keys/u_c.env', copyText: '加入团队…' } }))
  try {
    const r = await inviteMember({ teamId: 't_1' }, 'http://127.0.0.1:1')
    assert.equal(r.code, '739204')
    assert.equal(r.envelope, 'keys/u_c.env')
    assert.equal(typeof r.copyText, 'string')
    assert.deepEqual(bodyOf(s.calls[0]), { teamId: 't_1' })
  } finally { s.restore() }
})

test('revokeTeamMember / setTeamSearchRoot：成功与失败都不抛', async () => {
  const ok = stubFetch((url) => ({ body: url.includes('search-root') ? { ok: true, searchRoot: 'C:/Drive' } : { ok: true, memberId: 'u_c' } }))
  try {
    const a = await revokeTeamMember({ teamId: 't_1', memberId: 'u_c' }, 'http://127.0.0.1:1')
    assert.equal(a.ok, true)
    assert.equal(a.memberId, 'u_c')
    const b = await setTeamSearchRoot('C:/Drive', 'http://127.0.0.1:1')
    assert.equal(b.ok, true)
    assert.equal(b.searchRoot, 'C:/Drive')
  } finally { ok.restore() }

  const bad = stubFetch(() => ({ status: 400, body: { ok: false, reason: 'not-a-member' } }))
  try {
    assert.equal((await revokeTeamMember({ teamId: 't_1', memberId: 'u_c' }, 'http://127.0.0.1:1')).reason, 'not-a-member')
    assert.equal((await setTeamSearchRoot('', 'http://127.0.0.1:1')).ok, false)
  } finally { bad.restore() }
})
