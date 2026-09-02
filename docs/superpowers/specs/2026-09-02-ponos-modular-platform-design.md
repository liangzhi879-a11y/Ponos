# Ponos 模块化平台重构设计（v1）

> 日期：2026-09-02
> 状态：已批准（用户确认）
> 范围：全量重构 + 五阶段完整方案 + 执行路线 A（协议内核先行，模块逐批迁移）

## 1. 背景与目标

### 1.1 背景

Ponos 是一个 Agent 桌面应用（当前 v2.7.0）：React + Vite + Tailwind GUI，Electron 主进程，`server/bridge.mjs` 桥接层，零 npm 依赖的 agent 内核（`kernel/`）。近期已完成了第一轮"模块化多窗口重构"（阶段 A）：ModuleRegistry（内置 10 模块清单 + manifest 解析）、StateBus（channel 订阅/广播/快照）、WindowManager（窗口类型注册表）、DockService、ApprovalCenter、AnchorLayout、LinkRegistry、LinkOverlay。

现状问题：
- `electron/main.cjs`（1959 行）耦合了经验库、打包器、浏览器执行器、模块化窗口、dock、审批、锚点布局、链接注册表等大量职责，主进程"上帝文件"化。
- `server/bridge.mjs`（2544 行）维护 HTTP REST + WebSocket 双协议，路由语义与会话管理纠缠。
- GUI 中约半数组件耦合 YFWorking 业务（审批中心、dock 导航、提问卡片、经验沉淀、豆包 AI、企业咨询工具），通用 Agent 能力与业务能力未分层。
- 模块间通信为 StateBus channel 广播 + IPC 硬编码，无标准化 RPC 协议；无进程级运行时隔离；状态分散在各渲染窗口的本地 Zustand store。

### 1.2 目标

将 Ponos 重构为一个 **Agent 操作系统平台**：

1. **微内核架构**：Electron 主进程收敛为极简 Harness Kernel（进程编排 + 消息路由 + 模块注册 + 权限拦截，目标 <500 行核心逻辑）。
2. **万物皆模块**：所有能力（聊天、文件、设置、技能、浏览器、Agent 内核、状态服务）均为平权模块，通过 `module.json` manifest 声明，无核心/扩展的代码级差异。
3. **协议大于代码**：模块间通信统一走自研 JSON-RPC 2.0 协议，模块间不互相引用 npm 包。
4. **分级运行时隔离**：三种运行时（ui-renderer / node-worker / cli-bridge），模块崩溃不影响 Harness 与其他模块。
5. **状态去中心化**：全局状态由 state-manager 服务模块提供，模块按需订阅，移除渲染层本地长期持有的全局业务状态。
6. **产品独立**：Ponos 是独立产品（非 YFWorking）。清除全部 YFWorking 特有业务；被清除的业务在 Phase 5 以标准模块形式回归。

### 1.3 非目标（本次重构不做）

- 不做分布式（模块跨机器部署）。
- 不做模块市场运营（仅预留扫描加载与依赖提示）。
- 不引入 npm 依赖来替换自研协议层。
- 不重做视觉体系（保留现有 vaporwave 深黑霓虹主题并精化）。

## 2. 设计原则

| 原则 | 含义 |
| :--- | :--- |
| 协议大于代码 | 模块间仅通过 JSON-RPC 2.0 通信，不直接引用对方包 |
| 位置透明 | 调用方不关心模块在 Renderer/Worker/CLI 哪个进程，由 Harness 路由 |
| 崩溃即重启 | 模块崩溃不影响 Harness，Harness 自动重启并恢复最新状态 |
| 状态去中心化 | Harness 无状态，全局状态由 state-manager 服务模块提供 |

## 3. 目标架构

### 3.1 Monorepo 结构（pnpm workspace，在 ponos-dev 内重组）

```
ponos-dev/
├── package.json / pnpm-workspace.yaml   # root workspace
├── harness/                             # 微内核主程序（Electron Main）
│   ├── src/
│   │   ├── kernel/                      # Harness Kernel：进程编排+消息路由+模块注册+权限
│   │   ├── rpc/                         # 自研 JSON-RPC 2.0：envelope/route/transport
│   │   └── preload/                     # 渲染进程标准桥
│   └── package.json
├── modules/                             # 官方模块（平权）
│   ├── launcher/                        # 启动台种子模块 (ui-renderer)
│   ├── chat/                            # 聊天 (ui-renderer)
│   ├── files/                           # 文件 (ui-renderer)
│   ├── settings/                        # 设置 (ui-renderer)
│   ├── skills/                          # 技能 (ui-renderer)
│   ├── browser/                         # 浏览器 (ui-renderer + CDP)
│   ├── cockpit/                         # 驾驶舱 (ui-renderer)
│   ├── state-manager/                   # 状态服务 (node-worker)
│   └── agent-core/                      # Agent 内核 (cli-bridge，复用现有 kernel/)
├── external-sdk/                        # js-sdk（RPC 调用装饰器）
├── kernel/                              # 现有零依赖内核（作为 agent-core 模块源码基座）
├── user-data/                           # 运行时生成（modules/ storage/）
└── scripts/
```

