# 内核可观测与运维（P3）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 P3 可观测：内核用量聚合/成本统计纯函数（含 cache 计费与缓存命中率）、运维健康指标、诊断补全与一键导出。聚合/成本/健康计算逻辑内核化（kernel/stats.mjs、kernel/cost.mjs），bridge 仅保留读文件 + 拼全局会话数的薄壳，前端零新增设置项。

**Architecture:** 新建 kernel/stats.mjs（aggregateUsage 纯函数：cache 四字段 / bySession / 工具分布 / cacheRate）+ kernel/cost.mjs（costOf 含 cache 计费，对齐 benchmark/lib/llm-api.mjs 口径）；health.mjs 增加 getOpsHealth（内存/最近 API 结果/队列深度）；bridge /transcript/stats 切换新聚合并加月度预算阈值（走 env，不新增 GUI 设置项）、/health 拼会话数、/diag/info 补全 + /diag/export。

**Tech Stack:** Node.js ESM（零 npm 依赖）、node:test + spawn 集成测试（PONOS_MOCK_API=1）、transcript JSONL（server/transcript.mjs 同格式）。

## Global Constraints

- **内核优先原则（用户硬性前提）**：聚合/成本/健康计算逻辑放 kernel/；bridge 只做文件读取、全局会话数拼接与 REST 薄壳；**不新增任何 GUI 设置项**（月度预算阈值走 env `PONOS_MONTHLY_BUDGET_USD`，成本面板已有展示）。
- 口径一致：costOf 与 benchmark/lib/llm-api.mjs 同公式（cache_read 按 `pricePerMInput × cacheReadRatio` 计费，cache_creation 按全价 input 计费）；aggregateStats（transcript.mjs 现有）保持向后兼容，/transcript/stats 响应字段只增不改。
- 向后兼容：现有 221+ 测试零破坏；/health、/diag/info、/transcript/stats 现有消费方（GUI 面板、diag-monitor）不得因字段扩展出问题（只加字段）。
- 测试命令：`node --test server/<file>.test.mjs`；全量回归 `node --test "server/*.test.mjs"`。

---

### Task 1: O1-1 核对——engine result 事件 usage 四字段断言

**Files:**
- Test: `server/kernel-engine.test.mjs`（增补 1 个测试）
- 若断言失败则改 `kernel/engine.mjs`（预计零改动——`wire.result(usage)` 已传 addUsage 累计的四字段）

**Interfaces:**
- Produces: 确认 `result` 事件 usage 含 `input_tokens/output_tokens/cache_read_input_tokens/cache_creation_input_tokens` 四字段（会话落盘 + GUI 用量展示的权威源）

- [x] **Step 1: 写测试（增补到 server/kernel-engine.test.mjs 末尾，沿用该文件 fixture）**

```js
test('O1-1 result 事件 usage 含 cache 四字段（mock 多工具轮累计）', async () => {
  const events = []
  const wire = makeWire({ stream: new Writable({ write(c) { try { events.push(JSON.parse(c.toString())) } catch {} } }) })
  const session = createSessionStore({ configDir: mkdtempSync(join(tmpdir(), 'engine-usage-')), cwd: '', sessionId: 'u1' })
  const engine = createEngine({ opts: { addDirs: [], skipPermissions: true }, wire, session })
  await engine.runTurn({ content: '[mock:tool-safe]' })
  const result = events.find((e) => e.type === 'result')
  assert.ok(result, '应收到 result 事件')
  assert.ok(result.usage, 'result 应带 usage')
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    assert.ok(k in result.usage, `usage 应含 ${k}`)
  }
  // 落盘条目同样带完整 usage
  const msgs = session.deriveMessages()
  const last = msgs[msgs.length - 1]
  assert.ok(last?.usage, '最终 assistant 条目应带 usage')
})
```

- [x] **Step 2: 跑测试确认通过（或失败定位缺口）**

Run: `node --test server/kernel-engine.test.mjs`
Expected: PASS（若 cache 字段缺失则修复 engine.mjs——把 wire.result 与 appendAssistant 的 usage 统一为 addUsage 累计结果）

- [x] **Step 3: 修复（仅当 Step 2 失败）**

若 `usage` 缺 cache 字段，定位 engine.mjs 中 result 事件构造处（line ~551 `wire.result(usage, ...)`），确认 usage 来源为 addUsage 累计（非覆盖赋值）；若被覆盖，改为与 finalizeUsage 同一 usage 对象。

