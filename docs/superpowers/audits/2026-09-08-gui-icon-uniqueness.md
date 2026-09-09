# GUI 图标唯一性审计表（Task 15 收口门）

- 日期：2026-09-08（Task 15，onboarding + cockpit + work 重构流水线最后一个实现任务）
- 范围：全 `src/` lucide-react 图标使用盘点，对照 spec §8.2「图标即语义」契约逐 hotspot 裁决
- 基线 commit：`ce4814d`（Task 1-14 已完结）；本审计对应 Task 15 提交（直接落 HEAD 之上）
- 产出文件：本审计 md + `src/i18n` 清理 + 3 处图标冲突组件修正
- 配套报告：`.superpowers/sdd/2026-09-08-gui-onboarding-cockpit-redesign/task-15-report.md`

---

## 1. 契约（spec §8.2，需求侧原文要点）

「每个语义动作一个图标」：rail 四类别入口、新建任务、新建对话、文件浏览、历史、工作树、用量、
返回驾驶舱、设置各用唯一图标；badges 区分靠色不靠图标；status dot 例外；Chevron 类仅作展开/收起
指示（非功能图标，允许）；rail 底部不放设置入口（设置仅 Header 齿轮）；无 emoji。

| 语义动作 | 契约图标 | 允许的域内同实体复用点 |
|---|---|---|
| 对话类别入口 | MessageSquare | 会话列表/搜索结果行/历史标题行/空态（均指「会话」实体） |
| 任务类别入口 | SquareKanban | 任务空态装饰（同「任务」语义） |
| 智能体类别入口 | Bot | 智能体标题/助手/系统角色头像/warning agent_spec（均指「AI 实体」身份） |
| 技能类别入口 | Puzzle | 设置技能子页/技能设置头（同「技能」语义） |
| 新建对话 | MessageSquarePlus | —（勿被「排队插话」跨义借用） |
| 新建任务 | SquarePlus | — |
| 会话集容器 | Folder | 移动至会话集子菜单行（同「容器」语义） |
| 文件浏览入口/目录 | FolderOpen | 目录展开态/工作目录 chip（同「文件夹/目录」语义） |
| 历史入口/内容 | History | — |
| 工作树 | GitFork | 工作树面板头（同「工作树」实体） |
| 用量 | Gauge | 仅 usage 语境（豁免：条目+面板头同义） |
| 返回驾驶舱 | Home | 现由 logo 承担；Home 仅文件系统根（FileBrowser/DirectoryPicker） |
| 设置 | Settings | 仅 Header 齿轮 + SettingsView 自标题 + CommandPalette「打开设置」命令行（均同一「打开设置」动作，同动作复用） |
| 搜索 | Search | 通用检索动作，全库一致（豁免） |

## 2. 盘点方法

- `lucide-react` import + JSX 使用点全量 grep（快照于 2026-09-08，HEAD `ce4814d` + 工作区修改）。
- 裁决规则：按「语义动作」而非「形状」分组；同一实体/身份的域内复用允许，异义复用必须换图标；
  泛用字形（Search、Plus 带文字标签的新建入口、Chevron、status 色点）豁免。
- 使用点行号以最终工作区为准（含本任务修正后）。

## 3. 全库按语义动作的使用清单

> 表内「→」条目为本任务修正（见 §5 mapping）。

### 3.1 rail 四类别入口（railMeta.RAIL → RailNav 渲染）
- `src/components/layout/railMeta.ts` RAIL（22-27 行声明）：MessageSquare / SquareKanban / Bot / Puzzle。
- `src/components/layout/RailNav.tsx` 24-42：`<Icon>` 动态渲染，每类入口各一枚。

### 3.2 会话/任务实体（允许同实体复用）
- MessageSquare：`ChatListPanel.tsx:39`（空态）、`SearchDialog.tsx:116`（结果行）、`HistoryView.tsx:148`（预览行）。
- SquareKanban：`TaskListPanel.tsx:347`（空态装饰）。
- MessageSquarePlus：`ChatListPanel.tsx:42`（空态新建对话钮）。任务侧 SquarePlus：`TaskListPanel.tsx:350`（空态新建任务钮）+ PanelToolbar 主操作（`newLabel`）。

### 3.3 AI 实体身份（Bot，允许）
- `AgentsPanel.tsx:191` 标题；`MessageBubble.tsx:409` 助手角色头像 fallback；`HistoryView.tsx:153/210` 统计与行；
  `SystemWarningStrip.tsx:14` agent_spec 警告图标（Bot）。
- Bot 与「智能体列表」同一 AI 实体身份 → 允许；非异义复用。

