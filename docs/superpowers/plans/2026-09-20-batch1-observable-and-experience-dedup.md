# 批 1 实施计划：观测层 + 注入总账 + 经验去重（S1 + S1+ + S4.5）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 先把"看得见"和"最确定的浪费"解决掉——补上观测字段（O1/O2）、建立注入总账（O4）、消除经验元数据的重复常驻注入并修好其三层化（S4.5），**全部为纯增量或纯删减，零行为变更**。

**Architecture:** 8 个任务，按"无依赖 → 有依赖"排序，每步独立可交付、可回滚：
1. **S1（Task 1）**：观测层 O1（`turnToolDigest.size`）+ O2（`turnStats.guard`）。**纯增量**。
2. **S1+（Task 2）**：注入总账 O4（`inject_snapshot` + 只读分段计量 + 渠道记账）。**纯增量**。
3. **S4.5（Task 3–8）**：经验三层化——去重（2→1）→ 内核侧尊重 `active` → 字节口径统一 → 线索层（EL1）→ 接线与互斥 → 面板口径同步。**纯删减 + 新增只读线索**，目标 **−8526 B/轮**。

**Tech Stack:** Node.js ESM（`.mjs`）、`node:test` + `node:assert/strict`、现有 `createEngine`/`createSessionStore`、`npm run test:kernel`。

## Global Constraints

以下为项目级硬约束，**每个任务的要求都隐含包含本节**；数值与措辞逐字来自 spec，不得改写：

- **零行为变更（批 1 总原则）**：S1/S1+ **只增字段与账，不改任何注入内容、提示词、wire 序列**；S4.5 **只做去重与分层**，检索口径（评分 / 过滤 / `topK`）**一字不动**。
- **只读长度，不重组**：分段计量**只取长度**（`Buffer.byteLength`），**不得把提示词拆成"可重排的块"**。
- **S1+ 不改 `build` 预算口径**：字符→字节的换算**唯一归属 S4.5（Task 5）**，S1+ 不做。
- **不删既有字段**：`metrics.json` 的既有 `inject` / `search` 段**只增不删**（sidecar 形状不变）；`getInjectStats()` 既有字段一个都不动。
- **不引入** `priority` / `budgetBytes` / `kind` / `phase`：那是 **S3.5**（批 2）的事。
- **单步归属**：字节口径统一（字符→字节）**只在 Task 5 做**，其他任务不得顺手改。
- **EL1 关键约束**（逐字取自注入 spec §3.2.1 R1–R6 + D2/D6）：
  - **只发索引线索，不含正文**；`upgraded` 恒 `false`（**禁止全文升级**）
  - 每行必带 `blockId`；摘要走 `makeSnippet`（默认 160，线索层可放宽至 **300**）
  - 预载一跳锚点 ≤ **`INJECT_RELATED_TOPN`(3)**，剔除 `duplicate`；未授权空间**只给** `related` / `mode:'full'`
  - 预算**按字节记账**，装不下**丢弃整行**（不截断行内正文），**首条无条件放入**
  - EL1 上限 **≤1.5 KB（1536 B）**；恒在 EL0 **~200 B**（A14 断言 ≤512 B）
  - 逃生阀**只留 `PONOS_MEMORY_EL1=0`**，**不与** `PONOS_MEMORY_INJECT` 耦合（D6）
  - **观察期默认 `OBSERVE_ONLY`**（不真注入；`offered` / `offeredDryRun` 分名记录）
- **EL1 与 unified 抽调层互斥（A20）**：`strategy=legacy` → 线索段存在；`strategy=unified` → **线索段不存在**。**不改** unified 抽调层为线索形态。
- **不删函数定义**：`buildExperienceIndex` 的**定义与 re-export 必须保留**（`npm run verify:experience-inject` 与 `server/experience.test.mjs` 四处测试依赖它）；本批**只移除 `server/bridge.mjs` 的两处「注入调用」**。
- **文件暂存纪律**：**禁止 `git add -A`**（常态数十项他人在途改动）。按文件精确 `git add <path>`。

### 交付前门禁（每条都不能省）

```bash
cd /c/Users/T203-15/yfworking
npm run test:kernel                                      # 内核测试全绿（实测基线 210 个 .test.mjs，只增不减）
npm run kit:check                                        # 红 0（EXIT=0）
node --test --test-timeout=120000 "kit/**/*.test.mjs"     # ★ 引号必须有，否则静默漏测
npm run verify:ci                                        # EXIT=0
npm run verify:experience-inject                         # ★ 本批最易踩：经验注入契约必须仍绿
npm run verify:milestones-start                          # milestone 解析契约未破
```

> ★ 引号不是风格问题：不加引号时 shell 把 `**` 当单个 `*` ⇒ **静默漏掉** `kit/cli.test.mjs` 与 `kit/gui.test.mjs`。

## 范围与非范围

**本计划实现**：`S1`（O1/O2）、`S1+`（O4）、`S4.5`（①–⑦）。

**明确不在本计划**：
- `O3`（模式 meta）—— **阻塞于 S4**（`kernel/loop-mode.mjs` 尚不存在，模式在批 3 才建）。**不实现、不编字段**。
- `S2`/`S3`/`S3.5`（循环体契约 + 注入总线）—— 属**批 2**，见 `2026-09-20-batch2-loop-core-contract.md`。两批**无依赖**，可并行。
  - 唯一交界面：批 2 的 L4 等价锁可能用 O2 的 `turnStats.guard`。已在该计划写明"若批 1 未落地则用本地计数替代"。
- `S4`–`S11`（模式、方法论下沉）—— 行为变更，待 B1 交付并评审后另立计划。
- **不修任何无关 bug**。

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `kernel/inject-ledger.mjs` | **新建**。注入总账：`summarizeInjection` / `buildSegmentMeters` / `ledgerTotals`。纯函数，无 IO。 | 新建 |
| `kernel/knowledge-recommend.mjs` | **新建（Task 6）**。EL1 线索层：`buildRecommendSection`，复用 `searchKnowledgeItems`。纯函数。 | 新建 |
| `kernel/engine.mjs` | O1（`turnToolDigest.size`）+ O2（`turnStats.guard`）。 | 修改（小） |
| `kernel/knowledge-inject.mjs` | `getInjectStats()` 增 `channels`（**只增不删**）。 | 修改（小） |
| `kernel/cli.mjs` | 轮边界挂总账（Task 2）；`beforeIter` 接线 EL1 + 推荐集合登记（Task 7）。 | 修改（小） |
| `kernel/memory.mjs` | 内核注入侧尊重 `front.active`（Task 4）；字节口径统一（Task 5）。 | 修改（小） |
| `server/bridge.mjs` | 移除两处常驻经验注入调用（Task 3）。**不动定义与 re-export**。 | 修改（小） |
| `server/experience.mjs` | GUI 面板字节口径同步（Task 8）。 | 修改（小） |
| `kernel-tests/turn-observability.test.mjs` | **新建**。O1/O2 单测。 | 新建 |
| `kernel-tests/inject-ledger.test.mjs` | **新建**。总账与分段计量单测。 | 新建 |
| `kernel-tests/experience-dedup.test.mjs` | **新建**。去重（2→1）与 `active` 过滤单测。 | 新建 |
| `kernel-tests/knowledge-recommend.test.mjs` | **新建**。EL1 线索层单测（含 R1–R6 六条对照 + 边界）。 | 新建 |

---

## Task 1: S1 —— 观测层 O1（`turnToolDigest.size`）+ O2（`turnStats.guard`）

**Files:**
- Modify: `kernel/engine.mjs`（`turnToolDigest` 约 `:1031-1037`；守卫状态声明约 `:289-297`；`turnStats.push` 约 `:2386`）
- Test: `kernel-tests/turn-observability.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `turnToolDigest[i].size: number`（工具结果**字符长度**，非内容）
  - `turnStats[i].guard: { hits: string[], injections: number, iterCapHit: boolean, loopStopReason: string|null, stallHeals: number, errorStreak: number, repeatStreak: number }`
  - 模块内辅助函数 `collectGuardState()`（导出以便单测）

### 背景（实现者必读）

**为什么加 `size`**：`turnToolDigest` 现只有 4 字段（`name`/`path`/`isError`/`errorText`），**缺结果规模** ⇒ 无法区分"工具失败"与"工具成功但返回 12 万字符"，失真观测缺一块。

★ **不违反既有设计约束**：`kernel/engine.mjs:1024-1025` 注释写明「只保留"路径+是否失败+错误文本（截断）"，**不复制结果正文**（体积与隐私）」。`size` 是**一个整数长度**，不复制正文 ⇒ 约束**依然成立**。**严禁**把 `content` 存进 digest。

**为什么加 `guard`**：`turnStats` 现只有 `{usage,lastUsage,durationMs,model,ts,compactCount}`，**缺守卫字段** ⇒ 无法回答"这轮为什么停下来"。

★ **额外价值（务必实现到位）**：`guard.injections`（本轮守卫类注入条数）正是主 spec **§8.6 N1「停滞类注入每轮至多一条」的判据**——它是"轮内可见"的标记，让 N1 不必靠"读上下文文本"去重。批 3 会消费它。

- [ ] **Step 1: 核实落点与变量名（只读）**

```bash
cd /c/Users/T203-15/yfworking
# ① digest 落点 + 原始 content 读取处
grep -n "turnToolDigest" kernel/engine.mjs
# ② 守卫状态变量声明（确认名字，勿凭猜测）
grep -n "let loopStop\|let iterCapHit\|let errorStreak\|let repeatStreak\|let repeatHeals\|let stallHeals" kernel/engine.mjs
# ③ turnStats 落点
grep -n "turnStats.push" kernel/engine.mjs
```

Expected: 定位三处实际行号；确认变量名为 `loopStop`(≈`:289`)、`iterCapHit`(`:290`)、`errorStreak`(`:291`)、`repeatStreak`(`:292`)、`repeatHeals`(`:295`)、`stallHeals`(`:297`)。**以实测为准**。

- [ ] **Step 2: 写失败测试**

`kernel-tests/turn-observability.test.mjs`：

```js
// 观测层 O1/O2：digest 带结果规模；turnStats 带守卫状态
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectGuardState } from '../kernel/engine.mjs'

