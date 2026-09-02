# Ponos 模块化平台 · P2 状态服务 Implementation Plan（大纲级）

> **For agentic workers:** 执行前先用 writing-plans 将本大纲细化为步骤级 TDD 计划（见文末「启动时需细化的内容」）。Steps use checkbox（`- [ ]`）语法。

**Goal:** 建立 node-worker 运行时，state-manager 服务模块提供全局状态 get/set/subscribe + 事件广播，迁移 settings/files 全局状态到 state-manager，移除渲染层全局 Zustand store，统一窗口壳标题栏。

**Architecture:** worker-transport 适配器 + worker_threads 进程类型；state-manager 是总线上的第一个服务模块（node-worker）；渲染层 store 仅保留纯视图态（草稿/滚动），全局业务状态全部走 RPC。

**Spec:** `docs/superpowers/specs/2026-09-02-ponos-modular-platform-design.md` §5（node-worker 运行时）、§7（状态即服务）、§9（窗口壳）

## 依赖与前置

- P1 产物：message-router（attach/broadcast/sendTo）、process-orchestrator、ipc-transport、`harness/src/main.cjs` buildApp 装配、`modules/`（launcher/chat）

## 启动时需细化的内容（基于 P1 实际代码）

1. `message-router.cjs` 实际 attach/broadcast/sendTo 签名（P1 已定义，确认无微调）
2. `process-orchestrator.cjs` 实际结构——node-worker/cli-bridge 进程类型如何扩展（读 P1 后实现）
3. `main.cjs` buildApp 的模块注册模式——服务模块如何 attach（读 P1 实际装配）
4. `src/stores/` 全部 zustand store 清单与全局状态字段（逐一盘点，列出「迁出到 state-manager」/「保留视图态」分类表）
5. `modules/settings`、`modules/files` 模块 UI 与状态读取点（若 P1 后已建）

## 任务清单

1. **worker-transport 适配器**：worker_threads postMessage ↔ envelope；与 ipc-transport 同构接口 `{ send, onMessage, close }`
2. **orchestrator 支持 node-worker 运行时**：runtime:'node-worker' 进程创建、崩溃重启、断开清理（沿用 P1 render-process-gone 模式）
3. **state-manager 模块**（node-worker）：`state.get/set/subscribe` + 快照环形缓冲 + 持久化（沿用现有 classic-level 或 better-sqlite3，执行时定）
4. **event:state.changed 广播**：状态变化经 message-router.broadcast 推送，订阅模块 UI 自动响应
5. **settings 模块迁移**：读取经 `state.get`、变更经 `state.set` + 广播刷新
6. **files 模块迁移**：同上
7. **渲染层 Zustand 清理**：移除全局业务状态 store，仅保留视图态（草稿/滚动/折叠）
8. **窗口壳统一标题栏**：模块图标 + 名称 + 最小化/最大化/关闭 + 会话上下文下拉（替换 P1 页内标题）

## 接口契约（固化，跨阶段依赖此签名）

- state-manager 提供：
  - `state.get(key)` → `{ ok, value }`
  - `state.set(key, value)` → `{ ok, version }`
  - `state.subscribe(key)` → 注册订阅（模块 UI 用）
  - 事件：`event:state.changed` → `{ key, value, version, from }`
- worker-transport 与 ipc-transport 同构：`{ send, onMessage, close }`
- 会话上下文：模块窗口参数 `params.conversation`（现有 keyOf 约定延续）

## 验收标准

1. 两个窗口对同一 key 读写结果一致，变更实时同步
2. settings 变更广播到所有订阅窗口
3. 全局业务状态不再存于渲染层 store（仅视图态）
4. node-worker 崩溃自动重启且持久化状态不丢

## 测试策略

- worker-transport 契约测试（fake worker 伪对象，沿用 fakeWin/fakeTarget 模式）
- state-manager 状态机/持久化测试
- 双窗口状态同步 e2e 冒烟
