# 内核神经图谱知识经验沉淀系统 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为内核新增无模型特征向量图谱（n-gram 哈希 + TF/IDF + 余弦）替换 L3-2 关键词检索，markdown 为权威源、graph.jsonl 为派生索引，预留 IGraphBackend 外部替换点。

**Architecture:** 新增 `kernel/graph.mjs`（Vectorizer + GraphStore + GraphSearch 三合一模块，含 IGraphBackend 契约）。捕获层不变：markdown 仍是权威写入，`appendMemoryEntry` 通过可选 `graphStore` 参数同步图谱（依赖注入避免循环依赖：graph.mjs 单向 import memory.mjs）。注入层：cli.mjs L3-2 从 `buildRelevantMemory` 切到图谱检索，注入格式与逃生阀完全保留。

**Tech Stack:** Node.js ≥18 ESM，node:test（server/*.test.mjs），零新增依赖（node:fs / node:crypto）。

## Global Constraints

- 零新增运行时依赖：不引入 embedding 模型、不联网、不引入向量库。
- 图谱 id 复用 `memory.mjs hashLine`（32-bit hex）；节点行格式与 markdown 条目一致：`- [会话|标签] 摘要 -- 全文`。
- 注入格式沿用现 `buildRelevantMemory` 输出（引导语 `【相关经验抽调】` + `- [主题|标签] 摘要 -- 全文` 行），prompt.mjs 零改动。
- 逃生阀保留：`settings.memory.inject=false`、`PONOS_MEMORY_INJECT=index-only`。
- 外部知识库（`PONOS_GRAPH_BACKEND=external`）本次不实现，仅留 stub 报错。
- markdown 权威源与 GUI（server/experience.mjs）、workflow store 节点零改动。
- 测试隔离：用 `PONOS_TEST_HOME` 重定向 `~/.ponos`（参考 server/experience.test.mjs 模式）。

---

### Task 1: 特征向量化（Vectorizer）

**Files:**
- Create: `kernel/graph.mjs`（本任务只写 gramTokens / vectorizeText / cosine / buildIdf 四个导出函数）
- Test: `server/graph.test.mjs`

**Interfaces:**
- Produces:
  - `gramTokens(text: string): Generator<string>` —— 中文段字符 bigram + 英文/数字段单词小写
  - `vectorizeText(text: string, { tagBoost?: number, idf?: Map<string, number> } = {}): Array<[string, number]>` —— 稀疏向量 `[[桶id, 权重], ...]`，归一化；权重 = `(1 + sqrt(tf)) * tagBoost * (idf?.get(gram) ?? 1)`
  - `cosine(a: Array<[string, number]>, b: Array<[string, number]>): number` —— 归一化后点积
  - `buildIdf(docs: Array<{ gramCounts: Map<string, number> }>): Map<string, number>` —— `ln((N+1)/(df+1)) + 1`

- [ ] **Step 1: 写失败测试**（server/graph.test.mjs，本任务追加节）

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gramTokens, vectorizeText, cosine, buildIdf, hashLine } from '../kernel/graph.mjs'

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
  const g2 = { gramCounts: new Map([['研发', 1]]) }
  const idf = buildIdf([g1, g2])
  assert.ok(idf.get('的') < idf.get('研发'), 'df 高者 idf 低')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/graph.test.mjs`
Expected: FAIL（模块不存在 / 函数未定义）

- [ ] **Step 3: 实现 Vectorizer**（kernel/graph.mjs 顶部；import `hashLine` from `./memory.mjs`）

```js
// kernel/graph.mjs —— 内核神经图谱（无模型特征向量 + 图谱存储 + 检索）
import { hashLine } from './memory.mjs'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

const CJK = /[\u4e00-\u9fff]/
const WORD = /[A-Za-z0-9]/

export function* gramTokens(text) {
  const s = String(text ?? '').trim()
  let cjkSeg = ''
  let wordSeg = ''
  const flushCjk = function* () {
    if (!cjkSeg) return
    const chars = [...cjkSeg]
    if (chars.length === 1) yield chars[0]
    for (let i = 0; i + 1 < chars.length; i++) yield chars[i] + chars[i + 1]
    cjkSeg = ''
  }
  const flushWord = function* () {
    if (!wordSeg) return
    yield wordSeg.toLowerCase()
    wordSeg = ''
  }
  for (const ch of s) {
    if (CJK.test(ch)) { yield* flushWord(); cjkSeg += ch }
    else if (WORD.test(ch)) { yield* flushCjk(); wordSeg += ch }
    else { yield* flushCjk(); yield* flushWord() }
  }
  yield* flushCjk()
  yield* flushWord()
}

export function vectorizeText(text, { tagBoost = 1, idf = null } = {}) {
  const tf = new Map()
  for (const g of gramTokens(text)) tf.set(g, (tf.get(g) || 0) + 1)
  const raw = []
  for (const [gram, count] of tf) {
    const w = (1 + Math.sqrt(count)) * (tagBoost || 1) * (idf?.get(gram) ?? 1)
    raw.push([hashLine(gram), w])
  }
  const norm = Math.sqrt(raw.reduce((s, [, w]) => s + w * w, 0))
  return norm > 0 ? raw.map(([id, w]) => [id, w / norm]) : []
}

export function cosine(a, b) {
  const bm = new Map(b)
  let dot = 0
  for (const [id, wa] of a) { const wb = bm.get(id); if (wb) dot += wa * wb }
  return dot
}

export function buildIdf(docs) {
  const df = new Map()
  const N = docs.length
  for (const d of docs) for (const gram of d.gramCounts.keys()) df.set(gram, (df.get(gram) || 0) + 1)
  const idf = new Map()
  for (const [gram, count] of df) idf.set(gram, Math.log((N + 1) / (count + 1)) + 1)
  return idf
}
```

注意：`yield*` 在 generator 内调用 generator 需 `function*` 定义——上面 flushCjk/flushWord 已用 `function*`。若实现有出入，保证测试语义：中英分段、bigram、单词小写、归一化、tagBoost、cosine、idf。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/graph.test.mjs`
Expected: PASS（4 个用例）

- [ ] **Step 5: Commit**

```bash
git add kernel/graph.mjs server/graph.test.mjs
git commit -m "feat(kernel): 图谱特征向量化（n-gram 哈希 + TF/IDF + 余弦）"
```

---

### Task 2: 图谱存储 GraphStore

**Files:**
- Create: `kernel/graph.mjs`（追加 createGraphStore）
- Test: `server/graph.test.mjs`（追加节）

**Interfaces:**
- Consumes: `hashLine`（memory.mjs）、Task 1 的 `vectorizeText` / `buildIdf` / `gramTokens`
- Produces:
  - `createGraphStore({ root?: string }): GraphStore` —— `root` 为图谱目录（默认 `<configDir>/memory/graph`）
  - `GraphStore.load({ memoryRoot?: string }): Promise<void>` —— 图谱文件存在则流式加载（跳过半截行）；缺失则全量重建
  - `GraphStore.append({ theme, tag, summary, full }): { ok, deduped }` —— 构造行 `- [会话|tag] summary -- full`，id=`hashLine(行)`，去重后追加节点 + 落盘
  - `GraphStore.replaceAll(nodes: Node[]): void` —— 原子重写图谱文件（临时文件 + rename）
  - `GraphStore.getNodes(): Node[]`、`GraphStore.getIdf(): Map<string, number>`
  - Node = `{ id, theme, tag, summary, full, ts, vec: Array<[string, number]> }`

- [ ] **Step 1: 写失败测试**

```js
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
```

（文件头需补 import：`import fs from 'node:fs'`、`import os from 'node:os'`、`import path from 'node:path'`）

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/graph.test.mjs`
Expected: FAIL（createGraphStore 未定义）

- [ ] **Step 3: 实现 GraphStore**（kernel/graph.mjs 追加）

```js
const GRAPH_FILE = 'graph.jsonl'

function nodeLine(n) {
  return `- [会话${n.tag ? '|' + n.tag : ''}] ${n.summary} -- ${n.full}`
}

function entryToNode({ theme, tag, summary, full }, idf) {
  const tagText = tag ? tag : ''
  const vec = vectorizeText(`${theme} ${tagText} ${summary} ${full}`, { tagBoost: tag ? 3 : 1, idf })
  return { id: hashLine(nodeLine({ tag, summary, full })), theme, tag: tag || null, summary, full, ts: new Date().toISOString(), vec }
}

export function createGraphStore({ root = null } = {}) {
  const dir = root || join(process.env.PONOS_TEST_HOME || '', 'memory', 'graph')
  const file = join(dir, GRAPH_FILE)
  let nodes = []
  let idf = new Map()
  const recomputeIdf = () => {
    idf = buildIdf(nodes.map((n) => ({ gramCounts: new Map(n.vec.map(([id]) => [id, 1])) })))
  }
  // 闭包重建：扫描 memoryRoot 全部主题 md → 两遍（先收集算 IDF，再向量化）→ 原子替换
  const rebuildFromMemory = (memoryRoot) => {
    const collected = []
    let entries = []
    try { entries = readdirSync(memoryRoot).filter((f) => f.endsWith('.md') && !f.startsWith('.')) } catch { return }
    for (const f of entries) {
      const theme = f.slice(0, -3)
      for (const it of readMemoryEntries({ root: memoryRoot, theme })) {
        collected.push({ theme, tag: it.tag, summary: it.summary, full: it.full })
      }
    }
    const gramDocs = collected.map((c) => ({ gramCounts: new Map([...gramTokens(`${c.theme} ${c.tag || ''} ${c.summary} ${c.full}`)].map((g) => [g, 1])) }))
    const memIdf = buildIdf(gramDocs)
    const next = collected.map((c) => entryToNode(c, memIdf))
    nodes = next
    recomputeIdf()
    try {
      mkdirSync(dir, { recursive: true })
      const tmp = file + '.tmp'
      writeFileSync(tmp, nodes.map((n) => JSON.stringify(n)).join('\n') + '\n', 'utf-8')
      renameSync(tmp, file)
    } catch { /* 磁盘不可写不致命 */ }
  }
  return {
    getNodes: () => nodes,
    getIdf: () => idf,
    async load({ memoryRoot = null } = {}) {
      if (existsSync(file)) {
        try { mkdirSync(dir, { recursive: true }) } catch {}
        const raw = readFileSync(file, 'utf-8')
        nodes = []
        for (const line of raw.split(/\r?\n/)) {
          const t = line.trim()
          if (!t) continue
          try { nodes.push(JSON.parse(t)) } catch { /* 半截行跳过 */ }
        }
        recomputeIdf()
        return
      }
      if (memoryRoot) rebuildFromMemory(memoryRoot)
    },
    append({ theme = '', tag = null, summary = '', full = '' }) {
      const node = entryToNode({ theme, tag, summary, full })
      if (nodes.some((n) => n.id === node.id)) return { ok: true, deduped: true }
      nodes.push(node)
      recomputeIdf()
      try {
        mkdirSync(dir, { recursive: true })
        writeFileSync(file, nodes.map((n) => JSON.stringify(n)).join('\n') + '\n', 'utf-8')
      } catch { /* 磁盘不可写不致命：内存图谱可用 */ }
      return { ok: true, deduped: false }
    },
    replaceAll(next) {
      nodes = next
      recomputeIdf()
      try {
        mkdirSync(dir, { recursive: true })
        const tmp = file + '.tmp'
        writeFileSync(tmp, nodes.map((n) => JSON.stringify(n)).join('\n') + '\n', 'utf-8')
        renameSync(tmp, file)
      } catch { /* 磁盘不可写不致命 */ }
    },
  }
}
```

（`rebuildFromMemory` 与 `load` 均为闭包，无 `this` 依赖；`readMemoryEntries` 已从 memory.mjs 导出）

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/graph.test.mjs`
Expected: PASS（原 4 用例 + 新增 3 用例）

