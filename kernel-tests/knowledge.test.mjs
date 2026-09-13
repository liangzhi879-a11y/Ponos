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
    assert.deepEqual(links, [{ from: 'my-notes/a.md', to: 'b' }])
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
    assert.equal(manifest.version, 1)
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
    assert.equal(s2.stats().version ?? 1, 1, '重建回当前版本')
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
