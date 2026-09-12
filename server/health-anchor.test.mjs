// server/health-anchor.test.mjs
// node --test server/health-anchor.test.mjs
// 测"锚定生效"路由的纯函数封装（不起真桥；bridge 只做校验+转发）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAnchorApplied, MAX_ISSUE_IDS, MAX_ID_LEN } from './health-anchor.mjs'

test('buildAnchorApplied：构造内核 stdin 消息', () => {
  assert.deepEqual(buildAnchorApplied('s1', ['a', 'b']), {
    sessionId: 's1',
    message: { type: 'anchor_applied', issueIds: ['a', 'b'] },
  })
})

test('issueIds 清洗：去重、剔除非字符串、限长、非法回落空数组', () => {
  const long = 'x'.repeat(MAX_ID_LEN + 50)
  const r = buildAnchorApplied('s1', ['a', 'a', 1, null, {}, '  ', long])
  assert.deepEqual(r.message.issueIds, ['a', long.slice(0, MAX_ID_LEN)])
  assert.deepEqual(buildAnchorApplied('s1', null).message.issueIds, [])
  assert.deepEqual(buildAnchorApplied('s1', 'not-an-array').message.issueIds, [])
})

test('issueIds 总量封顶 MAX_ISSUE_IDS', () => {
  const many = Array.from({ length: MAX_ISSUE_IDS + 20 }, (_, i) => `id-${i}`)
  assert.equal(buildAnchorApplied('s1', many).message.issueIds.length, MAX_ISSUE_IDS)
})

test('sessionId 必填：缺失/非字符串/空白返回 null（路由回 400）', () => {
  assert.equal(buildAnchorApplied('', ['a']), null)
  assert.equal(buildAnchorApplied('   ', ['a']), null)
  assert.equal(buildAnchorApplied(null, ['a']), null)
  assert.equal(buildAnchorApplied(123, ['a']), null)
})

test('sessionId 去空白后透传', () => {
  assert.equal(buildAnchorApplied(' s1 ', []).sessionId, 's1')
})
