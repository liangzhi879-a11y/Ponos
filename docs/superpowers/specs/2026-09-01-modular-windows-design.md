# Ponos 纯模块化多窗口重构设计（2026-09-01）

## 1. 背景与目标

Ponos 桌面应用（Electron + React 18 + TS + Vite + Tailwind + zustand，单主题 `shadow`）
当前为单体布局：启动 → 欢迎页 → 驾驶舱 → 工作台（Header + 6-Tab 侧边栏 + 聊天区 +
RightRail + StatusBar + 10+ overlay 弹窗）。所有模块挤在单一主窗口内，交互范式固定。

本次重构将交互范式打碎重建为**纯模块化多窗口模式**：

1. **启动流程**：logo+动画 → 登录 → 驾驶舱。
2. **驾驶舱**：降级为常驻模块窗口之一（可开可关可最小化）。
3. **主窗口 dock**：关闭驾驶舱后主窗口收窄为屏幕右侧 dock 细条，仅显示功能导航
   （模块图标网格）+ 状态气泡 + 审批/提问弹窗宿主；鼠标悬浮展开。
4. **全模块窗口化**：聊天/文件/设置/诊断/技能Agent/Token/历史/工作树/搜索/权限
   全部独立原生窗口，可自由显示、放大缩小、最小化、关闭。
5. **后台运行**：模块窗口关闭后其运行时（agent 任务/会话流）继续，状态实时反映
   在 dock 气泡与弹窗。
6. **外部模块**：支持安装第三方模块（manifest.json + JS bundle），集成进导航条。

## 2. 已确认架构决策

| 维度 | 决策 |
|---|---|
| 窗口形态 | 原生多窗口（Electron BrowserWindow），非 DOM 浮窗 |
| 导航栏 | 主窗口收窄为 dock 细条，吸附屏幕右侧，hover 展开 |
| 模块窗口 | 聊天也独立窗口（每会话一窗），全量核心模块窗口化 |
| 跨窗口同步 | 主进程转发（IPC 总线广播） |
| 外部模块 | manifest.json + JS bundle，主进程扫描用户级 modules 目录注册 |
| 驾驶舱 | 常驻模块窗口之一 |
| 后台运行 | 窗口关闭只销毁视图，运行时状态保留，气泡反映 |

## 3. 架构总览

