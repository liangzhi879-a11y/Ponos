// src/lib/knowledgeInspector.test.ts —— 右栏纯逻辑（node --test，S2 Task 9）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ageParts, buildOutline, dedupeSources, outlineIndent } from './knowledgeInspector.ts'
import type { BlockLike } from './knowledgeBlocks.ts'

const b = (over: Partial<BlockLike> & { line: number }): BlockLike => ({ kind: 'paragraph', text: 'x', ...over })

test('buildOutline：只收 heading，且丢弃空标题', () => {
  const out = buildOutline([
    b({ kind: 'heading', level: 1, text: ' 一级 ', line: 3 }),
    b({ kind: 'paragraph', text: '正文', line: 5 }),
    b({ kind: 'heading', level: 2, text: '   ', line: 7 }),   // 空标题：点它无处可跳
    b({ kind: 'heading', level: 3, text: '三级', line: 9 }),
  ])
  assert.deepEqual(out, [
    { n: 0, line: 3, level: 1, text: '一级' },
    { n: 3, line: 9, level: 3, text: '三级' },
  ])
})

test('buildOutline：脏 level / 缺失 line 不产生负缩进或 NaN', () => {
  const out = buildOutline([
    b({ kind: 'heading', level: 0 as number, text: 'a', line: 1 }),
    b({ kind: 'heading', level: 99, text: 'b', line: Number.NaN }),
  ])
  assert.equal(out[0].level, 1)
  assert.equal(out[1].level, 6)      // 封顶 6（clampLevel）
  assert.equal(out[1].line, 0)
})

test('buildOutline：undefined / 空数组 → []', () => {
  assert.deepEqual(buildOutline(undefined), [])
  assert.deepEqual(buildOutline([]), [])
})

test('outlineIndent：随级别递增、封顶 5 级', () => {
  assert.equal(outlineIndent(1), 6)
  assert.equal(outlineIndent(2), 15)
  assert.equal(outlineIndent(5), 42)
  assert.equal(outlineIndent(6), 42, '6 级与 5 级同缩进：再往右就挤不下正文了')
  assert.equal(outlineIndent(0), 6, '非法级别回落首级')
})

test('ageParts：分档阈值与边界（向下取整，宁可说 59 分钟）', () => {
  assert.deepEqual(ageParts(0), { unit: 'now', value: 0 })
  assert.deepEqual(ageParts(59_999), { unit: 'now', value: 0 })
  assert.deepEqual(ageParts(60_000), { unit: 'minute', value: 1 })
  assert.deepEqual(ageParts(3_599_999), { unit: 'minute', value: 59 })
  assert.deepEqual(ageParts(3_600_000), { unit: 'hour', value: 1 })
  assert.deepEqual(ageParts(86_399_999), { unit: 'hour', value: 23 })
  assert.deepEqual(ageParts(86_400_000), { unit: 'day', value: 1 })
})

test('ageParts：null / 非数 / 负数 → null（"没数据"不许显示成"刚刚"）', () => {
  assert.equal(ageParts(null), null)
  assert.equal(ageParts(undefined), null)
  assert.equal(ageParts(Number.NaN), null)
  assert.equal(ageParts(-1), null)
})

test('dedupeSources：同一来源出现多次只留一条（后端 in 是逐链接推出来的）', () => {
  assert.deepEqual(dedupeSources([{ from: 'a/x.md' }, { from: 'a/x.md' }, { from: 'b/y.md' }]), ['a/x.md', 'b/y.md'])
  assert.deepEqual(dedupeSources([{ from: '  ' }, {}, { from: 'ok.md' }]), ['ok.md'])
  assert.deepEqual(dedupeSources(undefined), [])
})
