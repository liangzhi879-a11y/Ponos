# B1 循环体契约实施计划（批 2：S2 + S3 + S3.5）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把主循环与子 lane 的守卫序收敛为一份共享循环体契约，并把散在 **18 处**的指令注入收敛到一条注入总线——**全部是零行为变更的等价重构**，作为后续模式/方法论等行为变更的地基。

> ★ **口径修正（实测）**：主 spec §12.1 与注入 spec §2.4 都写"12 处"。**实测为 18 处**：
> 主循环 **9** + 子 lane **6**（`store.appendUser` @ `engine.mjs:1579`/`:1731`/`:1763`/`:1776`/`:1825`/`:1841`）
> + 协议回填 **2**（`:927`/`:1073`）+ 轮载荷 **1**（`:2336 queueNext`，内部 `pushMemory` @ `:2360`）。
> 原写"12 处 = 9+3+2+1"算术本身不成立（=15），且 lane 被少算 3 处。**本计划按 18 处执行**；spec 的措辞属**欠计**，不改 spec，在此登记。

**Architecture:** 三部分，**独立交付、独立回滚**（批次划分见主 spec §12.1，及评估报告 §3.2 的"切香肠"建议）：
1. **S2**：新建 `kernel/loop-core.mjs` + `kernel/loop-profile.mjs`，把主循环的守卫序抽成**参数化 profile**（`iterHead`/`inStream`/`afterStream` 三段），并由 `ctx.emitInjection(text, {persist, event})` 承载**随守卫一起搬迁的**自愈注入——**零行为变更**。
2. **S3**：lane 复用同一守卫实现，传"简化档" profile（无 health/锚点/完整压缩；~300–350 行共享，~250 行刻意差异保留）。
3. **S3.5**：新建 `kernel/inject-bus.mjs`，把**剩余注入点**（主循环未搬迁的 + lane **6** 处 + 协议回填 2 处 + 轮载荷 1 处）改走同一出口，并**此时才**引入 `priority`/`budgetBytes`/`kind`/`phase`。

> **为什么 S2/S3 与 S3.5 合成一批交付**：三者都是"等价重构"，共用同一套回归锁（L1/L2/L3/L4）与同一份评审输入；且 S3.5 依赖 S2 建立的出口。批 1（S1/S1+/S4.5）是纯增量与纯删减，与本批**无依赖**，故独立成计划（见 `2026-09-20-batch1-observable-and-experience-dedup.md`）。

**Tech Stack:** Node.js ESM（`.mjs`）、`node:test` + `node:assert/strict`、现有 `createEngine`/`createSessionStore`/`createCompactor`、`npm run test:kernel`。

## Global Constraints

以下为项目级硬约束，**每个任务的要求都隐含包含本节**；数值与措辞逐字来自 spec，不得改写：

- **B1 冻结面**：S2/S3 阶段 `ctx.emitInjection(text, { persist, event })` —— **只冻结这三项**。`priority`/`budgetBytes`/`kind`/`phase` **由 S3.5（Task 7）才引入**；S2 阶段 `emitInjection` **必须拒绝**这四个字段并抛错（Task 1 的测试断言了这一点，**Task 7 须同步更新该断言**）。
- **命名纪律（只有一套语义，两种形态）**：唯一注入出口是 **`ctx.emitInjection(text, meta)`**（调用形态）。
  - `loop-core.mjs` **内部保留自由函数** `emitInjection(ctx, text, meta)`，并由 `runOnce` 把它挂成 `ctx.emitInjection`（`const emit = (t, m) => emitInjection(ctx, t, m)`）——**自由函数仅供模块内部与单测使用**，业务代码一律走 `ctx.emitInjection`。
  - **禁止**给出口起名 `ctx.inject`（与 `LoopProfile.inject` 字段语义冲突）。
  - Task 2 Step 5/6 的示例必须只出现 `ctx.emitInjection(...)` 这一种调用形态；自由函数名不得出现在 `engine.mjs`。
- **零行为变更**：S2/S3/S3.5 全是**等价重构**。提示词字节、wire 事件序列、`turnToolDigest`、`turnStats`、守卫触发时机与文案**全部不变**。发现的 bug **另开 issue，不在本计划内顺手修**。
- **S3.5 的"不做什么"（逐字取自注入 spec §4.1）**：**只做等价搬移**；**不补事件**（4 处 `event: null` **如实保留**——补事件是行为变更）；**不统一 lane 与主循环的注入语义**（"刻意不同的 250 行"须保持：lane 不注册锚点渲染器、`pendingNext`/`inbox` 仍走 profile 开关）。
- **`withAnchorTail` 相位**：注册为 `beforeRequest` 相位的 **`derived`** 渲染器（纯派生，不改 `requestFace` 缓存对象）。⚠️ 实施前先 Read 核实行号。
- **守卫计数器语义**：搬迁**不清零** `errorStreak`/`repeatStreak`/`stallHeals`/`attemptMaxTokens`（防"守卫预算重置"被反复利用规避熔断）。**计数清零规则按原实现照搬**，不得"顺手统一"。
- **回归锁**：L1 现有测试全绿且**数量不变**；L2 守卫命中用例（文案/事件/计数/收尾时机逐一不变）；L3 mock 会话回放（digest/turnStats/wire 序列一致）；**L4 双重等价**（注入**文本 + wire 事件序列**）**并加 `PONOS_LOOP_GUARD=0` 对照组**（Task 7 落地）。
- **文件暂存纪律**：**禁止 `git add -A`**（常态数十项他人在途改动）。按文件精确 `git add <path>`。
- **既有验证器契约**（改动后必须仍绿）：
  - `npm run verify:experience-inject` —— 断言 `buildExperienceIndex(4096)` 存在且 `buildSedimentPrompt` 含"经验沉淀"（**经验注入已从全量迁移为索引**；本批**不动**它）。
  - `npm run verify:milestones-start` —— 断言 `extractMilestoneMarks`（`server/milestones.mjs`）**仅解析**。

### 交付前门禁（每条都不能省）

```bash
npm run test:kernel                                     # 内核测试全绿（实测基线 210 个 .test.mjs 文件，不得减少）
npm run kit:check                                       # 红 0（EXIT=0）
node --test --test-timeout=120000 "kit/**/*.test.mjs"    # ★ 引号必须有，否则静默漏测
npm run verify:ci                                       # EXIT=0
npm run verify:experience-inject                        # 经验注入契约未破
npm run verify:milestones-start                         # milestone 解析契约未破
```

> ★ 引号不是风格问题：不加引号时 shell 把 `**` 当单个 `*` ⇒ **静默漏掉** `kit/cli.test.mjs` 与 `kit/gui.test.mjs`。

## 范围与非范围

**本计划实现**：`S2`（B1 契约与守卫序参数化）、`S3`（lane 复用）、**`S3.5`（注入总线抽取）**。

**明确不在本计划**：
- `S1` / `S1+` / `S4.5`（观测层 O1–O4 + 经验去重）—— 属**批 1**，见 `2026-09-20-batch1-observable-and-experience-dedup.md`。本批与之**无依赖**，可并行。
  - 唯一交界面：Task 7 的 L4 等价锁会用到 O2 的 `turnStats.guard`（若批 1 尚未落地，则 Task 7 用**本地计数**替代，并在评审时说明）。
- `S4`–`S11`（模式、方法论下沉、三层化）—— 行为变更，待 B1 交付并评审后另立计划。
- **不修任何既有 bug**（搬迁中发现的一律记录到 `docs/superpowers/audits/` 或 issue）。

### Q1 接口冻结的解读（务必按此实现，避免与 spec 打架）

spec 有两处表述需要统一理解：
- 注入 spec §9 Q1(a)：**B1 搬迁时即以 `ctx.emitInjection(text, { persist, event })` 为唯一注入出口**。
- 主 spec §12.1 S3.5 行：**"12 处指令注入改走 `ctx.emitInjection`"** —— ★ 实测为 **18 处**（见 Goal 下的口径修正），本计划按 18 处执行。

**本计划的统一解读**（与 spec 的"B1 冻结面最小化"一致）：

| 阶段 | 做什么 |
|---|---|
| **S2/S3（Task 1–6）** | 在 `loop-core.mjs` 内**建立出口**，并把**随守卫逻辑一起搬迁进 loop-core 的注入调用**改走该出口（等价）。**不改**未搬迁的注入点，**不建总线模块**，**不引入**四个扩展字段（且 `emitInjection` 明确拒绝它们）。 |
| **S3.5（Task 7）** | 新建 `kernel/inject-bus.mjs`、注册渲染器（含 `withAnchorTail` 作 `beforeRequest` 相位 `derived` 渲染器）、引入 `priority`/`budgetBytes`/`kind`/`phase`、把**剩余注入点**改走出口。 |

**净效果**：S3.5 的"改 18 个点"退化为"换实现 + 加注册"，正是 Q1 的意图。

> ⚠️ **与批 1 的串行纪律**：批 1 的 Task 1（O2 守卫登记）要在 `engine.mjs` 的**守卫命中处**逐处插 `turnGuardHits.add(...)`，而本批 Task 2/3/4 会把**同一段代码**搬进 `loop-core.mjs` ⇒ **两批对 `engine.mjs` 的改动必须串行**：
> - 优选：**批 1 先落地**（登记语句跟着守卫一起被搬进 `loop-core.mjs`，本批搬迁时一并带走）；
> - 若本批先落地：批 1 的登记点要改到 `loop-core.mjs` 的守卫体内（**不是** `engine.mjs`），且 `turnGuardHits` 要经 `ctx` 传入。
> 「无依赖可并行」仅指**接口无依赖**，**文件级改动仍须串行**。

**剩余注入点清单（Task 7 的对象，逐处核实自注入 spec §2.4）**：

| # | 位置 | 数量 |
|---|---|---|
| 1 | 主循环未随守卫搬迁的注入点 | 9 − 已搬迁数 |
| 2 | 子 lane 注入 | **6**（`store.appendUser` @ `engine.mjs:1579`/`:1731`/`:1763`/`:1776`/`:1825`（同工具提醒）/`:1841`（熔断）） |
| 3 | 协议回填 | 2（`engine.mjs:927`/`:1073` 附近） |
| 4 | 轮载荷 | 1（`engine.mjs:2336` `queueNext`） |

> ⚠️ 上表行号来自注入 spec §2.4，**Task 7 Step 1 必须重新核实**（本批前面的搬迁会移动行号）。

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `kernel/loop-core.mjs` | **新建**。循环体契约：守卫实现 `runIterHeadGuards`/`runInStreamGuards`/`runAfterStreamGuards`、`emitInjection(ctx, text, meta)`（唯一出口）、`runOnce`/`shouldStop`。**不引用 engine 闭包**（依赖全走 `ctx`）。 | 新建 |
| `kernel/loop-profile.mjs` | **新建**。`LoopProfile` 定义与校验：`MAIN_PROFILE` / `LANE_PROFILE` / `validateProfile()` / `resolveGuards()`。纯数据 + 纯函数。 | 新建 |
| `kernel/inject-bus.mjs` | **新建（Task 7 / S3.5）**。注入总线：3 相位 `beforeIter`/`inStream`/`beforeRequest`；class 二分 `protocol`/`directive`；渲染器注册位。纯函数。 | 新建 |
| `kernel/engine.mjs` | 主循环改由守卫契约 + `MAIN_PROFILE` 驱动（等价搬移，分 3 次提交）；lane 改由同一实现 + `LANE_PROFILE` 驱动；剩余注入点改走总线。 | 修改（大） |
| `kernel-tests/loop-core-contract.test.mjs` | **新建**。契约单元测试（纯函数、不需要 mock API）。 | 新建 |
| `kernel-tests/loop-guard-order-equivalence.test.mjs` | **新建**。L2/L4 守卫序与注入等价锁。 | 新建 |
| `kernel-tests/loop-lane-profile.test.mjs` | **新建**。lane 刻意差异钉成契约。 | 新建 |
| `kernel-tests/inject-bus.test.mjs` | **新建（Task 7）**。总线相位/class/渲染器注册单测。 | 新建 |
| `kernel-tests/fixtures/*.golden.json` | **新建**。L2/L3/L4 的 golden 基线（**重构前录制**，必须提交）。 | 新建 |

**新建文件的边界理由**：`loop-core` 只做"一轮迭代怎么跑"，`loop-profile` 只做"参数长什么样/是否合法"，`inject-bus` 只做"注入怎么排队与渲染"。三者互不依赖对方内部，各自可单测。

---

## Task 1: S2a —— `loop-core.mjs` 契约骨架与 `LoopProfile`

**Files:**
- Create: `kernel/loop-profile.mjs`
- Create: `kernel/loop-core.mjs`
- Test: `kernel-tests/loop-core-contract.test.mjs`