test('collectGuardState 输出固定字段形状', () => {
  const g = collectGuardState({
    hits: new Set(['wallClock', 'stall', 'wallClock']),
    injections: 2, iterCapHit: false, loopStop: { reason: 'timeout', message: 'x' },
    stallHeals: 1, errorStreak: 0, repeatStreak: 3,
  })
  assert.deepEqual(g.hits, ['wallClock', 'stall'], 'hits 应去重且保序')
  assert.equal(g.injections, 2)
  assert.equal(g.iterCapHit, false)
  assert.equal(g.loopStopReason, 'timeout')
  assert.equal(g.stallHeals, 1)
  assert.equal(g.errorStreak, 0)
  assert.equal(g.repeatStreak, 3)
})

test('collectGuardState：无 loopStop 时 loopStopReason 为 null', () => {
  assert.equal(collectGuardState({ hits: new Set(), injections: 0, loopStop: null }).loopStopReason, null)
})

test('collectGuardState：缺失输入不抛错，计数按 0', () => {
  const g = collectGuardState()
  assert.deepEqual(g.hits, [])
  assert.equal(g.injections, 0)
  assert.equal(g.stallHeals, 0)
})

test('digest 的 size 是结果长度而非正文（隐私约束）', () => {
  // 断言语义：size 为数字；digest 对象不得含 content 字段
  const digestEntry = { name: 'Read', path: 'a.mjs', isError: false, errorText: '', size: 12345 }
  assert.equal(typeof digestEntry.size, 'number')
  assert.ok(!('content' in digestEntry), 'digest 不得复制结果正文')
  assert.ok(!('resultText' in digestEntry))
})
```

- [ ] **Step 3: 运行测试确认失败**

```bash
node --test --test-timeout=120000 kernel-tests/turn-observability.test.mjs
```

Expected: FAIL —— `collectGuardState is not a function`（尚未导出）。

- [ ] **Step 4: 实现 O1（`size`）**

在 `turnToolDigest.push({...})` 的对象字面量中新增一个字段。**原上下文**（`kernel/engine.mjs` 约 `:1031-1037`，`content` 已在同函数 `:1026` 读到）：

```js
turnToolDigest.push({
  name: String(blocks[i]?.name || ''),
  path: String(inp.file_path ?? inp.path ?? inp.pattern ?? inp.notebook_path ?? '').slice(0, 300),
  isError: toolResults[i]?.is_error === true,
  errorText: String(typeof toolResults[i]?.content === 'string' ? toolResults[i].content : '').slice(0, 200),
  // O1：结果规模（字符数）。★ 只存长度，不存正文 —— 保持 :1024-1025 的体积与隐私约束
  size: typeof toolResults[i]?.content === 'string' ? toolResults[i].content.length : 0,
})
```

- [ ] **Step 5: 实现 O2（`guard`）**

**(a)** 在守卫状态变量声明处（约 `:289-297`，紧邻 `stallHeals` 之后）新增两个轮内累加器：

```js
// O2：本轮守卫命中登记（hits 去重保序；injections 供主 spec §8.6 N1「每轮至多一条注入」判据）
const turnGuardHits = new Set()
let guardInjectCount = 0
```

**(b)** 在每个守卫的**命中处**登记（**只加登记，不改任何判定/文案/事件**）：

| 守卫 | 登记语句 |
|---|---|
| ① 轮次墙钟 | `turnGuardHits.add('wallClock')` |
| ② 迭代硬上限 | `turnGuardHits.add('iterCap')` |
| ⑥ 无进展停滞 | `turnGuardHits.add('stall'); guardInjectCount++` |
| ①b 流内墙钟 | `turnGuardHits.add('streamWallClock')` |
| ③ 生成重复 | `turnGuardHits.add('genRepeat'); guardInjectCount++` |
| ③b 句级近重复 | `turnGuardHits.add('nearRepeat'); guardInjectCount++` |
| 空闲看门狗 | `turnGuardHits.add('idleWatchdog')` |
| 上游死亡 | `turnGuardHits.add('upstreamDead')` |
| R3-2 重复自愈 | `turnGuardHits.add('repeatHeal'); guardInjectCount++` |
| ④ 熔断 | `turnGuardHits.add('failureHeal'); guardInjectCount++` |
| ⑤ 同工具提醒 | `turnGuardHits.add('repeatReminder'); guardInjectCount++` |

> **命名与主 spec 的 `KNOWN_GUARDS` 对齐**（批 2 的 `loop-profile.mjs` 用同一套名字），便于日后"守卫命中率"横向对比。

**(c)** 在模块内新增并**导出** `collectGuardState`：

```js
/**
 * O2：收集本轮守卫状态，供 turnStats.guard 使用。
 * 纯函数——入参为显式对象，便于单测（不在内部读闭包变量）。
 */
export function collectGuardState(input = {}) {
  const hits = input.hits instanceof Set ? [...input.hits] : Array.isArray(input.hits) ? [...input.hits] : []
  return {
    hits,
    injections: Number.isFinite(input.injections) ? input.injections : 0,
    iterCapHit: input.iterCapHit === true,
    loopStopReason: input.loopStop?.reason ?? null,
    stallHeals: Number.isFinite(input.stallHeals) ? input.stallHeals : 0,
    errorStreak: Number.isFinite(input.errorStreak) ? input.errorStreak : 0,
    repeatStreak: Number.isFinite(input.repeatStreak) ? input.repeatStreak : 0,
  }
}
```

**(d)** 在 `turnStats.push({...})`（约 `:2386`）处新增字段：

```js
turnStats.push({
  usage, lastUsage, durationMs, model, ts, compactCount,
  // O2：本轮守卫状态（为什么停下来 / 有没有自愈过）
  guard: collectGuardState({
    hits: turnGuardHits, injections: guardInjectCount,
    iterCapHit, loopStop, stallHeals, errorStreak, repeatStreak,
  }),
})
```

- [ ] **Step 6: 运行测试确认通过**

```bash
node --test --test-timeout=120000 kernel-tests/turn-observability.test.mjs
```

Expected: PASS（4 个用例）。

- [ ] **Step 7: 跑内核测试 + 提交**

```bash
cd /c/Users/T203-15/yfworking
npm run test:kernel
```

Expected: 全绿（基线 **210** 个 `.test.mjs`，本任务新增 1 个 ⇒ 211）。

```bash
git add kernel/engine.mjs kernel-tests/turn-observability.test.mjs
git commit -m "feat(observe): S1 观测层 O1/O2 —— digest 带结果规模，turnStats 带守卫状态

- O1：turnToolDigest 增 size（工具结果字符长度；只存长度不存正文，
  保持 engine.mjs:1024-1025「不复制结果正文（体积与隐私）」约束）
- O2：turnStats 增 guard{hits,injections,iterCapHit,loopStopReason,stallHeals,errorStreak,repeatStreak}
  · 轮内累加器 turnGuardHits/guardInjectCount（守卫命中处只加登记，不改判定/文案/事件）
  · 守卫命名与批 2 的 KNOWN_GUARDS 对齐，便于守卫命中率横向对比
  · guard.injections 是主 spec §8.6 N1「停滞类注入每轮至多一条」的轮内判据（批 3 消费）
- 导出 collectGuardState 纯函数以便单测
- O3（模式 meta）阻塞于 S4，不在本批
- 纯增量：不改任何注入内容/提示词/wire 序列" 
```

---

## Task 2: S1+ —— 注入总账（O4）与只读分段计量

**Files:**
- Create: `kernel/inject-ledger.mjs`
- Modify: `kernel/knowledge-inject.mjs`（`getInjectStats` 返回值增字段，**只增不删**）
- Modify: `kernel/cli.mjs`（轮边界 `appendMeta('inject_snapshot', ...)`）
- Test: `kernel-tests/inject-ledger.test.mjs`

**Interfaces:**
- Consumes: `kernel/knowledge-inject.mjs` 的 `getInjectStats()` / `resetInjectStats()`（已存在）；`kernel/session.mjs` 的 `appendMeta`（已存在）。
- Produces:
  - `summarizeInjection({ turn, seq, segments, channels, ts }) → object`（规范化记录，供 `appendMeta`）
  - `buildSegmentMeters({ systemPromptBytes, toolSchemaBytes, skillBytes, injectedBytes }) → Array<{ id, bytes }>`
  - `ledgerTotals(records) → { totalBytes, bySegment: Record<string, number>, byChannel: Record<string, number> }`

### 背景（实现者必读）

spec 已核实：注入散在 **12 处**、留痕不齐（`guard_heal` 全文仅 5 处；`:949`/`:965`/`:973`/`:1105` 四处注入无留痕）、**注入无账**。本任务的产出是**账**，不是改注入行为。

**硬要求（逐字来自 spec O4）**：
1. 每轮 `appendMeta('inject_snapshot', ...)`，含**分段计量**与**渠道记账**（legacy / unified 各记 calls / hits / injectedChars）。
2. 计量**只取长度**，**不得重排提示词**。
3. **不删** `metrics.json` 既有 `inject`/`search` 段，sidecar 形状不变。
4. **不改** `build` 预算口径（字符→字节归 **Task 5**）。

- [ ] **Step 1: 先核实落点（只读，5 分钟）**

```bash
cd /c/Users/T203-15/yfworking
# ① 现有注入计量入口
grep -n "getInjectStats\|resetInjectStats\|persistMetrics" kernel/knowledge-inject.mjs
# ② cli.mjs 里轮边界与 appendMeta 用法
grep -n "onTurnEnd\|appendMeta" kernel/cli.mjs | head -20
# ③ 确认 sidecar 现有段名（不得改名/删除）
grep -n "inject\|search" kernel/knowledge-inject.mjs | head -20
```

Expected: 找到 `getInjectStats`/`resetInjectStats` 定义、`cli.mjs` 的 `appendMeta` 调用点、sidecar 段名。**记下实际行号**——本任务后续步骤引用的行号若与实测不符，以实测为准。

- [ ] **Step 2: 写失败测试**

`kernel-tests/inject-ledger.test.mjs`：

```js
// 注入总账（S1+ / O4）：只读计量 + 渠道记账，不改注入行为
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  summarizeInjection, buildSegmentMeters, ledgerTotals,
} from '../kernel/inject-ledger.mjs'

