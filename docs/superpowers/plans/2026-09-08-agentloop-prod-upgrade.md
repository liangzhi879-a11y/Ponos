# Agent Loop 生产级差距升级（Phase1+2）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按已批准 spec 把净室内核 `kernel/` + `server/bridge.mjs` 的 agentloop 补齐 8 项生产级能力（U1/J1/AS1/SV1/MS1 + P2-1/P2-2/P2-3），GUI 只产出契约。

**Architecture:** 数据双权威源（冷 = transcript JSONL 经 kernel 只读子命令输出、bridge HTTP 薄转发；热 = engine turnStats + 会话级累计）。A 区纯新增接线先行（只读子命令/health/agent 字段/技能守卫/检索工具），B 区 lane 参数化 + 可选压缩为唯一触碰既有运行路径的结构改动，用两把零回归锁对冲（lane 参数未定义 = 全量、lane 压缩默认关）。

**Tech Stack:** Node（node:test / ESM，仓库既有 kernel 栈）；改动面 kernel/engine.mjs、kernel/health.mjs、kernel/agents.mjs、kernel/cli.mjs、kernel/tools.mjs、kernel/api.mjs（mock）、server/bridge.mjs；新建 kernel/readonly.mjs、kernel/memory-search.mjs、server/kernel-readonly.mjs 与 8 个 kernel-tests 测试文件。

## Global Constraints

- 测试命令：`node --test kernel-tests/*.test.mjs`（kernel 测试不在 `npm test` 内）；`npm test` 覆盖 server/electron。
- mock 测试环境：`PONOS_MOCK_API=1`（api.mjs mock 流，免网络）；engine 直连测试 `opts: { model: 'mock-model', configDir, addDirs: [dir], skipPermissions: true }`（模板 = kernel-tests/subagent.test.mjs `makeEnv`）。
- 零回归锁 ①：agent 的 model/tools/skills 字段未定义或空数组 → lane 全量模型/全量工具/不过滤技能（行为与现状逐字一致）。
- 零回归锁 ②：`PONOS_LANE_COMPACT` 默认未设 → lane 行为与现状一致（无压缩器、无 engineCtx 依赖）。
- 所有新增侧路（Judge/预算/守卫/只读命令）异常一律 try/catch 静默降级，绝不中断主 loop（沿用 health.mjs 全模块风格）。
- 界面边界：kernel + server 为界。bridge HTTP 响应 schema 与 wire 事件字段扩展按 spec 附录 A；不写任何 React/GUI 组件。
- 配置一律 env 位 + 默认值，不触 settings 持久化层。
- 提交粒度：每 Task 结尾一个 commit（实现 + 测试同提交）；commit message 前缀 `feat(s6-agentloop):`。
- runTurn 尾部 `health.record(...)` 之后、`wire.result(...)` 之前为 J1 judge 块插入位（engine.mjs:1635 与 :1637 之间）；turnStats push 在 :1634。

---

### Task 1: P2-1① lane 参数骨架（签名扩展 + 白名单 deny gate + 零回归锁）

**Files:**
- Modify: `kernel/engine.mjs:1077`（runSubAgentLoop 签名与循环内 model 引用）、`:1134`（retryStream tools 收窄）、`:1258`（runToolBatch ctx 透传）、`:1013`（executeToolUse gate）、`:1334`（runLaneExecution laneOptions 透传）
- Test: `kernel-tests/lane-options.test.mjs`

**Interfaces:**
- Consumes: `tools.toolSchemas()` 每项含 `{ name, description, input_schema }`（tools.mjs:1311-1317）；`runToolBatch(blocks, ctx)` 把 ctx 透传 `executeToolUse(b, ctx)`。
- Produces: `runSubAgentLoop({ store, sysPrompt, signal: subSignal, onTool, options = {} })`（options = `{ model, allowedTools, allowedSkills }`，undefined 语义 = 全量）；`runLaneExecution({ taskId, laneStore, sysPrompt, signal: subSignal, writePaths, t0, onTool, laneOptions })`；executeToolUse 顶部 lane 白名单 deny gate（读 `ctx.laneOptions`）。

- [ ] **Step 1: 写回归锁测试（先失败）**

Create `kernel-tests/lane-options.test.mjs`（拷贝 subagent.test.mjs `makeEnv` 样式；本文件头注释声明两把零回归锁）：

```js
// lane 参数骨架回归锁（spec P2-1① + AS1 零回归锁①）
// options 未定义/空 = 现状行为（全量工具、全量模型、无白名单过滤）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from '../kernel/engine.mjs'
import { createSessionStore } from '../kernel/session.mjs'
import { makeWire } from '../kernel/protocol.mjs'

process.env.PONOS_MOCK_API = '1'

function makeEnv() {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const dir = mkdtempSync(join(tmpdir(), 'ponos-laneopt-'))
  const configDir = join(dir, 'home')
  const store = createSessionStore({ configDir, cwd: dir, sessionId: 'main-session' })
  const engine = createEngine({
    opts: { model: 'mock-model', configDir, addDirs: [dir], skipPermissions: true },
    wire,
    session: store,
  })
  engine.setSystemPrompt('你是 Ponos-turbo 测试内核。')
  const laneFile = (taskId) => join(configDir, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'), `${taskId}.jsonl`)
  return { events, engine, store, dir, laneFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('零回归锁①：lane 无 options（现状路径）→ 工具全量可执行、model 沿用主模型', async () => {
  const env = makeEnv()
  try {
    // 后台 spawn，prompt 触发非高危 Bash——不传任何 agent 字段 ⇒ allowedTools 未定义 ⇒ Bash 放行
    const r = await env.engine.spawnSubAgent(
      { subagent_type: 'general-purpose', prompt: '[mock:tool-safe]', run_in_background: true },
      { toolUseId: 'tool_use_laneopt_1' },
    )
    const taskId = String(r.content).match(/task_id: ([0-9a-f-]+)/)?.[1]
    assert.ok(taskId)
    const deadline = Date.now() + 8000
    let notif = null
    while (Date.now() < deadline && !notif) {
      notif = env.events.find((e) => e.type === 'system' && e.subtype === 'task_notification' && e.task_id === taskId)
      await new Promise((res) => setTimeout(res, 10))
    }
    assert.ok(notif, 'task_notification 应到达')
    assert.equal(notif.status, 'completed')
    assert.match(String(notif.summary), /工具执行完成/)
    // 子 lane transcript：assistant 条目 model = 主模型 mock-model（options.model 未定义 → loopModel=model）
    const lines = readFileSync(env.laneFile(taskId), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const asst = lines.filter((e) => e.type === 'assistant')
    assert.ok(asst.length >= 1)
    assert.equal(asst[0].message.model, 'mock-model')
  } finally { env.cleanup() }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test kernel-tests/lane-options.test.mjs`
Expected: 现在尚未改动 engine——此测试其实能过（无 gate 时 Bash 本就放行）。失败点不在行为，故把本步作为"基线冒烟"，真正 TDD 失败点在 Step 4 的实现后回归测试（Step 5 重跑本文件断言仍绿）。若本步已绿则继续（基线 = 零回归起点）。

- [ ] **Step 3: 实现签名扩展 + deny gate + loopModel**

3a. `kernel/engine.mjs` runSubAgentLoop（L1077）签名与内部：

```js
  async function runSubAgentLoop({ store, sysPrompt, signal: subSignal, onTool, options = {} }) {
    let usage = {}
    let textBuf = ''
    let toolUses = 0
    const subT0 = Date.now()
    // P2-1①/AS1：lane 级参数（model/tools/skills 白名单）。options 未定义/空 =
    // 全量（零回归锁①）。loopModel 在 retryStream 与落盘（appendAssistant）统一使用。
    const loopModel = options?.model || model
    const laneToolSchemas = (Array.isArray(options?.allowedTools) && options.allowedTools.length)
      ? tools.toolSchemas().filter((t) => options.allowedTools.includes(t.name))
      : null
```

3b. retryStream 调用（现 L1134）改 tools 收窄：

```js
        for await (const chunk of retryStream({ model: loopModel, messages: msgs(), maxTokens: attemptMaxTokens, signal: streamSignal, tools: laneToolSchemas ?? tools.toolSchemas() })) {
```

3c. 子 lane 内全部落盘点 `store.appendAssistant(blocks, { model })` 第二参改 `{ model: loopModel }`，共 3 处：L1229（截断保护分支）、L1256（常规工具轮）、L1307（熔断收尾 meltdownNotice）：

```js
        store.appendAssistant(assistantBlocks, { model: loopModel })
```

3d. 子 lane 工具批调用（现 L1258）透传 laneOptions（executeToolUse 的 ctx 由此获得白名单）：

```js
      const executed = await runToolBatch(blocks, { lane: true, store, laneOptions: options })
```

3e. `executeToolUse`（L1013）在 `gateToolUse` 之后加白名单 deny gate（先于任何执行；空/未定义 = 放行，零回归锁①）：

```js
  async function executeToolUse(toolUse, ctx = {}) {
    const gate = await gateToolUse(toolUse)
    if (!gate.allowed) return { content: gate.message, isError: true }
    // P2-1①/AS1：lane 白名单 deny gate——子 agent options 显式声明 tools/skills 时收窄。
    // 空数组/未定义跳过（全量）。仅当 mock/模型以名单外工具名发起时才拦截（第二道保险，
    // 第一道是 retryStream 的 tools 收窄让模型根本看不到名单外工具）。
    const lo = ctx?.laneOptions
    if (lo && Array.isArray(lo.allowedTools) && lo.allowedTools.length && !lo.allowedTools.includes(toolUse.name)) {
      return { content: `子 Agent 工具白名单不含 ${toolUse.name}（允许：${lo.allowedTools.join(', ')}），已拒绝执行`, isError: true }
    }
    if (toolUse.name === 'Skill' && Array.isArray(lo?.allowedSkills) && lo.allowedSkills.length
        && !lo.allowedSkills.includes(String(toolUse.input?.skill ?? ''))) {
      return { content: `子 Agent 技能白名单不含「${String(toolUse.input?.skill ?? '')}」（允许：${lo.allowedSkills.join(', ')}），已拒绝加载`, isError: true }
    }
```

3f. `runLaneExecution`（L1334）签名与内部透传：

```js
  async function runLaneExecution({ taskId, laneStore, sysPrompt, signal: subSignal, writePaths, t0, onTool, laneOptions }) {
    ...
      const r = await runSubAgentLoop({ store: laneStore, sysPrompt, signal: subSignal, onTool, options: laneOptions })
```

- [ ] **Step 4: 跑全量 lane 相关测试（回归）**

Run: `node --test kernel-tests/*.test.mjs`
Expected: 全绿（含 subagent.test.mjs 与既有 lane 审计测试——它们都不传 laneOptions，白名单 gate 永不命中）。

- [ ] **Step 5: Commit**

```bash
git add kernel/engine.mjs kernel-tests/lane-options.test.mjs
git commit -m "feat(s6-agentloop): P2-1① lane 参数骨架——runSubAgentLoop/runLaneExecution options 透传 + 白名单 deny gate + 零回归锁①测试"
```

---

### Task 2: AS1 agent spec 三字段接线 + --agents 只读子命令

**Files:**
- Modify: `kernel/agents.mjs:80`（parseAgentMarkdown 加 skills 解析）
- Modify: `kernel/engine.mjs:1367-1438`（spawnSubAgent 取 agent.model/tools/skills 透传 + resume 用 target.laneOptions + warnUnknownAgentRefs）
- Modify: `kernel/cli.mjs:55-101`（parseArgs 加 agents/usage/audit/scope/sessionId/project/from/to flags）、`:133-136` 后（只读子命令短路）、import 顶部
- Create: `kernel/readonly.mjs`（collectTranscriptFiles/runUsage/runAudit/runAgents/runReadonly 一次建全；--agents 本 Task 即用，usage/audit Task 3 用）
- Modify: `kernel/api.mjs`（mock 流新增 `[mock:agent-lane-skill]` + `[mock:lane-skill]` 两分支）
- Test: `kernel-tests/agent-spec.test.mjs`

**Interfaces:**
- Consumes: `resolveAgents({ configDir })` / `resolveAgent(agents, type)`（agents.mjs:108/114）；`sanitizeSegment`（session.mjs）；transcript 行结构 `{ type, seq, timestamp, message, sessionId?/project? 注入 }`。
- Produces: `parseAgentMarkdown` 返回对象新增 `skills: string[]`；`readonly.mjs` 导出 `{ collectTranscriptFiles, runUsage, runAudit, runAgents, runReadonly }`；cli `--agents` 输出 A.4 schema（stdout JSON）；`pendingSubAgents` entry 新增 `laneOptions`。

