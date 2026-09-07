# S2-P0：内核正确性缺陷修复（P0 #1/#2/#3 + 守卫基线核验）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 ponos-dev 内核（Ponos-turbo）修复外部审计的 P0 正确性缺陷——#1 子 Agent 循环补 stop_reason/截断拒执、#3 health chainDepth 改窗口增量、#2 摘要请求补孤儿 tool_use 补丁——并在全量回归绿后作为 S3 迁移的修复后基线。

**Architecture:** 修复全部落在 `C:\Users\T203-15\ponos-dev`（内核现行开发地，含完整测试环境）。子 lane 逻辑（`kernel/engine.mjs` 的 `runSubAgentLoop`）对齐主循环既有 P0-2 分支；`kernel/health.mjs` 的链深度改为统计窗口内压缩**增量**；`kernel/compact.mjs` 摘要请求组装前对 covered 消息做孤儿 tool_use 补丁（复用 `engine.mjs` 导出的 `patchOrphanToolUses`，无循环依赖——engine 不 import compact）。

**Tech Stack:** Node >= 18 ESM、node:test、零 npm 依赖内核、bun 构建（仅产物，本计划不涉及）。

## Global Constraints

- 执行目录：`C:\Users\T203-15\ponos-dev`（git 仓库；每任务独立 commit）
- 测试命令：`cd C:/Users/T203-15/ponos-dev && node --test server/<file>.test.mjs`
- 全量回归：`cd C:/Users/T203-15/ponos-dev && node --test "server/*.test.mjs" "electron/*.test.mjs"`（已知 flaky 见审计 #11；本计划以"目标文件 + 相关 suite 全绿"为任务门，全量门禁治理归 S2-P1）
- 测试 hermetic 纪律：引用 `process.env` 的守卫类测试必须用 `PONOS_MOCK_API=1` 门控，涉及 `createHealth` 必须传 `env: {}` 隔离（防 `PONOS_HEALTH_COMPACT_COUNT` 泄漏）
- 不改动 mock 既有分支语义；新 mock 行为用新 env/marker 追加，旧测试零改动
- 目标文件当前锚点（以 2026-09-07 HEAD 为准）：`engine.mjs:1037-1149`（runSubAgentLoop）、`engine.mjs:728-744`（主循环 P0-2 镜像源）、`engine.mjs:197-221`（patchOrphanToolUses）、`compact.mjs:245-259`（assembleSummaryRequest）、`compact.mjs:328-343`（runSummarizer）、`health.mjs:60-83`（snapshot/chainDepth）
- 参考样例：`server/subagent.test.mjs`（子 lane 测试环境 makeEnv）、`server/engine-guard-gen.test.mjs`（守卫集成测试写法）、`server/health.test.mjs`、`server/compact.test.mjs`

---

### Task 1: 守卫回归基线核验（对应审计 #7 的"先验证"部分）

