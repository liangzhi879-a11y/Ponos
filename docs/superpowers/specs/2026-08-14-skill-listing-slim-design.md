# Skill 披露瘦身与层级化设计（宿主 triggers 优先 + subskill 系统化 + 版本剥离）

日期：2026-08-14
状态：已确认（brainstorming 完成）

## 1. 背景与量化

Ponos 的 skill 系统存在**双套清单并存的重复注入**，且 63 个技能**全平铺披露**、父子关系不可见：

| 注入源 | 载体 | 现状体积 | 职责 |
|---|---|---|---|
| 宿主清单（`server/bridge.mjs` `appendSkillList`） | 系统提示词文件，**每轮常驻** | **11,073 字符**（description 截断 200/项，无总量预算） | 主会话技能发现 + 强制调用指令 |
| 内核清单（`ponos-kernel/claude-code/src/utils/attachments.ts` `getSkillListingAttachments`） | turn-0 `skill_listing` attachment；子代理按 agentId 各注入一份 | 11,566 字符（250/项截断 + 1% 窗口预算） | 主会话 turn-0 发现 + 子代理唯一技能来源 |
| 调用时全文注入（`SkillTool.call`） | 对话历史（`invokedSkills` 跨压缩存活） | 单技能 2KB–313KB | 技能执行本体 |

- 宿主清单占宿主系统提示词总量的 **71%**
- 63 个技能全平铺，5 组父子关系仅靠 SKILL.md 正文叙述约定（无结构化声明）：
  - `yfwdoc-suite` → word/pptx/pdf/excel/template（总路由懒加载）
  - `yfwweb-suite` → scrape/form/verify
  - `yfwx-suite` → qualification-chain/kexiao/zhuanjingtexin/xiaojuren/dengling/unicorn（seal-extract 现状独立，目标态归入）
  - `gxtz-core-tables` → rd-tables/ps-tables/ip-tables/toai-tables（仅表格部分）
  - `executing-plans` → `REQUIRED SUB-SKILL` 引用
- 父技能 description 已重复列出子技能名（如 yfwdoc-suite 的 description 含全部 5 个子技能名），清单重复度高
- `description` 内嵌版本更新日志合计 **1,401 字符**（占清单 ~12%），对技能识别零价值
- frontmatter `triggers` 字段：36/63 技能有（平均 6.6 个/技能），是比 description 更短的纯调用信号

## 2. 目标与非目标

### 目标
1. **subskill 系统化**：父子技能关系从叙述约定升级为结构化 frontmatter 声明（`parent`/`subskills`），清单按层级渲染
2. **清单只披露父技能**：agent 索引技能只能看到父技能（5 条）+ 少量独立技能（6 条），共 **11 条**；子技能经父技能 SKILL.md 索引
3. 宿主清单从 ~11K 瘦身到 **~2-3K 字符**（父条目聚合触发词 + 内联子技能名 + 版本剥离）
4. 内核清单剥离版本历史 + 层级渲染（隐藏子条目、父条目内联子技能名）

### 非目标（红线，改动后仍须成立）
- **子技能必须仍可被 Skill 工具调用**（父技能索引后调用；SkillTool 调用走 `getAllCommands` 全量查找，不受清单渲染过滤影响——已验证）
- **全部技能名一个都不能丢**：父技能与独立技能独立成条，子技能名内联在父条目（模型调用入口与索引前提）
- **强制调用指令前缀【已安装技能清单】… 不能丢**
- **调用时全文注入 + invokedSkills 跨压缩存活——完全不动**（技能执行本体）
- 内核的 1% 窗口预算、按 agentId 子代理注入——**保持不变**（渲染内容变化，机制不变）
- 仅一层父子层级（不支持嵌套；gxtz 系列全部一级归 gxtz-suite，含 core-tables）
- **不使用官方 `disable-model-invocation`**（Ponos 内核用它同时禁止模型调用：`getSkillToolCommands:571` 过滤 + `SkillTool.ts:412` 拒绝，与"隐藏描述但保留调用"需求冲突）

