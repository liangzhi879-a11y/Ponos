// transcriptAdapter / transcriptLoader 单元测试（node:test + node:assert，与 server/*.test.mjs 同风格）。
// 运行：node --test src/lib/transcriptAdapter.test.ts（Node 24 原生 TS 类型剥离）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  transcriptEntryToMessage,
  entriesToMessages,
  cropBlock,
  cropMessages,
  CROP_LIMITS,
  CROP_SUFFIX,
} from './transcriptAdapter.ts'
import { fetchTranscript, loadConversationMessages } from './transcriptLoader.ts'
import type { Message } from '../types/index.ts'

// ── 测试用的内核 entry 模板（形态与实测 transcript 一致） ──────────────────────────

/** 内核 user entry：message.content 为 string（最常见形态） */
function userEntry(over: Record<string, unknown> = {}) {
  return {
    parentUuid: null,
    type: 'user',
    message: { role: 'user', content: '请删除测试文件' },
    uuid: 'u-1',
    timestamp: '2026-08-14T06:56:18.227Z',
    sessionId: 'sess-1',
    cwd: 'C:\\Users\\T203-15\\AppData\\Local\\Temp',
    ...over,
  }
}

/** 内核 assistant entry：content 为块数组 */
function assistantEntry(blocks: any[], over: Record<string, unknown> = {}) {
  return {
    parentUuid: 'u-1',
    type: 'assistant',
    message: {
      id: 'm-1',
      type: 'message',
      role: 'assistant',
      model: 'deepseek-v4-flash',
      content: blocks,
      usage: { input_tokens: 100, output_tokens: 50 },
    },
    uuid: 'a-1',
    timestamp: '2026-08-14T06:56:23.391Z',
    sessionId: 'sess-1',
    ...over,
  }
}

// ── user string content ─────────────────────────────────────────────

test('user entry：string content → 单个 text 块', () => {
  const m = transcriptEntryToMessage(userEntry())
  assert.ok(m)
  assert.equal(m!.role, 'user')
  assert.equal(m!.content.length, 1)
  assert.equal(m!.content[0].type, 'text')
  assert.equal(m!.content[0].content, '请删除测试文件')
  // 内核 timestamp 是 ISO 字符串，需转成 epoch ms
  assert.equal(m!.timestamp, Date.parse('2026-08-14T06:56:18.227Z'))
  assert.equal(m!.id, 'u-1')
})

// ── assistant 各块类型 ──────────────────────────────────────────────

test('assistant entry：text / tool_use / thinking 块转换', () => {
  const m = transcriptEntryToMessage(
    assistantEntry([
      { type: 'thinking', thinking: '先思考再动手' },
      { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'rm -v f.txt' } },
      { type: 'text', text: '完成。', citations: [{ uri: 'x' }] },
    ])
  )
  assert.ok(m)
  assert.equal(m!.role, 'assistant')
  assert.equal(m!.model, 'deepseek-v4-flash')
  assert.equal(m!.tokensUsed, 150) // input 100 + output 50
  assert.equal(m!.content.length, 3)
  const [th, tu, tx] = m!.content
  assert.equal(th.type, 'thinking')
  assert.equal(th.content, '先思考再动手')
  assert.equal(tu.type, 'tool_use')
  assert.equal(tu.metadata?.toolName, 'Bash')
  assert.deepEqual(JSON.parse(tu.content), { command: 'rm -v f.txt' }) // input JSON 化
  assert.equal(tx.type, 'text')
  assert.equal(tx.content, '完成。')
})

test('assistant entry：无 usage 字段（中间工具轮条目，M1 后仅最终条目带 usage）→ tokensUsed 不设', () => {
  const m = transcriptEntryToMessage(
    assistantEntry([{ type: 'text', text: '中间轮' }], {
      message: { role: 'assistant', model: 'deepseek-v4-flash', content: [{ type: 'text', text: '中间轮' }] },
    })
  )
  assert.ok(m)
  assert.equal(m!.tokensUsed, undefined) // 不带 usage → per-message tokensUsed 留空
  assert.equal(m!.model, 'deepseek-v4-flash') // model 仍保留（中间条目仅带 model）
})

