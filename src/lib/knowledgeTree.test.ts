// src/lib/knowledgeTree.test.ts
// 运行：node --test src/lib/knowledgeTree.test.ts（Node 原生 TS，相对导入必须带 `.ts` 后缀）
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { indentFor, normalizeNoteName, resolveDocId, sortEntries } from './knowledgeTree.ts'

test('indentFor：8 + depth*12，120px 封顶，非法 depth 按 0 层', () => {
  assert.equal(indentFor(0), 8)
  assert.equal(indentFor(1), 20)
  assert.equal(indentFor(5), 68)
  assert.equal(indentFor(9), 116)
  assert.equal(indentFor(10), 120, '8+120=128 → 封顶 120（否则窄左栏里文件名宽度为 0）')
  assert.equal(indentFor(99), 120)
  assert.equal(indentFor(-1), 8)
  assert.equal(indentFor(Number.NaN), 8, 'NaN 不能污染 paddingLeft（会渲染成 "NaNpx"）')
  assert.equal(indentFor(Number.POSITIVE_INFINITY), 8)
  assert.equal(indentFor(2.7), 32, '小数向下取整')
})

test('sortEntries：目录在前、文件在后，数字感知排序，且不改动入参', () => {
  const input = [
    { name: 'a10.md', path: 'a10.md', type: 'file' as const },
    { name: 'dirB', path: 'b', type: 'dir' as const },
    { name: 'a2.md', path: 'a2.md', type: 'file' as const },
    { name: 'dirA', path: 'a', type: 'dir' as const },
  ]
  const snapshot = input.map(e => e.path)
  const out = sortEntries(input)
  assert.deepEqual(out.map(e => e.path), ['a', 'b', 'a2.md', 'a10.md'])
  assert.deepEqual(input.map(e => e.path), snapshot, '不得就地排序（entries 是跨组件共享引用）')
  assert.notEqual(out, input, '必须返回新数组')
})

test('resolveDocId：拼 `${space}/${rel}`，并吃掉前导斜杠', () => {
  assert.equal(resolveDocId('notes', 'a.md'), 'notes/a.md')
  assert.equal(resolveDocId('notes', '/a.md'), 'notes/a.md')
  assert.equal(resolveDocId('notes', 'sub/b.md'), 'notes/sub/b.md')
})

test('normalizeNoteName：补 .md 后缀并回带标题', () => {
  assert.deepEqual(normalizeNoteName('我的笔记'), { ok: true, path: '我的笔记.md', title: '我的笔记' })
  assert.deepEqual(normalizeNoteName('  a.md  '), { ok: true, path: 'a.md', title: 'a' })
  assert.deepEqual(normalizeNoteName('X.MD'), { ok: true, path: 'X.md', title: 'X' }, '大小写后缀归一')
})

test('normalizeNoteName：空 / 越界 / 非法字符一律拒绝', () => {
  assert.deepEqual(normalizeNoteName(''), { ok: false, reason: 'empty' })
  assert.deepEqual(normalizeNoteName('   '), { ok: false, reason: 'empty' })
  assert.deepEqual(normalizeNoteName('.md'), { ok: false, reason: 'invalid' })
  assert.deepEqual(normalizeNoteName('.hidden'), { ok: false, reason: 'invalid' })
  for (const bad of ['sub/a', 'sub\\a', '/etc/passwd', '..', '../a', 'a?.md', 'a*.md', 'a|b.md', 'a:b.md', 'a"b.md', 'a<b.md']) {
    assert.deepEqual(normalizeNoteName(bad), { ok: false, reason: 'invalid' }, `${bad} 必须被拒（后端 400 是兜底，不该让用户撞上去）`)
  }
})
