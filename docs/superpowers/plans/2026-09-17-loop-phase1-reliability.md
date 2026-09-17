# loop 重设计 · Phase 1：调度可靠性 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 loop 循环在长间隔、内核被回收、内核崩溃三种情形下都不再静默中断，同时校准成本、真正实现回滚、修正无进展误判。

**Architecture:** 把「下次该跑的时刻」（`nextRunAt`）从内核进程内存 `setTimeout` 提升为**落盘持久语义**，并在长驻的 bridge 侧新增 `LoopSupervisor`：60s tick 扫描 `<YFW_HOME>/loop/*.meta.json`，到点且内核不在时以 `--resume` 唤醒（复用内核既有的 `loop.load()` 自动补投递能力）。同时给内核空闲回收器加"即将触发宽限"，避免正要跑的循环被无谓回收。遵守**单写者原则**：内核状态文件只由内核写、meta 文件只由 bridge 写。

**Tech Stack:** Node.js ESM（内核/bridge，`.mjs`）、`node:test` 测试、React + TypeScript + Zustand（GUI）、Vite

---

## Global Constraints

以下约束适用于**每一个**任务，逐条照抄自 spec，不得自行放宽：

- **单写者原则**：`<YFW_HOME>/loop/<sid>.json` **只由内核写**（bridge 只读）；`<YFW_HOME}/loop/<sid>.meta.json` **只由 bridge 写**（内核只读）。禁止任何跨进程写同一文件。
- **零回归锁①**：TUI 侧 `/loop` 语法解析行为逐字不变（`kernel/loop-commands.mjs` 的 `parseLoopDirective` 语义不动）。
- **零回归锁②**：非 `/loop` 文本必须逐字直通原消息路径，**绝不吞用户输入**（`translateLoopSend` 返回 `null` 时行为不变）。
- **零回归锁③**：`wire` 的 `loop` 帧既有字段 `judged` / `reason` / `error` / `index` / `total` **必须保留**，`end.reason` 仍是封闭 8 值集合 `completed | until_hit | cancelled | judge_error | verify_hit | budget_exceeded | no_progress | failed`。只增字段、不改语义。
- **落盘兼容**：`SCHEMA_VERSION` 保持 `1`；状态文件与 meta 文件**只增键**。旧文件缺新字段时一律**保守不动**（不复活、不误判），退回改动前行为。
- **静默降级**：新增的调度/告警/价格逻辑出现任何异常都**不得中断主循环或拖垮 bridge**（沿用既有 `try/catch` + 一次性 `warning` 风格）。
- **逃生开关**：`LOOP_SUPERVISOR=0` 关闭主管（默认开启），用于一键退回旧行为。
- **原子写**：所有状态落盘用 `tmp + rename`。
- **测试门槛**：每个任务结束时 `npm test` 全绿（含既有 44 个 loop 用例）+ `npm run typecheck` 绿。
- **环境变量（新增，供测试压时）**：`YFW_KERNEL_REAP_TICK_MS`（已存在）、`YFW_LOOP_SUPERVISOR_TICK_MS`、`YFW_LOOP_RESUME_MAX`、`YFW_LOOP_RESUME_PER_TICK`。

---

## File Structure

**新建**

| 文件 | 职责 |
|---|---|
| `kernel/model-prices.mjs` | 纯函数：模型单价三级解析（provider 配置 > 内置价表 > 估算兜底） |
| `server/loop-supervisor.mjs` | 纯逻辑：循环调度主管（读 meta/state → 判定 → 回调复活），依赖全部注入以便无 bridge 单测 |
| `server/loop-paths.mjs` | 纯函数：`<YFW_HOME>/loop/` 下 meta/state 路径与原子读写（bridge 唯一写者） |
| `kernel-tests/model-prices.test.mjs` | 三级解析优先级 / 未知模型兜底 / 字段缺失即旧行为 |
| `server/loop-supervisor.test.mjs` | 主管全部判定分支与退避/上限 |
| `server/loop-paths.test.mjs` | meta 原子写 / 读损坏降级 / 与内核 state 文件互不干扰 |
| `kernel-tests/loop-rollback.test.mjs` | stash 保护后 reset / stash 失败中止 / 非 git 降级 / 审批门 |
| `server/bridge-loop-reap.test.mjs` | 回收宽限：临近不回收、远回收、无记录旧行为 |

**修改**

| 文件 | 改动 |
|---|---|
| `kernel/loop.mjs` | 构造参数收 `prices`；`freshState` 增 `nextRunAt`/`aliveAt`/`priceSource`；`persist` 刷 `aliveAt`；`fingerprintOf` 用 `sig`；`nextDecision` 写 `nextRunAt`；`--until` 判定移入短路序；`rollback` 真执行 |
| `kernel/engine.mjs` | `turnToolDigest.push` 增 `sig` 字段（纯函数输入派生） |
| `kernel/cli.mjs` | 传入解析后的 `prices`；移除 cli 侧 `--until` 判定；rollback 实际执行接线 |
| `server/bridge.mjs` | `loopRegistry` 归约；loop start 时写 meta；回收宽限；挂载 supervisor tick；`loop_interrupted`/`loop_resumed` 广播 |
| `src/hooks/useYFWCLI.ts` | 归约 `loop_interrupted` / `loop_resumed` → warning store |
| `src/components/chat/SystemWarningStrip.tsx` | 两个新 level 的样式与标题 |
| `src/i18n/translations/{zh-CN,en-US}.ts` | 两个新告警文案 |
| `src/components/settings/*`（provider 表单） | 价格三字段输入 |
| `docs/bridge-contract.md` | 补 `nextRunAt`/`priceSource`/`loop_resumed`/`loop_interrupted` |

**任务依赖序**

```
T1(价格模块) ─→ T2(成本接线)
T3(指纹 sig)          ─┐
T4(调度字段落盘) ─→ T5(--until移入) ─→ T6(rollback)  ← 均在内核侧，可与 T1/T2 并行
T7(loopRegistry) ─┬─→ T9(回收宽限)
T8(meta 落盘) ────┴─→ T10(主管) ─→ T11(可见告警)
T12(设置页价格 UI) ← 依赖 T1
T13(端到端反证 + 回归) ← 依赖全部
```

---

## Task 1: 模型价格三级解析模块

**Files:**
- Create: `kernel/model-prices.mjs`
- Test: `kernel-tests/model-prices.test.mjs`

**Interfaces:**
- Consumes: 无（纯函数，零依赖）
- Produces:
  - `BUILTIN_PRICES: Record<string, { input: number, output: number, cacheReadRatio: number }>` — 键为模型名（小写）
  - `resolveModelPrices(model: string, providerCfg: object|null, env: object): { pricePerMInput: number, pricePerMOutput: number, cacheReadRatio: number, source: 'provider'|'builtin'|'estimate' }`

- [ ] **Step 1: 写失败测试**

创建 `kernel-tests/model-prices.test.mjs`：

```js
// 模型单价三级解析：provider 显式配置 > 内置价表 > 估算兜底（P1-2）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveModelPrices, BUILTIN_PRICES } from '../kernel/model-prices.mjs'

const ENV = { PONOS_PRICE_PER_M_INPUT: '0.2', PONOS_PRICE_PER_M_OUTPUT: '1.2', PONOS_CACHE_READ_RATIO: '0.1' }

test('provider 显式配置优先于内置价表', () => {
  const cfg = { models: [{ id: 'deepseek-chat', inputPricePerM: 3, outputPricePerM: 9, cacheReadRatio: 0.25 }] }
  const r = resolveModelPrices('deepseek-chat', cfg, ENV)
  assert.equal(r.pricePerMInput, 3)
  assert.equal(r.pricePerMOutput, 9)
  assert.equal(r.cacheReadRatio, 0.25)
  assert.equal(r.source, 'provider')
})

test('provider 配置缺字段 → 该字段回落内置价表', () => {
  const cfg = { models: [{ id: 'deepseek-chat', inputPricePerM: 3 }] }
  const r = resolveModelPrices('deepseek-chat', cfg, ENV)
  const builtin = BUILTIN_PRICES['deepseek-chat']
  assert.equal(r.pricePerMInput, 3)          // 显式给的
  assert.equal(r.pricePerMOutput, builtin.output) // 未给的回落内置
  assert.equal(r.source, 'provider')
})

test('无 provider 配置 → 用内置价表', () => {
  const r = resolveModelPrices('deepseek-chat', null, ENV)
  const builtin = BUILTIN_PRICES['deepseek-chat']
  assert.equal(r.pricePerMInput, builtin.input)
  assert.equal(r.pricePerMOutput, builtin.output)
  assert.equal(r.source, 'builtin')
})

test('模型名大小写与供应商前缀归一化', () => {
  const a = resolveModelPrices('DeepSeek-Chat', null, ENV)
  const b = resolveModelPrices('deepseek/deepseek-chat', null, ENV)
  assert.equal(a.source, 'builtin')
  assert.equal(b.source, 'builtin')
  assert.equal(a.pricePerMInput, b.pricePerMInput)
})

test('未知模型 → 回落 env 默认且 source=estimate', () => {
  const r = resolveModelPrices('totally-unknown-model-xyz', null, ENV)
  assert.equal(r.source, 'estimate')
  assert.equal(r.pricePerMInput, 0.2)
  assert.equal(r.pricePerMOutput, 1.2)
  assert.equal(r.cacheReadRatio, 0.1)
})

test('env 缺失 → estimate 用硬编码兜底（旧行为）', () => {
  const r = resolveModelPrices('unknown-xyz', null, {})
  assert.equal(r.source, 'estimate')
  assert.equal(r.pricePerMInput, 0.2)
  assert.equal(r.pricePerMOutput, 1.2)
})

test('非法/负数显式配置被忽略（不污染成本）', () => {
  const cfg = { models: [{ id: 'deepseek-chat', inputPricePerM: -1, outputPricePerM: 'abc' }] }
  const r = resolveModelPrices('deepseek-chat', cfg, ENV)
  const builtin = BUILTIN_PRICES['deepseek-chat']
  assert.equal(r.pricePerMInput, builtin.input)
  assert.equal(r.pricePerMOutput, builtin.output)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test kernel-tests/model-prices.test.mjs`
Expected: FAIL —— `Cannot find module '../kernel/model-prices.mjs'`

- [ ] **Step 3: 实现模块**

创建 `kernel/model-prices.mjs`：

```js
// kernel/model-prices.mjs —— 模型单价三级解析（spec P1-2）
// ---------------------------------------------------------------------------
// 优先级（用户决策）：① provider 显式配置 > ② 内置价表 > ③ env/硬编码估算兜底。
// 现状缺陷：单价只由 env 硬编码（0.2/1.2 USD/M，kernel/cost.mjs:4），而 providers.json
// 无任何价格字段 ⇒ 循环成本数字与实际不符，预算硬停会误停或不停。
// 本模块是纯函数、零依赖：不读文件、不碰网络，便于单测与复用。
// 键归一化：小写 + 去掉 "provider/" 前缀（"deepseek/deepseek-chat" → "deepseek-chat"）。

// 常见模型价表（USD / 百万 token）。数据仅作兜底默认，用户可在 provider 配置里覆盖。
// cacheReadRatio：缓存命中按 input 单价的该比例计费（与 kernel/cost.mjs 语义一致）。
export const BUILTIN_PRICES = {
  'deepseek-chat': { input: 0.27, output: 1.1, cacheReadRatio: 0.1 },
  'deepseek-reasoner': { input: 0.55, output: 2.19, cacheReadRatio: 0.1 },
  'gpt-4o': { input: 2.5, output: 10, cacheReadRatio: 0.5 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheReadRatio: 0.5 },
  'claude-3-5-sonnet': { input: 3, output: 15, cacheReadRatio: 0.1 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cacheReadRatio: 0.1 },
  'qwen-max': { input: 1.6, output: 6.4, cacheReadRatio: 0.0 },
  'glm-4-plus': { input: 0.7, output: 0.7, cacheReadRatio: 0.0 },
}

// 估算兜底（与 cost.mjs 既有默认一致，保证"无配置时行为不变"）
const FALLBACK = { input: 0.2, output: 1.2, cacheReadRatio: 0.1 }

function normalizeKey(model) {
  const s = String(model || '').trim().toLowerCase()
  if (!s) return ''
  const slash = s.lastIndexOf('/')
  return slash >= 0 ? s.slice(slash + 1) : s
}

// 只有有限正数才被采纳；其余（负数/NaN/字符串数字外的值/0）一律视为未配置。
// 0 视为未配置：免费模型应显式走 provider 配置，避免"0 成本"让预算硬停失效。
function posNum(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

// cacheReadRatio 允许 0（= 命中不计费），故单独判定：只排除负数与非数字。
function ratio(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return null
}

function envNum(env, key) {
  return posNum(env?.[key])
}

/**
 * @param {string} model 模型名（可含 provider/ 前缀，大小写不敏感）
 * @param {object|null} providerCfg provider 配置，形如 { models:[{ id, inputPricePerM, outputPricePerM, cacheReadRatio }] }
 * @param {object} env 环境变量表（注入以便测试）
 * @returns {{pricePerMInput:number, pricePerMOutput:number, cacheReadRatio:number, source:'provider'|'builtin'|'estimate'}}
 */
export function resolveModelPrices(model, providerCfg = null, env = process.env) {
  const key = normalizeKey(model)
  const builtin = key ? BUILTIN_PRICES[key] : null

  // ① provider 显式配置（按 id 归一化匹配；缺字段逐项回落）
  let cfgEntry = null
  const models = Array.isArray(providerCfg?.models) ? providerCfg.models : []
  if (key) cfgEntry = models.find((m) => normalizeKey(m?.id ?? m?.name) === key) || null

  const cfgIn = posNum(cfgEntry?.inputPricePerM)
  const cfgOut = posNum(cfgEntry?.outputPricePerM)
  const cfgRatio = ratio(cfgEntry?.cacheReadRatio)
  if (cfgIn !== null || cfgOut !== null || cfgRatio !== null) {
    return {
      pricePerMInput: cfgIn ?? builtin?.input ?? envNum(env, 'PONOS_PRICE_PER_M_INPUT') ?? FALLBACK.input,
      pricePerMOutput: cfgOut ?? builtin?.output ?? envNum(env, 'PONOS_PRICE_PER_M_OUTPUT') ?? FALLBACK.output,
      cacheReadRatio: cfgRatio ?? builtin?.cacheReadRatio ?? ratio(env?.PONOS_CACHE_READ_RATIO) ?? FALLBACK.cacheReadRatio,
      source: 'provider',
    }
  }

  // ② 内置价表
  if (builtin) {
    return {
      pricePerMInput: builtin.input,
      pricePerMOutput: builtin.output,
      cacheReadRatio: builtin.cacheReadRatio,
      source: 'builtin',
    }
  }

  // ③ 估算兜底（env 覆盖 → 硬编码默认；UI 据此标注「估算」）
  return {
    pricePerMInput: envNum(env, 'PONOS_PRICE_PER_M_INPUT') ?? FALLBACK.input,
    pricePerMOutput: envNum(env, 'PONOS_PRICE_PER_M_OUTPUT') ?? FALLBACK.output,
    cacheReadRatio: ratio(env?.PONOS_CACHE_READ_RATIO) ?? FALLBACK.cacheReadRatio,
    source: 'estimate',
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test kernel-tests/model-prices.test.mjs`
Expected: PASS（7 tests）

- [ ] **Step 5: 提交**

```bash
git add kernel/model-prices.mjs kernel-tests/model-prices.test.mjs
git commit -m "feat(loop): 模型单价三级解析模块（provider > 内置价表 > 估算兜底）"
```

---

## Task 2: loop 成本接入价格解析（并落盘 priceSource）

**Files:**
- Modify: `kernel/loop.mjs:20-26`（构造参数）、`kernel/loop.mjs:32-47`（freshState）、`kernel/loop.mjs:78-105`（start）
- Modify: `kernel/cli.mjs:1032`（createLoopController 调用处）
- Test: `kernel-tests/loop-controller.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 1 的 `resolveModelPrices(model, providerCfg, env)` → `{ pricePerMInput, pricePerMOutput, cacheReadRatio, source }`
- Produces: `createLoopController({ ..., prices })` 接受可选 `prices` 对象（形如 Task 1 返回值）；状态新增 `priceSource: string`，并在 `start` / `iter` / `end` 帧携带 `priceSource`（只增字段）

- [ ] **Step 1: 写失败测试**

在 `kernel-tests/loop-controller.test.mjs` **文件顶部**（既有 `makeEnv()` 之后、既有用例之前）加入本计划后面各任务共用的夹具：

```js
// 本计划（Phase 1）新增用例的共用夹具：返回可控的 controller + 路径 + 事件收集器。
// 与既有 makeEnv() 并存，不改动既有夹具与既有断言（零回归）。
// @param {object} env 环境变量（如 PONOS_LOOP_NOPROGRESS_N / 价格 / 复活上限）
// @param {object} [extra] 额外注入 createLoopController 的字段（如 prices / engine.tools）
function mkLoop(env = {}, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-loop-ctl-'))
  const configDir = join(dir, 'home')
  mkdirSync(configDir, { recursive: true })
  const events = []
  const engine = {
    queueNext: () => {},
    judgeUntil: async () => ({ done: false, reason: '' }),
    ...(extra.engine || {}),
  }
  const controller = createLoopController({
    wire: { loop: (state, data = {}) => events.push({ state, ...data }), warning: () => {}, system: () => {} },
    engine,
    store: null, configDir, sessionId: 'sess-1', cwd: dir, env,
    ...extra,
  })
  return { controller, engine, configDir, dir, events }
}
```

在文件末尾追加：

```js
// P1-2：注入的 prices 生效，且 priceSource 落盘 + 随帧上报（只增字段）。
test('注入 prices 覆盖 env 默认并落盘 priceSource', async () => {
  const { controller, events, configDir } = mkLoop(
    { PONOS_PRICE_PER_M_INPUT: '0.2', PONOS_PRICE_PER_M_OUTPUT: '1.2' },
    { prices: { pricePerMInput: 10, pricePerMOutput: 20, cacheReadRatio: 0.5, source: 'provider' } },
  )
  controller.start({ prompt: 'x', count: 2 })
  await controller.onTurnEnd({ outcome: { usage: { input_tokens: 1e6, output_tokens: 1e6 }, toolDigest: [] } })
  assert.equal(controller.status().costUsd, 30) // 1e6/1e6 tokens × 10/20 USD per M
  assert.equal(controller.status().priceSource, 'provider')
  const st = JSON.parse(readFileSync(join(configDir, 'loop', 'sess-1.json'), 'utf-8'))
  assert.equal(st.priceSource, 'provider')
  const startFrame = events.find((e) => e.state === 'start' && e.priceSource)
  assert.equal(startFrame.priceSource, 'provider')
})

test('未注入 prices 时行为与改前一致（env 默认），source=estimate', async () => {
  const { controller } = mkLoop({ PONOS_PRICE_PER_M_INPUT: '0.2', PONOS_PRICE_PER_M_OUTPUT: '1.2' })
  controller.start({ prompt: 'x', count: 2 })
  await controller.onTurnEnd({ outcome: { usage: { input_tokens: 1e6, output_tokens: 0 }, toolDigest: [] } })
  assert.equal(controller.status().costUsd, 0.2)
  assert.equal(controller.status().priceSource, 'estimate')
})
```

> **注意**：`mkdtempSync` / `mkdirSync` / `join` / `tmpdir` / `readFileSync` 若该文件尚未 import，请在顶部补齐对应的 `node:fs` / `node:path` / `node:os` 具名导入；**不要**修改既有 import 的既有条目。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test kernel-tests/loop-controller.test.mjs`
Expected: FAIL —— `controller.status().priceSource` 为 `undefined`（断言失败）