test('assistant entry：tool_result 块（content 为数组时 join）', () => {
  const m = transcriptEntryToMessage(
    assistantEntry([
      { type: 'tool_result', tool_use_id: 'call_1', content: ['第一行', { text: '第二行' }], is_error: false },
    ])
  )
  assert.ok(m)
  const [tr] = m!.content
  assert.equal(tr.type, 'tool_result')
  assert.equal(tr.content, '第一行\n第二行')
  assert.equal(tr.metadata?.toolUseId, 'call_1')
  assert.equal(tr.metadata?.isError, false)
})

// ── user content 数组（claude-code 把 tool_result 作为 user 消息块回传） ─────────

test('user entry：纯 tool_result 回显 → 跳过；结果挂到对应 assistant tool_use', () => {
  const echoEntry = userEntry({
    uuid: 'u-2',
    parentUuid: 'a-1',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', content: 'User denied the high-risk operation', is_error: true, tool_use_id: 'call_1' },
      ],
    },
  })
  // 单条转换：回显不是用户发言，不生成"用户消息"
  assert.equal(transcriptEntryToMessage(echoEntry), null)
  // 批量转换：echo 结果按 tool_use_id 挂到 assistant tool_use 块（信息不丢）
  const { messages, skipped } = entriesToMessages([
    assistantEntry([{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'rm -v f.txt' } }]),
    echoEntry,
  ])
  assert.equal(skipped, 1)
  assert.equal(messages.length, 1)
  const [asst] = messages
  assert.equal(asst.role, 'assistant')
  const [tu] = asst.content
  assert.equal(tu.type, 'tool_use')
  assert.equal(tu.metadata?.toolUseId, 'call_1')
  assert.deepEqual(tu.result, { content: 'User denied the high-risk operation', isError: true })
})

test('user entry：混合数组（text + tool_result）只留 text 块', () => {
  const m = transcriptEntryToMessage(
    userEntry({
      uuid: 'u-3',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', content: 'out', tool_use_id: 'call_1' },
          { type: 'text', text: '真实提问' },
        ],
      },
    })
  )
  assert.ok(m)
  assert.equal(m!.content.length, 1)
  assert.equal(m!.content[0].type, 'text')
  assert.equal(m!.content[0].content, '真实提问')
})

test('tool_result 回显超长 → 挂接时按展示级上限裁剪', () => {
  const big = 'x'.repeat(20000)
  const { messages } = entriesToMessages([
    assistantEntry([{ type: 'tool_use', id: 'call_2', name: 'Bash', input: {} }]),
    userEntry({
      uuid: 'u-4',
      message: { role: 'user', content: [{ type: 'tool_result', content: big, tool_use_id: 'call_2' }] },
    }),
  ])
  const [asst] = messages
  const [tu] = asst.content
  assert.equal(tu.result?.content.length, CROP_LIMITS.tool_result + CROP_SUFFIX.length)
  assert.equal(tu.result?.content.slice(-CROP_SUFFIX.length), CROP_SUFFIX)
})

// ── harness 注入型系统管道消息（task-notification / system-reminder） ────────────

test('user entry：harness 注入 <task-notification> → 跳过', () => {
  const e = userEntry({
    message: {
      role: 'user',
      content:
        '<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>call_00_x</tool-use-id>\n' +
        '<output-file>C:\\tmp\\t.output</output-file>\n<status>completed</status>\n' +
        '<summary>Background command done</summary>\n</task-notification>',
    },
  })
  assert.equal(transcriptEntryToMessage(e), null)
  // 前导空白不干扰识别
  assert.equal(transcriptEntryToMessage(userEntry({ message: { role: 'user', content: '  <task-notification>…' } })), null)
})

test('user entry：harness 注入 <system-reminder> → 跳过', () => {
  const e = userEntry({
    message: { role: 'user', content: '<system-reminder>\nSome instruction\n</system-reminder>' },
  })
  assert.equal(transcriptEntryToMessage(e), null)
})

test('user entry：普通文本不受影响', () => {
  const m = transcriptEntryToMessage(userEntry())
  assert.ok(m)
  assert.equal(m!.content[0].content, '请删除测试文件')
  // 以 < 开头的普通用户消息（如贴代码）不误伤：仅精确匹配 task-notification/system-reminder 信封
  const code = transcriptEntryToMessage(userEntry({ message: { role: 'user', content: '<div>hello</div>' } }))
  assert.ok(code)
})

// ── system / queue-operation / 其它类型跳过 ──────────────────────────

