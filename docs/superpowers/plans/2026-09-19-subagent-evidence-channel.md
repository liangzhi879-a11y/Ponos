# 跨 Agent 证据面接线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让主 Agent 能拿到子 Agent 的**全量产物清单、读过的文件、以及可展开的完整过程记录**，替代当前"只有一段散文摘要 + 单个文件路径"的唯一回传通道。

**Architecture:** 数据在 `makeLaneOnTool` 时就已经流经内核（`b.name` / `b.input.file_path` 均在手上），只是没被采集与回传。本计划**不引入新机制**，只做三处接线：① `Edit` 与 `Write` 同样计入产物清单；② 新增 `reads` 采集并限量回传主 Agent；③ 把已落盘的 lane transcript 路径暴露出来，并纳入 Read 只读白名单使其可被 `offset/limit` 精确展开。

**Tech Stack:** Node.js ESM（`kernel/*.mjs`）、`node:test` + `node:assert/strict`、内核 mock API（`PONOS_MOCK_API=1`，无网络）。

## Global Constraints

- **不改写边界**：`Write` / `Edit` / `Bash` / `OCR` 的文件边界仍严格等于 `allowDirs`（会话目录 + `--add-dir`）。本计划只动 **Read 只读侧**（与既有 `readAllowFiles` / `knowledgeReadDirs` 同一片边界）。
- **不削减文本回传**：transcript 是审计留痕与 `--usage` 聚合的权威源，任何"为省 token 而不落盘/不回放"的改动都不在本计划范围。
- **不动压缩与缓存参数**：不改 `keepRecent`、压缩阈值、`cache_control` 策略（`docs/2026-09-18-前缀缓存命中率优化方案.md` §8 自定禁区）。
- **不改 context 继承的纯文本投影**：`engine.mjs` 的 `inherit`（none/summary/full）剥离 `tool_use`/`tool_result` 是**有意设计**（保证 API 合法性），保持原样。
- **零回归**：`npm run test:kernel` 现有 **2031 项（2030 pass / 1 skip / 0 fail）** 必须全过；`kernel-tests/subagent.test.mjs:373-374` 对 `outputs`/`output_file` 的既有断言不得破坏。该脚本**只跑 `kernel-tests/*.test.mjs`**（`package.json:23`），不受工作区其他未提交改动影响。
- **字段只增不改**：`task_notification` 为既有 wire 契约，新字段一律**追加**（`reads` / `transcript_path`），既有字段名与语义逐字不变。

---

## File Structure

| 文件 | 职责 | 本次改动 |
|---|---|---|
| `kernel/engine.mjs` | lane 生命周期与回传组装 | 采集 `reads`；`runLaneExecution` 返回全量产物与 transcript 路径；foreground 返回体补证据面；`taskSystem.output` 补路径；注册 lane transcript 可读 |
| `kernel/engine-config.mjs` | `PONOS_*` 环境变量的唯一求值点 | 新增 `LANE_READS_MAX`（读面上限，与 `LANE_MAX_CONCURRENT` 并列） |
| `kernel/protocol.mjs` | wire 事件契约 | `taskNotification` 追加 `reads` / `transcriptPath`（只增字段） |
| `kernel/tools.mjs` | 工具注册表与只读边界 | 导出 `MUTATING_FILE_TOOLS`；新增 `addReadAllowFiles()`，让 lane transcript 可被 Read |
| `kernel/api.mjs` | mock 流（仅测试用） | 新增 `[mock:edit]` 触发词：一次 Edit + 一次 Read |
| `kernel-tests/subagent.test.mjs` | **修改**：证据面用例**并入**既有文件 | Task 1/2 用例复用其既有 `makeEnv`；Task 3 在同一文件内新增 `makeEnvSplit`（configDir 在会话目录之外） |

**为何并入 `subagent.test.mjs` 而非新建文件（2026-09-19 人类裁定）**：仓库有**按 `git ls-files` 计数**的文档锚点门禁
（`scripts/check-doc-anchors.mjs` 的 `testFileCounts`，由 `kernel-tests/doc-anchors-reproducible.test.mjs` 在
**只含已跟踪文件的干净检出**里强制），新增一个 `kernel-tests/*.test.mjs` 会把计数从 210 推到 211 而门禁仍写 210
⇒ 干净检出必红。而修锚点需写 `docs/_anchors.json`，该文件当时**被另一分支的未提交改动占用**，写入会覆盖其 WIP。
在"只碰 4 个 kernel 文件"的范围约束下，**并入既有文件是唯一不触碰 `docs/` 且门禁全绿的路径**。

代价与对策：该文件将从 383 行增至约 480 行，超出单屏可读范围。对策是**追加式收敛**——所有新用例集中在文件末尾的
「跨 Agent 证据面」区块，不插入既有测试之间；该区块自带 `makeEnvSplit` 辅助，与既有 `makeEnv` 并列而不修改它。
文件不因本次改动而重构（既有 6 个主题的测试逐字不动）。

**门禁自检（每个 Task 收尾必做）**：`git ls-files 'kernel-tests/*.test.mjs' | wc -l` 必须仍为 **210**。

---

### Task 1: Edit 计入产物清单

