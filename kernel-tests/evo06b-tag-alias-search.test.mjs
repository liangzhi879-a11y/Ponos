// EVO-06 ②a 修复验证（P2）：检索打分不认标签别名 —— 合并了标签，检索却按原字符串匹配。
//
// 【台账原文】「② byTag/structBoost 仍用原字符串（改它要 bump 索引版本，故未做）」
//
// 【实测修正台账前提（本项最重要产出）】
//   `byTag`/`structBoost` 其实是**两件事**，成本差一个数量级：
//   · **②a 检索打分**（`shared/knowledge-core.mjs:522` `structBoostOf`）：把 `doc.tags`
//     与查询词做**双向子串匹配**，不查注册表。⇒ 在**查询期**把词/标签经注册表展开即可，
//     **索引里存的原字符串不必改** ⇒ **不需要 bump INDEX_VERSION、不需要全库重建**。
//   · **②b 标签关系边**（`kernel/knowledge.mjs:1886` `byTag` 按原字符串给同标签块连边）：
//     边是**构建期持久化**产物 ⇒ 改口径才需要 bump + 重建。
//   ⇒ 台账把 ② 当成必须重建的一整块，这个判断对 ②b 成立、对 ②a **不成立**。
//
// 【②a 的具体缺陷（两种漏检）】
//   设 A→B 合并（A 是别名，B 是规范名）：
//   · 场景①：查询说 "A"、文档标签是 "B" ⇒ 展开查询词后能命中（原实现漏）
//   · 场景②：查询说 "B"、文档标签是 "A" ⇒ **必须展开文档标签**才能命中（原实现必漏）
//   ⇒ 只展开一侧不够，两侧都要展开。
//
// 【修法】`structBoostOf({ ..., tagResolver })`：给了 resolver 就把 `doc.tags` 与
//   `keywords` **各自映射一遍再合并原值**（映射结果是原集合的超集，不会丢原有子串匹配能力），
//   且 **未注册名原样通过**（`resolveTagName` 的既有语义，不做受控词表）。
//   **不传 resolver 时行为逐字不变**（反向守卫，见第 1 条测试）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { structBoostOf } from '../shared/knowledge-core.mjs'

/** 造一个"别名 → 规范名"的解析器（模拟 makeTagResolver 的可见行为） */
const resolverOf = (map) => (raw) => {
  const k = String(raw ?? '').trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : raw
}

const docWith = (tags) => ({ title: '', tags })

test('★ 反向守卫：不传 tagResolver 时行为逐字不变（不能顺手改坏既有打分）', () => {
  // 既有语义：双向子串匹配，命中标签得 0.67
  assert.equal(structBoostOf({ block: { kind: 'text' }, doc: docWith(['研发']), query: '', keywords: ['研发'] }), 0.67)
  assert.equal(structBoostOf({ block: { kind: 'text' }, doc: docWith(['研发']), query: '', keywords: ['销售'] }), 0,
    '不命中必须是 0（不能因为新增参数就悄悄放宽命中条件）')
  // 传入 undefined / null 也必须等价于"没给"
  assert.equal(structBoostOf({ block: { kind: 'text' }, doc: docWith(['研发']), query: '', keywords: ['销售'], tagResolver: undefined }), 0)
  assert.equal(structBoostOf({ block: { kind: 'text' }, doc: docWith(['研发']), query: '', keywords: ['销售'], tagResolver: null }), 0)
})

test('★★ 场景①：查询用**别名**、文档标签是规范名 ⇒ 必须命中', () => {
  const tagResolver = resolverOf({ dev: '研发', 开发: '研发' })
  // 修前：'研发'.includes('dev') false 且 'dev'.includes('研发') false ⇒ 0（漏检）
  assert.equal(structBoostOf({ block: { kind: 'text' }, doc: docWith(['研发']), query: '', keywords: ['dev'] }), 0,
    '前置：不传 resolver 时确实漏（这正是缺陷）')
  assert.equal(
    structBoostOf({ block: { kind: 'text' }, doc: docWith(['研发']), query: '', keywords: ['dev'], tagResolver }),
    0.67,
    '给了 resolver 后，别名 dev 应展开为规范名「研发」并命中',
  )
})

test('★★ 场景②：查询用**规范名**、文档标签存的是别名 ⇒ 也必须命中（只展开一侧不够）', () => {
  const tagResolver = resolverOf({ dev: '研发', 开发: '研发' })
  // 修前：'dev'.includes('研发') false 且 '研发'.includes('dev') false ⇒ 0（漏检）
  assert.equal(
    structBoostOf({ block: { kind: 'text' }, doc: docWith(['dev']), query: '', keywords: ['研发'], tagResolver }),
    0.67,
    '文档标签侧也必须展开 —— 否则"合并了标签，检索仍按旧名漏检"，本项等于没修',
  )
  assert.equal(
    structBoostOf({ block: { kind: 'text' }, doc: docWith(['开发']), query: '', keywords: ['研发'], tagResolver }),
    0.67,
  )
})

test('★ 短别名展开后仍要参与（≥2 字符过滤必须在**展开之后**）', () => {
  // 'a' 只有 1 字符，原实现会在 filter(k.length>=2) 阶段被丢掉，永远没机会展开
  const tagResolver = resolverOf({ a: '阿里巴巴' })
  assert.equal(
    structBoostOf({ block: { kind: 'text' }, doc: docWith(['阿里巴巴']), query: '', keywords: ['a'], tagResolver }),
    0.67,
    '短别名必须先展开再过滤长度 —— 否则"一字符别名"永远命中不了',
  )
})

test('★ 未注册标签不得被"规范化"掉（不做受控词表，原样通过）', () => {
  const tagResolver = resolverOf({ dev: '研发' })
  // '企微CLI化' 不在注册表 ⇒ resolver 原样返回 ⇒ 原有的双向子串匹配能力必须保留
  assert.equal(
    structBoostOf({ block: { kind: 'text' }, doc: docWith(['企微CLI化']), query: '', keywords: ['企微'], tagResolver }),
    0.67,
    '未注册标签必须保留原有子串匹配（本仓既有语义：不做受控词表）',
  )
})

test('★ resolver 抛错/返回异常值时不得影响打分（降级安全）', () => {
  const throwing = () => { throw new Error('registry unreadable') }
  // 不能因为注册表坏了就让检索整体失败 —— 退回原字符串匹配
  assert.equal(
    structBoostOf({ block: { kind: 'text' }, doc: docWith(['研发']), query: '', keywords: ['研发'], tagResolver: throwing }),
    0.67,
    'resolver 抛错时必须退回原字符串匹配（注册表坏了不该让检索崩）',
  )
  const returnsNull = () => null
  assert.equal(
    structBoostOf({ block: { kind: 'text' }, doc: docWith(['研发']), query: '', keywords: ['研发'], tagResolver: returnsNull }),
    0.67,
  )
})

test('★ 标题命中(1.0)仍优先于标签命中(0.67)，不受 resolver 影响', () => {
  const tagResolver = resolverOf({ dev: '研发' })
  assert.equal(
    structBoostOf({ block: { kind: 'text' }, doc: { title: '研发规范', tags: ['研发'] }, query: '研发', keywords: ['dev'], tagResolver }),
    1,
    '标题整串命中仍是 1（既有优先级不得被新参数打乱）',
  )
})
