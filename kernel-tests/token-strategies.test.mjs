// T3.2（治理计划 2026-10-20-token-context-governance）：治理策略注册表（A/B 的分组键）。
//
// 问题（问0）：本计划落了一批"每条独立开关"的策略，开关分散在各自的 env 里 ⇒ **A/B 拿不到
// 分组键**："这次 C_success 变好，是因为开了哪几条？"答不出来，只能整体归因（等于没归因）。
//
// 本文件钉住 6 条：
//   ① ★ 登记表非空且每条字段齐（id/face/env/defaultOn/revert）——缺字段就没法回退/归因
//   ② ★ id 唯一（重复 id 会让 A/B 分组把两条策略混成一档）
//   ③ ★ 每条策略的 `revert` 必须**具体**（含 = 或"删除…"，不能是"关掉即可"这种空话）
//   ④ ★ `resolveActiveStrategies` 与登记表的 defaultOn 一致（默认开的进 active）
//   ⑤ ★ 显式关闭（0/off/false）能把"默认开"的策略挪进 inactive（开关真的有效）
//   ⑥ ★ 默认关的策略：不设 env 就不生效；显式设值才生效（GC7：改默认是独立一步）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TOKEN_STRATEGIES, STRATEGY_FACE, resolveActiveStrategies } from '../kernel/token-strategies.mjs'

const REPO = fileURLToPath(new URL('..', import.meta.url))

test('① 登记表非空且每条字段齐', () => {
  assert.ok(TOKEN_STRATEGIES.length >= 5, `登记的策略数应 ≥5（实测 ${TOKEN_STRATEGIES.length}）`)
  for (const s of TOKEN_STRATEGIES) {
    for (const k of ['id', 'face', 'env', 'defaultOn', 'saving', 'revert']) {
      assert.ok(s[k] !== undefined && s[k] !== null && String(s[k]).trim() !== '',
        `策略 ${s.id || '(无 id)'} 缺字段 ${k}（缺了就没法回退/归因）`)
    }
    assert.equal(typeof s.defaultOn, 'boolean', `${s.id} 的 defaultOn 必须是布尔`)
    assert.ok(Object.values(STRATEGY_FACE).includes(s.face), `${s.id} 的 face=${s.face} 不在枚举内`)
  }
})

test('★ ② id 唯一（重复 id 会让 A/B 把两条策略混成一档）', () => {
  const ids = TOKEN_STRATEGIES.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length, `id 重复：${ids.join('、')}`)
})

test('★ ③ 每条 revert 必须具体（空话式回退等于没有回退）', () => {
  for (const s of TOKEN_STRATEGIES) {
    const r = String(s.revert)
    assert.ok(/=|删除|设为/.test(r), `${s.id} 的 revert 不具体："${r}"（要写"设什么值"或"删什么"）`)
  }
})

test('★ ④ resolveActiveStrategies 与 defaultOn 一致', () => {
  // 空 env ⇒ 生效集合 = defaultOn=true 的那些
  const r = resolveActiveStrategies({ env: {} })
  const expectOn = TOKEN_STRATEGIES.filter((s) => s.defaultOn).map((s) => s.id)
  const expectOff = TOKEN_STRATEGIES.filter((s) => !s.defaultOn).map((s) => s.id)
  assert.deepEqual([...r.active].sort(), [...expectOn].sort(), '默认开的必须进 active')
  assert.deepEqual([...r.inactive].sort(), [...expectOff].sort(), '默认关的必须进 inactive')
  assert.equal(r.active.length + r.inactive.length, TOKEN_STRATEGIES.length, '每条策略必须落在一侧（不能丢）')
})

test('★ ⑤ 显式关闭（0/off/false）能把"默认开"的策略挪进 inactive', () => {
  const onByDefault = TOKEN_STRATEGIES.filter((s) => s.defaultOn)
  assert.ok(onByDefault.length > 0, '夹具自检：应有默认开的策略')
  for (const s of onByDefault) {
    for (const off of ['0', 'off', 'false', 'OFF', 'False']) {
      const r = resolveActiveStrategies({ env: { [s.env]: off } })
      assert.ok(r.inactive.includes(s.id), `★ ${s.env}=${off} 应把 ${s.id} 关掉（开关无效即红）`)
    }
  }
})

test('★ ⑥ 默认关的策略：不设 env 不生效，显式设值才生效', () => {
  const offByDefault = TOKEN_STRATEGIES.filter((s) => !s.defaultOn)
  assert.ok(offByDefault.length > 0, '夹具自检：应有默认关的策略（GC7）')
  for (const s of offByDefault) {
    assert.ok(resolveActiveStrategies({ env: {} }).inactive.includes(s.id), `★ ${s.id} 缺省必须不生效`)
    assert.ok(resolveActiveStrategies({ env: { [s.env]: '1' } }).active.includes(s.id), `${s.env}=1 应打开 ${s.id}`)
    assert.ok(resolveActiveStrategies({ env: { [s.env]: '8192' } }).active.includes(s.id), `${s.env}=8192 应打开 ${s.id}`)
  }
})

test('★ 登记表与实现不漂移：每条策略的 env 名在 kernel/ 下确有消费者', () => {
  // 白名单里写一行、实现里没人读 = 孤儿策略（"机制存在 ≠ 机制生效"）。判据落**字面量**：
  // 该 env 名必须出现在 kernel/ 的某个 .mjs 里（不含本模块自身）。
  const dir = path.join(REPO, 'kernel')
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs') && f !== 'token-strategies.mjs')
  const corpus = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf-8')).join('\n')
  for (const s of TOKEN_STRATEGIES) {
    assert.ok(corpus.includes(s.env),
      `★ ${s.id} 登记的 ${s.env} 在 kernel/ 下没有消费者（孤儿策略：白名单有、实现没有）`)
  }
})
