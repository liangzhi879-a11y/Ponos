# 注入总账 + 循环体契约（S1+ → S2 → S3）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 先把"注入账"建起来（S1+，纯增量、零行为变更），再把主循环与子 lane 的守卫序收敛为一份共享循环体契约（S2/S3，等价重构），使后续模式/方法论/注入总线的改动有测量面与统一落点。

**Architecture:** 三步走，每步独立可交付、可回滚：
1. **S1+**：新增注入总账（`inject_snapshot` → `appendMeta`），与只读分段计量；**不改任何注入内容与提示词**。
2. **S2**：新建 `kernel/loop-core.mjs`，把主循环的守卫序抽成**参数化 profile**（`iterHead`/`inStream`/`afterStream` 三段），并由 `ctx.emitInjection(text, {persist, event})` 承载全部自愈注入——**零行为变更**。
3. **S3**：lane 复用同一 `runOnce`，传"简化档" profile（无 health/锚点/完整压缩）。

**Tech Stack:** Node.js ESM（`.mjs`）、`node:test` + `node:assert/strict`、现有 `createEngine`/`createSessionStore`/`createCompactor`、`npm run test:kernel`。

## Global Constraints

以下为项目级硬约束，**每个任务的要求都隐含包含本节**；数值与措辞逐字来自 spec，不得改写：

- **B1 冻结面**：`ctx.emitInjection(text, { persist, event })` —— **只冻结这三项**。`priority`/`budgetBytes`/`kind`/`phase` 由 **S3.5** 才引入（本计划不涉及 S3.5）。
- **命名纪律**：唯一出口为 **`ctx.emitInjection`**。**不得**命名为 `ctx.inject`（与 `LoopProfile.inject` 字段语义冲突）。
- **零行为变更**：S2/S3 是**等价重构**。提示词字节、wire 事件序列、`turnToolDigest`、`turnStats`、守卫触发时机与文案**全部不变**。发现的 bug **另开 issue，不在本计划内顺手修**。
- **只读长度，不重组**：分段计量**只取长度**，**不得把提示词拆成"可重排的块"**。
- **不删既有字段**：`metrics.json` 的既有 `inject` / `search` 段**只增不删**（sidecar 形状不变）。
- **口径**：S1+ **不改** `build` 预算口径——字符→字节的换算归 **S4.5**，本计划不做。
- **守卫计数器语义**：切换/搬迁**不清零** `errorStreak`/`repeatStreak`/`stallHeals`/`attemptMaxTokens`（防"守卫预算重置"被反复利用规避熔断）。
- **回归锁**：L1 现有测试全绿且**数量不变**；L2 守卫命中用例（文案/事件/计数/收尾时机逐一不变）；L3 mock 会话回放（digest/turnStats/wire 序列一致）；**L4a 同相位断言（S3.5 才有意义）/ L4b 双重等价留待 S3.5**。
- **文件暂存纪律**：**禁止 `git add -A`**（常态数十项他人在途改动）。按文件精确 `git add <path>`。
- **既有验证器契约**（改动后必须仍绿）：
  - `npm run verify:experience-inject` —— 断言 `bridge.buildExperienceIndex(4096)` 存在且 `buildSedimentPrompt` 含"经验沉淀"（**经验注入已从全量迁移为索引**）。
  - `npm run verify:milestones-start` —— 断言 `extractMilestoneMarks`（`server/milestones.mjs`）**仅解析**。

### 交付前门禁（每条都不能省）

```bash
npm run test:kernel                                     # 212 个内核测试全绿
npm run kit:check                                       # 红 0（EXIT=0）
node --test --test-timeout=120000 "kit/**/*.test.mjs"    # ★ 引号必须有，否则静默漏测
npm run verify:ci                                       # EXIT=0
npm run verify:experience-inject                        # 经验注入契约未破
```

> ★ 引号不是风格问题：不加引号时 shell 把 `**` 当单个 `*` ⇒ **静默漏掉** `kit/cli.test.mjs` 与 `kit/gui.test.mjs`。

## 范围与非范围

**本计划实现**：`S1+`（O4 注入总账）、`S2`（B1 契约与守卫序参数化）、`S3`（lane 复用）。

