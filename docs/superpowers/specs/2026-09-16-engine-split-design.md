# P1-6 拆 `kernel/engine.mjs` 设计（支撑层外提）

- 日期：2026-09-16
- 来源：`docs/2026-09-15-五引擎架构性能对比分析.md` §5 P1-6「拆 `engine.mjs`（文档时 2,885 行）与消除双份守卫」
- 前置：**P1-6 的「消除双份守卫」子项已于 2026-09-16 完成**（`kernel/guards.mjs`，9 用例绿）；
  本文件只处理剩余子项「拆文件」。
- 前置条件已满足：工作区已提交（8 条 `e1d5543`→`82c74b4`），**可随时 `git checkout` 回退对照**。

## 1. 现状（代码级核实）

`kernel/engine.mjs` = **2968 行**，呈三层：

| 层 | 行范围 | 内容 |
|---|---|---|
| ① env 常量层 | 40–219 | `envNonNeg`/`envHealMax`/`envRemindList`/`envFloat` + 约 20 个 `PONOS_*` 派生的守卫常量（受 `LOOP_GUARD_OFF` 总开关） |
| ② 模块级函数层 | 221–769 | 22 个**纯函数/工厂**（无闭包状态）：usage、sleep/重试/看门狗、预算、请求面组装、生成侧守卫检测 |
| ③ `createEngine` 巨型闭包 | 771–2968 | **~2200 行**，`runTurnInternal`@920、`runSubAgentLoop`@2110 等，全部依赖闭包状态（`signal`/`opts`/`wire`/`session`/`tools`/`approvalMode`/`agents`/lane 队列） |

外部导入面（全仓核实，仅 4 类）：
- `kernel/cli.mjs` → `createEngine`
- `kernel/compact.mjs` → `patchOrphanToolUses`
- `kernel-tests/*` → `createEngine`、`fitRequestToWindow`、`applyAggregateResultBudget`、`withAnchorTail`

## 2. 本轮范围：外提②层（支撑层），③层不动

**做**：把 ① 与 ② 层按内聚拆成 4 个模块，`engine.mjs` 只留 `createEngine` 与 re-export。
**不做**：拆 `createEngine` 闭包（理由见 §5）。

## 3. 模块划分（按内聚，非按行数）

### 3.1 `kernel/engine-config.mjs` —— env 常量层（原 54–219）
`envNonNeg` / `envHealMax` / `envRemindList` / `envFloat` + 全部 `PONOS_*` 常量
（`LOOP_GUARD_OFF`、`MAX_TOOL_ITERATIONS`、`TURN_TIMEOUT_MS`、`MAX_OVERFLOW_RETRIES`、
`STREAM_IDLE_MS`、`FIRST_BYTE_HARD_CAP_MS`、`STREAM_FIRST_BYTE_MS`、`IDLE_DEAD_RETRY_*`、
`MAX_ERROR_ITERATIONS`、`REPEAT_REMIND_AT`、`NEAR_REPEAT_*`、`REPEAT_HEAL_MAX`、
`CONTINUE_HEAL_MAX`、`OUTPUT_TIERS`、`MELTDOWN_HEAL_MAX`、`IDLE_HEAL_MAX`、
`UPSTREAM_DEAD_HEAL_*`、`LOOP_STALL_MS`、`STALL_HEAL_MAX`、`LANE_MAX_CONCURRENT`）。全部 export，注释随迁。

**求值时机不变**：仍是模块顶层读 `process.env`。ESM 中依赖模块先于引用者求值，与"常量原在 engine
顶层"等价（`cli.mjs` 的 `settings.env` 注入发生在**所有**模块求值之后——两种写法都一样拿不到，
这是既有已知行为，非本次引入）。

### 3.2 `kernel/request-face.mjs` —— 请求面组装（含失真锚点）
`isRequestFaceCacheOn`（带私有 `let requestFaceCacheOn`，**保持惰性读**）、
`isFidAnchorOn`（同上）、`withAnchorTail`、`trimOversizedRequestCopy`、`buildHistoryIndex`、
`fitRequestToWindow`、私有无需导出的 `messageTextOf`、`patchOrphanToolUses`、`createRequestFace`。
依赖：`contentEpoch`(context) 、`perfCount`(perf)。