**Files:**
- Modify: `kernel/tools.mjs:722` 之后（导出 `MUTATING_FILE_TOOLS`）
- Modify: `kernel/engine.mjs:32`（import）、`:1860-1876`（`makeLaneOnTool`）、`:1945-1946` 与 `:2025-2027`（调用点）
- Modify: `kernel/api.mjs:916-926` 之后（新增 mock 触发词）
- Test: `kernel-tests/subagent.test.mjs`（新建）

**Interfaces:**
- Consumes: 无（本任务为起点）
- Produces: `tools.mjs` 导出 `MUTATING_FILE_TOOLS: Set<string>`；`makeLaneOnTool` 的新签名 `{ taskId, writePaths, readPaths, t0 }`

**背景**：`kernel/tools.mjs:881` 的 `Write` 与 `:894` 的 `Edit` 是两个独立注册工具，而 `makeLaneOnTool` 只认 `Write`。`Edit` 的描述写着"改动范围超过半个文件时优先考虑本工具【Write】而非多次 Edit"⇒ **Edit 才是小改的默认路径**，产物却完全不入账。

- [ ] **Step 1: 写失败测试**

追加到 `kernel-tests/subagent.test.mjs` **末尾**（不改动既有 6 个主题的测试）：

```js
// 跨 Agent 证据面测试（mock API，无网络）
// ---------------------------------------------------------------------------
// 覆盖：Edit 计入产物、reads 采集与限量回传、lane transcript 可被 Read 展开。
// 并入 subagent.test.mjs 而非新建文件：仓库文档锚点门禁按 git ls-files 计数测试文件数，
// 新增文件会让干净检出的门禁变红，而修锚点要碰他分支 WIP 的 docs/_anchors.json。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from '../kernel/engine.mjs'
import { createSessionStore } from '../kernel/session.mjs'
import { makeWire } from '../kernel/protocol.mjs'

process.env.PONOS_MOCK_API = '1'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const extractTaskId = (content) => String(content).match(/task_id: ([0-9a-f-]+)/)?.[1]

// 与 subagent.test.mjs 的 makeEnv 关键差异：**configDir 不在 addDirs 内**。
// 这样 lane transcript（<configDir>/projects/<cwd>/<taskId>.jsonl）落在会话目录之外，
// "未放行 ⇒ 越界 / 放行 ⇒ 可读"才有区分度（若 configDir 在会话目录内，测试恒通过、测不出东西）。
// 对照既有 subagent.test.mjs:32-45 —— 它是 dir = mkdtempSync(...)；configDir = join(dir,'home')；
// cwd: dir；addDirs: [dir] ⇒ laneFile 落在 dir/home/... ，**本就在 addDirs 内**，故既有测试
// 无法验证跨出边界的情形。故本区块需分离 work / home 两个目录，这是不能照抄它那条 makeEnv 的原因。
function makeEnv() {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const root = mkdtempSync(join(tmpdir(), 'ponos-evidence-'))
  const workDir = join(root, 'work')
  const configDir = join(root, 'home')
  mkdirSync(workDir, { recursive: true })
  const store = createSessionStore({ configDir, cwd: workDir, sessionId: 'main-session' })
  const engine = createEngine({
    opts: { model: 'mock-model', configDir, addDirs: [workDir], skipPermissions: true },
    wire,
    session: store,
  })
  engine.setSystemPrompt('你是 Ponos-turbo 测试内核。')
  const laneFile = (taskId) => join(configDir, 'projects', workDir.replace(/[^a-zA-Z0-9]/g, '-'), `${taskId}.jsonl`)
  const waitNotif = async (taskId, timeoutMs = 8000, nth = 1) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const ns = events.filter((e) => e.type === 'system' && e.subtype === 'task_notification' && e.task_id === taskId)
      if (ns.length >= nth) return ns[nth - 1]
      await sleep(10)
    }
    return null
  }
  return { events, engine, store, root, workDir, configDir, laneFile, waitNotif, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('Edit 产物计入 outputs（原先只认 Write）', async () => {
  const env = makeEnv()
  const prev = process.env.PONOS_MOCK_WRITE_DIR
  try {
    process.env.PONOS_MOCK_WRITE_DIR = env.workDir
    // Edit 需要目标文件已存在（Edit 是"先读后改"，old_string 必须精确命中）
    writeFileSync(join(env.workDir, 'mock-c.txt'), 'old\n', 'utf-8')
    const r = await env.engine.spawnSubAgent(
      { subagent_type: 'general-purpose', prompt: '[mock:edit]', run_in_background: true },
      { toolUseId: 'tool_use_ev_1' },
    )
    const taskId = extractTaskId(r.content)
    assert.ok(taskId)
    const n = await env.waitNotif(taskId)
    assert.ok(n, '完成通知应到达')
    // Edit 的目标文件必须进 outputs（改造前恒为空数组）
    assert.deepEqual(n.outputs, [`${env.workDir}/mock-c.txt`])
  } finally {
    if (prev === undefined) delete process.env.PONOS_MOCK_WRITE_DIR
    else process.env.PONOS_MOCK_WRITE_DIR = prev
    env.cleanup()
  }
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test --test-timeout=120000 kernel-tests/subagent.test.mjs`
Expected: FAIL —— mock 尚无 `[mock:edit]` 触发词，子 Agent 会走普通文本回复 ⇒ `n.outputs` 为 `[]`，`assert.deepEqual` 报 `Expected [ ... ] but got []`。

