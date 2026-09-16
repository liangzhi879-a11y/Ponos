# 计划：agent / skill 页面与功能大改（待处理清单 P1 第 2 项）

- **spec**：`docs/superpowers/specs/2026-09-15-agent-skill-overhaul-design.md`
- **决策（用户 2026-09-15 确认）**：D1 显式声明优先 + 前缀启发式兜底｜D2 只读展示 + 系统打开文件｜
  D3 **全局禁用**｜D4 先 A+D 再 B+C
- **批次一（A + D）状态**：✅ 已完成并验证（见下"批次一"）

---

## 批次一（A 工具控制 + D 全局开关）—— 已完成

### 步骤与验证

| # | 步骤 | 文件 | 验证 |
|---|---|---|---|
| A1 | 修 `tools` 声明解析（自然语言句式 → 可执行白名单/禁名单） | `kernel/agents.mjs` `parseToolsSpec` / `parseSkillsSpec` | `agent-tools-spec.test.mjs`（10 pass） |
| A2 | 车道工具收窄抽成纯函数并接回 engine | `kernel/agents.mjs` `resolveLaneTools` + `engine.mjs` | 同上（含"必须保留 Read"的核心断言） |
| A3 | GUI 结构化工具模型 + 内核漂移守卫 | `src/lib/agentTools.ts`（新） | `src/lib/agentTools.test.ts`（11 pass） |
| A4 | 卡片内工具控制组件 | `src/components/agents/AgentToolsEditor.tsx`（新） | typecheck + 接入 `AgentsPanel` |
| A5 | 工具范围可写（任何类型 agent） | `agentStore.setAgentTools` | 接线守卫 ⑥ |
| D1 | 停用注册表（原子写 + 容错读） | `kernel/disabled.mjs`（新） | `disabled-registry.test.mjs`（8 pass） |
| D2 | 三处消费面收窄（提示词 / Skill 工具 / resolveAgents） | `cli.mjs`、`tools.mjs`、`agents.mjs` | **真进程 e2e**（5 pass）+ 接线守卫（9 pass） |
| D3 | HTTP 面（只改传入的键） | `server/disabled-routes.mjs`（新）+ bridge | `disabled-routes.test.mjs`（9）+ `disabled-route.test.mjs`（4） |
| D4 | GUI 开关（乐观更新 + 失败回滚） | `disabledApi.ts`、`disabledStore.ts`（新）、`SkillsPanel`、`agentStore` | `disabledApi.test.ts`（10 pass） |

### 门禁结果

- `npm run typecheck` ✓
- `node --test kernel-tests/*.test.mjs` **1595 pass / 0 fail**（基线 1572）
- `node --test server/*.test.mjs` **484 pass**（基线 472）
- `node --test src/**/*.test.ts` **435 pass**（基线 414）
- `npm run build` ✓；已同步 `release/YFWorking/`（kernel / server / dist 三层 grep 核验）

---

## 批次二（H 内核内置 agent 入口 + B 收藏版面）—— 已完成

用户选择：**H 与 B 合并一轮，再做 C**；C 的父级声明载体 = **`SKILL.md` frontmatter `parent` 字段**。

### H：补上「内核内置 agent 在界面上看不到、也停不掉」的缺口 + 修一处交互 bug

| # | 步骤 | 文件 | 验证 |
|---|---|---|---|
| H1 | `resolveAgents` 结果加 `builtin` 标记（纯增量） | `kernel/agents.mjs` | `agents-routes.test.mjs` |
| H2 | `GET /agents` 纯 handler（**直接调用 `resolveAgents`**，不抄名单） | `server/agents-routes.mjs`（新）+ bridge | 8 pass |
| H3 | 客户端 + 「内核内置智能体」分区（开关写注册表） | `src/lib/agentsApi.ts`、`src/components/agents/KernelAgentsSection.tsx`（新）、`AgentsPanel` | 7 pass + 守卫 |
| H4 | **修 bug**：`agentStore` 覆盖式重算会抹掉内核独有 agent 的停用项 → 改为并集保留 | `agentStore.syncDisabledAgents` | 回归测试（含"旧写法确实会丢"的反证） |
| H5 | 真进程证据：内置 agent（无 .md）也能真的停掉 | `kernel-tests/disabled-e2e.test.mjs` | e2e 6 pass |

**两条关键设计约束**（否则修复本身有缺陷）：
1. `GET /agents` **刻意传 `disabled: []`** 返回完整目录 + `disabled` 标记 —— 若按停用过滤，停用项会从列表消失 ⇒ 用户**永远点不回来**（开关成单向）。这一条是实现中**自查发现并纠正**的（初版就是过滤版）。
2. 分区**只列 GUI 列表里没有的项** —— 否则同一 agent 出现两个开关（一个走 `enabled`、一个走注册表），界面自相矛盾。

### B：收藏技能改为紧凑卡片行

- `src/components/skills/PinnedSkillsRow.tsx`（新）：一行小卡（名称 + 来源目录 + hover 取消收藏；停用徽标同样可见），点击滚动定位到主体列表对应项（父级先展开）。
- `SkillsPanel`：`pinnedList.map(s => renderSkillItem(s))` → `<PinnedSkillsRow>`；主体列表项加 `skill-item-<id>` 锚点。

---

## 批次二 C：卡片详情 + 只读展开（已完成）

用户要求「每张卡片注明 skill 详情，展开可管理触发规则，管理关联脚本」；决策 D2 = **只读展示 + 系统打开文件**。

