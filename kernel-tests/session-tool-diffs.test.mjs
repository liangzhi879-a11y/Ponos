// kernel-tests/session-tool-diffs.test.mjs —— 增删行数的落盘形状与模型输入纯净（2026-10-08）
// ---------------------------------------------------------------------------
// 数据链：tools.mjs 的 meta → engine.mjs toolResults 条目 → session.appendToolResults。
// 落盘约定（本文件钉住）：
//   ① 增删行数只出现在条目**顶层** `diffs: [{tool_use_id, additions, deletions}]`——
//      回放侧 UI 数据源（src/lib/transcriptAdapter.ts 预扫描）；
//   ② `entry.message.content` 的 tool_result 块**恰好 4 键**（type/tool_use_id/content/is_error），
//      增删行数绝不混入——那里是模型输入；
//   ③ 无任何数据的批次**不加键** ⇒ 旧场景条目形状逐字不变；
//   ④ redactEntry（落盘单点）必须原样放行顶层 diffs（若未来改成白名单重建，这里先红）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore, newSessionId } from '../kernel/session.mjs'
import { redactEntry } from '../kernel/redact.mjs'

function newHome() {
  const home = mkdtempSync(join(tmpdir(), 'yfw-diffs-'))
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

const linesOf = (s) => readFileSync(s.file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

test('appendToolResults：有数据 ⇒ 顶层 diffs 落盘，message.content 恰好 4 键', () => {
  const { home, cleanup } = newHome()
  try {
    const s = createSessionStore({ configDir: home, cwd: 'C:\\proj\\demo', sessionId: newSessionId() })
    s.appendAssistant([{ type: 'tool_use', id: 'tu1', name: 'Write', input: {} }], { model: 'm1' })
    s.appendToolResults([
      { tool_use_id: 'tu1', content: '已写入 x（3 字符）', is_error: false, additions: 3, deletions: 0 },
      { tool_use_id: 'tu2', content: '已编辑 y（1 处替换）', is_error: false },
    ])

    const entry = linesOf(s).find((e) => e.type === 'user' && Array.isArray(e.diffs))
    assert.ok(entry, '应有一条带顶层 diffs 的 user 条目')
    // ① 顶层 diffs：只收有数据的（tu2 无 additions/deletions ⇒ 不进数组）
    assert.deepEqual(entry.diffs, [{ tool_use_id: 'tu1', additions: 3, deletions: 0 }])
    // ② message.content 纯净：恰好 4 键，增删行数不在其中
    assert.equal(entry.message.content.length, 2)
    for (const blk of entry.message.content) {
      assert.deepEqual(Object.keys(blk).sort(), ['content', 'is_error', 'tool_use_id', 'type'])
    }
    assert.equal('additions' in entry.message.content[0], false)
  } finally { cleanup() }
})

test('appendToolResults：无任何数据 ⇒ 不加 diffs 键（旧场景条目形状逐字不变）', () => {
  const { home, cleanup } = newHome()
  try {
    const s = createSessionStore({ configDir: home, cwd: 'C:\\proj\\demo', sessionId: newSessionId() })
    s.appendToolResults([{ tool_use_id: 'tu1', content: 'ok', is_error: false }])
    const entry = linesOf(s).find((e) => e.type === 'user')
    assert.equal('diffs' in entry, false)
  } finally { cleanup() }
})

test('appendToolResults：单侧数据另一侧补 0（回放端拿到的 always 是完整二元组）', () => {
  const { home, cleanup } = newHome()
  try {
    const s = createSessionStore({ configDir: home, cwd: 'C:\\proj\\demo', sessionId: newSessionId() })
    s.appendToolResults([
      { tool_use_id: 'a', content: 'x', additions: 5 },
      { tool_use_id: 'b', content: 'y', deletions: 2 },
    ])
    const entry = linesOf(s).find((e) => Array.isArray(e.diffs))
    assert.deepEqual(entry.diffs, [
      { tool_use_id: 'a', additions: 5, deletions: 0 },
      { tool_use_id: 'b', additions: 0, deletions: 2 },
    ])
  } finally { cleanup() }
})

test('模型输入纯净：deriveMessages 里没有 diffs/additions/deletions', () => {
  const { home, cleanup } = newHome()
  try {
    const s = createSessionStore({ configDir: home, cwd: 'C:\\proj\\demo', sessionId: newSessionId() })
    s.appendAssistant([{ type: 'tool_use', id: 'tu1', name: 'Write', input: {} }], { model: 'm1' })
    s.appendToolResults([{ tool_use_id: 'tu1', content: '已写入 x', is_error: false, additions: 4, deletions: 1 }])

    const flat = JSON.stringify(s.deriveMessages())
    assert.equal(flat.includes('"diffs"'), false, 'diffs 不得投影进模型输入')
    assert.equal(flat.includes('additions'), false)
    assert.equal(flat.includes('deletions'), false)
  } finally { cleanup() }
})

test('redactEntry（落盘单点）原样放行顶层 diffs', () => {
  const entry = {
    type: 'user',
    id: 'e1',
    timestamp: '2026-10-08T00:00:00.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok', is_error: false }] },
    diffs: [{ tool_use_id: 'tu1', additions: 1, deletions: 1 }],
  }
  const out = redactEntry(entry)
  assert.deepEqual(out.diffs, [{ tool_use_id: 'tu1', additions: 1, deletions: 1 }])
})
