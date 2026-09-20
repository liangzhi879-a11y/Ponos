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

- **Task 3**：流内守卫搬移（`streamWallClock` / `genRepeat` / `nearRepeat` / `idleWatchdog` /
  `upstreamDead`）——与 Task 2 同型
- **Task 4**：流后守卫搬移（`repeatHeal` / `errorMeltdown` + `stall` 的进展刷新）
- **Task 5–7**：lane 接线 / `runOnce` 真实编排 / 注入总线

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
