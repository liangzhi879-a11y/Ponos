# loop 重设计 · Phase 1：调度可靠性 设计

> 状态：设计定稿待实现（用户已确认调度架构、范围、成本路径、回滚策略）
> 日期：2026-09-17
> 基线：`kernel/loop.mjs` / `kernel/loop-commands.mjs` / `kernel/loop-verify.mjs` / `kernel/cli.mjs` / `server/bridge.mjs` / `src/components/chat/Loop*`
> 前序：`docs/superpowers/specs/2026-09-14-loop-command-runtime-design.md`（该期建立了 loop 运行时，本文在其上做可靠性重设计）

---

## 0. 四期总纲（本文档只覆盖 Phase 1）

本次重设计由用户确认拆为四期，各自独立 spec → plan → 实现：

| 期 | 主题 | 交付判据 | 状态 |
|---|---|---|---|
| **1** | **可靠性与调度**（本文档） | 长间隔循环不再中断；崩溃/回收可自愈；成本准；回滚真落地 | 本文档 |
| 2 | 语义能力升级 | 目标分解、轮间上下文策略、完成判定增强 | 待启动 |
| 3 | 可视化与可控性 | 历史时间线、每轮差异可视化、热操作（跳轮/改目标/改间隔/即时暂停） | 待启动 |
| 4 | 循环平台化 | 循环成全局可管理实体（ID/列表/历史/跨会话查看），**会话内仍单一** | 待启动 |

**依赖关系**：Phase 1 是 2/3/4 的共同底座。调度权不明确时，Phase 3 的"改间隔/跳轮"没有可靠落点；Phase 4 的"全局列表"没有数据源。

**已确认的范围边界（用户决策）**：

- 「多循环与编排」= **全局可管理的实体 + 会话内仍只一个循环**（不并行）。Phase 4 落地列表与托管，Phase 1 只负责把数据源（`loopRegistry`）建起来。
- `/loop` **文本语法保留**（CLI/TUI 需要），但 **GUI 改走结构化通道**（不再"拼文本 → bridge 反向解析"）。该改动落在 Phase 3（GUI 侧），Phase 1 保持现有转译链路不动以缩小回归面。

---

## 1. 现状与缺陷（实测核实）

### 1.1 现有实现骨架（六层）

```
[GUI]  ScheduleGuide / LoopPanel / LoopStatusBar
         ↓ buildLoopCommand()            src/lib/loopCommand.ts
         ↓ send(cid, "/loop 3 --every 5m …  <任务>")
[WS]   { type:'send', prompt }
         ↓ translateLoopSend()            server/loop-translate.mjs
[bridge] start → { type:'user', loop:{…}} ／ op → { type:'loop_command' }
         ↓ 写内核 stdin
[kernel/cli.mjs]  handleUser → loop.start() ／ handleLoopOp()
         ↓ engine.runTurn() 每轮
[kernel/engine.mjs] 返回 { usage, model, text, toolDigest }
         ↓ finally: loop.onTurnEnd({ outcome })
[kernel/loop.mjs] 短路序决策 → next / wait / stop
         ↑ wire.loop('start'|'iter'|'end'|'status')
[GUI]  useYFWCLI 归约 → chatStore.loopStates[sid] → LoopStatusBar + LoopPanel
```

**短路序**（`loop.mjs:onTurnEnd`，安全边界）：
`awaiting_approval 挡自动推进 → pausing → 预算 → 无进展 → doneWhen 验证 → 次数`

**终止值域**（封闭 8 值，`loop.mjs:END_REASONS`）：
`completed / until_hit / cancelled / judge_error / verify_hit / budget_exceeded / no_progress / failed`

### 1.2 Phase 1 要修的缺陷

