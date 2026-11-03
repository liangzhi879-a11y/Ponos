// S6：索引的**静默截断**回归。原主题是"护栏本身合理、但静默丢数据不可接受"。
//
// ★★ 2026-09-30 用户裁决（优先级最高）：**知识库不做上限约束**。
//   原话：「知识库理论上不能做上限约束，需要的是解决如何在大数据量的前提下，仍能正常解析和读取，
//   分块是否合理，标签是否冗余，或者其他相关优化」。
//   ⇒ 单文档块数上限（`MAX_BLOCKS_PER_DOC` + `capBlocks` 的尾部截断）与每空间文件数上限
//     （`FILE_LIMIT_PER_SPACE`）**已从内核删除**：索引侧不再有任何"条数到了就停手"的路径。
//     本文件据此改写：原来守"截断必须出声/上限要留余量"，现在守"**不允许存在丢弃式上限**"
//     —— 方向相反，但同样是机器可判的红线（谁把上限加回来，谁就红）。
//
// 背景（合并历史经验库时实测暴露，也是这次裁决的直接来由）：
//  ① `MAX_BLOCKS_PER_DOC` 原为 200，实现是 `slice(0, 200)` —— **静默丢尾部**。
//     合并后 `experience/workflow.md` 达 239 条条目 ⇒ 尾部 ~48 条不进索引：
//     文件里 Read 看得见，但检索不到、没有关联边、图谱里不存在。
//     实测症状：文件 302 条 / 索引 254 条，差值无任何提示。（把 200 调到 2000 只是把同一机制
//     推到更远处 —— 故本次删掉机制本身。）
//  ② 条目级图沿用了文档级的 `limit = 200` 缺省，且 `pool.slice(0, limit)` 是**从头截**，
//     恰好砍掉排在文档尾部的段（= 刚合并进来的那批经验）⇒ "合并了却看不见"。
//     而 `knowledge-cli.mjs` 又写死 `Number(args.limit) || 200`，把缺省变成"显式值"，
//     使层级缺省永远被覆盖。★ 这一项属于**展示层分页**（返回 `truncated` 标记、数据未丢），
//     不在"索引/存储/检索丢数据"的范围内，故其断言保持原样（缺省覆盖全池、显式 limit 生效）。
//
// 本文件钉住：① 单文档 2000+ 块**全部**进索引（真跑，不是源码守卫）；② 内核源码里不存在
// 丢弃式上限（防回退）；③ 容量内一条不少；④ 条目级图缺省覆盖全池；显式 limit 仍生效；
// 非法 limit 不产出空图。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runKnowledgeCommand } from '../kernel/knowledge-cli.mjs'
import { createKnowledgeStore } from '../kernel/knowledge.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(ROOT, 'kernel', 'cli.mjs')

