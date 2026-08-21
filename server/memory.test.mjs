// server/memory.test.mjs —— P5 L3-1 记忆内核化（与 GUI experience.mjs 同数据源/格式/去重算法）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendMemoryEntry, readMemoryEntries, buildMemoryIndex, captureMemoryCandidates, hashLine } from '../kernel/memory.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'yfw-mem-'))
test.after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch {} })

test('hashLine：与 experience.mjs 同算法（兼容 GUI 面板去重）', () => {
  const ref = (text) => {
    let h = 0
    for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0
    return (h >>> 0).toString(16).padStart(8, '0')
  }
  const t = '- [会话|测试] 摘要 -- 全文'
  assert.equal(hashLine(t), ref(t))
  assert.equal(hashLine('abc'), hashLine('abc'))
  assert.notEqual(hashLine('abc'), hashLine('abd'))
})

test('appendMemoryEntry：写文件 + 读回 + 去重', () => {
  const root = join(tmp, 'mem1')
  mkdirSync(root, { recursive: true })
  const r1 = appendMemoryEntry({ root, theme: 'workflow', tag: '测试', summary: '摘要一', full: '全文一' })
  assert.equal(r1.ok, true)
  const r2 = appendMemoryEntry({ root, theme: 'workflow', tag: '测试', summary: '摘要一', full: '全文一' })
  assert.equal(r2.deduped, true)
  const entries = readMemoryEntries({ root, theme: 'workflow' })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].tag, '测试')
  assert.equal(entries[0].summary, '摘要一')
  assert.equal(entries[0].full, '全文一')
  const raw = readFileSync(join(root, 'workflow.md'), 'utf-8')
  assert.ok(raw.startsWith('---\nname: workflow'))
  assert.ok(raw.includes('- [会话|测试] 摘要一 -- 全文一'))
})

test('buildMemoryIndex：格式与 experience.mjs 索引一致', () => {
  const root = join(tmp, 'mem2')
  mkdirSync(root, { recursive: true })
  appendMemoryEntry({ root, theme: 'workflow', tag: '导出', summary: 's', full: 'f' })
  const idx = buildMemoryIndex({ root })
  assert.ok(idx.includes('【个人经验索引】'))
  assert.ok(idx.includes('[workflow|导出]'))
  assert.ok(idx.trim().endsWith('.md')) // 末行携带文件路径（与 GUI 索引同格式，行尾换行）
})

test('captureMemoryCandidates：纠错 → workflow / 偏好 → communication', () => {
  assert.deepEqual(captureMemoryCandidates({ userText: '以后不要用 sed 改文件' }).map((c) => c.theme), ['workflow'])
  assert.deepEqual(captureMemoryCandidates({ userText: '我习惯先读文件再改' }).map((c) => c.theme), ['communication'])
  assert.deepEqual(captureMemoryCandidates({ userText: '实现导出功能' }), [])
})
