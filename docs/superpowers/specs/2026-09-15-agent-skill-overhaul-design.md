# Spec：Agent / Skill 页面与功能大改（2026-09-15）

## 0. 需求原文（`docs/待处理清单.md` P1）

> agent和skill页面及功能需要大改。每个agent一张卡片，包含详细的说明，并配置**关联工具控制**。
> skill页面**收藏技能仅作卡片式置顶展示，不占用过多版面**，主体skill卡片做好**父级子级skill分类浏览**，
> 每张卡片注明skill详情，展开可**管理触发规则**，**管理关联脚本**。
> agent和skill要有明显的**注册和关闭开关**，用户随时可停止相关agent和skill是否能被运行agent调用。

拆成四条可验收的条款：

| 条款 | 目标 |
|---|---|
| A 卡片化 + 工具控制 | Agent 页每张卡含详细说明；卡片上可直接配置该 agent 的**工具可见范围**并持久化生效 |
| B 收藏降噪 | 收藏（pinned）技能只在顶部以小卡展示，不占据主体版面 |
| C 分类 + 详情 + 展开管理 | 主体技能**父级/子级两层分类**浏览；卡片注明详情；展开可管**触发规则**与**关联脚本** |
| D 注册/关闭开关 | Agent 与 Skill 均有显眼的启用/停用开关，**立即决定内核是否还能调用它** |

## 1. 现状锚点（源码核对）

### 1.1 Agent 侧

| 事实 | 坐标 |
|---|---|
| 数据模型已含全部所需字段：`tools: string[]`、`skills: string[]`、`enabled: boolean`、`whenToUse` | `src/lib/agents.ts:1-21` |
| 内置/专业 agent 清单（tools 用自然语言串表达："All tools"、"All tools except Agent, Edit, Write"） | `src/lib/agents.ts:24-60` |
| Agent 页：卡片列表 + 搜索/筛选 + 启用开关 + `TagEditorField`（标签编辑器） | `src/components/agents/AgentsPanel.tsx` |
| 创建/编辑走 `AgentEditDialog`，字段含工具输入 | 同文件 |
| 落盘：`electron/main.cjs` 的 `agents:sync` 把 agent 写为 `.md`（frontmatter 含 workflows） | 见 `Agent` 注释 `src/lib/agents.ts:14-16` |
| 内核按 `agentId` 过滤 bound 工作流 | `kernel/cli.mjs` 等（S5/S6 已落地） |

**缺口（A/D）**：`tools` 目前是"自由文本串列表"，用户改它只能靠猜（`All tools except Agent, Edit, Write` 这种句式无校验、写错即静默失效）；`enabled` 开关是否真的让内核拒绝调用该 agent，需要落到内核侧证据。

### 1.2 Skill 侧

| 事实 | 坐标 |
|---|---|
| 技能发现：`fetchSkills(projectRoot, setSkillsDir)` + `SkillEntry` | `src/lib/skills.ts`；`src/components/skills/SkillsPanel.tsx:96-100` |
| 收藏：`pinnedSkills` / `togglePinSkill`，上限 10，超限广播 `yfworking:pin-limit` | `SkillsPanel.tsx:24-40`；`src/stores/uiStore.ts` |
| 分类：`skillFolders` / `skillFolderMap` + **默认启发式**（`gxtz-/yfwdoc-/yfwweb-/yfwx-` → Working，其余 → Coding） | `SkillsPanel.tsx:62-76` |
| 展开态：`expanded` 记录 | `SkillsPanel.tsx:20` |
| 安装/卸载：`/install-skill`、`/uninstall-skill` 桥接口 | `SkillsPanel.tsx:102-140` |
| 内核技能注入：`skillsDirs`（`--skills-dir` 可多次）+ `join(configDir,'skills')` → `flatSkillRoots` → `createToolRegistry({ skillsDirs })`；技能名列表进提示词 | `kernel/cli.mjs:92,160,306,442,657` |