**Interfaces:**
- Consumes: 无（纯新建；不 import `engine.mjs`）。
- Produces:
  - `MAIN_PROFILE` / `LANE_PROFILE`（`LoopProfile` 常量）
  - `validateProfile(profile) → { ok: boolean, errors: string[] }`
  - `resolveGuards(profile, phase) → string[]`（`phase ∈ 'iterHead'|'inStream'|'afterStream'`）
  - `emitInjection(ctx, text, meta) → void`（**唯一注入出口**，冻结 `text`/`persist`/`event`）
  - `runOnce(state, ctx) → Promise<LoopState>`（本任务只建骨架，返回未变更 state）
  - `shouldStop(state, ctx) → null | { reason, message }`

### 背景（实现者必读）

本任务**只建契约与纯函数**，**不碰 engine.mjs**。这样 Task 2–4 的搬移有稳定目标，且契约本身可独立单测。

**守卫清单（已核实锚点，主循环 `kernel/engine.mjs`）**：

| 相位 | 守卫 | 锚点（实测） | 收尾方式 |
|---|---|---|---|
| `iterHead` | ① 轮次墙钟 | `:486-494` | `loopStop` → break |
| `iterHead` | ② 迭代硬上限 | `:495-496` | `iterCapHit` → break |
| `iterHead` | ⑥ 无进展停滞 | `:497-515`（含 `:516 if (loopStop) break`） | `loopStop` → break |
| `inStream` | ①b 流内墙钟 | `:620-629` | `loopStop` |
| `inStream` | ③ 生成重复 | `:630-642` | 内部自愈注入 |
| `inStream` | ③b 句级近重复 | `:643-662` | 内部自愈注入 |
| `inStream` | 上游死亡 | `:694` 附近 | `loopStop` |
| `afterStream` | R3-2 生成重复自愈 | `:899-912` | 自愈注入（`REPEAT_HEAL_MAX`） |
| `afterStream` | ④ 熔断 | `:1066-1075` | 自愈注入 |
| `afterStream` | ⑥ 进展刷新 | `:1076-1082` | **计数刷新，无注入**（`if (madeProgress) { lastProgressAt = Date.now(); stallHeals = 0 }`）——★ 不是注入点，不得当成"自愈注入"计数 |
| `afterStream` | ⑤ 同工具提醒 | `:1083-1090` | 自愈注入（不 veto） |
| `afterStream` | 熔断收尾 | `:1122` | `loopStop` |
| 收尾 | 终结判定 | `:1139 if (loopStop \|\| iterCapHit)` | finalize |

**已核实的守卫 → `wire` 事件 reason 对照表**（等价搬移时**必须逐字保留**，写错就等于改了可观测行为）：

| 守卫 | 触发时的事件 | reason 字面值 |
|---|---|---|
| ⑥ 无进展停滞 | `wire.system('guard_heal', {reason, attempt, max})` | `'loop-stall'`（`:507`） |
| 空闲看门狗 | `guard_heal` | `'idle-interrupted'`（`:690`） |
| 上游死亡 | `guard_heal` | `'upstream-dead'`（`:729`） |
| R3-2 生成重复自愈 | `guard_heal` | `healReason`（**变量**，`:909`） |
| ④ 熔断 | `guard_heal` | `'error-meltdown'`（`:1118`） |
| ① 轮次墙钟 | **不发 `guard_heal`**；置 `loopStop` | `loopStop.reason = 'timeout'`（`:489`） |
| ② 迭代硬上限 | **不发事件**；置 `iterCapHit = true` | — |

> ★ 注意：守卫①的 env 变量是 **`PONOS_TURN_TIMEOUT_MS`**（不是 `WALL_CLOCK`），其 `reason` 是 **`'timeout'`**（不是 `'wall-clock'`）。守卫②**不发任何事件**。搬移时以实测为准。

> **锚点是给你定位用的，不是契约**。开工第一步必须**重新核实行号**（Task 2 Step 1 给了命令）；行号漂移以实测为准。

- [ ] **Step 1: 写失败测试**

`kernel-tests/loop-core-contract.test.mjs`：

```js
// 循环体契约（S2/B1）：profile 校验、守卫序解析、注入出口形状
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAIN_PROFILE, LANE_PROFILE, validateProfile, resolveGuards,
} from '../kernel/loop-profile.mjs'
import { emitInjection, runOnce, shouldStop } from '../kernel/loop-core.mjs'

test('MAIN_PROFILE / LANE_PROFILE 合法', () => {
  assert.equal(validateProfile(MAIN_PROFILE).ok, true)
  assert.equal(validateProfile(LANE_PROFILE).ok, true)
})

test('validateProfile 拒绝未知相位与未知守卫', () => {
  const bad = { guards: { iterHead: ['wallClock', '不存在'], inStream: [], afterStream: [] } }
  const r = validateProfile(bad)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('不存在')))
})

test('validateProfile 拒绝缺失相位', () => {
  const r = validateProfile({ guards: { iterHead: [] } })
  assert.equal(r.ok, false)
})

test('resolveGuards 返回副本，外部改动不回写 profile', () => {
  const g = resolveGuards(MAIN_PROFILE, 'iterHead')
  g.push('hacked')
  assert.ok(!resolveGuards(MAIN_PROFILE, 'iterHead').includes('hacked'))
})

test('resolveGuards 对未知相位抛错（早失败优于静默）', () => {
  assert.throws(() => resolveGuards(MAIN_PROFILE, 'nope'), /unknown phase/)
})

test('LANE_PROFILE 的刻意差异只在 compactor/health/inject/stop —— 守卫集与主循环相同', () => {
  // 差异（spec §6.2 明列的四项 + 收尾方式）
  assert.equal(LANE_PROFILE.health.fidelityAnchor, false)
  assert.equal(LANE_PROFILE.compactor.preStep, false)
  assert.equal(LANE_PROFILE.inject.pendingNext, false)
  assert.equal(LANE_PROFILE.inject.inbox, true)
  assert.equal(LANE_PROFILE.stop, 'guardStop')
  // ★ 守卫集**不**是差异：lane 与主循环逐项同集（实测 engine.mjs:1505-1862）
  for (const phase of ['iterHead', 'inStream', 'afterStream']) {
    assert.deepEqual(
      resolveGuards(LANE_PROFILE, phase),
      resolveGuards(MAIN_PROFILE, phase),
      `lane 的 ${phase} 守卫集必须与主循环相同（漏一个 = 静默丢守卫）`,
    )
  }
})

test('★ runOnce 按 profile 相位顺序驱动（A2「一处实现」的载体）', async () => {
  const order = []
  const ctx = {
    profile: MAIN_PROFILE,
    pushInjection: () => {},
    async streamOnce() { order.push('stream'); return { ok: true } },
  }
  // Task 2–4 会实现守卫体；本任务阶段用 try/catch 观察"相位 1 先于取流"
  try { await runOnce({}, ctx) } catch { /* 守卫体未实现：Task 1 阶段预期抛错 */ }
  assert.deepEqual(order, [], '相位 1 命中/抛错时不应进入 streamOnce（顺序正确性）')
})

test('★ runOnce：守卫体未实现时抛错而非静默跳过（防"漏实现=静默失效"）', async () => {
  const ctx = { profile: MAIN_PROFILE, pushInjection: () => {}, async streamOnce() { return {} } }
  await assert.rejects(() => runOnce({}, ctx), /未实现/)
})

test('shouldStop：无 stop 返回 null，有 stop 时规范化 reason', () => {
  assert.equal(shouldStop({}), null)
  assert.deepEqual(shouldStop({ stop: { reason: 'loop-stall', message: 'm' } }), { reason: 'loop-stall', message: 'm' })
  assert.deepEqual(shouldStop({ stop: {} }), { reason: 'unknown', message: undefined })
})

test('emitInjection 冻结 text/persist/event：拒绝扩展字段', () => {
  const seen = []
  const ctx = { emitInjection: null, wire: { system: () => {} } }
  // 出口由 loop-core 注入到 ctx 上；这里直接测形状校验函数
  assert.throws(
    () => emitInjection(ctx, 'x', { persist: false, event: null, priority: 1 }),
    /unknown option: priority/,
  )
})

test('emitInjection 记录到 ctx 注入缓冲，persist 语义透传', () => {
  const buf = []
  const ctx = { pushInjection: (text, meta) => buf.push({ text, ...meta }) }
  emitInjection(ctx, '自愈：继续', { persist: true, event: { reason: 'wall-clock' } })
  assert.equal(buf.length, 1)
  assert.equal(buf[0].text, '自愈：继续')
  assert.equal(buf[0].persist, true)
  assert.equal(buf[0].event.reason, 'wall-clock')
})

test('emitInjection 无 pushInjection 时静默（不抛错、不阻断主流程）', () => {
  assert.doesNotThrow(() => emitInjection({}, 'x', { persist: false, event: null }))
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test --test-timeout=120000 kernel-tests/loop-core-contract.test.mjs
```

Expected: FAIL —— 找不到 `../kernel/loop-profile.mjs`。

- [ ] **Step 3: 写 `kernel/loop-profile.mjs`**

```js
// LoopProfile（S2/B1）：主循环与 lane 的参数化面
// ---------------------------------------------------------------------------
// 设计要点（spec §6.1）：
//   · 只参数化\"守卫序 + 注入面 + 收尾方式\"，不参数化业务逻辑
//   · lane 的 250 行刻意差异（无 health / 无锚点 / 无完整 preStep）在 profile 里
//     显式表达为 false，而不是靠\"不传就是没有\"——否则差异会变成隐形假设
//   · validateProfile 早失败：未知守卫名/未知相位一律拒绝（避免拼错守卫名后静默失效）

/** 允许的守卫名（与 engine.mjs 现有守卫逐一对齐；**主循环与 lane 同集**，见下方 profile 说明） */
export const KNOWN_GUARDS = new Set([
  // iterHead
  'wallClock', 'iterCap', 'stall',
  // inStream
  'streamWallClock', 'genRepeat', 'nearRepeat', 'idleDeadRetry', 'upstreamDead',
  // afterStream
  'repeatHeal', 'failureHeal', 'progressRefresh', 'repeatReminder', 'meltdownStop',
])

/** 允许的注入相位（S3.5 才扩 priority/budgetBytes/kind/phase；此处只列相位） */
export const PHASES = ['iterHead', 'inStream', 'afterStream']

/**
 * @typedef {object} LoopProfile
 * @property {{iterHead: string[], inStream: string[], afterStream: string[]}} guards
 * @property {{preStep: boolean, laneCompact: boolean}} compactor
 * @property {{fidelityAnchor: boolean, recordTurnContent: boolean}} health
 * @property {{pendingNext: boolean, inbox: boolean}} inject
 * @property {'loopStop'|'guardStop'} stop
 */

/** @type {LoopProfile} 主循环：全量守卫 + health + 锚点 + 完整压缩 */
export const MAIN_PROFILE = {
  guards: {
    iterHead: ['wallClock', 'iterCap', 'stall'],
    inStream: ['streamWallClock', 'genRepeat', 'nearRepeat', 'idleDeadRetry', 'upstreamDead'],
    afterStream: ['repeatHeal', 'failureHeal', 'progressRefresh', 'repeatReminder', 'meltdownStop'],
  },
  compactor: { preStep: true, laneCompact: false },
  health: { fidelityAnchor: true, recordTurnContent: true },
  inject: { pendingNext: true, inbox: false },
  stop: 'loopStop',
}

/** @type {LoopProfile} lane：**守卫集与主循环相同**；差异只在 compactor/health/inject/stop */
export const LANE_PROFILE = {
  // ★ 实测（2026-09-20，engine.mjs:1505-1862）lane 的守卫与主循环**逐项同集**：
  //   iterHead  ① 轮次墙钟(:1570) ⑥ 停滞自愈(:1575，注入续跑) ② 迭代上限(:1594)
  //   inStream  ①b 流内墙钟(:1648) ③ gen-repeat(:1654) ③b near-repeat(:1659)
  //             idleDeadRetry(:1677) 上游空流/死亡(:1696/:1714) → 流外自愈收尾(:1726)
  //   afterStream ⑥ 进展刷新(:1805，**计数清零无注入**) ⑤ 同工具提醒(:1825，repeatRemindText)
  //               ④ 熔断(:1841 errorMeltdownText('lane') / :1851 meltdownNotice)
  // ⚠️ 此前的草稿把 inStream 写成"无 nearRepeat"、afterStream 写成"仅有 repeatHeal/failureHeal"
  //    ⇒ 那是**错的**，照那样实现会**静默丢掉 lane 的 4 个守卫**（③b/⑥/⑤/④）。已按实测修正。
  guards: {
    iterHead: ['wallClock', 'iterCap', 'stall'],
    inStream: ['streamWallClock', 'genRepeat', 'nearRepeat', 'idleDeadRetry', 'upstreamDead'],
    afterStream: ['repeatHeal', 'failureHeal', 'progressRefresh', 'repeatReminder', 'meltdownStop'],
  },
  compactor: { preStep: false, laneCompact: true },
  health: { fidelityAnchor: false, recordTurnContent: false },
  inject: { pendingNext: false, inbox: true },
  stop: 'guardStop',
}

/**
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateProfile(profile) {
  const errors = []
  if (!profile || typeof profile !== 'object') return { ok: false, errors: ['profile 不是对象'] }
  const g = profile.guards
  if (!g || typeof g !== 'object') return { ok: false, errors: ['缺少 guards'] }
  for (const phase of PHASES) {
    if (!Array.isArray(g[phase])) {
      errors.push(`缺少相位或不是数组: ${phase}`)
      continue
    }
    for (const name of g[phase]) {
      if (!KNOWN_GUARDS.has(name)) errors.push(`未知守卫: ${name}（相位 ${phase}）`)
    }
  }
  for (const key of Object.keys(g)) {
    if (!PHASES.includes(key)) errors.push(`未知相位: ${key}`)
  }
  if (!['loopStop', 'guardStop'].includes(profile.stop)) errors.push(`未知 stop: ${profile.stop}`)
  return { ok: errors.length === 0, errors }
}

/** 取某相位的守卫序（副本，防外部回写 profile） */
export function resolveGuards(profile, phase) {
  if (!PHASES.includes(phase)) throw new Error(`unknown phase: ${phase}`)
  return [...(profile?.guards?.[phase] || [])]
}
```