**Files:**
- Run only（无源码改动）：`server/engine-guard-*.test.mjs`、`server/r3-guard.test.mjs`、`server/subagent.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces: 守卫测试当前绿/红清单（写进 commit message 或任务备注），决定后续任务是否有"补测试"工作量

- [ ] **Step 1: 逐个跑守卫相关测试**

Run:
```bash
cd C:/Users/T203-15/ponos-dev && for f in server/engine-guard-gen.test.mjs server/engine-guard-heal.test.mjs server/engine-guard-iter.test.mjs server/engine-guard-meltdown.test.mjs server/engine-guard-idle.test.mjs server/r3-guard.test.mjs server/subagent.test.mjs; do echo "== $f"; node --test "$f" 2>&1 | tail -3; done
```
Expected: 全部 PASS（当前 HEAD 已跟踪这些测试且引用 mock 分支——审计 #7 的"零覆盖"论断在该快照不成立，以实测为准）。若任一 FAIL，先记下失败用例，禁止跳过；在 Task 4 完成后复跑确认非本计划引入。

- [ ] **Step 2: 记录基线**

将每个文件的 pass/fail 计数写入提交说明（不单独 commit，随 Task 4 的验证步骤一并固化进最终回归结果备注）。

---

### Task 2: #1 子 Agent 循环补 stop_reason + P0-2 截断拒执

**Files:**
- Modify: `kernel/engine.mjs`（`runSubAgentLoop`，约 1037-1149）
- Modify: `kernel/api.mjs`（`mockStream`：新增两个 mock 分支）
- Test: `server/engine-lane-trunc.test.mjs`（新建，镜像 `server/subagent.test.mjs` 的 makeEnv 写法）

**Interfaces:**
- Consumes: 主循环 P0-2 分支语义（`engine.mjs:728-744`）；子 lane store API：`store.appendAssistant(content, { model })`、`store.appendToolResults(results)`（用例见 `engine.mjs:1132-1145`）；lane 生成链：`spawnSubAgent` 把 `Agent` 工具 `input.prompt` 作为子 lane 首条 user 消息（`engine.mjs:1247-1248` `laneStore.appendUser(prompt)`），`mockStream` 按末条真实 user 文本的标记分发 mock 分支
- Produces: 子 lane 在流以 `stop_reason='length'` 结束时不再执行残缺 tool_use：注入 is_error tool_result 提示补全重发并 continue 续跑（lane 转录可证）

- [ ] **Step 1: 加 mock 分支**（测试脚手架）

`kernel/api.mjs` 的 `mockStream` 中，紧挨既有 `[mock:tool-safe]` 分支（安全 Bash）之后加**主循环分支**（触发一次携带自定义 prompt 的 Agent 工具；从既有 `[mock:agent]` 分支原样复制 tool_use 形状，只改标记名与 prompt——`[mock:agent]` 分支须与 `engine.mjs` 的 Agent 工具输入 schema 一致，读它再照抄）：
```js
// 子 lane 截断测试（审计 #1）：触发 Agent 工具，子任务 prompt 内嵌 [mock:lane-trunc]
if (lastText.includes('[mock:agent-lane-trunc]')) {
  if (signal?.aborted) throw abortError()
  await sleep(MOCK_SLEEP_MS)
  yield { type: 'tool_use', id: 'tool_use_mock_agent_lane_trunc', name: 'Agent',
    input: { subagent_type: 'general-purpose', prompt: '子任务：请针对 [mock:lane-trunc] 输出确认' } }
  yield { type: 'usage', usage: MOCK_USAGE }
  return
}
```
再加**lane 分支**（子 lane 流上产出安全 Bash + `stop_reason='length'`；marker 只出现在该测试的 prompt 中，不会误伤既有用例）：
```js
// 子 lane 截断模拟（审计 #1）：非高危 Bash tool_use + 截断 stop_reason
if (lastText.includes('[mock:lane-trunc]')) {
  if (signal?.aborted) throw abortError()
  await sleep(MOCK_SLEEP_MS)
  yield { type: 'tool_use', id: 'tool_use_lane_trunc_1', name: 'Bash', input: { command: 'echo mock-lane-trunc' } }
  yield { type: 'stop_reason', reason: 'length' }
  yield { type: 'usage', usage: MOCK_USAGE }
  return
}
```
> `[mock:agent-lane-trunc]` 不含 `[mock:lane-trunc]` 子串，主请求不会误触发 lane 分支；`input` 键名以 `[mock:agent]` 既有分支实测形状为准。

- [ ] **Step 2: 写失败测试**（先复现缺陷）

新建 `server/engine-lane-trunc.test.mjs`（写法镜像 `server/subagent.test.mjs` 的 makeEnv + 前台 Agent 链路断言）：

```js
// 子 lane P0-2 截断拒执（审计 #1）：lane 流产出 tool_use 后 stop_reason=length 时，
// 残缺参数的 Bash 不得执行成功，而应转为 is_error tool_result（内容含"截断"）提示重发。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from '../kernel/engine.mjs'
import { createSessionStore } from '../kernel/session.mjs'
import { makeWire } from '../kernel/protocol.mjs'

process.env.PONOS_MOCK_API = '1'

