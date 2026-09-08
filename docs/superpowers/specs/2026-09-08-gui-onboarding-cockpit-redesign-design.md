# GUI 交互升级设计：启动动画 / 登录 / 驾驶舱 / 三段式工作界面

> **状态**：已批准（2026-09-08，用户逐轮确认，锚点见下）
> **范围**：`src/` 前端 + `server/bridge.mjs` 少量端点/会话装配 + `public/cockpit/` 驾驶舱 iframe 素材。
> **不动**：`kernel/`（对话受限会话仅用现有参数组合 + disallowedTools；effort 内核已实现，只补 GUI→bridge 接线）、`electron/main.cjs` 主体结构。
> **上游参考**：`docs/superpowers/specs/2026-09-08-gui-agentloop-adapt-design.md`（UI 接线 spec 行文风格）
> **视觉素材**：`YF/驾驶舱原型/驾驶舱原型.html`（913 行银河飞轮演示）、`YF/boost-logo.ai`（PDF 兼容矢量，供导出透明 logo）

## Goal

把应用启动与一级导航重排为「品牌化四段流程」，并重构工作界面为三段式：

1. **启动动画**：boost 透明 logo + 流光进度条的品牌首屏；
2. **登录认证**：本地端口 `/api/auth/*` + 首设本机口令向导 + 登录页（后端服务端将来替换）；
3. **驾驶舱**：信息汇总屏（iframe 承载改造版银河原型），中央 logo 球为进入工作界面唯一入口；
4. **工作界面三段式**：左侧 lucide 图标 rail + 二级面板 + 主工作区；会话拆分为 **对话（纯聊）** 与 **任务（可执行）** 两模式；思考深度 GUI 接线补通；界面现场跨重启持久化。

附加硬约束（用户强调）：**所有界面风格统一并适配现有主题**；**应用内图标唯一、不重复，全用 lucide 标准图标（禁用 emoji 作图标）**。

## 决策记录（用户已确认，verbatim anchors）

| # | 决策点 | 确认结果 |
|---|--------|----------|
| D1 | 四段流程载体 | 同一 Electron 主窗口内 React 视图状态机：`boot → login → cockpit → work` |
| D2 | 工作界面左列形态 | **三段式 A**：rail（细图标列）+ 二级面板 + 主工作区 |
| D3 | 驾驶舱定位 | **信息汇总屏**，不承担模块导航；**点中央 logo 球进入工作界面**；工作界面点**左上 logo** 返回驾驶舱 |
| D4 | 现场保留 | 工作界面保留退出时状态，**跨重启持久化**；无历史默认 = **自动新建一个对话**（空白 chat 会话） |
| D5 | rail 图标集 | 用"核心项"，但**不放驾驶舱**；即 rail = 对话 / 任务 / 智能体 / 技能 / 设置；**图标全用 lucide、应用内不重复** |
| D6 | 登录形态 | **首设本机口令**：首次启动设口令（scrypt 哈希落本地），之后每次启动登录；本地 bridge 端口加 `/api/auth/*`，将来接服务端同构替换 |
| D7 | 驾驶舱实现 | **iframe 内嵌**改造版原型（`public/cockpit/`），postMessage 注入总览数据 / 主题 / 进出指令 |
| D8 | 对话纯聊技术路线 | **内核受限会话**：仍走 bridge→内核 agent 循环，不绑业务 cwd、仅保留联网工具（WebSearch/WebFetch）、屏蔽全部本地执行工具 |
| D9 | 驾驶舱↔工作过渡 | logo 为载体：**logo 球微放大 → 平移至工作界面左上 logo 位 → 目标屏淡入**，不充满全屏；反向同理（~400ms） |
| D10 | 驾驶舱汇总内容 | 六张信息卡：运行中任务 / 任务进度 / 智能体状态 / 技能与知识库 / 用量统计 / 健康与设置；hover 反馈、点开**只读详情浮层**（不跳转功能界面） |

## 现状锚点（本 spec 依赖的事实基线）