- [ ] **Step 5: Commit**

```bash
git add kernel/graph.mjs server/graph.test.mjs
git commit -m "feat(kernel): 图谱存储 GraphStore（append-only + 崩溃恢复 + 全量重建）"
```

---

### Task 3: 检索器 GraphSearch（混合评分 + 注入）

**Files:**
- Modify: `kernel/graph.mjs`（追加 search / keywordScore 混合逻辑）
- Modify: `kernel/memory.mjs`（导出 `keywordScore`，从 buildRelevantMemory 抽取）
- Test: `server/graph.test.mjs`（追加节）

**Interfaces:**
- Consumes: Task 2 的 `GraphStore.getNodes()/getIdf()`、Task 1 `cosine`
- Produces:
  - `keywordScore({ tag, summary, full, theme }, keywords: string[]): number`（memory.mjs 导出）——标签命中 +3 / 主题 +2 / 摘要 +2 / 全文 +1（与现 buildRelevantMemory 一致）
  - `GraphStore.search({ query: string, keywords?: string[], topK?: number, maxBytes?: number }): string` —— 注入文本：`【相关经验抽调】…` 引导语 + `- [主题|标签] 摘要 -- 全文` 行；最终分 = `0.7 × cosine + 0.3 × keywordScore`（归一化到 0-1 后）