test('kind=compaction 条目折叠为 null（GUI 不渲染压缩条目）', () => {
  const entry = {
    type: 'assistant', id: 'c1', timestamp: 't',
    kind: 'compaction', phase: 'summary',
    message: { role: 'assistant', content: [{ type: 'text', text: '<compacted-summary>x</compacted-summary>' }] },
  }
  assert.equal(transcriptEntryToMessage(entry), null)
})

test('system compact_boundary → 特殊 system 消息', () => {
  const m = transcriptEntryToMessage({
    parentUuid: null,
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    uuid: 'sys-1',
    timestamp: '2026-08-10T02:10:37.073Z',
  })
  assert.ok(m)
  assert.equal(m!.role, 'system')
  assert.equal(m!.content.length, 1)
  assert.equal(m!.content[0].content, 'Conversation compacted')
  assert.equal(m!.content[0].metadata?.compactBoundary, true)
})

test('其它 system（api_config_changed 等）→ 跳过', () => {
  assert.equal(
    transcriptEntryToMessage({ type: 'system', subtype: 'api_config_changed', timestamp: '2026-08-10T02:00:00.000Z' }),
    null
  )
})

test('queue-operation → 跳过', () => {
  assert.equal(
    transcriptEntryToMessage({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-08-14T06:56:18.165Z' }),
    null
  )
})

test('attachment / mode / last-prompt 等未知类型 → 跳过', () => {
  assert.equal(transcriptEntryToMessage({ type: 'attachment', attachment: {} }), null)
  assert.equal(transcriptEntryToMessage({ type: 'mode', mode: 'normal' }), null)
  assert.equal(transcriptEntryToMessage({ type: 'last-prompt' }), null)
  assert.equal(transcriptEntryToMessage(null), null)
})

test('assistant 未知块类型（image 等）→ 该块跳过，其余保留', () => {
  const m = transcriptEntryToMessage(
    assistantEntry([{ type: 'image', source: {} }, { type: 'text', text: '存活' }])
  )
  assert.ok(m)
  assert.equal(m!.content.length, 1)
  assert.equal(m!.content[0].type, 'text')
})

// ── 裁剪逻辑 ─────────────────────────────────────────────────────────

test('CROP_LIMITS 值符合架构要求', () => {
  assert.deepEqual(CROP_LIMITS, { text: 8192, tool_result: 16384, thinking: 4096, tool_use: 8192 })
})

test('cropBlock：超限截断 + originalLength；幂等不重复裁', () => {
  const big = 'x'.repeat(9000)
  const cropped = cropBlock({ id: 'b1', type: 'text', content: big })
  assert.equal(cropped.content, 'x'.repeat(8192) + CROP_SUFFIX)
  assert.equal(cropped.metadata?.originalLength, 9000)
  // 幂等：已带 originalLength 的块不再裁
  const again = cropBlock(cropped)
  assert.equal(again.content, cropped.content)
  assert.equal(again.metadata?.originalLength, 9000)
  // 未超限的块不动
  const small = cropBlock({ id: 'b2', type: 'text', content: 'hi' })
  assert.equal(small.content, 'hi')
  assert.equal(small.metadata, undefined)
})

test('裁剪按块类型用不同上限（tool_use / thinking / tool_result）', () => {
  const tu = cropBlock({ id: 'b', type: 'tool_use', content: 'y'.repeat(9000) })
  assert.equal(tu.metadata?.originalLength, 9000)
  assert.equal(tu.content.length, CROP_LIMITS.tool_use + CROP_SUFFIX.length)
  const th = cropBlock({ id: 'b', type: 'thinking', content: 'z'.repeat(5000) })
  assert.equal(th.content.length, CROP_LIMITS.thinking + CROP_SUFFIX.length)
  const tr = cropBlock({ id: 'b', type: 'tool_result', content: 'w'.repeat(20000) })
  assert.equal(tr.content.length, CROP_LIMITS.tool_result + CROP_SUFFIX.length)
  // image/file 无上限定义：原样
  const img = cropBlock({ id: 'b', type: 'image', content: 'x'.repeat(99999) })
  assert.equal(img.content.length, 99999)
})

test('entriesToMessages 时超长 text 也被裁剪', () => {
  const { messages } = entriesToMessages([
    userEntry({ uuid: 'u-big', message: { role: 'user', content: 'x'.repeat(20000) } }),
  ])
  assert.equal(messages[0].content[0].content.length, CROP_LIMITS.text + CROP_SUFFIX.length)
  assert.equal(messages[0].content[0].metadata?.originalLength, 20000)
})

// ── parentUuid 链 ────────────────────────────────────────────────────

test('parentUuid 在结果集内 → 设 parentId；孤儿不设', () => {
  const { messages } = entriesToMessages([
    // 乱序传入：queue-op 跳过、子先于父出现，验证排序与链恢复
    assistantEntry([{ type: 'text', text: '回答' }], { uuid: 'a-2', parentUuid: 'u-1', timestamp: '2026-08-14T06:57:00.000Z' }),
    { type: 'queue-operation', operation: 'enqueue' },
    userEntry(),
    // 孤儿：父被截断（不在结果里）→ 不设 parentId
    assistantEntry([{ type: 'text', text: '孤儿' }], { uuid: 'a-orphan', parentUuid: 'u-99', timestamp: '2026-08-14T06:58:00.000Z' }),
  ])
  assert.equal(messages.length, 3)
  assert.equal(messages[0].id, 'u-1') // 时间升序
  const a2 = messages.find((m) => m.id === 'a-2')!
  assert.equal(a2.parentId, 'u-1') // 父在结果集 → 链上
  const orphan = messages.find((m) => m.id === 'a-orphan')!
  assert.equal(orphan.parentId, undefined) // 父被截断 → 孤儿不设
  // skipped 计数包含 queue-operation
  const { skipped } = entriesToMessages([
    { type: 'queue-operation', operation: 'dequeue' },
    userEntry(),
  ])
  assert.equal(skipped, 1)
})

// ── sanitizeText：控制字符剥离 ───────────────────────────────────────

test('内容经 sanitizeText：剥离控制字符、保留换行', () => {
  const m = transcriptEntryToMessage(userEntry({ message: { role: 'user', content: 'a\u0000b\nc\u001fd' } }))
  assert.equal(m!.content[0].content, 'ab\ncd')
})

// ── transcriptLoader：fetchTranscript ────────────────────────────────

test('fetchTranscript：成功路径（stub fetch 返回原始 entries）', async () => {
  const entries = [
    userEntry(),
    assistantEntry([{ type: 'text', text: 'ok' }]),
    { type: 'queue-operation', operation: 'dequeue' },
  ]
  const origFetch = globalThis.fetch
  let calledUrl = ''
  globalThis.fetch = (async (url: any) => {
    calledUrl = String(url)
    return new Response(JSON.stringify({ ok: true, entries, truncated: true, skipped: 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as any
  try {
    const r = await fetchTranscript('sess-1', 'C:\\proj', { baseUrl: 'http://localhost:51311', tailFirst: true })
    assert.equal(r.ok, true)
    assert.equal(r.truncated, true)
    assert.equal(r.messages.length, 2)
    assert.equal(r.skipped, 1) // queue-operation 被转换层跳过
    // URL 参数正确编码（cwd 含反斜杠/冒号）
    assert.ok(calledUrl.startsWith('http://localhost:51311/transcript/load'))
    assert.ok(calledUrl.includes('sessionId=sess-1'))
    assert.ok(calledUrl.includes('tailFirst=1'))
    assert.ok(calledUrl.includes('cwd=' + encodeURIComponent('C:\\proj')))
  } finally {
    globalThis.fetch = origFetch
  }
})

test('fetchTranscript：失败路径（文件不存在）', async () => {
  const origFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: false, error: 'not found' }), { status: 200 })) as any
  try {
    const r = await fetchTranscript('nope', 'C:\\proj', { baseUrl: 'http://x' })
    assert.equal(r.ok, false)
    assert.equal(r.error, 'not found')
    assert.deepEqual(r.messages, [])
  } finally {
    globalThis.fetch = origFetch
  }
})

test('fetchTranscript：bridge 不可达 → ok:false 不抛异常', async () => {
  const origFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED')
  }) as any
  try {
    const r = await fetchTranscript('s1', 'cwd', { baseUrl: 'http://localhost:1' })
    assert.equal(r.ok, false)
    assert.ok(r.error)
  } finally {
    globalThis.fetch = origFetch
  }
})

// ── transcriptLoader：loadConversationMessages 聚合 ──────────────────

/** 构造按 sessionId 返回不同 entries 的 stub bridge */
function stubBridge(canned: Record<string, any[]>) {
  const origFetch = globalThis.fetch
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    const sid = new URL(u).searchParams.get('sessionId') || ''
    const entries = canned[sid]
    return new Response(
      JSON.stringify(entries === undefined ? { ok: false, error: 'not found' } : { ok: true, entries, truncated: false, skipped: 0 }),
      { status: 200 }
    )
  }) as any
  return () => { globalThis.fetch = origFetch }
}