- [ ] **Step 4: 写 `kernel/loop-core.mjs`**

```js
// 循环体契约（S2/B1）
// ---------------------------------------------------------------------------
// 边界纪律（spec §6.4）：本模块**不得引用 engine.mjs 的闭包**。
// 一切外部依赖走 ctx 显式注入——否则\"等价重构\"会变成\"隐式耦合搬家\"。
//
// B1 冻结面（最小化）：ctx.emitInjection(text, { persist, event })
//   priority / budgetBytes / kind / phase 由 S3.5 引入，本阶段**必须拒绝**，
//   以免调用方提前依赖未定形状。

const ALLOWED_INJECTION_OPTIONS = new Set(['persist', 'event'])

/**
 * 唯一注入出口（B1 冻结面）。
 * @param {object} ctx  需含 pushInjection(text, meta)（由宿主提供）
 * @param {string} text 注入文本
 * @param {{persist: boolean, event: object|null}} meta
 */
export function emitInjection(ctx, text, meta = {}) {
  for (const k of Object.keys(meta || {})) {
    if (!ALLOWED_INJECTION_OPTIONS.has(k)) throw new Error(`unknown option: ${k}`)
  }
  const fn = ctx && typeof ctx.pushInjection === 'function' ? ctx.pushInjection : null
  if (!fn) return  // 无缓冲时静默：记账/注入失败绝不能阻断主流程
  fn(String(text), {
    persist: meta.persist === true,
    event: meta.event || null,
  })
}

/**
 * 一轮迭代的执行体（B1 契约，spec §6.1 / A2）。
 *
 * ★ 设计要点（这是"一处实现"的载体，**不是** no-op 骨架）：
 *   · 主循环与 lane **都调本函数** —— 差异只由 `ctx.profile` 表达
 *   · 本函数**不引用 engine 闭包**：IO 走 `ctx.streamOnce`，注入走 `ctx.emitInjection`
 *   · 按 profile 的相位顺序驱动三段守卫；任一守卫命中即返回 `stop`
 *   · 返回形状固定：`{ state, stop }`，`stop` 为 `null` 或 `{ reason, message? }`
 *
 * Task 2–4 逐相位填 `runIterHeadGuard`/`runInStreamGuard`/`runAfterStreamGuard` 的守卫体；
 * 本任务只把**编排顺序与契约**固定下来（用 spy 测相位顺序）。
 */
export async function runOnce(state, ctx) {
  const emit = (text, meta) => emitInjection(ctx, text, meta)
  const phaseCtx = (extra) => ({ ...ctx, emit, ...extra })

  // 相位 1：迭代前守卫（① 墙钟 / ⑥ 停滞 / ② 迭代上限）
  for (const name of resolveGuards(ctx.profile, 'iterHead')) {
    const stop = await runIterHeadGuard(name, state, phaseCtx())
    if (stop) return { state, stop }
  }

  // 相位 2：流内守卫（①b 流内墙钟 / ③ gen-repeat / ③b near-repeat / idleDeadRetry / upstreamDead）
  const streamed = await ctx.streamOnce(state, phaseCtx())
  for (const name of resolveGuards(ctx.profile, 'inStream')) {
    const stop = await runInStreamGuard(name, state, phaseCtx({ streamed }))
    if (stop) return { state, stop }
  }

  // 相位 3：流后守卫（⑥ 进展刷新 / ③自愈 / ⑤ 提醒 / ④ 熔断）
  for (const name of resolveGuards(ctx.profile, 'afterStream')) {
    const stop = await runAfterStreamGuard(name, state, phaseCtx({ streamed }))
    if (stop) return { state, stop }
  }

  return { state, stop: null }
}

// —— 三段守卫的相位分发器（Task 2–4 逐个补守卫体；未实现的守卫名一律抛错，避免静默漏守卫）——

async function runIterHeadGuard(name, state, ctx) {
  void name; void state; void ctx
  throw new Error(`runIterHeadGuard 未实现: ${name}（Task 2 补齐）`)
}

async function runInStreamGuard(name, state, ctx) {
  void name; void state; void ctx
  throw new Error(`runInStreamGuard 未实现: ${name}（Task 3 补齐）`)
}

async function runAfterStreamGuard(name, state, ctx) {
  void name; void state; void ctx
  throw new Error(`runAfterStreamGuard 未实现: ${name}（Task 4 补齐）`)
}

/**
 * 循环终止判定（B1 契约）。
 * 收尾方式因宿主而异：主循环 `loopStop` + break；lane `guardStop` return。
 * @returns {null | {reason: string, message?: string}}
 */
export function shouldStop(state, ctx) {
  const s = state?.stop
  if (!s) return null
  return { reason: String(s.reason || 'unknown'), message: s.message }
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
node --test --test-timeout=120000 kernel-tests/loop-core-contract.test.mjs
```

Expected: PASS（9 个用例）。

- [ ] **Step 6: 确认未触碰 engine**

```bash
cd /c/Users/T203-15/yfworking && git status --short kernel/engine.mjs kernel/cli.mjs
```

Expected: **空输出**（本任务严禁改 engine.mjs / cli.mjs）。

- [ ] **Step 7: 提交**

```bash
cd /c/Users/T203-15/yfworking
git add kernel/loop-profile.mjs kernel/loop-core.mjs kernel-tests/loop-core-contract.test.mjs
git commit -m "feat(loop): S2a 循环体契约骨架 —— LoopProfile + emitInjection 冻结面

- kernel/loop-profile.mjs：MAIN/LANE profile + validateProfile + resolveGuards（纯函数）
- kernel/loop-core.mjs：emitInjection(text,{persist,event}) 唯一注入出口 + runOnce/shouldStop 骨架
- 出口冻结面最小化：只 text/persist/event；priority/budgetBytes/kind/phase 留给 S3.5（未知项抛错）
- lane 刻意差异（无 health/锚点/完整 preStep）在 profile 显式表达，不靠\"不传就是没有\"
- 边界纪律：loop-core 不得引用 engine 闭包，依赖全走 ctx
- 未触碰 engine.mjs / cli.mjs（本任务纯新建）"
```

---

## Task 2: S2b —— `iterHead` 守卫序参数化（第一次搬移）

**Files:**
- Modify: `kernel/engine.mjs`（`runTurnInternal` 的迭代头守卫，`:486-516` 附近）
- Modify: `kernel/loop-core.mjs`（新增 `runIterHeadGuards`）
- Test: `kernel-tests/loop-guard-order-equivalence.test.mjs`（新建）

**Interfaces:**
- Consumes: `resolveGuards(MAIN_PROFILE, 'iterHead')`（Task 1）、`emitInjection`（Task 1）。
- Produces:
  - `runIterHeadGuards(state, ctx) → Promise<{ stop: null | {reason, message}, state }>`
  - `kernel-tests/loop-guard-order-equivalence.test.mjs` 的 `makeHarness({ profileId })`（Task 2–4 复用）

### 背景（实现者必读）

这是 **B1 的第一次真搬移**，风险最高。纪律：

1. **等价搬移**——逻辑逐行照搬，**不重排、不合并条件、不改文案**。
2. **发现 bug 不修**——记进 `docs/superpowers/audits/` 或 issue，**不在本任务修**。
3. **分三次提交**（Task 2/3/4 各一次），任一步红了可单独回退。

- [ ] **Step 1: 重新核实锚点（只读）**

```bash
cd /c/Users/T203-15/yfworking
grep -n "守卫①\|守卫②\|守卫⑥\|iterCapHit\|loopStop = \|loopStop)" kernel/engine.mjs | sed -n '1,30p'
```

Expected: 定位到迭代头三个守卫的实际行号。**以实测为准**，spec 里的 `:486-516` 是参考值。

- [ ] **Step 2: 写失败测试（L2 等价锁骨架）**

`kernel-tests/loop-guard-order-equivalence.test.mjs`：

```js
// L2 守卫序等价锁（S2/B1）
// ---------------------------------------------------------------------------
// 目的：把\"守卫命中时的可观测后果\"钉死——防重构把守卫静默搬丢/搬错序。
// 断言四件事（spec L2）：注入文案、wire 事件、计数变化、收尾时机。
// 本任务只覆盖 iterHead；Task 3/4 扩充 inStream/afterStream。
process.env.PONOS_MOCK_API = '1'
const { createEngine } = await import('../kernel/engine.mjs')
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore } from '../kernel/session.mjs'

/** 建一个最小 harness：收集 wire 事件与注入，供各任务复用 */
export function makeHarness({ env = {} } = {}) {
  for (const [k, v] of Object.entries(env)) process.env[k] = String(v)
  const events = []
  const injections = []
  const wire = {
    assistant: () => {}, result: () => {}, controlRequest: () => {}, summary: () => {},
    health: () => {}, warning: () => {}, error: () => {},
    system: (subtype, payload) => events.push({ subtype, ...(payload || {}) }),
  }
  const dir = mkdtempSync(join(tmpdir(), 'guard-order-'))
  const session = createSessionStore({ configDir: dir, cwd: dir, sessionId: 'guard-order' })
  return { events, injections, wire, session, dir }
}

test('守卫名清单与 profile 声明一致（防拼错后静默失效）', async () => {
  const { MAIN_PROFILE, LANE_PROFILE, KNOWN_GUARDS } = await import('../kernel/loop-profile.mjs')
  const declared = new Set([
    ...MAIN_PROFILE.guards.iterHead, ...MAIN_PROFILE.guards.inStream, ...MAIN_PROFILE.guards.afterStream,
    ...LANE_PROFILE.guards.iterHead, ...LANE_PROFILE.guards.inStream, ...LANE_PROFILE.guards.afterStream,
  ])
  for (const name of declared) assert.ok(KNOWN_GUARDS.has(name), `${name} 应在 KNOWN_GUARDS`)
})

test('iterHead：wallClock 命中产生 loopStop 且不抛错', async () => {
  const { wire, session } = makeHarness({ env: { PONOS_TURN_TIMEOUT_MS: '1' } })
  const engine = createEngine({
    opts: { model: 'mock-model', addDirs: [session.cwd], skipPermissions: true, systemPrompt: '' },
    wire, session, compactor: null,
  })
  // 断言形状：守卫命中不得抛出，且 loopStop 语义可达（具体文案由 Task 2 Step 5 固化）
  assert.equal(typeof engine.runTurn, 'function')
})
```

> **说明**：上面第二个用例是**形状占位**，它的最终断言在 **Step 5 之后**用"重构前录制的 golden 值"替换（见 Step 3）。这样做的原因是：等价锁的正确做法是**先录基线再比对**，而不是凭记忆写期望值——否则测试本身就是猜测。

- [ ] **Step 3: 录制重构前基线（关键步骤）**

```bash
cd /c/Users/T203-15/yfworking
# 在未改 engine 的状态下，跑出守卫命中的可观测后果，存为 golden
node --test --test-timeout=120000 kernel-tests/loop-guard-order-equivalence.test.mjs 2>&1 | tail -20
git stash list   # 确认没有未提交改动干扰基线
```

**做法**：先写**录制器脚本**（**入库**，后续 Task 3/4/5/7 复用同一个），对三个 iterHead 守卫各构造一次命中，把 `{injections, events, turnStats}` 序列化到 `kernel-tests/fixtures/guard-order-iterhead.golden.json`。**该 golden 文件要提交**——它是等价锁的真值源。

`kernel-tests/fixtures/record-goldens.mjs`：

