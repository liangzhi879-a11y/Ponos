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

### Task 4 ✅ 已完成（`refactor(loop): … Task 4`）

afterStream 6 守卫（repeatHeal / progressRefresh / repeatReminder / meltdown / idleWatchdog /
upstreamDead）已搬入 loop-core 并由 **timing 门控**驱动三站点（`postStream` / `postTools` /
`onErrorIdle` / `onErrorDeadStream`）+ engine 三处接线。**为何不拆相位**：拆要改 `PHASES`
与全部相位集断言（结构代价大），timing 门控零结构代价且顺序仍在 profile 内定义。

### Task 5 ✅ 已完成（Step 1 + 等价锁；Step 2 见下）

- **Step 1** profile 完整性 3 例：MAIN 覆盖全部 12 守卫且无重复 / LANE 与 MAIN 守卫集逐项相同 /
  三相位齐备非空
- **等价锁** `kernel-tests/loop-guard-afterstream-equivalence.test.mjs`（15 例）——
  ★ **锁出并修复 4 个真 bug**（详见下表）。这 4 个都逃过了 Task 2/3 的守卫族测试
  （那些守卫不发事件、不传空文本）⇒ **每个搬移相位都必须配一把等价锁**。

| # | Bug | 根因 | 修法 |
|---|---|---|---|
| 1 | 看门狗场景收尾原因被改写 | 两 catch 站点共用 `onError` ⇒ `guardUpstreamDead` 在无该字段的站点被判"预算耗尽" | timing 细到**每个调用站点** |
| 2 | 落了一条**空 user 消息** | `emitInjection('')` 照样调 `pushInjection` | 空文本 = 只发事件 |
| 3 | 事件**重复派发 ×2** | `inject` 垫片调 `emitInjection` 后又调一次 `onGuardInject` | 派发统一归 `emitInjection` |
| 4 | 有文本路径**漏派发事件** | 修 3 后暴露：非空路径原先靠垫片补 | 两条路径都派发 |

- **Step 2 未做**（主循环改调 `runOnce`）：**与计划 Task 4 自相矛盾** —— Task 4 勘察已证明
  afterStream 的 6 守卫分布在三个不相邻的宿主时机，中间夹着工具执行与内存写入 ⇒
  单个 `runOnce(state, ctx)` **无法**覆盖真实主循环（除非把工具执行/重试/压缩一起搬进
  loop-core，那是 Task 6 的范围）。**需先改计划再动手**。

### Task 6 ⚠️ lane 接线（下一步入口）

**目标**：lane 段（engine `:1590-1917`）复用 `LANE_PROFILE` 驱动的同一套守卫体（A2 的实质）。

**现状**：lane 仍是**完全内联**实现（自带 iterHead/inStream/afterStream 三组守卫副本），
`LANE_PROFILE` 定义了却**未被 engine 使用**。已知 drift 前科：lane 的 `REPEAT_HEAL_MAX`
判据曾与主循环漂移（已在 `:1781-1783` 注释登记）。

**建议路径**（与 Task 4 同型，逐站点接）：
1. 先 grep 出 lane 段内联守卫的**全部落点行号**，做"落点分布勘察"（判据见下方坑 3）
2. 按站点逐个替换为 `runIterHeadGuards` / `runInStreamGuards` / `runAfterStreamGuards`
   —— 关键是**传 `profile: LANE_PROFILE`**（否则 lane 与 main 无法差异化配置）
3. 每接一个站点跑一次 lane 相关测试 + spawn 端到端
4. 收尾：加一条断言"engine 不得再内联 lane 的守卫命中登记"（同 Task 3/4 的接线断言）

**注意**：lane 的 `emitInjection` 需接 lane 自己的宿主实现（注入要落到 lane 的 memory/transcript，
不是主会话）——`ctx.pushInjection` 指向 lane 的落库路径。

#### ★ lane 落点勘察（已做，省下一步的开场成本）

lane 段行号（`kernel/engine.mjs`，勘察时 2502 行基线，**已含 Task 4 改动，行号会继续漂**）：

