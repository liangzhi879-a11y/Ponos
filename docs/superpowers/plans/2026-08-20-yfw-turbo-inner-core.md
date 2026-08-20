# YFW-turbo 内层逻辑实施计划（事件日志 surface + 双协议 + 两阶段压缩 + 健康监控 + 统计）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 YFW-turbo 内核补齐内层逻辑——消息历史从内存数组迁移到「追加式事件日志 + surface 派生」，实现双协议 API（OpenAI/Anthropic）+ tools schema 注入、两阶段上下文压缩（免模型裁剪 + 主模型摘要）、健康监控事件、token 统计聚合端点，全部保持既有 wire 契约与测试通过。

**Architecture:** 单进程每会话。transcript JSONL 仍为权威源；新增内存 `surface = { nodes, replaceGeneration }` 投影，模型输入永远从 `session.deriveMessages()` 派生（带缓存）。`context.mjs`（token 计价/压力判定）与 `compact.mjs`（裁剪/摘要/切点/日志锁）配合 engine 的 pre-step 测压检查点触发压缩。每轮尾部产出 `turnStats`，供 `health.mjs` 纯计算消费 → `yfw_health`/`yfw_summary` 事件。api.mjs 增加协议选择层（env 检测 openai/anthropic）+ 纯解析器，tools 注入请求 body。统计聚合收敛到 bridge `/transcript/stats`。

**Tech Stack:** Node ESM（.mjs）、node:test + assert/strict、NDJSON stream-json 协议、node:readline/fs 流式读、无第三方运行时依赖（沿用净室原则）。

## Global Constraints

- **净室**：不引入任何第三方依赖（无 sqlite/vector/embedding）；所有增强必须是确定性 O(n) 纯函数或默认关闭的可选调用。
- **既有测试不得破坏**：`server/kernel-engine.test.mjs`、`server/kernel-contract.test.mjs`、`server/kernel-bridge.test.mjs`、`src/lib/transcriptAdapter.test.ts` 全量保持通过（spec §8 测试 24）。
- **wire 契约不变**：stdin/stdout NDJSON 形状、`system/init`、`assistant`、`result`、`control_request(can_use_tool)`、`bridge_request` 全部保留；新增事件只增不改。
- **transcript 兼容**：新增 entry 字段（seq/surfaceOp/sourceEventSeqs/kind）全部可选；旧 transcript 无 seq 时按顺序补齐。
- **result 事件保持纯 usage**：不补 `total_cost_usd` 字段；成本换算收敛到 `/transcript/stats`（spec §6.5）。
- **切点纪律**：压缩只切在 turn 边界；assistant tool-call 与其 tool_result 配对永不被拆分；open tail（最后一条是带 tool_use 的 assistant）不压缩返回 null。
- **默认值**（spec §5.6）：thresholdRatio=0.8、retainRatio=0.16、tool-result 裁剪阈值 20000 字符、compactionRetries=3、maxOverflowRetries=3。
- **模型窗口**：`CLAUDE_CODE_AUTO_COMPACT_WINDOW`（bridge 注入）→ 模型表（deepseek-v4-flash=200K / deepseek-v4-pro=1M）→ 默认 200K。
- **测试运行**：`node --test "server/*.test.mjs" "electron/*.test.mjs"`；transcriptAdapter 单独 `node --test src/lib/transcriptAdapter.test.ts`。内核新测试一律放 `server/*.test.mjs`（不经 kernel/ 目录）。

---

### Task 1: 阶段0a —— tools.mjs input_schema + toolSchemas()（前置项）

**Files:**
- Modify: `kernel/tools.mjs`（registry 每工具补 input_schema；新增 toolSchemas()）
- Test: `server/tools-schema.test.mjs`（新建）

**Interfaces:**
- Consumes: 无（独立改造）
- Produces: `createToolRegistry({ cwd, addDirs, skipPermissions })` 返回值新增方法 `toolSchemas()` → `[{ name, description, input_schema }]`（中立形状，协议映射在 api.mjs）；`run(toolUse, ctx)` 签名不变；`toolNames` 不变

- [ ] **Step 1: 写失败测试**

`server/tools-schema.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createToolRegistry } from '../kernel/tools.mjs'

function reg() {
  return createToolRegistry({ cwd: '/tmp', addDirs: ['/tmp'], skipPermissions: false })
}

test('registry 每工具带 input_schema（JSON Schema，additionalProperties:false）', () => {
  const schemas = reg().toolSchemas()
  assert.deepEqual(schemas.map((s) => s.name), ['Bash', 'Read', 'Write'])
  for (const s of schemas) {
    assert.equal(typeof s.description, 'string')
    assert.ok(s.description.length > 0)
    assert.equal(s.input_schema.type, 'object')
    assert.equal(s.input_schema.additionalProperties, false)
    assert.ok(s.input_schema.properties && typeof s.input_schema.properties === 'object')
  }
})

test('各工具 input_schema 字段与 required 正确', () => {
  const schemas = reg().toolSchemas()
  const byName = Object.fromEntries(schemas.map((s) => [s.name, s]))
  assert.ok(byName.Bash.input_schema.properties.command)
  assert.deepEqual(byName.Bash.input_schema.required, ['command'])
  assert.ok(byName.Read.input_schema.properties.file_path)
  assert.deepEqual(byName.Read.input_schema.required, ['file_path'])
  assert.ok(byName.Write.input_schema.properties.file_path)
  assert.ok(byName.Write.input_schema.properties.content)
  assert.deepEqual(byName.Write.input_schema.required, ['file_path', 'content'])
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test server/tools-schema.test.mjs`
Expected: FAIL —— `reg().toolSchemas is not a function`

- [ ] **Step 3: 最小实现**

在 `kernel/tools.mjs` 的 `createToolRegistry` 内，给三个工具补 `input_schema`，并在返回对象上新增 `toolSchemas()`：

```js
export function createToolRegistry({ cwd, addDirs, skipPermissions }) {
  const allowDirs = [cwd, ...(addDirs || [])].filter(Boolean)
  const registry = {
    Bash: {
      description: '执行 shell 命令',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: { command: { type: 'string', description: '要执行的 shell 命令' } },
        required: ['command'],
      },
      run: (input) => runShell(String(input?.command ?? ''), cwd),
      isHighRisk: (input) => matchesHighRisk(String(input?.command ?? '')),
    },
    Read: {
      description: '读取文本文件内容',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: { file_path: { type: 'string', description: '要读取的文件绝对路径' } },
        required: ['file_path'],
      },
      run: (input) => readFile(String(input?.file_path ?? ''), allowDirs),
    },
    Write: {
      description: '写入文本文件',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_path: { type: 'string', description: '要写入的文件绝对路径' },
          content: { type: 'string', description: '文件内容' },
        },
        required: ['file_path', 'content'],
      },
      run: (input) => writeFile(String(input?.file_path ?? ''), String(input?.content ?? ''), allowDirs),
    },
  }
  return {
    registry,
    toolNames: Object.keys(registry),
    // 中立工具 schema 列表（Anthropic/OpenAI 协议字段映射在 api.mjs 完成）
    toolSchemas() {
      return Object.entries(registry).map(([name, tool]) => ({
        name,
        description: tool.description,
        input_schema: tool.input_schema,
      }))
    },
    async run(toolUse, ctx) {
      const tool = registry[toolUse?.name]
      if (!tool) return { content: `未知工具：${toolUse?.name}`, isError: true }
      return tool.run(toolUse.input || {}, ctx)
    },
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test server/tools-schema.test.mjs`
Expected: PASS（2 个测试）

- [ ] **Step 5: 回归既有工具测试**

Run: `node --test server/kernel-engine.test.mjs`
Expected: PASS（tool+approval 闭环、highrisk 测试仍通过——run/toolNames 未变）

- [ ] **Step 6: Commit**

```bash
git add kernel/tools.mjs server/tools-schema.test.mjs
git commit -m "feat(kernel): tools registry 补 input_schema + toolSchemas()（双协议前置项）"
```

---

### Task 2: 阶段0b —— api.mjs 双协议 + tools 注入 + cache usage 解析（前置项）

**Files:**
- Modify: `kernel/api.mjs`（detectProtocol、createAnthropicParser/createOpenAIParser、anthropicStream/openaiStream、tools 注入、normalizeUsage 含 cache_read/cache_creation）
- Test: `server/api-protocol.test.mjs`（新建）

**Interfaces:**
- Consumes: Task 1 的 `toolSchemas()`（中立形状 `[{name, description, input_schema}]`）；既有 `segmentText`（保留在 api.mjs 内部）
- Produces:
  - `detectProtocol(env = process.env)` → `'openai' | 'anthropic' | null`（OPENAI_BASE_URL+OPENAI_API_KEY → openai；否则 ANTHROPIC_BASE_URL → anthropic；否则 null）
  - `createAnthropicParser()` → `{ feed(payload) → chunk[], finish() → chunk[], usage() → usage }`
  - `createOpenAIParser()` → 同上
  - `streamMessages({ model, messages, maxTokens, signal, tools })`（新增 `tools` 参数；chunk 形状不变）
  - usage 对象扩展：`{ input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }`

- [ ] **Step 1: 写失败测试（协议选择 + 解析器 + tools 注入 + cache usage）**

`server/api-protocol.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectProtocol, createAnthropicParser, createOpenAIParser, streamMessages } from '../kernel/api.mjs'
import { createToolRegistry } from '../kernel/tools.mjs'

test('detectProtocol：OPENAI env 优先，否则 Anthropic，都没有返回 null', () => {
  assert.equal(detectProtocol({ OPENAI_BASE_URL: 'http://x', OPENAI_API_KEY: 'k' }), 'openai')
  assert.equal(detectProtocol({ OPENAI_BASE_URL: 'http://x', OPENAI_API_KEY: 'k', ANTHROPIC_BASE_URL: 'http://y' }), 'openai')
  assert.equal(detectProtocol({ ANTHROPIC_BASE_URL: 'http://y' }), 'anthropic')
  assert.equal(detectProtocol({}), null)
})

test('Anthropic 解析器：text/tool_use/usage 归一化 chunk 形状', () => {
  const p = createAnthropicParser()
  const out = []
  out.push(...p.feed({ type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } }))
  out.push(...p.feed({ type: 'content_block_delta', delta: { type: 'text_delta', text: '你好，世界。\n\n' } }))
  out.push(...p.feed({ type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: 'Bash' } }))
  out.push(...p.feed({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"command":' } }))
  out.push(...p.feed({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '"ls"}' } }))
  out.push(...p.feed({ type: 'content_block_stop' }))
  out.push(...p.feed({ type: 'message_delta', usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } }))
  out.push(...p.finish())
  const kinds = out.map((c) => c.type)
  assert.ok(kinds.includes('text') && kinds.includes('tool_use') && kinds.includes('usage'))
  const tool = out.find((c) => c.type === 'tool_use')
  assert.deepEqual(tool, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } })
  const usage = out.find((c) => c.type === 'usage').usage
  assert.equal(usage.input_tokens, 5)
  assert.equal(usage.output_tokens, 3)
  assert.equal(usage.cache_read_input_tokens, 2)
  assert.equal(usage.cache_creation_input_tokens, 1)
})

test('OpenAI 解析器：content/reasoning_content/tool_calls/末尾 usage → 相同 chunk 形状', () => {
  const p = createOpenAIParser()
  const out = []
  out.push(...p.feed({ choices: [{ delta: { content: '第一段。\n\n' } }] }))
  out.push(...p.feed({ choices: [{ delta: { reasoning_content: '思考中…' } }] }))
  out.push(...p.feed({ choices: [{ delta: { tool_calls: [{ index: 0, id: 't2', function: { name: 'Read', arguments: '{"file_path":' } }] } }] }))
  out.push(...p.feed({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }] }))
  out.push(...p.feed({ choices: [{ finish_reason: 'tool_calls', delta: {} }] }))
  out.push(...p.feed({ choices: [{ delta: { content: '第二段。\n\n' } }] }))
  out.push(...p.feed({ usage: { prompt_tokens: 11, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 4 } } }))
  out.push(...p.finish())
  const tool = out.find((c) => c.type === 'tool_use')
  assert.deepEqual(tool, { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'a.txt' } })
  assert.ok(out.some((c) => c.type === 'thinking'))
  const usage = out.find((c) => c.type === 'usage').usage
  assert.equal(usage.input_tokens, 11)
  assert.equal(usage.output_tokens, 7)
  assert.equal(usage.cache_read_input_tokens, 4)
})

test('tools 注入：Anthropic 请求 body 含 tools[]（字段名映射，mock HTTP 断言）', async () => {
  const captured = []
  const prev = global.fetch
  global.fetch = async (url, init) => {
    captured.push({ url: String(url), body: JSON.parse(String(init.body)) })
    return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"message_delta","usage":{"input_tokens":1,"output_tokens":1}}\n\ndata: [DONE]\n\n')); c.close() } }) }
  }
  const env = { ANTHROPIC_BASE_URL: 'http://t', ANTHROPIC_AUTH_TOKEN: 'k', ANTHROPIC_MODEL: 'm' }
  const oldEnv = { ...process.env }
  Object.assign(process.env, env)
  try {
    const tools = createToolRegistry({ cwd: '/tmp', addDirs: ['/tmp'] }).toolSchemas()
    const chunks = []
    for await (const c of streamMessages({ model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, tools, signal: undefined })) chunks.push(c)
    assert.equal(captured.length, 1)
    assert.ok(captured[0].url.endsWith('/v1/messages'))
    assert.ok(Array.isArray(captured[0].body.tools))
    assert.deepEqual(captured[0].body.tools.map((t) => t.name), ['Bash', 'Read', 'Write'])
    assert.equal(captured[0].body.tools[0].input_schema.type, 'object')
    assert.ok(chunks.some((c) => c.type === 'usage'))
  } finally {
    global.fetch = prev
    process.env = oldEnv
  }
})

test('tools 注入：OpenAI 请求 body 为 function 形状且 system 并入 messages', async () => {
  const captured = []
  const prev = global.fetch
  global.fetch = async (url, init) => {
    captured.push({ url: String(url), body: JSON.parse(String(init.body)) })
    return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":""}}]}\n\ndata: {"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n')); c.close() } }) }
  }
  const oldEnv = { ...process.env }
  Object.assign(process.env, { OPENAI_BASE_URL: 'http://o', OPENAI_API_KEY: 'k', OPENAI_MODEL: 'm' })
  try {
    const tools = createToolRegistry({ cwd: '/tmp', addDirs: ['/tmp'] }).toolSchemas()
    const chunks = []
    for await (const c of streamMessages({ model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, tools, signal: undefined })) chunks.push(c)
    assert.equal(captured.length, 1)
    assert.ok(captured[0].url.endsWith('/v1/chat/completions'))
    assert.ok(captured[0].body.messages[0].role === 'system' || !captured[0].body.messages.some((m) => m.role === 'system'))
    const tool0 = captured[0].body.tools[0]
    assert.equal(tool0.type, 'function')
    assert.equal(tool0.function.name, 'Bash')
    assert.equal(tool0.function.parameters.type, 'object')
  } finally {
    global.fetch = prev
    process.env = oldEnv
  }
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test server/api-protocol.test.mjs`
Expected: FAIL —— `detectProtocol is not a function` / `createAnthropicParser is not a function` 等

