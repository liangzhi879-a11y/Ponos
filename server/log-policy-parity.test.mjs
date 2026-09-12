// 日志策略 GUI/服务端一致性：src/lib/logUi.ts ≡ server/log-policy.cjs
// ---------------------------------------------------------------------------
// 为什么需要：GUI 表单与服务端轮转器各自持有一套钳制常量。对不上就出现
// "界面显示 5MB、实际按 100MB 轮转"这类幽灵问题——用户改不动、也看不出原因。
// 放在 server/（不在 tsconfig include 内）才能直接从 .mjs 里 import .ts；
// 依赖方向 safety：src/lib/logUi.ts 是零依赖纯模块（不 import 任何运行时依赖）。
//
// 动态导入而非静态：`release/YFWorking/` 只发 server/ electron/ dist/，**不含 src/**，
// 而该目录同样带 `.test.mjs`（发布目录跑测试是既有做法）。静态 import 会让发布目录里的
// 套件永久红一条；这里只在"确实找不到 src/lib/logUi.ts"时跳过——源码树里 src/ 必然存在，
// 若因别的原因（语法/依赖）导入失败，异常照旧抛出，不会被吞成静默跳过。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_LOG_POLICY, LOG_LEVELS, LOG_POLICY_LIMITS, normalizeLogPolicy,
} from './log-policy.cjs'

let ui = null
let uiSkip = false
try {
  ui = await import('../src/lib/logUi.ts')
} catch (e) {
  const notFound = e?.code === 'ERR_MODULE_NOT_FOUND' || e?.code === 'MODULE_NOT_FOUND'
  if (notFound && /src[\\/]lib[\\/]logUi/.test(String(e?.message || ''))) uiSkip = true
  else throw e
}
const SKIP = uiSkip ? '发布目录无 src/，一致性守卫仅在源码树运行' : false
const UI_DEFAULT = ui?.DEFAULT_LOG_POLICY
const UI_LEVELS = ui?.LOG_LEVELS
const UI_LIMITS = ui?.LOG_POLICY_LIMITS
const normalizeLogPolicyUi = ui?.normalizeLogPolicyUi

test('常量一致性：默认策略 / 钳制边界 / 等级清单逐位相等', { skip: SKIP }, () => {
  assert.deepEqual(UI_DEFAULT, DEFAULT_LOG_POLICY, 'DEFAULT_LOG_POLICY 漂移')
  assert.deepEqual(UI_LIMITS, LOG_POLICY_LIMITS, 'LOG_POLICY_LIMITS 漂移')
  assert.deepEqual(UI_LEVELS, LOG_LEVELS, 'LOG_LEVELS 漂移')
})

test('钳制一致性：同一批输入两侧产出完全相同的策略', { skip: SKIP }, () => {
  const MB = 1024 * 1024
  const inputs = [
    undefined, null, 'x', 7, [], true,
    {}, { persist: false }, { persist: 'false' }, { persist: 0 },
    { level: 'DEBUG' }, { level: '  Warn  ' }, { level: 'trace' }, { level: 3 },
    { maxFileBytes: -1 }, { maxFileBytes: 0 }, { maxFileBytes: 1e12 }, { maxFileBytes: 64 * 1024 },
    { maxFileBytes: '1048576' }, { maxFileBytes: 1048576.9 }, { maxFileBytes: 'abc' },
    { maxFiles: -3 }, { maxFiles: 0 }, { maxFiles: 99 }, { maxAgeDays: 0 }, { maxAgeDays: 9999 },
    { persist: false, level: 'error', maxFileBytes: 3 * MB, maxFiles: 0, maxAgeDays: 30 },
    { persist: true, level: 'debug', maxFileBytes: 100 * MB, maxFiles: 20, maxAgeDays: 365 },
  ]
  for (const input of inputs) {
    assert.deepEqual(
      normalizeLogPolicyUi(input), normalizeLogPolicy(input),
      `输入 ${JSON.stringify(input)} 两侧结果不一致`,
    )
  }
})

test('GUI 端不得放宽服务端边界（逐个字段盯住方向）', { skip: SKIP }, () => {
  // 即便将来某侧改了常量，这条也能在 deepEqual 之前给出"往哪个方向错"的信息
  assert.equal(UI_LIMITS.minFileBytes, LOG_POLICY_LIMITS.minFileBytes)
  assert.equal(UI_LIMITS.maxFileBytes, LOG_POLICY_LIMITS.maxFileBytes)
  assert.equal(UI_LIMITS.maxFiles, LOG_POLICY_LIMITS.maxFiles)
  assert.equal(UI_LIMITS.maxAgeDays, LOG_POLICY_LIMITS.maxAgeDays)
  assert.equal(UI_DEFAULT.maxFileBytes, 5 * 1024 * 1024, '默认单文件上限（用户决策 5MB）')
  assert.equal(UI_DEFAULT.maxFiles, 3, '默认保留份数（用户决策 3 份）')
  assert.equal(UI_DEFAULT.maxAgeDays, 14, '默认按天清理（用户决策 14 天）')
  assert.equal(UI_DEFAULT.persist, true, '默认可本地持久化')
})