### 3.4 技能实体（Puzzle）
- rail 入口（railMeta）+ `SettingsView.tsx:898` 技能子页头 → 同「技能」语义，允许。

### 3.5 次级浮层四入口（任务面板工具栏，TaskListPanel.tsx 74-77）
- 文件浏览=FolderOpen（74）、历史=History（75）、用量=Gauge（76）、工作树=GitFork（77）。
- 内容面板头同实体：`UsagePanel.tsx:94` Gauge、`WorktreePanel.tsx:107` GitFork → 豁免（同义实体）。

### 3.6 Folder/FolderOpen 家族（文件夹/目录语义）
- 目录树行（展开/闭合两态）：`FileBrowser.tsx:154`、`DirectoryPicker.tsx:115/169`。
- 文件系统根 Home：`FileBrowser.tsx:175`、`DirectoryPicker.tsx:125`（FS root 回主目录，豁免）。
- 工作目录 chip：`ChatWindow.tsx:278`、`MessageBubble.tsx:177`、`SubAgentPanel.tsx:117`。
- 技能目录行：`SettingsView.tsx:907`、`SkillsPanel.tsx:282/476`。
- 打开日志目录：`DiagnosticPanel.tsx:127`。
- **会话集容器：`TaskListPanel.tsx:387`（集行）与 630（移动至集子菜单）→ 本任务 FolderOpen→Folder 修正（见 §5 #1）。**

### 3.7 Settings（设置字形——契约限定）
- Header 齿轮：`Header.tsx:132`（唯一旁路入口）。
- `SettingsView.tsx:49` 自标题同字面（面板标题，非第二入口）→ 允许。
- 其余一律禁用 Settings 字形：原 `AgentsPanel.tsx` 重置全部按钮 → RotateCcw（§5 #3）。
- CommandPalette.tsx「打开设置」命令行同为 Settings 字形 = 与 Header 齿轮同动作（打开 SettingsView）→ 同动作复用豁免（§4 e）。

### 3.8 插话（排队）动作
- `ChatInput.tsx:730` → 本任务 MessageSquarePlus→MessageCirclePlus（§5 #2）。

### 3.9 泛用/豁免字形（不裁决）
- Search：全库一致（ChatListPanel/TaskListPanel/AgentsPanel/SkillsPanel/UsagePanel/SearchDialog…）。
- Plus 带文字标签（实体特定新增）：AgentsPanel:139/211、SkillsPanel、SettingsView、TaskListPanel:635 新建会话集子项、WorktreePanel。
- Chevron（Right/Down）为展开/收起指示；Pin/Trash2/Edit3/Share2/Download/RefreshCw/ArrowUpDown/
  Wand2（自动整理）/StopCircle/Zap/Mic/X/Copy/Check 等为各自唯一动作字形，盘点无跨义复用。
- RotateCcw 为「回退/旋转箭头」字形族：MessageBubble:468（重试 regenerate，Tooltip "Retry"）、
  AgentsPanel:220（重置默认，本任务新增）、AvatarCropDialog:153（重置裁剪视口：scale 归 1、位置归位，
  非图像旋转）——语义不同但同属 circular-arrow 族，各使用点均带文字/aria/tooltip 标签、无同面歧义；
  controller 裁决允许共享该字形族，不按「唯一动作字形」对待。

## 4. Controller scope hotspot 裁决（a-f）

| # | hotspot | 证据（使用点） | 裁决 |
|---|---|---|---|
| a | MessageSquare（4 处） | ChatListPanel 空态、SearchDialog 结果行、HistoryView 预览行、rail 入口 | 均指「会话」实体 → 允许（同实体复用） |
| b | SquareKanban | rail 入口 + TaskListPanel 空态 | 同「任务」语义 → 允许 |
| c | Bot（列表 vs 角色） | AgentsPanel 标题/行、MessageBubble 角色头像、HistoryView 统计、SystemWarningStrip agent_spec | 均指「AI 实体身份」同一语义族 → 允许 |
| d | Gauge | TaskListPanel:76 浮层入口 + UsagePanel:94 面板头 | 仅 usage 语境 → 豁免（usage-only） |
| e | Settings | Header:132、SettingsView:49 自标题、CommandPalette「打开设置」命令行（与 Header 同动作）；**AgentsPanel 重置全部按钮 = 冲突** | AgentsPanel → RotateCcw；Header+SettingsView+CommandPalette open-settings（同动作复用）保留 |
| f | Search | 全库检索统一字形 | 通用动作 → 允许 |

## 5. 图标冲突修正映射表（3 处 + 注释固化）