- [ ] **Step 3: 实现 detectProtocol + normalizeUsage + 纯解析器**

在 `kernel/api.mjs` 顶部新增（`segmentText` 保留原样；新增导出）：

```js
// 协议检测：OPENAI env 优先（可并存时走 OpenAI），否则 Anthropic；都没有返回 null
export function detectProtocol(env = process.env) {
  if (env.OPENAI_BASE_URL && env.OPENAI_API_KEY) return 'openai'
  if (env.ANTHROPIC_BASE_URL) return 'anthropic'
  return null
}

// usage 归一化：兼容 anthropic/openai 字段名；扩展 cache_read/cache_creation（deepseek 系）
function normalizeUsage(u = {}) {
  const cacheRead =
    u.cache_read_input_tokens ??
    u.prompt_tokens_details?.cached_tokens ??
    0
  return {
    input_tokens: u.input_tokens ?? u.prompt_tokens ?? 0,
    output_tokens: u.output_tokens ?? u.completion_tokens ?? 0,
    cache_read_input_tokens: cacheRead ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
  }
}

// Anthropic Messages 事件流纯解析器（闭包状态：tool 累积/textBuf/usage）
export function createAnthropicParser() {
  let tool = null // { id, name, inputJson }
  let textBuf = ''
  let usage = { input_tokens: 0, output_tokens: 0 }
  return {
    feed(payload) {
      const out = []
      const dt = payload.delta
      if (payload.type === 'content_block_start' && payload.content_block?.type === 'tool_use') {
        tool = { id: payload.content_block.id, name: payload.content_block.name, inputJson: '' }
      } else if (payload.type === 'content_block_delta' && dt) {
        if (dt.type === 'text_delta' && dt.text) {
          textBuf += dt.text
          for (const seg of segmentText(textBuf)) { textBuf = ''; out.push(seg) }
        } else if (dt.type === 'thinking_delta' && dt.thinking) {
          out.push({ type: 'thinking', text: dt.thinking })
        } else if (dt.type === 'input_json_delta' && tool && dt.partial_json) {
          tool.inputJson += dt.partial_json
        }
      } else if (payload.type === 'content_block_stop' && tool) {
        let input = {}
        try { input = tool.inputJson ? JSON.parse(tool.inputJson) : {} } catch {}
        out.push({ type: 'tool_use', id: tool.id, name: tool.name, input })
        tool = null
      } else if (payload.type === 'message_start' && payload.message?.usage) {
        usage = normalizeUsage(payload.message.usage)
      } else if (payload.type === 'message_delta' && payload.usage) {
        usage = normalizeUsage(payload.usage)
      }
      return out
    },
    finish() {
      const out = []
      if (textBuf.trim()) out.push({ type: 'text', text: textBuf })
      textBuf = ''
      return out
    },
    usage() { return usage },
  }
}

// OpenAI Chat Completions 事件流纯解析器（choices[].delta；deepseek 系 reasoning_content）
export function createOpenAIParser() {
  let tool = null // { index, id, name, inputJson }
  let textBuf = ''
  let usage = { input_tokens: 0, output_tokens: 0 }
  return {
    feed(payload) {
      const out = []
      if (payload.usage) {
        usage = normalizeUsage(payload.usage)
        return out
      }
      const choice = payload.choices?.[0] ?? {}
      const delta = choice.delta ?? {}
      if (delta.reasoning_content) out.push({ type: 'thinking', text: delta.reasoning_content })
      if (delta.content) {
        textBuf += delta.content
        for (const seg of segmentText(textBuf)) { textBuf = ''; out.push(seg) }
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          if (tc.id) tool = { index: tc.index ?? 0, id: tc.id, name: tc.function?.name ?? '', inputJson: '' }
          if (tool && tc.function?.name) tool.name = tc.function.name
          if (tool && tc.function?.arguments) tool.inputJson += tc.function.arguments
        }
      }
      if (choice.finish_reason === 'tool_calls' && tool) {
        let input = {}
        try { input = tool.inputJson ? JSON.parse(tool.inputJson) : {} } catch {}
        out.push({ type: 'tool_use', id: tool.id, name: tool.name, input })
        tool = null
      }
      return out
    },
    finish() {
      const out = []
      if (textBuf.trim()) out.push({ type: 'text', text: textBuf })
      textBuf = ''
      return out
    },
    usage() { return usage },
  }
}
```

- [ ] **Step 4: 运行确认通过（解析器部分）**

Run: `node --test server/api-protocol.test.mjs`
Expected: 前 3 个测试 PASS；`tools 注入` 2 个测试仍 FAIL（remoteStream 未注入 tools / 无 openaiStream）

- [ ] **Step 5: 重构 remoteStream 为双协议 + tools 注入**

替换现有 `remoteStream` 与 `streamMessages` 尾部实现：

```js
// 双协议流：统一产出归一化 chunk。protocol 由 env 检测（engine 无感）。
async function* protocolStream({ protocol, url, body, headers, signal }) {
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal })
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    throw new Error(`内核：API 请求失败 ${res.status} ${detail.slice(0, 300)}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const parser = protocol === 'openai' ? createOpenAIParser() : createAnthropicParser()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (signal?.aborted) throw abortError()
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        const payload = t.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let ev
        try { ev = JSON.parse(payload) } catch { continue }
        for (const c of parser.feed(ev)) yield c
      }
    }
    for (const c of parser.finish()) yield c
    yield { type: 'usage', usage: parser.usage() }
  } finally {
    try { reader.releaseLock() } catch {}
  }
}

// Anthropic 协议流：tools 中立形状 → tools[]；system 抽顶层
async function* anthropicStream({ model, messages, system, tools, maxTokens, signal }) {
  const base = (process.env.ANTHROPIC_BASE_URL || '').replace(/\/+$/, '')
  const token = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || ''
  if (!base || !token) throw new Error('内核：ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 未配置')
  const body = {
    model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages,
    stream: true,
    ...(tools.length
      ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })) }
      : {}),
  }
  yield* protocolStream({
    protocol: 'anthropic',
    url: base + '/v1/messages',
    body,
    headers: { 'content-type': 'application/json', 'x-api-key': token, 'anthropic-version': '2023-06-01' },
    signal,
  })
}

// OpenAI 协议流：tools 中立形状 → function 形状；system 并入 messages 首位
async function* openaiStream({ model, messages, system, tools, maxTokens, signal }) {
  const base = (process.env.OPENAI_BASE_URL || '').replace(/\/+$/, '')
  const token = process.env.OPENAI_API_KEY || ''
  if (!base || !token) throw new Error('内核：OPENAI_BASE_URL / OPENAI_API_KEY 未配置')
  const body = {
    model,
    max_tokens: maxTokens,
    stream: true,
    messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
    ...(tools.length
      ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) }
      : {}),
  }
  yield* protocolStream({
    protocol: 'openai',
    url: base + '/v1/chat/completions',
    body,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    signal,
  })
}

// 消息流入口：mock / 真实双协议分流。tools = 中立 [{name, description, input_schema}]
export async function* streamMessages({ model, messages, maxTokens, signal, tools = [] }) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n')
  const rest = messages.filter((m) => m.role !== 'system')
  if (process.env.YFW_MOCK_API === '1') {
    yield* mockStream({ messages, signal })
    return
  }
  const protocol = detectProtocol()
  if (!protocol) throw new Error('内核：未检测到可用协议（需 ANTHROPIC_BASE_URL 或 OPENAI_BASE_URL+OPENAI_API_KEY）')
  if (protocol === 'openai') yield* openaiStream({ model, messages: rest, system, tools, maxTokens, signal })
  else yield* anthropicStream({ model, messages: rest, system, tools, maxTokens, signal })
}
```

同时删除旧的 `remoteStream` 函数体（被 `protocolStream` 取代）。

- [ ] **Step 6: 运行确认全部通过**

Run: `node --test server/api-protocol.test.mjs`
Expected: PASS（5 个测试）

- [ ] **Step 7: 回归 mock 路径**

Run: `node --test server/kernel-engine.test.mjs server/kernel-contract.test.mjs`
Expected: PASS（YFW_MOCK_API=1 分支未动，既有 wire 测试全绿）

- [ ] **Step 8: Commit**

```bash
git add kernel/api.mjs server/api-protocol.test.mjs
git commit -m "feat(kernel): 双协议适配（openai/anthropic）+ tools 注入 + cache usage 解析"
```

---

### Task 3: 阶段1 —— kernel/context.mjs（token 计价 / 窗口表 / 压力判定 / tokenLedger / usage 锚点）

**Files:**
- Create: `kernel/context.mjs`
- Test: `server/context.test.mjs`（新建）

**Interfaces:**
- Consumes: 无（零依赖纯函数模块）
- Produces:
  - `DEFAULT_WINDOW = 200_000`；`MODEL_CONTEXT_WINDOWS = { 'deepseek-v4-flash': 200_000, 'deepseek-v4-pro': 1_000_000 }`
  - `contextWindowFor(model, env = process.env)` → number（CLAUDE_CODE_AUTO_COMPACT_WINDOW 优先 → 模型表 → DEFAULT_WINDOW）
  - `isCodeLike(text)` → boolean（行首特征：const/let/function/class/import/export/def/echo/SELECT 等）
  - `estimateTokens(block, opts)` → number（text/thinking 按 ceil(chars/4)，tool_result 与代码特征文本按 ceil(chars/3)，image=4800，每块 +4）
  - `estimateMessage(m, opts)` → number（role +4 + 各块合计；string content 视为单 text 块）
  - `estimateHistory(msgs, opts)` → number（逐条 estimateMessage 求和）
  - `estimateRequest({ system, messages, opts })` → `{ total, sections: { system, task, tool_result, history } }`（tokenLedger 四区）
  - `createTokenLedger()` → `{ record(section, tokens), get(section), total(), toolResultShare() }`
  - `makeUsageAnchor()` → `{ estimate({ headKey, history }), record({ headKey, inputTokens }) }`

- [ ] **Step 1: 写失败测试**

`server/context.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  contextWindowFor, isCodeLike, estimateTokens, estimateMessage, estimateHistory,
  estimateRequest, createTokenLedger, makeUsageAnchor, MODEL_CONTEXT_WINDOWS,
} from '../kernel/context.mjs'

test('窗口表与优先级：env → 模型表 → 默认', () => {
  assert.equal(contextWindowFor('x', { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '12345' }), 12345)
  assert.equal(contextWindowFor('deepseek-v4-flash', {}), 200_000)
  assert.equal(contextWindowFor('deepseek-v4-pro', {}), 1_000_000)
  assert.equal(contextWindowFor('unknown-model', {}), 200_000)
  assert.equal(MODEL_CONTEXT_WINDOWS['deepseek-v4-flash'], 200_000)
})

test('token 计价：chars/4 基准 + 块/role 加成', () => {
  assert.equal(estimateTokens({ type: 'text', text: 'abcd' }), 1 + 4) // 4 chars / 4 = 1 + 块 +4
  assert.equal(estimateTokens({ type: 'text', text: 'a'.repeat(800) }), 200 + 4)
  assert.equal(estimateMessage({ role: 'user', content: 'a'.repeat(400) }), 4 + 100 + 4)
  assert.equal(estimateMessage({ role: 'assistant', content: [] }), 4)
})

test('代码密度：tool_result 与代码特征文本按 chars/3', () => {
  assert.equal(estimateTokens({ type: 'tool_result', content: 'a'.repeat(300) }), 100 + 4)
  assert.equal(estimateTokens({ type: 'text', text: 'const x = 1;\n' + 'a'.repeat(200) }), 4 + Math.ceil(204 / 3))
  assert.equal(isCodeLike('const a = 1'), true)
  assert.equal(isCodeLike('这是一段中文文本'), false)
})

test('图片/二进制固定 4800 当量', () => {
  assert.equal(estimateTokens({ type: 'image' }), 4800 + 4)
})

