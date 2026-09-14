// src/lib/knowledgeImportUi.test.ts —— 导入进度/上限的纯函数（2026-09-14）
//
// 这些断言钉的是**容易静默错**的地方，不是形式覆盖：
//  · 分母未知时必须 0%（画成满格 = 假进度；画成 NaN = 进度条消失）
//  · done>total 必须钳到 100（跨源去重/被拒会让 done 与 total 短暂不齐）
//  · plan/process 的分界取决于 total 是否已知（这决定了进度条是确定态还是不确定态）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_KNOWLEDGE_IMPORT_POLICY, IDLE_IMPORT_PROGRESS, KNOWLEDGE_IMPORT_LIMITS,
  importPercent, importProgressText, normalizeKnowledgeImportPolicyUi, progressFromJob, reduceProgressEvent,
} from './knowledgeImportUi.ts'

const MB = 1024 * 1024

test('importPercent：分母未知时为 0，不 NaN 不满格', () => {
  assert.equal(importPercent({ done: 0, total: 0 }), 0)
  assert.equal(importPercent({ done: 7, total: 0 }), 0, 'total=0 时 done 再大也不能算成 100')
  assert.equal(importPercent({ done: NaN, total: 10 }), 0)
  assert.equal(importPercent({ done: 3, total: NaN }), 0)
})

test('importPercent：正常区间与越界钳制', () => {
  assert.equal(importPercent({ done: 0, total: 10 }), 0)
  assert.equal(importPercent({ done: 5, total: 10 }), 50)
  assert.equal(importPercent({ done: 10, total: 10 }), 100)
  assert.equal(importPercent({ done: 11, total: 10 }), 100, 'done>total 钳到 100')
  assert.equal(importPercent({ done: 1, total: 3 }), 33, '四舍五入')
})

test('reduceProgressEvent：只认三种 phase，未知形状返回 null', () => {
  assert.equal(reduceProgressEvent(null), null)
  assert.equal(reduceProgressEvent('x'), null)
  assert.equal(reduceProgressEvent({ phase: 'weird' }), null)
  assert.deepEqual(reduceProgressEvent({ phase: 'plan', done: 0, total: 6 }), { phase: 'plan', done: 0, total: 6 })
  // current 只在非空字符串时带上（空串不该产生一个空 title 属性）
  assert.deepEqual(reduceProgressEvent({ phase: 'process', done: 2, total: 6, current: '' }), { phase: 'process', done: 2, total: 6 })
  assert.deepEqual(reduceProgressEvent({ phase: 'process', done: 2, total: 6, current: 'a/b.md' }), { phase: 'process', done: 2, total: 6, current: 'a/b.md' })
  // 负数/非数字一律归 0，不让坏数据污染分母
  assert.deepEqual(reduceProgressEvent({ phase: 'plan', done: -3, total: 'x' }), { phase: 'plan', done: 0, total: 0 })
})

test('progressFromJob：running+total>0 才是 process，total=0 是 plan（不确定态分界）', () => {
  // 统计阶段：已提交但内核还没枚举完 → must be plan（UI 显示不确定态）
  assert.deepEqual(progressFromJob({ status: 'running', done: 0, total: 0, percent: 0 }),
    { phase: 'plan', done: 0, total: 0 })
  // 处理阶段
  assert.deepEqual(progressFromJob({ status: 'running', done: 3, total: 9, current: 'x/y.md', percent: 33 }),
    { phase: 'process', done: 3, total: 9, current: 'x/y.md' })
  // 完成：即便 total=0（空目录）也算 done，而不是停在 plan
  assert.deepEqual(progressFromJob({ status: 'done', done: 0, total: 0, percent: 100 }),
    { phase: 'done', done: 0, total: 0 })
  // 失败：带上错误文案
  assert.deepEqual(progressFromJob({ status: 'error', done: 1, total: 5, error: 'too-many-files: ...' }),
    { phase: 'error', done: 1, total: 5, error: 'too-many-files: ...' })
  assert.equal(progressFromJob({ status: 'unknown' }), null)
  assert.equal(progressFromJob(null), null)
})

test('importProgressText：五态各有文案，处理态带 n/total', () => {
  assert.equal(importProgressText(IDLE_IMPORT_PROGRESS), '待开始')
  assert.equal(importProgressText({ phase: 'plan', done: 0, total: 0 }), '已发现 0 个文件，准备导入…')
  assert.match(importProgressText({ phase: 'process', done: 1, total: 6, current: 'a/b.md' }), /2\/6.*a\/b\.md$/)
  assert.match(importProgressText({ phase: 'done', done: 6, total: 6 }), /6\/6/)
  assert.match(importProgressText({ phase: 'error', done: 0, total: 0, error: 'boom' }), /boom/)
})

test('导入上限：归一化与钳制边界', () => {
  assert.deepEqual(normalizeKnowledgeImportPolicyUi(undefined), DEFAULT_KNOWLEDGE_IMPORT_POLICY)
  assert.deepEqual(normalizeKnowledgeImportPolicyUi('x'), DEFAULT_KNOWLEDGE_IMPORT_POLICY)
  assert.deepEqual(normalizeKnowledgeImportPolicyUi({ maxFiles: 0 }).maxFiles, KNOWLEDGE_IMPORT_LIMITS.minFiles)
  assert.equal(normalizeKnowledgeImportPolicyUi({ maxFiles: 99999 }).maxFiles, KNOWLEDGE_IMPORT_LIMITS.maxFiles)
  assert.equal(normalizeKnowledgeImportPolicyUi({ maxTotalBytes: 0 }).maxTotalBytes, KNOWLEDGE_IMPORT_LIMITS.minTotalBytes)
  assert.equal(normalizeKnowledgeImportPolicyUi({ maxTotalBytes: 999 * MB * 1024 }).maxTotalBytes, KNOWLEDGE_IMPORT_LIMITS.maxTotalBytes)
  // 只改一项时另一项保持默认（不是被整体重置成默认）
  assert.deepEqual(normalizeKnowledgeImportPolicyUi({ maxFiles: 2000 }),
    { maxFiles: 2000, maxTotalBytes: DEFAULT_KNOWLEDGE_IMPORT_POLICY.maxTotalBytes })
  // 小数取整（输入框可能填出 1.5）
  assert.equal(normalizeKnowledgeImportPolicyUi({ maxFiles: 1.9 }).maxFiles, 1)
})