| # | 缺陷 | 证据（文件:行） | 用户影响 |
|---|---|---|---|
| **P1-1** | `--every ≥ 10m` 循环被内核空闲回收**静默杀死** | `server/bridge.mjs:3387-3424`（`reapIdleKernels` 无 loop 豁免）；`kernel/cli.mjs:1041-1042,1302`（定时器是进程内存 `setTimeout`）；`server/bridge.mjs:3358`（`KERNEL_IDLE_REAP_MS` 默认 10 分钟） | GUI 间隔选项里 30m/1h/2h/1d **必然中断**；用户以为循环还在跑 |
| **P1-2** | 循环成本数字**不可信** | `kernel/cost.mjs:4`（单价 env 硬编码 0.2/1.2 USD/M）；`~/.yfworking/providers.json` **零价格字段**（已核实） | 预算硬停误停或不停；用户对花费无判断依据 |
| **P1-3** | `rollback` **未实现** | `kernel/loop.mjs:169-176`（只登记 `pendingApproval` + 记 git HEAD）；前序 spec 附录 C.3 自陈 | 用户以为有回滚保护，实则没有 |
| **P1-4** | 无进展指纹是 `<工具名>:<路径>`，**同路径内容变更被判无进展** | `kernel/loop.mjs:70-75`（`fingerprintOf`）；`kernel/engine.mjs:984-990`（`turnToolDigest` 无 size/mtime/内容签名） | **误报**：反复改进同一文件会被判"无进展"并升级为待人工 |

### 1.3 一并收口的架构项（用户确认纳入本 Phase）

| # | 问题 | 为什么现在做 |
|---|---|---|
| **P1-5** | `--until` 判定留在 **cli 侧**（`cli.mjs:1282-1291`），终止逻辑分裂两地 | Phase 2 重构终止逻辑必然要碰；一次做完避免二次 churn |
| **P1-6** | 循环运行状态对 bridge **完全不可观测**（`bridge.mjs` 只做文本转译与命令转发，从不解析 loop 帧） | P1-1 修复的前提；Phase 4 全局列表的数据源 |
| **P1-7** | 恢复/中断**无用户可见通知** | 静默失败是 P1-1 最严重的特征——用户看不出循环已停 |

### 1.4 关键可行性前提（已核实）

| 事实 | 位置 | 对设计的意义 |
|---|---|---|
| `bridge` 的 `YFW_HOME` 与内核 `configDir` **同源** | `bridge.mjs:1059`（`PONOS_CONFIG_DIR: YFW_HOME`）；`kernel/config.mjs:7`；`server/yfw-home.cjs` | bridge **可直接读** `<YFW_HOME>/loop/*.json`，无需跨进程通道 |
| 内核 `--resume <id>` → `sessionId = args.resume` | `bridge.mjs:1337`；`kernel/cli.mjs:449` | 用 `sessionId` 即可反查并恢复 loop 状态文件 |
| `--resume` 时 `loop.load()` 成功后**自动补投递下一轮** | `cli.mjs:1044-1060`（前序 spec 附录 C.4 已修 + 反证测试） | **复活路径已存在且经验证**，主管只需触发 spawn |
| bridge 已有 60s tick 与常驻豁免先例 | `bridge.mjs:3429`（`reapIdleKernels` tick）；`bridge.mjs:3395`（`HOST_SID` 常驻豁免） | 复用既有 tick 体系，不新建定时器；豁免范式已有先例 |
| `send` 分支**同时持有全部 spawn 字段** | `bridge.mjs:3684-3690`（`sid/cwd/resumeId/systemPrompt/model/compactCount/mode/knowledgeSpaces/appPageId`） | 落盘 meta 的天然写入点，无需额外查找 |

---

## 2. 核心架构决策：「下一次该跑的时刻」归谁管

### 2.1 根因抽象

`nextRunAt`（下次该跑的时刻）是**持久语义**，却被存在**内核进程内存**里（`setTimeout`）。进程一死语义蒸发，且无人知晓。P1-1 / P1-6 / P1-7 全部由此派生。

### 2.2 方案对比与决策

| 方案 | 结论 |
|---|---|
| A｜给回收器加 loop 豁免 | **采纳为辅助**。不解决崩溃；且长间隔循环常驻内存数日（`--every 1d`），与回收器"1M 上下文单进程可达数 GB"的初衷冲突 |
| B｜独立调度守护进程 | 否决。又多一个要管生命周期的进程（本仓已有内核泄漏事故史：`pid 6736 静默 53min`）；bridge 已是长驻 + 已有 tick |
| C｜bridge 侧循环主管 | **采纳为主**。一个机制同修"回收"与"崩溃"；不牺牲内存优化（唤醒而非保活）；复用已验证的 `--resume` 能力 |

**用户决策：C + A 双保险。**

