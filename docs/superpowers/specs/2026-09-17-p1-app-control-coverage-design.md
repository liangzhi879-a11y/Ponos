# P1「应用智控：真正 agent 可智控 + 控制命令覆盖度量」规格与计划

- 日期：2026-09-17
- 来源：`docs/待处理清单.md:500`（P1）
- 原文要求：**应用智控功能需要真正实现agent可智控，功能要实际落实可用，网站和应用应至少70%能匹配上全量控制命令。当前面板改成以agent智能运行为主，执行命令保留但不做主要界面元素。**
- 状态：**部分完成**（本文件记录已完成部分、实测缺口与后续）

---

## 1. 需求拆解（三个可验收要点）

| # | 要求 | 可验收形式 |
|---|---|---|
| R1 | agent 真正可智控 | 模型经 `app_*` 工具能实际操作目标（工具面逐条派生自 Spec、绑定/离开即时生效、write 有审批） |
| R2 | **网站和应用 ≥70% 匹配全量控制命令** | 需要一个**可计算的覆盖率**：分母=全量控制命令，分子=真正可表达且真能执行者 |
| R3 | 面板以 agent 智能运行为主，执行命令保留但非主要元素 | 控制台默认落点=agent；命令执行降级为次级入口 |

**R2 是本项的核心难点：全仓此前没有任何"全量控制命令"的定义，也没有任何比例型度量**（`git grep 全量控制\|控制命令\|匹配率` 全仓命中仅 `docs/待处理清单.md:500` 自身）。没有定义就没有验收 —— 所以本项第一步不是写功能，而是**把定义与度量钉死**。

---

## 2. 事实基线（逐条实测，非推断）

### 2.1 agent 可智控面（R1）——已具备，瓶颈不在机制

| 事实 | 证据 |
|---|---|
| `app_*` 工具**逐条派生**自 Spec 命令（不是静态工具表） | `kernel/app-tools.mjs:60-77`：`for (const cmd of spec.commands.slice(0, MAX_COMMANDS_PER_APP))` → 每命令一个工具，`input_schema` 由 `cmd.params` 派生 |
| 每应用命令上限 40 | `kernel/app-spec.mjs:19`、`kernel/app-tools.mjs:103-108` |
| 进入卡片即可见、离开即收回 | `electron/app-bindings.cjs:40/55`（bind/unbind）→ `kernel/app-tools.mjs:53-59`（`isAppVisible`）→ `kernel/cli.mjs:793-828`（动态工具+权限规则同一时点重载） |
| write 命令审批在内核硬拦，**穿透 bypass 档** | `kernel/app-permissions.mjs:44-63`（write→`ask`，显式规则优先于档位表）→ `kernel/engine.mjs:1240` `decideToolPermission` |
| 面板手工执行**不经内核审批**，由 UI 二次确认兜底 | `AppConsole.tsx:12-14` 注释 + `:722-731` |

⇒ **结论：R1 的机制已就位。"agent 不可智控"的真实瓶颈在 Spec 能表达多少动作（R2）。**

### 2.2 控制命令面：契约与执行器的**差额**（R2 的真实缺口）

**驱动允许的 act（契约）**（`electron/app-generate.cjs:45-58`）：

| driver | act 列表 |
|---|---|
| `browser` | `goto, click, type, select, scroll, hover, js, wait, snapshot`（**9**） |
| `process` | `cli`（1） |
| `script` | `script`（1） |
| `uia` | `focus, type, key, wait`（4） |
| `http` | `request`（1） |
| `file` | `read, query`（2） |

**浏览器执行器实际支持**（`electron/browser-executor.cjs:947-965`）＝**15** 个：上述 9 个 + `back` / `forward` / `refresh` / `pause_for_human` / `resume` / `close`。

⇒ **实测差额 6 个**，分两类：
- **目标控制类（应补，执行器已支持）**：`back` / `forward` / `refresh` —— 与 `goto` 同族，模型却无法在 Spec 里写出来。
- **编排/人工接管类（应明确排除在"控制命令"之外）**：`pause_for_human` / `resume` / `close` —— 它们控制的是"我们的会话"，不是目标。

**桌面侧**：`uia` 的 4 个 act 是**契约占位、后端未接入**（`electron/app-runner-desktop.cjs:58-65` 的 `runUia` 恒返回"UI 自动化后端尚未接入"）。且 `desktopRunner` 对 uia **不校验 act**（`:100-105` 分支直接透传给桩），任意 act 都能走到那句"未接入"。

### 2.3 两处**确定性缺陷**（"功能实际落实可用"的直接反面）

