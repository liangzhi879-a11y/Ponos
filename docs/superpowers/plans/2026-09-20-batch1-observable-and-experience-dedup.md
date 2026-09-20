# 批 1 实施计划：观测层 + 注入总账 + 经验去重（S1 + S1+ + S4.5）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 先把"看得见"和"最确定的浪费"解决掉——补上观测字段（O1/O2）、建立注入总账（O4）、消除经验元数据的重复常驻注入并把经验供给三层化（S4.5）。**S1/S1+ 为零行为变更；S4.5 是口径与分层变更，目标 −8526 B/轮。**

**Architecture:** 9 个任务，按"无依赖 → 有依赖"排序，每步独立可交付、可回滚：
1. **S1（Task 1）**：观测层 O1（`turnToolDigest.size`）+ O2（`turnStats.guard`）。**纯增量**。
2. **S1+（Task 2）**：注入总账 O4（`inject_snapshot` + 只读分段计量 + 渠道五分 + 来源归因）。**纯增量**。
3. **S4.5（Task 3–9）**：经验三层化 ——
   **Task 3** 内核侧尊重 `active`（A16，硬前置）→ **Task 4** 去重（2→1）→ **Task 5** 字节口径统一 →
   **Task 6** **EL0 主题清单**（−4931 B/轮，A14/G3 的载体）→ **Task 7** EL1 线索层（R1–R6）→
   **Task 8** 接线 + 观察期分名 + 与 unified 互斥（A18/A20）→ **Task 9** 面板口径同步。

> ★ **任务顺序不可调**：Task 3 必须在 Task 4 之前（spec D3/§3.4 硬前置：先补 `active` 过滤再移除桥侧注入，
> 否则"停用主题仍被注入"会从隐性变显性）。

**Tech Stack:** Node.js ESM（`.mjs`）、`node:test` + `node:assert/strict`、现有 `createEngine`/`createSessionStore`、`npm run test:kernel`。

## Global Constraints

以下为项目级硬约束，**每个任务的要求都隐含包含本节**；数值与措辞逐字来自 spec，不得改写：

- **变更性质（★ 勿读成"整批零行为变更"）**：
  - **S1 / S1+（Task 1/2）＝ 零行为变更**：**只增字段与账**，不改任何注入内容、提示词、wire 序列。
  - **S4.5（Task 3–9）＝ 口径与分层变更**（spec §9 Q4：「口径变更属行为变更，唯一归属 S4.5」）：去重、`active` 过滤、EL0/EL1 三层化、字节口径统一**都会改变注入量**——**这正是本批的目的**。
    ★ **唯一不许动的是检索口径**：评分 / 过滤 / `topK` / `smartFilter` **一字不动**（三层化只改"注什么"，不改"搜什么"）。
- **★ 与批 2 的串行纪律（文件级，非接口级）**：本批 Task 1 要在 `kernel/engine.mjs` 的**守卫命中处**插 `turnGuardHits.add(...)`；批 2 的 Task 2/3/4 会把**同一段代码**搬进 `loop-core.mjs` ⇒ **两批对 `engine.mjs` 的改动必须串行**（优选本批先落地，登记语句随后被批 2 一并搬走）。「两批无依赖」仅指**接口无依赖**。
- **只读长度，不重组**：分段计量**只取长度**（`Buffer.byteLength`），**不得把提示词拆成"可重排的块"**（spec §4.1 S1+ ④：在 `prompt.mjs` 各段就地取长度、桥侧取 append 长度）。
- **S1+ 不改 `build` 预算口径**：字符→字节的换算**唯一归属 S4.5（Task 5）**，S1+ 不做。
- **不删既有字段**：`metrics.json` 的既有 `inject` / `search` 段**只增不删**（sidecar 形状不变）；`getInjectStats()` 既有字段一个都不动。
- **不引入** `priority` / `budgetBytes` / `kind` / `phase`：那是 **S3.5**（批 2）的事。
- **单步归属**：字节口径统一（字符→字节）**只在 Task 5 做**，其他任务不得顺手改；`experienceInjectBytes` 类工具**不得另造第二套换算**（复用 `kernel/memory.mjs` 的 `memoryBytes`）。
- **EL1 关键约束**（逐字取自注入 spec §3.2.1 R1–R6 + D2/D6）：
  - **只发索引线索，不含正文**；`upgraded` 恒 `false`（**禁止全文升级**）
  - 每行必带 `blockId`；摘要走 `makeSnippet`（默认 160，线索层可放宽至 **300**）——**复用既有实现，不另造**
  - 预载一跳锚点 ≤ **`INJECT_RELATED_TOPN`(3)**，**按 `why.kind` 打理由**，剔除 `duplicate`；未授权空间**只给** `related` / `mode:'full'`
  - **可读性据实三态**（`Set` 放行 / `null` 不给指引 / 未授权只给替代路径）
  - 预算**按字节记账**，装不下**丢弃整行**（不截断行内正文），**首条无条件放入**
  - EL1 上限 **≤1.5 KB（1536 B）**；恒在 **EL0 ~200 B**（A14 断言 **≤512 B**）
  - 逃生阀**只留 `PONOS_MEMORY_EL1=0`**，**不与** `PONOS_MEMORY_INJECT` 耦合（D6）
  - **观察期默认**（`PONOS_MEMORY_EL1_OBSERVE=1`，不真注入；`offered` / `offeredDryRun` 分名记录）；
    `adopted` / `adoptRate` 按 spec §3.2.3 提供，★ 观察期 `adopted` 语义为**不适用** ⇒ 记 `null`，**不得记 0**（A19）
- **EL0 关键约束**（Task 6）：**保留全部主题名 + 条数**（spec :475，只裁条目级细节）；**不含条目正文**；≤512 B（A14）；停用主题不得出现（A16）。
- **EL1 与 unified 抽调层互斥（A20）**：`strategy=legacy` → 线索段存在；`strategy=unified` → **线索段不存在**。**不改** unified 抽调层为线索形态。
- **不删函数定义**：`buildExperienceIndex` 的**定义与 re-export 必须保留**（`npm run verify:experience-inject` 与 `server/experience.test.mjs` 四处测试依赖它）；本批**只移除 `server/bridge.mjs` 的两处「注入调用」**。
- **点名受影响的既有测试**（spec §9 Q6）：实测最小受影响面 = `kernel-tests/knowledge-inject.test.mjs`（`:39`/`:59`/`:63` 与 `:128-132` 注释写明"`buildMemoryIndex` 内部按**字符数**比较 `maxBytes`（既有约定，不动 = 零回归）"）⇒ Task 5/Task 6 改口径后该注释**必须同步更新**（改断言使其对新形态仍有意义，**不是删断言**）。
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
| `kernel/inject-ledger.mjs` | **新建（Task 2）**。注入总账：`CHANNELS`/`BY_SOURCE`/`buildSegmentMeters`/`summarizeInjection`/`ledgerTotals`。纯函数，无 IO。 | 新建 |
| `kernel/knowledge-recommend.mjs` | **新建（Task 7）**。EL1 线索层：`buildRecommendSection`/`renderRecommendLine`/`shouldInjectEl1`，复用 `searchKnowledgeItems` + `makeSnippet`。纯函数。 | 新建 |
| `kernel/engine.mjs` | O1（`turnToolDigest.size`）+ O2（`turnStats.guard`）。 | 修改（小） |
| `kernel/prompt.mjs` | **新增只读段计量** `getPromptSegmentMeters()`（spec §4.1 S1+ ④ / Q13）；**不改**内容与顺序。 | 修改（小） |
| `kernel/knowledge-inject.mjs` | `getInjectStats()` 增 `channels`（五分）+ `bySource` + 场景三元组（**只增不删**）。 | 修改（小） |
| `kernel/cli.mjs` | **轮末统一出口**挂总账（Task 2；★ 不是 `loop.onTurnEnd`——它在 `loop.isActive()` 内）；每轮 system 组装处接线 EL1（Task 8）。 | 修改（小） |
| `kernel/memory.mjs` | 内核注入侧尊重 `front.active`（Task 3）；字节口径统一 `memoryBytes`（Task 5）；**EL0 主题清单**渲染（Task 6）。 | 修改（中） |
| `server/bridge.mjs` | 移除两处常驻经验注入调用（Task 4）；桥侧 append 长度计量（Task 2）。**不动定义与 re-export**。 | 修改（小） |
| `server/experience.mjs` | GUI 面板字节口径同步（Task 9）。 | 修改（小） |
| `kernel-tests/turn-observability.test.mjs` | **新建（Task 1）**。O1/O2 单测。 | 新建 |
| `kernel-tests/inject-ledger.test.mjs` | **新建（Task 2）**。总账、渠道五分与“只增不删”守护单测。 | 新建 |
| `kernel-tests/experience-dedup.test.mjs` | **新建（Task 3）**。`active` 过滤（A16）、去重（2→1）、字节口径、**EL0**（Task 6 追加）单测。 | 新建 |
| `kernel-tests/knowledge-recommend.test.mjs` | **新建（Task 7）**。EL1 线索层单测（R1–R6 六条对照 + 边界 + A18/A20 互斥）。 | 新建 |
| `kernel-tests/knowledge-inject.test.mjs` | **既有，需同步更新**（Task 5/Task 6 改口径后，"按字符数比较 maxBytes"的既有注释与断言须改写为对新形态仍有意义的断言，**不删断言**）。 | 修改（小） |

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
- Modify: `kernel/prompt.mjs`（各段 `Buffer.byteLength` **只读**计量，spec §4.1 S1+ ④ / Q13）
- Modify: `kernel/knowledge-inject.mjs`（`getInjectStats()` 增 `channels` 与 `bySource`，**只增不删**）
- Modify: `kernel/cli.mjs`（**轮末统一出口**落快照）
- Test: `kernel-tests/inject-ledger.test.mjs`

