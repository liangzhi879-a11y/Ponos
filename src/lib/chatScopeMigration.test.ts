// src/lib/chatScopeMigration.test.ts —— v3 → v4 迁移与知识范围归一（2026-09-15，P1）
//
// 为什么单测这条迁移：v3 → v4 只新增一个字段，看上去"顺手复用 <2 的重建分支"更省事，
// 但那个分支会按**已剥离的 messages** 重算 messageCount/tokensTotal——v3 行里这两个值
// 恰恰是当初算好存下来的，跑一遍就把会话列表的统计清零（静默数据损坏）。
// 静态守卫只能证明分支存在，证明不了分支**不重算**，故用真负载。
//
// 本模块是纯函数（只 import type），因此能被 node --test 直接加载；store 侧"确实调的是这一份"
// 由 kernel-tests/knowledge-scope-plumbing.test.mjs 的静态守卫钉住。
import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeConversations, sanitizeKnowledgeSpaces, migrateChatV3 } from './chatScopeMigration.ts'

const v3Row = (over: Record<string, unknown> = {}) => ({
  id: 'c1', title: 'A', createdAt: 1, updatedAt: 2, model: 'm', mode: 'task', messages: [],
  messageCount: 42, tokensTotal: 1234, ...over,
})

test('sanitizeKnowledgeSpaces：脏值塌缩为 undefined（同一状态只能有一个签名）', () => {
  assert.deepEqual(sanitizeKnowledgeSpaces(['a', 'b']), ['a', 'b'])
  assert.deepEqual(sanitizeKnowledgeSpaces([' b ', 'a', 'b']), ['b', 'a'], '去空 + 去重 + **保序**（顺序=提示词优先级）')
  for (const bad of [undefined, null, 'docs', {}, 0, [], ['', '  '], [null, undefined]]) {
    assert.equal(sanitizeKnowledgeSpaces(bad), undefined, `${JSON.stringify(bad)} 应归一为"未关联"`)
  }
})

test('migrateChatV3：脏 knowledgeSpaces 归一，null/缺字段 → undefined', () => {
  const st = migrateChatV3({
    conversations: [
      v3Row({ knowledgeSpaces: [' docs ', 'docs', ''] }),
      v3Row({ id: 'c2', knowledgeSpaces: null }),
      v3Row({ id: 'c3' }),
    ],
    activeConversationId: 'c1',
  })
  const rows = st.conversations as Array<Record<string, unknown>>
  assert.deepEqual(rows[0].knowledgeSpaces, ['docs'], '空白丢弃 / 去重 / 保序')
  assert.equal(rows[1].knowledgeSpaces, undefined, 'null → 未关联')
  assert.equal(rows[2].knowledgeSpaces, undefined, '缺字段不补值（未关联就是缺省）')
  assert.equal(st.activeConversationId, 'c1', '无关字段原样带过')
})

test('migrateChatV3：**不重建行内统计**（messageCount/tokensTotal 原样保留）', () => {
  // 本次迁移的核心不变量：复用 <2 的重建分支会把它们算成 0（messages 早已被 partialize 剥离）
  const st = migrateChatV3({ conversations: [v3Row(), v3Row({ id: 'c2', messageCount: 7, tokensTotal: 70 })] })
  const rows = st.conversations as Array<Record<string, unknown>>
  assert.equal(rows[0].messageCount, 42)
  assert.equal(rows[0].tokensTotal, 1234)
  assert.equal(rows[1].messageCount, 7)
  assert.equal(rows[1].tokensTotal, 70)
  assert.deepEqual(rows[0].messages, [], 'messages 仍兜底为数组（不引入 undefined 崩溃面）')
})

test('migrateChatV3：脏数据不炸（非数组/含 null/空负载）', () => {
  assert.deepEqual((migrateChatV3({ conversations: 'oops' }).conversations as unknown[]), [])
  assert.deepEqual((migrateChatV3({ conversations: [null, 7, v3Row()] }).conversations as unknown[]).length, 1)
  assert.deepEqual((migrateChatV3(undefined).conversations as unknown[]), [])
})

test('sanitizeConversations：干净行返回原引用（避免无谓写回），脏行才新建', () => {
  const clean = [v3Row()]
  assert.equal(sanitizeConversations(clean), clean, '全干净 → 原引用（调用方据此跳过 setState/写回）')
  const dirty = [v3Row({ knowledgeSpaces: ['a', 'a'] })]
  assert.notEqual(sanitizeConversations(dirty), dirty, '有脏值 → 新建数组')
})
