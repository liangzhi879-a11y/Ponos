# 批2 进度交接（loop 模式自适应 · 契约化改造）

> 交接时间：2026-09-20 · 分支 `kit/p0-ledgers` · 远端 `ponos`
> 用途：多会话/多 agent 协作接手用。**不是** spec/plan 的替代，只记"做到哪、坑在哪、下一步怎么验"。

## 一、已完成（全部测试绿、已提交）

### 批1（S1 / S1+ / S4.5）—— 9 个 Task，**已推送**

| Commit | 内容 |
|---|---|
| `1072d41` | S1+ 注入总账 O4（`inject-ledger.mjs` + `knowledge-inject.mjs` 增 channels/bySource + `prompt.mjs` 分段计量 + cli 轮末 `inject_snapshot`） |
| `b7170aa` 等（Task 1） | S1 观测层 O1/O2（`engine.mjs` 工具结果体积 + 守卫命中登记；`turn-observability.test.mjs` 8 例） |
| `0e5c47a`（Task 3） | 内核注入侧尊重 `front.active`（A16） |
| `f43e1ac`（Task 4） | 去重：移 `server/bridge.mjs` 两处常驻经验注入 |
| `2c2ad0a`（Task 5） | 字节口径统一（字符→字节，`memoryBytes` 唯一入口） |
| `e5a30fc`（Task 6） | EL0 主题清单（5131→254 B；A14/G3 的载体） |
| `1b6f9bd`（Task 7） | EL1 线索层 `knowledge-recommend.mjs`（R1–R6 渲染契约） |
| `6c10c1c`（Task 8） | EL1 接线 + A18/A20 互斥 + 观察期分名 |
| `b6b6b25`（Task 9） | 面板口径同步 + 观察期登记改 stderr |

### 批2 —— 进行中

| Commit | 内容 | 状态 |
|---|---|---|
| `b710afa` | Task 1：`loop-profile.mjs` + `loop-core.mjs` 契约骨架 + `loop-core-contract.test.mjs`（13 例） | 已推送 |
| `690d448` | 补提批1 Task 8 漏暂存的 7 例测试 | **待推送** |
| `fda0d87` | Task 2：迭代头守卫搬入 loop-core + 守卫命名归一 + engine 接线 | **待推送** |

## 二、待推送（网络阻塞）

`git push ponos kit/p0-ledgers` 连续 3 次失败：
`Failed to connect to github.com port 443 after 21454 ms`。
本地 3 个提交完好，网络恢复后直接推送即可（无需 rebase/merge）。

## 三、剩余工作

### Task 3 ✅ 已完成（`refactor(loop): … Task 3`）

流内守卫搬入 loop-core：`streamWallClock` / `genRepeat` / `nearRepeat`（chunk 尾）。
**关键修正**：`idleWatchdog` / `upstreamDead` 从 `inStream` **移到 `afterStream`** ——
命中判定源于流内，但**处理时机在 catch 块**（:739-800）⇒ 按执行时机归"流后"。
新增等价锁 `kernel-tests/loop-guard-instream-equivalence.test.mjs`（12 例）。

### Task 4 ⚠️ 有实质设计难点，**不可按计划原样实施**（下一步入口）

**难点**：计划 Step 4 假设 afterStream 能**一次调用**跑完（`runAfterStreamGuards(...)`）。
实测**不成立** —— 该相位的 6 个守卫**散布在三个互不相邻的时机**，中间夹着工具执行与内存写入：

| 时机 | 守卫 | 精确落点 | 语义要点 |
|---|---|---|---|
| **流后·工具前** | `repeatHeal` | engine `:947-961` | `loopStop && REPEAT_HEAL_MAX!==0 && (<0 \|\| repeatHeals<MAX) && reason ∈ {gen-repeat,near-repeat}` ⇒ hits.push + injections++ + `repeatHeals++` + `healedLastIter=true` + **`loopStop=null`** + `textBuf=''` + 注入 + `wire('guard_heal')` + **`continue`** |
| **工具后** | `progressRefresh` | `:1133-1134` | `madeProgress` ⇒ `lastProgressAt=Date.now(); stallHeals=0`（纯状态更新，**无 stop/注入**） |
| **工具后** | `repeatReminder` | `:1140-1162` | `!loopStop && REPEAT_REMIND_AT.length && blocks.length` ⇒ 链键比对 `repeatStreak`、`shouldRemindRepeat` ⇒ hits.push + injections++ + 注入（**只提醒不否决**，无 stop） |
| **工具后** | `meltdown` | `:1163-1183` | `errorStreak>=MAX_ERROR_ITERATIONS` ⇒ 自愈（injections++、`meltdownHeals++`、`errorStreak=0`、注入、**`continue`**）或硬停（`loopStop={reason:'error-meltdown'}` + **`break`**） |
| **catch 块** | `idleWatchdog` | `:739-800` | `watchdog.tripped` ⇒ 三态：`idleDeadRetry`（**continue**）/ 自愈注入（**continue**）/ 硬停（`loopStop`） |
| **catch 块** | `upstreamDead` | 同上 | `classifyApiError(err).kind==='dead-stream'` ⇒ 自愈（事件 + `sleep` + **continue**）或硬停 |

**建议路径（需先定案再动手）**：把 `afterStream` 相位**拆分**为三个相位
（例：`postStream` / `postTools` / `onError`），`PHASES` 从 3 → 5，`KNOWN_GUARDS` 分组同步。
这样每相位仍是"一次调用 + profile 定序"，且 `action`（`continue`/`break`）语义与
`runOnce`（Task 6）的编排天然对齐。**代价**：`loop-core-contract.test.mjs` 的相位集断言要同步更新。