test('loadConversationMessages：多 session 按时间合并排序 + 按 id 去重', async () => {
  const restore = stubBridge({
    's1': [
      userEntry({ uuid: 'u-1', timestamp: '2026-08-14T06:56:18.227Z' }),
      assistantEntry([{ type: 'text', text: '早' }], { uuid: 'a-1', timestamp: '2026-08-14T06:56:23.391Z' }),
    ],
    's2': [
      userEntry({ uuid: 'u-2', timestamp: '2026-08-14T06:55:00.000Z' }),
      // 与 s1 重复的消息（同 id）→ 去重
      userEntry({ uuid: 'u-1', timestamp: '2026-08-14T06:56:18.227Z' }),
      assistantEntry([{ type: 'text', text: '晚' }], { uuid: 'a-2', timestamp: '2026-08-14T06:57:00.000Z' }),
    ],
  })
  try {
    const msgs = await loadConversationMessages(
      { sessionIds: ['s1', 's2'], cwd: 'C:\\proj' },
      { baseUrl: 'http://localhost:51311' }
    )
    assert.equal(msgs.length, 4) // u-1 重复被去重
    const order = msgs.map((m) => m.id)
    assert.deepEqual(order, ['u-2', 'u-1', 'a-1', 'a-2']) // 时间升序
  } finally {
    restore()
  }
})