- 渲染根 `src/App.tsx`（编辑器独立窗口分支）→ `src/components/layout/AppShell.tsx`：`Header` + `Sidebar`(可隐藏) + 中央 `ChatWindow/ChatInput/QuestionCard` + `StatusBar` + 各 overlay。
- 侧栏 7-Tab：`src/components/layout/Sidebar.tsx:25-33`（chats/files/worktrees/history/agents/skills/usage），TABS 各自渲染已有面板组件（AgentsPanel/SkillsPanel/UsagePanel/HistoryView/FileBrowser/WorktreePanel）。
- 会话概念：`Conversation`（`src/types/index.ts:93-113`）**无 mode 字段**；`createConversation(cwd?, agentId?)`（`chatStore.ts:458-482`）恒设 cwd（参数||lastCwd||home）与 `model:'deepseek-v4-flash'`。
- GUI→内核：`src/hooks/useYFWCLI.ts` 实为 WS 客户端（`ws://localhost:<BRIDGE_PORT>`，`src/lib/config.ts:14-20`）；`send` 载荷含 `{sessionId, cwd, resumeId, systemPrompt, model, compactCount…}`（`useYFWCLI.ts:243-273`）。每会话对应 bridge 侧一个常驻内核进程。
- bridge spawn 内核：`server/bridge.mjs getOrCreateSession`（~792-880），固定参数 `--print --output-format stream-json --input-format stream-json --verbose --dangerously-skip-permissions --permission-prompt-tool stdio --disallowedTools AskUserQuestion` + `--add-dir <cwd>` `--add-dir <skillRoot>`；无 cwd 时 spawn cwd 退化 `process.cwd()`。会话级 WS 上行分发（cancel 等）在 `bridge.mjs:2011-2157`；HTTP if-chain handler ~1135（Node 原生 http，无 express；新增端点加 if 分支，范本 `/api/usage` `bridge.mjs:1322-1335`）。
- 工具与联网：`kernel/tools.mjs createToolRegistry` 的 blocked 集合过滤；WebFetch/WebSearch 已默认注册（`tools.mjs:484,563-663`）。内核禁工具集合来自 CLI 参数 + settings `disallowedTools`（`kernel/cli.mjs:281`）。
- effort/思考深度：内核完整实现（`kernel/engine.mjs normalizeEffort` off/low/medium→high/high/max/auto、`api.mjs effortParam` low/high/max→`reasoning_effort`、off→`thinking:{disabled}`、端点拒绝自动降级重发）；支持 `control_request` subtype `reasoning_effort`/`switch_provider` 热切换（`kernel/cli.mjs:653-688`）。**GUI 链路断裂**：SettingsView 档位（`SettingsView.tsx:747-755`）只写 config/localStorage；`bridge.mjs buildChildEnv`(~674-730) 与 `syncKernelSettings`(~440-479) 均未注入 `CLAUDE_CODE_EFFORT_LEVEL`，bridge WS 分发无 reasoning_effort/switch_provider case。
- 配置/持久化：bridge `~/.yfworking/config.json`（provider/effortLevel 字段存在）、内核 settings `~/.yfworking/settings.json`；前端 zustand persist → localStorage `yfworking-settings`（`settingsStore.ts:224`）、`yfworking-chat`。**无密码/加密先例**（无 safeStorage 使用，authToken 明文）。
- 用量视图：`usageApi.ts` fetch `/api/usage` `/api/audit`；健康/诊断：`diag:get-boot-summary`、healthStore。
- 驾驶舱原型：`YF/驾驶舱原型/驾驶舱原型.html`（自含 CSS/JS，`buildStations/ringXY/frame` 轨道+尘埃动画；`MODULES` 六站 sessions/tasks/agents/kb/usage/settings；`openPanel` 演示面板 `html:825`；hub click 关面板 `html:842`；主题 `applyTheme` light/dark `html:848`）。主题 token 名与 GUI 不同（独立变量），需桥接。
- boost-logo.ai：`%PDF-1.6` 头（Illustrator PDF 兼容），可尝试矢量/位图导出。

## 架构总览