| 缺陷 | 证据链 | 后果 |
|---|---|---|
| **`scroll.delta` 静默失效** | 契约要求 `ref\|delta`（`app-generate.cjs:132`）→ 但 `stepParams` **只转发 `direction`、从不转发 `delta`**（`electron/app-runner.cjs:59-70`）→ 执行器只读 `params.delta`，缺省回落 400px（`browser-executor.cjs:1132`） | 模型/用户写的滚动像素被**静默丢弃**，命令"看着跑了但没用你的值"，且不报错 —— 最难查的一类 |
| **内核 Browser 工具 schema 文案错** | `kernel/tools.mjs:1833` 写"scroll 需 `direction`"，而执行器从不读 `direction`（全仓仅 `:1132` 读 `delta`） | 模型按文案填 `direction` → 静默用 400px |

### 2.4 面板现状（R3）

- agent 已是**默认落点**（`src/lib/appsTab.ts:19`），质检进行中强制回 agent（`AppConsole.tsx:364-365`）。
- 但 `commands` 与 `agent`、`diagnose` **平级并列为主标签**（`AppConsole.tsx:411-424`），且控制台内**没有**"自动探索/一键接入"入口（只在新增应用对话框 `AddAppDialog.tsx:331`）。
- ⇒ R3 只完成了一半：默认落点做了，**界面元素降级没做**。

### 2.5 真实语料（本地现有 Spec，可作度量样本）

`~/.yfw/apps/*/spec.json` 共 **5 个真实目标**：

| appId | 名称 | driver | 目标 | 命令数 | 用到的 act |
|---|---|---|---|---|---|
| 001 | 远方数据平台 | browser | web | 6 | goto, wait, snapshot, js |
| 002 | DeepSeek 聊天控制 | browser | web | 4 | goto, wait, js |
| app-001 | 远方数据 SaaS 管理平台 | browser | web | 9 | goto, wait, snapshot, js |
| app-002 | DevLens 代码图谱 | process | desktop | 21 | cli |
| app-004 | Aseprite | process | desktop | 11 | cli |

**重要观察**：三个 web 目标里**没有一个**用到 `click/type/select/scroll/hover` —— 它们全部用 `js` 一步到位（如 `clickMenu` 是 `goto,wait,js,wait,snapshot`）。⇒ **"按 Spec 实际用到的 act 计覆盖"会得出 4/12≈33% 这种失真的数字**：能力在，只是这批命令没用到。故覆盖率必须按**能力面**（契约 ∩ 执行器）计，不能按"某个 Spec 恰好用到什么"计。

---

## 3. 定义（本项的核心产物）

### 3.1 控制命令（canonical control command）

**收录判据**：一个动作**对目标本身产生控制或读取效果**。
**明确排除**：`pause_for_human` / `resume` / `close` —— 它们作用于"我们的会话生命周期/人工接管"，不是目标控制。排除要有据：`pause_for_human` 在 `withTimeout` 里被特意豁免超时（`browser-executor.cjs:940`），语义是"把控制权交回人"。

### 3.2 全量控制命令目录（分母，按目标类别分两组）

**web（12）**：`goto`(打开) · `back`(后退) · `forward`(前进) · `refresh`(刷新) · `snapshot`(读页面结构) · `click`(点击) · `type`(输入) · `select`(下拉) · `scroll`(滚动) · `hover`(悬停) · `js`(页面脚本) · `wait`(等待)

**desktop（9）**：`cli`(命令行) · `script`(脚本接口) · `request`(本地接口直调) · `read`(读文件) · `query`(查文件字段) · `focus`(聚焦控件) · `type`(输入文本) · `key`(按键) · `wait`(等待)

分母**写死在代码里**（是契约），**不随实现缩水** —— 否则"把没实现的能力从分母里删掉"就能刷出 100%，这是本项最容易出现的自欺。

### 3.3 覆盖率

```
覆盖率(目标类别) = |{ 命令 ∈ 分母 : 契约可表达 AND 执行器可执行 }| / |分母|
```

- **可表达**：`ACTS_BY_DRIVER` 里该驱动含此 act（否则模型写不出来，校验也拦）。
- **可执行**：执行器有真实分支且后端可用（`uia` 后端未接入 ⇒ 不计入）。
- 阈值：**70%**（需求给定）。
- 报告形状：`{ class, covered, total, ratio, met, missing: [{id, reasonKey}] }`。

### 3.4 实测的现状与目标

| 目标类别 | 现状 | 本次后 |
|---|---|---|
| web | 9/12 = **75%** | **12/12 = 100%**（补 `back/forward/refresh`） |
| desktop | 5/9 = **56%** | 5/9 = **56%**（`uia` 4 个未接入，**本次不实现**） |

⇒ **web 达标；desktop 不达标，原因明确且不可绕过**：UIA 后端需要真实桌面输入/控件树能力，属 P1「computeruse工具的开发」范围（`docs/待处理清单.md:660`）。本项**如实标注、不假装可用、不把 uia 从分母里删掉**。

---

## 4. 本次范围

