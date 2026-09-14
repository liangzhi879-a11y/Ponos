// 控制台「能力清单」的纯逻辑测试（与组件解耦，node --test 直接跑）。
// 运行：node --test src/lib/appSurface.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VERDICT_COPY, normalizeSurface, groupCapabilities, summarizeSpec, reviewSummary } from './appSurface.ts'

const cap = (channel: string, confidence: string, extra: Record<string, unknown> = {}) => ({
  channel, driver: 'process', label: `${channel} 通道`, confidence, evidence: '证据', next: '下一步', ...extra,
})

test('normalizeSurface：老版本主进程 / 没探测过 → null（界面据此不渲染，不白屏）', () => {
  assert.equal(normalizeSurface(null), null)
  assert.equal(normalizeSurface(undefined), null)
  assert.equal(normalizeSurface('nope'), null)
  assert.equal(normalizeSurface({}), null, 'capabilities 不是数组 ⇒ 视为没有清单')
  assert.equal(normalizeSurface({ capabilities: 'x' }), null)
})

test('normalizeSurface：三态判定与后端同口径（verified 优先 → connectable；仅 probable → weak；都没有 → unusable）', () => {
  assert.equal(normalizeSurface({ capabilities: [cap('cli', 'verified')] })?.verdict, 'connectable')
  assert.equal(normalizeSurface({ capabilities: [cap('http', 'probable')] })?.verdict, 'weak')
  assert.equal(normalizeSurface({ capabilities: [cap('unusable', 'unusable')] })?.verdict, 'unusable')
  assert.equal(normalizeSurface({ capabilities: [] })?.verdict, 'unusable')
  // 后端已给 verdict 就照用它（前端不再推一遍，避免两套口径）
  assert.equal(normalizeSurface({ capabilities: [cap('cli', 'verified')], verdict: 'weak' })?.verdict, 'weak')
})

test('normalizeSurface：脏字段不会漏进界面（缺字段补空串、可疑 confidence 归一为 unusable）', () => {
  const s = normalizeSurface({ capabilities: [{ channel: 'cli' }, { channel: 'http', confidence: 'weird' }] })
  assert.equal(s?.capabilities.length, 2)
  assert.equal(s?.capabilities[0].label, 'cli', '缺 label 时退回 channel（界面不至于出现 undefined）')
  assert.equal(s?.capabilities[0].evidence, '')
  assert.equal(s?.capabilities[1].confidence, 'unusable', '未知可信度按最保守处理')
})

test('★ 文案协议：三态措辞严格区分，weak 绝不含"无法接入"（与后端 renderSurfaceReport 对齐）', () => {
  const weak = `${VERDICT_COPY.weak.label}${VERDICT_COPY.weak.detail}`
  assert.ok(!weak.includes('无法接入'), `weak 不得出现"无法接入"：${weak}`)
  assert.ok(weak.includes('证据不足'), weak)
  assert.ok(VERDICT_COPY.unusable.label.includes('无法接入'), VERDICT_COPY.unusable.label)
  assert.equal(new Set([VERDICT_COPY.connectable.label, VERDICT_COPY.weak.label, VERDICT_COPY.unusable.label]).size, 3, '三个标签互不相同')
})

test('groupCapabilities：按可信度分成三组（界面分组展示"能走的 / 待确认的 / 已排除的"）', () => {
  const s = normalizeSurface({ capabilities: [cap('cli', 'verified'), cap('http', 'probable'), cap('file', 'probable'), cap('unusable', 'unusable')] })
  const g = groupCapabilities(s)
  assert.deepEqual(g.verified.map((c) => c.channel), ['cli'])
  assert.deepEqual(g.probable.map((c) => c.channel), ['http', 'file'])
  assert.deepEqual(g.dead.map((c) => c.channel), ['unusable'])
  assert.deepEqual(groupCapabilities(null), { verified: [], probable: [], dead: [] })
})

test('summarizeSpec：一眼看出"这个应用现在怎么接的"', () => {
  assert.equal(summarizeSpec(null), '')
  assert.equal(
    summarizeSpec({ driver: 'browser', commands: [{ kind: 'read' }, { kind: 'read' }, { kind: 'write' }] }),
    'driver=browser · 3 条命令（2 只读 / 1 写入）',
  )
  assert.equal(summarizeSpec({ driver: 'file', commands: [] }), 'driver=file · 0 条命令（0 只读 / 0 写入）')
})

test('reviewSummary：评审结论如实呈现（无 / 跳过 / 未完成 / 到位 / N 处缺口）', () => {
  assert.equal(reviewSummary(null), null)
  assert.equal(reviewSummary({ outcome: 'no-gaps', gaps: [], applied: false }), '评审：覆盖度到位')
  assert.equal(reviewSummary({ outcome: 'skipped-budget' }), '本次未做覆盖度评审（预算不足）')
  assert.equal(reviewSummary({ outcome: 'review-failed' }), '本次评审未完成（已跳过补全）')
  const refined = reviewSummary({ outcome: 'refined', gaps: [{ what: '缺导出命令' }], applied: true })
  assert.ok(refined?.includes('1 处缺口') && refined.includes('已补全'), String(refined))
  const failed = reviewSummary({ outcome: 'refine-failed', gaps: [{ what: '缺导出命令' }], applied: true })
  assert.ok(failed?.includes('补全未通过'), String(failed))
})
