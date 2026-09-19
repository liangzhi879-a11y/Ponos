// kit/lib/baseline.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASELINE_FILE, keyOf, loadBaseline, applyBaseline, baselineGrowth } from './baseline.mjs'
import { RED, YELLOW, finding } from './report.mjs'

function fixture(baseline) {
  const root = mkdtempSync(join(tmpdir(), 'yfw-kit-'))
  mkdirSync(join(root, 'kit', 'manifest'), { recursive: true })
  if (baseline !== undefined) writeFileSync(join(root, BASELINE_FILE), JSON.stringify(baseline, null, 2))
  return root
}

test('loadBaseline：文件缺失返回空基线而非抛错', () => {
  const root = fixture(undefined)
  const b = loadBaseline({ root })
  assert.equal(b.version, 1)
  assert.deepEqual(b.entries, [])
})

test('loadBaseline：解析失败也返回空基线（不能因坏文件崩掉门禁）', () => {
  const root = mkdtempSync(join(tmpdir(), 'yfw-kit-'))
  mkdirSync(join(root, 'kit', 'manifest'), { recursive: true })
  writeFileSync(join(root, BASELINE_FILE), '{ 坏 JSON')
  assert.deepEqual(loadBaseline({ root }).entries, [])
})

test('applyBaseline：命中降级为 baselined 并带 reason；未命中的原样保留', () => {
  const baseline = { version: 1, entries: [{ rule: 'P5', subject: 'python.diff', reason: '内嵌集是分发态最小集', at: '2026-09-19' }] }
  const findings = [
    finding({ rule: 'P5', severity: YELLOW, subject: 'python.diff' }),
    finding({ rule: 'V7', severity: RED, subject: 'skillsLock.x' }),
  ]
  const out = applyBaseline(findings, baseline)
  assert.equal(out.findings[0].severity, 'baselined')
  assert.equal(out.findings[0].reason, '内嵌集是分发态最小集')
  assert.equal(out.findings[1].severity, 'red')
  assert.deepEqual(out.used, [keyOf({ rule: 'P5', subject: 'python.diff' })])
})

test('applyBaseline：基线里不再命中的条目进 unused（提示可摘除）', () => {
  const baseline = { version: 1, entries: [{ rule: 'V8', subject: 'gone', reason: 'r' }] }
  const out = applyBaseline([], baseline)
  assert.deepEqual(out.used, [])
  assert.deepEqual(out.unused, [keyOf({ rule: 'V8', subject: 'gone' })])
})

// G5 防滥用：基线是"欠账"不是"药方"，条目数不得增长
test('baselineGrowth：条目数超过记录值即报超限；未记录（null）时不管', () => {
  const b = { version: 1, entries: [{ rule: 'a', subject: 'b', reason: 'r' }, { rule: 'c', subject: 'd', reason: 'r' }] }
  assert.equal(baselineGrowth({ baseline: b, recordedCount: null }), null)
  assert.equal(baselineGrowth({ baseline: b, recordedCount: 2 }), null)
  assert.deepEqual(baselineGrowth({ baseline: b, recordedCount: 1 }), { exceeded: 2, recordedCount: 1 })
})
