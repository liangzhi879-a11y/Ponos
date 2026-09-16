// src/lib/disabledApi.test.ts
// 停用注册表客户端 + 开关状态机（2026-09-15，P1 D 条款）。
//
// 重点测**不变量**而非网络细节（网络用 stub fetch 打桩，不依赖真实桥）：
//   ① PUT **只发要改的键** —— 否则两个面板互相覆盖（agent 面板写一次把技能停用清空）；
//   ② 失败**不静默** —— 开关"看起来生效了但内核没收到"是本需求要消灭的假开关；
//   ③ 读失败降级为"全开"但 readable=false —— 与内核 readDisabled 的容错策略一致。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeIdList, toggleDisabledId, fetchDisabled, saveDisabled } from './disabledApi.ts'

/** 用可编排的 stub 替换全局 fetch，返回 {calls, restore}。 */
function stubFetch(handler: (url: string, init?: RequestInit) => { status?: number; body?: unknown; throwErr?: boolean; text?: string }) {
  const original = globalThis.fetch
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const r = handler(String(url), init)
    if (r.throwErr) throw new Error('network down')
    const status = r.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.body,
      text: async () => r.text ?? JSON.stringify(r.body ?? ''),
    } as unknown as Response
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

test('normalizeIdList：去空/去重/保序，非数组安全', () => {
  assert.deepEqual(normalizeIdList([' b ', 'a', 'b', '', null, undefined]), ['b', 'a'])
  assert.deepEqual(normalizeIdList('not-an-array'), [])
  assert.deepEqual(normalizeIdList(null), [])
})

test('toggleDisabledId：开关语义（幂等、不误改其他项、保序）', () => {
  // 语义约定：入参 `current` 是**已停用**清单；`disabled=false` 表示"要把它启用" ⇒ 从清单移除。
  assert.deepEqual(toggleDisabledId(['a'], 'b', true), ['a', 'b'], '新增排到末尾（保用户操作序）')
  assert.deepEqual(toggleDisabledId(['a', 'b'], 'a', false), ['b'], '启用已停用项 = 从清单移除')
  assert.deepEqual(toggleDisabledId(['a', 'b'], 'b', true), ['a', 'b'], '已停用再停用 = 不变（幂等）')
  assert.deepEqual(toggleDisabledId(['a'], 'a', false), [], '同上：a 在清单里 ⇒ 它已停用，启用即移除')
  assert.deepEqual(toggleDisabledId([], 'a', false), [], '不在清单里再启用 = 不变（幂等）')
  assert.deepEqual(toggleDisabledId(['a'], '', true), ['a'], '空 id 不产生幽灵条目')
  assert.deepEqual(toggleDisabledId(['a'], '  ', true), ['a'])
})

test('saveDisabled：**只发传入的键**（跨面板操作不得互相覆盖）', async () => {
  const s = stubFetch(() => ({ body: { ok: true, agents: [], skills: [] } }))
  try {
    await saveDisabled({ skills: ['s-a'] })
    const body = JSON.parse(String(s.calls[0].init?.body))
    assert.deepEqual(Object.keys(body), ['skills'], '只发 skills；带上 agents 就会把对方面板的配置清空')
    assert.equal(s.calls[0].init?.method, 'PUT')

    await saveDisabled({ agents: ['a-1'] })
    assert.deepEqual(Object.keys(JSON.parse(String(s.calls[1].init?.body))), ['agents'])

    await saveDisabled({ agents: ['a-1'], skills: ['s-a'] })
    assert.deepEqual(Object.keys(JSON.parse(String(s.calls[2].init?.body))).sort(), ['agents', 'skills'])
  } finally { s.restore() }
})

test('saveDisabled：空 patch 不发请求（避免无谓触发内核重启判定）', async () => {
  const s = stubFetch(() => ({ body: { ok: true } }))
  try {
    assert.equal(await saveDisabled({}), null)
    assert.equal(s.calls.length, 0, '无事可做时不应打网络')
  } finally { s.restore() }
})

test('saveDisabled：**失败必须返回可展示的错误**（不静默）', async () => {
  const s500 = stubFetch(() => ({ status: 500, text: 'boom' }))
  try {
    const err = await saveDisabled({ skills: ['x'] })
    assert.ok(err, 'HTTP 500 必须报错，否则界面会显示"已停用"而内核没收到的假状态')
    assert.match(err!, /500/)
  } finally { s500.restore() }

  const sThrow = stubFetch(() => ({ throwErr: true }))
  try {
    const err = await saveDisabled({ skills: ['x'] })
    assert.ok(err, '网络异常同样必须报错')
    assert.match(err!, /network down/)
  } finally { sThrow.restore() }
})

test('saveDisabled：落盘前归一（去空/去重）——脏值不进注册表', async () => {
  const s = stubFetch(() => ({ body: { ok: true } }))
  try {
    await saveDisabled({ skills: ['x', 'x', '', ' y '] })
    assert.deepEqual(JSON.parse(String(s.calls[0].init?.body)).skills, ['x', 'y'])
  } finally { s.restore() }
})

test('fetchDisabled：正常读取', async () => {
  const s = stubFetch(() => ({ body: { ok: true, agents: ['a'], skills: ['s'], readable: true } }))
  try {
    const st = await fetchDisabled()
    assert.deepEqual(st.agents, ['a'])
    assert.deepEqual(st.skills, ['s'])
    assert.equal(st.readable, true)
  } finally { s.restore() }
})

test('fetchDisabled：注册表损坏（readable=false）→ 界面按"全开"展示但透出可读性', async () => {
  const s = stubFetch(() => ({ body: { ok: true, agents: [], skills: [], readable: false } }))
  try {
    const st = await fetchDisabled()
    assert.deepEqual(st.skills, [])
    assert.equal(st.readable, false, '必须透出，否则用户以为自己的停用配置丢了')
  } finally { s.restore() }
})

test('fetchDisabled：HTTP 错误 → 空清单 + readable=false（不抛给渲染层）', async () => {
  const s = stubFetch(() => ({ status: 404, body: {} }))
  try {
    const st = await fetchDisabled()
    assert.deepEqual(st.skills, [])
    assert.equal(st.readable, false)
  } finally { s.restore() }
})

test('fetchDisabled：桥未就绪（网络异常）→ 空清单 + readable=false，绝不抛', async () => {
  const s = stubFetch(() => ({ throwErr: true }))
  try {
    const st = await fetchDisabled()
    assert.deepEqual(st.agents, [])
    assert.deepEqual(st.skills, [])
    assert.equal(st.readable, false, '应用启动早期桥还没起来，面板不该崩')
  } finally { s.restore() }
})