- [ ] **Step 1: agents.mjs 解析 skills（先行单测）**

`parseAgentMarkdown` 返回对象（L76-83）加一行：

```js
    return {
      id,
      name: id,
      description,
      tools: String(fields.tools || '').split(',').map((s) => s.trim()).filter(Boolean),
      model: fields.model || '',
      skills: String(fields.skills || '').split(',').map((s) => s.trim()).filter(Boolean),
      systemPrompt: (m[2] || '').trim(),
    }
```

- [ ] **Step 2: engine spawnSubAgent 三字段接线**

2a. spawn 分支（L1394 resolveAgent 之后、L1409 sysPrompt 附近）计算 laneOptions，resume 分支（L1388-1391）改传 `target.laneOptions`：

```js
    const agent = resolveAgent(agents, type)
    if (!agent) return { content: `未知子 Agent：${type}。可用：${agents.map((a) => a.id).join(', ')}`, isError: true }
    if (!prompt) return { content: 'prompt 缺失：请说明要委派给子 Agent 的任务', isError: true }
    // AS1：agent spec 三字段接线（P2-1① 签名扩展的消费方）。tools/skills 引用未知项 →
    // wire.warning（level:'agent_spec'）提示不拦截；空/未定义 = 全量（零回归锁①）。
    const laneOptions = {
      model: agent.model || '',
      allowedTools: Array.isArray(agent.tools) && agent.tools.length ? agent.tools : undefined,
      allowedSkills: Array.isArray(agent.skills) && agent.skills.length ? agent.skills : undefined,
    }
    warnUnknownAgentRefs(agent)
```

2b. resume 分支的 runLaneExecution 调用（现 L1388-1391）与后台/前台 exec（现 L1414-1417、L1419-1424）都补 `laneOptions`；pendingSubAgents 登记补 `laneOptions`：

```js
      target.promise = runLaneExecution({
        taskId: resumeTaskId, laneStore: target.laneStore, sysPrompt: target.sysPrompt,
        signal: subController.signal, writePaths, t0, onTool, laneOptions: target.laneOptions,
      })
```
```js
    const exec = () => runLaneExecution({
      taskId, laneStore, sysPrompt,
      signal: subController.signal, writePaths, t0, onTool, laneOptions,
    })
    ...
      pendingSubAgents.set(taskId, {
        status: 'running', promise, laneStore, sysPrompt, lineage, laneOptions,
        stop: () => subController.abort(),
      })
```

2c. 新增 `warnUnknownAgentRefs` 局部函数（放 spawnSubAgent 定义之前；技能表来自 createEngine opts.skillIds——cli 在 Task 6 前无需传，缺省跳过技能校验；工具表用 tools.toolNames）：

```js
  // AS1：agent tools/skills 引用未知项诊断（提示不拦截；skillIds 仅在 cli 提供时校验）
  function warnUnknownAgentRefs(agent) {
    try {
      const knownTools = new Set(tools.toolNames)
      const unknownTools = (agent.tools || []).filter((t) => !knownTools.has(t))
      const knownSkills = new Set(opts.skillIds || [])
      const unknownSkills = (agent.skills || []).filter((s) => !knownSkills.has(s))
      const unk = [...unknownTools.map((t) => `工具 ${t}`), ...unknownSkills.map((s) => `技能 ${s}`)]
      if (unk.length) wire.warning?.({ level: 'agent_spec', agent: agent.id, message: `子 Agent「${agent.id}」引用未知${unk.join('、')}（已忽略，不拦截执行）` })
    } catch { /* 诊断失败静默 */ }
  }
```

- [ ] **Step 3: kernel/readonly.mjs 新建（collectTranscriptFiles + runAgents + runUsage + runAudit + runReadonly）**

Create `kernel/readonly.mjs`（只读子命令实现——kernel 读自家 transcript；纯函数 + 文件遍历，无任何 provider/网络依赖）：

```js
// kernel/readonly.mjs —— kernel 只读子命令（spec 2026-09-08 agentloop U1/AS1）
// ---------------------------------------------------------------------------
// --usage / --audit / --agents 的聚合实现。数据源 = kernel 自身 transcript
// （<configDir>/projects/<cwd-san>/<sessionId>.jsonl）。纯本地只读，由 cli.mjs
// 在进入 loop 前短路调用（stdout JSON）。bridge 只做 HTTP 薄转发，不做跨模块 import。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { aggregateUsage } from './stats.mjs'
import { buildAuditReport } from './audit.mjs'
import { costOf } from './cost.mjs'
import { resolveAgents, discoverUserAgents } from './agents.mjs'

// 遍历 <configDir>/projects/<dir>/*.jsonl，逐行读 transcript 并注入 e.sessionId
// （文件名去 .jsonl）与 e.project（子目录名）；from/to 按 entry.timestamp 前 10 位
// （YYYY-MM-DD）过滤；sessionId/project 过滤在调用方传入后于此处合并执行。
export function collectTranscriptFiles({ configDir = '', sessionId = '', project = '', from = '', to = '' } = {}) {
  const entries = []
  const root = join(configDir, 'projects')
  if (!existsSync(root)) return entries
  let dirs = []
  try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()) } catch { return entries }
  for (const d of dirs) {
    const dirName = d.name
    if (project && dirName !== project) continue
    const dirPath = join(root, dirName)
    let files = []
    try { files = readdirSync(dirPath).filter((f) => f.endsWith('.jsonl')) } catch { continue }
    for (const f of files) {
      const sid = f.slice(0, -'.jsonl'.length)
      if (sessionId && sid !== sessionId) continue
      let text = ''
      try { text = readFileSync(join(dirPath, f), 'utf-8') } catch { continue }
      for (const line of text.split('\n')) {
        const t = line.trim()
        if (!t) continue
        let e = null
        try { e = JSON.parse(t) } catch { continue }
        const ts = String(e.timestamp || '')
        if (from && ts.slice(0, 10) < from) continue
        if (to && ts.slice(0, 10) > to) continue
        entries.push({ ...e, sessionId: sid, project: dirName })
      }
    }
  }
  return entries
}

function readPriceEnv(env = process.env) {
  return {
    pricePerMInput: Number(env.PONOS_PRICE_PER_M_INPUT) || 0.2,
    pricePerMOutput: Number(env.PONOS_PRICE_PER_M_OUTPUT) || 1.2,
    cacheReadRatio: Number(env.PONOS_CACHE_READ_RATIO) || 0.1,
  }
}

export function runUsage({ configDir = '', sessionId = '', project = '', from = '', to = '', scope = 'all' } = {}) {
  const entries = collectTranscriptFiles({ configDir, sessionId, project, from, to })
  const agg = aggregateUsage(entries, { bySession: scope === 'session' })
  const prices = readPriceEnv()
  const byModelCostUsd = {}
  let costUsd = 0
  for (const [m, bucket] of Object.entries(agg.byModel)) {
    const c = costOf(bucket, prices)
    byModelCostUsd[m] = Number(c.toFixed(4))
    costUsd += c
  }
  const budgetUsd = Number(process.env.PONOS_BUDGET_USD) || 0
  return {
    totals: agg.totals,
    byModel: agg.byModel,
    byProject: agg.byProject,
    byDate: agg.byDate,
    byTool: agg.byTool,
    cacheRate: Number(agg.cacheRate.toFixed(4)),
    costUsd: Number(costUsd.toFixed(4)),
    byModelCostUsd,
    budgetUsd,
    overBudget: budgetUsd > 0 && costUsd > budgetUsd,
    ...(scope === 'session' ? { bySession: agg.bySession } : {}),
  }
}

export function runAudit({ configDir = '', sessionId = '', from = '', to = '' } = {}) {
  const entries = collectTranscriptFiles({ configDir, sessionId, from, to })
  return buildAuditReport(entries, { from, to, sessionId })
}

export function runAgents({ configDir = '' } = {}) {
  const userIds = new Set(discoverUserAgents({ configDir }).map((a) => a.id))
  return resolveAgents({ configDir }).map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    model: a.model || '',
    tools: a.tools || [],
    skills: a.skills || [],
    source: userIds.has(a.id) ? 'user' : 'builtin',
  }))
}

// cli 只读子命令统一入口：返回 { output, code }（code 1 = 无数据之外的失败情形预留）
export function runReadonly({ mode = '', args = {}, configDir = '' }) {
  const common = { configDir, sessionId: args.sessionId || '', project: args.project || '', from: args.from || '', to: args.to || '' }
  if (mode === 'agents') return { output: runAgents({ configDir }), code: 0 }
  if (mode === 'usage') return { output: runUsage({ ...common, scope: args.scope || 'all' }), code: 0 }
  if (mode === 'audit') return { output: runAudit(common), code: 0 }
  return { output: { error: `未知只读子命令：${mode}` }, code: 1 }
}
```

- [ ] **Step 4: cli.mjs 只读子命令短路 + parseArgs flags**

4a. import（cli.mjs L23-41 区）加：`import { runReadonly } from './readonly.mjs'`

4b. parseArgs 默认对象（L56-72）加字段：`agents: false, usage: false, audit: false, scope: null, sessionId: null, project: null, from: null, to: null`；switch（L76-99）加 case：

```js
      case '--agents': out.agents = true; break
      case '--usage': out.usage = true; break
      case '--audit': out.audit = true; break
      case '--scope': out.scope = next() ?? null; break
      case '--sessionId': out.sessionId = next() ?? null; break
      case '--project': out.project = next() ?? null; break
      case '--from': out.from = next() ?? null; break
      case '--to': out.to = next() ?? null; break
```

4c. main() 短路（现 L133-136 格式检查之后、L138 `wire` 之前插入；只读子命令不建 wire/session/engine，stdout JSON 后 return 0/1）：

```js
  const args = parseArgs(argv)
  if (args.outputFormat !== REQUIRED_FORMAT || args.inputFormat !== REQUIRED_FORMAT) {
    console.error(`kernel: only ${REQUIRED_FORMAT} I/O format is supported`)
    return 2
  }
  // U1/AS1 只读子命令：--usage / --audit / --agents（stdout JSON，不进 loop）。
  // 聚合实现 kernel/readonly.mjs（kernel 自读 transcript）；bridge 只薄转发。
  if (args.agents || args.usage || args.audit) {
    const mode = args.agents ? 'agents' : args.usage ? 'usage' : 'audit'
    const configDir = resolveConfigDir(process.env, homedir)
    try {
      const { output, code } = runReadonly({ mode, args, configDir })
      console.log(JSON.stringify(output))
      return code
    } catch (e) {
      console.log(JSON.stringify({ error: e?.message || String(e) }))
      return 1
    }
  }
```

- [ ] **Step 5: api.mjs mock 分支（[mock:agent-lane-skill] + [mock:lane-skill]）**

放在 `[mock:lane-trunc]` 分支（现 L282-289）之后、`[mock:agent-lane-overflow]`（L291）之前。两个分支形态与既有 lane 分支一致：主 loop 触发分支用 `lastText` 门控（同 L273-280 agent-lane-trunc）；lane 侧按历史门控。关键差异——lane 侧分支必须带"会话尚无 Skill tool_use"守卫：既有回显分支（L223）在本分支之前，tool_result 回合已被它拦截，故本分支只见非工具回合；若无守卫，deny 路径的 R3-2 注入续跑轮会反复重发 Skill（历史 gate 恒真），白名单拒绝会被重复触发多次。

```js
  // AS1 技能白名单测试：主 loop 标记 → Agent 子任务 prompt 内嵌 [mock:lane-skill]
  if (lastText.includes('[mock:agent-lane-skill]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_mock_agent_lane_skill', name: 'Agent',
      input: { subagent_type: 'general-purpose', prompt: '子任务：请针对 [mock:lane-skill] 输出确认并执行' } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // AS1 技能白名单：lane 会话历史含 [mock:lane-skill] 且尚无 Skill tool_use → 产
  // Skill tool_use {skill:'demo'}。历史门控（同 lane-iter）：[mock:lane-skill] 只存在于
  // lane 转录，不影响主 loop。once 语义靠 laneSkillSeen（前轮 Skill 调用已入历史 →
  // 本分支跳过 → 后续回合走回显/默认收尾，lane 自然完成；deny 路径同样不重复触发）。
  const laneSkillSeen = (messages || []).some((m) => m?.role === 'assistant' &&
    Array.isArray(m?.content) && m.content.some((b) => b?.type === 'tool_use' && b.name === 'Skill'))
  if (!laneSkillSeen && (messages || []).some((m) => m?.role === 'user' && (
    typeof m?.content === 'string'
      ? m.content.includes('[mock:lane-skill]')
      : (Array.isArray(m?.content) && m.content.some((b) => b?.type === 'text' && String(b?.text ?? '').includes('[mock:lane-skill]')))
  ))) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_lane_skill_1', name: 'Skill', input: { skill: 'demo' } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
```