```
React 渲染层（Electron 主窗口）
  src/lib/viewStore.ts —— view: 'boot'|'login'|'cockpit'|'work'（zustand persist，见 §7）
  │
  ├─ BootScreen（§1）→ 动画完成 → LoginScreen（§2）
  ├─ LoginScreen / SetupWizard（§2）→ 认证通过 → CockpitScreen（§3）
  ├─ CockpitScreen（§3）：全屏 <iframe src=/cockpit/index.html>
  │     postMessage：父→iframe {theme, overview, speedmode}；iframe→父 {ready, hub-click}
  │     hub-click → logo 过渡（§3.4）→ WorkShell
  └─ WorkShell（§4）：三段式 rail｜二级面板｜主工作区
        └─ 会话体系 ChatStore 增 mode（§5）+ effort 接线（§6）

进程边界
  bridge.mjs：
    HTTP 新增 /api/auth/* 分支（§2.3）——口令哈希/校验独立模块 server/auth.mjs（纯函数可测）
    getOrCreateSession 按会话 mode 定制 spawn 参数（§5.2）——chat 模式注入禁用工具集、不绑业务 cwd
    buildChildEnv 注入 CLAUDE_CODE_EFFORT_LEVEL；WS 分发补 reasoning_effort/switch_provider 转发（§6）
  kernel（不改核心）：
    chat 会话 = 无本地工具 + WebSearch/WebFetch 可见 → agent 循环退化为纯聊
    effort：内核侧已是既成事实
```

## §1 启动动画（BootScreen）

- 位置：AppShell 顶层按 view 状态切换；BootScreen 为全屏居中图层。
- 视觉：boost 透明 logo（PNG，见 §8.3）居中，呼吸光晕动画；下方**流光进度条**（CSS 渐变往返流动，装饰性非真实进度）；底部阶段小字（bridge health 探测 → 内核就绪）。
- 时序：最短展示 ~1.2s；`window.yfworkingWindow`/bridge `/health` 就绪或最长 ~2.5s 放行；`settings.speedMode` 为 true 时跳过动画直接到 login。
- 结束：淡出 logo → 交棒 login（首设未完成）或已认证会话登录页。

## §2 登录认证（本地端口 + UI）

### 2.1 流程

- `GET /api/auth/status` → `{ phase: 'uninitialized' | 'locked' | 'ok', lockedUntil?, remember? }`
  - `uninitialized` → **首设向导**（设口令 ×2 + 强度提示），POST `/api/auth/setup`；
  - `locked` → 显示锁定倒计时；
  - `ok` + 本地有效 token（localStorage `yfw-auth-token`）→ 可自动放行进 cockpit/work。
- 登录 POST `/api/auth/login` `{password, remember}` → 校验通过发 token。

### 2.2 服务端模块 `server/auth.mjs`（新增，纯函数优先可单测）

- 口令哈希：Node `crypto.scrypt` + 随机盐，存 `~/.yfworking/auth.json` `{salt, hash, version}`（**明文不落盘**）。
- token：登录成功签发随机不透明 token，bridge 内存 `Map(token→expiry)` 校验（重启失效→需重登录；`remember` 仅指本次运行期自动放行，重启后仍要登录——与 D6"每次启动登录"一致）。
- 错误处理：连续失败计数与退避锁定（`auth.json` 记录 failCount/lockedUntil），防本地暴力。
- 无新 npm 依赖（全 `node:crypto` 原生）。
- 将来替换：GUI 仅依赖上述 4 个 HTTP 端点路径，bridge 实现可整体换成服务端。

### 2.3 bridge HTTP 接入

`server/bridge.mjs` if-chain 增分支：`/api/auth/status|setup|login`（+ 退出 `POST /api/auth/logout` 可选）。校验逻辑全部在 `auth.mjs`，bridge 只做薄转发（参考 `/api/usage` 转发范本，注意 keep-alive 与 body 解析小 JSON，沿用现有 body 读取方式）。

### 2.4 登录/首设 UI

- 居中玻璃卡片：boost logo + 标题；密码框（可见性切换/回车提交）、错误抖动、锁定提示；「启动自动登录（本次运行）」checkbox 默认开。
- 完成后带 logo 过渡进 cockpit（§3.4 反向复用）。

## §3 驾驶舱（CockpitScreen · iframe）

### 3.1 素材制作（public/cockpit/）

- 由 `YF/驾驶舱原型/驾驶舱原型.html` 派生数据驱动版 `public/cockpit/index.html`：保留轨道/尘埃/彗星视觉与主题 light/dark；六站卡片与详情浮层改为**渲染注入的总览数据**；`hub` 点击动作改为 `parent.postMessage({type:'yfw:hub-click'})`；接收消息切换主题/注入数据/开关 speedmode。原 YF 原型文件保持不动。
- iframe 满屏（inset:0，`pointer-events` 正常），父级不绘制背景。