test('buildSegmentMeters 只取长度，输出固定段序', () => {
  const meters = buildSegmentMeters({
    systemPromptBytes: 1200, toolSchemaBytes: 3400,
    skillBytes: 900, injectedBytes: 150,
  })
  assert.deepEqual(meters, [
    { id: 'systemPrompt', bytes: 1200 },
    { id: 'toolSchema', bytes: 3400 },
    { id: 'skill', bytes: 900 },
    { id: 'injected', bytes: 150 },
  ])
})

test('buildSegmentMeters 缺失输入按 0 计，不抛错', () => {
  const meters = buildSegmentMeters({})
  assert.deepEqual(meters.map((m) => m.bytes), [0, 0, 0, 0])
})

test('buildSegmentMeters 接受非负数字字符串（env 口径宽容）', () => {
  const meters = buildSegmentMeters({ systemPromptBytes: '10' })
  assert.equal(meters[0].bytes, 10)
})

test('summarizeInjection 规范化：渠道缺省为 null 而非 0（区分未用与用了 0 条）', () => {
  const rec = summarizeInjection({ turn: 3, seq: 7, segments: [{ id: 'injected', bytes: 42 }] })
  assert.equal(rec.turn, 3)
  assert.equal(rec.seq, 7)
  assert.equal(rec.legacy, null)
  assert.equal(rec.unified, null)
  assert.equal(rec.totalBytes, 42)
})

test('summarizeInjection 透传渠道计数（calls/hits/injectedChars）', () => {
  const rec = summarizeInjection({
    turn: 1, seq: 1, segments: [{ id: 'injected', bytes: 5 }],
    channels: { legacy: { calls: 2, hits: 1, injectedChars: 300 } },
  })
  assert.deepEqual(rec.legacy, { calls: 2, hits: 1, injectedChars: 300 })
  assert.equal(rec.unified, null)
})

test('ledgerTotals 汇总分段与渠道', () => {
  const recs = [
    summarizeInjection({ turn: 1, seq: 1, segments: [{ id: 'injected', bytes: 10 }, { id: 'skill', bytes: 5 }], channels: { legacy: { calls: 1, hits: 1, injectedChars: 10 } } }),
    summarizeInjection({ turn: 2, seq: 2, segments: [{ id: 'injected', bytes: 20 }], channels: { legacy: { calls: 1, hits: 0, injectedChars: 0 } } }),
  ]
  const t = ledgerTotals(recs)
  assert.equal(t.totalBytes, 35)
  assert.equal(t.bySegment.injected, 30)
  assert.equal(t.bySegment.skill, 5)
  assert.equal(t.byChannel.legacy.calls, 2)
  assert.equal(t.byChannel.legacy.hits, 1)
})
```

- [ ] **Step 3: 运行测试确认失败**

```bash
node --test --test-timeout=120000 kernel-tests/inject-ledger.test.mjs
```

Expected: FAIL —— `Cannot find module '../kernel/inject-ledger.mjs'`。

- [ ] **Step 4: 写最小实现**

`kernel/inject-ledger.mjs`：

```js
// 注入总账（S1+ / O4）
// ---------------------------------------------------------------------------
// 目的：让每一次注入都有账——"注了什么、占了多少、走的是哪条渠道"。
// 硬约束（spec O4）：
//   ① 只取长度，不得重排提示词（本模块不持有提示词，只接收已算好的字节数）
//   ② 不删 metrics.json 既有 inject/search 段（本模块不写 metrics.json）
//   ③ 不改 build 预算口径（字符→字节换算归 S4.5 / Task 5）
// 纯函数、无 IO：便于单测与复用。

const SEGMENT_ORDER = ['systemPrompt', 'toolSchema', 'skill', 'injected']

const SEGMENT_KEYS = {
  systemPrompt: 'systemPromptBytes',
  toolSchema: 'toolSchemaBytes',
  skill: 'skillBytes',
  injected: 'injectedBytes',
}

/** 非负整数化：缺失/非数字按 0（env 口径宽容，不抛错） */
function n(v) {
  const x = Number(v)
  return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0
}

/**
 * 只读分段计量。固定段序，缺失按 0。
 * @returns {Array<{id: string, bytes: number}>}
 */
export function buildSegmentMeters(input) {
  const src = input || {}
  return SEGMENT_ORDER.map((id) => ({ id, bytes: n(src[SEGMENT_KEYS[id]]) }))
}

function normalizeChannel(ch) {
  if (!ch || typeof ch !== 'object') return null
  return {
    calls: n(ch.calls),
    hits: n(ch.hits),
    injectedChars: n(ch.injectedChars),
  }
}

/**
 * 规范化一条注入快照，供 appendMeta('inject_snapshot', ...) 使用。
 * 渠道缺省为 null（区分"未走该渠道"与"走了但 0 命中"）。
 */
export function summarizeInjection({ turn, seq, segments, channels, ts } = {}) {
  const segs = Array.isArray(segments) ? segments.map((s) => ({ id: String(s.id), bytes: n(s.bytes) })) : []
  const ch = channels || {}
  return {
    turn: Number.isFinite(turn) ? Math.floor(turn) : null,
    seq: Number.isFinite(seq) ? Math.floor(seq) : null,
    ts: Number.isFinite(ts) ? Math.floor(ts) : Date.now(),
    segments: segs,
    totalBytes: segs.reduce((a, s) => a + s.bytes, 0),
    legacy: normalizeChannel(ch.legacy),
    unified: normalizeChannel(ch.unified),
  }
}