| # | 组件 / 原图标 | 位置 | 换为 | 理由 |
|---|---|---|---|---|
| 1 | TaskListPanel.tsx 会话集行 FolderOpen / 移动至集子菜单 FolderOpen | 387 / 630 | Folder（闭合文件夹） | 同面板内 FolderOpen=「文件浏览」浮层入口；会话集是「容器」语义，同面板勿跨义复用（Folder 已代表闭合容器） |
| 2 | ChatInput.tsx 排队插话 MessageSquarePlus | 730 | MessageCirclePlus | 与新对话 MessageSquarePlus 同屏（输入条 vs rail 面板可同时可见），圆/方泡区分；MessageSquarePlus 契约保留给「新建对话」 |
| 3 | AgentsPanel.tsx 重置全部 Agent 齿轮 Settings | 220（导入 3） | RotateCcw | §8.2 设置字形仅 Header 齿轮；重置=「回退默认」，RotateCcw 语义更准 |

注释已就地固化（railMeta.ts 头部、TaskListPanel.tsx:386、ChatInput.tsx:729、AgentsPanel.tsx:219），
防后续任务回归；railMeta.ts 头部指向本审计 md。

## 6. i18n 清理（Step 2）

删除「零消费」键（全仓 grep 证据：仅剩注释内字面，代码 `t(...)` 消费为零）：

- `header.toggleSidebar`（zh/en）——必删；代码内 Header 齿轮 tooltip 已不再引用。
- `sidebar.chats / sidebar.agents / sidebar.skills / sidebar.newChat`（zh/en）——零消费。
- `settings.providerEffortLevel`（zh/en）——T12/T13 迁至全局 `settings.effortLevel` 后无消费。
- **保留** `commandPalette.cmd.toggleSidebar / toggleSidebarDesc`：`CommandPalette.tsx` 中 command 注册行仍引用。
- **保留核对通过**：`rail.*`（RailNav/TaskListPanel/ChatListPanel 消费）、`sessionMode.*`（SessionModeBar）、
  `effort.*`（SettingsView + EffortPicker）、`auth.*`（AuthScreen/SetupWizard/PasswordField）、
  `warnings.*`（SystemWarningStrip）、`usage.*`（UsagePanel）、`sidebar.*` 剩余键（TaskListPanel 大量消费）。

## 7. 回归记录（Step 3）

### 7.1 Gates（全部实际运行，全绿）
- `npm run typecheck` → exit 0。
- `npm run test`（server/*.test.mjs + electron/*.test.mjs）→ 156/156 pass。
- `node --test src/stores/viewStore.test.ts src/lib/chatModeUi.test.ts src/lib/effortUi.test.ts` 及 lib 单测 → 59/59 pass。
- `npm run build` → 成功。

### 7.2 dev 冒烟（isolated vite :5199，fresh origin，store 驱动，zh + en-US）
- rail 四切换渲染正确图标；空态任务=square-kanban、空态对话=message-square。
- 工具栏四枚次级图标文件/历史/用量/工作树齐全。
- 会话集行 DOM=`lucide-folder`；移动至集子菜单行=Folder。
- AgentsPanel 重置=`lucide-rotate-ccw`；命令面板关闭态页面唯一 `lucide-settings`=Header 齿轮（面板打开时其「打开设置」命令行同字形 = 同动作复用，§3.7/§4 e）。
- 排队插话（streamingConversations 模拟）=`lucide-message-circle-plus`。
- 四浮层（文件/历史/用量/工作树）打开、标题正确。
- en-US 切换无 raw-key 回退；`sidebar\.|header\.|providerEffortLevel` 正则负检通过。
- 命令面板保留 toggle-sidebar command（按 scope 保留）。
- cockpit↔work 往返 + `yfworking-view` persist（workState.rail='task'）reload 校验通过。

### 7.3 环境限制（如实记录，未虚报通过）
- 沙箱 rAF 抑制 → framer-motion `onAnimationComplete` 不触发：logo morph 动画无法自动收尾
  （渲染存在性已验证，动画完成态不可观测）→ 记为 env-limited，非本任务改动点。
- 冷启动认证小窗编排（首设/登录/锁定 → 放行 → boot → cockpit）需真实 Electron 窗口 + auth 后端联动，
  沙箱内不可运行；以组件渲染 + server/electron 测试套件覆盖代替，冒烟清单第 1 条部分记为 env-limited。

## 8. 结论

- 契约全表核对完成：无跨义图标残留；3 处冲突已修并记录映射；i18n 零消费键已删、保留键齐全。
- 交付基线（§8.2 + task-15 brief Step 1-3）达成；环境限制项见 §7.3。
