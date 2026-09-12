// src/lib/healthUi.test.ts
// node --test src/lib/healthUi.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  meterState,
  distortionOf, distortionBadge, shouldShowDistortionAlert, anchorTextFrom, mergeIssues,
  isRecurred, distortionSuppressKey,
} from './healthUi.ts'
import type { DistortionInfo, DistortionIssue } from './healthUi.ts'
import type { HealthInfo } from '../stores/healthStore.ts'

function h(over: Partial<HealthInfo>): HealthInfo {
  return { score: 40, tier: 'green', compactCount: 0, remainingPct: 60, remainingTurns: 20, suggestNewSession: false, reason: '', ...over }
}

/** 失真档构造器：默认 green 中性对象（缺省即健康） */
function d(over: Partial<DistortionInfo> = {}): DistortionInfo {
  return {
    score: 0, tier: 'green', axes: { memory: 0, coherence: 0, goal: 0 },
    issues: [], trigger: null, observeUntilTurn: null, anchorAvailable: false, ...over,
  }
}

function i(id: string, over: Partial<DistortionIssue> = {}): DistortionIssue {
  return { id, axis: 'coherence', kind: 'stale_ref', strength: 'medium', turn: 1, evidence: 'ev', at: '', ...over }
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

// ---- 失真档（distortion）：与压力档并列的独立被测量 ----

test('缺 distortion 字段时按 green（老内核/老快照兼容）', () => {
  assert.equal(distortionOf(h({})).tier, 'green')
  assert.equal(distortionOf(null).tier, 'green')
  assert.equal(distortionOf(h({})).issues.length, 0)
})

test('distortion 字段残缺时逐字段降级，不抛异常', () => {
  const broken = h({ distortion: { tier: 'red' } as unknown as DistortionInfo })
  assert.equal(distortionOf(broken).tier, 'red')
  assert.deepEqual(distortionOf(broken).axes, { memory: 0, coherence: 0, goal: 0 })
  assert.deepEqual(distortionOf(broken).issues, [])
  assert.equal(distortionOf(broken).trigger, null)
})

test('失真档与压力档互不干扰（两轴严禁互相赋值）', () => {
  const x = h({ tier: 'green', distortion: d({ tier: 'red', trigger: 'm:summary:src/a.ts', issues: [i('m:summary:src/a.ts')] }) })
  assert.equal(meterState(x).color, 'green', '血条仍读压力档')
  assert.equal(distortionOf(x).tier, 'red')
  const y = h({ tier: 'red', distortion: d({ tier: 'green' }) })
  assert.equal(meterState(y).color, 'red', '压力红不影响失真档')
  assert.equal(distortionOf(y).tier, 'green')
})

test('shouldShowDistortionAlert：仅 red + 未冷却 + 去抖键未展示过', () => {
  const x = h({ distortion: d({ tier: 'red', trigger: 'm:1', issues: [i('m:1')] }) })
  assert.equal(shouldShowDistortionAlert(x, 0, []), true)
  assert.equal(shouldShowDistortionAlert(x, 0, ['m:1']), false, '同去抖键不重复弹')
  assert.equal(shouldShowDistortionAlert(x, Date.now() + 1000, []), false, '冷却期内不弹')
  assert.equal(shouldShowDistortionAlert(h({ distortion: d({ tier: 'amber', trigger: 'm:1' }) }), 0, []), false, 'amber 不弹卡')
  assert.equal(shouldShowDistortionAlert(h({}), 0, []), false, '无失真数据不弹')
  assert.equal(shouldShowDistortionAlert(null, 0, []), false)
})

test('shouldShowDistortionAlert：观察期（red 但 trigger 为 null）不弹卡', () => {
  const observing = h({ distortion: d({ tier: 'red', trigger: null, observeUntilTurn: 12 }) })
  assert.equal(shouldShowDistortionAlert(observing, 0, []), false, '观察期只显示角标')
})

test('shouldShowDistortionAlert：同源复发（recurred）必须重新提醒，动作可升级为新建会话', () => {
  // 内核语义：markResolved 后同源证据再现 → 打 recurred 标记（fidelity.mjs）。
  // 前端必须放行，否则用户处理过的失真再次复发时被静默吞掉（spec 验收项 6）。
  const rec = i('m:1', { recurred: true })
  const x = h({ distortion: d({ tier: 'red', trigger: 'm:1', issues: [rec] }) })
  assert.equal(shouldShowDistortionAlert(x, 0, ['m:1']), true, '复发应重新弹卡（即使该 id 已展示过）')
  assert.equal(isRecurred(distortionOf(x)), true, '复发态需可判定（卡片据此升级动作）')
  // 非复发且已展示过 → 仍不重复弹
  const y = h({ distortion: d({ tier: 'red', trigger: 'm:1', issues: [i('m:1')] }) })
  assert.equal(shouldShowDistortionAlert(y, 0, ['m:1']), false)
  // 复发只该弹一次：同一复发态的抑制键必须可区分于首次展示
  const key1 = distortionSuppressKey(distortionOf(y))
  const key2 = distortionSuppressKey(distortionOf(x))
  assert.ok(key1 && key2, '有 trigger 时抑制键不应为空')
  assert.notEqual(key1, key2, `复发态需用不同抑制键（首次=${key1} 复发=${key2}）`)
  assert.equal(shouldShowDistortionAlert(x, 0, [key1, key2]), false, '同一复发态不得反复弹卡（否则无限循环）')
})

test('shouldShowDistortionAlert：冷却只由显式关闭（dismiss）设置，不因处理过证据而闷掉新失真', () => {
  // 处理（重新锚定/新建会话）只按 id 抑制"已处理的证据"；新的、不同的证据必须立刻可提醒——
  // 红档意味着上下文已失真，静默 5 分钟等于让会话带着错误继续跑。
  const fresh = h({ distortion: d({ tier: 'red', trigger: 'c:9', issues: [i('c:9')] }) })
  assert.equal(shouldShowDistortionAlert(fresh, 0, ['m:1']), true, '新证据不受其它 id 的抑制影响')
})

test('distortionBadge：amber/red 显示角标并带证据条数，green 不显示', () => {
  const amber = distortionBadge(h({ distortion: d({ tier: 'amber', issues: [i('c:1'), i('c:2')] }) }))
  assert.equal(amber.show, true)
  assert.equal(amber.count, 2)
  assert.equal(amber.tier, 'amber')
  assert.equal(distortionBadge(h({ distortion: d({ tier: 'green', issues: [i('c:1')] }) })).show, false, 'green 不显示（压力红也不显示）')
  assert.equal(distortionBadge(h({ tier: 'red' })).show, false, '压力红不点亮失真角标')
  assert.equal(distortionBadge(null).show, false)
})

test('anchorTextFrom 透传且缺省为空串（老内核不附带 anchorText）', () => {
  assert.equal(anchorTextFrom(h({ distortion: d({ tier: 'red', anchorText: 'X' }) })), 'X')
  assert.equal(anchorTextFrom(h({})), '')
  assert.equal(anchorTextFrom(null), '')
})

test('mergeIssues：按 id 去重、新证据覆盖旧、保序且在尾追加', () => {
  const a = i('c:1', { turn: 1 })
  const b = i('c:2', { turn: 2 })
  const a2 = i('c:1', { turn: 3, evidence: '更新后的证据' })
  const merged = mergeIssues([a, b], [a2])
  assert.equal(merged.length, 2, '同 id 不重复')
  assert.equal(merged[0].turn, 3, '新证据覆盖旧')
  assert.equal(merged[0].evidence, '更新后的证据')
  assert.equal(merged[1].id, 'c:2', '保序')
  assert.deepEqual(mergeIssues([], [a]).map(x => x.id), ['c:1'])
  assert.deepEqual(mergeIssues([a], []).map(x => x.id), ['c:1'], '传空不清空')
  assert.equal(mergeIssues(null as unknown as DistortionIssue[], [a]).length, 1, '脏输入不抛异常')
})
