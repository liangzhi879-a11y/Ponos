# Ponos 前端升级设计（2026-08-31）

## 1. 背景与目标

Ponos 桌面应用（Electron + React 18 + TS + Vite + Tailwind + zustand，单主题 `shadow`
霓虹 vaporwave）当前启动后直接进入聊天界面，无登录入口；主界面为
Header + 左侧 6-Tab 侧边栏 + 中间聊天区 + StatusBar 布局；品牌图标为 YF 橙红调，
与主题（霓虹粉 `#ff2d94` + 电青 `#1fd8f0` + 暗黑 `#0d0d11`）不符；Header 品牌文案
为 SHADOW；StatusBar 含 Sélectionner/Quitter 手柄提示。

本次升级目标：

1. **登录入口**：启动等待动画 → 欢迎页（登录）→ 主界面；欢迎页暂不校验，但架构
   预留认证扩展点（后续可无缝接入真实认证）。
2. **驾驶舱主界面**：模块化、图谱化（卡片 + SVG 连线）展示应用数据，多入口进入
   聊天工作台与其他管理；Token 用量统计详细设计。
3. **工作台三栏布局**：左任务栏（会话 + 运行任务）、中聊天工作区、右资源管理器
   （列表/图标双模式）；左上头像 + Ponos 品牌；删除右下 Sélectionner/Quitter。
4. **品牌视觉升级**：替换 YF 橙红图标为霓虹漩涡 P，统一应用图标/托盘/安装包/
   Header/登录/驾驶舱 Logo。

## 2. 视图与流程

### 2.1 视图状态机

新增 `src/stores/viewStore.ts`（zustand + persist，遵循现有模式）：

```
boot（启动等待动画）
  └─ 初始化完成 → login（欢迎页）
       └─ 点击「进入 Ponos」→ cockpit（驾驶舱，默认首页）
            ├─ 卡片点击 → workspace（工作台）
            └─ 左上角 Logo 点击 → 返回 cockpit
```

- `App.tsx` 根组件按 `viewStore.view` 渲染：`BootScreen` / `LoginScreen` /
  `CockpitView` / `Workspace`（改造后的 AppShell）。
- 视图切换不引入路由（桌面单窗口应用无 URL 场景，YAGNI），用 zustand 状态机。

### 2.2 BootScreen（启动等待动画）

- 霓虹漩涡 P Logo 呼吸动画 + 加载步骤提示：初始化内核 → 加载配置 → 连接模型 →
  准备就绪。
- 步骤由 bridge 连接状态与内核健康事件驱动（`usePonosCLI().connected` /
  `healthStore`），动画走完自动切 login。
- 复用现有 `shadow-theme/bg-vaporwave.jpg` 背景与主题色。

### 2.3 LoginScreen（欢迎页）

- 品牌视觉（霓虹漩涡 P + Ponos 字标）+「进入 Ponos」按钮 + 版本号（`__APP_VERSION__`）。
- **暂不校验密码**；`viewStore` 内含 `authToken` 占位字段与 `onAuthRequired` 认证钩子
  （空实现）。未来接真实认证时：LoginScreen 升级为登录表单（用户名/密码 →
  onAuthRequired 校验 → 写 authToken），视图流不变，无需改 App 骨架。

### 2.4 CockpitView（驾驶舱）

见第 3 段。点击卡片 → `viewStore.goWorkspace(tab?)`，进入对应工作区。

### 2.5 Workspace（改造后 AppShell）

见第 4 段。Header 品牌区点击 → `viewStore.goCockpit()`。

## 3. 驾驶舱与 Token 统计

### 3.1 驾驶舱布局

- 顶部欢迎条：用户问候 + 当前模型/连接状态 + 全局搜索入口。
- 下方模块化卡片网格，卡片间用 **SVG 连线**表达数据流关联（会话→Token 消耗、
  会话→文件、会话→技能/Agent）。连线为装饰性（低透明度渐变描边），hover 卡片
  高亮相关连线，无浏览器兼容风险（纯 SVG）。
- 点击卡片进入对应工作区（驾驶舱多入口）。

### 3.2 四个模块卡片

| 卡片 | 展示数据 | 数据源 | 点击入口 |
|---|---|---|---|
| 会话·任务 | 总会话数、今日消息数、运行中任务、完成率 | chatStore（conversations / backgroundTasks） | 工作台聊天 |
| Token 用量 | 累计/今日/近7日 + 迷你趋势 + 水位 | tokenStatsStore（新增聚合） | Token 统计详情面板 |
| 文件·目录 | 当前项目目录文件数、最近打开文件、磁盘占用 | bridge /list-dir、/drives | 工作台右侧资源管理器 |
| 技能·Agent | 已装技能数、Agent 列表、最近使用 | lib/skills.ts、lib/agents.ts | 工作台技能/Agent 面板 |

### 3.3 Token 统计详细设计

**数据架构**：新增 `src/stores/tokenStatsStore.ts`（zustand + persist）。

- **增量聚合**：每条消息结束时不只更新 `conversations[].tokensTotal`，同时按
  `日期 / 会话 id / 模型 / input|output` 四维累加，持久化 localStorage。
- **历史回填**：升级后首次打开驾驶舱，懒加载各会话 transcript（复用
  `fetchTranscript`），解析每条 assistant 的 `usage{input_tokens, output_tokens}` +
  timestamp 回填聚合；之后每次流式结束（`usePonosCLI.ts:686-692` 已有
  `inputTokens/outputTokens` 事件）增量累加，零重复加载。