```js
// golden 录制器：把一次 mock 会话的注入/事件/观测序列落成基线文件。
// 用法（★ 重构前录一次并提交，之后即为"真值源"）：
//   PONOS_MOCK_API=1 node kernel-tests/fixtures/record-goldens.mjs guard-order-iterhead
//   PONOS_MOCK_API=1 node kernel-tests/fixtures/record-goldens.mjs guard-order-instream
//   PONOS_MOCK_API=1 node kernel-tests/fixtures/record-goldens.mjs guard-order-afterstream
//   PONOS_MOCK_API=1 node kernel-tests/fixtures/record-goldens.mjs session-replay
//   PONOS_LOOP_GUARD=0 PONOS_MOCK_API=1 node kernel-tests/fixtures/record-goldens.mjs inject-bus-l4-guardoff
//
// 说明：PONOS_MOCK_API=1 是仓库既有的幂等 mock 流（kernel/api.mjs:1676），测试零网络。
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const name = process.argv[2]
if (!name) { console.error('用法: node record-goldens.mjs <golden-name>'); process.exit(2) }
if (process.env.PONOS_MOCK_API !== '1') { console.error('必须设 PONOS_MOCK_API=1（幂等 mock 流）'); process.exit(2) }

// ★ 实施时按真实 API 补齐：用 createEngine/createSessionStore 跑一段确定性的 mock 轮次，
//   收集三类序列后落盘。三条序列**缺一不可**（否则 L2/L3/L4 无法判等价）：
//     injections —— 每次注入的 { text, phase, persist, event }
//     events     —— wire 事件序列（guard_heal / 收尾事件）
//     turns      —— [{ turnToolDigest, turnStats }]（L3 用；批 1 未落地时可省略）
const payload = { injections: [], events: [], turns: [] }   // ← 由实际会话填充
if (payload.injections.length === 0) {
  console.error('拒绝写出空基线：injections 为空 ⇒ 该 golden 无判等价能力'); process.exit(3)
}

writeFileSync(fileURLToPath(new URL(`./${name}.golden.json`, import.meta.url)), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
console.log(`已录制 fixtures/${name}.golden.json（injections=${payload.injections.length} events=${payload.events.length}）`)
```

```bash
mkdir -p kernel-tests/fixtures
PONOS_MOCK_API=1 node kernel-tests/fixtures/record-goldens.mjs guard-order-iterhead
```

Expected: 生成 golden 文件且 **`injections` 非空**（脚本会在空基线时 `exit 3` 拒绝写出）；`git status` 应显示 recorder 脚本与 golden 均为新文件。

- [ ] **Step 4: 把 golden 比对接进测试**

将 Step 2 的形状占位用例替换为真实比对：

```js
import { readFileSync } from 'node:fs'
const GOLDEN = JSON.parse(readFileSync(new URL('./fixtures/guard-order-iterhead.golden.json', import.meta.url), 'utf8'))

test('iterHead 守卫后果与基线逐字一致（L2）', () => {
  // 用 GOLDEN[guardName] 逐项比对 injections 文案、events 序列、计数变化
  assert.deepEqual(Object.keys(GOLDEN).sort(), ['iterCap', 'stall', 'wallClock'])
})

test('iterHead 守卫序固定为 wallClock → iterCap → stall', async () => {
  const { resolveGuards, MAIN_PROFILE } = await import('../kernel/loop-profile.mjs')
  assert.deepEqual(resolveGuards(MAIN_PROFILE, 'iterHead'), ['wallClock', 'iterCap', 'stall'])
})
```

```bash
node --test --test-timeout=120000 kernel-tests/loop-guard-order-equivalence.test.mjs
```

Expected: PASS（基线已录，此刻尚未改 engine，故必然一致）。

- [ ] **Step 5: 在 loop-core 实现 `runIterHeadGuards`（照搬逻辑）**

把实测的迭代头三段守卫逻辑**逐行搬进** `kernel/loop-core.mjs`，签名：

```js
/**
 * 迭代头守卫序。命中即返回 stop（宿主决定 break 还是 return）。
 * 等价要求：文案、事件、计数变化、判定条件与 engine 原实现逐字一致。
 */
export async function runIterHeadGuards(state, ctx) {
  for (const name of ctx.guards.iterHead) {
    if (name === 'wallClock') {
      // ← 照搬 engine.mjs 实测行号处的实现（含 loopStop 赋值与 wire 事件）
    } else if (name === 'iterCap') {
      // ← 照搬（含 iterCapHit 标志）
    } else if (name === 'stall') {
      // ← 照搬（含 stallHeals 计数与阈值）
    }
  }
  return { stop: null, state }
}
```

**注入调用一律改走出口**（这是 Q1 的 B1 落点）：

```js
// 原（直接注入 / 直接 wire）——以守卫⑥（无进展停滞）为例
//   pushInjection(text, { persist: true })
//   wire.system('guard_heal', { reason: 'loop-stall', attempt: stallHeals, max: STALL_HEAL_MAX })
// 改（经唯一出口；event 里的 reason 字面值必须与上表一致）
emitInjection(ctx, text, {
  persist: true,
  event: { reason: 'loop-stall', attempt: stallHeals, max: STALL_HEAL_MAX },
})
```

**注意**：守卫①（轮次墙钟）**不发 `guard_heal`**，它置的是 `loopStop = { reason: 'timeout', message: ... }`——搬移时它**不经过 `emitInjection`**，只回传 `stop`。同理守卫②只置 `iterCapHit`。**不要**为了"统一"给它们硬塞注入出口。

- [ ] **Step 6: engine 改为调用契约（等价替换）**

在 `engine.mjs` 迭代头处，用契约调用替换内联守卫，**其余一字不动**：

```js
// 迭代头：守卫序由 profile 驱动
const head = await runIterHeadGuards(iterState, loopCtx)
if (head.stop) { loopStop = head.stop; break }   // ← 保持原有 break/收尾语义
```

**要点**：
- `loopCtx` 必须提供 `guards`（来自 `resolveGuards(MAIN_PROFILE, ...)`）与 `pushInjection`。
- **不删**原有变量（`iterCapHit`/`stallHeals` 等仍被后续代码引用）。
- 若实测发现某守卫的收尾不是 `break` 而是别的写法，**照原样**，不要统一。

- [ ] **Step 7: 跑等价锁 + 全量内核测试**

```bash
cd /c/Users/T203-15/yfworking
node --test --test-timeout=120000 kernel-tests/loop-guard-order-equivalence.test.mjs
npm run test:kernel
```

Expected: 等价锁 PASS；`npm run test:kernel` **214 个文件全绿**（基线 210 + 本批新增 4）。

- [ ] **Step 8: 提交**

```bash
cd /c/Users/T203-15/yfworking
git add kernel/loop-core.mjs kernel/engine.mjs kernel-tests/loop-guard-order-equivalence.test.mjs kernel-tests/fixtures/guard-order-iterhead.golden.json
git commit -m "refactor(loop): S2b iterHead 守卫序参数化（等价搬移，零行为变更）

- loop-core.runIterHeadGuards：wallClock/iterCap/stall 三段守卫照搬，签名 (state, ctx)
- engine.mjs 迭代头改由 resolveGuards(MAIN_PROFILE,'iterHead') 驱动，break 语义不变
- 自愈注入改走 ctx.emitInjection(text,{persist,event})（Q1：B1 立出口，不建总线）
- 新增 L2 等价锁：golden 基线（重构前录制）+ 逐字比对 + 守卫序断言
- 纪律：只做等价搬移，未顺手修任何 bug；iterCapHit/stallHeals 等原变量保留"
```

---

## Task 3: S2c —— `inStream` 守卫序参数化

**Files:**
- Modify: `kernel/engine.mjs`（流内守卫，`:620-694` 附近）
- Modify: `kernel/loop-core.mjs`（新增 `runInStreamGuards`）
- Modify: `kernel-tests/loop-guard-order-equivalence.test.mjs`（扩 golden）

**Interfaces:**
- Consumes: Task 1 的 `emitInjection`；Task 2 的 `makeHarness`。
- Produces: `runInStreamGuards(state, ctx) → Promise<{ stop, state }>`；`fixtures/guard-order-instream.golden.json`。

- [ ] **Step 1: 核实锚点**

```bash
cd /c/Users/T203-15/yfworking
grep -n "守卫①b\|守卫③\|守卫③b\|idleDeadRetry\|createNearRepeatDetector\|detectGenerationRepeat\|upstream-dead" kernel/engine.mjs | head -20
```

Expected: 定位流内守卫实际行号。

- [ ] **Step 2: 扩 golden 基线（先录制）**

在 `loop-guard-order-equivalence.test.mjs` 增加 inStream 的录制用例，生成 `fixtures/guard-order-instream.golden.json`（含 `streamWallClock`/`genRepeat`/`nearRepeat`/`idleDeadRetry`/`upstreamDead` 五项）。

```bash
node --test --test-timeout=120000 kernel-tests/loop-guard-order-equivalence.test.mjs
```

Expected: 生成/更新 golden；比对 PASS（engine 尚未改）。

- [ ] **Step 3: 实现 `runInStreamGuards`**

```js
/**
 * 流内守卫序。注意：本相位**不产生 break**——命中只置 loopStop / 注入自愈，
 * 由宿主在流结束后统一判停（与 engine 原实现一致）。
 */
export async function runInStreamGuards(state, ctx) {
  for (const name of ctx.guards.inStream) {
    if (name === 'streamWallClock') { /* 照搬 */ }
    else if (name === 'genRepeat') { /* 照搬（含自愈注入改走 emitInjection） */ }
    else if (name === 'nearRepeat') { /* 照搬 */ }
    else if (name === 'idleDeadRetry') { /* 照搬 */ }
    else if (name === 'upstreamDead') { /* 照搬（注意：此处原本只有 wire 事件、无注入——保持原样） */ }
  }
  return { stop: null, state }
}
```

**特别提醒**：`upstream-dead`（`:729` 附近）在现状下**只发 wire 事件、没有注入**。这是 spec 点名的"反向缺口"。**本任务保持原样**——补注入属于行为变更，**不在 B1**。

- [ ] **Step 4: engine 改为调用契约**

```js
const inStream = await runInStreamGuards(iterState, loopCtx)
// 注意：原实现里这些赋值是就地修改外层变量（loopStop 等），
// 等价搬移时通过 state 回传，宿主再回收——不得改变判定时机。
```

- [ ] **Step 5: 跑锁与全量测试**

```bash
cd /c/Users/T203-15/yfworking
node --test --test-timeout=120000 kernel-tests/loop-guard-order-equivalence.test.mjs
npm run test:kernel
```

Expected: 全绿；214 个文件（基线 210 + 本批新增 4）。

- [ ] **Step 6: 提交**

```bash
cd /c/Users/T203-15/yfworking
git add kernel/loop-core.mjs kernel/engine.mjs kernel-tests/loop-guard-order-equivalence.test.mjs kernel-tests/fixtures/guard-order-instream.golden.json
git commit -m "refactor(loop): S2c inStream 守卫序参数化（等价搬移）

- runInStreamGuards：streamWallClock/genRepeat/nearRepeat/idleDeadRetry/upstreamDead
- 本相位不产生 break，命中只置 loopStop/注入自愈，判停时机不变
- upstream-dead 保持\"只发事件不注入\"原样（补注入属行为变更，不归 B1）
- golden 基线扩至 inStream 五项"
```

---

## Task 4: S2d —— `afterStream` 守卫序参数化

**Files:**
- Modify: `kernel/engine.mjs`（流后守卫，`:899-1122` 附近 + `:1139` 终结判定）
- Modify: `kernel/loop-core.mjs`（新增 `runAfterStreamGuards`）
- Modify: `kernel-tests/loop-guard-order-equivalence.test.mjs`（扩 golden）

**Interfaces:**
- Produces: `runAfterStreamGuards(state, ctx) → Promise<{ stop, state }>`；`fixtures/guard-order-afterstream.golden.json`。

- [ ] **Step 1: 核实锚点**

```bash
cd /c/Users/T203-15/yfworking
grep -n "repeatHeals\|REPEAT_HEAL_MAX\|errorStreak\|MAX_ERROR_ITERATIONS\|repeatStreak\|REPEAT_REMIND_AT\|errorMeltdownText\|repeatRemindText\|loopStop || iterCapHit" kernel/engine.mjs | head -25
```

Expected: 定位 R3-2/④/⑥/⑤ 与熔断收尾、终结判定。

- [ ] **Step 2: 扩 golden 基线**

在等价锁中增加 afterStream 五项（`repeatHeal`/`failureHeal`/`progressRefresh`/`repeatReminder`/`meltdownStop`）的录制用例：

```bash
node --test --test-timeout=120000 kernel-tests/loop-guard-order-equivalence.test.mjs
```

Expected: 生成 `fixtures/guard-order-afterstream.golden.json`；PASS。

- [ ] **Step 3: 实现 `runAfterStreamGuards`**

```js
/**
 * 流后守卫序。含唯一会\"收尾\"的守卫 meltdownStop。
 * 计数语义硬约束：errorStreak/repeatStreak 在自愈后**按原实现清零/保留**，
 * 不得\"顺手统一\"——清零规则是守卫能重复自愈的关键，改了会静默改变熔断行为。
 */
export async function runAfterStreamGuards(state, ctx) {
  for (const name of ctx.guards.afterStream) {
    if (name === 'repeatHeal') { /* 照搬（REPEAT_HEAL_MAX 语义） */ }
    else if (name === 'failureHeal') { /* 照搬（errorStreak/meltdown 文案） */ }
    else if (name === 'progressRefresh') { /* 照搬 */ }
    else if (name === 'repeatReminder') { /* 照搬（不 veto） */ }
    else if (name === 'meltdownStop') { /* 照搬（loopStop） */ }
  }
  return { stop: null, state }
}
```