- [x] **Step 4: 提交**

```bash
git add server/kernel-engine.test.mjs kernel/engine.mjs
git commit -m "test(kernel): result 事件 usage 四字段断言——cache 用量透传确认（O1-1）"
```

---

### Task 2: kernel/stats.mjs — 用量聚合纯函数（O1-2 + O4-2）

**Files:**
- Create: `kernel/stats.mjs`
- Test: `server/stats.test.mjs`（新建；server/stats.test.mjs 已存在则增补）

**Interfaces:**
- Produces:
  - `aggregateUsage(entries, { bySession = false } = {})` → `{ totals, byModel, byProject, byDate, bySession, byTool, cacheRate }`
    - totals/byModel/byProject/byDate 各含 `{ input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, turns }`
    - byTool：`{ [toolName]: count }`（扫描 assistant tool_use）
    - cacheRate：`cache_read/(input+cache_read)`（0..1，分母为 0 时 0）——O4-2 缓存命中率
    - 输入：transcript entries（同 aggregateStats 的 JSONL 行对象，`e.message.usage` 数据源）
  - 与现有 aggregateStats 响应兼容：`totals/byModel/byProject/byDate` 键名一致，新增 cache 字段与 byTool/bySession/cacheRate

- [x] **Step 1: 写失败测试（新建 server/stats.test.mjs）**

```js
// server/stats.test.mjs —— 内核用量聚合（docs/production/observability.md O1-2/O4-2）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aggregateUsage } from '../kernel/stats.mjs'

function assistantEntry(model, usage, ts, seq, toolUses = []) {
  return { type: 'assistant', seq, timestamp: ts, message: { role: 'assistant', model, usage, content: toolUses.map((t) => ({ type: 'tool_use', id: t, name: 'Bash', input: {} })) } }
}

test('aggregateUsage：cache 四字段累计 + byModel/byDate + 工具分布', () => {
  const entries = [
    assistantEntry('m1', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 900, cache_creation_input_tokens: 1000 }, '2026-08-21T00:00:00Z', 1, ['t1']),
    assistantEntry('m1', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 }, '2026-08-21T00:00:01Z', 2, ['t2', 't3']),
    assistantEntry('m2', { input_tokens: 200, output_tokens: 100 }, '2026-08-22T00:00:00Z', 3, []),
  ]
  const r = aggregateUsage(entries)
  assert.equal(r.totals.input_tokens, 310)
  assert.equal(r.totals.cache_read_input_tokens, 990)
  assert.equal(r.totals.cache_creation_input_tokens, 1000)
  assert.equal(r.totals.turns, 3)
  assert.equal(r.byModel.m1.cache_read_input_tokens, 990)
  assert.equal(r.byDate['2026-08-21'].output_tokens, 55)
  assert.equal(r.byTool.Bash, 3)
  // 缓存命中率：990/(310+990) ≈ 0.7615
  assert.ok(Math.abs(r.cacheRate - 990 / (310 + 990)) < 1e-6)
})

test('aggregateUsage：bySession 聚合 + 分母为 0 时 cacheRate 0', () => {
  const entries = [
    assistantEntry('m1', { input_tokens: 1, output_tokens: 0 }, '2026-08-21T00:00:00Z', 1),
  ]
  const r = aggregateUsage(entries, { bySession: true })
  assert.ok(r.bySession)
  assert.equal(r.cacheRate, 0)
})
```

- [x] **Step 2: 跑测试确认失败**

Run: `node --test server/stats.test.mjs`
Expected: FAIL（Cannot find module `../kernel/stats.mjs`）

- [x] **Step 3: 最小实现**

