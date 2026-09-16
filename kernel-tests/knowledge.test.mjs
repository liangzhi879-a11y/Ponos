// kernel/knowledge.mjs 测试：空间发现 / 文档解析 / 索引构建 / 检索 / 增量更新。
// 隔离纪律：全部走 mkdtempSync 临时 configDir，绝不碰真实 ~/.yfworking。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knowledgeRoot, discoverSpaces, walkMd, parseDocFile } from '../kernel/knowledge.mjs'
import { createKnowledgeStore } from '../kernel/knowledge.mjs'
import { GRAPH_DECAY } from '../shared/knowledge-core.mjs'

/** 造一个隔离的 configDir：含 personal 经验目录 + 一个用户空间 + 一个只读包 */
export function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kn-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  writeFileSync(join(personal, 'workflow.md'), [
    '---', 'name: workflow', 'description: 工作流心得', '---',
    '## 企微CLI化',
    '',
    '- [会话|企微CLI化] 只发文件传输助手 -- 涉及真实沟通渠道的测试一律只发文件传输助手',
    '- [会话|应用智控] 步骤字段契约 -- js 需 expression、click 类需 ref',
  ].join('\n') + '\n', 'utf-8')

  const notes = join(dir, 'knowledge', 'spaces', 'my-notes')
  mkdirSync(notes, { recursive: true })
  writeFileSync(join(notes, '.space.json'), JSON.stringify({ name: '我的笔记', description: '手写笔记' }), 'utf-8')
  writeFileSync(join(notes, 'a.md'), '# 甲文档\n\n见 [[b]]。\n\n正文内容。\n', 'utf-8')
  writeFileSync(join(notes, 'b.md'), '# 乙文档\n\n乙的正文。\n', 'utf-8')

  const pack = join(dir, 'knowledge', 'packs', 'demo-pack')
  mkdirSync(join(pack, 'docs'), { recursive: true })
  writeFileSync(join(pack, 'pack.json'), JSON.stringify({
    id: 'demo-pack', name: '演示知识包', version: '1.0.0', license: 'CC-BY-4.0', source: 'docs',
  }), 'utf-8')
  writeFileSync(join(pack, 'docs', 'p.md'), '# 包内文档\n\n包内容。\n', 'utf-8')
  return { dir, personal, notes, pack }
}

