// src/stores/viewStore.test.ts
// node --test src/stores/viewStore.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
// 注：import './viewStore.ts' 会连带执行模块级 zustand create(persist(...))——见 viewStore.ts 头注释，
// persist 在无 localStorage 的 node 环境自动降级 noop storage，实测可安全导入（否则拆到 src/lib/viewUi.ts）。
// Task 6b（D11-D13）：login 视图删除后原 normalizeStoredView 归一用例作废，改为 sanitizeRail 清洗断言。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeRail, RAIL_IDS, sanitizeSecondTab, SECOND_TAB_IDS } from './viewStore.ts'

test('sanitizeRail：4 合法值透传，非法/缺省回退 task', () => {
  for (const ok of RAIL_IDS) assert.equal(sanitizeRail(ok), ok)
  assert.equal(sanitizeRail(undefined), 'task')
  assert.equal(sanitizeRail('nope'), 'task')
  assert.equal(sanitizeRail(42), 'task')
})

test('sanitizeSecondTab：4 合法值透传，非法/缺省/历史无字段回退 null', () => {
  for (const ok of SECOND_TAB_IDS) assert.equal(sanitizeSecondTab(ok), ok)
  assert.equal(sanitizeSecondTab(undefined), null) // 旧 workState 无 secondTab 字段 → 关闭态
  assert.equal(sanitizeSecondTab(null), null)
  assert.equal(sanitizeSecondTab('nope'), null)
  assert.equal(sanitizeSecondTab(42), null)
})