- [ ] **Step 3: 加 mock 触发词**

在 `kernel/api.mjs` 的 `[mock:write]` 分支之后（`:926` 的 `}` 之后）插入：

```js
  // 跨 Agent 证据面测试：[mock:edit] 触发一次 Edit + 一次 Read
  // （Edit 产物须计入 outputs；Read 路径须进 task_notification.reads）
  if (lastText.includes('[mock:edit]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    const base = process.env.PONOS_MOCK_WRITE_DIR || process.cwd()
    yield { type: 'tool_use', id: 'tool_use_mock_edit_1', name: 'Edit', input: { file_path: `${base}/mock-c.txt`, old_string: 'old', new_string: 'new' } }
    yield { type: 'tool_use', id: 'tool_use_mock_read_1', name: 'Read', input: { file_path: `${base}/mock-c.txt` } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
```

- [ ] **Step 4: 导出 `MUTATING_FILE_TOOLS` 并在 engine 使用**

`kernel/tools.mjs:722` 的 `CHAT_MODE_DISALLOWED` 之后追加（**同性质先例**：该文件已用同样方式导出工具名集合，故新集合也归此处——离它描述的工具定义最近）：

```js
/**
 * 会改变文件内容的工具（lane 产物清单来源）。
 * 为什么必须显式列全：`Write` 与 `Edit` 是**两个独立注册工具**（见本文件 Write / Edit 条目），
 * 而 engine 的产物采集原先只认 `Write` ⇒ 最常见的改动方式（小改走 Edit）产物完全不入账，
 * outputs/output_file 恒为"最后一个 Write"。**今后新增会改文件的工具必须加进这里**。
 */
export const MUTATING_FILE_TOOLS = new Set(['Write', 'Edit'])
```

`kernel/engine.mjs:32` 的 import 改为：

```js
import { createToolRegistry, killActiveChildren, MUTATING_FILE_TOOLS } from './tools.mjs'
```

然后替换 `kernel/engine.mjs:1860` 起的 `makeLaneOnTool`（`MUTATING_FILE_TOOLS` 已是模块顶层导入，此处**不再**在函数体内声明）：

```js
  function makeLaneOnTool({ taskId, writePaths, readPaths, t0 }) {
    return (b, r, count) => {
      if (!r.isError) {
        const p = String(b.input?.file_path || '')
        if (p) {
          if (MUTATING_FILE_TOOLS.has(b.name)) writePaths.push(p)
          else if (b.name === 'Read') readPaths.push(p)
        }
      }
      try {
        wire.taskProgress({
          taskId,
          lastToolName: b.name,
          description: r.isError ? `${b.name} 失败：${String(r.content || '').slice(0, 120)}` : `${b.name} 完成`,
          usage: { tool_uses: count, total_tokens: 0, duration_ms: Date.now() - t0 },
        })
      } catch { /* wire 缺 taskProgress 通道不影响 lane 执行 */ }
    }
  }
```

**注意**：`readPaths` 参数本任务尚未传入调用点，会得到 `undefined` ⇒ `readPaths.push` 在命中 Read 时抛错。故本步骤**必须同时**把两个调用点的 `makeLaneOnTool({ taskId, writePaths, t0 })` 改为 `makeLaneOnTool({ taskId, writePaths, readPaths, t0 })` 并在各自作用域声明 `const readPaths = []`：

- `kernel/engine.mjs:1945-1946`（resume 分支）
- `kernel/engine.mjs:2025-2027`（spawn 分支）

resume 分支改为（`writePaths` 旁并列）：

```js
      const writePaths = []
      const readPaths = []
      const onTool = makeLaneOnTool({ taskId: resumeTaskId, writePaths, readPaths, t0 })
```

spawn 分支改为：