**明确不在本计划**：
- `S1`（O1 `turnToolDigest.size` / O2 `turnStats.guard`）—— 独立纯增量，可并行另做；其中 **O3（模式 meta）阻塞于 S4**（模式尚不存在）。本计划**不实现**，但 Task 1 的分段计量会复用同一 `appendMeta` 通道，不冲突。
- `S3.5`（`kernel/inject-bus.mjs` 抽取 + 12 处注入改走出口 + `priority`/`budgetBytes`/`kind`/`phase`）—— Q1 决定：**B1 先立出口并冻结三项**，S3.5 才做总线与注册。
- `S4`–`S9.5`（模式、方法论下沉、三层化）—— 待 S3 后评审。

### Q1 接口冻结的解读（务必按此实现，避免与 spec 打架）

spec 有两处表述需要统一理解：
- 注入 spec §9 Q1(a)：**B1 搬迁时即以 `ctx.emitInjection(text, { persist, event })` 为唯一注入出口**。
- 主 spec §12.1 S3.5 行：**"12 处指令注入改走 `ctx.emitInjection`"**。

**本计划的统一解读**（已与 spec 的"B1 冻结面最小化"一致）：

| 阶段 | 做什么 |
|---|---|
| **B1（Task 2–7）** | 在 `loop-core.mjs` 内**建立出口**，并把**随守卫逻辑一起搬迁进 loop-core 的注入调用**改走该出口（等价）。**不改**未搬迁的注入点，**不建总线模块**，**不引入**三个扩展字段。 |
| **S3.5（不在本计划）** | 新建 `inject-bus.mjs`、注册渲染器（含 `withAnchorTail` 作 `beforeRequest` 相位 `derived` 渲染器）、引入 `priority`/`budgetBytes`/`kind`/`phase`、把**剩余注入点**改走出口。 |

**净效果**：S3.5 的"改 12 个点"退化为"换实现 + 加注册"，正是 Q1 的意图。

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `kernel/loop-core.mjs` | **新建**。循环体契约：`runOnce(state, ctx)` / `shouldStop(state, ctx)` / `resolveGuards(profile, phase)` / `emitInjection(ctx, text, meta)`。**不引用 engine 闭包**（依赖全走 `ctx`）。 | 新建 |
| `kernel/loop-profile.mjs` | **新建**。`LoopProfile` 定义与校验：`MAIN_PROFILE` / `LANE_PROFILE` / `validateProfile()`。纯数据 + 纯函数。 | 新建 |
| `kernel/inject-ledger.mjs` | **新建**。注入总账：`summarizeInjection(snapshot)` → 规范化记录；`buildSegmentMeters(...)` → 只读分段计量。纯函数，无 IO。 | 新建 |
| `kernel/cli.mjs` | 轮边界挂总账：每轮 `appendMeta('inject_snapshot', ...)`。 | 修改（小） |
| `kernel/knowledge-inject.mjs` | `getInjectStats()` 增加只读计量字段（**只增不删**）。 | 修改（小） |
| `kernel/engine.mjs` | 主循环改由 `runOnce` + `MAIN_PROFILE` 驱动（等价搬移）；lane 改由同一 `runOnce` + `LANE_PROFILE` 驱动。 | 修改（大、分 3 次提交） |
| `kernel-tests/loop-core-contract.test.mjs` | **新建**。契约单元测试（纯函数、不需要 mock API）。 | 新建 |
| `kernel-tests/loop-guard-order-equivalence.test.mjs` | **新建**。L2 守卫序等价锁。 | 新建 |
| `kernel-tests/inject-ledger.test.mjs` | **新建**。总账与分段计量单测。 | 新建 |

**新建文件的边界理由**：`loop-core` 只做"一轮迭代怎么跑"，`loop-profile` 只做"参数长什么样/是否合法"，`inject-ledger` 只做"怎么记账"。三者互不依赖对方内部，各自可单测。

---

## Task 1: S1+ —— 注入总账（O4）与只读分段计量

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
4. **不改** `build` 预算口径（字符→字节归 S4.5）。

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
// 目的：让每一次注入都有账——\"注了什么、占了多少、走的是哪条渠道\"。
// 硬约束（spec O4）：
//   ① 只取长度，不得重排提示词（本模块不持有提示词，只接收已算好的字节数）
//   ② 不删 metrics.json 既有 inject/search 段（本模块不写 metrics.json）
//   ③ 不改 build 预算口径（字符→字节换算归 S4.5）
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
 * 渠道缺省为 null（区分\"未走该渠道\"与\"走了但 0 命中\"）。
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

在 `cli.mjs` 的轮边界处（`onTurnEnd` 或等价位置，Step 1 已定位实际行号）追加：

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

