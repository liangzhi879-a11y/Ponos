// kit/lib/report.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RED, YELLOW, BASELINED, finding, checkResult, makeReport, renderHuman } from './report.mjs'

test('finding 只带非空字段（报告里不出现 undefined 噪声）', () => {
  const f = finding({ rule: 'V1', severity: RED, subject: 'APP_VERSION@version.mjs' })
  assert.deepEqual(f, { rule: 'V1', severity: 'red', subject: 'APP_VERSION@version.mjs' })
  const g = finding({ rule: 'V1', severity: RED, subject: 's', expected: 4, actual: '4', file: 'a.mjs', line: 9, hint: 'h' })
  assert.equal(g.expected, '4')      // 数值统一字符串化，避免类型差异造成的假不等
  assert.equal(g.actual, '4')
  assert.equal(g.line, 9)
})

test('makeReport：ok 只由 red 决定；green 统计通过的规则数', () => {
  const r = makeReport({
    checks: [checkResult({ rule: 'V1', title: '可解析-回读', passed: true }), checkResult({ rule: 'V2', title: '载体存在', passed: false })],
    findings: [finding({ rule: 'V7', severity: RED, subject: 'x' }), finding({ rule: 'P5', severity: YELLOW, subject: 'y' })],
    generatedAt: '2026-09-19T00:00:00.000Z',
  })
  assert.equal(r.ok, false)
  assert.deepEqual(r.summary, { red: 1, yellow: 1, baselined: 0, green: 1, rules: 2 })
})

test('makeReport：仅 yellow 时 ok 为 true（黄不阻断）', () => {
  const r = makeReport({ findings: [finding({ rule: 'P5', severity: YELLOW, subject: 'y' })] })
  assert.equal(r.ok, true)
  assert.equal(r.summary.red, 0)
})

// ★ 裁定规则 3：豁免统计必须始终可见 —— 报告的 baselined 要能分出"其中红灯几条"
test('makeReport：暴露 baselined { total, red }，「其中红灯」靠 baselinedFrom 反查', () => {
  const r = makeReport({
    findings: [
      finding({ rule: 'V7', severity: BASELINED, subject: 'skillsLock.x', reason: 'r', baselinedFrom: RED }),
      finding({ rule: 'P5', severity: BASELINED, subject: 'python.diff', reason: 'r', baselinedFrom: YELLOW }),
      finding({ rule: 'P6', severity: YELLOW, subject: 'z' }),
    ],
  })
  assert.deepEqual(r.baselined, { total: 2, red: 1 })
  assert.equal(r.summary.baselined, 2)
  assert.equal(r.ok, true, '基线里没有活红灯，故 ok')
})

// 审查实测：原断言用 /黄灯 1/ 会被表头里的 "黄灯 1" 满足（删掉整个黄灯段落也能过）
// → 改为断言**完整的段落头整行**与**期望/实际整行**，让删段落/删渲染必然变红。
test('renderHuman：红/黄/基线三段分明，含 file:line 与 hint（整行断言）', () => {
  const r = makeReport({ findings: [
    finding({ rule: 'V7', severity: RED, subject: 'skillsLock.brainstorming', expected: 'aaa', actual: 'bbb', file: 'skills-lock.json', line: 3, hint: '跑 npm run kit:sync 重算' }),
    finding({ rule: 'P5', severity: YELLOW, subject: 'python.diff' }),
    finding({ rule: 'V8', severity: BASELINED, subject: 'commonTools', reason: '存量豁免' }),
  ] })
  const lines = renderHuman(r).split('\n')
  assert.equal(lines[0], 'DevKit 检查：❌ 未通过（红灯 1 / 基线豁免 1 条，其中红灯 0 条）')
  assert.ok(lines.includes('基线豁免：1 条（其中红灯 0 条）'), '豁免统计行必须存在')
  assert.ok(lines.includes('── 红灯（阻断）（1）──'), '红灯段落头必须整行存在')
  assert.ok(lines.includes('  [V7] skillsLock.brainstorming  skills-lock.json:3'), 'file:line 必须整行存在')
  assert.ok(lines.includes('        期望 aaa / 实际 bbb'), '期望/实际 必须整行存在')
  assert.ok(lines.includes('        → 跑 npm run kit:sync 重算'), 'hint 必须整行存在')
  assert.ok(lines.includes('── 黄灯（提示）（1）──'), '黄灯段落头必须整行存在')
  assert.ok(lines.includes('  [P5] python.diff'), '黄灯条目必须整行存在')
  assert.ok(lines.includes('── 基线（已知断账）（1）──'), '基线段落头必须整行存在')
  assert.ok(lines.includes('        （已登记基线：存量豁免）'), '基线 reason 必须整行存在')
})