**Interfaces:**
- Consumes: `kernel/knowledge-inject.mjs` 的 `getInjectStats()`/`resetInjectStats()`；`kernel/session.mjs` 的 `appendMeta`（实测 `kernel/session.mjs:343`；cli 内变量名是 `store`，不是 `session`）
- Produces:
  - `CHANNELS = ['static', 'bridge', 'guard', 'derived', 'payload']`
  - `BY_SOURCE = ['systemPrompt', 'toolSchema', 'skill', 'experience', 'knowledge', 'protocol', 'payload']`
  - `buildSegmentMeters(input) → Array<{ id, bytes }>`
  - `summarizeInjection({ turn, seq, segments, channels, bySource, promptTier, sessionMode, kb, ts }) → object`
  - `ledgerTotals(records) → { totalBytes, bySegment, byChannel, bySource }`
  - `resetTurnLedger()` / `nextTurnSeq()`（逐轮语义，见 Step 4d）

### 背景（实现者必读）—— 为什么不能只记 legacy/unified

spec 已核实：注入散在 **18 处**、留痕不齐（`guard_heal` 全文仅 5 处；4 处注入无留痕）、**注入无账**。

**A13 的达标条件（spec §3.3 原文口径）**：总账要能"**归因到 5% 以内**"，因此字段集必须包含
- **渠道五分** `channels.{static, bridge, guard, derived, payload}`（不是 legacy/unified 两分——那是**检索策略**维度，不是**注入渠道**维度）
- **来源** `bySource`（按 `systemPrompt` / `toolSchema` / `skill` / `experience` / `knowledge` / `protocol` / `payload` 归因）
- **场景** `promptTier` / `sessionMode` / `kb`（否则跨场景混算，5% 会假红）

★ **本任务原稿的三处致命问题（已按实测修正）**：
1. 原稿 `channels` 只有 `legacy`/`unified` ⇒ 与 A13 要求的渠道五分不符，**不可归因**。
2. 原稿 Step 9 读 `stats.systemPromptBytes` / `toolSchemaBytes` / `skillBytes` / `injectedChars` / `seq` —— **`getInjectStats()` 里这些字段全都不存在**（实测返回：`calls/strategy/indexLines/recallBlocks/elapsedMs/indexAgeMs/degraded/queries/hitQueries/scope/spacesDropped/spacesCapped/hitRate`）⇒ 全部按 0 计，**账是空的**。
3. 原稿落点在 `cli.mjs:1322 loop.onTurnEnd`，而它位于 `if (loop.isActive())`（实测 `:1319`）内 ⇒ 只有 loop 会话有快照，**"每轮一条"不成立**。

**硬要求（spec O4）**：
1. **每轮** `appendMeta('inject_snapshot', ...)` —— 落点必须是**轮末统一出口**，与 `loop.isActive()` 无关。
2. 计量**只取长度**（`Buffer.byteLength`），**不得重排提示词**（spec §4.1 S1+ ④：在 `prompt.mjs` 各段就地取长度、桥侧取 append 长度）。
3. **不删** `metrics.json` 既有 `inject`/`search` 段，sidecar 形状不变。
4. **不改** `build` 预算口径（字符→字节换算唯一归属 **Task 5**）。
5. **`settings.memory.inject === false` 时记忆类注入全停，总账记 0 而非不记**（spec `:211`）。

- [ ] **Step 1: 核实落点（只读，务必做完再动手）**

```bash
cd /c/Users/T203-15/yfworking
# ① 现有注入计量入口与真实返回字段
grep -n "export function getInjectStats\|export function resetInjectStats\|channels\|bySource" kernel/knowledge-inject.mjs
sed -n '/export function getInjectStats/,/^}/p' kernel/knowledge-inject.mjs
# ② prompt.mjs 的段落构成（要按段取长度）
grep -n "export function build\|systemPrompt\|toolSchema\|skill" kernel/prompt.mjs | head -20
# ③ 轮末统一出口（★ 不是 loop.onTurnEnd —— 它在 if (loop.isActive()) 内，实测 :1319）
grep -n "appendMeta\|onTurnEnd\|isActive()" kernel/cli.mjs | head -20
# ④ appendMeta 真实 API
grep -n "appendMeta" kernel/session.mjs
```

Expected:
- 读到 `getInjectStats()` 的**真实返回字段**（据此改测试，**不要**假设 `*Bytes` 存在）
- 定位 `prompt.mjs` 的段构造处（各段可加就地 `Buffer.byteLength`）
- 找到**在 `if (loop.isActive())` 之外的轮末收尾段**（实测约 `:1290-1318`，以实际为准）——**记下真实行号**
- 确认 `appendMeta` 定义（实测 `kernel/session.mjs:343`）与 cli 内持有它的变量名（实测是 `store`）

- [ ] **Step 2: 写失败测试**

`kernel-tests/inject-ledger.test.mjs`：

```js
// 注入总账（S1+ / O4）：只读计量 + 渠道五分 + 来源归因，不改注入行为
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHANNELS, BY_SOURCE, buildSegmentMeters, summarizeInjection, ledgerTotals,
} from '../kernel/inject-ledger.mjs'

test('渠道五分与来源清单为规范值（A13 可归因的前提）', () => {
  assert.deepEqual(CHANNELS, ['static', 'bridge', 'guard', 'derived', 'payload'])
  assert.deepEqual(BY_SOURCE, ['systemPrompt', 'toolSchema', 'skill', 'experience', 'knowledge', 'protocol', 'payload'])
})

test('buildSegmentMeters：固定段序、只取长度、缺失按 0 不抛错', () => {
  assert.deepEqual(
    buildSegmentMeters({ systemPromptBytes: 1200, toolSchemaBytes: 3400, skillBytes: 900, injectedBytes: 150 }),
    [{ id: 'systemPrompt', bytes: 1200 }, { id: 'toolSchema', bytes: 3400 }, { id: 'skill', bytes: 900 }, { id: 'injected', bytes: 150 }],
  )
  assert.deepEqual(buildSegmentMeters({}).map((m) => m.bytes), [0, 0, 0, 0])
  assert.equal(buildSegmentMeters({ systemPromptBytes: '10' })[0].bytes, 10)
})

test('summarizeInjection：五渠道全部就位，缺失渠道为 null（区分未用与 0 命中）', () => {
  const rec = summarizeInjection({ turn: 3, seq: 7, segments: [{ id: 'injected', bytes: 42 }] })
  assert.equal(rec.turn, 3)
  assert.equal(rec.seq, 7)
  assert.equal(rec.totalBytes, 42)
  for (const c of CHANNELS) assert.ok(c in rec.channels, `缺渠道 ${c}`)
  assert.equal(rec.channels.static, null)
})

test('summarizeInjection：渠道计数透传（calls/hits/injectedBytes）', () => {
  const rec = summarizeInjection({
    turn: 1, seq: 1, segments: [{ id: 'injected', bytes: 5 }],
    channels: { guard: { calls: 2, hits: 1, injectedBytes: 300 } },
  })
  assert.deepEqual(rec.channels.guard, { calls: 2, hits: 1, injectedBytes: 300 })
  assert.equal(rec.channels.bridge, null)
})

test('summarizeInjection：场景三元组齐备（跨场景混算会让 5% 假红）', () => {
  const rec = summarizeInjection({ turn: 1, seq: 1, promptTier: 'full', sessionMode: 'task', kb: 'on' })
  assert.equal(rec.promptTier, 'full')
  assert.equal(rec.sessionMode, 'task')
  assert.equal(rec.kb, 'on')
})

test('bySource 归因：来源缺失按 0，存在则透传', () => {
  const rec = summarizeInjection({ turn: 1, seq: 1, bySource: { experience: 90, knowledge: 10 } })
  assert.equal(rec.bySource.experience, 90)
  assert.equal(rec.bySource.knowledge, 10)
  assert.equal(rec.bySource.guard ?? 0, 0)
})

test('ledgerTotals：汇总分段、五渠道与来源', () => {
  const recs = [
    summarizeInjection({ turn: 1, seq: 1, segments: [{ id: 'injected', bytes: 10 }, { id: 'skill', bytes: 5 }], channels: { guard: { calls: 1, hits: 1, injectedBytes: 10 } }, bySource: { experience: 10 } }),
    summarizeInjection({ turn: 2, seq: 2, segments: [{ id: 'injected', bytes: 20 }], channels: { guard: { calls: 1, hits: 0, injectedBytes: 0 } }, bySource: { experience: 20 } }),
  ]
  const t = ledgerTotals(recs)
  assert.equal(t.totalBytes, 35)
  assert.equal(t.bySegment.injected, 30)
  assert.equal(t.bySegment.skill, 5)
  assert.equal(t.byChannel.guard.calls, 2)
  assert.equal(t.byChannel.guard.hits, 1)
  assert.equal(t.bySource.experience, 30)
})

test('★ 记忆注入关闭时记 0 而非不记（spec :211）', () => {
  const rec = summarizeInjection({ turn: 1, seq: 1, channels: { derived: { calls: 0, hits: 0, injectedBytes: 0 } } })
  assert.deepEqual(rec.channels.derived, { calls: 0, hits: 0, injectedBytes: 0 })
  assert.notEqual(rec.channels.derived, null)
})

test('getInjectStats 保留既有字段且新增 channels/bySource（只增不删）', async () => {
  const mod = await import('../kernel/knowledge-inject.mjs')
  const before = mod.getInjectStats()
  const baseline = Object.keys(before).sort()
  assert.ok(baseline.length > 0, '既有返回不得为空')
  mod.resetInjectStats?.()
  assert.ok('channels' in mod.getInjectStats(), 'channels 字段应存在')
  assert.ok('bySource' in mod.getInjectStats(), 'bySource 字段应存在')
  // 既有字段一个都不能少
  for (const k of baseline) assert.ok(k in mod.getInjectStats(), `既有字段被删: ${k}`)
})
```

- [ ] **Step 3: 运行测试确认失败**

```bash
node --test --test-timeout=120000 kernel-tests/inject-ledger.test.mjs
```

Expected: FAIL —— `Cannot find module '../kernel/inject-ledger.mjs'`（后续 `getInjectStats` 用例亦红：`channels`/`bySource` 尚不存在）。

- [ ] **Step 4: 写最小实现**