## 3. 架构：职责分层（三级）

```
主会话（每轮）     宿主清单（仅父技能 + 独立技能，聚合触发词 + 子名内联）   ~2-3K 字符
主会话（turn-0）   内核清单（同上层级，desc 250 截断 + 子名内联，1%预算）   ~4-6K 字符
子代理（每 agent） 内核清单（同上）                                       各 ~4-6K 字符
调用时             SKILL.md 全文注入（invokedSkills）                    不变；子技能可调
```

模型发现路径：清单（父技能）→ Skill 调用父技能 → 父技能 SKILL.md 全文注入（含子技能目录表）→ 按需 Skill 调用子技能。

## 4. subskill 系统化

### 4.1 frontmatter 声明规范

```yaml
# 子技能声明其父技能（仅一层，无嵌套；父技能不得再有 parent）：
parent: gxtz-suite

# 父技能声明其子技能列表（可选，清单内联展示用；与子技能 parent 互逆一致）：
# 统一用多行 "- " 列表语法（与 triggers 同构，复用同一解析函数）：
subskills:
  - gxtz-rd-report
  - gxtz-ip-materials
  - gxtz-core-tables
```

- `parent`：值为已存在的父技能名；父技能本身不得有 `parent`
- `subskills`：值为子技能名多行列表；列出的每个子技能必须声明 `parent` 指向本技能
- **互逆一致性**：父技能 `subskills` 集合 = 声明了该父 `parent` 的子技能集合（校验脚本保证）
- **二级协调者**：带 `subskills` 的技能若同时有 `parent`（如 gxtz-core-tables 归 gxtz-suite 后仍保留其 tables 子集声明），其 `subskills` 仅供正文使用、**不参与清单层级**——清单只认一层 `parent`，该技能作为普通子技能归入其父
- 独立技能：无 `parent` 也无 `subskills`
- 解析失败/无该字段 → 视为无

### 4.2 父技能清单与技能分类（64 目录 = 63 现有 + 1 新制）

**父技能（5 条，清单披露）：**

| 父技能 | 状态 | 子技能（parent 归属） |
|---|---|---|
| `gxtz-suite` | **新制** | 23 个 gxtz-*：achievement-materials、audit-verification、contract-review、core-tables、experience-sync、file-compressor、file-organizer、info-collector、innovation-statement、invoice-ps-matching、ip-materials、ip-tables、management-materials、precision-refiner、progress-manager、ps-materials、ps-tables、rd-report、rd-tables、staff-materials、submission-packager、toai-tables、wecom-collector |
| `yfwdoc-suite` | 已有改造 | word、pptx、pdf、excel、template |
| `yfwweb-suite` | 已有改造 | scrape、form、verify |
| `yfwx-suite` | 已有改造 | qualification-chain、kexiao、zhuanjingtexin、xiaojuren、dengling、unicorn、seal-extract |
| `using-superpowers` | 改造为父 | brainstorming、code-review-and-quality、dispatching-parallel-agents、example-skill、executing-plans、finishing-a-development-branch、receiving-code-review、requesting-code-review、subagent-driven-development、systematic-debugging、test-driven-development、using-git-worktrees、verification-before-completion、writing-plans、writing-skills |

**独立披露（6 条，保留在清单）：** context7、find-skills、frontend-design、shadcn、tailwindcss、ui-ux-pro-max

清单合计 **11 条**（5 父 + 6 独立），其余 53 子技能从清单隐藏。

### 4.3 聚合触发词

- 父技能 `description`（宿主触发词来源）**聚合全部子技能的触发场景**——脚本从子技能 triggers 聚合去重生成初稿，人工审定后写入父技能 description
- 父技能正文含**子技能目录表**（名字 + 一句话职责 + 触发场景），供模型索引后选择
- 子技能自身 frontmatter 不变（triggers/description 保留，供父正文聚合与调用上下文使用）

### 4.4 校验脚本

