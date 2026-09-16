// src/lib/knowledgeScopeUi.test.ts —— 会话知识范围判据的单测（2026-09-15，P1）
//
// 这些判据"判错了会出丑"：关联开关画在内置经验库上 → 点了没反应（内核忽略），用户以为坏了；
// 上限判错 → 超限静默丢弃（用户点了没生效却没有任何反馈）；归一判错 → 同一状态产生不同签名，
// 每次发消息都白重启一次内核。故都放进 `src/lib/*Ui.ts`（组件里就进不了 `node --test`）。
//
// 权威收口仍在**内核**（kernel/knowledge.mjs 的 resolveSessionKnowledgeScope）：这里只测界面预判。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isAssociableSpace, normalizeKnowledgeSpaces, toggleKnowledgeSpace, isLargeSpace,
  MAX_ASSOC_SPACES, LARGE_SPACE_DOCS,
} from './knowledgeScopeUi.ts'

test('isAssociableSpace：只有 user/pack 给开关，内置空间一律不给', () => {
  assert.equal(isAssociableSpace({ source: 'user' }), true)
  assert.equal(isAssociableSpace({ source: 'pack' }), true)
  // 内置经验类：恒在会话范围内（内核 D4），画开关 = 画一个点不动的按钮
  assert.equal(isAssociableSpace({ source: 'experience' }), false)
  assert.equal(isAssociableSpace({ source: 'memory' }), false)
  assert.equal(isAssociableSpace({ source: 'skill_exp' }), false)
  // 未知来源/缺字段/null：**默认不给**（白名单，新增来源时默认落在"不给开关"一侧）
  assert.equal(isAssociableSpace({ source: 'brand-new' }), false)
  assert.equal(isAssociableSpace({}), false)
  assert.equal(isAssociableSpace(null), false)
  assert.equal(isAssociableSpace(undefined), false)
})

test('normalizeKnowledgeSpaces：脏值塌缩为 undefined（同一状态必须只有一个签名）', () => {
  assert.deepEqual(normalizeKnowledgeSpaces(['a', 'b']), ['a', 'b'])
  assert.deepEqual(normalizeKnowledgeSpaces([' b ', 'a', 'b']), ['b', 'a'], '去空 + 去重 + **保序**（顺序=提示词里的优先级）')
  for (const bad of [undefined, null, 'a', {}, 0, [], ['', '  '], [null, undefined]]) {
    assert.equal(normalizeKnowledgeSpaces(bad), undefined, `${JSON.stringify(bad)} 应归一为"未关联"`)
  }
})

test('toggleKnowledgeSpace：加入 / 移除 / 超上限出声', () => {
  assert.deepEqual(toggleKnowledgeSpace(undefined, 'docs').spaces, ['docs'])
  assert.deepEqual(toggleKnowledgeSpace(['docs'], 'docs').spaces, undefined, '取消最后一个 → 未关联（而不是 []）')
  assert.deepEqual(toggleKnowledgeSpace(['a', 'docs', 'b'], 'docs').spaces, ['a', 'b'], '保序移除')
  const full = Array.from({ length: MAX_ASSOC_SPACES }, (_, i) => `s${i}`)
  const r = toggleKnowledgeSpace(full, 'overflow')
  assert.equal(r.rejected, 'limit', '超上限必须被拒绝**且告知**（静默丢弃 = 用户点了没生效）')
  assert.deepEqual(r.spaces, full, '被拒绝时原值不变（不能"丢了最后一个塞新的"）')
  // 满额时"取消"仍然可用（否则满额即锁死，用户只能删库才能换库）
  assert.equal(toggleKnowledgeSpace(full, 's0').spaces?.length, MAX_ASSOC_SPACES - 1)
  assert.equal(toggleKnowledgeSpace(['a'], ' ').spaces?.length, 1, '空白 id 不做任何事')
})

test('isLargeSpace：阈值处必须"大"，零/缺省必须"不大"', () => {
  assert.equal(isLargeSpace(0), false)
  assert.equal(isLargeSpace(undefined), false)
  assert.equal(isLargeSpace(null), false)
  assert.equal(isLargeSpace(LARGE_SPACE_DOCS), false, '恰好等于阈值不算大（> 而非 >=，与内核口径一致）')
  assert.equal(isLargeSpace(LARGE_SPACE_DOCS + 1), true)
})
