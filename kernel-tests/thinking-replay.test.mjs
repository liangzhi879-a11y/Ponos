// 思考回放（2026-10-22）：DeepSeek /anthropic 在思考模式下要求把上一轮 assistant 的
// `content[].thinking` 原样回传，缺块直接 400：
//   {"error":{"message":"The content[].thinking in the thinking mode must be passed back to the API."}}
// 本套件钉住四层，缺一层就可能在真机上"单元测试全绿但请求仍 400"：
//   ① 解析器：thinking 块整块产出（原始未分段文本 + signature），实时帧不受影响；
//   ② 线上裁剪：真 Anthropic 系（校验签名）丢弃无签名块，DeepSeek 等兼容端点补空签名；
//   ③ 会话投影：thinking 只并入**带 tool_use 的 assistant 轮**（不单独成帧、不改条目）；
//   ④ 引擎端到端：真实 SSE → 落盘 thinking（带签名）→ 工具结果后的第二次请求真的带上了它。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAnthropicParser, prepareMessagesForAnthropicWire } from '../kernel/api.mjs'
import { createSessionStore, newSessionId } from '../kernel/session.mjs'
import { resetProviderForTest } from '../kernel/provider.mjs'
import { trimOversizedRequestCopy } from '../kernel/request-face.mjs'

delete process.env.PONOS_MOCK_API // ④ 走真实 HTTP（本机 server），不用内置 mock 流
process.env.PONOS_STREAM_RECONNECTS = '0'
const { createEngine } = await import('../kernel/engine.mjs')
const { makeWire } = await import('../kernel/protocol.mjs')

const sseOf = (events) => events.map((e) => `data: ${JSON.stringify(e)}`).join('\n\n') + '\n\ndata: [DONE]\n\n'

// ── ① 解析器：完整块（回放数据源）────────────────────────────────────────────