const tmp = []
function fixture(n, { tag = '容量测试' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-cap-'))
  tmp.push(dir)
  mkdirSync(join(dir, 'memory', 'personal'), { recursive: true })
  const lines = ['---', 'name: workflow', '---']
  for (let i = 1; i <= n; i++) {
    // 每条正文互不相同且足够长（>MIN_LEN），避免被关联侧参与集过滤而干扰计数
    lines.push(`- [会话|${tag}] 第 ${i} 条 -- 这是第 ${i} 条容量测试经验，正文包含足够字符以进入索引与关联参与集`)
  }
  writeFileSync(join(dir, 'memory', 'personal', 'workflow.md'), lines.join('\n') + '\n', 'utf-8')
  return dir
}
process.on('exit', () => { for (const d of tmp) { try { rmSync(d, { recursive: true, force: true }) } catch {} } })

const entriesOf = async (dir) => {
  const { output } = await runKnowledgeCommand({ op: 'entries', configDir: dir, args: { id: 'experience/workflow.md' } })
  return output.entries || []
}

test('239 条条目全部进索引，且尾条目在内（原 200 块上限会静默丢掉尾部）', async () => {
  const dir = fixture(239)
  const rows = await entriesOf(dir)
  assert.equal(rows.length, 239, '容量内不允许丢任何一条（原先 slice(0,200) 会只剩 200）')
  // 截断总是从尾开始 —— 这正是合并后"新经验看不见"的机制，故尾部必须单独钉住
  const last = rows[rows.length - 1]
  assert.equal(last.blockId, 'experience/workflow.md#238')
  assert.equal(last.summary, '第 239 条')
})

test('★ 单文档 2200 块**全部**进索引（无块数上限；原 capBlocks 会砍掉尾部 200 块）', () => {
  // 这是"知识库不做上限约束"（2026-09-30 裁决）的**运行时**守卫：真造一篇 >2000 块的大文档，
  // 断言最后一块也在索引里且**可被检索到**（不只是"文件里有"）。
  // 为什么能进套件：按旧注释">2000 条 fixture 单次 reindex 实际 25s"是**关联物化**（同空间
  // N×M 次相似度）的成本，与本守卫要测的"索引是否丢块"无关 ⇒ 用 `relateMode: 'off'`
  // 隔离掉关联层，让守卫盯住它真正关心的那一层（分块→存储→检索）。
  const dir = mkdtempSync(join(tmpdir(), 'ponos-nocap-'))
  tmp.push(dir)
  mkdirSync(join(dir, 'memory', 'personal'), { recursive: true })
  const N = 2200
  const lines = ['---', 'name: workflow', '---']
  for (let i = 1; i <= N; i++) {
    lines.push(`- [会话|容量测试] 第 ${i} 条 -- 这是第 ${i} 条大文档容量测试经验，正文包含足够字符以进入索引`)
  }
  writeFileSync(join(dir, 'memory', 'personal', 'workflow.md'), lines.join('\n') + '\n', 'utf-8')

  const store = createKnowledgeStore({ configDir: dir, relateMode: 'off' })
  store.load({ force: true })
  const doc = store.getDoc('experience/workflow.md')
  assert.ok(doc, '文档必须在索引里')
  assert.equal(doc.blocks.length, N, `块必须一条不少地进索引（期望 ${N}，实际 ${doc.blocks.length}）`)
  assert.equal(store.listEntries('experience/workflow.md').length, N, '条目级清单同样一条不少')
  // 尾部块是旧实现被砍的那一端 ⇒ 必须单独钉住"看得见 + 找得到"
  const lastBid = `experience/workflow.md#${N - 1}`
  assert.ok(doc.blocks.some((b) => `experience/workflow.md#${b.n}` === lastBid), '尾块必须在索引里')
  const hit = store.search({ query: `第 ${N} 条`, topK: 5 })
  assert.ok(hit.count > 0, '尾块必须可被检索到（空集合 = fail-closed 判红）')
  assert.ok(hit.items.some((i) => i.blockId === lastBid), `尾块必须能被检索到（得到 ${JSON.stringify(hit.items.map((i) => i.blockId))}）`)
})

test('★ 防回退：内核源码里不得再出现丢弃式上限（块数 / 文件数）', () => {
  const src = readFileSync(join(ROOT, 'kernel', 'knowledge.mjs'), 'utf8')
  // ① 块数上限：常量与截断 helper 都不允许复活
  assert.doesNotMatch(src, /const MAX_BLOCKS_PER_DOC\s*=/, '不得恢复"单文档块数上限"（2026-09-30 裁决：知识库不做上限约束）')
  assert.doesNotMatch(src, /const capBlocks\s*=/, '不得恢复丢弃尾部的 capBlocks')
  assert.doesNotMatch(src, /blocks\.slice\(0,\s*MAX_BLOCKS_PER_DOC\)/, '不得恢复静默截断写法')
  // ② 文件数上限：内核扫描不得再传有限 maxFiles（`walkMd` 自己仍支持调用方显式限流，
  //    但内核路径必须全量收录，否则又变成"文件里有、知识库没有"）
  assert.doesNotMatch(src, /const FILE_LIMIT_PER_SPACE\s*=/, '不得恢复每空间文件数上限常量')
  assert.doesNotMatch(src, /walkMd\(space\.root,\s*\{\s*maxFiles/, '内核扫描不得传 maxFiles（须全量收录）')
})

test('正常容量下 blocksTruncated 恒为零值（字段形状稳定，消费方不必分支）', async () => {
  const dir = fixture(3)
  await runKnowledgeCommand({ op: 'reindex', configDir: dir, args: { force: true } })
  const stats = (await runKnowledgeCommand({ op: 'stats', configDir: dir, args: {} })).output
  assert.deepEqual(stats.blocksTruncated, { docs: 0, droppedBlocks: 0, docIds: [] })
})

test('条目级图缺省覆盖全池（不再被 200 截断）；文档级缺省行为不变', async () => {
  const dir = fixture(260)
  await runKnowledgeCommand({ op: 'reindex', configDir: dir, args: { force: true } })
  const entry = (await runKnowledgeCommand({ op: 'graph', configDir: dir, args: { level: 'entry' } })).output
  assert.equal(entry.nodes.length, 260, '条目级缺省上限必须覆盖全池（原先恒被截到 200）')
  assert.equal(entry.truncated, false)

  // 文档级仍走自己的 200 缺省（本 fixture 只有 1 篇文档，故必然不截断）
  const doc = (await runKnowledgeCommand({ op: 'graph', configDir: dir, args: {} })).output
  assert.equal(doc.nodes.length, 1)
})

test('真进程：显式 --limit 生效；非法 --limit 退化为层级缺省而非空图', () => {
  const dir = fixture(60)
  const env = { ...process.env, PONOS_HOME: dir }
  delete env.PONOS_CONFIG_DIR
  const run = (args) => JSON.parse(spawnSync(process.execPath, [CLI, '--output-format', 'stream-json', '--input-format', 'stream-json', ...args], { env, encoding: 'utf8', timeout: 60_000 }).stdout)

  assert.equal(run(['--knowledge', 'graph', '--level', 'entry', '--limit', '50']).nodes.length, 50)
  assert.equal(run(['--knowledge', 'graph', '--level', 'entry', '--limit', '50']).truncated, true)
  // `Number('abc') = NaN` 若直接透传，slice(0, NaN) 会得到**空图**（比截断更糟：看起来像库坏了）
  assert.equal(run(['--knowledge', 'graph', '--level', 'entry', '--limit', 'abc']).nodes.length, 60)
})
