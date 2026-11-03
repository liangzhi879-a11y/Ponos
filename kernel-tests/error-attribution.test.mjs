import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAttribution } from '../kernel/error-attribution.mjs'

const NOW = Date.parse('2026-10-27T12:00:00Z')
const D = 86400000
const H = 3600000
const iso = (ms) => new Date(ms).toISOString()
const ev = (src, at, fp, ref) => ({ src, at: iso(at), fp, ref, snippet: `${src} ${ref}` })

test('★ 同 fp 跨源合并为一条：origin 保序、count 计数、firstAt/lastAt 正确', () => {
  const events = [
    ev('transcript', NOW - 3 * D, 'aaaaaaaaaaaa', 's1#3'),
    ev('journal', NOW - 1 * D, 'aaaaaaaaaaaa', 'journal/1#2'),
    ev('log', NOW - 2 * D, 'aaaaaaaaaaaa', 'app.log'),
  ]
  const r = buildAttribution({ events, now: NOW, windowDays: 30 })
  assert.equal(r.items.length, 1)
  const it = r.items[0]
  assert.equal(it.fp, 'aaaaaaaaaaaa')
  assert.equal(it.count, 3)
  assert.equal(it.origin.length, 3)
  assert.equal(it.firstAt, iso(NOW - 3 * D))
  assert.equal(it.lastAt, iso(NOW - 1 * D))
})

test('★ fix 来自 journal act；verified 取 extra.verified；不复发 ⇒ recurring=false', () => {
  const events = [
    ev('journal', NOW - 5 * D, 'bbbbbbbbbbbb', 'journal/1#1'),
    { src: 'journal', at: iso(NOW - 4 * D), fp: 'bbbbbbbbbbbb', ref: 'journal/1#2', snippet: 'act', kind: 'act', actionId: 'config-valid', ok: true, extra: { verified: true } },
  ]
  const it = buildAttribution({ events, now: NOW }).items[0]
  assert.equal(it.fixes.length, 1)
  assert.equal(it.fixes[0].actionId, 'config-valid')
  assert.equal(it.fixes[0].verified, true)
  assert.equal(it.recurring, false)
  assert.equal(it.immediate, false)
})

test('★ R1：修后 3 天再现 ⇒ recurring=true / immediate=false', () => {
  const fx = NOW - 4 * D
  const events = [
    ev('journal', NOW - 6 * D, 'cccccccccccc', 'journal/1#1'),
    { src: 'journal', at: iso(fx), fp: 'cccccccccccc', ref: 'journal/1#2', snippet: 'act', kind: 'act', actionId: 'a', ok: true, extra: { verified: true } },
    ev('transcript', fx + 3 * D, 'cccccccccccc', 's9#1'),
  ]
  const it = buildAttribution({ events, now: NOW }).items[0]
  assert.equal(it.recurring, true)
  assert.equal(it.immediate, false)
})

test('★ R1：修后 2 小时再现 ⇒ immediate=true（且算复发）', () => {
  const fx = NOW - 1 * D
  const events = [
    ev('journal', NOW - 2 * D, 'dddddddddddd', 'journal/1#1'),
    { src: 'journal', at: iso(fx), fp: 'dddddddddddd', ref: 'journal/1#2', snippet: 'act', kind: 'act', actionId: 'a', ok: true, extra: { verified: true } },
    ev('log', fx + 2 * H, 'dddddddddddd', 'app.log'),
  ]
  const it = buildAttribution({ events, now: NOW }).items[0]
  assert.equal(it.immediate, true)
  assert.equal(it.recurring, true)
})

test('★ 窗口与空指纹：超窗事件剔除、null fp 计入 dropped', () => {
  const events = [
    ev('transcript', NOW - 90 * D, 'eeeeeeeeeeee', 's1#1'),
    ev('transcript', NOW - 1 * D, null, 's1#2'),
  ]
  const r = buildAttribution({ events, now: NOW, windowDays: 30 })
  assert.equal(r.items.length, 0)
  assert.equal(r.dropped.outOfWindow, 1)
  assert.equal(r.dropped.nullFp, 1)
})

test('★ 候选只在会话 id 精确匹配时关联（防"时间邻近就套上去"的假关联）', () => {
  const events = [ev('transcript', NOW - 2 * D, 'ffffffffffff', 'sess-1#5')]
  const candidates = [
    { id: 'c1', ruleId: 'OPP-7', subject: 'Grep', evidence: [{ sessionId: 'sess-1', ts: iso(NOW - 2 * D) }] },
    // 时间几乎同一刻、但会话不同 ⇒ **不许**关联（早先按时间窗关联，实测一条 fp 挂了 346 个候选）
    { id: 'c2', ruleId: 'OPP-11', subject: 'skill', evidence: [{ sessionId: 'sess-other', ts: iso(NOW - 2 * D) }] },
  ]
  const it = buildAttribution({ events, candidates, now: NOW }).items[0]
  assert.deepEqual(it.candidates.map((c) => c.id), ['c1'])
})

test('★ 稳定性：乱序输入 ⇒ 输出完全一致（按 count desc 再按 fp 排序）', () => {
  const a = [
    ev('transcript', NOW - 2 * D, '111111111111', 's#1'),
    ev('log', NOW - 2 * D, '222222222222', 'x#1'),
    ev('transcript', NOW - 1 * D, '222222222222', 's#2'),
  ]
  const r1 = buildAttribution({ events: a, now: NOW })
  const r2 = buildAttribution({ events: [...a].reverse(), now: NOW })
  assert.deepEqual(r1.items.map((i) => i.fp), r2.items.map((i) => i.fp))
  assert.equal(r1.items[0].fp, '222222222222')
})

// ── 2026-10-27：修复行没有 fp 时的归属规则（doctor 自包含，不许 import kernel ⇒ 只认 probeId）──
test('★ 修复行无 fp：同探针唯一指纹 ⇒ 归属；多指纹 ⇒ 不猜（fixWithoutFp）', async () => {
  const now = Date.parse('2026-10-27T12:00:00.000Z')
  const D = 86400000
  const iso = (t) => new Date(t).toISOString()
  const events = [
    // detect（带 fp、带 probeId）
    { src: 'journal', kind: 'detect', probeId: 'data-dirs', fp: 'aaaaaaaaaaaa', at: iso(now - 3 * D), ref: 'j#1' },
    // 同探针的修复（无 fp）⇒ 可反推
    { src: 'journal', kind: 'act', probeId: 'data-dirs', actionId: 'data-dirs', ok: true, at: iso(now - 2 * D), ref: 'j#2', extra: { verified: true } },
    // 另一个探针在历史上有两个不同指纹 ⇒ 修复行不得归属
    { src: 'journal', kind: 'detect', probeId: 'multi', fp: 'bbbbbbbbbbbb', at: iso(now - 3 * D), ref: 'j#3' },
    { src: 'journal', kind: 'detect', probeId: 'multi', fp: 'cccccccccccc', at: iso(now - 2 * D), ref: 'j#4' },
    { src: 'journal', kind: 'act', probeId: 'multi', actionId: 'multi', ok: true, at: iso(now - D), ref: 'j#5' },
  ]
  const out = buildAttribution({ events, candidates: [], now, windowDays: 30 })
  const a = out.items.find((i) => i.fp === 'aaaaaaaaaaaa')
  assert.equal(a.fixes.length, 1, '★ 唯一指纹的探针：修复行必须归属')
  assert.equal(a.fixes[0].linkedBy, 'probeId')
  assert.equal(out.dropped.fixWithoutFp, 1, '★ 多指纹 ⇒ 宁可丢也不猜')
})