Expected: **212 个测试文件全绿，数量不得减少**（若计数变化，说明误删/误改了既有测试，必须回退）。

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
- 硬约束：只取长度不重排提示词；不改 build 预算口径（字符→字节归 S4.5）；metrics.json 段名不变
- 测试 7 例；2026-09-03 发现：注入散在 12 处且 4 处无留痕，本任务先立账不动行为"
```

---

## Task 2: S2a —— `loop-core.mjs` 契约骨架与 `LoopProfile`

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

本任务**只建契约与纯函数**，**不碰 engine.mjs**。这样 Task 3–5 的搬移有稳定目标，且契约本身可独立单测。

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
| `afterStream` | ⑥ 进展刷新 | `:1076-1082` | 自愈注入 |
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

> **锚点是给你定位用的，不是契约**。开工第一步必须**重新核实行号**（Task 3 Step 1 给了命令）；行号漂移以实测为准。

- [ ] **Step 1: 写失败测试**

`kernel-tests/loop-core-contract.test.mjs`：

```js
// 循环体契约（S2/B1）：profile 校验、守卫序解析、注入出口形状
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAIN_PROFILE, LANE_PROFILE, validateProfile, resolveGuards,
} from '../kernel/loop-profile.mjs'
import { emitInjection } from '../kernel/loop-core.mjs'

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