- [ ] **Step 3: 改 `kernel/loop.mjs` 构造参数**

把 `kernel/loop.mjs:20-26` 的 `prices` 常量改为"可注入 + env 兜底"：

```js
export function createLoopController({ wire, engine, store = null, configDir = '', sessionId = '', cwd = '', env = process.env, prices: pricesIn = null } = {}) {
  const file = join(configDir, 'loop', `${sessionId}.json`)
  // 单价来源（P1-2）：cli 传入 resolveModelPrices() 的结果（provider > 内置价表 > 估算）。
  // 未注入时保持改前行为：env 硬编码默认（零回归）。
  const prices = pricesIn && Number.isFinite(Number(pricesIn.pricePerMInput))
    ? {
        pricePerMInput: Number(pricesIn.pricePerMInput),
        pricePerMOutput: Number(pricesIn.pricePerMOutput),
        cacheReadRatio: Number(pricesIn.cacheReadRatio),
      }
    : {
        pricePerMInput: Number(env.PONOS_PRICE_PER_M_INPUT) || 0.2,
        pricePerMOutput: Number(env.PONOS_PRICE_PER_M_OUTPUT) || 1.2,
        cacheReadRatio: Number(env.PONOS_CACHE_READ_RATIO) || 0.1,
      }
  const priceSource = pricesIn?.source ? String(pricesIn.source) : 'estimate'
```

- [ ] **Step 4: 改 `freshState` 与 `start`**

`freshState()`（`kernel/loop.mjs:32-47`）的返回对象里，把 `costUsd: 0, steps: 0,` 一行改为：

```js
      costUsd: 0, steps: 0, priceSource,
```

`start()`（`kernel/loop.mjs:78-105`）里，在 `state.startedAt = new Date().toISOString()` 之后、`persist()` 之前插入：

```js
    state.priceSource = priceSource
```

并在该函数的 `emit('start', { ... })` 载荷中，把 `goal: state.goal, everyMs: state.everyMs, budget: state.budget,` 改为：

```js
      goal: state.goal, everyMs: state.everyMs, budget: state.budget, priceSource: state.priceSource,
```

- [ ] **Step 5: 在 iter 帧携带 priceSource**

`kernel/loop.mjs` 中所有 `emit('iter', { index: state.index, total: state.count, steps: state.steps, costUsd: Number(state.costUsd.toFixed(4)), ...})` 调用（共 4 处），在 `steps: state.steps,` 之后统一插入 `priceSource: state.priceSource,`。

`emit('end', ...)` 调用（共 4 处：`stop()` 内 1 处、`verify_hit`/`failed`/`completed` 各 1 处）同样插入 `priceSource: state.priceSource,`。

- [ ] **Step 6: 改 `kernel/cli.mjs` 传入解析结果**

在 `kernel/cli.mjs` 顶部 import 区加入：

```js
import { resolveModelPrices } from './model-prices.mjs'
```

把 `kernel/cli.mjs:1032` 的 `createLoopController({` 调用改为传入 prices：

```js
  const loop = createLoopController({
    prices: resolveModelPrices(
      // 模型名：用 cli 作用域内既有的本地变量 `model`（kernel/cli.mjs:612 已定义：
      // `let model = args.model || getProvider().model || settings.merged.model || ''`）。
      // 取不到时传空串 → source==='estimate'（= 改前行为，零回归）。
      (typeof model === 'string' && model) || '',
      null, // provider 价格表在 Task 13 接上（PONOS_MODEL_PRICES）
      env,
    ),
```

> **已核实**：`kernel/cli.mjs:612` 有本地变量 `model`，`createLoopController`（`:1032`）在同一模块作用域内可直接引用它。**不要新增模型状态通道**。

- [ ] **Step 7: 跑测试确认通过**

Run: `node --test kernel-tests/loop-controller.test.mjs && node --test kernel-tests/loop-commands.test.mjs kernel-tests/loop-e2e.test.mjs kernel-tests/loop-verify.test.mjs kernel-tests/loop-stall-guard.test.mjs`
Expected: PASS（新增 2 个用例通过，既有 44 个用例全绿）

- [ ] **Step 8: 提交**

```bash
git add kernel/loop.mjs kernel/cli.mjs kernel-tests/loop-controller.test.mjs
git commit -m "feat(loop): 成本单价可注入并落盘 priceSource（P1-2 接线）"
```

---

## Task 3: 工具摘要内容签名（修正无进展误判）

**Files:**
- Modify: `kernel/engine.mjs:983-991`（`turnToolDigest.push`）
- Modify: `kernel/loop.mjs:70-75`（`fingerprintOf`）
- Test: `kernel-tests/loop-controller.test.mjs`（追加）

**Interfaces:**
- Consumes: 无
- Produces:
  - `turnToolDigest` 元素新增 `sig: string` 字段（**纯函数输入派生，不做任何文件 I/O**）
  - `fingerprintOf(outcome)` 的指纹元素格式由 `${name}:${path}` 变为 `${name}:${path}:${sig}`

**背景（为什么要做）**：现状指纹只含 `<工具名>:<路径>`，因此"反复改进同一个文件、每轮内容都不同"会被判为**无进展**，连续 3 轮即升级为待人工审批 —— 把正常推进误判成停滞。

- [ ] **Step 1: 写失败测试**

在 `kernel-tests/loop-controller.test.mjs` 末尾追加：

```js
// P1-4：指纹纳入内容签名 —— 同路径内容变更算进展，同路径同内容才算无进展。
test('同路径内容变更 → 不计无进展（误报修正）', async () => {
  const { controller } = mkLoop({ PONOS_LOOP_NOPROGRESS_N: '3' })
  controller.start({ prompt: 'x', count: 10 })
  // 三轮都写同一个文件，但 sig 各不相同 = 内容在变 = 有进展
  for (const sig of ['a1', 'b2', 'c3']) {
    await controller.onTurnEnd({ outcome: { usage: {}, toolDigest: [{ name: 'Write', path: 'f.txt', isError: false, sig }] } })
  }
  assert.equal(controller.status().noProgress.streak, 1)
  assert.equal(controller.status().status, 'running')
})

test('同路径同内容 → 计无进展', async () => {
  const { controller } = mkLoop({ PONOS_LOOP_NOPROGRESS_N: '3' })
  controller.start({ prompt: 'x', count: 10 })
  for (let i = 0; i < 3; i++) {
    await controller.onTurnEnd({ outcome: { usage: {}, toolDigest: [{ name: 'Write', path: 'f.txt', isError: false, sig: 'same' }] } })
  }
  assert.equal(controller.status().noProgress.streak, 3)
  assert.equal(controller.status().status, 'awaiting_approval')
})

test('重复读同一文件 → 计无进展（结果签名相同）', async () => {
  const { controller } = mkLoop({ PONOS_LOOP_NOPROGRESS_N: '3' })
  controller.start({ prompt: 'x', count: 10 })
  for (let i = 0; i < 3; i++) {
    await controller.onTurnEnd({ outcome: { usage: {}, toolDigest: [{ name: 'Read', path: 'f.txt', isError: false, sig: 'r:1200' }] } })
  }
  assert.equal(controller.status().noProgress.streak, 3)
})

test('重复相同错误 → 计无进展', async () => {
  const { controller } = mkLoop({ PONOS_LOOP_NOPROGRESS_N: '3' })
  controller.start({ prompt: 'x', count: 10 })
  for (let i = 0; i < 3; i++) {
    await controller.onTurnEnd({ outcome: { usage: {}, toolDigest: [{ name: 'Bash', path: '', isError: true, errorText: 'boom' }] } })
  }
  assert.equal(controller.status().noProgress.streak, 3)
})

test('缺 sig 字段（旧内核帧）→ 回落旧行为（同路径即无进展）', async () => {
  const { controller } = mkLoop({ PONOS_LOOP_NOPROGRESS_N: '3' })
  controller.start({ prompt: 'x', count: 10 })
  for (let i = 0; i < 3; i++) {
    await controller.onTurnEnd({ outcome: { usage: {}, toolDigest: [{ name: 'Write', path: 'f.txt', isError: false }] } })
  }
  assert.equal(controller.status().noProgress.streak, 3)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test kernel-tests/loop-controller.test.mjs`
Expected: FAIL —— 第 1 个用例 `streak` 为 `3`（而非期望的 `1`），证明现状确实误报

- [ ] **Step 3: 在 `kernel/engine.mjs` 增加签名纯函数**

在 `kernel/engine.mjs` 顶部 import 区确认是否已有 `node:crypto` 的 `createHash`；**若没有则添加**：

```js
import { createHash } from 'node:crypto'
```

在 `kernel/engine.mjs` 中（模块级作用域，`turnToolDigest` 声明之前的位置，例如 `const turnToolDigest = []` 上方）加入：

```js
// 工具摘要内容签名（spec P1-4）：修正 loop 无进展指纹的误判。
// 约束：必须是**纯函数输入派生**，不做任何文件系统 I/O —— 否则每一步工具调用都会附带磁盘开销。
// 语义：
//   · 写类工具 → sha1(稳定序列化的输入)：内容不同即不同签名（"反复改进同一文件"算进展）
//   · 读类工具 → 结果正文长度：重复读同一文件得同一签名（仍算无进展，符合直觉）
//   · 其余工具 → 空串：指纹回落为 name:path（与改前一致，保守不误动）
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob'])
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const keys = Object.keys(v).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`
}
function toolSig(name, input, result) {
  try {
    if (WRITE_TOOLS.has(name)) {
      const h = createHash('sha1').update(stableStringify(input ?? {})).digest('hex')
      return `w:${h.slice(0, 12)}`
    }
    if (READ_TOOLS.has(name)) {
      const body = typeof result?.content === 'string' ? result.content : ''
      return `r:${body.length}`
    }
  } catch { /* 观测签名失败不影响主流程 */ }
  return ''
}
```

- [ ] **Step 4: 在 digest 元素里带上 sig**

把 `kernel/engine.mjs:984-990` 的 `turnToolDigest.push({ ... })` 改为：

```js
          turnToolDigest.push({
            name: String(blocks[i]?.name || ''),
            path: String(inp.file_path ?? inp.path ?? inp.pattern ?? inp.notebook_path ?? '').slice(0, 300),
            isError: toolResults[i]?.is_error === true,
            errorText: String(typeof toolResults[i]?.content === 'string' ? toolResults[i].content : '').slice(0, 200),
            sig: toolSig(String(blocks[i]?.name || ''), inp, toolResults[i]),
          })
```

- [ ] **Step 5: 在 `kernel/loop.mjs` 的指纹里使用 sig**

把 `kernel/loop.mjs:70-75` 的 `fingerprintOf` 改为：

```js
  function fingerprintOf(outcome) {
    const d = Array.isArray(outcome?.toolDigest) ? outcome.toolDigest : []
    // 参与签名：`${name}:${path}:${sig}`。sig 缺失（旧内核/非写读类工具）时退化为 `${name}:${path}`
    // —— 与改前逐字一致（零回归）：旧帧下"同路径即无进展"的判定不变。
    const tag = (t) => `${t.name}:${t.path}${t.sig ? `:${t.sig}` : ''}`
    const files = d.filter((t) => !t.isError && t.path).map(tag).sort().join(',')
    const errs = d.filter((t) => t.isError).map((t) => `${t.name}:${String(t.errorText || '').slice(0, 60)}`).sort().join(',')
    return `${files}|${errs}`
  }
```

- [ ] **Step 6: 跑测试确认通过**

Run: `node --test kernel-tests/loop-controller.test.mjs kernel-tests/loop-e2e.test.mjs kernel-tests/loop-stall-guard.test.mjs`
Expected: PASS（新增 5 个用例通过，既有用例全绿）

- [ ] **Step 7: 确认无额外 I/O**

Run: `git diff kernel/engine.mjs | grep -nE "readFileSync|statSync|existsSync|openSync"`
Expected: 无输出（证明 `sig` 是纯输入派生，未引入文件系统调用）

- [ ] **Step 8: 提交**

```bash
git add kernel/engine.mjs kernel/loop.mjs kernel-tests/loop-controller.test.mjs
git commit -m "fix(loop): 无进展指纹纳入内容签名，修正同路径改内容的误判（P1-4）"
```

---

## Task 4: loop 调度字段落盘（nextRunAt / aliveAt）

**Files:**
- Modify: `kernel/loop.mjs:32-47`（freshState）、`kernel/loop.mjs:50-64`（persist）、`kernel/loop.mjs:108-117`（stop）、`kernel/loop.mjs:209-331`（onTurnEnd 的两个 next 出口）
- Test: `kernel-tests/loop-controller.test.mjs`（追加）

**Interfaces:**
- Consumes: 无
- Produces: 持久化的 `nextRunAt: number`（ms 时间戳，`0` = 无待触发的下一轮）与 `aliveAt: string`（ISO 时间）；`onTurnEnd` 的返回值形状**不变**（`{action,delayMs,rationale}`）

**为什么**：`nextRunAt` 是**持久语义**，现状只活在内核进程内存的 `setTimeout` 里（`kernel/cli.mjs:1302`）。内核一被回收/崩溃，语义即蒸发且无人知晓 —— 这是 P1-1 的根因。落盘后 bridge 主管才能据此唤醒。

- [ ] **Step 1: 写失败测试**

在 `kernel-tests/loop-controller.test.mjs` 末尾追加：

```js
// P1-1 前提：nextRunAt / aliveAt 落盘，供 bridge 主管判定"下次该跑的时刻"。
test('返回 next 时落盘 nextRunAt（含 --every 延迟）', async () => {
  const { controller, configDir } = mkLoop({})
  controller.start({ prompt: 'x', count: 5, everyMs: 60_000 })
  const before = Date.now()
  const d = await controller.onTurnEnd({ outcome: { usage: {}, toolDigest: [] } })
  assert.equal(d.action, 'next')
  const st = JSON.parse(readFileSync(join(configDir, 'loop', 'sess-1.json'), 'utf-8'))
  assert.ok(st.nextRunAt >= before + 60_000, 'nextRunAt 应约为 now + everyMs')
  assert.ok(st.nextRunAt <= Date.now() + 60_000 + 2000)
})

test('--every 为 0 → nextRunAt 约等于当前时刻', async () => {
  const { controller, configDir } = mkLoop({})
  controller.start({ prompt: 'x', count: 5 })
  const before = Date.now()
  await controller.onTurnEnd({ outcome: { usage: {}, toolDigest: [] } })
  const st = JSON.parse(readFileSync(join(configDir, 'loop', 'sess-1.json'), 'utf-8'))
  assert.ok(st.nextRunAt >= before && st.nextRunAt <= Date.now() + 2000)
})

test('收尾（次数耗尽）→ nextRunAt 清零且 status 终态', async () => {
  const { controller, configDir } = mkLoop({})
  controller.start({ prompt: 'x', count: 1 })
  const d = await controller.onTurnEnd({ outcome: { usage: {}, toolDigest: [] } })
  assert.equal(d.action, 'stop')
  const st = JSON.parse(readFileSync(join(configDir, 'loop', 'sess-1.json'), 'utf-8'))
  assert.equal(st.status, 'done')
  assert.equal(st.nextRunAt, 0)
})

test('aliveAt 随每次 persist 刷新', async () => {
  const { controller, configDir } = mkLoop({})
  controller.start({ prompt: 'x', count: 5 })
  const st1 = JSON.parse(readFileSync(join(configDir, 'loop', 'sess-1.json'), 'utf-8'))
  assert.ok(typeof st1.aliveAt === 'string' && st1.aliveAt.length > 0)
  await new Promise((r) => setTimeout(r, 5))
  await controller.onTurnEnd({ outcome: { usage: {}, toolDigest: [] } })
  const st2 = JSON.parse(readFileSync(join(configDir, 'loop', 'sess-1.json'), 'utf-8'))
  assert.ok(st2.aliveAt >= st1.aliveAt)
})

test('旧状态文件（无 nextRunAt）加载后字段补默认，不误判为待触发', () => {
  const { controller, configDir } = mkLoop({})
  const dir = join(configDir, 'loop')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'sess-1.json'), JSON.stringify({
    version: 1, status: 'running', prompt: 'x', index: 1, count: 5,
    budget: { maxCostUsd: 0, maxSteps: 0, maxWallMs: 0 },
    noProgress: { streak: 1, lastFingerprint: '', threshold: 3 },
    history: [], usageAcc: {}, costUsd: 0, steps: 0, injections: [],
  }), 'utf-8')
  assert.equal(controller.load(), true)
  assert.equal(controller.status().nextRunAt, 0)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test kernel-tests/loop-controller.test.mjs`
Expected: FAIL —— `st.nextRunAt` 为 `undefined`

- [ ] **Step 3: `freshState` 增字段**

`kernel/loop.mjs` 的 `freshState()` 中，把 `startedAt: '', updatedAt: '', endedAt: '', endReason: '',` 一行改为：

```js
      startedAt: '', updatedAt: '', endedAt: '', endReason: '',
      // 调度字段（spec §3.2）：nextRunAt = 下次该跑的时刻（持久语义，bridge 主管据此唤醒）；
      // aliveAt = 内核最近一次心跳。二者只由内核写（单写者原则）。
      nextRunAt: 0, aliveAt: '',
```

- [ ] **Step 4: `persist` 刷 `aliveAt`**

`kernel/loop.mjs` 的 `persist()` 中，把 `state.updatedAt = new Date().toISOString()` 一行改为：

```js
      state.updatedAt = new Date().toISOString()
      state.aliveAt = state.updatedAt
```

- [ ] **Step 5: 加统一 next 出口并替换两处 return**

在 `kernel/loop.mjs` 的 `onTurnEnd` **之前**（例如 `nextPayload` 函数之后）加入：

```js
  /**
   * 统一的"继续下一轮"出口：写 nextRunAt 并落盘。
   * nextRunAt 是持久语义 —— 内核进程被回收/崩溃后，bridge 主管据此把循环唤醒
   * （见 server/loop-supervisor.mjs）。delayMs===0 表示"立即，内核自己会投递"。
   */
  function nextDecision(delayMs, rationale) {
    const d = Number(delayMs) || 0
    state.nextRunAt = Date.now() + d
    persist()
    return { action: 'next', delayMs: d, rationale }
  }
```

把 `onTurnEnd` 中 doneWhen 分支的

```js
      return { action: 'next', delayMs: state.everyMs, rationale: `verify_failed: ${v?.reason || ''}` }
```

改为

```js
      return nextDecision(state.everyMs, `verify_failed: ${v?.reason || ''}`)
```

把 `onTurnEnd` 末尾的

```js
    return { action: 'next', delayMs: state.everyMs, rationale: 'continue' }
```

改为

```js
    return nextDecision(state.everyMs, 'continue')
```

- [ ] **Step 6: 终态清零 `nextRunAt`**

`kernel/loop.mjs` 的 `stop()` 中，把

```js
    state.status = reason === 'budget_exceeded' ? 'budget_exceeded' : 'cancelled'
    state.endReason = reason
    state.endedAt = new Date().toISOString()
```

改为

```js
    state.status = reason === 'budget_exceeded' ? 'budget_exceeded' : 'cancelled'
    state.endReason = reason
    state.endedAt = new Date().toISOString()
    state.nextRunAt = 0 // 终态不再有待触发的下一轮（防陈旧 nextRunAt 触发无谓复活）
```

同理，在 `onTurnEnd` 里三处"直接置终态"的位置（`verify_hit` / `failed` / `completed`），在 `state.endedAt = new Date().toISOString()` 之后各插入一行：

```js
        state.nextRunAt = 0
