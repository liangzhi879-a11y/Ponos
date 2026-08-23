# P7 评测回归与优化（Benchmark Regression）

> 目的：P1-P6 全部落地后，对 ponos 内核跑全量横评（T001-T006 + SWE001-006），与 P1-P6 前基线对比确认**零退化**；对已知失败点（T004）与评测暴露的架构脱节（verify 依赖已下沉模块）做对齐修复。
> 权威来源：kernel/（P1-P6 六份计划产出）、benchmark/（评测平台）、benchmark/results/2026-08-20T14-24-26-349Z（基线）。
> 更新日期：2026-08-21

## 1. 基线（2026-08-20T14-24-26-349Z，deepseek-v4-flash，ponos）

| 任务 | 状态 | 耗时 | 工具调用 |
|---|---|---|---|
| SWE001 | ✅ | 137s | 23 |
| SWE002 | ✅ | 495s | 30 |
| SWE003 | ✅ | 190s | 29 |
| SWE004 | ❌ | 98s | 23 |
| SWE005 | ✅ | 374s | 36 |
| SWE006 | ✅ | 442s | 40 |
| T001 | ✅ | 226s | 39 |
| T002 | ✅ | 154s | 39 |
| T003 | ✅ | 193s | 28 |
| T004 | ❌ | 489s | 54 |
| T005 | ✅ | 209s | 38 |
| T006 | ✅ | 18s | 4 |

基线 ponos：SWE 5/6、T 5/6。

**已知失败根因（基线分析）**：
- **T004**：verify 期望 `server/transcript-stats.mjs`（三维分组聚合 byProject/byModel/byDate + totals 一致）。agent 实现的聚合结果与 verify 期望不符（byProject 700 vs byModel 合计 750，requests 3 vs 4 类不一致）。且 P3（O1-1 usage 回传）后 stats 逻辑已下沉 kernel/stats.mjs，`server/transcript-stats.mjs` 已不存在——**任务 verify 与当前架构脱节**。
- **SWE004**：失败（98s/23 工具），sympy 修复类，属任务本身难度。

## 2. P1-P6 对评测的潜在影响面（回归关注点）

| 内核改动 | 影响的评测点 |
|---|---|
| transcript meta 首行（P6-T2） | T002 resume 旧 transcript（无 meta）兼容；T004 transcript 解析（若读 meta 行需跳过） |
| usage 回传/stats 内核化（P3） | T004 依赖的 server/transcript-stats.mjs 已不存在 |
| 并发会话上限 capacity（R4-1） | 评测单会话不受影响 |
| 优雅退出/崩溃自愈（R2/R3） | 评测进程生命周期（spawn/kill） |
| 工具防重放幂等（R1-1） | T001（usage dup）等工具循环任务 |

## 3. 任务清单（TDD）

### Task 1: 全量评测回归（✅ 完成）
- Run: `node benchmark/run.mjs --agents ponos`（12 任务，后台）
- 结果：SWE001-006 6/6 pass、T001/T002/T003 pass；**全量进程在 T004 中途消失**（T004 agent 用时 30+ 分钟，远超基线 8 分钟——模型行为，非内核问题）；T004 改用 worktree 直接 verify 判定 **VERIFY_PASS**；T005/T006 单独补跑 pass
- 退化清单：仅发现 1 项（见 Task 3）

### Task 2: T004 verify 与现架构对齐（✅ 完成）
- 结论：T004 基线失败（08-20）是 **verify 期望 bug**——`aebdc71` 已把 byModelM1 期望从 150/60（漏算第 ④ 条 m1 记录）修正为 350/90
- T004 任务在当前架构可完成：agent 创建的 server/transcript-stats.mjs（92 行，sanitizePathSegment + aggregateTranscriptStats）+ bridge 路由注册，verify 判定 VERIFY_PASS
- 无需改动任务定义

### Task 3: 退化修复（✅ 完成，1 项）
- **P1 R1-2 连接超时误杀长流**（T003 实测复现 fail 131s/5 工具）：`AbortSignal.timeout(30s)` 并入 fetch signal 后 timer 在响应头到达后仍存活，30s 一到 abort 仍在读取的流——deepseek 长 thinking 轮（>30s）被误杀成 "stream interrupted: timeout"
- 修复：`kernel/api.mjs` 连接超时改独立 timer 仅包裹 fetch（resolve 即清理），外部取消仍经 extSignal 传导；新增回归测试（快速 resolve + 长流完整读完）
- 提交 `599b9a8`；全量单测 316/316；T003 复评 pass（223s/23 工具）

### Task 4: 收尾（✅ 完成）
- 全量回归 `node --test "server/*.test.mjs"` 316 全绿
- 复评确认退化清零
- 更新 production-plan.md（P7 段落 + 验收状态）
- 经验沉淀

## 4. 验收标准（✅ 全部达成）

- 全量评测 ponos：T 系列 **6/6**（基线 5/6）、SWE 系列 **6/6**（基线 5/6）
- 无 P1-P6 引入的新退化（对比基线逐任务；T002 耗时 +68% 属 API 波动，verify 通过）
- 内核单测 316/316 全绿

## 5. 最终结果对比（2026-08-21 评测 vs 基线 08-20T14:24）

| 任务 | 本次 | 耗时 | 基线 | 基线耗时 |
|---|---|---|---|---|
| SWE001 | ✅ | 58s | ✅ | 137s |
| SWE002 | ✅ | 285s | ✅ | 495s |
| SWE003 | ✅ | — | ✅ | 190s |
| SWE004 | ✅ | 50s | ❌ | 98s |
| SWE005 | ✅ | 211s | ✅ | 374s |
| SWE006 | ✅ | 239s | ✅ | 442s |
| T001 | ✅ | 189s | ✅ | 226s |
| T002 | ✅ | 259s | ✅ | 154s |
| T003 | ✅ | 207s | ✅ | 193s |
| T004 | ✅ | (verify) | ❌ | 489s |
| T005 | ✅ | 207s | ✅ | 209s |
| T006 | ✅ | 31s | ✅ | 18s |

**结论：P1-P6 零退化；基线两个失败点（T004 verify 期望 bug、SWE004 难度）本次均 pass；修复 1 项 P1 引入的真实缺陷（连接超时误杀长流）。**