| # | 步骤 | 文件 | 验证 |
|---|---|---|---|
| C1 | 只读详情加载器（parent 归因 / 触发规则 / 脚本与文档分流 / 平铺形态处理） | `kernel/skills.mjs` `loadSkillDetail` | `skill-detail.test.mjs`（9 pass） |
| C2 | `GET /skill-detail?id=` 纯 handler（400/404/200） | `server/skill-detail-routes.mjs`（新）+ bridge | 8 pass（含只读纪律断言） |
| C3 | 数据层抽到 `.ts`（`.tsx` 无法被 `node --test` import） | `src/lib/skillDetail.ts`（新） | `skillDetail.test.ts`（8 pass） |
| C4 | 详情面板（只读 + 系统打开 + 归因徽标）挂进卡片，同时只展开一个 | `src/components/skills/SkillDetailPanel.tsx`（新）、`SkillsPanel` | typecheck + 守卫 |

**关键实现细节**：
- **平铺式技能**（`<root>/<id>.md`）返回**空脚本清单** —— 它的"目录"其实是技能根，列出父目录文件会把**别的技能**的文件算作它的关联脚本（误导性错误比"没有"更糟）。
- **归因必须区分"声明的"与"猜的"**（D1）：技能声明了 `parent` ⇒ 标"已声明"（作者意图，不可改）；未声明 ⇒ 标"按前缀推断"（可纠正）。
- **404 而非空白面板**：界面据此说"该技能在磁盘上已不存在"，否则用户会以为是界面坏了。

### C 补充：父子分类判据统一（`src/lib/skillTree.ts`）

实现 C 时发现「父级/子级分类浏览」有**两处真实缺陷**（都属静默失败：不报错、不提示，只是东西不见了或归类错了）：

| 缺陷 | 触发条件 | 后果 | 修法 |
|---|---|---|---|
| ① 父级判据**三处各自实现** | 父级自己没写 `subskills`，只有子技能用 `parent:` 反指它（本仓库官方写法，如 `yfwx-project-eval` → `parent: yfwx-suite`） | 渲染路径判它"非父级" ⇒ **子技能永不渲染** | 统一 `isParentSkill()`（双来源合并） |
| ② **孤儿技能界面消失** | 声明了 `parent` 但父级不在（未安装/拼写错/跨技能根） | `!s.parent` 顶层过滤 + `if (s.parent) return null` **双重丢弃** ⇒ 用户**看不到它**、无法查看详情或使用，且无任何提示 | `isOrphanChild()` 判定，孤儿留在顶层 |

三份副本的原始位置（已全部替换）：顶层过滤 `skills.filter(s => !s.parent …)`、渲染循环 `const isParent = (s.subskills||[]).length > 0`、收藏小卡 `(…).length > 0 || skills.some(c => c.parent === s.id)`。

**关键实现点**：
- 纯逻辑全部落在 `.ts`（`.tsx` 无法被 `node --test` import，实测 `ERR_UNKNOWN_FILE_EXTENSION`）⇒ 这些分支第一次变得可测（`skillTree.test.ts` 21 条）。
- `childIdsOf` 双来源合并时**剔除不存在项与自指**：自指坏数据会让技能成为自己的子项（重复/递归渲染），`subskills` 里写着但未安装的 id 会渲染成空洞。
- `topLevelSkills` 保留"搜索命中子技能时带出父级"的既有体验——否则子项折叠在父级下，搜到了却没有入口。
- `renderSkillItem` 新增 `childCount`：原先只显示 `skill.subskills.length`，统一判据后父级可能没有该字段 ⇒ 显示"父级但 0 子"的自相矛盾；子项调用**不递归传** childCount（本层不展开孙项，给了计数却不能展开反是误导）。

**防回归守卫**（`kernel-tests/disabled-plumbing.test.mjs` C④）：源码级断言面板**不得**再出现内联的 `const isParent = (s.subskills…`、`if (s.parent) return null`、`skills.filter(s => !s.parent`，且必须调用 `topLevelSkills`/`isParentSkill`/`childrenToShow`。

### 门禁结果（批次二全量·终值）

- `npm run typecheck` ✓
- `node --test kernel-tests/*.test.mjs` **1616 tests / 1615 pass / 0 fail / 1 skipped**
- `node --test server/*.test.mjs` **500 pass / 0 fail**
- `node --test src/**/*.test.ts` **471 pass / 0 fail**（含 `skillTree.test.ts` 21）
- `npm run build` ✓；`release/YFWorking/` 已同步（资产 0 缺失 0 残留，`index.html` 指向新 bundle）

> **并行跑测的假失败**：`kernel-tests` 在 `--test-concurrency=4` 下曾出现 2 例问答/审批超时时序用例失败
> （`engine-ask-user`、`engine-hard-watchdog`），**隔离复跑 3/3、4/4 全通过** ⇒ 属并行拥挤，非回归。
> 收尾门禁以串行/低并发全量为准；遇到可疑失败先"隔离复跑再下结论"。

---

## 验收纪律（两批共同）

1. **真进程证据**：涉及内核行为的改动，必须有"spawn 真内核 + 观察提示词/工具"的证据，而不是只测函数。
2. **零回归**：typecheck + kernel-tests + server + src 全绿；既有内置 agent、技能安装/卸载、
   收藏上限行为不变。
3. **接线守卫**：GUI → 桥 → 内核 新增键必须两端同改 + 静态守卫（病史：`--spaces`、`--confirm`）。
4. **一致性**：任何"界面显示的状态"必须与内核实际生效口径同源（本批的教训：假开关 =
   界面显示已停用但内核照旧加载）。
