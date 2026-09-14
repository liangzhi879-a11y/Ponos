// S6：索引导入的**两条静默截断**回归。两者都是"护栏本身合理、但静默丢数据不可接受"。
//
// 背景（合并历史经验库时实测暴露）：
//  ① `MAX_BLOCKS_PER_DOC` 原为 200，实现是 `slice(0, 200)` —— **静默丢尾部**。
//     合并后 `experience/workflow.md` 达 239 条条目 ⇒ 尾部 ~48 条不进索引：
//     文件里 Read 看得见，但检索不到、没有关联边、图谱里不存在。
//     实测症状：文件 302 条 / 索引 254 条，差值无任何提示。
//  ② 条目级图沿用了文档级的 `limit = 200` 缺省，且 `pool.slice(0, limit)` 是**从头截**，
//     恰好砍掉排在文档尾部的段（= 刚合并进来的那批经验）⇒ "合并了却看不见"。
//     而 `knowledge-cli.mjs` 又写死 `Number(args.limit) || 200`，把缺省变成"显式值"，
//     使层级缺省永远被覆盖。
//
// 本文件钉住：容量足够时**一条都不能少**；截断路径**必须出声且可观测**（源码守卫，
// 因为真截断需要 >2000 条 fixture，单次 reindex 实测 25s，不适合放进套件）；
// 条目级缺省必须覆盖全池；显式 limit 仍生效；非法 limit 不产出空图。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runKnowledgeCommand } from '../kernel/knowledge-cli.mjs'

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

test('截断路径必须"出声 + 可观测"（源码守卫：真触发需 >2000 条，单次 25s 不适合进套件）', () => {
  const src = readFileSync(join(ROOT, 'kernel', 'knowledge.mjs'), 'utf8')
  // 集中在一个 helper 里，而不是散落的裸 slice
  assert.match(src, /const capBlocks = /, '截断逻辑必须收敛到 capBlocks helper')
  assert.match(src, /console\.warn\(`\[knowledge\] \$\{doc\.id\}: 块数/, '截断必须写 warn，不能静默丢')
  assert.match(src, /blocksTruncated:/, 'stats 必须暴露截断计数（可观测）')
  // 防回退：不允许再出现"直接 slice 掉尾部、不留痕"的写法
  assert.doesNotMatch(src, /blocks\.length > MAX_BLOCKS_PER_DOC\)\s*\{\s*\n\s*[a-z.]*blocks = [a-z.]*blocks\.slice/, '不得恢复静默截断')
  // 上限本身要留足余量（真实单文件已 239 条）
  const cap = Number(src.match(/const MAX_BLOCKS_PER_DOC = (\d+)/)[1])
  assert.ok(cap >= 1000, `上限 ${cap} 对真实库（单文件 239 条）余量不足`)
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
  delete env.CLAUDE_CONFIG_DIR
  const run = (args) => JSON.parse(spawnSync(process.execPath, [CLI, '--output-format', 'stream-json', '--input-format', 'stream-json', ...args], { env, encoding: 'utf8', timeout: 60_000 }).stdout)

  assert.equal(run(['--knowledge', 'graph', '--level', 'entry', '--limit', '50']).nodes.length, 50)
  assert.equal(run(['--knowledge', 'graph', '--level', 'entry', '--limit', '50']).truncated, true)
  // `Number('abc') = NaN` 若直接透传，slice(0, NaN) 会得到**空图**（比截断更糟：看起来像库坏了）
  assert.equal(run(['--knowledge', 'graph', '--level', 'entry', '--limit', 'abc']).nodes.length, 60)
})