```js
    const writePaths = []
    const readPaths = []
    const inbox = [] // B2 主 Agent 消息投递队列（lane 工具边界吸收；后台/前台共用同一引用）
    const onTool = makeLaneOnTool({ taskId, writePaths, readPaths, t0 })
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `node --test --test-timeout=120000 kernel-tests/subagent.test.mjs`
Expected: PASS（1 test）

- [ ] **Step 6: 回归既有断言**

Run: `node --test --test-timeout=120000 kernel-tests/subagent.test.mjs`
Expected: 全过。重点确认 `:373-374`（`assert.deepEqual(n.outputs, [outA, outB])` 与 `output_file 为最后产物`）仍成立——该用例走两个 `Write`，不含 `Edit`，语义不变。

- [ ] **Step 7: 提交**

```bash
git add kernel/engine.mjs kernel/api.mjs kernel-tests/subagent.test.mjs
git commit -m "feat(subagent): Edit 产物计入 lane outputs 清单"
```

---

### Task 2: reads 采集与限量回传主 Agent

**Files:**
- Modify: `kernel/engine.mjs:1879-1908`（`runLaneExecution`）、`:1947` 与 `:2028`（两调用点补参）、`:2061-2075`（foreground 返回体）、`:2137-2143`（`taskSystem.output`）
- Modify: `kernel/engine-config.mjs:212` 之后（`LANE_READS_MAX`）、`kernel/engine.mjs:41`（import）
- Modify: `kernel/protocol.mjs:154-165`（`taskNotification`）
- Test: `kernel-tests/subagent.test.mjs`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `makeLaneOnTool({ taskId, writePaths, readPaths, t0 })` 与调用点的 `readPaths` 数组
- Produces:
  - `runLaneExecution(...)` 返回 `{ status, text, usage, outputFile, outputs: string[], reads: string[] }`
  - `task_notification` 事件新增 `reads: string[]`（追加字段，不改既有）
  - foreground `Agent` 返回 content 含"读过的文件"段（限量 `LANE_READS_MAX = 15`）

**背景**：主 Agent 从子 Agent 拿到的全部内容是三个字段——`totalTokens`、`r.text`（子 Agent 自述散文）、`r.outputFile`（单个）。`outputs` 全量只进 wire（GUI）。`reads` 现在根本不采集 ⇒ 主 Agent 常重读子 Agent 已读过的文件。

- [ ] **Step 1: 写失败测试**

追加到 `kernel-tests/subagent.test.mjs`：

```js
test('Read 路径进 reads 且主 Agent 前台回传含完整产物与过程入口', async () => {
  const env = makeEnv()
  const prev = process.env.PONOS_MOCK_WRITE_DIR
  try {
    process.env.PONOS_MOCK_WRITE_DIR = env.workDir
    writeFileSync(join(env.workDir, 'mock-c.txt'), 'old\n', 'utf-8')
    // desc 含 [mock:edit] 但不以它开头：确保子 Agent 首轮就命中触发词
    const r = await env.engine.spawnSubAgent(
      { subagent_type: 'general-purpose', prompt: '[mock:edit] 请改这个文件', run_in_background: true },
      { toolUseId: 'tool_use_ev_2' },
    )
    const taskId = extractTaskId(r.content)
    const n = await env.waitNotif(taskId)
    assert.ok(n)
    // reads 采集：Read 的 file_path 进通知
    assert.deepEqual(n.reads, [`${env.workDir}/mock-c.txt`])
    // transcript 路径暴露（Task 3 使其可读）
    assert.equal(n.transcript_path, env.laneFile(taskId))
  } finally {
    if (prev === undefined) delete process.env.PONOS_MOCK_WRITE_DIR
    else process.env.PONOS_MOCK_WRITE_DIR = prev
    env.cleanup()
  }
})

