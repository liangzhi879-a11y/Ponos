// ContentBlock → assistant-ui 消息转换 + 流式追加语义（2026-09-09 会话 UI 标准化）
// node:test + node:assert（Node 24 原生 TS 类型剥离），运行：
//   node --test src/lib/chatParts.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  messageToThreadMessageLike, messagesToThreadMessageLikes, appendStreamingBlock,
  createConversionCache, incrementalConvert,
} from './chatParts.ts'
import type { Message } from '../types/index.ts'

test('文本/思考块 → text/reasoning parts', () => {
  const m: Message = {
    id: 'm1',
    role: 'assistant',
    timestamp: 0,
    content: [
      { id: 'b1', type: 'thinking', content: '让我想想' },
      { id: 'b2', type: 'text', content: '答案是 2。' },
    ],
  }
  const out = messageToThreadMessageLike(m)
  assert.equal(out.role, 'assistant')
  const parts = out.content as unknown as Array<{ type: string; text?: string }>
  assert.equal(parts[0].type, 'reasoning')
  assert.equal(parts[0].text, '让我想想')
  assert.equal(parts[1].type, 'text')
})

test('tool_use → tool-call part（含 args 解析与 argsText）', () => {
  const m: Message = {
    id: 'm2',
    role: 'assistant',
    timestamp: 0,
    content: [
      { id: 't1', type: 'tool_use', content: '{"command":"echo hi"}', metadata: { toolName: 'Bash', toolUseId: 'tu-1' } },
    ],
  }
  const parts = messageToThreadMessageLike(m).content as unknown as Array<{ type: string; toolName?: string; args?: Record<string, unknown>; argsText?: string }>
  assert.equal(parts[0].type, 'tool-call')
  assert.equal(parts[0].toolName, 'Bash')
  assert.deepEqual(parts[0].args, { command: 'echo hi' })
  assert.equal(parts[0].argsText, '{"command":"echo hi"}')
})

test('tool_use 自带 result（历史回放）→ part.result 挂接', () => {
  const m: Message = {
    id: 'm3',
    role: 'assistant',
    timestamp: 0,
    content: [
      { id: 't1', type: 'tool_use', content: '{}', metadata: { toolName: 'Bash', toolUseId: 'tu-1' }, result: { content: 'hi', isError: false } },
    ],
  }
  const parts = messageToThreadMessageLike(m).content as unknown as Array<{ result?: string; isError?: boolean }>
  assert.ok(parts[0].result, 'result 应挂接')
  assert.equal(parts[0].result, 'hi')
  assert.equal(parts[0].isError, false)
})

test('独立 tool_result 块合并进前一个 tool_use 的 result', () => {
  const m: Message = {
    id: 'm4',
    role: 'assistant',
    timestamp: 0,
    content: [
      { id: 't1', type: 'tool_use', content: '{}', metadata: { toolName: 'Read', toolUseId: 'tu-1' } },
      { id: 'r1', type: 'tool_result', content: 'file content', metadata: { toolUseId: 'tu-1', isError: false } },
    ],
  }
  const parts = messageToThreadMessageLike(m).content as unknown as Array<{ type: string; result?: string }>
  assert.equal(parts.length, 1, 'tool_result 应合并而非独立成 part')
  assert.equal(parts[0].result, 'file content')
})

test('孤立 tool_result（无前置 tool_use）降级为文本块', () => {
  const m: Message = {
    id: 'm5',
    role: 'assistant',
    timestamp: 0,
    content: [{ id: 'r1', type: 'tool_result', content: '孤儿结果', metadata: { toolUseId: 'tu-x' } }],
  }
  const parts = messageToThreadMessageLike(m).content as unknown as Array<{ type: string; text?: string }>
  assert.equal(parts[0].type, 'text')
  assert.equal(parts[0].text, '孤儿结果')
})

test('messagesToThreadMessageLikes：保留消息 id（流式 mutate 稳定键）', () => {
  const out = messagesToThreadMessageLikes([
    { id: 'a', role: 'user', timestamp: 0, content: [{ id: 'b', type: 'text', content: 'hi' }] },
  ])
  assert.equal(out[0].id, 'a')
})

test('appendStreamingBlock：无同类型块时新建；有则追加', () => {
  const first = appendStreamingBlock([], 'text', '你')
  assert.equal(first[0].content, '你')
  const second = appendStreamingBlock(first, 'text', '好')
  assert.equal(second.length, 1, '同类型块应追加而非新建')
  assert.equal(second[0].content, '你好')
  const third = appendStreamingBlock(second, 'thinking', '想')
  assert.equal(third.length, 2)
  assert.equal(third[1].content, '想')
})