```js
// kernel/stats.mjs —— 用量聚合纯函数（docs/production/observability.md O1-2/O4-2）
// 数据源 = transcript assistant entry.message.usage（engine addUsage 累计四字段）。
// 与 server/transcript.mjs aggregateStats 键名兼容（totals/byModel/byProject/byDate），
// 新增 cache 字段 + byTool/bySession/cacheRate。纯函数，bridge 读文件后调用。
const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']

function newBucket() {
  const b = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, turns: 0 }
  return b
}
function addTo(b, u) {
  for (const k of USAGE_KEYS) b[k] += u[k] ?? 0
  b.turns += 1
}
function ensure(map, k) {
  if (!map[k]) map[k] = newBucket()
  return map[k]
}

export function aggregateUsage(entries, { bySession = false } = {}) {
  const totals = newBucket()
  const byModel = {}
  const byProject = {}
  const byDate = {}
  const bySessionMap = {}
  const byTool = {}
  let inputSum = 0
  let cacheReadSum = 0
  for (const e of entries || []) {
    if (e?.type !== 'assistant') continue
    const usage = e.message?.usage
    if (!usage || !Number.isFinite(usage.input_tokens)) continue
    const model = e.message?.model || 'unknown'
    const day = String(e.timestamp || '').slice(0, 10) || 'unknown'
    const u = {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    }
    addTo(totals, u)
    addTo(ensure(byModel, model), u)
    addTo(ensure(byDate, day), u)
    if (bySession && e.sessionId) addTo(ensure(bySessionMap, e.sessionId), u)
    for (const b of (e.message?.content || [])) {
      if (b?.type === 'tool_use' && b.name) byTool[b.name] = (byTool[b.name] || 0) + 1
    }
    inputSum += u.input_tokens
    cacheReadSum += u.cache_read_input_tokens
  }
  const cacheRate = inputSum + cacheReadSum > 0 ? cacheReadSum / (inputSum + cacheReadSum) : 0
  const out = { totals, byModel, byProject: {}, byDate, byTool, cacheRate }
  if (bySession) out.bySession = bySessionMap
  return out
}
```

> 注：byProject 依赖外层传入 project 名（bridge 按目录遍历时已知）——Task 4 在 bridge 侧为每项目文件加 `e.sessionId` 与 project 归属（`e.project = projName`）后调用。

- [x] **Step 4: 跑测试确认通过**

Run: `node --test server/stats.test.mjs`
Expected: PASS（2 个测试全过）

- [x] **Step 5: 提交**

```bash
git add kernel/stats.mjs server/stats.test.mjs
git commit -m "feat(kernel): 用量聚合纯函数——cache 四字段/byTool/cacheRate（O1-2/O4-2）"
```

---

### Task 3: kernel/cost.mjs — 成本计费纯函数（O4-1）

**Files:**
- Create: `kernel/cost.mjs`
- Test: `server/cost.test.mjs`（新建）

**Interfaces:**
- Produces:
  - `costOf(usage, { pricePerMInput, pricePerMOutput, cacheReadRatio })` → 美元
    - 公式对齐 benchmark/lib/llm-api.mjs：`input×pIn + output×pOut + cache_read×pIn×cacheReadRatio + cache_creation×pIn`
    - 默认值：pIn=0.2, pOut=1.2, cacheReadRatio=0.1（与 benchmark 一致）
  - `withBudget(rows, budgetUsd)` → `{ rows, totalUsd, overBudget: boolean }`（月度预算超限标记，预算值来自 env `PONOS_MONTHLY_BUDGET_USD`）

- [x] **Step 1: 写失败测试（新建 server/cost.test.mjs）**

```js
// server/cost.test.mjs —— 成本计费（docs/production/observability.md O4-1）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { costOf, withBudget } from '../kernel/cost.mjs'

test('costOf：cache 计费对齐 benchmark 口径（1000in/500out/100K cache_read/2K creation）', () => {
  const usd = costOf({ input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 100000, cache_creation_input_tokens: 2000 })
  // 1000/1e6*0.2 + 500/1e6*1.2 + 100000/1e6*0.2*0.1 + 2000/1e6*0.2
  const expect = 1000 / 1e6 * 0.2 + 500 / 1e6 * 1.2 + 100000 / 1e6 * 0.2 * 0.1 + 2000 / 1e6 * 0.2
  assert.ok(Math.abs(usd - expect) < 1e-9)
  assert.ok(usd > 0)
})

test('costOf：缺省字段按 0 计；自定义单价生效', () => {
  assert.equal(costOf({}), 0)
  const custom = costOf({ input_tokens: 1000000, output_tokens: 0 }, { pricePerMInput: 1, pricePerMOutput: 3, cacheReadRatio: 0 })
  assert.equal(custom, 1)
})

test('withBudget：总成本 + 超限标记', () => {
  const rows = [{ cost_usd: 0.6 }, { cost_usd: 0.5 }]
  const r = withBudget(rows, 1)
  assert.equal(r.totalUsd, 1.1)
  assert.equal(r.overBudget, true)
  assert.equal(withBudget(rows, 2).overBudget, false)
})
```

- [x] **Step 2: 跑测试确认失败**