- [ ] **Step 1: 修改 memory.mjs 抽取 keywordScore**

```js
// memory.mjs —— 从 buildRelevantMemory 抽取，供图谱检索复用（评分不变）
export function keywordScore({ tag = '', summary = '', full = '', theme = '' }, keywords = []) {
  const kws = keywords.map((k) => String(k).toLowerCase()).filter((k) => k.length >= 2)
  if (!kws.length) return 0
  const tagL = String(tag || '').toLowerCase()
  const sumL = String(summary || '').toLowerCase()
  const fullL = String(full || '').toLowerCase()
  const themeL = String(theme || '').toLowerCase()
  let score = 0
  for (const k of kws) {
    if (tagL.includes(k)) score += 3
    if (themeL.includes(k)) score += 2
    if (sumL.includes(k)) score += 2
    if (fullL.includes(k)) score += 1
  }
  return score
}
```

并在 `buildRelevantMemory` 内改用它（替换原内联打分循环，行为不变）。

- [ ] **Step 2: 写失败测试**

```js
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

test('GraphStore.search：maxBytes 截断', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-graph-'))
  try {
    const g = createGraphStore({ root: dir })
    for (let i = 0; i < 20; i++) g.append({ theme: 'workflow', summary: `经验${i}`, full: 'x'.repeat(50) })
    const out = g.search({ query: '经验', maxBytes: 500 })
    assert.ok(out.length <= 500)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node --test server/graph.test.mjs`
