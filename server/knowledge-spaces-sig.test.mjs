// server/knowledge-spaces-sig.test.mjs
// 会话知识范围的**桥侧签名与归一**（2026-09-15，待处理清单 P1）。
//
// 为什么单独测这一层：范围变更靠"签名不一致 → 收割内核 + --resume 重启"生效，这是本轮唯一
// 没被其它测试覆盖的**运行时分叉**——判错的后果不是"功能没生效"，而是**误杀正在跑的轮次**
// （签名抖动 = 每轮都重启）或**改了不生效**（签名恒定）。两种故障都不会报错。
//
// 加载方式照 server/provider-env-sig.test.mjs 的先例：YFW_BRIDGE_NO_LISTEN=1 + 动态 import，
// 只取纯函数、不起服务、不 spawn 内核。
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.YFW_BRIDGE_NO_LISTEN = '1'
const { normalizeKnowledgeSpaces, knowledgeSpacesSig } = await import('./bridge.mjs')

test('归一：去空、去重、保序（顺序 = 提示词里的优先级）', () => {
  assert.deepEqual(normalizeKnowledgeSpaces([' docs ', 'kb', 'docs']), ['docs', 'kb'])
  assert.deepEqual(normalizeKnowledgeSpaces(['kb', 'docs']), ['kb', 'docs'], '不得重排（排序=静默改变模型注意力）')
})

test('归一：非数组/脏值 → []（未关联），绝不抛异常', () => {
  for (const bad of [undefined, null, 'docs', 42, {}, [null, undefined, '', '   ']]) {
    assert.deepEqual(normalizeKnowledgeSpaces(bad), [], `${JSON.stringify(bad)} 应等价于未关联`)
  }
})

test('归一：含逗号的 id 被丢弃（无法通过 --knowledge-spaces 表达，丢弃而非切碎）', () => {
  assert.deepEqual(normalizeKnowledgeSpaces(['ok', 'a,b']), ['ok'], '含逗号者丢弃：留着会被内核按逗号切成两个不存在的库')
  assert.deepEqual(normalizeKnowledgeSpaces(['a,b']), [], '全丢弃后 = 未关联（不是"关联了一个坏 id"）')
})

test('签名：同一状态只有一个签名（否则每轮白重启一次内核）', () => {
  const canonical = knowledgeSpacesSig(['docs', 'kb'])
  assert.equal(knowledgeSpacesSig([' docs ', 'kb', 'docs']), canonical, '空白/重复不得改变签名')
  assert.equal(knowledgeSpacesSig(['docs', 'kb']), canonical)
  assert.equal(knowledgeSpacesSig(undefined), knowledgeSpacesSig(null), '缺值 与 null 同签名')
  assert.equal(knowledgeSpacesSig([]), knowledgeSpacesSig(['', '  ']), '空列表与脏值同签名（都=未关联）')
})

test('签名：真正不同的状态必须不同签名（否则改了不生效）', () => {
  assert.notEqual(knowledgeSpacesSig(['docs']), knowledgeSpacesSig(['docs', 'kb']), '加库必须变签名')
  assert.notEqual(knowledgeSpacesSig(['docs', 'kb']), knowledgeSpacesSig(['kb']), '减库必须变签名')
  assert.notEqual(knowledgeSpacesSig(undefined), knowledgeSpacesSig(['docs']), '未关联 → 关联必须变签名')
  assert.notEqual(knowledgeSpacesSig(['docs', 'kb']), knowledgeSpacesSig(['kb', 'docs']), '顺序不同视为不同（保序语义的一部分）')
})