Run: `node --test server/cost.test.mjs`
Expected: FAIL（Cannot find module `../kernel/cost.mjs`）

- [x] **Step 3: 最小实现**

```js
// kernel/cost.mjs —— 成本计费纯函数（docs/production/observability.md O4-1）
// 公式与 benchmark/lib/llm-api.mjs costOf 完全一致：cache_read 按 input 单价的
// cacheReadRatio 计费（缓存命中的折扣），cache_creation 按全价 input 计费。
export function costOf(usage = {}, { pricePerMInput = 0.2, pricePerMOutput = 1.2, cacheReadRatio = 0.1 } = {}) {
  const in_ = (usage.input_tokens || 0) / 1e6 * pricePerMInput
  const out = (usage.output_tokens || 0) / 1e6 * pricePerMOutput
  const cacheRead = (usage.cache_read_input_tokens || 0) / 1e6 * pricePerMInput * cacheReadRatio
  const cacheCreation = (usage.cache_creation_input_tokens || 0) / 1e6 * pricePerMInput
  return in_ + out + cacheRead + cacheCreation
}

export function withBudget(rows = [], budgetUsd = 0) {
  const totalUsd = rows.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0)
  return { rows, totalUsd: Number(totalUsd.toFixed(4)), overBudget: budgetUsd > 0 && totalUsd > budgetUsd }
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `node --test server/cost.test.mjs`
Expected: PASS（3 个测试全过）

- [x] **Step 5: 提交**

```bash
git add kernel/cost.mjs server/cost.test.mjs
git commit -m "feat(kernel): 成本计费纯函数——cache 折扣计费 + 月度预算标记（O4-1）"
```

---

### Task 4: bridge /transcript/stats 集成新聚合 + 预算阈值（O1-2 + O4-1 落地）

**Files:**
- Modify: `server/bridge.mjs`（/transcript/stats 改用 aggregateUsage + costOf + budget）
- Test: `server/stats.test.mjs`（增补集成断言，或 zz 文件走 HTTP——采用直接调模块级聚合 + 现有 /transcript/stats 结构断言）

**Interfaces:**
- Consumes: `aggregateUsage`（Task 2）、`costOf`/`withBudget`（Task 3）、`costUsd`（transcript.mjs 现有——保留兼容或替换）
- Produces: `/transcript/stats` 响应新增 `cache_read_input_tokens/cache_creation_input_tokens/cacheRate/byTool/bySession`（可选）字段；`totals.cost_usd` 计算改用 costOf（含 cache 计费）；`overBudget` 字段（`PONOS_MONTHLY_BUDGET_USD` env，未设时不输出）

- [x] **Step 1: 写失败测试（增补到 server/stats.test.mjs 末尾——直接调 aggregateUsage 模拟 bridge 集成路径）**

```js
// 模拟 bridge 的逐项目调用：为 entries 注入 sessionId/project 后聚合
test('bridge 集成：按项目注入 sessionId → bySession 生效', () => {
  const entries = [
    { ...assistantEntry('m1', { input_tokens: 10, output_tokens: 2 }, '2026-08-21T00:00:00Z', 1), sessionId: 's1', project: 'p1' },
    { ...assistantEntry('m1', { input_tokens: 20, output_tokens: 4 }, '2026-08-21T00:00:01Z', 2), sessionId: 's2', project: 'p1' },
  ]
  const r = aggregateUsage(entries, { bySession: true })
  assert.equal(r.bySession.s1.input_tokens, 10)
  assert.equal(r.bySession.s2.input_tokens, 20)
  assert.equal(r.totals.input_tokens, 30)
})
```

- [x] **Step 2: 跑测试确认失败**

Run: `node --test server/stats.test.mjs`
Expected: FAIL（bySession 为空——当前 aggregateUsage 检查 `e.sessionId` 但测试注入后应通过；若实际失败为 byProject 聚合缺失）

- [x] **Step 3: 最小实现（kernel/stats.mjs 补 byProject + bridge.mjs 集成）**

```js
// kernel/stats.mjs aggregateUsage 内补 byProject（e.project 注入时聚合）：
if (e.project) addTo(ensure(byProject, e.project), u)
// out 返回 byProject（此前恒为 {}，现随注入填充）