test('estimateRequest 四区记账：system/task/tool_result/history', () => {
  const r = estimateRequest({
    system: 'sys',
    messages: [
      { role: 'user', content: '历史问题1' },
      { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
      { role: 'user', content: [{ type: 'tool_result', content: 'big-output'.repeat(100), tool_use_id: 't' }] },
      { role: 'user', content: '本轮任务' },
    ],
  })
  assert.ok(r.sections.system > 0)
  assert.ok(r.sections.tool_result > 0)
  assert.ok(r.sections.task > 0)
  assert.ok(r.sections.history > 0)
  assert.equal(r.total, r.sections.system + r.sections.task + r.sections.tool_result + r.sections.history)
  const ledger = createTokenLedger()
  ledger.record('system', 10)
  ledger.record('tool_result', 20)
  ledger.record('history', 70)
  assert.equal(ledger.total(), 100)
  assert.equal(ledger.toolResultShare(), 0.2)
})

test('usage 锚点：同 headKey 用基线+尾部增量，异 headKey 全量', () => {
  const anchor = makeUsageAnchor()
  const history = [{ role: 'user', content: 'a'.repeat(400) }]
  const tail = [{ role: 'user', content: 'b'.repeat(400) }]
  const first = anchor.estimate({ headKey: 'k1', history })
  assert.equal(first.anchored, false)
  anchor.record({ headKey: 'k1', inputTokens: first.input })
  const second = anchor.estimate({ headKey: 'k1', history: [...history, ...tail] })
  assert.equal(second.anchored, true)
  assert.equal(second.input, first.input + estimateHistory(tail))
  const other = anchor.estimate({ headKey: 'k2', history: [...history, ...tail] })
  assert.equal(other.anchored, false)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test server/context.test.mjs`
Expected: FAIL —— 模块不存在 / 函数未定义

- [ ] **Step 3: 实现 kernel/context.mjs**

```js
// YFW-turbo 上下文管理（docs/superpowers/specs/2026-08-20-yfw-turbo-inner-core-design.md §5/§6.3）
// ---------------------------------------------------------------------------
// 零依赖纯函数：token 启发式计价（块级密度系数）、模型窗口表、pre-step 压力
// 判定、tokenLedger 四区记账、usage 锚点优化（KV 前缀缓存近似）。全部确定性，
// 无模型调用；engine/compact/health 消费。
export const DEFAULT_WINDOW = 200_000

// 模型窗口表（可扩展）：deepseek-v4-flash=200K / deepseek-v4-pro=1M
export const MODEL_CONTEXT_WINDOWS = {
  'deepseek-v4-flash': 200_000,
  'deepseek-v4-pro': 1_000_000,
}

// contextWindow 来源优先级：CLAUDE_CODE_AUTO_COMPACT_WINDOW（bridge 注入）→ 模型表 → 默认
export function contextWindowFor(model, env = process.env) {
  const injected = Number(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)
  if (Number.isFinite(injected) && injected > 0) return injected
  const byModel = MODEL_CONTEXT_WINDOWS[String(model || '')]
  if (byModel) return byModel
  return DEFAULT_WINDOW
}

// 密度系数（默认 text=4 / code=3，可经 env 校准）
function densityOf(env = process.env) {
  const d = { code: 3, text: 4 }
  const code = Number(env.CLAUDE_CODE_TOKEN_DENSITY_CODE)
  const text = Number(env.CLAUDE_CODE_TOKEN_DENSITY_TEXT)
  if (Number.isFinite(code) && code > 0) d.code = code
  if (Number.isFinite(text) && text > 0) d.text = text
  return d
}

// 代码特征检测：行首缩进 + 关键字（高 token 密度内容）；行首=字符串开头或换行后
export function isCodeLike(text) {
  return /(?:^|\n)[\t ]*(?:const|let|var|function|class|import|export|def|func|echo|SELECT|INSERT|UPDATE|DELETE|require|if\s*\()/i.test(String(text))
}

// 块级计价：text/thinking 按 text 密度，代码特征或 tool_result 按 code 密度，
// image/二进制固定 4800 当量；每块 +4。
export function estimateTokens(block = {}, opts = {}) {
  const { env = process.env } = opts
  const density = densityOf(env)
  if (block.type === 'image' || block.type === 'binary') return 4800 + 4
  const raw =
    block.type === 'tool_result'
      ? String(block.content ?? '')
      : String(block.text ?? block.thinking ?? block.content ?? '')
  const per = block.type === 'tool_result' || isCodeLike(raw) ? density.code : density.text
  return Math.ceil(raw.length / per) + 4
}

// 消息级：role +4 + 各块合计（string content 视为单 text 块）
export function estimateMessage(m = {}, opts) {
  const content = m.content
  if (typeof content === 'string') return 4 + estimateTokens({ type: 'text', text: content }, opts)
  if (Array.isArray(content)) return 4 + content.reduce((s, b) => s + estimateTokens(b, opts), 0)
  return 4
}

// 全量启发式
export function estimateHistory(msgs = [], opts) {
  return msgs.reduce((s, m) => s + estimateMessage(m, opts), 0)
}

// 四区记账：system（顶层提示）/ task（本轮 user 输入）/ tool_result / history（其余历史）
// 返回 { total, sections }，供 pre-step 测压与 tokenLedger 入账。
export function estimateRequest({ system = '', messages = [], opts }) {
  let task = 0
  let toolResult = 0
  let history = 0
  const arr = Array.isArray(messages) ? messages : []
  for (let i = 0; i < arr.length; i++) {
    const m = arr[i]
    if (i === arr.length - 1 && m.role === 'user') {
      task += estimateMessage(m, opts)
      continue
    }
    if (Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result')) {
      toolResult += estimateMessage(m, opts)
      continue
    }
    history += estimateMessage(m, opts)
  }
  const sections = {
    system: Math.ceil(String(system).length / 4) + 4,
    task,
    tool_result: toolResult,
    history,
  }
  return { total: sections.system + task + toolResult + history, sections }
}

// tokenLedger：四区累计 + tool_result 占比（喂给 health 分区失衡因子）
export function createTokenLedger() {
  const sections = { system: 0, task: 0, tool_result: 0, history: 0 }
  return {
    record(section, tokens) {
      if (Object.prototype.hasOwnProperty.call(sections, section)) sections[section] += tokens
    },
    get(section) { return sections[section] ?? 0 },
    total() { return sections.system + sections.task + sections.tool_result + sections.history },
    toolResultShare() {
      const t = this.total()
      return t === 0 ? 0 : sections.tool_result / t
    },
    sections,
  }
}

// usage 锚点：最近一次成功调用且请求头（system+工具+模型指纹）相同 → 基线 + 尾部增量
export function makeUsageAnchor() {
  let lastHeadKey = null
  let lastInputTokens = 0
  return {
    estimate({ headKey, history }) {
      if (headKey && headKey === lastHeadKey) {
        const tail = Array.isArray(history) ? history.slice(-1) : []
        return { input: lastInputTokens + estimateHistory(tail), anchored: true }
      }
      return { input: estimateHistory(history), anchored: false }
    },
    record({ headKey, inputTokens }) {
      lastHeadKey = headKey ?? null
      lastInputTokens = inputTokens
    },
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test server/context.test.mjs`
Expected: PASS（5 个测试）

- [ ] **Step 5: Commit**

```bash
git add kernel/context.mjs server/context.test.mjs
git commit -m "feat(kernel): context.mjs token 计价/窗口表/压力判定/tokenLedger/usage 锚点"
```

---

### Task 4: 阶段2a —— session.mjs 事件日志 + surface（流式加载 / seq / 孤儿回滚 / derive 缓存 / 压缩条目）

**Files:**
- Modify: `kernel/session.mjs`（load 改 async 流式、entry 扩展 seq/surfaceOp/sourceEventSeqs/kind、surface 重建、deriveMessages 缓存、replaceCovered、compaction/toolResult/start 条目构造）
- Modify: `kernel/cli.mjs`（main 改 async、resume 块用 `await store.load()`）
- Test: `server/session-surface.test.mjs`（新建）

**Interfaces:**
- Consumes: 无（自包含；cli.mjs 消费）
- Produces: `createSessionStore({ configDir, cwd, sessionId, maxEntries })` 返回：
  - `load()` → `Promise<{ entries, surface: { nodes, replaceGeneration }, compactCount }>`（readline 流式读；seq 补齐；孤儿 compaction/start 回滚）
  - `append(entry)`（仅写日志，低级原语）
  - `appendUser(content, extra)` → user entry（写日志 + nodes.push(seq)）
  - `appendAssistant(blocks, { usage, model })` → assistant entry（写日志 + nodes.push(seq)）
  - `appendToolResult({ toolUseId, content, isError })` → user(tool_result) entry（写日志 + nodes.push(seq)）
  - `appendCompactionStart(coveredSeqs)` → entry（仅写日志，不进 nodes）
  - `appendCompactionSummary({ summary, coveredSeqs })` → entry（写日志 + replaceCovered + compactCount++）
  - `getSurface()` → `{ nodes, replaceGeneration }`
  - `deriveMessages()` → 模型消息数组（按 nodes 顺序；缓存，append/replace 后失效）
  - `seqsForMessages(messages)` → number[]（由 deriveMessages 结果反查各消息对应 seq；供 compactor 遮蔽区间落盘）
  - `compactCount()` → number
  - `entries`/`file` 只读访问
  - 既有 `userEntry`/`assistantEntry`/`sanitizeSegment`/`newSessionId` 保留

- [ ] **Step 1: 写失败测试**

`server/session-surface.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test server/session-surface.test.mjs`
Expected: FAIL —— `appendUser is not a function` / load 同步无 surface 返回等

- [ ] **Step 3: 重写 kernel/session.mjs**

保留 `MAX_SANITIZED_LENGTH`/`sanitizeSegment`/`newSessionId` 原样，重写 `createSessionStore`：

```js
import { existsSync, createReadStream, appendFileSync, mkdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

export const MAX_SANITIZED_LENGTH = 200

export function sanitizeSegment(name) {
  const s = String(name ?? '').replace(/[^a-zA-Z0-9]/g, '-')
  if (s.length <= MAX_SANITIZED_LENGTH) return s
  const hash = createHash('md5').update(String(name)).digest('hex').slice(0, 12)
  return `${s.slice(0, MAX_SANITIZED_LENGTH)}-${hash}`
}

export function newSessionId() {
  return randomUUID()
}

export function createSessionStore({ configDir, cwd, sessionId, maxEntries = 0 }) {
  const dir = join(configDir, 'projects', sanitizeSegment(cwd))
  const file = join(dir, `${sessionId}.jsonl`)
  // 内存状态：entries（seq → entry）、surface（投影顺序）、derive 缓存、压缩计数
  const entriesBySeq = new Map()
  const nodes = []
  let replaceGeneration = 0
  let compactCount = 0
  let nextSeq = 1
  let deriveCache = null // { key, messages }

  // 逐行流式读取（分段加载：超大 transcript 不整文件进内存）
  function readLines() {
    return new Promise((resolve, reject) => {
      if (!existsSync(file)) return resolve([])
      const out = []
      const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
      rl.on('line', (line) => {
        const t = line.trim()
        if (!t) return
        try { out.push(JSON.parse(t)) } catch { /* 跳过损坏行 */ }
      })
      rl.on('close', () => resolve(out))
      rl.on('error', reject)
    })
  }

  // 依序重建 seq + surface；孤儿 compaction/start 直接忽略（replace 从未落地）
  function rebuildSurface(entries) {
    entriesBySeq.clear()
    nodes.length = 0
    replaceGeneration = 0
    compactCount = 0
    nextSeq = 1
    for (const e of entries) {
      const seq = e.seq ?? nextSeq
      nextSeq = Math.max(nextSeq, seq) + 1
      e.seq = seq
      if (e.kind === 'compaction' && e.phase === 'start') continue // 孤儿/占位不投影
      entriesBySeq.set(seq, e)
      if (e.kind === 'compaction' && e.phase === 'summary') {
        // 被遮蔽 seq 区间（投影中连续前缀）→ 替换为 summary seq
        const covered = new Set(e.sourceEventSeqs || [])
        const idxs = nodes.map((s, i) => (covered.has(s) ? i : -1)).filter((i) => i >= 0)
        if (idxs.length) { nodes.splice(idxs[0], idxs.length, seq); replaceGeneration++ }
        compactCount++
      } else {
        nodes.push(seq)
      }
    }
    // 窗口化恢复：超限截断到近窗口（保留尾部；compaction 条目始终保留在 nodes 内）
    if (maxEntries > 0 && nodes.length > maxEntries) {
      const cut = nodes.length - maxEntries
      nodes.splice(0, cut)
    }
    deriveCache = null
  }

  async function load() {
    const entries = await readLines()
    rebuildSurface(entries)
    return { entries, surface: { nodes, replaceGeneration }, compactCount }
  }

  function invalidate() { deriveCache = null }

  function append(entry) {
    try {
      mkdirSync(dir, { recursive: true })
      appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8')
    } catch { /* 磁盘不可写不致命 */ }
    return entry
  }

  function baseEntry(type, message, extra = {}) {
    const entry = {
      type,
      id: randomUUID(),
      seq: nextSeq++,
      timestamp: new Date().toISOString(),
      message,
      surfaceOp: 'append',
      ...extra,
    }
    entriesBySeq.set(entry.seq, entry)
    nodes.push(entry.seq)
    invalidate()
    return entry
  }

  return {
    file,
    // 加载（async；resume / 测试用）。加载后 entries/surface 为当前权威快照
    async load() { return load() },
    // 仅写日志（低级原语；普通追加请用 appendUser/appendAssistant）
    append(entry) { return append(entry) },

    // —— 投影语义封装（写日志 + 更新 surface）——
    userEntry(content, extra = {}) {
      return { type: 'user', id: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: String(content ?? '') }, ...extra }
    },
    assistantEntry(blocks, { usage, model } = {}) {
      const entry = { type: 'assistant', id: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'assistant', content: blocks } }
      if (usage) entry.message.usage = usage
      if (model) entry.message.model = model
      return entry
    },
    toolResultEntry({ toolUseId, content, isError }) {
      return {
        type: 'user',
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: String(content ?? ''), is_error: Boolean(isError) }] },
      }
    },
    compactionStartEntry(coveredSeqs) {
      return {
        type: 'assistant', id: randomUUID(), timestamp: new Date().toISOString(),
        kind: 'compaction', phase: 'start', surfaceOp: 'replace',
        sourceEventSeqs: coveredSeqs,
        message: { role: 'assistant', content: [] },
      }
    },
    compactionSummaryEntry({ summary, coveredSeqs }) {
      return {
        type: 'assistant', id: randomUUID(), timestamp: new Date().toISOString(),
        kind: 'compaction', phase: 'summary', surfaceOp: 'replace',
        sourceEventSeqs: coveredSeqs,
        message: { role: 'assistant', content: [{ type: 'text', text: summary }] },
      }
    },

    appendUser(content, extra = {}) { return append(baseEntry('user', { role: 'user', content: String(content ?? '') }, extra)) },
    appendAssistant(blocks, opts = {}) {
      const entry = this.assistantEntry(blocks, opts)
      return append(baseEntry('assistant', entry.message, {}))
    },
    appendToolResult({ toolUseId, content, isError }) {
      const entry = this.toolResultEntry({ toolUseId, content, isError })
      return append(baseEntry('user', entry.message, {}))
    },
    // 压缩开始占位：仅写日志（持锁标记），不进 surface.nodes；崩溃留孤儿 → 加载回滚
    appendCompactionStart(coveredSeqs) {
      const entry = { ...this.compactionStartEntry(coveredSeqs), seq: nextSeq++ }
      append(entry)
      return entry
    },
    // 压缩落地：写 summary 条目 → surface 替换被遮蔽区间 → compactCount++
    appendCompactionSummary({ summary, coveredSeqs }) {
      const seq = nextSeq++
      const entry = { ...this.compactionSummaryEntry({ summary, coveredSeqs }), seq }
      append(entry)
      const covered = new Set(coveredSeqs || [])
      const idxs = nodes.map((s, i) => (covered.has(s) ? i : -1)).filter((i) => i >= 0)
      if (idxs.length) { nodes.splice(idxs[0], idxs.length, seq); replaceGeneration++ }
      compactCount++
      entriesBySeq.set(seq, entry)
      invalidate()
      return entry
    },

    // —— surface / 派生 ——
    getSurface() { return { nodes: [...nodes], replaceGeneration } },
    compactCount() { return compactCount },
    // 模型输入永远从日志派生（缓存：append/replace 后 key 变化自动失效）
    deriveMessages() {
      const key = nodes.join(',')
      if (deriveCache && deriveCache.key === key) return deriveCache.messages
      const seqs = []
      const messages = []
      for (const seq of nodes) {
        const entry = entriesBySeq.get(seq)
        if (!entry) continue
        seqs.push(seq)
        messages.push(entry.message)
      }
      deriveCache = { key, messages, seqs }
      return messages
    },
    // 由 deriveMessages() 返回的消息对象反查其 seq（对象引用一致；供压缩遮蔽区间落盘）
    seqsForMessages(covered) {
      if (!deriveCache) this.deriveMessages()
      const byRef = new Map()
      deriveCache.messages.forEach((m, i) => byRef.set(m, deriveCache.seqs[i]))
      return covered.map((m) => byRef.get(m)).filter((s) => s != null)
    },
  }
}
```

注意：`baseEntry` 内部已把 seq 追加进 nodes；`appendCompactionStart` 用裸 `append`（不进 nodes）；`appendCompactionSummary` 手动做 replace 语义。`load()` 的 async 包装避免 `async load(){ return load() }` 自引用命名冲突——上面实现里内部函数叫 `load`，返回对象里键是 `async load()`，`async load() { return load() }` 中的 `load` 引用的是内部函数，正确。

- [ ] **Step 4: 运行确认通过**

Run: `node --test server/session-surface.test.mjs`
Expected: PASS（6 个测试）

- [ ] **Step 5: cli.mjs 适配 async load（resume 块）**

`kernel/cli.mjs`：

```js
export async function main(argv) {
  // ...（原有校验不变）
  // --resume：从 transcript 恢复（load 为 async 流式）。本任务 engine 仍走内存
  // seedHistory（engine 迁移到 session 派生在 Task 5 完成，届时此处简化为仅 await store.load()）
  if (args.resume) {
    const { entries } = await store.load()
    const history = entries.filter((e) => e?.type === 'user' || e?.type === 'assistant')
    engine.seedHistory(history.map((e) => e.message))
  }
  // ...（其余不变）
}
```

并将文件尾改为 `if (isMain) { main(process.argv.slice(2)).then((code) => { process.exitCode = code }) }`（main 变 async，Promise 落地 exitCode）。

- [ ] **Step 6: 回归既有测试**

Run: `node --test server/kernel-engine.test.mjs`
Expected: PASS（transcript 落盘 / resume 测试仍通过——cli 仍由 engine 写入 assistant 条目前提未变，本任务未动 engine）

- [ ] **Step 7: Commit**

```bash
git add kernel/session.mjs kernel/cli.mjs server/session-surface.test.mjs
git commit -m "feat(kernel): session 事件日志 + surface 投影（流式加载/seq/孤儿回滚/derive 缓存）"
```

---

### Task 5: 阶段2b —— engine.mjs 迁移到 session（usage 累加 / 中间条目落盘 / turnStats / pre-step 骨架）

**Files:**
- Modify: `kernel/engine.mjs`（createEngine 接收 session；history → session.deriveMessages()；usage 累加 addUsage；中间工具条目落盘；最终 assistant 条目由 engine 写入；turnStats 记录器 + duration_ms）
- Modify: `kernel/cli.mjs`（移除 runTurn 后的 `store.append(store.assistantEntry(...))`——engine 自己写；engine 构造传入 session；`wire.result(usage, { duration_ms })`）
- Modify: `kernel/api.mjs`（mockStream 的 userMsgs 过滤 tool_result user 消息，保证 turn 计数正确）
- Test: `server/engine-session.test.mjs`（新建）

**Interfaces:**
- Consumes: Task 2 的 `streamMessages({..., tools})`；Task 4 的 `createSessionStore` 返回对象
- Produces: `createEngine({ opts, wire, session })`（session 必传）；runTurn 返回不变 `{ usage, model, text }`；新增 `turnStats`（内存 append-only 数组，每轮一条 `{ usage, durationMs, model, ts, compactCount }`）与 `getTurnStats()`；`seedCompactCount(n)` 保留（兼容）；`toolSchemas()` 暴露给 cli 的 init 事件（可改为 schema 形状，或保留 toolNames——本任务保持 toolNames 不变，toolSchemas 内部使用）

- [ ] **Step 1: 写失败测试**

`server/engine-session.test.mjs`（直接 import engine.mjs 用内存 store 测试，避免 spawn 开销；工具循环用法同 mock）：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from '../kernel/engine.mjs'
import { createSessionStore } from '../kernel/session.mjs'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'engine-session-'))
  const events = []
  const wire = {
    assistant: (blocks) => events.push({ type: 'assistant', blocks }),
    result: (usage, extra) => events.push({ type: 'result', usage, extra }),
    controlRequest: () => {},
    system: () => {},
    summary: () => {},
    health: () => {},
  }
  const session = createSessionStore({ configDir: dir, cwd: 'proj', sessionId: '00000000-0000-0000-0000-000000000003' })
  return { dir, events, session }
}

test('usage 逐次累计：工具循环多轮 API 调用全部计入 result.usage', async () => {
  const { dir, events, session } = setup()
  try {
    process.env.YFW_MOCK_API = '1'
    const engine = createEngine({ opts: { model: 'm', addDirs: [dir], skipPermissions: true, systemPrompt: '' }, wire, session })
    await engine.runTurn({ content: '[mock:tool]' })
    // mock 流：工具请求回合 + 工具结果回合 = 2 次 API 调用，各 10/20 → 累计 20/40
    const result = events.find((e) => e.type === 'result')
    assert.equal(result.usage.input_tokens, 20)
    assert.equal(result.usage.output_tokens, 40)
    assert.ok(Number.isFinite(result.extra.duration_ms))
    delete process.env.YFW_MOCK_API
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('中间工具条目落盘：assistant tool_use + user tool_result 进入 session', async () => {
  const { dir, session } = setup()
  try {
    process.env.YFW_MOCK_API = '1'
    const engine = createEngine({ opts: { model: 'm', addDirs: [dir], skipPermissions: true }, wire: { assistant: () => {}, result: () => {}, controlRequest: () => {}, summary: () => {}, health: () => {} }, session })
    await engine.runTurn({ content: '[mock:tool]' })
    const msgs = session.deriveMessages()
    const roles = msgs.map((m) => m.role)
    assert.ok(roles.includes('assistant'))
    assert.ok(msgs.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use')))
    assert.ok(msgs.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')))
    delete process.env.YFW_MOCK_API
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('turnStats 记录器：每轮一条，含 usage/durationMs/model/ts', async () => {
  const { dir, session } = setup()
  try {
    process.env.YFW_MOCK_API = '1'
    const engine = createEngine({ opts: { model: 'm', addDirs: [dir], skipPermissions: true }, wire: { assistant: () => {}, result: () => {}, controlRequest: () => {}, summary: () => {}, health: () => {} }, session })
    await engine.runTurn({ content: 'hello' })
    const stats = engine.getTurnStats()
    assert.equal(stats.length, 1)
    assert.equal(stats[0].model, 'm')
    assert.ok(stats[0].usage.output_tokens >= 0)
    assert.ok(Number.isFinite(stats[0].durationMs))
    assert.ok(stats[0].ts)
    delete process.env.YFW_MOCK_API
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test server/engine-session.test.mjs`
Expected: FAIL —— engine 未接 session / usage 覆盖而非累计（第二个工具回合覆盖为 10/20 而非 20/40）

- [ ] **Step 3: engine.mjs 迁移实现**

在 `kernel/engine.mjs` 中替换 `createEngine`：

```js
import { streamMessages } from './api.mjs'
import { abortError } from './protocol.mjs'
import { decideToolPermission } from './permissions.mjs'
import { createToolRegistry } from './tools.mjs'

const MAX_TOOL_ITERATIONS = 10

// usage 逐次累加（input/output/cache 各字段），修复"多次 API 调用只记最后一次"
function addUsage(acc, u = {}) {
  const out = { ...acc }
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    out[k] = (acc[k] ?? 0) + (u[k] ?? 0)
  }
  return out
}

export function createEngine({ opts = {}, wire, session }) {
  const signal = { aborted: false }
  const model = opts.model || process.env.ANTHROPIC_MODEL || ''
  const maxTokens = Math.max(1, Number(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || 64000))
  const tools = createToolRegistry({ cwd: opts.addDirs?.[0], addDirs: opts.addDirs, skipPermissions: opts.skipPermissions })
  // 审批挂起队列：toolUseId → resolve（cli 的 control_response 解除）
  const approvalWaiters = new Map()
  // turnStats 记录器（内存 append-only）：health / result / stats 三个消费者共用
  const turnStats = []

  // 历史优先走 session.deriveMessages()；无 session 时退化为内存数组（测试直连场景）
  const memoryHistory = []
  const systemPrompt = opts.systemPrompt || ''

  function deriveHistory() {
    if (session) return session.deriveMessages()
    return memoryHistory.filter((m) => m.role !== 'system')
  }
  function pushMemory(m) { if (!session) memoryHistory.push(m) }

  async function runTurnInternal({ content }) {
    let usage = {}
    let textBuf = ''
    // 请求消息 = system 前缀（api.mjs 抽顶层）+ 派生历史；session/memory 两模式一致
    const requestMessages = () => {
      const msgs = deriveHistory()
      return [{ role: 'system', content: systemPrompt }].filter((m) => m.content).concat(msgs)
    }
    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      const blocks = []
      for await (const chunk of streamMessages({
        model,
        messages: requestMessages(),
        maxTokens,
        signal,
        tools: tools.toolSchemas(),
      })) {
        if (signal.aborted) throw abortError()
        if (chunk.type === 'text') {
          textBuf += chunk.text
          wire.assistant([{ type: 'text', text: chunk.text }])
        } else if (chunk.type === 'thinking') {
          wire.assistant([{ type: 'thinking', thinking: chunk.text }])
        } else if (chunk.type === 'tool_use') {
          blocks.push({ type: 'tool_use', id: chunk.id, name: chunk.name, input: chunk.input })
          wire.assistant([{ type: 'tool_use', id: chunk.id, name: chunk.name, input: chunk.input }])
        } else if (chunk.type === 'usage') {
          usage = addUsage(usage, chunk.usage)
        }
      }
      if (blocks.length === 0) break
      const assistantBlocks = [...(textBuf.trim() ? [{ type: 'text', text: textBuf }] : []), ...blocks]
      pushMemory({ role: 'assistant', content: assistantBlocks })
      // 中间 assistant 条目落盘（工具调用轮）
      if (session) session.appendAssistant(assistantBlocks, { usage, model })
      for (const b of blocks) {
        const result = await executeToolUse(b)
        const toolResultMsg = { role: 'user', content: [{ type: 'tool_result', tool_use_id: b.id, content: result.content, is_error: result.isError }] }
        pushMemory(toolResultMsg)
        if (session) session.appendToolResult({ toolUseId: b.id, content: result.content, isError: result.isError })
      }
      textBuf = ''
    }
    if (textBuf.trim()) {
      pushMemory({ role: 'assistant', content: textBuf })
      // 最终 assistant 条目由 engine 写入（带 usage/model；cli 不再重复落盘）
      if (session) session.appendAssistant([{ type: 'text', text: textBuf }], { usage, model })
    }
    return { usage, model, text: textBuf }
  }

  async function executeToolUse(toolUse) {
    const perm = decideToolPermission({ toolName: toolUse.name, input: toolUse.input, skipPermissions: opts.skipPermissions })
    if (perm.decision === 'deny') return { content: '用户拒绝执行该操作', isError: true }
    if (perm.decision === 'ask') {
      wire.controlRequest({
        requestId: 'req-' + toolUse.id,
        toolName: toolUse.name,
        toolUseId: toolUse.id,
        input: toolUse.input,
        reason: perm.reason || '',
      })
      const decision = await new Promise((resolvePromise) => {
        approvalWaiters.set(toolUse.id, resolvePromise)
      })
      if (decision?.behavior !== 'allow') {
        return { content: decision?.message || '用户拒绝执行该操作', isError: true }
      }
    }
    return tools.run(toolUse, {})
  }

  return {
    signal,
    toolNames: tools.toolNames,
    toolSchemas: () => tools.toolSchemas(),
    abort() { signal.aborted = true },
    seedHistory(entries) {
      if (!session) memoryHistory.push(...entries.filter((m) => m.role !== 'system'))
    },
    seedCompactCount(n) { /* session 已从日志恢复 compactCount；兼容保留 */ },
    resolveApproval(toolUseId, inner) {
      const w = approvalWaiters.get(toolUseId)
      if (w) { approvalWaiters.delete(toolUseId); w(inner) }
    },
    getTurnStats() { return turnStats },
    async runTurn({ content, msg }) {
      signal.aborted = false
      const t0 = Date.now()
      if (session) session.appendUser(String(content ?? ''))
      else pushMemory({ role: 'user', content: String(content ?? '') })
      const { usage, model: turnModel, text } = await runTurnInternal({ content })
      const durationMs = Date.now() - t0
      // turnStats 每轮尾部产出（health/result/stats 共用）
      turnStats.push({ usage, durationMs, model: turnModel, ts: new Date().toISOString(), compactCount: session ? session.compactCount() : 0 })
      return { usage, model: turnModel, text, durationMs }
    },
  }
}
```

注意：mock 流 `turn` 计数依赖 user 消息数——tool_result user 条目混入会导致计数偏移，需同步修 mock（Step 5）。

- [ ] **Step 4: 运行确认 engine-session 测试通过**

Run: `node --test server/engine-session.test.mjs`
Expected: PASS（usage 20/40 累计、中间条目落盘、turnStats）

- [ ] **Step 5: 修 mock 流 turn 计数（api.mjs）+ cli 适配**

`kernel/api.mjs` 的 `mockStream` 中，user 计数与 tool_result 检测需排除工具结果消息（它们以 user 角色进入模型输入，但不是用户新轮次）：

```js
async function* mockStream({ messages, signal }) {
  // tool_result user 消息不是"新轮次"：计数与 lastText 提取都要跳过
  const realUser = (messages || []).filter(
    (m) => m.role === 'user' && !(Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result'))
  )
  const lastUser = realUser[realUser.length - 1]
  const lastContent = lastUser?.content
  const lastText = typeof lastContent === 'string'
    ? lastContent
    : (Array.isArray(lastContent) ? lastContent.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '')
  const toolResults = (messages || []).filter(
    (m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result')
  )
  // ...（其余分支不变；普通回合 turn 数用 realUser.length）
}
```

`kernel/cli.mjs`：
- `createEngine({ opts, wire, session: store })`（传入 session）
- 移除 `store.append(store.assistantEntry([{ type: 'text', text }], { usage, model: turnModel }))`（engine 已写）
- `wire.result(usage, { duration_ms: result.durationMs })`
- handleUser 解构增加 `durationMs`
- resume 块简化为 `if (args.resume) { await store.load() }`（engine 已从 session 派生；seedHistory 仅内存模式用，cli 不再调用）

```js
const { usage, text, model: turnModel, durationMs } = await engine.runTurn({ content, msg })
wire.result(usage, { duration_ms: durationMs })
```

- [ ] **Step 6: 回归既有测试**

Run: `node --test server/kernel-engine.test.mjs server/kernel-contract.test.mjs server/kernel-bridge.test.mjs server/tools-schema.test.mjs server/api-protocol.test.mjs server/context.test.mjs server/session-surface.test.mjs`
Expected: PASS（尤其 kernel-engine「transcript 落盘 2 条目」「resume turn 从 2 开始」「tool+approval 闭环」——mock turn 计数修复保证 turn 数正确）

- [ ] **Step 7: Commit**

```bash
git add kernel/engine.mjs kernel/cli.mjs kernel/api.mjs server/engine-session.test.mjs
git commit -m "feat(kernel): engine 迁移 session 派生（usage 累计/中间条目落盘/turnStats）"
```

---

### Task 6: 阶段3 —— kernel/compact.mjs 两阶段压缩器（裁剪 / 摘要 / 切点 / 日志锁 / 溢出恢复）

**Files:**
- Create: `kernel/compact.mjs`
- Modify: `kernel/api.mjs`（mock 扩展：`系统压缩指令` 检测 → 返回 `YFW_MOCK_COMPACT_RESPONSE` 或 `<compacted-summary>`；`YFW_MOCK_OVERFLOW=once` → 非 summarizer 调用抛一次 context_window_exceeded）
- Modify: `kernel/engine.mjs`（pre-step 测压检查点、溢出 retry 循环、compactor 接入）
- Test: `server/compact.test.mjs`（新建）

**Interfaces:**
- Consumes: Task 3 的 context.mjs（estimate/estimateMessage/contextWindowFor）；Task 4 的 session；Task 5 的 engine
- Produces:
  - `pruneToolResult(content, { budget = 20000 })` → `{ text, truncated, note }`（结构感知：表格采样/代码行边界/JSON 键名+错误行）
  - `findCutPoint({ messages, retainTokens, estimateMessage })` → `{ start, covered } | null`（切点纪律；open tail → null）
  - `assembleSummaryRequest({ system, messages, cut, lastSummary })` → 消息数组（前缀对齐主请求：system+工具+旧消息+`<compacted-summary>`+COMPACTION_INSTRUCTION）
  - `extractSummary(text)` → `<compacted-summary>` 标签内文本 | null
  - `createCompactor({ session, context, model, maxTokens, wire, signal, env })` → `{ maybeCompact({ system }), forceCompact({ system }) }`

- [ ] **Step 1: 写失败测试（纯函数 + 集成）**

`server/compact.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneToolResult, findCutPoint, extractSummary, assembleSummaryRequest, createCompactor } from '../kernel/compact.mjs'
import { estimateMessage, contextWindowFor } from '../kernel/context.mjs'
import { createSessionStore } from '../kernel/session.mjs'
import { createEngine } from '../kernel/engine.mjs'

test('结构感知裁剪：超长表格保留表头+采样+合计尾行，不切行中', () => {
  const lines = ['编号,名称,金额']
  for (let i = 1; i <= 500; i++) lines.push(`${i},项目${i}${'x'.repeat(60)},${i * 10}`) // 行 ~75 字符，总 ~37.5K > 20000
  lines.push('合计,总计,5000')
  const big = lines.join('\n')
  assert.ok(big.length > 20000)
  const r = pruneToolResult(big)
  assert.equal(r.truncated, true)
  assert.ok(r.note.includes('已截断'))
  const keptLines = r.text.split('\n')
  assert.equal(keptLines[0], '编号,名称,金额') // 表头保留
  assert.equal(keptLines[keptLines.length - 1], '合计,总计,5000') // 合计尾行保留
  for (const l of keptLines) assert.ok(!l.includes('\r')) // 完整行
})

test('裁剪不切代码行中间：首部/尾部完整行保留', () => {
  const head = ['const fs = require("fs")', 'function main() {', '  console.log("start")']
  const body = []
  for (let i = 0; i < 400; i++) body.push(`  const v${i} = ${i}; // ${'x'.repeat(60)}`)
  const tail = ['  return 0', '}']
  const big = [...head, ...body, ...tail].join('\n')
  const r = pruneToolResult(big)
  assert.equal(r.truncated, true)
  const kept = r.text.split('\n')
  assert.ok(kept[0].startsWith('const fs'))
  assert.equal(kept[kept.length - 1], '}')
})