test('前台 Agent 返回体列出全部产物（不止最后一个）', async () => {
  const env = makeEnv()
  const prev = process.env.PONOS_MOCK_WRITE_DIR
  try {
    process.env.PONOS_MOCK_WRITE_DIR = env.workDir
    const r = await env.engine.spawnSubAgent(
      { subagent_type: 'general-purpose', prompt: '[mock:write]' }, // 无 run_in_background ⇒ 前台同步
      { toolUseId: 'tool_use_ev_3' },
    )
    assert.equal(r.isError, false)
    // 两个产物都要出现（改造前只出现最后一个）
    assert.match(r.content, /mock-a\.txt/)
    assert.match(r.content, /mock-b\.txt/)
  } finally {
    if (prev === undefined) delete process.env.PONOS_MOCK_WRITE_DIR
    else process.env.PONOS_MOCK_WRITE_DIR = prev
    env.cleanup()
  }
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test --test-timeout=120000 kernel-tests/subagent.test.mjs`
Expected: FAIL —— `n.reads` 为 `undefined`（`deepEqual` 报错）；`n.transcript_path` 为 `undefined`；前台 content 不含 `mock-a.txt`。

- [ ] **Step 3: 扩展 `taskNotification` 契约**

`kernel/protocol.mjs:154-165`，替换为（**只增字段**）：

```js
    // S3 结果承接：outputs 为子 agent 会话内**全部产物**路径（Write + Edit；主 agent
    // 中转给下家子 agent 的"接力清单"，配合共享工作区实现流水线协同）；
    // reads 为其 Read 过的文件（主 agent 据此避免重读）；transcriptPath 为其会话落盘
    // 文件（可用 Read offset/limit 精确展开过程细节，替代"让子 agent 复述"）。
    taskNotification({ taskId, status, summary, outputFile, usage = {}, outputs = [], reads = [], transcriptPath = '' }) {
      writeLine(stream, {
        type: 'system', subtype: 'task_notification', task_id: taskId,
        status: status || 'completed', summary: summary || '', output_file: outputFile || '',
        outputs: Array.isArray(outputs) ? outputs : [],
        reads: Array.isArray(reads) ? reads : [],
        transcript_path: transcriptPath || '',
        usage: { tool_uses: usage.tool_uses ?? 0, total_tokens: usage.total_tokens ?? 0, duration_ms: usage.duration_ms ?? 0 },
      })
    },
```

- [ ] **Step 4: 改 `runLaneExecution` 采集与返回**

`kernel/engine.mjs:1879` 起，函数签名加 `readPaths`，并在终态汇总去重、回传：

```js
  async function runLaneExecution({ taskId, laneStore, sysPrompt, signal: subSignal, writePaths, readPaths, t0, onTool, laneOptions, inbox }) {
```

在 `const outputFile = writePaths[writePaths.length - 1] || ''` **之前**插入去重收口（保持首次出现顺序）：

```js
    // 产物与读面去重（同一文件可被多次 Edit / Read）：保序去重，避免回传给主 Agent
    // 的清单里出现重复路径。writePaths 原为"最后产物"取用，去重不改变其末元素语义。
    const dedupe = (arr) => [...new Set((arr || []).filter(Boolean))]
    const outputs = dedupe(writePaths)
    const reads = dedupe(readPaths)
    const transcriptPath = String(laneStore?.file || '')
    const outputFile = outputs[outputs.length - 1] || ''
```

将紧随其后的 `const outputFile = writePaths[writePaths.length - 1] || ''` 行**删除**（已被上面替换）。

`Object.assign(entry, ...)` 与 `wire.taskNotification(...)` 两处同步补齐：

```js
    if (entry) Object.assign(entry, { status, summary: text, outputFile, outputs, reads, transcriptPath, usage: notifUsage })
    wire.taskNotification({ taskId, status, summary: text, outputFile, outputs, reads, transcriptPath, usage: notifUsage })
```

函数末尾的返回改为：

```js
    return { status, text, usage, outputFile, outputs, reads, transcriptPath }
```

- [ ] **Step 5: 改 resume 调用点传参**

`kernel/engine.mjs:1947-1951` 的 `runLaneExecution({...})` 补 `readPaths`：

```js
      target.promise = runLaneExecution({
        taskId: resumeTaskId, laneStore: target.laneStore, sysPrompt: target.sysPrompt,
        signal: subController.signal, writePaths, readPaths, t0, onTool, laneOptions: target.laneOptions,
        inbox: target.inbox || [],
      })
```

- [ ] **Step 6: 改 spawn 调用点传参**

`kernel/engine.mjs:2028-2031` 的 `exec` 补 `readPaths`：

```js
    const exec = () => runLaneExecution({
      taskId, laneStore, sysPrompt,
      signal: subController.signal, writePaths, readPaths, t0, onTool, laneOptions, inbox,
    })
```

- [ ] **Step 7: 改 foreground 返回体（核心交付）**

`kernel/engine.mjs:2061-2075`，替换 detail 组装：

```js
    const totalTokens = (r.usage.input_tokens ?? 0) + (r.usage.output_tokens ?? 0)
      + (r.usage.cache_read_input_tokens ?? 0) + (r.usage.cache_creation_input_tokens ?? 0)
    // 证据面回传：产物**全量**（原只给 outputFile 一个，多产物任务会被主 Agent 漏接）、
    // 读面限量（读过的文件可能很多，全量会淹掉主上下文；上限内全列，超出给总数提示）、
    // 过程入口（transcript 路径，主 Agent 可 Read offset/limit 展开，替代原文复述）。
    const outs = Array.isArray(r.outputs) ? r.outputs : []
    const reads = Array.isArray(r.reads) ? r.reads : []
    // LANE_READS_MAX = 0 表示"不限"（与 LANE_MAX_CONCURRENT 的 0 语义一致）；
    // 不能直接 slice(0, 0)——那会返回空数组，把"不限"变成"不列"。
    const shownReads = LANE_READS_MAX > 0 ? reads.slice(0, LANE_READS_MAX) : reads
    const detail = [
      `子 Agent「${agent.id}」执行完成（${totalTokens} tokens）`,
      r.text,
      outs.length ? `产物（${outs.length}）：${outs.join('、')}` : '',
      shownReads.length
        ? `已读文件（${reads.length}）：${shownReads.join('、')}${reads.length > shownReads.length ? `\n（仅列前 ${LANE_READS_MAX} 个，其余见过程记录）` : ''}`
        : '',
      r.transcriptPath ? `过程记录：${r.transcriptPath}（需要细节用 Read offset/limit 展开，勿让子 Agent 复述）` : '',
    ].filter(Boolean).join('\n\n')
    return { content: detail, isError: false }
```

`kernel/engine-config.mjs:212` 的 `LANE_MAX_CONCURRENT` 之后追加。**落点依据**：该文件头注自述"PONOS_* 环境变量的唯一求值点"，lane 相关阈值（`LANE_MAX_CONCURRENT`）正集中于此；且读面上限应可调（不同模型上下文差距大），故走 env 而非硬编码。engine.mjs 的模块顶层只放 import/re-export（P1-6 拆分后的既有约定），**不得**在此新起常量区。

```js
// 跨 Agent 证据面（2026-09-19）：前台子 Agent 回传给主 Agent 的"已读文件"条数上限。
// 为什么限量：reads 可能上百条，全量进主上下文会挤掉真正要用的历史，小窗口本地模型
// 尤其吃不消。**产物（outputs）不设上限**——每个都是需要主 Agent 接力的交付物，
// 漏一个就是任务断链（两者的信息价值不同：读面可再生，产物不可再生）。0 = 不限。
export const LANE_READS_MAX = envNonNeg('PONOS_LANE_READS_MAX', 15)
```

`kernel/engine.mjs:41` 的 import 中，把 `LANE_MAX_CONCURRENT, LOOP_STALL_MS` 替换为 `LANE_MAX_CONCURRENT, LANE_READS_MAX, LOOP_STALL_MS`（按既有字母序排入）。

- [ ] **Step 8: `taskSystem.output` 补过程入口**

`kernel/engine.mjs:2137-2143`，替换 `output(taskId)`：

```js
    output(taskId) {
      const t = pendingSubAgents.get(String(taskId || ''))
      if (!t) return { content: `任务不存在：${taskId}`, isError: true }
      if (t.status === 'running') return { content: '任务仍在运行中', isError: false }
      const parts = [
        String(t.summary || '(无输出)'),
        Array.isArray(t.outputs) && t.outputs.length ? `产物（${t.outputs.length}）：${t.outputs.join('、')}` : '',
        t.transcriptPath ? `过程记录：${t.transcriptPath}（用 Read offset/limit 展开）` : '',
      ].filter(Boolean)
      return { content: parts.join('\n\n'), isError: false }
    },
```

- [ ] **Step 9: 运行测试，确认通过**

Run: `node --test --test-timeout=120000 kernel-tests/subagent.test.mjs`
Expected: PASS（3 tests）

- [ ] **Step 10: 全量回归**

Run: `npm run test:kernel`
Expected: 全过（现有 2020 项 + 本计划新增）。若有失败，优先核对 `kernel-tests/subagent.test.mjs` 与消费 `task_notification` 的前端类型（`src/` 下若有 TS 类型定义需同步，`grep -rn "task_notification" src/`）。

- [ ] **Step 11: 提交**

```bash
git add kernel/engine.mjs kernel/protocol.mjs kernel-tests/subagent.test.mjs
git commit -m "feat(subagent): 回传全量产物/读面/过程记录入口给主 Agent"
```

---

### Task 3: lane transcript 可被 Read 展开

**Files:**
- Modify: `kernel/tools.mjs:726-732`（`readAllowFilesSet` 旁新增注册方法）、`:1579-1581`（`setKnowledgeReadDirs` 旁导出）
- Modify: `kernel/engine.mjs:1996` 附近（spawn 注册）、`:1935` 附近（resume 注册）
- Test: `kernel-tests/subagent.test.mjs`（追加用例）

**Interfaces:**
- Consumes: Task 2 的 `runLaneExecution` 返回的 `transcriptPath`（= `laneStore.file`）
- Produces: `tools.addReadAllowFiles(files: string[]): void`

**背景**：lane transcript 已由 `createSessionStore` 落盘（`kernel/session.mjs:48-49` → `<configDir>/projects/<sanitize(cwd)>/<taskId>.jsonl`，本机实有 493 个），但 Read 白名单只含**主会话自身**那个文件（`kernel/engine.mjs:75` 的 `readAllowFiles: session?.file ? [session.file] : []`，且全仓仅此 1 个 `createToolRegistry` 调用点）⇒ Task 2 给出的 `transcriptPath` 目前**读不到**。

**实现者须知的三个已核实事实**（2026-09-19 实读代码）：

1. **边界判定就一处**：`kernel/tools.mjs:113-114` —— `const fileAllowed = allowFiles && allowFiles.has(resolved.toLowerCase())`，放行条件是 `skipBoundary || withinBoundary(resolved, allowDirs) || fileAllowed`；拒绝文案为 `拒绝访问：路径超出会话目录边界（<resolved>）`。`allowFiles` 即 `readAllowFilesSet`（`:731` 定义 → `:879` **唯一**使用点，直接传入 `readFile`）⇒ 对该 Set 做 `.add()` **立即生效**，无需重建。
2. **入 Set 必须与判定同规范化**：`:731` 存入的是 `resolve(f).toLowerCase()`。`addReadAllowFiles` 必须走同样的 `resolve(...).toLowerCase()`，否则大小写/相对路径差异会让放行静默失效（Windows 盘符大小写尤其敏感）。`Set` 天然去重，resume 同一 lane 重复注册无副作用。
3. **既有近邻先例走的是另一条通道，不要照抄**：`engine.mjs:65-75` 的 `toolResultsDir`（大结果落盘目录）是把目录**并入 `addDirs`**——那同时放宽了**写**边界。lane transcript 只需**读**，故本任务走 `readAllowFilesSet` 侧，写边界（`allowDirs`）逐字不动。这也是 `Global Constraints` 的硬要求。

- [ ] **Step 1: 写失败测试**

追加到 `kernel-tests/subagent.test.mjs`：

```js
test('lane transcript 可被主 Agent 用 Read 展开（落盘在会话目录之外）', async () => {
  const env = makeEnv()
  try {
    const marker = '证据面可读性标记文本'
    const r = await env.engine.spawnSubAgent(
      { subagent_type: 'general-purpose', prompt: marker, run_in_background: true },
      { toolUseId: 'tool_use_ev_4' },
    )
    const taskId = extractTaskId(r.content)
    assert.ok(taskId)
    await env.waitNotif(taskId)
    const lanePath = env.laneFile(taskId)
    // 前置事实：该文件确实落在会话目录之外（否则本测试恒通过、测不出放行效果）
    assert.ok(!lanePath.startsWith(env.workDir), 'lane transcript 必须在 addDirs 之外')
    // 直调注册表里的 Read 条目。注意 registry 的形态是 { Read: { run(input) }, ... }
    // （tools.mjs:879 `run: (input) => readFile(path, readAllowDirs, input, cwd, readCache, skipBoundary, readAllowFilesSet)`），
    // 没有 tools.run({name, input}) 这种统一入口——Read.run 只需 input，不需要 ctx。
    const rr = env.engine.tools.Read.run({ file_path: lanePath })
    assert.notEqual(rr.isError, true, `Read lane transcript 不应被边界拒绝：${String(rr.content).slice(0, 200)}`)
    assert.match(String(rr.content), new RegExp(marker), 'Read 结果应含 lane 内的任务文本')
  } finally { env.cleanup() }
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test --test-timeout=120000 kernel-tests/subagent.test.mjs`
Expected: FAIL —— `rr.isError === true`，content 含越界文案（"路径超出会话目录边界"一类），`assert.notEqual` 报错。

- [ ] **Step 3: 在 tools.mjs 暴露注册方法**

`kernel/tools.mjs:731` 的 `readAllowFilesSet` 声明**保持 `const`**（只改内容、不换引用，故 Read 侧的 `readAllowFilesSet` 引用时刻可见新条目）。在 `:1581` 的 `setKnowledgeReadDirs(dirs) {...}` 之后追加：

```js
    // 跨 Agent 证据面（lane transcript 只读放行）：子 Agent 会话的落盘 transcript 由
    // 内核自己构造路径（createSessionStore 的 file），**不是用户输入** ⇒ 不会因放行
    // 而扩大攻击面；且只进 Read 白名单——Write / Edit / Bash / OCR 仍用 allowDirs，
    // 子 Agent 会话文件对模型**只读**。与既有 readAllowFiles（主会话自身 transcript）
    // 同性质，收口在同一片边界。
    // 用追加而非替换：主会话 transcript 与多个 lane transcript 需同时可读，
    // 且 Set 天然去重（resume 同一 lane 重复注册无副作用）。
    addReadAllowFiles(files) {
      for (const f of Array.isArray(files) ? files : []) {
        if (f) readAllowFilesSet.add(resolve(String(f)).toLowerCase())
      }
    },
```

- [ ] **Step 4: 在 engine 注册 lane transcript**

`kernel/engine.mjs:1996`（spawn 分支，`const laneStore = createSessionStore({...})` 之后）追加：

```js
    // 证据面接线（Task 3）：lane transcript 纳入 Read 只读白名单——主 Agent 可据
    // task_notification.transcript_path 用 Read offset/limit 精确展开子 Agent 过程，
    // 不必让子 Agent 把细节"说"一遍（低带宽有损编码 → 无损引用）。
    tools.addReadAllowFiles([laneStore.file])
```

`kernel/engine.mjs:1935`（resume 分支，`if (!target.laneStore) ...` 守卫之后）追加：

```js
      tools.addReadAllowFiles([target.laneStore.file])
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `node --test --test-timeout=120000 kernel-tests/subagent.test.mjs`
Expected: PASS（4 tests）

- [ ] **Step 6: 全量回归 + 边界复核**

Run: `npm run test:kernel`
Expected: 全过。
再显式确认写边界未被放宽（本任务只动只读侧）：

```bash
grep -n "addReadAllowFiles" kernel/tools.mjs kernel/engine.mjs
```
Expected: 3 处（1 定义 + 2 调用）；且 `kernel/tools.mjs` 的 `writeFile` / `editFile` 调用参数仍为 `allowDirs`（未出现 `readAllowFilesSet`）。

- [ ] **Step 7: 提交**

```bash
git add kernel/tools.mjs kernel/engine.mjs kernel-tests/subagent.test.mjs
git commit -m "feat(subagent): lane transcript 纳入 Read 只读白名单，过程可精确展开"
```

---

### Task 4: reviewer 异族模型实测裁决（非代码）

**Files:**
- 不修改产品代码（配置项：`$PONOS_HOME/agents/*.md` frontmatter 的 `model` 字段，解析已存在于 `kernel/agents.mjs:238`）
- 产出：`docs/superpowers/audits/YYYY-MM-DD-reviewer-cross-model.md`（实测报告）

**Interfaces:**
- Consumes: 无（独立于 Task 1–3）
- Produces: 是否将 `reviewer` 默认 `model` 改为异族模型的结论 + 实验数据

**背景**：`kernel/agents.mjs` 的六个内置 agent 全部 `model: ''`（`:30,42,56,70,84,97`）⇒ `loopModel = options?.model || model`（`kernel/engine.mjs:1516`）⇒ **全部继承主会话模型**，`reviewer` 与主 Agent 同模型。而 `docs/superpowers/specs/2026-09-11-agent-orchestration-upgrade.md` 的"不采纳"理由写着"本地单模型环境无第二模型可用"——该前提已被本机配置推翻（4 个 provider / 6 个模型：DeepSeek×2、MiniMax-M3、Qwen3.8-27B、rulu×2）。

**⚠️ 本任务不预设结论**：C2C 论文给的是"不同模型正确答题集重叠小"的**论文场景**实证，**不是本应用场景的证据**。故必须先实测再改默认。

- [ ] **Step 1: 选定对照任务**

挑一个**已有客观判据**的审查任务（避免主观打分），例如：对一份已完成改动跑 `reviewer`，判据 = "是否找出预设缺陷"。准备 3 个含已知缺陷的改动样本，记录缺陷清单（真值）到报告。

- [ ] **Step 2: 跑对照组（同族，现状）**

用 `reviewer` 默认配置（继承主会话模型）跑 3 个样本，记录：找出的缺陷数、误报数、漏报的已知缺陷、token 成本。

- [ ] **Step 3: 跑实验组（异族）**

写一个临时 agent 定义（**不改内置**），复用 `reviewer` 正文但指定异族 `model`：

```markdown
---
name: reviewer-cross
description: "审查者（异族模型对照实验用）"
tools: Read, Glob, Grep, Bash, WebFetch
disallowedTools: Write, Edit, Agent, Task, TodoWrite
model: "<与主会话模型不同的可用模型 id>"
---
<复制 kernel/agents.mjs 中 reviewer 的 systemPrompt 正文>
```

放到 `$PONOS_HOME/agents/reviewer-cross.md`，同样跑 3 个样本。

- [ ] **Step 4: 记录并裁决**

报告须含：两组的缺陷命中率 / 误报率 / token 成本对照表，以及结论——
- 异族组命中率显著更高且误报不增 ⇒ 建议改 `reviewer` 默认 `model`；
- 无显著差异或成本更高 ⇒ 维持现状，并在报告写明"spec 的不采纳理由需从'无模型可用'改为'实测无收益'"（事实依据变了，理由也须更新）。

- [ ] **Step 5: 提交报告**

```bash
git add docs/superpowers/audits/*-reviewer-cross-model.md
git commit -m "docs(subagent): reviewer 异族模型对照实测报告"
```

---

## Self-Review

**1. Spec coverage**（对照 `docs/2026-09-18-前缀缓存命中率优化方案.md` §4 失效源清单与本次代码实测的五处洞）

| 实测洞 | 证据 | 覆盖任务 |
|---|---|---|
| Edit 产物不入账 | `engine.mjs:1862` 只认 `Write` | Task 1 |
| 多产物不达主 Agent | `:1906` 只进 wire，`:2071-2075` 只给 `outputFile` | Task 2 Step 7 |
| transcript 落盘但不可达 | `session.mjs:48-49` 落盘；`engine.mjs:75` 白名单只含 `session.file` | Task 3 |
| reads 完全不采集 | `:1860-1876` 只取 Write 路径 | Task 2 |
| 内置 agent 全同模型 | `agents.mjs:30,42,56,70,84,97` 全 `model: ''` | Task 4 |

未纳入（有意）：前缀缓存 P2-11（lane 前缀复用）——它改的是 `inherit` 的入 lane 位置，与 Task 3 的"读侧放行"是不同风险面（前者动请求前缀构成，可能影响缓存与指令权重），宜独立计划；本计划的 `Global Constraints` 已声明不改 `inherit`。

**2. Placeholder scan**：无 TBD / "适当处理" / "类似 Task N"。Task 4 Step 3 的 `<复制 reviewer 正文>` 与 `<与主会话模型不同的可用模型 id>` 是**实验参数**（值取决于实测时本机可用模型），非实现占位符——该任务本身即"产出这些取值"的实验。

**3. Type consistency**：`makeLaneOnTool` 的 `readPaths` 参数名贯穿 Task 1（定义 + 2 调用点）与 Task 2（`runLaneExecution` 签名 + 2 调用点，先由 Task 1 声明数组、Task 2 再把它传下去，两步不重叠）；`MUTATING_FILE_TOOLS` 在 `kernel/tools.mjs` 导出、`kernel/engine.mjs:32` 导入，仅此两处；`outputs` / `reads` / `transcriptPath` 三个名字在 `runLaneExecution` 返回值、`Object.assign(entry)`、`wire.taskNotification` 参数、`protocol.mjs` 的 `task_notification` 字段（wire 为 snake_case `outputs` / `reads` / `transcript_path`）、foreground detail、`taskSystem.output` 六处保持一致；`LANE_READS_MAX` 在 `engine-config.mjs` 定义、`engine.mjs:41` 导入并用于 foreground，同名无变体。

**4. 落点依约定核对（本次自审修正的三处）**：

| 原写法 | 问题 | 修正 |
|---|---|---|
| `MUTATING_FILE_TOOLS` 放 `engine.mjs` 函数体内 | 与"工具名集合"的既有先例（`tools.mjs` 的 `CHAT_MODE_DISALLOWED`）不一致；且离它描述的工具定义太远，将来加工具易漏改 | 移到 `kernel/tools.mjs` 导出，engine 导入 |
| `LANE_READS_MAX` 放 `engine.mjs` 顶层 | `engine.mjs` 模块顶层经 P1-6 拆分后只放 import/re-export，阈值一律归 `engine-config.mjs`（`LANE_MAX_CONCURRENT` 即在彼处） | 移到 `engine-config.mjs:212` 之后，并走 `envNonNeg` 支持 `PONOS_LANE_READS_MAX` |
| `reads.slice(0, LANE_READS_MAX)` + 注释"0 = 不限" | 语义自相矛盾：`0` 时 `slice` 返回空数组，等于"不列"而非"不限" | 改为 `LANE_READS_MAX > 0 ? reads.slice(...) : reads` |

**已知风险（实施者须留意）**：`kernel/engine.mjs:75` 的 `createToolRegistry` 调用是**全仓唯一**调用点，且该行注释说明 `cli.mjs` 还有独立构造路径（`cli.mjs:485,745,759` 注释提及测试直接构造 registry）。Task 3 的 Step 6 已要求 grep 复核写边界；若发现测试夹具自行构造 registry 并传 `readAllowFiles`，须确认 `addReadAllowFiles` 在无调用时行为为空操作（当前实现满足：空数组循环不执行）。