- [ ] **Step 6: 写 agent-spec.test.mjs 并跑绿**

Create `kernel-tests/agent-spec.test.mjs`（makeEnv 样式，但 configDir/agents 下写用户级 agent fixture；demo 技能放 addDirs 下）：

```js
// agent spec 三字段生效（AS1）：model/tools/skills 接线 + 白名单 deny + 零回归锁。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from '../kernel/engine.mjs'
import { createSessionStore } from '../kernel/session.mjs'
import { makeWire } from '../kernel/protocol.mjs'
import { parseAgentMarkdown } from '../kernel/agents.mjs'
import { runAgents } from '../kernel/readonly.mjs'

process.env.PONOS_MOCK_API = '1'

function makeEnv({ agentMd }) {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const dir = mkdtempSync(join(tmpdir(), 'ponos-agspec-'))
  const configDir = join(dir, 'home')
  mkdirSync(join(configDir, 'agents'), { recursive: true })
  if (agentMd) writeFileSync(join(configDir, 'agents', `${agentMd.id}.md`), agentMd.body)
  // demo 技能：Skill 工具 skillLoadRoots 回退 allowDirs=[dir]（createToolRegistry 无
  // skillsDirs 时），故放 <dir>/demo/SKILL.md 即可命中
  mkdirSync(join(dir, 'demo'), { recursive: true })
  writeFileSync(join(dir, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: demo skill\n---\n步骤一\n')
  const store = createSessionStore({ configDir, cwd: dir, sessionId: 'main-session' })
  const engine = createEngine({
    opts: { model: 'mock-model', configDir, addDirs: [dir], skipPermissions: true },
    wire,
    session: store,
  })
  engine.setSystemPrompt('你是 Ponos-turbo 测试内核。')
  const laneFile = (taskId) => join(configDir, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'), `${taskId}.jsonl`)
  const waitNotif = async (taskId, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const n = events.find((e) => e.type === 'system' && e.subtype === 'task_notification' && e.task_id === taskId)
      if (n) return n
      await new Promise((res) => setTimeout(res, 10))
    }
    return null
  }
  return { events, engine, store, dir, laneFile, waitNotif, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('parseAgentMarkdown：skills 字段解析（逗号分隔 + 缺失容错）', () => {
  const md = '---\nname: "spec-agent"\ndescription: "技能限定代理"\nskills: demo, office-docs\n---\nbody'
  const a = parseAgentMarkdown(md)
  assert.deepEqual(a.skills, ['demo', 'office-docs'])
  assert.deepEqual(parseAgentMarkdown('---\nname: "x"\ndescription: "y"\n---\nb').skills, [])
})

test('tools 白名单生效：用户级 general-purpose tools=[Read] → lane 内 Bash 被 deny（transcript 留痕）', async () => {
  const env = makeEnv({ agentMd: { id: 'general-purpose', body: '---\nname: "general-purpose"\ndescription: "受限通用"\ntools: Read\nmodel: "lane-model"\n---\n受限 body\n' } })
  try {
    // 后台跑子任务触发 Bash —— allowedTools=['Read'] ⇒ Bash 被 deny gate 拦
    const r = await env.engine.spawnSubAgent(
      { subagent_type: 'general-purpose', prompt: '[mock:tool-safe]', run_in_background: true },
      { toolUseId: 'tool_use_ag_1' },
    )
    const taskId = String(r.content).match(/task_id: ([0-9a-f-]+)/)?.[1]
    assert.ok(taskId)
    const notif = await env.waitNotif(taskId)
    assert.ok(notif)
    assert.equal(notif.status, 'completed') // deny 后 R3-2 注入耗尽 guardInjections 正常收尾，不是 failed
    // lane transcript：出现 deny 文案 + assistant model = agent.model
    const text = readFileSync(env.laneFile(taskId), 'utf-8')
    assert.match(text, /工具白名单不含 Bash/)
    const asst = text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'assistant')
    assert.ok(asst.some((e) => e.message?.model === 'lane-model'), 'lane 落盘 model 应取 agent.model')
  } finally { env.cleanup() }
})

test('model 生效（对照组）：无用户级覆盖 → 内置 general-purpose 8 基础工具仍全量可用 + model=mock-model', async () => {
  const env = makeEnv({ agentMd: null })
  try {
    const r = await env.engine.spawnSubAgent(
      { subagent_type: 'general-purpose', prompt: '[mock:tool-safe]', run_in_background: true },
      { toolUseId: 'tool_use_ag_2' },
    )
    const taskId = String(r.content).match(/task_id: ([0-9a-f-]+)/)?.[1]
    const notif = await env.waitNotif(taskId)
    assert.ok(notif)
    assert.equal(notif.status, 'completed')
    assert.match(String(notif.summary), /工具执行完成/) // Bash 属内置 8 工具 → 放行
  } finally { env.cleanup() }
})

test('skills 白名单生效（正向）：general-purpose skills=[demo] → Skill demo 可加载', async () => {
  const env = makeEnv({ agentMd: { id: 'general-purpose', body: '---\nname: "general-purpose"\ndescription: "技能代理"\ntools: Skill\ntype: "user"\nskills: demo\n---\n技能 body\n' } })
  try {
    const r = await env.engine.runTurn({ content: '[mock:agent-lane-skill]' })
    assert.ok(String(r.text).includes('工具执行完成'), String(r.text))
    const notif = env.events.find((e) => e.type === 'system' && e.subtype === 'task_notification')
    assert.ok(notif)
    const text = readFileSync(env.laneFile(notif.task_id), 'utf-8')
    assert.match(text, /技能「demo」已加载/)
  } finally { env.cleanup() }
})

test('skills 白名单生效（deny）：skills=[other] → Skill demo 被拒（不落地加载）', async () => {
  const env = makeEnv({ agentMd: { id: 'general-purpose', body: '---\nname: "general-purpose"\ndescription: "受限技能"\ntools: Skill\nskills: other\n---\n受限技能 body\n' } })
  try {
    const r = await env.engine.runTurn({ content: '[mock:agent-lane-skill]' })
    const notif = env.events.find((e) => e.type === 'system' && e.subtype === 'task_notification')
    assert.ok(notif)
    const text = readFileSync(env.laneFile(notif.task_id), 'utf-8')
    assert.match(text, /技能白名单不含「demo」/)
    assert.ok(!text.includes('技能「demo」已加载'))
  } finally { env.cleanup() }
})

test('--agents 输出 schema（runAgents 纯函数）：source 正确区分 builtin/user', async () => {
  const env = makeEnv({ agentMd: { id: 'custom-writer', body: '---\nname: "custom-writer"\ndescription: "自定义代理"\nskills: demo\n---\nc\n' } })
  try {
    const list = runAgents({ configDir: env.dir + '/home' })
    const gp = list.find((a) => a.id === 'general-purpose')
    assert.ok(gp)
    assert.equal(gp.source, 'builtin')
    assert.ok(Array.isArray(gp.tools) && gp.tools.length >= 1)
    const cw = list.find((a) => a.id === 'custom-writer')
    assert.equal(cw.source, 'user')
    assert.deepEqual(cw.skills, ['demo'])
  } finally { env.cleanup() }
})
```

- [ ] **Step 7: 跑全量 kernel-tests**

Run: `node --test kernel-tests/*.test.mjs`
Expected: 全绿（subagent/engine-lane-* 现有测试不受影响——内置 general-purpose 的 tools 8 项含其测试所用全部工具：Bash/Write/Read 等）。

- [ ] **Step 8: Commit**

```bash
git add kernel/agents.mjs kernel/engine.mjs kernel/cli.mjs kernel/readonly.mjs kernel/api.mjs kernel-tests/agent-spec.test.mjs
git commit -m "feat(s6-agentloop): AS1 agent spec 三字段接线（skills 解析 + lane 白名单生效 + unknown ref warning）+ --agents 只读子命令"
```

---

### Task 3: U1 kernel 只读子命令接线 + 测试（--usage / --audit）

**Files:**
- Modify: `kernel/cli.mjs`（Task 2 Step 4 已含短路与 flags——本 Task 仅核对/补齐，无新 kernel 代码改动预期；若 Task 2 未含则补）
- Test: `kernel-tests/usage.test.mjs`（runUsage/runAudit 纯函数 + fixture transcript 数值断言）
- Test: `kernel-tests/cli-subcommands.test.mjs`（spawn `node kernel/cli.mjs --usage/--audit/--agents` 输出 schema 冒烟）

**Interfaces:**
- Consumes: `runUsage`/`runAudit`/`runReadonly`（readonly.mjs）；transcript fixture 写入路径 `<configDir>/projects/<sanitizeSegment(cwd)>/<sid>.jsonl`（sanitizeSegment 从 session.mjs import）。
- Produces: 无新生产接口（测试驱动验证 U1 schema A.1/A.2 与 cli 短路）。

- [ ] **Step 1: 核对 cli 短路与 parseArgs 已含 usage/audit 接线（Task 2 已做）**

Run: `node kernel/cli.mjs --agents --output-format stream-json --input-format stream-json 2>&1 | head -c 200`
Expected: JSON 数组输出（schema A.4），非 usage 帮助文本。若 Task 2 的短路代码未含 usage/audit 分支，补齐 `mode` 三元（Step 见 Task 2 Step 4c 已含）。

- [ ] **Step 2: 写 usage.test.mjs（fixture transcript → runUsage 数值断言）**

Create `kernel-tests/usage.test.mjs`：

```js
// U1 纯函数（kernel/readonly.mjs）：fixture transcript → aggregateUsage/costOf 数值 + schema。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sanitizeSegment } from '../kernel/session.mjs'
import { runUsage, runAudit } from '../kernel/readonly.mjs'

const USAGE1 = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 200, cache_creation_input_tokens: 100 }
function entry(type, { content, usage, model, role, seq } = {}) {
  const e = { type, seq, timestamp: '2026-09-08T10:00:00.000Z' }
  if (type === 'assistant') e.message = { role: 'assistant', content: content ?? [], usage, model: model || 'mock-model' }
  else e.message = { role: role || 'user', content }
  return e
}

test('runUsage：fixture 数值（totals/byModel/byTool/cacheRate/costUsd/budgetUsd）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-usage-'))
  try {
    const cwd = join(dir, 'proj-a')
    const projDir = join(dir, 'home', 'projects', sanitizeSegment(cwd))
    mkdirSync(projDir, { recursive: true })
    const sid = 'sess-1'
    const lines = [
      { type: 'meta', schemaVersion: 1 },
      entry('assistant', { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], usage: USAGE1 }),
      entry('user', { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }),
      entry('assistant', { content: [], usage: { input_tokens: 500, output_tokens: 100 }, model: 'other-model' }),
    ].map((l) => JSON.stringify(l)).join('\n') + '\n'
    writeFileSync(join(projDir, `${sid}.jsonl`), lines)
    const out = runUsage({ configDir: join(dir, 'home') })
    assert.equal(out.totals.input_tokens, 1500)
    assert.equal(out.totals.output_tokens, 600)
    assert.equal(out.totals.turns, 2)
    assert.equal(out.byModel['mock-model'].input_tokens, 1000)
    assert.equal(out.byTool.Bash, 1)
    assert.equal(out.cacheRate, 200 / (1000 + 200)) // cacheRead / (input+cacheRead)
    assert.ok(out.costUsd > 0)
    assert.equal(out.budgetUsd, 0)
    assert.equal(out.overBudget, false)
    assert.equal(out.byProject[Object.keys(out.byProject)[0]].turns, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('runUsage：scope/sessionId/from/to 过滤', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-usage-'))
  try {
    const cwd = join(dir, 'proj-a')
    const projDir = join(dir, 'home', 'projects', sanitizeSegment(cwd))
    mkdirSync(projDir, { recursive: true })
    const mk = (sid, day, inp) => JSON.stringify({ type: 'assistant', seq: 1, timestamp: `${day}T00:00:00.000Z`, message: { role: 'assistant', content: [], usage: { input_tokens: inp, output_tokens: 1 }, model: 'm' } })
    writeFileSync(join(projDir, 's-a.jsonl'), mk('s-a', '2026-09-01', 100) + '\n' + mk('s-a', '2026-09-05', 100) + '\n')
    writeFileSync(join(projDir, 's-b.jsonl'), mk('s-b', '2026-09-08', 50) + '\n')
    const base = join(dir, 'home')
    assert.equal(runUsage({ configDir: base, scope: 'session' }).totals.input_tokens, 250)
    assert.equal(runUsage({ configDir: base }).bySession === undefined, true)
    const sess = runUsage({ configDir: base, sessionId: 's-b' })
    assert.equal(sess.totals.input_tokens, 50)
    assert.ok(sess.bySession)
    assert.equal(runUsage({ configDir: base, from: '2026-09-06', to: '2026-09-09' }).totals.input_tokens, 50)
    assert.equal(runUsage({ configDir: base, project: sanitizeSegment(cwd), to: '2026-09-02' }).totals.input_tokens, 100)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('runAudit：rows 含 tool_use/tool_result、params 截断 200、from/to 过滤', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-usage-'))
  try {
    const projDir = join(dir, 'home', 'projects', 'p')
    mkdirSync(projDir, { recursive: true })
    const big = JSON.stringify({ command: 'x'.repeat(500) })
    const lines = [
      { type: 'assistant', seq: 2, timestamp: '2026-09-08T00:00:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'x'.repeat(500) } }] } },
      { type: 'user', seq: 3, timestamp: '2026-09-08T00:00:01.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'done' }] } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n'
    writeFileSync(join(projDir, 's.jsonl'), lines)
    const rows = runAudit({ configDir: join(dir, 'home'), sessionId: 's' })
    assert.equal(rows.length, 2)
    assert.equal(rows[0].type, 'tool_use')
    assert.equal(rows[0].tool, 'Bash')
    assert.equal(rows[0].session, 's')
    assert.ok(rows[0].params.length <= 200 + 1, 'params 应截断到 ~200')
    assert.equal(rows[1].type, 'tool_result')
    assert.equal(rows[1].toolUseId, 'tu-1')
    assert.equal(runAudit({ configDir: join(dir, 'home'), from: '2026-09-09' }).length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
```