/** 汇总多条快照（观察期统计用） */
export function ledgerTotals(records) {
  const bySegment = {}
  const byChannel = {}
  let totalBytes = 0
  for (const rec of records || []) {
    totalBytes += n(rec.totalBytes)
    for (const s of rec.segments || []) bySegment[s.id] = (bySegment[s.id] || 0) + n(s.bytes)
    for (const name of ['legacy', 'unified']) {
      const c = rec[name]
      if (!c) continue
      byChannel[name] = byChannel[name] || { calls: 0, hits: 0, injectedChars: 0 }
      byChannel[name].calls += c.calls
      byChannel[name].hits += c.hits
      byChannel[name].injectedChars += c.injectedChars
    }
  }
  return { totalBytes, bySegment, byChannel }
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
node --test --test-timeout=120000 kernel-tests/inject-ledger.test.mjs
```

Expected: PASS（6 个用例全绿）。

- [ ] **Step 6: 接渠道记账到 knowledge-inject（只增不删）**

在 `kernel/knowledge-inject.mjs` 的 `getInjectStats()` 返回值上**新增** `channels` 字段（保留全部既有字段）：

```js
// getInjectStats() 返回值新增（既有字段一个都不动）：
//   channels: {
//     legacy:  { calls, hits, injectedChars },   // 来自现有 graph.search 计数
//     unified: { calls, hits, injectedChars },   // unified 路径从未启用时恒为 0
//   }
```

**要求**：若现有实现里 legacy 的 calls/hits 已有变量，直接映射；`injectedChars` 若未统计，**新增累加但不改现有累加语义**。**不得**删除或改名任何既有字段。

> 参考：`resolveInjectMode`（`kernel/knowledge-inject.mjs` 约 `:52`）默认 `legacy`（unified 从未在生产启用）⇒ `unified` 渠道记账应如实为 0，**不要**造数。

- [ ] **Step 7: 写"只增不删"守护测试**

追加到 `kernel-tests/inject-ledger.test.mjs`：

```js
test('getInjectStats 保留既有字段且新增 channels（只增不删）', async () => {
  const mod = await import('../kernel/knowledge-inject.mjs')
  mod.resetInjectStats?.()
  const s = mod.getInjectStats()
  assert.equal(typeof s, 'object')
  assert.ok('channels' in s, 'channels 字段应存在')
  assert.ok(s.channels.legacy && s.channels.unified, 'legacy/unified 两条渠道都应存在')
})
```

- [ ] **Step 8: 运行测试**

```bash
node --test --test-timeout=120000 kernel-tests/inject-ledger.test.mjs
```

Expected: PASS（7 个用例）。

- [ ] **Step 9: 在 cli.mjs 轮边界落总账**

在 `cli.mjs` 的轮边界处（`loop.onTurnEnd` 或等价位置，Step 1 已定位实际行号）追加：

```js
// 注入总账（S1+ / O4）：每轮一条，只读计量
try {
  const stats = deps?.knowledge?.getInjectStats?.() || {}
  const segments = buildSegmentMeters({
    systemPromptBytes: stats.systemPromptBytes,
    toolSchemaBytes: stats.toolSchemaBytes,
    skillBytes: stats.skillBytes,
    injectedBytes: stats.injectedChars,
  })
  session.appendMeta('inject_snapshot', summarizeInjection({
    turn, seq: stats.seq, segments,
    channels: { legacy: stats.channels?.legacy, unified: stats.channels?.unified },
  }))
} catch { /* 记账失败绝不影响主流程 */ }
```

**要点**：
- `import { buildSegmentMeters, summarizeInjection } from './inject-ledger.mjs'`
- **必须** `try/catch` 吞掉记账异常——**账不能影响主流程**。
- `stats.*Bytes` 若上游暂无值，`buildSegmentMeters` 会按 0 计（不抛错）；**不要**为了填满而重组提示词（违反硬约束①）。

- [ ] **Step 10: 跑核心门禁**

```bash
cd /c/Users/T203-15/yfworking
npm run test:kernel
```

Expected: 212 个测试文件全绿（基线 **210** + Task 1 新增 1 + 本任务新增 1）。

```bash
npm run verify:experience-inject && npm run verify:milestones-start
```

Expected: 两者 EXIT=0（本任务不动经验注入契约与 milestone 解析）。

- [ ] **Step 11: 提交（按文件精确 add）**

```bash
cd /c/Users/T203-15/yfworking
git add kernel/inject-ledger.mjs kernel-tests/inject-ledger.test.mjs kernel/knowledge-inject.mjs kernel/cli.mjs
git commit -m "feat(inject): S1+ 注入总账（O4）—— 每轮 inject_snapshot + 只读分段计量

- 新建 kernel/inject-ledger.mjs（纯函数）：summarizeInjection/buildSegmentMeters/ledgerTotals
- knowledge-inject getInjectStats 增 channels（legacy/unified 各记 calls/hits/injectedChars），既有字段只增不删
- cli.mjs 轮边界 appendMeta('inject_snapshot')，try/catch 吞异常（记账不影响主流程）
- 硬约束：只取长度不重排提示词；不改 build 预算口径（字符→字节归 S4.5/Task 5）；metrics.json 段名不变
- 测试 7 例；注入散在 12 处且 4 处无留痕，本任务先立账不动行为"
```

---

## Task 3: S4.5① —— 去重：移除 `server/bridge.mjs` 两处常驻经验注入

**Files:**
- Modify: `server/bridge.mjs`（移除约 `:1609` / `:1647` 两处 `buildExperienceIndex(...)` **调用**）
- Test: `kernel-tests/experience-dedup.test.mjs`（新建）

**Interfaces:**
- Consumes: `buildExperienceIndex(maxBytes, theme?)`（`server/experience.mjs:161` 定义；`server/bridge.mjs:90-91` import + re-export）
- Produces: system 中经验相关内容**出现次数 2 → 1**

### 背景（实现者必读）

**问题**：`server/bridge.mjs` 有两处把经验索引拼进 prompt：

| 位置 | 现状 |
|---|---|
| `server/bridge.mjs:1609` | `resumePrompt += buildExperienceIndex(injectCfg.maxBytes)` |
| `server/bridge.mjs:1647` | `effectivePrompt += buildExperienceIndex(injectCfg.maxBytes)` |

⇒ 同一份经验索引在 system 里**出现两遍**。

**★★ 最关键的纪律（踩了就是事故）**：**只移除这两处「注入调用」**，**绝对不要**删除：
- `buildExperienceIndex` 的**函数定义**（`server/experience.mjs:161`）
- `server/bridge.mjs:90-91` 的 **import 与 re-export**

**原因**：以下三处都依赖它存在，删了会直接红：
1. `npm run verify:experience-inject`（断言 `buildExperienceIndex(4096)` 存在）
2. `server/experience.test.mjs`（`:133` / `:146` / `:154` / `:158` 四处测试）
3. Task 8 要改的面板口径（`server/experience.mjs:219` / `:223`）

- [ ] **Step 1: 核实两处调用的真实上下文（只读）**

```bash
cd /c/Users/T203-15/yfworking
grep -n "buildExperienceIndex" server/bridge.mjs server/experience.mjs
```

Expected: `server/bridge.mjs:90`（import）、`:91`（re-export）、`:1609`、`:1647`（两处调用）；`server/experience.mjs:161`（定义）。**读出 `:1609` 与 `:1647` 的整行**（含赋值目标变量名），下一步照原样处理。

- [ ] **Step 2: 写失败测试**

`kernel-tests/experience-dedup.test.mjs`：

```js
// S4.5① 去重：经验索引在 system 中只出现一次
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const BRIDGE = new URL('../server/bridge.mjs', import.meta.url)

test('server/bridge.mjs 不再有 buildExperienceIndex 的注入调用', () => {
  const src = readFileSync(BRIDGE, 'utf8')
  // 统计"非 import/export 行"里的调用次数：应为 0
  const callLines = src.split(/\r?\n/).filter((l) =>
    l.includes('buildExperienceIndex') && !/^\s*(import|export)/.test(l),
  )
  assert.deepEqual(callLines, [], `不应再有注入调用，实际: ${JSON.stringify(callLines)}`)
})

test('server/bridge.mjs 仍保留 import 与 re-export（供 verify:experience-inject 与测试使用）', () => {
  const src = readFileSync(BRIDGE, 'utf8')
  const importLines = src.split(/\r?\n/).filter((l) => /^\s*(import|export)/.test(l) && l.includes('buildExperienceIndex'))
  assert.ok(importLines.length >= 2, `import 与 re-export 都应保留，实际: ${JSON.stringify(importLines)}`)
})
```

- [ ] **Step 3: 运行测试确认失败**

```bash
node --test --test-timeout=120000 kernel-tests/experience-dedup.test.mjs
```

Expected: 第一个用例 **FAIL**（当前仍有 2 行调用）；第二个用例 PASS。

- [ ] **Step 4: 写最小实现（移除两处调用）**

**做法**：把 `:1609` 与 `:1647` 两行（含其换行与必要的拼接运算符）**整行删除**；若该行是 `x += buildExperienceIndex(...)` 形式且 `x` 是唯一用途，则**保留 `x` 变量的其它赋值路径不动**——**只删这一行**。

**示范**（行形状示意，实际以 Step 1 读到的为准）：

```js
// 删除前（server/bridge.mjs:1609 附近）
resumePrompt += buildExperienceIndex(injectCfg.maxBytes)

// 删除后：该行不存在（resumePrompt 的其它来源保持原样）


// 删除前（server/bridge.mjs:1647 附近）
effectivePrompt += buildExperienceIndex(injectCfg.maxBytes)

// 删除后：该行不存在（effectivePrompt 的其它来源保持原样）
```

**校验**：删完后**必须**确认 `injectCfg` 若仅被这两行使用，其定义**保持不变**（**不要去清理"未使用变量"**——那也是行为/改动范围之外）。

- [ ] **Step 5: 运行测试 + 关键门禁**

```bash
cd /c/Users/T203-15/yfworking
node --test --test-timeout=120000 kernel-tests/experience-dedup.test.mjs
npm run verify:experience-inject
npm run test:kernel
```

Expected: 去重测试 PASS；**`verify:experience-inject` EXIT=0**（若红，说明删过头了——检查是否误删定义或 re-export）；内核测试全绿。

- [ ] **Step 6: 提交**

```bash
cd /c/Users/T203-15/yfworking
git add server/bridge.mjs kernel-tests/experience-dedup.test.mjs
git commit -m "fix(experience): S4.5① 去重 —— 移除 server/bridge.mjs 两处常驻经验注入

- 移除 :1609/:1647 两处 buildExperienceIndex(...) 注入调用 ⇒ system 中出现次数 2→1
- ★ 只删调用，保留函数定义（server/experience.mjs:161）与 import/re-export（server/bridge.mjs:90-91）：
  verify:experience-inject、server/experience.test.mjs 四处测试、面板口径（Task 8）都依赖它存在
- 不清扫\"未使用变量\"（超出改动范围）
- 新增测试：调用数=0 且 import/re-export 仍存
- 零行为变更（仅去重）"
```

---

## Task 4: S4.5② —— 内核注入侧尊重 `active`（A16）

**Files:**
- Modify: `kernel/memory.mjs`（`buildMemoryIndex` 约 `:99`、`buildRelevantMemory` 约 `:140`）
- Test: `kernel-tests/experience-dedup.test.mjs`（追加）

**Interfaces:**
- Consumes: `readTheme(root, theme) → { front, entries }`（`kernel/memory.mjs`，`front.active` 由 `:87-89` 写入）
- Produces: `buildMemoryIndex(...)` / `buildRelevantMemory(...)` 跳过 `front.active === 'false'` 的主题

### 背景（实现者必读）—— 这是本批**最关键的事实修正**

spec（增量 §4.1）旧表述写的是「`memory.mjs` 补 `front.active`」。**逐行核实后：这个表述不准确**：

| 环节 | 实测状态 |
|---|---|
| **写入侧** | ✅ **已实现**：`kernel/memory.mjs:87-89` 写 `{ name: theme, description: theme, active: true }`；`server/experience.mjs:37` 同 |
| **服务端读取侧** | ✅ **已生效**：`server/experience.mjs:101`（`active: data.front.active !== 'false'`）、`:115`、`:131`、`:163`（`.filter(x => x.active && ...)`）、`:217` |
| **内核注入侧** | ❌ **漏判（真实缺口）**：`kernel/memory.mjs:99 buildMemoryIndex` 在 `:105` 只解构 `const { entries } = readTheme(root, theme)`，**从不读 `front.active`**；`:140 buildRelevantMemory` 同样不读 |

⇒ **后果（A16）**：用户在图谱 GUI 里停用主题 T 后，**服务端不注入 T，但内核仍会注入 T** —— 停用形同虚设。

⇒ **本任务的正确目标**：让**内核的两个注入函数尊重 `active`**，**不是**"补写入 active"。

- [ ] **Step 1: 核实缺口（只读，确认我的结论）**

```bash
cd /c/Users/T203-15/yfworking
grep -n "active" kernel/memory.mjs server/experience.mjs | head -20
grep -n "const { entries } = readTheme\|const { front\b\|readTheme(" kernel/memory.mjs | head -20
```

Expected: 看到写入侧（`kernel/memory.mjs:87-89`）、服务端过滤（`server/experience.mjs:101/115/131/163`）、内核侧 `:105` 只取 `entries` 的证据。**若实测与上表不符，以实测为准并改写本任务**。

- [ ] **Step 2: 写失败测试**

追加到 `kernel-tests/experience-dedup.test.mjs`：

```js
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildMemoryIndex } from '../kernel/memory.mjs'

/** 造一个含 active:true / active:false 两个主题的记忆根目录 */
function mkMemoryRoot() {
  const root = mkdtempSync(join(tmpdir(), 'mem-active-'))
  for (const [theme, active] of [['启用主题', 'true'], ['停用主题', 'false']]) {
    const dir = join(root, theme)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.md'), '内容A\n', 'utf8')
    writeFileSync(join(dir, '_front.md'), `name: ${theme}\ndescription: ${theme}\nactive: ${active}\n`, 'utf8')
  }
  return root
}

