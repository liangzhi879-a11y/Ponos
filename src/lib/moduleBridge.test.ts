// src/lib/moduleBridge.test.ts
// node --test src/lib/moduleBridge.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseModuleUrl } from './moduleBridge.ts'

test('parseModuleUrl 解析 ?module=chat&conversation=c1', () => {
  const r = parseModuleUrl('http://x/?module=chat&conversation=c1')
  assert.equal(r.moduleId, 'chat')
  assert.equal(r.params.conversation, 'c1')
})

test('parseModuleUrl 无 module 返回 null', () => {
  const r = parseModuleUrl('http://x/?editor=1')
  assert.equal(r.moduleId, null)
})

test('parseModuleUrl 空 query 返回 null', () => {
  const r = parseModuleUrl('http://x/')
  assert.equal(r.moduleId, null)
})