- [ ] **Step 3: 跑 usage.test.mjs**

Run: `node --test kernel-tests/usage.test.mjs`
Expected: 全绿。

- [ ] **Step 4: 写 cli-subcommands.test.mjs（真实 spawn 冒烟）**

Create `kernel-tests/cli-subcommands.test.mjs`（spawn 封装拷贝 kernel-bridge.test.mjs 最小集；只读子命令无需 stdin 交互，等 exit 取 stdout）：

```js
// U1/AS1 cli 只读子命令冒烟：spawn `node kernel/cli.mjs --usage/--audit/--agents`
// （CLAUDE_CONFIG_DIR 指向 fixture 临时目录，PONOS_MOCK_API=1 免网络）→ stdout JSON。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sanitizeSegment } from '../kernel/session.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const KERNEL_CLI = join(__dirname, '..', 'kernel', 'cli.mjs')
const FMT = ['--output-format', 'stream-json', '--input-format', 'stream-json']

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [KERNEL_CLI, ...FMT, ...args], { env })
    let out = ''
    let err = ''
    proc.stdout.on('data', (d) => { out += d })
    proc.stderr.on('data', (d) => { err += d })
    proc.on('close', (code) => resolve({ code, out, err }))
    proc.on('error', reject)
  })
}

test('cli --usage / --audit / --agents：stdout JSON 输出 schema（fixture transcript）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-clisub-'))
  try {
    const cwd = join(dir, 'proj-a')
    const projDir = join(dir, 'home', 'projects', sanitizeSegment(cwd))
    mkdirSync(projDir, { recursive: true })
    writeFileSync(join(projDir, 's1.jsonl'),
      JSON.stringify({ type: 'assistant', seq: 1, timestamp: '2026-09-08T00:00:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }], usage: { input_tokens: 100, output_tokens: 50 }, model: 'm' } }) + '\n')
    const env = { ...process.env, PONOS_MOCK_API: '1', CLAUDE_CONFIG_DIR: join(dir, 'home'), YFWORKING_HOME: join(dir, 'home') }
    const usage = await runCli(['--usage'], env)
    assert.equal(usage.code, 0, usage.err)
    const u = JSON.parse(usage.out)
    assert.equal(u.totals.input_tokens, 100)
    assert.equal(u.totals.output_tokens, 50)
    assert.equal(u.byTool.Bash, 1)
    assert.equal(typeof u.costUsd, 'number')
    assert.equal(u.overBudget, false)
    const audit = await runCli(['--audit'], env)
    assert.equal(audit.code, 0, audit.err)
    const rows = JSON.parse(audit.out)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].tool, 'Bash')
    const agents = await runCli(['--agents'], env)
    assert.equal(agents.code, 0, agents.err)
    const list = JSON.parse(agents.out)
    assert.ok(Array.isArray(list) && list.some((a) => a.id === 'general-purpose'))
    assert.ok(list.every((a) => ['builtin', 'user'].includes(a.source)))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
```

- [ ] **Step 5: 跑全量 kernel-tests + 收尾 Commit**

Run: `node --test kernel-tests/*.test.mjs`
Expected: 全绿。

```bash
git add kernel/cli.mjs kernel-tests/usage.test.mjs kernel-tests/cli-subcommands.test.mjs
git commit -m "feat(s6-agentloop): U1 usage/audit 只读子命令接线 + fixture 数值/冒烟测试"
```

---

### Task 4: U1 server 端点（/api/usage /api/audit）+ kernel-readonly.mjs

**Files:**
- Create: `server/kernel-readonly.mjs`（同步调 kernel 只读子命令；免 shell quoting 用 execFileSync(process.execPath)）
- Modify: `server/bridge.mjs:1304`（/health 分支后加两端点）
- Test: `server/kernel-readonly.test.mjs`（spawn kernel --usage 成功路径 + 失败路径；被 `npm test` server glob 收录）

**Interfaces:**
- Consumes: bridge `buildChildEnv()`（bridge.mjs:661）、`YFW_HOME`、`reply` 样板（bridge.mjs if-chain）。
- Produces: `server/kernel-readonly.mjs` 导出 `kernelReadonlySync(argsList, { env, cwd })` → stdout string（throw on 非零退出）；bridge GET `/api/usage`、`/api/audit`（query 透传 → 502 on 失败）。

- [ ] **Step 1: server/kernel-readonly.mjs 新建**

Create `server/kernel-readonly.mjs`：

```js
// server/kernel-readonly.mjs —— bridge → kernel 只读子命令薄转发（U1/AS1）
// ---------------------------------------------------------------------------
// execFileSync(process.execPath, [cli, ...args]) 免 shell quoting（对比 spawn shell:true
// 拼接需 q() 转义）。cli 路径解析与 findYFWorking 同源（YFWORKING_KERNEL > <repo>/kernel/
// cli.mjs > <repo>/kernel-dist/cli.mjs）。60s 超时兜底——只读聚合毫秒级，超时视为内核故障。
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export function resolveKernelCli() {
  if (process.env.YFWORKING_KERNEL) {
    if (!existsSync(process.env.YFWORKING_KERNEL)) throw new Error(`kernel not found: YFWORKING_KERNEL=${process.env.YFWORKING_KERNEL}`)
    return process.env.YFWORKING_KERNEL
  }
  for (const rel of ['../kernel/cli.mjs', '../kernel-dist/cli.mjs']) {
    const p = join(__dirname, rel)
    if (existsSync(p)) return p
  }
  throw new Error('[kernel-readonly] kernel cli.mjs not found — set YFWORKING_KERNEL')
}

// 同步调只读子命令（--usage/--audit/--agents）。stdout = JSON（cli 短路输出）；
// 非零退出抛错（调用方回 502）。同步阻塞可接受：只读聚合毫秒级，60s 超时兜底防悬挂。
export function kernelReadonlySync(argsList = [], { env = process.env, cwd = process.cwd(), timeoutMs = 60_000 } = {}) {
  const cli = resolveKernelCli()
  const stdio = ['ignore', 'pipe', 'pipe']
  const out = execFileSync(process.execPath, [cli, '--output-format', 'stream-json', '--input-format', 'stream-json', ...argsList], {
    env, cwd, timeout: timeoutMs, stdio, encoding: 'utf8',
  })
  return out.trim()
}
```

- [ ] **Step 2: bridge.mjs 两端点**

在 `/health` 分支（L1304-1306）之后插入（import 顶部加 `import { kernelReadonlySync } from './kernel-readonly.mjs'`）：

```js
    // U1 只读子命令薄转发：query → kernel 只读子命令 → 透传 stdout JSON（schema A.1/A.2）
    if (url.pathname === '/api/usage' || url.pathname === '/api/audit') {
      const sub = url.pathname === '/api/usage' ? '--usage' : '--audit'
      const flags = []
      for (const k of ['scope', 'sessionId', 'project', 'from', 'to']) {
        const v = url.searchParams.get(k)
        if (v) flags.push(`--${k}`, v)
      }
      try {
        const out = kernelReadonlySync([sub, ...flags], { env: buildChildEnv(), cwd: process.cwd() })
        return reply(200, { 'Content-Type': 'application/json' }, out)
      } catch (e) {
        return reply(502, { 'Content-Type': 'application/json' }, JSON.stringify({ error: e?.message || String(e) }))
      }
    }
```

- [ ] **Step 3: server/kernel-readonly.test.mjs（npm test 收录）**

Create `server/kernel-readonly.test.mjs`：

```js
// kernel-readonly 冒烟：真实 spawn kernel 只读子命令（PONOS_MOCK_API=1 + 临时 home，
// 与 kernel-bridge.test.mjs 同款隔离）。npm test server/*.test.mjs glob 收录。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { kernelReadonlySync, resolveKernelCli } from './kernel-readonly.mjs'

test('resolveKernelCli：能定位 kernel cli.mjs', () => {
  const p = resolveKernelCli()
  assert.ok(p.endsWith('cli.mjs'), p)
})

test('kernelReadonlySync：--agents / --usage 真实 spawn 返回 JSON', () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-kr-home-'))
  try {
    const env = { ...process.env, PONOS_MOCK_API: '1', CLAUDE_CONFIG_DIR: home, YFWORKING_HOME: home }
    const agents = JSON.parse(kernelReadonlySync(['--agents'], { env, cwd: process.cwd() }))
    assert.ok(Array.isArray(agents) && agents.length >= 2)
    const usage = JSON.parse(kernelReadonlySync(['--usage'], { env, cwd: process.cwd() }))
    assert.equal(typeof usage.totals.input_tokens, 'number')
  } finally { rmSync(home, { recursive: true, force: true }) }
})
```

- [ ] **Step 4: 跑 npm test（server 侧）+ kernel-tests**

Run: `npm test`
Expected: 全部 server/electron 测试绿（含新 kernel-readonly.test.mjs）。

- [ ] **Step 5: Commit**

```bash
git add server/kernel-readonly.mjs server/bridge.mjs server/kernel-readonly.test.mjs
git commit -m "feat(s6-agentloop): U1 bridge /api/usage /api/audit 端点——kernelReadonlySync 薄转发（schema A.1/A.2）"
```

---

### Task 5: J1 health Judge 接线

**Files:**
- Modify: `kernel/health.mjs`（createHealth 加 runJudge 注入位 + judgeEnabled 双 env + recordFailure + recordJudge + emitIfChanged(force) + snapshotState）
- Modify: `kernel/engine.mjs:1635`（runTurn 尾部 judge 块 + 兜底分支 recordFailure）
- Modify: `kernel/cli.mjs:222`（createHealth 后注入 runJudge 包装 engine.judgeUntil）
- Test: `kernel-tests/health-judge.test.mjs`

**Interfaces:**
- Consumes: `engine.judgeUntil({ target, maxTokens })`（engine.mjs:1545 区）；`shouldJudge` 纯函数（health.mjs:46）。
- Produces: `createHealth({ wire, model, contextWindow, env })`（签名不加 runJudge）返回对象新增 `recordFailure()` / `recordJudge({done,reason})` / `snapshotState()`；`emitIfChanged(force)` 重写；`wire.health` 可选 `judge: { done, reason }` 字段（一次性）。`health.runJudge` 为可选**数据属性注入位**（引擎经 `health.runJudge?.()` 调用、cli 在 createEngine 后赋值——对象 data property，无需构造期传入）。

- [ ] **Step 1: health.mjs 状态机扩展**

1a. L62 `judgeEnabled` 双 env（替换原单 env 行）：