// server/bridge.mjs /transcript/stats handler 改造：
import { aggregateUsage } from '../kernel/stats.mjs'
import { costOf, withBudget } from '../kernel/cost.mjs'
// 遍历时（与 /audit 同构的目录遍历）：
//   for each 项目/文件：为每行 entry 注入 { sessionId: sid, project: projName }
//   汇总 entries → aggregateUsage(entries, { bySession: true })
// 成本：totals.cost_usd = costOf(totals)；byModel 逐模型 costOf
// 预算：const budget = Number(process.env.PONOS_MONTHLY_BUDGET_USD || 0)
//   const { totalUsd, overBudget } = withBudget([{ cost_usd: totals.cost_usd }], budget)
// 响应追加：cacheRead/cacheCreation/cacheRate/byTool/(bySession 可选)/overBudget
```

> 现有 `aggregateStats`（transcript.mjs）与 `costUsd` 保持导出兼容（其他调用方 /audit 等不受影响）；/transcript/stats 改为新聚合。

- [x] **Step 4: 跑测试确认通过**

Run: `node --test server/stats.test.mjs server/kernel-bridge.test.mjs`
Expected: PASS（stats 3 个 + kernel-bridge 原有全过——/transcript/stats 结构兼容）

- [x] **Step 5: 提交**

```bash
git add kernel/stats.mjs server/bridge.mjs server/stats.test.mjs
git commit -m "feat(bridge): /transcript/stats 集成内核聚合——cache 计费 + bySession + 预算标记（O1-2/O4-1）"
```

---

### Task 5: health.mjs 运维健康 + bridge /health（O2-1）

**Files:**
- Modify: `kernel/health.mjs`（getOpsHealth 纯函数）、`server/bridge.mjs`（/health 拼全局会话数）
- Test: `server/health.test.mjs`（增补）+ `server/kernel-bridge.test.mjs`（增补）

**Interfaces:**
- Consumes: 无（纯计算）
- Produces:
  - `getOpsHealth({ memory, lastApi, pendingTurns, diskBytes })` → `{ rssMB, heapMB, lastApiOk, lastApiMs, pendingTurns, diskMB }`（纯函数，输入由调用方采集——内核侧采集自身，bridge 采集全局）
  - bridge `/health` 响应扩展：`{ status, pid, sessions: <活跃会话数>, ops: <内核上报或 bridge 采集的运维指标>, apiOk, pendingTurns }`——会话数由 bridge 聚合（全局概念，内核单进程无法感知）

- [x] **Step 1: 写失败测试（增补到 server/health.test.mjs 末尾）**

```js
import { getOpsHealth } from '../kernel/health.mjs'

test('O2-1 getOpsHealth：内存/API 状态/队列深度归一输出', () => {
  const h = getOpsHealth({
    memory: { rss: 500 * 1024 * 1024, heapUsed: 100 * 1024 * 1024 },
    lastApi: { ok: true, ms: 320 },
    pendingTurns: 2,
    diskBytes: 25 * 1024 * 1024,
  })
  assert.equal(h.rssMB, 500)
  assert.equal(h.heapMB, 100)
  assert.equal(h.lastApiOk, true)
  assert.equal(h.lastApiMs, 320)
  assert.equal(h.pendingTurns, 2)
  assert.equal(h.diskMB, 25)
})

test('O2-1 缺省输入降级：空对象返回 0/null 不抛', () => {
  const h = getOpsHealth({})
  assert.equal(h.rssMB, 0)
  assert.equal(h.lastApiOk, null)
  assert.equal(h.pendingTurns, 0)
})
```

- [x] **Step 2: 跑测试确认失败**

Run: `node --test server/health.test.mjs`
Expected: FAIL（getOpsHealth 未导出）

- [x] **Step 3: 最小实现**

```js
// kernel/health.mjs 末尾追加纯函数：
// O2-1 运维健康归一：输入由调用方采集（内核测自身进程，bridge 测全局会话）。
// 纯函数保证可测性——采集与展示分离。
export function getOpsHealth({ memory = {}, lastApi = {}, pendingTurns = 0, diskBytes = 0 } = {}) {
  return {
    rssMB: Math.round((memory.rss || 0) / 1024 / 1024),
    heapMB: Math.round((memory.heapUsed || 0) / 1024 / 1024),
    lastApiOk: lastApi.ok ?? null,
    lastApiMs: lastApi.ms ?? null,
    pendingTurns: pendingTurns || 0,
    diskMB: Math.round((diskBytes || 0) / 1024 / 1024),
  }
}