test('buildMemoryIndex 跳过 active:false 的主题（A16）', () => {
  const root = mkMemoryRoot()
  const out = buildMemoryIndex({ root, keywords: ['', '启用', '停用'] })
  const text = typeof out === 'string' ? out : JSON.stringify(out)
  assert.ok(text.includes('启用主题'), '启用主题应被注入')
  assert.ok(!text.includes('停用主题'), '停用主题不应被注入')
})
```

> ⚠️ `buildMemoryIndex` 的**实际签名**必须先在 Step 1 读出来（本测试的参数形状需与之对齐）。若签名不同，**改测试以匹配真实签名**，但**断言意图不变**（停用主题不得出现）。

- [ ] **Step 3: 运行测试确认失败**

```bash
node --test --test-timeout=120000 kernel-tests/experience-dedup.test.mjs
```

Expected: FAIL —— 输出中**仍含** `停用主题`（复现 A16 的漏判）。

- [ ] **Step 4: 实现（内核侧尊重 active）**

在 `kernel/memory.mjs` 的**两个**注入函数中，改为同时取 `front` 并跳过停用主题：

```js
// buildMemoryIndex（约 :99，原：const { entries } = readTheme(root, theme)）
const { front, entries } = readTheme(root, theme)
// A16：内核侧也尊重 active（此前只读 entries，导致停用主题仍被注入）
if (front && String(front.active) === 'false') continue   // 若在循环内
```

并在 `buildRelevantMemory`（约 `:140`）做**同样的**判断。

**实现要点**：
- 判定语义与服务端**保持一致**：`server/experience.mjs:101` 用的是 `data.front.active !== 'false'` ⇒ 内核侧用**同一口径** `String(front.active) === 'false'` 视为停用（**不要**改成 `!front.active`——那会把 `undefined` 也判成停用，与现状不兼容）。
- 若函数是"先收集后渲染"结构，`continue` 替换为等价的过滤（如 `.filter(...)`）。
- **不改** `readTheme`（它已返回 `front`）。

- [ ] **Step 5: 运行测试确认通过 + 门禁**

```bash
cd /c/Users/T203-15/yfworking
node --test --test-timeout=120000 kernel-tests/experience-dedup.test.mjs
npm run test:kernel
```

Expected: PASS；内核测试全绿（**A16** 达成）。

- [ ] **Step 6: 提交**

```bash
cd /c/Users/T203-15/yfworking
git add kernel/memory.mjs kernel-tests/experience-dedup.test.mjs
git commit -m "fix(memory): S4.5② 内核注入侧尊重 front.active（A16）

- 事实修正：active 的写入侧（kernel/memory.mjs:87-89）与服务端读取侧
  （server/experience.mjs:101/115/131/163）**早已实现**，真实缺口在内核注入侧——
  buildMemoryIndex(:99，:105 只解构 entries) 与 buildRelevantMemory(:140) 从不读 front.active
  ⇒ 图谱停用主题后服务端不注入、内核仍注入，停用形同虚设
- 修复：两个函数同时取 front，按 String(front.active)==='false' 跳过
  （口径与服务端 data.front.active !== 'false' 一致；不改成 !front.active 以免 undefined 判成停用）
- 新增测试：停用主题不得出现在注入文本中（复现→修复）
- 不改 readTheme（已返回 front）"
```

---

## Task 5: S4.5③ —— 字节口径统一（字符 → 字节，唯一归属本步）

**Files:**
- Modify: `kernel/memory.mjs`（经验注入的预算记账）
- Test: `kernel-tests/experience-dedup.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 4 的 `active` 过滤；`kernel/memory.mjs` 现有预算参数
- Produces: 经验类注入的计量**一律 `Buffer.byteLength(..., 'utf8')`**；EL0 主题清单 **~200 B**

### 背景（实现者必读）

**唯一性纪律**：**字符 → 字节的换算只在本步做**。S1+（Task 2）**明确不做**（`buildSegmentMeters` 只接收已算好的字节数）——**不要回头改 Task 2**。

**为什么必须统一**：混用 `.length`（UTF-16 码元数）与 `Buffer.byteLength`（UTF-8 字节）会**系统性低估中文**（1 汉字 = 1 `.length` 但 3 字节）⇒ 预算按"字符"批、实际按"字节"发，超发 3 倍。

**目标（注入 spec §4.2）**：

| 指标 | 现状 | 目标 |
|---|---|---|
| 经验常驻字节 | `5131 × 2 = 10262 B` | EL0 ~200 B + EL1 ≤1536 B |

⇒ **−8526 B/轮**。

- [ ] **Step 1: 找出所有按字符计量的地方（只读）**

```bash
cd /c/Users/T203-15/yfworking
grep -n "\.length" kernel/memory.mjs | head -30
grep -n "maxBytes\|budget" kernel/memory.mjs | head -20
```

Expected: 列出经验注入里所有 `.length` 计量点与预算变量名。

- [ ] **Step 2: 写失败测试**

追加到 `kernel-tests/experience-dedup.test.mjs`：

```js
import { memoryBytes } from '../kernel/memory.mjs'

test('memoryBytes 按 UTF-8 字节计（中文不得被当成 1 字节）', () => {
  assert.equal(memoryBytes('abc'), 3)
  assert.equal(memoryBytes('中文'), 6, '2 个汉字 = 6 字节（非 2）')
  assert.equal(memoryBytes('中a'), 4)
})

test('memoryBytes 与 Buffer.byteLength 一致（单一真源）', () => {
  for (const s of ['', 'a', '中文', 'emoji🙂']) {
    assert.equal(memoryBytes(s), Buffer.byteLength(s, 'utf8'))
  }
})
```

> 若 `kernel/memory.mjs` 已有等价工具函数，**复用它**并把测试改为断言该函数；**不要**另造第二个换算函数（单一口径）。

- [ ] **Step 3: 运行测试确认失败**

```bash
node --test --test-timeout=120000 kernel-tests/experience-dedup.test.mjs
```

Expected: FAIL —— `memoryBytes is not a function`（或未导出）。

- [ ] **Step 4: 实现统一口径**

在 `kernel/memory.mjs` 新增并导出（若已有同类函数则改为复用）：

```js
/**
 * 经验注入的唯一字节口径（S4.5③：字符→字节换算只在此处）。
 * 用 UTF-8 字节而非 String.length —— 后者对中文系统性低估 3 倍。
 */
export function memoryBytes(s) {
  return Buffer.byteLength(String(s ?? ''), 'utf8')
}
```

并把经验注入中**所有** `.length` 计量替换为 `memoryBytes(...)`。

- [ ] **Step 5: 运行测试确认通过 + 提交**

```bash
cd /c/Users/T203-15/yfworking
node --test --test-timeout=120000 kernel-tests/experience-dedup.test.mjs
npm run test:kernel
git add kernel/memory.mjs kernel-tests/experience-dedup.test.mjs
git commit -m "fix(memory): S4.5③ 字节口径统一 —— 字符→字节换算唯一归属本步

- 新增并导出 memoryBytes（Buffer.byteLength utf8）；替换经验注入中所有 .length 计量
- 理由：.length 是 UTF-16 码元数，对中文低估 3 倍 ⇒ 预算按字符批、按字节发会超发
- 目标：经验常驻 10262 B → EL0 ~200 B + EL1 ≤1536 B（−8526 B/轮）
- 唯一性纪律：S1+（Task 2）明确不做换算，此处不做回头改
- 单一真源：若已有同类工具函数则复用，不另造第二个换算函数"
```

---

## Task 6: S4.5④ —— 新增 EL1 线索层 `kernel/knowledge-recommend.mjs`（R1–R6）

**Files:**
- Create: `kernel/knowledge-recommend.mjs`
- Test: `kernel-tests/knowledge-recommend.test.mjs`

**Interfaces:**
- Consumes: `searchKnowledgeItems`（`kernel/knowledge-search.mjs:18`）；`makeSnippet`（既有）；`INJECT_RELATED_TOPN`（既有，值 **3**）
- Produces:
  - `buildRecommendSection(items, opts) → { text: string, lines: Array, offered: string[], bytes: number }`
  - `HYDRATE_EL1_MAX_BYTES = 1536`、`EL1_SNIPPET_MAX = 300`
  - `renderRecommendLine(item, opts) → string | null`

### 背景（实现者必读）—— R1–R6 是**渲染契约**，逐字来自注入 spec §3.2.1

| # | 约束 | 依据（原文） |
|---|---|---|
| **R1** | **禁止全文升级**：`upgraded` 恒 `false`，不注入 `full` | `expandRelated` 原文："把正文预装进来等于让'展开一跳'变成'再注入一遍全文'" |
| **R2** | **每行必带 `blockId`**：无线索凭据的行不渲染 | 无 blockId ⇒ 无法 `related` 展开（`isBlockId` 形状校验会拒） |
| **R3** | **摘要走 `makeSnippet`**（默认 160，线索层可放宽至 **300**） | `searchKnowledge` 既有用法；行字节可控 |
| **R4** | **预载一跳锚点 ≤ `INJECT_RELATED_TOPN`(3)**，按 `why.kind` 打理由，**剔除 `duplicate`** | `anchorTextOf` 既有口径（duplicate 是去重提示，不是阅读路径，且会诱导重读） |
| **R5** | **可读性据实分支**（`readableSpaces` 三态）；未授权空间**只给** `related` / `mode:'full'` | `fullTextHint` 与 `expandRelated` 的既有 P3 修复（"无权限的指引必须写明替代路径"） |
| **R6** | **预算按字节记账**，装不下**丢弃整行**（不截断行内正文），**首条无条件放入** | `renderRecall` 既有纪律（"预算必须按实际装入的字节记账"/"首条无条件放入"） |

**硬上限**：EL1 ≤ **1536 B**（1.5 KB）。
**观察期**：默认 `OBSERVE_ONLY` ⇒ **不真注入**（Task 7 接线时生效）。

- [ ] **Step 1: 核实既有工具的真实签名（只读）**