- 聚合结构：
  ```ts
  interface TokenStats {
    totalInput: number
    totalOutput: number
    byDay: Record<string, { input: number; output: number }>   // YYYY-MM-DD
    byConversation: Record<string, { input: number; output: number; title?: string }>
    byModel: Record<string, { input: number; output: number }>
    lastUpdatedAt: number
  }
  ```

**六维展示**（Token 详情面板，纯 SVG 手绘，零依赖）：

1. **总量卡**：累计消耗 + 今日消耗 + 近 7 日消耗（大数字 + 环比）。
2. **按日趋势**：近 30 日折线/柱状图。
3. **按会话 Top 10**：各会话消耗排行 + 占比条。
4. **按模型拆分**：DeepSeek / MiniMax 各模型用量占比（环形图）。
5. **输入/输出拆分**：input vs output 双色堆叠。
6. **上下文窗口水位**：活跃会话估算占用 / provider contextWindow（如 1M）进度条。

**入口**：驾驶舱 Token 卡片点击 → Token 详情面板（可全屏/抽屉）；StatusBar TK 徽标
点击同样直达。

## 4. 工作台三栏布局改造

### 4.1 Header 品牌区（Header.tsx:64-72）

- 左上角头像：新霓虹漩涡 P 图标 + 登录用户头像环（默认品牌图，未来接真实头像）。
- 文案 `SHADOW` → `Ponos`。
- 点击品牌区 → `viewStore.goCockpit()`（返回驾驶舱）。

### 4.2 左侧任务栏（Sidebar.tsx 改造）

- **保留**：会话列表全部现有能力（搜索/新建/会话集/拖拽/置顶/右键菜单）。
- **新增顶部**：运行任务区——`chatStore.backgroundTasks` 中 `running` 的任务胶囊，
  点击展开/中止。
- **精简 Tab 条**：移除 `files`（移到右侧），保留
  `chats / worktrees / history / agents / skills`，新增 `cockpit` 返回入口。
- 宽度可拖拽（沿用 `sidebarWidth`）。

### 4.3 中间聊天工作区

`ChatWindow + ChatInput + QuestionCard` 原样保留，不动。

### 4.4 右侧资源管理器（新增 RightRail.tsx）

- 常驻右侧栏，可折叠（`⌘E` 切换），宽度可拖拽，persist 到 uiStore。
- 复用 `FileBrowser` 内核，新增 **列表/图标双模式**：
  - **列表模式**：现有树形列表。
  - **图标模式**：当前目录条目图标网格（`getFileIcon` 按扩展名着色 + 文件名），
    双击打开/预览，右键菜单复用现有 ctxMenu 逻辑。
- 模式切换按钮（`LayoutGrid` / `List` 图标）持久化。

### 4.5 StatusBar（StatusBar.tsx）

- 删除 shadow 主题分支的 **Sélectionner / Quitter** 手柄提示（68-100 右半区）。
- 保留 TK 徽标，点击改为打开 Token 统计详情面板。

### 4.6 布局骨架（AppShell.tsx）

```
Header（Ponos 品牌 + 头像 + 窗口控制）
├─ LeftRail（会话 + 运行任务）  |  Chat（聊天工作区）  |  RightRail（资源管理器）
StatusBar（连接/模型/任务/TK）
```

## 5. 品牌视觉升级（霓虹漩涡 P）

### 5.1 图标设计

- 暗底 `#0d0d11` 圆形/圆角方底 + 霓虹粉 `#ff2d94`→电青 `#1fd8f0` 渐变描边的
  「P」字母与漩涡尾迹（沿用 Header 现有漩涡意象，换主题色）。

### 5.2 产出与生成

- 产出文件：`public/icon.png`（256）、`icon-16/32/48/64/128/256.png`、
  `icon.ico`（多尺寸合并）、`logo.png`（Header/登录/驾驶舱）、
  替换 `public/shadow-theme/icon-vortex.png`。
- 生成方式：Python + Pillow 脚本绘制（仓库已有 `build/make_installer_art.py` 先例），
  统一来源避免手绘不一致。脚本放 `build/make_ponos_icon.py`，产出一键生成。

### 5.3 应用范围

| 位置 | 引用 |
|---|---|
| 窗口/托盘/通知图标 | `electron/main.cjs:177,440,531-534,785`（ICON_PATH） |
| 安装包图标 | `electron-builder.yml:93-102`（icon/installerIcon/uninstallerIcon/installerHeaderIcon） |
| Header 品牌区 | `Header.tsx:64-72`（SHADOW→Ponos + 换图） |
| 登录/驾驶舱 Logo | 新组件引用 `logo.png` / `icon-vortex.png` |

## 6. 错误处理与测试

- **错误处理**：Token 回填失败（bridge 不可达 / transcript 缺失）静默降级，不阻塞
  驾驶舱渲染；文件卡片 bridge 请求失败显示占位并允许重试。
- **测试**：
  - `tokenStatsStore` 聚合纯函数单测（`src/stores/tokenStatsStore.test.ts`，
    聚合/回填/增量幂等性）。
  - `viewStore` 状态机流转单测（boot→login→cockpit→workspace 往返）。
  - 现有全量测试 `node --test "server/*.test.mjs"` 保持通过。
  - 图标生成脚本冒烟（Pillow 输出尺寸/透明度断言）。

## 7. 范围与 YAGNI

- 不做：真实认证服务、多用户切换、路由库、独立登录窗口、远程同步。
- 预留：`authToken` / `onAuthRequired` 认证扩展点（空实现）、用户头像字段。