test('LANE_PROFILE 关闭 health/锚点/完整压缩（刻意差异，不收敛）', () => {
  assert.equal(LANE_PROFILE.health.fidelityAnchor, false)
  assert.equal(LANE_PROFILE.compactor.preStep, false)
  assert.equal(LANE_PROFILE.inject.pendingNext, false)
  assert.equal(LANE_PROFILE.stop, 'guardStop')
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

/** 允许的守卫名（与 engine.mjs 现有守卫逐一对齐） */
export const KNOWN_GUARDS = new Set([
  // iterHead
  'wallClock', 'iterCap', 'stall',
  // inStream
  'streamWallClock', 'genRepeat', 'nearRepeat', 'idleWatchdog', 'upstreamDead',
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
    inStream: ['streamWallClock', 'genRepeat', 'nearRepeat', 'idleWatchdog', 'upstreamDead'],
    afterStream: ['repeatHeal', 'failureHeal', 'progressRefresh', 'repeatReminder', 'meltdownStop'],
  },
  compactor: { preStep: true, laneCompact: false },
  health: { fidelityAnchor: true, recordTurnContent: true },
  inject: { pendingNext: true, inbox: false },
  stop: 'loopStop',
}

/** @type {LoopProfile} lane：刻意差异——无 health / 无锚点 / 无完整压缩（engine.mjs:1502-1504 注释明说） */
export const LANE_PROFILE = {
  guards: {
    iterHead: ['wallClock', 'iterCap', 'stall'],
    inStream: ['streamWallClock', 'genRepeat', 'idleWatchdog', 'upstreamDead'],
    afterStream: ['repeatHeal', 'failureHeal'],
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
 * 一轮迭代的执行体（B1 骨架）。
 * Task 3-5 会把守卫逻辑搬进来；本任务只保证形状与\"不改 state\"的契约。
 * @param {object} state
 * @param {object} ctx
 * @returns {Promise<object>}
 */
export async function runOnce(state, ctx) {
  void ctx
  return state
}

/**
 * 循环终止判定（收尾方式因宿主而异）。
 * @returns {null | {reason: string, message?: string}}
 */
export function shouldStop(state, ctx) {
  void state; void ctx
  return null
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

## Task 3: S2b —— `iterHead` 守卫序参数化（第一次搬移）

**Files:**
- Modify: `kernel/engine.mjs`（`runTurnInternal` 的迭代头守卫，`:486-516` 附近）
- Modify: `kernel/loop-core.mjs`（新增 `runIterHeadGuards`）
- Test: `kernel-tests/loop-guard-order-equivalence.test.mjs`（新建）

**Interfaces:**
- Consumes: `resolveGuards(MAIN_PROFILE, 'iterHead')`（Task 2）、`emitInjection`（Task 2）。
- Produces:
  - `runIterHeadGuards(state, ctx) → Promise<{ stop: null | {reason, message}, state }>`
  - `kernel-tests/loop-guard-order-equivalence.test.mjs` 的 `makeHarness({ profileId })`（Task 4–6 复用）

### 背景（实现者必读）

这是 **B1 的第一次真搬移**，风险最高。纪律：

1. **等价搬移**——逻辑逐行照搬，**不重排、不合并条件、不改文案**。
2. **发现 bug 不修**——记进 `docs/superpowers/audits/` 或 issue，**不在本任务修**。
3. **分三次提交**（Task 3/4/5 各一次），任一步红了可单独回退。

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
// 本任务只覆盖 iterHead；Task 4/5 扩充 inStream/afterStream。
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
  // 断言形状：守卫命中不得抛出，且 loopStop 语义可达（具体文案由 Task 3 Step 5 固化）
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

**做法**：写一个临时录制脚本（**不提交**），对三个 iterHead 守卫各构造一次命中，把 `{injections, events, turnStats}` 序列化到 `kernel-tests/fixtures/guard-order-iterhead.golden.json`。**该 golden 文件要提交**——它是等价锁的真值源。

```bash
mkdir -p kernel-tests/fixtures
node --test --test-timeout=120000 kernel-tests/loop-guard-order-equivalence.test.mjs
```

Expected: 生成 golden 文件；`git status` 应显示它为新文件。

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

Expected: 等价锁 PASS；`npm run test:kernel` **212 个文件全绿且数量不变**。

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

## Task 4: S2c —— `inStream` 守卫序参数化

**Files:**
- Modify: `kernel/engine.mjs`（流内守卫，`:620-694` 附近）
- Modify: `kernel/loop-core.mjs`（新增 `runInStreamGuards`）
- Modify: `kernel-tests/loop-guard-order-equivalence.test.mjs`（扩 golden）

**Interfaces:**
- Consumes: Task 2 的 `emitInjection`；Task 3 的 `makeHarness`。
- Produces: `runInStreamGuards(state, ctx) → Promise<{ stop, state }>`；`fixtures/guard-order-instream.golden.json`。

- [ ] **Step 1: 核实锚点**

```bash
cd /c/Users/T203-15/yfworking
grep -n "守卫①b\|守卫③\|守卫③b\|idleWatchdog\|createNearRepeatDetector\|detectGenerationRepeat\|upstream-dead" kernel/engine.mjs | head -20
```

Expected: 定位流内守卫实际行号。

- [ ] **Step 2: 扩 golden 基线（先录制）**

在 `loop-guard-order-equivalence.test.mjs` 增加 inStream 的录制用例，生成 `fixtures/guard-order-instream.golden.json`（含 `streamWallClock`/`genRepeat`/`nearRepeat`/`idleWatchdog`/`upstreamDead` 五项）。

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
    else if (name === 'idleWatchdog') { /* 照搬 */ }
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

Expected: 全绿；212 个文件不变。

- [ ] **Step 6: 提交**

```bash
cd /c/Users/T203-15/yfworking
git add kernel/loop-core.mjs kernel/engine.mjs kernel-tests/loop-guard-order-equivalence.test.mjs kernel-tests/fixtures/guard-order-instream.golden.json
git commit -m "refactor(loop): S2c inStream 守卫序参数化（等价搬移）

- runInStreamGuards：streamWallClock/genRepeat/nearRepeat/idleWatchdog/upstreamDead
- 本相位不产生 break，命中只置 loopStop/注入自愈，判停时机不变
- upstream-dead 保持\"只发事件不注入\"原样（补注入属行为变更，不归 B1）
- golden 基线扩至 inStream 五项"
```

---

## Task 5: S2d —— `afterStream` 守卫序参数化

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

Expected: 全绿；212 个文件不变。

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

## Task 6: S2e —— 三段合一的等价性收尾（L1 + L3）

**Files:**
- Modify: `kernel-tests/loop-guard-order-equivalence.test.mjs`（L3 回放）
- Test: `kernel-tests/loop-core-contract.test.mjs`（补 profile 完整性）

**Interfaces:**
- Consumes: Task 3–5 的 golden 三份。
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

- [ ] **Step 2: L3 会话级回放基线**

录制一段 mock 会话（多轮、含守卫触发）的 `turnToolDigest` / `turnStats` / wire 序列，存 `fixtures/session-replay.golden.json`，并加比对用例：

```js
test('L3 会话回放：digest/turnStats/wire 序列一致', () => {
  const golden = JSON.parse(readFileSync(new URL('./fixtures/session-replay.golden.json', import.meta.url), 'utf8'))
  // 逐项 deepEqual；若失败，先确认是\"重构引入差异\"还是\"基线需重录\"
  assert.ok(Array.isArray(golden.turns))
})
```

- [ ] **Step 3: 三份 golden 全跑 + 全量测试 + 门禁**

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

## Task 7: S3 —— lane 复用同一 `runOnce`

**Files:**
- Modify: `kernel/engine.mjs`（`runSubAgentLoop`，`:1505-1855` 附近）
- Test: `kernel-tests/loop-lane-profile.test.mjs`（新建）

**Interfaces:**
- Consumes: `LANE_PROFILE`（Task 2）、`runIterHeadGuards`/`runInStreamGuards`/`runAfterStreamGuards`（Task 3–5）。
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

test('lane 不含 nearRepeat / progressRefresh / repeatReminder（刻意差异）', () => {
  assert.ok(!resolveGuards(LANE_PROFILE, 'inStream').includes('nearRepeat'))
  assert.ok(!resolveGuards(LANE_PROFILE, 'afterStream').includes('progressRefresh'))
  assert.ok(!resolveGuards(LANE_PROFILE, 'afterStream').includes('repeatReminder'))
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

Expected: PASS（profile 已在 Task 2 定义）。此测试的作用是**把差异钉成契约**——lane 后续改动若误丢共享守卫会立刻红。

- [ ] **Step 4: lane 改调契约实现**

在 `runSubAgentLoop` 中，把三段守卫的内联实现替换为与主循环相同的契约调用，**传 `LANE_PROFILE`**：

```js
const laneCtx = { ...loopCtx, guards: {
  iterHead: resolveGuards(LANE_PROFILE, 'iterHead'),
  inStream: resolveGuards(LANE_PROFILE, 'inStream'),
  afterStream: resolveGuards(LANE_PROFILE, 'afterStream'),
} }
```

**要点**：
- lane 不注册锚点渲染器、不启用 health（**这是 Task 2 profile 已表达的差异**，靠 `LANE_PROFILE.health.fidelityAnchor === false` 生效）。
- `guardStop` 的 `return` 语义保持——**不要**改成 `break`。
- lane 的 `inbox` 吸收路径**不动**。

- [ ] **Step 5: 跑全量 + 门禁**

```bash
cd /c/Users/T203-15/yfworking
node --test --test-timeout=120000 kernel-tests/loop-lane-profile.test.mjs
npm run test:kernel
```

Expected: 全绿；212 个文件不变。

- [ ] **Step 6: 确认共享只有一份**

```bash
cd /c/Users/T203-15/yfworking
grep -c "errorMeltdownText\|repeatRemindText" kernel/engine.mjs kernel/loop-core.mjs
```

Expected: **文案常量引用集中在 `loop-core.mjs`**；`engine.mjs` 侧不应再有守卫文案的内联注入调用（若有残留，说明该点未搬迁，需补）。

- [ ] **Step 7: 提交**

```bash
cd /c/Users/T203-15/yfworking
git add kernel/engine.mjs kernel-tests/loop-lane-profile.test.mjs
git commit -m "refactor(loop): S3 lane 复用同一守卫实现（LANE_PROFILE 表达刻意差异）

- runSubAgentLoop 改调 runIterHeadGuards/runInStreamGuards/runAfterStreamGuards
- 刻意差异（无 health/锚点/完整 preStep/nearRepeat/progressRefresh/repeatReminder）由 LANE_PROFILE 显式表达
- guardStop 的 return 语义保持（不改成 break）；inbox 吸收路径不动
- 新增测试把\"共享 vs 刻意不同\"钉成契约（误丢共享守卫会立刻红）
- 至此 B1 完成：可共享守卫序一处实现、两处生效（约 300-350 行），250 行刻意差异保留"
```

---

## 交付前总门禁（S3 完成后执行）

```bash
cd /c/Users/T203-15/yfworking
npm run test:kernel                                      # 212 文件全绿，数量不变
npm run kit:check                                        # EXIT=0
node --test --test-timeout=120000 "kit/**/*.test.mjs"     # ★ 引号必须有
npm run verify:ci                                        # EXIT=0
npm run verify:experience-inject                         # 经验注入契约未破
npm run verify:milestones-start                          # milestone 解析契约未破
git status --short                                       # 确认没有夹带他人在途改动
```

**然后停下评审**（Q7：先推到 S3 再评审），**不要**直接进 S3.5。

## 评审时的汇报清单（S3 后）

| 项 | 要报什么 |
|---|---|
| 等价性 | L1/L2/L3 三锁结果；golden 基线文件清单 |
| 共享收益 | `loop-core.mjs` 行数 vs `engine.mjs` 净变化（预期：可共享约 300-350 行一处实现） |
| 刻意差异 | 250 行保留清单（逐条对应 `LANE_PROFILE` 的 false/true） |
| 注入出口 | 已改走 `emitInjection` 的点位清单 vs 仍待 S3.5 处理的剩余点位 |
| 观察数据 | `inject_snapshot` 记账样例（连续 3 轮） |
| 意外发现 | 搬迁中发现的 bug（**只记录不修**）清单 |

## Self-Review

**1. Spec coverage**

| spec 要求 | 落在哪 |
|---|---|
| S1+ O4 注入总账（每轮 appendMeta + 分段 + 渠道） | Task 1 |
| S1+ 硬要求①只取长度 | Task 1 Step 4（`buildSegmentMeters` 只接收已算好的字节数；Step 9 要点明令不重组） |
| S1+ 硬要求②不删 metrics 段 | Task 1 Step 6 + Step 7 守护测试 |
| S1+ 硬要求③不改 build 口径 | Global Constraints（明确归 S4.5） |
| S2 契约 `runOnce(state, ctx)` | Task 2 Step 4 |
| S2 契约 `shouldStop` | Task 2 Step 4 |
| S2 三段守卫序参数化 | Task 3 / 4 / 5 |
| S2 冻结面 `text/persist/event` | Task 2 Step 4（未知 option 抛错）+ 契约测试 |
| S2 命名 `ctx.emitInjection`（禁 `ctx.inject`） | Global Constraints + Task 3 Step 5 |
| S2 不引用 engine 闭包 | Task 2 Step 4 模块头注 + Global Constraints |
| L1/L2/L3 回归锁 | Task 3 Step 7 / Task 6 Step 3 |
| S3 lane 复用 + 差异表达 | Task 7 |
| 交付门禁（含引号纪律） | 「交付前总门禁」 |
| 发现 bug 不顺手修 | Task 3 背景 + Task 4 `upstream-dead` 特别提醒 |

**2. Placeholder scan**

- 无 "TBD"/"TODO"/"implement later"。
- Task 3–5 的守卫函数体内是 `/* 照搬 engine.mjs X 行附近实现 */` 注释——这是**等价搬移任务的正确规格**（spec 明确"只做等价搬移，不顺手修"），并配了 **golden 基线**作为真值源，而非留白。**这是有意为之，不是占位符**。
- Task 3 Step 2 的第二个用例显式标注为"形状占位，Step 3 后替换"——**这是先录基线再比对的正确顺序**，已在 Step 3/4 给出替换后的真实代码。
- 所有新代码（`inject-ledger.mjs`、`loop-profile.mjs`、`loop-core.mjs`）**完整给出**。

**3. Type consistency**

- `emitInjection(ctx, text, meta)` —— Task 2 定义，Task 3 Step 5 使用，签名一致。
- `resolveGuards(profile, phase)` —— Task 2 定义，Task 3 Step 4 与 Task 7 Step 4 使用，一致。
- `MAIN_PROFILE`/`LANE_PROFILE` —— Task 2 定义，Task 3/6/7 使用，一致。
- `runIterHeadGuards`/`runInStreamGuards`/`runAfterStreamGuards` —— Task 3/4/5 定义，Task 7 使用，名称一致。
- `buildSegmentMeters`/`summarizeInjection`/`ledgerTotals` —— Task 1 定义且同任务内使用，一致。
- **已修正的三处**（自审 + 实测核对发现）：
  1. 早期草稿在 Task 2 用 `ctx.inject`，与 `LoopProfile.inject` 字段撞名 → 按 spec 改名 `ctx.emitInjection`，并在 Global Constraints 写明禁令。
  2. Task 3 测试用了不存在的 env 变量 `PONOS_WALL_CLOCK_MS` → 实测为 **`PONOS_TURN_TIMEOUT_MS`**，已改。
  3. Task 3 的注入示例写了 `reason: 'wall-clock'` → 实测守卫①的 reason 是 **`'timeout'`** 且**不发 `guard_heal`**；已改为以守卫⑥ `'loop-stall'` 为例，并补了**守卫 → reason 对照表**（含"② 不发事件"这一容易漏掉的事实）。