| 机制 | 位置 | 作用 | 代价 |
|---|---|---|---|
| **A｜即将触发宽限** | `reapIdleKernels()` | `nextRunAt - now < 2×tick` 时不回收 → 短间隔循环不被无谓回收 | 内存略高（仅临触发窗口） |
| **C｜主管复活** | 新 `loopSupervisor` | 到点且内核不在 → `--resume` 唤醒；**崩溃也能自愈** | 一次冷启动 |

A 保证"正要跑的别杀"，C 保证"已经死的能醒"。**长间隔循环仍被正常回收** —— 这是不采用"无条件豁免"的关键理由。

### 2.3 架构总览

```
                   ┌─────────────── bridge（长驻） ───────────────┐
                   │  ① loopRegistry   : 解析 loop 帧，维护循环视图 │
                   │  ② loopSupervisor : 60s tick 扫 <YFW_HOME>/loop│
                   │  ③ 回收器新增 loop 宽限判定（A）               │
                   └──────────────────────────────────────────────┘
                              │                        ▲
              spawn --resume │                        │ loop 帧
                              ▼                        │
                   ┌─────────────── 内核（短命） ────────────────┐
                   │  LoopController                             │
                   │   · 落盘新增 nextRunAt / aliveAt（内核独占写）│
                   │   · 短间隔快路径仍用 setTimeout（零 spawn）   │
                   │   · --resume → load() 补投递（既有能力）      │
                   └─────────────────────────────────────────────┘
                              │
                    <YFW_HOME>/loop/<sid>.json       ← 内核写（权威状态）
                    <YFW_HOME>/loop/<sid>.meta.json  ← bridge 写（spawn 上下文）
```

**职责边界（单向依赖，无环）**：

- **内核**：权威状态机 + 短间隔快路径。不感知主管存在。
- **bridge**：持久性 backstop + 可观测视图。不修改内核状态，只触发 spawn。
- **共存规则**：内核存活 → 主管不动（内核的 `setTimeout` 会处理）；内核不在 → 主管按 `nextRunAt` 唤醒。

---

## 3. 落盘契约（新增）

### 3.1 `<YFW_HOME>/loop/<sid>.meta.json` — bridge 写

```json
{
  "version": 1,
  "sessionId": "<内核 sessionId，作 --resume 用>",
  "cwd": "...",
  "model": "...",
  "mode": "task",
  "systemPrompt": null,
  "knowledgeSpaces": null,
  "appPageId": null,
  "compactCount": 0,
  "resumeCount": 0,
  "lastResumeAt": 0,
  "updatedAt": "2026-09-17T..."
}
```

- **写入点**：`send` 分支 `translateLoopSend()` 返回 `start` 形式的那一刻（`bridge.mjs:3694`）。彼时 bridge 手里正好有全部 spawn 字段。
- **刷新点**：内核重启（复活）时用同一份字段重写 `updatedAt`，确认上下文仍有效。
- **原子写**：`tmp + rename`（与内核侧 loop 状态文件同款）。
- **失败处理**：写失败 → 静默降级（主管无 meta 即不复活，退回旧行为），记 bridge 日志一行。

> **`resumeCount` / `lastResumeAt` 归 meta 而非内核状态文件（设计修正）**：两者是**主管自有**的复活计数。若写入内核状态文件，会形成**同文件跨进程写冲突** —— 内核的 `persist()` 用其内存态整体覆写文件，而运行中的内核并不知道 bridge 写过这个字段，下一次 persist 就把 bridge 的写入抹掉（且 bridge 的写入时机与内核 persist 时机无同步）。故遵守**单写者原则**：内核状态文件只由内核写，meta 文件只由 bridge 写。

### 3.2 `<YFW_HOME>/loop/<sid>.json` — 内核写（既有文件，**只增字段**）

新增字段：

| 字段 | 语义 | 写入时机 |
|---|---|---|
| `nextRunAt` | 下次该跑的时刻（ms 时间戳） | `onTurnEnd` 返回 `next` 时：`delayMs > 0` → `now + delayMs`；`delayMs === 0` → `now`（表示"立即，内核自己会投递"） |
| `aliveAt` | 内核最近一次心跳（ISO 时间） | 每轮轮末刷新（复用既有 `persist()`） |