Expected: FAIL（search 未定义 / keywordScore 未导出）

- [ ] **Step 4: 实现 search**（kernel/graph.mjs，createGraphStore 返回对象内追加）

```js
search({ query = '', keywords = [], topK = 5, maxBytes = 2048 } = {}) {
  const q = String(query || '').trim()
  if (!q && !keywords.length) return ''
  const qvec = vectorizeText(q || keywords.join(' '), { idf })
  const scored = nodes.map((n) => {
    const cos = cosine(n.vec, qvec)
    const kw = keywordScore(n, keywords) / 8 // 关键词分最大值约 3+2+2+1=8，归一化到 0-1
    return { ...n, score: 0.7 * cos + 0.3 * Math.min(kw, 1) }
  }).filter((n) => n.score > 0.001)
  scored.sort((a, b) => b.score - a.score || b.ts.localeCompare(a.ts))
  const header = '\n\n【相关经验抽调】根据当前任务关键词，以下过往经验与任务直接相关，可直接参考（格式：-[主题|标签] 摘要 -- 全文）：\n'
  let out = header
  const seen = new Set()
  for (const it of scored.slice(0, topK)) {
    const line = `- [${it.theme}${it.tag ? '|' + it.tag : ''}] ${it.summary} -- ${it.full}`
    if (seen.has(it.id)) continue
    const lb = line.length + 1
    if (out.length + lb > maxBytes) break
    seen.add(it.id)
    out += line + '\n'
  }
  return out === header ? '' : out
}
```

