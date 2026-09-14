// src/lib/knowledgeTags.test.ts —— 标签树纯逻辑（2026-09-14 对标 Obsidian 批次 1）
// 运行：`npm test`（node --test，原生跑 TS）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTagTree, normalizeTag, tagDepth, tagSearchTerms, tagSegments } from './knowledgeTags.ts'

test('normalizeTag：前导 # / 重复斜杠 / 首尾斜杠 / 空白 / 空串', () => {
  assert.equal(normalizeTag('财务'), '财务')
  assert.equal(normalizeTag('#财务'), '财务')
  assert.equal(normalizeTag('##财务'), '财务')
  assert.equal(normalizeTag('  税务/增值税  '), '税务/增值税')
  assert.equal(normalizeTag('a//b/'), 'a/b')
  assert.equal(normalizeTag(''), null)
  assert.equal(normalizeTag('   '), null)
  assert.equal(normalizeTag('#'), null)
  assert.equal(normalizeTag(null), null)
})

test('层级切分与深度', () => {
  assert.deepEqual(tagSegments('a/b/c'), ['a', 'b', 'c'])
  assert.deepEqual(tagSegments('a'), ['a'])
  assert.equal(tagDepth('a'), 1)
  assert.equal(tagDepth('a/b/c'), 3)
  assert.equal(tagDepth(''), 0)
})

test('buildTagTree：层级结构 + 中间层自动补齐', () => {
  const tree = buildTagTree([{ tag: '税务/增值税', count: 2, single: false }])
  assert.equal(tree.length, 1)
  assert.equal(tree[0].path, '税务')
  assert.equal(tree[0].name, '税务')
  assert.equal(tree[0].count, 0, '父标签自身没被任何文档直接使用 → count 0')
  assert.equal(tree[0].total, 2, '父标签的 total 汇总子标签')
  assert.equal(tree[0].children.length, 1)
  assert.equal(tree[0].children[0].path, '税务/增值税')
  assert.equal(tree[0].children[0].name, '增值税', '子节点 name 是片段，path 才是完整路径')
})

test('buildTagTree：父 total 不与自身重复计数（同一篇同时打父子标签的形态）', () => {
  // 形态一：只有子标签被打（父 count=0）→ total 精确等于子和
  const a = buildTagTree([
    { tag: '税务', count: 0, single: false },
    { tag: '税务/增值税', count: 3, single: false },
    { tag: '税务/所得税', count: 2, single: false },
  ])
  assert.equal(a[0].total, 5)
  // 形态二：父子都被打，父 count 已涵盖子标签那批文档 → 取 max 而不是相加（相加会得到 6）
  const b = buildTagTree([
    { tag: '税务', count: 4, single: false },
    { tag: '税务/增值税', count: 3, single: false },
  ])
  assert.equal(b[0].total, 4, 'max(count, Σ子树) 而非相加，避免同一文档被算两次')
})

test('buildTagTree：排序稳定（总数降序 + 名字次序）与 single 口径', () => {
  const tree = buildTagTree([
    { tag: 'b', count: 1, single: true },
    { tag: 'a', count: 5, single: false },
    { tag: 'c', count: 1, single: true },
  ])
  assert.deepEqual(tree.map((n) => n.path), ['a', 'b', 'c'], '文档多的在前，同数按名字')
  assert.equal(tree[0].single, false)
  assert.equal(tree[1].single, true)
  // 父节点按**子树**口径判定 single：子标签 total=1 时父也是 single
  const nested = buildTagTree([{ tag: 'x/y', count: 1, single: true }])
  assert.equal(nested[0].single, true, '父的 single 按子树 total 算，不能只看自身 count')
})

test('buildTagTree：非法条目跳过而不是渲染出空节点', () => {
  const tree = buildTagTree([
    { tag: '', count: 3, single: false },
    { tag: '#', count: 1, single: true },
    { tag: 'ok', count: 2, single: false },
  ] as never)
  assert.deepEqual(tree.map((n) => n.path), ['ok'])
})

test('tagSearchTerms：自身在前 + 后代深度优先 + limit 护栏', () => {
  const tree = buildTagTree([{ tag: 'a/b', count: 2, single: false }, { tag: 'a/c', count: 1, single: true }])
  const node = tree[0]
  assert.deepEqual(tagSearchTerms(node, 8), ['a', 'a/b', 'a/c'], '父标签检索要带上后代（Obsidian 口径）')
  assert.deepEqual(tagSearchTerms(node, 2), ['a', 'a/b'], 'limit 截断，避免关键词串无限长')
  // 叶子节点：只有自己
  const leaf = node.children[0]
  assert.deepEqual(tagSearchTerms(leaf), ['a/b'])
})