> 这几个函数本就自洽成环：`fitRequestToWindow` 用 `buildHistoryIndex`/`trimOversizedRequestCopy`/`patchOrphanToolUses`；
> `createRequestFace` 用 `patchOrphanToolUses`/`contentEpoch`/`isRequestFaceCacheOn`。同模块内保持函数声明提升语义。

### 3.3 `kernel/stream-runtime.mjs` —— 流式运行支撑
`addUsage`/`hasUsage`、`sleep`/`sleepAbortable`/`retryDelayMs`/`retryStream`/`rawAbortSignal`、
`withToolDeadline`、`applyAggregateResultBudget`、`makeIdleWatchdog`、`adaptiveFirstByteMs`。
依赖：`streamMessages`/`classifyApiError`/`deadStreamError`(api)。

### 3.4 `kernel/gen-guards.mjs` —— 生成侧检测
`normalizeEffort`、`isPlanTail`、`isThinkOnly`、`detectGenerationRepeat`、`isCodeLikeUnit`、
`createNearRepeatDetector`、`canonicalToolCallKey`。依赖：`countCjk`(context)。

> 与 `guards.mjs`（P1-6 上半场产物，**工具/循环侧判据**）区分：本模块管**生成文本侧**（重复、计划尾、
> 思考早停）。两者都不依赖 engine。

## 4. `engine.mjs` 侧改动（最小化）

1. 删除已外提的 ① ② 层代码。
2. 从 4 个新模块 **import** 内部用到的符号。
3. **re-export 原 17 个导出名**（`export { ... } from './xxx.mjs'`）⇒ **外部导入方与既有测试一行都不用改**，
   1647 个既有测试直接充当本次重构的验证网（这是本方案"低风险"的关键）。
4. `createEngine` 及其内部函数体**逐字不动**（只改符号来源）。

**刻意不做的清理**：engine.mjs 里因搬迁而变成未使用的 `import` 保持原样（JS 未使用导入无副作用），
避免"顺手清理"引入无关 diff。

## 5. 为什么不拆 `createEngine`（诚实标注）

`createEngine`（~2200 行）是本次拆分**真正的大头**，但本轮不做：
- 其内部函数（`runTurnInternal`/`gateToolUse`/`runToolBatch`/`runSubAgentLoop`/`spawnSubAgent`/`runLaneExecution`…）
  **全部读写闭包状态**（`signal`/`opts`/`wire`/`session`/`tools`/`approvalMode`/`agents`/lane 队列/计时器）。
  外提必须传一个巨型 context 对象并把**可变状态**改为属性访问——这是**行为等价性最难保证**的一类改动，
  而它恰好覆盖写文件权限门、灾难命令硬拒、保真门禁这些**安全相关**路径。
- 本轮先拿下"零行为风险"的 ①②层（约 800 行），把文件从 2968 降到约 2170；**③层留作独立一轮**，
  届时以本轮为新基线、可逐步（一次一个函数 + 传输对象）推进并逐次跑 1647 项测试。

## 6. 验收（DoD）

1. 4 个新模块 `node --check` 通过；`engine.mjs` 通过。
2. **无重复定义**：`engine.mjs` 内不得再出现已外提函数的定义（grep 定义式 0 命中）。
3. **导出面不变**：`engine.mjs` 的导出名集合与改前**完全相同**（17 个，逐一比对）。
4. 内核全量 **1647 tests / 1646 pass / 0 fail / 1 skipped**（与基线一致，零回归）。
5. 外部导入方（`cli.mjs`/`compact.mjs`/kernel-tests）**一行未改**且全部通过。
6. 同步 `release/YFWorking/kernel/`（**含 4 个新文件**），`diff -rq` 仅 `.env.example`；重建 `kernel-dist`。
7. 守门演练：破坏某新模块（如 `fitRequestToWindow` 早退）→ 相应用例应变红 → 恢复回绿。
