// src/lib/knowledgeGraph.test.ts —— 图谱布局纯逻辑（node --test，S2 Task 8）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { layoutGraph, layoutSections, nodeDegrees, resolvedEdges, shortRef } from './knowledgeGraph.ts'

const nodes = (...ids: string[]) => ids.map(id => ({ id }))

test('nodeDegrees：出入边都计数', () => {
  const d = nodeDegrees([{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'a', to: 'c' }])
  assert.equal(d.get('a'), 2)
  assert.equal(d.get('b'), 2)
  assert.equal(d.get('c'), 2)
  assert.equal(d.get('zzz'), undefined)
})

test('layoutGraph：hub 在前，且与入参顺序无关（确定性）', () => {
  const edges = [{ from: 'hub', to: 'a' }, { from: 'hub', to: 'b' }]
  const p1 = layoutGraph(nodes('a', 'b', 'hub'), edges)
  const p2 = layoutGraph(nodes('hub', 'b', 'a'), edges)   // 只换入参顺序
  assert.deepEqual(p1, p2, '同数据必须同布局：否则切视图回来画布会整体跳动')
  assert.equal(p1[0].id, 'hub')
  // 度数相同时按 id 升序兜底（否则排序结果由 sort 实现决定，不稳定）
  assert.deepEqual(p1.slice(1).map(p => p.id), ['a', 'b'])
})

test('layoutGraph：网格无重叠、列数 ≤ 6', () => {
  const ids = Array.from({ length: 20 }, (_, i) => `d${String(i).padStart(2, '0')}`)
  const pos = layoutGraph(nodes(...ids), [])
  const seen = new Set(pos.map(p => `${p.x},${p.y}`))
  assert.equal(seen.size, pos.length, '任何两个节点不得落在同一格')
  const xs = [...new Set(pos.map(p => p.x))]
  assert.ok(xs.length <= 6, `列数应 ≤ 6，实际 ${xs.length}`)
  assert.equal(xs.length, 5, '20 个节点 → ceil(sqrt(20)) = 5 列')
})

test('layoutGraph：空集/脏数据不抛', () => {
  assert.deepEqual(layoutGraph([], []), [])
  assert.deepEqual(layoutGraph([{ id: '' }], []), [])
})

test('resolvedEdges：丢掉悬空边（xyflow 对悬空边会报错并静默丢）', () => {
  const ns = nodes('a', 'b')
  assert.deepEqual(
    resolvedEdges(ns, [{ from: 'a', to: 'b' }, { from: 'a', to: 'ghost' }, { from: 'ghost', to: 'b' }]),
    [{ from: 'a', to: 'b' }],
  )
})

test('shortRef：docId 取末段', () => {
  assert.equal(shortRef('experience/workflow.md'), 'workflow.md')
  assert.equal(shortRef('knowledge\\a\\b.md'), 'b.md')
  assert.equal(shortRef('plain.md'), 'plain.md')
  assert.equal(shortRef(''), '')
})

// ── S5.1：孤立节点分区（用户实测反馈："只有上部的条目连接了，下边的全都没有连"）──
// 原布局按度数降序**混排**一个网格 ⇒ 零度节点必然连续沉到最底部若干行，看起来像图谱坏了。
// 修的思路：零度节点单独成一个区块（留空行 + 画布分区标签），但**不删不隐藏**。

test('layoutSections：孤立节点排到下方独立区块，与关联区之间留有空行', () => {
  // hub–a–b 有关联；x1..x4 度数为 0
  const edges = [{ from: 'hub', to: 'a' }, { from: 'hub', to: 'b' }]
  const ns = nodes('hub', 'a', 'b', 'x1', 'x2', 'x3', 'x4')
  const sec = layoutSections(ns, edges)

  assert.equal(sec.connectedCount, 3, 'hub/a/b 有边 → 关联区')
  assert.equal(sec.isolatedCount, 4, 'x1..x4 无任何边 → 孤立区')
  assert.equal(sec.positions.length, ns.length, '分区不得丢节点（少一个都像数据丢失）')

  const byId = new Map(sec.positions.map(p => [p.id, p]))
  const connectedMaxY = Math.max(...['hub', 'a', 'b'].map(id => byId.get(id)!.y))
  const isolatedMinY = Math.min(...['x1', 'x2', 'x3', 'x4'].map(id => byId.get(id)!.y))
  assert.ok(isolatedMinY > connectedMaxY, '孤立区必须在关联区**下方**（否则"独立成区"无从谈起）')
  // 关键：留出**空行**，否则两区在视觉上仍是连成一片的网格，等于没分区
  assert.ok(sec.isolatedTopY !== null && sec.isolatedTopY > connectedMaxY + 0,
    `孤立区起点应严格低于关联区最后一行（gap 生效）`)
  assert.ok(sec.isolatedTopY! - connectedMaxY >= 92,
    '孤立区与关联区之间至少空一行（ROW_H=92），空行是分区的视觉依据')
})

test('layoutSections：无孤立节点时退化为原行为（isolatedTopY 为 null、不额外留空）', () => {
  const edges = [{ from: 'hub', to: 'a' }]
  const sec = layoutSections(nodes('hub', 'a'), edges)
  assert.equal(sec.isolatedCount, 0)
  assert.equal(sec.isolatedTopY, null, '没有孤立区就不该有分区标签（视图据 null 不渲染标签）')
  // 与 layoutGraph 一致（前者是后者的坐标来源）
  assert.deepEqual(sec.positions, layoutGraph(nodes('hub', 'a'), edges))
})

test('layoutSections：孤立区内部也确定性排序（换入参顺序结果不变）', () => {
  const edges = [{ from: 'hub', to: 'a' }]
  const p1 = layoutSections(nodes('hub', 'a', 'z', 'y', 'x'), edges)
  const p2 = layoutSections(nodes('x', 'y', 'z', 'a', 'hub'), edges)
  assert.deepEqual(p1, p2, '同数据必须同布局：否则切视图回来画布会整体跳动')
})