```js
  const judgeEnabled = env.PONOS_LLM_JUDGE === '1' || env.CLAUDE_CODE_LLM_JUDGE === '1'
```

1b. `let pendingJudge = null` 追加到 `const failures = { count: 0 }`（L61，已存在）之后（只加这一块，勿重复 `recent`/`failures`/`judgeEnabled`）：

```js
  // J1：Judge 结论暂存——仅随 force 发（recordJudge → emitIfChanged(true)）的
  // ponos_health 一次性带出（judge 字段；发完即清，不残留到后续事件）
  let pendingJudge = null
```

`runJudge` 不内建（引擎 `health.runJudge?.()` 调用、cli 在 createEngine 后对其赋值——可选数据属性，见 Step 3）。

1c. `emitIfChanged` 重写（L88-94）支持 force + judge 载荷：

```js
  function emitIfChanged(force = false) {
    const h = snapshot()
    const changed = force || h.tier !== lastTier
    if (changed) {
      lastTier = h.tier
      const base = { score: h.score, tier: h.tier, compactCount, remainingPct: h.remainingPct, remainingTurns: h.remainingTurns, suggestNewSession: h.suggestNewSession, reason: h.reason, growthPerTurn: h.growthPerTurn, predictedTurns: h.predictedTurns }
      wire.health?.({ ...base, ...(pendingJudge ? { judge: pendingJudge } : {}) })
    }
    if (force) pendingJudge = null // force 发完即清：judge 只随当次事件带出
  }
```

1d. 返回对象（L96-122）新增方法（放 shouldRunJudge 之后）：

```js
    // J1：内部错误兜底登记（engine runTurn 非 Abort 异常路径调用）——即时重估，
    // failures 计分进 snapshot（上限 +30），档位变化即发 ponos_health
    recordFailure() {
      try {
        failures.count += 1
        emitIfChanged()
      } catch { /* 静默降级 */ }
    },
    // J1：Judge 结论暂存 + 强制带出（done/reason 进 wire.health.judge，一次性）
    recordJudge({ done, reason } = {}) {
      try {
        pendingJudge = { done: done === true, reason: String(reason || '') }
        emitIfChanged(true)
      } catch { /* 静默降级 */ }
    },
    snapshotState() {
      try { return snapshot() } catch { return null }
    },
```

- [ ] **Step 2: engine.mjs runTurn 接线**

2a. 内部错误兜底分支（L1620-1631，`if (e?.name === 'AbortError') throw e` 之后、`const errMsg` 前）加 recordFailure：

```js
        // J1：内部错误（非取消）登记到 health failures——多次失败推高健康分/触发红档判定
        try { health?.recordFailure?.() } catch { /* 静默 */ }
```

2b. L1635 `health?.record(...)` 之后、L1637 `wire.result` 之前加 judge 块：

```js
      health?.record(turnStats[turnStats.length - 1])
      // J1：LLM-as-Judge 低频抽检（shouldRunJudge = 红档 + 冷却 300s；默认关零行为）。
      // judge 失败/抛异常一律静默——判定不得影响主流程（spec：Judge 为新增侧路）。
      // health.runJudge 为可选数据属性（cli 装配 engine.judgeUntil 包装，见 Task5 Step 3）
      try {
        if (health?.shouldRunJudge?.()) {
          const j = await health.runJudge?.(health.snapshotState?.() ?? null)
          if (j) health.recordJudge?.(j)
        }
      } catch { /* judge 异常静默：不影响本轮 result */ }
```

- [ ] **Step 3: cli.mjs 装配 runJudge**

在 `const engine = createEngine({...})`（L240-260）之后插入（引用 engine.judgeUntil，closured）：

```js
  // J1：health Judge 注入位——包装 engine.judgeUntil 作健康判定（目标 = 当前会话
  // 健康状态判定：是否建议重置/继续/压缩后继续）。默认关（PONOS_LLM_JUDGE /
  // CLAUDE_CODE_LLM_JUDGE），开时仅红档 + 冷却 300s 触发；异常由 health 侧静默。
  try {
    health.runJudge = async () => {
      const j = await engine.judgeUntil({
        target: '判定当前会话健康状态：是否建议重置会话 / 继续当前会话 / 压缩上下文后继续',
        maxTokens: 512,
      })
      return { done: j?.done === true, reason: j?.reason || j?.raw || '' }
    }
  } catch { /* 注入失败不阻断启动（judge 可选能力） */ }
```

- [ ] **Step 4: health-judge.test.mjs**

Create `kernel-tests/health-judge.test.mjs`：

```js
// J1 health Judge：状态机（recordFailure/recordJudge/冷却/runJudge 注入）+ engine 集成。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHealth, shouldJudge, computeHealthScore } from '../kernel/health.mjs'
import { createEngine } from '../kernel/engine.mjs'
import { createSessionStore } from '../kernel/session.mjs'
import { makeWire } from '../kernel/protocol.mjs'

process.env.PONOS_MOCK_API = '1'

function collectHealth() {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  return { events, wire }
}

test('shouldJudge 纯函数：红档+开+冷却 → true；绿档/关/冷却内 → false', () => {
  const now = Date.now()
  assert.equal(shouldJudge({ tier: 'red', judgeEnabled: true, lastJudgeAt: 0, now }), true)
  assert.equal(shouldJudge({ tier: 'green', judgeEnabled: true, lastJudgeAt: 0, now }), false)
  assert.equal(shouldJudge({ tier: 'red', judgeEnabled: false, lastJudgeAt: 0, now }), false)
  assert.equal(shouldJudge({ tier: 'red', judgeEnabled: true, lastJudgeAt: now - 1000, now }), false)
  assert.equal(shouldJudge({ tier: 'red', judgeEnabled: true, lastJudgeAt: now - 300_100, now }), true)
})

test('recordJudge：force 发 ponos_health 且带 judge 字段一次性（下次 record 不再带）', () => {
  const { events, wire } = collectHealth()
  const h = createHealth({ wire, contextWindow: 200_000 })
  h.recordJudge({ done: true, reason: '建议继续' })
  let healthEv = events.filter((e) => e.type === 'ponos_health')
  assert.equal(healthEv.length, 1)
  assert.deepEqual(healthEv[0].judge, { done: true, reason: '建议继续' })
  // 普通 record（tier 不变不发）→ 后续事件不残留 judge
  h.record({ usage: { input_tokens: 100 }, compactCount: 0 })
  assert.equal(events.filter((e) => e.type === 'ponos_health').length, 1)
})

test('recordFailure：failures 计入 snapshotState 计分（上限 +30，tier 绿不变不发事件）', () => {
  const { events, wire } = collectHealth()
  const h = createHealth({ wire, contextWindow: 200_000 })
  // 空 recent：predictTurns 默认 growth 1000 → remainingTurns≈160（>10 无加分），
  // remainingPct=100 → score 恒 = min(failures,3)*10，档位绿 → 不发 ponos_health
  assert.equal(h.snapshotState().score, 0)
  h.recordFailure()
  assert.equal(h.snapshotState().score, 10)
  h.recordFailure(); h.recordFailure()
  assert.equal(h.snapshotState().score, 30)
  h.recordFailure(); h.recordFailure()
  assert.equal(h.snapshotState().score, 30, 'failures 计分封顶 +30')
  assert.equal(h.snapshotState().tier, 'green')
  assert.equal(events.filter((e) => e.type === 'ponos_health').length, 0, '绿档 recordFailure 不打扰（档位变化才发）')
})

test('computeHealthScore 纯函数：failures 加分封顶与 tier 边界', () => {
  assert.equal(computeHealthScore({}).tier, 'green')
  assert.equal(computeHealthScore({ failures: 3 }).score, 30)
  assert.equal(computeHealthScore({ failures: 9 }).score, 30, 'failures 封顶 +30')
  assert.equal(computeHealthScore({ remainingPct: 20 }).tier, 'amber') // 45 分
  assert.equal(computeHealthScore({ remainingPct: 20, failures: 3 }).tier, 'red') // 75 分
  assert.equal(computeHealthScore({ remainingTurns: 3 }).tier, 'red') // 30 + forceRed
})

test('runJudge 注入位：shouldRunJudge 门 + runJudge 被调 + 结果入事件（stub health）', async () => {
  // 直连 engine：传 stub health 观察接线点（真实状态机冷却另测于上）
  const dir = mkdtempSync(join(tmpdir(), 'ponos-judge-'))
  try {
    const events = []
    const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
    const store = createSessionStore({ configDir: join(dir, 'home'), cwd: dir, sessionId: 'main' })
    const calls = { judge: 0, recordFailure: 0 }
    const health = {
      record() {},
      shouldRunJudge() { return calls.judge < 1 }, // 首轮后冷却（模拟）
      async runJudge() { calls.judge++; return { done: false, reason: '健康判定完成' } },
      recordJudge(j) { calls.lastJudge = j },
      snapshotState() { return { tier: 'green' } },
      recordFailure() { calls.recordFailure++ },
    }
    const engine = createEngine({ opts: { model: 'mock-model', configDir: join(dir, 'home'), addDirs: [dir], skipPermissions: true }, wire, session: store })
    engine.setSystemPrompt('你是测试内核。')
    await engine.runTurn({ content: '你好' })
    assert.equal(calls.judge, 1, '首轮应触发一次 judge')
    assert.deepEqual(calls.lastJudge, { done: false, reason: '健康判定完成' })
    await engine.runTurn({ content: '再来一轮' })
    assert.equal(calls.judge, 1, '冷却内不应再触发')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('runJudge 抛异常静默：轮次照常完成（judge 不得影响主流程）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-judge-'))
  try {
    const events = []
    const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
    const store = createSessionStore({ configDir: join(dir, 'home'), cwd: dir, sessionId: 'main' })
    const health = {
      record() {},
      shouldRunJudge() { return true },
      async runJudge() { throw new Error('judge boom') },
      recordJudge() {},
      snapshotState() { return { tier: 'red' } },
      recordFailure() {},
    }
    const engine = createEngine({ opts: { model: 'mock-model', configDir: join(dir, 'home'), addDirs: [dir], skipPermissions: true }, wire, session: store })
    engine.setSystemPrompt('你是测试内核。')
    const r = await engine.runTurn({ content: '你好' }) // 不应抛
    assert.match(r.text, /mock:/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
```

- [ ] **Step 5: 跑全量 kernel-tests**

Run: `node --test kernel-tests/*.test.mjs`
Expected: 全绿（engine runTurn 兜底分支改动不改变既有行为——AbortError 仍原样上抛）。

- [ ] **Step 6: Commit**

```bash
git add kernel/health.mjs kernel/engine.mjs kernel/cli.mjs kernel-tests/health-judge.test.mjs
git commit -m "feat(s6-agentloop): J1 health Judge 接线——recordFailure/recordJudge/snapshotState + runTurn 尾部 judge 块 + cli runJudge 装配"
```

---

### Task 6: SV1 技能版本守卫

**Files:**
- Modify: `kernel/cli.mjs`（skills 发现块 L273-279 之后加 lock 校验 + import verifySkillVersions）
- Test: `kernel-tests/skill-lock.test.mjs`（verifySkillVersions fixtures：缺文件/顶层/嵌套/匹配/过期）

**Interfaces:**
- Consumes: `verifySkillVersions({ lockPath, skills }) → { outdated: [{id, lock, disk}] }`（skills.mjs:109）；`discoverSkills` 每技能含 `version`（skills.mjs:67）。
- Produces: 无新接口；wire.warning `{ level: 'skill_version', outdated }`（A.3）。

- [ ] **Step 1: cli.mjs 启动校验**

import：把 cli.mjs L36 的 `import { discoverSkills } from './skills.mjs'` 合并为 `import { discoverSkills, verifySkillVersions } from './skills.mjs'`（`existsSync`/`join` cli.mjs 已 import）。

skills 发现 for 循环（L275-279）之后插入：

```js
  // SV1 技能版本守卫：<configDir>/skills.lock.json 存在时校验当前技能表 id/version。
  // outdated 非空 → wire.warning(level:'skill_version')，不阻断启动（lock 当前无写入
  // 者，文件不存在即零激活——天然零回归）。
  try {
    const lockPath = join(configDir, 'skills.lock.json')
    if (existsSync(lockPath)) {
      const { outdated } = verifySkillVersions({ lockPath, skills })
      if (outdated.length) wire.warning?.({ level: 'skill_version', outdated })
    }
  } catch { /* 版本校验失败不阻断启动 */ }
```

- [ ] **Step 2: skill-lock.test.mjs**

Create `kernel-tests/skill-lock.test.mjs`：