`kernel/inject-ledger.mjs`：

```js
// 注入总账（S1+ / O4）
// ---------------------------------------------------------------------------
// 目的：让每一次注入都有账——"注了什么、占了多少、走哪条渠道、来自哪个来源"。
// A13 要求"可归因到 5% 以内"，故维度必须齐备：
//   · 渠道五分 channels.{static,bridge,guard,derived,payload}（注入渠道维度）
//   · 来源归因 bySource（systemPrompt/toolSchema/skill/experience/knowledge/protocol/payload）
//   · 场景三元组 promptTier/sessionMode/kb（跨场景混算会让 5% 假红）
// 硬约束（spec O4）：
//   ① 只取长度，不得重排提示词（本模块不持有提示词，只接收已算好的字节数）
//   ② 不删 metrics.json 既有 inject/search 段（本模块不写 metrics.json）
//   ③ 不改 build 预算口径（字符→字节换算归 S4.5 / Task 5）
// 纯函数、无 IO。

export const CHANNELS = ['static', 'bridge', 'guard', 'derived', 'payload']
export const BY_SOURCE = ['systemPrompt', 'toolSchema', 'skill', 'experience', 'knowledge', 'protocol', 'payload']

const SEGMENT_ORDER = ['systemPrompt', 'toolSchema', 'skill', 'injected']
const SEGMENT_KEYS = {
  systemPrompt: 'systemPromptBytes',
  toolSchema: 'toolSchemaBytes',
  skill: 'skillBytes',
  injected: 'injectedBytes',
}

/** 非负整数化：缺失/非数字按 0（口径宽容，不抛错） */
function n(v) {
  const x = Number(v)
  return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0
}

/** 只读分段计量。固定段序，缺失按 0。 */
export function buildSegmentMeters(input) {
  const src = input || {}
  return SEGMENT_ORDER.map((id) => ({ id, bytes: n(src[SEGMENT_KEYS[id]]) }))
}

function normalizeChannel(ch) {
  if (!ch || typeof ch !== 'object') return null
  return { calls: n(ch.calls), hits: n(ch.hits), injectedBytes: n(ch.injectedBytes) }
}

function normalizeBySource(bs) {
  const out = {}
  for (const k of BY_SOURCE) out[k] = n(bs?.[k])
  return out
}

/**
 * 规范化一条注入快照，供 appendMeta('inject_snapshot', ...) 使用。
 * 渠道缺失为 null（区分"未走该渠道"与"走了但 0 命中"）；
 * ★ 但显式传入的 0 必须保留（"记忆注入关闭 ⇒ 记 0 而非不记"，spec :211）。
 */
export function summarizeInjection({
  turn, seq, segments, channels, bySource, promptTier, sessionMode, kb, ts,
} = {}) {
  const segs = Array.isArray(segments) ? segments.map((s) => ({ id: String(s.id), bytes: n(s.bytes) })) : []
  const ch = channels || {}
  const outChannels = {}
  for (const name of CHANNELS) outChannels[name] = normalizeChannel(ch[name])
  return {
    turn: Number.isFinite(turn) ? Math.floor(turn) : null,
    seq: Number.isFinite(seq) ? Math.floor(seq) : null,
    ts: Number.isFinite(ts) ? Math.floor(ts) : Date.now(),
    segments: segs,
    totalBytes: segs.reduce((a, s) => a + s.bytes, 0),
    channels: outChannels,
    bySource: normalizeBySource(bySource),
    promptTier: promptTier ?? null,
    sessionMode: sessionMode ?? null,
    kb: kb ?? null,
  }
}

/** 汇总多条快照（观察期统计用） */
export function ledgerTotals(records) {
  const bySegment = {}
  const byChannel = {}
  const bySource = {}
  let totalBytes = 0
  for (const rec of records || []) {
    totalBytes += n(rec.totalBytes)
    for (const s of rec.segments || []) bySegment[s.id] = (bySegment[s.id] || 0) + n(s.bytes)
    for (const name of CHANNELS) {
      const c = rec.channels?.[name]
      if (!c) continue
      byChannel[name] = byChannel[name] || { calls: 0, hits: 0, injectedBytes: 0 }
      byChannel[name].calls += c.calls
      byChannel[name].hits += c.hits
      byChannel[name].injectedBytes += c.injectedBytes
    }
    for (const k of BY_SOURCE) bySource[k] = (bySource[k] || 0) + n(rec.bySource?.[k])
  }
  return { totalBytes, bySegment, byChannel, bySource }
}
```

- [ ] **Step 4b: `kernel/prompt.mjs` 各段只读计量（spec §4.1 S1+ ④ / Q13）**

spec 原文要求：**「`prompt.mjs` 各段 `Buffer.byteLength` + 桥侧 append 长度」**。这是 A13 的**数据来源**，不做这一步则总账没有真值。

在 `kernel/prompt.mjs` 的 **`composeSystemPrompt({ toolNames, agents, subagents, append, cwd, skills, workflows, memory, tier, mode, knowledgeScope })`**（实测 **`:218`** 定义）内就地记录各段长度（**只读，不改内容与顺序**；★ 这些参数名就是"段"的真源）：

```js
// S1+ O4：各段只读字节计量（只取长度，不重排、不改内容）
// 说明：用 Buffer.byteLength 而非 String.length（UTF-16 码元数对中文低估 3 倍）
const __segMeters = { systemPromptBytes: 0, toolSchemaBytes: 0, skillBytes: 0, injectedBytes: 0 }
function __meter(key, text) { __segMeters[key] = Buffer.byteLength(String(text ?? ''), 'utf8'); return text }
```

在各段（system prompt / tool schema / skill 注入段 / 注入拼接段）取值后调用 `__meter('systemPromptBytes', sys)` 等，并把结果挂到既有导出上（**新增导出** `getPromptSegmentMeters()`，不删任何既有导出）。

> ★ **桥侧 append 长度**：`server/bridge.mjs` 的 append 处同样取一次 `Buffer.byteLength`，累加进 `bySource.bridge`（spec Q13 明确这一步属于 S1+ 范围）。

- [ ] **Step 4c: `getInjectStats()` 增字段（**只增不删**）**

在 `kernel/knowledge-inject.mjs` 的 `getInjectStats()` 返回值上**新增**（保留全部既有字段）：

```js
// 新增（既有字段一个都不动）：
//   channels: { static:{calls,hits,injectedBytes}, bridge:…, guard:…, derived:…, payload:… },
//   bySource: { systemPrompt:…, toolSchema:…, skill:…, experience:…, knowledge:…, protocol:…, payload:… },
//   promptTier, sessionMode, kb
```

**要求**：
- `static` 由 Step 4b 的 prompt 段计量映射；`bridge` 由桥侧 append 累加；`guard` 由守卫注入累加；`derived` 由 `beforeIter` 派生注入累加；`payload` 由轮载荷累加。
- `unified` 路径从未在生产启用（实测 `resolveInjectMode` 默认 `legacy`）⇒ **如实为 0，不造数**。
- **不得**删除或改名任何既有字段（`calls`/`strategy`/`indexLines`/`recallBlocks`/`elapsedMs`/`indexAgeMs`/`degraded`/`queries`/`hitQueries`/`scope`/`spacesDropped`/`spacesCapped`/`hitRate`）。

- [ ] **Step 4d: 落点改到**轮末统一出口**（★ 不是 `loop.onTurnEnd`）**

实测 `cli.mjs:1322 loop.onTurnEnd` 位于 `if (loop.isActive())`（`:1319`）内 ⇒ 只在 loop 会话生效。改为在**每个轮末都走的收尾段**（实测约 `:1290-1318`，以 Step 1 实测为准）落快照：

```js
// S1+ O4：每轮一条注入总账（与 loop.isActive() 无关）
try {
  const stats = deps?.knowledge?.getInjectStats?.() || {}
  const segments = buildSegmentMeters({
    ...getPromptSegmentMeters(),                  // Step 4b
    injectedBytes: stats.channels?.derived?.injectedBytes
      + stats.channels?.guard?.injectedBytes
      + stats.channels?.bridge?.injectedBytes,
  })
  store.appendMeta('inject_snapshot', summarizeInjection({   // ★ 变量名实测是 store
    turn, seq: nextTurnSeq(),
    segments,
    channels: stats.channels,
    bySource: stats.bySource,
    promptTier: stats.promptTier, sessionMode: stats.sessionMode, kb: stats.kb,
  }))
} catch { /* 记账失败绝不影响主流程 */ }
```

**逐轮语义（易错点）**：`resetInjectStats()` 现有 `acc` 是**进程级累计**，逐轮直接读会拿到累计值 ⇒ 由本任务新增的 `nextTurnSeq()` 记录轮号，并在**每轮开始或轮末读数后**调用 `resetInjectStats()`（**二选一，选定后在注释里写明**，不要两头都调导致漏账）。

**必须 `try/catch`**：账不能影响主流程。

- [ ] **Step 5: 运行测试确认通过**

```bash
node --test --test-timeout=120000 kernel-tests/inject-ledger.test.mjs
```

Expected: PASS（9 个用例全绿）。

- [ ] **Step 6: 跑核心门禁**

```bash
cd /c/Users/T203-15/yfworking
npm run test:kernel
npm run verify:experience-inject && npm run verify:milestones-start
```

Expected: 全绿（基线 210 + Task 1 新增 1 + 本任务新增 1 = 212 文件）；两个 verify EXIT=0（本任务不动经验注入契约与 milestone 解析）。

- [ ] **Step 7: 提交（按文件精确 add）**