```bash
cd /c/Users/T203-15/yfworking
grep -n "export function searchKnowledgeItems\|export async function searchKnowledgeItems" kernel/knowledge-search.mjs
grep -n "makeSnippet\|isBlockId\|anchorTextOf\|INJECT_RELATED_TOPN\|readableSpaces" kernel/*.mjs | head -20
```

Expected: 读出 `searchKnowledgeItems` 的参数与返回形状、`makeSnippet` 签名、`INJECT_RELATED_TOPN` 的值（应为 3）、`readableSpaces` 的三态定义。**以实测为准**，据此调整下方实现。

- [ ] **Step 2: 写失败测试**

`kernel-tests/knowledge-recommend.test.mjs`：

```js
// EL1 线索层（S4.5④）：R1–R6 六条渲染契约 + 边界
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRecommendSection, HYDRATE_EL1_MAX_BYTES, EL1_SNIPPET_MAX,
} from '../kernel/knowledge-recommend.mjs'

const item = (over = {}) => ({
  blockId: 'experience/workflow.md#1',
  space: 'experience',
  title: '注入总线',
  snippet: '把散在 12 处的注入收敛到一条总线',
  related: [],
  ...over,
})

test('R1：永不升级全文（upgraded 恒 false，且不含全文标记）', () => {
  const r = buildRecommendSection([item({ full: '整篇正文……' })], { budgetBytes: HYDRATE_EL1_MAX_BYTES })
  assert.equal(r.upgraded, false)
  assert.ok(!r.text.includes('整篇正文'), 'R1：不得注入正文')
  assert.ok(!r.text.includes(' ·全文'), 'R1：不得出现全文升级标记')
})

test('R2：无线索凭据（blockId）的行不渲染', () => {
  const r = buildRecommendSection([item({ blockId: '' }), item()], { budgetBytes: HYDRATE_EL1_MAX_BYTES })
  assert.equal(r.lines.length, 1, '仅含 blockId 的那条渲染')
})

test('R3：摘要走 makeSnippet，且不超过 EL1_SNIPPET_MAX(300)', () => {
  assert.equal(EL1_SNIPPET_MAX, 300)
  const long = 'x'.repeat(2000)
  const r = buildRecommendSection([item({ snippet: long })], { budgetBytes: HYDRATE_EL1_MAX_BYTES })
  const lineLen = r.lines[0].snippet.length
  assert.ok(lineLen <= EL1_SNIPPET_MAX, `摘要应 ≤300，实际 ${lineLen}`)
})

test('R4：一跳锚点 ≤3 且剔除 duplicate', () => {
  const related = [
    { blockId: 'a#1', why: { kind: 'same-space' } },
    { blockId: 'b#2', why: { kind: 'duplicate' } },
    { blockId: 'c#3', why: { kind: 'keyword' } },
    { blockId: 'd#4', why: { kind: 'keyword' } },
    { blockId: 'e#5', why: { kind: 'keyword' } },
  ]
  const r = buildRecommendSection([item({ related })], { budgetBytes: HYDRATE_EL1_MAX_BYTES })
  assert.equal(r.lines[0].related.length, 3, 'R4：最多 3 个锚点')
  assert.ok(!r.lines[0].related.some((x) => x.blockId === 'b#2'), 'R4：必须剔除 duplicate')
})

test('R5：未授权空间只给 related / mode:full 的替代路径', () => {
  const r = buildRecommendSection(
    [item({ space: 'secret', readable: false })],
    { budgetBytes: HYDRATE_EL1_MAX_BYTES, readableSpaces: [] },
  )
  assert.ok(r.lines[0].hint.includes("related") || r.lines[0].hint.includes('full'), 'R5：须写明替代路径')
})

test('R6：预算按字节记账，装不下丢弃整行（不截断行内正文），首条无条件放入', () => {
  const many = Array.from({ length: 20 }, (_, i) => item({ blockId: `s#${i}`, title: `标题${i}` }))
  const r = buildRecommendSection(many, { budgetBytes: 200 })
  assert.ok(r.bytes <= 200, `字节数不得超预算，实际 ${r.bytes}`)
  assert.equal(r.lines.length, 1, '预算极小 ⇒ 只剩首条（首条无条件放入）')
  assert.ok(r.dropped > 0, '应记录被丢弃的行数')
})

test('R6：首条即使超预算也放入（无条件）', () => {
  const huge = item({ title: 'x'.repeat(500), snippet: 'y'.repeat(300) })
  const r = buildRecommendSection([huge], { budgetBytes: 10 })
  assert.equal(r.lines.length, 1)
})

test('related 为空时不渲染展开指引（降级）', () => {
  const r = buildRecommendSection([item({ related: [] })], { budgetBytes: HYDRATE_EL1_MAX_BYTES })
  assert.ok(!r.text.includes('展开'), '无锚点则不给展开动作')
})

test('offered 返回 blockId 列表（供观察期采纳率统计）', () => {
  const r = buildRecommendSection([item()], { budgetBytes: HYDRATE_EL1_MAX_BYTES })
  assert.deepEqual(r.offered, ['experience/workflow.md#1'])
})

test('空输入返回空段（不抛错）', () => {
  const r = buildRecommendSection([], { budgetBytes: HYDRATE_EL1_MAX_BYTES })
  assert.equal(r.text, '')
  assert.equal(r.lines.length, 0)
  assert.equal(r.bytes, 0)
})
```

- [ ] **Step 3: 运行测试确认失败**

```bash
node --test --test-timeout=120000 kernel-tests/knowledge-recommend.test.mjs
```

Expected: FAIL —— `Cannot find module '../kernel/knowledge-recommend.mjs'`。

- [ ] **Step 4: 实现 `kernel/knowledge-recommend.mjs`**

```js
// EL1 线索层（S4.5④）
// ---------------------------------------------------------------------------
// 目的：经验供给从"预装全文"改为"只发索引线索"——agent 自主决定读不读、读哪条。
// 供给形态（D2）：**只发索引线索，不含正文**；支持扩展线索阅读。
//
// 渲染契约 R1–R6（注入 spec §3.2.1，逐条对应下方实现注释）：
//   R1 upgraded 恒 false，不注入 full
//   R2 每行必带 blockId
//   R3 摘要走 makeSnippet（线索层放宽至 300）
//   R4 一跳锚点 ≤ INJECT_RELATED_TOPN(3)，剔除 duplicate
//   R5 可读性据实分支；未授权空间只给 related / mode:'full'
//   R6 预算按字节记账，装不下丢整行，首条无条件放入

export const HYDRATE_EL1_MAX_BYTES = 1536   // EL1 硬上限 1.5 KB
export const EL1_SNIPPET_MAX = 300          // 线索层摘要上限（默认 160 放宽至此）

const RELATE_TOPN = 3                       // = INJECT_RELATED_TOPN

/** 摘要化：优先复用既有 makeSnippet 口径；此处按 EL1_SNIPPET_MAX 截断 */
function snippetOf(text, max = EL1_SNIPPET_MAX) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

const bytes = (s) => Buffer.byteLength(String(s), 'utf8')

/**
 * 渲染一行线索。R2：无线索凭据（blockId）返回 null（不渲染）。
 */
export function renderRecommendLine(item, opts = {}) {
  if (!item || !item.blockId) return null           // R2
  const snippet = snippetOf(item.snippet ?? item.title)
  const related = (item.related || [])
    .filter((r) => r?.why?.kind !== 'duplicate')    // R4：剔除 duplicate
    .slice(0, RELATE_TOPN)                          // R4：≤3
  // R5：未授权空间只给替代路径
  const unreadable = item.readable === false || (opts.readableSpaces && !opts.readableSpaces.includes(item.space))
  const hint = unreadable
    ? `（无读取权限：用 KnowledgeSearch {related:'${item.blockId}'} 或 {mode:'full'} 获取）`
    : (related.length ? `（展开：KnowledgeSearch {related:'${item.blockId}'}）` : '')
  return {
    blockId: item.blockId,
    space: item.space,
    snippet,
    related,
    hint,
    text: `- [${item.space}] ${item.title} —— ${snippet} ${hint}`.trim(),  // R1：不含正文
  }
}

/**
 * 构建 EL1 线索段。
 * R6：按字节记账；装不下丢整行；首条无条件放入。
 */
export function buildRecommendSection(items, opts = {}) {
  const budget = Number.isFinite(opts.budgetBytes) ? opts.budgetBytes : HYDRATE_EL1_MAX_BYTES
  const lines = []
  const offered = []
  let used = 0
  let dropped = 0
  for (const it of items || []) {
    const line = renderRecommendLine(it, opts)
    if (!line) continue                                // R2
    const b = bytes(line.text)
    if (lines.length > 0 && used + b > budget) { dropped++; continue }   // R6
    used += b
    lines.push(line)
    offered.push(line.blockId)
  }
  return {
    lines,
    offered,
    dropped,
    bytes: used,
    upgraded: false,                                   // R1：恒定
    text: lines.length ? `【线索】\n${lines.map((l) => l.text).join('\n')}` : '',
  }
}
```

> **实现纪律**：`renderRecommendLine` 与 `buildRecommendSection` 必须**复用**既有 `makeSnippet` / `isBlockId` / `anchorTextOf`（Step 1 已核实签名）——若既有函数语义与上方的本地实现不同，**以既有函数为准**并调整测试期望。

- [ ] **Step 5: 运行测试确认通过**

```bash
node --test --test-timeout=120000 kernel-tests/knowledge-recommend.test.mjs
```

Expected: PASS（12 个用例）。

- [ ] **Step 6: 提交**

```bash
cd /c/Users/T203-15/yfworking
git add kernel/knowledge-recommend.mjs kernel-tests/knowledge-recommend.test.mjs
git commit -m "feat(knowledge): S4.5④ EL1 线索层 —— 只发索引线索，不含正文

- 新建 kernel/knowledge-recommend.mjs：buildRecommendSection / renderRecommendLine
- 渲染契约 R1-R6 逐条实现：
  R1 upgraded 恒 false 不注入 full（预装正文=让\"展开一跳\"变成\"再注入一遍全文\"）
  R2 无线索凭据（blockId）的行不渲染；R3 摘要走 makeSnippet 且 ≤300
  R4 一跳锚点 ≤INJECT_RELATED_TOPN(3) 且剔除 duplicate；R5 未授权空间只给 related/mode:full
  R6 预算按字节记账、装不下丢整行、首条无条件放入