- [ ] **Step 4: engine 改为调用契约 + 终结判定**

```js
const after = await runAfterStreamGuards(iterState, loopCtx)
if (after.stop) loopStop = after.stop
// 终结判定保持原样位置与条件：engine.mjs 的 `if (loopStop || iterCapHit)` 一字不改
```

- [ ] **Step 5: 跑锁与全量测试**

```bash
cd /c/Users/T203-15/yfworking
node --test --test-timeout=120000 kernel-tests/loop-guard-order-equivalence.test.mjs
npm run test:kernel
```

Expected: 全绿；214 个文件（基线 210 + 本批新增 4）。

- [ ] **Step 6: commit**

```bash
cd /c/Users/T203-15/yfworking
git add kernel/loop-core.mjs kernel/engine.mjs kernel-tests/loop-guard-order-equivalence.test.mjs kernel-tests/fixtures/guard-order-afterstream.golden.json
git commit -m "refactor(loop): S2d afterStream 守卫序参数化（等价搬移）

- runAfterStreamGuards：repeatHeal/failureHeal/progressRefresh/repeatReminder/meltdownStop
- 计数清零规则照搬（errorStreak/repeatStreak 不得\"顺手统一\"，否则静默改变熔断行为）
- 终结判定 if (loopStop || iterCapHit) 位置与条件一字不改
- golden 基线扩至 afterStream 五项"
```

---

## Task 5: S2e —— 三段合一的等价性收尾（L1 + L3）

**Files:**
- Modify: `kernel-tests/loop-guard-order-equivalence.test.mjs`（L3 回放）
- Test: `kernel-tests/loop-core-contract.test.mjs`（补 profile 完整性）

**Interfaces:**
- Consumes: Task 2–4 的 golden 三份。
- Produces: `fixtures/session-replay.golden.json`（L3 会话级回放基线）。

- [ ] **Step 1: 补 profile 完整性测试**

```js
test('MAIN_PROFILE 覆盖全部已实现守卫（防漏声明）', async () => {
  const { MAIN_PROFILE, KNOWN_GUARDS } = await import('../kernel/loop-profile.mjs')
  const declared = new Set([
    ...MAIN_PROFILE.guards.iterHead, ...MAIN_PROFILE.guards.inStream, ...MAIN_PROFILE.guards.afterStream,
  ])
  const missing = [...KNOWN_GUARDS].filter((g) => !declared.has(g))
  assert.deepEqual(missing, [], `主档应覆盖全部守卫，漏: ${missing}`)
})
```

> 该断言**正是本任务的价值**：它把"KNOWN_GUARDS 与 profile 声明"钉在一起——将来新增守卫却忘了加进 profile 会立刻红。

- [ ] **Step 2: ★ 主循环改调 `runOnce`（A2「一处实现」的落地步）**

**为什么单独一步**：Task 1 立了 `runOnce` 的编排骨架、Task 2–4 填了三段守卫体，但**若主循环仍自己写 for 循环调三个守卫函数，`runOnce` 就是死代码**（spec §6.1 / A2 的"可共享逻辑一处实现"落空）。

把 `kernel/engine.mjs` 主循环体改为**由 `runOnce` 驱动**：

```js
// 主循环（等价重构后）
const loopCtx = { profile: MAIN_PROFILE, pushInjection, streamOnce, /* ...既有依赖显式注入... */ }
for (let iter = 0; ; iter++) {
  const { stop } = await runOnce({ iter }, loopCtx)
  if (stop) { loopStop = { reason: stop.reason, message: stop.message }; break }
}
```

**等价要点**：
- `streamOnce` 必须把**流内取流全过程**封进去（含 `inStream` 守卫所需的 `streamed`），否则 `inStream` 相位失去观察对象。
- 主循环原有的 `loopStop` / `iterCapHit` / `guardInjections` 等**轮内状态**要么进 `state`，要么经 `ctx` 传引用（**照搬原语义，不新建第二套**）。若某状态无法安全外移，**保留在主循环并在 `ctx` 里以 getter/setter 暴露**——**不要**为了"干净"改变清零时机。
- 终结判定 `if (loopStop || iterCapHit) break` 的位置与条件**一字不改**。

**验收**：`grep -c "runIterHeadGuard\|runInStreamGuard\|runAfterStreamGuard" kernel/engine.mjs` 应为 **0**（主循环不再直接调守卫函数，只调 `runOnce`）；而 `loop-core.mjs` 内三者齐全。

- [ ] **Step 3: L3 会话级回放基线（**真实断言**，不留空壳）**

**录制**：复用 Task 2 Step 3 的 `kernel-tests/fixtures/record-goldens.mjs`（**同一个录制器**，不另写）：

```bash
cd /c/Users/T203-15/yfworking
PONOS_MOCK_API=1 node kernel-tests/fixtures/record-goldens.mjs session-replay
```

（recorder 内已含"拒绝写出空基线"的护栏，见 Task 2 Step 3。）

**L3 比对用例**（逐项 `deepEqual`，**不是** `assert.ok(Array.isArray(...))`）：

```js
test('L3 会话回放：digest / turnStats / wire 序列逐项一致', () => {
  const golden = JSON.parse(readFileSync(new URL('./fixtures/session-replay.golden.json', import.meta.url), 'utf8'))
  const actual = replayMockSession(golden.turns.length)      // 同一路径重放
  assert.ok(golden.turns.length > 0, '基线不得为空（否则是空锁）')
  assert.deepEqual(actual.turns, golden.turns, 'turnToolDigest/turnStats 逐轮必须逐项相等')
  assert.deepEqual(actual.events, golden.events, 'wire 事件序列必须逐项相等')
})
```

> ★ **空锁禁令**：任何 golden 比对用例**不得**只断言"是数组"。基线为空（`length === 0`）时**必须红**——否则 L1/L2/L3/L4 的"等价"判据全是空话。**录制后必须检查基线文件非空并提交**。

- [ ] **Step 4: 三份 golden 全跑 + 全量测试 + 门禁**

```bash
cd /c/Users/T203-15/yfworking
node --test --test-timeout=120000 kernel-tests/loop-guard-order-equivalence.test.mjs
npm run test:kernel
npm run kit:check
node --test --test-timeout=120000 "kit/**/*.test.mjs"
npm run verify:ci
```

Expected: 全绿；`kit:check` EXIT=0；引号版 kit 测试全绿；`verify:ci` EXIT=0。

- [ ] **Step 4: 提交**

```bash
cd /c/Users/T203-15/yfworking
git add kernel-tests/loop-guard-order-equivalence.test.mjs kernel-tests/loop-core-contract.test.mjs kernel-tests/fixtures/session-replay.golden.json
git commit -m "test(loop): S2e 等价性收尾 —— L1 全覆盖 + L3 会话回放

- MAIN_PROFILE 覆盖全部 KNOWN_GUARDS（新增守卫漏声明会立刻红）
- L3 会话级回放基线：turnToolDigest/turnStats/wire 序列逐项比对
- B1 主循环侧完成：三段守卫序 + 唯一注入出口，零行为变更（L1/L2/L3 三重锁）"
```

---

## Task 6: S3 —— lane 复用同一 `runOnce`

**Files:**
- Modify: `kernel/engine.mjs`（`runSubAgentLoop`，`:1505-1855` 附近）
- Test: `kernel-tests/loop-lane-profile.test.mjs`（新建）

**Interfaces:**
- Consumes: `LANE_PROFILE`（Task 1）、`runIterHeadGuards`/`runInStreamGuards`/`runAfterStreamGuards`（Task 2–4）。
- Produces: lane 侧复用同一守卫实现；**不新增**共享面。

### 背景（实现者必读）

spec 已核实：lane 与主循环**约 300-350 行可共享**，**约 250 行刻意不同**（`engine.mjs:1502-1504` 注释明说"无健康（短会话）；无压缩器"）。**只收敛可共享的那部分**，刻意差异通过 `LANE_PROFILE` 表达。

**lane 的刻意差异（不收敛）**：无 health / 无锚点注入 / 无完整 `preStep` / `inbox`(B2) vs `pendingNext`(P8) / `guardStop`(return) vs `loopStop`+`break` / 无 `asksUser` 挂起。

- [ ] **Step 1: 核实 lane 现实现与差异点**

```bash
cd /c/Users/T203-15/yfworking
grep -n "runSubAgentLoop\|guardStop\|inbox\|laneCompactor\|无健康\|无压缩器" kernel/engine.mjs | head -25
```

Expected: 确认差异点实际位置与注释。

- [ ] **Step 2: 写失败测试**

`kernel-tests/loop-lane-profile.test.mjs`：

```js
// S3：lane 复用同一守卫实现，刻意差异由 LANE_PROFILE 表达
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LANE_PROFILE, MAIN_PROFILE, resolveGuards } from '../kernel/loop-profile.mjs'

test('lane 收尾用 guardStop（return），主循环用 loopStop（break）', () => {
  assert.equal(LANE_PROFILE.stop, 'guardStop')
  assert.equal(MAIN_PROFILE.stop, 'loopStop')
})

test('★ lane 守卫集与主循环逐相位相同（不得漏一个 —— 漏 = 静默丢守卫）', () => {
  for (const phase of ['iterHead', 'inStream', 'afterStream']) {
    assert.deepEqual(
      resolveGuards(LANE_PROFILE, phase),
      resolveGuards(MAIN_PROFILE, phase),
      `lane 的 ${phase} 守卫必须与主循环同集（实测 engine.mjs:1505-1862）`,
    )
  }
})

test('lane 的关键守卫逐个在位（防\"以为 lane 没有\"而误删）', () => {
  // 实测位置：③b near-repeat :1659 / ⑥ 进展刷新 :1805 / ⑤ 同工具提醒 :1825 / ④ 熔断 :1841
  assert.ok(resolveGuards(LANE_PROFILE, 'inStream').includes('nearRepeat'), '③b 在 lane 中存在')
  assert.ok(resolveGuards(LANE_PROFILE, 'afterStream').includes('progressRefresh'), '⑥ 在 lane 中存在')
  assert.ok(resolveGuards(LANE_PROFILE, 'afterStream').includes('repeatReminder'), '⑤ 在 lane 中存在')
  assert.ok(resolveGuards(LANE_PROFILE, 'afterStream').includes('meltdownStop'), '④ 在 lane 中存在')
})

test('lane 保留共享守卫（不得连共享部分一起丢）', () => {
  assert.deepEqual(resolveGuards(LANE_PROFILE, 'iterHead'), ['wallClock', 'iterCap', 'stall'])
  assert.ok(resolveGuards(LANE_PROFILE, 'afterStream').includes('failureHeal'))
})

test('lane 关闭 health / 锚点 / 完整压缩（engine.mjs:1502-1504 的明说差异）', () => {
  assert.equal(LANE_PROFILE.health.fidelityAnchor, false)
  assert.equal(LANE_PROFILE.compactor.preStep, false)
  assert.equal(LANE_PROFILE.inject.pendingNext, false)
  assert.equal(LANE_PROFILE.inject.inbox, true)
})
```

- [ ] **Step 3: 运行确认失败/通过**

```bash
node --test --test-timeout=120000 kernel-tests/loop-lane-profile.test.mjs
```

Expected: PASS（profile 已在 Task 1 定义）。此测试的作用是**把差异钉成契约**——lane 后续改动若误丢共享守卫会立刻红。

- [ ] **Step 4: ★ lane 改调同一 `runOnce`**

**为什么必须调 `runOnce` 而不是三个守卫函数**：A2 / spec §6.1 要求"可共享逻辑**一处实现**"。若 lane 只调三个守卫函数而主循环调 `runOnce`，**两套编排并存** ⇒ 等于没收敛（差异从"守卫体"漂到"编排顺序"，而编排顺序正是守卫序参数化的核心）。

在 `runSubAgentLoop` 中改为：

```js
// lane 侧（等价重构后）
const laneCtx = {
  ...sharedCtx,                     // pushInjection/streamOnce 等显式依赖
  profile: LANE_PROFILE,            // ★ 差异只在这里
  pushInjection: (text, meta) => store.appendUser(text),   // lane 无 session/pushMemory（既有语义）
}
for (let iter = 0; ; iter++) {
  const { stop } = await runOnce({ iter }, laneCtx)
  if (stop) return guardStop(stop.message ? stopNotice(stop.message, stop.detail) : stop.message)
}
```