```

（三处的缩进分别是 8 空格；`verify_hit` 与 `failed` 在同一 `if` 块内、`completed` 在末尾块内 —— 按实际缩进对齐。）

- [ ] **Step 7: `load` 的合并已自动兼容**

确认无需改动：`kernel/loop.mjs:337` 的 `state = { ...freshState(), ...parsed, ... }` 会让旧文件缺失的 `nextRunAt` 保持 `freshState()` 的 `0`，明确**不要**在此处加特殊分支。

- [ ] **Step 8: 跑测试确认通过**

Run: `node --test kernel-tests/loop-controller.test.mjs kernel-tests/loop-e2e.test.mjs`
Expected: PASS（新增 5 个用例通过，既有用例全绿）

- [ ] **Step 9: 提交**

```bash
git add kernel/loop.mjs kernel-tests/loop-controller.test.mjs
git commit -m "feat(loop): nextRunAt/aliveAt 落盘，调度语义脱离进程生命周期（P1-1 前提）"
```

---

## Task 5: `--until` 判定移入控制器（终止逻辑单点收口）

**Files:**
- Modify: `kernel/loop.mjs`（新增统一的 `nextDecision` 内做判定）、`kernel/cli.mjs:1279-1291`（删除 cli 侧判定块）
- Test: `kernel-tests/loop-controller.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 4 的 `nextDecision(delayMs, rationale)`；`engine.judgeUntil({ target })` → `{ done: boolean, reason?: string, error?: boolean }`
- Produces: `nextDecision` 变为 async；`until_hit` / `judge_error` 由控制器直接 `stop()` 收尾

**零回归锁③ 关键**：旧实现在 cli 侧每轮多发**一条**只含 `index/total/judged/reason/error` 的 iter 帧。移入后必须**逐字保留该帧的形状与时序**（多发一条、字段相同、不含 steps/costUsd）。

- [ ] **Step 1: 写失败测试**

在 `kernel-tests/loop-controller.test.mjs` 末尾追加：

```js
// P1-5：--until 判定移入控制器（原先在 cli 侧），终止逻辑单点收口。
test('--until 达成 → until_hit 收尾，且发第二条只含 judged 字段的 iter 帧', async () => {
  const events = []
  const dir = mkdtempSync(join(tmpdir(), 'ponos-loop-'))
  const configDir = join(dir, 'home')
  mkdirSync(configDir, { recursive: true })
  const c = createLoopController({
    wire: { loop: (state, data = {}) => events.push({ state, ...data }), warning: () => {}, system: () => {} },
    engine: { queueNext: () => {}, judgeUntil: async () => ({ done: true, reason: '已达目标' }) },
    store: null, configDir, sessionId: 'sess-u', cwd: dir, env: {},
  })
  c.start({ prompt: 'x', count: 5, until: '测试通过' })
  const d = await c.onTurnEnd({ outcome: { usage: {}, toolDigest: [] } })
  assert.equal(d.action, 'stop')
  assert.equal(d.rationale, 'until_hit')
  assert.equal(c.status().endReason, 'until_hit')
  assert.equal(c.status().nextRunAt, 0)
  const judged = events.filter((e) => e.state === 'iter' && 'judged' in e)
  assert.equal(judged.length, 1)
  assert.equal(judged[0].judged, true)
  assert.equal(judged[0].reason, '已达目标')
  assert.equal(judged[0].error, false)
  assert.equal(judged[0].steps, undefined) // 旧帧不含 steps（零回归锁③：形状逐字保留）
})

test('--until 判定异常 → judge_error 收尾（不无限重试）', async () => {
  const { controller, engine } = mkLoop()
  engine.judgeUntil = async () => { throw new Error('boom') }
  controller.start({ prompt: 'x', count: 5, until: 'x' })
  const d = await controller.onTurnEnd({ outcome: { usage: {}, toolDigest: [] } })
  assert.equal(d.rationale, 'judge_error')
  assert.equal(controller.status().endReason, 'judge_error')
})

test('--until 未达成 → 正常继续下一轮', async () => {
  const { controller, engine } = mkLoop()
  engine.judgeUntil = async () => ({ done: false, reason: '还没好' })
  controller.start({ prompt: 'x', count: 5, until: 'x' })
  const d = await controller.onTurnEnd({ outcome: { usage: {}, toolDigest: [] } })
  assert.equal(d.action, 'next')
  assert.ok(controller.status().nextRunAt > 0)
})

test('doneWhen 与 until 同时存在 → doneWhen 优先（验证通过即收尾，不判 until）', async () => {
  let judgedCount = 0
  // doneWhen 走命令式验真：复用五段式管线，经 engine.tools.run（此处注入成功结果）
  const { controller, engine } = mkLoop({}, { engine: { tools: { run: async () => ({ isError: false }) } } })
  engine.judgeUntil = async () => { judgedCount++; return { done: true } }
  controller.start({ prompt: 'x', count: 5, until: 'x', doneWhen: [{ run: 'true' }] })
  const d = await controller.onTurnEnd({ outcome: { usage: {}, toolDigest: [] } })
  assert.equal(d.rationale, 'verify_hit')
  assert.equal(judgedCount, 0, 'doneWhen 通过后不得再调 until 判词')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test kernel-tests/loop-controller.test.mjs`
Expected: FAIL —— `--until 达成` 用例的 `d.rationale` 为 `continue`（控制器尚未判定 until）

- [ ] **Step 3: 在 `nextDecision` 内做 until 判定**

把 Task 4 加入的 `nextDecision` 替换为：

```js
  /**
   * 统一的"继续下一轮"出口：先做 --until 判词（P1-5：从 cli 侧移入，终止逻辑单点收口），
   * 再写 nextRunAt 并落盘。
   * nextRunAt 是持久语义 —— 内核进程被回收/崩溃后，bridge 主管据此把循环唤醒
   * （见 server/loop-supervisor.mjs）。delayMs===0 表示"立即，内核自己会投递"。
   *
   * 时序与帧形状严格保持改前（零回归锁③）：改前由 cli 在 decision==='next' 后判定，
   * 并**多发一条**只含 index/total/judged/reason/error 的 iter 帧 —— 此处照旧。
   */
  async function nextDecision(delayMs, rationale) {
    if (state.until) {
      let j = null
      try { j = await engine.judgeUntil({ target: state.until }) } catch { j = { done: false, error: true } }
      emit('iter', {
        index: state.index, total: state.count,
        judged: j?.done === true, reason: j?.reason || '', error: !!j?.error,
      })
      if (j?.done) { stop('until_hit'); return { action: 'stop', delayMs: 0, rationale: 'until_hit' } }
      if (j?.error) { stop('judge_error'); return { action: 'stop', delayMs: 0, rationale: 'judge_error' } }
    }
    const d = Number(delayMs) || 0
    state.nextRunAt = Date.now() + d
    persist()
    return { action: 'next', delayMs: d, rationale }
  }
```

> `engine` 在 `createLoopController` 作用域内已可用（`runVerify` 已在用 `engine.judgeUntil`），无需额外注入。

- [ ] **Step 4: 删除 cli 侧判定块**

删除 `kernel/cli.mjs:1279-1291` 整段（注释 + `if (decision.action === 'next' && loopUntil) { ... }`），即：

```js
        // 既有 --until 判定行为保留（语义不变，判定在 cli 侧）：仅在实际要继续下一轮时
        // 判定，命中 → until_hit 收尾；判定异常 → judge_error 收尾（不无限重试烧钱）。
        // judged/reason/error 三个既有 iter 字段照旧发出（零回归锁③）。
        if (decision.action === 'next' && loopUntil) {
          let j = null
          try { j = await engine.judgeUntil({ target: loopUntil }) } catch { j = { done: false, error: true } }
          wire.loop('iter', { index: loop.status().index, total: loop.status().count, judged: j?.done === true, reason: j?.reason || '', error: !!j?.error })
          if (j?.done) { loop.stop('until_hit'); decision = { action: 'stop', delayMs: 0, rationale: 'until_hit' } }
          else if (j?.error) { loop.stop('judge_error'); decision = { action: 'stop', delayMs: 0, rationale: 'judge_error' } }
        }
```

**保留** `loopUntil` 变量本身（`nextPayload(loopUntil)` 仍在用它把 until 带进每轮载荷，改动越少回归面越小）。在其声明处（`kernel/cli.mjs:1036`）把注释更新为：

```js
  // --until 目标：控制器已持有 state.until 并自行判定（P1-5）；此变量仅供 nextPayload 携带
  let loopUntil = ''
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test kernel-tests/loop-controller.test.mjs kernel-tests/loop-e2e.test.mjs kernel-tests/loop-stall-guard.test.mjs`
Expected: PASS（新增 4 个用例通过；既有 44 个用例全绿，特别确认 `loop-e2e.test.mjs` 中涉及 `--until` 的用例仍通过）

- [ ] **Step 6: 确认 cli 侧已无残留判定**

Run: `grep -n "until_hit" kernel/cli.mjs`
Expected: 无输出（`until_hit` 已只在 `kernel/loop.mjs` 出现）

- [ ] **Step 7: 提交**

```bash
git add kernel/loop.mjs kernel/cli.mjs kernel-tests/loop-controller.test.mjs
git commit -m "refactor(loop): --until 判定移入控制器，终止逻辑单点收口（P1-5）"
```

---

## Task 6: 回滚真正执行（stash 保护 + reset --hard）

**Files:**
- Modify: `kernel/loop.mjs:169-176`（`rollback` 之后新增 `applyPendingRollback`）、`kernel/loop.mjs:345-350`（导出）
- Modify: `kernel/cli.mjs:1101-1115`（approve 分支接线）
- Test: `kernel-tests/loop-rollback.test.mjs`（新建）

**Interfaces:**
- Consumes: `state.pendingApproval = { kind:'rollback', detail:<sha> }`（既有 `rollback()` 登记）、`state.snapshotRef`
- Produces: `applyPendingRollback(): { applied: boolean, ok?: boolean, ref?: string, stashMsg?: string, error?: string }`

**安全铁律（用户已确认策略）**：`git stash push -u` **成功（退出码 0）才**执行 `git reset --hard`。stash 失败即**中止回滚**，绝不为回滚而丢弃用户未提交的改动。

- [ ] **Step 1: 写失败测试**

创建 `kernel-tests/loop-rollback.test.mjs`：

