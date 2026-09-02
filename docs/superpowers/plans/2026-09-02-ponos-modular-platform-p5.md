# Ponos 模块化平台 · P5 生态 Implementation Plan（大纲级）

> **For agentic workers:** 执行前先用 writing-plans 将本大纲细化为步骤级 TDD 计划（见文末「启动时需细化的内容」）。Steps use checkbox（`- [ ]`）语法。

**Goal:** 外部模块扫描加载 + external-sdk/js-sdk + YFWorking 业务以标准模块形式回归（approval/question/经验沉淀等，按需）+ 驾驶舱拓扑卡 + 接入文档。

**Architecture:** `user-data/modules/` 外部模块扫描（manifest v2.0 完整校验 + 依赖解析 + 缺失依赖提示）；js-sdk 封装 `window.ponosRpc` 为装饰器库并配模块脚手架模板；回归业务全部实现为标准模块（平权，无特殊地位）；驾驶舱订阅 state-manager 的 Connection Graph 渲染拓扑卡。

**Spec:** `docs/superpowers/specs/2026-09-02-ponos-modular-platform-design.md` §2.3（模块发现）、§5.1（驾驶舱）、§10 Phase 5、§14 验收标准

## 依赖与前置

- P1-P4 产物（manifest v2.0、message-router、state-manager、意图总线、窗口壳）
- 待回归业务组件源码（`src/components/module/windows/` 下 approval/question/panel 等 + 相关 store）

## 启动时需细化的内容（基于 P1-P4 实际代码 + 业务决策）

1. **待回归业务清单与优先级**：与用户确认哪些 YFWorking 业务先回归（候选：审批 approval / 提问卡片 question / 经验沉淀 experience / 面板 panel），每个组件的模块化方案（runtime 选择、依赖接口）
2. 原业务组件对 bridge/IPC/state 的依赖点（读 `src/components/module/windows/*` 与对应 store，列出迁移清单）
3. `user-data/modules/` 目录约定与安装方式（手动拷贝？市场下载？——P5 先手动拷贝 + 目录扫描）
4. 拓扑卡数据源就绪度（state-manager 的 Connection Graph 在 P4 色钥实现后的状态）
5. js-sdk 包形式（`external-sdk/js-sdk` 独立包 + 文档示例）

## 任务清单

1. **外部模块扫描加载**：`user-data/modules/*/module.json` 扫描 + manifest v2.0 完整校验 + 依赖（consumes）解析 + 缺失依赖 UI 提示
2. **external-sdk/js-sdk**：RPC 调用装饰器（`rpc({ base }) → { call, notify, on, discover }`）+ 模块脚手架模板（`create-ponos-module`）
3. **业务模块回归 A**：审批模块（approval，ui-renderer，复用原审批组件）
4. **业务模块回归 B**：提问卡片模块（question，ui-renderer）
5. **业务模块回归 C**：经验沉淀模块（experience，ui-renderer 或 cli-bridge，按依赖定）
6. **驾驶舱模块 + 拓扑卡**：气泡聚合图（会话中心球 + 模块卫星球 + 粒子流，毛玻璃风格），订阅 `event:graph.updated`
7. **文档**：接入指南 + 模块开发指南（README + `modules/README.md` + 示例模块 walkthrough）

## 接口契约（固化，跨阶段依赖此签名）

- 外部模块扫描：`user-data/modules/<id>/module.json`（manifest v2.0 完整校验，字段见 spec §6）
- js-sdk：`rpc({ base })` → `{ call, notify, on, discover }`；模块脚手架生成 `module.json` + 入口 + README
- Connection Graph（spec「交互设计细节」第四部分）：state-manager 维护 `sessions`（含 colorHex/activeModules）与 `links`（source/target/sessionId/status/lastActive）；事件 `event:graph.updated`
- 驾驶舱：订阅 `widget.getDashboardCards` 返回 `{ title, previewHtml, onClickAction }`（spec §5.1）

## 验收标准

1. 第三方模块可安装（放入 user-data/modules）→ 扫描加载 → 与其他模块 RPC 互通
2. 回归业务（approval/question/experience）功能完整可用，以标准模块形式存在于 `modules/`（不在 harness 内核代码中）
3. 驾驶舱拓扑卡展示会话 ↔ 模块连接与工作/空闲状态
4. 模块开发指南文档齐备，可据此写出第三方模块
5. 全量 `node --test` 通过（含回归业务的模块测试）

## 测试策略

- 扫描加载器测试（manifest 校验/依赖解析/缺失提示）
- js-sdk 契约测试（call/notify/on 封装）
- 回归业务模块单测 + e2e 冒烟
- 拓扑卡数据聚合纯函数测试