**必守的等价细节**（易错）：
1. `repeatHeal` 会把 `loopStop` **清空并 continue** ⇒ `action:'continue'` + 返回 `loopStop:null`
   （若只返回 stop 而不清空，会误收尾）
2. 计数清零规则不同：`repeatHeals` 由"干净迭代"（`healedLastIter`）清零、
   `stallHeals` 由"恢复进展"清零、`meltdownHeals` 由"工具成功"清零 —— **三条规则不能合并**
3. `meltdown` 自愈后 `errorStreak=0`（重开失败预算）；硬停走 `break`（**置 loopStop + 停迭代**）
4. `progressRefresh` **不是守卫**语义上是"状态更新"，但它在 profile 里占位 —— 实现为
   `{state}` 返回（无 stop/action），保留可配置性
5. catch 块两个守卫的 `continue` 是**迭代级重试**，属宿主循环控制流 ⇒ 必须经 `action` 回传

### Task 5–7

- **Task 5**：lane 接线（`LANE_PROFILE` 目前**未被 engine 使用**，lane 段 `:1590-1917` 仍是内联实现；
  注意 lane 的 `REPEAT_HEAL_MAX` 判据曾与主循环漂移，已在 `:1781-1783` 注释登记）
- **Task 6**：`runOnce` 真实编排（把 api/流/工具/守卫串起来）
- **Task 7**：注入总线（把散在各处的注入收敛到 `emitInjection`）

## 四、关键坑（本批实测，务必先读）

1. **★ 改 `kernel/` 必须跑 server 分片**：`server/kernel-bridge.test.mjs` 等 spawn 真实
   `node kernel/cli.mjs`，内核侧任何写入转录/输出 stdout 的改动都会改它们看到的序列。
   实测撞 2 次（Task 2 的 `inject_snapshot` ⇒ `resume 兼容` 的 `entries.length===5` 变 6；
   Task 8 的启动期记账 ⇒ `协议闭环` 的 `expected 3 / actual 4`）。
   命令：`node --test --test-shard=i/3 "server/*.test.mjs"`（`test:server` 整包 >120s 会被工具超时杀）。
2. **★ 转录 = 协议面，观测数据不要往里写**：观测/登记类数据优先
   `process.stderr.write()` 一行结构化日志。只有 spec **明确要求**"每轮落 store"的账
   （S1+ 的 `inject_snapshot`）才写转录。
3. **★ 修"总数断言"要换成更强判据，不是改数字**：`entries.length===5` ⇒ 改为按语义子集计数
   + 断言新条目类型确实存在且结构正确（否则触"把期望值改成实际值"红线）。
4. **★ `appendMeta` 的 `...extra` 排在 `seq` 之后**：调用时**不要**传
   `seq`/`turn`/`id`/`type`/`kind`/`timestamp`（传了会覆盖内部生成值，引发
   `Cannot read properties of undefined (reading 'role')`）。
5. **★ 锚点核对不能用 `git ls-files`**（不含未暂存新文件 ⇒ 误判"已一致"）。用
   `git ls-tree --name-only HEAD kernel-tests/ | grep -c '\.test\.mjs$'` + 新增数。
6. **★ 注释里写旧代码形态会自伤 grep 型测试**：对策 = 注释省略具体形态 + 测试先过滤注释行。
7. **★ 子代理超时风险**：implementer 跑大 Task（>300s）会工具层中止，可能留下
   **"已引用但未 import"的破碎中间态**（实测 `runIterHeadGuards is not defined`）。
   对策：① 委派时限定"只读计划指定行范围"；② 超时后**先 md5 两次比对确认写入停止**再动手；
   ③ 核实最终态自洽（import/常量就位）后才跑验证。
8. **`kernel-tests/mcp.test.mjs` 的「请求超时」**在本机稳定失败（300ms 时序敏感）——
   已用 `git worktree add --detach /tmp/chx HEAD` 干净检出证实**预存**，与本批无关。

## 五、验收命令（每条都必须 EXIT=0 或全绿）

```bash
node --test --test-timeout=120000 kernel-tests/loop-core-contract.test.mjs
node --test --test-timeout=120000 kernel-tests/workflow-prompt-refresh.test.mjs   # spawn 端到端
node --test --test-concurrency=4 --test-timeout=100000 --test-shard=i/4 "kernel-tests/*.test.mjs"   # i=1..4
node --test --test-concurrency=4 --test-timeout=100000 --test-shard=1/3 "server/*.test.mjs"
npm run kit:check        # 工作树红灯 = 他方在途（/generate-title、/app-info、CT9 基线）
npm run verify:ci
```

★ 串联多条会超 120s 工具上限 ⇒ **一条一个 Bash 调用**。
★ `kit/**/*.test.mjs` 的引号不能省（省了会静默漏跑 `cli.test.mjs`/`gui.test.mjs`）。

## 六、当前树状态

- `kernel/loop-core.mjs`：三相位入口 + 迭代头 3 守卫已实现；流内/流后守卫仍为占位（Task 3/4 填）
- `kernel/loop-profile.mjs`：守卫名已归一到 `engine.mjs` 的 `GUARD_IDS`（11 个），
  `LANE_PROFILE` 与 `MAIN_PROFILE` **同集**（差异只在 compactor/health/inject/stop）
- `kernel/engine.mjs`：迭代头三段 if 已换成一次 `runIterHeadGuards(...)` 调用，仅保留宿主接线