test('解析器：thinking 块在 stop 时整块产出（原始文本 + signature），分段实时帧照旧', () => {
  const p = createAnthropicParser()
  const out = []
  out.push(...p.feed({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }))
  out.push(...p.feed({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先想' } }))
  out.push(...p.feed({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '一下' } }))
  out.push(...p.feed({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } }))
  out.push(...p.feed({ type: 'content_block_stop', index: 0 }))
  out.push(...p.finish())

  const blocks = out.filter((c) => c.type === 'thinking_block')
  assert.equal(blocks.length, 1, '每个思考块恰好产出一条完整块（驱动落盘/回放）')
  assert.equal(blocks[0].thinking, '先想一下', '回放文本必须是**未经分段**的原始 delta 拼接')
  assert.equal(blocks[0].signature, 'sig-abc', 'signature_delta 必须落到块上（真 Anthropic 校验）')
  const live = out.filter((c) => c.type === 'thinking').map((c) => c.text).join('')
  assert.equal(live, '先想一下', '实时帧不能因为新增回放面而丢字')
})

test('解析器：流在 content_block_stop 前断开 ⇒ finish() 仍保住完整块（不掉签名）', () => {
  const p = createAnthropicParser()
  p.feed({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
  p.feed({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '断流前的思考' } })
  p.feed({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-x' } })
  const tail = p.finish().filter((c) => c.type === 'thinking_block')
  assert.equal(tail.length, 1)
  assert.equal(tail[0].thinking, '断流前的思考')
  assert.equal(tail[0].signature, 'sig-x')
})

// ── ② 线上裁剪：按端点能力决定发不发 ─────────────────────────────────────────

const assistantWithThinking = (signature) => ([{
  role: 'assistant',
  content: [
    signature === undefined ? { type: 'thinking', thinking: '历史思考' } : { type: 'thinking', thinking: '历史思考', signature },
    { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'echo hi' } },
  ],
}])

test('线上裁剪：DeepSeek 等非签名端点 ⇒ 无签名块补 `signature: ""` 后原样回传', () => {
  const msgs = assistantWithThinking(undefined)
  const out = prepareMessagesForAnthropicWire(msgs, { base: 'https://api.deepseek.com/anthropic' })
  assert.equal(out[0].content[0].type, 'thinking', '必须回传（DeepSeek 缺块即 400）')
  assert.equal(out[0].content[0].thinking, '历史思考')
  assert.equal(out[0].content[0].signature, '', '签名字段必须存在且为空串（DeepSeek 实证接受）')
  assert.equal(out[0].content[1].type, 'tool_use')
  // 纯函数：绝不改入参（请求面缓存的消息对象跨调用共享）
  assert.equal('signature' in msgs[0].content[0], false, '不得原地给入参块加签名')
})

test('线上裁剪：真 Anthropic 系 ⇒ 无签名的旧历史块丢弃（发出去必 400），有签名则保留', () => {
  const unsigned = prepareMessagesForAnthropicWire(assistantWithThinking(undefined), { base: 'https://api.anthropic.com' })
  assert.deepEqual(unsigned[0].content.map((b) => b.type), ['tool_use'], '无签名块必须丢弃（维持旧行为）')
  const signed = prepareMessagesForAnthropicWire(assistantWithThinking('sig-ok'), { base: 'https://api.anthropic.com' })
  assert.deepEqual(signed[0].content.map((b) => b.type), ['thinking', 'tool_use'])
  assert.equal(signed[0].content[0].signature, 'sig-ok')
})

test('线上裁剪：本步显式关闭思考 ⇒ 一律不回放（思考关了还递思考块属协议冲突）', () => {
  const out = prepareMessagesForAnthropicWire(assistantWithThinking('sig-ok'), {
    base: 'https://api.deepseek.com/anthropic', thinkingDisabled: true,
  })
  assert.deepEqual(out[0].content.map((b) => b.type), ['tool_use'])
})

test('线上裁剪：超长思考块被截断时必须丢掉旧签名（签名已与文本不匹配）', () => {
  const big = '思'.repeat(150_000)
  const msgs = [{
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: big, signature: 'sig-big' },
      { type: 'tool_use', id: 'tu_big', name: 'Bash', input: { command: 'echo hi' } },
    ],
  }]
  const copy = trimOversizedRequestCopy(msgs)
  assert.ok(copy, '超过 100k 的块必须触发终局裁剪')
  assert.ok(copy[0].content[0].thinking.length < big.length, '块确实被截短')
  assert.equal('signature' in copy[0].content[0], false, '签名已失效 ⇒ 必须删除（否则签名端点 400）')
  assert.equal(msgs[0].content[0].signature, 'sig-big', '裁剪只作用于请求副本，不得改原消息')
})

test('线上裁剪：只含思考块的 assistant 被丢光 ⇒ 整条消息不发（空 content 非法）', () => {
  const out = prepareMessagesForAnthropicWire([{ role: 'assistant', content: [{ type: 'thinking', thinking: '只有思考' }] }], {
    base: 'https://api.anthropic.com',
  })
  assert.equal(out.length, 0)
})

test('线上裁剪：压缩摘要必须投影为 user —— 否则「压缩后无真实 user」的请求必 400', () => {
  // 真机失败形态（2026-10-22 15:30:41 / 15:34:45 / 15:54:20）：压缩摘要遮蔽掉全部真实
  // user 文本，请求只剩「assistant 摘要 + 带 thinking 的工具轮 + tool_result」。DeepSeek
  // 从**最后一条真实 user 消息**之后校验 thinking，而 tool_result 映射成 role:'tool'、不算
  // user ⇒ 摘要这个无 thinking 的 assistant 被点名「thinking must be passed back」。
  // 对照：同一会话里带真实 user 文本的 4 次请求全 200（7/7 相关）。
  const derived = [
    { role: 'assistant', content: '旧对话摘要' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '继续做事', signature: 'sig-t' },
        { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'true' } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] },
  ]
  const out = prepareMessagesForAnthropicWire(derived, { base: 'https://api.deepseek.com/anthropic' })
  assert.equal(out[0].role, 'user', '摘要上线必须转为 user（给校验器一个真实 user 锚点）')
  assert.equal(out[0].content, '旧对话摘要', '只换 role，摘要正文不得改写')
  assert.equal(out[1].content[0].type, 'thinking', '其后的工具轮 thinking 仍须原样回放')
  assert.equal(out[1].content[0].signature, 'sig-t')
  assert.equal(out[2].content[0].type, 'tool_result')
  // 派生层契约不变：compact.mjs 的 isSealedSummary / 遮蔽区间判据依赖 assistant+字符串
  assert.equal(derived[0].role, 'assistant')
})