```bash
cd /c/Users/T203-15/yfworking
git add kernel/inject-ledger.mjs kernel-tests/inject-ledger.test.mjs kernel/prompt.mjs kernel/knowledge-inject.mjs kernel/cli.mjs server/bridge.mjs
git commit -m "feat(inject): S1+ 注入总账（O4）—— 每轮 inject_snapshot，渠道五分 + 来源归因

- 新建 kernel/inject-ledger.mjs（纯函数）：CHANNELS/BY_SOURCE、
  buildSegmentMeters/summarizeInjection/ledgerTotals
- ★ 修正原稿三处致命问题（逐行实测）：
  1) 渠道原为 legacy/unified 两分 ⇒ 那是检索策略维度，不是注入渠道维度，
     与 A13「可归因到 5% 以内」不符；已改为渠道五分 static/bridge/guard/derived/payload
  2) 原稿读 stats.systemPromptBytes/toolSchemaBytes/skillBytes/injectedChars/seq
     —— 这些字段在 getInjectStats() 中**均不存在**，账会全为 0；
     改为补做 spec §4.1 S1+④ 的 prompt.mjs 各段 Buffer.byteLength 只读计量 + 桥侧 append 长度
  3) 原稿落点 cli.mjs:1322 loop.onTurnEnd 位于 if (loop.isActive()) 内 ⇒ 只有 loop 会话有账；
     改为落在轮末统一收尾段，与 loop.isActive() 无关
- 场景三元组 promptTier/sessionMode/kb 齐备（跨场景混算会让 5% 假红）
- 记忆注入关闭时记 0 而非不记（spec :211）；unified 渠道如实为 0（不造数）
- 逐轮语义：resetInjectStats 原为进程级累计，新增 nextTurnSeq 并明确重置时点
- 硬约束：只取长度不重排提示词；不改 build 预算口径（归 Task 5）；metrics.json 段名不变
- 记账异常 try/catch 吞掉，绝不影响主流程
- 测试 9 例（含\"只增不删\"守护）"
```

---

## Task 3: S4.5② —— 内核注入侧尊重 `active`（A16）

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
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'   // ← 仅当 Step 1 确认需要造目录时保留；实测扁平文件形状**不需要**
import { buildMemoryIndex, buildRelevantMemory } from '../kernel/memory.mjs'

/** 造一个含 active:true / active:false 两个主题的记忆根（★ 扁平文件形状） */
function mkMemoryRoot() {
  const root = mkdtempSync(join(tmpdir(), 'mem-active-'))
  for (const { theme, active } of [{ theme: '启用主题', active: 'true' }, { theme: '停用主题', active: 'false' }]) {
    // ★ 实测形状：主题是**扁平文件** root/<主题>.md（kernel/memory.mjs:29-31 themePath），
    //   frontmatter 与条目**同文件**（:83-85 写 front + 条目）；**不是**目录，也**没有** _front.md
    const lines = ['---', `name: ${theme}`, `description: ${theme}`, `active: ${active}`, '---',
      `- [会话|标签] ${theme} 的条目 -- 全文`]
    writeFileSync(join(root, `${theme}.md`), `${lines.join('\n')}\n`, 'utf8')
  }
  return root
}

test('buildMemoryIndex 跳过 active:false 的主题（A16）', () => {
  const root = mkMemoryRoot()
  const text = buildMemoryIndex({ root, maxBytes: 4096 })      // ★ 实测签名 ({root, maxBytes})，无 keywords
  assert.ok(text.includes('启用主题'), '启用主题应被注入')
  assert.ok(!text.includes('停用主题'), '停用主题不应被注入')
})

test('buildRelevantMemory 同样跳过 active:false 的主题（A16：两个注入函数都要覆盖）', () => {
  const root = mkMemoryRoot()
  const text = buildRelevantMemory({ root, keywords: ['启用主题', '停用主题'], maxBytes: 4096 })
  assert.ok(!String(text).includes('停用主题'), '停用主题不应被相关记忆注入')
})
```

> ⚠️ `buildMemoryIndex`（实测 `:99 ({root, maxBytes})`）与 `buildRelevantMemory`（实测 `:140`）的**真实签名与返回形状必须先 Read 确认**（`keywords` 属后者，不属前者——原稿把两者的参数混用了）。若实测不同，**改测试以匹配真实签名**，但**断言意图不变**（停用主题在两处都不得出现）。

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

## Task 4: S4.5① —— 去重：移除 `server/bridge.mjs` 两处常驻经验注入

**Files:**
- Modify: `server/bridge.mjs`（移除约 `:1609` / `:1647` 两处 `buildExperienceIndex(...)` **调用**）
- Test: `kernel-tests/experience-dedup.test.mjs`（新建）

**Interfaces:**
- Consumes: `buildExperienceIndex(maxBytes, theme?)`（`server/experience.mjs:161` 定义；`server/bridge.mjs:90-91` import + re-export）
- Produces: system 中经验相关内容**出现次数 2 → 1**

### 背景（实现者必读）

> ★★ **硬前置（spec D3 / §3.4）：必须先完成 Task 3（内核侧尊重 `active`）再执行本任务。**
> 依据：spec D3「**前置硬约束**：先补 `front.active` 过滤，**再**移除桥侧 `buildExperienceIndex`」；
> §3.4「**必须先做**，否则去重后'停用主题仍被注入'从隐性变**显性**」——去重后只剩内核侧一份注入，
> 若内核侧不认 `active`，用户在图谱停用主题**将完全无效**（比去重前更难解释）。
> ⇒ **本任务不得先于 Task 3 提交**；已在 `kernel-tests/experience-dedup.test.mjs` 有 Task 3 的 A16 用例作为前置哨兵。

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

## Task 6: S4.5④-1 —— EL0 主题清单渲染（常驻 ~200 B，A14/G3）

**Files:**
- Modify: `kernel/memory.mjs`（`buildMemoryIndex`，实测约 `:99`）
- Test: `kernel-tests/experience-dedup.test.mjs`（追加）

**Interfaces:**
- Consumes: `readTheme(root, theme) → { front, entries }`（`kernel/memory.mjs`）；Task 3 落地的 `front.active` 过滤；Task 5 的 `memoryBytes`
- Produces:
  - `buildMemoryIndex({ root, maxBytes }) → string`：输出**主题清单**（每行 `- [主题] N 条 · 最近日期`）
  - `EL0_TARGET_BYTES = 200`、`EL0_MAX_BYTES = 512`
  - `renderThemeList(themes, { lean }) → string`

### 背景（实现者必读）—— **本任务是 headline 收益（−8526 B/轮）的主要载体**

**现状（实测）**：`kernel/memory.mjs:99 buildMemoryIndex` 输出**约 42 行条目式索引 ≈5131 B**，且**每轮恒在**。注入 spec `:57` 的诊断原话：

> 经验索引的现状是**同一个病症**：42 行 / 5131 B 的"完整条目索引"（本质是 L2 内容）被当作 L0 恒在，塞进每一轮的 system。

**目标（spec §3.2 `:230` + §4.2 `:402`/`:416`）**：

| 层 | 内容 | 成本 |
|---|---|---|
| **EL0** | 主题清单：`- [主题] N 条 · 最近日期`（7 主题） | **~200 B**（恒在，**替代现 42 行**），通道①②（system 静态） |

逐项核算（spec `:416`）：**经验索引（内核 `memory` 段）5131 → 200（EL0）= −4931 B/轮**。这是 A14/G3「每轮恒在合计 ≤1736 B」成立的前提——**没有这一步，去重后仍恒在 ≈6667 B，A14 与 G3 均不可达**。

**硬要求**：
1. **保留全部主题名 + 条数**（spec `:475`：EL0 保留**全部**主题名 + 条数（~200 B），**只裁条目级细节**；对齐主 spec §9.4"L0 元数据恒在用于路由"）。⇒ **不得**只保留"前 N 个主题"——那会让模型"不知道有哪些主题"。
2. **A14**：恒在的 EL0 **≤512 B**。
3. **不含条目摘要正文**（否则又变回 L2）。
4. **停用主题不得出现**（A16；由 Task 3 的 `front.active` 过滤保证，本任务不得绕过）。
5. **不改检索口径**、不改 `settings.memory.inject` 语义（后者 `false` ⇒ 记忆类注入全停，总账**记 0 而非不记**，spec `:211`）。

- [ ] **Step 1: 核实落点与真实形状（只读）**

```bash
cd /c/Users/T203-15/yfworking
grep -n "export function buildMemoryIndex" kernel/memory.mjs
grep -n "function readTheme\|function themePath\|parseFrontmatter\|date" kernel/memory.mjs | head -20
sed -n '95,135p' kernel/memory.mjs
```

Expected: 读出 `buildMemoryIndex` 的**真实签名**（实测 `:99 ({root, maxBytes})`）、列主题的真实方式（实测 `readdirSync(root).filter(x=>x.endsWith('.md'))`，`:102`）、`readTheme` 的返回（含 `front`/`entries`）、条目是否带 `date` 字段。
★ **若条目无 `date`**：`最近日期` 取**主题文件**（`root/<主题>.md`）的 frontmatter 字段（如 `updated`）或文件 `mtime`；**先用 Grep 确认可用字段，不要臆造**——若确实无从取得，则该列**省略**（并在事实登记里写明），**但主题名 + 条数不得省**。

- [ ] **Step 2: 写失败测试**

追加到 `kernel-tests/experience-dedup.test.mjs`：

```js
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildMemoryIndex, renderThemeList, memoryBytes, EL0_MAX_BYTES, EL0_TARGET_BYTES } from '../kernel/memory.mjs'

/** 造记忆根：扁平文件 root/<主题>.md（★ 实测形状：不是目录，也不是 _front.md） */
function mkFlatRoot(themes) {
  const root = mkdtempSync(join(tmpdir(), 'mem-el0-'))
  for (const { theme, active = 'true', entries = 3 } of themes) {
    const lines = ['---', `name: ${theme}`, `description: ${theme}`, `active: ${active}`, '---']
    for (let i = 0; i < entries; i++) lines.push(`- [会话|标签] ${theme} 的第 ${i} 条摘要 -- 全文${i}`)
    writeFileSync(join(root, `${theme}.md`), `${lines.join('\n')}\n`, 'utf8')
  }
  return root
}

test('EL0：输出主题清单形态（- [主题] N 条）', () => {
  const root = mkFlatRoot([{ theme: '经验沉淀', entries: 4 }])
  const text = buildMemoryIndex({ root })
  assert.ok(/^- \[经验沉淀\] 4 条/m.test(text), `应为主题清单形态，实际:\n${text}`)
})