```
┌────────────────────────────── 主进程 (electron/main.cjs) ─────────────────────────────┐
│  ModuleRegistry ── 扫描 modules/ + 内置模块清单 → 模块目录                              │
│  WindowManager ── 创建/聚焦/最小化/恢复/销毁模块窗口，bounds 持久化                     │
│  DockBar (主窗口) ── 右侧细条：气泡 + hover 展开导航 + 审批/提问弹窗宿主               │
│  StateBus ── IPC 收事件 → 按订阅表广播到各窗口 → 气泡计数/状态                          │
│  任务运行时 (内核进程池) ── agent 任务继续跑，完成/提问/审批事件上报 StateBus           │
└────────────────────────────────────────────────────────────────────────────────────────┘
        │ IPC (preload 扩展: window.ponosModules / ponosBus)
        ▼
┌────────────────────────────── 渲染层 (多个 BrowserWindow) ─────────────────────────────┐
│  dock 窗口   聊天窗口₁ 聊天窗口₂   文件窗口   设置窗口   诊断窗口   ...   驾驶舱窗口     │
│  (导航条)    ── 每个模块窗口加载同一 dist，?module=<id> 路由到对应组件根                 │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 核心组件五块

1. **ModuleRegistry（主进程）**：内置模块清单（聊天/文件/设置/诊断/技能Agent/Token/
   历史/工作树/驾驶舱/搜索/权限/浏览器）+ 外部模块扫描（`~/.ponos-dev/modules/`
   目录 manifest.json + bundle）。产出统一 `ModuleDescriptor`：
   `{ id, name, icon, windowSpec, entry, singleton }`。
2. **WindowManager（主进程）**：`openModule(id, params?)` → 复用/新建 BrowserWindow；
   `?module=<id>` 路由到渲染层；窗口 bounds 持久化（复用 `editor:sync-bounds` 先例
   扩展为通用）；窗口关闭只销毁视图，不销毁模块运行时状态。
3. **DockBar（主窗口）**：dock 右缘细条（默认 ~48px），hover 展开功能导航；气泡区
   （运行任务/提问待处理/审批待处理/Token 水位/健康状态）；审批/提问弹窗直接宿主
   在 dock 窗口（全屏最前小弹窗）。
4. **StateBus（主进程）**：统一事件通道 `bus:publish` / `bus:subscribe`；事件如
   `task:status`、`question:pending`、`approval:request`、`module:state`；主进程按
   订阅表广播，DockBar 聚合显示气泡计数。
5. **模块窗口（渲染层）**：每窗口 `?module=<id>` + `ModuleRoot` 分发到对应组件
   （聊天窗口复用 ChatWindow；文件窗口复用 FileBrowser；设置窗口复用 SettingsView）。
   状态共享经跨窗口状态层（第 6 节）。

### 3.2 两阶段实施路径

- **阶段 A（架构地基）**：ModuleRegistry + WindowManager + DockBar 骨架 + StateBus +
  3 个试点模块（聊天/文件/设置）窗口化。
- **阶段 B（全量迁移）**：剩余模块全部窗口化 + 外部模块安装机制 + 驾驶舱改模块窗口
  + 气泡/审批/提问完整交互。

## 4. WindowManager（主进程）

**职责**：所有模块窗口的创建/复用/聚焦/最小化/恢复/关闭/销毁，bounds 持久化。

**核心 API**（IPC handler）：

```
module:list            → ModuleDescriptor[]            （注册表清单，DockBar 渲染导航用）
module:open            → { ok, windowId }              （打开/聚焦模块窗口；singleton 复用）
module:close           → { ok }                        （关闭窗口视图，不销毁模块运行时）
module:get-bounds      → { x,y,w,h }                   （各模块 bounds 缓存）
module:set-bounds      → { ok }                        （拖动/缩放回传，沿用 editor:sync-bounds 模式）
module:on-state        → 广播模块状态变更给订阅窗口    （StateBus 通道）
```

**窗口生命周期策略**：

| 动作 | 行为 |
|---|---|
| 打开 | 存在且未销毁 → `focus()`；否则新建 BrowserWindow，加载 `?module=<id>` |
| 最小化 | 原生最小化，气泡仍显示运行状态 |
| 关闭（×） | 销毁窗口视图但保留模块运行时（聊天会话/agent 任务继续跑），气泡标记"后台运行中" |
| 重开 | 新建窗口，从持久化状态（localStorage 同 origin 共享）恢复视图 |
| 全部关闭 | 主进程存活（dock 窗口不关），任务继续，仅气泡可见 |

**复用现有先例**：`editorWin` 的 `moved/resized → syncBounds` 回传模式泛化为
`module:set-bounds`；`?editor=1` URL 路由模式泛化为 `?module=<id>`。

**singleton 语义**：多数模块（文件/设置/诊断/Token）单窗口；**聊天模块每个会话一个
窗口**（`?module=chat&conversation=<id>`），会话窗口关闭后任务继续，导航条气泡显示
该会话运行状态，点击气泡重开该会话窗口。

## 5. DockBar（主窗口 dock 形态）

**形态**：主窗口收窄为右侧 dock 条（默认宽 ~48px，可拖宽），`alwaysOnTop` 可选，
吸附屏幕右缘（`screen.getPrimaryDisplay().workArea` 右侧）。

**三区结构**（从上到下）：

```
┌─┐
│P│  ← 品牌区：点击 → 打开驾驶舱窗口
├─┤
│●│  ← 状态气泡区（可展开面板）：
│●│     - 运行任务（chatStore.backgroundTasks 聚合，点击展开→各任务状态/中止）
│●│     - 待处理提问（pendingQuestions 计数，点击展开→提问卡）
│●│     - 待审批（approval 请求，点击展开→审批卡：允许/拒绝/详情）
│●│     - Token 水位 / 健康状态（healthStore 聚合）
├─┤
│▦│  ← 模块导航区（hover 展开横向/纵向面板）：
│▦│     - 内置模块图标网格（驾驶舱/聊天/文件/设置/诊断/技能Agent/Token/历史/工作树/搜索/权限/浏览器）
│▦│     - 外部已安装模块（manifest 注册，同网格）
│▦│     - 展开面板含"打开/关闭/后台运行中"角标
└─┘
```

**交互**：
- **hover 展开**：鼠标悬停 dock 条 → 展开完整功能面板（模块网格 + 气泡详情）；移出
  自动收回（可设置"锁定展开"）。
- **审批/提问弹窗**：直接宿主在 dock 窗口（最高 z 序，alwaysOnTop），新审批/提问
  到达时 dock 窗口自动弹出小卡片，处理后收起。替代现有主窗口的 `PermissionDialog`
  / `QuestionCard` overlay。
- **气泡计数**：来自 StateBus 订阅，dock 窗口常驻监听，实时刷新角标。

**DockBar 与主窗口关系**：原主窗口即 dock 窗口本身（不另开"导航栏窗口"），避免双
窗口管理。驾驶舱/聊天等全部改模块窗口后，主窗口只渲染 DockBar。

## 6. 跨窗口状态与 StateBus 协议

### 6.1 问题本质

当前 zustand store 是单窗口进程内共享（localStorage persist 只解决刷新持久化，
不解决多窗口实时同步）。多窗口后：

- 聊天窗口₁ 的 `backgroundTasks` 更新 → dock 窗口气泡必须实时反映
- 内核 `approval` / `question` 事件 → 必须送达 dock 窗口（审批宿主）
- 文件窗口打开/关闭 → dock 导航条显示"运行中"状态
- Token 统计跨窗口聚合（tokenStatsStore 持久化在 localStorage 多窗口同 origin 可读，
  但实时增量需广播）

### 6.2 StateBus 设计（主进程转发）

```
渲染层窗口                   主进程                    渲染层窗口
┌──────────┐  bus:publish  ┌──────────────┐  broadcast  ┌──────────┐
│ chat窗口  │ ────────────→ │  StateBus     │ ──────────→ │ dock窗口  │
│           │               │  (main.cjs)   │             │ (订阅者)  │
└──────────┘               │ 订阅表+路由    │             └──────────┘
                           └──────────────┘