### 做
1. **命令目录 + 覆盖率纯函数**（唯一实现，CJS+ESM 双用）：`shared/app-control-commands.cjs` / `.mjs`。
2. **补 web 三个缺口**：`back/forward/refresh` 进 `ACTS_BY_DRIVER.browser` + `WEB_CONTRACT` + 提示词（三处同源派生，不手抄）。
3. **修两处确定性缺陷**：`scroll` 的 `delta` 转发链（并兼容旧的 `direction` 拼写）；内核 `Browser` 工具 schema 文案改为 `delta`。
4. **uia 诚实化**：`uia` 分支补 act 校验（不再任意 act 直通桩）；覆盖率把 4 个 act 记为缺失并给原因 key。
5. **度量呈现**：控制台展示覆盖率（分子/分母/缺失清单）。
6. **面板降级（R3）**：`commands` 从主标签降为页头次级入口，agent 为绝对主位；`APPS_TABS` 的持久化兼容保持不变（旧值不炸）。

### 不做（明确划界）
- **不实现 UIA 后端**（属 computeruse P1；且真机验证需要向用户**活的桌面**发键鼠输入，不可接受）。
- **不改 uia 的提示词契约清单**：`kernel-tests/app-agent.test.mjs:452-457` 明确要求 uia 驱动下发 `focus` 等 act（既有刻意不变式）；本项只在**度量**层标记不可用。
- 不引入比例型"目标级成功率"采集（需要真实网络/真机批量试跑，本轮环境不具备）。

---

## 5. 验收标准

| # | 标准 | 验证方式 |
|---|---|---|
| A1 | 覆盖率数学正确、分母不缩水 | `shared/app-control-commands.test.mjs`：web=12 分母、补后 12/12；desktop=9 分母、5/9；反向断言"不允许把 uia 从分母删掉" |
| A2 | **契约允许的 act ⊆ 执行器可执行 act**（web） | 从 `browser-executor.cjs` 源码提取 `runAction` 分支 act 集合，与 `actsFor('browser')` 对账：差额必须为 0 |
| A3 | 覆盖率报告对 5 个真实 Spec 可跑出数字 | 报告脚本/测试读 `~/.yfw/apps`（缺目录则跳过），输出 5 行 |
| A4 | `scroll.delta` 真被转发 | `kernel-tests/app-scroll-delta.test.mjs`：`stepParams({act:'scroll',delta:120})` → `params.delta===120`；旧 `direction:'up'` → 负值；内核 Browser schema 文案含 `delta` 且不含"scroll 需 direction" |
| A5 | uia 不再"任意 act 直通" | uia 驱动下未知 act → 明确报错；4 个 act 在覆盖率里记为缺失 |
| A6 | 面板 agent 主位 | `src/lib/appsTab.test.ts` + `kernel-tests/app-console-tabs.test.mjs`：主标签只剩 agent/diagnose；`commands` 由页头入口打开；旧持久化值 `'commands'` 不炸 |
| A7 | 无回归 | `npm run typecheck` + `test:unit` + 既有 `kernel-tests/app-*.mjs` 全绿 |

---

## 6. 风险与已知边界

1. **desktop 上限 56%**：不是本次可解决的（需 UIA）。已在报告与清单如实标注，**不勾选本清单项**。
2. **`direction` 兼容**：老 Spec 若写 `direction:'down'`，按 `+400` 归一（`up` → `-400`），并把归一结果落在 `delta` 上；不删 `direction` 的读取，避免旧 Spec 行为突变。
3. **面板降级**：`APPS_TABS` 保持不变（持久化兼容），仅改**渲染**——主标签条只渲染 agent/diagnose，页头提供「手工执行命令」入口切换 `commands` 面板。
4. **度量不测"命令是否真能完成业务"**：覆盖率只回答"命令面是否齐"，不回答"某站点某流程是否跑通"——后者需要真机跑，属既有质检（`app:verify` + LLM 评审）的职责。

---

## 7. 计划（bite-sized）

| Step | 内容 | 验证 |
|---|---|---|
| 1 | `shared/app-control-commands.cjs` + `.mjs` + 单测 | `node --test shared/app-control-commands.test.mjs` |
| 2 | `app-generate.cjs`：`ACTS_BY_DRIVER.browser` 补 3 个 + `WEB_CONTRACT` 补 3 条 | `node --test kernel-tests/app-generate.test.mjs` |
| 3 | `app-runner.cjs`：`stepParams` 转发 `delta`（含 `direction` 归一）；`kernel/tools.mjs` schema 文案 | `node --test kernel-tests/app-scroll-delta.test.mjs` |
| 4 | `app-runner-desktop.cjs`：uia 分支补 act 校验 | 同上 A5 |
| 5 | 覆盖率 IPC + 控制台展示 + 页头「手工执行命令」入口 + i18n | `kernel-tests/app-console-tabs.test.mjs`、`src/lib/appsTab.test.ts`、`typecheck` |
| 6 | 5 个真实 Spec 的度量报告 + 清单记录 | A3/A7 |