### 3.2 postMessage 契约

| 方向 | type | data | 触发 |
|------|------|------|------|
| 父→iframe | `yfw:theme` | `{mode:'light'\|'dark', speedMode:boolean}` | 主题/极速变化或进入 cockpit 时 |
| 父→iframe | `yfw:overview` | `OverviewData`（见下） | 进入时 + 周期/事件驱动刷新 |
| iframe→父 | `yfw:ready` | — | iframe 加载完成 |
| iframe→父 | `yfw:hub-click` | — | hub 球点击 → 父执行过渡进 work |
| iframe→父 | `yfw:detail-open` | `{stationId}` | 可选：父侧联动（默认忽略） |

`OverviewData`（父级汇总，来源均现有）：`{ runningTasks:[{title,status,progress?,cwd}], agents:[...], usage:{token,requests,costUsd}, skills:{count,recent:[]}, health:{engine, kernel}, recent:{...} }`。数据源：`chatStore.streamingConversations + conversationProgress`、`agentStore`、`usageApi.fetch`、`/skills`、`healthStore/diag:get-boot-summary`。

### 3.3 主题桥接

- 现有主题 → iframe 模式：非 light 系 → dark 映射为 `theme-dark`，light 系 → `theme-light`（沿用原型 `applyTheme`）。
- `settings.speedMode` 时给 iframe 注入关闭动画指令（原型挂 `speed-mode` 类停轨道/尘埃逐帧）。
- 主题切换全局生效：进入 cockpit、GUI 切主题、speeedMode 变化三条路径都发 `yfw:theme`。

### 3.4 logo 过渡（驾驶舱 ⇄ 工作界面）

- 实现层：view 切换包一层 overlay 动画组件 `LogoMorph`（framer-motion）。驾驶舱→工作：取 hub logo 球当前屏幕坐标 → logo 微放大(scale ~1.15) + 泛光 → **平移至 Header 左上 logo 位置**（同帧缩小至 header 尺寸）→ 工作界面淡入（~400ms）。工作→驾驶舱反向：左上 logo → 放大平移至驾驶舱 hub 位。
- 进入动画在 iframe 与父级 z 轴顺序：overlay 置于 iframe 之上；动画完成后卸载 iframe（切 cockpit 视图时再挂载或保活——**首次后保活 iframe**，避免重复加载闪白，返回时直接淡入）。

## §4 三段式工作界面（WorkShell）

### 4.1 布局

```
Header（保留现窗口控件；左上 logo 点击 → logo 过渡回 cockpit）
┌────────┬──────────────┬─────────────────────────────┐
│ rail   │ 二级面板      │ 主工作区                     │
│ 48px   │ ~240px       │ ChatWindow/QuestionCard/Input│
│ lucide │ 按 rail 项    │（现状全链路保留）             │
└────────┴──────────────┴─────────────────────────────┘
StatusBar（现状保留）
```

- rail 常驻（不再可整体隐藏；宽度固定）。条目与图标（lucide，**全局唯一**，见 §8.2）：
  `对话`(MessageSquare) / `任务`(SquareKanban) / `智能体`(Bot) / `技能`(Puzzle) / `设置`(Settings)。激活项品牌橙高亮 + tooltip。
- 点击 `设置` → 打开现有 SettingsView overlay（rail 自身不高亮驻留）。

### 4.2 二级面板内容

| rail 项 | 面板内容 |
|---------|----------|
| 对话 | 对话（mode=chat）会话列表 + 顶部「＋ 新建对话」；空态提示（纯聊/无目录/可联网） |
| 任务 | 任务（mode=task）会话列表（运行中分组 + 其余 + 会话集），顶栏「＋ 新建任务」+ 次级工具钮（文件浏览/历史/用量/工作树 → 打开对应浮层面板，复用现组件） |
| 智能体 | 复用 `AgentsPanel` |
| 技能 | 复用 `SkillsPanel` |

- 现有 7-Tab 宽侧栏结构退役，其内容按上面拆解；`files/worktrees/history/usage` 作为从任务面板次级工具钮唤出的浮层/临时面板（保留既有组件实现与 store）。

### 4.3 Header logo 语义