```js
// SV1 技能版本守卫 fixtures：verifySkillVersions（skills.mjs）两形态 lock/缺文件/匹配/过期。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifySkillVersions } from '../kernel/skills.mjs'

function lockDir(obj) {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-sv1-'))
  if (obj !== null) writeFileSync(join(dir, 'skills.lock.json'), JSON.stringify(obj))
  return dir
}
const SKILLS = [
  { id: 'a', version: '1.0.0' },
  { id: 'b', version: '2.0.0' },
  { id: 'c', version: '' }, // 磁盘技能无版本 → 不参与校验（want 存在但 disk 空不报）
]

test('缺 lock 文件 → 零激活', () => {
  const dir = lockDir(null)
  try { assert.deepEqual(verifySkillVersions({ lockPath: join(dir, 'skills.lock.json'), skills: SKILLS }), { outdated: [] }) }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

test('顶层形态 lock：匹配无 outdated / 过期报 id+lock+disk', () => {
  const dir = lockDir({ a: '1.0.0', b: '9.0.0' })
  try {
    const r = verifySkillVersions({ lockPath: join(dir, 'skills.lock.json'), skills: SKILLS })
    assert.equal(r.outdated.length, 1)
    assert.deepEqual(r.outdated[0], { id: 'b', lock: '9.0.0', disk: '2.0.0' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('嵌套形态 lock { skills: {...} } 同语义；顶层 skills 键被跳过', () => {
  const dir = lockDir({ skills: { a: '1.0.0', b: '9.0.0' }, unrelated: 'x' })
  try {
    const r = verifySkillVersions({ lockPath: join(dir, 'skills.lock.json'), skills: SKILLS })
    assert.equal(r.outdated.length, 1)
    assert.equal(r.outdated[0].id, 'b')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('lock 损坏 JSON → 容错空结果', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-sv1-'))
  try { writeFileSync(join(dir, 'skills.lock.json'), '{oops') } catch {}
  try { assert.deepEqual(verifySkillVersions({ lockPath: join(dir, 'skills.lock.json'), skills: SKILLS }), { outdated: [] }) }
  finally { rmSync(dir, { recursive: true, force: true }) }
})
```

- [ ] **Step 3: 跑全量 kernel-tests + Commit**

Run: `node --test kernel-tests/*.test.mjs`
Expected: 全绿。

```bash
git add kernel/cli.mjs kernel-tests/skill-lock.test.mjs
git commit -m "feat(s6-agentloop): SV1 技能版本守卫——cli 启动 lock 校验 + wire.warning(level:'skill_version')"
```

---

### Task 7: MS1 MemorySearch 工具

**Files:**
- Create: `kernel/memory-search.mjs`（searchLocalMemory：无模型向量检索）
- Modify: `kernel/tools.mjs:935`（createToolRegistry 参数加 memoryRoot/projectMemoryRoot + 注册 MemorySearch）
- Modify: `kernel/engine.mjs:385`（createToolRegistry 调用透传 memoryRoot）
- Modify: `kernel/cli.mjs:240`（engine opts 加 memoryRoot: memoryRoot(configDir)）
- Test: `kernel-tests/memory-search.test.mjs`

**Interfaces:**
- Consumes: `gramTokens`/`vectorizeText`/`cosine`（graph.mjs:25/60/74）；`parseEntryLine`（memory.mjs:44）；条目格式 `- [会话|标签] 摘要 -- 全文`。
- Produces: `searchLocalMemory({ personalRoot, projectRoot = '', query, topK = 5, scope = 'all' }) → { items: [{theme,tag,summary,full,file,score}], count }`；tools.mjs 注册 `MemorySearch`（schema A.5）。

- [ ] **Step 1: kernel/memory-search.mjs 新建**

Create `kernel/memory-search.mjs`：

```js
// kernel/memory-search.mjs —— MemorySearch 工具检索实现（spec MS1）
// ---------------------------------------------------------------------------
// local 直检：遍历经验根 *.md → 解析 `- [会话|标签] 摘要 -- 全文` 条目 → 与 query 做
// 无模型余弦相似度（graph.mjs gramTokens/vectorizeText/cosine，tagBoost 强化标签命中）
// → 输出 topK。scope：personal=个人根；project=项目根（memory/project，当前无写入方，
// 目录不存在即 0 命中）；all=两库合并。纯本地无网络。对应 IGraphBackend 接口的
// search(query, { topK })——本实现为 local 直检，external 后端未来经工厂替换。
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { gramTokens, vectorizeText, cosine } from './graph.mjs'
import { parseEntryLine } from './memory.mjs'

function readEntriesFrom(root, dirLabel) {
  const out = []
  if (!root || !existsSync(root)) return out
  let files = []
  try { files = readdirSync(root).filter((f) => f.endsWith('.md')) } catch { return out }
  for (const f of files) {
    const theme = f.slice(0, -3)
    const file = join(root, f)
    let text = ''
    try { text = readFileSync(file, 'utf-8') } catch { continue }
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim()
      if (!t.startsWith('- [')) continue
      const { tag, summary, full } = parseEntryLine(t)
      if (!summary) continue
      out.push({ theme, tag: tag || '', summary, full, file })
    }
  }
  return out
}

// scope：personal（个人根）/ project（项目根）/ all（默认，两库合并）
export function searchLocalMemory({ personalRoot = '', projectRoot = '', query = '', topK = 5, scope = 'all' } = {}) {
  const q = String(query || '').trim()
  if (!q) return { items: [], count: 0 }
  const sc = String(scope || 'all')
  const entries = []
  if (sc === 'personal' || sc === 'all') entries.push(...readEntriesFrom(personalRoot, 'personal'))
  if (sc === 'project' || sc === 'all') entries.push(...readEntriesFrom(projectRoot, 'project'))
  const qv = vectorizeText(q)
  const scored = entries.map((e) => {
    const text = `${e.theme} ${e.tag} ${e.summary} ${e.full}`
    const sv = vectorizeText(text, { tagBoost: 2 })
    return { ...e, score: Number(cosine(qv, sv).toFixed(4)) }
  }).filter((e) => e.score > 0)
  scored.sort((a, b) => b.score - a.score)
  const items = scored.slice(0, Math.min(Math.max(1, Number(topK) || 5), 10)).map(({ theme, tag, summary, full, file, score }) => ({ theme, tag, summary, full, file, score }))
  return { items, count: scored.length }
}
```

- [ ] **Step 2: tools.mjs 注册 MemorySearch**

2a. createToolRegistry 签名（L935）加参数：

```js
export function createToolRegistry({ cwd, addDirs, skillsDirs, skipPermissions, allowOutsideDirs = false, disallowedTools = [], workflow = null, memoryRoot = null, projectMemoryRoot = null }) {
```

2b. 在 `Skill` 工具定义（L1188-1207）之后、`SkillSearch`（L1211）之前注册（import 顶部加 `import { searchLocalMemory } from './memory-search.mjs'`）：

```js
    // MS1 个人/项目经验检索：本地无模型向量匹配（cosine，无网络）。与神经图谱同源
    //（memory/personal *.md 条目 `- [会话|标签] 摘要 -- 全文`），输出条目含 file 供
    // Read 追全文。无命中返回明确提示（勿盲目换词重试——可先确认经验库是否有沉淀）。
    MemorySearch: {
      description: '检索个人/项目经验库（本地无模型向量匹配）：按 query 找过往沉淀经验条目（主题/标签/摘要/全文余弦相似度）。命中返回条目清单（含主题/标签/摘要/所在文件，score 排序），需全文用 Read 读 file。适合"以前处理过类似问题吗"类查询。scope：personal=个人经验；project=项目经验（需项目库存在）；all=全部（默认）。',
      concurrencySafe: true,
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '检索关键词（一句话描述想找的经验主题）' },
          topK: { type: 'number', description: '可选：返回条数上限（1-10，默认 5）' },
          scope: { type: 'string', description: "可选：'personal' | 'project' | 'all'（默认 all）" },
        },
        required: ['query'],
      },
      run: (input) => {
        const q = String(input?.query ?? '').trim()
        if (!q) return { content: 'query 参数缺失：请描述想检索的经验主题', isError: true }
        const { items, count } = searchLocalMemory({
          personalRoot: memoryRoot,
          projectRoot: projectMemoryRoot,
          query: q,
          topK: Number(input?.topK) || 5,
          scope: String(input?.scope || 'all'),
        })
        if (!items.length) {
          const why = count > 0 ? '（均未达相似度阈值）' : ''
          return { content: `经验库无「${q}」相关命中${why}。可换关键词，或确认该主题尚未沉淀过经验。`, isError: false }
        }
        const lines = [`【经验库命中 ${count} 条，取前 ${items.length}】`]
        for (const it of items) {
          lines.push(`- [${it.theme}${it.tag ? '|' + it.tag : ''}] ${it.summary} -- ${it.full}（score ${it.score} · ${it.file}）`)
        }
        return { content: lines.join('\n'), isError: false }
      },
    },
```

- [ ] **Step 3: engine/cli 透传 memoryRoot**

3a. engine.mjs L385 createToolRegistry 调用加两参数：

```js
  const tools = createToolRegistry({ cwd: opts.addDirs?.[0], addDirs: toolResultsDir ? [...(opts.addDirs || []), toolResultsDir] : opts.addDirs, skillsDirs: opts.skillsDirs, skipPermissions: opts.skipPermissions, allowOutsideDirs: opts.allowOutsideDirs, disallowedTools: opts.disallowedTools, workflow: opts.workflow, memoryRoot: opts.memoryRoot || null, projectMemoryRoot: opts.projectMemoryRoot || null })
```

3b. cli.mjs L240 createEngine opts 加（configDir 已知；memoryRoot 函数已 import）：

```js
      memoryRoot: memoryRoot(configDir),
```

（projectMemoryRoot 当前无项目记忆写入方，cli 不传 —— tools 侧 projectMemoryRoot null → project scope 0 命中，schema 与提示完整。）

- [ ] **Step 4: memory-search.test.mjs**

Create `kernel-tests/memory-search.test.mjs`：

```js
// MS1 searchLocalMemory：命中排序 / scope 过滤 / 空结果 / 工具注册冒烟。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchLocalMemory } from '../kernel/memory-search.mjs'
import { createToolRegistry } from '../kernel/tools.mjs'
import { memoryRoot } from '../kernel/memory.mjs'

function makeRoots() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-ms1-'))
  const personal = join(dir, 'memory', 'personal')
  const project = join(dir, 'memory', 'project')
  mkdirSync(personal, { recursive: true })
  mkdirSync(project, { recursive: true })
  const w = (root, file, body) => writeFileSync(join(root, file), body)
  w(personal, 'workflow.md', [
    '---',
    'name: workflow',
    'description: 工作流',
    '---',
    '- [会话|PS材料] PS材料整理 -- 材料压缩：先合并再压缩，注意尺寸上限',
    '- [会话] 无关经验 -- 与检索目标无关的内容',
  ].join('\n') + '\n')
  w(project, 'proj.md', '- [会话|成果转化] 成果转化材料 -- 四表联动核对步骤\n')
  return { dir, personal, project }
}

test('命中排序 + topK 截断 + 输出条目字段', () => {
  const { dir, personal, project } = makeRoots()
  try {
    const r = searchLocalMemory({ personalRoot: personal, projectRoot: project, query: 'PS材料 压缩', topK: 5 })
    assert.ok(r.items.length >= 1)
    const top = r.items[0]
    assert.ok(['theme', 'tag', 'summary', 'full', 'file', 'score'].every((k) => k in top))
    assert.equal(top.tag, 'PS材料')
    assert.ok(top.score > 0)
    assert.ok(r.items.every((a, i, arr) => i === 0 || arr[i - 1].score >= a.score), 'score 降序')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('scope 过滤：project 只查项目库；personal 只查个人库；all 合并', () => {
  const { dir, personal, project } = makeRoots()
  try {
    const q = '材料'
    assert.ok(searchLocalMemory({ personalRoot: personal, projectRoot: project, query: q, scope: 'project' }).items.length >= 1)
    const personalHit = searchLocalMemory({ personalRoot: personal, projectRoot: project, query: q, scope: 'personal' })
    assert.ok(personalHit.items.length >= 1)
    const allHit = searchLocalMemory({ personalRoot: personal, projectRoot: project, query: q, scope: 'all' })
    assert.ok(allHit.count >= personalHit.count)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('空结果：无匹配 → items 空；空 query → 空', () => {
  const { dir, personal, project } = makeRoots()
  try {
    assert.equal(searchLocalMemory({ personalRoot: personal, projectRoot: project, query: 'zzz不存在的词', topK: 3 }).items.length, 0)
    assert.equal(searchLocalMemory({ personalRoot: personal, projectRoot: project, query: '' }).items.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('工具注册：MemorySearch 进 toolNames/toolSchemas，执行无命中返回明确空提示', async () => {
  const { dir, personal } = makeRoots()
  try {
    const tools = createToolRegistry({ cwd: dir, addDirs: [dir], memoryRoot: personal })
    assert.ok(tools.toolNames.includes('MemorySearch'))
    const schema = tools.toolSchemas().find((t) => t.name === 'MemorySearch')
    assert.equal(schema.input_schema.required[0], 'query')
    const r = await tools.run({ name: 'MemorySearch', input: { query: 'zzz不存在的词' } }, {})
    assert.equal(r.isError, false)
    assert.match(String(r.content), /经验库无/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
```