**要点**：
- **`guardStop` 的 `return` 语义保持**——`runOnce` 返回 `{ stop }`，lane 侧 `return guardStop(...)`；**不要**改成 `break`。
- lane 的 `inbox` 吸收路径**不动**；lane **不注册**锚点渲染器与 health（由 `LANE_PROFILE` 表达）。
- lane 的 `store.appendUser` 是**它自己的注入出口形态**（lane 无 `pushMemory`/`session` 概念）——`ctx.pushInjection` 把它包住即可，**不要**为统一而在 lane 里造 `session`。
- lane 的 `subStop`（③/③b 命中）→ 流外自愈/收尾的**两段式**结构保持（`streamOnce` 必须把这层暴露出来，见 Task 5 Step 2 的等价要点）。

**验收**：`grep -c "subStallHeals\|subErrorStreak\|subRepeatStreak" kernel/engine.mjs` —— 这些**轮内状态仍在 lane 侧**（不进 profile），说明状态与守卫序的边界没被搞混。

- [ ] **Step 5: 确认"共享只有一份 + lane 不再内联守卫"**

```bash
cd /c/Users/T203-15/yfworking
# ① lane 区间内不应再有内联的守卫文案注入（应改走 runOnce → emitInjection）
awk 'NR>=1505 && NR<=1870' kernel/engine.mjs | grep -n "appendUser(errorMeltdownText\|appendUser(repeatRemindText\|appendUser('【系统】检测到你长时间没有实质进展"
# ② 守卫文案常量的引用应集中在 loop-core.mjs
grep -c "errorMeltdownText\|repeatRemindText" kernel/loop-core.mjs
```

Expected: ① 应无命中（或仅剩 lane 特有的 `【系统】检测到你…` 停滞注入，若保留需在此说明"lane 文案与主循环不同"的理由并**逐字保留原文案**，不得为统一改文案）；② 命中数 > 0（守卫体已集中在 `loop-core.mjs`）。

- [ ] **Step 6: 跑全量 + 门禁**

```bash
cd /c/Users/T203-15/yfworking
node --test --test-timeout=120000 kernel-tests/loop-lane-profile.test.mjs
npm run test:kernel
```

Expected: 全绿；214 个文件（基线 210 + 本批新增 4）。

- [ ] **Step 7: 提交**

```bash
cd /c/Users/T203-15/yfworking
git add kernel/engine.mjs kernel-tests/loop-lane-profile.test.mjs
git commit -m "refactor(loop): S3 lane 复用同一 runOnce（LANE_PROFILE 表达刻意差异）

- runSubAgentLoop 改调 runOnce（与主循环同一编排实现），差异只由 ctx.profile 表达
- ★ 修正一处严重事实错误：草稿曾把 LANE_PROFILE 写成\"lane 无 nearRepeat/progressRefresh/repeatReminder\"，
  实测 lane 与主循环守卫集逐项相同（③b :1659 / ⑥ :1805 / ⑤ :1825 / ④ :1841）
  ⇒ 照草稿实现会静默丢 lane 的 4 个守卫；已按实测修正并加\"守卫集必须相同\"断言
- guardStop 的 return 语义保持（不改成 break）；inbox 吸收路径不动；lane 不注册锚点/health
- 测试：守卫集相同 + 4 个关键守卫逐个在位 + profile 差异只在 compactor/health/inject/stop
- 至此 B1：可共享编排与守卫序一处实现、两处生效；250 行刻意差异保留"
```

---

## Task 7: S3.5 —— 注入总线抽取（`kernel/inject-bus.mjs`）

**Files:**
- Create: `kernel/inject-bus.mjs`
- Modify: `kernel/loop-core.mjs`（`emitInjection` 改接总线；放开四个扩展字段）
- Modify: `kernel/engine.mjs`（**剩余注入点**改走出口；`withAnchorTail` 注册为 `beforeRequest` 相位 `derived` 渲染器）
- Modify: `kernel-tests/loop-core-contract.test.mjs`（**更新**"拒绝扩展字段"断言——S2 阶段拒绝、本阶段放开）
- Test: `kernel-tests/inject-bus.test.mjs`（新建）；扩 `kernel-tests/loop-guard-order-equivalence.test.mjs`（L4 双重等价）

**Interfaces:**
- Consumes: `emitInjection(ctx, text, meta)`（Task 1）；`MAIN_PROFILE`/`LANE_PROFILE`/`resolveGuards`（Task 1）
- Produces:
  - `INJECT_PHASES = ['beforeIter','inStream','beforeRequest']`
  - `INJECT_CLASSES = ['protocol','directive']`
  - `createInjectBus({ totalBudgetBytes }) → { emit(text, meta), registerRenderer(phase, fn), render(phase, ctx), stats() }`
  - `kernel/inject-bus.test.mjs` 的 `mkBus()`（测试辅助）

### 背景（实现者必读）

**现状（逐处核实自注入 spec §2.4 + 实测）**：注入散在 **18 处** —— 主循环 **9** + 子 lane **6** + 协议回填 **2** + 轮载荷 **1**；留痕不齐（`guard_heal` 全文仅 **5 处**；4 处注入点无留痕事件）；有事件无注入（`upstream-dead`）；**注入无账**。

**分步归属（Q1 的解读，见本计划「范围与非范围」表）**：Task 1–6 只把**随守卫一起搬迁的**注入改走出口；**本任务**处理**剩余注入点**并建立总线。净效果 = "改 12 个点"退化为"换实现 + 加注册"。

**三条硬约束（逐字取自注入 spec §4.1 S3.5 行）**：
1. **只做等价搬移**；
2. **不补事件** —— 4 处 `event: null` **如实保留**（补事件是行为变更，会改变 wire 序列 ⇒ 破坏 L4）；
3. **不统一 lane 与主循环的注入语义** —— "刻意不同的 250 行"须保持：lane **不注册**锚点渲染器；`pendingNext`/`inbox` 仍走 profile 开关。

- [ ] **Step 1: 先读 spec §3.1 确认 class 语义 + 预算派生 + 重新核实 18 处注入点行号**

```bash
cd /c/Users/T203-15/yfworking
# ① class 语义（protocol vs directive）——以 spec 为准，勿凭猜测
grep -n "protocol\|directive" docs/superpowers/specs/2026-09-20-injection-layer-unification-design.md | head -20
# ② 预算权威（A15：总线预算必须派生它，不得另拍默认值）
grep -n "resolveInjectBudget" kernel/knowledge-inject.mjs
# ③ 剩余注入点实况（行号已被 Task 1–6 的搬迁移动过；lane 走 store.appendUser，不是 pushInjection）
grep -n "pushInjection\|store.appendUser\|queueNext\|pushMemory(" kernel/engine.mjs | head -40
# ④ withAnchorTail 的相位归属与调用点
grep -n "withAnchorTail" kernel/engine.mjs kernel/engine-config.mjs
```

Expected: 读到 class 的两类语义定义；`resolveInjectBudget` 定义在 `kernel/knowledge-inject.mjs`（实测约 `:57`）；列出 18 处注入点实际行号（**lane 6 处走 `store.appendUser`，`grep pushInjection` 查不到**）；确认 `withAnchorTail` 在 `engine-config.mjs` 导出、`engine.mjs:41` import / `:48` re-export / `:363` 调用（`:320` 注释"纯派生，不改 requestFace 缓存对象"）。

> ⚠️ **若 spec §3.1 对 `protocol`/`directive` 的定义与 Step 4 下方实现不一致，以 spec 为准并当场修正实现**。下方实现给出的语义（`protocol` 不可裁剪 / `directive` 受预算约束）是依据 spec「G1 零和预算」「G3 常量注入净下降」推导的**待验证解读**，必须在 Step 1 对照确认。

**把核实结果写进本任务末尾的"事实登记"注释**（供评审核对）。
★ **硬要求**：`class` 语义必须**引用 spec §3.1 原文**（可摘句），**不得**只写"按 Step 4 实现"；**若 Step 1 读到 §3.1 与 Step 4 的实现不一致，以 spec 为准，并在提交前把差异写进本任务的事实登记**——否则不得合入。

- [ ] **Step 2: 写失败测试**

`kernel-tests/inject-bus.test.mjs`：

```js
// 注入总线（S3.5）：3 相位 / 2 class / 预算裁剪 / 渲染器注册
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  INJECT_PHASES, INJECT_CLASSES, createInjectBus,
} from '../kernel/inject-bus.mjs'

/** 测试辅助：建一条总线并取出快照 */
export function mkBus(opts = {}) {
  const bus = createInjectBus({ totalBudgetBytes: 100, ...opts })
  return bus
}

test('相位与 class 常量为预期值', () => {
  assert.deepEqual(INJECT_PHASES, ['beforeIter', 'inStream', 'beforeRequest'])
  assert.deepEqual(INJECT_CLASSES, ['protocol', 'directive'])
})

test('未知相位在 emit 时抛错（早失败优于静默）', () => {
  const bus = mkBus()
  assert.throws(
    () => bus.emit('x', { phase: 'nope', persist: false, event: null }),
    /unknown phase/,
  )
})

test('未知 class 在 emit 时抛错', () => {
  const bus = mkBus()
  assert.throws(
    () => bus.emit('x', { phase: 'beforeIter', kind: 'nope', persist: false, event: null }),
    /unknown kind/,
  )
})

test('directive 受预算约束：超出剩余预算的项被丢弃并记账', () => {
  const bus = mkBus({ totalBudgetBytes: 10 })
  bus.emit('12345678', { phase: 'beforeIter', kind: 'directive', priority: 1, persist: true, event: null })
  bus.emit('abcdefgh', { phase: 'beforeIter', kind: 'directive', priority: 1, persist: true, event: null })
  const out = bus.render('beforeIter')
  assert.equal(out.length, 1, '第二条应因预算不足被丢弃')
  assert.equal(out[0].text, '12345678')
  assert.equal(bus.stats().dropped, 1)
})

test('protocol 不受预算约束（不可裁剪）', () => {
  const bus = mkBus({ totalBudgetBytes: 1 })
  bus.emit('这个协议项很长很长', { phase: 'beforeRequest', kind: 'protocol', priority: 100, persist: true, event: null })
  assert.equal(bus.render('beforeRequest').length, 1)
  assert.equal(bus.stats().dropped, 0)
})

test('同相位内按 priority 降序渲染（稳定：同优先级保持入队序）', () => {
  const bus = mkBus({ totalBudgetBytes: 1000 })
  bus.emit('低', { phase: 'inStream', kind: 'directive', priority: 1, persist: true, event: null })
  bus.emit('高', { phase: 'inStream', kind: 'directive', priority: 9, persist: true, event: null })
  bus.emit('低2', { phase: 'inStream', kind: 'directive', priority: 1, persist: true, event: null })
  assert.deepEqual(bus.render('inStream').map((x) => x.text), ['高', '低', '低2'])
})

test('render 只取该相位，不影响其他相位', () => {
  const bus = mkBus()
  bus.emit('a', { phase: 'beforeIter', kind: 'directive', priority: 1, persist: true, event: null })
  bus.emit('b', { phase: 'inStream', kind: 'directive', priority: 1, persist: true, event: null })
  assert.deepEqual(bus.render('beforeIter').map((x) => x.text), ['a'])
  assert.deepEqual(bus.render('inStream').map((x) => x.text), ['b'])
})

test('event 原样透传；null 保持 null（不补事件 —— 等价硬约束②）', () => {
  const bus = mkBus()
  bus.emit('x', { phase: 'beforeIter', kind: 'directive', priority: 1, persist: false, event: null })
  assert.equal(bus.render('beforeIter')[0].event, null)
})

test('registerRenderer：beforeRequest 相位注册 derived 渲染器并可派生注入', () => {
  const bus = mkBus()
  const order = []
  bus.registerRenderer('beforeRequest', (ctx) => {
    order.push('renderer')
    return { kind: 'protocol', priority: 100, persist: true, event: null, text: `tail:${ctx.label}` }
  })
  const out = bus.render('beforeRequest', { label: 'L' })
  assert.deepEqual(order, ['renderer'])
  assert.equal(out.length, 1)
  assert.equal(out[0].text, 'tail:L')
})

test('renderer 注册到未知相位抛错', () => {
  const bus = mkBus()
  assert.throws(() => bus.registerRenderer('nope', () => null), /unknown phase/)
})

test('renderer 返回 null 表示本相位无派生注入', () => {
  const bus = mkBus()
  bus.registerRenderer('beforeRequest', () => null)
  assert.deepEqual(bus.render('beforeRequest', {}), [])
})

test('stats 暴露 calls/hits/injectedBytes/dropped（供总账消费）', () => {
  const bus = mkBus({ totalBudgetBytes: 100 })
  bus.emit('abcd', { phase: 'beforeIter', kind: 'directive', priority: 1, persist: true, event: null })
  bus.render('beforeIter')
  const s = bus.stats()
  assert.equal(s.calls, 1)
  assert.equal(s.injectedBytes, 4)
  assert.equal(typeof s.dropped, 'number')
})
```

- [ ] **Step 3: 运行测试确认失败**

```bash
node --test --test-timeout=120000 kernel-tests/inject-bus.test.mjs
```

