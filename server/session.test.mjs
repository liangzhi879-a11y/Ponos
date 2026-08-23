// session.mjs 阶段2a 事件日志 + surface 投影测试（Task 4：权威测试，意图优先）
// ---------------------------------------------------------------------------
// 覆盖：append 落盘 + surface.nodes 单调、旧 transcript seq 补齐、compaction
// start/summary 替换语义、孤儿 start 回滚、deriveMessages 缓存、maxEntries
// 窗口化恢复。回归：server/kernel-engine.test.mjs（15/15）保持全绿。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore } from '../kernel/session.mjs'

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'session-surface-'))
  const store = createSessionStore({ configDir: dir, cwd: 'proj', sessionId: '00000000-0000-0000-0000-000000000001' })
  return { dir, store }
}

test('appendUser/appendAssistant 落盘且 surface.nodes 单调', async () => {
  const { dir, store } = freshStore()
  try {
    store.appendUser('你好')
    store.appendAssistant([{ type: 'text', text: '回复' }])
    const { surface, compactCount } = await store.load()
    assert.equal(surface.nodes.length, 2)
    assert.equal(surface.replaceGeneration, 0)
    assert.equal(compactCount, 0)
    assert.deepEqual(store.deriveMessages().map((m) => m.role), ['user', 'assistant'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('旧格式 foreign：无 role 行跳过 + tool_use/tool_result 链剥离（G.content + API 400 双根因回归）', async () => {
  const { dir, store } = freshStore()
  try {
    writeFileSync(store.file, [
      // 无 message.role 的元行（旧 claude-code 格式 queue-operation）→ 跳过，不得产出 undefined（G.content 根因）
      JSON.stringify({ type: 'queue-operation', id: 'q', timestamp: 't', message: {} }),
      JSON.stringify({ type: 'user', id: 'u1', timestamp: 't', message: { role: 'user', content: '查资料' } }),
      // assistant 混合消息：tool_use 剥离、text 保留
      JSON.stringify({ type: 'assistant', id: 'a1', timestamp: 't', message: { role: 'assistant', content: [{ type: 'text', text: '好的' }, { type: 'tool_use', id: 'tu1', name: 'grep', input: {} }] } }),
      // 纯 tool_result user 消息 → 整条丢弃（结果不紧跟 tool_use，API 400 根因）
      JSON.stringify({ type: 'user', id: 'u2', timestamp: 't', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x' }] } }),
      JSON.stringify({ type: 'assistant', id: 'a2', timestamp: 't', message: { role: 'assistant', content: [{ type: 'text', text: '结果' }] } }),
      '',
    ].join('\n'))
    const r = await store.load()
    assert.equal(r.foreign, true)
    const msgs = store.deriveMessages()
    assert.ok(msgs.every((m) => m && typeof m.role === 'string'), '不得含 undefined 条目')
    assert.equal(msgs.length, 3)
    assert.equal(msgs[0].content, '查资料')
    assert.deepEqual(msgs[1].content, [{ type: 'text', text: '好的' }])
    assert.deepEqual(msgs[2].content, [{ type: 'text', text: '结果' }])
    const allBlocks = msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    assert.ok(!allBlocks.some((b) => b.type === 'tool_use' || b.type === 'tool_result'), 'tool 块全部剥离')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('旧 transcript 无 seq → 加载按顺序补齐', async () => {
  const { dir, store } = freshStore()
  try {
    writeFileSync(store.file, [
      JSON.stringify({ type: 'user', id: 'a', timestamp: 't', message: { role: 'user', content: 'q' } }),
      JSON.stringify({ type: 'assistant', id: 'b', timestamp: 't', message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] } }),
      '',
    ].join('\n'))
    const { entries } = await store.load()
    assert.equal(entries[0].seq, 1)
    assert.equal(entries[1].seq, 2)
    assert.deepEqual(store.deriveMessages().map((m) => m.role), ['user', 'assistant'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('compaction：start 不进 nodes，summary 替换区间并推进 replaceGeneration', async () => {
  const { dir, store } = freshStore()
  try {
    store.appendUser('u1'); store.appendAssistant([{ type: 'text', text: 'a1' }])
    store.appendUser('u2'); store.appendAssistant([{ type: 'text', text: 'a2' }])
    store.appendUser('u3'); store.appendAssistant([{ type: 'text', text: 'a3' }])
    const before = store.deriveMessages().length
    assert.equal(before, 6)
    const coveredSeqs = [1, 2, 3, 4] // 遮蔽前两轮
    store.appendCompactionStart(coveredSeqs)
    store.appendCompactionSummary({ summary: '<compacted-summary>…</compacted-summary>', coveredSeqs })
    const { surface, compactCount } = await store.load()
    assert.equal(compactCount, 1)
    assert.equal(surface.replaceGeneration, 1)
    assert.ok(surface.nodes.length < 6)
    const msgs = store.deriveMessages()
    assert.equal(msgs[0].content, '<compacted-summary>…</compacted-summary>')
    assert.deepEqual(msgs.map((m) => m.role), ['assistant', 'user', 'assistant'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('孤儿 compaction/start（无配对 summary）→ 加载回滚忽略', async () => {
  const { dir, store } = freshStore()
  try {
    store.appendUser('u1'); store.appendAssistant([{ type: 'text', text: 'a1' }])
    store.appendUser('u2'); store.appendAssistant([{ type: 'text', text: 'a2' }])
    store.appendCompactionStart([1, 2]) // 模拟崩溃：start 已写、summary 未落地
    const { surface, compactCount } = await store.load()
    assert.equal(compactCount, 0)
    assert.equal(surface.replaceGeneration, 0)
    assert.equal(store.deriveMessages().length, 4) // 完整两轮保留
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('deriveMessages 缓存：append 增量失效重建，同 surface 不重复派生', async () => {
  const { dir, store } = freshStore()
  try {
    store.appendUser('q1')
    const m1 = store.deriveMessages()
    const m2 = store.deriveMessages()
    assert.equal(m1, m2) // 缓存命中：同一对象引用
    store.appendAssistant([{ type: 'text', text: 'a1' }])
    const m3 = store.deriveMessages()
    assert.notEqual(m1, m3) // 变更后重建
    assert.equal(m3.length, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('窗口化恢复：maxEntries 超限截断到近窗口（保留尾部 + compaction 条目）', async () => {
  const { dir } = freshStore()
  try {
    const store = createSessionStore({ configDir: dir, cwd: 'proj', sessionId: '00000000-0000-0000-0000-000000000002', maxEntries: 4 })
    for (let i = 1; i <= 6; i++) { store.appendUser(`q${i}`); store.appendAssistant([{ type: 'text', text: `a${i}` }]) }
    const { surface } = await store.load()
    assert.ok(surface.nodes.length <= 4)
    assert.deepEqual(store.deriveMessages()[0].content, 'q5') // 近窗口：保留尾部 4 条 = U5..A6
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('S2-1 磁盘脱敏：transcript 文件含打码内容，内存 deriveMessages 保留原文', () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-redact-'))
  const prev = process.env.YFW_KEEP_SECRETS
  process.env.YFW_KEEP_SECRETS = ''
  try {
    const store = createSessionStore({ configDir: dir, cwd: '', sessionId: 'r' })
    store.appendUser('my key is sk-abc12345XYZ')
    const raw = readFileSync(store.file, 'utf-8')
    assert.match(raw, /sk-\*\*\*/)
    assert.ok(!raw.includes('sk-abc12345XYZ'), '磁盘不得含原文密钥')
    assert.equal(store.deriveMessages()[0].content, 'my key is sk-abc12345XYZ', '模型输入保留原文')
  } finally {
    process.env.YFW_KEEP_SECRETS = prev || ''
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P4-5 appendMeta：落盘 + 不进模型输入 + load 恢复不污染', async () => {
  const { dir, store } = freshStore()
  try {
    store.appendUser('hi')
    store.appendMeta('provider_switched', { provider: { baseUrl: 'http://x', model: 'm' }, version: 1 })
    store.appendAssistant([{ type: 'text', text: 'ok' }])
    // deriveMessages 不得含 meta 条目（其 message 为占位，进模型输入会污染）
    const msgs = store.deriveMessages()
    assert.equal(msgs.length, 2)
    assert.ok(msgs.every((m) => m.role !== undefined))  // meta 条目无 message.role，不应出现
    // 磁盘确实落了 4 行（meta 首行 + user + meta + assistant）
    const raw = readFileSync(store.file, 'utf-8').trim().split('\n')
    assert.equal(raw.length, 4)
    // load 恢复：meta 行存在但同样不进投影
    const store2 = createSessionStore({ configDir: dir, cwd: 'proj', sessionId: '00000000-0000-0000-0000-000000000001' })
    await store2.load()
    assert.equal(store2.deriveMessages().length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