**缺口（B/C/D）**：
- 收藏区与主体区在**同一版面**竞争（收藏多时主体被挤压）——条款 B 要求收藏降为顶部小卡。
- 分类是"文件夹分组"（用户可改名），**不是父子两层**（Working/Coding 下再无层级；`gxtz-` 这类前缀关系没有体现为父子）。
- 卡片展开目前只有详情文本，**没有触发规则与关联脚本的管理位**。
- **技能没有 enable/disable 开关**，更没有"停用后内核不再加载该技能"的通道（D 条款在 skill 侧完全缺失）。

## 2. 关键结论

1. **D 条款（开关）是本轮的核心价值，也是最容易被做成"假开关"的一条**：只在 GUI 隐藏、内核照旧能加载 = 用户以为停了、实际还在被调用。故开关必须有**内核侧证据**（真进程测试：停用后提示词里不再出现该技能、`Skill` 工具不再能调用）。
2. **A 条款的工具控制要"可校验"**：现有自由文本句式（`All tools except ...`）必须给出**结构化编辑**（从真实工具清单里选），否则"配置"等于制造配置错误。工具清单的权威源在内核（`createToolRegistry` 的工具名集合），GUI 侧需要一份可展示的清单（与内核同源或镜像 + 漂移守卫）。
3. **C 条款的分类要"确定性"**：父/子两级若靠前缀启发式（`gxtz-*` → 父 `gxtz`），对用户自定义技能不成立。需要**显式声明优先、启发式兜底**的两级模型（显式声明落在技能清单文件，启发式只作缺省，且缺省必须**可见可纠正**）。
4. **触发规则/脚本的管理 = 写技能文件**（`SKILL.md` frontmatter 的 description/触发词、技能目录下的脚本）。这是**写通道**，必须与只读浏览分级：默认只读展示 + 打开文件；应用内编辑属于独立能力（权限、备份、格式保真都有风险），须单独决定。
5. **开关的作用域要一次定清**（全局 vs 按会话）：范围越大，后端与持久化越复杂。若做成"全局禁用 + 会话内可临时启用"，则回到 S3 的"会话范围"模型（与本轮刚完成的会话知识范围同构，可复用思路）。

## 3. 待确认的设计决策（本轮实现前必须敲定）

| # | 决策 | 选项 | 影响面 |
|---|---|---|---|
| D1 | 技能父/子两级的口径 | ① 按目录/前缀自动分层（零配置，可能猜错）② 显式声明优先 + 启发式兜底（推荐）③ 纯手工分组（最准，需用户维护） | `src/lib/skills.ts` 解析、`SkillsPanel` 渲染、uiStore 持久化 |
| D2 | 「管理触发规则 / 关联脚本」的深度 | ① 只读展示 + 系统打开文件（零风险）② 应用内编辑触发规则（写 `SKILL.md` frontmatter）③ 应用内编辑 + 脚本编辑（风险最高） | 桥写通道、备份、格式保真、审计 |
| D3 | 开关作用域 | ① 全局（禁用后所有会话都不加载）② 仅当前会话 ③ 全局默认 + 会话覆盖（最灵活、最复杂） | `uiStore`/`agentStore` 持久化、桥透传、内核加载过滤 |
| D4 | 交付批次 | ① 先 A+D（开关与工具控制，可验证性最强）再 B+C（版面与分层）② 先 B+C 再 A+D ③ 一次全做 | 每批次都要独立可验收 |

## 4. 无论选哪条都要守的验收纪律（先写死，避免"假功能"）

1. **开关的内核证据**：真进程测试——停用某技能/agent 后，① 提示词不再出现它；② 相关工具调用被拒（技能）或被路由排除（agent）；③ 重新启用后恢复。
2. **工具控制的结构化**：GUI 产出的工具配置写回后，内核按它收窄；非法组合（如把 `Skill` 从所有 agent 移除却仍期望调用技能）在保存时就应提示，而不是运行时报错。
3. **零回归**：`npm run typecheck` + `kernel-tests/*` + `server/*` + `src/**/*.test.ts` 全绿；既有 agent/skill 行为（内置 5 个 agent、技能安装/卸载、收藏上限）不变。
4. **持久化可迁移**：新增字段必须带 zustand 版本迁移（本仓库已有 v3→v4 先例），且**不得重建既有统计字段**（S3 会话范围一役的教训：迁移只补字段）。
5. **未知参数静默失效的病史**：任何新增的"GUI → 桥 → 内核"键，两端必须同改 + 静态守卫测试（本轮会话知识范围已确立该纪律）。