### 3.2 Harness Kernel 四大组件

| 组件 | 职责 | 迁移来源 |
| :--- | :--- | :--- |
| Process Orchestrator | 管理三类进程（BrowserWindow / worker_threads / child_process），崩溃自动重启、生命周期状态机 | `electron/window-manager.cjs` 升级 + 新增长程进程管理 |
| Message Router | Map<method, handler> 路由，支持 x_target 定向与 broadcast | `electron/state-bus.cjs` 广播升级 + 自研 |
| Module Registry | manifest v2.0 解析/依赖解析/加载卸载 | `electron/module-registry.cjs` 升级 |
| Permission Gatekeeper | 按 manifest capabilities/runtimeConfig 拦截越权调用 | 新增 |

### 3.3 进程视图

```
Main Process (Node.js)
├── Harness Kernel
│   ├── Process Orchestrator
│   ├── Message Router
│   ├── Module Registry
│   └── Permission Gatekeeper
├── (IPC)          ├── (worker_threads)    ├── (stdio/WS)
├── Renderer 进程群  ├── Worker 进程群       ├── CLI 子进程群
│   launcher/chat/  │   state-manager       │   agent-core（kernel）
│   files/settings/ │                      │   python / 外部程序
│   skills/browser/ │                      │
│   cockpit         │                      │
```

## 4. 协议层（自研，零 npm 依赖）

### 4.1 Envelope

```typescript
interface Envelope {
  jsonrpc: "2.0";
  id?: string | number;          // 请求 ID（通知可省略）
  method: string;                // 全局唯一方法名，如 "chat.sendMessage"
  params?: any;
  // ---- 扩展路由头（由 Harness 注入）----
  x_sender: string;              // 模块 ID（+实例）
  x_target: string | "broadcast";// 模块 ID 或 broadcast
  x_ttl?: number;                // 防死循环（默认 16）
  x_trace_id?: string;           // 全链路追踪 ID
}
```

### 4.2 传输适配器（统一接口 `{ send, onMessage, close }`）

| 适配器 | 通道 | 用途 |
| :--- | :--- | :--- |
| ipc-transport | Electron ipcRenderer/ipcMain | renderer ↔ main |
| worker-transport | worker_threads postMessage | main ↔ node-worker |
| stdio-transport | child_process stdin/stdout NDJSON | main ↔ cli-bridge 子进程 |

### 4.3 路由与内省

- 方法注册表：`router.register(method, handler, { scope, permissions })`。
- broadcast：`x_target: "broadcast"` 时向所有订阅该意图/通道的模块转发。
- `rpc.discover`：模块启动后向 Harness 上报完整方法清单（含签名），支持按需缓存。
- `rpc.initialize` / `rpc.shutdown`：生命周期握手。

### 4.4 现有 bridge 语义映射

`server/bridge.mjs` 现有能力收敛为 JSON-RPC 方法集（会话管理语义保留，双协议统一）：

| 现有语义 | 新方法 |
| :--- | :--- |
| WS send/cancel/set_effort | session.send / session.cancel / session.setEffort |
| HTTP /list-dir /read-file /write-file | fs.listDir / fs.readFile / fs.writeFile |
| HTTP /providers /settings | config.get / config.set |
| 事件推送（assistant/tool/status） | JSON-RPC notification（method: session.event） |

## 5. 分级运行时

manifest `runtime` 字段声明，Harness 自动分配进程模型：

| 运行时 | 进程类型 | 崩溃后果 | 重启代价 | 适用 |
| :--- | :--- | :--- | :--- | :--- |
| ui-renderer | 独立 BrowserWindow | 该窗口白屏，其他正常 | 毫秒级重绘 | 聊天/文件/设置/驾驶舱 |
| node-worker | worker_threads | 该线程退出，抛错误事件 | 微秒级（内存池保留） | 状态管理、本地检索 |
| cli-bridge | child_process | 子进程退出，管道断开 | 秒级（重新 spawn） | agent-core、外部脚本 |

崩溃自动重启由 Process Orchestrator 负责；重启后经 `rpc.initialize` 恢复并同步最新状态。

## 6. Manifest v2.0

在现有 `module-registry.cjs` 的 `id/name/windowSpec/singleton/channels/permissions` 基础上新增字段，旧字段保持兼容。兼容规则：旧版 `entry` 为字符串（UI 入口路径），新版为 `{ main, ui }` 对象；解析时字符串自动归一化为 `{ ui: entry }`（ui-renderer 运行时），node-worker/cli-bridge 必须使用对象形式：

