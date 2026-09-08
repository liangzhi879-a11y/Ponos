// src/stores/viewStore.test.ts
// node --test src/stores/viewStore.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
// 注：import './viewStore.ts' 会连带执行模块级 zustand create(persist(...))——见 viewStore.ts 头注释，
// persist 在无 localStorage 的 node 环境自动降级 noop storage，实测可安全导入（否则拆到 src/lib/viewUi.ts）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeStoredView } from './viewStore.ts'

test('持久化 view 归一', () => {
  assert.equal(normalizeStoredView('work'), 'work')
  assert.equal(normalizeStoredView('cockpit'), 'cockpit')
  assert.equal(normalizeStoredView('boot'), 'login')
  assert.equal(normalizeStoredView('login'), 'login')
  assert.equal(normalizeStoredView(undefined), 'login')
})