**单写者原则**：本文件**只由内核写**；bridge 只读。主管的复活计数（`resumeCount`/`lastResumeAt`）存 meta 文件（§3.1），避免同文件跨进程覆写。

**兼容**：旧状态文件无这些字段 → 主管视为"无调度信息"，**不复活**（保守不误动，退回旧行为）。

**零回归**：既有字段与语义逐字不变（`version` 仍为 `SCHEMA_VERSION = 1`，只增键）。

---

## 4. 主管算法（`loopSupervisor`）

### 4.1 主循环

挂在既有 60s tick 上（`bridge.mjs:3429` 的 `setInterval(reapIdleKernels, ...)` 同源 tick，**不新建定时器体系**）：

```
function loopSupervisorTick(now):
  for meta of readdir(<YFW_HOME>/loop/*.meta.json):        // 逐个独立 try/catch
    st = readJSON(loop/<meta.sessionId>.json)
    if !st || st.version !== 1                 → skip      // 解析失败/版本不符 → 保守不动
    if st.status !== 'running'                 → skip      // paused / awaiting_approval 需人介入；终态跳过
    if !st.nextRunAt                           → skip      // 无调度信息（旧文件）→ 旧行为
    if st.nextRunAt > now                      → skip      // 未到点
    if sessionAlive(meta.sessionId)            → skip      // 内核活着，其 setTimeout 会处理
    if meta.resumeCount >= MAX_RESUME (5)      → warnOnce + skip   // 不再复活，交人处理
    if resurrectInFlight.has(sid)              → skip      // 防重复 spawn
    if inBackoff(sid, now)                     → skip      // 指数退避未到
    → resurrect(meta)                                       // spawn --resume
```

### 4.2 复活与退避

```
resurrect(meta):
  resurrectInFlight.add(sid)
  try:
    spawnKernel({ sessionId: meta.sessionId, cwd: meta.cwd, model: meta.model,
                  mode: meta.mode, systemPrompt: meta.systemPrompt,
                  knowledgeSpaces: meta.knowledgeSpaces, appPageId: meta.appPageId })
    // 走既有 getOrCreateSession(sid, cwd, resumeId=sessionId, …) → args.push('--resume', sessionId)
    // 内核启动 → loop.load() 成功且 status==='running' → setImmediate 自动补投递下一轮
    回写 meta：{ resumeCount: meta.resumeCount + 1, lastResumeAt: now, updatedAt: now }
    清退避；emit('loop_resumed', { sessionId, resumeCount })
  catch e:
    记退避 = min(2^n × 60s, 15min)
    log 一行（不抛，不阻塞其他循环）
  finally:
    resurrectInFlight.delete(sid)
```

### 4.3 幂等与安全约束

| 约束 | 理由 |
|---|---|
| 复活前复核 `status === 'running'` | 用户在途 `stop` 可能刚落盘，避免"停止后又跑一轮"（前序 spec 附录 C.2 缺陷 1 的同源风险） |
| 同一 sid 复活在途 → 跳过 | 防重复 spawn 双跑两轮 |
| 复活失败退避、不阻塞其他循环 | 单个循环故障不得拖垮 bridge |
| 主管自身全套 `try/catch` 静默降级 | 主管故障绝不能拖垮 bridge |
| `meta.resumeCount` 达上限 → 告警 + 停止复活 | 防"复活 → 崩溃 → 复活"风暴；交人处理 |
| 每次 tick 复活数上限（`MAX_PER_TICK = 3`） | 防大量循环同时到点造成 spawn 风暴 |
| `LOOP_SUPERVISOR=0` 逃生开关（默认开） | 出问题可一键退回旧行为 |

### 4.4 回收宽限（机制 A）

在 `reapIdleKernels()` 的通用空闲判定之前插入：

```
// loop 宽限：循环即将触发（nextRunAt 在 2×tick 内）→ 不回收，避免"刚要跑就被杀"的无谓 spawn
const lr = loopRegistry.get(sid)
if (lr && lr.status === 'running' && lr.nextRunAt && lr.nextRunAt - now < 2 * REAP_TICK_MS) continue
```

> 宽限窗口取 `2 × tick`（默认 120s）：恰好覆盖"本次 tick 不回收时，下次 tick 内核已被主管/自身定时器续上"的区间，不会让长间隔循环长期滞留。

---

## 5. 七项修复详细方案

