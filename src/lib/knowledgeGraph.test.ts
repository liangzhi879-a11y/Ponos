// src/lib/knowledgeGraph.test.ts —— 图谱布局纯逻辑（node --test，S2 Task 8）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { layoutGraph, nodeDegrees, resolvedEdges, shortRef } from './knowledgeGraph.ts'

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