Header 左侧 logo（现 `Header.tsx:75` 的 `<img src=logo.png>`）改为点击热区：点击 → `LogoMorph` 过渡回 cockpit（工作现场快照到持久化 store，D4）。

## §5 会话模式：对话 vs 任务

### 5.1 数据模型

- `Conversation` 增 `mode?: 'chat' | 'task'`（缺省按 `task` 迁移——旧会话含 cwd 行为不变）。
- `createConversation` 增 mode 分支：`chat` 模式**不设业务 cwd**（记录 `cwd: undefined` + 专用内核运行目录常量 `CHAT_SANDBOX_DIR` 如 `~/.yfworking/projects/_chat/<sid>` 用于 transcript 落盘，避免污染业务目录）；`task` 行为现状不变。
- title：chat 会话沿用现有摘要/「新对话」；历史列表两类分栏展示。

### 5.2 bridge 装配（chat 受限会话）

- `getOrCreateSession` 接收会话 mode（来自 `send` 载荷新增 `mode` 字段）；`mode==='chat'` 时 spawn 参数：
  - **不注入业务 cwd**；`--add-dir` 仅 skill 根（或 chat 模式不注入技能目录，视内核行为定）；
  - 追加 `--disallowedTools` 本地执行工具全集：`Bash|Shell|Read|Write|Edit|...|Browser` 等，**仅保留** WebSearch / WebFetch 两类联网只读工具（最终清单以 `kernel/tools.mjs` 工具名为准，实施时核对注册表）；
  - 其余（`--dangerously-skip-permissions` 等）不变——受限后无本地工具可执行，天然满足"不可执行本地任务"。
- 会话级发送仍用现 `send` 路径（载荷加 mode）。event 回传、milestone/提问卡/用量统计与任务一致（D8 目标：两模式同体系）。

### 5.3 输入区差异提示

- ChatWindow/ChatInput 顶部按 `conversation.mode` 显示模式徽标：对话=「纯聊 · 可联网 · 不执行本地」/任务=「任务 · 可执行本地操作」；并提供**快速 effort 档位**控件（见 §6）——两模式共用。

## §6 思考深度（effort）接线补通

- 语义：GUI 档位 `off / low / medium / high / max / auto`（与内核 normalizeEffort 对齐；UI 展示名称：关闭/轻/标准/深度/最强/自动）。默认 `auto`。
- 静态接线：`bridge.mjs buildChildEnv` 注入 `CLAUDE_CODE_EFFORT_LEVEL=<档位>`（来自会话设置/全局设置，随每次 spawn 生效）；SettingsView 现有下拉的落点从"只写配置"扩展为"写配置 + 通知 bridge 更新 env"（新增会话 spawn 生效）。
- 动态热切换：bridge WS 分发补 `control_request(subtype:'reasoning_effort')` / `switch_provider` case（cancel 写法范本 `bridge.mjs:2056-2060`），GUI 输入框档位切换与 Settings 变更时向当前会话发 control_request，实现不重启内核的即时调整。
- 注意：chat 受限会话同样受 effort 控制（纯聊思考深浅可调，需求 D8 覆盖）。

## §7 状态持久化

- `src/lib/viewStore.ts`：`view` + 工作现场 `{ work:{ railTab, activeConversationId, panelContext, … } }`，zustand `persist` → localStorage（沿用 settings/chat 先例）。
- 恢复语义：启动认证通过后 → 若存在现场 → 回驾驶舱（D3：登录后默认驾驶舱）；点 hub 球按现场恢复工作界面（rail/面板/活动会话）。**无任何历史/首启** → 进入工作界面时自动 `createConversation(mode:'chat')` 生成空白对话（D4"默认新对话"）。
- 工作界面往返驾驶舱不改现场（D4 保留退出状态），持久化跨重启。

## §8 主题 / 图标唯一性 / 素材 / i18n

### 8.1 主题统一

- 所有新屏（Boot/Login/Cockpit 父层/work rail/面板）吃现有 CSS 变量令牌与 THEME_CLASS_NAMES；glass 主题对半透明元素生效、speed-mode 全局关动效（含 §1 动画跳过与 iframe 指令）。文案一律进 i18n（`src/i18n`）。

### 8.2 图标唯一契约（lucide，应用内不重复）