### P1-1 长间隔循环中断

见 §2–§4（主管 + 回收宽限）。

### P1-2 成本校准

**三级解析优先级**（用户决策）：

```
① provider 显式配置（providers.json 的 models[] 内）
      inputPricePerM / outputPricePerM / cacheReadRatio
② 内置价表（kernel/model-prices.mjs，按模型名匹配，含常见云端模型）
③ 都没有 → 沿用现有 env 默认值，且**在 UI 标注「估算」**（消除假精度误导）
```

改动点：

- **新增** `kernel/model-prices.mjs`：纯函数 `resolveModelPrices(model, providerCfg, env)` → `{ pricePerMInput, pricePerMOutput, cacheReadRatio, source: 'provider'|'builtin'|'estimate' }`
- **`kernel/loop.mjs`**：`prices` 从 env 硬编码改为**构造参数**（`createLoopController({ prices })`），由 cli 传入解析结果；`state.priceSource` 落盘以便 UI 展示
- **`providers.json` 契约**：`models[]` 元素新增三个可选字段（**只增**，缺失即旧行为）
- **设置页**：provider 表单增价格字段（Phase 1 只做输入与存储；展示「估算」徽标）
- **协议**：`loop` 帧 `iter`/`start` 增 `priceSource` 字段（只增）

### P1-3 回滚（stash 保护 + reset --hard）

**用户决策：真正实现回滚且不丢数据。**

```
rollback():
  登记 pendingApproval { kind:'rollback', detail: snapshotRef }  → 发 status 帧（既有行为不变）
  等 /loop approve

approve() 中的 rollback 分支（实际执行）:
  ① 校验 snapshotRef 存在且为合法 git ref（sha 格式）
  ② git stash push -u -m "yfw-loop-rollback-<ts>"   // 保护未提交改动（含未跟踪 -u）
  ③ 校验 stash 成功（退出码 0）—— 失败则中止回滚并报错（绝不硬删用户改动）
  ④ git reset --hard <snapshotRef>
  ⑤ 回报：'已回滚至 <ref>；回滚前的改动已存入 stash「<msg>」，可用 git stash pop 找回'
```

**约束**：

- 仅作用于 git 跟踪文件；非 git 仓库 → 降级报错（既有行为）
- 执行仍受**审批门**（`pendingApproval` → `approve`），不可绕过
- 步骤 ③ 是安全闸：stash 不成功绝不 reset（防丢数据）
- 回滚结果写 `state.history` 条目（`note: 'rollback'`）以便 replay 可查

### P1-4 无进展指纹增内容签名

**改动**：

- `kernel/engine.mjs:984-990` 的 `turnToolDigest.push({...})` 新增 `sig` 字段：
  - 写类工具（`Write` / `Edit` / `MultiEdit`）：`sha1(输入内容)` 或 `sha1(JSON(输入参数))`
  - 读类工具（`Read` / `Grep` / `Glob`）：结果条目数 / 结果长度摘要
  - 其余工具：缺省空串
  - **实现约束**：`sig` 必须是**纯函数输入派生**（不读文件系统、不额外 I/O），避免给每步引入磁盘开销
- `kernel/loop.mjs:70-75` 的 `fingerprintOf()` 改拼接：`${name}:${path}:${sig}`

**语义校正对照**：

| 场景 | 现状判定 | 修后判定 |
|---|---|---|
| 反复写同一文件、内容不同 | ❌ 无进展（**误报**） | ✅ 有进展 |
| 反复写同一文件、内容相同 | ✅ 无进展 | ✅ 无进展 |
| 反复读同一文件 | ✅ 无进展 | ✅ 无进展 |
| 工具报同一错误 | ✅ 无进展 | ✅ 无进展 |

误报消除后，`PONOS_LOOP_NOPROGRESS_N` 保持默认 3（不再需要为误报放宽）。

### P1-5 `--until` 判定移入控制器

**现状**：`cli.mjs:1282-1291` 在 `decision.action === 'next'` 时调 `engine.judgeUntil`，命中 → `loop.stop('until_hit')`。

**改为**：移入 `onTurnEnd` 短路序——**doneWhen 之后、次数判定之前**：

