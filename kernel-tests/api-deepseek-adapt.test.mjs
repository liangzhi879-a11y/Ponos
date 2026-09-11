// DeepSeek 兼容端点流式适配（2026-09-11）
// ---------------------------------------------------------------------------
// 背景：本内核只走 Anthropic 兼容协议（DeepSeek 经其 /anthropic 端点接入）。原解析器
// 对"兼容端点不守 Anthropic 严格串行语义"的三种形态存在确定性缺陷：
//   A. 并发/交错工具块：单一 `tool` 槽 → 后块覆盖前块 + 两块 partial_json 串进同一
//      inputJson（JSON.parse 失败 → 空参 {} 执行）。
//   B. 兼容端点把完整参数内联在 content_block.input（不发 input_json_delta）→ 旧实现
//      从不读 input → 空参执行。
//   C. 流内 `event: error`（overloaded_error 等）被静默吞掉 → 用户侧表现为"回答突然
//      截断/空回复且无报错"，且不进入重试链路。
//   D. `ping` 心跳被计入有效事件 → "只发 ping 后 EOF"的空流无法快速判定。
//   E. 截断 stop_reason 官方语义是 'max_tokens'（旧判据只认 mock 的 'length'）→ 真端点
//      截断时残缺工具被当正常调用执行。
// 本文件锁定 A-E 的修复；同时保证旧式"无 index 的严格串行流"行为不变（向后兼容）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAnthropicParser, protocolStream, classifyApiError } from '../kernel/api.mjs'

const feedAll = (p, events) => {
  const out = []
  for (const e of events) out.push(...p.feed(e))
  out.push(...p.finish())
  return out
}

test('A. 并发/交错工具块（带 index）：两块分槽累积，互不串参数、无丢失', () => {
  const p = createAnthropicParser()
  const out = feedAll(p, [
    // 交错形态：两个 tool_use 先 start，delta 交替下发（旧实现会互相覆盖+串参数）
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Bash' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't2', name: 'Read' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"ls -la"}' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"/tmp/a.txt"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_stop', index: 1 },
  ])
  const tools = out.filter((c) => c.type === 'tool_use')
  assert.equal(tools.length, 2, '两个工具块都必须产出（旧实现会丢一个）')
  const t1 = tools.find((t) => t.id === 't1')
  const t2 = tools.find((t) => t.id === 't2')
  assert.deepEqual(t1.input, { command: 'ls -la' })
  assert.deepEqual(t2.input, { path: '/tmp/a.txt' })
})

test('A2. 文本块 stop 不再误触发未收尾工具（旧实现把 pending tool 提前吐出的缺陷）', () => {
  const p = createAnthropicParser()
  const out = feedAll(p, [
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Bash' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } },
    // index 1 是文本块：它的 stop 不应产出 index 0 的工具（旧实现只看 tool!=null）
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_stop', index: 0 },
  ])
  const tools = out.filter((c) => c.type === 'tool_use')
  assert.equal(tools.length, 1)
  assert.deepEqual(tools[0].input, { command: 'ls' })
})

test('B. 内联 content_block.input（不发 input_json_delta）：参数不得丢空', () => {
  const p = createAnthropicParser()
  const out = feedAll(p, [
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo hi' } } },
    { type: 'content_block_stop', index: 0 },
  ])
  const tool = out.find((c) => c.type === 'tool_use')
  assert.deepEqual(tool.input, { command: 'echo hi' })
})

test('B2. 内联 input 与 delta 并存时，增量 delta 优先（不双写）', () => {
  const p = createAnthropicParser()
  const out = feedAll(p, [
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' } },
    { type: 'content_block_stop', index: 0 },
  ])
  const tool = out.find((c) => c.type === 'tool_use')
  assert.deepEqual(tool.input, { command: 'pwd' })
})