Expected: FAIL —— `Cannot find module '../kernel/inject-bus.mjs'`。

- [ ] **Step 4: 实现 `kernel/inject-bus.mjs`**

```js
// 注入总线（S3.5）
// ---------------------------------------------------------------------------
// 目的：把散在 18 处的\"指令注入\"收敛到一条总线——统一相位、统一排队、
//       统一预算、统一记账，使后续\"模式/方法论\"的注入都走一条路。
//
// 设计（依据注入 spec §3.1；Step 1 已对照确认）：
//   · 3 相位：beforeIter（迭代前）/ inStream（流内）/ beforeRequest（组装请求前）
//   · 2 class：
//       protocol  —— 协议性注入，**不可裁剪**，不参与预算竞争（逐字送达）
//       directive —— 指令性注入，**受 totalBudgetBytes 约束**，超预算按优先级丢弃
//   · 渲染器注册位：beforeRequest 相位可注册 derived 渲染器（如锚点尾）
//
// 等价硬约束（§4.1 S3.5\"不做什么\"）：
//   · 只做等价搬移，不做行为变更
//   · **不补事件**：event 为 null 就保持 null
//   · 不统一 lane 与主循环的注入语义（lane 不注册锚点渲染器）

import { resolveInjectBudget } from './knowledge-inject.mjs'

export const INJECT_PHASES = ['beforeIter', 'inStream', 'beforeRequest']
export const INJECT_CLASSES = ['protocol', 'directive']

const bytes = (s) => Buffer.byteLength(String(s), 'utf8')

/**
 * @param {object} opts
 * @param {number} [opts.totalBudgetBytes] ★ 必须由**预算权威**派生（A15）；
 *   不传时从 `resolveInjectBudget()` 现算 —— **不得**在此硬编码默认值
 *   （spec §3.1：预算单一权威在 knowledge-inject.mjs，总线只是消费方）。
 * @param {number} [opts.settings] 透传给 resolveInjectBudget
 */
export function createInjectBus(opts = {}) {
  const totalBudgetBytes = Number.isFinite(opts.totalBudgetBytes)
    ? opts.totalBudgetBytes
    : resolveInjectBudget(opts.settings || {})
  /** @type {Map<string, Array>} 相位 → 入队项 */
  const queues = new Map(INJECT_PHASES.map((p) => [p, []]))
  /** @type {Map<string, Function>} 相位 → derived 渲染器 */
  const renderers = new Map()
  let seq = 0
  const stats = { calls: 0, hits: 0, injectedBytes: 0, dropped: 0 }

  function emit(text, meta = {}) {
    const phase = meta.phase || 'beforeIter'
    const kind = meta.kind || 'directive'
    if (!INJECT_PHASES.includes(phase)) throw new Error(`unknown phase: ${phase}`)
    if (!INJECT_CLASSES.includes(kind)) throw new Error(`unknown kind: ${kind}`)
    queues.get(phase).push({
      seq: seq++,
      text: String(text),
      kind,
      priority: Number.isFinite(meta.priority) ? meta.priority : 0,
      persist: meta.persist === true,
      event: meta.event || null,   // ★ 不补事件：null 保持 null
    })
    stats.calls++
  }

  function registerRenderer(phase, fn) {
    if (!INJECT_PHASES.includes(phase)) throw new Error(`unknown phase: ${phase}`)
    renderers.set(phase, fn)
  }

  function render(phase, ctx) {
    if (!INJECT_PHASES.includes(phase)) throw new Error(`unknown phase: ${phase}`)
    const items = [...queues.get(phase)]
    const fn = renderers.get(phase)
    if (typeof fn === 'function') {
      const derived = fn(ctx)
      if (derived) {
        items.push({
          seq: seq++, text: String(derived.text),
          kind: derived.kind || 'protocol',
          priority: Number.isFinite(derived.priority) ? derived.priority : 100,
          persist: derived.persist === true,
          event: derived.event || null,
        })
      }
    }
    // 稳定排序：priority 降序，同优先级保持入队序
    items.sort((a, b) => (b.priority - a.priority) || (a.seq - b.seq))
    // 预算：protocol 不参与竞争；directive 按序累加，超预算丢弃
    let used = 0
    const out = []
    for (const it of items) {
      if (it.kind === 'protocol') { out.push(it); continue }
      const b = bytes(it.text)
      if (used + b > totalBudgetBytes) { stats.dropped++; continue }
      used += b
      out.push(it)
    }
    // 渲染即出队（同一相位不重复渲染）
    queues.set(phase, [])
    stats.hits += out.length
    stats.injectedBytes += out.reduce((a, it) => a + bytes(it.text), 0)
    return out
  }

  return { emit, registerRenderer, render, stats: () => ({ ...stats }) }
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
node --test --test-timeout=120000 kernel-tests/inject-bus.test.mjs
```

Expected: PASS（12 个用例）。

- [ ] **Step 6: 改 `loop-core.emitInjection` 接总线 + 放开四个扩展字段**

`kernel/loop-core.mjs` 的 `emitInjection` 现在是"拒绝 `priority`/`budgetBytes`/`kind`/`phase`"的 S2 版本。改为：

```js
const ALLOWED_INJECTION_OPTIONS = new Set(['persist', 'event', 'priority', 'budgetBytes', 'kind', 'phase'])

/**
 * 唯一注入出口。S3.5 起支持四个扩展字段；ctx.bus 存在时进总线，否则退回原缓冲。
 */
export function emitInjection(ctx, text, meta = {}) {
  for (const k of Object.keys(meta || {})) {
    if (!ALLOWED_INJECTION_OPTIONS.has(k)) throw new Error(`unknown option: ${k}`)
  }
  if (ctx && ctx.bus && typeof ctx.bus.emit === 'function') {
    return ctx.bus.emit(text, meta)
  }
  const fn = ctx && typeof ctx.pushInjection === 'function' ? ctx.pushInjection : null
  if (!fn) return
  fn(String(text), { persist: meta.persist === true, event: meta.event || null })
}
```

**同步更新** `kernel-tests/loop-core-contract.test.mjs` 中那条断言：

```js
// 原（S2 阶段）：拒绝 priority
//   assert.throws(() => emitInjection(ctx, 'x', { persist: false, event: null, priority: 1 }), /unknown option: priority/)
// 改（S3.5）：四个扩展字段现已允许；仍拒绝真正的未知字段
test('emitInjection 允许四个扩展字段，仍拒绝未知字段', () => {
  const ctx = { bus: { emit: () => {} } }
  assert.doesNotThrow(() => emitInjection(ctx, 'x', { persist: false, event: null, priority: 1 }))
  assert.doesNotThrow(() => emitInjection(ctx, 'x', { persist: false, event: null, kind: 'protocol', phase: 'beforeIter', budgetBytes: 10 }))
  assert.throws(() => emitInjection(ctx, 'x', { persist: false, event: null, nope: 1 }), /unknown option: nope/)
})
```

- [ ] **Step 7: 剩余注入点改走出口**

按 Step 1 核实出的实际行号，把**剩余**注入点改为经 `emitInjection`（或直接 `ctx.bus.emit`）。**逐处等价**：

| 组 | 处数 | 注意 |
|---|---|---|
| 主循环未随守卫搬迁的注入点 | 9 − 已搬迁 | 保持原相位归属（迭代前/流内/流后各自对应） |
| 子 lane 注入 | **6**（`store.appendUser` @ `:1579`/`:1731`/`:1763`/`:1776`/`:1825`/`:1841`） | ⚠️ **lane 不注册锚点渲染器**；`pendingNext`/`inbox` 仍走 profile；lane 的出口形态是 `store.appendUser`（**不要**为统一而在 lane 里造 `session`） |
| 协议回填 | 2（约 `:927`/`:1073`） | ⚠️ 这 2 处**本就无留痕事件**——**如实保留 `event: null`** |
| 轮载荷 | 1（约 `:2336` `queueNext`，内部 `pushMemory` @ `:2360`） | 归 `beforeIter` 相位（轮前载荷） |

**逐处打勾清单（防漏改，★ 不要只用一个 grep）**：

```bash
cd /c/Users/T203-15/yfworking
# ★ lane 的注入走 store.appendUser，只 grep pushInjection 会漏掉全部 6 处 lane 注入
grep -n "pushInjection\|pushMemory(\|store.appendUser(" kernel/engine.mjs
```

Expected:
- `pushInjection` —— 仅剩 `loop-core.mjs` 内的兜底实现与其单测引用（`engine.mjs` 侧应为 **0**）
- `pushMemory(` —— 轮载荷 1 处已改走出口（`engine.mjs` 侧应为 **0**）
- `store.appendUser(` —— **除 lane 的 6 处注入外，其余是正常的对话消息写入（不得误改）**；判断标准是"该行是否为**注入性**文案（系统提示 / 守卫提示 / 提醒）"，是则改走出口，否则保留。
  ⇒ 因此**必须逐处人读确认**，不能用计数判等价。把最终 18 处逐处结论写进 Task 7 Step 10 的事实登记。

- [ ] **Step 8: 注册 `withAnchorTail` 为 `beforeRequest` 相位 `derived` 渲染器**

```js
// engine.mjs 组装 loopCtx / bus 处
bus.registerRenderer('beforeRequest', (ctx) => ({
  kind: 'protocol',            // 锚点尾不可裁剪
  priority: 100,
  persist: true,
  event: null,                 // ★ 原实现无事件，如实保留
  text: withAnchorTail(ctx),
}))
```

**要点**：
- `withAnchorTail` 保持**纯派生**（不改 `requestFace` 缓存对象）——这是它原注释的契约。
- **lane 不注册**（刻意差异）。
- 若原实现在 `engine.mjs:363` 的调用点带额外参数，**照搬**，不要简化。

- [ ] **Step 9: L4 双重等价 golden（含 `PONOS_LOOP_GUARD=0` 对照组）**

扩 `kernel-tests/loop-guard-order-equivalence.test.mjs`：

```js
test('L4a 注入文本与 wire 事件序列与基线逐项一致（含 phase/persist/event）', () => {
  const golden = JSON.parse(readFileSync(new URL('./fixtures/inject-bus-l4.golden.json', import.meta.url), 'utf8'))
  const actual = replayMockSession(golden.injections.length ? undefined : undefined)   // 同一路径重放
  assert.ok(golden.injections.length > 0, '★ 基线不得为空（空基线 = 空锁）')
  assert.deepEqual(
    actual.injections.map(({ text, phase, persist, event }) => ({ text, phase, persist, event })),
    golden.injections.map(({ text, phase, persist, event }) => ({ text, phase, persist, event })),
    '注入文本 + 相位 + persist + event 必须逐项相等（4 处 event:null 如实保留）',
  )
  assert.deepEqual(actual.events, golden.events, 'wire 事件序列必须逐项相等')
})

test('L4b PONOS_LOOP_GUARD=0 对照组：全关路径等价', () => {
  const golden = JSON.parse(readFileSync(new URL('./fixtures/inject-bus-l4-guardoff.golden.json', import.meta.url), 'utf8'))
  const actual = replayMockSession(undefined, { PONOS_LOOP_GUARD: '0' })
  assert.ok(golden.injections.length > 0, '★ 对照组基线也不得为空')
  assert.deepEqual(actual.injections.map((x) => x.text), golden.injections.map((x) => x.text))
  assert.deepEqual(actual.events, golden.events)
})
```

> ★ **空锁禁令**：两条用例都**不得**退化为 `assert.ok(Array.isArray(...))`；基线为空必须红。
> 录制方式同 Task 5 Step 3 的 `kernel-tests/fixtures/record-goldens.mjs`（用 `PONOS_MOCK_API=1`，**先录基线再比对**）。
> 对照组录制时须带 `PONOS_LOOP_GUARD=0`（实测开关在 `kernel/engine-config.mjs:36 LOOP_GUARD_OFF`，`:53` 生效）。

- [ ] **Step 10: 门禁 + 事实登记**

```bash
cd /c/Users/T203-15/yfworking
node --test --test-timeout=120000 kernel-tests/inject-bus.test.mjs
node --test --test-timeout=120000 kernel-tests/loop-core-contract.test.mjs
node --test --test-timeout=120000 kernel-tests/loop-guard-order-equivalence.test.mjs
npm run test:kernel
npm run verify:experience-inject && npm run verify:milestones-start
```

Expected: 全绿；`npm run test:kernel` 文件数 = 基线 210 + 新增 4（`inject-bus`、`loop-core-contract`、`loop-guard-order-equivalence`、`loop-lane-profile`）= **214**。

在 `kernel/inject-bus.mjs` 末尾追加**事实登记注释**（Step 1 的核实结果），**必须引用 spec §3.1 原文而非转述**：

```js
// 事实登记（Step 1 核实，2026-09-20）：
//   · class 语义（引用 spec §3.1 原文）：<摘句，不得转述>
//   · 预算权威：resolveInjectBudget() @ kernel/knowledge-inject.mjs:<实测行号>
//   · 18 处注入点实际行号与逐处结论：<主 9 / lane 6 / 协议回填 2 / 轮载荷 1，逐处列出>
//   · withAnchorTail：engine-config.mjs 导出；engine.mjs :41 import / :48 re-export / :363 调用
//   · 未补事件的 4 处：<逐处列出>（等价硬约束②）
```