```
短路序（新）:
  1.   !isActive()                  → wait
  1.5  awaiting_approval            → wait
  2.   pausing                      → paused
  3.   预算超限                      → budget_exceeded
  4.   无进展阈值                    → onStall
  5.   doneWhen 非空 → 双层验证
         通过 → verify_hit ；未通过 + 轮尽 → failed ；未通过 + 有轮 → next
  6.   until 非空 → judgeUntil（新增位置）
         达成 → until_hit ；异常 → judge_error ；未达成 → 继续
  7.   次数耗尽 → completed ；否则 next
```

**零回归锁③ 约束**：`judged` / `reason` / `error` 三个 iter 帧字段必须保留（旧 GUI 按枚举解析）。移入后由控制器在 `emit('iter', ...)` 时携带。

**收益**：终止逻辑单点收口，Phase 2 的判定增强有唯一落点。

### P1-6 bridge loop 帧可观测（`loopRegistry`）

- bridge 在事件转发路径解析 `type === 'loop'` 帧，维护 `loopRegistry: Map<sid, {status, index, total, endReason, costUsd, priceSource, lastFrameAt}>`
- **用途**：循环运行视图（P1-6）→ Phase 4 全局列表的数据源；以及回收宽限的"是否有活跃循环"判定
- **`nextRunAt` 不在帧内**（它是内核写进状态文件的调度语义，不随帧上报）。**单一数据源 = 内核写的状态文件**：机制 A（§4.4 回收宽限）与主管（§4.1）各自经 `server/loop-paths.mjs` 读同一份 `<YFW_HOME>/loop/<sid>.json`，不共享内存缓存（避免缓存陈旧导致误判）。宽限判定只在**已登记活跃循环**的会话上发生，读盘量为个位数级别，可忽略
- 归约规则与 GUI 侧 `useYFWCLI` 同源（`LOOP_ACTIVE_STATUSES` / `LOOP_END_REASONS` 值域校验）

### P1-7 可见告警

新增两个广播事件（复用既有 warning strip 样式与通道）：

| 事件 | 触发 | GUI 展示 |
|---|---|---|
| `loop_interrupted` | 主管检测到"到点但内核不在且暂不复活"（退避中 / 达上限） | 提示条：循环已中断，原因 + 建议动作 |
| `loop_resumed` | 主管复活成功 | 提示条：循环已自动恢复（第 N 次） |

- GUI：`useYFWCLI` 归约 → 复用 `SystemWarningStrip` 通道（不新建 UI 族）
- 内核侧既有 `wire.warning({ level: 'loop_persist' })` 保留不变

---

## 6. 测试计划

沿用 `kernel-tests/*.test.mjs`（`node:test`）+ `npm test`（server/GUI）。

| 文件 | 覆盖 |
|---|---|
| `server/loop-supervisor.test.mjs`（新） | 到点复活 / 未到点不动 / 内核活着不重复 spawn / `paused` 不复活 / `awaiting_approval` 不复活 / 终态不复活 / 无 `nextRunAt` 旧文件不复活 / 复活失败退避 / `meta.resumeCount` 上限告警停复活 / 损坏 meta 与损坏 state 静默跳过 / 每次 tick 上限 |
| `kernel-tests/loop-controller.test.mjs`（扩） | `nextRunAt` 落盘 round-trip（`delayMs>0` / `=0` 两分支）/ `aliveAt` 刷新 / `--until` 移入后短路序（doneWhen 优先于 until、until 优先于次数）/ `judged/reason/error` 帧字段保留 / `sig` 指纹四种场景（内容变→有进展、内容同→无进展、重复读→无进展、重复错→无进展） |
| `kernel-tests/loop-rollback.test.mjs`（新） | stash 保护后 reset 成功 / stash 失败则中止回滚（不 reset）/ 非 git 仓库降级报错 / 未经 `approve` 不执行 / 回滚记入 history |
| `kernel-tests/model-prices.test.mjs`（新） | 三级解析优先级（provider > builtin > estimate）/ 未知模型落 estimate / 字段缺失即旧行为 |
| `server/bridge-loop-supervisor.test.mjs`（新） | 回收宽限：`nextRunAt` 临近 → 不回收；远 → 回收；无 loop 记录 → 回收（旧行为）/ meta 落盘内容完整 |
| `server/loop-translate.test.mjs`（扩） | loop start 时写 meta.json（字段齐备）/ 非 loop 文本不写 |
| **零回归** | 既有 44 个 loop 用例全绿；**三把零回归锁**逐字保持（① TUI 语法解析不变 ② 非 `/loop` 文本直通 ③ loop 帧旧字段保留）；`npm test` + `tsc --noEmit` 绿 |