## 5. 附着风险（提前记录）

| 风险 | 说明 | 缓解 |
|---|---|---|
| 技能停用与"技能内脚本被显式调用" | 用户可能用 Bash/Read 直接跑技能脚本，绕开开关 | 开关语义限定为"**不再被 agent 自动调用/注入**"，不承诺阻止用户手动执行（写进 UI 文案） |
| 编辑 `SKILL.md` 破坏格式 | frontmatter 被写坏会导致技能整体不可用 | 若选 D2-②：写前备份 + 解析失败拒绝写入 + 只改已知键 |
| Agent 工具配置与内核实际工具名漂移 | 名字写错 = 该工具静默消失 | 工具清单以内核为准（导出清单 + 漂移守卫测试） |
| 分类启发式误判 | 技能被放进错的父级，用户找不到 | 显式声明优先；UI 展示"为何在此分组"并允许一键纠正 |

## 6. 决策确认（2026-09-15，用户答复）

| # | 决策 | 用户选择 | 落地含义 |
|---|---|---|---|
| D1 | 分层口径 | **② 显式声明优先 + 前缀启发式兜底** | 技能若在 `SKILL.md` 里声明了父级则用之；否则沿用现有 `gxtz-/yfwdoc-/yfwweb-/yfwx-` 前缀启发式。→ 批次二（B+C） |
| D2 | 触发规则/脚本管理深度 | **① 只读展示 + 系统打开文件** | 应用不写 `SKILL.md`；"打开文件"交给系统默认程序。零格式风险，无备份/审计负担。→ 批次二 |
| D3 | 开关作用域 | **① 全局禁用** | 停用后**所有会话**都不加载/调用。→ **本批次（D），已实现** |
| D4 | 交付批次 | **① 先 A+D，再 B+C** | 本批次交付 A（卡片 + 工具控制）与 D（开关）；B+C 待下批 |

## 7. 批次一（A + D）实现记录 — 已完成

### 7.1 D 条款：Agent / Skill 全局停用

**落点选择**：`<configDir>/disabled.json`（内核 `configDir` ≡ 桥的 `YFW_HOME`）。
不用 spawn 参数的理由：全局语义与"每会话透传"不匹配，而本仓库已有 `--spaces`/`--confirm`
两次"漏登记被内核静默忽略"的事故——少一条链就少一处静默失效点。

| 环节 | 文件 | 关键点 |
|---|---|---|
| 注册表 | `kernel/disabled.mjs`（新） | 读极宽容（坏文件 → 退化为"不停用"，`ok=false` 出声）；写**原子替换 + 回读校验**（半截 JSON 会让内核读成"全开"） |
| 消费 ① 提示词 | `kernel/cli.mjs` | `excludeDisabled(discoverSkills(...))` —— 同时决定提示词技能清单与 `skillIds`（工具池口径） |
| 消费 ② 工具 | `kernel/tools.mjs` | `Skill` 工具按名调用判停用（防模型沿用历史对话直调的后门）；"技能不存在"的可用清单同口径 |
| 消费 ③ agent | `kernel/agents.mjs` `resolveAgents` | **函数内自读**注册表：多调用点靠传参迟早漏一个；内置 agent 同样可停（原先硬编码不可停） |
| 汇聚点 | `kernel/skills.mjs` `discoverSkillsAll` | 过滤放这里 ⇒ 提示词与工具池自动一致；缺省不过滤（公开口零回归） |
| HTTP | `server/disabled-routes.mjs`（新）+ bridge | 纯 handler（仓库纪律：测试不起 bridge）；**PUT 只改传入的键**（跨面板不互相清空） |
| GUI | `src/lib/disabledApi.ts`、`src/stores/disabledStore.ts`（新） | 乐观更新 + **失败回滚**（留在"已停用"界面就是假开关） |

