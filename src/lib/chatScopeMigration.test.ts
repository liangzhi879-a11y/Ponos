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
import { sanitizeConversations, sanitizeKnowledgeSpaces, sanitizeAppPageId, sanitizeAppId, migrateChatV3 } from './chatScopeMigration.ts'

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

// —— 应用页作用域归一（2026-09-16，P2「应用页会话」）—————————————————
// 与 knowledgeSpaces 同一条纪律、同一种失败模式：桥侧按值算 spawn 冻结签名（appPageSig），
// 若 `''` 与 `undefined` 各留下一个值，"清空作用域"就会被判成一次变更 → 白重启一次内核。
test('sanitizeAppPageId：脏值塌缩为 undefined（同一状态只能有一个签名）', () => {
  assert.equal(sanitizeAppPageId('app-a'), 'app-a')
  assert.equal(sanitizeAppPageId('  app-a  '), 'app-a', '去空白（否则内核收到一个不存在的 appId）')
  for (const bad of [undefined, null, '', '   ', 0, 42, {}, [], ['app-a'], true]) {
    assert.equal(sanitizeAppPageId(bad), undefined, `${JSON.stringify(bad)} 应归一为"无作用域"`)
  }
})

test('migrateChatV3：脏 appPageId 归一，null/空串/非字符串 → undefined（键被抹掉，不留 null）', () => {
  const st = migrateChatV3({
    conversations: [
      v3Row({ appPageId: ' app-a ' }),
      v3Row({ id: 'c2', appPageId: null }),
      v3Row({ id: 'c3', appPageId: '' }),
      v3Row({ id: 'c4', appPageId: 42 }),
      v3Row({ id: 'c5' }),
    ],
  })
  const rows = st.conversations as Array<Record<string, unknown>>
  assert.equal(rows[0].appPageId, 'app-a', '有值 → 去空白保留')
  for (const r of rows.slice(1)) assert.equal(r.appPageId, undefined, '脏值/缺字段 → 未设作用域')
  // 关键：归一到 undefined 必须把键**抹掉**（JSON.stringify 丢 undefined 值），
  // 否则持久化里会长期留一个 null（与"未设"等价但污染"一个状态一个签名"）
  assert.equal('appPageId' in (JSON.parse(JSON.stringify(rows[1])) as object), false, 'null 必须被抹掉而不是留成 null')
})

test('sanitizeConversations：只有 appPageId 脏时也要触发归一（改一行不得只补不洁）', () => {
  const dirty = [v3Row({ appPageId: '' })]
  const out = sanitizeConversations(dirty)
  assert.notEqual(out, dirty, '有脏 appPageId → 必须新建（否则脏值原样回到内存）')
  assert.equal((out[0] as unknown as Record<string, unknown>).appPageId, undefined)
  // 干净行（含合法 appPageId）不新建
  const clean = [v3Row({ appPageId: 'app-a' })]
  assert.equal(sanitizeConversations(clean), clean)
})

// —— 应用会话归属归一（2026-09-16，Task 4「应用生成后自动质检」）—————————————
// 与 appPageId 同一条纪律：它是"一个应用一个常驻会话"的**幂等键**，脏值（`''`/null/非字符串）
// 若留下来，getOrCreateAppConversation 的 `c.appId === appId` 永远匹配不上 →
// 用户每进一次应用页就多出一个"应用·xxx"会话（会话列表越用越乱）。
// **刻意不 bump persist version**：纯新增可选字段，缺字段与脏值都在这一个函数里归一。
test('sanitizeAppId：脏值塌缩为 undefined（幂等键只能是"有值"或"没有"）', () => {
  assert.equal(sanitizeAppId('app-001'), 'app-001')
  assert.equal(sanitizeAppId('  app-001  '), 'app-001', '去空白（否则幂等键永远匹配不上被 trim 过的 appId）')
  for (const bad of [undefined, null, '', '   ', 0, 42, {}, [], ['app-001'], true]) {
    assert.equal(sanitizeAppId(bad), undefined, `${JSON.stringify(bad)} 应归一为"非应用会话"`)
  }
})

test('sanitizeConversations：脏 appId 归一为 undefined（键被抹掉，不留 null/空串）', () => {
  const dirty = [v3Row({ appId: '' }), v3Row({ id: 'c2', appId: null }), v3Row({ id: 'c3', appId: 42 })]
  const out = sanitizeConversations(dirty)
  assert.notEqual(out, dirty, '有脏 appId → 必须新建（否则脏值原样回到内存，幂等从此失效）')
  const rows = out as unknown as Array<Record<string, unknown>>
  for (const r of rows) assert.equal(r.appId, undefined)
  assert.equal('appId' in (JSON.parse(JSON.stringify(rows[0])) as object), false, '空串必须被抹掉而不是留成空串')
  // 合法 appId 的行保持原引用（干净行不新建）
  const clean = [v3Row({ appId: ' app-001 ' })]
  const cleanOut = sanitizeConversations(clean)
  assert.equal((cleanOut[0] as unknown as Record<string, unknown>).appId, 'app-001', '去空白保留')
  // 已归一过的行（appId 有值且已 trim）不再新建
  const settled = [v3Row({ appId: 'app-001' })]
  assert.equal(sanitizeConversations(settled), settled)
})