- HYDRATE_EL1_MAX_BYTES=1536（EL1 ≤1.5KB）；offered 供观察期采纳率统计
- 单测 12 例覆盖 R1-R6 + 首条无条件 + 丢整行 + related 为空降级
- 不改检索口径（评分/过滤/topK 一字不动）"
```

---

## Task 7: S4.5⑤⑥ —— `beforeIter` 接线 + 观察期分名 + EL1↔unified 互斥（A18/A20）

**Files:**
- Modify: `kernel/cli.mjs`（`beforeIter` 相位接线；推荐集合登记 `offered` / `offeredDryRun`）
- Test: `kernel-tests/knowledge-recommend.test.mjs`（追加接线与互斥用例）

**Interfaces:**
- Consumes: `buildRecommendSection`（Task 6）；`knowledgeRelateMode`（`kernel/knowledge.mjs:566` 定义 `'on'`（缺省）\|`'off'`；`:585` 从 `<configDir>/config.json` 读）；`resolveInjectMode`（`kernel/knowledge-inject.mjs`）
- Produces: EL1 在 `strategy=legacy` 时生效、`unified` 时关闭；观察期 `offeredDryRun` 与转正后 `offered` **分名**

### 背景（实现者必读）

**⑤ 接线**：EL1 走通道④（`beforeIter` 派生注入）。同时**登记推荐集合**：
- 观察期（默认 `OBSERVE_ONLY`）：登记为 **`offeredDryRun`**（**不真注入**）
- 转正后：登记为 **`offered`**

**⑥ 互斥（A20）**：EL1 线索层与 unified 抽调层（`renderRecall`）做的是**同一件事的两种渲染**。若同时启用 ⇒ **同一批知识块注入两遍**（本次评估 P0「双注入」的新版本）。故：

| `strategy` | 知识供给方 | EL1 |
|---|---|---|
| `legacy`（当前生产） | 无抽调层（legacy `recallSection` 恒空） | ✅ **生效**（补上 legacy 缺失的供给） |
| `unified`（灰度后） | `renderRecall` 抽调层 | ❌ **关闭**（避免双供给） |

**前置（A18）**：`knowledgeRelateMode === 'on'`（`kernel/knowledge.mjs:566`）。

- [ ] **Step 1: 核实开关与接线点（只读）**

```bash
cd /c/Users/T203-15/yfworking
grep -n "knowledgeRelateMode" kernel/knowledge.mjs | head
grep -n "beforeIter\|offered\|OBSERVE_ONLY" kernel/cli.mjs kernel/*.mjs | head -20
grep -n "resolveInjectMode" kernel/knowledge-inject.mjs
```

Expected: 确认 `knowledgeRelateMode` 的读取方式（`config.json`）、`beforeIter` 相位的既有接线位置、`OBSERVE_ONLY` 是否已有开关。**以实测为准**。

- [ ] **Step 2: 写失败测试**

追加到 `kernel-tests/knowledge-recommend.test.mjs`：

```js
import { shouldInjectEl1 } from '../kernel/knowledge-recommend.mjs'

test('A20：strategy=legacy 时 EL1 生效；unified 时关闭（互斥）', () => {
  assert.equal(shouldInjectEl1({ strategy: 'legacy', relateMode: 'on', enabled: true }), true)
  assert.equal(shouldInjectEl1({ strategy: 'unified', relateMode: 'on', enabled: true }), false)
})

test('A18：前置 knowledgeRelateMode === on（off 时不注入）', () => {
  assert.equal(shouldInjectEl1({ strategy: 'legacy', relateMode: 'off', enabled: true }), false)
})

test('逃生阀：PONOS_MEMORY_EL1=0 时关闭（与 PONOS_MEMORY_INJECT 不耦合）', () => {
  assert.equal(shouldInjectEl1({ strategy: 'legacy', relateMode: 'on', enabled: false }), false)
})

test('观察期：offeredDryRun 计数，不真注入', () => {
  const r = buildRecommendSection([{ blockId: 'x#1', space: 's', title: 't', snippet: 's', related: [] }], { budgetBytes: 1536, dryRun: true })
  assert.equal(r.dryRun, true)
  assert.ok(Array.isArray(r.offered))
  assert.equal(r.text, '', 'dryRun 不产生可注入文本')
})
```

- [ ] **Step 3: 运行测试确认失败**

```bash
node --test --test-timeout=120000 kernel-tests/knowledge-recommend.test.mjs
```

Expected: FAIL —— `shouldInjectEl1 is not a function`；`dryRun` 未支持。

- [ ] **Step 4: 实现互斥判据 + dryRun**

在 `kernel/knowledge-recommend.mjs` 追加：

```js
/**
 * EL1 是否生效（A18 前置 + A20 互斥 + 逃生阀）。
 * 纯函数：便于单测，不读全局状态。
 */
export function shouldInjectEl1({ strategy, relateMode, enabled } = {}) {
  if (enabled !== true) return false                 // 逃生阀 PONOS_MEMORY_EL1=0
  if (relateMode !== 'on') return false              // A18 前置
  return strategy !== 'unified'                      // A20：unified 关闭 EL1，避免双供给
}
```

并在 `buildRecommendSection` 支持 `opts.dryRun`：

```js
  // 观察期（OBSERVE_ONLY）：登记 offered，但不产生可注入文本
  if (opts.dryRun === true) {
    return { lines, offered, dropped, bytes: used, upgraded: false, dryRun: true, text: '' }
  }
```

- [ ] **Step 5: 在 `kernel/cli.mjs` 接线**

```js
// beforeIter 相位：EL1 线索层（S4.5⑤）
const el1On = shouldInjectEl1({
  strategy: mode,                                   // resolveInjectMode(...) 的结果
  relateMode: knowledgeRelateMode,                   // 来自 config.json
  enabled: process.env.PONOS_MEMORY_EL1 !== '0',     // D6：唯一逃生阀
})
if (el1On) {
  const rec = buildRecommendSection(hits, {
    budgetBytes: HYDRATE_EL1_MAX_BYTES,
    readableSpaces,
    dryRun: OBSERVE_ONLY,                            // 观察期默认 true
  })
  if (OBSERVE_ONLY) {
    session.appendMeta('inject_recommend_dryrun', { offered: rec.offered, bytes: rec.bytes })
  } else {
    // 真注入（转正后）；登记为 offered 供采纳率统计
    emitIterDerived(rec.text)
    session.appendMeta('inject_recommend', { offered: rec.offered, bytes: rec.bytes })
  }
}
```

**要点**：
- **`offeredDryRun` 与 `offered` 必须分名**（混用会让观察期数据污染采纳率口径）。
- 观察期**不注入**（`rec.text === ''`）。
- `emitIterDerived` 只是示意名——**按现有 `beforeIter` 注入机制的实际 API 替换**（Step 1 已核实）。

- [ ] **Step 6: 运行测试 + 门禁**

```bash
cd /c/Users/T203-15/yfworking
node --test --test-timeout=120000 kernel-tests/knowledge-recommend.test.mjs
npm run test:kernel
npm run verify:experience-inject
```

Expected: 全绿。

- [ ] **Step 7: 提交**

```bash
cd /c/Users/T203-15/yfworking
git add kernel/cli.mjs kernel/knowledge-recommend.mjs kernel-tests/knowledge-recommend.test.mjs
git commit -m "feat(knowledge): S4.5⑤⑥ EL1 接线 + 观察期分名 + 与 unified 互斥（A18/A20）

- shouldInjectEl1 纯函数：A18 前置 relateMode==='on' + A20 interlock + 逃生阀 PONOS_MEMORY_EL1=0
  （D6：不与 PONOS_MEMORY_INJECT 耦合）
- A20 互斥：strategy=legacy → EL1 生效（补 legacy 缺失的供给）；unified → 关闭
  （避免同一批知识块被 renderRecall 与 EL1 注入两遍 —— 评估 P0「双注入」的新版本）
- cli.mjs beforeIter 相位接线；观察期 OBSERVE_ONLY 默认 → 登记 inject_recommend_dryrun 且不注入
  转正后登记 inject_recommend（offered/offeredDryRun 分名，防污染采纳率口径）
- buildRecommendSection 支持 dryRun（text 恒空）"
```

---

## Task 8: S4.5⑦ —— GUI 面板口径同步（`server/experience.mjs`）

**Files:**
- Modify: `server/experience.mjs`（约 `:219` 单主题 `inject_bytes`、`:223` `totalInjectBytes`）
- Test: `kernel-tests/experience-dedup.test.mjs`（追加）

**Interfaces:**
- Consumes: `buildExperienceIndex(4096, theme)`（`server/experience.mjs:161` 定义）
- Produces: 面板显示字节与实际注入口径一致（三层化后）

### 背景（实现者必读）

三层化后，**实际注入的不再是 `buildExperienceIndex` 的全量文本**（那是旧的 5131 B/主题）。若面板仍用它算字节：

| 位置 | 现状 | 后果 |
|---|---|---|
| `server/experience.mjs:219` | `inject_bytes: buildExperienceIndex(4096, item.theme).length` | 高估（且用 `.length` 而非字节） |
| `server/experience.mjs:223` | `const totalInjectBytes = buildExperienceIndex(4096).length` | 同上 |

⇒ **面板数字与实际注入不符**，用户会以为"还在注入 10 KB"。

- [ ] **Step 1: 核实两处（只读）**

```bash
cd /c/Users/T203-15/yfworking
sed -n '215,226p' server/experience.mjs
grep -n "inject_bytes\|totalInjectBytes" server/experience.mjs
```

Expected: 读出 `:219` / `:223` 的整行，确认字段名与赋值方式。

- [ ] **Step 2: 写失败测试**

追加到 `kernel-tests/experience-dedup.test.mjs`：

```js
import { readFileSync } from 'node:fs'