function makeEnv() {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const dir = mkdtempSync(join(tmpdir(), 'ponos-lane-trunc-'))
  const configDir = join(dir, 'home')
  const store = createSessionStore({ configDir, cwd: dir, sessionId: 'main-session' })
  const engine = createEngine({
    opts: { model: 'mock-model', configDir, addDirs: [dir], skipPermissions: true },
    wire,
    session: store,
  })
  engine.setSystemPrompt('你是 Ponos-turbo 测试内核。')
  // 子 lane transcript 路径（同 subagent.test.mjs laneFile 规则）
  const laneFile = (taskId) => join(configDir, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'), `${taskId}.jsonl`)
  return { events, engine, store, dir, laneFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('子 lane：stop_reason=length 的 tool_use 不执行，落 is_error 提示后正常完成', async () => {
  const env = makeEnv()
  try {
    const r = await env.engine.runTurn({ content: '[mock:agent-lane-trunc]' })
    const sys = env.events.filter((e) => e.type === 'system')
    const started = sys.find((e) => e.subtype === 'task_started')
    assert.ok(started, '应有 task_started')
    // 前台子任务完成后通知存在
    const notif = sys.find((e) => e.subtype === 'task_notification' && e.task_id === started.task_id)
    assert.ok(notif, '应有 task_notification')
    // lane transcript 必须含"截断拒执"的 is_error tool_result
    const lane = readFileSync(env.laneFile(started.task_id), 'utf-8')
    assert.ok(lane.includes('截断'), `lane 转录应含截断拒执说明，实际：${lane.slice(-400)}`)
    assert.ok(lane.includes('"is_error":true') || lane.includes('is_error: true'), '拒执 tool_result 应为 is_error')
    // 主线程正常收尾
    assert.ok(String(r.text).length > 0)
  } finally { env.cleanup() }
})
```

- [ ] **Step 3: 跑测试确认失败（缺陷复现）**

Run: `cd C:/Users/T203-15/ponos-dev && node --test server/engine-lane-trunc.test.mjs`
Expected: FAIL —— 修复前 lane 不消费 stop_reason，残缺 Bash 被当普通工具执行成功（转录出现 `echo mock-lane-trunc` 成功结果、无"截断"拒执），断言 `lane.includes('截断')` 失败。

- [ ] **Step 4: 生产代码修复（镜像主循环 P0-2）**

在 `kernel/engine.mjs` 的 `runSubAgentLoop` 内：
1. 每轮迭代流前声明截断标志（与 `blocks` 同处，约 1063 行）：
```js
const blocks = []
let subStopReason = null
```
2. chunk 处理分支补 stop_reason 消费（`tool_use` 分支之后，约 1086）：
```js
} else if (chunk.type === 'stop_reason') {
  subStopReason = chunk.reason
}
```
3. 在守卫自愈块（`if (subStop) {...}`，约 1121-1130）之后、`if (blocks.length === 0) break`（约 1131）之前，插入 P0-2 镜像（对齐主循环 `engine.mjs:730-744`，把 pushMemory/session 换为子 lane 的 store 调用）：
```js
// P0-2（子 lane 镜像）：输出被 max_tokens 截断且已产出工具调用 → 不执行残缺参数，
// 注入 is_error tool_result 提示模型补全重发（主循环同款保护，防子 lane 复活缺陷）
if (blocks.length > 0 && subStopReason === 'length') {
  const assistantBlocks = [...(textBuf.trim() ? [{ type: 'text', text: textBuf }] : []), ...blocks]
  store.appendAssistant(assistantBlocks, { model })
  const errorResults = blocks.map((b) => ({
    type: 'tool_result',
    tool_use_id: b.id,
    content: '模型输出被 max_tokens 截断，工具调用参数可能不完整，未执行。请重新完整发起该工具调用。',
    is_error: true,
  }))
  store.appendToolResults(errorResults)
  textBuf = ''
  continue
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd C:/Users/T203-15/ponos-dev && node --test server/engine-lane-trunc.test.mjs server/subagent.test.mjs`
Expected: PASS（新增 1 + 既有 lane 语义零回归）。

- [ ] **Step 6: Commit**

```bash
cd C:/Users/T203-15/ponos-dev && git add kernel/engine.mjs kernel/api.mjs server/engine-lane-trunc.test.mjs && git commit -m "fix(kernel): 子 lane 消费 stop_reason，length 截断拒执残缺 tool_use（审计 #1）"
```

---

### Task 3: #3 health chainDepth 改窗口增量（压缩后不再 10 轮恒红）

**Files:**
- Modify: `kernel/health.mjs`（`snapshot`，约 73 行）
- Test: `server/health.test.mjs`（追加用例）

**Interfaces:**
- Consumes: `record(turnStats)` 每轮入窗（`turnStats.compactCount` 为会话累计值）；`recent` 窗口上限 10
- Produces: `snapshot()` 的 `chainDepth` = 窗口内 `compactCount` **上升次数**（增量），单次压缩后后续轮次不再累计计深

- [ ] **Step 1: 写失败测试**（复现"压缩后 10 轮恒红"）

追加到 `server/health.test.mjs`：

```js
test('createHealth：压缩后多轮不再因 chainDepth 恒红（增量语义，审计 #3）', () => {
  const events = []
  const wire = {
    health: (d) => events.push({ type: 'ponos_health', ...d }),
    summary: (t, c) => events.push({ type: 'ponos_summary', text: t, compactCount: c }),
  }
  const h = createHealth({ wire, model: 'deepseek-v4-flash', contextWindow: 200_000, env: {} })
  // 10 轮健康记录：第 2 轮发生一次压缩（累计 compactCount 0→1），其余轮 1
  h.record({ usage: { input_tokens: 500 }, durationMs: 5, model: 'deepseek-v4-flash', ts: 't1', compactCount: 0 })
  h.record({ usage: { input_tokens: 500 }, durationMs: 5, model: 'deepseek-v4-flash', ts: 't2', compactCount: 1 }) // 压缩发生
  for (let i = 3; i <= 10; i++) {
    h.record({ usage: { input_tokens: 500 }, durationMs: 5, model: 'deepseek-v4-flash', ts: `t${i}`, compactCount: 1 })
  }
  const healthEvents = events.filter((e) => e.type === 'ponos_health')
  // 压缩后档位至多 amber（score 40，chainDepth 不累计）；不得出现 red/suggestNewSession
  const red = healthEvents.find((e) => e.tier === 'red')
  assert.equal(red, undefined, `压缩一次后不应 10 轮恒红，实际: ${JSON.stringify(red)}`)
  const last = healthEvents[healthEvents.length - 1]
  if (last) assert.notEqual(last.suggestNewSession, true)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd C:/Users/T203-15/ponos-dev && node --test server/health.test.mjs`
Expected: FAIL —— 修复前 `chainDepth = recent.reduce((s,t)=>s+(t.compactCount>0?1:0),0)`，第 2 轮后窗口内 9~10 条全带 compactCount>0 → chainDepth≥9 → score≥(9-1)×15+40=160 → red + suggestNewSession。

- [ ] **Step 3: 生产代码修复**

`kernel/health.mjs` `snapshot()` 内（约 73 行）把：
```js
const chainDepth = recent.reduce((s, t) => s + (t.compactCount > 0 ? 1 : 0), 0)
```
改为（窗口内增量：与上一条记录相比 compactCount 上升计 1 次；窗口起点本身不计，恢复/种子累计值不再误判连续压缩）：
```js
const chainDepth = recent.reduce(
  (s, t, i) => s + (i > 0 && t.compactCount > recent[i - 1].compactCount ? 1 : 0),
  0,
)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd C:/Users/T203-15/ponos-dev && node --test server/health.test.mjs`
Expected: PASS（含既有 5 个用例 + 新增 1 个）。

- [ ] **Step 5: Commit**

```bash
cd C:/Users/T203-15/ponos-dev && git add kernel/health.mjs server/health.test.mjs && git commit -m "fix(kernel): health chainDepth 改窗口增量计数，压缩后不再恒红（审计 #3）"
```

---

### Task 4: #2 摘要请求补孤儿 tool_use 补丁

**Files:**
- Modify: `kernel/compact.mjs`（顶部 import + `assembleSummaryRequest`，约 245-259）
- Test: `server/compact.test.mjs`（追加用例）

**Interfaces:**
- Consumes: `patchOrphanToolUses(msgs)`（`engine.mjs:197-221` 导出，纯函数）；`assembleSummaryRequest` 当前签名不变
- Produces: 摘要请求 body 的 covered 段先过 `patchOrphanToolUses`——resume 恢复/进程崩溃遗留的孤儿 tool_use（assistant 已落盘、tool_result 未落盘）在发摘要前被合成 is_error tool_result 补齐，杜绝摘要请求 400 → 压缩失败 → overflow-compact-failed 整轮死亡

- [ ] **Step 1: 写失败测试**

先读 `server/compact.test.mjs` 头部确认其 import 方式，追加用例：

```js
test('assembleSummaryRequest：covered 含孤儿 tool_use 时先补 is_error tool_result（审计 #2）', () => {
  const { assembleSummaryRequest } = await import('../kernel/compact.mjs')
  const orphan = {
    role: 'assistant',
    content: [{ type: 'text', text: '我来搜索' }, { type: 'tool_use', id: 'tu_orphan_1', name: 'Grep', input: { pattern: 'x' } }],
  }
  const body = assembleSummaryRequest({
    system: 'sys',
    messages: [],
    cut: { covered: [orphan] },
    lastSummary: null,
    keyInfo: '',
  })
  // body 顺序：covered（补丁后）→ 指令。孤儿 tool_use 必须有紧随的 is_error tool_result
  const toolResultMsg = body.find((m) => Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result'))
  assert.ok(toolResultMsg, '应存在补丁产生的 tool_result 用户消息')
  const tr = toolResultMsg.content.find((b) => b.type === 'tool_result')
  assert.equal(tr.tool_use_id, 'tu_orphan_1')
  assert.equal(tr.is_error, true)
  // 补丁消息必须紧跟 assistant，且其后才是指令（指令为最后一条）
  const idxAsst = body.findIndex((m) => m === orphan)
  const idxRes = body.indexOf(toolResultMsg)
  const last = body[body.length - 1]
  assert.ok(idxAsst >= 0 && idxRes === idxAsst + 1, 'tool_result 应紧跟孤儿 tool_use')
  assert.equal(last.role, 'user')
  assert.ok(!Array.isArray(last.content), '末条为指令文本')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd C:/Users/T203-15/ponos-dev && node --test server/compact.test.mjs`
Expected: FAIL —— 修复前 covered 原样进 body，无补丁 tool_result 消息。

- [ ] **Step 3: 生产代码修复**

`kernel/compact.mjs`：
1. 顶部追加 import（engine 不 import compact，无循环依赖，已核实）：
```js
import { patchOrphanToolUses } from './engine.mjs'
```
2. `assembleSummaryRequest` 内（约 246 行），对 covered 先补丁再组装：
```js
export function assembleSummaryRequest({ system, messages, cut, lastSummary, keyInfo = '', sessionMemory = '' }) {
  const covered = (cut.covered || [])
    .filter((m) => !(m?.role === 'assistant' && typeof m?.content === 'string'))
  const patched = patchOrphanToolUses(covered) // 审计 #2：摘要请求前补齐孤儿 tool_use（防 400）
  const body = []
  if (lastSummary) body.push({ role: 'user', content: `<compacted-summary>${lastSummary}</compacted-summary>` })
  body.push(...patched)
  // …… body 后续指令组装逻辑保持不变（smBlock/keyInfo 追加）……
}
```
> 注意：只替换 `covered` 定义与 `body.push(...covered)` 两处；其余（lastSummary、指令、sessionMemory）不动。patch 返回的新数组含新增 user 消息，保证补丁消息紧跟孤儿 assistant 之后、指令之前（Anthropic 链合法性）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd C:/Users/T203-15/ponos-dev && node --test server/compact.test.mjs server/compact-keyinfo.test.mjs`
Expected: PASS（既有 compact 用例零回归 + 新增 1 个）。

- [ ] **Step 5: Commit**

```bash
cd C:/Users/T203-15/ponos-dev && git add kernel/compact.mjs server/compact.test.mjs && git commit -m "fix(kernel): 摘要请求 covered 过 patchOrphanToolUses，孤儿 tool_use 不再致 400（审计 #2）"
```

---

### Task 5: P0 修复后回归固化（含守卫基线复跑）

**Files:**
- Run only（无源码改动）

**Interfaces:**
- Consumes: Task 2/3/4 修复已提交
- Produces: S2-P0 完成证据（可写进 S3 迁移基线的回归记录）

- [ ] **Step 1: 复跑全部相关 suite**

Run:
```bash
cd C:/Users/T203-15/ponos-dev && node --test server/engine-lane-trunc.test.mjs server/subagent.test.mjs server/health.test.mjs server/compact.test.mjs server/compact-keyinfo.test.mjs server/engine-guard-gen.test.mjs server/engine-guard-heal.test.mjs server/engine-guard-iter.test.mjs server/engine-guard-meltdown.test.mjs server/engine-guard-idle.test.mjs server/r3-guard.test.mjs
```
Expected: 全部 PASS（含 Task 1 记录的守卫基线——若 Task 1 存在 FAIL，此处必须已绿或注明与本次无关的既有红）。

- [ ] **Step 2: 提交回归记录**

在 `docs/superpowers/plans/2026-09-07-s2-kernel-p0-fixes.md` 末尾的"执行记录"区追加：修复后各 suite pass 数、守卫测试基线结论（#7 在该 HEAD 的实测状态）、任何既有红项。随计划文档在 yfworking 仓库提交（`cd C:/Users/T203-15/yfworking && git add docs/superpowers/plans/2026-09-07-s2-kernel-p0-fixes.md && git commit -m "docs(plan): S2-P0 执行记录"`）。

---

## 执行记录（S2-P0，2026-09-07）

修复基线：ponos-dev main 26bd8de → 1b350c5（三个独立 commit，每任务经独立 task review 后合入）。

| 审计项 | 修复 | 提交 | 测试证据 |
|---|---|---|---|
| #1 子 lane stop_reason/截断拒执 | engine.mjs runSubAgentLoop 消费 stop_reason + 镜像主循环 P0-2（is_error 拒执残缺 tool_use） | 4a6e594 | engine-lane-trunc + subagent 16/16 |
| #3 health chainDepth 窗口增量 | health.mjs snapshot() reduce 改增量计数（压缩后不再 10 轮恒红） | 882464c | health 9/9 |
| #2 摘要请求孤儿 tool_use 补丁 | compact.mjs covered 过 patchOrphanToolUses | 1b350c5 | compact + compact-keyinfo 27/27 |

守卫基线核验结论（审计 #7"零覆盖"论断）：在 26bd8de 快照不成立——7 个守卫相关套件（engine-guard-gen/heal/iter/meltdown/idle、r3-guard、subagent）已存在且全 PASS 24/24；本轮无"补守卫测试"工作量，守卫 suite 在修复后复跑仍全绿（engine-guard-* + r3-guard 共 9 个用例 PASS）。

修复后全量相关套件复跑（Task 5）：engine-lane-trunc 1/1、subagent 15/15、health 9/9、compact 22/22、compact-keyinfo 5/5、engine-guard-gen 1/1、engine-guard-heal 3/3、engine-guard-iter 1/1、engine-guard-meltdown 1/1、engine-guard-idle 1/1、r3-guard 2/2 —— 全部 PASS，无既有红项、无 flaky 抖动。

已知取舍：审计 #11 全量套件 flaky 治理（bridge/spawn collect timeout）与 #4/#5/#6、#8-#10 归 S2-P1/P2；本计划为 S3 迁移提供修复后基线。