**已知边界**：停用 = 不再被 agent 自动加载/注入/调用；**不阻止**用户自行用 Bash/Read 执行技能目录里的脚本（已写进 UI 文案，见 `skills.disableHint`）。

### 7.2 A 条款：Agent 卡片 + 工具控制（附带修掉一个静默缺陷）

**发现的既存缺陷**（本条款的意外收获，严重度高于预期）：
`Agent.tools` 一直是自然语言句式（GUI 写 `'All tools except Agent, Edit, Write'`），
而 `engine.mjs` 把它当**具体工具名数组**用；原 `parseAgentMarkdown` 按逗号 split，那句子被切成
`['All tools except Agent','Edit','Write']`，engine 的"名单里只要有一个认识的名字就不重置"守卫
因 `Edit`/`Write` 恰是真实工具名而**不生效** ⇒ 该 agent 最终只剩 **Edit + Write**：
一个"不会读文件、只会改文件"的 agent，**全程无报错**。

| 修复 | 文件 | 关键点 |
|---|---|---|
| 声明解析 | `kernel/agents.mjs` `parseToolsSpec` / `parseSkillsSpec` | 支持 `All tools` / `All tools except A, B` / 显式清单；数组写法等价；`disallowedTools` 与 except 项**合并** |
| 车道收窄 | `kernel/agents.mjs` `resolveLaneTools` + `engine.mjs` | 从 engine 内联逻辑抽成纯函数（原先无法单测，正是缺陷长期未被发现的原因）；三分支：空白名单=不收窄 / 全不认识=退回不收窄 / 只禁不白=全量−禁用集 |
| GUI 结构化模型 | `src/lib/agentTools.ts`（新） | 三态（全部 / 全部（除…）/ 仅选中的）+ 工具目录分组 + 与内核同语义的 parse/format + **漂移守卫**（对账内核注册表 21 个工具名） |
| GUI 组件 | `src/components/agents/AgentToolsEditor.tsx`（新） | 卡片内可见摘要 + 只读徽标 + 展开编辑；未知名字**出声**（内核会退回"不限制"，界面不能装作已收窄） |
| store | `src/stores/agentStore.ts` `setAgentTools` | 对**任何**类型 agent 生效（原先 `updateAgent` 仅限 `custom`，专业 agent 的工具控制完全不可改） |

### 7.3 验收证据

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | ✓ |
| 内核：注册表 | `node --test kernel-tests/disabled-registry.test.mjs` | 8 pass |
| 内核：**真进程 e2e** | `node --test kernel-tests/disabled-e2e.test.mjs` | 5 pass（技能停用/不误伤/容错/**恢复**/agent 停用） |
| 内核：接线守卫 | `node --test kernel-tests/disabled-plumbing.test.mjs` | 9 pass |
| 内核：工具声明 | `node --test kernel-tests/agent-tools-spec.test.mjs` | 10 pass |
| 桥：路由行为 | `node --test server/disabled-routes.test.mjs` | 9 pass |
| 桥：接线守卫 | `node --test server/disabled-route.test.mjs` | 4 pass |
| GUI | `node --test src/lib/agentTools.test.ts src/lib/disabledApi.test.ts` | 11 + 10 pass |

**真进程证据的口径**（最重要的一条）：`kernel-tests/disabled-e2e.test.mjs` spawn 真内核 +
mock API，用系统提示探针直接观察"模型还能不能看到它"——不是"函数返回了正确数组"。
初版曾误用 `ANCHOR_PROBE`（只看非 system 条目）导致基线假红灯：agent 表在**系统提示**里，
故必须用 `SYS_PROBE`。这条教训记在测试文件头注里。

### 7.4 待办（批次二 B+C）

- B：收藏降为顶部小卡；技能卡片信息密度调整。
- C：父子两级分类（D1=显式声明优先 + 前缀启发式兜底）、卡片详情（D2=只读 + 系统打开）、展开管理。
- C 批次需要把 `SKILL.md` 的父级声明纳入解析（`src/lib/skills.ts`），并给 `SkillsPanel` 的
  `skillFolders`/`skillFolderMap` 启发式加"为何在此分组"的可解释提示。

