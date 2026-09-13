// 特征测试（characterization test）：在把 gramTokens/vectorizeText/cosine/buildIdf/
// hashLine/keywordScore 迁移到 shared/ 之前，先把**现状行为**钉死。
// 迁移是纯搬家（实现逐字复制），这些断言在迁移前后必须完全一致——若迁移后变红，
// 说明搬错了，必须修实现而不是改断言。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gramTokens, vectorizeText, cosine, buildIdf, createGraphStore } from '../kernel/graph.mjs'
import { hashLine, keywordScore, parseEntryLine } from '../kernel/memory.mjs'

test('gramTokens 迁移前语义（graph.mjs 重构路径注释所依赖的断言）', () => {
  // graph.mjs:26 注释记录了该用例：'ps 表与 rd 表' 类的边界 bigram
  assert.deepEqual([...gramTokens('ps 表与 rd 表')], ['ps', '表与', '与r', 'rd', 'rd表'])
})

test('vectorizeText 的 tagBoost 在归一化之后生效', () => {
  // graph.mjs:60 注释断言：w2[知识] > w1[知识]
  const w1 = new Map(vectorizeText('知识 检索'))
  const w2 = new Map(vectorizeText('知识 检索', { tagBoost: 3 }))
  assert.ok(w2.get(hashLine('知识')) > w1.get(hashLine('知识')))
})

test('cosine / buildIdf 基础契约', () => {
  const v = vectorizeText('知识库检索')
  assert.ok(Math.abs(cosine(v, v) - 1) < 1e-9)
  const idf = buildIdf([
    { gramCounts: new Map([['a', 1], ['b', 1]]) },
    { gramCounts: new Map([['a', 1]]) },
  ])
  assert.ok(idf.get('a') < idf.get('b'), 'df 高的 idf 低')
})

test('hashLine / keywordScore / parseEntryLine 迁移前语义', () => {
  assert.match(hashLine('- [会话|X] 摘要 -- 全文'), /^[0-9a-f]{8}$/)
  assert.equal(keywordScore({ tag: 'PS材料' }, ['ps材料']), 3)
  assert.deepEqual(parseEntryLine('- [会话|标签] 摘要 -- 全文'), {
    tag: '标签', summary: '摘要', full: '全文',
  })
})

test('createGraphStore.search 输出形状与排序（端到端特征）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kc-parity-'))
  const memoryRoot = join(dir, 'memory', 'personal')
  mkdirSync(memoryRoot, { recursive: true })
  writeFileSync(join(memoryRoot, 'workflow.md'), [
    '---', 'name: workflow', 'description: 工作流', '---',
    '- [会话|PS材料] PS材料整理 -- 先合并再压缩，注意尺寸上限',
    '- [会话|成果转化] 成果转化材料 -- 四表联动核对步骤',
  ].join('\n') + '\n', 'utf-8')

  try {
    const g = createGraphStore({ root: join(dir, 'memory', 'graph') })
    await g.load({ memoryRoot, force: true })
    assert.equal(g.getNodes().length, 2)
    const out = g.search({ query: 'PS材料 压缩', keywords: ['PS材料'], topK: 5 })
    assert.ok(out.includes('【相关经验抽调】'), '表头不变')
    assert.ok(out.includes('PS材料整理'), '命中相关条目')
    assert.ok(out.indexOf('PS材料整理') < out.indexOf('成果转化材料'), '相关度降序')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