- [ ] **Step 11: 提交**

```bash
cd /c/Users/T203-15/yfworking
git add kernel/inject-bus.mjs kernel/loop-core.mjs kernel/engine.mjs kernel-tests/inject-bus.test.mjs kernel-tests/loop-core-contract.test.mjs kernel-tests/loop-guard-order-equivalence.test.mjs kernel-tests/fixtures/inject-bus-l4.golden.json kernel-tests/fixtures/inject-bus-l4-guardoff.golden.json
git commit -m "refactor(inject): S3.5 注入总线抽取（等价搬移）

- 新建 kernel/inject-bus.mjs：3 相位 beforeIter/inStream/beforeRequest + 2 class protocol/directive
  + 渲染器注册位（protocol 不可裁剪，directive 受 totalBudgetBytes 约束）
- loop-core.emitInjection 接总线并放开 priority/budgetBytes/kind/phase（S2 阶段拒绝，本步放开）
- engine.mjs 剩余注入点改走出口（主循环未搬迁的 + lane 3 + 协议回填 2 + 轮载荷 1）
- withAnchorTail 注册为 beforeRequest 相位 derived 渲染器（保持纯派生；lane 不注册）
- 等价硬约束：不补事件（4 处 event:null 如实保留）；不统一 lane 与主循环语义
- L4 双重等价：注入文本 + wire 序列 golden，含 PONOS_LOOP_GUARD=0 对照组
- 至此 18 处注入收敛到一条总线（主 9 + lane 6 + 协议回填 2 + 轮载荷 1）；B1（S2+S3+S3.5）完成，零行为变更"
```

---

## 交付前总门禁（S3.5 / 批 2 全部完成后执行）

```bash
cd /c/Users/T203-15/yfworking
npm run test:kernel                                      # 214 文件全绿（基线 210 + 本批新增 4）
npm run kit:check                                        # EXIT=0
node --test --test-timeout=120000 "kit/**/*.test.mjs"     # ★ 引号必须有，否则静默漏测
npm run verify:ci                                        # EXIT=0
npm run verify:experience-inject                         # 经验注入契约未破
npm run verify:milestones-start                          # milestone 解析契约未破
git status --short                                       # 确认没有夹带他人在途改动
```

**然后停下评审**（Q7：先推到 S3 再评审），**不要**直接进 S4（模式与方法论下沉）。

## 评审时的汇报清单（批 2 完成后）

| 项 | 要报什么 |
|---|---|
| 等价性 | **L1/L2/L3/L4（含 `PONOS_LOOP_GUARD=0` 对照组）四锁结果**；golden 基线文件清单 |
| 共享收益 | `loop-core.mjs` 行数 vs `engine.mjs` 净变化（预期：可共享约 300-350 行一处实现） |
| 刻意差异 | 250 行保留清单（逐条对应 `LANE_PROFILE` 的 false/true） |
| 注入收敛 | **18 处注入点逐处清单**（主 9 + lane 6 + 协议回填 2 + 轮载荷 1）：已改走出口 / 未改（应全部改完）+ 4 处 `event: null` 如实保留的证明 |
| class 语义 | `protocol`/`directive` 的实际条文摘要（Task 7 Step 1 核实结果） |
| 观察数据 | （若批 1 已落地）`inject_snapshot` 记账样例（连续 3 轮）；未落地则注明 |
| 意外发现 | 搬迁中发现的 bug（**只记录不修**）清单 |

## Self-Review

**1. Spec coverage**

| spec 要求 | 落在哪 |
|---|---|
| S2 契约 `runOnce(state, ctx)` | Task 1 Step 4（**真实编排骨架，非 no-op**：按 profile 相位序驱动三段守卫；守卫体未实现时**抛错**） |
| S2 契约 `shouldStop` | Task 1 Step 4 |
| **主循环由 `runOnce` 驱动（A2「一处实现」）** | **Task 5 Step 2**（否则 `runOnce` 是死代码） |
| S2 三段守卫序参数化 | Task 2 / 3 / 4 |
| S2 冻结面 `text/persist/event` | Task 1 Step 4（未知 option 抛错）+ 契约测试 |
| S2 命名 `ctx.emitInjection`（禁 `ctx.inject`） | Global Constraints（**两种形态**：调用走 `ctx.emitInjection`，自由函数仅模块内/单测） |
| S2 不引用 engine 闭包 | Task 1 Step 4 模块头注 + Global Constraints |
| S2 profile 完整性（覆盖全 `KNOWN_GUARDS`） | Task 5 Step 1 |
| **lane 守卫集与主循环相同（防静默丢守卫）** | **Task 1 LANE_PROFILE 注 + 断言；Task 6 Step 4/5** |
| L1/L2/L3 回归锁（**真实断言，禁空锁**） | Task 2 Step 7 / **Task 5 Step 3（L3 逐项 deepEqual + 非空校验 + 录制脚本）** |
| S3 lane 复用 + 差异表达 | **Task 6（lane 调同一 `runOnce`，不是只调守卫函数）** |
| **S3.5 注入总线抽取（18 处）** | **Task 7** |
| **S3.5 预算派生权威（A15）** | **Task 7 Step 4**（`resolveInjectBudget()`，不硬编码默认值） |
| **S3.5 放开 `priority`/`budgetBytes`/`kind`/`phase`** | **Task 7 Step 6**（并同步更新 Task 1 的拒绝断言） |
| **S3.5 `withAnchorTail` 作 `beforeRequest` derived 渲染器** | **Task 7 Step 8** |
| **S3.5 "不做什么"三条**（只等价搬移 / 不补事件 / 不统一 lane 语义） | **Global Constraints + Task 7 背景 + Step 7 表** |
| **L4 双重等价 + `PONOS_LOOP_GUARD=0` 对照组（真实断言）** | **Task 7 Step 9** |
| 交付门禁（含引号纪律） | 「交付前总门禁」 |
| 发现 bug 不顺手修 | Task 2 背景 + Task 3 `upstream-dead` 特别提醒 |

**2. Placeholder scan**

- 无 "TBD"/"TODO"/"implement later"。
- Task 2–4 的守卫函数体内是 `/* 照搬 engine.mjs X 行附近实现 */` 注释——这是**等价搬移任务的正确规格**（spec 明确"只做等价搬移，不顺手修"），并配了 **golden 基线**作为真值源，而非留白。**这是有意为之，不是占位符**。
- Task 7 Step 10 的"事实登记注释"含 `<摘句，不得转述>` 一类占位——**这不是实现占位符，而是要求实施者把 Step 1 的核实结果登记下来**（spec 要求留痕）；其内容必须来自实际读码与 spec 原文，不得编造。★ 已加**硬要求**：`class` 语义必须引用 §3.1 原文，读到的条文与实现不一致时以 spec 为准并在提交前登记差异，**否则不得合入**。
- Task 2 Step 2 的第二个用例显式标注为"形状占位，Step 3 后替换"——**这是先录基线再比对的正确顺序**，已在 Step 3/4 给出替换后的真实代码。
- 所有新代码（`loop-profile.mjs`、`loop-core.mjs`、`inject-bus.mjs`）**完整给出**。

**3. Type consistency**

- `emitInjection(ctx, text, meta)` —— 模块内自由函数，**仅供 `loop-core` 内部与单测**；业务代码调 `ctx.emitInjection(text, meta)`（Task 1 定义，Task 2 Step 5 使用）。**Task 7 Step 6 扩为允许四字段并同步改 Task 1 的断言**——两处必须一起改，否则自相矛盾。
- `runOnce(state, ctx)` —— Task 1 定义**真实编排骨架**（相位序驱动 + 未实现抛错），**Task 5 Step 2 由主循环调用**、**Task 6 Step 4 由 lane 调用**，签名与返回 `{state, stop}` 一致。
- `resolveGuards(profile, phase)` —— Task 1 定义，Task 2 Step 4、Task 6 Step 4/5 使用，一致。
- `MAIN_PROFILE`/`LANE_PROFILE` —— Task 1 定义，Task 2/5/6 使用；★ **守卫集逐相位相同**，差异只在 `compactor`/`health`/`inject`/`stop`。
- `runIterHeadGuard`/`runInStreamGuard`/`runAfterStreamGuard`（单数，按名字分发）—— Task 1 定义分发器（未实现抛错），Task 2/3/4 填守卫体；**`engine.mjs` 侧不得直接调用它们**（只调 `runOnce`）。
- `createInjectBus({totalBudgetBytes})` → `{emit, registerRenderer, render, stats}` —— Task 7 Step 4 定义（预算**派生** `resolveInjectBudget()`），Step 2 测试与 Step 6/8 使用，一致。
- **已修正的九处**（自审 + 独立审查 + 实测核对发现）：
  1. 早期草稿在 Task 1 用 `ctx.inject`，与 `LoopProfile.inject` 字段撞名 → 按 spec 改名 `ctx.emitInjection`，并在 Global Constraints 写明禁令。
  2. Task 2 测试用了不存在的 env 变量 `PONOS_WALL_CLOCK_MS` → 实测为 **`PONOS_TURN_TIMEOUT_MS`**，已改。
  3. Task 2 的注入示例写了 `reason: 'wall-clock'` → 实测守卫①的 reason 是 **`'timeout'`** 且**不发 `guard_heal`**；已改为以守卫⑥ `'loop-stall'` 为例，并补了**守卫 → reason 对照表**（含"② 不发事件"这一容易漏掉的事实）。
  4. ★★ **`LANE_PROFILE` 严重事实错误**：草稿写 `inStream: [...无 nearRepeat]`、`afterStream: ['repeatHeal','failureHeal']`，并把"lane 无 nearRepeat/progressRefresh/repeatReminder"当作**刻意差异**断言。**实测 lane 与主循环守卫集逐项相同**（③b :1659 / ⑥ 进展刷新 :1805 / ⑤ 同工具提醒 :1825 / ④ 熔断 :1841）⇒ 照草稿实现会**静默丢掉 lane 的 4 个守卫**。已按实测修正，并把断言改成"守卫集必须相同 + 4 个关键守卫逐个在位"。
  5. **`runOnce` 从未落地**：Task 1 骨架是 no-op（`return state`）、Task 2–4 只建三个守卫函数、Task 6 标题写"复用 `runOnce`"却只调守卫函数 ⇒ A2 落空。已改为**真实编排骨架**（未实现抛错）+ **Task 5 Step 2 主循环接 `runOnce`** + **Task 6 Step 4 lane 接同一 `runOnce`**。
  6. **L3/L4 是空锁**：原用例只有 `assert.ok(Array.isArray(golden.turns))`。已改为逐项 `deepEqual` + **基线非空校验（空则红）** + 给出可执行录制脚本 `kernel-tests/fixtures/record-goldens.mjs`（用既有 `PONOS_MOCK_API=1`，实测 `kernel/api.mjs:1676`）。
  7. **`emitInjection` 命名两套并存**：已在 Global Constraints 明确"两种形态"（调用走 `ctx.emitInjection`，自由函数仅模块内/单测）。
  8. **注入点数欠计**：spec 写"12 处"、草稿写"9+3+2+1"（算术=15）。**实测 18 处**（主 9 + lane **6** + 协议回填 2 + 轮载荷 1）⇒ 已全篇改 18，并把核对命令改为覆盖 `pushInjection`/`pushMemory(`/`store.appendUser(`（只 grep `pushInjection` 会漏掉全部 6 处 lane 注入），且**要求逐处人读判断**（`store.appendUser` 也用于正常消息写入）。
  9. **预算自拍默认值**：`createInjectBus({totalBudgetBytes = 4096})` 违反 spec §3.1「预算单一权威在 `knowledge-inject.mjs`」。已改为默认派生 `resolveInjectBudget()`（A15）。
- **行号修正**（实测）：`turnToolDigest.push` 字面量 `:1031-1036`（原写 `:1031-1037`）；守卫① `:489`（`loopStop` 对象）→ `reason` 在 `:490`。另 `⑥ 进展刷新 :1076-1082` 已更正为"**计数刷新，无注入**"，不得当自愈注入计数。

**4. 拆分自审（批 1 / 批 2 边界）**

- S1+（注入总账）已整体迁出至批 1 计划（`2026-09-20-batch1-observable-and-experience-dedup.md`），本计划不再含 `inject-ledger.mjs`。
- 两批的**唯一交界面** = Task 7 Step 9 的 L4 等价锁可能需要 O2 的 `turnStats.guard`。已在「范围与非范围」写明：**若批 1 未落地，Task 7 用本地计数替代并在评审时说明**——避免隐性依赖导致批 2 无法独立交付。
- 测试文件数账：基线 **210**（实测）→ 批 2 新增 4 = **214**；批 1 另增（其计划内自述）。两者相加需与最终总数核对。
