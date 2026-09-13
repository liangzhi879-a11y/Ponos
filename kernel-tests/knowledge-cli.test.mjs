// kernel 知识子命令测试：直接调 runKnowledgeCommand（不起进程）+ parseArgs 契约。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runKnowledgeCommand } from '../kernel/knowledge-cli.mjs'
import { parseArgs } from '../kernel/cli.mjs'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kcli-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  writeFileSync(join(personal, 'workflow.md'), [
    '---', 'name: workflow', '---',
    '- [会话|企微CLI化] 只发文件传输助手 -- 涉及真实沟通渠道的测试一律只发文件传输助手',
  ].join('\n') + '\n', 'utf-8')
  return { dir, personal }
}

test('op=stats 返回索引统计', async () => {
  const { dir } = fixture()
  try {
    const { output, code } = await runKnowledgeCommand({ op: 'stats', configDir: dir })
    assert.equal(code, 0)
    assert.equal(output.docs, 1)
    assert.ok(output.blocks >= 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('op=spaces 返回空间清单（含 docCount）', async () => {
  const { dir } = fixture()
  try {
    const { output } = await runKnowledgeCommand({ op: 'spaces', configDir: dir })
    assert.equal(output.spaces[0].id, 'experience')
    assert.equal(output.spaces[0].docCount, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('op=search 返回块级结果', async () => {
  const { dir } = fixture()
  try {
    const { output } = await runKnowledgeCommand({
      op: 'search', configDir: dir, args: { query: '文件传输助手', topK: 5 },
    })
    assert.ok(output.count > 0)
    assert.equal(output.items[0].spaceId, 'experience')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('op=entries 返回条目级清单', async () => {
  const { dir } = fixture()
  try {
    const { output } = await runKnowledgeCommand({
      op: 'entries', configDir: dir, args: { id: 'experience/workflow.md' },
    })
    assert.equal(output.entries.length, 1)
    assert.equal(output.entries[0].tag, '企微CLI化')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('op=update-doc 触发增量更新', async () => {
  const { dir, personal } = fixture()
  try {
    writeFileSync(join(personal, 'workflow.md'), '- [会话|新] 增量条目 -- 内容\n', 'utf-8')
    const { output } = await runKnowledgeCommand({
      op: 'update-doc', configDir: dir, args: { id: 'experience/workflow.md' },
    })
    assert.equal(output.updated, true)
    const { output: s } = await runKnowledgeCommand({
      op: 'search', configDir: dir, args: { query: '增量条目' },
    })
    assert.ok(s.count > 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('op=search 支持单数 --space 空间过滤（Task 11 路由按单数转发）', async () => {
  const { dir } = fixture()
  try {
    const q = { op: 'search', configDir: dir, args: { query: '文件传输助手', space: 'experience' } }
    assert.ok((await runKnowledgeCommand(q)).output.count > 0, '单数 --space 应生效')
    const miss = { op: 'search', configDir: dir, args: { query: '文件传输助手', space: 'nope' } }
    assert.equal((await runKnowledgeCommand(miss)).output.count, 0, '限定不存在的空间应 0 命中')
    const multi = { op: 'search', configDir: dir, args: { query: '文件传输助手', spaces: ['experience'] } }
    assert.ok((await runKnowledgeCommand(multi)).output.count > 0, '复数 spaces 仍生效')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('未知 op 返回 code=1 与 error 文案（不抛异常给调用方）', async () => {
  const { dir } = fixture()
  try {
    const { output, code } = await runKnowledgeCommand({ op: 'nope', configDir: dir })
    assert.equal(code, 1)
    assert.match(String(output.error), /unknown knowledge op/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('parseArgs 认识 --knowledge 与子参数（topK 转数字）', () => {
  const a = parseArgs(['--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--knowledge', 'search', '--query', 'x', '--keywords', 'a,b', '--topK', '3', '--mode', 'full'])
  assert.equal(a.knowledge, 'search')
  assert.equal(a.query, 'x')
  assert.deepEqual(a.keywords, ['a', 'b'])
  assert.equal(a.topK, 3)
  assert.equal(a.mode, 'full')
})

test('parseArgs 缺省时 knowledge 为 null（不影响既有路径）', () => {
  const a = parseArgs(['--print'])
  assert.equal(a.knowledge, null)
})

test('op=search 的逗号串空间过滤（路由转发形式，需真正生效）', async () => {
  const { dir } = fixture()
  try {
    // 单数逗号串：explore 两个空间
    const one = await runKnowledgeCommand({ op: 'search', configDir: dir, args: { query: '文件传输助手', space: 'experience' } })
    assert.ok(one.output.count > 0, '单空间命中')
    // 逗号串含 experience → 仍应命中
    const two = await runKnowledgeCommand({ op: 'search', configDir: dir, args: { query: '文件传输助手', space: 'experience,session-memory' } })
    assert.ok(two.output.count > 0, '逗号串含有效空间应命中（原实现会因匹配不到 id 而全空）')
    // 逗号串全为无效空间 → 0 命中（证明过滤生效而非被忽略）
    const bad = await runKnowledgeCommand({ op: 'search', configDir: dir, args: { query: '文件传输助手', space: 'x,y' } })
    assert.equal(bad.output.count, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// S3 §6 观测：stats op 必须带上注入指标 sidecar（缺失时为 null，不得报错）。
// 为什么要在 CLI 这一层锁：`--knowledge stats` 是新进程，进程内累加器恒为初值，
// 只有读 sidecar 这条路能让 HTTP/CLI 看到指标 —— 这条链断了，指标就等于不存在。
test('S3：op=stats 输出含 metrics（无 sidecar 时为 null）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kcli-s3-'))
  try {
    const { output, code } = await runKnowledgeCommand({ op: 'stats', configDir: dir })
    assert.equal(code, 0)
    assert.ok('metrics' in output, 'stats 必须带 metrics 字段（可为 null）')
    assert.equal(output.metrics, null)
    assert.deepEqual(output.search, { count: 0, elapsedP50: null, elapsedP95: null })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