// ── ③ 会话投影：只并进带 tool_use 的 assistant 轮 ──────────────────────────────

function newHome() {
  const home = mkdtempSync(join(tmpdir(), 'yfw-think-replay-'))
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

test('会话投影：thinking 不单独成帧，而是并到紧随其后的 tool_use assistant 头部', () => {
  const { home, cleanup } = newHome()
  try {
    const s = createSessionStore({ configDir: home, cwd: 'C:\\proj\\demo', sessionId: newSessionId() })
    s.appendUser('读一下')
    s.appendThinking('原始思考', { model: 'm1', blocks: [{ type: 'thinking', thinking: '原始思考', signature: 'sig-1' }] })
    const entry = s.appendAssistant([{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'a' } }], { model: 'm1' })

    const derived = s.deriveMessages()
    assert.equal(derived.length, 2, 'thinking 不单独成帧（派生消息数不变）')
    assert.deepEqual(derived[1].content.map((b) => b.type), ['thinking', 'tool_use'])
    assert.equal(derived[1].content[0].thinking, '原始思考')
    assert.equal(derived[1].content[0].signature, 'sig-1')
    // 原始条目不得被投影改写：transcript 回放/usage 后挂以它为准
    assert.deepEqual(entry.message.content.map((b) => b.type), ['tool_use'])
  } finally { cleanup() }
})

test('会话投影：纯文本 assistant 轮不并入 thinking（白涨 prompt）', () => {
  const { home, cleanup } = newHome()
  try {
    const s = createSessionStore({ configDir: home, cwd: 'C:\\proj\\demo', sessionId: newSessionId() })
    s.appendUser('你好')
    s.appendThinking('想一下')
    s.appendAssistant([{ type: 'text', text: '答案' }], { model: 'm1' })
    const derived = s.deriveMessages()
    assert.equal(derived.length, 2)
    assert.deepEqual(derived[1].content.map((b) => b.type), ['text'], '纯文本轮不回放思考')
  } finally { cleanup() }
})

test('会话投影：resume 后仍能并回（磁盘 thinking 行 → rebuildSurface 的 seq 索引）', async () => {
  const { home, cleanup } = newHome()
  try {
    const sid = newSessionId()
    const s1 = createSessionStore({ configDir: home, cwd: 'C:\\proj\\demo', sessionId: sid })
    s1.appendUser('读一下')
    s1.appendThinking('盘上的思考', { blocks: [{ type: 'thinking', thinking: '盘上的思考', signature: 'sig-r' }] })
    s1.appendAssistant([{ type: 'tool_use', id: 'tu_r', name: 'Read', input: { file_path: 'a' } }])

    const s2 = createSessionStore({ configDir: home, cwd: 'C:\\proj\\demo', sessionId: sid })
    await s2.load()
    const derived = s2.deriveMessages()
    assert.deepEqual(derived[1].content.map((b) => b.type), ['thinking', 'tool_use'])
    assert.equal(derived[1].content[0].thinking, '盘上的思考')
    assert.equal(derived[1].content[0].signature, 'sig-r')
    // 落盘行必须带签名（resume 时签名来源）
    const disk = readFileSync(s2.file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const t = disk.find((e) => e.type === 'thinking')
    assert.equal(t.message.content[0].signature, 'sig-r')
  } finally { cleanup() }
})

test('会话投影：两轮工具调用各带各的思考（不串轮）', () => {
  const { home, cleanup } = newHome()
  try {
    const s = createSessionStore({ configDir: home, cwd: 'C:\\proj\\demo', sessionId: newSessionId() })
    s.appendUser('第一轮')
    s.appendThinking('思考一', { blocks: [{ type: 'thinking', thinking: '思考一', signature: 's1' }] })
    s.appendAssistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'true' } }])
    s.appendToolResult({ toolUseId: 't1', content: 'ok' })
    s.appendThinking('思考二', { blocks: [{ type: 'thinking', thinking: '思考二', signature: 's2' }] })
    s.appendAssistant([{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'true' } }])

    const d = s.deriveMessages()
    const first = d.find((m) => m.role === 'assistant' && m.content.some((b) => b.id === 't1'))
    const second = d.find((m) => m.role === 'assistant' && m.content.some((b) => b.id === 't2'))
    assert.equal(first.content[0].thinking, '思考一')
    assert.equal(second.content[0].thinking, '思考二')
    assert.equal(first.content[0].signature, 's1')
    assert.equal(second.content[0].signature, 's2')
  } finally { cleanup() }
})