### 6.1 端到端反证（P1-1 的牙齿）

真实 bridge + WS 客户端 + `PONOS_MOCK_API=1` 净室：

1. 发 `/loop --every 15m <任务>`，把 `YFW_KERNEL_IDLE_MS` 压到 60s
2. **先证明旧实现必停**：临时移除主管 → 观察"被回收 → 再无 iter 帧"（反证用例有牙齿）
3. **再证明新实现自愈**：恢复主管 → 观察"被回收 → `loop_resumed` → 继续 iter 帧"
4. 断言：`start` 帧数恒为 1（不重复启动 loop）；`loop_resumed` 恰好 1 次；复活后 `index` 连续

---

## 7. 风险与对冲

| 风险 | 对冲 |
|---|---|
| 主管复活风暴（大量循环同时到点） | `meta.resumeCount` 上限（5）+ 指数退避（60s→15min 封顶）+ 每次 tick 上限（3） |
| 主管自证循环（复活 → 崩溃 → 复活） | 达上限转告警并停止复活，交人处理（`loop_interrupted`） |
| 复活用错 spawn 上下文 | meta 由 `send` 分支同一份字段写出（单一来源）；内核 `init` 帧回显 `session_id` 供校验 |
| `--resume` 复活破坏在途工作 | 仅在"内核确认不在"时复活；复活前复核 `status === 'running'`；复活失败退避 |
| 复活与内核自身定时器**双投递**（连跑两轮） | 主管只在 `sessionAlive() === false` 时复活 ⇒ 两者互斥；内核侧既有 `clearLoopNextTimer()` 五处调用保持不动 |
| 价格字段改动波及设置页 | 只增字段、缺失即旧行为；未知模型标「估算」而非报错 |
| `sig` 指纹给每步引入 I/O 开销 | `sig` 必须是纯函数输入派生（不读文件系统）；测试断言无额外 fs 调用 |
| `--until` 移入控制器影响旧 GUI | `judged/reason/error` 三字段逐字保留；既有 iter 帧断言不变 |
| 回滚丢用户改动 | `git stash push -u` 成功才执行 reset；失败即中止并报错；结果回报 stash 位置 |

### 回滚方案

- 主管：独立新增模块 + 一处 tick 挂载 + 回收器一个判定分支 → 可单点回退
- `LOOP_SUPERVISOR=0` 逃生开关（默认开）
- 价格/指纹/until 三项均为"只增字段 + 单点替换"，可按提交粒度独立回退
- 落盘新增字段只增键，`SCHEMA_VERSION` 保持 1（旧内核读新文件忽略未知键）

---

## 8. 明确不做（Phase 1 边界）

| 不做项 | 归属 |
|---|---|
| 目标分解 / 轮间上下文策略 / 完成判定增强 | Phase 2 |
| 历史时间线 UI / 每轮差异可视化 / 热操作（跳轮·改目标·改间隔·即时暂停） | Phase 3 |
| 全局循环列表 UI / 跨会话查看与管理 | Phase 4（Phase 1 只落 `loopRegistry` 数据源） |
| GUI 改走结构化通道（不再拼文本反向解析） | Phase 3 |
| workflow DAG 调度器（`startScheduler`）的同类回收问题 | **不在本 Phase**，但 §4.4 的宽限判定对工作流宿主已有豁免，风险受控；若实测确有中断，另立任务 |
| 多循环并行 | 用户已定：会话内保持单一 |

---

## 9. 建议推进顺序（供 writing-plans 细化）

