// kernel-tests/tool-result-wire.test.mjs —— tool_result 帧的增删行数出口（2026-10-08）
// ---------------------------------------------------------------------------
// 钉两层：
//   ① 帧形状：wire.toolResult 无数据 ⇒ 逐字同旧形状（不多键）；有数据 ⇒ 只加有限数键
//      （NaN/undefined 不算数据）；
//   ② 端到端接线（mock API 走**真实工具执行**）：Write 真写文件 ⇒ 帧带 additions/deletions
//      且与落盘同源；Read 结果帧零噪音；同批 tool_result 的 transcript user 条目顶层
//      diffs 落盘、message 层纯净。
// 为什么必须有端到端这层：帧构造器测试证明不了 engine → registry(meta) → wire 的中段接线。
process.env.PONOS_MOCK_API = '1'
const { createEngine } = await import('../kernel/engine.mjs')
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeWire } from '../kernel/protocol.mjs'
import { createSessionStore, newSessionId } from '../kernel/session.mjs'

const BASE_KEYS = ['content', 'is_error', 'tool_use_id', 'type']

test('wire.toolResult：无数据 ⇒ 旧形状；有数据 ⇒ 只加有限数键', () => {
  const frames = []
  const wire = makeWire({ write(s) { frames.push(JSON.parse(s)) } })
  wire.toolResult({ toolUseId: 't1', content: 'ok' })
  wire.toolResult({ toolUseId: 't2', content: 'ok', additions: 2, deletions: 0 })
  wire.toolResult({ toolUseId: 't3', content: 'ok', additions: 5 })
  wire.toolResult({ toolUseId: 't4', content: 'ok', additions: NaN, deletions: undefined })

  assert.deepEqual(Object.keys(frames[0]).sort(), [...BASE_KEYS].sort(), '无数据帧不得多键')
  assert.equal(frames[1].additions, 2)
  assert.equal(frames[1].deletions, 0, '0 是有效数据（覆盖写只删不增的合法一侧）')
  assert.equal(frames[2].additions, 5)
  assert.equal('deletions' in frames[2], false, '缺的一侧不得补键')
  assert.deepEqual(Object.keys(frames[3]).sort(), [...BASE_KEYS].sort(), 'NaN/undefined 不是数据')
})

test('端到端（mock）：Write 真执行 ⇒ 帧带 {+1,−0}，transcript 顶层 diffs 落盘且 message 纯净', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-wire-'))
  process.env.PONOS_MOCK_WRITE_DIR = dir
  const home = join(dir, 'home')
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const session = createSessionStore({ configDir: home, cwd: dir, sessionId: newSessionId() })
  try {
    const engine = createEngine({ opts: { model: 'm', configDir: home, addDirs: [dir], skipPermissions: true, systemPrompt: '' }, wire, session })
    await engine.runTurn({ content: '[mock:write]' })

    const frames = events.filter((e) => e.type === 'tool_result')
    assert.equal(frames.length, 2, `[mock:write] 应产生两次写入的帧，实际 ${frames.length}`)
    // 数字与落盘同源：文件真的写出来了
    assert.equal(readFileSync(join(dir, 'mock-a.txt'), 'utf-8'), 'a')

    for (const f of frames) {
      assert.equal(f.additions, 1, `新文件 1 行：${JSON.stringify(f)}`)
      assert.equal(f.deletions, 0)
      assert.deepEqual(Object.keys(f).sort(), ['additions', 'content', 'deletions', 'is_error', 'tool_use_id', 'type'])
      assert.match(String(f.content), /^已写入 /)
    }

    // 同一批 tool_result 的 user 条目：顶层 diffs 两条、message 层零污染
    const lines = readFileSync(session.file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const diffsEntry = lines.find((e) => Array.isArray(e.diffs))
    assert.ok(diffsEntry, '应有顶层 diffs 的 user 条目')
    assert.deepEqual(diffsEntry.diffs.map((d) => [d.additions, d.deletions]), [[1, 0], [1, 0]])
    assert.equal(JSON.stringify(diffsEntry.message).includes('additions'), false, 'message 层（模型输入）不得含增删行数')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('端到端（mock）：Read 结果帧零噪音（非写侧工具不得出现增删键）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-wire-read-'))
  const home = join(dir, 'home')
  writeFileSync(join(dir, 'plain.txt'), 'hello\n', 'utf-8')
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const session = createSessionStore({ configDir: home, cwd: dir, sessionId: newSessionId() })
  try {
    const engine = createEngine({ opts: { model: 'm', configDir: home, addDirs: [dir], skipPermissions: true, systemPrompt: '' }, wire, session })
    await engine.runTurn({ content: `[mock:read] ${join(dir, 'plain.txt')}` })

    const frames = events.filter((e) => e.type === 'tool_result')
    assert.equal(frames.length, 1)
    assert.deepEqual(Object.keys(frames[0]).sort(), [...BASE_KEYS].sort())
    // transcript 里也不得凭空出现 diffs 键
    const lines = readFileSync(session.file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    assert.equal(lines.some((e) => 'diffs' in e), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