```json
{
  "id": "com.ponos.chat",
  "name": "聊天",
  "version": "1.0.0",
  "runtime": "ui-renderer",
  "entry": { "main": "./dist/index.js", "ui": "./dist/index.html" },
  "windowSpec": { "width": 900, "height": 700, "resizable": true },
  "interfaces": {
    "provides": [{ "method": "chat.sendMessage", "handler": "handlers.sendMessage" }],
    "consumes": [{ "interface": "agent.inference", "version": "~1.0", "optional": false }]
  },
  "capabilities": ["ui.window.create"],
  "lifecycle": { "init": "bootstrap.init", "destroy": "bootstrap.destroy" },
  "runtimeConfig": { "sandbox": { "allowNetwork": ["localhost:8080"] } }
}
```

依赖（consumes）未满足时阻止激活，UI 提示缺失依赖（Phase 5 接入模块市场跳转）。

## 7. 状态即服务

- **state-manager 模块**（node-worker 运行时）：提供 `state.get(key)` / `state.set(key, value)` / `state.subscribe(key)`；状态变化主动广播 `event:state.changed`，订阅模块 UI 自动响应。
- 现有 `state-bus.cjs` 演进为总线基座（订阅表 + 快照环形缓冲保留），state-manager 是总线上的第一个服务模块。
- 各模块 UI 通过 RPC 读写全局状态；移除渲染层本地 Zustand store 中长期持有的全局业务状态（会话 ID、设置等）。UI 层 store 仅保留纯视图状态（输入草稿、滚动位置等）。
- 持久化由 state-manager 模块自选（推荐 `better-sqlite3` 或现有 classic-level），不强制。

## 8. 模块生命周期

| 阶段 | 动作 |
| :--- | :--- |
| 发现 | 扫描内置 `modules/` + `user-data/modules/`，解析 manifest，依赖循环检测 |
| 激活 | 按 runtime 创建进程 → `rpc.initialize` → `rpc.discover` 上报方法 → 调用 `init` 钩子 |
| 运行 | `rpc.call` / `rpc.notify` 交互；`system.module.statusUpdate` 健康上报 |
| 停用 | `rpc.shutdown`（带超时检测）→ 释放资源 → 未响应则强制 kill |

## 9. 交互体系（保留 vaporwave 视觉并精化）

- **窗口壳（Shell Window）**：统一标题栏（模块图标 + 名称 + 最小化/最大化/关闭 + 会话上下文下拉），内容区为模块 UI；由 Harness 统一渲染壳，模块只控制内容区。
- **会话色钥（Context Color Wheel）**：新会话分配高辨别度专属主题色（珊瑚红/蒂芙尼蓝/芒果黄等），关联窗口标题栏色带同步染色，多会话归属一眼可辨。
- **连接徽章（Connection Badge）**：升级现有 link-registry/anchor-layout，窗口标题栏显示连接状态徽章，悬停时对方窗口边框闪烁定位。
- **命令面板（Command Palette）**：全局 `Ctrl+Shift+P` 唤起，向所有模块请求 `command.suggest` 补全，执行权转交对应模块（Phase 4）。
- **驾驶舱拓扑卡**：气泡聚合图展示会话 ↔ 模块连接与数据流状态（Phase 5）。
- 窗口外边框按连接状态显示"呼吸光晕/流光"（Phase 4 精化，可后置）。

## 10. 五阶段路线（结合 ponos 现状细化）

### Phase 1：协议内核（P1）

**目标**：Harness Kernel + 自研 RPC + Launcher 种子模块 + Chat 模块跑通对话。

- monorepo 重组（pnpm workspace：harness / modules / external-sdk / kernel 保留顶层）
- 自研 `rpc` 包：envelope / router / ipc-transport（worker/stdio 传输在 P2/P3）
- `module-registry` 升级 manifest v2.0（runtime/entry/interfaces/lifecycle 字段，兼容旧字段）
- Process Orchestrator：BrowserWindow 管理（迁移 window-manager）+ 进程生命周期状态机
- Launcher 模块（种子模块）：列出已装模块，点击启动
- Chat 模块迁移：现有 ChatWindow 通用视图（MessageBubble/CodeBlock/ThinkingBlock）模块化
- 跑通链路：**启动 → Launcher → 打开 Chat → 与 agent-core 对话（临时直连 bridge 或最小 agent 桥）**

**验收**：启动后显示 Launcher，可打开 Chat 窗口并完成一轮对话；模块崩溃不影响 Harness；全部核心逻辑可单测。

### Phase 2：状态服务（P2）

**目标**：state-manager 模块 + 多窗口状态同步。

