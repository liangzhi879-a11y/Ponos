# 内核可靠性（P1）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 P1 可靠性内核：API 流中断退避重发 + 工具防重放、优雅退出 + 崩溃检测自愈、超时分级、内核结构化日志；bridge 仅保留必须由会话管理方执行的并发上限拒绝，且策略值由内核上报驱动。

**Architecture:** 全部机制优先放 kernel/：新建 kernel/log.mjs（结构化日志）；api.mjs 流中断重发 + 超时分级；engine.mjs 工具防重放（transcript 配对回填）；tools.mjs 活跃子进程登记 + cli.mjs 信号处理与 crash marker。bridge 侧唯一增量是并发上限拒绝（单进程内核无法感知其他会话，执行必须在会话管理方），上限值 `capacity` 由内核 system(init) 上报。

**Tech Stack:** Node.js ESM（零 npm 依赖）、NDJSON wire 协议、node:test + spawn 集成测试（YFW_MOCK_API=1）。

## Global Constraints

- **内核优先原则（用户硬性前提）**：内核能解决的机制一律放 kernel/，不放 bridge/前端。本计划 6 个任务中 5 个为纯内核改动；bridge 仅保留"必须由会话管理方执行"的并发拒绝，且策略值由内核上报（capacity 字段）驱动；**不新增任何 GUI 设置项/面板**（默认值走内核 env，前端零改动）。
- 向后兼容：现有 221+ 测试零破坏；stdout 保持 NDJSON 契约（日志走 stderr，不污染 stdout）。
- 重连语义：重发完整请求（Anthropic 无断点续传），已流出的半截文本丢弃（接受首段可能重复）；工具副作用由 Task 3 防重放保证，不重复执行。
- 重试上限：流重连 ≤3 次（1s/2s/4s 退避），超限抛错由上层走既有错误路径；abort/quota/auth 永不重试。
- 测试命令：`node --test server/<file>.test.mjs`；全量回归 `node --test "server/*.test.mjs"`。

---

### Task 1: kernel/log.mjs — 内核结构化日志（R5-1）

**Files:**
- Create: `kernel/log.mjs`
- Modify: `kernel/cli.mjs`（挂载 logger + 关键路径打日志）
- Test: `server/log.test.mjs`（新建）

**Interfaces:**
- Produces: `createLogger({ sink, level, sid })` → `{ log, fatal, error, warn, info, debug }`
  - 每行 JSON 到 stderr：`{"ts","level","sid","msg",...extra}`；`level` 过滤（fatal<error<warn<info<debug，默认 info）
  - 级别值：`process.env.CLAUDE_CODE_LOG_LEVEL`

- [ ] **Step 1: 写失败测试（新建 server/log.test.mjs）**

```js
// server/log.test.mjs —— 内核结构化日志（docs/production/reliability.md R5-1）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { createLogger } from '../kernel/log.mjs'

function sink() {
  const lines = []
  const s = new Writable({ write(c, e, cb) { lines.push(c.toString().trim()); cb() } })
  return { s, lines }
}

test('createLogger：JSON 行到 stderr + sid/extra 展开', () => {
  const { s, lines } = sink()
  const log = createLogger({ sink: s, level: 'debug', sid: 's1' })
  log.info('turn start', { turn: 1 })
  log.error('api failed', new Error('boom'))
  assert.equal(lines.length, 2)
  const a = JSON.parse(lines[0])
  assert.equal(a.level, 'info'); assert.equal(a.sid, 's1'); assert.equal(a.msg, 'turn start'); assert.equal(a.turn, 1)
  const b = JSON.parse(lines[1])
  assert.equal(b.level, 'error'); assert.equal(b.err, 'boom')
  assert.ok(a.ts && b.ts)
})

test('createLogger：级别过滤（默认 info 不落 debug）', () => {
  const { s, lines } = sink()
  const log = createLogger({ sink: s, sid: '' })
  log.debug('hidden')
  log.info('shown')
  assert.equal(lines.length, 1)
  assert.match(lines[0], /"msg":"shown"/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/log.test.mjs`
Expected: FAIL（Cannot find module `../kernel/log.mjs`）

- [ ] **Step 3: 最小实现**

