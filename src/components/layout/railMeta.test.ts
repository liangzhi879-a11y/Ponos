// src/components/layout/railMeta.test.ts
// node --test src/components/layout/railMeta.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
// 覆盖 railMeta 的两处 rail 合法性判定：RAIL 表（RailNav 渲染源）与 railId() 兜底。
// 与 viewStore.sanitizeRail 是两条独立 guard，二者合法集合必须同步——漏一处 rail 会静默丢。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RAIL, railId } from './railMeta.ts'

test('RAIL：apps（应用智控）在常驻标签栏表中，且 id 唯一', () => {
  // Task 1.1：与应用/任务/智能体/技能/工作流平级的第六项
  assert.ok(RAIL.some(r => r.id === 'apps'), 'RAIL 缺 apps 条目')
  const ids = RAIL.map(r => r.id)
  assert.equal(new Set(ids).size, ids.length, 'RAIL id 重复')
  // 每项都要有图标与文案 key（RailNav 渲染契约）
  for (const item of RAIL) {
    assert.ok(item.icon, `${item.id} 缺 icon`)
    assert.match(item.labelKey, /^rail\./, `${item.id} labelKey 应形如 rail.<id>`)
  }
})

test('railId：apps 透传，非法 id 回退 task', () => {
  assert.equal(railId('apps'), 'apps')
  assert.equal(railId('nope'), 'task')
})

test('railId 与 RAIL 合法集合一致（railMeta guard 不漏项）', () => {
  for (const item of RAIL) assert.equal(railId(item.id), item.id)
})
