// src/lib/warningUi.test.ts
// node --test src/lib/warningUi.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeWarning } from './warningUi.ts'
import type { KernelWarningFrame } from './warningUi.ts'

test('budget 帧归约：usd/budgetUsd 数值透传', () => {
  const w = normalizeWarning({ type: 'ponos_warning', level: 'budget', usd: 1.2345, budgetUsd: 1 })
  assert.equal(w.level, 'budget')
  assert.equal(w.usd, 1.2345)
  assert.equal(w.budgetUsd, 1)
  assert.equal(w.message, undefined)
})

test('skill_version 帧归约：outdated 数组白名单映射', () => {
  const w = normalizeWarning({ level: 'skill_version', outdated: [{ id: 'gxtz-x', lock: '2.0.0', disk: '1.0.0' }, { id: '', lock: '1', disk: '1' }, null] })
  assert.deepEqual(w.outdated, [{ id: 'gxtz-x', lock: '2.0.0', disk: '1.0.0' }])
})

test('agent_spec / context 帧归约：message 与 agent 透传', () => {
  const a = normalizeWarning({ level: 'agent_spec', agent: 'researcher', message: '引用未知工具 x（已忽略）' })
  assert.equal(a.agent, 'researcher')
  assert.equal(a.message, '引用未知工具 x（已忽略）')
  const c = normalizeWarning({ level: 'context', message: '接近压缩阈值' })
  assert.equal(c.level, 'context')
  assert.equal(c.message, '接近压缩阈值')
})

test('未知 level 与缺失字段兜底：level=unknown、其余字段缺省', () => {
  const w = normalizeWarning({})
  assert.equal(w.level, 'unknown')
  assert.equal(w.usd, undefined)
  assert.equal(w.budgetUsd, undefined)
  assert.equal(w.outdated, undefined)
  assert.equal(w.agent, undefined)
  assert.equal(w.message, undefined)
  assert.ok(typeof w.ts === 'number')
})

test('非数值/非数组负载免疫：usd 字符串不取、outdated 非数组跳过', () => {
  const w = normalizeWarning({ level: 'budget', usd: '1.2', outdated: 'nope' })
  assert.equal(w.usd, undefined)
  assert.equal(w.outdated, undefined)
})