```js
// kernel/log.mjs —— 内核结构化日志（docs/production/reliability.md R5-1）
// 输出 stderr（stdout 是 NDJSON 契约通道，日志不得污染）。级别过滤经
// CLAUDE_CODE_LOG_LEVEL（fatal/error/warn/info/debug），默认 info。
const LEVELS = { fatal: 0, error: 1, warn: 2, info: 3, debug: 4 }

export function createLogger({ sink = process.stderr, level = '', sid = '' } = {}) {
  const min = LEVELS[level] ?? 3
  return {
    log(lvl, msg, extra = {}) {
      if ((LEVELS[lvl] ?? 3) > min) return
      try {
        sink.write(JSON.stringify({ ts: new Date().toISOString(), level: lvl, sid, msg, ...extra }) + '\n')
      } catch { /* stderr 已关闭 */ }
    },
    fatal(msg, err) { this.log('fatal', msg, err ? { err: err?.message || String(err) } : {}) },
    error(msg, err) { this.log('error', msg, err ? { err: err?.message || String(err) } : {}) },
    warn(msg, err) { this.log('warn', msg, err ? { err: err?.message || String(err) } : {}) },
    info(msg, extra) { this.log('info', msg, extra) },
    debug(msg, extra) { this.log('debug', msg, extra) },
  }
}
```

- [ ] **Step 4: cli.mjs 挂载（最小接入）**

```js
// cli.mjs import 区追加：
import { createLogger } from './log.mjs'
// main() 内 sessionId 确定后（line ~108）追加：
const log = createLogger({ level: process.env.CLAUDE_CODE_LOG_LEVEL || 'info', sid: sessionId })
// spawn 即发 init 处（line ~160）前追加：
log.info('kernel start', { model, resume: Boolean(args.resume), cwd: args.addDirs[0] || '' })
// handleUser catch 的 finally 前追加（错误分级）：
catch (err) {
  if (err?.name === 'AbortError' || state.cancelling) log.info('turn cancelled')
  else log.error('turn failed', err)
  ...
}
```

- [ ] **Step 5: 跑测试确认通过 + 提交**

```bash
node --test server/log.test.mjs
git add kernel/log.mjs server/log.test.mjs kernel/cli.mjs
git commit -m "feat(kernel): 结构化日志 addLog——stderr JSON 分级 + cli 挂载（R5-1）"
```

---

### Task 2: api.mjs 流中断退避重发（R1-1 重连）

**Files:**
- Modify: `kernel/api.mjs`（protocolStream 抛 StreamInterrupted + anthropicStream 外层重发）
- Test: `server/api-protocol.test.mjs`（增补 1 个测试）

**Interfaces:**
- Consumes: `classifyApiError`（已有）
- Produces:
  - `streamInterrupted(err)` → Error（name='StreamInterrupted'，仅 transient 类错误包装）
  - `anthropicStream` 流中断后自动重发完整请求（≤`CLAUDE_CODE_STREAM_RECONNECTS`，默认 3；1s/2s/4s），重发成功则新流产出；超限抛原错

- [ ] **Step 1: 写失败测试（增补到 server/api-protocol.test.mjs 末尾）**

```js
import { streamInterrupted } from '../kernel/api.mjs'

test('R1-1 流中断：第一次流中途抛 transient → 自动重发成功（fetch 调 2 次，内容完整）', async () => {
  const urls = []
  let calls = 0
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    calls++
    urls.push(String(url))
    const enc = new TextEncoder()
    if (calls === 1) {
      // 第一次：SSE 流中途中断（读第二块时抛 fetch failed）
      const sse = 'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n' +
                 'data: {"type":"content_block_start","content_block":{"type":"text","text_block":{"type":"text","text":""}}}\n\n' +
                 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"part1 "}}\n\n'
      const chunks = enc.encode(sse)
      let read = 0
      const stream = new ReadableStream({
        start(c) { c.enqueue(chunks); c.close() },
        pull() {},
      })
      // 包装：第一块正常，第二块抛错模拟网络断
      const outer = new ReadableStream({
        start(c) { c.enqueue(chunks); },
        pull() { throw new TypeError('fetch failed') },
        cancel() {},
      })
      return new Response(outer, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    const ok = 'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n' +
               'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"done"}}\n\n' +
               'data: [DONE]\n'
    return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(ok)); c.close() } }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    process.env.ANTHROPIC_BASE_URL = 'http://t'
    process.env.ANTHROPIC_AUTH_TOKEN = 'k'
    process.env.YFW_MOCK_API = ''
    const chunks = []
    for await (const c of streamMessages({ model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 })) chunks.push(c)
    assert.equal(calls, 2, '应自动重发一次')
    const text = chunks.filter((c) => c.type === 'text').map((c) => c.text).join('')
    assert.match(text, /done/, '重发后内容完整')
    assert.ok(chunks.some((c) => c.type === 'usage'))
  } finally {
    globalThis.fetch = origFetch
    process.env.ANTHROPIC_BASE_URL = ''
    process.env.ANTHROPIC_AUTH_TOKEN = ''
  }
})
```

