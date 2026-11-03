// kernel-tests/attribution-sources.test.mjs —— P1 Task 2：三源抽取器（设计 §4.1、方案 Task 2）
//
// 抽取器的职责只有一个：**把三处异构证据变成同一种事件**，且「读不到」必须如实说（skipped），
// 不许把"没测到"当成"没问题"（同 OPP-11 的"没有实测不参与"纪律）。
// 用 tmp 目录造最小样本：不依赖本机真实数据，断言可重放。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  collectJournalEvents, collectLogEvents, collectTranscriptEvents, collectAllEvents,
} from '../kernel/attribution-sources.mjs'

const NOW = Date.parse('2026-10-27T12:00:00.000Z')
const DAY = 86400_000

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-attr-'))
  try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

// ── journal ───────────────────────────────────────────────────────────────
test('★ journal：detect/act 进入事件流；decide 之类不参与；坏行跳过', () => withTmp((home) => {
  mkdirSync(join(home, 'journal'))
  const rows = [
    { at: '2026-10-27T10:00:00.000Z', kind: 'detect', ok: false, probeId: 'config-valid', detail: "open 'C:\\a\\b.json' failed" },
    { at: '2026-10-27T10:01:00.000Z', kind: 'act', ok: true, actionId: 'config-valid', detail: '已应用' },
    { at: '2026-10-27T10:02:00.000Z', kind: 'decide', ok: false, detail: '不该进事件流' },
  ]
  writeFileSync(join(home, 'journal', '2026-10-27.ndjson'),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n{坏行\n', 'utf8')

  const { events, skipped } = collectJournalEvents({ homeDir: home, windowDays: 30, now: NOW })
  assert.equal(events.length, 2, '只取 detect/act（坏行与 decide 都不算）')
  assert.ok(events.every((e) => e.src === 'journal'))
  assert.ok(events.every((e) => typeof e.ref === 'string' && e.ref.startsWith('journal/')), 'ref 指回文件+行号')
  assert.equal(skipped.length, 1, '坏行要如实记一条 skipped（不是静默）')
}))

test('★ journal：同一错误写两次（路径不同）⇒ 同 fp；窗口外的老事件被排除', () => withTmp((home) => {
  mkdirSync(join(home, 'journal'))
  const rows = [
    { at: '2026-10-27T10:00:00.000Z', kind: 'detect', ok: false, detail: "ENOENT, open 'C:\\x\\a.json'" },
    { at: '2026-10-27T11:00:00.000Z', kind: 'detect', ok: false, detail: "ENOENT, open 'D:\\y\\b.json'" },
    { at: '2026-01-01T00:00:00.000Z', kind: 'detect', ok: false, detail: "ENOENT, open 'E:\\old\\c.json'" },
  ]
  writeFileSync(join(home, 'journal', '2026-10-27.ndjson'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  const { events } = collectJournalEvents({ homeDir: home, windowDays: 30, now: NOW })
  assert.equal(events.length, 2, '窗口外的老事件不参与')
  assert.equal(events[0].fp, events[1].fp, '同一错误换路径 ⇒ 同 fp')
}))

// ── 渲染层日志 ─────────────────────────────────────────────────────────────
test('★ 日志：只取固定前缀的错误行，console 噪音不进汇总', () => withTmp((home) => {
  mkdirSync(join(home, 'logs'))
  const lines = [
    '[render] render-process-gone reason=oom exitCode=1',
    '[console] 随便一条调试输出',
    'did-fail-load -6 ERR_CONNECTION_REFUSED http://127.0.0.1:28717/',
    '[warn] 无关噪音',
  ]
  writeFileSync(join(home, 'logs', 'app.log'), lines.join('\n') + '\n', 'utf8')
  const { events } = collectLogEvents({ homeDir: home, windowDays: 30, now: NOW })
  assert.equal(events.length, 2, '只有两条是错误行')
  assert.ok(events.every((e) => e.src === 'log'))
  assert.ok(events.every((e) => typeof e.ref === 'string' && e.ref.startsWith('log/')))
  assert.equal(new Set(events.map((e) => e.fp)).size, 2, '两条不同错误 ⇒ 两个 fp')
}))

// ── 转录 ──────────────────────────────────────────────────────────────────
test('★ 转录：只取 tool_result.is_error === true 的条目，ref = 会话#序号', () => withTmp((cfg) => {
  const dir = join(cfg, 'projects', 'C--proj')
  mkdirSync(dir, { recursive: true })
  const rows = [
    { timestamp: '2026-10-27T09:00:00.000Z', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] } },
    { timestamp: '2026-10-27T09:00:01.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: '退出码 2 stderr: only stream-json I/O format is supported' }] } },
    { timestamp: '2026-10-27T09:00:02.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '正常输出' }] } },
  ]
  writeFileSync(join(dir, 'sess-abc.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

  const { events } = collectTranscriptEvents({ configDir: cfg, windowDays: 30, now: NOW })
  assert.equal(events.length, 1, '只有 is_error 的那条')
  assert.equal(events[0].src, 'transcript')
  assert.match(events[0].ref, /^sess-abc#\d+$/, 'ref = 会话#序号')
  assert.ok(typeof events[0].fp === 'string' && events[0].fp.length === 12)
}))

// ── 容错：读不到如实说，不抛 ─────────────────────────────────────────────────
test('★★ 容错：目录不存在 ⇒ 空事件 + skipped 原因（绝不抛、不按 0 计）', () => withTmp((home) => {
  assert.doesNotThrow(() => collectJournalEvents({ homeDir: home, windowDays: 30, now: NOW }))
  const j = collectJournalEvents({ homeDir: home, windowDays: 30, now: NOW })
  assert.deepEqual(j.events, [])
  assert.ok(j.skipped.length === 1 && /journal/.test(JSON.stringify(j.skipped)), 'skipped 要指明是哪个源')

  const l = collectLogEvents({ homeDir: home, windowDays: 30, now: NOW })
  assert.deepEqual(l.events, [])
  assert.ok(l.skipped.length === 1)

  const t = collectTranscriptEvents({ configDir: home, windowDays: 30, now: NOW })
  assert.deepEqual(t.events, [])
  assert.ok(t.skipped.length === 1)
}))

test('★ collectAllEvents：三源合并，且逐源 skipped 都带出来（供 UI 明示"哪部分没读到"）', () => withTmp((home) => {
  mkdirSync(join(home, 'journal'))
  writeFileSync(join(home, 'journal', '2026-10-27.ndjson'),
    JSON.stringify({ at: '2026-10-27T10:00:00.000Z', kind: 'detect', ok: false, detail: 'boom' }) + '\n', 'utf8')
  const r = collectAllEvents({ homeDir: home, configDir: home, windowDays: 30, now: NOW })
  assert.equal(r.events.length, 1)
  assert.ok(Array.isArray(r.skipped))
  assert.ok(r.events.every((e) => 'src' in e && 'at' in e && 'fp' in e && 'ref' in e && 'snippet' in e),
    '统一事件形状：src/at/fp/ref/snippet')
  assert.ok(r.events[0].snippet.length <= 200, 'snippet 有上限（只供人核）')
}))