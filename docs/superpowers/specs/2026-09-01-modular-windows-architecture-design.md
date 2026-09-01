# Ponos 多窗口体系化重构设计（路线 B，2026-09-01）

## 1. 背景与目标

Ponos 桌面应用经过阶段 A（模块化多窗口地基）与交互范式修复（独立导航栏窗口/独立审批窗口/气泡面板），已具备多窗口能力。但当前实现存在"野路子"特征：

- `electron/main.cjs` 已达 **1772 行**，混杂 bridge 生命周期、托盘/宠物、编辑器窗口、模块窗口、dock 贴边、审批窗口等职责
- 窗口管理逻辑散落（24 处 `setBounds/setAlwaysOnTop/轮询` 内联在 main.cjs）
- 跨窗口状态经"手搓 StateBus（IPC 广播）+ localStorage 共享"双通道，机制不统一
- 无窗口类型注册表，dock/审批/模块窗口的创建与行为散落各处

**目标**：把 Electron 的"GUI 主进程 + 渲染进程"架构**正规化**——主进程成为真正的"窗口操作系统"（窗口类型注册表 + 生命周期 + bounds 策略 + 系统集成），渲染层只做内容展示。这是 Electron 架构的本来面目，也是"完整实现设计要求"的正规路线。

## 2. 架构决策

### 2.1 已确认（延续现状，不推翻）

| 决策 | 理由 |
|---|---|
| 多 BrowserWindow（原生窗口） | Electron 原生能力，已生效 |
| 每渲染窗口独立 WS 连接 | usePonosCLI 的 WS 层（send payload 构建/流式/插话/排队）极其复杂，**上移主进程成本极高且风险大**；Bridge 多路 WS 无冲突（按 sessionId 路由），是 Electron 常见模式 |
| StateBus（主进程 IPC 广播）保留 | 已被 usePonosCLI（发布）+ DockBar（订阅）使用且工作正常；MessageChannelMain 替换是"为正规化而重写"，收益低风险高 |
| frameless + 自定义标题栏（ModuleFrame） | 已生效，-webkit-app-region 是原生能力 |

### 2.2 本次重构范围（收敛 main.cjs 窗口职责）

**不做**：WS 上移主进程、MessageChannelMain 替换 StateBus、换框架。

**做**：把 main.cjs 中散落的窗口相关逻辑**收敛为独立服务模块**，主进程按职责拆分：

```
electron/
├── main.cjs            → 瘦身为"装配器"：启动顺序 + 服务编排（不再内联窗口逻辑）
├── window-manager.cjs  → 扩展为完整 WindowManager 服务（见 3）
├── dock-service.cjs    → DockService：dock 贴边/自动隐藏/悬浮（光标轮询收敛于此）
├── approval-center.cjs → ApprovalCenter：审批队列 + 窗口调度（主进程化审批）
├── state-bus.cjs       → 保留（跨窗口状态广播）
├── module-registry.cjs → 保留（模块清单）
└── preload.cjs         → 按服务拆分 namespace（ponosModules/ponosBus/ponosDock/ponosApproval）
```

## 3. WindowManager 服务化

### 3.1 窗口类型注册表

```js
// window-manager.cjs 扩展
const WINDOW_TYPES = {
  main:    { frame: false, singleton: true,  route: null },              // 主窗口（登录/驾驶舱宿主）
  dock:    { frame: false, singleton: true,  route: 'dock',  dock: true },
  approval:{ frame: false, singleton: true,  route: 'approval', approval: true },
  module:  { frame: false, singleton: false, route: 'module' },          // chat/files/settings/skills...
}
```

- `open(type, { moduleId, params })` → 按类型创建/聚焦窗口
- 每种类型绑定行为：`dock` → 贴边+自动隐藏；`approval` → 置顶+聚焦+审批队列
- bounds 持久化：按类型 + moduleId 存储，复用 `module:set-bounds` 模式
- 生命周期统一：created/closed/destroyed 事件 → StateBus `module:state` 广播

