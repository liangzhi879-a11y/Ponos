import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gramTokens, vectorizeText, cosine, buildIdf, hashLine, createGraphStore, rebuildGraph } from '../kernel/graph.mjs'

test('gramTokens：中文 bigram + 英文单词', () => {
  assert.deepEqual([...gramTokens('知识图谱')], ['知识', '识图', '图谱'])
  assert.deepEqual([...gramTokens('High tech')], ['high', 'tech'])
})

test('gramTokens：中英混排分段', () => {
  assert.deepEqual([...gramTokens('PS表与RD表')], ['ps', '表与', '与r', 'rd', 'rd表'])
  assert.deepEqual([...gramTokens('  a  ')], ['a'])
  assert.deepEqual([...gramTokens('')], [])
})

test('vectorizeText：TF 平滑 + 归一化 + tag 加权', () => {
  const v1 = vectorizeText('知识 知识 图谱')   // 知识 tf=2
  const v2 = vectorizeText('知识 图谱', { tagBoost: 3 })
  const mag = (v) => Math.sqrt(v.reduce((s, [, w]) => s + w * w, 0))
  assert.ok(Math.abs(mag(v1) - 1) < 1e-9, '归一化')
  const w1 = Object.fromEntries(v1); const w2 = Object.fromEntries(v2)
  assert.ok(w1[hashLine('知识')] > w1[hashLine('图谱')], 'TF 高者权重大')
  assert.ok(w2[hashLine('知识')] > w1[hashLine('知识')], 'tagBoost 生效')
})

test('cosine：同义文本高、无关文本低', () => {
  const a = vectorizeText('成果转化材料整理')
  const b = vectorizeText('成果转化材料整理要点')
  const c = vectorizeText('财务报销发票处理')
  assert.ok(cosine(a, b) > 0.6, `同主题应高相似：${cosine(a, b)}`)
  assert.ok(cosine(a, c) < 0.3, `跨主题应低相似：${cosine(a, c)}`)
})

test('buildIdf：泛化 gram 权重低', () => {
  const g1 = { gramCounts: new Map([['的', 1], ['研发', 1]]) }
  const g2 = { gramCounts: new Map([['的', 1]]) }
  const idf = buildIdf([g1, g2])
  assert.ok(idf.get('的') < idf.get('研发'), 'df 高者 idf 低')
})

// ---------- Task 2: 图谱存储 GraphStore ----------