// server/bridge.mjs /health handler（line ~1353）扩展：
import { getOpsHealth } from '../kernel/health.mjs'
if (url.pathname === '/health') {
  const activeSessions = [...sessions.values()].filter((s) => !s._reaped)
  const pendingTurns = activeSessions.filter((s) => s._turnActive).length
  return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({
    status: 'ok',
    pid: process.pid,
    sessions: activeSessions.length,
    pendingTurns,
    ops: getOpsHealth({ memory: process.memoryUsage(), pendingTurns }),
  }))
}
```

> 注：bridge 侧 lastApi 采集（最近一次内核 API 调用结果）依赖内核上报——本任务先给 `lastApi: null`（bridge 无法直接感知内核 API 状态）；内核侧上报可在 health.mjs 的 engine 装配点补（record 时记最近一次 API 耗时，经 ponos_health 或后续 wire 事件透传）。第一版以 bridge 可采集项为准，内核 API 状态字段保留 `lastApiOk: null` 占位。

- [x] **Step 4: 跑测试确认通过**

Run: `node --test server/health.test.mjs server/kernel-bridge.test.mjs`
Expected: PASS（health 2 个新增 + 原有全过）

- [x] **Step 5: 提交**

```bash
git add kernel/health.mjs server/bridge.mjs server/health.test.mjs
git commit -m "feat(kernel+bridge): 运维健康——getOpsHealth 纯函数 + /health 会话数聚合（O2-1）"
```

---

### Task 6: /diag/info 补全 + /diag/export（O3-1 + O3-2）

**Files:**
- Modify: `server/bridge.mjs`（/diag/info 扩展 + /diag/export）
- Test: `server/diag-info.test.mjs`（增补）

**Interfaces:**
- Consumes: `redactText`（P2 Task 1）、`transcriptBaseDir`（已有）
- Produces:
  - `/diag/info` 响应 data 追加：`configSummary`（env 白名单键值脱敏）、`skillsLockVersion`（skills-lock.json version，缺失时 null）、`transcriptMB`（transcript 目录总大小）
  - `/diag/export` → `{ ok: true, exported: { generatedAt, env: <脱敏键值>, sessions: <计数>, transcriptMB, logTail: <内核 stderr 日志尾部 100 行>, version } }`（供支持排查；不落盘文件，直接 JSON 返回）

- [x] **Step 1: 写失败测试（增补到 server/diag-info.test.mjs 末尾，沿用该文件 HTTP/WS fixture）**

```js
test('O3-1 /diag/info 补全：configSummary 脱敏 + skillsLockVersion + transcriptMB', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/diag/info`)
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.ok('configSummary' in body.data, 'diag 应含 configSummary')
  // 脱敏：任何键值不含明文 sk-
  const joined = JSON.stringify(body.data.configSummary)
  assert.ok(!/sk-[A-Za-z0-9]{8,}/.test(joined), 'configSummary 不得含明文密钥')
  assert.ok('skillsLockVersion' in body.data)
  assert.ok('transcriptMB' in body.data)
  assert.ok(Number.isFinite(body.data.transcriptMB))
})

test('O3-2 /diag/export：环境脱敏 + transcript 摘要 + 无明文密钥', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/diag/export`)
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.ok(body.ok)
  assert.ok('env' in body.exported)
  assert.ok(!/sk-[A-Za-z0-9]{8,}/.test(JSON.stringify(body.exported.env)))
  assert.ok('sessions' in body.exported)
  assert.ok('transcriptMB' in body.exported)
})
```

- [x] **Step 2: 跑测试确认失败**

Run: `node --test server/diag-info.test.mjs`
Expected: FAIL（configSummary 未定义；/diag/export 404）

- [x] **Step 3: 最小实现（server/bridge.mjs）**

```js
// import 区追加：
import { redactText } from '../kernel/redact.mjs'
import { readFileSync, statSync, readdirSync } from 'node:fs'   // 已 import（同文件多处使用）

