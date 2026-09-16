// src/lib/providerSecrets.test.ts
// node --test src/lib/providerSecrets.test.ts
//
// 这里测的是"迁移决策"——一次性、有破坏性的判断。判错 = 用户的 API Key 被清掉，
// 所以每个分支（首次迁移 / 库优先 / 清空 / 不误删 / 未注水不得同步）都要有用例。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applySecretsToSettings,
  collectSecrets,
  createHydrationGate,
  LEGACY_API_KEY,
  planHydration,
  planSecretSync,
  providerTokenKey,
  stripSecretsFromPersisted,
} from './providerSecrets.ts'
import type { AppSettings } from '@/types'

function mkSettings(over: Record<string, unknown> = {}): AppSettings {
  return {
    apiKey: '',
    providers: [
      { id: 'p1', name: 'A', baseUrl: '', authToken: 'sk-1', model: '', enabled: true },
      { id: 'p2', name: 'B', baseUrl: '', authToken: '', model: '', enabled: false },
    ],
    ...over,
  } as unknown as AppSettings
}

test('stripSecretsFromPersisted：落盘那份不含任何密钥，且不破坏其它字段', () => {
  const out = stripSecretsFromPersisted(mkSettings({ apiKey: 'legacy-key' }))
  assert.equal(out.apiKey, '')
  assert.deepEqual(out.providers.map(p => p.authToken), ['', ''])
  // 非秘密字段照旧
  assert.deepEqual(out.providers.map(p => p.id), ['p1', 'p2'])
  assert.equal(out.providers[2 - 1].name, 'B')
})

test('stripSecretsFromPersisted：不改原对象（避免连带清掉内存正在用的密钥）', () => {
  const s = mkSettings({ apiKey: 'legacy-key' })
  stripSecretsFromPersisted(s)
  assert.equal(s.apiKey, 'legacy-key', '原对象被就地修改了：内存里的密钥会当场消失')
  assert.equal(s.providers[0].authToken, 'sk-1')
})

test('collectSecrets：只收非空值；空 token 不写库（避免以空值覆盖真值）', () => {
  assert.deepEqual(collectSecrets(mkSettings({ apiKey: 'legacy-key' })), {
    [providerTokenKey('p1')]: 'sk-1',
    [LEGACY_API_KEY]: 'legacy-key',
  })
  assert.deepEqual(collectSecrets(mkSettings({ providers: [] })), {})
  // 全是空 ⇒ 空对象（不是 {k:''}）
  assert.deepEqual(collectSecrets(mkSettings({ providers: [{ id: 'x', authToken: '' }] })), {})
})

test('planHydration：首次迁移 —— 内存有、库没有 ⇒ 搬进库（之后才能安全擦除明文）', () => {
  const r = planHydration({ [providerTokenKey('p1')]: 'sk-1' }, {})
  assert.deepEqual(r.toWrite, { [providerTokenKey('p1')]: 'sk-1' })
  assert.deepEqual(r.toApply, {})
})

test('planHydration：库优先 —— 库里有值就注回内存，不用旧副本反向覆盖', () => {
  const r = planHydration({ [providerTokenKey('p1')]: 'sk-stale' }, { [providerTokenKey('p1')]: 'sk-vault' })
  assert.deepEqual(r.toApply, { [providerTokenKey('p1')]: 'sk-vault' })
  assert.deepEqual(r.toWrite, {}, '库里已有值 ⇒ 不该再写（否则旧副本覆盖可信源）')
})

test('planHydration：两边都没有 ⇒ 什么都不做；库里有空值 ⇒ 不当成可注水', () => {
  assert.deepEqual(planHydration({}, {}), { toWrite: {}, toApply: {} })
  assert.deepEqual(planHydration({}, { k: '' }).toApply, {}, '空值不应注回内存')
})

test('applySecretsToSettings：按键注回对应 provider，陌生键忽略', () => {
  const out = applySecretsToSettings(mkSettings(), {
    [providerTokenKey('p1')]: 'sk-new',
    [LEGACY_API_KEY]: 'legacy',
    'unknown:key': 'ignored',
  })
  assert.equal(out.providers[0].authToken, 'sk-new')
  assert.equal(out.providers[1].authToken, '', '库里没有 p2 ⇒ 保持原样')
  assert.equal(out.apiKey, 'legacy')
})

test('planSecretSync：只报差量（值变了才写）', () => {
  const k = providerTokenKey('p1')
  assert.deepEqual(planSecretSync({ [k]: 'sk-1' }, { [k]: 'sk-1' }), {}, '一致就不写')
  assert.deepEqual(planSecretSync({ [k]: 'sk-2' }, { [k]: 'sk-1' }), { [k]: 'sk-2' })
})

test('planSecretSync：清空 token ⇒ 用空串表达删除', () => {
  const k = providerTokenKey('p1')
  assert.deepEqual(planSecretSync({ [k]: '' }, { [k]: 'sk-old' }), { [k]: '' })
})

test('planSecretSync：**不推断删除** —— 内存未见到不等于要删（防注水前清空全部密钥）', () => {
  // 这是最要命的一条：内存为空（如注水尚未完成）时，绝不能把库里的密钥判成"该删"
  const vault = { [providerTokenKey('p1')]: 'sk-1', [providerTokenKey('p2')]: 'sk-2' }
  assert.deepEqual(planSecretSync({}, vault), {}, '内存为空时不得产生任何删除指令')
  // 另一个窗口写了新键，本窗口没看到 ⇒ 也不动
  assert.deepEqual(planSecretSync({ [providerTokenKey('p1')]: 'sk-1' }, { ...vault, 'other:x': 'y' }), {})
})

test('注水闸门：注水完成前 canSync 为 false（挡住"空内存覆盖真相"）', () => {
  const gate = createHydrationGate()
  assert.equal(gate.isHydrated(), false)
  assert.equal(gate.canSync(), false, '注水前必须禁止写回')
  gate.markHydrated()
  assert.equal(gate.canSync(), true)
})

test('端到端推演：从"明文散落"到"库为真相源"的安全顺序', () => {
  const gate = createHydrationGate()
  // 1) 从 localStorage 起身：persist 已剥离密钥 ⇒ 内存里没有 token
  const booted = { apiKey: '', providers: [{ id: 'p1', authToken: '' }] } as never
  // 2) 注水前的一次同步必须被闸门挡住（否则会把库里真值清掉）
  assert.equal(gate.canSync(), false)
  // 3) 取库里的值 → 注回内存
  const fromVault = { [providerTokenKey('p1')]: 'sk-vault' }
  const hydrated = applySecretsToSettings(booted, fromVault)
  assert.equal(hydrated.providers[0].authToken, 'sk-vault')
  gate.markHydrated()
  // 4) 注水后同步发现一致 ⇒ 无操作（不会来回写）
  assert.deepEqual(planSecretSync(collectSecrets(hydrated), fromVault), {})
  // 5) 用户改 token ⇒ 只写差量
  const edited = { ...hydrated, providers: [{ ...hydrated.providers[0], authToken: 'sk-new' }] }
  assert.deepEqual(planSecretSync(collectSecrets(edited), fromVault), { [providerTokenKey('p1')]: 'sk-new' })
  // 6) 落盘那份永远不含密钥
  assert.equal(stripSecretsFromPersisted(edited).providers[0].authToken, '')
})
