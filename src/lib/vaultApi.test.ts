// src/lib/vaultApi.test.ts
// node --test src/lib/vaultApi.test.ts
//
// 覆盖 spec 的"渲染层不信任 bridge 返回值"与失败分类（§7 A5/A4 的界面侧）。
// 关键点：`window.yfworkingVault` 在 node 下不存在 → 默认走"无宿主"分支，
// 各用例按需注入假 bridge（这也正好验证了浏览器 dev 下的降级路径）。
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeVaultError,
  filterEntries,
  getVaultApi,
  isVaultAvailable,
  loadVault,
  normalizeListResult,
  normalizeStatus,
  removeVaultEntry,
  revealVaultEntry,
  copyVaultEntry,
  saveVaultEntry,
  sortEntries,
  validateEntryInput,
} from './vaultApi.ts'

/** 注入假 bridge；返回恢复函数 */
function setBridge(api: unknown) {
  const g = globalThis as unknown as { window?: Record<string, unknown> }
  g.window = g.window || {}
  ;(g.window as Record<string, unknown>).yfworkingVault = api
  return () => { delete (g.window as Record<string, unknown>).yfworkingVault }
}

const restores: Array<() => void> = []
afterEach(() => { while (restores.length) restores.pop()!() })

test('无宿主（浏览器 dev）→ 明确不可用，且不抛异常', async () => {
  assert.equal(getVaultApi(), null)
  assert.equal(isVaultAvailable(), false)
  const { status, list } = await loadVault()
  assert.equal(status.available, false)
  assert.equal(status.error, 'unavailable')
  assert.equal(list.ok, false)
  assert.equal(list.error, 'unavailable')
  assert.match(list.message || '', /仅桌面端/)
  // 关键：不是"空库"——ok:false 让 UI 走错误态而不是"暂无条目"
  assert.deepEqual(list.entries, [])
})

test('list：不信任形状 —— ok:true 但 entries 不是数组 ⇒ corrupt，而不是空库', () => {
  assert.equal(normalizeListResult({ ok: true, entries: 'nope' }).error, 'corrupt')
  assert.equal(normalizeListResult(null).error, 'corrupt')
  assert.equal(normalizeListResult({ ok: false, error: 'corrupt' }).ok, false)
})

test('list：缺字段/脏条目被过滤，好条目照常保留', () => {
  const r = normalizeListResult({
    ok: true,
    entries: [
      { id: 'a', name: 'A', tags: ['x', 1, 'y'] },
      { id: '', name: 'bad-id' },
      { name: 'no-id' },
      'garbage',
      { id: 'b', name: 'B', url: 42 },
    ],
  })
  assert.equal(r.ok, true)
  assert.deepEqual(r.entries.map(e => e.id), ['a', 'b'])
  assert.deepEqual(r.entries[0].tags, ['x', 'y'])
  assert.equal(r.entries[1].url, '')
  assert.equal(r.entries[1].notes, '')
})

test('list 结果不含 password 字段（A5 界面侧）', async () => {
  restores.push(setBridge({
    list: async () => ({ ok: true, entries: [{ id: 'a', name: 'A', password: 'LEAKED' }] }),
    status: async () => ({ ok: true, available: true, count: 1 }),
  }))
  const { list } = await loadVault()
  assert.equal(list.ok, true)
  assert.ok(!('password' in list.entries[0]), 'password 不得进入渲染层列表对象')
  assert.ok(!JSON.stringify(list).includes('LEAKED'))
})

test('status 归一：非法值不冒充可用', () => {
  assert.deepEqual(normalizeStatus({ ok: true, available: true, count: 3 }), { ok: true, available: true, count: 3, error: undefined, message: undefined })
  const s = normalizeStatus({ ok: 'yes', available: 1, count: 'many' })
  assert.equal(s.available, false)
  assert.equal(s.count, 0)
})

test('bridge 抛错 → 归类为 io，带上原始信息，不让异常穿透 UI', async () => {
  restores.push(setBridge({
    status: async () => { throw new Error('bridge down') },
    list: async () => { throw new Error('bridge down') },
  }))
  const { status, list } = await loadVault()
  assert.equal(status.ok, false)
  assert.equal(status.error, 'io')
  assert.match(status.message || '', /bridge down/)
  assert.equal(list.error, 'io')
})

test('input 校验：新增必须有密码；更新可缺省密码', () => {
  assert.equal(validateEntryInput({ name: '' }), '名称不能为空')
  assert.equal(validateEntryInput({ name: '  ' }), '名称不能为空')
  assert.equal(validateEntryInput({ name: 'A' }), '新增条目必须填写密码')
  assert.equal(validateEntryInput({ name: 'A', password: 'p' }), null)
  // 更新：带 id 且不给 password ⇒ 合法（主进程语义 = 保持原密码）
  assert.equal(validateEntryInput({ id: 'x', name: 'A' }), null)
  // 地址明显不对时给出提示（可留空）
  assert.equal(validateEntryInput({ name: 'A', password: 'p', url: '!!!' }), '地址看起来不正确（可留空）')
  assert.equal(validateEntryInput({ name: 'A', password: 'p', url: 'example.com' }), null)
  assert.equal(validateEntryInput({ name: 'A', password: 'p', url: 'https://example.com' }), null)
})