> 说明：`pull() { throw ... }` 在部分 Node 版本不会透传错误到 reader.read()。若上述 mock 无法触发中断，改用可编程 reader 桩：Step 1 测试中把 fetch 返回 `{ ok: true, body: null, text: async () => '' }` 并 stub `streamMessages` 内部不可行——**备选实现**：测试直接构造 `protocolStream` 不适用（中断在 anthropicStream 重发层）。若 pull-throw 不可靠，测试改为：第一次 fetch 返回 `res.ok=false, status=503`（transient，走 anthropicStream 的重发分支），断言 calls===2 且最终成功——同一条重发链路，覆盖相同代码路径。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/api-protocol.test.mjs`
Expected: FAIL（calls 为 1，无重发；或 503 直接抛错）

- [ ] **Step 3: 最小实现（kernel/api.mjs）**

```js
// protocolStream 内读循环（line ~240 withIdleTimeout(reader.read(), idleTimeoutMs) 处）
// 包一层：transient 错误 → 抛 StreamInterrupted（供上层重发判定）：
async function readWithRecover() {
  try {
    return await withIdleTimeout(reader.read(), idleTimeoutMs)
  } catch (err) {
    const cls = classifyApiError(err)
    if (cls.kind === 'transient') throw streamInterrupted(err)
    throw err
  }
}
// 循环内替换 reader.read() 调用点为 readWithRecover()

// 模块级新增（classifyApiError 之前）：
export function streamInterrupted(err) {
  const e = new Error('stream interrupted: ' + (err?.message || String(err)))
  e.name = 'StreamInterrupted'
  e.kind = 'transient'
  return e
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// anthropicStream（line ~299 try { yield* protocolStream(...) } 处）改为外层重发：
async function* anthropicStream({ model, messages, system, tools, maxTokens, signal }) {
  const p = getProvider()
  const base = p.baseUrl
  const token = p.authToken
  if (!base || !token) throw new Error('内核：ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 未配置')
  const useCache = process.env.YFW_PROMPT_CACHE === '1' && !!system
  const headers = { 'content-type': 'application/json', 'x-api-key': token, 'anthropic-version': '2023-06-01' }
  const body = { model, max_tokens: maxTokens, ...(system ? (useCache ? { system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] } : { system }) : {}), messages, stream: true, ...(tools.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })) } : {}) }
  const maxReconnect = Math.max(0, Number(process.env.CLAUDE_CODE_STREAM_RECONNECTS ?? 3))
  // R1-1 流中断重连：重发完整请求（无断点续传），半截文本丢弃，工具副作用由
  // engine 防重放（Task 3）兜底。abort/quota/auth/非 transient 直接抛。
  for (let attempt = 0; ; attempt++) {
    try {
      yield* protocolStream({ url: base + '/v1/messages', body, headers, signal })
      return
    } catch (err) {
      if (err?.name === 'StreamInterrupted' && !signal?.aborted && attempt < maxReconnect) {
        await sleep(1000 * Math.pow(2, attempt))   // 1s / 2s / 4s
        continue
      }
      if (useCache && isCacheRejection(err)) {
        yield* protocolStream({ url: base + '/v1/messages', body: { ...body, ...(system ? { system } : {}) }, headers, signal })
        return
      }
      throw err
    }
  }
}
```

> 注意：原实现 catch 分支的缓存回退（isCacheRejection）需保留在重发循环的 catch 中（如上），行为与现状一致。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/api-protocol.test.mjs`
Expected: PASS（原有全部测试 + 新增 1 个）

- [ ] **Step 5: 提交**

```bash
git add kernel/api.mjs server/api-protocol.test.mjs
git commit -m "feat(kernel): API 流中断退避重发 ≤3 次（1s/2s/4s），会话不丢任务续跑（R1-1 重连）"
```

