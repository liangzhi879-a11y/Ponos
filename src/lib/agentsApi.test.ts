// src/lib/agentsApi.test.ts
// 内核 Agent 目录客户端 + 「跨区域停用不得互相覆盖」的回归（2026-09-15，批次二 H）。
//
// 重点：
//   ① `selectKernelOnlyAgents`：只挑 GUI 列表没有的项（避免同一 agent 出现两个开关）；
//   ② `foreignDisabledAgents`：**这是 H 修掉的那个真 bug 的核心** —— 停用注册表是两类 agent
//      共用的（GUI 的 16 个 + 内核独有的 5 个），`agentStore` 同步时若按自己那份全量重算，
//      会把内核独有 agent 的停用项静默抹掉 ⇒ "我停用了 researcher，点了个别的开关，它又能跑了"。
//   ③ 拉取失败降级为空数组（桥未就绪不该让面板崩）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  fetchKernelAgents, selectKernelOnlyAgents, foreignDisabledAgents, type KernelAgent,
} from './agentsApi.ts'

/** 用可编排的 stub 替换全局 fetch。 */
function stubFetch(handler: (url: string, init?: RequestInit) => { status?: number; body?: unknown; throwErr?: boolean }) {
  const original = globalThis.fetch
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const r = handler(String(url), init)
    if (r.throwErr) throw new Error('network down')
    const status = r.status ?? 200
    return { ok: status >= 200 && status < 300, status, json: async () => r.body, text: async () => '' } as unknown as Response
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

const mk = (id: string, extra: Partial<KernelAgent> = {}): KernelAgent => ({
  id, name: id, description: '', tools: '', disallowedTools: [], builtin: false, disabled: false, ...extra,
})

test('selectKernelOnlyAgents：只保留 GUI 列表没有的项（避免同一 agent 两个开关）', () => {
  const kernel = [mk('general-purpose', { builtin: true }), mk('researcher', { builtin: true }), mk('demo-user')]
  const localIds = ['general-purpose', 'Explore', 'Plan', 'statusline-setup']
  const only = selectKernelOnlyAgents(kernel, localIds)
  assert.deepEqual(only.map((a) => a.id), ['researcher', 'demo-user'])
  assert.equal(only.some((a) => a.id === 'general-purpose'), false,
    'general-purpose 在 GUI 里已有自己的卡片与开关，这里再列一遍会出现两个开关（界面自相矛盾）')
})

test('selectKernelOnlyAgents：localIds 为空 → 全部返回；内核为空 → 空', () => {
  assert.equal(selectKernelOnlyAgents([mk('a'), mk('b')], []).length, 2)
  assert.deepEqual(selectKernelOnlyAgents([], ['a']), [])
})

test('**回归**：foreignDisabledAgents 挑出"不属于本 store"的停用项（H 修掉的覆盖 bug）', () => {
  // 场景：用户停用了内核独有的 researcher，然后去点 GUI 里某个 agent 的开关。
  const registry = ['researcher', 'my-custom']      // 注册表里两个停用项
  const localIds = ['my-custom', 'general-purpose'] // my-custom 属于本 store；researcher 不属于
  const foreign = foreignDisabledAgents(registry, localIds)
  assert.deepEqual(foreign, ['researcher'], 'researcher 必须被识别为"外来项"从而在同步时保留')
  // 同步逻辑（agentStore）：本 store 侧重算 ∪ 外来项 —— 模拟一遍，确认 researcher 不丢
  const localDisabled = ['my-custom']   // 本 store 侧算出来的（my-custom 被停用）
  const next = [...new Set([...localDisabled, ...foreign])]
  assert.ok(next.includes('researcher'), '**核心**：仅按本 store 重算会丢掉 researcher ⇒ 它会被静默重新启用')
  assert.deepEqual(next.sort(), ['my-custom', 'researcher'])
})

test('**回归**：若不做并集（旧行为），外来停用项确实会丢——证明这个修法不是多余的', () => {
  const registry = ['researcher', 'my-custom']
  const localIds = ['my-custom', 'general-purpose']
  // 旧实现：next = 本 store 的停用清单（完全不含 researcher）
  const oldNext = registry.filter((id) => localIds.includes(id))
  assert.equal(oldNext.includes('researcher'), false, '旧行为会丢 —— 这正是 bug 的可复现证据')
  const newNext = [...new Set([...oldNext, ...foreignDisabledAgents(registry, localIds)])]
  assert.ok(newNext.includes('researcher'), '新行为保留')
})

test('fetchKernelAgents：正常读取并归一字段', async () => {
  const s = stubFetch(() => ({
    body: { ok: true, agents: [
      { id: 'researcher', name: 'researcher', description: '调查', tools: 'Read, Grep', disallowedTools: ['Edit'], builtin: true, disabled: false },
      { id: 'demo', description: undefined },
    ] },
  }))
  try {
    const list = await fetchKernelAgents()
    assert.equal(list.length, 2)
    assert.deepEqual(list[0], {
      id: 'researcher', name: 'researcher', description: '调查', tools: 'Read, Grep',
      disallowedTools: ['Edit'], builtin: true, disabled: false,
    })
    assert.equal(list[1].name, 'demo', 'name 缺失时回落到 id（界面不能显示空白标题）')
    assert.equal(list[1].description, '', 'description 缺失 → 空串（而不是 undefined 泄漏到渲染层）')
    assert.equal(list[1].disabled, false)
  } finally { s.restore() }
})

test('fetchKernelAgents：丢弃无 id 的脏项（防脏数据在界面产生无法操作的卡片）', async () => {
  const s = stubFetch(() => ({ body: { agents: [{ id: '' }, { description: 'x' }, { id: 'ok' }] } }))
  try {
    const list = await fetchKernelAgents()
    assert.deepEqual(list.map((a) => a.id), ['ok'])
  } finally { s.restore() }
})

test('fetchKernelAgents：桥未就绪/异常 → 空数组，绝不抛给渲染层', async () => {
  const sThrow = stubFetch(() => ({ throwErr: true }))
  try {
    assert.deepEqual(await fetchKernelAgents(), [])
  } finally { sThrow.restore() }

  const s404 = stubFetch(() => ({ status: 404, body: {} }))
  try {
    assert.deepEqual(await fetchKernelAgents(), [], 'HTTP 错误也不该让面板崩')
  } finally { s404.restore() }

  const sBad = stubFetch(() => ({ body: { agents: 'not-an-array' } }))
  try {
    assert.deepEqual(await fetchKernelAgents(), [])
  } finally { sBad.restore() }
})