test('S4.5⑦：面板字节口径改用字节计量（不再用 .length 直接算）', () => {
  const src = readFileSync(new URL('../server/experience.mjs', import.meta.url), 'utf8')
  assert.ok(!/buildExperienceIndex\(4096[^)]*\)\.length/.test(src),
    '不应再用 .length 直接算面板字节（改用统一字节口径）')
})
```

- [ ] **Step 3: 运行测试确认失败**

```bash
node --test --test-timeout=120000 kernel-tests/experience-dedup.test.mjs
```

Expected: FAIL（当前仍有 `.length` 直接计量）。

- [ ] **Step 4: 实现口径同步**

把两处改为**三层化后的真实口径**（EL0 ~200 B + 命中时的 EL1）：

```js
// :219 单主题
inject_bytes: experienceInjectBytes(item.theme),   // 按 EL0(+EL1) 实际口径，且用字节而非 .length

// :223 合计
const totalInjectBytes = experienceInjectBytes()
```

其中 `experienceInjectBytes` 是**本文件内的小工具**（或复用 `kernel/memory.mjs` 的 `memoryBytes`）：

```js
/** 经验注入的实际字节口径（三层化：EL0 恒在 + EL1 命中） */
function experienceInjectBytes(theme) {
  // 用统一的字节口径（与 kernel/memory.mjs 的 memoryBytes 同源）
  return Buffer.byteLength(buildExperienceIndex(4096, theme) ?? '', 'utf8')
}
```

> ⚠️ **本步只做"口径同步"**：若三层化的 EL0 渲染在 `server/` 侧另有一份实现，**复用它**；若没有，就先用 `buildExperienceIndex` 的结果 + 字节口径（**诚实反映现状**，不编造更小的数字）。**不要**为了"数字好看"而硬编码 200。

- [ ] **Step 5: 运行测试 + 门禁 + 提交**

```bash
cd /c/Users/T203-15/yfworking
node --test --test-timeout=120000 kernel-tests/experience-dedup.test.mjs
npm run test:kernel
npm run verify:experience-inject
```

Expected: 全绿；`verify:experience-inject` EXIT=0（**本步最易踩**——若红，检查是否误删 `buildExperienceIndex`）。

```bash
git add server/experience.mjs kernel-tests/experience-dedup.test.mjs
git commit -m "fix(experience): S4.5⑦ GUI 面板字节口径同步（三层化后）

- server/experience.mjs:219/:223 改用统一字节口径（Buffer.byteLength），
  不再用 buildExperienceIndex(...).length 直接计量（.length 是 UTF-16 码元数，对中文低估 3 倍）
- 新增本文件内 experienceInjectBytes 工具（与 kernel/memory.mjs 的 memoryBytes 同源）
- 目的：面板数字与实际注入一致，避免用户误以为\"还在注入 10KB\"
- 纪律：不硬编码数字；三层化若无 server 侧实现则先用 buildExperienceIndex+字节口径诚实反映现状
- verify:experience-inject 必须仍绿"
```

---

## 交付前总门禁（批 1 全部完成后执行）

```bash
cd /c/Users/T203-15/yfworking
npm run test:kernel                                      # 214 文件全绿（基线 210 + 本批新增 4）
npm run kit:check                                        # EXIT=0
node --test --test-timeout=120000 "kit/**/*.test.mjs"     # ★ 引号必须有，否则静默漏测
npm run verify:ci                                        # EXIT=0
npm run verify:experience-inject                         # ★ 本批最易踩
npm run verify:milestones-start                          # milestone 解析契约未破
git status --short                                       # 确认没有夹带他人在途改动
```

**新增测试文件 4 个**：`turn-observability`（Task 1）、`inject-ledger`（Task 2）、`experience-dedup`（Task 3，Task 4/5/8 追加用例）、`knowledge-recommend`（Task 6，Task 7 追加用例）。⇒ 期望总数 **214**（基线 210 + 4，以实测为准；若差值不为 +4，逐一核对原因——最可能是 Task 4/5/7/8 误建成了新文件而非追加）。

## 评审时的汇报清单（批 1 完成后）

| 项 | 要报什么 |
|---|---|
| 观测层 | `turnToolDigest.size` / `turnStats.guard` 的真实样例（连续 2–3 轮） |
| 注入总账 | `inject_snapshot` 记账样例（连续 3 轮）；legacy 渠道非空；unified 如实为 0 |
| 去重收益 | 经验常驻字节 **实测前后对比**（目标 10262 B → ≤1736 B，−8526 B/轮） |
| A16 | 停用主题后内核 EL0/EL1 均不含该主题的证明 |
| R1–R6 | 六条渲染契约的对照测试结果；EL1 实测字节（≤1536） |
| A20 | `strategy=legacy` 有线索段 / `unified` 无线索段的对照结果 |
| 观察期 | `inject_recommend_dryrun` 记账存在且 `text` 为空（未真注入） |
| 意外发现 | 实施中发现的 bug（**只记录不修**）清单 |

## Self-Review

**1. Spec coverage**

| spec 要求 | 落在哪 |
|---|---|
| S1 O1（`turnToolDigest.size`） | Task 1 Step 4 |
| S1 O2（`turnStats.guard`） | Task 1 Step 5 |
| S1 O3（模式 meta） | **不在本批**（阻塞于 S4，已在「范围与非范围」写明） |
| S1+ O4 每轮 `appendMeta('inject_snapshot')` | Task 2 Step 9 |
| S1+ 只读分段计量（只取长度、不重组） | Task 2 Step 4 + Step 9 要点 |
| S1+ 渠道记账（legacy/unified） | Task 2 Step 6 + Step 7 守护测试 |
| S1+ 不删 `metrics.json` 段 | Global Constraints + Task 2 Step 7 |
| S1+ 不改 `build` 预算口径 | Global Constraints（明确归 Task 5） |
| S4.5① 去重（2→1，**只删调用**） | Task 3 |
| S4.5② 内核侧尊重 `active`（A16） | Task 4 |
| S4.5③ 字节口径统一（唯一归属本步） | Task 5 |
| S4.5④ `knowledge-recommend.mjs` + R1–R6 | Task 6 |
| S4.5⑤ `beforeIter` 接线 + `offered`/`offeredDryRun` | Task 7 |
| S4.5⑥ EL1↔unified 互斥（A20） | Task 7 |
| S4.5⑦ 面板口径同步 | Task 8 |
| A18 前置 `knowledgeRelateMode==='on'` | Task 7 Step 2/4 |
| A14 EL0 ≤512 B / EL1 无线索正文 / 逃生阀 | Global Constraints + Task 6 + Task 7 |
| 「不改检索口径」 | Global Constraints + Task 6 提交说明 |

**2. Placeholder scan**

- 无 "TBD"/"TODO"/"implement later"。
- **Task 1 Step 5(b) 的守卫登记表**给出的是"守卫 → 登记语句"的**映射表**而非 `/* 照搬 */`——因为每处只需插入一行 `turnGuardHits.add(...)`，不含可争议逻辑。**这是完整规格**。
- **Task 3 Step 4 / Task 4 Step 1 / Task 5 Step 1 / Task 7 Step 1 / Task 8 Step 4** 都要求先读实际代码再改，并给出**改动后的目标形状**与**判定语义**；这是"行号会漂移"的诚实处理，**不是占位符**。
- **Task 2 Step 6** 的 `channels` 是"字段形状 + 映射要求"，因为它必须接到既有变量上（Step 1 已要求先核实变量名）。
- ⚠️ 已明确标注 **Task 6 Step 4 的本地实现可能需以既有 `makeSnippet`/`isBlockId`/`anchorTextOf` 为准调整**——这是防"另造一套口径"，非留白。

**3. Type consistency**

- `summarizeInjection` / `buildSegmentMeters` / `ledgerTotals` —— Task 2 定义并同任务使用，一致。
- `collectGuardState(input) → {hits,injections,iterCapHit,loopStopReason,stallHeals,errorStreak,repeatStreak}` —— Task 1 定义，`turnStats.guard` 使用；**字段名与批 2 `loop-profile.mjs` 的 `KNOWN_GUARDS` 对齐**（跨计划一致性）。
- `memoryBytes(s)` —— Task 5 定义；Task 8 的 `experienceInjectBytes` 说明"同源"，避免第二套换算。
- `buildRecommendSection(items, opts) → {lines, offered, dropped, bytes, upgraded, dryRun?, text}` —— Task 6 定义，Task 7 使用（**新增 `dryRun` 字段**，已在 Task 7 Step 4 明确）。
- `shouldInjectEl1({strategy,relateMode,enabled})` —— Task 7 定义并使用，一致。
- `HYDRATE_EL1_MAX_BYTES=1536` / `EL1_SNIPPET_MAX=300` —— Task 6 定义，测试与 Task 7 使用，一致。
- **已修正的两处**：
  1. spec 增量 §4.1 写「`bridge.mjs` 两处」与「`memory.mjs` 补 `front.active`」——实测分别是 **`server/bridge.mjs`** 与 **"内核侧漏判 `active`（写入侧早已实现）"**，已在 Task 3/Task 4 的"背景"里以**事实修正**形式写明，并同步修进主 spec §12.1。
  2. 测试基线原写作 212 → **实测 210**，全篇已改。

**4. 批次边界自审（批 1 / 批 2）**

- 本批**不含** `inject-bus.mjs`、`emitInjection` 的字段扩展、守卫序参数化 —— 全在批 2。
- 本批**含** `inject-ledger.mjs`（O4 总账）—— 它与批 2 的注入总线**不是同一物**：总账负责"记账与只读计量"，总线负责"排队与渲染"。**两者互不依赖**，可并行落地。
- 交界面唯一：批 2 的 L4 等价锁可能消费本批 `turnStats.guard`。已在批 2 计划写明降级方案。
- 测试文件数账：基线 **210** → 本批 **+4 = 214**；批 2 另 **+4**（`inject-bus`/`loop-core-contract`/`loop-guard-order-equivalence`/`loop-lane-profile`）= 214。**两批都落地后总数应为 218**（以实测为准，用于发现"重复计数/漏建文件/误建新文件"）。