test('切点纪律：不拆 tool-call/result 配对；open tail 返回 null；只切 user 边界', () => {
  const msgs = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'out' }] },
    { role: 'assistant', content: 'a2' },
  ]
  // open tail：最后一条 assistant 带 tool_use → null
  const openTail = findCutPoint({ messages: [...msgs, { role: 'assistant', content: [{ type: 'tool_use', id: 'u', name: 'Bash', input: {} }] }], retainTokens: 10, estimateMessage })
  assert.equal(openTail, null)
  // 正常：遮蔽完整 turns，保留起点是 user
  const cut = findCutPoint({ messages: msgs, retainTokens: 10, estimateMessage })
  assert.ok(cut)
  assert.equal(cut.covered[0].role, 'user')
  assert.equal(cut.covered[cut.covered.length - 1].role, 'assistant') // 遮蔽以完整回复结束
  const kept = msgs.slice(cut.start)
  assert.equal(kept[0].role, 'user')
})

test('extractSummary 提取 <compacted-summary> 标签内容', () => {
  const s = extractSummary('前文\n<compacted-summary>\n9 节 checkpoint 内容\n</compacted-summary>\n后文')
  assert.ok(s.includes('9 节 checkpoint'))
  assert.equal(extractSummary('没有标签'), null)
})