- rail 与各功能图标按"语义动作"做全局查重；冲突者换近义 lucide（最终图标映射表在实现 Task T9 以清单形式固定，并加注释行禁止跨含义复用同一图标）。具体包括：
  - rail：`对话=MessageSquare`、`任务=SquareKanban`、`智能体=Bot`、`技能=Puzzle`、`设置=Settings`；
  - 新建任务=SquarePlus、新建对话=MessageSquarePlus（**不再与 rail 的 MessageSquare 混淆**，替代 Sidebar 现有 Plus 复用）；
  - 文件浏览=FolderOpen、历史=History、工作树=GitFork、用量=Gauge、返回驾驶舱=Home（仅 Header/Cockpit 语义用，rail 不放）；
  - 对话/任务徽标区分用色不用图标；运行状态点不属图标语义可例外。
- 规范落点：`docs/superpowers/` 图标契约段 + 组件注释；不引入 emoji 图标（lucide 缺失场景以文字或组合处理）。

### 8.3 boost logo 素材管线

- 目标：一份透明底 boost logo PNG（浅/深两版可选）供 boot/login/hub/header 复用，替换/新增 `public/logo` 资产。
- 方式：先尝试自动导出 `YF/boost-logo.ai`（检测 pymupdf/ghostscript/mutool；PDF 兼容位图或矢量转 PNG+alpha）。失败 → 请用户用 Illustrator 导出透明底 PNG 放置指定路径。
- 若自动导出质量不可用（图层/渐变压平差异），同样走用户导出通道。此为本 spec 的**前置资产待办**（不阻塞代码开发，先落地占位 logo）。

### 8.4 工程拆分（供 writing-plans 的 Task 骨架）

| Task | 内容 | 主要落点 |
|------|------|----------|
| T1 | 资产：boost logo 导出 + public/cockpit 原型改造（数据驱动 + postMessage） | public/ |
| T2 | viewStore + BootScreen + AppShell 视图路由 + LogoMorph 过渡骨架 | src/lib、src/components |
| T3 | auth：server/auth.mjs + bridge 端点 + 前端 authApi + Setup/Login 屏 | server、src |
| T4 | CockpitScreen：iframe 容器 + overview 汇总 + 主题/极速桥接 + hub 过渡接线 | src |
| T5 | WorkShell 三段式重构：rail + 二级面板拆解 + 现有 Sidebar 退役迁移 | src/components/layout 等 |
| T6 | chat/task mode：类型 + createConversation + bridge 受限 spawn + 输入区模式徽标 | src、server |
| T7 | effort 接线：buildChildEnv 注入 + WS 热切换转发 + GUI 档位控件 | server、src |
| T8 | 持久化现场 + 默认新对话语义 | src |
| T9 | 主题/i18n/图标查重 + 冒烟回归 + typecheck/test | 全局 |

## 测试策略

- 纯函数/独立模块单测（node 原生 TS / node:test，沿 usageUi、warning 归约先例）：
  - `auth.mjs`：哈希/校验/token/锁定逻辑；
  - view/mode 归约、effort 档位映射、overview 汇总纯函数（若抽 `src/lib`）。
- bridge 端点：`server/*.test.mjs` 既有测试族扩展 auth 分支（用临时 auth 路径/临时 HOME）。
- 类型与构建：`npm run typecheck` + `npm run build`。
- 冒烟回归：既有回归纪律（kernel/agentloop 冒烟清单 + GUI 手工冒烟脚本）；新增驾驶舱 iframe postMessage 冒烟（dev 起服务后手工：切主题、hub 进出、看数据刷新）。
- 回归底线：不动 kernel 核心与既有 WS 事件解析；Sidebar 退役前确保 chats/files/history/agents/skills/usage 六视图在新结构下入口齐全（等价性检查单）。

## 风险与未决

- boost-logo.ai 自动导出质量不确定 → 用户导出兜底（§8.3），不阻塞编码。
- iframe 内原型性能/主题闪烁：首帧后保活 + 预载 `yfw:theme`；若 iframe 动画与父级流畅度冲突，可降级速度模式下全关。
- 受限工具清单需以 `kernel/tools.mjs` 实际工具注册名核对（T6 前置小调研，已在实现清单内）。
- 驾驶舱 overview 数据源如 `/skills` 端点字段形态与 agents 数据模型，T4 落地前核对现有组件所用数据结构，不新造。