注意 `idf`、`nodes` 在闭包内可用（search 定义在 createGraphStore 内部）。`keywordScore` 从 `./memory.mjs` import。

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test server/graph.test.mjs`
Expected: PASS（全用例）

- [ ] **Step 6: Commit**

```bash
git add kernel/graph.mjs kernel/memory.mjs server/graph.test.mjs
git commit -m "feat(kernel): 图谱检索器（余弦+关键词混合评分，注入格式兼容）"
```

---

### Task 4: memory 接线 + 启动重建校验

**Files:**
- Modify: `kernel/memory.mjs`（`appendMemoryEntry` 增加可选 `graphStore` 参数）
- Modify: `kernel/cli.mjs`（L3-1 捕获处传入 graphStore；初始化处创建 graphStore + await load）
- Test: `server/graph.test.mjs`（追加节）

**Interfaces:**
- Consumes: Task 2 `createGraphStore().append()/.load()`
- Produces: `appendMemoryEntry({ root, theme, tag, summary, full, graphStore? })` —— 传入 graphStore 时 markdown 写入成功后同步 `graphStore.append({ theme, tag, summary, full })`

- [ ] **Step 1: 写失败测试**

```js
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
```

注意：两个模块都读 `PONOS_TEST_HOME`，测试前 `process.env.PONOS_TEST_HOME = home` 需在 import 前设置（参考 experience.test.mjs 顶部模式）。若 memory.mjs 的 `memoryRoot(configDir)` 直接以参数传入 root，则无需 env——本测试全部走显式参数，不依赖 env。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/graph.test.mjs`
Expected: FAIL（appendMemoryEntry 忽略 graphStore，图谱无节点）

- [ ] **Step 3: 实现双写**（memory.mjs appendMemoryEntry 尾部）

```js
export function appendMemoryEntry({ root = '', theme = '', tag = null, summary = '', full = '', graphStore = null } = {}) {
  if (!root || !theme || !summary) return { ok: false, error: 'root/theme/summary required' }
  // ...既有 markdown 逻辑不变，成功路径末尾追加：
  const result = ... // 现有去重判定结果
  if (result.ok && graphStore) {
    graphStore.append({ theme, tag, summary, full }) // 同步图谱（内部去重）
  }
  return result
}
```