test('appendStreamingBlock：跨块边界封块新建（thinking 后再回 text）', () => {
  const content = [
    { id: 'x', type: 'text' as const, content: '正文A' },
    { id: 'y', type: 'thinking' as const, content: '想' },
  ]
  const out = appendStreamingBlock(content, 'text', '正文B')
  assert.equal(out.length, 3, '最后一块是 thinking → text 新建块，不回填旧块')
  assert.equal(out[0].content, '正文A')
  assert.equal(out[1].content, '想')
  assert.equal(out[2].content, '正文B')
})

test('appendStreamingBlock：工具卡片后回到 text → 新建块保持交错顺序', () => {
  const content = [
    { id: 'x', type: 'text' as const, content: '第一步分析' },
    { id: 't', type: 'tool_use' as const, content: '{}', metadata: { toolName: 'Read', toolUseId: 'tu-1' } },
  ]
  const out = appendStreamingBlock(content, 'text', '第二步分析')
  assert.equal(out.length, 3, 'tool_use 之后 → text 新建块')
  assert.equal(out[0].content, '第一步分析')
  assert.equal(out[1].type, 'tool_use')
  assert.equal(out[2].content, '第二步分析')
  // 同类型连续 delta 仍合并
  const merged = appendStreamingBlock(out, 'text', '继续')
  assert.equal(merged.length, 3)
  assert.equal(merged[2].content, '第二步分析继续')
})

// —— R3：按对象身份增量转换 ——
// 断言的是 convert 的**调用次数**，不是返回值：这条优化的全部价值就在"少调用"。
test('incrementalConvert：只对身份变化的项重跑 convert（模拟流式追加最后一条）', () => {
  const cache = createConversionCache<Message, string>()
  const calls: string[] = []
  const convert = (m: Message) => { calls.push(m.id); return `C:${m.id}` }

  const m1: Message = { id: 'm1', role: 'user', timestamp: 0, content: [] }
  const m2: Message = { id: 'm2', role: 'assistant', timestamp: 0, content: [] }
  const m2b: Message = { ...m2, content: [{ id: 'b', type: 'text' as const, content: '流式片段' }] }

  const first = incrementalConvert([m1, m2], () => 'complete', convert, cache)
  assert.deepEqual(calls, ['m1', 'm2'], '首帧每条都转一次')
  assert.deepEqual(first, ['C:m1', 'C:m2'])

  calls.length = 0
  const second = incrementalConvert([m1, m2b], () => 'complete', convert, cache)
  assert.deepEqual(calls, ['m2'], '只有被替换的那一条重转，m1 命中缓存')
  assert.equal(second[0], first[0], '未变消息复用**同一个**结果对象（下游 memo 才能命中）')
  assert.deepEqual(second[1], 'C:m2')
})

test('incrementalConvert：statusKey 变化必须重算（否则流式最后一条永远停在 running）', () => {
  const cache = createConversionCache<Message, { status: string }>()
  const m1: Message = { id: 'm1', role: 'user', timestamp: 0, content: [] }
  const m2: Message = { id: 'm2', role: 'assistant', timestamp: 0, content: [] }
  // statusOf 与 convert 同源（真实调用点也这么写）：两处都由"是否仍在流式"派生
  let streaming = true
  let calls = 0
  const statusOf = (_m: Message, i: number) => ((streaming && i === 1) ? 'running' : 'complete')
  const convert = (_m: Message, i: number) => { calls++; return { status: statusOf(_m, i) } }

  incrementalConvert([m1, m2], statusOf, convert, cache)
  assert.equal(calls, 2)
  calls = 0
  incrementalConvert([m1, m2], statusOf, convert, cache)
  assert.equal(calls, 0, '同 key 全命中')
  // 流式结束：最后一条翻成 complete ⇒ 只有它重算
  streaming = false
  calls = 0
  const out = incrementalConvert([m1, m2], statusOf, convert, cache)
  assert.equal(calls, 1, 'key 变化的那一条必须重算')
  assert.equal(out[1].status, 'complete', '翻状态必须真的落进结果里')
  assert.equal(out[0].status, 'complete')
})

test('incrementalConvert：空数组与单元素边界', () => {
  const cache = createConversionCache<Message, number>()
  assert.deepEqual(incrementalConvert<Message, number>([], () => 'x', () => 1, cache), [])
  const m: Message = { id: 'm', role: 'user', timestamp: 0, content: [] }
  assert.deepEqual(incrementalConvert([m], () => 'x', () => 7, cache), [7])
  assert.deepEqual(incrementalConvert([m], () => 'x', () => 7, cache), [7], '命中复用')
})
