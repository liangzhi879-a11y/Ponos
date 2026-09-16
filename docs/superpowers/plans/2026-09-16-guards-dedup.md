# P1-6 消除双份守卫 实施计划

- spec：`docs/superpowers/specs/2026-09-16-guards-dedup-design.md`
- 新增：`kernel/guards.mjs`（已建）、`kernel-tests/guards.test.mjs`
- 改动：`kernel/engine.mjs`（import + 两处调用点改为复用）

## 步骤

### S1 提取共享模块（已完成）
`kernel/guards.mjs` 纯函数 7 个：`isRealProgress` / `allToolResultsFailed` / `nextHadToolError` /
`shouldRemindRepeat` / `repeatRemindText` / `errorMeltdownText` / `hasMeltdownBudget`。
**验证**：`node --check kernel/guards.mjs` ✓

### S2 engine.mjs 两处改为复用（已完成）
- 主循环 6 处：R3-2 `hadToolError`、守卫④ `allFailed`+预算+文案、守卫⑤ 阈值+文案、守卫⑥ `madeProgress`
- lane 4 处：R3-2、守卫④ 预算+文案(`'lane'`)、守卫⑤ 阈值+文案、守卫⑥ `laneProgress`
- **保持不动**：状态推进（`streak++`）、副作用（`pushMemory`/`session.appendUser`/`store.appendUser`/`wire.system`）、常量真相源
**验证**：`node --check kernel/engine.mjs` ✓ + 内联守卫特征串 grep 0 命中

### S3 守卫安全网回归（已完成）
`engine-guard-heal*` / `engine-guard-idle*` / `engine-guard-stall` / `engine-guard-deadstream` /
`engine-lane-heal` / `loop-stall-guard` / `budget-guard`。
**验证**：22/22 pass（零回归）

### S4 guards.mjs 直接单测（本轮做）
`kernel-tests/guards.test.mjs`：
- 7 个函数的正常路径 + **边界**（空数组、`max<0` 不限次、`heals>=max` 用尽、`reminded` 防重复、阈值非数组）
- **文案等价性**：`repeatRemindText` 输出必须与改前内联模板**逐字一致**；`errorMeltdownText('main')` 含 `stderr` 与「向用户说明」、`('lane')` 含「输出阻塞说明」且不含 `stderr`
- **防再重复**：读 `engine.mjs` 源码，断言内联守卫特征串（`【提示】你已连续 `、`【系统】检测到连续多轮工具调用全部失败。`）**不再出现**——否则债务会悄悄回来
**验证**：`node --test kernel-tests/guards.test.mjs` 绿

### S5 守门演练（反证）
破坏 `guards.mjs` 判据（如 `hasMeltdownBudget` 恒 `false`）→ 单测应红 → 恢复回绿 + grep 无残留。
另外把 `engine.mjs` 临时改回内联文案 → 「防再重复」断言应红。

### S6 全量门禁
`npm run typecheck`、`kernel-tests/*.test.mjs`、`src/**/*.test.ts`、`server/*.test.mjs`。

### S7 同步调试版 + 清单 + 经验
- 同步 `kernel/guards.mjs` + `kernel/engine.mjs` 到 `release/YFWorking/kernel/`，md5 核对 + `diff -rq`
- 更新 `docs/待处理清单.md`：P1-6 **子项「消除双份守卫」完成**，**子项「拆 `engine.mjs` 文件」未做**（诚实标注）；条目仍不勾选（P1-5 未做）
- 经验沉淀到 `workflow.md`