1. `kernel/model-prices.mjs` + 测试（纯函数，无依赖，可先行）
2. `engine.mjs` 的 `toolDigest.sig` + `loop.mjs` 的 `fingerprintOf` 校正 + 测试（P1-4）
3. `loop.mjs` 落盘新增 `nextRunAt`/`aliveAt` + 测试（P1-1 前提）
4. `loop.mjs` 的 `--until` 移入短路序 + cli 侧移除 + 帧字段保留断言（P1-5）
5. `loop.mjs` 的 `rollback` 实际执行 + 测试（P1-3）
6. `bridge.mjs` 的 `loopRegistry` 归约（P1-6，为 7/8 提供数据源）
7. `bridge.mjs` 的 `loopSupervisor` + meta 落盘 + 回收宽限（P1-1 主体）
8. `bridge.mjs` 的 `loop_interrupted`/`loop_resumed` 广播 + GUI 归约（P1-7）
9. 设置页 provider 价格字段（P1-2 的 UI 部分）
10. 端到端反证 + 全量回归门槛

第 1–2 步互不依赖可并行；第 7 步依赖 3、6；第 8 步依赖 7。

---

## 附录 A：现状锚点（探索期核实）

- `kernel/loop.mjs`：`freshState:32`、`persist:50`、`emit:68`、`fingerprintOf:70`、`start:78`、`isActive:106`、`stop:108`、`pause:119`、`resume:127`、`approve:140`、`setBudget:142`、`inject:151`、`snapshot:160`、`rollback:169`、`status:177`、`replay:179`、`memory:180`、`nextPayload:187`、`runVerify:195`、`onTurnEnd:209`、`load:331`、`SCHEMA_VERSION:14`
- `kernel/loop-commands.mjs`：`LOOP_OPS:11`、`parseDuration:19`、`parseLoopDirective:40`、`formatLoopStatus`、`formatLoopReplay`
- `kernel/loop-verify.mjs`：`verifyDoneWhen:24`（命令层经 `tools.run({name:'Bash'})`；只支持 `expect===0`）
- `kernel/cli.mjs`：`createLoopController:1032`、`loopUntil:1036`、`loopNextTimer:1041`、`clearLoopNextTimer:1042`、`--resume` 恢复 `:1044-1060`、`handleLoopOp:1079-1120`、`handleUser` 指令剥离 `:1143`、`loop.start:1154-1157`、轮末 `onTurnEnd:1272-1320`、`--until` 判定 `:1282-1291`、`--every` 定时器 `:1302`
- `kernel/engine.mjs`：`turnToolDigest:216`、`pendingNext:107`、`setFreshWindow:192`、`pendingNext 吸收:479-480`、`digest push:984-990`（`>40` 截断 `:991`）、`runTurn 返回 toolDigest:1101`、`judgeUntil:2129`、`queueNext:2210`、`pendingNextCount:2225`
- `kernel/cost.mjs`：`costOf:4`（env 默认 0.2/1.2/0.1）
- `kernel/config.mjs`：`resolveConfigDir:7`；`kernel/session.mjs:createSessionStore:47`
- `server/bridge.mjs`：`translateLoopSend:3694`、`loop_command` 入站 `:3711-3725`、`getOrCreateSession:1262`、`--resume` push `:1337`、`_turnActive` 跟踪 `:1485-1487`、回收器 `:3387-3424`、`KERNEL_IDLE_REAP_MS:3358`、tick `:3429`、`HOST_SID` 豁免 `:3395`、`PONOS_CONFIG_DIR:1059`
- `server/yfw-home.cjs`：`resolveYfwHome()`（`YFWORKING_HOME → PONOS_CONFIG_DIR → ~/.yfworking`）
- `server/loop-translate.mjs`：`translateLoopSend:20`
- `src/`：`lib/loopCommand.ts`、`components/chat/ScheduleGuide.tsx`、`LoopPanel.tsx`、`LoopStatusBar.tsx`、`hooks/useYFWCLI.ts:875-1240`（帧归约）、`stores/chatStore.ts:1348-1358`、`types/index.ts:68-108`

## 附录 B：关联文档

- 前序 spec：`docs/superpowers/specs/2026-09-14-loop-command-runtime-design.md`（建立 loop 运行时，附录 C.2–C.5 记录了 6 处已修严重缺陷）
- 前序 plan：`docs/superpowers/plans/2026-09-14-loop-command-runtime.md`
- 桥接契约：`docs/bridge-contract.md` §4.0.1（loop 事件字段）、§6.1（GUI 文本转译）——本 Phase 需补 `nextRunAt`/`priceSource`/`loop_resumed`/`loop_interrupted`
- 差距审计：`docs/superpowers/audits/2026-09-08-agentloop-guide-gap.md`