- [ ] **Step 5: 跑全量 kernel-tests + Commit**

Run: `node --test kernel-tests/*.test.mjs`
Expected: 全绿（工具表新增只影响 toolNames 长度，不影响既有断言——如有工具数断言需同步）。

```bash
git add kernel/memory-search.mjs kernel/tools.mjs kernel/engine.mjs kernel/cli.mjs kernel-tests/memory-search.test.mjs
git commit -m "feat(s6-agentloop): MS1 MemorySearch 工具——本地无模型向量检索 + personal/project scope + 工具注册"
```

---

### Task 8: P2-1③ lane 压缩开关（PONOS_LANE_COMPACT）

**Files:**
- Modify: `kernel/engine.mjs`（createEngine 顶部 engineCtx + LANE_COMPACT 常量 + import createCompactor；runSubAgentLoop lane 压缩器装配 + 迭代顶 maybeCompact）
- Modify: `kernel/api.mjs`（mock 摘要分支前移——lane 压缩摘要请求须先于 [mock:lane-*] 历史门控接管）
- Modify: `kernel/cli.mjs:214-226`（context 对象传 createEngine opts.context）
- Test: `kernel-tests/lane-compact.test.mjs`

**Interfaces:**
- Consumes: `createCompactor({ session, context, model, maxTokens, wire, health, signal, env, sessionMemoryPath })`（compact.mjs:269）返回 `maybeCompact({system,messages,outputBudget})`；laneStore = createSessionStore（含 appendCompactionStart/appendCompactionSummary/seqsForMessages/compactCount）。
- Produces: 无新接口。wire 事件 `system('lane_compaction', { taskId, text, compactCount })`（lane 摘要落地）；零回归锁②：`PONOS_LANE_COMPACT` 未设 → lane 无压缩器。

- [ ] **Step 1: mock 摘要分支前移（api.mjs）**

现 mockStream 的压缩摘要分支在 L232-244（`lastText.includes('系统压缩指令')`），位于 lane-melt（L154）/lane-iter（L176）历史门控之后——lane 开启压缩后，摘要请求的 covered 历史含 `[mock:lane-iter]` 标记会被门控分支抢先接管产出工具，摘要永不落地。修复要点（保持既有语义等价，避免回归）：

1. **保留** L208-222 的 `realUser`/`lastText`/`lastMessage`/`lastIsToolResult` 计算——后续 `[mock:tool-safe]`（L265）与 overflow（L250-262）等分支依赖这些变量，不可前移删除。
2. 在 `PONOS_MOCK_LOOP` 分支（L148）之后、lane-melt 门控（L149 注释块）之前，插入自包含的前移摘要块（独立局部变量，不触碰原计算）。**须带 `!mLastIsToolResult` 守卫**：原 L232 语义隐含"tool_result 回合由 L223 回显拦截后不会走到摘要判定"（末条 user 为 tool_result 时末条非工具 user 文本仍可能含历史 '系统压缩指令'——如压缩后继续工具轮）。置于 lane-melt/lane-iter 之前后，若缺此守卫，那些 tool_result 回合会先撞上前移的摘要判定而误回摘要。
3. **仅删除**原 L232-244 摘要 if 块（双份冗余；其它一律不动）。

```js
  // 压缩摘要调用检测（前移：须先于 [mock:lane-melt]/[mock:lane-iter] 历史门控——
  // lane 压缩开启后摘要请求的 covered 历史含 [mock:lane-iter] 标记，被门控抢先会产
  // 工具而非摘要。原位置在 L232，判定语义等价）。mLastIsToolResult 守卫镜像原"回显
  // 先于摘要"的隐式顺序（末条为 tool_result 的回合交回显，不在此误判）。
  const mLaneLast = (messages || [])[messages.length - 1]
  const mLastIsToolResult = mLaneLast?.role === 'user' &&
    Array.isArray(mLaneLast.content) && mLaneLast.content.some((b) => b?.type === 'tool_result')
  const mSummaryText = (() => {
    const lu = [...(messages || [])].reverse().find((m) => m.role === 'user' &&
      !(Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result')))
    const c = lu?.content
    return typeof c === 'string' ? c : (Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '')
  })()
  if (!mLastIsToolResult && mSummaryText.includes('系统压缩指令')) {
    if (process.env.PONOS_MOCK_COMPACT_BAD === '1') {
      yield* streamText('（压缩失败：模型未输出结构化摘要）', signal)
      yield { type: 'usage', usage: MOCK_USAGE }
      return
    }
    const body = process.env.PONOS_MOCK_COMPACT_RESPONSE === '1'
      ? '<compacted-summary>摘要输出</compacted-summary>'
      : '<compacted-summary>mock 摘要</compacted-summary>'
    yield* streamText(body, signal)
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
```

**改动后必须跑既有 engine-guard 压缩测试确认不回归**（PONOS_MOCK_COMPACT_BAD/RESPONSE 判定路径不变；主 loop 摘要请求末条为指令文本非 tool_result → 前移判定等价命中；后续工具轮 tool_result 回合被 mLastIsToolResult 守卫放行回显）。

- [ ] **Step 2: engine.mjs lane 压缩器装配**

2a. import（L15-25 区）加：`import { createCompactor } from './compact.mjs'`

2b. createEngine 顶部（L363-374 附近，`const turnStats = []` 之后）加：

```js
  // P2-1③：lane 压缩可选开关 + 主会话 context（engineCtx.estimate 供 lane 压缩器阈值判定）
  const engineCtx = opts.context || null
  const LANE_COMPACT_ENABLED = process.env.PONOS_LANE_COMPACT === '1'
```

2c. runSubAgentLoop（options 解构后、for 循环前）装配 lane 压缩器（惰性单例）：

```js
    // P2-1③：lane 压缩（可选，PONOS_LANE_COMPACT=1 且主会话提供 context）。复用主
    // loop 压缩语义（compact.mjs 两阶段 + 熔断），摘要落地到 laneStore（独立 transcript，
    // 主会话零污染）。wire 摘要经 laneWire 转发为 system('lane_compaction') 事件带 taskId。
    // 零回归锁②：默认关（LANE_COMPACT_ENABLED=false → laneCompactor 恒 null，零开销）。
    let laneCompactor = null
    if (LANE_COMPACT_ENABLED && engineCtx?.estimate) {
      try {
        const laneWire = { summary: (text, count) => { try { wire.system?.('lane_compaction', { text: String(text ?? ''), compactCount: count }) } catch { /* 事件失败静默 */ } } }
        laneCompactor = createCompactor({
          session: store,
          context: engineCtx,
          model: loopModel,
          maxTokens,
          wire: laneWire,
          health: undefined,
          signal: subSignal,
          env: process.env,
          sessionMemoryPath: null,
        })
      } catch { laneCompactor = null } // lane 压缩器装配失败 → 该 lane 不压缩（静默降级）
    }
```

2d. for 循环顶（守卫检查 L1109-1114 之后、`const blocks = []` 之前）加触发（仅 turn 边界；none/失败静默）：

```js
      // P2-1③：lane 压缩触发（turn 边界，阈值判定复用主循环阈值体系）。摘要调用
      // usage 并入 lane usage（与主循环 M2 语义一致）；outputBudget 透传本流 attemptMaxTokens
      //（同主循环 L485 compactor.maybeCompact 调用形态）。任何异常静默——压缩失败不阻断 lane。
      if (laneCompactor) {
        try {
          const laneMsgs = patchOrphanToolUses(store.deriveMessages())
          const cr = await laneCompactor.maybeCompact({ system: sysPrompt, messages: laneMsgs, outputBudget: attemptMaxTokens })
          if (cr?.usage) usage = addUsage(usage, cr.usage)
          if (cr?.action === 'summarized') textBuf = '' // 摘要落地后收尾文本已被遮蔽，置空防拼接
        } catch { /* lane 压缩异常静默 */ }
      }
```

- [ ] **Step 3: cli.mjs 传 context 进 engine**

createEngine opts（L240-260）加：

```js
      // P2-1③：主会话 context（estimate 闭包）透传——lane 压缩器阈值判定复用
      context,
```

- [ ] **Step 4: lane-compact.test.mjs**

Create `kernel-tests/lane-compact.test.mjs`：

```js
// P2-1③ lane 压缩：开关默认关（零回归）→ [mock:lane-iter] 长 lane 正常完成；开启后
// estimate 计数触发压缩 → laneStore 出现 compaction 条目、主 transcript 零污染。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from '../kernel/engine.mjs'
import { createSessionStore } from '../kernel/session.mjs'
import { makeWire } from '../kernel/protocol.mjs'

process.env.PONOS_MOCK_API = '1'

function makeEnv({ withCtx }) {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const dir = mkdtempSync(join(tmpdir(), 'ponos-lanecompact-'))
  const configDir = join(dir, 'home')
  const store = createSessionStore({ configDir, cwd: dir, sessionId: 'main-session' })
  const opts = { model: 'mock-model', configDir, addDirs: [dir], skipPermissions: true }
  if (withCtx) {
    // estimate 计数：第 1 次调用（lane 首轮仅 prompt 1 条）低于阈值；此后巨大（触发压缩）。
    let calls = 0
    opts.context = {
      window: 200000,
      thresholdRatio: 0.8,
      retainRatio: 0.3,
      estimate({ messages }) {
        calls++
        const n = messages?.length ?? 0
        return { total: calls <= 1 || n < 3 ? 100 : 200_000_000 } // 消息足量后触发
      },
    }
  }
  const engine = createEngine({ opts, wire, session: store })
  engine.setSystemPrompt('你是 Ponos-turbo 测试内核。')
  const laneFile = (taskId) => join(configDir, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'), `${taskId}.jsonl`)
  const waitNotif = async (taskId, timeoutMs = 12000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const n = events.find((e) => e.type === 'system' && e.subtype === 'task_notification' && e.task_id === taskId)
      if (n) return n
      await new Promise((res) => setTimeout(res, 10))
    }
    return null
  }
  return { events, engine, store, dir, laneFile, waitNotif, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('零回归锁②：PONOS_LANE_COMPACT 未设 → lane 无压缩（transcript 无 compaction 条目）', async () => {
  delete process.env.PONOS_LANE_COMPACT
  const env = makeEnv({ withCtx: true })
  try {
    const r = await env.engine.spawnSubAgent(
      { subagent_type: 'general-purpose', prompt: '[mock:lane-iter]', run_in_background: true },
      { toolUseId: 'tool_use_lc_1' },
    )
    const taskId = String(r.content).match(/task_id: ([0-9a-f-]+)/)?.[1]
    const notif = await env.waitNotif(taskId)
    assert.ok(notif)
    assert.equal(notif.status, 'completed')
    const text = readFileSync(env.laneFile(taskId), 'utf-8')
    assert.ok(!text.includes('"kind":"compaction"'), '关闭态 lane 不应压缩')
  } finally { env.cleanup() }
})

test('开启态：PONOS_LANE_COMPACT=1 + engineCtx → lane 摘要落地 + lane_compaction 事件 + 主会话零污染', async () => {
  process.env.PONOS_LANE_COMPACT = '1'
  const env = makeEnv({ withCtx: true })
  try {
    const r = await env.engine.spawnSubAgent(
      { subagent_type: 'general-purpose', prompt: '[mock:lane-iter]', run_in_background: true },
      { toolUseId: 'tool_use_lc_2' },
    )
    const taskId = String(r.content).match(/task_id: ([0-9a-f-]+)/)?.[1]
    const notif = await env.waitNotif(taskId, 15000)
    assert.ok(notif, 'lane 应完成')
    assert.equal(notif.status, 'completed')
    const laneText = readFileSync(env.laneFile(taskId), 'utf-8')
    assert.match(laneText, /"kind":"compaction"/)
    assert.match(laneText, /mock 摘要/)
    // 主 transcript：无 compaction 条目（lane 压缩不影响主会话）
    const mainText = readFileSync(env.store.file, 'utf-8')
    assert.ok(!mainText.includes('"kind":"compaction"'))
    // lane_compaction 事件带摘要文本
    assert.ok(env.events.some((e) => e.type === 'system' && e.subtype === 'lane_compaction' && typeof e.text === 'string'))
  } finally {
    delete process.env.PONOS_LANE_COMPACT
    env.cleanup()
  }
})
```

