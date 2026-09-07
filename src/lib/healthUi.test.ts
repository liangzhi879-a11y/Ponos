// src/lib/healthUi.test.ts
// node --test src/lib/healthUi.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { meterState, shouldShowRedAlert } from './healthUi.ts'
import type { HealthInfo } from '../stores/healthStore.ts'

function h(over: Partial<HealthInfo>): HealthInfo {
  return { score: 40, tier: 'green', compactCount: 0, remainingPct: 60, remainingTurns: 20, suggestNewSession: false, reason: '', ...over }
}

test('health 为 null 时血条占位满格绿色', () => {
  assert.deepEqual(meterState(null), { widthPct: 100, color: 'green' })
})

test('remainingPct 映射为宽度', () => {
  assert.equal(meterState(h({ remainingPct: 38 })).widthPct, 38)
})

test('tier 映射颜色：green→green / amber→amber / red→red', () => {
  assert.equal(meterState(h({ tier: 'green' })).color, 'green')
  assert.equal(meterState(h({ tier: 'amber' })).color, 'amber')
  assert.equal(meterState(h({ tier: 'red' })).color, 'red')
})

test('remainingPct 越界 clamp 到 0-100', () => {
  assert.equal(meterState(h({ remainingPct: 150 })).widthPct, 100)
  assert.equal(meterState(h({ remainingPct: -5 })).widthPct, 0)
})

test('shouldShowRedAlert：红档且未冷却为 true', () => {
  assert.equal(shouldShowRedAlert(h({ tier: 'red' }), Date.now() - 1000), true)
})

test('shouldShowRedAlert：冷却期内为 false', () => {
  assert.equal(shouldShowRedAlert(h({ tier: 'red' }), Date.now() + 60_000), false)
})

test('shouldShowRedAlert：非红档或 null 为 false', () => {
  assert.equal(shouldShowRedAlert(h({ tier: 'amber' }), 0), false)
  assert.equal(shouldShowRedAlert(null, 0), false)
})