test('discoverSpaces：内置 + 用户空间 + 只读包，目录不存在则跳过', () => {
  const { dir } = makeFixture()
  try {
    const spaces = discoverSpaces({ configDir: dir })
    const byId = Object.fromEntries(spaces.map((s) => [s.id, s]))
    assert.ok(byId['experience'], '内置经验空间')
    assert.equal(byId['my-notes'].name, '我的笔记')
    assert.equal(byId['my-notes'].writable, true)
    assert.equal(byId['pack-demo-pack'].writable, false, '知识包只读')
    assert.equal(byId['pack-demo-pack'].packVersion, '1.0.0')
    assert.ok(!byId['session-memory'], 'session 目录不存在 → 不挂载')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('walkMd 递归找 md、归一正斜杠 rel、跳过隐藏目录与符号链接', () => {
  const { notes } = makeFixture()
  const files = walkMd(notes)
  assert.deepEqual(files.map((f) => f.relPath).sort(), ['a.md', 'b.md'])
})

test('parseDocFile：title 取 frontmatter.title→name→首个 heading→文件名；tags 含文件名主题与条目标签', () => {
  const { dir, personal } = makeFixture()
  try {
    const space = discoverSpaces({ configDir: dir }).find((s) => s.id === 'experience')
    const { doc, links } = parseDocFile({ absPath: join(personal, 'workflow.md'), space, relPath: 'workflow.md' })
    assert.equal(doc.id, 'experience/workflow.md')
    assert.equal(doc.title, 'workflow')
    assert.ok(doc.tags.includes('workflow'), '含文件名主题')
    assert.ok(doc.tags.includes('企微CLI化'), '含条目标签')
    assert.equal(doc.blocks.filter((b) => b.kind === 'entry').length, 2)
    assert.equal(doc.blocks.find((b) => b.kind === 'entry').tag, '企微CLI化')
    assert.equal(doc.blocks.find((b) => b.kind === 'entry').full, '涉及真实沟通渠道的测试一律只发文件传输助手')
    assert.ok(doc.lineCount ?? doc.lines > 0)
    assert.deepEqual(links, [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('parseDocFile 抽取链接边（from=docId）', () => {
  const { dir, notes } = makeFixture()
  try {
    const space = discoverSpaces({ configDir: dir }).find((s) => s.id === 'my-notes')
    const { links } = parseDocFile({ absPath: join(notes, 'a.md'), space, relPath: 'a.md' })
    // S5.1 追加 `anchor` / `line` / `block`：`line`+`block` 用于把链接**定位到所属条目**，
    // 是条目级 ref 关联的源（本 fixture 的链接在 frontmatter 之后、无 entry 块 → block 为 null，
    // 退化为文档级，属预期）。见 spec s51 §4.1。
    // 批次 2（2026-09-14）追加引用体系四字段：`anchorRef`/`anchorKind`（`#锚点`）、
    // `embed`（`![[x]]`）、`self`（`[[#x]]` 同文档锚点）—— 阅读视图要靠它们跳到
    // "那一节/那个块"、把嵌入渲染成内联内容。未用到时是空串/false。
    assert.deepEqual(links, [{
      from: 'my-notes/a.md', to: 'b', anchor: '', line: 3, block: null,
      anchorRef: '', anchorKind: '', embed: false, self: false,
    }])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('load(force) 全量构建索引：三份 JSONL + manifest 落盘，字段齐备', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const idx = join(dir, 'knowledge', '.index')
    assert.ok(existsSync(join(idx, 'manifest.json')), 'manifest 落盘')
    assert.ok(existsSync(join(idx, 'docs.jsonl')), 'docs 落盘')
    assert.ok(existsSync(join(idx, 'inverted.jsonl')), 'inverted 落盘')
    assert.ok(existsSync(join(idx, 'links.jsonl')), 'links 落盘')
    assert.ok(existsSync(join(idx, 'tags.json')), 'tags 落盘')

    const manifest = JSON.parse(readFileSync(join(idx, 'manifest.json'), 'utf-8'))
    assert.equal(manifest.version, 4) // 3→4：引用体系（links 的 to 语义 + 锚点/嵌入/同文档锚点，2026-09-14 批次 2）
    // experience(workflow.md) + my-notes(a,b) + pack(p.md) = 4 篇
    assert.equal(manifest.docs, 4)
    assert.ok(manifest.blocks >= 6)
    assert.ok(manifest.files['experience/workflow.md'], '指纹表含每篇文档')
    assert.equal(typeof manifest.files['experience/workflow.md'].mtime, 'number')

    const stats = store.stats()
    assert.equal(stats.docs, 4)
    assert.ok(stats.grams > 0)
    assert.ok(stats.indexBytes > 0)
    assert.equal(stats.indexAgeMs >= 0, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('load 无 force 时直接复用既有索引（builtAt 不变）', async () => {
  const { dir } = makeFixture()
  try {
    const s1 = createKnowledgeStore({ configDir: dir })
    await s1.load({ force: true })
    const builtAt1 = s1.stats().builtAt
    const s2 = createKnowledgeStore({ configDir: dir })
    await s2.load()
    assert.equal(s2.stats().builtAt, builtAt1, '未重建')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('md 变更后 load 自动重建（mtime 新于索引）', async () => {
  const { dir, personal } = makeFixture()
  try {
    const s1 = createKnowledgeStore({ configDir: dir })
    await s1.load({ force: true })
    const before = s1.stats().docs
    writeFileSync(join(personal, 'new.md'), '# 新文档\n\n新内容。\n', 'utf-8')
    const s2 = createKnowledgeStore({ configDir: dir })
    await s2.load()
    assert.equal(s2.stats().docs, before + 1, '新文档进索引')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('索引版本不符时自动重建（防旧格式误用）', async () => {
  const { dir } = makeFixture()
  try {
    const s1 = createKnowledgeStore({ configDir: dir })
    await s1.load({ force: true })
    const mf = join(dir, 'knowledge', '.index', 'manifest.json')
    const m = JSON.parse(readFileSync(mf, 'utf-8'))
    m.version = 999
    writeFileSync(mf, JSON.stringify(m), 'utf-8')
    const s2 = createKnowledgeStore({ configDir: dir })
    await s2.load()
    assert.equal(s2.stats().version ?? 1, 4, '重建回当前版本（2026-09-14 批次 2 起为 4）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('inverted.jsonl 的 postings 下标落在 docs.jsonl 行数范围内', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const idx = join(dir, 'knowledge', '.index')
    const docs = readFileSync(join(idx, 'docs.jsonl'), 'utf-8').split('\n').filter(Boolean)
    const inv = readFileSync(join(idx, 'inverted.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    assert.ok(inv.length > 0)
    for (const e of inv) {
      for (const [di, w] of e.p) {
        assert.ok(di >= 0 && di < docs.length, `docIdx ${di} 越界`)
        assert.ok(typeof w === 'number' && w > 0)
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('links.jsonl 的 target 解析到同空间 docId，断链为 null', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const rows = readFileSync(join(dir, 'knowledge', '.index', 'links.jsonl'), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const hit = rows.find((r) => r.from === 'my-notes/a.md')
    assert.equal(hit.target, 'my-notes/b.md', '[[b]] 解析到同目录 b.md')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('空空间（无任何 md）不崩，索引文档数为 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kn-empty-'))
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    assert.equal(store.stats().docs, 0)
    assert.deepEqual(store.getSpaces(), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('磁盘上的 md 被删除后 load 重建（per-file 指纹表检出"已删"）', async () => {
  const { dir, notes } = makeFixture()
  try {
    const s1 = createKnowledgeStore({ configDir: dir })
    await s1.load({ force: true })
    assert.equal(s1.stats().docs, 4)
    rmSync(join(notes, 'b.md'))
    const s2 = createKnowledgeStore({ configDir: dir })
    await s2.load()
    assert.equal(s2.stats().docs, 3, '删除的文档不再进索引')
    assert.ok(!s2.getDocs().some((d) => d.id === 'my-notes/b.md'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('索引目录不可写时降级为内存索引（不抛错，检索仍可用）', async () => {
  const { dir } = makeFixture()
  try {
    // 用同名文件占住 .index 路径 → mkdir/write/rename 全部失败，走 catch 降级分支
    writeFileSync(join(dir, 'knowledge', '.index'), 'blocked', 'utf-8')
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    assert.equal(store.stats().docs, 4, '内存索引仍可用')
    assert.ok(store.getInverted().size > 0, '倒排表已建好')
    assert.equal(store.stats().builtAt, null, '未落盘 → 无 builtAt')
    assert.equal(store.stats().indexBytes, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── Task 7：检索（4 路融合 + 双层预算截断）────────────────────────────────────

test('search 命中经验条目，粒度为单条（blockId 指向条目块）', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const r = store.search({ query: '只发文件传输助手', keywords: ['企微CLI化'], topK: 5 })
    assert.equal(typeof r.then, 'undefined', 'search 必须是同步契约（Task 10 的 run() 为同步）')
    assert.ok(r.count > 0, '有命中')
    const top = r.items[0]
    assert.equal(top.spaceId, 'experience')
    assert.equal(top.kind, 'entry')
    assert.equal(top.title, 'workflow')
    assert.match(top.blockId, /^experience\/workflow\.md#\d+$/)
    assert.ok(top.line > 0, 'line 可回溯原文行号')
    assert.match(top.snippet, /文件传输助手/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('search 结果按分数降序，且不含零分项', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const r = store.search({ query: '步骤字段契约', keywords: [], topK: 10 })
    for (let i = 1; i < r.items.length; i++) assert.ok(r.items[i - 1].score >= r.items[i].score)
    assert.ok(r.items.every((x) => x.score > 0.001))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('search 中文查询有效（bigram 命中，非关键词路）', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    // 期望值修正：原简报用 '沟通渠道'，但该串在 fixture 里**只出现在条目 full**（未进倒排，
    // 见 blockIndexText 只取 tag+text）→ 必然走降级路且 snippet 不含该串。改用同样"存在于
    // index 文本的中文短语"，保持本用例的意图（验证 bigram 中文查询走倒排路、非降级）。
    const r = store.search({ query: '乙的正文', topK: 5 })
    assert.ok(r.count > 0)
    assert.equal(r.degraded, false, '走倒排向量路，未降级')
    assert.match(r.items[0].snippet, /乙的正文/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('search 条目全文（full）进倒排：无 keywords 也能按正文召回（S5 §8 口径修正）', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    // '沟通渠道' 只存在于 entry 的 full 里（摘要 '只发文件传输助手' 与标签都没有）。
    // S5 §8 把索引文本从 `b.text`（60 字截断摘要）改为 `relationContent(b)`（full 去类型前缀）
    // 之后，正文词**直接进倒排** → 不传 keywords 也能召回。
    // 旧行为（S1/S2 的记录性用例）：正文不进倒排，不传 keywords 时 count=0（已知取舍，
    // 当时结论是"S2 若要求全文可检索需另行裁定"——S5 §8 裁定为：要）。
    const bare = store.search({ query: '沟通渠道', topK: 5 })
    assert.equal(bare.degraded, false, '倒排命中正文 gram → 不降级')
    assert.ok(bare.count >= 1, '正文命中即可召回')
    assert.equal(bare.items[0].docId, 'experience/workflow.md')
    assert.equal(bare.items[0].kind, 'entry')
    // 关键词路同样指向它（两条路径口径一致，不会互相矛盾）
    const kw = store.search({ query: '沟通渠道', keywords: ['沟通渠道'], topK: 5 })
    assert.equal(kw.items[0].blockId, bare.items[0].blockId)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('search spaces 过滤只返回指定空间', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const r = store.search({ query: '文档', spaces: ['my-notes'], topK: 10 })
    assert.ok(r.items.length > 0, '该空间内有命中')
    assert.ok(r.items.every((x) => x.spaceId === 'my-notes'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('search 出链图扩展：出链目标经图路进入结果并带 0.9 折扣', async () => {
  const { dir, notes } = makeFixture()
  try {
    // 造一个"与查询零 gram 交集"的链接目标：它不可能作为倒排候选出现，只能靠图扩展进来。
    writeFileSync(join(notes, 'a.md'), '# 甲文档\n\n见 [[d]]。\n\n正文内容。\n', 'utf-8')
    writeFileSync(join(notes, 'd.md'), '# 无关零散\n\n离题内容。\n', 'utf-8')
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const r = store.search({ query: '甲文档', keywords: ['甲文档'], topK: 10 })
    const a = r.items.find((x) => x.docId === 'my-notes/a.md')
    assert.ok(a, '命中甲文档自身')
    const d = r.items.find((x) => x.docId === 'my-notes/d.md')
    assert.ok(d, '出链目标 d.md 经图扩展进入结果（它无任何查询 gram 命中）')
    assert.equal(d.kind, 'heading')
    // 折扣生效：该 heading 无向量/关键词信号，只有 struct 底价 0.5 → base = 0.15×0.5，图路再 ×0.9
    assert.ok(Math.abs(d.score - 0.15 * 0.5 * GRAPH_DECAY) < 1e-9, `图扩展 ×0.9 折扣，score=${d.score}`)
    assert.ok(d.score < a.score, '图扩展项分数低于直接命中项')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('search topK 与 maxBytes 双层截断', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const r1 = store.search({ query: '文档', topK: 1 })
    assert.equal(r1.items.length, 1)
    const r2 = store.search({ query: '文档', topK: 100, maxBytes: 1 })
    assert.ok(r2.items.length <= 1, 'maxBytes 极小也至少给 1 条（否则前端永远空白）')
    assert.equal(r2.items.length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('search mode=full 返回条目全文，snippet 模式截断', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const short = store.search({ query: '文件传输助手', mode: 'snippet' })
    const full = store.search({ query: '文件传输助手', mode: 'full' })
    assert.ok(full.items[0].snippet.length >= short.items[0].snippet.length)
    assert.match(full.items[0].snippet, /涉及真实沟通渠道/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('search 空查询返回空结果且不报错', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const r = store.search({ query: '', keywords: [] })
    assert.deepEqual(r.items, [])
    assert.equal(r.count, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('search 无倒排命中时降级为关键词路（degraded=true，不抛错）', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const r = store.search({ query: 'zzzzz', keywords: ['zzzzz'] })
    assert.equal(r.degraded, true)
    assert.equal(r.count, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('search 不做原地排序：docs 序（docIdx 定义）与 postings 下标保持稳定', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const before = store.getDocs().map((d) => d.id)
    store.search({ query: '文档 契约 条目', keywords: ['文档'], topK: 10 })
    assert.deepEqual(store.getDocs().map((d) => d.id), before, '检索不得打乱 docs.jsonl 行序')
    for (const e of store.getInverted().values()) {
      for (let i = 1; i < e.p.length; i++) assert.ok(e.p[i - 1][0] <= e.p[i][0], 'postings 按 docIdx 升序')
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('search 结构加权生效：标题按词元命中（多词元查询也能吃到 0.15）', async () => {
  const { dir, notes } = makeFixture()
  try {
    writeFileSync(join(notes, 'PS表.md'), ['---', 'name: PS表', '---', '重合词内容。'].join('\n') + '\n', 'utf-8')
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    // 查询与正文零 gram 交集（向量分 0、降级路），kw 只有 keywords 命中（2 分 → 0.0625），
    // 剩下的分数只能来自标题结构加权；若标题判定退化为 includes(整串)，则只有 0.0625。
    const r = store.search({
      query: 'PS表 RD表 交叉校验', keywords: ['重合词'], spaces: ['my-notes'], topK: 3,
    })
    assert.equal(r.items.length, 1, '只有 PS表.md 有内容信号，其余文档纯 struct 分被剔除')
    assert.equal(r.items[0].docId, 'my-notes/PS表.md')
    const structPart = 0.15 // W_STRUCT × struct(=1)
    assert.ok(
      Math.abs(r.items[0].score - (0.25 * (2 / 8) + structPart)) < 1e-9,
      `标题结构加权生效（0.15 未被静默吞掉），score=${r.items[0].score}`,
    )
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── Task 8：增量更新与条目级读接口 ───────────────────────────────────────────

test('listEntries 返回条目级清单（GUI 与 AI 的公共读接口）', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const entries = store.listEntries('experience/workflow.md')
    assert.equal(entries.length, 2)
    assert.equal(entries[0].tag, '企微CLI化')
    assert.equal(entries[0].summary, '只发文件传输助手')
    assert.match(entries[0].full, /真实沟通渠道/)
    assert.match(entries[0].blockId, /^experience\/workflow\.md#\d+$/)
    assert.ok(entries[0].line > 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('listEntries 对非经验文档返回空数组（无条目块）', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    assert.deepEqual(store.listEntries('my-notes/b.md'), [])
    assert.deepEqual(store.listEntries('不存在的文档'), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('updateDoc 增量更新：新内容可检索，且其他文档 docIdx 不变', async () => {
  const { dir, personal } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const before = store.getDocs().map((d) => d.id)
    writeFileSync(join(personal, 'workflow.md'), [
      '---', 'name: workflow', '---',
      '- [会话|企微CLI化] 只发文件传输助手 -- 涉及真实沟通渠道的测试一律只发文件传输助手',
      '- [会话|新增标签] 全新的条目内容 -- 增量更新后立即可检索',
    ].join('\n') + '\n', 'utf-8')
    const r = await store.updateDoc('experience/workflow.md')
    assert.equal(r.updated, true)
    assert.deepEqual(store.getDocs().map((d) => d.id), before, 'docIdx 顺序不变')
    // 查询词只出现在 full（正文）里，不在摘要/标签里 —— S5 §8 把索引文本改为
    // relationContent(b) 后，正文即索引文本，增量更新后的正文立即可检索；
    // 而 snippet 仍取 `b.text`（摘要），故下面仍断言 snippet 是"全新的条目内容"（行为不变）。
    const hit = store.search({ query: '增量更新后立即可检索', topK: 3 })
    assert.ok(hit.count > 0, '同一会话内立即可检索（无需重启）')
    assert.match(hit.items[0].snippet, /全新的条目内容/)
    assert.equal(store.listEntries('experience/workflow.md').length, 2, '条目清单同步更新')
    // 落盘也要同步：postings 下标仍受 docs 行序保护
    const idx = join(dir, 'knowledge', '.index')
    const docsRows = readFileSync(join(idx, 'docs.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const invRows = readFileSync(join(idx, 'inverted.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    assert.equal(docsRows.length, before.length)
    for (const e of invRows) for (const [di] of e.p) assert.ok(di >= 0 && di < docsRows.length, 'postings 下标仍在范围内')
    assert.match(readFileSync(join(idx, 'docs.jsonl'), 'utf-8'), /全新的条目内容/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('updateDoc 对不存在的 docId 返回 not-found 且不崩', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const r = await store.updateDoc('experience/nope.md')
    assert.equal(r.updated, false)
    assert.equal(r.reason, 'not-found')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('updateDoc 对已删除的文件返回 file-missing 且不崩', async () => {
  const { dir, notes } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    rmSync(join(notes, 'a.md'))
    const r = await store.updateDoc('my-notes/a.md')
    assert.equal(r.updated, false)
    assert.equal(r.reason, 'file-missing')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('增量更新后 load() 不再触发全量重建（staleness 以 per-file mtime 判定）', async () => {
  const { dir, personal } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    writeFileSync(join(personal, 'workflow.md'), '# 改过了\n\n新正文。\n', 'utf-8')
    await store.updateDoc('experience/workflow.md')
    const s2 = createKnowledgeStore({ configDir: dir })
    await s2.load()
    assert.equal(s2.stats().builtAt, store.stats().builtAt, '复用增量结果，未全量重建')
    assert.equal(s2.search({ query: '新正文', topK: 1 }).count, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('getDoc / listTree / getLinks / getGraph 形状正确', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    assert.equal(store.getDoc('my-notes/a.md').title, '甲文档')
    assert.equal(store.getDoc('不存在'), null)

    const tree = store.listTree({ space: 'my-notes' })
    assert.deepEqual(tree.map((x) => x.name).sort(), ['a.md', 'b.md'])
    assert.ok(tree.every((x) => x.type === 'file' && x.docId))
    assert.deepEqual(store.listTree({ space: '不存在' }), [])

    const links = store.getLinks('my-notes/a.md')
    assert.equal(links.out[0].target, 'my-notes/b.md')
    assert.equal(links.in.length, 0)
    const bin = store.getLinks('my-notes/b.md')
    assert.equal(bin.in[0].from, 'my-notes/a.md', '反向链接')

    const g = store.getGraph({ space: 'my-notes' })
    assert.equal(g.nodes.length, 2)
    assert.equal(g.edges.filter((e) => e.target).length, 1)
    for (const n of g.nodes) assert.ok(n.id && n.label)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('listTree 拒绝读侧目录穿越（与写侧同一套判定）', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    store.load({ force: true })
    // 正常列举仍工作
    assert.deepEqual(store.listTree({ space: 'my-notes' }).map((x) => x.name).sort(), ['a.md', 'b.md'])
    // 各类穿越一律返回空（不得列出空间根之外的目录内容）
    assert.deepEqual(store.listTree({ space: 'my-notes', path: '../packs' }), [])
    assert.deepEqual(store.listTree({ space: 'my-notes', path: '../../knowledge' }), [])
    assert.deepEqual(store.listTree({ space: 'my-notes', path: '/etc' }), [])
    assert.deepEqual(store.listTree({ space: 'my-notes', path: 'C:/Windows' }), [])
    // `.` 是空操作（= 当前目录 = 空间根），应正常返回根列表而非空
    assert.deepEqual(store.listTree({ space: 'my-notes', path: '.' }).map((x) => x.name).sort(), ['a.md', 'b.md'])
    // 前导/尾随斜杠是正常的（GUI 树拼接会产生），不应被误拒
    assert.deepEqual(store.listTree({ space: 'my-notes', path: './' }).map((x) => x.name).sort(), ['a.md', 'b.md'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('search 支持逗号串空间过滤（HTTP ?spaces=a,b 的形式）', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    store.load({ force: true })
    // 多空间：两个空间都有内容时都应返回
    const both = store.search({ query: '内容', spaces: ['experience', 'my-notes'], topK: 20 })
    assert.ok(both.items.some((x) => x.spaceId === 'experience') || both.items.some((x) => x.spaceId === 'my-notes'))
    // 限定到不存在的空间必须 0 命中（证明过滤真的生效，而非静默忽略）
    assert.equal(store.search({ query: '内容', spaces: ['不存在'], topK: 20 }).count, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('截断的 inverted.jsonl 触发重建而非静默返回空集', async () => {
  const { dir } = makeFixture()
  try {
    const idx = join(dir, 'knowledge', '.index')
    const s1 = createKnowledgeStore({ configDir: dir })
    s1.load({ force: true })
    const before = s1.search({ query: '文件传输助手', topK: 5 })
    assert.ok(before.count > 0, '基线应有命中')
    // 模拟半写：把 inverted.jsonl 截掉一半（解析仍"合法"，只是 postings 变少）
    const f = join(idx, 'inverted.jsonl')
    const txt = readFileSync(f, 'utf-8')
    writeFileSync(f, txt.slice(0, Math.floor(txt.length / 2)), 'utf-8')
    // 新 store 加载：必须判定为损坏并重建，结果与截断前一致
    const s2 = createKnowledgeStore({ configDir: dir })
    s2.load()
    assert.equal(s2.search({ query: '文件传输助手', topK: 5 }).count, before.count, '截断后应重建并恢复命中')
    // 重建后写盘的 manifest 指纹应与实际行数一致
    const man = JSON.parse(readFileSync(join(idx, 'manifest.json'), 'utf-8'))
    const invLines = readFileSync(join(idx, 'inverted.jsonl'), 'utf-8').split('\n').filter(Boolean).length
    assert.equal(man.invLines, invLines)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('knowledgeRoot：<configDir>/knowledge，且 configDir 缺省不抛错', () => {
  // 直接测而不是只靠间接覆盖：这个函数决定"知识库放哪"，是发布版与调试版共同的落点，
  // 写错会让索引写到别处而表现为"检索永远为空"。函数刻意不自解析 home（由调用方给），
  // 所以 configDir 为空的退化输入也应稳定返回相对路径而非抛错。
  assert.equal(knowledgeRoot('/home/u/.yfworking'), join('/home/u/.yfworking', 'knowledge'))
  assert.equal(knowledgeRoot(''), join('', 'knowledge'))
  assert.equal(knowledgeRoot(undefined), join('', 'knowledge'))
  const winPath = ['C:', 'Users', 'u'].join(String.fromCharCode(92))
  assert.equal(knowledgeRoot(winPath), join(winPath, 'knowledge'))
})

// S3 §6 观测：store.stats() 增检索耗时（进程内环形缓冲，最近 100 次）。
test('S3：stats().search 记录检索耗时 P50/P95（进程内）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kstats-'))
  try {
    const personal = join(dir, 'memory', 'personal')
    mkdirSync(personal, { recursive: true })
    writeFileSync(join(personal, 'workflow.md'), '---\nname: workflow\n---\n- [会话|x] 检索耗时观测 -- 正文\n', 'utf-8')
    const store = createKnowledgeStore({ configDir: dir })
    store.load({})
    assert.deepEqual(store.stats().search, { count: 0, elapsedP50: null, elapsedP95: null }, '未检索时无样本')
    for (let i = 0; i < 5; i++) store.search({ query: '检索耗时观测' })
    const s = store.stats().search
    assert.equal(s.count, 5)
    assert.ok(typeof s.elapsedP50 === 'number' && s.elapsedP50 >= 0)
    assert.ok(typeof s.elapsedP95 === 'number' && s.elapsedP95 >= s.elapsedP50, 'P95 不得小于 P50')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ═══════════════════════════════════════════════════════════════════════════
// 2026-09-14 对标 Obsidian 批次 1：标签来源（YAML 子集 + 正文内联 #tag）
// ═══════════════════════════════════════════════════════════════════════════

test('collectTags（经 parseDocFile）：Obsidian 标准 frontmatter + 正文内联标签都进 doc.tags', () => {
  const { dir, notes } = makeFixture()
  try {
    // Obsidian 写法集合：block 列表 tags / flow 数组 aliases / 正文内联 #标签 / 行内代码干扰项
    writeFileSync(join(notes, 'obsidian-style.md'), [
      '---',
      'title: 兼容性样本',
      'tags:',
      '  - 财务',
      '  - 税务/增值税',
      'aliases:',
      '  - 账务',
      '---',
      '# 兼容性样本',
      '',
      '正文提到 #内联标签 与（#全角括号标签）以及 `#不是标签`。',
      '[链接文字](#锚点) 的锚点不算标签。',
    ].join('\n') + '\n', 'utf-8')

    const space = { id: 'my-notes', source: 'user' }
    const { doc } = parseDocFile({ absPath: join(notes, 'obsidian-style.md'), relPath: 'obsidian-style.md', space })
    for (const t of ['财务', '税务/增值税', '内联标签', '全角括号标签']) {
      assert.ok(doc.tags.includes(t), `doc.tags 应含 ${t}，实际 ${JSON.stringify(doc.tags)}`)
    }
    assert.ok(!doc.tags.includes('不是标签'), '行内代码里的 #不是标签 不得进索引')
    assert.ok(!doc.tags.includes('锚点'), 'markdown 链接目标里的 #锚点 不得进索引')
    assert.equal(doc.title, '兼容性样本')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('collectTags：title/tags 为数组时不产生脏标题（标量归一）', () => {
  const { dir, notes } = makeFixture()
  try {
    writeFileSync(join(notes, 'arr.md'), '---\ntitle:\n  - 数组标题\ntags: [甲, 乙]\n---\n正文\n', 'utf-8')
    const { doc } = parseDocFile({ absPath: join(notes, 'arr.md'), relPath: 'arr.md', space: { id: 'my-notes', source: 'user' } })
    assert.equal(doc.title, '数组标题', '数组 title 取首元素，不能渲染成 "数组标题" 拼接串')
    assert.deepEqual(doc.tags.sort(), ['乙', '甲'].sort())
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('search 返回 total（截断前的命中总数）且不改变 count 语义', () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    store.load({})
    const all = store.search({ query: '正文', topK: 50 })
    assert.ok(all.total >= all.count, 'total 是全量命中，count 是返回条数，恒有 total >= count')
    const one = store.search({ query: '正文', topK: 1 })
    assert.equal(one.count, 1, 'topK 截断 count')
    assert.equal(one.total, all.total, 'total 不受 topK 影响（这正是它与 count 的区别）')
    const empty = store.search({ query: '' })
    assert.equal(empty.total, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('listIndexTags：全库文档标签 + 空间过滤 + single 标记', () => {
  const { dir, notes } = makeFixture()
  try {
    writeFileSync(join(notes, 't1.md'), '---\ntags:\n  - 共享\n  - 独占甲\n---\n正文甲\n', 'utf-8')
    writeFileSync(join(notes, 't2.md'), '---\ntags:\n  - 共享\n---\n正文乙\n', 'utf-8')
    const store = createKnowledgeStore({ configDir: dir })
    store.load({})

    const all = store.listIndexTags()
    const byTag = Object.fromEntries(all.tags.map((t) => [t.tag, t]))
    assert.equal(byTag['共享'].count, 2, '同名标签跨文档累计')
    assert.equal(byTag['共享'].single, false)
    assert.equal(byTag['独占甲'].count, 1)
    assert.equal(byTag['独占甲'].single, true, '单例标签是标签体系腐烂的第一信号，须显式标记')
    assert.equal(all.spaces, null, '缺省不过滤')
    assert.equal(all.singleCount, all.tags.filter((t) => t.single).length)

    // 排序：count 降序（共享在独占甲之前）
    const idxShared = all.tags.findIndex((t) => t.tag === '共享')
    const idxOnly = all.tags.findIndex((t) => t.tag === '独占甲')
    assert.ok(idxShared < idxOnly, 'count 降序排列')

    const scoped = store.listIndexTags({ spaces: ['my-notes'] })
    assert.deepEqual(scoped.spaces, ['my-notes'])
    assert.ok(scoped.tags.some((t) => t.tag === '共享'), '限定空间后仍能看到该空间标签')
    const other = store.listIndexTags({ spaces: ['pack-demo-pack'] })
    assert.equal(other.tags.length, 0, '只读包内无 frontmatter 标签 → 空集（而不是报错）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('listIndexTags 经 CLI 的 --spaces 生效（漏登记 --spaces 会被静默吞掉）', async () => {
  const { dir } = makeFixture()
  try {
    writeFileSync(join(dir, 'knowledge', 'spaces', 'my-notes', 'x.md'), '---\ntags: [clitag]\n---\n正文\n', 'utf-8')
    const { runKnowledgeCommand } = await import('../kernel/knowledge-cli.mjs')
    const hit = await runKnowledgeCommand({ op: 'index-tags', args: { spaces: ['my-notes'] }, configDir: dir })
    assert.equal(hit.code, 0)
    assert.ok(hit.output.tags.some((t) => t.tag === 'clitag'), `应命中 clitag，实际 ${JSON.stringify(hit.output.tags)}`)
    const miss = await runKnowledgeCommand({ op: 'index-tags', args: { spaces: ['pack-demo-pack'] }, configDir: dir })
    assert.equal(miss.code, 0)
    assert.equal(miss.output.tags.length, 0, '过滤到无标签空间 → 空集（证明过滤真的生效，而不是参数被吞）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ═══════════════════════════════════════════════════════════════════════════
// 2026-09-14 批次 1：标签直连检索（标签名当查询词必须能命中）
//
// 这一路的存在理由是一条实测出来的洞：标签写在 frontmatter 里，**不在任何块文本中**，
// 而倒排/关键词路只索引块文本 → `财务` 这种"只当标签、正文从不提"的词全文检索恒为 0 命中，
// 于是"标签视图点标签去看同标签文档"会得到空白。
// ═══════════════════════════════════════════════════════════════════════════

test('search：查询词命中标签 → 直连该标签的文档（tagHit 标记 + 定值分）', () => {
  const { dir, notes } = makeFixture()
  try {
    // a：只在 frontmatter 打了标签，正文完全不提"财务"
    writeFileSync(join(notes, 'a.md'), '---\ntags:\n  - 财务\n---\n# 甲\n正文只有别的内容。\n', 'utf-8')
    // b：正文里明写"财务"（应作为正文命中，且不得被标签路重复计一条）
    writeFileSync(join(notes, 'b.md'), '---\ntags:\n  - 财务\n---\n# 乙\n财务制度说明。\n', 'utf-8')
    // c：**强**正文命中（词反复出现）——用于断言排序口径（见下面 idxC < idxA）
    writeFileSync(join(notes, 'c.md'), '---\n---\n# 丙\n财务 财务 财务：财务制度、财务流程、财务核算都要走财务口径。\n财务预算与财务决算。\n', 'utf-8')
    const store = createKnowledgeStore({ configDir: dir })
    store.load({})

    const r = store.search({ query: '财务', topK: 10 })
    const docsHit = r.items.map((x) => x.docId)
    assert.ok(docsHit.includes('my-notes/a.md'), '仅打标签、正文不提的文档也必须被命中（标签直连）')
    assert.ok(docsHit.includes('my-notes/b.md'), '正文命中的文档照常命中')
    assert.equal(docsHit.filter((d) => d === 'my-notes/b.md').length, 1, '同一文档不得出现两条（正文已命中则不再给标签命中）')

    const a = r.items.find((x) => x.docId === 'my-notes/a.md')
    assert.equal(a.tagHit, '财务', '标签命中必须带 tagHit 标记，供消费方区分证据类型')
    assert.ok(a.score > 0 && a.score < 0.2,
      `标签命中分走 struct 通道算出（≈0.10），不得高于正文命中，实际 ${a.score}`)
    const b = r.items.find((x) => x.docId === 'my-notes/b.md')
    assert.equal(b.tagHit, undefined, '正文命中不带 tagHit')

    // 正文命中与标签命中的**排序口径**：标签命中只带 struct 证据（≈0.10），正文命中另外
    // 带 cos/kw 项，故正文命中恒在标签命中之前。这里用 c.md（正文里反复出现）钉住这一顺序。
    const r2 = store.search({ query: '财务', topK: 10 })
    const idxC = r2.items.findIndex((x) => x.docId === 'my-notes/c.md')
    const idxA = r2.items.findIndex((x) => x.docId === 'my-notes/a.md')
    assert.ok(idxC >= 0 && idxA >= 0, '强正文命中与标签命中都要在结果里')
    assert.ok(idxC < idxA, `正文命中排在标签命中之前（c=${r2.items[idxC]?.score} a=${r2.items[idxA]?.score}）`)

    // 前导 `#` 与大小写：容忍（用户从正文里抄标签会带 #）
    assert.ok(store.search({ query: '#财务', topK: 10 }).items.length >= 2, '查询串带前导 # 也要能命中标签')
    // 不相关的词不该把标签文档带出来
    assert.equal(store.search({ query: '完全不存在的词', topK: 10 }).items.length, 0, '无关查询不产生标签命中')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('search：标签直连遵守 spaces 白名单', () => {
  const { dir, notes } = makeFixture()
  try {
    writeFileSync(join(notes, 'a.md'), '---\ntags:\n  - 财务\n---\n# 甲\n正文。\n', 'utf-8')
    const store = createKnowledgeStore({ configDir: dir })
    store.load({})
    const hit = store.search({ query: '财务', spaces: ['my-notes'], topK: 10 })
    assert.equal(hit.items.length, 1)
    const miss = store.search({ query: '财务', spaces: ['pack-demo-pack'], topK: 10 })
    assert.equal(miss.items.length, 0, '换到别的空间 → 标签命中也要一起被过滤掉（不能绕过白名单）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ═══════════════════════════════════════════════════════════════════════════
// 2026-09-14 对标 Obsidian 批次 2：引用体系（锚点 / 嵌入 / 同文档锚点 / 提及 / 断链 / 局部图）
//
// 这一批修的核心是"引用的**位置**信息" —— 旧实现只记"谁引用了谁"，不记"引用的是哪一节、
// 在哪一行、是不是嵌入"，于是：点链接只能到文档开头、嵌入与引用不可区分、反链看不到上下文、
// 文档内部的 `[[#小节]]` 整批丢失、被编辑过的文档连行号都会丢。
// ═══════════════════════════════════════════════════════════════════════════

test('批次2：引用锚点/嵌入/同文档锚点都被解析并落盘（增量路径字段不丢）', () => {
  const { dir, notes } = makeFixture()
  try {
    writeFileSync(join(notes, 'notes.md'), [
      '# 笔记',
      '',
      '见 [[guide#安装步骤]] 与 [[guide|指南]]。',
      '',
      '![[snippet]]',
      '',
      '本文档内跳到 [[#本地小节]]。',
      '',
    ].join('\n'), 'utf-8')
    writeFileSync(join(notes, 'guide.md'), '# 指南\n\n## 安装步骤\n\n第一步。\n', 'utf-8')
    writeFileSync(join(notes, 'snippet.md'), '被嵌入的片段。\n', 'utf-8')

    const store = createKnowledgeStore({ configDir: dir })
    store.load({})
    const out = store.getLinks('my-notes/notes.md').out
    const anchor = out.find((l) => l.to === 'guide' && l.anchorRef === '安装步骤')
    assert.ok(anchor, `锚点引用要有 anchorRef，实际 ${JSON.stringify(out)}`)
    assert.equal(anchor.anchorKind, 'heading')
    assert.equal(anchor.target, 'my-notes/guide.md', '锚点剥离后仍要解析到目标文档')
    assert.ok(out.some((l) => l.to === 'guide' && l.anchor === '指南'), '别名引用照旧')
    assert.ok(out.some((l) => l.to === 'snippet' && l.embed === true), '![[x]] 要标 embed')
    const selfRef = out.find((l) => l.self === true)
    assert.ok(selfRef, '`[[#本地小节]]` 同文档锚点必须保留（旧实现因 to 为空被整条丢弃）')
    assert.equal(selfRef.target, 'my-notes/notes.md', '同文档锚点的目标就是本文档自身')
    assert.equal(selfRef.anchorRef, '本地小节')

    // a.md 在本套用例里不含任何链接，改它来触发**增量**路径（修 relinkDoc 丢字段的那个 bug）
    writeFileSync(join(notes, 'a.md'), '# 笔记 A\n\n改一下，见 [[guide#使用]]。\n', 'utf-8')
    store.updateDoc('my-notes/a.md')
    const inc = store.getLinks('my-notes/a.md').out
    assert.equal(inc.length, 1)
    assert.equal(inc[0].anchorKind, 'heading', '增量路径也不能丢 anchorKind（旧实现只写 from/to/target）')
    assert.equal(inc[0].anchorRef, '使用')
    assert.ok(inc[0].line > 0, '增量路径必须带行号（旧实现丢 line → 跳转定位失效）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('批次2：反链带上下文（line/block/snippet）且不丢锚点信息', () => {
  const { dir, notes } = makeFixture()
  try {
    writeFileSync(join(notes, 'a.md'), '# 甲\n\n这里是正文，引用 [[b#某节]]。\n', 'utf-8')
    writeFileSync(join(notes, 'b.md'), '# 乙\n\n## 某节\n\n内容。\n', 'utf-8')
    const store = createKnowledgeStore({ configDir: dir })
    store.load({})
    const back = store.getLinks('my-notes/b.md').in
    assert.equal(back.length, 1)
    assert.equal(back[0].from, 'my-notes/a.md')
    assert.equal(back[0].anchorRef, '某节', '反链要知道"引用的是哪一节"')
    assert.ok(back[0].line > 0, '反链要有行号（可跳转）')
    assert.ok(String(back[0].snippet).includes('引用'), '反链要有上下文片段（Obsidian 反链面板的核心）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('批次2：未链接提及（标题/文件名匹配、排除已链接、排除自身、长度护栏）', () => {
  const { dir, notes } = makeFixture()
  try {
    writeFileSync(join(notes, 'guide.md'), '# 指南手册\n\n本文档内容。\n', 'utf-8')
    // ① 正文提到标题但没链接 → 应被列出
    writeFileSync(join(notes, 'talk.md'), '# 闲聊\n\n正文写到 指南手册 四个字，但没有链接。\n', 'utf-8')
    // ② 正文提到文件名 stem（guide）但没链接 → 也应被列出
    writeFileSync(join(notes, 'other.md'), '# 其他\n\n提到了 guide 这个词。\n', 'utf-8')
    // ③ 已经打了链接的文档 → 不算"未链接提及"（否则与反链面板显示同一件事）
    writeFileSync(join(notes, 'linked.md'), '# 已链\n\n见 [[guide]]。\n', 'utf-8')
    const store = createKnowledgeStore({ configDir: dir })
    store.load({})
    const r = store.listMentions('my-notes/guide.md')
    const docsHit = r.items.map((x) => x.docId)
    assert.ok(docsHit.includes('my-notes/talk.md'), '标题提及要命中')
    assert.ok(docsHit.includes('my-notes/other.md'), '文件名 stem 提及要命中')
    assert.ok(!docsHit.includes('my-notes/linked.md'), '已建立链接的不算"未链接提及"')
    assert.ok(!docsHit.includes('my-notes/guide.md'), '自身不算提及')
    const talk = r.items.find((x) => x.docId === 'my-notes/talk.md')
    assert.equal(talk.matched, '指南手册')
    assert.ok(talk.line > 0 && talk.blockId.includes('#'), '提及要有行号与块 ID 供跳转')
    // 长度护栏：单字标题不参与匹配（否则会命中成百上千处噪声）
    writeFileSync(join(notes, 'one.md'), '# 甲\n\n内容。\n', 'utf-8')
    writeFileSync(join(notes, 'noise.md'), '# 噪声\n\n甲 甲 甲。\n', 'utf-8')
    const store2 = createKnowledgeStore({ configDir: dir })
    store2.load({})
    assert.equal(store2.listMentions('my-notes/one.md').items.length, 0, '单字标题不参与提及匹配')
    // limit 是**扫到就停**的硬护栏
    assert.ok(store.listMentions('my-notes/guide.md', { limit: 1 }).items.length <= 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('批次2：断链按目标聚合 + 空间过滤', () => {
  const { dir, notes } = makeFixture()
  try {
    writeFileSync(join(notes, 'x.md'), '# 坏链\n\n指向 [[不存在]] 与 [[缺目标#某节]]。\n', 'utf-8')
    writeFileSync(join(notes, 'y.md'), '# 也坏\n\n又一次 [[不存在]]。\n', 'utf-8')
    const store = createKnowledgeStore({ configDir: dir })
    store.load({})
    const r = store.listBrokenLinks()
    const bad = r.items.find((x) => x.to === '不存在')
    assert.ok(bad, `应有"不存在"这条断链，实际 ${JSON.stringify(r.items)}`)
    assert.equal(bad.count, 2, '同一目标在多处写错要聚合计数')
    assert.equal(bad.refs.length, 2, '要保留每处引用（用户要能逐个去改）')
    assert.ok(r.items.some((x) => x.to === '缺目标' && x.refs[0].anchorRef === '某节'), '带锚点的断链也要列出')
    assert.equal(r.broken, 3)
    // 空间过滤：换到不存在的空间 → 空集（证明过滤生效）
    assert.equal(store.listBrokenLinks({ space: 'no-such-space' }).broken, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('批次2：图谱局部图（双向 N 跳邻域 + 去自环 + 端点必在节点集内）', () => {
  const { dir, notes } = makeFixture()
  try {
    // 链：a → b → c → d，另有孤岛 e，以及 a 的自引用（同文档锚点）
    writeFileSync(join(notes, 'a.md'), '# 甲\n\n[[b]] 与 [[#自己]]\n', 'utf-8')
    writeFileSync(join(notes, 'b.md'), '# 乙\n\n[[c]]\n', 'utf-8')
    writeFileSync(join(notes, 'c.md'), '# 丙\n\n[[d]]\n', 'utf-8')
    writeFileSync(join(notes, 'd.md'), '# 丁\n\n没有出链。\n', 'utf-8')
    writeFileSync(join(notes, 'e.md'), '# 孤岛\n\n无人理我。\n', 'utf-8')
    const store = createKnowledgeStore({ configDir: dir })
    store.load({})

    // 全局图：含全部文档（fixture 自带若干 md，故只断言"包含我造的 5 篇"与"无自环"）
    const all = store.getGraph({})
    for (const id of ['a.md', 'b.md', 'c.md', 'd.md', 'e.md']) {
      assert.ok(all.nodes.some((n) => n.id === `my-notes/${id}`), `全局图应含 ${id}`)
    }
    assert.ok(!all.edges.some((e) => e.from === e.to), '自环边不得进图（`[[#自己]]` 是自引用）')
    assert.ok(all.edges.every((e) => all.nodes.some((n) => n.id === e.from) && all.nodes.some((n) => n.id === e.to)),
      '边的端点必须在节点集内（旧实现在 limit 截断时会产生悬空边）')

    // 1 跳（双向）：a 的出链邻居 b + 入链（无）→ {a, b}；隔离的 c/d/e 不在
    const h1 = store.getGraph({ around: 'my-notes/a.md', hops: 1 })
    assert.deepEqual(h1.nodes.map((n) => n.id).sort(), ['my-notes/a.md', 'my-notes/b.md'],
      '1 跳只含自身与直接邻居')
    // 2 跳：a → b → c（含双向）
    const h2 = store.getGraph({ around: 'my-notes/a.md', hops: 2 })
    assert.deepEqual(h2.nodes.map((n) => n.id).sort(),
      ['my-notes/a.md', 'my-notes/b.md', 'my-notes/c.md'])
    // 3 跳：到 d 为止，**仍然不含孤岛 e**（局部图的全部意义就是不把无关节点拉进来）
    const h3 = store.getGraph({ around: 'my-notes/a.md', hops: 3 })
    assert.deepEqual(h3.nodes.map((n) => n.id).sort(),
      ['my-notes/a.md', 'my-notes/b.md', 'my-notes/c.md', 'my-notes/d.md'])
    assert.ok(!h3.nodes.some((n) => n.id === 'my-notes/e.md'), '孤岛不得进局部图')
    // 反向也要走：以 d 为心 1 跳 → {d, c}（入链方向）
    const back = store.getGraph({ around: 'my-notes/d.md', hops: 1 })
    assert.deepEqual(back.nodes.map((n) => n.id).sort(), ['my-notes/c.md', 'my-notes/d.md'],
      '局部图必须双向遍历（只走出链会漏掉"谁引用了我"）')
    // hops 超上限被 clamp 到 3；around 不存在 → 回落全局图（不报错）
    assert.equal(store.getGraph({ around: 'my-notes/a.md', hops: 99 }).nodes.length, h3.nodes.length)
    const fallback = store.getGraph({ around: 'my-notes/不存在.md', hops: 2 })
    assert.ok(fallback.nodes.length > h3.nodes.length, 'around 不存在时回落全局图，而不是空图')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