### 3.2 生命周期策略（延续阶段 A）

| 动作 | 行为 |
|---|---|
| 打开 | 存在未销毁 → focus；否则新建（loadModuleUrl `?module=<id>`） |
| 关闭 | 销毁视图，保留运行时（WS/任务继续） |
| 重开 | 新建，从 localStorage/transcript 恢复 |

## 4. DockService（独立服务）

把 main.cjs 中散落的 dock 贴边/自动隐藏/悬浮逻辑（`attachDock`/`startDockWatch`/`DOCK_*` 常量/`dockWindow`/`dockDocked`）**收敛为独立模块**：

```js
// dock-service.cjs
function createDockService({ windowManager, screen }) {
  return {
    attach(win)        // 贴边 + alwaysOnTop + moved→悬浮
    detach()           // 关闭时清理
    startWatch()       // 光标轮询（自动隐藏）
    stopWatch()
    isDocked()         // 状态查询（供审批等判断）
  }
}
```

- 光标轮询（Windows 无原生自动隐藏 API）收敛为服务的内部实现，接口清晰
- main.cjs 只保留 `dockService.attach(win)` 一行调用

## 5. ApprovalCenter（审批中心）

把审批从"渲染层各自处理"提升为主进程正规服务：

```
内核 ──WS──▶ 渲染窗口（usePonosCLI 收 approval）
                │  publishBus({channel:'approval', action:'pending'})
                ▼
        主进程 StateBus
                │  (approval/pending 监听)
                ▼
        ApprovalCenter
          ├─ 审批队列（pendingPermissions 主进程副本，按 sessionId+toolUseId 去重）
          ├─ windowManager.open('approval') → 展示当前审批
          └─ 用户批准/拒绝 → IPC 'approval:respond'
                │
                ▼
        原发布窗口（经 bus:event 收到 respond → sendPermissionResponse）
```

- **展示**：ApprovalModule 窗口（已实现）
- **响应**：仍由发布窗口持 WS 直发（`sendPermissionResponse`），ApprovalCenter 经 StateBus 转发用户选择
- 主进程持有审批队列（去重/超时），窗口只是展示当前审批

## 6. 实施步骤

### Phase 1：WindowManager 服务化（重构，无行为变化）
- 扩展 `window-manager.cjs`：窗口类型注册表 + 类型化创建（dock/approval/module）
- main.cjs 的 `createWindow` 回调改为经 WindowManager 类型化创建
- 验证：现有功能不回归

### Phase 2：DockService 提取
- 新建 `electron/dock-service.cjs`，从 main.cjs 迁移 dock 逻辑
- main.cjs 瘦身（删 `attachDock`/`startDockWatch`/`dockWindow` 等）
- 验证：dock 贴边/自动隐藏/悬浮正常

### Phase 3：ApprovalCenter 提取
- 新建 `electron/approval-center.cjs`：审批队列 + 去重 + 窗口调度
- main.cjs 的 `bus:publish` approval 监听改为 ApprovalCenter 接管
- 验证：审批到达自动弹窗、批准/拒绝正常

### Phase 4：preload 按服务拆分 + main.cjs 瘦身收尾
- preload.cjs 拆 `ponosModules`/`ponosBus`/`ponosDock`/`ponosApproval`
- main.cjs 收敛为装配器（启动顺序 + 服务编排）
- 全量回归

## 7. 测试

- `window-manager` 单测扩展：窗口类型注册表、类型化创建、bounds 持久化
- `dock-service` 单测：attach/detach/watch 状态机（fake screen/win）
- `approval-center` 单测：队列去重、窗口调度、响应路由
- 全量回归：`node --test "server/*.test.mjs"` + 渲染层测试

## 8. 范围与 YAGNI

**不做**：WS 上移主进程、MessageChannelMain 替换 StateBus、换框架、虚拟桌面感知、多进程窗口管理。
**预留**：窗口类型注册表可扩展外部模块窗口类型；ApprovalCenter 可扩展超时自动拒绝。