// ★ 裁定规则 3 的核心：绿灯里藏着人工放行，必须看得见（ok=true 也要打印）
test('renderHuman：ok=true 且有红灯豁免时，通过行不得是裸「✅ 通过」并逐条列出放行', () => {
  const r = makeReport({ findings: [
    finding({ rule: 'V7', severity: BASELINED, subject: 'skillsLock.x', reason: '20 条锁哈希待 A3 重算', baselinedFrom: RED }),
    finding({ rule: 'P5', severity: BASELINED, subject: 'python.diff', reason: '内嵌集是分发态最小集', baselinedFrom: YELLOW }),
  ] })
  assert.equal(r.ok, true)
  const lines = renderHuman(r).split('\n')
  assert.equal(lines[0], 'DevKit 检查：✅ 通过（红灯 0 / 基线豁免 2 条，其中红灯 1 条）')
  assert.equal(lines[1], '基线豁免：2 条（其中红灯 1 条）')
  assert.ok(lines.includes('  ⚠ 基线放行：[V7] skillsLock.x  20 条锁哈希待 A3 重算'), '红灯放行条目必须逐条列出（rule subject reason）')
})

test('renderHuman：无豁免时也打印豁免统计行（0 条），不让人误以为"没算过"', () => {
  const r = makeReport({ findings: [finding({ rule: 'P5', severity: YELLOW, subject: 'python.diff' })] })
  assert.equal(r.ok, true)
  const lines = renderHuman(r).split('\n')
  assert.equal(lines[0], 'DevKit 检查：✅ 通过  （红灯 0 / 黄灯 1 / 基线 0）')
  assert.equal(lines[1], '基线豁免：0 条（其中红灯 0 条）')
  assert.ok(!lines.some((l) => l.startsWith('  ⚠ 基线放行：')), '无红豁免时不应有放行明细')
})

// ★ 裁定规则 2 的可见性：缺 reason 的红灯必须出现在报告里（否则"违反 I4"看不见）
test('renderHuman：BASELINE_NO_REASON 红必须渲染出来（含说明与修法）', () => {
  const r = makeReport({ findings: [
    finding({ rule: 'BASELINE_NO_REASON', severity: RED, subject: 'P5 python.diff', message: '基线条目缺 reason（不变量 I4：放行必须写明理由）—— 该条目已被忽略', hint: '给该条目补上 reason；确属误加则直接删除条目' }),
  ] })
  const lines = renderHuman(r).split('\n')
  assert.equal(lines[0], 'DevKit 检查：❌ 未通过  （红灯 1 / 黄灯 0 / 基线 0）')
  assert.ok(lines.includes('  [BASELINE_NO_REASON] P5 python.diff'), '缺 reason 的红必须整行出现')
  assert.ok(lines.includes('        基线条目缺 reason（不变量 I4：放行必须写明理由）—— 该条目已被忽略'), '说明必须整行出现')
  assert.ok(lines.includes('        → 给该条目补上 reason；确属误加则直接删除条目'), '修法必须整行出现')
})