- worker-transport + node-worker 运行时建立
- state-manager 模块：state.get/set/subscribe + event:state.changed
- 迁移 settings / files 全局状态到 state-manager
- 移除相关渲染层全局 Zustand store（保留视图态 store）

**验收**：两个窗口对同一状态读写一致；设置变更实时同步到所有订阅窗口。

### Phase 3：CLI 桥接（P3）

**目标**：agent-core 模块（kernel 接入）+ 外部程序接入。

- stdio-transport + cli-bridge 运行时建立
- `kernel/` 作为 agent-core 模块源码，`kernel/cli.mjs` 作为 cli-bridge 子进程入口（NDJSON 契约零改造）
- 会话生命周期（spawn/重启/健康）移交 Process Orchestrator
- bridge.mjs 双协议收敛为 JSON-RPC 方法集（会话管理语义保留）
- 一个外部程序（如 Python 脚本）注册为标准模块的示例

**验收**：Chat ↔ agent-core 全链路走 JSON-RPC；agent-core 崩溃自动重启且会话状态恢复；外部脚本可注册为标准模块。

### Phase 4：意图总线（P4）

**目标**：broadcast 路由 + user.intent + 命令面板。

- 路由层 broadcast 支持
- Chat 硬编码工具调用改为发布意图事件（`system.intent.broadcast`），模块订阅响应
- 命令面板 `Ctrl+Shift+P`（command.suggest 聚合）
- 窗口外边框流光/呼吸光晕精化

**验收**：输入 `/code 写个快排` 发布意图，订阅模块可接管；命令面板可唤起模块命令。

### Phase 5：生态（P5）

**目标**：外部模块扫描 + SDK + 业务模块回归 + 驾驶舱拓扑。

- `user-data/modules/` 外部模块扫描加载（阶段 B 完整启用）
- external-sdk/js-sdk（RPC 调用装饰器）
- **YFWorking 业务以标准模块形式回归**（approval / question / 经验沉淀等，按需）
- 驾驶舱拓扑卡（气泡聚合图 + 粒子流）
- 接入文档 + 模块开发指南

**验收**：第三方模块可安装加载并与其他模块 RPC 互通；回归业务模块功能完整；文档齐备。

## 11. 资产迁移清单

### 复用（升级挂载）

- `kernel/` → agent-core 模块（零依赖 NDJSON 契约，直接复用）
- `electron/module-registry.cjs` → Module Registry（manifest v2.0 升级）
- `electron/state-bus.cjs` → 总线基座（升级）
- `electron/window-manager.cjs` → Process Orchestrator 的 BrowserWindow 部分（clampBounds 保留）
- `electron/link-registry.cjs` / `anchor-layout.cjs` → 交互体系（连接徽章/吸附）
- GUI 通用视图：ChatWindow（MessageBubble/CodeBlock/ThinkingBlock）、SettingsView、FileBrowser 纯视图 → 对应模块
- 测试基建：node --test + 伪对象注入（fakeWin/fakeTarget）模式沿用

### 改造

- `server/bridge.mjs`：双协议统一为 JSON-RPC 方法集，会话管理/浏览器自动化路由语义保留

### 丢弃（P5 以模块回归）

- approval / dock / question / agents / doubao / experience 等 YFWorking 特有业务组件与相关 store、IPC 处理

## 12. 测试策略

- **协议契约测试**：envelope 编解码、router 定向/broadcast、三种 transport 适配器（fake 通道）
- **内核状态机测试**：registry 依赖解析、orchestrator 生命周期、权限拦截
- **模块单测**：各模块 handler 逻辑（沿用伪对象注入）
- **e2e 冒烟**：spawn 完整 harness，跑 Launcher → Chat → 对话链路
- 测试命令保持 `node --test`（harness/ 与 modules/ 各自包内脚本），每阶段提交前全量回归

## 13. 风险与缓解

| 风险 | 缓解 |
| :--- | :--- |
| monorepo 重组影响现有开发 | 重组与代码迁移分步，每步保留可运行基线（git 提交点） |
| 自研 RPC 生态成本 | 范围收敛（路由+发现+广播），<500 行，契约测试锁定 |
| 状态迁移破坏现有功能 | P2 先迁低风险状态（设置），验收后再扩展 |
| 业务清理后能力真空 | P5 模块化回归路线前置规划，明确每个业务组件的模块归属 |
| 大爆炸重构中途不可用 | 路线 A 每阶段有可演示验收点，阶段内保持可运行 |

## 14. 验收标准（总）

1. 启动 Ponos 后由 Launcher 引导进入任意模块，全链路走 JSON-RPC 2.0。
2. 任一模组崩溃不影响其他模块与 Harness，自动重启。
3. 多窗口状态一致（state-manager 提供服务）。
4. YFWorking 业务代码不在核心代码库中出现，仅以模块形式存在。
5. `node --test` 全量通过；核心逻辑零 Electron 依赖可单测。
