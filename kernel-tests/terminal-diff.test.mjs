// 行级 diff hunk 生成（Task 4a）：`file_change.diff_hunk` 的真源。
// 边界：纯函数（不碰 fs / wire / transcript）；只产出**单 hunk、无上下文的** unified diff，
//   行号 1-based，超 maxBytes 截断并带标记。集成断言另验 Write/Edit 的 meta 真的挂上了它。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildHunk } from '../kernel/terminal-diff.mjs'

test('单行替换：行号与 -/+ 正确', () => {
  const h = buildHunk('a\nb\nc', 'a\nB\nc')
  assert.equal(h.split('\n')[0], '@@ -2,1 +2,1 @@')
  assert.ok(h.includes('\n-b'))
  assert.ok(h.includes('\n+B'))
})

test('新文件：@@ -0,0 +1,N @@ 全 + 行', () => {
  const h = buildHunk('', 'x\ny')
  assert.equal(h.split('\n')[0], '@@ -0,0 +1,2 @@')
  assert.ok(h.includes('\n+x'))
})

test('无改动返回空串', () => {
  assert.equal(buildHunk('a\nb', 'a\nb'), '')
})

test('超 maxBytes 被截断并带标记', () => {
  const big = Array.from({ length: 5000 }, (_, i) => `line-${i}`).join('\n')
  const h = buildHunk('', big, { maxBytes: 200 })
  assert.ok(Buffer.byteLength(h) <= 260)
  assert.ok(h.includes('已截断'))
})

test('Edit 的 meta 带 diffHunk', async () => {
  const { createToolRegistry } = await import('../kernel/tools.mjs')
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'hunk-'))
  const f = join(dir, 'a.txt')
  writeFileSync(f, 'one\ntwo\n')
  const reg = createToolRegistry({ cwd: dir })
  const r = await reg.run({ name: 'Edit', input: { file_path: f, old_string: 'two', new_string: 'TWO' } }, { toolUseId: 'e1' })
  assert.equal(r.isError, false)
  assert.match(String(r.meta?.diffHunk ?? ''), /^@@ /)
})