（实施时保留现有函数体，仅加参数与尾部调用）

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/graph.test.mjs`
Expected: PASS

- [ ] **Step 5: cli.mjs 接线**

在 cli.mjs 的 memoryRootDir 定义（约 :287）之后、engine 创建之前：

```js
// 神经图谱：图谱存储（markdown 权威，图谱派生索引；缺失自动重建）
import { createGraphStore } from './graph.mjs'   // 文件头追加
// ...
const graph = createGraphStore({ root: join(configDir, 'memory', 'graph') })
try { await graph.load({ memoryRoot: memoryRootDir }) } catch { /* 图谱故障不影响主流程 */ }
```

（若 cli 该作用域非 async，需确认所在函数已 async；cli 主流程为 async main，`await` 可用）

L3-1 捕获处（约 :431-432）：

```js
for (const c of captureMemoryCandidates({ userText: content, tag: ..., markers: ... })) {
  appendMemoryEntry({ root: memoryRootDir, theme: c.theme, tag: c.tag, summary: c.summary, full: c.full, graphStore: graph })
}
```

- [ ] **Step 6: 手动冒烟验证**

Run: `node cli.mjs --help`（启动无崩溃）+ `node --test server/graph.test.mjs`
Expected: 启动正常；测试全绿。手动验证：PONOS_TEST_HOME 指向空目录启动一次，`<home>/memory/graph/graph.jsonl` 在捕获经验后生成。

- [ ] **Step 7: Commit**

```bash
git add kernel/memory.mjs kernel/cli.mjs server/graph.test.mjs
git commit -m "feat(kernel): 经验沉淀双写图谱 + 启动重建校验"
```

---

### Task 5: L3-2 注入切换到图谱检索

**Files:**
- Modify: `kernel/cli.mjs`（L3-2 注入块，约 :290-300）
- Test: `server/graph.test.mjs`（追加节：注入输出与 index-only 行为）

**Interfaces:**
- Consumes: Task 3 `GraphStore.search({ query, keywords, maxBytes })`、Task 4 的 `graph` 实例
- Produces: 无新接口——行为变更：`memoryBlock` 中 `buildRelevantMemory` 段落替换为 `graph.search(...)` 输出

- [ ] **Step 1: 写失败测试（行为契约）**

```js
test('search 输出独立可用（逃生阀由 cli 控制）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-g-'))
  try {
    const g = createGraphStore({ root: dir })
    g.append({ theme: 'workflow', tag: 'x', summary: 's', full: 'f' })
    const out = g.search({ query: 'x', keywords: ['x'] })
    assert.ok(out.startsWith('\n\n【相关经验抽调】'))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/graph.test.mjs`
Expected: FAIL 或行为不一致（若已有 Task 3 覆盖则跳过此步，直接改 cli）

- [ ] **Step 3: 修改 cli.mjs L3-2**

```js
if (injectMode !== 'index-only') {
  const kw = [
    ...(args.addDirs || []).map((d) => basename(d)).filter(Boolean),
    ...(settings.merged.memory?.taskTag || '').split(',').map((s) => s.trim()).filter(Boolean),
    ...(process.env.PONOS_MEMORY_KEYWORDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  ]
  memoryBlock += graph.search({ query: kw.join(' '), keywords: kw })
}
```

`buildRelevantMemory` 不再被 cli 调用（函数保留在 memory.mjs 供测试/回退；若触发 no-unused 检查，在 memory.mjs 导出即可，或由 graph.mjs keywordScore 吸收后删除——**删除前先确认无其他引用**：grep `buildRelevantMemory`）。

- [ ] **Step 4: 验证注入块输出**

Run: 临时脚本或现有 engine-session 测试中注入记忆块：`PONOS_MEMORY_INJECT=both node cli.mjs`（需 mock 或无网络场景下 `PONOS_MOCK_API=1`）观察 system prompt 中记忆段格式。
Expected: 记忆段为 `【相关经验抽调】` 引导语 + 图谱命中行（有经验时）；空库时输出 `【个人经验索引】` 段不受影响（buildMemoryIndex 保留）。

- [ ] **Step 5: 回归验证 index-only / 逃生阀**

Run: `grep -n "buildRelevantMemory\|PONOS_MEMORY_INJECT\|memory?.inject" kernel/cli.mjs`
Expected: `PONOS_MEMORY_INJECT=index-only` 分支仍只注入 `buildMemoryIndex`；`settings.memory.inject=false` 时整个 memoryBlock 为空。

- [ ] **Step 6: Commit**

```bash
git add kernel/cli.mjs server/graph.test.mjs
git commit -m "feat(kernel): L3-2 记忆注入切换为图谱检索"
```

---

### Task 6: 回归与收尾

**Files:**
- Test: 全量 server 测试

- [ ] **Step 1: 全量回归**

Run: `cd /c/Users/T203-15/ponos-dev && npm test 2>&1 | tail -40`
Expected: 全部 PASS（含 memory/experience/session/engine 既有测试——确认 graph.mjs 导入与 memory.mjs 改动未破坏现有行为）

- [ ] **Step 2: 专项核对**

- `grep -n "graph" kernel/cli.mjs kernel/memory.mjs kernel/graph.mjs` 确认接线一致
- `node --check kernel/graph.mjs`（语法）
- 确认 `PONOS_GRAPH_BACKEND=external` 时行为：graph.mjs 未实现 external——cli 不读取该 env，行为 = 本地图谱。**预留语义**：在 graph.mjs 顶部注释声明 IGraphBackend 契约（search/write/health）与未来扩展点，本次不实现。

- [ ] **Step 3: Commit**

```bash
git add kernel/graph.mjs kernel/memory.mjs kernel/cli.mjs server/graph.test.mjs
git commit -m "test(kernel): 神经图谱全量回归"
```

---

## Self-Review 记录

- **Spec 覆盖**：Vectorizer（Task 1）✓ / GraphStore + 重建（Task 2）✓ / 混合评分 + 注入格式（Task 3）✓ / markdown 权威 + 双写 + 启动校验（Task 4）✓ / L3-2 替换 + 逃生阀（Task 5）✓ / IGraphBackend 预留（Task 6 Step 2）✓ / 测试（各 Task）✓
- **一致性**：`id = hashLine(行)` 在 append 与 rebuild 同构；`keywordScore` 权重与现 buildRelevantMemory 一致（3/2/2/1）；注入行格式 `- [主题|标签] 摘要 -- 全文` 与 memory.mjs parseEntryLine 对称。
- **依赖方向**：graph.mjs → memory.mjs（hashLine/readMemoryEntries/keywordScore），memory.mjs 不 import graph.mjs（graphStore 为参数注入），无循环依赖。