test('assembleSummaryRequest 前缀对齐主请求（system+旧消息+前次摘要+指令）', () => {
  const msgs = [
    { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' },
  ]
  const cut = { start: 2, covered: msgs.slice(0, 2) }
  const req = assembleSummaryRequest({ system: 'SYS', messages: msgs, cut, lastSummary: null })
  const roles = req.map((m) => m.role)
  assert.deepEqual(roles, ['user', 'assistant', 'user']) // 被遮蔽区间 + 摘要指令（user）
  const last = req[req.length - 1]
  assert.equal(last.role, 'user')
  assert.ok(last.content.includes('compacted-summary'))
  assert.ok(last.content.includes('Goal'))
})

test('压缩集成（YFW_MOCK_API）：超阈值 → 摘要 replace 落地 → surface 派生正确', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'compact-'))
  try {
    const events = []
    const wire = { assistant: (b) => events.push({ type: 'assistant' }), result: () => events.push({ type: 'result' }), controlRequest: () => {}, summary: () => {}, health: () => {} }
    const session = createSessionStore({ configDir: dir, cwd: 'proj', sessionId: '00000000-0000-0000-0000-000000000004' })
    const compactEvents = []
    const compactor = createCompactor({
      session,
      context: { window: 500, thresholdRatio: 0.8, retainRatio: 0.16, estimate: (r) => ({ total: (r.messages?.length ?? 0) * 50 }), estimateMessage: () => 50, estimateHistory: (msgs) => (msgs?.length ?? 0) * 50 },
      model: 'm', maxTokens: 100, wire: { ...wire, summary: (t, c) => compactEvents.push({ type: 'summary', c }) },
      env: { YFW_MOCK_API: '1' },
    })
    process.env.YFW_MOCK_API = '1'
    process.env.YFW_MOCK_COMPACT_RESPONSE = '1'
    for (let i = 1; i <= 5; i++) { session.appendUser(`q${i}`); session.appendAssistant([{ type: 'text', text: 'a'.repeat(100) }]) }
    // 10 条消息 × 50 = 500 ≥ 阈值 400 → 触发；遮蔽前 8 条 [U1..A4]，保留 [U5,A5]
    const r = await compactor.maybeCompact({ system: 'S', messages: session.deriveMessages() })
    assert.equal(r.action, 'summarized')
    assert.equal(session.compactCount(), 1)
    const msgs = session.deriveMessages()
    assert.ok(msgs.some((m) => Array.isArray(m.content) && m.content.some((b) => b?.text === '摘要输出')))
    assert.ok(session.getSurface().replaceGeneration >= 1)
    delete process.env.YFW_MOCK_API
    delete process.env.YFW_MOCK_COMPACT_RESPONSE
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('溢出恢复：context_window_exceeded → forceCompact → retry 成功（replaceGeneration 前进才 retry）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'overflow-'))
  try {
    const events = []
    const wire = { assistant: (b) => events.push({ type: 'assistant' }), result: () => events.push({ type: 'result' }), controlRequest: () => {}, summary: () => {}, health: () => {} }
    const session = createSessionStore({ configDir: dir, cwd: 'proj', sessionId: '00000000-0000-0000-0000-000000000005' })
    const compactor = createCompactor({
      session,
      context: { window: 1000, thresholdRatio: 0.8, retainRatio: 0.16, estimate: (r) => ({ total: (r.messages?.length ?? 0) * 50 }), estimateMessage: () => 50, estimateHistory: (msgs) => (msgs?.length ?? 0) * 50 },
      model: 'm', maxTokens: 100, wire, env: process.env,
    })
    process.env.YFW_MOCK_API = '1'
    process.env.YFW_MOCK_OVERFLOW = 'once' // 非 summarizer 调用抛一次溢出
    process.env.YFW_MOCK_COMPACT_RESPONSE = '1'
    const engine = createEngine({
      opts: { model: 'm', addDirs: [dir], skipPermissions: true, systemPrompt: 'S' },
      wire, session, compactor,
    })
    for (let i = 1; i <= 5; i++) { session.appendUser(`q${i}`); session.appendAssistant([{ type: 'text', text: 'a'.repeat(100) }]) }
    // 第六轮：pre-step 估值 550 < 阈值 800 不触发；API 抛溢出 → forceCompact（遮蔽 3 轮）
    // → replaceGeneration 前进 → retry 成功。压缩后可见 user 只剩 U4/U5/q6 → mock turn=3
    const out = await engine.runTurn({ content: 'q6' })
    assert.ok(out.text.startsWith('mock: q6'))
    assert.equal(session.compactCount(), 1)
    assert.ok(session.getSurface().replaceGeneration >= 1)
    delete process.env.YFW_MOCK_API
    delete process.env.YFW_MOCK_OVERFLOW
    delete process.env.YFW_MOCK_COMPACT_RESPONSE
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test server/compact.test.mjs`
Expected: FAIL —— compact.mjs 模块不存在

- [ ] **Step 3: 实现 kernel/compact.mjs（纯函数）**

```js
// YFW-turbo 两阶段压缩器（docs/superpowers/specs/2026-08-20-yfw-turbo-inner-core-design.md §5）
// ---------------------------------------------------------------------------
// 阶段① 免模型结构感知裁剪（ToolResultPruner）：表格采样/代码行边界/JSON 键名+错误行
// 阶段② 主模型摘要：前缀对齐主请求（KV 缓存复用）+ <compacted-summary> 9 节 checkpoint
// 切点纪律：只切 turn 边界；tool-call/result 配对不可拆；open tail 返回 null。
// 日志锁：compaction/start（占位）→ compaction/summary（落地）；孤儿 start 加载回滚。
import { streamMessages } from './api.mjs'

export const COMPACTION_INSTRUCTION =
  '系统压缩指令：请将以下旧对话内容压缩为一份 <compacted-summary> 结构化检查点，' +
  '包含 9 节：Goal / Progress / Blockers / Next Steps / Key Facts / Decisions / Artifacts / Open Questions / Continuation。' +
  '只输出 <compacted-summary> 与 </compacted-summary> 之间的内容，尽可能简短但保留全部关键事实、数字与决策。'

// —— 结构感知裁剪（确定性零成本；按行操作天然不切行中）——
function detectKind(lines) {
  const head = lines.slice(0, 10).join('\n')
  if (/[，,]/.test(head) && lines.length > 20) return 'table'
  if (/^\s*[{[]/.test(head) || head.includes('"key"') || head.includes('"name"')) return 'json'
  if (lines.some((l) => /(ERROR|error|exception|stderr)/.test(l))) return 'log'
  if (/\n[\t ]*(?:const|let|function|class|import|export|def|echo|SELECT)/.test('\n' + head)) return 'code'
  return 'plain'
}

function pruneTable(lines) {
  const kept = [lines[0]]
  const step = Math.max(1, Math.floor((lines.length - 2) / 20))
  for (let i = 1; i < lines.length - 1; i += step) kept.push(lines[i])
  if (lines.length > 1) kept.push(lines[lines.length - 1]) // 合计尾行
  return kept
}
function pruneCode(lines) {
  const headCount = Math.max(5, Math.floor(lines.length * 0.15))
  const tailCount = Math.max(5, Math.floor(lines.length * 0.15))
  return [...lines.slice(0, headCount), '// …（中间省略 ' + (lines.length - headCount - tailCount) + ' 行）…', ...lines.slice(-tailCount)]
}
function pruneJsonOrLog(lines) {
  const errLines = lines.filter((l) => /(ERROR|error|exception|stderr)/.test(l))
  const head = lines.slice(0, 30)
  const tail = lines.slice(-10)
  const merged = [...new Set([...head, ...errLines.slice(0, 20), ...tail])]
  return merged.length ? merged : ['…']
}
function prunePlain(lines) {
  return [...lines.slice(0, 50), '…（中间省略 ' + Math.max(0, lines.length - 100) + ' 行）…', ...lines.slice(-50)]
}

export function pruneToolResult(content, { budget = 20000 } = {}) {
  const text = String(content ?? '')
  if (text.length <= budget) return { text, truncated: false, note: '' }
  const lines = text.split('\n')
  const kind = detectKind(lines)
  let keptLines
  if (kind === 'table') keptLines = pruneTable(lines)
  else if (kind === 'code') keptLines = pruneCode(lines)
  else if (kind === 'json' || kind === 'log') keptLines = pruneJsonOrLog(lines)
  else keptLines = prunePlain(lines)
  const note =
    `已截断：原 ${text.length} 字符 / ${lines.length} 行，仅保留结构采样（${keptLines.length} 行）。` +
    `可对该片段追问，或我用 Read offset/limit 补读`
  return { text: keptLines.join('\n'), truncated: true, note, kind }
}

// —— 切点纪律 ——
// messages = deriveMessages() 结果（不含 system）。切点 start 处必须是真实 user 消息
// （保留尾巴从新 turn 开始，遮蔽 [0, start) 结束于完整 turn 回复之后）。
// user 角色消息含两种：真实轮次起点 / tool_result 续接——只有前者可作为保留起点，
// 否则会拆散 assistant tool_use 与其 tool_result 配对。
function isTurnStart(m) {
  return m.role === 'user' && !(Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result'))
}

export function findCutPoint({ messages, retainTokens, estimateMessage }) {
  if (!Array.isArray(messages) || messages.length === 0) return null
  const last = messages[messages.length - 1]
  // open tail：最后一条 assistant 带 tool_use → 进行中 turn 不可切
  if (last.role === 'assistant' && Array.isArray(last.content) && last.content.some((b) => b?.type === 'tool_use')) return null
  // 从尾部向前累计保留预算（保留 = [idx, end)）
  let acc = 0
  let idx = messages.length
  while (idx > 0 && acc < retainTokens) { idx--; acc += estimateMessage(messages[idx]) }
  // 起点向后（向更早）对齐到最近完整 turn 边界：保留起点必须是真实 user 消息。
  // 估算位置落在工具回合中间时，把整轮收回保留区，遮蔽区间相应前移——保证
  // assistant tool_use 与其 tool_result 配对不因切点拆散。
  let start = idx
  while (start > 0 && !isTurnStart(messages[start])) start--
  if (start <= 0 || start >= messages.length) return null
  return { start, covered: messages.slice(0, start) }
}

// —— 摘要请求组装（前缀对齐主请求：system + 旧消息 + 前次摘要 + 指令）——
export function assembleSummaryRequest({ system, messages, cut, lastSummary }) {
  const covered = cut.covered || []
  const body = []
  if (lastSummary) body.push({ role: 'user', content: `<compacted-summary>${lastSummary}</compacted-summary>` })
  body.push(...covered)
  body.push({
    role: 'user',
    content: COMPACTION_INSTRUCTION + (system ? `\n\n（系统提示开头：${String(system).slice(0, 200)}…）` : ''),
  })
  return body
}

export function extractSummary(text) {
  const m = String(text ?? '').match(/<compacted-summary>([\s\S]*?)<\/compacted-summary>/)
  return m ? m[1].trim() : null
}

// —— 压缩器编排（pre-step 测压 / forceCompact 溢出兜底）——
export function createCompactor({ session, context, model, maxTokens, wire, signal, env = process.env }) {
  let summaryInFlight = false
  let lastSummary = null
  let consecutiveFailures = 0

  async function runSummarizer({ system, messages, cut }) {
    const req = assembleSummaryRequest({ system, messages, cut, lastSummary })
    let buf = ''
    for await (const chunk of streamMessages({ model, messages: req, maxTokens, signal, tools: [] })) {
      if (chunk.type === 'text') buf += chunk.text
    }
    return buf
  }

  async function summarize({ system, messages }) {
    if (summaryInFlight) return { action: 'none', reason: 'lock' } // 内存锁：拒绝并发压缩
    summaryInFlight = true
    try {
      const window = context.window ?? 200_000
      const retainTokens = Math.floor(window * (context.retainRatio ?? 0.16))
      const cut = findCutPoint({ messages, retainTokens, estimateMessage: context.estimateMessage })
      if (!cut) return { action: 'none', reason: 'no-cut-point' }
      const coveredTokens = context.estimateHistory ? context.estimateHistory(cut.covered) : cut.covered.length * 100
      const retries = Number(env.CLAUDE_CODE_COMPACTION_RETRIES || 3)
      let summary = null
      let converged = false
      for (let attempt = 0; attempt < retries; attempt++) {
        const text = await runSummarizer({ system, messages, cut })
        const s = extractSummary(text)
        if (!s) { consecutiveFailures++; continue }
        const summaryTokens = Math.ceil(s.length / 4)
        if (summaryTokens < coveredTokens) { summary = s; converged = true; break }
        consecutiveFailures++
        // 收敛失败：下一次重试靠 COMPACTION_INSTRUCTION 已内嵌"尽可能简短"；此处不再追加
      }
      if (!converged || !summary) {
        consecutiveFailures++
        return { action: 'none', reason: 'no-convergence', failures: consecutiveFailures }
      }
      consecutiveFailures = 0
      // 落地：日志锁（start 占位 → summary 落地 replace）+ 内存锁释放
      // covered 来自 deriveMessages()（对象引用一致），经 session 反查真实 seq
      const coveredSeqs = session.seqsForMessages(cut.covered)
      session.appendCompactionStart(coveredSeqs)
      session.appendCompactionSummary({ summary, coveredSeqs })
      lastSummary = summary
      wire.summary?.(summary, session.compactCount())
      return { action: 'summarized', summary, compactCount: session.compactCount() }
    } finally {
      summaryInFlight = false
    }
  }

  return {
    // pre-step 测压：先裁剪（阶段①），仍超再摘要（阶段②）
    async maybeCompact({ system, messages }) {
      const window = context.window ?? 200_000
      const threshold = Math.floor(window * (context.thresholdRatio ?? 0.8))
      const est = context.estimate ? context.estimate({ system, messages }) : { total: 0 }
      if (est.total < threshold) return { action: 'none', reason: 'below-threshold' }
      // 阶段① 免模型裁剪（对超大 tool_result 就地替换为结构采样）
      const budget = Number(env.CLAUDE_CODE_TOOL_RESULT_BUDGET_BYTES || env.CLAUDE_CODE_TOOL_RESULT_BUDGET || 20000)
      let prunedAny = false
      for (const m of messages) {
        if (!Array.isArray(m.content)) continue
        for (const b of m.content) {
          if (b?.type !== 'tool_result' || typeof b.content !== 'string') continue
          const r = pruneToolResult(b.content, { budget })
          if (r.truncated) {
            b.content = r.text + '\n\n' + r.note
            b.__pruned = true
            prunedAny = true
          }
        }
      }
      if (prunedAny) {
        const est2 = context.estimate({ system, messages })
        if (est2.total < threshold) return { action: 'pruned', reason: 'tool-result-pruned' }
      }
      // 阶段② 主模型摘要
      return summarize({ system, messages })
    },
    // 溢出兜底：跳过阈值判定直接强制压缩；仅当 replaceGeneration 前进（调用方校验）才 retry
    async forceCompact({ system, messages }) {
      return summarize({ system, messages })
    },
    lastSummary: () => lastSummary,
  }
}
```

- [ ] **Step 4: mock 扩展（api.mjs）——压缩摘要指令检测 + 溢出模拟**

在 `mockStream` 中追加两个分支（放在 `[mock:tool]` 分支之前）：

```js
  // 压缩摘要调用：检测 COMPACTION_INSTRUCTION → 返回 mock 摘要（收敛用）
  if (lastText && lastText.includes('系统压缩指令')) {
    const body = process.env.YFW_MOCK_COMPACT_RESPONSE === '1'
      ? '<compacted-summary>摘要输出</compacted-summary>'
      : '<compacted-summary>mock 摘要</compacted-summary>'
    yield* streamText(body, signal)
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 溢出模拟：YFW_MOCK_OVERFLOW=once → 非 summarizer 调用抛一次 context_window_exceeded
  if (process.env.YFW_MOCK_OVERFLOW === 'once' && !String(lastText || '').includes('系统压缩指令')) {
    if (process.env.YFW_MOCK_OVERFLOW_CONSUMED === '1') { /* 已抛过 */ } else {
      process.env.YFW_MOCK_OVERFLOW_CONSUMED = '1'
      throw new Error('context_window_exceeded: 请求超出模型上下文窗口')
    }
  }
```

（`YFW_MOCK_OVERFLOW_CONSUMED` 用进程级 env 标记一次消费——单测进程内有效。）

- [ ] **Step 5: engine.mjs 接入 pre-step 测压 + 溢出 retry 循环**

`kernel/engine.mjs`：createEngine 增加 `compactor` 可选参数；`runTurnInternal` 请求循环外包：

```js
  async function runTurnInternal({ content }) {
    let usage = {}
    let textBuf = ''
    let overflowRetries = 0
    const maxOverflowRetries = Number(process.env.CLAUDE_CODE_MAX_OVERFLOW_RETRIES || 3)
    const requestMessages = () => {
      const msgs = deriveHistory()
      return session
        ? [{ role: 'system', content: systemPrompt }].filter((m) => m.content).concat(msgs)
        : msgs
    }
    // pre-step 测压检查点：每轮请求前（工具结果/上轮产物已落日志之后）
    async function preStep() {
      if (!compactor || !session) return
      const msgs = session.deriveMessages()
      const sys = systemPrompt || ''
      await compactor.maybeCompact({ system: sys, messages: msgs })
    }
    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      await preStep()
      let overflowed = false
      try {
        for await (const chunk of streamMessages({ model, messages: requestMessages(), maxTokens, signal, tools: tools.toolSchemas() })) {
          // ...（原有 chunk 分发不变）
        }
      } catch (err) {
        // 溢出兜底：强制压缩 → 仅 replaceGeneration 前进才 retry 同一请求
        if (/context_window_exceeded/.test(err?.message || '') && compactor && session && overflowRetries < maxOverflowRetries) {
          const genBefore = session.getSurface().replaceGeneration
          await compactor.forceCompact({ system: systemPrompt, messages: session.deriveMessages() })
          const genAfter = session.getSurface().replaceGeneration
          if (genAfter > genBefore) { overflowRetries++; overflowed = true }
          else return { usage, model, text: '', error: 'overflow-compact-failed' }
        } else {
          throw err
        }
      }
      if (overflowed) { continue } // 压缩落地 → 重试同一轮
      // ...（原 blocks 处理不变）
    }
    // ...
  }
```

（实现时保持原 chunk 分发 / blocks / tool 循环逻辑，仅在外层加 preStep 与 overflow retry 包装。）

- [ ] **Step 6: 运行确认通过**

Run: `node --test server/compact.test.mjs`
Expected: PASS（6 个测试；溢出恢复测试依赖 mock 的 `context_window_exceeded` 抛一次 + forceCompact 成功）

- [ ] **Step 7: 回归既有测试**

Run: `node --test server/kernel-engine.test.mjs server/kernel-contract.test.mjs server/kernel-bridge.test.mjs`
Expected: PASS（compactor 默认未注入 → preStep 短路，行为不变）

- [ ] **Step 8: Commit**

```bash
git add kernel/compact.mjs kernel/api.mjs kernel/engine.mjs server/compact.test.mjs
git commit -m "feat(kernel): compact.mjs 两阶段压缩（结构裁剪/摘要/切点/日志锁/溢出恢复）"
```

---

### Task 7: 阶段4 —— kernel/health.mjs 健康监控 + yfw_health/yfw_summary 事件

**Files:**
- Create: `kernel/health.mjs`
- Modify: `kernel/protocol.mjs`（makeWire 加 `health(data)` / `summary(text, compactCount)` 构造器）
- Modify: `kernel/engine.mjs`（每轮尾部 health.record(turnStats)；装配 createHealth）
- Modify: `kernel/cli.mjs`（engine 构造传入 health）
- Test: `server/health.test.mjs`（新建）

**Interfaces:**
- Consumes: Task 5 的 turnStats 形状 `{ usage, durationMs, model, ts, compactCount }`
- Produces:
  - `modelCap(model)` → 断崖点（pro → 6，其余 → 3）
  - `computeHealthScore({ compactCount, chainDepth, remainingPct, remainingTurns, failures, redundancyRatio, toolResultShare, model })` → `{ score, tier, suggestNewSession, reason }`（tier ∈ green/yellow/red；<5 turns 强制 red）
  - `shouldJudge({ tier, judgeEnabled, lastJudgeAt, now, cooldownMs })` → boolean（默认关；仅红档；冷却）
  - `createHealth({ wire, model, contextWindow, env })` → `{ record(turnStats), recordCompaction(summary, count), getState() }`
  - `makeWire()` 新增 `health(data)` → `{ type: 'yfw_health', ...data }`、`summary(text, compactCount)` → `{ type: 'yfw_summary', text, compactCount }`

- [ ] **Step 1: 写失败测试**

`server/health.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeHealthScore, modelCap, shouldJudge, createHealth } from '../kernel/health.mjs'

test('档位边界：40/70 分界；压缩次数驱动', () => {
  const base = { chainDepth: 0, remainingPct: 50, remainingTurns: 20, failures: 0, redundancyRatio: 0, toolResultShare: 0 }
  const g = computeHealthScore({ ...base, compactCount: 0, model: 'deepseek-v4-flash' })
  assert.equal(g.tier, 'green')
  const y = computeHealthScore({ ...base, compactCount: 1, model: 'deepseek-v4-flash' }) // 70×1/3=23 → max(40,23)=40
  assert.equal(y.tier, 'yellow')
  const r = computeHealthScore({ ...base, compactCount: 3, model: 'deepseek-v4-flash' }) // 70×3/3=70
  assert.equal(r.tier, 'red')
  assert.equal(r.suggestNewSession, true)
})

test('模型自适应：flash 3 次压缩=红；pro[1m] 3 次=黄（cap 6）', () => {
  const base = { chainDepth: 0, remainingPct: 50, remainingTurns: 20, failures: 0, redundancyRatio: 0, toolResultShare: 0 }
  const f = computeHealthScore({ ...base, compactCount: 3, model: 'deepseek-v4-flash' })
  const p = computeHealthScore({ ...base, compactCount: 3, model: 'deepseek-v4-pro' })
  assert.equal(f.tier, 'red')
  assert.equal(p.tier, 'yellow')
  assert.equal(modelCap('deepseek-v4-pro'), 6)
  assert.equal(modelCap('deepseek-v4-flash'), 3)
})

test('剩余水位与剩余轮数因子；<5 轮强制红', () => {
  const base = { compactCount: 0, chainDepth: 0, failures: 0, redundancyRatio: 0, toolResultShare: 0, model: 'deepseek-v4-flash' }
  const lowWater = computeHealthScore({ ...base, remainingPct: 10, remainingTurns: 20 }) // <12% → +70
  assert.equal(lowWater.tier, 'red')
  const lowTurns = computeHealthScore({ ...base, remainingPct: 50, remainingTurns: 4 }) // <5 → +30 且强制红
  assert.equal(lowTurns.tier, 'red')
})

test('冗余率与分区失衡因子各 +10', () => {
  const base = { compactCount: 0, chainDepth: 0, remainingPct: 50, remainingTurns: 20, failures: 0, model: 'deepseek-v4-flash' }
  const red = computeHealthScore({ ...base, redundancyRatio: 0.6, toolResultShare: 0.6 })
  assert.equal(red.score, 20)
  assert.equal(red.tier, 'green') // 20 < 40 仍绿
})

test('shouldJudge：默认关不触发；红档开启后才触发且走冷却', () => {
  const now = Date.now()
  assert.equal(shouldJudge({ tier: 'red', judgeEnabled: false, lastJudgeAt: 0, now }), false)
  assert.equal(shouldJudge({ tier: 'green', judgeEnabled: true, lastJudgeAt: 0, now }), false)
  assert.equal(shouldJudge({ tier: 'red', judgeEnabled: true, lastJudgeAt: 0, now }), true)
  assert.equal(shouldJudge({ tier: 'red', judgeEnabled: true, lastJudgeAt: now, now, cooldownMs: 300000 }), false)
})

test('createHealth：非 green 档位去抖只发一次 yfw_health；recordCompaction 发 yfw_summary', () => {
  const events = []
  const wire = {
    health: (d) => events.push({ type: 'yfw_health', ...d }),
    summary: (t, c) => events.push({ type: 'yfw_summary', text: t, compactCount: c }),
  }
  const h = createHealth({ wire, model: 'deepseek-v4-flash', contextWindow: 200_000 })
  h.record({ usage: {}, durationMs: 5, model: 'deepseek-v4-flash', ts: 't', compactCount: 0 })
  assert.equal(events.filter((e) => e.type === 'yfw_health').length, 0) // green 不发
  h.recordCompaction('摘要A', 1)
  const sum = events.filter((e) => e.type === 'yfw_summary')
  assert.equal(sum.length, 1)
  assert.equal(sum[0].text, '摘要A')
  assert.ok(events.some((e) => e.type === 'yfw_health')) // 压缩后档位变化 → 发
  const before = events.length
  h.record({ usage: {}, durationMs: 5, model: 'deepseek-v4-flash', ts: 't', compactCount: 2 })
  assert.equal(events.length, before) // 同档去抖：不再发
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test server/health.test.mjs`
Expected: FAIL —— health.mjs 不存在

- [ ] **Step 3: 实现 kernel/health.mjs + protocol.mjs 事件构造器**

`kernel/health.mjs`：

```js
// YFW-turbo 健康监控（docs/superpowers/specs/2026-08-20-yfw-turbo-inner-core-design.md §6/§6.3）
// ---------------------------------------------------------------------------
// 纯计算 + 去抖状态机。消费 engine 每轮尾部 turnStats；产出 yfw_health / yfw_summary。
// 多因子加权（压缩次数/链深度/剩余水位/剩余轮数/失败/冗余率/分区失衡），模型自适应。
// 全程 try/catch 静默降级，绝不影响主流程。LLM-as-Judge 默认关闭（可选调用）。

// 断崖点：flash 3 / pro[1m] 6
export function modelCap(model) {
  return /pro/i.test(String(model || '')) ? 6 : 3
}

// 模型自适应归一化：attentionCeiling = min(有效窗口×0.9, 名义窗口×0.8)
export function attentionCeiling(window = 200_000) {
  return Math.min(window * 0.9, window * 0.8)
}

export function computeHealthScore({
  compactCount = 0, chainDepth = 0, remainingPct = 100, remainingTurns = 99,
  failures = 0, redundancyRatio = 0, toolResultShare = 0, model = '',
} = {}) {
  const cap = modelCap(model)
  let score = 0
  let forceRed = false
  if (compactCount > 0) score = Math.max(40, Math.round((70 * compactCount) / cap))
  if (chainDepth >= 2) score += (chainDepth - 1) * 15
  if (remainingPct < 12) score += 70
  else if (remainingPct < 25) score += 45
  if (remainingTurns < 5) { score += 30; forceRed = true }
  else if (remainingTurns < 10) score += 20
  score += Math.min(3, failures) * 10
  if (redundancyRatio > 0.5) score += 10
  if (toolResultShare > 0.5) score += 10
  const tier = score >= 70 || forceRed ? 'red' : score >= 40 ? 'yellow' : 'green'
  const reason =
    tier === 'red'
      ? `已连续压缩 ${compactCount} 次，剩余约 ${remainingTurns} 轮，建议开启新会话`
      : tier === 'yellow'
        ? `上下文接近压力区（压缩 ${compactCount} 次，剩余 ${Math.round(remainingPct)}% 水位）`
        : '上下文健康'
  return { score, tier, compactCount, remainingPct: Math.round(remainingPct), remainingTurns, suggestNewSession: tier === 'red', reason }
}

// LLM-as-Judge 低频抽检判定：默认关闭；仅红档；冷却期内不重复
export function shouldJudge({ tier, judgeEnabled = false, lastJudgeAt = 0, now = Date.now(), cooldownMs = 300_000 }) {
  if (!judgeEnabled || tier !== 'red') return false
  return now - lastJudgeAt >= cooldownMs
}

export function createHealth({ wire, model = '', contextWindow = 200_000, env = process.env }) {
  let compactCount = 0
  let lastSummary = ''
  let lastTier = null
  let lastJudgeAt = 0
  const recent = [] // 近 10 轮 turnStats
  const failures = { count: 0 }
  const judgeEnabled = env.CLAUDE_CODE_LLM_JUDGE === '1'

  function snapshot() {
    // 剩余水位：最近一轮 usage.input 与 attentionCeiling 的近似（engine 侧可传入精确值，
    // 此处以最近一轮 input_tokens 相对 ceiling 估算）
    const ceiling = attentionCeiling(contextWindow)
    const lastInput = recent.length ? (recent[recent.length - 1].usage?.input_tokens ?? 0) : 0
    const remainingPct = ceiling > 0 ? Math.max(0, 100 - (lastInput / ceiling) * 100) : 100
    const avgPerTurn = recent.length
      ? Math.max(1, Math.round(recent.reduce((s, t) => s + (t.usage?.input_tokens ?? 0), 0) / recent.length))
      : 1000
    const remainingTokens = Math.max(0, ceiling - lastInput)
    const remainingTurns = Math.max(0, Math.floor(remainingTokens / avgPerTurn))
    const chainDepth = recent.reduce((s, t) => s + (t.compactCount > 0 ? 1 : 0), 0)
    return computeHealthScore({
      compactCount, chainDepth, remainingPct, remainingTurns,
      failures: failures.count, redundancyRatio: 0, toolResultShare: 0, model,
    })
  }

  function emitIfChanged() {
    const h = snapshot()
    if (h.tier !== lastTier) {
      lastTier = h.tier
      wire.health?.({ score: h.score, tier: h.tier, compactCount, remainingPct: h.remainingPct, remainingTurns: h.remainingTurns, suggestNewSession: h.suggestNewSession, reason: h.reason })
    }
  }

  return {
    record(turnStats) {
      try {
        recent.push(turnStats)
        if (recent.length > 10) recent.shift()
        if (turnStats.compactCount > compactCount) compactCount = turnStats.compactCount
        emitIfChanged()
      } catch { /* 静默降级 */ }
    },
    recordCompaction(summary, count) {
      try {
        compactCount = count
        lastSummary = summary
        wire.summary?.(summary, count)
        lastTier = null // 强制下一轮重估（档位可能因压缩变化）
        emitIfChanged()
      } catch { /* 静默降级 */ }
    },
    // 红档 Judge 判定（默认关；engine 装配时可注入 runJudge 回调）
    shouldRunJudge() {
      const h = snapshot()
      if (!shouldJudge({ tier: h.tier, judgeEnabled, lastJudgeAt })) return false
      lastJudgeAt = Date.now()
      return true
    },
    getState() { return { compactCount, lastSummary, tier: lastTier, judgeEnabled } },
  }
}
```

`kernel/protocol.mjs` 的 `makeWire` 增加：

```js
    health(data = {}) {
      writeLine(stream, { type: 'yfw_health', ...data })
    },
    summary(text, compactCount) {
      writeLine(stream, { type: 'yfw_summary', text: String(text ?? ''), compactCount })
    },
```

- [ ] **Step 4: engine/cli 装配 health（每轮尾部 record）**

`kernel/engine.mjs` createEngine 增加 `health` 可选参数；`runTurn` 尾部：

```js
      turnStats.push({ usage, durationMs, model: turnModel, ts: new Date().toISOString(), compactCount: session ? session.compactCount() : 0 })
      health?.record(turnStats[turnStats.length - 1])
      return { usage, model: turnModel, text, durationMs }
```

`kernel/cli.mjs` 装配（context + compactor + health 一次接齐；compactor 的 signal 暂传 undefined——cancel 进行中的压缩摘要调用为已知限制，记为 deferred minor）：

```js
import { createHealth } from './health.mjs'
import { createCompactor } from './compact.mjs'
import { contextWindowFor, estimateRequest, estimateMessage, estimateHistory } from './context.mjs'
// main() 内（engine 构造前）：
const maxTokens = Math.max(1, Number(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || 64000))
const contextWindow = contextWindowFor(model)
const context = {
  window: contextWindow,
  thresholdRatio: 0.8,
  retainRatio: 0.16,
  estimate: ({ system, messages }) => estimateRequest({ system, messages }),
  estimateMessage,
  estimateHistory,
}
const compactor = createCompactor({ session: store, context, model, maxTokens, wire, signal: undefined, env: process.env })
const health = createHealth({ wire, model, contextWindow, env: process.env })
const engine = createEngine({ opts: {...}, wire, session: store, health, compactor })
```

- [ ] **Step 5: 运行确认通过**

Run: `node --test server/health.test.mjs`
Expected: PASS（6 个测试）

- [ ] **Step 6: 回归既有测试（health 事件不污染既有 wire 断言）**

Run: `node --test server/kernel-engine.test.mjs server/kernel-contract.test.mjs server/kernel-bridge.test.mjs`
Expected: PASS（green 档不发事件；既有测试收集到 result 前忽略 yfw_* 事件）

- [ ] **Step 7: Commit**

```bash
git add kernel/health.mjs kernel/protocol.mjs kernel/engine.mjs kernel/cli.mjs server/health.test.mjs
git commit -m "feat(kernel): health.mjs 健康分/yfw_health/yfw_summary（去抖+模型自适应+Judge默认关）"
```

---

### Task 8: 阶段5 —— bridge /transcript/stats 聚合端点 + OPENAI env 注入 + GUI 折叠

**Files:**
- Modify: `server/transcript.mjs`（`aggregateStats(projectsDir)` + `costUsd` 帮助）
- Modify: `server/bridge.mjs`（`/transcript/stats` 路由；`buildChildEnv` 支持 `provider.protocol === 'openai'` → 注入 OPENAI_*）
- Modify: `src/lib/transcriptAdapter.ts`（`transcriptEntryToMessage` 对 `kind === 'compaction'` 返回 null 折叠）
- Test: `server/stats.test.mjs`（新建）+ `src/lib/transcriptAdapter.test.ts`（追加用例）

**Interfaces:**
- Consumes: transcript 文件格式（assistant entry `message.usage` / `message.model` / `timestamp`）；provider 配置结构 `{ id, apiBaseUrl, authToken, primaryModel, subagentModel, contextWindow, models[], protocol? }`
- Produces:
  - `aggregateStats(projectsDir)` → `{ totals: { input_tokens, output_tokens, turns, sessions }, byModel: { [model]: {...} }, byProject: { [proj]: {...} }, byDate: { [YYYY-MM-DD]: {...} } }`
  - `costUsd({ input_tokens, output_tokens, priceTable })` → number（bridge 侧换算；价格表来自 provider 配置）
  - bridge `GET /transcript/stats?project=<cwd>` → `{ ok, stats }`
  - `buildChildEnv` 中 `provider.protocol === 'openai'` → 注入 `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`OPENAI_MODEL`（保留 ANTHROPIC_* 兼容）

- [ ] **Step 1: 写失败测试**

`server/stats.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aggregateStats, costUsd } from '../server/transcript.mjs'

test('aggregateStats：多会话/多模型 transcript 按 项目/模型/日期 聚合', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stats-'))
  try {
    const projA = join(dir, 'proj-a')
    const projB = join(dir, 'proj-b')
    mkdirSync(projA, { recursive: true })
    mkdirSync(projB, { recursive: true })
    const entry = (model, input, output, ts) =>
      JSON.stringify({ type: 'assistant', id: 'x', timestamp: ts, message: { role: 'assistant', content: [], model, usage: { input_tokens: input, output_tokens: output } } })
    writeFileSync(join(projA, '11111111-1111-1111-1111-111111111111.jsonl'), [
      entry('deepseek-v4-flash', 100, 50, '2026-08-20T01:00:00Z'),
      entry('deepseek-v4-flash', 200, 100, '2026-08-20T02:00:00Z'),
      entry('deepseek-v4-pro', 500, 250, '2026-08-21T01:00:00Z'),
      '',
    ].join('\n'))
    writeFileSync(join(projB, '22222222-2222-2222-2222-222222222222.jsonl'), [
      entry('deepseek-v4-flash', 50, 25, '2026-08-20T03:00:00Z'),
      '',
    ].join('\n'))
    const s = aggregateStats(dir)
    assert.equal(s.totals.input_tokens, 850)
    assert.equal(s.totals.output_tokens, 425)
    assert.equal(s.totals.sessions, 2)
    assert.equal(s.byModel['deepseek-v4-flash'].input_tokens, 350)
    assert.equal(s.byModel['deepseek-v4-pro'].input_tokens, 500)
    assert.equal(s.byDate['2026-08-20'].input_tokens, 350)
    assert.equal(s.byProject['proj-a'].output_tokens, 400)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('costUsd：按价格表换算', () => {
  const priceTable = { 'deepseek-v4-flash': { input_per_mtok: 0.1, output_per_mtok: 0.2 } }
  const c = costUsd({ model: 'deepseek-v4-flash', input_tokens: 1000, output_tokens: 500 }, priceTable)
  assert.ok(Math.abs(c - (1000 / 1e6 * 0.1 + 500 / 1e6 * 0.2)) < 1e-9)
})
```

`src/lib/transcriptAdapter.test.ts` 追加用例（沿用该文件既有测试结构）：

```ts
// 在既有 describe 内追加：
it('kind=compaction 条目折叠为 null（GUI 不渲染压缩条目）', () => {
  const entry = {
    type: 'assistant', id: 'c1', timestamp: 't',
    kind: 'compaction', phase: 'summary',
    message: { role: 'assistant', content: [{ type: 'text', text: '<compacted-summary>x</compacted-summary>' }] },
  }
  expect(transcriptEntryToMessage(entry)).toBeNull()
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test server/stats.test.mjs` + `node --test src/lib/transcriptAdapter.test.ts`
Expected: FAIL —— aggregateStats/costUsd 未导出；transcriptEntryToMessage 未折叠 compaction

- [ ] **Step 3: transcript.mjs 实现聚合**

在 `server/transcript.mjs` 末尾追加：

```js
// —— 统计聚合（spec §6.5：按 项目/模型/日期 聚合 token 用量；成本换算在 bridge 侧）——
// usage 数据源：assistant entry.message.usage（engine 已累计多次 API 调用 + 压缩摘要用量）
export function aggregateStats(projectsDir) {
  const totals = { input_tokens: 0, output_tokens: 0, turns: 0, sessions: 0 }
  const byModel = {}
  const byProject = {}
  const byDate = {}
  if (!existsSync(projectsDir)) return { totals, byModel, byProject, byDate }
  const add = (bucket, k, entry) => {
    if (!bucket[k]) bucket[k] = { input_tokens: 0, output_tokens: 0, turns: 0 }
    bucket[k].input_tokens += entry.input_tokens
    bucket[k].output_tokens += entry.output_tokens
    bucket[k].turns += 1
  }
  for (const projName of readdirSync(projectsDir)) {
    const projDir = join(projectsDir, projName)
    let pst
    try { pst = statSync(projDir) } catch { continue }
    if (!pst.isDirectory()) continue
    let sessionSeen = false
    for (const name of readdirSync(projDir)) {
      if (!isUuidFile(name)) continue
      const fp = join(projDir, name)
      let st
      try { st = statSync(fp) } catch { continue }
      if (!st.isFile()) continue
      let text
      try { text = readFileSync(fp, 'utf-8') } catch { continue }
      let sawUsage = false
      for (const line of text.split('\n')) {
        const t = line.trim()
        if (!t) continue
        let e
        try { e = JSON.parse(t) } catch { continue }
        const usage = e?.message?.usage
        if (e?.type !== 'assistant' || !usage || !Number.isFinite(usage.input_tokens)) continue
        const model = e.message.model || 'unknown'
        const day = String(e.timestamp || '').slice(0, 10) || 'unknown'
        const u = {
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: usage.output_tokens ?? 0,
        }
        totals.input_tokens += u.input_tokens
        totals.output_tokens += u.output_tokens
        totals.turns += 1
        add(byModel, model, u)
        add(byProject, projName, u)
        add(byDate, day, u)
        sawUsage = true
      }
      if (sawUsage && !sessionSeen) { sessionSeen = true; totals.sessions += 1 }
    }
  }
  return { totals, byModel, byProject, byDate }
}

// 成本换算（bridge 侧调用；单价表来自 provider 配置，provider 改价无需动内核）
export function costUsd({ model = 'unknown', input_tokens = 0, output_tokens = 0 }, priceTable = {}) {
  const p = priceTable[model] || priceTable.default || {}
  const inRate = Number(p.input_per_mtok) || 0
  const outRate = Number(p.output_per_mtok) || 0
  return (input_tokens / 1e6) * inRate + (output_tokens / 1e6) * outRate
}
```

- [ ] **Step 4: bridge.mjs 路由 + OPENAI env 注入**

`server/bridge.mjs` transcript 路由区（现有 /transcript/list、/transcript/load、/transcript/search 附近）追加：

```js
    // --- /transcript/stats：token 统计聚合（项目/模型/日期），GUI 成本面板数据源 ---
    if (url.pathname === '/transcript/stats') {
      const project = url.searchParams.get('project') || ''
      const base = transcriptBaseDir()
      const stats = project ? aggregateStats(join(base, sanitizePathSegment(project))) : aggregateStats(base)
      // 成本换算：单价表来自 provider 配置
      const cfg = loadConfig()
      const provider = (cfg.providers || []).find((p) => p.id === cfg.activeProvider) || cfg.providers?.[0]
      const priceTable = provider?.pricing || {}
      const withCost = (bucket) => {
        const out = {}
        for (const [k, v] of Object.entries(bucket)) {
          out[k] = { ...v, cost_usd: Number(costUsd({ model: k, input_tokens: v.input_tokens, output_tokens: v.output_tokens }, priceTable).toFixed(4)) }
        }
        return out
      }
      return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({
        ok: true,
        totals: { ...stats.totals, cost_usd: Number(
          Object.entries(stats.byModel).reduce((s, [, v]) => s + costUsd(v, priceTable), 0)
        ).toFixed(4) },
        byModel: withCost(stats.byModel),
        byProject: stats.byProject,
        byDate: stats.byDate,
      }))
    }
```

`buildChildEnv`（现 :586-635）在 ANTHROPIC 注入分支后追加 openai 分支：

```js
  // OpenAI 兼容协议（provider.protocol === 'openai'）：注入 OPENAI_* env（双协议前置项）
  if (provider && provider.protocol === 'openai' && provider.apiBaseUrl && provider.authToken) {
    env.OPENAI_BASE_URL = provider.apiBaseUrl
    env.OPENAI_API_KEY = provider.authToken
    const model = provider.primaryModel || (provider.models && provider.models[0]) || ''
    if (model) env.OPENAI_MODEL = model
    if (provider.contextWindow) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(provider.contextWindow)
    console.log('[bridge] openai-compatible provider:', provider.id, '| model:', model, '| baseUrl:', provider.apiBaseUrl)
  }
```

（注：bridge 侧现有 ANTHROPIC_* 注入分支保持；openai 分支在 provider.protocol 标记时补充 env。ANTHROPIC_MODEL 兼容保留。）

- [ ] **Step 5: transcriptAdapter.ts 折叠 compaction**

`src/lib/transcriptAdapter.ts` 的 `transcriptEntryToMessage` 开头（system compact_boundary 特殊处理之前）加：

```ts
  // 压缩条目（kind=compaction）是 surface 投影元数据，GUI 不渲染，折叠跳过
  if (entry.kind === 'compaction') return null
```

- [ ] **Step 6: 运行确认通过**

Run: `node --test server/stats.test.mjs` + `node --test src/lib/transcriptAdapter.test.ts`
Expected: PASS（新增用例 + 既有 adapter 用例）

- [ ] **Step 7: 回归**

Run: `node --test server/kernel-bridge.test.mjs server/kernel-engine.test.mjs server/kernel-contract.test.mjs`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add server/transcript.mjs server/bridge.mjs src/lib/transcriptAdapter.ts server/stats.test.mjs src/lib/transcriptAdapter.test.ts
git commit -m "feat(bridge): /transcript/stats 聚合端点 + OPENAI env 注入 + GUI 折叠 compaction 条目"
```

---

### Task 9: 阶段6 —— 全量回归

**Files:**
- 无新文件；运行与修复

**Interfaces:**
- Consumes: 全部 Task 1-8 产出
- Produces: 全绿回归基线

- [ ] **Step 1: 运行全量测试**

Run: `node --test "server/*.test.mjs" "electron/*.test.mjs" && node --test src/lib/transcriptAdapter.test.ts`
Expected: 全部 PASS（kernel-engine / kernel-contract / kernel-bridge / tools-schema / api-protocol / context / session-surface / engine-session / compact / health / stats + GUI 侧既有测试）

- [ ] **Step 2: 修复任何回归**

如出现失败：
- 确认 wire 事件形状未被破坏（尤其既有测试对 assistant/result 事件的深比较）
- 确认 mock 流分支顺序（工具结果回合 → 压缩指令 → 溢出模拟 → [mock:tool] → 普通回合）
- 确认 session load 的 async 化在 resume 路径生效（cli main 为 async）

Run（重复 Step 1）直至全绿。

- [ ] **Step 3: 规格覆盖自检（spec §8 测试计划 24 项逐条对照）**

| spec 测试 | 覆盖任务 |
|---|---|
| 1 token 计价/锚点 | Task 3 |
| 2 切点纪律 | Task 6（findCutPoint 测试） |
| 3 行边界裁剪（代码） | Task 6（pruneToolResult 代码用例） |
| 4 结构感知裁剪 | Task 6（表格用例） |
| 5 压缩流程（mock） | Task 6（集成测试） |
| 6 收敛校验 | Task 6（createCompactor retries 循环） |
| 7 溢出恢复 | Task 6（溢出恢复测试） |
| 8 日志锁/崩溃恢复 | Task 4（孤儿 start 回滚测试） |
| 9 usage 累计 | Task 5（engine-session usage 测试） |
| 10 统计聚合 | Task 8（aggregateStats 测试） |
| 11 健康分 | Task 7（档位/自适应/强制红） |
| 12 resume 回归 | Task 5 + Task 4（surface 终态 + compactCount） |
| 13 tools schema 注入 | Task 1 + Task 2（fetch 断言） |
| 14 双协议解析 | Task 2（两解析器相同 chunk 形状） |
| 15 协议选择 | Task 2（detectProtocol） |
| 16 tokenLedger 四区 | Task 3（estimateRequest 四区测试） |
| 17 冗余率 | Task 7（computeHealthScore redundancyRatio 因子） |
| 18 LLM-as-Judge | Task 7（shouldJudge 默认关测试） |
| 19 缓存 usage 解析 | Task 2（normalizeUsage cache_read/creation） |
| 20 summarizer 前缀对齐 | Task 6（assembleSummaryRequest 测试） |
| 21 分段加载 | Task 4（readLines 流式 + 窗口化测试） |
| 22 derive 缓存 | Task 4（缓存命中测试） |
| 23 resume 窗口化恢复 | Task 4（maxEntries 测试） |
| 24 既有回归 | Task 9（全量） |

- [ ] **Step 4: Commit**

```bash
git add .
git commit -m "test(kernel): 全量回归——内层逻辑 9 任务全部落地（压缩/健康/统计/双协议）"
```

---

## Self-Review

**1. Spec coverage**：§3.5 双协议+tools（Task 1-2）；§3.6 前缀缓存（summarizer 前缀对齐 Task 6 assembleSummaryRequest、cache usage 解析 Task 2）；§3.7 资源治理（分段加载/derive 缓存/窗口化 Task 4；拒绝进程池——无对应任务，符合非目标）；§4 事件日志+surface（Task 4）；§5 两阶段压缩（Task 6，含 §5.4 切点/§5.5 日志锁/§5.6 默认值）；§6 健康监控（Task 7，含 §6.3 冗余率/分区失衡/Judge 默认关、§6.5 usage 累加 Task 5 + stats Task 8）；§7 契约分层（事件只增不改、entry 字段可选、result 保持纯 usage）；§8 测试计划 24 项（Task 9 Step 3 对照表全覆盖）；§9 改动文件清单 10 个文件全部覆盖（api/tools/context/compact/health/session/engine/protocol/bridge/transcriptAdapter）。

**2. Placeholder scan**：所有步骤含真实可运行代码；无 TBD/TODO；无"类似 Task N"引用（assembleSummaryRequest/findCutPoint 等重复给出完整实现）。

**3. Type consistency**：`toolSchemas()` 中立形状 `{name, description, input_schema}` 在 Task 1 产出、Task 2 消费（映射 anthropic tools[]/openai function 形状）；`streamMessages({ model, messages, maxTokens, signal, tools })` 在 Task 2 定义、Task 5/6 调用；session 的 `appendUser/appendAssistant/appendToolResult/appendCompactionStart/appendCompactionSummary/deriveMessages/getSurface/compactCount` 在 Task 4 定义、Task 5（engine 落盘/derive）、Task 6（compactor 落地）消费；`findCutPoint` 返回 `{start, covered}` 在 Task 6 定义并供 `assembleSummaryRequest` 消费；`createHealth({ wire, model, contextWindow, env })` 的 `record/recordCompaction` 由 Task 7 engine 装配消费；`turnStats` 形状 `{ usage, durationMs, model, ts, compactCount }` 在 Task 5 产出、Task 7 消费。`estimateRequest` 的 `{total, sections}` 与 `createTokenLedger().record` 四区键名（system/task/tool_result/history）一致。

**已知取舍（记录）**：① 既有 `store.append(store.assistantEntry(...))` 在 cli 中移除、改由 engine 写最终 assistant 条目——kernel-engine「transcript 落盘 2 条目」测试依赖该语义，Task 5 步骤 6 显式回归；② mock turn 计数需排除 tool_result user 消息（Task 5 步骤 5），否则 multi-turn `(turn=N)` 断言偏移；③ health 的 remainingPct 用最近一轮 input_tokens 相对 attentionCeiling 估算（近似，精确值可后续由 engine 传 context 侧精确 token），纯计算可测；④ LLM-as-Judge 本轮只做判定函数 + 默认关占位，不接真实 API 调用（符合 spec「默认关闭」+「结果进 stats 供回归」的最小落地）。

---

**Plan complete and saved to `docs/superpowers/plans/2026-08-20-yfw-turbo-inner-core.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