`scripts/verify-skill-listing.mjs` 扩展以下断言（宿主清单改造验证同脚本）：
- 每个 `parent` 指向的父技能存在
- 父技能 `subskills` 与子技能 `parent` 互逆一致（双向核对）
- 父技能无 `parent`；独立技能无 `parent`/`subskills`
- 清单条目数 = 父技能数 + 独立技能数；子技能名全部出现在对应父条目内联或父正文

## 5. 宿主清单改造（`server/bridge.mjs`）

### 5.1 frontmatter 解析扩展

- 现状：`listInstalledSkills()` 正则仅取 name/description（`.slice(0, 200)`）
- 本次新增解析：triggers（多行 `- ` 列表）、`parent:`（单行，`/^parent:\s*["']?(.+?)["']?\s*$/m`）、`subskills:`（多行列表，复用 triggers 的行清洗——去 `- ` 前缀/引号/空白、过滤空行）
- 解析失败/无该字段 → 空值

### 5.2 清单条目拼装

每个**无 parent** 的技能生成一个条目；有 parent 的技能**不生成条目**：

```
父技能：  - {name}：{聚合触发词，截断 80}{（子：子名1、子名2、…）}
独立技能：- {name}：{description 剥版本后截断 80}
空兜底：  - {name}
```

- **触发词来源**：父技能 `triggers` 字段优先；无则取 `description`（4.3 聚合触发词已写入）剥版本后截 80。触发词用顿号（U+3001）连接，触发词部分上限 **80** 字符（超出截断加 `…`）
- 内联子技能名全部列出（用户要求"披露子 skill 清单"），不设截断；子名来自 `subskills` 字段
- **空兜底**：触发词为空且 description 剥版本后也为空 → 只列 `- {name}`
- 版本剥离正则 `/\bv\d+\.\d+\.\d+[^。]*(?:。|$)/g` 应用于 description/触发词拼装前
- 前缀段落（【已安装技能清单】…必须调用 Skill 工具执行…）**原样保留**

### 5.3 缓存不变

`skillListCache` 指纹缓存保留（解析逻辑变化经 bridge 重启生效）。

## 6. 内核清单改造

### 6.1 `loadSkillsDir.ts`（`parseSkillFrontmatterFields` L185-265）

- 解析 `parent`/`subskills` → `Command` 新增可选字段 `parent?`、`subskills?`
- 不影响 `estimateSkillFrontmatterTokens` 预算估算（字段长度可忽略）

### 6.2 `SkillTool/prompt.ts`（`getCommandDescription` L43-50 + `formatCommandsWithinBudget` L70-171）

- `getCommandDescription`：应用版本剥离正则（同 5.2），再做既有 250 字符截断
- `formatCommandsWithinBudget`：**有 `parent` 的技能条目不渲染**（隐藏）；父技能条目渲染为 `- {name}: {desc 截 250}（子：n1、n2…）`——子名追加在 desc 截断之后、不占 250 限额（每父技能再预留子名拼接预算，估算计入 fullTotal/预算计算）
- 预算计算：父条目字符数 = desc(≤250) + 子名串（`（子：…）` 前缀 + join 顿号）；`MIN_DESC_LENGTH` 极端降级逻辑对父技能**只降 desc 不丢子名**

### 6.3 明确不动

- `attachments.ts` `getSkillListingAttachments`（注入时机/按 agentId/预算入口不变）
- `commands.ts` `getSkillToolCommands`/`getSlashCommandToolSkills`（过滤逻辑不变）
- `SkillTool.ts` 调用执行（`getAllCommands` 全量查找——子技能不受清单隐藏影响，仍可调用）

## 7. 技能库改造（63 + 1 个 SKILL.md）

