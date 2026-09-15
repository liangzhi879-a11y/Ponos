// S5 Task 9（GUI 数据口）的回归测试：
//   ① `getRelatedForDoc(docId)` —— 整篇文档的条目锚点（条目卡片/Inspector 用），
//      口径必须与块级 `getRelated` **逐字同源**（同一块两处结果必须 deepEqual，否则界面会互相矛盾）；
//   ② `getGraph({ related: true })` —— 图谱的文档级隐式关联层：只收 tag/content（duplicate 不是
//      关联）、丢自环、按无序对去重并计 count、按在场节点过滤；
//   ③ **默认不带 related**：图层默认关是 spec §7.5 的硬要求，既有调用方（/knowledge/graph 不带参、
//      S2 的 deepEqual 用例）必须零变化。
// 隔离纪律：mkdtempSync 临时 configDir，绝不碰真实 ~/.yfworking。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKnowledgeStore } from '../kernel/knowledge.mjs'

/** 锚点摘要的精确字段集合（与块级口同一份契约，多一个正文类字段即失败）。 */
const SUMMARY_KEYS = ['blockId', 'docId', 'score', 'title', 'why']
const A = '- [会话|企微CLI化] 渠道纪律 -- 涉及真实沟通渠道的测试只发文件传输助手，避免打扰真人'
const B = '- [会话|企微CLI化] 步骤字段契约 -- js 步骤需 expression、click 类需 ref，写错会静默失败很久'
const C = '- [会话|打包发布] 预演先行 -- 用 rsync 增量同步目录时先 dry-run 预览变更清单，确认无误再落地'
const D = '- [会话|打包发布] 同步预演 -- 用 rsync 增量同步目录时先 dry-run 预览变更清单，确认无误再执行'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-krelgui-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  writeFileSync(join(personal, 'a.md'), ['---', 'name: a', '---', A, B].join('\n') + '\n', 'utf-8')
  writeFileSync(join(personal, 'b.md'), ['---', 'name: b', '---', B.replace('步骤字段契约', '字段契约'), C, D].join('\n') + '\n', 'utf-8')
  return dir
}

test('getRelatedForDoc：整篇锚点（只有带锚点的块 + 字段集合钉死），与块级 getRelated 同源', () => {
  const store = createKnowledgeStore({ configDir: fixture() })
  store.load({})
  const docs = store.getDocs()
  const a = docs.find((d) => d.id.endsWith('/a.md') || d.id === 'a.md')
  const b = docs.find((d) => d.id.endsWith('/b.md') || d.id === 'b.md')
  assert.ok(a && b, `夹具两篇文档都要被索引到（实际：${docs.map((d) => d.id).join(',')}）`)

  const blocks = store.getRelatedForDoc(a.id)
  assert.ok(blocks.length >= 1, '同 tag 的块之间必有锚点（骨架层）')
  assert.deepEqual(Object.keys(blocks[0]), ['blockId', 'related'], '只回 blockId + related 两项')
  for (const bl of blocks) {
    assert.ok(bl.blockId.startsWith(`${a.id}#`), 'blockId 必须是本文档的块')
    assert.ok(bl.related.length > 0, '没有锚点的块不该出现在结果里（GUI 据此不留空壳）')
    for (const r of bl.related) assert.deepEqual(Object.keys(r).sort(), SUMMARY_KEYS, '绝不含正文')
  }
  // 口径同源：同一块经两条通道取到的锚点必须 deepEqual（两套排序/上限必然漂移）
  const sample = blocks[0]
  assert.deepEqual(sample.related, store.getRelated(sample.blockId))

  // 未知文档 → 空数组（不是抛错，也不是"整个库的锚点"）
  assert.deepEqual(store.getRelatedForDoc('experience/nope.md'), [])
  assert.deepEqual(store.getRelatedForDoc(''), [])
})

test('getGraph：默认不带 related（图层默认关，既有调用方零变化）；related:true 才附文档级隐式边', () => {
  const store = createKnowledgeStore({ configDir: fixture() })
  store.load({})
  const base = store.getGraph({})
  assert.equal('related' in base, false, '缺省不得带 related —— S2 的响应形状必须逐字不变')

  const on = store.getGraph({ related: true })
  assert.ok(Array.isArray(on.related), 'related:true 时必须给数组（空也要给，前端不必判 undefined）')
  assert.deepEqual(on.nodes, base.nodes)
  assert.deepEqual(on.edges, base.edges)
  const ids = new Set(on.nodes.map((n) => n.id))
  for (const e of on.related) {
    assert.deepEqual(Object.keys(e).sort(), ['count', 'from', 'kind', 'score', 'to'], '字段集合固定')
    assert.notEqual(e.from, e.to, '同文档内的块间关联在图谱上是自环 → 必须丢弃')
    assert.ok(ids.has(e.from) && ids.has(e.to), '两端必须都在场（否则画布上是一条指向空气的边）')
    assert.ok(e.kind === 'tag' || e.kind === 'content', 'duplicate 不是关联（spec §5.5）')
    assert.ok(e.count >= 1, 'count = 背后块级边数，至少 1')
  }
  // 无序对唯一：同一条关系不得出现两条边
  const pairs = on.related.map((e) => [e.from, e.to].sort().join('|'))
  assert.equal(new Set(pairs).size, pairs.length, '同一无序对只能有一条')

  // 节点被 limit 截断时，关联边也必须只留两端在场的（否则图上缺边，看着像索引坏了）
  if (on.nodes.length >= 2) {
    const one = store.getGraph({ related: true, limit: 1 })
    assert.equal(one.nodes.length, 1)
    assert.deepEqual(one.related, [], '只有一个节点时不可能有合法的文档对')
  }
})