test('GraphStore：append 后节点可读、hashLine 去重', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-graph-'))
  try {
    const g = createGraphStore({ root: dir })
    const r1 = g.append({ theme: 'workflow', tag: '材料压缩', summary: '压缩经验', full: '全文内容' })
    const r2 = g.append({ theme: 'workflow', tag: '材料压缩', summary: '压缩经验', full: '全文内容' })
    assert.equal(r1.deduped, false); assert.equal(r2.deduped, true)
    assert.equal(g.getNodes().length, 1)
    const g2 = createGraphStore({ root: dir })  // 重新加载
    await g2.load()
    assert.equal(g2.getNodes().length, 1)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('GraphStore：load 跳过半截行（崩溃恢复）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-graph-'))
  try {
    const g = createGraphStore({ root: dir })
    g.append({ theme: 'a', summary: 'x', full: 'x' })
    fs.appendFileSync(path.join(dir, 'graph.jsonl'), '{"v":1,"id":"broken"\n', 'utf-8')
    const g2 = createGraphStore({ root: dir })
    await g2.load()
    assert.equal(g2.getNodes().length, 1)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('GraphStore：缺失时 load 从 memoryRoot 重建', async () => {
  const mem = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-mem-'))
  const gdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-graph-'))
  try {
    fs.mkdirSync(mem, { recursive: true })
    fs.writeFileSync(path.join(mem, 'workflow.md'),
      '---\nname: workflow\n---\n- [会话|材料压缩] 摘要A -- 全文A\n- [会话] 摘要B -- 全文B\n', 'utf-8')
    const g = createGraphStore({ root: gdir })
    await g.load({ memoryRoot: mem })
    assert.equal(g.getNodes().length, 2)
    assert.ok(g.getNodes()[0].vec.length > 0, '节点带向量')
  } finally { fs.rmSync(mem, { recursive: true, force: true }); fs.rmSync(gdir, { recursive: true, force: true }) }
})

test('GraphStore：半截行 EOF 后 append 不粘连新节点', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-graph-'))
  try {
    const g = createGraphStore({ root: dir })
    g.append({ theme: 'a', summary: 'x', full: 'x' })
    fs.appendFileSync(path.join(dir, 'graph.jsonl'), '{"v":1,"id":"broken', 'utf-8')
    const g2 = createGraphStore({ root: dir })
    await g2.load()
    g2.append({ theme: 'b', summary: 'y', full: 'y' })
    const g3 = createGraphStore({ root: dir })
    await g3.load()
    assert.equal(g3.getNodes().length, 2)  // x 与 y 都在，broken 行被跳过
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('GraphStore.search：余弦+关键词混合排序与注入格式', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-graph-'))
  try {
    const g = createGraphStore({ root: dir })
    g.append({ theme: 'workflow', tag: '材料压缩', summary: 'PDF 压缩经验', full: '用压缩技能处理 PDF' })
    g.append({ theme: 'finance', tag: '发票', summary: '发票匹配', full: 'PS 与发票匹配流程' })
    const out = g.search({ query: '压缩 PDF 材料', keywords: ['材料压缩'] })
    assert.ok(out.includes('【相关经验抽调】'), '引导语')
    assert.ok(out.includes('- [workflow|材料压缩] PDF 压缩经验'), '行格式')
    assert.ok(!out.includes('发票匹配'), '低相关不注入')
    const out2 = g.search({ query: '发票 匹配 PS' })
    assert.ok(out2.includes('发票匹配'))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('search 输出独立可用（逃生阀由 cli 控制）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-g-'))
  try {
    const g = createGraphStore({ root: dir })
    g.append({ theme: 'workflow', tag: 'x', summary: 's', full: 'f' })
    const out = g.search({ query: 'x', keywords: ['x'] })
    assert.ok(out.startsWith('\n\n【相关经验抽调】'))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('GraphStore.search：maxBytes 截断', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-graph-'))
  try {
    const g = createGraphStore({ root: dir })
    for (let i = 0; i < 20; i++) g.append({ theme: 'workflow', summary: `经验${i}`, full: 'x'.repeat(50) })
    const out = g.search({ query: '经验', maxBytes: 500 })
    assert.ok(out.length <= 500)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// ---------- Task 4: 经验沉淀双写 + 重建校验（缺失/版本/mtime/命令式） ----------

test('appendMemoryEntry 传 graphStore 双写，不传只写 markdown', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-mem-home-'))
  try {
    const root = path.join(home, 'memory', 'personal')
    const graphDir = path.join(home, 'memory', 'graph')
    const { createGraphStore } = await import('../kernel/graph.mjs')
    const { appendMemoryEntry, readMemoryEntries } = await import('../kernel/memory.mjs')
    const g = createGraphStore({ root: graphDir })
    await g.load()
    const r = appendMemoryEntry({ root, theme: 'workflow', tag: 't1', summary: 's1', full: 'f1', graphStore: g })
    assert.equal(r.ok, true)
    assert.equal(g.getNodes().length, 1, '图谱有节点')
    assert.equal(readMemoryEntries({ root, theme: 'workflow' }).length, 1, 'markdown 有条目')
    const g2 = createGraphStore({ root: graphDir })
    await g2.load()
    assert.equal(g2.getNodes().length, 1, '重载后图谱仍有节点')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test('GraphStore.load：markdown mtime 新于图谱时触发重建', async () => {
  const mem = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-graph-mem-'))
  const gdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-graph-'))
  try {
    fs.writeFileSync(path.join(mem, 'workflow.md'),
      '---\nname: workflow\n---\n- [会话|t] 旧 -- 旧\n', 'utf-8')
    const g1 = createGraphStore({ root: gdir })
    await g1.load({ memoryRoot: mem })        // 缺失 → 重建，入图 1 条
    // markdown 直写新条目（不经图谱）：markdown mtime 新于 graph.jsonl
    fs.writeFileSync(path.join(mem, 'workflow.md'),
      '---\nname: workflow\n---\n- [会话|t] 旧 -- 旧\n- [会话|t] 新 -- 新\n', 'utf-8')
    const g2 = createGraphStore({ root: gdir })
    await g2.load({ memoryRoot: mem })        // mtime 校验 → 重建
    assert.ok(g2.getNodes().some((n) => n.summary === '新'), '重建后新条目入图')
  } finally { fs.rmSync(mem, { recursive: true, force: true }); fs.rmSync(gdir, { recursive: true, force: true }) }
})

test('GraphStore.load：版本旧触发重建', async () => {
  const mem = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-graph-mem-'))
  const gdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-graph-'))
  try {
    fs.writeFileSync(path.join(mem, 'workflow.md'),
      '---\nname: workflow\n---\n- [会话|t] 甲 -- 甲\n', 'utf-8')
    fs.mkdirSync(gdir, { recursive: true })
    fs.writeFileSync(path.join(gdir, 'graph.jsonl'),
      JSON.stringify({ v: 999, id: 'x', theme: 'stale', tag: null, summary: 'stale', full: 'stale', ts: new Date().toISOString(), vec: [] }) + '\n', 'utf-8')
    const g = createGraphStore({ root: gdir })
    await g.load({ memoryRoot: mem })
    assert.equal(g.getNodes().length, 1)
    assert.equal(g.getNodes()[0].summary, '甲', '版本旧 → 从 markdown 重建')
  } finally { fs.rmSync(mem, { recursive: true, force: true }); fs.rmSync(gdir, { recursive: true, force: true }) }
})

test('rebuildGraph：命令式入口全量重建', async () => {
  const mem = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-graph-mem-'))
  const gdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-graph-'))
  try {
    fs.writeFileSync(path.join(mem, 'workflow.md'),
      '---\nname: workflow\n---\n- [会话|t] 甲 -- 甲\n', 'utf-8')
    const g1 = createGraphStore({ root: gdir })
    await g1.load({ memoryRoot: mem })
    g1.append({ theme: 'workflow', tag: 't2', summary: '乙', full: '乙' })  // 图谱比 markdown 多一条
    fs.writeFileSync(path.join(mem, 'workflow.md'),
      '---\nname: workflow\n---\n- [会话|t] 丙 -- 丙\n', 'utf-8')             // markdown 内容已改
    const n = await rebuildGraph({ graphRoot: gdir, memoryRoot: mem })
    assert.equal(n, 1)
    const g2 = createGraphStore({ root: gdir })
    await g2.load({ memoryRoot: mem })
    assert.equal(g2.getNodes()[0].summary, '丙', '命令式重建后与 markdown 一致')
  } finally { fs.rmSync(mem, { recursive: true, force: true }); fs.rmSync(gdir, { recursive: true, force: true }) }
})

test('GraphStore.load：markdown 未变更时正常加载不重建', async () => {
  const mem = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-graph-mem-'))
  const gdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-graph-'))
  try {
    fs.writeFileSync(path.join(mem, 'workflow.md'),
      '---\nname: workflow\n---\n- [会话|t] 甲 -- 甲\n', 'utf-8')
    const g1 = createGraphStore({ root: gdir })
    await g1.load({ memoryRoot: mem })
    g1.append({ theme: 'workflow', tag: 't2', summary: '乙', full: '乙' })  // 图谱 2 条，markdown 仍 1 条且更旧
    const g2 = createGraphStore({ root: gdir })
    await g2.load({ memoryRoot: mem })
    assert.equal(g2.getNodes().length, 2, 'markdown 更旧 → 不重建，保持图谱 2 条')
  } finally { fs.rmSync(mem, { recursive: true, force: true }); fs.rmSync(gdir, { recursive: true, force: true }) }
})