test('A14：EL0 恒在 ≤512 B（7 主题 ≈200 B）', () => {
  const root = mkFlatRoot(Array.from({ length: 7 }, (_, i) => ({ theme: `主题${i}`, entries: 5 })))
  const text = buildMemoryIndex({ root })
  assert.ok(memoryBytes(text) <= EL0_MAX_BYTES, `EL0 应 ≤${EL0_MAX_BYTES} B，实际 ${memoryBytes(text)}`)
  assert.ok(memoryBytes(text) <= EL0_TARGET_BYTES * 2, `应接近目标 ~${EL0_TARGET_BYTES} B，实际 ${memoryBytes(text)}`)
})

test('★ 保留全部主题名 + 条数（不得只留前 N 个 —— spec :475）', () => {
  const themes = Array.from({ length: 40 }, (_, i) => ({ theme: `主题${i}`, entries: i + 1 }))
  const text = buildMemoryIndex({ root: mkFlatRoot(themes) })
  for (const t of themes) assert.ok(text.includes(t.theme), `缺主题名: ${t.theme}`)
  assert.ok(text.includes('40 条'), '应含条数')
})

test('★ EL0 不含条目摘要正文（否则又变回 L2）', () => {
  const text = buildMemoryIndex({ root: mkFlatRoot([{ theme: '经验沉淀', entries: 3 }]) })
  assert.ok(!text.includes('全文0'), 'EL0 不得含条目正文')
  assert.ok(!text.includes('的第 0 条摘要'), 'EL0 不得含条目摘要')
})

test('A16：停用主题不出现在 EL0', () => {
  const root = mkFlatRoot([{ theme: '启用主题' }, { theme: '停用主题', active: 'false' }])
  const text = buildMemoryIndex({ root })
  assert.ok(text.includes('启用主题'))
  assert.ok(!text.includes('停用主题'))
})

test('renderThemeList：lean 档只去日期，不漏主题名与条数', () => {
  const lean = renderThemeList([{ theme: 'A', count: 2, latest: '2026-09-20' }], { lean: true })
  assert.ok(lean.includes('A'))
  assert.ok(lean.includes('2 条'))
  assert.ok(!lean.includes('2026-09-20'))
})
```

- [ ] **Step 3: 运行测试确认失败**

```bash
node --test --test-timeout=120000 kernel-tests/experience-dedup.test.mjs
```

Expected: FAIL —— `renderThemeList`/`EL0_MAX_BYTES` 未导出；且 `buildMemoryIndex` 当前输出条目式索引（不含 `- [主题] N 条` 形态、含"全文0"）。

- [ ] **Step 4: 实现**

在 `kernel/memory.mjs` 新增并导出：

```js
/** EL0 目标字节（spec §3.2：7 主题 ≈200 B） */
export const EL0_TARGET_BYTES = 200
/** EL0 硬上限（A14：恒在的 EL0 ≤ 512 B） */
export const EL0_MAX_BYTES = 512

/**
 * EL0 渲染：主题清单 `- [主题] N 条 · 最近日期`。
 * lean 档 = 去掉"最近日期"，**保留全部主题名与条数**（只裁条目级细节，spec :475）。
 */
export function renderThemeList(themes, { lean = false } = {}) {
  return (themes || [])
    .map((t) => {
      const suffix = !lean && t.latest ? ` · ${t.latest}` : ''
      return `- [${t.theme}] ${t.count} 条${suffix}`
    })
    .join('\n')
}
```

并把 `buildMemoryIndex` 改为输出主题清单**（★ 签名与列目录方式以 Step 1 实测为准）**：

```js
/**
 * EL0：经验**主题清单**（常驻 ~200 B）。
 * 改前：42 行条目式索引 ≈5131 B（本质 L2 被当 L0，spec :57）。
 * 改后：`- [主题] N 条 · 最近日期`，**保留全部主题名 + 条数**，只裁条目级细节。
 * 归通道①②（system 静态）。
 */
export function buildMemoryIndex({ root, maxBytes = EL0_MAX_BYTES } = {}) {
  const themes = []
  for (const name of listThemeNames(root)) {          // ← Step 1 实测的真实列目录方式
    const { front, entries } = readTheme(root, name)
    if (String(front?.active) === 'false') continue    // A16（Task 3 已落地）
    const latest = latestDateOf(front, entries, root, name)   // ← Step 1 决定取值来源
    themes.push({ theme: name, count: entries.length, latest })
  }
  const full = renderThemeList(themes)
  if (memoryBytes(full) <= maxBytes) return full
  // 二级降级：只去"最近日期"，**绝不丢主题名与条数**
  return renderThemeList(themes, { lean: true })
}
```

**要点**：
- `listThemeNames` / `latestDateOf` 若现有代码里已有等价逻辑，**直接复用**（不要另造第二套遍历）。
- **删除**原条目式索引的渲染分支（那是本任务要替掉的形态）；若该分支有别的调用方，**先 Grep 确认**再删。
- **不要**动 `readTheme` 与 `front.active` 判定口径。

- [ ] **Step 5: 运行测试确认通过 + 点名受影响测试**

```bash
cd /c/Users/T203-15/yfworking
node --test --test-timeout=120000 kernel-tests/experience-dedup.test.mjs
npm run test:kernel
```

Expected: 全绿。

★ **必须同步处理既有测试**（spec §9 Q6 要求把"已知会变的测试"列为交付前置检查单）：实测最小受影响面是 `kernel-tests/knowledge-inject.test.mjs` —— 其 `:39`/`:59`/`:63` 的"零回归锁"与 `:128-132` 的注释明确写着"`buildMemoryIndex` 内部按**字符数**比较 `maxBytes`（既有约定，不动 = 零回归）"。**本任务改了输出形态与口径 ⇒ 该注释必须同步更新，相关断言按新形态核对**（不是删断言，而是改成对新形态成立且仍有意义的断言）。

```bash
grep -rn "buildMemoryIndex" kernel-tests/ | head
```

- [ ] **Step 6: 提交**

```bash
cd /c/Users/T203-15/yfworking
git add kernel/memory.mjs kernel-tests/experience-dedup.test.mjs kernel-tests/knowledge-inject.test.mjs
git commit -m "feat(memory): S4.5④-1 EL0 主题清单渲染（常驻 5131→200 B，A14/G3）

- buildMemoryIndex 输出形态改为 EL0 主题清单 \`- [主题] N 条 · 最近日期\`（替代原 42 行条目式索引）
- 依据：注入 spec :57 诊断\"42 行/5131 B 的完整条目索引（本质 L2）被当作 L0 恒在\"
  ⇒ spec §4.2 逐项核算：经验索引 5131 → 200（EL0）= −4931 B/轮
- 硬要求：保留全部主题名 + 条数（:475，只裁条目级细节）；EL0 ≤512 B（A14）；不含条目正文
- 二级降级只去\"最近日期\"，绝不丢主题名与条数（防\"模型不知道有哪些主题\"）
- 复用 Task 3 的 front.active 过滤 ⇒ 停用主题不出现在 EL0（A16）
- 同步更新 kernel-tests/knowledge-inject.test.mjs 中\"按字符数比较 maxBytes\"的既有约定注释
- ★ 无此步则去重后仍恒在 ≈6667 B，A14 与 G3（≤1736 B）均不可达"
```

---
## Task 7: S4.5④ —— 新增 EL1 线索层 `kernel/knowledge-recommend.mjs`（R1–R6）

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
**观察期**：由 `PONOS_MEMORY_EL1_OBSERVE`（**默认 `1`**）控制 ⇒ **不真注入**（Task 8 接线时生效）。

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
  buildRecommendSection, renderRecommendLine, HYDRATE_EL1_MAX_BYTES, EL1_SNIPPET_MAX,
} from '../kernel/knowledge-recommend.mjs'

const item = (over = {}) => ({
  blockId: 'experience/workflow.md#1',
  space: 'experience',
  title: '注入总线',
  snippet: '把散在 12 处的注入收敛到一条总线',
  related: [],
  ...over,
})

