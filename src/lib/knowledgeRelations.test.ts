// src/lib/knowledgeRelations.test.ts
// 运行：node --test src/lib/knowledgeRelations.test.ts（Node 24 原生 TS；相对导入带 .ts）
//
// 这是 S5 Task 9 的**逻辑**测试（本仓库无 DOM 环境，组件渲染属人工走查）：
// 分组/排序/计数/shared 裁剪/图谱两层边合并全部在这里钉住，组件里只剩 map + 渲染。
// 期望值一律按 spec §7.5 与内核口径（tag → content → duplicate 层序、duplicate 不算关联）写。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  duplicateNotice, formatScore, hasRelations, indexByBlock, mergeGraphEdges, relatedCounts,
  relatedGroup, splitAnchors, trimShared,
} from './knowledgeRelations.ts'
import type { KnowledgeRelatedAnchor } from './knowledgeApi.ts'

const anchor = (
  blockId: string,
  why: KnowledgeRelatedAnchor['why'],
  score: number | null = null,
): KnowledgeRelatedAnchor => ({ blockId, docId: blockId.split('#')[0], title: `T:${blockId}`, why, score })

const TAG_A = anchor('d1.md#0', { kind: 'tag', tag: '应用智控' })
const TAG_B = anchor('d1.md#1', { kind: 'tag', tag: '应用智控' })
const SIM_LOW = anchor('d2.md#0', { kind: 'content', score: 0.21, shared: ['功能', '原型', '看板', '排期', '验收'] }, 0.21)
const SIM_HIGH = anchor('d3.md#0', { kind: 'content', score: 0.44, shared: ['校验'] }, 0.44)
const DUP = anchor('d4.md#0', { kind: 'duplicate', score: 0.98 }, 0.98)

test('relatedGroup：三类各归其位；未知/畸形 why 归 other（不当作已解释的关联展示）', () => {
  assert.equal(relatedGroup({ kind: 'tag', tag: 'x' }), 'themed')
  assert.equal(relatedGroup({ kind: 'content', score: 0.2, shared: ['a'] }), 'similar')
  assert.equal(relatedGroup({ kind: 'duplicate', score: 1 }), 'duplicate')
  assert.equal(relatedGroup({ kind: '同目录' }), 'other', '将来新增层：宁可少显示，也不静默当成关联')
  assert.equal(relatedGroup(undefined), 'other')
  assert.equal(relatedGroup('tag'), 'other', 'why 是字符串（上游契约漂移）不得抛错')
})

test('splitAnchors：分组 + 按 blockId 去重 + similar 按 score 降序（tag 也排成确定顺序）', () => {
  const g = splitAnchors([SIM_LOW, TAG_A, DUP, SIM_HIGH, TAG_B, anchor('d9.md#0', { kind: '同目录' } as never)])
  assert.deepEqual(g.themed.map(a => a.blockId), ['d1.md#0', 'd1.md#1'])
  assert.deepEqual(g.similar.map(a => a.blockId), ['d3.md#0', 'd2.md#0'], '内容层按分数降序')
  assert.deepEqual(g.duplicates.map(a => a.blockId), ['d4.md#0'])
  assert.equal(g.other.length, 1, '未知层单独收好，界面不渲染')

  // 同一目标块出现两次（将来两层都算时会遇到）→ 只留先到的一条，避免看起来像两条不同关系
  const twice = splitAnchors([TAG_A, { ...TAG_A, why: { kind: 'content', score: 0.5, shared: ['x'] } as const }])
  assert.equal(twice.themed.length + twice.similar.length, 1)

  // 脏数据：缺 blockId 的条目直接跳过（blockId 是渲染 key，缺了会串行）
  assert.deepEqual(splitAnchors([{ ...TAG_A, blockId: '' }]).themed, [])
  assert.deepEqual(splitAnchors().themed, [], 'undefined 输入 → 全空（不抛）')
})

test('relatedCounts / hasRelations：计数按层；只有 duplicate 时**没有关联**（卡片不显示关联行）', () => {
  const all = [TAG_A, TAG_B, SIM_LOW, DUP]
  assert.deepEqual(relatedCounts(all), { themed: 2, similar: 1, duplicate: 1 })
  assert.equal(hasRelations(all), true)
  assert.equal(hasRelations([DUP]), false, 'duplicate 是去重提示，不是关联（spec §5.5）')
  assert.equal(hasRelations([]), false)
  assert.equal(hasRelations(undefined), false)
})

test('trimShared：最多 3 个词 + 余量计数；非字符串/空白剔除；max=0 合法', () => {
  assert.deepEqual(trimShared(['功能', '原型', '看板', '排期', '验收']), { words: ['功能', '原型', '看板'], more: 2 })
  assert.deepEqual(trimShared([' 校验 ', 42, '', '  ', null]), { words: ['校验'], more: 0 })
  assert.deepEqual(trimShared(undefined), { words: [], more: 0 })
  assert.deepEqual(trimShared(['a', 'b'], 0), { words: [], more: 2 })
})