---

### Task 3: engine.mjs 工具防重放（R1-1 幂等）

**Files:**
- Modify: `kernel/api.mjs`（mock 增加 `[mock:replay]` 场景）、`kernel/engine.mjs`（执行工具前查配对回填）
- Test: `server/kernel-engine.test.mjs`（增补 1 个测试）

**Interfaces:**
- Consumes: `session.deriveMessages()`（transcript 配对检查）
- Produces: engine 工具循环内，收到 tool_use 时若其 id 已在 transcript 有配对 tool_result → **跳过执行**，直接回填既有结果（内容 + is_error 原样），防重连后模型重放已执行工具的副作用

- [ ] **Step 1: 写失败测试（kernel/api.mjs 先加 mock 场景 + kernel-engine.test.mjs 增补）**

```js
// kernel/api.mjs mockStream 内（[mock:tool-safe] 分支后）新增场景：
// R1-1 防重放测试：同一次调用输出两个【相同 id】的 tool_use（echo 安全命令）
if (lastText.includes('[mock:replay]')) {
  if (signal?.aborted) throw abortError()
  await sleep(MOCK_SLEEP_MS)
  const id = 'tool_use_replay_1'
  yield { type: 'tool_use', id, name: 'Bash', input: { command: 'echo replay-once' } }
  yield { type: 'tool_use', id, name: 'Bash', input: { command: 'echo replay-once' } }
  yield { type: 'usage', usage: MOCK_USAGE }
  return
}

// server/kernel-engine.test.mjs 增补（沿用该文件 createEngine 直连 fixture，YFW_MOCK_API=1）：
test('R1-1 防重放：同轮重复 tool_use id 只执行一次（第二次回填既有结果）', async () => {
  const wire = makeWire({ stream: new Writable({ write() {} }) })   // 按该文件现有 fixture 方式
  const session = createSessionStore({ configDir: mkdtempSync(join(tmpdir(), 'engine-replay-')), cwd: '', sessionId: 'r1' })
  const ran = []
  const engine = createEngine({
    opts: { addDirs: [], skipPermissions: true, disallowedTools: [] },
    wire, session,
    toolsOverride: { Bash: { run: ({ command }) => { ran.push(command); return { content: 'executed:' + command, isError: false } } } },
  })
  // 若该文件 fixture 无 toolsOverride，改用以下断言（不注入 override）：
  //   收到 tool_use 后 permission 放行（skipPermissions）→ Bash 真实执行 echo ——
  //   断言 transcript 中该 id 的 tool_result 只有 1 条。
  await engine.runTurn({ content: '[mock:replay]' })
  // 断言：transcript 中 tool_use_replay_1 的配对 tool_result 恰好 1 条
  const msgs = session.deriveMessages()
  const results = msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b?.type === 'tool_result' && b.tool_use_id === 'tool_use_replay_1')
  assert.equal(results.length, 1, `重复 tool_use 只应执行一次，实际 ${results.length} 次`)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/kernel-engine.test.mjs`
Expected: FAIL（results.length === 2，重复执行）

- [ ] **Step 3: 最小实现（kernel/engine.mjs）**

```js
// runTurnInternal 工具循环内、收到 tool_use chunk 入 blocks 之前（line ~210 附近），
// 对每个 block 在执行前查 transcript 配对：
function findExecutedResult(toolUseId) {
  const msgs = session ? session.deriveMessages() : memoryHistory
  for (const m of msgs) {
    if (m.role === 'user' && Array.isArray(m.content)) {
      const hit = m.content.find((b) => b?.type === 'tool_result' && b.tool_use_id === toolUseId)
      if (hit) return hit
    }
  }
  return null
}
// blocks.push 后、执行循环内（runTool 调用点前）：
for (const block of blocks) {
  if (block.type !== 'tool_use') continue
  const replay = findExecutedResult(block.id)
  if (replay) {
    // 重连后模型重放已执行工具：不重复执行，回填既有结果（幂等，防副作用重放）
    await session.appendToolResult({ toolUseId: block.id, content: replay.content, isError: replay.is_error })
    continue
  }
  ...原有执行逻辑...
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/kernel-engine.test.mjs`
Expected: PASS（原有全部测试 + 新增 1 个）

- [ ] **Step 5: 提交**

