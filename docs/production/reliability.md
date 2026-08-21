# 子项目：可靠性（P1）—— production-plan Phase 1 细化

> 所属总纲：docs/production-plan.md §4 Phase 1
> 场景定位：个人重度 + 团队协作（多会话并发、API 抖动、进程崩溃恢复）
> 更新日期：2026-08-21

---

## 1. 场景与压力

| 压力 | 量化基线 | 说明 |
|---|---|---|
| 多会话并发 | 同时 5~20 个会话 | 个人重度可开 5+，团队共享机器 20 上限 |
| 长会话轮次 | 单会话 200~500 轮 | 单轮 API 调用 + 工具往返数百次 |
| API 不稳定 | 断流/超时/5xx 占比 ≥1% | 生产网络抖动是常态 |
| 进程生命周期 | 随用随启、随时关 | 用户切会话/关窗口/系统睡眠 |

当前架构：bridge 每会话 spawn 一个内核进程（stream-json 模式）。可靠性压力集中在**进程生命周期与 API 流**两个面。

## 2. 现状（已有能力映射）

| 能力 | 现状位置 | 覆盖程度 |
|---|---|---|
| 重试退避 | kernel/engine.mjs P0-1 指数退避 + 25% jitter（对照 pi） | ✅ 已有 |
| 流式空闲超时 | CLAUDE_CODE_STREAM_IDLE_TIMEOUT_MS / TOOL_TIMEOUT_MS | ⚠️ 超时兜底，无恢复 |
| 工具结果预算 | CLAUDE_CODE_TOOL_RESULT_BUDGET_BYTES（落盘 + 预览） | ✅ 已有 |
| 会话持久化 | kernel/session.mjs JSONL + --resume | ✅ 已有 |
| 优雅退出 | cli stdin EOF → exit 0；SIGINT/SIGTERM 处理 | ⚠️ 不完整 |
| 崩溃自愈 | 无 | ❌ 缺失 |
| 结构化日志 | electron/log-tee.cjs（GUI 侧） | ⚠️ 内核侧无分级日志 |
| 多进程资源治理 | 每会话一进程，无上限/回收策略 | ❌ 缺失 |

## 3. 目标与验收标准

| # | 目标 | 验收标准（可测） |
|---|---|---|
| R1 | API 断流可恢复 | mock 注入流中断 → 自动重连 ≤3 次退避，会话不丢，任务续跑 |
| R2 | 进程可优雅退出 | SIGINT/SIGTERM → flush session + 杀子进程 + 状态标记；重启 `--resume` 完整恢复 |
| R3 | 崩溃可自愈 | 模拟崩溃后启动：检测上次未正常退出 → 提示恢复/清理，transcript 不损坏 |
| R4 | 多会话资源可控 | 并发 N 会话有上限策略（默认 10），超限排队/提示；单会话内存有水位监控 |
| R5 | 日志可诊断 | 内核全链路结构化日志（级别/时间戳/会话 id），错误可回看定位 |

## 4. 任务清单（按依赖排序）

**P0（上线底线）**
- [ ] R1-1 api.mjs 流式中断重连：读循环内捕获断流 → 指数退避（1s/2s/4s，≤3 次）重发请求；会话消息已落盘可重放，无重复副作用（幂等工具：Read/Glob/Grep 天然幂等，Write/Edit 需记录已执行 tool_use id 防重放）
- [ ] R2-1 优雅退出：SIGINT/SIGTERM handler → flush 内存 buffer 到 session → 终止子进程（Bash/OCR spawn 的子进程树）→ exit 0
- [ ] R3-1 崩溃检测：session 元数据记 `lastExit: 'clean'|'crash'`；启动时 crash 且存在未完成 turn → 提示恢复/清理

**P1（规模化）**
- [ ] R4-1 bridge 并发治理：会话数上限 + 排队提示（GUI 侧提示"已达并发上限"）；空闲会话超时回收（可配置，默认 30min）
- [ ] R5-1 内核结构化日志：addLog(level/ts/sid) 全链路；错误统一分级（fatal/error/warn/info/debug）
- [ ] R1-2 超时分级：连接超时 / 首字节超时 / 流空闲超时，分别处理（重连 vs 报错）

**P2（增强）**
- [ ] R4-2 单进程多会话（可选调研）：同进程多 engine 实例共享模型连接池，降内存——风险高，作为 P2 探索项
- [ ] R5-2 日志轮转与采样：transcript 目录大小治理（保留策略：默认 500MB / 90 天）

## 5. 前端集成点

| 前端能力 | 落点 |
|---|---|
| health/diag 面板（src/components/healthUi.ts、diagnostic） | 展示 R4 会话数/内存水位、R5 最近错误 |
| 会话历史（history 面板 + /transcript/*） | 崩溃恢复入口（resume 上次会话） |
| settingsStore 新增项 | concurrentSessions、idleRecycleMinutes、logLevel |

## 6. 验证方式

- 单元：mock API 注入断流（server/api-protocol.test.mjs 扩展）；session flush 幂等测试
- 端到端：杀进程（SIGKILL）→ `--resume` 恢复验证；并发 10 会话冒烟（benchmark 扩展）
- 评测：T001-T006 全量回归确认可靠性改动无性能/正确性退化
