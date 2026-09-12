// src/lib/approvalModeUi.test.ts
// node --test src/lib/approvalModeUi.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  APPROVAL_MODES, APPROVAL_MODE_OPTIONS, APPROVAL_MODE_RANK, DEFAULT_APPROVAL_MODE,
  effectiveModeForSession, normalizeApprovalMode, parseApprovalModeReport, requiresConfirm,
} from './approvalModeUi.ts'

test('APPROVAL_MODES：四档顺序 = 逐级放宽，且与内核/桥枚举一致', () => {
  assert.deepEqual(APPROVAL_MODES, ['manual', 'auto', 'loose', 'bypass'])
  assert.deepEqual(APPROVAL_MODE_OPTIONS.map(o => o.value), APPROVAL_MODES)
  assert.deepEqual(
    APPROVAL_MODE_OPTIONS.map(o => o.labelKey),
    ['approvalMode.manual', 'approvalMode.auto', 'approvalMode.loose', 'approvalMode.bypass'],
  )
  assert.deepEqual(
    APPROVAL_MODE_OPTIONS.map(o => o.descKey),
    ['approvalMode.manualDesc', 'approvalMode.autoDesc', 'approvalMode.looseDesc', 'approvalMode.bypassDesc'],
  )
  // rank 必须严格递增（requiresConfirm 依赖它）
  let prev = -1
  for (const m of APPROVAL_MODES) { assert.ok(APPROVAL_MODE_RANK[m] > prev, `${m} rank 应递增`); prev = APPROVAL_MODE_RANK[m] }
})

test('默认档 = loose（等价现状，存量用户零行为变化）', () => {
  assert.equal(DEFAULT_APPROVAL_MODE, 'loose')
  assert.equal(normalizeApprovalMode(undefined), 'loose', '脏值兜底到默认而非最严')
})

test('视觉语义：loose 警示色、bypass 危险色、manual/auto 常规', () => {
  const tone = (v: string) => APPROVAL_MODE_OPTIONS.find(o => o.value === v)?.tone
  assert.deepEqual(
    APPROVAL_MODES.map(tone),
    ['default', 'default', 'warning', 'danger'],
  )
})

test('normalizeApprovalMode：合法原样、非法/异形值 → loose', () => {
  for (const m of APPROVAL_MODES) assert.equal(normalizeApprovalMode(m), m)
  for (const bad of [null, undefined, '', 'plan', 'acceptEdits', 'bypassPermissions', 'yolo', '7', 'Loose', {}, [], 0, true]) {
    assert.equal(normalizeApprovalMode(bad), 'loose', `${String(bad)} 应归一为 loose`)
  }
})

test('requiresConfirm：仅"向放宽方向且目标为 loose/bypass"才需二次确认', () => {
  assert.equal(requiresConfirm('manual', 'loose'), true)
  assert.equal(requiresConfirm('manual', 'bypass'), true)
  assert.equal(requiresConfirm('auto', 'bypass'), true)
  assert.equal(requiresConfirm('loose', 'bypass'), true)
  // 收紧方向永远不确认（用户在加审批）
  assert.equal(requiresConfirm('bypass', 'loose'), false)
  assert.equal(requiresConfirm('bypass', 'manual'), false)
  assert.equal(requiresConfirm('loose', 'auto'), false)
  assert.equal(requiresConfirm('auto', 'manual'), false)
  // 目标为 manual/auto 时即使 rank 上升也不确认（loose→auto 是收紧，已覆盖）
  assert.equal(requiresConfirm('manual', 'auto'), false)
  // 同档
  assert.equal(requiresConfirm('loose', 'loose'), false)
  assert.equal(requiresConfirm('bypass', 'bypass'), false)
  // 非法 from 归一为 loose：manual→loose 的越级判断不受脏值影响
  assert.equal(requiresConfirm('bogus' as never, 'bypass'), true)
  assert.equal(requiresConfirm('bogus' as never, 'loose'), false, '脏 from 归一成 loose → 同档不确认')
})

test('parseApprovalModeReport：合法帧解析、脏帧返回 null（不覆盖旧值）', () => {
  assert.deepEqual(parseApprovalModeReport({ mode: 'manual', override: true }), { mode: 'manual', override: true })
  assert.deepEqual(parseApprovalModeReport({ mode: 'loose' }), { mode: 'loose', override: false }, 'override 缺省为 false')
  assert.deepEqual(parseApprovalModeReport({ mode: 'bypass', override: 'yes' }), { mode: 'bypass', override: false }, '非布尔 true 不算覆盖')
  for (const bad of [null, undefined, {}, [], 'manual', { mode: 'plan' }, { override: true }, { mode: 7 }]) {
    assert.equal(parseApprovalModeReport(bad), null, `${JSON.stringify(bad)} 应返回 null`)
  }
})

test('effectiveModeForSession：会话上报优先于全局，并如实标注临时覆盖', () => {
  assert.deepEqual(
    effectiveModeForSession({ session: { mode: 'bypass', override: true }, globalMode: 'loose' }),
    { mode: 'bypass', isOverride: true, global: 'loose' },
  )
  // 全局热生效推到本会话（override=false）：档位跟随，不显示「临时」
  assert.deepEqual(
    effectiveModeForSession({ session: { mode: 'auto', override: false }, globalMode: 'auto' }),
    { mode: 'auto', isOverride: false, global: 'auto' },
  )
  // 无上报（首帧前 / 无活动会话）→ 回落全局
  assert.deepEqual(
    effectiveModeForSession({ globalMode: 'manual' }),
    { mode: 'manual', isOverride: false, global: 'manual' },
  )
  assert.deepEqual(
    effectiveModeForSession({ session: null, globalMode: undefined }),
    { mode: 'loose', isOverride: false, global: 'loose' },
  )
  // 全局值本身脏 → 归一，never 抛
  assert.equal(effectiveModeForSession({ globalMode: 'yolo' }).mode, 'loose')
})