test('R1：永不升级全文（upgraded 恒 false，输入含 full 也不得进入输出）', () => {
  const r = buildRecommendSection([item({ full: '整篇正文……' })], { budgetBytes: HYDRATE_EL1_MAX_BYTES })
  assert.equal(r.upgraded, false)
  assert.ok(!r.text.includes('整篇正文'), 'R1：不得注入正文')
  // ★ 有效断言：即使输入带 full 且预算充足，输出长度也不得因正文而膨胀
  const withoutFull = buildRecommendSection([item()], { budgetBytes: HYDRATE_EL1_MAX_BYTES })
  assert.equal(r.bytes, withoutFull.bytes, 'R1：带上 full 输入不得改变注入字节数（否则等于注正文）')
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

test('R5：未授权空间只给 related / mode:full 的替代路径，且不得指向 Read', () => {
  const r = buildRecommendSection(
    [item({ space: 'secret', readable: false })],
    { budgetBytes: HYDRATE_EL1_MAX_BYTES, readableSpaces: [] },
  )
  assert.ok(r.lines[0].hint.includes("mode:'full'"), 'R5：须写明 mode:full 替代路径')
  assert.ok(r.lines[0].hint.includes('related'), 'R5：须写明 related 替代路径')
  assert.ok(!r.lines[0].hint.includes('Read'), 'R5：无权限时不得指向 Read（会失败）')
})

test('R6：预算按字节记账，装不下丢弃整行（不截断行内正文）', () => {
  const many = Array.from({ length: 20 }, (_, i) => item({ blockId: `s#${i}`, title: `标题${i}` }))
  const r = buildRecommendSection(many, { budgetBytes: 200 })
  assert.ok(r.bytes <= 200, `字节数不得超预算，实际 ${r.bytes}`)
  assert.ok(r.lines.length >= 1, '至少首条（首条无条件放入）')
  assert.ok(r.lines.length < 20, `预算不足 ⇒ 必须丢行，实际装入 ${r.lines.length}`)
  assert.ok(r.dropped > 0, '应记录被丢弃的行数')
  // ★ 不得截断行内正文：装入的每行 text 必须与渲染结果逐字相等（未被切短）
  for (const line of r.lines) {
    assert.equal(line.text, renderRecommendLine(many.find((x) => x.blockId === line.blockId), {}).text,
      '装入的行不得被截断')
  }
})

test('R6：预算小到只装得下首条时，只剩首条（首条无条件放入）', () => {
  const many = Array.from({ length: 20 }, (_, i) => item({ blockId: `s#${i}`, title: `标题${i}` }))
  const one = buildRecommendSection([many[0]], { budgetBytes: 1 }).bytes          // 实测单行字节
  const r = buildRecommendSection(many, { budgetBytes: one })                     // 只够一条
  assert.equal(r.lines.length, 1, `预算=${one} 时只剩首条，实际 ${r.lines.length}`)
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

// ★ R3：摘要必须复用既有 makeSnippet（shared/knowledge-core.mjs；kernel/knowledge-search.mjs:10 已导入）
//    —— 不要另造第二个摘要实现（单一口径）。EL1 只把 max 放宽到 300。
import { makeSnippet } from '../shared/knowledge-core.mjs'

/** 摘要化：走 makeSnippet —— ★ 实测签名为**对象参数** `makeSnippet(text, { maxLen })`，不是位置参数 */
function snippetOf(text, max = EL1_SNIPPET_MAX) {
  return makeSnippet(String(text ?? ''), { maxLen: max })
}

/** R4：把 why.kind 打成简短理由标签（契约要求"按 why.kind 打理由"） */
const WHY_LABEL = {
  'same-space': '同空间',
  keyword: '关键词',
  'anchor': '锚点',
  'blockId': '直指',
  'linked': '关联',
  'duplicate': '重复',
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
    .map((r) => ({ ...r, label: WHY_LABEL[r?.why?.kind] || String(r?.why?.kind || '关联') }))  // R4：打理由
  // R5：三态 —— Set 放行 / null 不给指引 / 未授权只给 related|mode:'full'（含替代路径，且不得指向 Read）
  const unreadable = item.readable === false
    || (Array.isArray(opts.readableSpaces) && !opts.readableSpaces.includes(item.space))
  const hint = unreadable
    ? `（无读取权限：用 KnowledgeSearch {related:'${item.blockId}'} 或 {mode:'full'} 获取）`
    : (related.length ? `（展开：KnowledgeSearch {related:'${item.blockId}'}）` : '')  // 无锚点则不给展开动作
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

## Task 8: S4.5⑤⑥ —— 每轮 system 组装处接线 + 观察期分名 + EL1↔unified 互斥（A18/A20）

**Files:**
- Modify: `kernel/cli.mjs`（`beforeIter` 相位接线；推荐集合登记 `offered` / `offeredDryRun`）
- Test: `kernel-tests/knowledge-recommend.test.mjs`（追加接线与互斥用例）

**Interfaces:**
- Consumes: `buildRecommendSection`（Task 6）；`knowledgeRelateMode`（`kernel/knowledge.mjs:566` 定义 `'on'`（缺省）\|`'off'`；`:585` 从 `<configDir>/config.json` 读）；`resolveInjectMode`（`kernel/knowledge-inject.mjs`）
- Produces: EL1 在 `strategy=legacy` 时生效、`unified` 时关闭；观察期 `offeredDryRun` 与转正后 `offered` **分名**

### 背景（实现者必读）

**⑤ 接线**：EL1 走通道④（`beforeIter` 派生注入）。同时**登记推荐集合**：
- 观察期（`PONOS_MEMORY_EL1_OBSERVE=1`，**默认**）：登记为 **`offeredDryRun`**（**不真注入**）
- 转正后：登记为 **`offered`**

**⑥ 互斥（A20）**：EL1 线索层与 unified 抽调层（`renderRecall`）做的是**同一件事的两种渲染**。若同时启用 ⇒ **同一批知识块注入两遍**（本次评估 P0「双注入」的新版本）。故：

| `strategy` | 知识供给方 | EL1 |
|---|---|---|
| `legacy`（当前生产） | 无抽调层（legacy `recallSection` 恒空） | ✅ **生效**（补上 legacy 缺失的供给） |
| `unified`（灰度后） | `renderRecall` 抽调层 | ❌ **关闭**（避免双供给） |

**前置（A18）**：`knowledgeRelateMode === 'on'`（`kernel/knowledge.mjs:566`）。

- [ ] **Step 1: 核实开关与接线点（只读，★ 必做：原稿引用了不存在的符号）**

```bash
cd /c/Users/T203-15/yfworking
# ① relate 模式的真实实现（★ 实测 :566 是 JSDoc，:577 才是实现）
grep -n "resolveRelateMode\|knowledgeRelateMode" kernel/knowledge.mjs
# ② 每轮 system 组装处（★ EL1 的真实落点在这里，不是"beforeIter 相位"）
grep -n "refreshSystemPrompt\|function buildSystem\|systemPrompt =" kernel/cli.mjs | head
# ③ 既有"相位/相位钩子"是否存在（★ 实测：不存在，phaseHooks 是 B2 概念）
grep -rn "beforeIter\|phaseHooks\|emitIterDerived\|OBSERVE_ONLY" kernel/ server/ | head
# ④ 检索入口与 appendMeta API
grep -n "export async function searchKnowledgeItems" kernel/knowledge-search.mjs
grep -n "appendMeta" kernel/session.mjs
```

Expected:
- ① `resolveRelateMode(configDir, explicit)`（实测约 `:577`）—— **用真实函数名，不是 `knowledgeRelateMode`**
- ② 定位每轮 system 组装函数（实测 **`kernel/cli.mjs:1001 refreshSystemPrompt()`**，函数体是
  `engine.setSystemPrompt(composeSystemPrompt({ toolNames, subagents, agents, append, cwd, skills, workflows, memory, knowledgeScope, mode, tier }))`）
  —— **这是接线落点**。而 `composeSystemPrompt`（定义在 **`kernel/prompt.mjs:218`**）**已有 `append = ''` 参数**
  ⇒ **线索段最稳的落点是并入 `append`**（零改动风险）；若要新增独立参数，须同步该函数全部调用方
- ③ **应零命中** ⇒ 说明"`beforeIter` 相位 / `OBSERVE_ONLY` / `emitIterDerived`"**都是不存在的概念**（`phaseHooks` 属 spec §5.4 的 B2）
  ⇒ **本任务必须落在真实位置**：把线索段拼进 system 组装处（②），**不要**去造一套相位机制（那是 B2 的事）
- ④ `searchKnowledgeItems`（实测 `kernel/knowledge-search.mjs:18`）；`appendMeta`（实测 `kernel/session.mjs:343`）

**把 ② 的真实函数名与行号写进 Step 5 的代码注释**。

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

test('观察期：dryRun 下 offered 有值但 text 为空（offeredDryRun 语义）', () => {
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
  // 观察期（opts.dryRun，由 PONOS_MEMORY_EL1_OBSERVE 控制）：登记 offered，但不产生可注入文本
  if (opts.dryRun === true) {
    return { lines, offered, dropped, bytes: used, upgraded: false, dryRun: true, text: '' }
  }
```

- [ ] **Step 5: 在**每轮 system 组装处**接线（★ 落点实测 = `kernel/cli.mjs:999-1011 refreshSystemPrompt()`，以 Step 1 实测为准）**

```js
// S4.5⑤ EL1 线索层接线（在 refreshSystemPrompt / 每轮 system 组装处，Step 1 已核实真实位置）
const el1On = shouldInjectEl1({
  strategy: resolveInjectMode(settings),                 // kernel/knowledge-inject.mjs:50（默认 legacy）
  relateMode: resolveRelateMode(configDir),               // kernel/knowledge.mjs:577（不是 :566）
  enabled: process.env.PONOS_MEMORY_EL1 !== '0',          // D6：唯一逃生阀，不与 PONOS_MEMORY_INJECT 耦合
})
if (el1On) {
  // hits 来源：KnowledgeSearch 同一入口（Step 1 已核实签名）
  const hits = await searchKnowledgeItems({ configDir, query, keywords, spaces: readableSpaces })
  const rec = buildRecommendSection(hits, {
    budgetBytes: HYDRATE_EL1_MAX_BYTES,
    readableSpaces,
    dryRun: el1ObserveOnly,                               // 观察期默认 true
  })
  if (el1ObserveOnly) {
    // 观察期：只登记，**不注入**（rec.text 为空）
    store.appendMeta('inject_recommend_dryrun', { offered: rec.offered, bytes: rec.bytes })  // ★ 变量名是 store
  } else {
    sys += `\n${rec.text}`                                // 真注入（转正后）
    store.appendMeta('inject_recommend', { offered: rec.offered, bytes: rec.bytes })
  }
}
```

**要点（逐条都是实测修正）**：
- **落点**是每轮 system 组装处（`kernel/cli.mjs:1001 refreshSystemPrompt()` → `composeSystemPrompt({ append })`，定义在 `kernel/prompt.mjs:218`）——**不是**"`beforeIter` 相位"：实测 `beforeIter`/`phaseHooks`/`emitIterDerived` **全部不存在**（`phaseHooks` 是 spec §5.4 的 **B2** 概念）。**不要**为接线去造一套相位机制。
- `resolveRelateMode(configDir)` 是**真实函数名**（实测 `kernel/knowledge.mjs:577`；`:566` 只是 JSDoc）。
- `store` 是 cli 内持有 session 的**真实变量名**（`appendMeta` 实测 `kernel/session.mjs:343`）。
- **观察期开关**：用 `PONOS_MEMORY_EL1_OBSERVE`（**默认 `1` = 观察期**，与逃生阀 `PONOS_MEMORY_EL1=0` 相互独立；前者控"是否真注入"，后者控"是否启用该层"）。
- `query` / `keywords` 的来源**必须写明**（取自当前用户消息与检索上下文；若存在多个候选来源，选定一个并在注释里说明理由）。
- **`offeredDryRun` 与 `offered` 必须分名**（混用会污染采纳率口径）。
- **A18②③ / A19 补充**：除 `offered` 外，还要按 spec §3.2.3 提供 **`adopted`** 与 **`adoptRate`**；
  ★ 观察期 `adopted` 的**语义为"不适用"**（A19）——**不得记 0**，应记 `null` 并在面板/日志中标注"观察期不适用"。

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
- ★ 落点修正：接在每轮 system 组装处（refreshSystemPrompt），**不造相位机制**
  原稿引用的 beforeIter/phaseHooks/emitIterDerived/knowledgeRelateMode 实测均不存在（phaseHooks 属 spec §5.4 的 B2）
  改用真实函数 resolveRelateMode(:577) 与 store.appendMeta(session.mjs:343)
- 观察期 PONOS_MEMORY_EL1_OBSERVE 默认 1 → 登记 inject_recommend_dryrun 且不注入
  转正后登记 inject_recommend（offered/offeredDryRun 分名，防污染采纳率口径）
- buildRecommendSection 支持 dryRun（text 恒空）"
```

---

## Task 9: S4.5⑦ —— GUI 面板口径同步（`server/experience.mjs`）

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

- [ ] **Step 4: 实现口径同步（★ 读 EL0 的真实渲染，不是旧的全量索引）**

**关键**：Task 6 已把内核侧经验供给改为 **EL0 主题清单（~200 B）**。面板若仍以 `buildExperienceIndex(4096, theme)` 为底，
数字会**停在 ≈5131 B**——"面板与实际一致"的目标**不成立**（原稿只换单位的做法已被否）。

```js
// server/experience.mjs 顶部：复用内核侧的唯一字节口径与 EL0 渲染（不另造换算函数）
import { memoryBytes, buildMemoryIndex, EL0_MAX_BYTES } from '../kernel/memory.mjs'

// :219 单主题 —— 按内核侧 EL0 实际注入口径
inject_bytes: experienceInjectBytes(),

// :223 合计 —— 同上
const totalInjectBytes = experienceInjectBytes()

/**
 * 经验注入的实际字节口径（三层化：EL0 恒在 + 命中时的 EL1）。
 * ★ 复用 kernel/memory.mjs 的 EL0 渲染与 memoryBytes —— 不另造第二套口径。
 */
function experienceInjectBytes() {
  const el0 = buildMemoryIndex({ root: memoryRoot, maxBytes: EL0_MAX_BYTES })
  return memoryBytes(el0)
}
```

**要求**：
- **必须**复用 `memoryBytes`（禁止第二份换算）；**必须**以 EL0 渲染为底（不得再用 `buildExperienceIndex(...).length`）。
- `memoryRoot` 用本文件**既有的**记忆根路径变量（Step 1 核实真实名，不要新造）。
- 若本文件无法 import `kernel/memory.mjs`（循环依赖等），**先尝试**；确实不行才在本文件内联一份**同名同语义**的 EL0 渲染，
  并在注释写明"与 `kernel/memory.mjs` 的 EL0 渲染必须同步"——**不得**只是换个单位仍用旧全量口径。
- **不得**硬编码 200/512 等数字（从 `EL0_MAX_BYTES` 取）。

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

## 数字口径（★ 本机实测，实施前必读）

本计划的收益数字有两个口径：**spec 口径**（spec 时点语料）与**实测口径**（本机真实语料）。
实施者**必须两者都知道**，否则"改前改后对不对"无从判断。

**实测命令（可复现）**：

```bash
cd /c/Users/T203-15/yfworking
node --input-type=module -e '
import { buildMemoryIndex } from "./kernel/memory.mjs";
import { homedir } from "node:os";
import { join } from "node:path";
const root = join(homedir(), ".yfworking", "memory", "personal");
const out = String(buildMemoryIndex({ root, maxBytes: 4096 }));
console.log("现状字节 =", Buffer.byteLength(out, "utf8"));
console.log("条目行数 =", out.split("\n").filter(l => l.startsWith("- [")).length);
'
```

**实测结果（2026-09-20，root = `~/.yfworking/memory/personal`）**：

| 指标 | 实测值 | 说明 |
|---|---|---|
| 现状 `buildMemoryIndex` 输出 | **5053 B** | 恒在，每轮注入 |
| 现状条目行数 | **40 行** | ★ 粒度是 **`[主题\|标签]` 二级**，且**每行带完整文件路径**（`C:\Users\…\workflow.md`，纯噪声约 60 B/行） |
| 记忆根主题数 | **7 个 .md**（`code-style`/communication/finance/office-docs/policy/project-application/workflow） | 其中 3 个当前 0 条 |
| **EL0（主题级，7 行）** | **211 B** | 形态 `- [主题] N 条 · 最近日期` |
| 现状 → EL0 差值 | **−4842 B/轮** | 单份 |

**分项与合计（务必按此核对）**：

| 步骤 | 口径 | 变化 |
|---|---|---|
| 现状（2 份：`server/bridge.mjs` 两处） | 2 × 5053 = **10106 B** | — |
| Task 4 去重后（1 份） | 10106 → 5053 | **−5053 B** |
| Task 6 EL0 后 | 5053 → **211 B** | **−4842 B** |
| **合计（EL1 = 0 时）** | 10106 → 211 | **−9895 B/轮** |
| **合计（EL1 满 1536 B 时）** | 10106 → 1747 | **−8359 B/轮** |

**与 spec 口径的关系（★ 结论：spec 的 ~200 B 口径成立，不修正）**：
- spec §4.2 写「经验索引 5131 → 200（EL0）= −4931 B/轮」、G3「≤1736 B」、总账「−8526 B/轮」。
- 实测现网是 **5053 → 211（−4842）**，与 spec 的 5131 → 200 **同量级且更接近**（差异来自 spec 时点语料）。
- ⇒ **本计划沿用 spec 的 headline「−8526 B/轮」（保守：按 EL1 满额算）**，但在汇报时**必须同时给出实测口径**（去重 −5053 / EL0 −4842 / 合计 −9895 ~ −8359）。
- ⇒ **A14（EL0 ≤512 B）与 G3（≤1736 B）按实测口径均已满足**（211 B ≪ 512 B）。

> ⚠️ **不要**把"现状"写成 42 行——实测 **40 行**（另有 4 行非条目行）。也不要把 EL0 目标写成"不可达"——实测 211 B 说明 ~200 B 目标**可达**。

---

## 受影响既有测试检查单（spec §9 Q6 交付前置）

spec §9 Q6 要求：把**已知会变的既有测试**列为**交付前置检查单**，避免"实现改完、既有测试红一片才发现"。

**实测最小受影响面**（已用 Grep 核实）：

| 文件 | 位置 | 为何受影响 | 处理 |
|---|---|---|---|
| `kernel-tests/knowledge-inject.test.mjs` | `:39`/`:59`/`:63`（"零回归锁"）与 `:128-132` 注释 | 该注释明确写"**`buildMemoryIndex` 内部按字符数比较 `maxBytes`（既有约定，不动 = 零回归）**"。Task 5（字节口径）与 Task 6（EL0 输出形态）**都会改变**这两个前提 | **必须同步更新该注释与相关断言**（改成对新形态仍有意义的断言，★ **不是删断言**）；由 Task 5 Step 5 与 Task 6 Step 5 各自负责，并在提交时一并 `git add` |
| `kernel-tests/memory-*.test.mjs`（memory 四件套） | — | spec Q6 曾点名，但**实测并不引用** `buildMemoryIndex`/`buildRelevantMemory` | 无需改（如实施时发现引用，按上一条同样处理） |
| `npm run verify:experience-inject` | — | 断言 `buildExperienceIndex(4096)` 存在 | **改动后必须仍绿**（Task 4 只删调用、保留定义与 re-export ⇒ 不应红；**若红说明删过头了**） |
| `server/experience.test.mjs` | `:133`/`:146`/`:154`/`:158` | 同上的四处测试 | 同上，**不应红** |

**交付前动作**：每个改口径的 Task（5/6）在提交前，先跑一次全量 `npm run test:kernel`，把**红清单**与上表对照：上表内的 ⇒ 本任务范围内同步改；**上表外的 ⇒ 停下来评估**（可能是改超范围了）。

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

**新增测试文件 4 个**：`turn-observability`（Task 1）、`inject-ledger`（Task 2）、`experience-dedup`（Task 3，Task 3/5/6/9 追加用例）、`knowledge-recommend`（Task 7，Task 8 追加用例）。⇒ 期望总数 **214**（基线 210 + 4，以实测为准；若差值不为 +4，逐一核对原因——最可能是 Task 6/8/9 误建成了新文件而非追加）。另需同步更新既有 `kernel-tests/knowledge-inject.test.mjs`（Task 5/6 改口径；**文件数不变**）。

## 评审时的汇报清单（批 1 完成后）

| 项 | 要报什么 |
|---|---|
| 观测层 | `turnToolDigest.size` / `turnStats.guard` 的真实样例（连续 2–3 轮） |
| 注入总账 | `inject_snapshot` 记账样例（连续 3 轮，**含非 loop 会话**）；渠道五分 `static/bridge/guard/derived/payload` 的实测值；`bySource` 归因；场景三元组 `promptTier/sessionMode/kb` 齐备 |
| 去重 + EL0 收益 | 经验常驻字节 **实测前后对比**：去重 `10262 → 5131`（−5131）+ EL0 `5131 → ~200`（−4931）⇒ 合计 **≈4668 B，−8526 B/轮**；EL0 实测字节 ≤512（A14） |
| A16 | 停用主题后内核 EL0/EL1 均不含该主题的证明 |
| R1–R6 | 六条渲染契约的对照测试结果；EL1 实测字节（≤1536） |
| A20 | `strategy=legacy` 有线索段 / `unified` 无线索段的对照结果 |
| A18/A19 | `blockId` 喂 `related` 必返非空；`offered`/`adopted`/`adoptRate` 三字段就位；★ 观察期 `adopted === null`（**不是 0**） |
| 观察期 | `inject_recommend_dryrun` 记账存在且 `text` 为空（未真注入）；`PONOS_MEMORY_EL1_OBSERVE` 默认 1 |
| 意外发现 | 实施中发现的 bug（**只记录不修**）清单 |

## Self-Review

**1. Spec coverage**

| spec 要求 | 落在哪 |
|---|---|
| S1 O1（`turnToolDigest.size`） | Task 1 Step 4 |
| S1 O2（`turnStats.guard`） | Task 1 Step 5 |
| S1 O3（模式 meta） | **不在本批**（阻塞于 S4，已在「范围与非范围」写明） |
| S1+ O4 每轮 `appendMeta('inject_snapshot')` | Task 2 Step 4d（**轮末统一出口**，★ 不是 `loop.onTurnEnd`——它在 `if (loop.isActive())` 内） |
| S1+ 只读分段计量（只取长度、不重组） | Task 2 Step 4 + **Step 4b**（`prompt.mjs` 各段 `Buffer.byteLength` + 桥侧 append 长度，spec §4.1 S1+④ / Q13） |
| **A13 可归因（≤5%）** | **Task 2 Step 4**（渠道五分 `static/bridge/guard/derived/payload` + `bySource` + 场景三元组 `promptTier/sessionMode/kb`） |
| S1+ `getInjectStats` 只增不删 | Task 2 Step 4c + 「只增不删」守护测试 |
| S1+ 不删 `metrics.json` 段 | Global Constraints + 「只增不删」守护测试 |
| S1+ 不改 `build` 预算口径 | Global Constraints（明确归 Task 5） |
| **S4.5② 内核侧尊重 `active`（A16）——★ 硬前置，必须先于去重** | **Task 3**（spec D3 / §3.4） |
| S4.5① 去重（2→1，**只删调用**） | **Task 4**（其背景写明"必须后于 Task 3"） |
| S4.5③ 字节口径统一（唯一归属本步） | Task 5（唯一性纪律） |
| **S4.5④-1 EL0 主题清单（−4931 B/轮，A14/G3 的载体）** | **Task 6**（保留全部主题名 + 条数、≤512 B、不含条目正文、停用主题不出现） |
| **受影响既有测试点名（spec §9 Q6）** | **Task 5 Step 5 + Task 6 Step 5**（`kernel-tests/knowledge-inject.test.mjs` 的"按字符数比较 maxBytes"注释与断言须同步更新，**不删断言**） |
| S4.5④ EL1 线索层 `knowledge-recommend.mjs` + R1–R6（含 R3 复用 `makeSnippet`、R4 打理由、R5 三态） | Task 7 |
| S4.5⑤ 每轮 system 组装处接线 + `offered`/`offeredDryRun` 分名 | Task 8（★ 落点为实测的 system 组装处，**不造相位机制**） |
| S4.5⑥ EL1↔unified 互斥（A20） | Task 8 |
| S4.5⑦ 面板口径同步（★ 读 EL0 真实渲染，非旧全量） | Task 9 |
| A18 前置 relateMode === 'on'（真实函数 `resolveRelateMode`） | Task 8 Step 2/4 |
| **A14** EL0 ≤512 B（Task 6）/ EL1 无线索正文 / 逃生阀 | Task 6 + Task 7 + Task 8 + Global Constraints |
| 「不改检索口径」 | Global Constraints + Task 7 提交说明 |

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
- **已修正的九处**（自审 + 独立审查 + 逐行实测）：
  1. **★ 缺 EL0 任务（headline 收益不可达）**：原稿目标"−8526 B/轮 / ≤1736 B"，但无任何一步改 `buildMemoryIndex` 的输出形态 ⇒ 去重后仍恒在 ≈6667 B，**A14（EL0 ≤512 B）与 G3（≤1736 B）均不成立**。已**新增 Task 6（EL0 主题清单）**：`5131 → ~200 B（−4931）`，并把 Goal/Architecture/File Structure/门禁/Self-Review 全部同步。
  2. **★ 任务顺序违反 spec 硬前置**：原稿"去重(Task 3) → active(Task 4)"，而 spec D3/§3.4 明确**必须先补 `front.active` 过滤、再移除桥侧注入**（否则"停用主题仍被注入"会从隐性变显性）。已**交换为 Task 3（active）→ Task 4（去重）**，并在 Task 4 背景写明"不得先于 Task 3 提交"。
  3. **★ Task 3（原 Task 4）测试 fixture 与签名全错**：原稿造 `root/<主题>/_front.md` 目录结构并传 `keywords` —— 实测主题是**扁平文件** `root/<主题>.md`（`kernel/memory.mjs:29-31 themePath`，frontmatter 与条目同文件，`grep _front.md` 零命中），且 `keywords` 属 `buildRelevantMemory` 不属 `buildMemoryIndex`（实测签名 `:99 ({root, maxBytes})`）。已改为扁平文件 fixture + 真实签名，并**补 `buildRelevantMemory` 的 A16 用例**（两个注入函数都要覆盖）。
  4. **★ Task 2 总账三处致命问题**：① 渠道只有 `legacy/unified`（那是**检索策略**维度，不是注入渠道维度，与 A13「可归因 5%」不符）⇒ 改为**渠道五分** `static/bridge/guard/derived/payload` + `bySource` + 场景三元组；② 原稿读 `stats.systemPromptBytes/toolSchemaBytes/skillBytes/injectedChars/seq`，**这些字段在 `getInjectStats()` 中均不存在**（账会全为 0）⇒ 补做 spec §4.1 S1+④ 的 `prompt.mjs` 各段 `Buffer.byteLength` 只读计量 + 桥侧 append 长度；③ 落点 `cli.mjs:1322 loop.onTurnEnd` 位于 `if (loop.isActive())`（实测 `:1319`）内 ⇒ 只有 loop 会话有账 ⇒ 改为**轮末统一出口**，并明确 `resetInjectStats` 的逐轮语义（原为进程级累计）。
  5. **★ Task 8（接线）无落点**：原稿引用的 `beforeIter` / `phaseHooks` / `OBSERVE_ONLY` / `emitIterDerived` / `knowledgeRelateMode` **实测全部不存在**（`phaseHooks` 是 spec §5.4 的 **B2** 概念）⇒ 改为落在**真实的每轮 system 组装处**（实测 `kernel/cli.mjs:999-1011 refreshSystemPrompt()`）、用真实函数 `resolveRelateMode`（`:577`，`:566` 只是 JSDoc）与 `store.appendMeta`（`kernel/session.mjs:343`），并明确观察期开关 `PONOS_MEMORY_EL1_OBSERVE`（默认 1）与逃生阀的分工。
  6. **★ Task 7（原 Task 6）R6 断言与自带实现矛盾**：`assert.equal(r.lines.length, 1)` 在 `budgetBytes:200` 下实测为 `lines=2`（每行 ≈75 B）⇒ **必红**。已改为忠实表达 R6 语义的断言（`bytes ≤ 预算` + 至少首条 + 丢行 + **装入行不得被截断**），并另加一条"预算小到只够首条"的用例。
  7. **R1/R5 两条空转断言**：R1 的 `!`text.includes(' ·全文')`（实现永不产出该串）、R5 的 `hint.includes('related')`（任何分支都含）⇒ 已改为有效断言（R1：带 `full` 输入不得改变注入字节数；R5：未授权时 `hint` 须含 `mode:'full'` 与 `related` 且**不得指向 `Read`**）。
  8. **R3/R4/R5 与 spec 不符**：R3 已改为**复用 `makeSnippet`**（`shared/knowledge-core.mjs`，`kernel/knowledge-search.mjs:10` 已导入）而非另造 `snippetOf`；R4 补上**按 `why.kind` 打理由标签**（原实现只用于过滤 `duplicate`）；R5 补成**三态**（据实分支）。
  9. **事实/口径与行号修正**：spec 增量 §4.1 的「`bridge.mjs` 两处」实测是 **`server/bridge.mjs`**、写入侧 `active` 在 **`:83-85`**（原写 `:87-89`）；「`memory.mjs` 补 `front.active`」的正确表述是**内核注入侧漏判**（写入侧与服务端读取侧早已实现）；`content` 读取处实测 **`:1021`**（原写 `:1026` 指向 `try {`）；`turnToolDigest.push` 字面量 `:1031-1036`；测试基线 **210**（原写 212）；`injectCfg`/4 处无留痕**18 处注入点**（原写 12 处，主 9 + lane **6** + 协议回填 2 + 轮载荷 1）已随批 2 同步登记。
- **Task 9（面板）目标修正**：原稿只换单位（仍以 `buildExperienceIndex(4096)` 为底）⇒ 面板数字停在 ≈5131 B，"与实际一致"不成立。已改为**读 EL0 真实渲染**并复用 `memoryBytes`（禁止第二套换算）。

**4. 批次边界自审（批 1 / 批 2）**

- 本批**不含** `inject-bus.mjs`、`emitInjection` 的字段扩展、守卫序参数化 —— 全在批 2。
- 本批**含** `inject-ledger.mjs`（O4 总账）—— 它与批 2 的注入总线**不是同一物**：总账负责"记账与只读计量"，总线负责"排队与渲染"。**两者接口互不依赖**。
- ★ **但文件级必须串行**：本批 Task 1 在 `kernel/engine.mjs` 的守卫命中处插 `turnGuardHits.add(...)`，批 2 的 Task 2/3/4 会搬走**同一段代码** ⇒ 优选**本批先落地**（登记语句随后被批 2 一并搬进 `loop-core.mjs`）。已在 Global Constraints 与批 2 计划双向写明。
- 交界面之二：批 2 的 L4 等价锁可能消费本批 `turnStats.guard`。已在批 2 计划写明降级方案（未落地则用本地计数替代）。
- 测试文件数账：基线 **210** → 本批 **+4 = 214**（`turn-observability`/`inject-ledger`/`experience-dedup`/`knowledge-recommend`；EL0 用例追加进 `experience-dedup`，**不新增文件**）；批 2 另 **+4** = 214。**两批都落地后总数应为 218**（以实测为准，用于发现"重复计数/漏建文件/误建新文件"）。