| 改动 | 数量 | 说明 |
|---|---|---|
| 新制 `gxtz-suite/SKILL.md` | 1 | 父技能：聚合触发词 description + 23 子技能目录表 + 分派规则（参考 yfwdoc-suite 总路由模式） |
| 改造 `using-superpowers/SKILL.md` | 1 | 升级为父技能：frontmatter 加 `subskills`、description 聚合 15 子触发词、正文补子技能目录表（保留现有调用规则章节） |
| 改造 `yfwdoc-suite`/`yfwweb-suite`/`yfwx-suite` | 3 | frontmatter 加 `subskills`；description 聚合子技能触发词（现有 description 已列子名，扩为触发词覆盖）；正文目录表核对完备 |
| 子技能标注 `parent` | 53 | 在 frontmatter 加一行 `parent: <父名>`（源文件仅此一处改动） |
| 独立技能 | 6 | 零改动（无 parent/subskills） |
| `subskills`/`parent` 声明正确性 | — | 校验脚本统一验证 |

聚合触发词初稿由脚本生成（从子技能 triggers/description 提取去重），**人工审定后**写入父技能 description。

## 8. 明确不改的部分

- 内核 `attachments.ts`、`commands.ts` 过滤、`SkillTool.ts` 调用、`bootstrap/state.ts` invokedSkills——全部保持
- 子技能 SKILL.md 除 frontmatter 加 `parent` 一行外零改动（正文/description/triggers 保留）
- 独立技能 SKILL.md 零改动
- 调用时全文注入机制不变

## 9. 同步与发布

| 改动文件 | 同步目标 |
|---|---|
| `server/bridge.mjs` | `release/Ponos/server/` + `release/Ponos_ms92cd6u/server/` |
| 内核 `loadSkillsDir.ts` + `prompt.ts` | rebuild bundle → `release/Ponos/kernel/` + `release/Ponos_ms92cd6u/kernel/` |
| 技能库 `~/.ponos/skills/**/SKILL.md` | 用户目录直接生效（无需 release 同步；技能目录指纹变化触发宿主清单重建；内核命令按 cwd memoize，技能变更需新会话/重启生效——既有行为） |

- 同步后 sha256 三端一致校验（dist 不涉及）
- 不打包（沿用项目约束）
- **生效需重启 live app**——重启前须征得用户同意（项目 memory 约束）

## 10. 验证方案

1. **重建清单实测**：改造后重建宿主/内核清单，字符数对比（预期：宿主 11,073 → ~2-3K；内核 11,566 → ~5K）
2. **层级渲染抽查**：清单仅 11 条（5 父 + 6 独立）；父条目含子技能名内联；53 子技能名不在清单独立出现
3. **子技能可调回归**：确认 SkillTool 调用 `gxtz-rd-tables` 等子技能仍成功（`getAllCommands` 路径零改动，diff 检查）
4. **互逆一致性**：校验脚本断言 parent/subskills 双向一致、无孤儿、父技能无 parent
5. **聚合触发词抽查**：父技能 description 覆盖子技能触发场景（如 gxtz-suite 含"知识产权/专利/软著/立项报告/管理制度"等）
6. **边界用例**：触发词与剥版本后描述均为空 → 只列名字；触发词超 80 → 截断 + 省略号；版本号在描述中间 → 不误删
7. **执行能力回归**：SkillTool 工具定义、调用注入、子代理注入路径零改动（diff 检查）

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 子技能隐藏后模型直接触发率下降（如用户说"帮我整理知识产权材料"须先想起 gxtz-suite） | 父技能聚合触发词覆盖子技能场景 + 父条目内联子技能名提示子集；父技能正文目录表质量把关 |
| 父技能 description 聚合后超长 | 触发词部分截断 80 + 子名内联独立计算；内核 desc 250 截断；父条目总长受 1% 预算约束 |
| 父技能被调后跳过目录、未分派到具体子技能（模型直接把总路由当执行体） | 父技能正文第一行即分派指引（"本技能为总路由，先定位具体子技能"），正文含完整目录表 |
| 子代理 context 无子技能清单，不敢调用子技能 | 父技能正文明确"全部 gxtz-* 子技能可直接 skill 调用：name1、name2…"；子代理执行父流程时该信息在上下文中 |
| 版本剥离正则误伤正文 | 正则以句号/串尾为界 + 抽查验证；剥离只发生在清单渲染层，源文件无损 |
| 技能库 53 处 parent 标注遗漏/错误 | 校验脚本强制互逆一致，CI/收工必跑 |