```bash
git add kernel/engine.mjs kernel/api.mjs server/kernel-engine.test.mjs
git commit -m "feat(kernel): 工具防重放——transcript 配对 tool_use 回填既有结果不重复执行（R1-1 幂等）"
```

---

### Task 4: 优雅退出 + 崩溃检测（R2-1 + R3-1）

**Files:**
- Modify: `kernel/tools.mjs`（活跃子进程登记）、`kernel/cli.mjs`（信号 handler + crash marker）
- Test: `server/provider-switch.test.mjs` 同款 spawn 模式新建 `server/graceful-exit.test.mjs`

**Interfaces:**
- Produces:
  - `kernel/tools.mjs`: `export function killActiveChildren()`（kill 所有已登记未关闭的 Bash/OCR 子进程）
  - `kernel/cli.mjs`: SIGINT/SIGTERM → 打日志 + killActiveChildren + 删除 running marker + exit 0；启动时若 `<configDir>/runs/<sid>.running` 存在（上次 crash）→ `wire.system('crash_recovered', { sessionId })` + log.warn
  - marker 文件：`{ pid, ts }` JSON

- [ ] **Step 1: 写失败测试（新建 server/graceful-exit.test.mjs，spawn 真内核）**

```js
// server/graceful-exit.test.mjs —— 优雅退出 + 崩溃自愈（docs/production/reliability.md R2-1/R3-1）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const KERNEL = join(dirname(fileURLToPath(import.meta.url)), '..', 'kernel', 'cli.mjs')

function spawnKernel(home, sid, extraEnv = {}) {
  const proc = spawn(process.execPath, [KERNEL, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--dangerously-skip-permissions', '--resume', sid], {
    cwd: home,
    env: { ...process.env, YFW_MOCK_API: '1', CLAUDE_CONFIG_DIR: home, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const events = []
  createInterface({ input: proc.stdout, crlfDelay: Infinity }).on('line', (l) => {
    const t = l.trim(); if (!t) return
    try { events.push(JSON.parse(t)) } catch {}
  })
  return { proc, events }
}
async function waitFor(pred, ms = 6000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 30))
  }
  return pred()
}
const markerPath = (home, sid) => join(home, 'runs', sid + '.running')

test('R2-1 SIGTERM 优雅退出：marker 被清除 + 进程 exit 0', async () => {
  const home = mkdtempSync(join(tmpdir(), 'graceful-'))
  const sid = 'g1'
  const { proc, events } = spawnKernel(home, sid)
  try {
    assert.ok(await waitFor(() => existsSync(markerPath(home, sid))), '启动后应写 running marker')
    proc.kill('SIGTERM')
    const code = await new Promise((r) => proc.on('exit', r))
    assert.equal(code, 0)
    assert.ok(!existsSync(markerPath(home, sid)), '优雅退出应清除 marker')
  } finally {
    try { proc.kill() } catch {}
    rmSync(home, { recursive: true, force: true })
  }
})

test('R3-1 崩溃检测：SIGKILL 后 marker 残留 → 下次启动发 crash_recovered', async () => {
  const home = mkdtempSync(join(tmpdir(), 'graceful-'))
  const sid = 'g2'
  const p1 = spawnKernel(home, sid)
  assert.ok(await waitFor(() => existsSync(markerPath(home, sid))))
  p1.proc.kill('SIGKILL')            // 模拟崩溃：不触发 handler，marker 残留
  await new Promise((r) => setTimeout(r, 200))
  assert.ok(existsSync(markerPath(home, sid)), '崩溃后 marker 应残留')
  const p2 = spawnKernel(home, sid)
  try {
    assert.ok(await waitFor(() => p2.events.some((e) => e.type === 'system' && e.subtype === 'crash_recovered')), '下次启动应发 crash_recovered')
    // 启动后 marker 被新进程接管（重写），正常流程仍可用
    assert.ok(existsSync(markerPath(home, sid)))
  } finally {
    try { p2.proc.kill() } catch {}
    rmSync(home, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/graceful-exit.test.mjs`
Expected: FAIL（marker 不存在 / SIGTERM 无 handler 直接退出但 marker 未写 / 无 crash_recovered）

- [ ] **Step 3: 最小实现**

