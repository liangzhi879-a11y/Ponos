# Ponos 模块化平台 · P4 意图总线 Implementation Plan（大纲级）

> **For agentic workers:** 执行前先用 writing-plans 将本大纲细化为步骤级 TDD 计划（见文末「启动时需细化的内容」）。Steps use checkbox（`- [ ]`）语法。

**Goal:** broadcast 意图路由正式化，Chat 硬编码工具调用改为发布意图事件，命令面板 Ctrl+Shift+P，窗口连接视觉精化（会话色钥 + 边框流光/呼吸光晕）。

**Architecture:** 在 message-router 的 broadcast 基础上建立意图订阅表与事件匹配；Chat 弱耦合输入（`system.intent.broadcast`），模块订阅后弹窗确认接管；命令面板由 harness 统一渲染，聚合各模块 `command.suggest`；连接视觉基于 link-registry 数据（会话色钥由 state-manager 维护）。

**Spec:** `docs/superpowers/specs/2026-09-02-ponos-modular-platform-design.md` §5.2（意图总线）、§5.4（命令面板）、§9（交互体系）、「交互设计细节」第一~三部分

## 依赖与前置

- P1-P3 产物（message-router.broadcast 雏形、Chat 模块、state-manager）
- `electron/link-registry.cjs`（连接图数据，P1 迁移后确认位置）

## 启动时需细化的内容（基于 P1-P3 实际代码）

1. `message-router.cjs` 实际 broadcast 实现——意图语义如何映射（读 P1 后实际代码）
2. Chat 模块当前全部工具调用点清单（读 P1 后 `modules/chat` 实际代码 + 原 `src/` 工具调用参考），确定哪些转为意图发布
3. 窗口壳渲染方式（frame:false + 页内标题 vs 独立壳窗口）——决定色钥/流光的实现位置（读 P1/P2 实际窗口壳）
4. 会话概念当前实现（params.conversation）与色钥分配点（在 orchestrator 或 state-manager 何处分配）
5. 命令面板触发键与现有全局快捷键冲突排查（Electron Menu/globalShortcut 现状）

## 任务清单

1. **意图路由正式化**：意图订阅表 + 事件匹配 + 接管确认弹窗（`system.intent.broadcast` → 订阅模块 `module.intent.takeOver/decline`）
2. **Chat 模块重构**：`/命令` 与硬编码工具调用 → 发布 `user.intent`，模块订阅响应
3. **示例意图模块**：coding 模块骨架（订阅 coding 意图 + 确认接管 + 执行）
4. **命令面板**：全局 `Ctrl+Shift+P` 唤起 + 向模块请求 `command.suggest` 补全 + 执行权转交
5. **会话色钥**：新会话分配主题色 + 关联窗口标题栏色带同步染色
6. **连接视觉精化**：窗口边框流光/呼吸光晕 + 悬停徽章闪烁（升级 link-registry 数据消费）

## 接口契约（固化，跨阶段依赖此签名）

- 意图事件：`system.intent.broadcast` → `{ type, query, sessionId, from }`（spec §5.2）
- 模块响应：`module.intent.takeOver({ intentId })` / `module.intent.decline({ intentId })`
- 命令补全：`command.suggest` → `[{ command, description, moduleId }]`；执行：`command.execute({ command, args })`
- 会话色钥：`session.colorHex` 由 state-manager 维护（Connection Graph 数据结构见 spec「交互设计细节」第四部分）；事件 `event:graph.updated`

## 验收标准

1. 输入 `/code 写个快排` → 意图发布 → coding 模块弹窗确认接管
2. `Ctrl+Shift+P` 唤起命令面板，可补全并执行模块命令
3. 多会话窗口色钥一眼可辨，关联窗口同步染色（切换会话标题联动）
4. 连接窗口边框流光随数据流状态变化（工作时快速脉冲、空闲缓慢呼吸）

## 测试策略

- 意图路由状态机测试（订阅/匹配/超时/接管）
- Chat 意图发布逻辑测试（纯函数：命令解析 → 意图事件）
- command.suggest 聚合测试
- 视觉逻辑可测部分（色钥分配、边框状态计算）纯函数单测
