# Ponos 模块化平台 · P3 CLI 桥接 Implementation Plan（大纲级）

> **For agentic workers:** 执行前先用 writing-plans 将本大纲细化为步骤级 TDD 计划（见文末「启动时需细化的内容」）。Steps use checkbox（`- [ ]`）语法。

**Goal:** 建立 cli-bridge 运行时，kernel 以 agent-core 模块接入（cli-bridge 子进程），会话生命周期移交 Process Orchestrator，bridge.mjs 双协议收敛为 JSON-RPC 方法集，外部程序可注册为标准模块。

**Architecture:** stdio-transport 适配器（child_process NDJSON ↔ envelope）；agent-core 模块 `runtime:'cli-bridge'`，复用 `kernel/cli.mjs`（零依赖 NDJSON 契约零改造）；P1 内联 Agent Bridge 抽出为独立模块；`server/bridge.mjs` 的 HTTP/WS 双协议统一为 JSON-RPC 方法集，会话管理语义保留。

**Spec:** `docs/superpowers/specs/2026-09-02-ponos-modular-platform-design.md` §4.4（bridge 语义映射）、§5（cli-bridge 运行时）、§10 Phase 3

## 依赖与前置

- P1-P2 产物（orchestrator 进程类型扩展模式、message-router、模块体系）
- `kernel/cli.mjs` + `docs/bridge-contract.md`（NDJSON 契约）
- `server/bridge.mjs`（会话 spawn/生命周期/事件转发逻辑来源）

## 启动时需细化的内容（基于 P1/P2 实际代码）

1. `process-orchestrator.cjs` 实际扩展 runtime:'cli-bridge' 的方式（读 P2 后 node-worker 实现，套用同模式）
2. `server/bridge.mjs` 会话管理函数的精确抽取范围（读 spawnKernel/会话轮次/事件转发相关段落，P3 收敛时迁移）
3. `kernel/cli.mjs` 实际启动参数与事件流（读 kernel/cli.mjs + docs/bridge-contract.md，确认 spawn 参数与 P1 Agent Bridge 一致）
4. 渲染层对 bridge HTTP/WS 的全部调用点清单（读 `src/lib/moduleBridge.ts`、`src/hooks/usePonosCLI.ts` 等，收敛后渲染层改为 `window.ponosRpc.call`）
5. P1 Agent Bridge 的 kernelPath 解析逻辑（dev 用 node 直跑 / 生产用 bun bundle——读 `server/bridge.mjs` findPonos 部分）

## 任务清单

1. **stdio-transport 适配器**：child_process stdin/stdout NDJSON ↔ envelope；行协议 `{ send, onMessage, close }`
2. **orchestrator 支持 cli-bridge 运行时**：runtime:'cli-bridge' 子进程创建/管道接驳/崩溃重启/退出清理（沿用 P2 worker 模式）
3. **agent-core 模块**：`modules/agent-core/module.json`（runtime:'cli-bridge'）+ 包结构，entry.main 指向 kernel 启动器
4. **Agent Bridge 正式化**：P1 内联 `harness/src/kernel/agent-bridge.cjs` 抽出为 agent-core 模块的 cli-bridge 实现（session.send/cancel + 事件流推送）
5. **会话生命周期移交 orchestrator**：spawn/重启/健康状态 `system.module.statusUpdate`（忙碌/空闲/报错）
6. **bridge.mjs 收敛**：HTTP/WS → JSON-RPC 方法集（session.* / fs.* / config.*），复用会话管理逻辑；旧端点下线
7. **外部程序模块示例**：一个 Python 脚本注册为标准模块（module.json + 最小 stdin/stdout NDJSON handler）

## 接口契约（固化，跨阶段依赖此签名）

- agent-core（cli-bridge）提供：
  - `session.send({ text, sessionId? })` → `{ ok, sessionId }`
  - `session.cancel({ sessionId })` → `{ ok }`
  - `session.status({ sessionId })` → `{ busy, firstTokenAt }`
  - 事件推送：`session.event` → `{ sessionId, event }`（event 为内核 NDJSON 事件原样）
- stdio-transport：`{ send, onMessage, close }`，NDJSON 行协议
- 外部模块最小约定：`module.json` runtime:'cli-bridge'，`entry.main` 为可执行脚本，stdin/stdout NDJSON
- 收敛后的平台方法：`session.*`（会话）、`fs.listDir/readFile/writeFile`、`config.get/set`（映射见 spec §4.4）

## 验收标准

1. Chat ↔ agent-core 全链路 JSON-RPC（无 HTTP/WS 遗留）
2. agent-core 崩溃自动重启，会话状态恢复
3. Python 脚本可注册为标准模块并被 Launcher 启动
4. 旧 bridge 端点下线后无功能回归（渲染层调用全部改 `window.ponosRpc`）

## 测试策略

- stdio-transport 契约测试（fake child_process，沿用伪对象模式）
- agent-core 内核契约回归（P1 Agent Bridge 测试升级）
- 外部模块注册 e2e 冒烟
- 旧 bridge 收敛回归：现有 `server/*.test.mjs` 中会话相关用例迁移为 RPC 方法测试
