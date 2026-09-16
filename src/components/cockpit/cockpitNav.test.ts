// src/components/cockpit/cockpitNav.test.ts
// node --test src/components/cockpit/cockpitNav.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveCockpitNav, type CockpitNavDeps } from './cockpitNav.ts'

// 与运行时同语义的假白名单（真值由 ViewRouter 注入 sanitizeRail/sanitizeSecondTab）
const RAILS = ['chat', 'task', 'agents', 'skills', 'workflows', 'apps', 'knowledge']
const TABS = ['files', 'history', 'usage', 'worktree']
const deps: CockpitNavDeps = {
  isRail: v => typeof v === 'string' && RAILS.includes(v),
  isSecondTab: v => typeof v === 'string' && TABS.includes(v),
}

test('rail 入口：拿到合法 rail → work 导航', () => {
  assert.deepEqual(resolveCockpitNav({ type: 'yfw:nav', target: { rail: 'chat' } }, deps),
    { kind: 'work', rail: 'chat', secondTab: null })
  assert.deepEqual(resolveCockpitNav({ type: 'yfw:nav', target: { rail: 'knowledge' } }, deps),
    { kind: 'work', rail: 'knowledge', secondTab: null })
})

test('task + secondTab：合法组合透传（用量统计入口）', () => {
  assert.deepEqual(resolveCockpitNav({ type: 'yfw:nav', target: { rail: 'task', secondTab: 'usage' } }, deps),
    { kind: 'work', rail: 'task', secondTab: 'usage' })
})

test('secondTab 不变量：非 task rail 一律降级 null（否则浮层永不渲染）', () => {
  assert.deepEqual(resolveCockpitNav({ type: 'yfw:nav', target: { rail: 'chat', secondTab: 'usage' } }, deps),
    { kind: 'work', rail: 'chat', secondTab: null })
})

test('secondTab 非法值降级 null（不导航到未定义浮层）', () => {
  assert.deepEqual(resolveCockpitNav({ type: 'yfw:nav', target: { rail: 'task', secondTab: 'bogus' } }, deps),
    { kind: 'work', rail: 'task', secondTab: null })
})

test('utility 入口：设置/资料窗口', () => {
  assert.deepEqual(resolveCockpitNav({ type: 'yfw:nav', target: { utility: 'settings' } }, deps),
    { kind: 'utility', utility: 'settings' })
  assert.deepEqual(resolveCockpitNav({ type: 'yfw:nav', target: { utility: 'profile' } }, deps),
    { kind: 'utility', utility: 'profile' })
})

test('utility 非法值拒绝', () => {
  assert.equal(resolveCockpitNav({ type: 'yfw:nav', target: { utility: 'whatever' } }, deps), null)
})

test('非法 rail 拒绝（不落到兜底 rail，"点了没反应"优于"跳错页"）', () => {
  assert.equal(resolveCockpitNav({ type: 'yfw:nav', target: { rail: 'bogus' } }, deps), null)
  assert.equal(resolveCockpitNav({ type: 'yfw:nav', target: { rail: 42 } }, deps), null)
})

test('非 yfw:nav 消息 / 垃圾载荷一律 null', () => {
  assert.equal(resolveCockpitNav(null, deps), null)
  assert.equal(resolveCockpitNav(undefined, deps), null)
  assert.equal(resolveCockpitNav('yfw:nav', deps), null)
  assert.equal(resolveCockpitNav([], deps), null)
  assert.equal(resolveCockpitNav({ type: 'yfw:ready' }, deps), null)
  assert.equal(resolveCockpitNav({ type: 'yfw:nav' }, deps), null)
  assert.equal(resolveCockpitNav({ type: 'yfw:nav', target: null }, deps), null)
  assert.equal(resolveCockpitNav({ type: 'yfw:nav', target: 'chat' }, deps), null)
  assert.equal(resolveCockpitNav({ type: 'yfw:nav', target: [] }, deps), null)
  assert.equal(resolveCockpitNav({ type: 'yfw:nav', target: {} }, deps), null)
})

test('rail 与 utility 同时给出：rail 优先（功能入口 > 工具窗口）', () => {
  assert.deepEqual(resolveCockpitNav({ type: 'yfw:nav', target: { rail: 'agents', utility: 'settings' } }, deps),
    { kind: 'work', rail: 'agents', secondTab: null })
})
