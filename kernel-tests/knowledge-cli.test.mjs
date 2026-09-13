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