test('会话投影：压缩摘要切在工具批次起点（摘要 seq 大于保留尾）⇒ 紧随其后的 thinking 仍并回', async () => {
  const { home, cleanup } = newHome()
  try {
    const sid = newSessionId()
    const s = createSessionStore({ configDir: home, cwd: 'C:\\proj\\demo', sessionId: sid })
    // 旧轮：整段被摘要遮蔽；其 thinking 不在 sourceEventSeqs 里（thinking 不投影）
    const u1 = s.appendUser('旧轮')
    s.appendThinking('旧思考', { blocks: [{ type: 'thinking', thinking: '旧思考', signature: 's-old' }] })
    const a1 = s.appendAssistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'true' } }])
    const tr1 = s.appendToolResult({ toolUseId: 't1', content: 'ok' })
    // 新轮：user 起点被遮蔽、工具批次 assistant 保留 —— 计数预算下的合法切点
    // （kernel/compact.mjs#findCutPoint 的 isToolBatchStart 分支，真机 2026-10-22 即此形态）
    const u2 = s.appendUser('新轮')
    s.appendThinking('新思考', { blocks: [{ type: 'thinking', thinking: '新思考', signature: 's-new' }] })
    s.appendAssistant([{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'true' } }])
    s.appendToolResult({ toolUseId: 't2', content: 'ok' })
    // 摘要条目在**最后**追加 ⇒ 它的 seq 比它遮蔽的整段都大；若拿它当投影边界，
    // 紧随其后的保留轮会落在「下界 > 上界」的空区间里。这是 400 的直接根因。
    const summary = s.appendCompactionSummary({ summary: '旧轮摘要', coveredSeqs: [u1.seq, a1.seq, tr1.seq, u2.seq] })
    assert.ok(summary.seq > u2.seq, '前提：摘要 seq 必须大于被遮蔽区的最大 seq')

    const assertProjection = (d, label) => {
      assert.equal(d.length, 3, `${label}：派生消息 = 摘要 + 保留的工具轮 + 其结果`)
      assert.equal(d[0].content, '旧轮摘要')
      const kept = d.find((m) => Array.isArray(m.content) && m.content.some((b) => b.id === 't2'))
      assert.ok(kept, `${label}：保留的工具轮必须存在`)
      assert.equal(kept.content[0].type, 'thinking', `${label}：摘要不得吃掉下一条保留轮的 thinking（缺块 ⇒ DeepSeek 400）`)
      assert.equal(kept.content[0].thinking, '新思考')
      assert.equal(kept.content[0].signature, 's-new')
      assert.equal(kept.content[1].type, 'tool_use')
      const leaked = d.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'thinking' && b.thinking === '旧思考'))
      assert.equal(leaked, false, `${label}：被遮蔽区间的思考不得回放`)
    }
    assertProjection(s.deriveMessages(), '活会话')

    // resume：盘上按 seq 重建 surface 必须得到同一投影（否则重启后照旧 400）
    const s2 = createSessionStore({ configDir: home, cwd: 'C:\\proj\\demo', sessionId: sid })
    await s2.load()
    assertProjection(s2.deriveMessages(), 'resume')
  } finally { cleanup() }
})