test('兼容性：无 index 的旧式严格串行流（多工具顺序下发）行为不变', () => {
  const p = createAnthropicParser()
  const out = feedAll(p, [
    { type: 'content_block_start', content_block: { type: 'tool_use', id: 'a', name: 'Bash' } },
    { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"command":"x"}' } },
    { type: 'content_block_stop' },
    { type: 'content_block_start', content_block: { type: 'tool_use', id: 'b', name: 'Read' } },
    { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"path":"y"}' } },
    { type: 'content_block_stop' },
  ])
  const tools = out.filter((c) => c.type === 'tool_use')
  assert.equal(tools.length, 2)
  assert.deepEqual(tools[0].input, { command: 'x' })
  assert.deepEqual(tools[1].input, { path: 'y' })
})

test("E. stop_reason 'max_tokens'（Anthropic/DeepSeek 官方语义）原样透传，不被丢弃", () => {
  const p = createAnthropicParser()
  p.feed({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Bash' } })
  p.feed({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } })
  p.feed({ type: 'content_block_stop', index: 0 })
  p.feed({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { input_tokens: 1, output_tokens: 1 } })
  assert.equal(p.stopReason(), 'max_tokens', 'engine 截断守卫据此拒执残缺工具')
  // 旧 mock 语义保持可用
  const p2 = createAnthropicParser()
  p2.feed({ type: 'message_delta', delta: { stop_reason: 'length' } })
  assert.equal(p2.stopReason(), 'length')
})

test('C. 流内 event: error（overloaded_error）→ 抛 ApiStreamError，status 529 可重试', async () => {
  const sse = [
    `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } })}`,
    '',
    `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '半截回答' } })}`,
    '',
    'event: error',
    `data: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}`,
    '',
    'data: [DONE]',
    '',
  ].join('\n')
  const prev = global.fetch
  global.fetch = async () => ({
    ok: true,
    body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close() } }),
  })
  try {
    await assert.rejects(
      (async () => {
        for await (const _c of protocolStream({ url: 'http://t/v1/messages', body: {}, headers: {} })) { /* drain */ }
      })(),
      (err) => {
        assert.equal(err.name, 'ApiStreamError')
        assert.equal(err.status, 529)
        assert.match(err.message, /overloaded_error/)
        // 既有分类链路必须把它判为可重试（engine retryStream 据此重发而非终局失败）
        assert.equal(classifyApiError(err).retryable, true)
        return true
      },
    )
  } finally {
    global.fetch = prev
  }
})

test('C2. 流内 error（invalid_request_error）→ status 400 终局不可重试（不空耗重试）', async () => {
  const sse = [
    'event: error',
    `data: ${JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad payload' } })}`,
    '',
    'data: [DONE]',
    '',
  ].join('\n')
  const prev = global.fetch
  global.fetch = async () => ({
    ok: true,
    body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close() } }),
  })
  try {
    await assert.rejects(
      (async () => {
        for await (const _c of protocolStream({ url: 'http://t/v1/messages', body: {}, headers: {} })) { /* drain */ }
      })(),
      (err) => {
        assert.equal(err.name, 'ApiStreamError')
        assert.equal(err.status, 400)
        assert.equal(classifyApiError(err).retryable, false)
        return true
      },
    )
  } finally {
    global.fetch = prev
  }
})

test('D. 仅 ping 后 EOF 的空流 → 计入 0 有效事件（不再掩盖空流判定）', async () => {
  const sse = [
    'event: ping',
    `data: ${JSON.stringify({ type: 'ping' })}`,
    '',
    'data: [DONE]',
    '',
  ].join('\n')
  const prev = global.fetch
  global.fetch = async () => ({
    ok: true,
    body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close() } }),
  })
  try {
    await assert.rejects(
      (async () => {
        for await (const _c of protocolStream({ url: 'http://t/v1/messages', body: {}, headers: {} })) { /* drain */ }
      })(),
      (err) => {
        assert.equal(err.name, 'DeadStreamError', 'ping 不算有效产出，应快速判空流')
        return true
      },
    )
  } finally {
    global.fetch = prev
  }
})