test('loadConversationMessages：sessionIds 为空 → 回退 extMessages', async () => {
  const ext: Message[] = [
    { id: 'e1', role: 'user', content: [{ id: 'e1-b0', type: 'text', content: '本地历史' }], timestamp: 1 },
  ]
  const msgs = await loadConversationMessages({ sessionIds: [], extMessages: ext })
  assert.equal(msgs, ext) // 直接返回迁移兜底
})

test('loadConversationMessages：全部失败 → 回退 extMessages；无兜底 → []', async () => {
  const restore = stubBridge({}) // 任何 sessionId 都 not found
  try {
    const msgs = await loadConversationMessages(
      { sessionIds: ['s1', 's2'], cwd: 'C:\\proj' },
      { baseUrl: 'http://localhost:51311' }
    )
    assert.deepEqual(msgs, [])
    const ext: Message[] = [
      { id: 'e1', role: 'user', content: [{ id: 'e1-b0', type: 'text', content: '兜底' }], timestamp: 1 },
    ]
    const withExt = await loadConversationMessages(
      { sessionIds: ['s1', 's2'], cwd: 'C:\\proj', extMessages: ext },
      { baseUrl: 'http://localhost:51311' }
    )
    assert.equal(withExt, ext)
  } finally {
    restore()
  }
})

test('loadConversationMessages：并发限制 2（最大同时 in-flight ≤2）', async () => {
  let inFlight = 0
  let maxInFlight = 0
  const origFetch = globalThis.fetch
  globalThis.fetch = (async (url: any) => {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((r) => setTimeout(r, 10))
    inFlight -= 1
    const sid = new URL(String(url)).searchParams.get('sessionId') || ''
    return new Response(
      JSON.stringify({
        ok: true,
        entries: [userEntry({ uuid: `u-${sid}`, timestamp: `2026-08-14T06:5${sid}:00.000Z` })],
        truncated: false,
        skipped: 0,
      }),
      { status: 200 }
    )
  }) as any
  try {
    const msgs = await loadConversationMessages(
      { sessionIds: ['1', '2', '3', '4', '5'], cwd: 'C:\\proj' },
      { baseUrl: 'http://localhost:51311' }
    )
    assert.equal(msgs.length, 5)
    assert.ok(maxInFlight <= 2, `并发超限: ${maxInFlight}`)
  } finally {
    globalThis.fetch = origFetch
  }
})

// ── cropMessages 兜底 ────────────────────────────────────────────────

test('cropMessages：批量裁剪且保持幂等', () => {
  const msgs: Message[] = [
    { id: 'm1', role: 'user', content: [{ id: 'm1-b0', type: 'text', content: 'x'.repeat(10000) }], timestamp: 1 },
  ]
  const once = cropMessages(msgs)
  assert.equal(once[0].content[0].metadata?.originalLength, 10000)
  const twice = cropMessages(once)
  assert.equal(twice[0].content[0].content, once[0].content[0].content) // 不二次截断
})
