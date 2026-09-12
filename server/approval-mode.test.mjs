// 桥侧审批档位：与内核枚举一致性 + spawn 参数 + 覆盖解析
// 打包产物没有 kernel/ 目录 → 桥侧独立一份枚举，本测试负责把"两份必须逐字一致"钉死。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  APPROVAL_MODES, DEFAULT_APPROVAL_MODE, isValidApprovalMode, normalizeApprovalMode,
  resolveEffectiveApprovalMode, approvalSpawnArgs, approvalModeSummary,
} from './approval-mode.mjs'
import {
  APPROVAL_MODES as KERNEL_MODES, DEFAULT_APPROVAL_MODE as KERNEL_DEFAULT,
  APPROVAL_RANK as KERNEL_RANK,
} from '../kernel/approval-mode.mjs'

test('枚举与默认档：桥侧与内核逐字一致（打包后无 kernel/，只能靠本测试把关）', () => {
  assert.deepEqual(APPROVAL_MODES, KERNEL_MODES)
  assert.equal(DEFAULT_APPROVAL_MODE, KERNEL_DEFAULT)
  assert.deepEqual(Object.keys(KERNEL_RANK), APPROVAL_MODES, '内核 rank 表键序应与枚举一致')
})

test('normalize：非法/空/大小写/空白', () => {
  assert.equal(normalizeApprovalMode('manual'), 'manual')
  assert.equal(normalizeApprovalMode(' BYPASS '), 'bypass')
  assert.equal(normalizeApprovalMode(''), DEFAULT_APPROVAL_MODE)
  assert.equal(normalizeApprovalMode(null), DEFAULT_APPROVAL_MODE)
  assert.equal(normalizeApprovalMode(undefined), DEFAULT_APPROVAL_MODE)
  // 刻意不接受的近义词：Claude Code 的 permission-mode 语义与本档位不同名
  for (const bad of ['plan', 'acceptEdits', 'bypassPermissions', 'default', 'yolo', 7, {}]) {
    assert.equal(normalizeApprovalMode(bad), DEFAULT_APPROVAL_MODE, `${JSON.stringify(bad)} 应回落默认档`)
    assert.equal(isValidApprovalMode(bad), false)
  }
})

test('resolveEffectiveApprovalMode：会话覆盖 > 全局；非法覆盖不生效', () => {
  assert.equal(resolveEffectiveApprovalMode({ sessionOverride: 'manual', configMode: 'bypass' }), 'manual')
  assert.equal(resolveEffectiveApprovalMode({ sessionOverride: null, configMode: 'auto' }), 'auto')
  assert.equal(resolveEffectiveApprovalMode({ configMode: 'nonsense' }), DEFAULT_APPROVAL_MODE)
  assert.equal(resolveEffectiveApprovalMode({}), DEFAULT_APPROVAL_MODE)
  assert.equal(resolveEffectiveApprovalMode(), DEFAULT_APPROVAL_MODE)
  // 非法覆盖不得放大权限（回落全局档，而不是回落默认档）
  assert.equal(resolveEffectiveApprovalMode({ sessionOverride: 'yolo', configMode: 'manual' }), 'manual')
})

test('approvalSpawnArgs：显式档位 + loose/bypass 保留旧 skip flag（旧内核优雅降级）', () => {
  assert.deepEqual(approvalSpawnArgs('manual'), ['--approval-mode', 'manual'])
  assert.deepEqual(approvalSpawnArgs('auto'), ['--approval-mode', 'auto'])
  assert.deepEqual(approvalSpawnArgs('loose'), ['--approval-mode', 'loose', '--dangerously-skip-permissions'])
  assert.deepEqual(approvalSpawnArgs('bypass'), ['--approval-mode', 'bypass', '--dangerously-skip-permissions'])
  // 非法值 → 默认档参数（不会产生 --approval-mode undefined）
  assert.deepEqual(approvalSpawnArgs('plan'), ['--approval-mode', 'loose', '--dangerously-skip-permissions'])
  assert.deepEqual(approvalSpawnArgs(), ['--approval-mode', 'loose', '--dangerously-skip-permissions'])
  // 参数原子性：--approval-mode 后必须紧跟合法值（cli 用 next() 取值）
  for (const m of APPROVAL_MODES) {
    const args = approvalSpawnArgs(m)
    assert.equal(args[0], '--approval-mode')
    assert.ok(APPROVAL_MODES.includes(args[1]), `档位值必须合法，实际 ${args[1]}`)
  }
})

test('approvalModeSummary：四档各有文案且不空', () => {
  for (const m of APPROVAL_MODES) {
    assert.ok(String(approvalModeSummary(m)).length > 0, `${m} 应有摘要文案`)
  }
  assert.match(approvalModeSummary('bypass'), /灾难/, 'bypass 摘要必须点明硬黑名单仍在拦截')
  assert.equal(approvalModeSummary('nonsense'), approvalModeSummary(DEFAULT_APPROVAL_MODE))
})
