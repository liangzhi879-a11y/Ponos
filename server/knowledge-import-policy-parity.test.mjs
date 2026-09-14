// 导入上限 GUI/服务端一致性：src/lib/knowledgeImportUi.ts ≡ server/knowledge-import-policy.cjs
// ---------------------------------------------------------------------------
// 为什么需要：GUI 表单与服务端钳制各自持有一套常量。对不上就出现
// "界面能填 5000、实际被钳到 500"这类幽灵问题——用户改不动、也看不出原因。
// 放在 server/（不在 tsconfig include 内）才能直接从 .mjs 里 import .ts；
// GUI 侧是零依赖纯模块（不 import 任何运行时依赖）。
//
// 动态导入 + 条件跳过，理由同 log-policy-parity.test.mjs：
// 发布目录（release/YFWorking/）只发 server/ electron/ dist/，不含 src/，
// 静态 import 会让发布目录里的套件永久红一条。只在**确实找不到该 ts 文件**时跳过；
// 若因语法/依赖等其它原因导入失败，异常照旧抛出，不会被吞成静默跳过。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_IMPORT_POLICY, IMPORT_POLICY_LIMITS, normalizeImportPolicy,
} from './knowledge-import-policy.cjs'

let ui = null
let uiSkip = false
try {
  ui = await import('../src/lib/knowledgeImportUi.ts')
} catch (e) {
  const notFound = e?.code === 'ERR_MODULE_NOT_FOUND' || e?.code === 'MODULE_NOT_FOUND'
  if (notFound && /src[\\/]lib[\\/]knowledgeImportUi/.test(String(e?.message || ''))) uiSkip = true
  else throw e
}
const SKIP = uiSkip ? '发布目录无 src/，一致性守卫仅在源码树运行' : false

test('常量一致性：默认上限 / 钳制边界逐位相等', { skip: SKIP }, () => {
  assert.deepEqual(ui.DEFAULT_KNOWLEDGE_IMPORT_POLICY, DEFAULT_IMPORT_POLICY, 'DEFAULT_IMPORT_POLICY 漂移')
  assert.deepEqual(ui.KNOWLEDGE_IMPORT_LIMITS, IMPORT_POLICY_LIMITS, 'IMPORT_POLICY_LIMITS 漂移')
})

test('钳制一致性：同一批输入两侧产出完全相同的策略', { skip: SKIP }, () => {
  const MB = 1024 * 1024
  const cases = [
    undefined, null, 'x', 42, [], {},
    { maxFiles: 0 }, { maxFiles: -5 }, { maxFiles: 1 }, { maxFiles: 2000 },
    { maxFiles: 20000 }, { maxFiles: 99999 }, { maxFiles: 1.7 }, { maxFiles: '300' },
    { maxFiles: NaN }, { maxFiles: Infinity },
    { maxTotalBytes: 0 }, { maxTotalBytes: 512 }, { maxTotalBytes: 300 * MB },
    { maxTotalBytes: 20 * 1024 * MB }, { maxTotalBytes: 999 * 1024 * MB },
    { maxFiles: 1234, maxTotalBytes: 7 * MB },
  ]
  for (const c of cases) {
    assert.deepEqual(
      normalizeImportPolicy(c),
      ui.normalizeKnowledgeImportPolicyUi(c),
      `钳制结果漂移，输入 ${JSON.stringify(c)}`,
    )
  }
})

test('默认档与内核 IMPORT_LIMITS 同值（改默认必须同时改内核那一份）', { skip: SKIP }, async () => {
  const { IMPORT_LIMITS } = await import('../kernel/knowledge-import.mjs')
  // 内核的键名是 maxBatchFiles / maxBatchBytes（整批护栏），策略层用更直白的
  // maxFiles / maxTotalBytes 暴露给用户 —— 名字不同、语义一一对应，故在此逐项对齐。
  assert.equal(DEFAULT_IMPORT_POLICY.maxFiles, IMPORT_LIMITS.maxBatchFiles,
    '策略默认 maxFiles 与内核 IMPORT_LIMITS.maxBatchFiles 不一致')
  assert.equal(DEFAULT_IMPORT_POLICY.maxTotalBytes, IMPORT_LIMITS.maxBatchBytes,
    '策略默认 maxTotalBytes 与内核 IMPORT_LIMITS.maxBatchBytes 不一致')
})

test('百分比归约：total 未知时为 0（不 NaN/不满格）', { skip: SKIP }, () => {
  assert.equal(ui.importPercent({ done: 0, total: 0 }), 0)
  assert.equal(ui.importPercent({ done: 5, total: 0 }), 0)
  assert.equal(ui.importPercent({ done: 5, total: 10 }), 50)
  assert.equal(ui.importPercent({ done: 10, total: 10 }), 100)
  assert.equal(ui.importPercent({ done: 99, total: 10 }), 100, '超过总数应钳到 100')
  assert.equal(ui.importPercent({ done: NaN, total: 10 }), 0)
})