// ── ④ 引擎端到端：真实 SSE → 落盘 → 工具结果后的请求真的带上思考 ───────────────

async function withServer(respond, fn) {
  const requests = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      let body = null
      try { body = JSON.parse(raw || '{}') } catch { body = raw }
      requests.push({ url: req.url, body })
      const out = respond({ url: req.url, body, index: requests.length - 1 })
      res.writeHead(out.status ?? 200, { 'content-type': 'text/event-stream' })
      res.end(out.body ?? '')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const prevEnv = { ...process.env }
  Object.assign(process.env, {
    PONOS_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    PONOS_AUTH_TOKEN: 'test-token',
    PONOS_MODEL: 'test-model',
  })
  try {
    return await fn({ requests })
  } finally {
    process.env = prevEnv
    resetProviderForTest()
    await new Promise((r) => server.close(r))
  }
}

const TOOL_REPLY = sseOf([
  { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先确认文件存在，再读。' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-e2e' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_e2e', name: 'Bash', input: { command: 'echo hi' } } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 10, output_tokens: 20 } },
])
const TEXT_REPLY = sseOf([
  { type: 'message_start', message: { usage: { input_tokens: 20, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '完成' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 20, output_tokens: 5 } },
])

test('引擎端到端：工具结果后的请求带上上一条 assistant 的 thinking（缺它正是 400 的根因）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-think-e2e-'))
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  try {
    await withServer(({ index }) => ({ body: index === 0 ? TOOL_REPLY : TEXT_REPLY }), async ({ requests }) => {
      process.env.PONOS_API_FORMAT = 'anthropic'
      const session = createSessionStore({ configDir: dir, cwd: dir, sessionId: 'thinking-e2e' })
      // 令牌模式在 createEngine 时读取 ⇒ 只在构造窗口内关掉路由（镜像 api-empty-completion）：
      // 否则每轮会多一次真实路由请求打进来，requests 下标全部错位。
      const prevLoopMode = process.env.PONOS_LOOP_MODE
      process.env.PONOS_LOOP_MODE = 'react'
      let engine
      try {
        engine = createEngine({
          opts: { model: 'test-model', addDirs: [dir], skipPermissions: true, systemPrompt: '', configDir: dir },
          wire,
          session,
        })
      } finally {
        if (prevLoopMode === undefined) delete process.env.PONOS_LOOP_MODE
        else process.env.PONOS_LOOP_MODE = prevLoopMode
      }
      const out = await engine.runTurn({ content: '跑个命令' })
      assert.match(String(out.text || ''), /完成/)
      assert.equal(requests.length, 2, '一次工具调用 → 恰好两次模型请求')

      // 落盘：thinking 条目带原始文本与签名
      const disk = readFileSync(session.file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      const t = disk.find((e) => e.type === 'thinking')
      assert.ok(t, '思考必须落盘（回放数据源）')
      assert.equal(t.message.content[0].thinking, '先确认文件存在，再读。')
      assert.equal(t.message.content[0].signature, 'sig-e2e')

      // 第二次请求：assistant(tool_use) 的 content 头必须是同一条 thinking
      const sent = requests[1].body.messages
      const assistant = sent.find((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use'))
      assert.ok(assistant, '第二次请求必须包含工具轮的 assistant 消息')
      assert.equal(assistant.content[0].type, 'thinking', 'thinking 必须在 content 头部（DeepSeek 校验形态）')
      assert.equal(assistant.content[0].thinking, '先确认文件存在，再读。')
      assert.equal(assistant.content[0].signature, 'sig-e2e')
      assert.equal(assistant.content[1].type, 'tool_use')
    })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