```

**事件协议**（统一信封）：

```ts
interface BusEvent {
  channel: 'task' | 'question' | 'approval' | 'module' | 'token' | 'health' | 'agent' | 'custom:<extModuleId>'
  action: string                       // 'status-change' | 'pending' | 'resolved' | 'opened' | 'closed' ...
  payload: unknown                     // 事件载荷
  from: string                         // 来源窗口 id / 模块 id
  ts: number
}
```

**IPC 通道**（preload 扩展）：

```
window.ponosBus = {
  publish: (event) => ipcRenderer.send('bus:publish', event),
  subscribe: (channel, listener) => ipcRenderer.on(`bus:event:${channel}`, ...),
  // 返回取消订阅函数（沿用 ponosWindow 的 on/off 模式）
}
```

**主进程 StateBus**：
- 维护订阅表：`Map<channel, Set<webContents>>`（窗口打开时自动登记所属模块的订阅；
  dock 窗口订阅全部通道）。
- `bus:publish` → 校验事件信封 → 按 channel 广播给所有订阅者
  （`webContents.send('bus:event:' + channel, event)`）。
- 状态快照服务：`bus:get-snapshot(channel)` → 主进程维护各 channel 最近 N 条事件
  （环形缓冲），新窗口打开/重开时先拉快照再订阅增量，避免丢事件。

### 6.3 各 channel 的数据流映射

| channel | 发布方 | 订阅方（典型） | 载荷 |
|---|---|---|---|
| `task` | 聊天窗口（usePonosCLI 收到 task 事件） | dock 气泡、驾驶舱 | `{ conversationId, taskId, status }` |
| `question` | 聊天窗口（pendingQuestions 变更） | dock 弹窗宿主 | `{ conversationId, question }` |
| `approval` | 聊天窗口（内核 approval 事件） | dock 弹窗宿主 | `{ conversationId, toolUseId, command, approved? }` |
| `module` | 各模块窗口（打开/关闭/最小化） | dock 导航、所有窗口 | `{ moduleId, windowState }` |
| `token` | 聊天窗口（流式 usage 事件） | dock 气泡、Token 窗口 | `{ delta }` 增量 |
| `health` | 主进程（health 事件） | dock 气泡、驾驶舱 | `{ factor, score }` |
| `agent` | 主进程（子 agent 状态） | dock 气泡 | `{ agentId, status }` |

**关键迁移点**：
- 现有 `usePonosCLI` 的 `task`/`approval`/`question` 处理逻辑保留在聊天窗口内
  （它拥有内核 WS 连接），额外 `bus.publish` 到 StateBus；dock 窗口只做订阅与展示，
  不再需要直接连内核。
- 审批响应仍由聊天窗口的 `sendPermissionResponse` 完成（持有会话连接），dock 只
  负责展示审批卡并回传用户选择：dock 点击"允许" → `bus.publish({channel:'approval',
  action:'respond', payload:{conversationId, toolUseId, approved:true}})` → 聊天窗口
  收到 → 调 `sendPermissionResponse`。**审批执行权仍在持有连接的窗口，dock 是纯 UI
  宿主。**

## 7. 外部模块（manifest + JS bundle）

### 7.1 模块目录约定（复用 skills 目录心智）

```
~/.ponos-dev/modules/<moduleId>/
├── manifest.json          ← 模块声明（id/名称/图标/入口/窗口规格/权限）
├── bundle.js              ← 模块渲染逻辑（ESM，导出 mount/unmount）
└── assets/                ← 可选：图标/静态资源
```

`~/.ponos-dev/modules/` 与 skills 同级（用户级目录，非打包目录），安装=复制目录，
卸载=删除目录，主进程启动时扫描注册。分发物就是一个目录 zip。

### 7.2 manifest.json schema

```jsonc
{
  "id": "weather-dock",              // 唯一 id，反向域名风格
  "name": "天气插件",
  "version": "1.0.0",
  "icon": "assets/icon.svg",          // 相对 manifest 的路径
  "entry": "bundle.js",               // 渲染入口（ESM）
  "windowSpec": {                      // 默认窗口规格（可被用户拖动覆盖持久化）
    "width": 480, "height": 640,
    "minWidth": 320, "minHeight": 240,
    "resizable": true, "frame": true
  },
  "singleton": true,                   // 是否单窗口（false=可多开，需传 params）
  "channels": ["custom:weather"],       // 声明订阅的 StateBus 通道（主进程据此分配）
  "permissions": ["shell:open-path"],   // 可选：声明的 IPC 权限白名单
  "homepage": "https://...",            // 可选：模块主页/文档
  "author": "Ponos Team"
}
```

**启动方式**：DockBar 导航网格点击外部模块图标 → `module:open { id }` → WindowManager
创建窗口加载 `?module=<id>` → 渲染层 `ModuleRoot` 检测到外部模块 id → 动态
`import` bundle.js（经主进程 `module:get-bundle-url` 提供安全加载路径）→ 调用
`bundle.mount(container, { bus, api })`。

**渲染层模块契约**（外部模块只需实现）：

```ts
interface ExternalModule {
  mount(el: HTMLElement, ctx: ModuleContext): void | Promise<void>
  unmount?(el: HTMLElement): void          // 窗口关闭时清理
  onEvent?(e: BusEvent): void              // 订阅的 channel 事件推送
}
interface ModuleContext {
  bus: PonosBus                            // publish/subscribe
  api: { openModule, closeWindow, getConfig, setConfig }
  config: Record<string, unknown>          // 模块持久化配置
}
```

### 7.3 安全边界

- 外部模块 bundle 在独立窗口（contextIsolation: true，sandbox 同主应用）运行，无
  node 访问权。
- IPC 通道经 preload 白名单暴露（`window.ponosModules` 只含
  open/close/get-bounds/get-bundle-url 等安全方法），不暴露任意 ipcRenderer。
- `permissions` 声明只是 UI 提示层（如"使用系统浏览器打开链接"），实际能力由
  preload 白名单决定——外部模块默认能力：开模块窗口、订阅 StateBus、读写自身
  config、调 `shell:open-path` 打开链接。
- 安装时主进程校验 manifest 必需字段（id/name/entry/windowSpec），缺失/非法拒绝
  注册并告警。

## 8. 模块窗口化迁移清单

| 模块 | 现有组件/状态 | 窗口化处理 |
|---|---|---|
| 聊天 | ChatWindow+ChatInput+QuestionCard；chatStore | 每会话一窗口 `?module=chat&conversation=<id>`；保留 usePonosCLI（内核 WS 连接持有者） |
| 文件 | RightRail 内核 FileBrowser | 独立窗口复用 FileBrowser + 列表/图标双模式 |
| 设置 | SettingsView | 独立窗口复用 SettingsView |
| 诊断 | DiagnosticPanel+Banner | 独立窗口复用 DiagnosticPanel |
| 技能/Agent | SkillsPanel/AgentsPanel（Sidebar tab） | 独立窗口（可合并为一个"技能Agent"窗口，tab 内切换） |
| Token 统计 | TokenStatsPanel（App 根级） | 独立窗口复用 TokenStatsPanel |
| 历史 | HistoryView | 独立窗口 |
| 工作树 | WorktreePanel | 独立窗口 |
| 搜索 | SearchDialog | 独立窗口（快捷键 ⌘⇧F 在 dock 内唤起） |
| 权限 | PermissionDialog | 迁移到 dock 宿主（审批卡） |
| 提问卡 | QuestionCard | 迁移到 dock 宿主（提问弹窗） |
| 命令面板 | CommandPalette | 迁移到 dock 宿主（dock 内快捷键面板） |
| 驾驶舱 | CockpitView | 独立窗口（登录后自动打开；dock 品牌区可重开） |
| 快捷键帮助 | ShortcutsHelp | dock 宿主 |
| 文件预览 | FilePreview | 保持文件窗口内嵌（不另开窗） |

**overlay 收敛原则**：需要"跟随全局注意力"的（审批/提问/命令面板/快捷键）→ dock
宿主；需要"长时间停留操作"的（聊天/文件/设置/诊断/技能/Token/历史/工作树/驾驶舱）
→ 独立窗口。搜索介于两者——首版做独立窗口（可多窗口并行），快捷键 ⌘⇧F 在 dock
内唤起。

## 9. 跨窗口状态收敛

多窗口后各 zustand store 是独立实例，需要明确"权威源"：

**权威源策略**（延续 AGENTS.md"transcript 是权威源"哲学）：
- **持久化状态**（conversations/backgroundTasks/settings/ui 布局）→ 继续
  `localStorage` persist（同 origin 多窗口共享，读旧写新），但变更需经 StateBus
  广播触发他窗口重读——避免直接跨窗口写 localStorage 的竞态。
- **实时流状态**（流式消息块/usage 增量/审批挂起）→ 留在持有 WS 连接的聊天窗口，
  经 StateBus 广播"摘要事件"（状态变化/计数/审批请求），dock 与驾驶舱只消费摘要
  做展示，不复制全量。
- 一句话：**写全量（localStorage）+ 广播增量（StateBus）+ 读快照（bus:get-snapshot）**。

**聊天窗口权威**：每个会话窗口持有自己的 WS 连接（usePonosCLI 实例化于该窗口），
所以审批响应/提问回复天然在该窗口执行——dock 只是 UI 转发，与第 6.3 节一致。

## 10. 错误处理与测试

### 10.1 错误处理

- StateBus 广播失败（窗口已销毁）静默跳过，不阻塞发布方。
- 模块窗口打开失败（bundle 加载失败/manifest 缺失）→ 注册表拒绝 + dock 提示，不
  崩溃主进程。
- 外部模块运行时异常 → ErrorBoundary 捕获，窗口内降级显示错误卡，不影响其他窗口。

### 10.2 测试策略

内核/主进程侧（可测）：
- `WindowManager` 单测：open/close/singleton 复用、bounds 校验与持久化（仿
  `editorWin` bounds 校验）。
- `StateBus` 单测：publish→广播→订阅表路由、快照环形缓冲、非法信封拒绝。
- `ModuleRegistry` 单测：manifest 解析、缺失字段拒绝、bundle 路径安全校验。
- 渲染层状态收敛单测：token 增量聚合幂等（沿用 `tokenStatsStore.test.ts` 模式）。

Electron 集成（冒烟）：
- dock 窗口 + 模块窗口打开/聚焦/最小化/关闭的 IPC 全链路冒烟。
- 双窗口状态同步：聊天窗口发布 task 事件 → dock 气泡计数更新。

## 11. 范围与 YAGNI

**不做**：多进程窗口管理（每会话一进程）、窗口间拖拽合并、虚拟桌面感知、模块市场
在线安装器（首版仅本地目录安装）、真实认证服务、路由库、远程同步。

**预留**：`authToken` / `onAuthRequired` 认证扩展点（沿用现状）、模块市场安装器
（manifest 已含版本/author/homepage 字段，后续可接在线市场）。