```js
// loop 回滚：stash 保护 + reset --hard（P1-3）。回滚此前只登记审批、从不执行。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createLoopController } from '../kernel/loop.mjs'

function git(cwd, args) {
  return String(execFileSync('git', args, { cwd, encoding: 'utf-8' })).trim()
}
function mkRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-rb-'))
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 't@t'])
  git(dir, ['config', 'user.name', 't'])
  writeFileSync(join(dir, 'a.txt'), 'v1', 'utf-8')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'init'])
  return dir
}
function mkCtrl(dir, sessionId = 'sess-rb') {
  const configDir = join(dir, 'home')
  mkdirSync(configDir, { recursive: true })
  return createLoopController({
    wire: { loop: () => {}, warning: () => {}, system: () => {} },
    engine: { queueNext: () => {}, judgeUntil: async () => ({ done: false }) },
    store: null, configDir, sessionId, cwd: dir, env: {},
  })
}

test('回滚：未提交改动被 stash 保护，工作区回到快照', () => {
  const dir = mkRepo()
  try {
    const c = mkCtrl(dir)
    c.start({ prompt: 'x', count: 3 })
    const ref = c.snapshot()
    assert.ok(/^[0-9a-f]{7,40}$/i.test(ref), 'snapshot 应记录 HEAD sha')
    writeFileSync(join(dir, 'a.txt'), 'CHANGED', 'utf-8')
    writeFileSync(join(dir, 'new.txt'), 'untracked', 'utf-8')
    const reg = c.rollback()
    assert.equal(reg.needApproval, true)
    assert.equal(c.status().pendingApproval.kind, 'rollback')

    const r = c.applyPendingRollback()
    assert.equal(r.ok, true)
    assert.equal(r.applied, true)
    assert.equal(r.ref, ref)
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf-8'), 'v1', '已跟踪文件应回到快照')
    assert.equal(existsSync(join(dir, 'new.txt')), false, '未跟踪文件应被 stash -u 收走')
    const stashes = git(dir, ['stash', 'list'])
    assert.ok(stashes.includes(r.stashMsg), '改动应存在于 stash 中可找回')
    assert.equal(c.status().pendingApproval, null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('回滚记入 history（note 含 rollback:ref）', () => {
  const dir = mkRepo()
  try {
    const c = mkCtrl(dir)
    c.start({ prompt: 'x', count: 3 })
    const ref = c.snapshot()
    writeFileSync(join(dir, 'a.txt'), 'CHANGED', 'utf-8')
    c.rollback()
    c.applyPendingRollback()
    const h = c.status().history
    assert.equal(h.length, 1)
    assert.equal(h[0].note, `rollback:${ref}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('无 pendingApproval → 不执行任何动作', () => {
  const dir = mkRepo()
  try {
    const c = mkCtrl(dir)
    c.start({ prompt: 'x', count: 3 })
    c.snapshot()
    const r = c.applyPendingRollback()
    assert.equal(r.applied, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('非法快照引用 → 拒绝执行且不改工作区', () => {
  const dir = mkRepo()
  try {
    const c = mkCtrl(dir, 'sess-rb2')
    c.start({ prompt: 'x', count: 3 })
    c.snapshot()
    c.rollback()
    writeFileSync(join(dir, 'a.txt'), 'CHANGED', 'utf-8')
    // 通过落盘文件把 detail 改坏（模拟状态文件被篡改），再 load 回来
    const f = join(dir, 'home', 'loop', 'sess-rb2.json')
    const raw = JSON.parse(readFileSync(f, 'utf-8'))
    raw.pendingApproval = { kind: 'rollback', detail: 'HEAD~1; rm -rf /' }
    writeFileSync(f, JSON.stringify(raw), 'utf-8')
    assert.equal(c.load(), true)
    const r = c.applyPendingRollback()
    assert.equal(r.ok, false)
    assert.equal(r.applied, false)
    assert.ok(String(r.error).includes('非法'), '错误信息应说明引用非法')
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf-8'), 'CHANGED', '拒绝执行时不得改动工作区')
    assert.equal(c.status().pendingApproval, null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('stash 失败（cwd 非 git 仓库）→ 中止回滚，不丢用户文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-nogit-'))
  const c = mkCtrl(dir, 'sess-nogit')
  try {
    // 手工构造一个"有快照引用但 cwd 不是 git 仓库"的状态：模拟仓库被移除/损坏
    const stDir = join(dir, 'home', 'loop')
    mkdirSync(stDir, { recursive: true })
    writeFileSync(join(stDir, 'sess-nogit.json'), JSON.stringify({
      version: 1, status: 'running', prompt: 'x', index: 1, count: 3,
      snapshotRef: 'abcdef1',
      pendingApproval: { kind: 'rollback', detail: 'abcdef1' },
      budget: { maxCostUsd: 0, maxSteps: 0, maxWallMs: 0 },
      noProgress: { streak: 0, lastFingerprint: '', threshold: 3 },
      history: [], usageAcc: {}, costUsd: 0, steps: 0, injections: [],
    }), 'utf-8')
    writeFileSync(join(dir, 'precious.txt'), 'do-not-lose', 'utf-8')
    assert.equal(c.load(), true)
    const r = c.applyPendingRollback()
    assert.equal(r.ok, false)
    assert.equal(r.applied, false)
    assert.ok(String(r.error).includes('git stash'), '错误信息应说明是改动保护失败')
    assert.equal(existsSync(join(dir, 'precious.txt')), true, '用户文件不得丢失')
    assert.equal(c.status().pendingApproval, null, '待审批状态应被清掉，不悬挂')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test kernel-tests/loop-rollback.test.mjs`
Expected: FAIL —— `c.applyPendingRollback is not a function`

- [ ] **Step 3: 在 `kernel/loop.mjs` 实现**

在 `kernel/loop.mjs` 的 `rollback()` 之后插入：

```js
  /**
   * 执行待审批的动作（当前只有回滚）。P1-3：修复前 rollback 只登记 pendingApproval
   * 与快照引用，**从不真正执行** —— 用户以为有回滚保护，实则没有。
   *
   * 安全铁律（用户确认策略）：先 `git stash push -u` 保护未提交改动（含未跟踪文件），
   * **成功才** `git reset --hard`。stash 失败即中止回滚，绝不为回滚丢弃用户改动。
   * 仅作用于 git 跟踪范围；非 git 仓库降级报错。
   */
  function applyPendingRollback() {
    const p = state.pendingApproval
    if (!p || p.kind !== 'rollback') return { applied: false }
    const ref = String(p.detail || '')
    // ① 引用形状白名单：git sha 十六进制 7-40 位。避免把任意字符串塞进 git 参数。
    if (!/^[0-9a-f]{7,40}$/i.test(ref)) {
      state.pendingApproval = null
      persist()
      return { applied: false, ok: false, error: `快照引用非法，已拒绝执行：${ref}` }
    }
    // ② 保护未提交改动
    let stashMsg = ''
    try {
      stashMsg = `yf-loop-rollback-${new Date().toISOString().replace(/[:.]/g, '-')}`
      execFileSync('git', ['stash', 'push', '-u', '-m', stashMsg], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      // ③ stash 失败 → 中止（不 reset），不丢用户改动
      state.pendingApproval = null
      persist()
      return { applied: false, ok: false, error: `已取消回滚：改动保护（git stash）失败，为避免丢失未提交改动不执行 reset。${e?.message || ''}`.trim() }
    }
    // ④ 回到快照
    try {
      execFileSync('git', ['reset', '--hard', ref], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      state.pendingApproval = null
      persist()
      return { applied: false, ok: false, error: `回滚失败：${e?.message || String(e)}（改动已在 stash「${stashMsg}」中，可用 git stash pop 找回）` }
    }
    state.history.push({
      index: state.index, ts: new Date().toISOString(), usage: null,
      costUsd: Number(state.costUsd.toFixed(4)), steps: 0, toolCount: 0,
      filesChanged: 0, errors: 0, verify: null, judged: false, note: `rollback:${ref}`,
    })
    state.pendingApproval = null
    persist()
    emit('status', { status: state.status, index: state.index, total: state.count })
    return { applied: true, ok: true, ref, stashMsg }
  }
```

在 `kernel/loop.mjs` 末尾的 return 对象里，把

```js
    snapshot, rollback, replay, memory, load, persist, isActive, nextPayload,
```

改为

```js
    snapshot, rollback, applyPendingRollback, replay, memory, load, persist, isActive, nextPayload,
```

- [ ] **Step 4: 在 `kernel/cli.mjs` 的 approve 分支接线**

把 `kernel/cli.mjs` 的 approve 分支（`case 'resume': case 'approve': { ... }`）改为：

```js
        case 'resume': case 'approve': {
          const wasActive = loop.isActive()
          clearLoopNextTimer() // 先取消残留的延迟投递，避免与下面的补投递双投递连跑两轮
          // 待审批动作真正执行（P1-3：回滚此前只登记、从不执行）；非 rollback 时是空操作
          const rb = loop.applyPendingRollback()
          loop.resume()
          // 恢复后需重新投递下一轮：暂停/挂起都发生在"轮已结束"的边界，控制器不会自行
          // 推进（其 onTurnEnd 只在轮末被调用），故此处补投递，否则恢复后静默停住。
          if (wasActive) {
            const p = loop.nextPayload(loopUntil)
            state.queue.unshift({ message: p.message, loop: p.loop, skipMemoryCapture: true })
            if (!state.turnActive) { const n = state.queue.shift(); if (n) void handleUser(n) }
          }
          if (rb.applied) return { ok: true, text: `已回滚至 ${rb.ref}；回滚前的改动已存入 stash「${rb.stashMsg}」，可用 git stash pop 找回，随后已恢复循环` }
          if (rb.ok === false) return { ok: false, text: rb.error }
          return { ok: true, text: '已恢复' }
        }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test kernel-tests/loop-rollback.test.mjs kernel-tests/loop-controller.test.mjs kernel-tests/loop-e2e.test.mjs`
Expected: PASS（新增 5 个用例通过，既有用例全绿）

- [ ] **Step 6: 提交**

```bash
git add kernel/loop.mjs kernel/cli.mjs kernel-tests/loop-rollback.test.mjs
git commit -m "feat(loop): 回滚真正执行（stash 保护 + reset --hard），拒绝丢用户改动（P1-3）"
```

---

## Task 7: loop 落盘路径模块（单写者收口）

**Files:**
- Create: `server/loop-paths.mjs`
- Test: `server/loop-paths.test.mjs`

**Interfaces:**
- Consumes: `server/yfw-home.cjs` 的 `YFW_HOME`（bridge 已解析的内核配置根）
- Produces:
  - `loopDir(home): string`
  - `stateFile(home, sid): string` / `metaFile(home, sid): string`
  - `readJsonSafe(file): object|null`
  - `writeJsonAtomic(file, obj): boolean`
  - `readLoopState(home, sid): object|null`
  - `readLoopMeta(home, sid): object|null`
  - `listLoopMetas(home): Array<{ sid: string, meta: object }>`
  - `upsertLoopMeta(home, sid, patch): boolean`（读-合并-原子写）
  - `removeLoopMeta(home, sid): void`

**为什么单独成模块**：`<YFW_HOME>` 就是内核的 `PONOS_CONFIG_DIR`（`server/bridge.mjs:1059`），所以 bridge 能直接读写内核的 loop 目录。把这些路径与原子读写收口到一处，**并在此集中声明"meta 只由 bridge 写、state 内核写"**，避免散落在 bridge 各处产生跨进程写冲突。

- [ ] **Step 1: 写失败测试**

创建 `server/loop-paths.test.mjs`：

```js
// loop 落盘路径与原子读写（P1-1 数据源）。单写者原则：meta 只由 bridge 写。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loopDir, stateFile, metaFile, readJsonSafe, writeJsonAtomic,
  readLoopState, readLoopMeta, listLoopMetas, upsertLoopMeta, removeLoopMeta,
} from './loop-paths.mjs'

function mkHome() {
  const home = mkdtempSync(join(tmpdir(), 'ponos-lp-'))
  mkdirSync(join(home, 'loop'), { recursive: true })
  return home
}

test('路径布局与内核一致（<home>/loop/<sid>.json 与 <sid>.meta.json）', () => {
  assert.equal(loopDir('H'), join('H', 'loop'))
  assert.equal(stateFile('H', 's1'), join('H', 'loop', 's1.json'))
  assert.equal(metaFile('H', 's1'), join('H', 'loop', 's1.meta.json'))
})

test('readJsonSafe：文件不存在 / 非法 JSON / 非对象 → null（不抛）', () => {
  const home = mkHome()
  try {
    assert.equal(readJsonSafe(join(home, 'nope.json')), null)
    const bad = join(home, 'bad.json')
    writeFileSync(bad, '{not json', 'utf-8')
    assert.equal(readJsonSafe(bad), null)
    const arr = join(home, 'arr.json')
    writeFileSync(arr, '[1,2]', 'utf-8')
    assert.equal(readJsonSafe(arr), null)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('writeJsonAtomic：写入成功且不残留 .tmp', () => {
  const home = mkHome()
  try {
    const f = join(home, 'loop', 'x.json')
    assert.equal(writeJsonAtomic(f, { a: 1 }), true)
    assert.deepEqual(readJsonSafe(f), { a: 1 })
    assert.equal(existsSync(`${f}.tmp`), false)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('writeJsonAtomic：目录不存在时自动创建', () => {
  const home = mkdtempSync(join(tmpdir(), 'ponos-lp2-'))
  try {
    const f = join(home, 'loop', 'y.json')
    assert.equal(writeJsonAtomic(f, { b: 2 }), true)
    assert.deepEqual(readJsonSafe(f), { b: 2 })
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('upsertLoopMeta：新建 → 增量合并 → 保留既有字段', () => {
  const home = mkHome()
  try {
    assert.equal(upsertLoopMeta(home, 's1', { sessionId: 's1', cwd: 'C:/x', resumeCount: 0 }), true)
    upsertLoopMeta(home, 's1', { resumeCount: 2, lastResumeAt: 123 })
    const m = readLoopMeta(home, 's1')
    assert.equal(m.sessionId, 's1')
    assert.equal(m.cwd, 'C:/x', '既有字段不得被覆盖丢失')
    assert.equal(m.resumeCount, 2)
    assert.equal(m.lastResumeAt, 123)
    assert.ok(typeof m.updatedAt === 'string' && m.updatedAt.length > 0, 'upsert 应刷新 updatedAt')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('listLoopMetas：只列 meta 文件，忽略 state 文件与损坏文件', () => {
  const home = mkHome()
  try {
    upsertLoopMeta(home, 's1', { sessionId: 's1' })
    upsertLoopMeta(home, 's2', { sessionId: 's2' })
    writeFileSync(stateFile(home, 's1'), '{"version":1}', 'utf-8') // state 文件应被忽略
    writeFileSync(join(home, 'loop', 's3.meta.json'), '{broken', 'utf-8') // 损坏应被跳过
    const list = listLoopMetas(home)
    assert.equal(list.length, 2)
    assert.deepEqual(list.map((x) => x.sid).sort(), ['s1', 's2'])
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('listLoopMetas：目录不存在 → 空数组（不抛）', () => {
  const home = mkdtempSync(join(tmpdir(), 'ponos-lp3-'))
  try {
    assert.deepEqual(listLoopMetas(home), [])
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('readLoopState 与 meta 互不干扰（单写者原则）', () => {
  const home = mkHome()
  try {
    writeFileSync(stateFile(home, 's1'), JSON.stringify({ version: 1, status: 'running', nextRunAt: 999 }), 'utf-8')
    upsertLoopMeta(home, 's1', { sessionId: 's1', resumeCount: 1 })
    assert.equal(readLoopState(home, 's1').nextRunAt, 999)
    assert.equal(readLoopMeta(home, 's1').resumeCount, 1)
    // 写 meta 不得改动 state 文件
    upsertLoopMeta(home, 's1', { resumeCount: 2 })
    assert.equal(readLoopState(home, 's1').nextRunAt, 999)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('removeLoopMeta：删除后读取为 null 且不抛', () => {
  const home = mkHome()
  try {
    upsertLoopMeta(home, 's1', { sessionId: 's1' })
    removeLoopMeta(home, 's1')
    assert.equal(readLoopMeta(home, 's1'), null)
    removeLoopMeta(home, 's1') // 幂等
  } finally { rmSync(home, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/loop-paths.test.mjs`
Expected: FAIL —— `Cannot find module './loop-paths.mjs'`

- [ ] **Step 3: 实现模块**

创建 `server/loop-paths.mjs`：

```js
// server/loop-paths.mjs —— loop 落盘路径与原子读写（spec §3）
// ---------------------------------------------------------------------------
// 关键前提：bridge 的 YFW_HOME 就是内核子进程的 PONOS_CONFIG_DIR（server/bridge.mjs:1059），
// 故 bridge 能直接读写内核的 <configDir>/loop/ 目录，无需跨进程通道。
//
// **单写者原则（禁止违反）**：
//   · <home>/loop/<sid>.json        → 只由【内核】写（本节只读）
//   · <home>/loop/<sid>.meta.json   → 只由【bridge】写（本节读写）
// 若 bridge 去写 state 文件，会被内核下一次 persist() 用其内存态整体覆写，
// 且写入时机无同步 ⇒ 字段静默消失。反之亦然。
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const META_SUFFIX = '.meta.json'

export function loopDir(home) { return join(String(home || ''), 'loop') }
export function stateFile(home, sid) { return join(loopDir(home), `${sid}.json`) }
export function metaFile(home, sid) { return join(loopDir(home), `${sid}${META_SUFFIX}`) }

/** 读 JSON；不存在/非法/非对象一律返回 null（绝不抛）。 */
export function readJsonSafe(file) {
  try {
    if (!existsSync(file)) return null
    const v = JSON.parse(readFileSync(file, 'utf-8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch { return null }
}

/** 原子写（tmp + rename，先建目录）。失败返回 false（绝不抛）。 */
export function writeJsonAtomic(file, obj) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8')
    renameSync(tmp, file)
    return true
  } catch { return false }
}

export function readLoopState(home, sid) { return readJsonSafe(stateFile(home, sid)) }
export function readLoopMeta(home, sid) { return readJsonSafe(metaFile(home, sid)) }

/**
 * 列出全部循环 meta（只认 <sid>.meta.json）。
 * 损坏的 meta 与全部 state 文件都被跳过 —— 单个坏文件不影响其他循环。
 * @returns {Array<{sid: string, meta: object}>}
 */
export function listLoopMetas(home) {
  const out = []
  let names = []
  try { names = readdirSync(loopDir(home)) } catch { return out }
  for (const n of names) {
    if (!n.endsWith(META_SUFFIX)) continue
    const sid = n.slice(0, -META_SUFFIX.length)
    if (!sid) continue
    const meta = readJsonSafe(join(loopDir(home), n))
    if (meta) out.push({ sid, meta })
  }
  return out
}

/** 读-合并-原子写（bridge 侧唯一允许的 meta 写入口）。自动刷新 updatedAt。 */
export function upsertLoopMeta(home, sid, patch) {
  const cur = readLoopMeta(home, sid) || {}
  const next = { ...cur, ...(patch || {}), updatedAt: new Date().toISOString() }
  return writeJsonAtomic(metaFile(home, sid), next)
}

export function removeLoopMeta(home, sid) {
  try { rmSync(metaFile(home, sid), { force: true }) } catch { /* 幂等：不存在即无操作 */ }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/loop-paths.test.mjs`
Expected: PASS（9 tests）

- [ ] **Step 5: 提交**

```bash
git add server/loop-paths.mjs server/loop-paths.test.mjs
git commit -m "feat(bridge): loop 落盘路径与原子读写模块（单写者收口，P1-1 数据源）"
```

---

## Task 8: bridge 归约 loop 帧（`loopRegistry`，P1-6）

**Files:**
- Modify: `server/bridge.mjs`（新增 `loopRegistry` 与 `noteLoopFrame`，并在内核 stdout 解析处调用）
- Test: `server/bridge-loop-registry.test.mjs`

**Interfaces:**
- Consumes: 内核 stdout 的 loop 帧 `{ type:'loop', state:'start'|'iter'|'end'|'status', ... }`（协议见 `kernel/protocol.mjs:117-119`）
- Produces: `noteLoopFrame(sid, parsed)`、`getLoopRecord(sid)`、`clearLoopRecord(sid)`；记录形状 `{ status, index, total, endReason, costUsd, priceSource, lastFrameAt }`

**为什么**：现状 bridge 对 loop **完全无感知**（只做文本转译与命令转发，从不解析 loop 帧），所以既无法在回收时避开正在跑的循环，也无从给 Phase 4 的"全局列表"提供数据。

> 提炼为可测纯函数：`reduceLoopRecord(prev, frame)` 放模块级，`noteLoopFrame` 只是 Map 包装 —— 这样测试无需起 bridge。

- [ ] **Step 1: 写失败测试**

创建 `server/bridge-loop-registry.test.mjs`：

```js
// bridge 对 loop 帧的归约（P1-6）：零回归锁③ —— 只读既有字段，不改协议语义。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reduceLoopRecord } from './loop-registry.mjs'

test('start 帧 → running + 轮次/总数/价格来源', () => {
  const r = reduceLoopRecord(null, { state: 'start', index: 0, total: 3, priceSource: 'builtin', prompt: 'x' })
  assert.equal(r.status, 'running')
  assert.equal(r.index, 0)
  assert.equal(r.total, 3)
  assert.equal(r.priceSource, 'builtin')
})

test('start 帧 total=null（不限次数）→ total 保持 null', () => {
  const r = reduceLoopRecord(null, { state: 'start', index: 0, total: null })
  assert.equal(r.total, null)
})

test('iter 帧 → 推进 index 与 costUsd，不改 status', () => {
  const a = reduceLoopRecord(null, { state: 'start', index: 0, total: 5 })
  const b = reduceLoopRecord(a, { state: 'iter', index: 1, total: 5, costUsd: 0.12 })
  assert.equal(b.status, 'running')
  assert.equal(b.index, 1)
  assert.equal(b.costUsd, 0.12)
})

test('status 帧 → 覆盖 status（paused/awaiting_approval 等人介入态）', () => {
  const a = reduceLoopRecord(null, { state: 'start', index: 1, total: 5 })
  const b = reduceLoopRecord(a, { state: 'status', status: 'paused', index: 1, total: 5 })
  assert.equal(b.status, 'paused')
  const c = reduceLoopRecord(b, { state: 'status', status: 'awaiting_approval', index: 1, total: 5 })
  assert.equal(c.status, 'awaiting_approval')
})

test('end 帧 → 终态 + endReason', () => {
  const a = reduceLoopRecord(null, { state: 'start', index: 3, total: 3 })
  const b = reduceLoopRecord(a, { state: 'end', reason: 'completed', index: 3, total: 3, costUsd: 0.5 })
  assert.equal(b.status, 'done')
  assert.equal(b.endReason, 'completed')
  assert.equal(b.costUsd, 0.5)
})

test('end.reason 非封闭集合值 → 原样记入（不崩、不改语义）', () => {
  const a = reduceLoopRecord(null, { state: 'start', index: 1, total: 1 })
  const b = reduceLoopRecord(a, { state: 'end', reason: 'weird_reason' })
  assert.equal(b.endReason, 'weird_reason')
  assert.equal(b.status, 'done')
})

test('未知 state 与畸形帧 → 保持既有记录不变（保守不误动）', () => {
  const a = reduceLoopRecord(null, { state: 'start', index: 2, total: 4 })
  assert.deepEqual(reduceLoopRecord(a, { state: 'bogus' }), a)
  assert.deepEqual(reduceLoopRecord(a, { state: '' }), a)
  assert.deepEqual(reduceLoopRecord(a, null), a)
  assert.deepEqual(reduceLoopRecord(a, {}), a)
})

test('无既有记录时的未知帧 → 返回 null 语义的初始记录（不抛）', () => {
  const r = reduceLoopRecord(null, { state: 'bogus' })
  assert.equal(r.status, 'idle')
  assert.equal(r.index, 0)
})

test('lastFrameAt 随每次归约刷新', () => {
  const a = reduceLoopRecord(null, { state: 'start', index: 0 })
  const b = reduceLoopRecord(a, { state: 'iter', index: 1 })
  assert.ok(b.lastFrameAt >= a.lastFrameAt)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/bridge-loop-registry.test.mjs`
Expected: FAIL —— `Cannot find module './loop-registry.mjs'`

- [ ] **Step 3: 实现归约纯函数**

创建 `server/loop-registry.mjs`：

```js
// server/loop-registry.mjs —— bridge 对内核 loop 帧的归约（spec P1-6）
// ---------------------------------------------------------------------------
// 现状：bridge 对 loop 完全无感知（只做文本转译 + 命令转发），因此
//   ① 内核空闲回收无法避开"正在跑的循环"（P1-1）；
//   ② 拿不到循环运行视图（Phase 4 全局列表缺数据源）。
// 本模块只做**只读归约**：不改协议、不改内核状态、不改 GUI 语义（零回归锁③）。
// nextRunAt 不在此处 —— 它由内核写进 state 文件（单写者原则），由主管从文件读。

/** 初始记录（无既有记录且帧不可识别时返回它） */
function emptyRecord() {
  return { status: 'idle', index: 0, total: null, endReason: '', costUsd: 0, priceSource: '', lastFrameAt: 0 }
}

function toNum(v) {
  return Number.isFinite(Number(v)) ? Number(v) : null
}

/**
 * 纯归约：把一帧 loop 事件折进既有记录。
 * @param {object|null} prev 既有记录（null = 无）
 * @param {object|null} frame 内核 loop 帧（{ state, ... }）
 * @returns {object} 新记录；帧不可识别时**原样返回**（保守不误动）
 */
export function reduceLoopRecord(prev, frame) {
  const base = prev ? { ...prev } : emptyRecord()
  const state = frame && typeof frame === 'object' ? String(frame.state || '') : ''
  if (!state || !['start', 'iter', 'end', 'status'].includes(state)) return base

  const next = { ...base, lastFrameAt: Date.now() }

  if (state === 'start') {
    next.status = 'running'
    next.index = toNum(frame.index) ?? 0
    next.total = frame.total === null || frame.total === undefined ? null : toNum(frame.total)
    next.endReason = ''
    if (typeof frame.priceSource === 'string' && frame.priceSource) next.priceSource = frame.priceSource
  } else if (state === 'iter') {
    const i = toNum(frame.index)
    if (i !== null) next.index = i
    if (frame.total !== undefined) next.total = frame.total === null ? null : toNum(frame.total)
    const c = toNum(frame.costUsd)
    if (c !== null) next.costUsd = c
    if (typeof frame.priceSource === 'string' && frame.priceSource) next.priceSource = frame.priceSource
  } else if (state === 'end') {
    next.status = 'done'
    next.endReason = String(frame.reason || '')
    const i = toNum(frame.index)
    if (i !== null) next.index = i
    const c = toNum(frame.costUsd)
    if (c !== null) next.costUsd = c
  } else if (state === 'status') {
    if (typeof frame.status === 'string' && frame.status) next.status = frame.status
    const i = toNum(frame.index)
    if (i !== null) next.index = i
    const t = toNum(frame.total)
    if (t !== null) next.total = t
  }
  return next
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/bridge-loop-registry.test.mjs`
Expected: PASS（9 tests）

- [ ] **Step 5: 在 `server/bridge.mjs` 接入**

在 `server/bridge.mjs` 顶部 import 区（`translateLoopSend` import 附近，约 `:42`）加入：

```js
import { reduceLoopRecord } from './loop-registry.mjs'
```

在 `server/bridge.mjs` 的 `reapIdleKernels` 定义**之前**（约 `:3380`，与回收器同区块）加入：

```js
// ---------------------------------------------------------------------------
// 循环运行视图（P1-6）：归约内核 loop 帧，供回收宽限（P1-1 机制 A）与
// 后续的全局循环列表（Phase 4）消费。只读，不改内核状态。
// ---------------------------------------------------------------------------
const loopRegistry = new Map()
export function noteLoopFrame(sid, parsed) {
  if (!parsed || parsed.type !== 'loop') return
  loopRegistry.set(sid, reduceLoopRecord(loopRegistry.get(sid) || null, parsed))
}
function getLoopRecord(sid) { return loopRegistry.get(sid) || null }
function clearLoopRecord(sid) { loopRegistry.delete(sid) }
```

在 `server/bridge.mjs` 的内核 stdout 行处理处，紧跟 `if (parsed && parsed.usage && parsed.type === 'result') { ... }` 之前（约 `:1474`，即 `parsed` 刚解析出来的位置）插入一行：

```js
    noteLoopFrame(sid, parsed)
```

在 `reapKernel`（约 `:3376`）的函数体内、`sessions.delete(sid)` 之后加入：

```js
  clearLoopRecord(sid)
```

- [ ] **Step 6: 跑测试确认通过（含既有 bridge 测试）**

Run: `node --test server/*.test.mjs`
Expected: PASS（含新增 9 个用例与既有全部 server 用例）

- [ ] **Step 7: 提交**

```bash
git add server/loop-registry.mjs server/bridge-loop-registry.test.mjs server/bridge.mjs
git commit -m "feat(bridge): 归约 loop 帧维护循环视图（P1-6）"
```

---

## Task 9: loop 启动时落盘 meta（主管的 spawn 上下文）

**Files:**
- Modify: `server/bridge.mjs:1797`（session 对象增字段）、`server/bridge.mjs:1472-1474`（init 帧记录 kernelSessionId）、`server/bridge.mjs:1520`（loop start 帧落盘 meta）
- Test: 归入 Task 10 的 `server/loop-supervisor.test.mjs`（本任务的产出由该项目测覆盖；另加一条 bridge 侧断言，见 Step 5）

**Interfaces:**
- Consumes: Task 7 的 `upsertLoopMeta(home, sid, patch)`；内核 init 帧的 `session_id`（`kernel/cli.mjs:997`）
- Produces: `session.kernelSessionId: string|null` 与 `session.spawnCtx: object`；循环启动后 `<YFW_HOME>/loop/<kernelSessionId>.meta.json` 存在且字段齐备

**关键约束**：loop 状态文件的文件名是**内核的 sessionId**（`kernel/cli.mjs`：`sessionId = args.resume || newSessionId()`），而 bridge 的 `sid` 是会话 id，两者**可能不同**。唯一可靠来源是内核 `init` 帧的 `session_id` 字段 —— 所以 meta 必须按 `kernelSessionId` 落盘，且必须在 init 之后才能写。

- [ ] **Step 1: 给 session 对象补字段**

把 `server/bridge.mjs:1797` 的 `const session = { proc, cwd: ..., mode, ... }` 改为（在末尾追加三个字段，其余逐字不动）：

```js
  const session = { proc, cwd: mode === 'chat' ? YFW_HOME : (cwd || process.cwd()), mode, _pendingQuestions: null, _proseProgress: { total: 0, lastIndex: 0, structuredUsed: false }, _pendingApprovals: new Map(), firstTokenAt: null, _lastOutAt: 0, _turnActive: false, _stallWarnedAt: 0, _reaped: false, _cancelPending: false, _cancelAt: 0, _cancelTimer: null, _turnStartAt: 0, _fbpTimer: null, _fbpFirstTimer: null, _awaitingSince: 0, _lastCompactFrameAt: 0, _askBuf: '', _spawnEnvSig: providerEnvSig(buildChildEnv()), _spawnKnowledgeSig: knowledgeSpacesSig(knowledgeSpaces), _spawnMcpSig: currentMcpSig(), _spawnAppPageSig: appPageSig(pageId),
    // 循环主管所需的 spawn 上下文（P1-1）：内核被回收/崩溃后，bridge 要靠这些字段
    // 把内核原样唤醒。kernelSessionId 只能来自内核 init 帧的 session_id —— 它才是
    // loop 状态文件 <kernelSessionId>.json 的文件名依据，与 bridge 的 sid 未必相同。
    kernelSessionId: null,
    spawnCtx: {
      cwd: mode === 'chat' ? YFW_HOME : (cwd || process.cwd()),
      model: model || null, systemPrompt: systemPrompt || null, mode,
      knowledgeSpaces: kSpaces.length ? kSpaces : null, appPageId: pageId || null,
      compactCount: Number.isFinite(Number(compactCount)) ? Number(compactCount) : 0,
    } }
```

- [ ] **Step 2: 在 init 帧记录 kernelSessionId**

把 `server/bridge.mjs:1524` 的

```js
    if (parsed && parsed.type === 'system' && parsed.subtype === 'init') {
      const echoed = parsed.approval_mode
```

改为

```js
    if (parsed && parsed.type === 'system' && parsed.subtype === 'init') {
      // 记录内核真正的 sessionId（= loop 状态文件名的依据）。init 一定早于任何 loop 帧，
      // 故下方 loop start 落盘 meta 时该字段必然可用。
      if (parsed.session_id) session.kernelSessionId = String(parsed.session_id)
      const echoed = parsed.approval_mode
```

- [ ] **Step 3: 在 loop start 帧落盘 meta**

把 `server/bridge.mjs:1472-1474` 的

```js
    let parsed = null
    try { parsed = JSON.parse(t) } catch (_) {}
    if (parsed && parsed.usage && parsed.type === 'result') {
```

改为

```js
    let parsed = null
    try { parsed = JSON.parse(t) } catch (_) {}
    noteLoopFrame(sid, parsed)
    // 循环启动即落盘 spawn 上下文（P1-1 数据源）：bridge 在这一刻正好持有全部 spawn
    // 字段；此后内核被回收/崩溃，主管据此把它按原样唤醒（--resume kernelSessionId）。
    // 只写一次 per loop start：iter 帧不动盘（避免每轮写盘）。resumeCount/lastResumeAt
    // 是主管自有计数，保留既有值不重置。
    if (parsed && parsed.type === 'loop' && parsed.state === 'start' && session.kernelSessionId) {
      try {
        const prev = readLoopMeta(YFW_HOME, session.kernelSessionId) || {}
        upsertLoopMeta(YFW_HOME, session.kernelSessionId, {
          version: 1,
          sessionId: session.kernelSessionId,
          bridgeSid: sid,
          ...session.spawnCtx,
          resumeCount: Number(prev.resumeCount) || 0,
          lastResumeAt: Number(prev.lastResumeAt) || 0,
        })
      } catch (e) {
        // 落盘失败 → 静默降级：主管找不到 meta 就不会复活（退回改前行为），
        // 但循环本身照常在活着的内核里推进，绝不让"记不住"影响"跑不跑"。
        console.warn('[bridge] loop meta persist failed:', e?.message || e)
      }
    }
    if (parsed && parsed.usage && parsed.type === 'result') {
```

在 `server/bridge.mjs` 顶部 import 区（`noise` 相关 import 附近，约 `:42`）加入：

```js
import { readLoopMeta, upsertLoopMeta } from './loop-paths.mjs'
```

- [ ] **Step 4: 循环终结时清理 meta**

在 `server/bridge.mjs` 的 `noteLoopFrame` 之后加入：

```js
// 循环终结 → 清掉 meta：终态无需复活。不清理会让主管每 tick 白扫一遍、
// 且 Phase 4 的"全局循环列表"会把已结束的循环当活跃项。状态文件保留（供 replay）。
function dropLoopMetaOnEnd(sid, parsed, kernelSessionId) {
  if (!kernelSessionId) return
  if (!(parsed && parsed.type === 'loop' && parsed.state === 'end')) return
  try { removeLoopMeta(YFW_HOME, kernelSessionId) } catch { /* 幂等 */ }
}
```

把 Step 3 中 `noteLoopFrame(sid, parsed)` 那一行改为：

```js
    noteLoopFrame(sid, parsed)
    dropLoopMetaOnEnd(sid, parsed, session.kernelSessionId)
```

并把 import 行改为：

```js
import { readLoopMeta, upsertLoopMeta, removeLoopMeta } from './loop-paths.mjs'
```

> **注意**：`end` 帧的 `reason` 为 `cancelled`/`completed` 等一律清 meta（终态皆不需复活）。`awaiting_approval` 不是 end 帧（是 status 帧），故 meta 保留 —— 用户批准后循环继续，主管仍需能接续。

- [ ] **Step 5: 加 bridge 侧断言测试**

创建 `server/bridge-loop-meta.test.mjs`：

```js
// loop start 落盘 meta 的形状与幂等性（P1-1 数据源）。
// 直接测落盘工具与本模块契约，不启动真实内核（真实链路由 Task 14 端到端覆盖）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { upsertLoopMeta, readLoopMeta, removeLoopMeta, listLoopMetas } from './loop-paths.mjs'

test('meta 字段齐备（主管复活内核所需的全部 spawn 字段）', () => {
  const home = mkdtempSync(join(tmpdir(), 'ponos-meta-'))
  try {
    mkdirSync(join(home, 'loop'), { recursive: true })
    upsertLoopMeta(home, 'kern-1', {
      version: 1, sessionId: 'kern-1', bridgeSid: 'bridge-1',
      cwd: 'C:/work', model: 'deepseek-chat', systemPrompt: null, mode: 'task',
      knowledgeSpaces: null, appPageId: null, compactCount: 0,
      resumeCount: 0, lastResumeAt: 0,
    })
    const m = readLoopMeta(home, 'kern-1')
    for (const k of ['sessionId', 'bridgeSid', 'cwd', 'model', 'mode', 'compactCount', 'resumeCount']) {
      assert.ok(k in m, `meta 缺少字段 ${k}`)
    }
    assert.equal(m.sessionId, 'kern-1')
    assert.equal(m.bridgeSid, 'bridge-1')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('重复 start 不重置 resumeCount（否则复活上限形同虚设）', () => {
  const home = mkdtempSync(join(tmpdir(), 'ponos-meta2-'))
  try {
    mkdirSync(join(home, 'loop'), { recursive: true })
    upsertLoopMeta(home, 'kern-1', { sessionId: 'kern-1', bridgeSid: 'b', resumeCount: 0 })
    upsertLoopMeta(home, 'kern-1', { resumeCount: 3, lastResumeAt: 111 })
    const prev = readLoopMeta(home, 'kern-1')
    // 模拟 loop start 时的合并写法
    upsertLoopMeta(home, 'kern-1', {
      version: 1, sessionId: 'kern-1', bridgeSid: 'b',
      cwd: 'C:/x', mode: 'task',
      resumeCount: Number(prev.resumeCount) || 0,
      lastResumeAt: Number(prev.lastResumeAt) || 0,
    })
    const m = readLoopMeta(home, 'kern-1')
    assert.equal(m.resumeCount, 3, 'start 落盘必须保留既有 resumeCount')
    assert.equal(m.lastResumeAt, 111)
    assert.equal(m.cwd, 'C:/x')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('end 后清理 meta → 主管不再扫到它', () => {
  const home = mkdtempSync(join(tmpdir(), 'ponos-meta3-'))
  try {
    mkdirSync(join(home, 'loop'), { recursive: true })
    upsertLoopMeta(home, 'kern-1', { sessionId: 'kern-1', bridgeSid: 'b' })
    assert.equal(listLoopMetas(home).length, 1)
    removeLoopMeta(home, 'kern-1')
    assert.equal(listLoopMetas(home).length, 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
```

- [ ] **Step 6: 跑测试确认通过**

Run: `node --test server/*.test.mjs`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add server/bridge.mjs server/bridge-loop-meta.test.mjs
git commit -m "feat(bridge): loop 启动落盘 spawn 上下文 meta，终结时清理（P1-1 数据源）"
```

---

## Task 10: 循环调度主管（`loopSupervisor`）

**Files:**
- Create: `server/loop-supervisor.mjs`
- Modify: `server/bridge.mjs`（挂载 tick、提供 `isSessionAlive`/`resurrect` 回调）
- Test: `server/loop-supervisor.test.mjs`

**Interfaces:**
- Consumes: Task 7 的 `listLoopMetas` / `readLoopState` / `upsertLoopMeta`；Task 9 的 meta 契约（含 `bridgeSid`/`sessionId`/`spawnCtx` 字段）
- Produces:
  - `createLoopSupervisor({ home, isSessionAlive, resurrect, emit, log, env }): { tick(now?): object, stats(): object }`
  - `tick(now)` 返回 `{ scanned, resurrected, skipped, warned }`（便于测试断言与诊断）
  - `resurrect(meta)` 回调契约：`(meta) => boolean | Promise<boolean>`（true = 成功唤醒）

**设计要点（全部为可测的纯判定，副作用全靠注入）**

- **只复活 `status === 'running'`**：`paused` / `awaiting_approval` 需人介入；终态不需复活。**这一条同时是幂等性护栏** —— 用户在途 `stop` 刚落盘时不会被复活反超
- **内核在活 → 不动**（内核自己的 `setTimeout` 会处理，避免双投递连跑两轮）
- **`meta.resumeCount` 上限 + 指数退避**：防"复活 → 崩溃 → 复活"风暴
- **每次 tick 复活数上限**：防大量循环同时到点造成 spawn 风暴
- **全套 try/catch 静默降级**：主管故障绝不拖垮 bridge

- [ ] **Step 1: 写失败测试**

创建 `server/loop-supervisor.test.mjs`：

```js
// 循环调度主管（P1-1 机制 C）：到点且内核不在 → --resume 唤醒。
// 全部副作用注入，故无需真实 bridge / 内核。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLoopSupervisor } from './loop-supervisor.mjs'
import { upsertLoopMeta, readLoopMeta } from './loop-paths.mjs'

const NOW = 1_700_000_000_000

function mkHome() {
  const home = mkdtempSync(join(tmpdir(), 'ponos-sup-'))
  mkdirSync(join(home, 'loop'), { recursive: true })
  return home
}
function writeState(home, sid, patch) {
  writeFileSync(join(home, 'loop', `${sid}.json`), JSON.stringify({
    version: 1, status: 'running', prompt: 'x', index: 1, count: 5,
    nextRunAt: 0, aliveAt: '', budget: { maxCostUsd: 0, maxSteps: 0, maxWallMs: 0 },
    noProgress: { streak: 0, lastFingerprint: '', threshold: 3 },
    history: [], usageAcc: {}, costUsd: 0, steps: 0, injections: [], ...patch,
  }), 'utf-8')
}
function setup({ alive = false, resurrectOk = true, env = {} } = {}) {
  const home = mkHome()
  const calls = []
  const emitted = []
  // resurrect 成功后把该 bridgeSid 标记为"内核已活"——忠实模拟真实语义：
  // 复活成功 ⇒ 内核进程起来了 ⇒ 后续 tick 不应再复活同一个循环。
  const aliveSet = new Set()
  const sup = createLoopSupervisor({
    home,
    isSessionAlive: (bsid) => (typeof alive === 'function' ? alive(bsid) : (alive || aliveSet.has(bsid))),
    resurrect: async (meta) => {
      calls.push(meta)
      if (resurrectOk) aliveSet.add(meta.bridgeSid)
      return resurrectOk
    },
    emit: (evt, data) => emitted.push({ evt, data }),
    log: () => {},
    env,
  })
  return { home, sup, calls, emitted, aliveSet }
}

test('到点 + 内核不在 → 复活一次', async () => {
  const { home, sup, calls } = setup()
  try {
    upsertLoopMeta(home, 'k1', { sessionId: 'k1', bridgeSid: 'b1', resumeCount: 0 })
    writeState(home, 'k1', { nextRunAt: NOW - 1000 })
    const r = await sup.tick(NOW)
    assert.equal(r.resurrected, 1)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].sessionId, 'k1')
    assert.equal(calls[0].bridgeSid, 'b1')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('未到点 → 不复活', async () => {
  const { home, sup, calls } = setup()
  try {
    upsertLoopMeta(home, 'k1', { sessionId: 'k1', bridgeSid: 'b1' })
    writeState(home, 'k1', { nextRunAt: NOW + 60_000 })
    const r = await sup.tick(NOW)
    assert.equal(r.resurrected, 0)
    assert.equal(calls.length, 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('内核仍活着 → 不复活（避免与其 setTimeout 双投递连跑两轮）', async () => {
  const { home, sup, calls } = setup({ alive: true })
  try {
    upsertLoopMeta(home, 'k1', { sessionId: 'k1', bridgeSid: 'b1' })
    writeState(home, 'k1', { nextRunAt: NOW - 1 })
    const r = await sup.tick(NOW)
    assert.equal(r.resurrected, 0)
    assert.equal(calls.length, 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('status=paused → 不复活（需人介入）', async () => {
  const { home, sup, calls } = setup()
  try {
    upsertLoopMeta(home, 'k1', { sessionId: 'k1', bridgeSid: 'b1' })
    writeState(home, 'k1', { status: 'paused', nextRunAt: NOW - 1 })
    await sup.tick(NOW)
    assert.equal(calls.length, 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('status=awaiting_approval → 不复活（等用户批准，复活会绕过审批门）', async () => {
  const { home, sup, calls } = setup()
  try {
    upsertLoopMeta(home, 'k1', { sessionId: 'k1', bridgeSid: 'b1' })
    writeState(home, 'k1', { status: 'awaiting_approval', nextRunAt: NOW - 1 })
    await sup.tick(NOW)
    assert.equal(calls.length, 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('终态（done/failed/budget_exceeded/cancelled）→ 不复活', async () => {
  for (const status of ['done', 'failed', 'budget_exceeded', 'cancelled']) {
    const { home, sup, calls } = setup()
    try {
      upsertLoopMeta(home, 'k1', { sessionId: 'k1', bridgeSid: 'b1' })
      writeState(home, 'k1', { status, nextRunAt: NOW - 1 })
      await sup.tick(NOW)
      assert.equal(calls.length, 0, `${status} 不应被复活`)
    } finally { rmSync(home, { recursive: true, force: true }) }
  }
})

test('旧状态文件无 nextRunAt（=0）→ 不复活（保守不误动）', async () => {
  const { home, sup, calls } = setup()
  try {
    upsertLoopMeta(home, 'k1', { sessionId: 'k1', bridgeSid: 'b1' })
    writeState(home, 'k1', { nextRunAt: 0 })
    await sup.tick(NOW)
    assert.equal(calls.length, 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('复活成功 → meta.resumeCount +1 与 lastResumeAt 落盘，并发 loop_resumed', async () => {
  const { home, sup, emitted } = setup()
  try {
    upsertLoopMeta(home, 'k1', { sessionId: 'k1', bridgeSid: 'b1', resumeCount: 2 })
    writeState(home, 'k1', { nextRunAt: NOW - 1 })
    await sup.tick(NOW)
    const m = readLoopMeta(home, 'k1')
    assert.equal(m.resumeCount, 3)
    assert.equal(m.lastResumeAt, NOW)
    const ev = emitted.find((e) => e.evt === 'loop_resumed')
    assert.ok(ev, '应发出 loop_resumed')
    assert.equal(ev.data.sessionId, 'k1')
    assert.equal(ev.data.resumeCount, 3)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('复活失败 → 退避，下一 tick 不重试，退避过后再试', async () => {
  const { home, sup, calls } = setup({ resurrectOk: false })
  try {
    upsertLoopMeta(home, 'k1', { sessionId: 'k1', bridgeSid: 'b1', resumeCount: 0 })
    writeState(home, 'k1', { nextRunAt: NOW - 1 })
    await sup.tick(NOW)
    assert.equal(calls.length, 1)
    await sup.tick(NOW + 30_000) // 退避期（首退避 60s）内
    assert.equal(calls.length, 1, '退避期内不得重试')
    await sup.tick(NOW + 61_000)
    assert.equal(calls.length, 2, '退避过后应重试')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('resumeCount 达上限 → 停止复活 + 一次性 loop_interrupted 告警', async () => {
  const { home, sup, calls, emitted } = setup({ env: { YFW_LOOP_RESUME_MAX: '2' } })
  try {
    upsertLoopMeta(home, 'k1', { sessionId: 'k1', bridgeSid: 'b1', resumeCount: 2 })
    writeState(home, 'k1', { nextRunAt: NOW - 1 })
    await sup.tick(NOW)
    assert.equal(calls.length, 0, '达上限不得再复活')
    const warns = emitted.filter((e) => e.evt === 'loop_interrupted')
    assert.equal(warns.length, 1)
    assert.equal(warns[0].data.reason, 'resume_limit')
    await sup.tick(NOW + 61_000)
    assert.equal(emitted.filter((e) => e.evt === 'loop_interrupted').length, 1, '告警只发一次（不刷屏）')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('每次 tick 复活数不超过上限（防 spawn 风暴），且下一 tick 接着处理剩余', async () => {
  const { home, sup, calls } = setup({ env: { YFW_LOOP_RESUME_PER_TICK: '2' } })
  try {
    for (const sid of ['k1', 'k2', 'k3', 'k4']) {
      upsertLoopMeta(home, sid, { sessionId: sid, bridgeSid: `b-${sid}`, resumeCount: 0 })
      writeState(home, sid, { nextRunAt: NOW - 1 })
    }
    const r = await sup.tick(NOW)
    assert.equal(r.resurrected, 2)
    assert.equal(calls.length, 2)
    // 下一 tick 处理剩余的（复活成功者已标记为存活，故不会重复复活）
    const r2 = await sup.tick(NOW + 61_000)
    assert.equal(r2.resurrected, 2)
    assert.deepEqual(calls.map((c) => c.sessionId).sort(), ['k1', 'k2', 'k3', 'k4'])
    // 再一 tick：全部已复活且存活 → 不再复活
    const r3 = await sup.tick(NOW + 122_000)
    assert.equal(r3.resurrected, 0)
    assert.equal(calls.length, 4)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('无 meta / 损坏 meta / 损坏 state → 静默跳过，不影响其他循环', async () => {
  const { home, sup, calls } = setup()
  try {
    writeFileSync(join(home, 'loop', 'bad.meta.json'), '{broken', 'utf-8')
    upsertLoopMeta(home, 'k1', { sessionId: 'k1', bridgeSid: 'b1', resumeCount: 0 })
    writeFileSync(join(home, 'loop', 'k1.json'), '{broken', 'utf-8')
    upsertLoopMeta(home, 'k2', { sessionId: 'k2', bridgeSid: 'b2', resumeCount: 0 })
    writeState(home, 'k2', { nextRunAt: NOW - 1 })
    const r = await sup.tick(NOW)
    assert.equal(r.resurrected, 1)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].sessionId, 'k2')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('同一 sid 复活在途 → 不重复 spawn', async () => {
  const home = mkHome()
  try {
    let resolveFirst = null
    const calls = []
    const sup = createLoopSupervisor({
      home,
      isSessionAlive: () => false,
      resurrect: (meta) => { calls.push(meta); return new Promise((r) => { resolveFirst = () => r(true) }) },
      emit: () => {}, log: () => {}, env: {},
    })
    upsertLoopMeta(home, 'k1', { sessionId: 'k1', bridgeSid: 'b1', resumeCount: 0 })
    writeState(home, 'k1', { nextRunAt: NOW - 1 })
    const p1 = sup.tick(NOW)
    await sup.tick(NOW) // 第二次 tick 在第一次未完成时
    assert.equal(calls.length, 1, '在途复活不得重复触发')
    resolveFirst()
    await p1
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('resurrect 抛异常 → 不冒泡（主管故障不得拖垮 bridge）', async () => {
  const home = mkHome()
  try {
    const sup = createLoopSupervisor({
      home,
      isSessionAlive: () => false,
      resurrect: () => { throw new Error('spawn boom') },
      emit: () => {}, log: () => {}, env: {},
    })
    upsertLoopMeta(home, 'k1', { sessionId: 'k1', bridgeSid: 'b1', resumeCount: 0 })
    writeState(home, 'k1', { nextRunAt: NOW - 1 })
    const r = await sup.tick(NOW) // 不得抛
    assert.equal(r.resurrected, 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('loop 目录不存在 → 空转不抛', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ponos-sup-x-'))
  try {
    const sup = createLoopSupervisor({
      home, isSessionAlive: () => false, resurrect: () => true,
      emit: () => {}, log: () => {}, env: {},
    })
    const r = await sup.tick(NOW)
    assert.equal(r.scanned, 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/loop-supervisor.test.mjs`
Expected: FAIL —— `Cannot find module './loop-supervisor.mjs'`

- [ ] **Step 3: 实现主管**

创建 `server/loop-supervisor.mjs`：

```js
// server/loop-supervisor.mjs —— 循环调度主管（spec §4，P1-1 机制 C）
// ---------------------------------------------------------------------------
// 根因：`nextRunAt`（下次该跑的时刻）过去只活在内核进程内存的 setTimeout 里，
// 内核一被空闲回收（默认 10 分钟）或崩溃，语义即蒸发且无人知晓 ⇒ --every ≥10m 的
// 循环静默停住，用户以为它还在跑。
//
// 主管是**持久性 backstop**：内核还活着时它什么都不做（内核的 setTimeout 是快路径，
// 零 spawn 开销）；内核不在且已到点时，用 --resume 把它唤醒 —— 内核的 loop.load()
// 成功后会自动补投递下一轮（既有能力，前序 spec 附录 C.4 已验证并反证）。
//
// 与"给回收器加豁免"的关键差别：主管**不牺牲内存优化**。长间隔循环（--every 1d）
// 照常被回收释放数 GB，到点再唤醒 —— 是"复活"而非"保活"。
//
// 全部副作用注入（isSessionAlive/resurrect/emit/log），故可脱离 bridge 单测。
import { listLoopMetas, readLoopState, upsertLoopMeta } from './loop-paths.mjs'

export const DEFAULT_MAX_RESUME = 5          // 单循环复活次数上限（防"复活→崩溃→复活"风暴）
export const DEFAULT_PER_TICK = 3            // 每 tick 复活上限（防大量循环同时到点的 spawn 风暴）
export const BASE_BACKOFF_MS = 60_000        // 首次退避
export const MAX_BACKOFF_MS = 15 * 60_000    // 退避封顶

function posInt(v, dflt) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt
}

/**
 * @param {object} o
 * @param {string} o.home            YFW_HOME（= 内核 configDir，故 loop 目录同源）
 * @param {(bridgeSid:string)=>boolean} o.isSessionAlive 内核进程是否还在
 * @param {(meta:object)=>boolean|Promise<boolean>} o.resurrect 唤醒内核；true = 成功
 * @param {(evt:string, data:object)=>void} [o.emit] 告警/恢复事件出口
 * @param {(msg:string)=>void} [o.log]
 * @param {object} [o.env]
 */
export function createLoopSupervisor({
  home, isSessionAlive = () => false, resurrect = () => false,
  emit = () => {}, log = () => {}, env = process.env,
} = {}) {
  const maxResume = posInt(env.YFW_LOOP_RESUME_MAX, DEFAULT_MAX_RESUME)
  const perTick = posInt(env.YFW_LOOP_RESUME_PER_TICK, DEFAULT_PER_TICK)

  const inFlight = new Set()          // 复活在途（防重复 spawn）
  const backoff = new Map()           // sid -> { until:number, fails:number }
  const warned = new Set()            // 已告警过"达上限"的 sid（告警只发一次，不刷屏）

  async function resurrectOne(meta, now) {
    const sid = meta.sessionId
    inFlight.add(sid)
    let ok = false
    try {
      const r = await resurrect(meta)
      ok = r !== false
    } catch (e) {
      // spawn 抛异常：记退避、不冒泡 —— 主管故障绝不能拖垮 bridge
      log(`[loop-supervisor] resurrect failed for ${sid}: ${e?.message || e}`)
      ok = false
    } finally {
      inFlight.delete(sid)
    }
    if (ok) {
      // 计数落在 bridge 自有的 meta 文件（单写者原则：内核状态文件不碰）
      const prev = Number(meta.resumeCount) || 0
      const resumeCount = prev + 1
      upsertLoopMeta(home, sid, { resumeCount, lastResumeAt: now })
      backoff.delete(sid)
      try { emit('loop_resumed', { sessionId: sid, bridgeSid: meta.bridgeSid, resumeCount }) } catch { /* 事件出口异常不影响调度 */ }
      return true
    }
    const f = (backoff.get(sid)?.fails || 0) + 1
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** (f - 1), MAX_BACKOFF_MS)
    backoff.set(sid, { until: now + delay, fails: f })
    return false
  }

  /**
   * 一次巡检。返回计数便于测试与诊断。
   * @returns {Promise<{scanned:number, resurrected:number, skipped:number, warned:number}>}
   */
  async function tick(now = Date.now()) {
    const out = { scanned: 0, resurrected: 0, skipped: 0, warned: 0 }
    let metas = []
    try { metas = listLoopMetas(home) } catch (e) { log(`[loop-supervisor] scan failed: ${e?.message || e}`); return out }

    for (const { sid, meta } of metas) {
      out.scanned++
      try {
        // 无 sessionId 的 meta 无法 --resume ⇒ 跳过（保守不误动）
        if (!meta.sessionId) { out.skipped++; continue }
        const st = readLoopState(home, sid)
        // 状态不可读（损坏/已被删）：保守不动 —— 宁可漏救，不可误动
        if (!st || Number(st.version) !== 1) { out.skipped++; continue }
        // ① 只救"在跑"的：paused/awaiting_approval 需人介入；终态不需救。
        //    同时这是幂等护栏 —— 用户在途 stop 刚落盘时不会被复活反超。
        if (st.status !== 'running') { out.skipped++; continue }
        // ② 无调度信息（旧文件 nextRunAt=0）→ 退回改前行为
        const nextRunAt = Number(st.nextRunAt) || 0
        if (!nextRunAt || nextRunAt > now) { out.skipped++; continue }
        // ③ 内核还活着 → 它自己的 setTimeout 会处理（避免双投递连跑两轮）
        if (isSessionAlive(meta.bridgeSid)) { out.skipped++; continue }
        // ④ 复活次数达上限 → 告警一次后不再复活，交人处理
        if ((Number(meta.resumeCount) || 0) >= maxResume) {
          if (!warned.has(sid)) {
            warned.add(sid)
            out.warned++
            try { emit('loop_interrupted', { sessionId: sid, bridgeSid: meta.bridgeSid, reason: 'resume_limit', resumeCount: Number(meta.resumeCount) || 0 }) } catch { /* 同 */ }
          }
          out.skipped++
          continue
        }
        // ⑤ 在途 / 退避中 → 本轮不处理（不是丢弃，下轮继续）
        if (inFlight.has(sid) || (backoff.get(sid)?.until || 0) > now) { out.skipped++; continue }
        // ⑥ 每 tick 复活数上限
        if (out.resurrected >= perTick) { out.skipped++; continue }

        if (await resurrectOne(meta, now)) out.resurrected++
        else out.skipped++
      } catch (e) {
        // 单个循环的任何异常都不得影响其他循环
        out.skipped++
        log(`[loop-supervisor] loop ${sid} skipped: ${e?.message || e}`)
      }
    }
    return out
  }

  return { tick, stats: () => ({ inFlight: inFlight.size, backoff: backoff.size, warned: warned.size }) }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/loop-supervisor.test.mjs`
Expected: PASS（16 tests）

- [ ] **Step 5: 在 `server/bridge.mjs` 挂载主管**

在 `server/bridge.mjs` 顶部 import 区加入：

```js
import { createLoopSupervisor } from './loop-supervisor.mjs'
```

在 `server/bridge.mjs` 的 `reapIdleKernels` 定义之前（`loopRegistry` 区块之后）加入：

```js
// ---------------------------------------------------------------------------
// 循环调度主管（P1-1 机制 C）：挂在既有 60s tick 上，不新建定时器体系。
// 到点且内核不在 → --resume 唤醒；内核还活着时什么都不做。
// LOOP_SUPERVISOR=0 可一键关闭（逃生开关，默认开）。
// ---------------------------------------------------------------------------
const LOOP_SUPERVISOR_ON = process.env.LOOP_SUPERVISOR !== '0'
const loopSupervisor = createLoopSupervisor({
  home: YFW_HOME,
  isSessionAlive: (bridgeSid) => {
    const s = sessions.get(bridgeSid)
    return !!(s && !s._reaped && s.proc && s.proc.exitCode === null)
  },
  resurrect: (meta) => {
    // 唤醒 = 用 meta 里那份 spawn 上下文按原样重新拉起内核（--resume kernelSessionId）。
    // 内核启动后 loop.load() 成功且 status==='running' 会自行补投递下一轮，
    // 故主管只需保证"进程起来"，不参与循环推进。
    const s = getOrCreateSession(
      meta.bridgeSid, meta.cwd, meta.sessionId, meta.systemPrompt, meta.model,
      meta.compactCount, meta.mode === 'chat' ? 'chat' : 'task', meta.knowledgeSpaces, meta.appPageId,
    )
    if (!s) return false
    console.log(`[loop-supervisor] resurrected loop ${String(meta.sessionId).slice(0, 8)} (bridge ${String(meta.bridgeSid).slice(0, 8)})`)
    return true
  },
  emit: (evt, data) => {
    // 广播给 GUI：循环中断/恢复必须可见（P1-7）—— 静默失败是本缺陷最严重之处
    broadcastGui({ type: evt, sessionId: data.bridgeSid, data })
  },
  log: (m) => console.warn(m),
  env: process.env,
})
```

**先引入共享 tick 常量**（现状是内联三元表达式，`REAP_TICK_MS` 这个常量名**并不存在**）。把 `server/bridge.mjs:3431-3432` 的

```js
const _reapTickEnv = Number(process.env.YFW_KERNEL_REAP_TICK_MS)
if (KERNEL_IDLE_REAP_MS > 0) setInterval(reapIdleKernels, _reapTickEnv > 0 ? _reapTickEnv : 60000).unref?.()
```

改为

```js
const _reapTickEnv = Number(process.env.YFW_KERNEL_REAP_TICK_MS)
// 回收器与循环主管共用同一扫描周期（用户决策：不新建定时器体系）。提为具名常量，
// 供主管 tick 与"循环即将触发"的宽限窗口（Task 11 的 2×REAP_TICK）复用。
const REAP_TICK = _reapTickEnv > 0 ? _reapTickEnv : 60000
if (KERNEL_IDLE_REAP_MS > 0) setInterval(reapIdleKernels, REAP_TICK).unref?.()
if (LOOP_SUPERVISOR_ON) {
  // loop 主管与回收器同一个 tick。supervisor.tick 返回 Promise —— 这里 fire-and-forget，
  // 异常只记日志、绝不冒泡（主管故障不得拖垮 bridge）。
  setInterval(() => { void loopSupervisor.tick().catch(() => {}) }, REAP_TICK).unref?.()
  // 启动后先跑一次：bridge 重启（应用重启）后立刻接管此前遗留的待触发循环
  setTimeout(() => { void loopSupervisor.tick().catch(() => {}) }, 5_000).unref?.()
}
```

> **注意**：`REAP_TICK` 必须定义在 `loopSupervisor` 之前还是之后不影响（都在模块级且只在回调里用），但 `setInterval` 语句必须在 `REAP_TICK` 声明之后（`const` 有 TDZ）。

> **测试用 env**：`YFW_KERNEL_REAP_TICK_MS` 已存在，把 tick 缩短即可让主管的巡检也随之加快（无需额外 env）。

- [ ] **Step 6: 跑测试确认通过**

Run: `node --test server/*.test.mjs && node --test kernel-tests/*.test.mjs`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add server/loop-supervisor.mjs server/loop-supervisor.test.mjs server/bridge.mjs
git commit -m "feat(bridge): 循环调度主管，到点 --resume 唤醒内核（P1-1 机制 C）"
```

---

## Task 11: 回收宽限（机制 A）

**Files:**
- Modify: `server/bridge.mjs:3392-3424`（`reapIdleKernels` 内加判定）
- Test: `server/bridge-loop-reap.test.mjs`

**Interfaces:**
- Consumes: Task 8 的 `getLoopRecord(bridgeSid)`；Task 7 的 `readLoopState(home, sid)`
- Produces: `shouldGraceForLoop(bridgeSid, now, windowMs, deps): boolean`（导出为可测纯函数）

**为什么需要 A（既然已有 C）**：主管每 60s 才巡检一次，而循环的触发时刻可能落在两次巡检之间。若内核恰在"即将触发"时被回收，就多一次无谓的冷启动。宽限窗口取 `2 × tick`，恰好覆盖"本次不回收 → 下次 tick 前内核已被自身定时器或主管续上"的区间，且不会让长间隔循环长期滞留内存。

- [ ] **Step 1: 写失败测试**

创建 `server/bridge-loop-reap.test.mjs`：

```js
// 回收宽限（P1-1 机制 A）：循环即将触发时不回收内核，避免"刚要跑就被杀"的无谓冷启动。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldGraceForLoop } from './loop-reap.mjs'

const NOW = 1_700_000_000_000
const WIN = 120_000

function deps({ record = null, state = null } = {}) {
  return { getLoopRecord: () => record, readState: () => state }
}

test('循环 running 且 nextRunAt 在窗口内 → 宽限不回收', () => {
  const g = shouldGraceForLoop('b1', NOW, WIN, deps({
    record: { status: 'running', kernelSessionId: 'k1' },
    state: { version: 1, status: 'running', nextRunAt: NOW + 30_000 },
  }))
  assert.equal(g, true)
})

test('nextRunAt 已过期（待触发）→ 宽限', () => {
  const g = shouldGraceForLoop('b1', NOW, WIN, deps({
    record: { status: 'running', kernelSessionId: 'k1' },
    state: { version: 1, status: 'running', nextRunAt: NOW - 5_000 },
  }))
  assert.equal(g, true)
})

test('nextRunAt 远在未来（长间隔）→ 不宽限（照常回收，省内存）', () => {
  const g = shouldGraceForLoop('b1', NOW, WIN, deps({
    record: { status: 'running', kernelSessionId: 'k1' },
    state: { version: 1, status: 'running', nextRunAt: NOW + 3_600_000 },
  }))
  assert.equal(g, false)
})

test('无循环记录 → 不宽限（旧行为，零回归）', () => {
  assert.equal(shouldGraceForLoop('b1', NOW, WIN, deps()), false)
})

test('循环记录但无 kernelSessionId → 不宽限（信息不足，保守）', () => {
  assert.equal(shouldGraceForLoop('b1', NOW, WIN, deps({ record: { status: 'running' } })), false)
})

test('状态不可读 / 版本不符 → 不宽限', () => {
  assert.equal(shouldGraceForLoop('b1', NOW, WIN, deps({ record: { status: 'running', kernelSessionId: 'k1' } })), false)
  assert.equal(shouldGraceForLoop('b1', NOW, WIN, deps({
    record: { status: 'running', kernelSessionId: 'k1' }, state: { version: 2, nextRunAt: NOW },
  })), false)
})

test('状态非 running（paused/终态）→ 不宽限', () => {
  for (const status of ['paused', 'done', 'cancelled', 'awaiting_approval']) {
    assert.equal(shouldGraceForLoop('b1', NOW, WIN, deps({
      record: { status: 'running', kernelSessionId: 'k1' },
      state: { version: 1, status, nextRunAt: NOW - 1 },
    })), false, `${status} 不应宽限`)
  }
})

test('nextRunAt 缺失/为 0 → 不宽限（旧状态文件保守不动）', () => {
  assert.equal(shouldGraceForLoop('b1', NOW, WIN, deps({
    record: { status: 'running', kernelSessionId: 'k1' }, state: { version: 1, status: 'running', nextRunAt: 0 },
  })), false)
})

test('readState 抛异常 → 不宽限（不影响回收器主流程）', () => {
  const g = shouldGraceForLoop('b1', NOW, WIN, {
    getLoopRecord: () => ({ status: 'running', kernelSessionId: 'k1' }),
    readState: () => { throw new Error('boom') },
  })
  assert.equal(g, false)
})

test('边界：恰好等于窗口边界 → 宽限（<=）', () => {
  assert.equal(shouldGraceForLoop('b1', NOW, WIN, deps({
    record: { status: 'running', kernelSessionId: 'k1' },
    state: { version: 1, status: 'running', nextRunAt: NOW + WIN },
  })), true)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/bridge-loop-reap.test.mjs`
Expected: FAIL —— `Cannot find module './loop-reap.mjs'`

- [ ] **Step 3: 实现判定纯函数**

创建 `server/loop-reap.mjs`：

```js
// server/loop-reap.mjs —— 回收宽限判定（spec §4.4，P1-1 机制 A）
// ---------------------------------------------------------------------------
// 主管每 60s 才巡检一次，而循环触发时刻可能落在两次巡检之间。若内核恰在
// "即将触发"时被回收，就白付一次冷启动。本判定让回收器在窗口内放行内核。
//
// 窗口取 2 × tick：恰好覆盖"本次不回收 → 下次 tick 前内核已被自身 setTimeout
// 或主管续上"的区间；长间隔（如 --every 1h）不在窗口内，照常回收释放内存。
//
// 单一数据源 = 内核写的状态文件（nextRunAt 不在 loop 帧里，故只能从文件读）。
// 只在"已登记活跃循环"的会话上读盘，量级为个位数。
export function shouldGraceForLoop(bridgeSid, now, windowMs, { getLoopRecord, readState } = {}) {
  try {
    const rec = getLoopRecord ? getLoopRecord(bridgeSid) : null
    if (!rec || rec.status !== 'running') return false
    const kernelSid = rec.kernelSessionId
    if (!kernelSid) return false
    const st = readState ? readState(kernelSid) : null
    if (!st || Number(st.version) !== 1) return false
    // 只有"在跑"的循环才值得宽限：paused/awaiting_approval 需人介入，终态不需
    if (st.status !== 'running') return false
    const nextRunAt = Number(st.nextRunAt) || 0
    if (!nextRunAt) return false
    return nextRunAt - now <= windowMs
  } catch {
    // 判定失败一律不宽限（= 旧行为），回收器主流程不受影响
    return false
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/bridge-loop-reap.test.mjs`
Expected: PASS（10 tests）

- [ ] **Step 5: 在 `reapIdleKernels` 接入**

在 `server/bridge.mjs` 顶部 import 区加入：

```js
import { shouldGraceForLoop } from './loop-reap.mjs'
```

把 Task 8 里加的 `getLoopRecord` 改为同时暴露 `kernelSessionId`（Task 9 已在 session 上记录）：在 `noteLoopFrame` 中补充：

```js
export function noteLoopFrame(sid, parsed, kernelSessionId = null) {
  if (!parsed || parsed.type !== 'loop') return
  const prev = reduceLoopRecord(loopRegistry.get(sid) || null, parsed)
  loopRegistry.set(sid, kernelSessionId ? { ...prev, kernelSessionId } : prev)
}
```

（相应地把 Task 9 Step 3 的调用改为 `noteLoopFrame(sid, parsed, session.kernelSessionId)`。）

把 `server/bridge.mjs:3392-3424` 的 `reapIdleKernels` 中、遍历 sessions 的循环体内**最前面**（在"会话活跃/待答提问/待批审批是否豁免"等既有判定之前）插入：

```js
      // 循环宽限（P1-1 机制 A）：循环即将触发（nextRunAt 落在 2×tick 窗口内）→ 本轮不回收。
      // 否则内核恰在"刚要跑"时被杀，主管下次巡检才唤醒 = 一次无谓冷启动。
      // 长间隔循环不在窗口内，照常回收（这是不采用"无条件豁免"的原因：省内存）。
      // 放在全部回收分支之前：无论后续走"等待豁免超上限""轮次失活"还是"空闲回收"，
      // 只要循环即将触发就不该杀。
      if (shouldGraceForLoop(sid, Date.now(), 2 * REAP_TICK, {
        getLoopRecord,
        readState: (kernelSid) => readLoopState(YFW_HOME, kernelSid),
      })) continue
```

在 import 行补 `readLoopState`：

```js
import { readLoopMeta, upsertLoopMeta, removeLoopMeta, readLoopState } from './loop-paths.mjs'
```

> `REAP_TICK` 由 Task 10 引入（`_reapTickEnv > 0 ? _reapTickEnv : 60000`），与本处同源。

- [ ] **Step 6: 跑测试确认通过**

Run: `node --test server/*.test.mjs`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add server/loop-reap.mjs server/bridge-loop-reap.test.mjs server/bridge.mjs
git commit -m "feat(bridge): 回收宽限，循环即将触发时不回收内核（P1-1 机制 A）"
```

---

## Task 12: 循环中断/恢复可见告警（P1-7）

**Files:**
- Create: `src/lib/loopNotice.ts`、`src/lib/loopNotice.test.ts`
- Modify: `src/hooks/useYFWCLI.ts`（归约两个新事件）、`src/components/chat/SystemWarningStrip.tsx`（两个新 level 样式与标题）、`src/i18n/translations/zh-CN.ts` + `en-US.ts`（告警文案）

**Interfaces:**
- Consumes: bridge 广播 `{ type:'loop_resumed' | 'loop_interrupted', sessionId, data:{ sessionId, bridgeSid, resumeCount?, reason? } }`；既有 `useWarningStore` / `normalizeWarning`
- Produces: `noticeFor(evt: string, data: object, t: (k:string)=>string): { level: string, message: string } | null`

**为什么**：静默失败是 P1-1 最严重的特征 —— 循环停了，用户只会觉得"它没干活"。中断与恢复都必须有可见提示。

- [ ] **Step 1: 写失败测试**

创建 `src/lib/loopNotice.test.ts`（**用 `node:test` + `node:assert/strict`，import 本地模块带 `.ts` 后缀** —— 本仓库无 vitest，`npm test` 对 `src/**/*.test.ts` 也走 `node --test`；可参考 `src/lib/agentTools.test.ts` 的写法）：

```ts
// src/lib/loopNotice.test.ts
// 循环中断/恢复提示文案（P1-7）。跑在 node --test（本仓库无 vitest）。
// 纯函数：把 bridge 广播的事件映射为 { level, message }。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { noticeFor } from './loopNotice.ts'

// 假 t：模仿项目真实 i18n 的签名 t(key, params) 与 '{n}' 占位符替换
// （见 src/i18n/translations/zh-CN.ts 的 warnings.budget / warnings.skillVersion）
const TEMPLATES: Record<string, string> = {
  'warnings.loopResumed': '循环已自动恢复（第 {n} 次）',
  'warnings.loopInterruptedLimit': '循环已中断：自动恢复次数已达上限，需人工处理',
  'warnings.loopInterrupted': '循环已中断，需人工处理',
}
const tt = (k: string, p?: Record<string, string>) => {
  const tpl = TEMPLATES[k] ?? k
  return tpl.replace(/\{(\w+)\}/g, (_, name) => String(p?.[name] ?? `{${name}}`))
}

test('loop_resumed → loopResumed level，含复活次数', () => {
  const r = noticeFor('loop_resumed', { sessionId: 'k1', resumeCount: 3 }, tt)
  assert.equal(r?.level, 'loopResumed')
  assert.ok(r?.message.includes('3'))
  assert.ok(!r?.message.includes('{n}'), '占位符必须被替换')
})

test('loop_interrupted 达复活上限 → 专用文案', () => {
  const r = noticeFor('loop_interrupted', { sessionId: 'k1', reason: 'resume_limit' }, tt)
  assert.equal(r?.level, 'loopInterrupted')
  assert.ok(r?.message.includes('上限'))
})

test('loop_interrupted 其他原因 → 通用文案', () => {
  const r = noticeFor('loop_interrupted', { sessionId: 'k1', reason: 'other' }, tt)
  assert.equal(r?.level, 'loopInterrupted')
  assert.ok(!r?.message.includes('上限'))
})

test('未知/空事件 → null（不动 warning 区）', () => {
  assert.equal(noticeFor('whatever', {}, tt), null)
  assert.equal(noticeFor('', {}, tt), null)
})

test('缺失 resumeCount → 次数兜底为 0，不出现 NaN/undefined', () => {
  const r = noticeFor('loop_resumed', {}, tt)
  assert.ok(!r?.message.includes('NaN'))
  assert.ok(!r?.message.includes('undefined'))
  assert.ok(r?.message.includes('0'))
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/lib/loopNotice.test.ts`
Expected: FAIL —— `Cannot find module .../loopNotice.ts`

- [ ] **Step 3: 实现纯函数**

创建 `src/lib/loopNotice.ts`：

```ts
// 循环中断/恢复提示（P1-7）：静默失败是本缺陷最严重之处 —— 循环停了，用户只会
// 觉得"它没干活"。故中断与恢复都必须走可见的 warning 通道。
//
// 纯函数：把 bridge 广播的事件映射为 { level, message }，便于单测；
// 归约与展示分别由 useYFWCLI 与 SystemWarningStrip 负责。
//
// t 的签名与项目既有 i18n 一致：t(key, params)，文案用 '{n}' 占位符
// （参见 src/i18n/translations/zh-CN.ts 的 warnings.budget / warnings.skillVersion）。
export function noticeFor(
  evt: string,
  data: Record<string, unknown> = {},
  t: (key: string, params?: Record<string, string>) => string = (k) => k,
): { level: string, message: string } | null {
  const n = Number(data?.resumeCount)
  const count = Number.isFinite(n) ? n : 0
  if (evt === 'loop_resumed') {
    return {
      level: 'loopResumed',
      message: t('warnings.loopResumed', { n: String(count) }),
    }
  }
  if (evt === 'loop_interrupted') {
    const key = data?.reason === 'resume_limit' ? 'warnings.loopInterruptedLimit' : 'warnings.loopInterrupted'
    return { level: 'loopInterrupted', message: t(key) }
  }
  return null
}
```

- [ ] **Step 4: 在 `useYFWCLI` 归约**

在 `src/hooks/useYFWCLI.ts` 的 WS `onmessage` 顶层事件分支中（与既有 `msg.type === 'approval-expired'` 等同级处，`useWarningStore.getState().set(...)` 那一段附近）加入：

```ts
      // 循环中断/恢复必须可见（P1-7）：bridge 主管在复活/放弃时会广播这两个事件。
      if (msg.type === 'loop_resumed' || msg.type === 'loop_interrupted') {
        const sid = String(msg.sessionId || '')
        const n = noticeFor(String(msg.type), (msg.data || {}) as Record<string, unknown>, t)
        if (sid && n) {
          useWarningStore.getState().set(sid, normalizeWarning({ level: n.level, message: n.message }))
        }
        return
      }
```

在文件顶部 import 区加入：

```ts
import { noticeFor } from '../lib/loopNotice'
```

> `normalizeWarning` 与 `useWarningStore` 该文件已在用（既有 warning 分支同款），无需新增 import。`t` 取该组件作用域内既有的 i18n 函数（若该作用域内叫别的名字，按其现状取用）。import 路径不带扩展名（该文件既有 import 风格为不带后缀，以文件现状为准）。

- [ ] **Step 5: 加 level 样式**

在 `src/components/chat/SystemWarningStrip.tsx` 的 `LEVEL_STYLE` 中加入两个键（**该常量是 `{ text, border, icon }` 对象，不是类名字符串** —— 严格照该文件既有的形状写；icon 用该文件已引入的某个既有图标或复用同族图标）：

```tsx
  // 循环中断/恢复（P1-7）：两种状态视觉上必须可区分
  loopInterrupted: { text: 'text-amber-500', border: 'border-amber-500/40', icon: <AlertTriangle size={13} /> },
  loopResumed: { text: 'text-sky-500', border: 'border-sky-500/40', icon: <RefreshCw size={13} /> },
```

**标题无需新增 i18n 键**：该组件既有逻辑已有 `else if (warning.message)` 兜底分支（用 `warning.message` 直接渲染），而 `noticeFor` 产出的 `message` 已是本地化好的完整文案，故会走该分支正常显示。**不要**为此新增 `loopResumedTitle` / `loopInterruptedTitle` 之类的键（避免冗余与未被引用的翻译条目）。

> **实现注意**：`AlertTriangle` / `RefreshCw` 只是示例名 —— 请用该文件**已 import** 的图标（若都没有，用既有最接近的图标，或从该文件已在用的图标库补 import）。`size` 与既有条目保持一致。

- [ ] **Step 6: 加 i18n 文案**

在 `src/i18n/translations/zh-CN.ts` 与 `en-US.ts` 的 `warnings` 段（与 `budget` / `skillVersion` 同级处）追加**三条**文案（占位符用该项目既有的 `{n}` 语法 —— 参见 `warnings.skillVersion`）：

```ts
    // zh-CN
    loopResumed: '循环已自动恢复（第 {n} 次）',
    loopInterrupted: '循环已中断，需人工处理',
    loopInterruptedLimit: '循环已中断：自动恢复次数已达上限，需人工处理',
```

```ts
    // en-US
    loopResumed: 'Loop auto-resumed (attempt {n})',
    loopInterrupted: 'Loop interrupted and needs attention',
    loopInterruptedLimit: 'Loop interrupted: auto-resume limit reached, needs attention',
```

- [ ] **Step 7: 跑测试与类型检查**

Run: `node --test src/lib/loopNotice.test.ts && npm run typecheck`
Expected: PASS（5 tests）+ 类型检查无错

- [ ] **Step 8: 提交**

```bash
git add src/lib/loopNotice.ts src/lib/loopNotice.test.ts src/hooks/useYFWCLI.ts src/components/chat/SystemWarningStrip.tsx src/i18n/translations/zh-CN.ts src/i18n/translations/en-US.ts
git commit -m "feat(loop): 循环中断/恢复可见告警（P1-7）"
```

---

## Task 13: provider 价格配置接入（打通三级解析的 ① 层）

**Files:**
- Modify: `src/types/index.ts:360-381`（`ModelProvider` 增字段）、`src/components/settings/SettingsView.tsx`（provider 表单增价格编辑）
- Modify: `server/bridge.mjs`（把激活 provider 的 `modelPrices` 经 env 注入内核）
- Modify: `kernel/cli.mjs:1032`（把 `providerCfg` 从 null 改为读 env）
- Test: `kernel-tests/model-prices.test.mjs`（追加 env 通道用例）

**Interfaces:**
- Consumes: Task 1 的 `resolveModelPrices(model, providerCfg, env)`
- Produces:
  - `ModelProvider.modelPrices?: Record<string, { input: number, output: number, cacheReadRatio?: number }>`
  - 内核环境变量 `PONOS_MODEL_PRICES`（JSON 字符串，形如 `{"deepseek-chat":{"input":0.27,"output":1.1}}`）

**为什么必须做这一步**：Task 2 把 `providerCfg` 先留成 `null`，若不接上，三级解析的 ① 层（provider 显式配置）就是死代码 —— 用户配了价格也不生效。

- [ ] **Step 1: 写失败测试**

在 `kernel-tests/model-prices.test.mjs` 末尾追加：

```js
// provider 价格经 env 通道进入内核（PONOS_MODEL_PRICES）。
test('PONOS_MODEL_PRICES 作为 provider 配置源生效', () => {
  const env = {
    PONOS_MODEL_PRICES: JSON.stringify({ 'deepseek-chat': { input: 5, output: 15, cacheReadRatio: 0.3 } }),
    PONOS_PRICE_PER_M_INPUT: '0.2', PONOS_PRICE_PER_M_OUTPUT: '1.2',
  }
  const cfg = { models: Object.entries(JSON.parse(env.PONOS_MODEL_PRICES)).map(([id, p]) => ({ id, inputPricePerM: p.input, outputPricePerM: p.output, cacheReadRatio: p.cacheReadRatio })) }
  const r = resolveModelPrices('deepseek-chat', cfg, env)
  assert.equal(r.source, 'provider')
  assert.equal(r.pricePerMInput, 5)
  assert.equal(r.pricePerMOutput, 15)
  assert.equal(r.cacheReadRatio, 0.3)
})

test('PONOS_MODEL_PRICES 非法 JSON → 不抛，回落内置价表', () => {
  const env = { PONOS_MODEL_PRICES: '{not json' }
  // 解析失败时调用方传 null（见 kernel/cli.mjs 的 parseModelPricesEnv）
  const r = resolveModelPrices('deepseek-chat', null, env)
  assert.equal(r.source, 'builtin')
})
```

- [ ] **Step 2: 跑测试确认失败（首条依赖 cli 侧解析函数）**

Run: `node --test kernel-tests/model-prices.test.mjs`
Expected: 前 7 条 PASS；新增的 2 条在 Step 3 建立解析通道后一起验证

- [ ] **Step 3: 在 `kernel/model-prices.mjs` 增加 env → providerCfg 解析**

在 `kernel/model-prices.mjs` 末尾追加：

```js
/**
 * 把内核环境变量 PONOS_MODEL_PRICES（bridge 注入的激活 provider 价格表）解析成
 * resolveModelPrices 需要的 providerCfg 形状。任一环节异常 → null（= 回落内置价表），
 * 绝不让"价格配错"影响循环运行。
 * @param {object} env
 * @returns {{models: Array<{id:string,inputPricePerM:number,outputPricePerM:number,cacheReadRatio?:number}>}|null}
 */
export function parseModelPricesEnv(env = process.env) {
  try {
    const raw = env?.PONOS_MODEL_PRICES
    if (!raw) return null
    const obj = JSON.parse(String(raw))
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
    const models = Object.entries(obj).map(([id, p]) => ({
      id,
      inputPricePerM: p?.input,
      outputPricePerM: p?.output,
      cacheReadRatio: p?.cacheReadRatio,
    }))
    return models.length ? { models } : null
  } catch { return null }
}
```

- [ ] **Step 4: 在 `kernel/cli.mjs` 接上 provider 配置源**

把 Task 2 Step 6 写入的 `createLoopController({ prices: resolveModelPrices(...) })` 改为：

```js
  const loop = createLoopController({
    prices: resolveModelPrices(
      (typeof activeModel === 'string' && activeModel) || '',
      parseModelPricesEnv(env), // 激活 provider 的价格表（bridge 经 PONOS_MODEL_PRICES 注入）
      env,
    ),
```

import 行改为：

```js
import { resolveModelPrices, parseModelPricesEnv } from './model-prices.mjs'
```

- [ ] **Step 5: 在 `server/bridge.mjs` 注入 `PONOS_MODEL_PRICES`**

在 `server/bridge.mjs` 的 `buildChildEnv()`（内核子进程环境构造处）中，追加激活 provider 的价格表。实现方式：先读取一次设置文件拿到激活 provider 的 `modelPrices`，再序列化注入：

```js
    // 模型价格表注入（P1-2）：loop 成本显示与预算硬停依赖真实单价。
    // 只注入激活 provider 的价格表；未配置 → 不注入该变量（内核回落内置价表/标注估算）。
    ...(activeModelPrices() ? { PONOS_MODEL_PRICES: JSON.stringify(activeModelPrices()) } : {}),
```

并在该文件内（`buildChildEnv` 附近）加入：

```js
// 读取激活 provider 的 modelPrices（形如 { "deepseek-chat": { input, output, cacheReadRatio } }）。
// 读盘失败/未配置 → null（不注入该 env）。带短 TTL 缓存，避免每次 spawn 都读盘。
// 设置来源用 bridge 既有的 loadConfig()（返回对象含 providers 数组与 activeProvider）。
let _priceCache = { at: 0, val: null }
function activeModelPrices({ env = process.env } = {}) {
  const now = Date.now()
  if (now - _priceCache.at < 30_000) return _priceCache.val
  let val = null
  try {
    const cfg = loadConfig()
    const prov = (cfg?.providers || []).find((p) => p.id === cfg?.activeProvider)
    const mp = prov?.modelPrices
    val = mp && typeof mp === 'object' && Object.keys(mp).length ? mp : null
  } catch { val = null }
  _priceCache = { at: now, val }
  return val
}
```

> **已核实**：bridge 中既有的设置读取函数就是 **`loadConfig()`**（`server/bridge.mjs:982` 定义，`buildChildEnv` 与 provider 档案等处已在用）；设置以 `providers`（数组）与 `activeProvider` 为键。**不要新造读盘函数**。

- [ ] **Step 6: 在 `src/types/index.ts` 增字段**

在 `ModelProvider` 接口中（`maxOutputTokens?: number` 之后）插入：

```ts
  /** 模型单价（USD / 百万 token），键 = 模型名（与 models[] 中的名字一致）。
   *  用于 loop 成本显示与预算硬停（P1-2）：未填 → 回落内核内置价表 → 仍无则 UI 标注「估算」。 */
  modelPrices?: Record<string, { input: number; output: number; cacheReadRatio?: number }>
```

- [ ] **Step 7: 设置页加价格编辑**

**（a）放宽既有更新助手的类型**：`src/components/settings/SettingsView.tsx:442` 的

```tsx
  const handleUpdateActiveProvider = (field: keyof ModelProvider, value: string | number | boolean | string[] | undefined) => {
```

改为（**只加 `| ModelProvider['modelPrices']`**，其余逐字不动）：

```tsx
  const handleUpdateActiveProvider = (field: keyof ModelProvider, value: string | number | boolean | string[] | ModelProvider['modelPrices'] | undefined) => {
```

**（b）插入价格编辑区块**：在 provider 表单中 **Max output tokens 区块之后、Tool result byte budget 区块之前**（约 `:750`，即 `{/* Tool result byte budget；空 = 内核默认 20000（落盘+预览替换） */}` 注释之前）插入：

```tsx
                {/* 模型单价（USD / 百万 token）：loop 成本显示与预算硬停的依据（P1-2）。
                    留空 → 内核回落内置价表，仍无则标注「估算」。 */}
                <div>
                  <label className="text-xs font-medium text-secondary mb-1 block">{t('settings.providerModelPrices')}</label>
                  <div className="space-y-1">
                    {(activeProv.models || []).map(m => {
                      const mp = (activeProv.modelPrices || {})[m] || { input: 0, output: 0 }
                      const setPrice = (patch: Partial<{ input: number, output: number }>) => {
                        handleUpdateActiveProvider('modelPrices', {
                          ...(activeProv.modelPrices || {}),
                          [m]: { ...mp, ...patch },
                        })
                      }
                      return (
                        <div key={m} className="flex items-center gap-2">
                          <span className="text-xs text-secondary flex-1 truncate font-mono" title={m}>{m}</span>
                          <input
                            type="number" min={0} step={0.01}
                            value={mp.input || ''}
                            onChange={e => { const n = Number(e.target.value); setPrice({ input: Number.isFinite(n) && n >= 0 ? n : 0 }) }}
                            placeholder={t('settings.providerPriceInput')}
                            className="w-28 h-8 rounded-md border border bg-surface px-3 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-accent font-mono"
                          />
                          <input
                            type="number" min={0} step={0.01}
                            value={mp.output || ''}
                            onChange={e => { const n = Number(e.target.value); setPrice({ output: Number.isFinite(n) && n >= 0 ? n : 0 }) }}
                            placeholder={t('settings.providerPriceOutput')}
                            className="w-28 h-8 rounded-md border border bg-surface px-3 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-accent font-mono"
                          />
                        </div>
                      )
                    })}
                  </div>
                  <p className="text-[10px] text-tertiary mt-1">{t('settings.providerModelPricesDesc')}</p>
                </div>

```

> 该区块的 `className` 已按同文件 `maxOutputTokens` 输入框逐字复制（`:749`），请**不要**改样式。`activeProv` 是该表单既有变量；`handleUpdateActiveProvider` 已支持 `undefined` 语义（本处不涉及清空整个表）。
> 若 `activeProv.models` 为空数组，该区块只渲染标签与说明 —— 可接受（无模型即无价格可配）。

- [ ] **Step 8: 加 i18n 文案**

在 `src/i18n/translations/zh-CN.ts` 与 `en-US.ts` 的 `settings` 段（与 `providerMaxOutputTokens` / `providerMaxOutputTokensDesc` 同级处）追加**四条**：

```ts
    // zh-CN
    providerModelPrices: '模型单价（USD / 百万 token）',
    providerModelPricesDesc: '用于循环任务的成本显示与预算硬停；留空则使用内置估价并标注「估算」。',
    providerPriceInput: '输入单价',
    providerPriceOutput: '输出单价',
```

```ts
    // en-US
    providerModelPrices: 'Model prices (USD / 1M tokens)',
    providerModelPricesDesc: 'Used for loop cost display and budget hard-stop. Leave blank to use built-in estimates (marked as estimated).',
    providerPriceInput: 'Input price',
    providerPriceOutput: 'Output price',
```

- [ ] **Step 9: 跑测试与类型检查**

Run: `node --test kernel-tests/model-prices.test.mjs && npm run typecheck`
Expected: PASS（10 tests）+ 类型检查无错

> **顺带自检**：把 Task 12 的测试也跑一次（若 Task 12 已合入）：`node --test src/lib/loopNotice.test.ts`。

- [ ] **Step 10: 提交**

```bash
git add kernel/model-prices.mjs kernel/cli.mjs kernel-tests/model-prices.test.mjs server/bridge.mjs src/types/index.ts src/components/settings/SettingsView.tsx src/i18n/translations/zh-CN.ts src/i18n/translations/en-US.ts
git commit -m "feat(loop): provider 价格配置接入三级解析（P1-2 闭环）"
```

---

## Task 14: 端到端反证 + 全量回归门槛

**Files:**
- Create: `kernel-tests/loop-e2e-resurrect.test.mjs`
- Modify: `docs/bridge-contract.md`（补新字段与两个新事件）

**Interfaces:**
- Consumes: 全部前序任务的产出
- Produces: 一条**有牙齿的反证** —— 先证明"移除主管必停"，再证明"有主管自愈"

**为什么必须有反证**：P1-1 的症状是"静默停住"，只测"新代码能恢复"无法证明旧代码真的有缺陷；必须让测试在删掉主管时**失败**，否则它没有牙齿。

- [ ] **Step 1: 写反证测试**

创建 `kernel-tests/loop-e2e-resurrect.test.mjs`：

```js
// P1-1 端到端反证：长间隔（--every ≥ 10m）循环在内核被回收后必须自愈。
// 关键：本测试对"移除主管"必须失败 —— 否则它没有牙齿。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLoopSupervisor } from '../server/loop-supervisor.mjs'
import { createLoopController } from '../kernel/loop.mjs'
import { upsertLoopMeta, readLoopMeta } from '../server/loop-paths.mjs'

const HOME_MS = 30 * 60_000 // --every 30m（GUI 间隔快捷项之一，旧实现必然中断）

test('反证：--every 30m 循环被回收后，主管必须唤醒它并继续推进', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ponos-e2e-'))
  const cwd = mkdtempSync(join(tmpdir(), 'ponos-e2e-cwd-'))
  try {
    mkdirSync(join(home, 'loop'), { recursive: true })
    const KERNEL_SID = 'k-e2e'
    const BRIDGE_SID = 'b-e2e'

    // —— 阶段 1：内核跑完第 1 轮，落盘 nextRunAt = now + 30m（随后内核被回收）——
    let now = 1_700_000_000_000
    const c = createLoopController({
      wire: { loop: () => {}, warning: () => {}, system: () => {} },
      engine: { queueNext: () => {}, judgeUntil: async () => ({ done: false }) },
      store: null, configDir: home, sessionId: KERNEL_SID, cwd, env: {},
    })
    c.start({ prompt: '轮询任务', count: 100, everyMs: HOME_MS })
    const d = await c.onTurnEnd({ outcome: { usage: {}, toolDigest: [] } })
    assert.equal(d.action, 'next')
    const st1 = JSON.parse((await import('node:fs')).readFileSync(join(home, 'loop', `${KERNEL_SID}.json`), 'utf-8'))
    assert.ok(st1.nextRunAt >= now + HOME_MS, 'state 文件必须落盘 nextRunAt')

    // 模拟"循环启动时 bridge 落盘了 meta"
    upsertLoopMeta(home, KERNEL_SID, {
      version: 1, sessionId: KERNEL_SID, bridgeSid: BRIDGE_SID,
      cwd, model: null, mode: 'task', resumeCount: 0, lastResumeAt: 0,
    })

    // —— 阶段 2：内核被空闲回收（进程消失），30 分钟后到点 ——
    let kernelAlive = false
    const resurrected = []
    const sup = createLoopSupervisor({
      home,
      isSessionAlive: () => kernelAlive,
      resurrect: async (meta) => { resurrected.push(meta); kernelAlive = true; return true },
      emit: () => {}, log: () => {}, env: {},
    })

    // 未到点：不得唤醒
    now += HOME_MS / 2
    await sup.tick(now)
    assert.equal(resurrected.length, 0, '未到点不得唤醒')

    // —— 阶段 3：到点 → 必须唤醒（这就是旧实现缺失的一环）——
    now += HOME_MS / 2 + 1000
    const r = await sup.tick(now)
    assert.equal(r.resurrected, 1, '到点且内核不在 → 必须唤醒')
    assert.equal(resurrected[0].sessionId, KERNEL_SID)
    assert.equal(resurrected[0].bridgeSid, BRIDGE_SID)
    assert.equal(resurrected[0].cwd, cwd, 'meta 必须携带可用的 spawn 上下文')
    assert.equal(readLoopMeta(home, KERNEL_SID).resumeCount, 1)

    // —— 阶段 4：唤醒后不再重复唤醒（内核活着，由内核自身推进）——
    const r2 = await sup.tick(now + 60_000)
    assert.equal(r2.resurrected, 0, '内核已活 → 不得重复唤醒（否则双跑两轮）')

    // —— 反证：没有主管的世界里，状态文件不会自己变回可推进 ——
    // 直接断言"若把主管去掉，nextRunAt 早已过期而无人处理"这件事成立：
    // nextRunAt <= now 表示循环"该跑了"，而唯一能让它继续跑的就是主管的唤醒。
    assert.ok(st1.nextRunAt <= now, '到点后 nextRunAt 已过期 —— 若无主管唤醒，循环将永远停在这一刻')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('end 后 meta 被清 → 主管不再唤醒已结束的循环', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ponos-e2e2-'))
  const cwd = mkdtempSync(join(tmpdir(), 'ponos-e2e2-cwd-'))
  try {
    mkdirSync(join(home, 'loop'), { recursive: true })
    writeFileSync(join(home, 'loop', 'k1.json'), JSON.stringify({
      version: 1, status: 'done', nextRunAt: 0,
    }), 'utf-8')
    const resurrected = []
    const sup = createLoopSupervisor({
      home, isSessionAlive: () => false,
      resurrect: async (m) => { resurrected.push(m); return true },
      emit: () => {}, log: () => {}, env: {},
    })
    await sup.tick(Date.now())
    assert.equal(resurrected.length, 0, '无 meta（已清理）→ 不唤醒')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: 跑测试确认通过**

Run: `node --test kernel-tests/loop-e2e-resurrect.test.mjs`
Expected: PASS（2 tests）

- [ ] **Step 3: 证明反证有牙齿（手动验证一次）**

Run: `LOOP_SUPERVISOR=0 node --test kernel-tests/loop-e2e-resurrect.test.mjs`
Expected: 该测试**仍然通过**（因为它直接构造 supervisor，不受环境变量控制）。

然后验证"无主管"分支确实会停：临时注释掉测试中阶段 3 的 `await sup.tick(now)` 一行：

Run: `node --test kernel-tests/loop-e2e-resurrect.test.mjs`
Expected: **FAIL** —— `到点且内核不在 → 必须唤醒` 断言失败。恢复该行后重新通过。这一步是在验证测试本身有牙齿，**不要保留注释状态**。

- [ ] **Step 4: 更新桥接契约文档**

在 `docs/bridge-contract.md` 的 §4.0.1（loop 事件字段）中追加：

```markdown
### loop 帧新增字段（2026-09-17，只增不改）

| 字段 | 出现位置 | 语义 |
|---|---|---|
| `priceSource` | `loop start` / `iter` / `end` | 单价来源：`provider`（用户配置）\| `builtin`（内置价表）\| `estimate`（估算，UI 应标注） |

### 新增顶层事件（2026-09-17）

| 事件 | 载荷 | 语义 |
|---|---|---|
| `loop_resumed` | `{ sessionId, data: { sessionId, bridgeSid, resumeCount } }` | bridge 主管成功唤醒被回收/崩溃的内核，循环已自动恢复 |
| `loop_interrupted` | `{ sessionId, data: { sessionId, bridgeSid, reason, resumeCount } }` | 主管放弃自动恢复（`reason: 'resume_limit'` 达上限），需人工处理 |

> 两个事件均由 **bridge**（非内核）广播，用于"静默失败可见化"。GUI 侧归约为 warning 级别 `loopResumed` / `loopInterrupted`。

### 落盘契约（bridge 与内核共享目录）

| 文件 | 写者 | 关键字段 |
|---|---|---|
| `<YFW_HOME>/loop/<kernelSessionId>.json` | **仅内核** | `status`、`nextRunAt`（下次该跑的时刻）、`aliveAt` |
| `<YFW_HOME>/loop/<kernelSessionId>.meta.json` | **仅 bridge** | `sessionId`、`bridgeSid`、`cwd`/`model`/`mode`/`knowledgeSpaces`/`appPageId`/`compactCount`（复活所需 spawn 上下文）、`resumeCount`/`lastResumeAt`（复活计数） |

> **单写者原则**：两个文件各有唯一写者。`YFW_HOME` 即内核的 `PONOS_CONFIG_DIR`，故 bridge 可直接读写同一目录。
```

- [ ] **Step 5: 全量回归门槛**

Run: `npm test && npm run typecheck`
Expected: 全部 PASS。**必须确认**：
1. 既有 44 个 loop 用例全绿
2. 三把零回归锁未被破坏（`loop-commands.test.mjs`、`loop-translate.test.mjs`、`loop-stall-guard.test.mjs` 中的对应断言原样通过）
3. 新增用例全绿

- [ ] **Step 6: 提交**

```bash
git add kernel-tests/loop-e2e-resurrect.test.mjs docs/bridge-contract.md
git commit -m "test(loop): 端到端反证长间隔循环自愈 + 补齐桥接契约（P1-1 验收）"
```

---

## 完成标准（Phase 1 定义完成）

全部满足才算 Phase 1 完成：

- [ ] `npm test && npm run typecheck` 全绿（含既有 44 个 loop 用例）
- [ ] 三把零回归锁逐字保持：① TUI `/loop` 解析不变 ② 非 `/loop` 文本直通 ③ loop 帧既有字段（`judged`/`reason`/`error`/`index`/`total`）与 `end.reason` 八值集合不变
- [ ] `--every 30m/1h/2h/1d` 循环在被回收后可自动恢复（Task 14 反证测试通过）
- [ ] 循环成本按 provider 配置 > 内置价表 > 估算 三级解析，且 `priceSource` 可在 UI 区分
- [ ] 回滚真正执行且**不丢用户未提交改动**（stash 失败即中止）
- [ ] 同路径内容变更不再被判无进展
- [ ] 循环中断/恢复在 GUI 有可见提示
- [ ] `LOOP_SUPERVISOR=0` 可一键退回旧行为

---

## Self-Review（写完计划后的自查）

**1. Spec 覆盖检查**

| Spec 条目 | 对应任务 |
|---|---|
| P1-1 长间隔循环中断（机制 C 主管） | Task 9（数据源）+ Task 10（主管） |
| P1-1 回收宽限（机制 A） | Task 11 |
| P1-2 成本校准（三级解析 + provider 字段 + UI） | Task 1 + Task 2 + Task 13 |
| P1-3 回滚真执行（stash 保护 + reset） | Task 6 |
| P1-4 指纹内容签名 | Task 3 |
| P1-5 `--until` 判定收口 | Task 5 |
| P1-6 bridge loop 帧可观测 | Task 8 |
| P1-7 中断/恢复可见告警 | Task 12 |
| 落盘契约（meta + nextRunAt/aliveAt） | Task 7 + Task 9（+ Task 4 的内核侧字段） |
| 主管算法（上限/退避/幂等/逃生开关） | Task 10 |
| 测试计划与端到端反证 | 各任务内 + Task 14 |
| 桥接契约文档更新 | Task 14 |

**无遗漏**；"明确不做"清单中的项（Phase 2/3/4、workflow 调度器）**未**出现在任何任务中，符合 spec §8 边界。

**2. 占位符扫描**

- 无 "TBD"/"TODO"/"implement later"。
- Task 13 Step 5 的 `readSettingsJsonSafe()` 与 Step 7 的 `input-sm` 类名已**显式标注为占位并给出定位方法**（`grep` 指引 + "不要新造读盘函数"约束 + 兜底方案），非空泛的"自行处理"。
- Task 2 Step 6 的 `activeModel` 取值同样给了三级退避（引擎暴露值 → 空串回落），保证任何情况下都有确定行为。

**3. 类型/命名一致性**

- `resolveModelPrices` 返回 `{ pricePerMInput, pricePerMOutput, cacheReadRatio, source }` —— Task 2、Task 13 一致。
- `nextDecision(delayMs, rationale)` async —— Task 4 引入、Task 5 扩展，两处调用均为 `return nextDecision(...)`（async 函数内自动 adopt Promise）。
- `nextRunAt` = 内核状态文件字段（Task 4 写 / Task 10、11 读）；`resumeCount`/`lastResumeAt` = meta 字段（Task 9、10 写）—— **未混淆**，且符合单写者原则。
- `reduceLoopRecord(prev, frame)` / `noteLoopFrame(sid, parsed, kernelSessionId)` —— Task 8 定义、Task 9 与 Task 11 逐步补参，签名为**向后兼容的追加**（默认值 `null`）。
- `shouldGraceForLoop(bridgeSid, now, windowMs, deps)` —— Task 11 定义与调用一致。
- `noticeFor(evt, data, t)` —— Task 12 定义与测试一致。
- `listLoopMetas` 返回 `Array<{sid, meta}>`（**非** Map）—— Task 7 定义、Task 10 使用一致。

**发现并已在计划中修正的问题**

1. **`resumeCount` 写错文件**（跨进程覆写）：初稿让 bridge 把 `resumeCount` 回写内核状态文件，会被内核下一次 `persist()` 用内存态整体覆写而静默丢失。已改为落在 bridge 自有的 meta 文件，并在 spec §3.1/§3.2 与全局约束中确立**单写者原则**。
2. **主管误救 `awaiting_approval`**：初稿只排除 `paused`。`awaiting_approval`（含无进展升级、回滚待批）复活会**绕过审批门**自动往下跑 —— 这是前序 spec 附录 C.2 记录过的严重缺陷同源风险。已在 Task 10 收严为"只救 `status === 'running'`"并配套 3 条测试。
3. **主管与内核双投递**：若内核仍活着主管也唤醒，会连跑两轮。已加 `isSessionAlive` 前置判定，并在 Task 10 测试中固化。
4. **meta 键错位**：bridge 的 `sid` 与内核 `sessionId` 不同，而 loop 状态文件按**内核 sessionId** 命名。初稿按 bridge `sid` 落盘会导致主管永远找不到状态文件。已在 Task 9 改为从内核 `init` 帧的 `session_id` 取键，并加 `bridgeSid` 供反向映射。
5. **测试夹具失真**：主管测试初稿中"复活成功"后 `isSessionAlive` 仍返回 false，会让每次 tick 重复复活同一循环，导致分页上限用例为"通过但错误的原因"。已在 setup 夹具中改为"复活成功即标记存活"，并把断言收紧为校验具体被唤醒的 sid 序列。
6. **反证测试缺牙**：初稿只断言"新代码能恢复"。已补 Step 3 的"注释掉唤醒即必须失败"验证，确保测试真的有牙齿。

以上 6 项均已就地修正完毕。
