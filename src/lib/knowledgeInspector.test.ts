// src/lib/knowledgeInspector.test.ts —— 右栏纯逻辑（node --test，S2 Task 9）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ageParts, buildOutline, dedupeSources, groupBacklinks, outlineIndent } from './knowledgeInspector.ts'
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

// ── 2026-09-14 批次 2：反链分组（上下文 + 锚点 + 嵌入）────────────────────────

test('groupBacklinks：按来源分组、组内按行升序、保留上下文与锚点', () => {
  const groups = groupBacklinks([
    { from: 'a.md', line: 9, snippet: '第二处', anchorRef: '某节', anchorKind: 'heading' },
    { from: 'a.md', line: 3, snippet: '第一处', embed: true },
    { from: 'b.md', line: 5, snippet: '别处' },
  ])
  // 组间按引用处数降序：a.md 有 2 处 → 排最前（被引最多的来源通常最相关）
  assert.deepEqual(groups.map(g => g.from), ['a.md', 'b.md'])
  // 组内按行号升序 = 阅读顺序（不是插入顺序）——这是"顺着往下看就是文档推进顺序"的前提
  assert.deepEqual(groups[0].refs.map(r => r.line), [3, 9])
  assert.equal(groups[0].refs[0].embed, true, '嵌入标记要透传（UI 要显示"嵌入"）')
  assert.equal(groups[0].refs[1].anchorRef, '某节', '锚点要透传（UI 要显示 #锚点）')
  assert.equal(groups[0].refs[0].snippet, '第一处', '上下文片段要透传（反链面板的核心价值）')
})

test('groupBacklinks：脏数据/老内核字段缺失时退化而不丢条目、不抛错', () => {
  // 批次 2 之前的索引只有 `{from}`：组仍在，refs 只有一行且 line 为 null（UI 显示 L?）
  const legacy = groupBacklinks([{ from: 'a.md' }, { from: 'a.md' }])
  assert.equal(legacy.length, 1)
  assert.equal(legacy[0].refs.length, 2, '同一来源的两条老记录都要保留（不去重掉）')
  assert.equal(legacy[0].refs[0].line, null)
  // 空 from 一律丢弃（`{from:'  '}` / `{}`）；空数组输入 → 空数组输出
  // （`{}` / `undefined` 用 as never 是因为类型层不允许——这里正是要测"运行时收到脏数据"）
  assert.deepEqual(groupBacklinks([{ from: '  ' }, {} as never, undefined as never]), [])
  assert.deepEqual(groupBacklinks(undefined), [])
  // 同数时的稳定排序：不能因重渲染而顺序抖动
  assert.deepEqual(groupBacklinks([{ from: 'b.md' }, { from: 'a.md' }]).map(g => g.from), ['a.md', 'b.md'])
})