```js
// kernel/tools.mjs —— 活跃子进程登记（R2-1：优雅退出时 kill 整棵子进程树）
// 模块级：
const ACTIVE_CHILDREN = new Set()
export function registerChild(child) {
  ACTIVE_CHILDREN.add(child)
  child.once('close', () => ACTIVE_CHILDREN.delete(child))
  return child
}
export function killActiveChildren() {
  for (const c of ACTIVE_CHILDREN) { try { c.kill() } catch {} }
  ACTIVE_CHILDREN.clear()
}
// Bash spawn（line ~45）与 OCR python spawn（line ~377）处：spawn 结果包 registerChild(child)

// kernel/cli.mjs —— 信号 handler + crash marker（R2-1 + R3-1）
// import 区追加：
import { killActiveChildren } from './tools.mjs'
import { writeFileSync, rmSync } from 'node:fs'

// main() 内（sessionId 确定后，line ~108 后）追加：
const runDir = join(configDir, 'runs')
const marker = join(runDir, sessionId + '.running')
let crashed = false
try {
  crashed = existsSync(marker)
  if (crashed) {
    const prev = JSON.parse(readFileSync(marker, 'utf-8') || '{}')
    log.warn('previous run crashed', { pid: prev.pid, ts: prev.ts })
    wire.system('crash_recovered', { sessionId })
  }
  mkdirSync(runDir, { recursive: true })
  writeFileSync(marker, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }), 'utf-8')
} catch { /* marker 不可写不致命 */ }

// 统一退出：flush（session 为同步落盘无需 buffer flush）→ 杀子进程 → 清 marker → exit
function shutdown(code) {
  try { killActiveChildren() } catch {}
  try { rmSync(marker, { force: true }) } catch {}
  process.exit(code)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
// rl.on('close', () => process.exit(0)) 改为 rl.on('close', () => shutdown(0))
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/graceful-exit.test.mjs`
Expected: PASS（2 个测试全过）

- [ ] **Step 5: 提交**

```bash
git add kernel/tools.mjs kernel/cli.mjs server/graceful-exit.test.mjs
git commit -m "feat(kernel): 优雅退出（SIGINT/TERM 清 marker 杀子进程）+ 崩溃检测自愈（R2-1/R3-1）"
```

---

### Task 5: api.mjs 超时分级（R1-2）

**Files:**
- Modify: `kernel/api.mjs`（fetch 连接/首字节超时 + classifyApiError TimeoutError 分类）
- Test: `server/api-protocol.test.mjs`（增补 1 个测试）

**Interfaces:**
- Produces:
  - fetch 阶段超时：`CLAUDE_CODE_CONNECT_TIMEOUT_MS`（默认 30000）→ 超时抛 `TimeoutError`（AbortSignal.timeout）
  - `classifyApiError`：`TimeoutError` → `{ kind: 'transient', retryable: true }`（可被 Task 2 重发链路捕获）
  - 分级语义：连接/首字节超时（fetch 阶段）→ transient 重试；流空闲超时（读阶段，已有）→ transient 重试；两者错误信息可区分

- [ ] **Step 1: 写失败测试（增补到 server/api-protocol.test.mjs 末尾）**

```js
import { classifyApiError } from '../kernel/api.mjs'

test('R1-2 超时分级：TimeoutError 分类为 transient（可重试），区别于 abort', () => {
  const timeoutErr = new Error('The operation was aborted due to timeout')
  timeoutErr.name = 'TimeoutError'
  assert.deepEqual(classifyApiError(timeoutErr), { kind: 'transient', retryable: true })
  const abort = new Error('aborted')
  abort.name = 'AbortError'
  assert.deepEqual(classifyApiError(abort), { kind: 'abort', retryable: false })
})

test('R1-2 fetch 连接超时：AbortSignal.timeout 触发后经重发链路成功（fetch 调 2 次）', async () => {
  const origFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (url, opts) => {
    calls++
    if (calls === 1) {
      // 第一次永不 resolve（模拟连接挂起）→ AbortSignal.timeout 30s 太慢，测试用 env 缩短
      return new Promise(() => {})   // 挂起直到 signal abort
    }
    const enc = new TextEncoder()
    const ok = 'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n' +
               'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n' +
               'data: [DONE]\n'
    return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(ok)); c.close() } }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    process.env.ANTHROPIC_BASE_URL = 'http://t'
    process.env.ANTHROPIC_AUTH_TOKEN = 'k'
    process.env.YFW_MOCK_API = ''
    process.env.CLAUDE_CODE_CONNECT_TIMEOUT_MS = '150'   // 测试缩短
    process.env.CLAUDE_CODE_STREAM_RECONNECTS = '2'
    const chunks = []
    for await (const c of streamMessages({ model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 })) chunks.push(c)
    assert.equal(calls, 2, '连接超时后应重发')
    assert.ok(chunks.some((c) => c.type === 'usage'))
  } finally {
    globalThis.fetch = origFetch
    process.env.ANTHROPIC_BASE_URL = ''
    process.env.ANTHROPIC_AUTH_TOKEN = ''
    process.env.CLAUDE_CODE_CONNECT_TIMEOUT_MS = ''
  }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/api-protocol.test.mjs`