// /diag/info handler（line ~1358）扩展：
if (url.pathname === '/diag/info') {
  const cfg = loadConfig()
  const configSummary = {}
  for (const k of Object.keys(process.env)) {
    if (/^(ANTHROPIC_|CLAUDE_|PONOS_|OPENAI_)/.test(k)) configSummary[k] = redactText(process.env[k] || '')
  }
  const skillsLock = join(PONOS_HOME, 'skills-lock.json')
  let skillsLockVersion = null
  try { skillsLockVersion = JSON.parse(readFileSync(skillsLock, 'utf-8')).version ?? null } catch {}
  let transcriptBytes = 0
  const base = transcriptBaseDir()
  try {
    for (const proj of readdirSync(base)) {
      const pdir = join(base, proj)
      if (!statSync(pdir).isDirectory()) continue
      for (const f of readdirSync(pdir)) {
        try { transcriptBytes += statSync(join(pdir, f)).size } catch {}
      }
    }
  } catch {}
  const extended = { ...diagInfo, configSummary, skillsLockVersion, transcriptMB: Math.round(transcriptBytes / 1024 / 1024) }
  return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true, data: extended }))
}

// /diag/export（/diag/info 分支后追加）：
if (url.pathname === '/diag/export') {
  const env = {}
  for (const k of Object.keys(process.env)) {
    if (/^(ANTHROPIC_|CLAUDE_|PONOS_|OPENAI_)/.test(k)) env[k] = redactText(process.env[k] || '')
  }
  const base = transcriptBaseDir()
  let sessions = 0
  try {
    for (const proj of readdirSync(base)) {
      const pdir = join(base, proj)
      if (!statSync(pdir).isDirectory()) continue
      sessions += readdirSync(pdir).filter((f) => f.endsWith('.jsonl')).length
    }
  } catch {}
  return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({
    ok: true,
    exported: {
      generatedAt: new Date().toISOString(),
      version: diagInfo.version || '',
      env,
      sessions,
      transcriptMB: Math.round((() => { try { let b = 0; for (const p of readdirSync(base)) { const pd = join(base, p); if (!statSync(pd).isDirectory()) continue; for (const f of readdirSync(pd)) { try { b += statSync(join(pd, f)).size } catch {} } } return b } catch { return 0 } })() / 1024 / 1024),
    },
  }))
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `node --test server/diag-info.test.mjs`
Expected: PASS（原有 + 新增 2 个）

- [x] **Step 5: 全量回归 + 提交**

```bash
node --test "server/*.test.mjs"
git add server/bridge.mjs server/diag-info.test.mjs
git commit -m "feat(bridge): /diag/info 补全（配置脱敏/skills-lock/transcript 大小）+ /diag/export（O3-1/O3-2）"
```

---

## Self-Review

**Spec coverage（docs/production/observability.md P0+P1 + 用户"内核优先"前提）：**
- O1 每会话用量可查 → Task 1（result 四字段核对）+ Task 2（aggregateUsage bySession）+ Task 4（/transcript/stats 集成）✓
- O2 健康接口完备 → Task 5（getOpsHealth + /health 会话数）✓
- O3 故障可诊断 → Task 6（/diag/info 补全 + /diag/export）✓
- O4 成本可预警 → Task 3（costOf）+ Task 4（预算阈值 env）✓
- O4-2 缓存命中率 → Task 2（cacheRate）✓
- 内核优先前提：聚合/成本/健康计算逻辑在 kernel/（stats.mjs、cost.mjs、health.mjs 纯函数）；bridge 仅文件读取 + 全局会话数拼接 + REST 薄壳；预算阈值走 env（PONOS_MONTHLY_BUDGET_USD）不新增 GUI 设置项 ✓
- O2-2（GUI 健康面板增强）、O3-2 的 GUI 展示为前端工作，本计划只产出内核/服务端能力 ✓

**Placeholder scan：** 无 TBD/TODO；每个代码步骤含完整实现。Task 1 的"修复"步骤为条件性（断言通过则零改动），属验收核对而非占位。

**Type consistency：**
- `aggregateUsage(entries, {bySession})` → `{totals,byModel,byProject,byDate,byTool,cacheRate,bySession?}`（Task 2 定义，Task 4 bridge 消费，一致）
- `costOf(usage, opts)` / `withBudget(rows, budgetUsd)`（Task 3 定义，Task 4 消费 `costOf(totals)`、`withBudget([...], budget)`，一致）
- `getOpsHealth(inputs)` → `{rssMB,heapMB,lastApiOk,lastApiMs,pendingTurns,diskMB}`（Task 5 定义，bridge /health 消费，一致）
- `redactText`（P2 Task 1 产出，Task 6 消费，一致）
- 测试 fixture 中 `assistantEntry(...)` 辅助（Task 2/4 定义，两处一致——Task 4 复用 Task 2 的 helper 并注入 sessionId/project）
