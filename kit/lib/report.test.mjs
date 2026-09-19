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

test('renderHuman：红/黄/基线三段分明，含 file:line 与 hint', () => {
  const r = makeReport({ findings: [
    finding({ rule: 'V7', severity: RED, subject: 'skillsLock.brainstorming', expected: 'aaa', actual: 'bbb', file: 'skills-lock.json', line: 3, hint: '跑 npm run kit:sync 重算' }),
    finding({ rule: 'P5', severity: YELLOW, subject: 'python.diff' }),
    finding({ rule: 'V8', severity: BASELINED, subject: 'commonTools', reason: '存量豁免' }),
  ] })
  const text = renderHuman(r)
  assert.match(text, /红灯 1/)
  assert.match(text, /skills-lock\.json:3/)
  assert.match(text, /跑 npm run kit:sync 重算/)
  assert.match(text, /黄灯 1/)
  assert.match(text, /基线 1/)
  assert.match(text, /存量豁免/)
})