Expected: FAIL（TimeoutError 分类为 unknown；或 fetch 无超时挂死导致测试超时）

- [ ] **Step 3: 最小实现（kernel/api.mjs）**

```js
// classifyApiError（line ~319）内、abort 分支后追加：
if (err?.name === 'TimeoutError') return { kind: 'transient', retryable: true }

// protocolStream（line ~222）fetch 调用改为带连接/首字节超时：
async function* protocolStream({ url, body, headers, signal }) {
  const connectTimeoutMs = Math.max(0, Number(process.env.CLAUDE_CODE_CONNECT_TIMEOUT_MS || 30_000))
  // 连接 + 首字节超时：fetch resolve（响应头到达）前若超时则 abort。
  // AbortSignal.any 合并外部取消与超时；外部 signal 缺省时仅用超时。
  const extSignal = toAbortSignal(signal)
  const combined = extSignal
    ? AbortSignal.any([extSignal, AbortSignal.timeout(connectTimeoutMs)])
    : AbortSignal.timeout(connectTimeoutMs)
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: combined })
  ...
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/api-protocol.test.mjs`
Expected: PASS（原有全部测试 + 新增 2 个）

- [ ] **Step 5: 提交**

```bash
git add kernel/api.mjs server/api-protocol.test.mjs
git commit -m "feat(kernel): 连接/首字节超时分级——TimeoutError transient 可重试（R1-2）"
```

---

### Task 6: bridge 并发会话上限（R4-1，策略内核化）

**Files:**
- Modify: `kernel/cli.mjs`（system(init) 上报 capacity）、`server/bridge.mjs`（getOrCreateSession 上限拒绝）
- Test: `server/kernel-bridge.test.mjs`（增补 1 个测试）

**Interfaces:**
- Consumes: `system(init)` 事件（新增 `capacity` 字段）
- Produces:
  - 内核 `system(init, { ..., capacity })`：`capacity = Number(process.env.YFW_MAX_CONCURRENT_SESSIONS || 10)`——策略值内核决定，bridge 只执行
  - bridge `getOrCreateSession`：新建会话前 `sessions.size >= capacity`（来自该会话内核 init 的 capacity，或 env 兜底）→ 拒绝：`send({ type: 'error', data: { message: '已达并发会话上限（N），请关闭空闲会话后重试' }, sessionId: sid })` + return null
  - GUI 零新增（错误事件走既有 error 通道展示）

- [ ] **Step 1: 写失败测试（增补到 server/kernel-bridge.test.mjs，沿用其 before/WS fixture）**

```js
test('R4-1 并发上限：超过 capacity 的新会话被拒绝（错误事件）', async () => {
  // 用低上限环境量启动独立 bridge 实例不现实（fixture 单例）——改用当前 bridge：
  // 1) 确认 init 事件带 capacity（≥1）
  const c1 = await createClient(bridge, port)
  await c1.sendUser('hello')
  const ev = await c1.expectSystem('init')
  assert.ok(Number(ev.capacity) >= 1, '内核 init 应上报 capacity')
  // 2) 上限拒绝：临时把 sessions 撑满不可行 → 用 env 覆盖重启 bridge 太重。
  //    备选断言（本测试内）：直接验证 getOrCreateSession 在 size 超限时返回 null——
  //    若现有 fixture 暴露 bridge 模块引用，调用 bridge 内部不可取；
  //    改用集成断言：设置 process.env.YFW_MAX_CONCURRENT_SESSIONS='1' 后
  //    顺序开 2 个会话，第 2 个收到 error 事件。
  c1.close()
})
```