- [ ] **Step 5: 跑全量 kernel-tests（重点回归 api.mjs mock 分支前移）**

Run: `node --test kernel-tests/*.test.mjs`
Expected: 全绿。若既有压缩/守卫测试因 mock 分支前移失败，先修前移代码保持语义等价（压缩摘要请求判定一致），再继续。

- [ ] **Step 6: Commit**

```bash
git add kernel/engine.mjs kernel/api.mjs kernel/cli.mjs kernel-tests/lane-compact.test.mjs
git commit -m "feat(s6-agentloop): P2-1③ lane 压缩开关——lane 压缩器装配 + 迭代顶触发 + mock 摘要分支前移 + 零回归锁②测试"
```

---

### Task 9: P2-2 预算护栏

**Files:**
- Modify: `kernel/engine.mjs`（import costOf；createEngine 会话级累计 sessionUsageAcc + 单价/budget env 常量 + budgetWarned；runTurn 尾部累加 + 阈值告警）
- Test: `kernel-tests/budget-guard.test.mjs`

**Interfaces:**
- Consumes: `costOf(usage, { pricePerMInput, pricePerMOutput, cacheReadRatio })`（cost.mjs:4）；`outcome.usage`（runTurn 每轮，mock 每轮 `{input_tokens:10, output_tokens:20}`）。
- Produces: `wire.warning({ level: 'budget', usd, budgetUsd })`（A.3；跨阈值单次，硬停交调用方/GUI）。

- [ ] **Step 1: engine.mjs 会话级累计 + 护栏**

1a. import（L15-25 区）加：`import { costOf } from './cost.mjs'`

1b. createEngine 顶部（`const turnStats = []` 之后）加：

```js
  // P2-2 预算护栏（热累计，进程内；跨会话/历史预算走 U1 文件聚合——两层互补）。
  // 单价 env：PONOS_PRICE_PER_M_INPUT/OUTPUT、PONOS_CACHE_READ_RATIO；PONOS_BUDGET_USD
  // >0 启用。告警不硬停（硬停决策交调用方/GUI）；进程重启护栏清零。
  const PRICES = {
    pricePerMInput: Number(process.env.PONOS_PRICE_PER_M_INPUT) || 0.2,
    pricePerMOutput: Number(process.env.PONOS_PRICE_PER_M_OUTPUT) || 1.2,
    cacheReadRatio: Number(process.env.PONOS_CACHE_READ_RATIO) || 0.1,
  }
  const BUDGET_USD = Number(process.env.PONOS_BUDGET_USD) || 0
  const sessionUsageAcc = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  let budgetWarned = false
```

1c. runTurn 尾部（`turnStats.push` L1634 之后、`health?.record` 之前）加累计与告警：

```js
      turnStats.push({ usage: outcome.usage, durationMs, model: outcome.model, ts: new Date().toISOString(), compactCount: session ? session.compactCount() : 0 })
      // P2-2：会话级用量累计（四字段）→ costOf 单价 env → 跨 PONOS_BUDGET_USD 阈值
      // 发 budget 告警（每会话单次 crossing，防刷屏）。usage null（内部错误轮）不累计。
      if (outcome.usage) {
        for (const k of Object.keys(sessionUsageAcc)) sessionUsageAcc[k] += outcome.usage[k] ?? 0
      }
      if (BUDGET_USD > 0 && !budgetWarned) {
        try {
          const usd = costOf(sessionUsageAcc, PRICES)
          if (usd > BUDGET_USD) {
            budgetWarned = true
            wire.warning?.({ level: 'budget', usd: Number(usd.toFixed(4)), budgetUsd: BUDGET_USD })
          }
        } catch { /* 预算计算异常静默 */ }
      }
```

- [ ] **Step 2: budget-guard.test.mjs**

Create `kernel-tests/budget-guard.test.mjs`：

```js
// P2-2 预算护栏：会话级累计 + 单价 env 覆盖 + 跨阈值单次事件 + 阈值未达不发。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from '../kernel/engine.mjs'
import { createSessionStore } from '../kernel/session.mjs'
import { makeWire } from '../kernel/protocol.mjs'
import { costOf } from '../kernel/cost.mjs'

process.env.PONOS_MOCK_API = '1'
// mock 每轮 usage = { input_tokens: 10, output_tokens: 20 }（api.mjs MOCK_USAGE）
const MOCK_ROUND_USD = costOf({ input_tokens: 10, output_tokens: 20 })

// 引擎在 createEngine 时读取 PRICES/BUDGET_USD env 常量（快照），故 env 必须在
// makeEngine 之前设置——三个用例统一先 cleanEnv + setEnv 再建引擎。
function makeEngine() {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const dir = mkdtempSync(join(tmpdir(), 'ponos-budget-'))
  const store = createSessionStore({ configDir: join(dir, 'home'), cwd: dir, sessionId: 'main' })
  const engine = createEngine({ opts: { model: 'mock-model', configDir: join(dir, 'home'), addDirs: [dir], skipPermissions: true }, wire, session: store })
  engine.setSystemPrompt('你是 Ponos-turbo 测试内核。')
  const warnings = () => events.filter((e) => e.type === 'ponos_warning' && e.level === 'budget')
  return { events, engine, warnings, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
const BUDGET_ENVS = ['PONOS_BUDGET_USD', 'PONOS_PRICE_PER_M_INPUT', 'PONOS_PRICE_PER_M_OUTPUT', 'PONOS_CACHE_READ_RATIO']
const cleanEnv = () => { for (const k of BUDGET_ENVS) delete process.env[k] }

test('累计正确性 + 跨阈值单次告警（2 轮跨阈才发、第 3 轮不重复）', async () => {
  cleanEnv()
  // 预算 = 1.5 轮成本：第 2 轮累计才跨阈
  process.env.PONOS_BUDGET_USD = String((MOCK_ROUND_USD * 1.5).toFixed(6))
  const env = makeEngine() // env 已设 → 引擎快照 budget 生效
  try {
    await env.engine.runTurn({ content: '一' })
    assert.equal(env.warnings().length, 0, '未跨阈不发')
    await env.engine.runTurn({ content: '二' })
    assert.equal(env.warnings().length, 1, '跨阈发一次')
    const w = env.warnings()[0]
    assert.ok(w.usd > 0)
    assert.ok(w.budgetUsd > 0)
    await env.engine.runTurn({ content: '三' })
    assert.equal(env.warnings().length, 1, '不重复告警')
  } finally { cleanEnv(); env.cleanup() }
})

test('单价 env 覆盖：输出单价调高 → 单轮即跨阈', async () => {
  cleanEnv()
  process.env.PONOS_PRICE_PER_M_OUTPUT = '1000' // 输出 20 token → 0.02 USD/轮
  process.env.PONOS_BUDGET_USD = '0.01'
  const env = makeEngine()
  try {
    await env.engine.runTurn({ content: '一' })
    assert.equal(env.warnings().length, 1)
  } finally { cleanEnv(); env.cleanup() }
})

test('阈值未设（PONOS_BUDGET_USD=0）→ 恒不发', async () => {
  cleanEnv()
  const env = makeEngine()
  try {
    await env.engine.runTurn({ content: '一' })
    await env.engine.runTurn({ content: '二' })
    assert.equal(env.warnings().length, 0)
  } finally { cleanEnv(); env.cleanup() }
})

test('costOf 纯函数：cache 计费与单价参数', () => {
  const c = costOf({ input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 })
  assert.ok(Math.abs(c - (0.2 + 1.2 + 0.2 * 0.1 + 0.2)) < 1e-9, `cache 计费错误: ${c}`)
})
```

- [ ] **Step 3: 跑全量 kernel-tests + Commit**

Run: `node --test kernel-tests/*.test.mjs`
Expected: 全绿（runTurn 尾部新增为纯增量，默认 budget 0 不激活）。

```bash
git add kernel/engine.mjs kernel-tests/budget-guard.test.mjs
git commit -m "feat(s6-agentloop): P2-2 预算护栏——会话级 usage 累计 + costOf 单价 env + 跨阈单次 budget 告警"
```

---

### Task 10: P2-3 值守能力契约核对 + env 补齐

**Files:**
- Read-only 核对: `server/bridge.mjs`（YFW_KERNEL_IDLE_MS / YFW_KERNEL_STALL_MS env 位）、`kernel/engine.mjs`（PONOS_TURN_TIMEOUT_MS / PONOS_STREAM_IDLE_MS / PONOS_LOOP_*）
- Modify（仅当核对发现缺口）: `kernel/engine.mjs`（补 kernel 侧 stall 判定 env）
- Modify: `docs/superpowers/specs/2026-09-08-agentloop-prod-upgrade-design.md` 附录 C 表格（核对结果落 mark）

**Interfaces:**
- 无生产接口。交付 = 附录 C 核对表完成 + 发现的 env 缺口补齐冒烟。

- [ ] **Step 1: 核对值守 env 位与既有覆盖**

Run: `node --test kernel-tests/*.test.mjs`（基线已绿）

核对（grep 确认后填表）：
- kernel 侧 stall/守卫：`PONOS_TURN_TIMEOUT_MS`（engine.mjs:52）、`PONOS_STREAM_IDLE_MS`（:54）、`PONOS_LOOP_MAX_ERROR_ITERATIONS`（:56）、`PONOS_LOOP_GUARD`（:39）——存在。
- server 侧：`YFW_KERNEL_STALL_MS` / `YFW_KERNEL_IDLE_MS`（bridge.mjs 约 :1916/:1942）——grep 确认存在。
- workflow cron scheduler：`kernel/workflow.mjs`——存在。
- health 事件流（档位/压缩史）：health.mjs record/recordCompaction——存在。

Expected: 逐项为"已覆盖 G0，无缺口"。若 grep 发现某 env 位缺失（例如 kernel 侧无显式 stall 判定 env 名），在 engine.mjs 守卫常量旁补 env 别名（保持既有默认值不变）：

```js
// P2-3：kernel 侧 stall 判定 env 别名（值守契约核对补齐；默认不变，纯命名对齐）
const STALL_MS = envNonNeg('PONOS_KERNEL_STALL_MS', 0) || TURN_TIMEOUT_MS
```

（仅当 Step 1 核对发现对应缺口才落此代码；无缺口则跳过本步并注释说明。）

- [ ] **Step 2: 附录 C 核对表落 mark**

Edit `docs/superpowers/specs/2026-09-08-agentloop-prod-upgrade-design.md` 附录 C 表格各"覆盖"列（"已覆盖 G0"或补缺口说明），并在表格下加一行实施结论：

```markdown
> 实施期核对（2026-09-08，Task 10）：六项能力逐项确认存在——KernelStallBar/LoopStatusBar（S5）、WS 15s/60s 心跳（S5）、workflow cron scheduler、health 事件流、bridge 空闲回收 env、kernel 侧守卫 env 全部在列；未发现需新增 env 的缺口。
```

- [ ] **Step 3: 全量回归 + 契约冒烟**

Run: `node --test kernel-tests/*.test.mjs && npm test`
Expected: 全绿。

- [ ] **Step 4: Commit**

```bash
git add kernel/engine.mjs docs/superpowers/specs/2026-09-08-agentloop-prod-upgrade-design.md
git commit -m "docs(s6-agentloop): P2-3 值守能力契约核对——附录 C 落 mark，无 env 缺口"
```

---

## 验收门槛（全部 Task 完成后）

- 全量 `node --test kernel-tests/*.test.mjs` 绿（含两把零回归锁显式断言：lane 参数未定义 = 全量 / lane 压缩默认关）。
- `npm test` 绿（server 新增 kernel-readonly.test.mjs）。
- 手动契约冒烟：`node kernel/cli.mjs --usage/--audit/--agents ...` 三命令输出 A.1/A.2/A.4 JSON；GUI 侧 `/api/usage`、`/api/audit`（GUI 组件由 GUI 侧另排，不在本计划）。
- spec 附录 A.3 三新 warning level（budget/skill_version/agent_spec）与 health.judge 字段在 wire 事件实测出现。