test('duplicateNotice：无重复 → null；有 → 条数 + **最高**分（用户要的是"最像的那条多像"）', () => {
  assert.equal(duplicateNotice([TAG_A, SIM_LOW]), null)
  assert.deepEqual(duplicateNotice([DUP, anchor('d5.md#0', { kind: 'duplicate', score: 0.97 }, 0.97)]), { count: 2, score: 0.98 })
  // score 缺失（上游未给）→ score null，count 仍要给（提示本身不能因此消失）
  assert.deepEqual(duplicateNotice([anchor('d6.md#0', { kind: 'duplicate', score: 1 }, null)]), { count: 1, score: null })
})

test('formatScore：2 位小数；null/NaN/Infinity → null（界面宁可不显示，也不显示 "NaN"）', () => {
  assert.equal(formatScore(0.21), '0.21')
  assert.equal(formatScore(0.2), '0.20')
  assert.equal(formatScore(null), null)
  assert.equal(formatScore(undefined), null)
  assert.equal(formatScore(Number.NaN), null)
  assert.equal(formatScore(Number.POSITIVE_INFINITY), null)
})

test('indexByBlock：blockId → 锚点；重复 blockId 合并而非覆盖；空项跳过', () => {
  const m = indexByBlock([
    { blockId: 'd1.md#0', related: [TAG_A] },
    { blockId: 'd1.md#0', related: [SIM_LOW] },
    { blockId: '', related: [DUP] },
    { blockId: 'd1.md#1' as string, related: undefined as unknown as KnowledgeRelatedAnchor[] },
  ])
  assert.deepEqual(m.get('d1.md#0')?.map(a => a.blockId), ['d1.md#0', 'd2.md#0'])
  assert.equal(m.has(''), false)
  assert.deepEqual(m.get('d1.md#1'), [], 'related 缺字段 → 空数组（不是 undefined，调用方无需判空）')
  assert.equal(indexByBlock(undefined).size, 0)
})

test('mergeGraphEdges：默认（图层关）只显式链接，且与 S2 既有口径逐字一致（有向去重、保序）', () => {
  const links = [
    { from: 'a.md', to: 'b.md', target: 'b.md' },
    { from: 'a.md', to: 'b.md', target: 'b.md' },   // 同一对的多条链接 → 合成一条
    { from: 'c.md', to: 'a.md', target: 'a.md' },
  ]
  const related = [{ from: 'b.md', to: 'c.md', kind: 'tag' as const, score: null, count: 3 }]
  const off = mergeGraphEdges(links, related, false)
  assert.deepEqual(off.edges.map(e => e.id), ['a.md->b.md', 'c.md->a.md'])
  assert.deepEqual(off.counts, { link: 2, related: 0 }, '图层关：隐式边一条都不许混进来')
  assert.equal(off.edges.every(e => e.layer === 'link'), true)
})

test('mergeGraphEdges：图层开 → 追加隐式边（tag 在前、分降序），与显式同对时丢弃，自环丢弃', () => {
  const links = [{ from: 'a.md', to: 'b.md', target: 'b.md' }]
  const related = [
    { from: 'b.md', to: 'a.md', kind: 'tag' as const, score: null, count: 2 },   // 已有显式边 → 不重复画
    { from: 'c.md', to: 'd.md', kind: 'content' as const, score: 0.30, count: 1 },
    { from: 'e.md', to: 'e.md', kind: 'tag' as const, score: null, count: 1 },   // 自环
    { from: 'b.md', to: 'c.md', kind: 'tag' as const, score: null, count: 4 },
    { from: 'd.md', to: 'e.md', kind: 'content' as const, score: 0.44, count: 2 },
  ]
  const on = mergeGraphEdges(links, related, true)
  assert.deepEqual(on.edges.map(e => e.id), ['a.md->b.md', 'r:b.md->c.md', 'r:d.md->e.md', 'r:c.md->d.md'])
  assert.deepEqual(on.counts, { link: 1, related: 3 }, 'counts 是**画出来**的边数（与画布对得上）')
  assert.deepEqual(on.edges.find(e => e.id === 'r:b.md->c.md'), {
    id: 'r:b.md->c.md', from: 'b.md', to: 'c.md', layer: 'related', target: 'c.md', kind: 'tag', score: null, count: 4,
  })
  assert.equal(on.edges.some(e => e.id.startsWith('r:b.md->a.md')), false, '显式优先：同无序对不再画虚线')
})

test('mergeGraphEdges：缺字段/未知 kind 一律兜底，不抛错（读侧不因脏数据白屏）', () => {
  const on = mergeGraphEdges(
    [{ from: 'a.md', to: '' } as never],
    // 整对象 `as never`（同上一行）：本用例要喂**脏数据**，故意缺 `count` 测兜底，
    // 不能为过 tsc 补一个 `count: 1` —— 那会把"缺字段兜底"这条断言测没了。
    [{ from: 'a.md', to: 'b.md', kind: 'mystery', score: Number.NaN } as never],
    true,
  )
  assert.deepEqual(on.edges.map(e => e.id), ['r:a.md->b.md'], '端点缺 to 的显式边丢弃')
  assert.equal(on.edges[0].kind, 'content', '未知 kind 兜底到内容层（不会伪装成最可信的 tag）')
  assert.equal(on.edges[0].score, null, 'NaN 分数归一成 null')
  assert.equal(on.edges[0].count, 0)
})