| 相位 | 守卫 | 落点 | lane 特有语义 |
|---|---|---|---|
| iterHead | `wallClock` | `:1600` | `guardStop(stopNotice('运行超时', …))` |
| iterHead | `stall` | `:1604-1613` | 用 `subLastProgressAt`（**不是** `lastProgressAt`） |
| iterHead | `iterCap` | `:1624` | `guardStop(stopNotice('达到迭代上限', …))` |
| inStream | `streamWallClock` | `:1677` | 把 `textBuf.trim()` **拼在** stopNotice 前（与主循环不同） |
| inStream | `genRepeat`/`nearRepeat` | `:1763` | 统一走 `subStop.reason` 二分文案 |
| afterStream(onError) | `upstreamDead` | `:1711-1725` | 三条分支（含"流内已产出"形态） |
| afterStream(onError) | `idleWatchdog` | `:1743` | — |
| afterStream(postTools) | `meltdown` | `:1865-1880` | `meltdownNotice` |
| afterStream(postTools) | `repeatReminder` | `:1891` 附近 | `repeatRemindText` |

★★ **lane 的控制流惯例与主循环根本不同**：lane 用 `return guardStop(...)`（直接**返回**一个
stop 对象结束本 lane），而主循环用 `break`/`continue` + `loopStop` 变量。⇒ **不能机械照搬
Task 2/3/4 的接线方式**。两条可选路径：
- **A（保守，推荐）**：给 `loop-core` 的相位入口加一个 `stopShape: 'return'` 适配，
  lane 侧把 `return guardStop(x)` 改为 `const r = await runXxx(...); if (r?.stop) return guardStop(adapt(r))`
- **B（激进）**：让 lane 也改造成 `loopStop` + break/continue 惯例（统一两处控制流，
  但 lane 的 `guardStop` 还承担"拼 textBuf""lane 结束事件"等副作用，改造面大）

★ lane 还有**独立的宿主副作用**要保住：`guardStop` 内部会发 lane 结束事件、`subStop.detail`
文案、`streamProduced` 判定 —— 这些不属于守卫体（守卫只判定），**留在 lane 宿主**。
★ 建议**逐相位接**（iterHead → inStream → afterStream），每步全绿再下一步，
不要一次接完（lane 的 `engine-guard-*` 与 lane 专属测试都要每步跑）。

### Task 7 注入总线

把散在各处的注入收敛到 `emitInjection`（唯一出口）。Task 4 已把守卫类注入全部收敛；
剩余的是非守卫注入（如 workspace/知识注入）——需先 grep 出 `pushMemory({ role: 'user'` 的全部落点。

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

9. **★ 等价锁能抓出守卫族测试抓不到的 bug**：Task 4 的 afterstream 锁一次抓出 **4 个真 bug**
   （跨站点误触发 / 空 user 消息 / 事件重复派发 / 有文本路径漏派发）—— 它们都逃过了
   Task 2/3 的 `engine-guard-*` 测试，因为那些守卫**不发事件、不传空文本**。
   ⇒ **每搬移一个相位就配一把等价锁**，不是形式主义。三个具体教训：
   ① timing 粒度必须细到**每个调用站点**，不能到"每个 catch 块"（否则缺字段的守卫
   在别的站点被判为"条件成立"）；② **空文本注入必须拦下**（否则落一条空 user 消息）；
   ③ **事件派发只能有一个派发点**（垫片里"顺手再补一刀" = 双重派发）。
10. **★ 测试基线不能用 HEAD，要用固定 SHA**：Task 3 的等价锁以 `HEAD:kernel/engine.mjs` 为基线，
   搬移一入库 HEAD 前移 ⇒ 自检假红（"基线应含某文案"失败）。固定 SHA 才真正表达"与搬移前逐字一致"。
11. **★ 新增测试文件必须当场 `git add`**：Task 2 的 `loop-guard-order-equivalence.test.mjs`
   + 2 个 fixture + 录制脚本从未入库 ⇒ 锚点计数与实际不符，`doc-anchors-reproducible` 红。
   ★ 该用例只在**干净检出**（仅已跟踪文件）里暴露 ⇒ 单跑工作树看不出来。

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