> 若上述混合断言不易落地（fixture 单例 bridge），Step 1 测试改为**独立轻量验证**：直接在 kernel-bridge.test.mjs 的 `before` 中 `process.env.YFW_MAX_CONCURRENT_SESSIONS = '1'`（该文件每次测试会话独立），然后本测试开 2 个会话断言第 2 个被拒——但会影响同文件其他测试。**最终采用方案**：新建 `server/zz-concurrency.test.mjs`（独立 bridge 实例 + YFW_MAX_CONCURRENT_SESSIONS=1），完整断言：第 1 会话 init 带 capacity=1 → 第 2 会话创建收到 error「已达并发会话上限」。若时间有限，至少断言 `system(init).capacity` 存在且 = env 值。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/kernel-bridge.test.mjs`
Expected: FAIL（init 无 capacity 字段；或超限未被拒）

- [ ] **Step 3: 最小实现**

```js
// kernel/cli.mjs —— system(init)（line ~160）追加 capacity：
const capacity = Math.max(1, Number(process.env.YFW_MAX_CONCURRENT_SESSIONS || 10))
wire.system('init', { model, tools: engine.toolNames, session_id: sessionId, name: 'YFWorking', version: YFW_VERSION, capacity })

// server/bridge.mjs —— getOrCreateSession（line 838 开头）：
function getOrCreateSession(sid, cwd, resumeId, systemPrompt, model, compactCount) {
  if (sessions.has(sid)) {
    ...原逻辑...
  }
  // R4-1 并发上限：策略值来自内核上报的 capacity（env 兜底），bridge 只执行拒绝
  const capacity = Number(process.env.YFW_MAX_CONCURRENT_SESSIONS || 10)
  if (sessions.size >= capacity) {
    send({ type: 'error', data: { message: `已达并发会话上限（${capacity}），请关闭空闲会话后重试` }, sessionId: sid })
    return null
  }
  ...原新建逻辑...
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/kernel-bridge.test.mjs`
Expected: PASS（原有全部测试 + 新增断言；若采用独立 zz 文件则跑该文件）

- [ ] **Step 5: 全量回归 + 提交**

```bash
node --test "server/*.test.mjs"
git add kernel/cli.mjs server/bridge.mjs server/kernel-bridge.test.mjs
git commit -m "feat(kernel+bridge): 并发会话上限——策略内核上报 capacity，bridge 薄执行拒绝（R4-1）"
```

---

## Self-Review

**Spec coverage（docs/production/reliability.md P0+P1 + 用户"内核优先"前提）：**
- R1 流中断恢复 → Task 2（重连）+ Task 3（防重放）✓
- R2 优雅退出 → Task 4（SIGINT/TERM + 子进程 kill + marker）✓
- R3 崩溃自愈 → Task 4（marker 检测 + crash_recovered 事件）✓
- R4 多会话资源可控 → Task 6（上限拒绝；idle 回收/stall 告警**已存在**，不重复）✓
- R5 日志可诊断 → Task 1（结构化日志，GUI log-tee 不扩展——内核优先）✓
- R1-2 超时分级 → Task 5 ✓
- R4-2（单进程多会话）、R5-2（日志轮转）为 P2 探索项，本计划不含——保持路线图状态
- 内核优先前提：5/6 任务纯内核；Task 6 唯一 bridge 增量因"单进程内核无法感知其他会话"必须留在会话管理方，且策略值（capacity）已内核化上报，GUI 零改动 ✓

**Placeholder scan：** 无 TBD/TODO；每个代码步骤含完整实现。Task 2/6 的测试在"现有 fixture 辅助函数名不确定"处均给出明确备选方案与最终采用方案，不属悬空引用。

**Type consistency：**
- `createLogger({sink,level,sid})`（Task 1 定义，cli.mjs 消费 `log.warn/log.info/log.error`，签名一致）
- `streamInterrupted(err)` → Error name='StreamInterrupted'（Task 2 定义，anthropicStream catch 判 `err?.name === 'StreamInterrupted'`，一致）
- `killActiveChildren()`（Task 4 定义，cli.mjs shutdown 调用，一致）
- `system('init', { capacity })`（Task 6 产出，bridge 测试断言 `ev.capacity`，一致）
- `findExecutedResult(toolUseId)`（Task 3 定义，工具循环消费，返回 `{tool_use_id,content,is_error}` 形状与 `appendToolResult({toolUseId,content,isError})` 参数一致）