test('save：本地校验先挡住非法输入（不打 IPC）', async () => {
  let called = 0
  restores.push(setBridge({ upsert: async () => { called++; return { ok: true, entry: { id: 'a', name: 'A' } } } }))
  const r = await saveVaultEntry({ name: '', password: 'p' })
  assert.equal(r.ok, false)
  assert.equal((r as { error: string }).error, 'invalid')
  assert.equal(called, 0, '非法输入不应打到 IPC')
})

test('save：主进程报 unavailable 时原样透传（不伪装成功）', async () => {
  restores.push(setBridge({ upsert: async () => ({ ok: false, error: 'unavailable', message: '系统安全存储不可用' }) }))
  const r = await saveVaultEntry({ name: 'A', password: 'p' })
  assert.equal(r.ok, false)
  assert.equal((r as { error: string }).error, 'unavailable')
})

test('save：ok:true 但 entry 形状不对 ⇒ corrupt（不误导为已保存）', async () => {
  restores.push(setBridge({ upsert: async () => ({ ok: true, entry: { name: 'no-id' } }) }))
  const r = await saveVaultEntry({ name: 'A', password: 'p' })
  assert.equal(r.ok, false)
  assert.equal((r as { error: string }).error, 'corrupt')
})

test('remove / reveal / copy 的失败分类与成功形状', async () => {
  restores.push(setBridge({
    remove: async () => ({ ok: true }),
    reveal: async () => ({ ok: true, password: 'secret' }),
    copy: async () => ({ ok: true, clearInMs: 30000 }),
  }))
  assert.deepEqual(await removeVaultEntry('a'), { ok: true })
  assert.deepEqual(await revealVaultEntry('a'), { ok: true, password: 'secret' })
  assert.deepEqual(await copyVaultEntry('a'), { ok: true, clearInMs: 30000 })

  restores.push(setBridge({ remove: async () => ({ ok: false, error: 'not_found' }) }))
  const r = await removeVaultEntry('a')
  assert.equal(r.ok, false)
  assert.equal((r as { error: string }).error, 'not_found')

  // reveal 返回 ok 但缺 password ⇒ 不能当成空密码
  restores.push(setBridge({ reveal: async () => ({ ok: true }) }))
  const rv = await revealVaultEntry('a')
  assert.equal(rv.ok, false)
})

test('错误文案区分"环境不可用"与"文件损坏"，并都声明原文件保留', () => {
  assert.match(describeVaultError('unavailable'), /系统安全存储当前不可用/)
  assert.match(describeVaultError('corrupt'), /原文件已保留/)
  assert.match(describeVaultError('io'), /原文件未改动/)
  assert.match(describeVaultError(undefined, '自定义'), /自定义/)
  // 自定义 message 优先（主进程给的现场信息更具体）
  assert.equal(describeVaultError('corrupt', '具体原因'), '具体原因')
})

test('搜索与排序', () => {
  const es = [
    { id: '1', name: '银行', url: 'https://bank.com', username: 'zhang', notes: '', tags: ['财务'], createdAt: '', updatedAt: '' },
    { id: '2', name: '邮箱', url: '', username: '', notes: '备用', tags: [], createdAt: '', updatedAt: '' },
  ]
  assert.equal(filterEntries(es, '').length, 2)
  assert.deepEqual(filterEntries(es, 'BANK').map(e => e.id), ['1'])
  assert.deepEqual(filterEntries(es, '财务').map(e => e.id), ['1'])
  assert.deepEqual(filterEntries(es, '备用').map(e => e.id), ['2'])
  assert.deepEqual(filterEntries(es, 'zzz'), [])
  // 排序：断言**性质**而非具体排法 —— 中文/拉丁的先后由 ICU 与 locale 决定
  // （实测本机 'zh-Hans-CN' 下 '银行' 排在 'A' 前），钉死具体顺序会让用例在换 Node/ICU 时假红。
  const sorted = sortEntries([{ ...es[1], name: 'A' }, es[0]])
  assert.deepEqual([...sorted.map(e => e.name)].sort(), ['A', '银行'].sort(), '排序不得丢条目/改名')
  assert.deepEqual(sortEntries([...sorted].reverse()).map(e => e.id), sorted.map(e => e.id), '排序结果应与输入顺序无关（确定性）')
  // 不改原数组（排序不应有副作用）
  assert.equal(es[0].name, '银行')
  assert.deepEqual(sortEntries([]), [])
})
