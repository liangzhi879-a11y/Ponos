# DevKit —— 操作契约

> 本文件是**给 AI 的操作契约**（结构化，不是散文）。人读 `node kit/cli.mjs check --verbose`。
> 设计依据：`docs/superpowers/specs/2026-09-19-devkit-design.md`（§5 版本台账 / §6 依赖台账 / §7 门禁 / §8 章）。
> 判定域：**一切基于 `git ls-files`（已入库文件）**，不是磁盘遍历（spec §3 不变量 I2）。

## 何时跑什么

| 场景 | 命令 | 说明 |
|---|---|---|
| 提交前自检 | `npm run kit:check` | 只读。有红灯**不要提交** |
| 改了版本号/常量 | `npm run kit:sync` | 先 sync 再 check |
| 改了 `SKILL.md` | `npm run kit:sync` | 重算 `skills-lock.json`（V7 判据恒为 lock 文件，不读台账） |
| 新增/删除依赖 | `npm run kit:sync` | 然后看 `check` 的 P1（未用）/ P2（幽灵）/ P7（双向对账） |
| 改了 `_common/*.py` | `npm run kit:sync` | 台账会补登记；**新增**脚本必须有 `__version__` 或显式登记（V8′） |
| 新增/改名 `scripts/verify-*.mjs` | 同步 `package.json` + `kit/manifest/deps.json#gates` | 三条挂载完整性测试会红（`kit/cli.test.mjs`），不要绕开它们改文档 |
| 改了端点 / WS 事件类型 / IPC 通道 / 工具 `input_schema` | 先 `npm run kit:check` 看 **CT8 在途差异**（黄）→ **提交** → `npm run kit:sync` → 提交台账变化 | 台账按**提交态**落盘，故顺序不能反（见「契约快照与范围登记」的 committed 口径） |
| 改品牌名 / 窗口标题 / 安装产品名 | `node scripts/brand.mjs check` 看还差哪些 → `set <layer> <name>` 重新定义 → 提交 → `npm run kit:check` | 品牌真源 = `kit/manifest/brand.json`（见「品牌标识与名称的统一管理」）；CT10 读**提交态** |
| 契约面**不在** `docs/bridge-contract.md` 覆盖面内 | 在 `kit/manifest/contract-scope.json` 逐条精确登记（人工），并上调 `channels.scopeCount` / `scopeRedCount` | 别用通配/前缀（CT4C 红）；`sync` 不会替你写它 |
| 新增测试文件 | `git add` 后跑 `npm run anchors:write` | 文档锚点门禁只算**已跟踪**文件（否则 CI 在干净克隆上必红） |
| 同步调试版给用户测 | `npm run kit:stamp` | 产出 `release/YFWorking/kit-stamp.json`（local-only） |
| 汇报现状给用户 | `npm run kit:view` | 输出固定 schema JSON，不必解析散文 |

## 读红灯的正确姿势

```
1. npm run kit:view            # 拿 JSON（findings[].rule / file / hint），不解析散文
2. 按 rule 决定动作：
```

**版本侧（V1–V8′，共 11 个规则号）**

| rule | 判据 | 默认动作 |
|---|---|---|
| V0 | 台账 `versions.json` 读不到（只在文件缺失时出现，**不计入** 19 个规则号） | `npm run kit:sync` 生成台账 |
| V1 | 台账声明的定位处能解析出该常量且值相等 | `kit:sync`（宿主是对的）或修宿主（台账是对的） |
| V1b | 台账键（`id@file`）唯一 | 修 `versions.json`：同名常量必须靠 `file` 区分 |
| V2 | 每条版本线有**已入库**的宿主文件 | 修 `versions.json` 的 `file` 字段（或 `git add` 宿主文件） |
| V3 | `history.records` 首尾相接且末条 == 当前值 | 补 history 记录（版本变更必须留痕，防静默改值） |
| V4 | 内核线映射一致：`'dev X.Y'` ↔ `'X.Y.0'` | 对齐 `kernel/package.json` 或版本线（与 `scripts/bump-version.mjs` 同源） |
| V5 | `kind=data-schema` 的变更写了 `migrationNote` | 补说明（无迁移也须显式写"向后兼容，无需迁移"） |
| V6 | 技能版本三方一致（`skills.json` ↔ `SKILL.md` ↔ 台账） | 对齐前两者；台账值必须能**由源文件复算**（对不上则 `kit:sync`，不要手改） |
| V7 | `skills-lock.json` 哈希 == `SKILL.md`（行尾归一后）实际哈希 | 有意改动 → `kit:sync` 重算；否则回退 `SKILL.md` |
| V8 | 台账登记的 `.py` 都存在 | `kit:sync`（文件已删/改名） |
| V8b | 实有 `.py` 全部在台账中 | `kit:sync` 自动补齐（`version` 可空，**不回填**假版本号） |
| V8′ | **新增**的 `_common/*.py` 自证版本 | 加 `__version__`，或显式登记 `version: null` + `versionSource: "unmarked"` |

**依赖侧（P0–P7，共 8 个规则号）**

| rule | 判据 | 默认动作 |
|---|---|---|
| P0 | `deps.json` 存在 | `kit:sync` 生成台账 |
| P1 | 每个声明依赖都有引用证据（黄灯 `unused`） | 五类证据（`import` / 动态 `import()` / 配置文件 / CLI / types）逐类核过、**确认无用**才删；删错的代价是功能静默失效 |
| P2 | 反向幽灵依赖：源码 import 了却没声明（**红**） | 补 `package.json` 声明，或改掉那个 `import`。**这是唯一能抓"删了依赖但其实还在用"的规则**，也是它必须进 CI 的原因（见下） |
| P3 | 内核域零第三方依赖 | 内核要能 `bun` 打成单文件，不允许引入 |
| P4 | 内嵌 Python 清单真源在 `deps.json#python.embedded` | 构建脚本必须走 `readEmbeddedPackages({ root })`，不得硬编码列表 |
| P5 | 两套 Python 清单差集（**黄灯**，刻意保留） | 无需消除：差集是预期事实（内嵌=分发最小集）。但条目**必须逐项可见**且每条有真实 `reason` |
| P6 | 三域体积记账（3 键齐备，仅趋势无阈值） | `kit:sync` 采集 |
| P7 | 台账包集 ↔ `package.json` 双向一致 | 任一侧多了/少了都红：`kit:sync`（**不要手改 `deps.json`**） |

**基线与护栏**

| 规则/字段 | 含义 | 动作 |
|---|---|---|
| `BASELINE_NO_REASON` | 基线条目缺 `reason`（红，违反 I4） | 补 `reason`，或摘除该条目 |
| `BASELINE_FORBIDDEN` | **契约对账类规则（`CT0`–`CT8`）与品牌规则（`CT10`）不支持基线豁免**：条目里出现这些规则号即红（第 4 批收口，堵掉"单行 JSON 就能把契约红灯变绿"的通路；★ CT10 是第 9 批新增，自动落入本清单——`BASELINE_FORBIDDEN` 判据是「除 CT9 外全部 CT」） | 删掉该条目；契约红灯只能靠修契约面消除（修代码 / `kit:sync` / `contract-scope.json` 登记）。`CT9`（幽灵 fetch 历史欠账，黄）**仍可**登记豁免 |
| `BASE` | 基线条目总数 / 豁免红灯条数**超过**上次登记值（红） | 基线是"已知欠账"，不是"遇红就塞"：修代码，别加条目 |
| `baselineUnused` | 基线里**未生效或已不再命中**的条目（提示） | 应摘除（避免基线长期挂着过期豁免；`BASELINE_FORBIDDEN` 的条目也会列在这里） |

## 契约快照与范围登记（P1 · T12；**P1.5 起登记只剩空命名空间**）

契约面**五类**（bridge 路由 / WS 事件类型（出、入）/ IPC 推送通道 / 工具 `input_schema`）↔ `docs/bridge-contract.md` 的对账。
设计依据：spec §12 的 P1 判据**两条** —— **(a)** 快照可从代码**复算**、差异 = 0；**(b)** **范围登记完整**
（登记集 = 代码真值 ∖ 文档已声明）；实施计划 `.superpowers/sdd/2026-09-19-devkit-p1-contracts/plan.md`。

**P1.5（2026-09-19）把"登记"升级为"真对账"**：文档此前**缺半壁**（IPC 与工具零章节、§7 只声明
**32 条 distinct 路径**（含 2 条 `*` 通配；同一提交的代码侧是 **103 个 method+path 键** —— 两个口径不可相除））
⇒ 那 **92 键**契约面（= `contract-scope.json` 的 `members` 逐条求和）只能"人工承认边界"（登记），不是对账。P1.5 补齐了文档面：

| 判据 | 内容 | 落点 |
|---|---|---|
| (a) | `kit:check` 双树**红 0 / EXIT=0**；`CT2`/`CT3` 覆盖 **routes + wsOut + wsIn + ipc + tools** 五类 | 规则表 `CT2`/`CT3` 行 |
| (b) | `contract-scope.json` 只剩**无法文档化的空洞**（空命名空间）；`scopeCount`/`scopeRedCount` 人工下调到现值 | 见下面「P1.5 之后的登记面貌」 |
| (c) | **反向可证伪**：删 §11 一条 push ⇒ `CT2`（未覆盖）+ `CT4`（未登记）双红；改 §12 一个指纹末位 ⇒ `CT3` 红；把已摘除的成员塞回 scope ⇒ `CT4` 多登记红；**把 §5 的出站 WS 行挪进 §6 ⇒ `CT2`+`CT4`+`CT3` 三红**（收尾批补的方向判据） | 每条都有单元用例（`contract-rules.test.mjs` 的「P1.5-变异①②③」与「收尾批①②③⑤」） |
| (d) | **90 键**摘除（92 → 2）**逐条可解释**：`CT4 多登记 = 0` 即"每条都真被文档声明了"（口径：`members` 求和；逐类 routes 76→2、wsOut 6→0、wsIn 3→0、ipc 7→0） | `CT4` 的 `extra` 方向 |
| (e) | 遗留条目的 reason 必须说明"**为什么补不了文档**"（`children` 为空 / 动态拼装 ⇒ 没有具体端点可写） | `contract-scope.json#entries[].reason` |

文档新增面（**逐项标口径，不同口径不相加**）：**§7** **+25 行**表行（`git show --stat 93f89a4`）⇒
**72 个 method+path 键**（**代码侧**口径：这 68 条新路径在代码里共有 72 个键 —— `/api/profile`、`/knowledge/doc`、
`/mcp`、`/file-collab/policies` 各一行两方法）/ **68 条 distinct 路径**（**文档侧**口径：新增的路径数）、
**§5** +6 / **§6** +3 WS 类型（口径 = 表格行数，且这 6+3 行各只含一个类型 ⇒ 行数与类型数同值；收尾批又为 §5 补 `browser:event` 一行 ⇒
**§5 现 24 表格行 / 27 个类型**、§6 现 15 表格行 / 16 个类型 —— 一行可写多类型，两口径**不可混用**）、
**§11**（新章）7 条 IPC 推送通道、**§12**（新章）21 个工具 + 结构指纹（口径 = 章节表格行数）。
★ 说"共 N 条"时必须点明口径：**行数 / method+path 键数 / distinct 路径数 / 成员键数**互不通用
（P1.5 的 `docs/ci.md` 曾把三个口径混写成一句"88 条"，收尾批已按实测改口径）。

### P1.5 之后的登记面貌（2 组 / 2 键，`scopeCount=scopeRedCount=2`）

`contract-scope.json` 现在只有**两条 `ns` 声明**，两条都是"**没有具体端点可写**"的命名空间：

| 条目 | 为什么补不了文档（= reason 的要点） |
|---|---|
| `ns /knowledge/import/jobs/` | 前缀 `children` 为空**且**无锚定正则（`dynamic:null`）⇒ 路径段由运行时 job id 拼装、静态不可枚举。带斜杠的 `/knowledge/import/jobs/` 在代码里**不存在**（代码只认 `/knowledge/import/jobs` 与其子路径）⇒ 写进 §7 会让 `CT3` 判"文档腐烂"。 |
| `ns /providers/` | §7 的 `/providers/*` 只声明命名空间、**不给子路径覆盖信用**（反例⑧），`/providers` 是另一条具体端点；子路径由 provider id 运行时拼装（`children` 为空、无锚定正则）⇒ 没有具体子路径可写。 |

★ 与之对照：`ns /file-collab/`、`ns /knowledge` 两条**已随着子路径补进 §7 自动消失** ——
`buildTruth` 的 `underDoc` 判据（"文档里有具体路径落在该前缀下 ⇒ 该命名空间已被覆盖"）本就是为此设计的，
与 `/transcript/`、`/logs/` 同理。**判据方向**：文档声明得越全，登记越小；登记里出现**新**成员
= 代码新增了未文档化的契约面（该补 §7/§11/§12，或说明为什么补不了）。

### 怎么跑

| 命令 | 作用 | 写文件？ |
|---|---|---|
| `npm run kit:check` | 三类规则（版本 V / 依赖 P / 契约 CT）的**门禁**，只读，退出码 0/1 | 否（**仓库内**只读；见下面「committed 口径」） |
| `npm run kit:check -- --verbose` | 追加「规则逐条」表：每条规则的 `evaluated`（判了多少条）+ 台账规模 | 否 |
| `npm run kit:sync` | 从**提交态**复算契约快照写进 `versions.json#channels`（人工段原样保留） | 是 |
| `npm run kit:view` | 固定 schema JSON（`findings` / `ledgers.versions.channels` / `scope`），AI 读它，不解析散文 | 否 |

★ **`view --json` 的顶层 schema 是 `schemaVersion` / `generatedAt` / `ok` / `summary` / `ledgers` / `scope` / `findings`
—— `channels` 明细不在顶层**（顶层只有 `summary.red/yellow/baselined/rules` 这类计数）。channels 读数路径两条：

```bash
# ① 计数摘要：ledgers.versions.channels（routes/routePrefixes/wsOut/wsIn/ipc/tools/... 都是**数字**，不是键表）
node kit/cli.mjs view --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const c=JSON.parse(s).ledgers.versions.channels;console.log('routes',c.routes,'/ prefixes',c.routePrefixes,'/ wsOut',c.wsOut,'/ ipc',c.ipc,'/ tools',c.tools,'/ scopeCount',c.scopeCount)})"
# ② 键级明细（哪条路由/哪个工具）：直接读 manifest 的 `channels`
node -e "const c=require('./kit/manifest/versions.json').channels;console.log(Object.keys(c.routes).length, Object.keys(c.routes).slice(0,3))"
```
（实测：① 打印 `routes 103 / prefixes 7 / wsOut 27 / ipc 156 / tools 21 / scopeCount 2`；② 打印 `103 [ 'ANY /agents', 'ANY /api/audit', 'ANY /api/auth/status' ]`。
`kit/manifest/versions.json#channels` 与 `ledgers.versions.channels` 同源 —— 后者是前者的**按类计数**投影。
★ 口径：`routes 103` 是**盘根干净克隆**值（主树 105，含他人在途改动的 2 条）；`scopeCount 2` 是 P1.5 后的终态。）

★ `check` **恒打印**两段：范围登记逐条（`── 契约范围登记（N 组 / M 键）──`，逐条带 kind/ns/键数/docSection/reason）
与在途差异一行（`（契约）在途差异（CT8，黄、只报不拦）：…`）—— **无差异时也明说"无"**（"没打印"与"没有差异"不是一回事），
且这一行**自报扫描域**（`扫描域：git 跟踪 + 未忽略的未跟踪文件` —— CT8 的工作树侧域，见规则表 `CT8` 行）。

### agent 自动注入入口（`AGENTS.md`）与其「不掉」保障

**入口是什么**：仓根的 `AGENTS.md`。多数 agent 工具（Codex / Cursor / Cline…）开工时会**自动读仓库根**的这个文件；
Ponos 内核自己也自动发现它 —— `kernel/prompt.mjs#discoverAgentsMd`：从 cwd **逐级向上直到 `.git` 所在目录**，
再加 `--add-dir` 的根（每个候选目录里若有 `AGENTS.md` 就注入）。⇒ 它是"规范不必靠 agent 自觉去找"的那一层，
**不是**第二份清单（唯一真源仍是 `kit/lib/agent-guide.mjs`）。

**为什么要有门禁（CT11）**：实测它此前**只在会话提示词里被口头描述、真源零登记、无任何校验** ——
改了真源忘改入口**不会红**，跟 `versions.json#lines[].label` 当初"无门禁、标签与口径正面冲突却永远不红"
是**同一类漏洞**。CT11 把它登记进真源（`entry.mustMention[]` 锚点 + `entry.maxLines` 上限 + `entry.portableSync`）并逐条核。

**★ 便携版（调试版）"更新了不会掉"**（用户口径 2026-09-20："人工测试跑的是 release 中的便携版（调试版）"）：
实测 `AGENTS.md` 此前**不在任何同步清单里** ⇒ 便携版里**从来就没有入口** ⇒ 在调试版里跑的 agent
**静默地不受规范约束**（症状不是"更新后掉了"，而是"从来没有过"，而且面板上看不出来）。
CT11 因此把**三条同步路径**也纳入判据（`entry.portableSync.paths`），谁删清单项就红：

| 路径 | 作用 |
|---|---|
| `scripts/package-portable-zip.mjs` 的 `SYNC_FILES` | 打包/手工同步（`--sync`）——★ 注意 `--dry-run` **只**决定"是否写 zip"，`syncPortable()` 照常执行 |
| `electron/dev-source-sync.cjs` 的 `SYNC_DIRS` | 调试版**每次启动**的 autoSync（`.yfw-dev-source.json` 的 `autoSync: true`）；`listFiles()` 已支持**单文件条目** |
| `scripts/verify-portable-layout.mjs` 的 `requiredFile` | 便携版布局校验：入口真掉了会 **EXIT=1**（而不是无声无息） |

**边界**：`kit/` **不**进便携版 —— 它是**开发门禁**（规则读 `HEAD`、要 `docs/bridge-contract.md` 与台账），
便携版没有 `docs/`、也不是 git 仓 ⇒ 塞进去跑必然全红，只会变噪声。盖章（`kit/cli.mjs stamp`）也是在**仓库里**跑、
写 `release/YFWorking/kit-stamp.json`，因此同样不需要把 `kit/` 同步进产品。

**入口自己也要守规矩**：CT11 会核"必备锚点是否还在"（如 `npm run kit:check`、四条断言与基线纪律、不许 `git add -A`、
测试 glob 必须带引号、以及"本仓有两份『四条』清单"的消歧），并限制行数（>90 行 ⇒ 红，那是"变成第二份清单"的信号）。
★ 反过来，CT11 **不评价**入口的文风/排版（锚点齐全但排版难看 ⇒ 仍然绿）—— 门禁不做风格警察。

### DevKit 边界：发行物不得含开发门禁（CT12）

**口径（用户，2026-09-20）**：「确保正式打包不会带 devkit，也就是**发行给用户的版本不带 kit 及相关配置**」。

**为什么要有这条**：本仓有四条"会把东西带出去"的路径，其中一条**真的漏了** ——

| 发行面 | 现状（本批修前） |
|---|---|
| 安装包（`build:installer` → `electron-builder.yml`） | 白名单本就干净，但**没有门禁**：哪天有人把 `files` 改成 `**/*`（很常见的"顺手全带上"），devkit 就静默进包 |
| **源码交付包**（`scripts/pack-source-zip.mjs` → `release/YFWorking-src-*.zip`，文件头注释写明"给客户/外部"） | ★ **真漏洞**：排除规则里**既没有 `kit/` 也没有 `AGENTS.md`**，而候选清单来自 `git ls-files` ⇒ 实测 **59 个 devkit 文件**（`kit/` 58 + `AGENTS.md` 1）会随包发出去 |
| 调试版便携包（`package-portable-zip.mjs`） | 清单不含 devkit，但无自查（"今天干净 ≠ 明天干净"） |
| 免安装便携目录（`package-portable.cjs`） | 复制清单是白名单、本就干净；但布局校验此前是**纯手工**命令 ⇒ **没人跑就等于没有** |

**真源与实现（单一真源，别各抄一份）**：
- `kit/manifest/devkit.json`：`patterns[]`（禁含路径，**每条都写 why**）+ `devChannelAllow[]`（调试渠道例外）+
  `releaseSurfaces[]`（四条发行面各带 `guard` 与 `status`）+ `engine`（匹配语义）+ `recompute`（59 怎么算出来）。
- `kit/lib/devkit-rules.mjs`：`devkitMatcher` 是**唯一**匹配实现（`/` 结尾 = 目录前缀；否则 = **仓根文件精确匹配**）
  —— 打包脚本 import 它、规则核它，谁都不许再抄一份路径清单。
  **零外部依赖**（不引 YAML 解析器）：规则要能在"干净克隆 + 仅装 node"的 CI 场景下跑。

**★ 与 CT11 的分工（容易混）**：CT11 管「要**有**什么」（agent 入口必须送达），CT12 管「要**没有**什么」（devkit 不得外泄）。
两者在调试渠道上刚好**相反** —— `AGENTS.md` 在调试版**必须有**（CT11）、在发行物**必须无**（CT12）。
这就是 `devChannelAllow[]` 存在的理由：**例外必须被显式登记**，不能靠"反正扫不到"。

**★ 渠道（debug / release）由产物证据推导，不许调用方自证**（真源 `channelEvidence` + `resolveChannel()`）：
- **包**（`.zip/.7z/.tgz/.tar.gz/.exe`）：**文件名就是发布意图** ⇒ 名字不含 `debug` **一律 release，不认 marker**；
- **目录**（免安装便携目录 `release/YFWorking`）：名字**天生不含** debug ⇒ 认 `.yfw-dev-source.json`（dev-source marker）为调试态；
- **推导不出来 ⇒ release（默认从严，零例外）**。

> ★ 这一条是**修过一个真洞**才长成这样的：早先的实现是 `devkitLeaks(files, dk, { allowDevChannel: true })`，
> 而两个调用点**硬编码了 `true`** —— 等于"谁调谁自称调试渠道"，与产物是什么**无关**。后果实测过两处：
> ① 免安装便携目录被压成**正式**便携包、或发布前清理凭据（删 marker）后，`AGENTS.md` 仍会静默随包发出；
> ② `--out` 指定**正式包名**时，包内残留的 marker 会把渠道判成 debug ⇒ 同样放行。
> 现在：把产物洗成发行物（改正式名 / 删 marker）⇒ 渠道**自动变严** ⇒ 门禁红。
> 旧参数 `allowDevChannel` **传入即抛错**（留着它就等于洞还在 —— 总有人接着用），CT12 另核"调用点文本里
> 不得出现该参数（只扫代码，注释里写清历史不算）"与"`product-evidence` 面必须真的调用 `resolveChannel(`"。

**四条发行面各自怎么守**（`releaseSurfaces[].guard`）：

| 发行面 | 守在哪 | 怎么守 |
|---|---|---|
| 安装包 | `electron-builder.yml` | **结构校验**（声明式配置没法 import 模块）：从 `files`/`extraResources` 提取入包路径，逐条判"会不会把 devkit 带进来"，**含 `**/*` 全包含** |
| 源码交付包 | `scripts/pack-source-zip.mjs` | 排除规则**从真源取**（`DEVKIT_RULES` 插在 `EXCLUDE_RULES` 最前）+ 打包期 `assertNoDevkit(kept)`（★ 在**写 zip 之前**抛，不是"打完记条日志"） |
| 调试版便携包 | `scripts/package-portable-zip.mjs` | 入包前 `assertNoDevkit(payload, { allowDevChannel: true })`（调试渠道按真源例外放行 `AGENTS.md`/`kit-stamp.json`） |
| 免安装便携目录 | `scripts/verify-portable-layout.mjs` | 扫产物按真源判定，命中即 **EXIT=1**；且 `build:portable` 已链上它 ⇒ **打包即校验**（不再靠人记得手动跑） |

另外 `scripts/verify-package-assets.mjs`（出包预检）加了两道：`files`/`extraResources` **结构级** +
若已有 `win-unpacked` 产物则**直接扫安装包**（★ 发行物**零例外**，不像调试渠道能放行入口）。

**两个"条件判据"（`guard.pending`）**：`scripts/pack-source-zip.mjs` 与 `scripts/package-portable-zip.mjs`
被**本地 `.git/info/exclude` 排除**（开发者本机在途文件，尚未入库）⇒ CT12 读**提交态**会读不到。
若照常报红，门禁会**永远红**，而"永远红"等于没有红灯 ⇒ 未入库**跳过**（不计 `evaluated`、不报红）、
**一旦入库自动开始核**（与 CT11 的 `pending` 同一套语义）。

### 规则表（`CT` 号段：CT0–CT12，含 CT4 的两个子规则、品牌 CT10、agent 入口 CT11 与 DevKit 边界 CT12）

| id | 判据（一句话） | 严重度 | 改坏了会怎样（变异） |
|---|---|---|---|
| CT0 | `versions.json#channels` 存在且形状完整 | 红 | 删 `channels` 键 |
| CT1 | 台账快照 == 从**提交态**代码**现场重算**的快照（逐类逐元素；绝不读快照当答案） | 红 | 手改快照任一键；提交了端点改动却没跑 `kit:sync`；HEAD 读不到（subject `HEAD 物化`） |
| CT2 | 代码 → 文档：真值里每条（**五类**：路由 / WS 出（减 **§5** 的声明集）/ WS 入（减 **§6** 的）/ IPC 推送 / 工具出口）都能在 §5/§6/§7/§11/§12 定位**或**在 scope 命中 | 红 | 提交新端点后既没补文档也没登记 scope；新增工具不进 §12；**把 §5 的出站事件挪进 §6**（方向写反 ⇒ `wsOut` 真值里多出该事件） |
| CT3 | 文档 → 代码：文档声明的每条（路由 / **WS 按方向**（§5 的必须在 `ws.out`、§6 的必须在 `ws.in`）/ **IPC 通道 / 工具名 + 结构指纹逐字相等**）都真在代码里（抓"文档腐烂"与方向写反） | 红 | 文档里写不存在的 `/fake`；§12 指纹改一位；§12 缺指纹（fail-closed，不"没写就不比"）；**把 §5 的出站事件挪进 §6**（§6 侧代码里没有它）；删掉代码里的端点。★ 工具指纹的口径与 `CT6` 的分工见下面「口径澄清」第 3 条 |
| CT4 | scope `members` 与「代码真值 ∖ 文档已声明」**集合相等**（多一少一都红；**逐条报，subject 带键名**） | 红 | members 少一条 / 多一条 / 拼错 |
| CT4B | scope 组数 / 键数不得超过 `channels.scopeCount` / `channels.scopeRedCount`（双护栏） | 红 | 往 scope 加条目超过封顶值 |
| CT4C | scope 条目合法：`reason` 必填、`ns`/`members` 禁 `*` 与正则字符、无重复、`docSection` 真实存在 | 红 | 写 `ns: "/knowledge"` + `members: ["/knowledge/.*"]`；删 reason |
| CT5 | IPC 三方配对（invoke↔handle / send↔on / push↔on）**双向集合相等**；`push` 每条在**文档 §11**或 scope | 红 | 删一个 `ipcMain.handle(...)`；preload 里加 invoke 而 main 侧没有 handle；新推送通道两处都不声明 |
| CT6 | `toolSchemas()` 出口 ⊆ 快照 + 静态 registry 计数一致 + 动态源逐条登记 + 结构指纹一致 | 红 | 加工具、改 `input_schema` 结构、加动态源不登记（**`description` 散文不入指纹** ⇒ 改文案不红） |
| CT7 | **提取守恒**：`type:` 字面量 = 已归因（sink 白名单）+ 显式 `excluded`；路径字面量必有归宿（独立重扫） | 红 | 非 sink 处写 `{ type: 'typo' }`；新增 sink 形态不登记 |
| CT8 | **在途差异**：工作树 ∖ HEAD 的契约面（路由/前缀/WS 类型/IPC/工具/排除项 + 文档声明集**六类**）**逐条列出** | **黄、只报不拦** | ——（在途改动就是这个状态；提交后自己变空，不需要任何基线） |
| CT8 的**扫描域** | 提交态侧 = `git ls-files`（索引）；**工作树侧 = 索引 ∪ 未忽略的未跟踪文件**（`git ls-files --cached --others --exclude-standard`，第 4 批补：未 `git add` 的新源文件原先整块不可见） | —— | 域仍由 git 决定（**不是**磁盘遍历）：`release/`、`kernel-dist/`、`node_modules` 等被忽略的镜像/产物目录在域外；`worktreeClean` 的捷径还要求索引里全是普通 `H`（`--assume-unchanged`/`--skip-worktree` 会让 `git status` 说谎） |
| CT9 | 渲染层 `src` 的 fetch 路径 → server 路由**单向**差集 | **黄、只报不拦** | ——（D8 历史欠账，逐条登记在 `drift-baseline.json`） |
| CT10 | **品牌声明点 ↔ 品牌真源**：`kit/manifest/brand.json` 的 14 条声明点逐条对账（层名"出现"即过 / 字面量须精确相等）+ 受管声明点里不得出现废弃别名 `Ponos-Turbo`（大小写不敏感） | 红（**不可基线豁免**） | 改 `productName` / `<title>` / `version.mjs` 的那两行注释 / 台账 `lines[].label` 而不动真源；把内核层注释改回 `Ponos-Turbo`；删掉或写坏 `brand.json`（真源不可读 ⇒ 红且不抛） |
| CT11 | **agent 自动注入入口 ↔ 真源**：仓根 `AGENTS.md` 必须存在、含真源 `entry.mustMention[]` 登记的每条必备锚点、行数 ≤ `entry.maxLines`（不许长成第二份清单）；★ 并且**必须留在便携版同步清单里**（详见下节） | 红（**不可基线豁免**） | 删掉入口、抠掉某条锚点（如 `git add -A` 那条红线）、把入口写长、走 `rename` 把入口搬走；或从 `scripts/package-portable-zip.mjs` / `electron/dev-source-sync.cjs` 的清单里删掉 `AGENTS.md` |
| CT12 | **DevKit 边界 ↔ 打包配置**：真源 `kit/manifest/devkit.json` 的 `patterns[]`（`kit/`、`AGENTS.md`、门禁文档…）**不得出现在任何发行物**；四条发行面必须**从真源取清单**；`electron-builder.yml` 的 `files`/`extraResources` 结构上不得含 devkit（含 `**/*` 全包含） | 红（**不可基线豁免**） | 往源码交付包/便携包的排除规则里各抄一份清单而不引用真源；把 `electron-builder.yml` 的 `files` 改成 `**/*`；`devkit.json` 被删/写坏/`patterns` 清空（恒真防护）；`devChannelAllow` 写成"什么都放行" |

两条"黄、只报不拦"的规则在报告里各占一个 `checkResult`，`passed=false` 表示"确实有东西"，但**不影响退出码**。

### 怎么登记（`kit/manifest/contract-scope.json`，**人工文件**）

`CT2/CT4` 的"登记"指这份文件：它表达**范围边界**（哪些契约面**不在**文档覆盖面内、为什么）。

| 字段 | 含义 |
|---|---|
| `kind` | `routes` / `wsOut` / `wsIn` / `ipc` / `tools` / `doc`（白名单，其它值 ⇒ 条目失效 + CT4C 红） |
| `ns` | 命名空间标签，**只用于人读与 CT4C 的分组检查**；不含通配/正则字符 |
| `members` | **逐条精确键**：`routes` 写 `GET /x` 或 `ns /x/`；`ws*` 写事件类型；`ipc` 写通道名。**禁 `*`、禁正则**（写了即条目失效 + CT4C 红）；**禁止用计数或前缀代替成员清单** |
| `docSection` | 该命名空间"本该在哪一节声明"的**可核对指针**（如 `"§7"`）；无相关章节写 `null`。指向不存在的章节 ⇒ CT4C 红 |
| `reason` | **必填**：为什么这些键不在文档覆盖面内（缺 reason ⇒ 条目失效 + CT4C 红；不变量 I4：放行即人工且可见） |

三条硬规矩：

1. **`members` 必须逐条精确**：`CT4` 做的是**集合相等**（多一少一都红），且匹配只用 `keyOf(kind, name)` 的精确 tuple
   —— `contract-scope.mjs` 里**不得出现** `startsWith`/`includes`/正则（有源码级断言钉住）；
2. **`sync` 不会写它**：`kit:sync` 只读它做摘要（`kit/cli.test.mjs` 断言"sync 前后逐字节不变"）。
   若由代码自动生成成员，登记就永远自洽、等于没有门禁；
3. **封顶值人工维护**：`versions.json#channels.scopeCount`（组数）/ `scopeRedCount`（键数）是人工写死的上限，
   超了报 `CT4B`。**新增范围**的正规流程：先确认这些键是真边界 → 加 `members` → **同时**上调这两个封顶值
   （它们只在升级时下调、不随入口自动涨，这是"范围被显式批准"的唯一痕迹）。

### 怎么摘条目

两条线索（都在 `check` 的输出里）：

- **scope / 基线未生效或已不再命中** ⇒ `（信息）基线中 N 条未生效或已不再命中，可摘除：…`（`kit:check` 默认输出的最后一行）
  以及 `CT4 多登记 <键>`（文档补上该键、或端点已删除/改名后出现）。摘除后**同步下调**
  `channels.scopeCount` / `scopeRedCount`（scope）或 `history.baselineCount`（基线）。
- **理由里的"何时摘除"**：每条保留的条目都写了可判定的摘除条件（例：CT9 的 `/v1/*` 是"上游 LLM 协议不经 bridge"的噪声，
  title 生成搬出渲染层后即可摘）。

### ★ committed 口径（为什么真值取提交态，而不是工作树）

**契约规则的真值 = 提交态（HEAD）**：`kit/lib/head-tree.mjs` 把 HEAD 物化成一份**临时干净检出**
（`git read-tree` + `checkout-index` → 系统临时目录；按 `(仓路径, sha)` 缓存，`marker.json` 最后写），
代码侧与文档侧都在它上面读，规则因此**与工作树脏不脏无关**。三条理由：

1. **台账是提交物**（`versions.json#channels` 随代码一起提交），CI 在**干净检出**上跑，
   本机门禁必须与 CI 同口径（铁律 4 的同一条理由）；
2. 反过来（规则读工作树）会逼出"为在途差异加基线"这种做法 —— 而基线按 `rule+subject` 认领，
   实测两个真漏洞：**真实端点键**的差异在任意方向被永久降级、**计数式 subject** 能认领任意同类单条；
3. 工作树∖HEAD 的差异不是欠账、是这个仓每天都有的状态 ⇒ **只由 CT8 报黄灯**，不需要任何基线。

配套的三条约定：

- **在途改动只报 CT8 黄灯、不红**：工作树里的新端点/新 WS 类型/新 IPC 通道/文档改动 ⇒ 红 0 + 逐条黄灯；
  **提交之后**同一处改动若没同步台账、没登记 scope，CT1/CT2/CT4 立刻红 —— 这才是"漏登记"该有的下场；
- **`drift-baseline.json` 只放真实的已知差异**（有据的欠账或噪声，每条写清"为什么不是 bug / 何时摘除"）。
  **不放"在途噪声"**：那些由 CT8 负责可见；
- **`sync` 也按提交态落盘**：脏树里跑 `sync` 不会把在途端点写进台账；它会打印
  `⚠ 工作树有 N 处在途契约差异**未落盘**`。所以流程是**先提交、再 `kit:sync`、再提交台账**。

★ **check 仍然只读仓库**：物化只写系统临时目录（`GIT_INDEX_FILE` 指到临时目录，不碰 `.git/` 与工作树），
`git status --porcelain` 不受影响。临时树按 sha 缓存 ⇒ 同一提交上只有第一次跑要付物化开销。

### ★ 端点搬家重构的协作约定（plan §8 的串行点）

"端点拆分 P1"（把 handler 从 `bridge.mjs` 搬到 `*-routes.mjs`）与本契约门禁**无耦合**：快照只存**语义键**
（方法 + 路径），**不存 `file:line`**（判定位置只出现在 finding 的 `hint` 里 —— plan §6 D2 的"搬家免疫"）。

**但搬家 PR 必须多做两件事**（否则 CI 红，且红的原因与搬家无关，会白花时间排查）：

1. 提交后跑 `npm run kit:sync` 并**提交 `channels` 的变化**（搬家若同时新增/删除了端点，快照会变）；
2. 若该端点在文档覆盖面之外，**同步更新 `contract-scope.json#members`**（键名若变 ⇒ CT4 集合相等报红）。

**`/boot-status` 的重复声明（协作事项，本批只记录不改）**：他人在途改动与 P1.5 在 §7 的**不同行号**
各补过一次（在途改动把它塞进 `/health`、`/diag/info` 那一行，P1.5 另起一行）⇒ **行号不重叠、无文本合并冲突**，
落地后只是**同一端点声明两行**（解析器按 `Map` 去重 ⇒ 门禁无害，`CT3`/`CT2` 都只认路径集合）。
他人在途改动落地后**删其一（保留 P1.5 补的那行）**即可。

**★ 用「局部暂存」提交 `docs/bridge-contract.md` 后，必须把工作树补回同步（否则你的改动会被下一次提交覆盖）**：
本仓的规矩是"改这份文档时**不许** `git add <path>`"（会把他人在途改动一起提交），
所以流程是 `git show HEAD:<path>` → 改 → `hash-object -w` → `update-index --cacheinfo`。
**代价**：提交后 **`HEAD` 变了、工作树还是旧版** ⇒ `git diff` 里会显示"你自己的改动被回退"，
且**下一手若 `git add`/`git commit -a` 这份文件，你的改动就被覆盖回去了**（静默丢失，门禁不会报警 ——
因为 `HEAD` 是对的）。
★ **前提限定（别忘了这条）**：这个代价**只在"该文件同时还有他人在途改动"时才出现**。
若该文件**没有**他人在途改动，那么"局部暂存的内容"与"工作树内容"本来就是同一份 ⇒ `HEAD` 与工作树一致、无需补同步。
**换成**：只要你在 `git diff -- <path>` 里看到**除了自己刚提交的改动之外的东西**（= 别人的在途改动），就要走下面的补同步。
⇒ **提交完做一次同步**（把工作树补成"新 `HEAD` + 他人在途改动"）：用三方 `git merge-file -p ours base theirs`，
其中 `ours = git show HEAD:<path>`、`base = 局部暂存前那次提交的版本`、`theirs = 工作树文件`；
★ **注意两件事**：① 该文件**以 LF 存储**，比对前要把工作树转成 LF（否则 CRLF 会让全文件冲突 ——
实测不转换会得到"单冲突块覆盖上千行"的假冲突）；② MSYS 的 `/tmp` 与 node 眼里的 `C:\tmp` **不是同一路径**
（临时文件写到会话目录更稳，否则 `readFileSync('/tmp/…')` 直接 `ENOENT`）。
**验收形态**：修完后 `git diff --numstat -- <path>` 应只剩**该文件他人在途的改动量**
（本次实测是 `2 1` —— ★ 这是**那一次**、**那个文件**的在途量，不是固定值；你自己的改动应已不在 diff 里，因为它在 `HEAD`）。

### 三条口径澄清（审查点名要写的）

- **`CT5 evaluated=156` 与 plan 说的"ipc 71"不是一回事**：`evaluated` 是**各侧独立计数之和**
  （invoke 61 + handle 61 + send 10 + on(main) 10 + on(renderer) 7 + push 7 = 156，配对判据必须按侧比，
  同一个通道在多侧各算一次）；"71 通道"是**去重后的通道数**（61 + 10）。数字不同是口径不同，不是漂移。
- **`CT3` 已是「方法 + 路径」对账（批 M，2026-09-19）**：文档 §7/§7.1 里**写了方法**的声明必须在代码里有
  **相容的键**。相容规则**原文**（判据只有一处实现：`contract-rules.mjs` 的 CT3 段；`CT2/CT4` **仍是路径粒度**）：

  | # | 规则 |
  |---|---|
  | ① | 代码键 = `'<METHOD> <path>'`（`METHOD ∈ {ANY, GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS}`；`ANY` = 提取器对"方法不可静态判定"的端点发的键） |
  | ② | 代码为 **`ANY`** ⇒ 与**任意**文档方法相容（真仓有 `ANY /agents`、`ANY /api/audit` 这类键） |
  | ③ | 文档**没写方法**（只写路径）⇒ **不判方法**（只判路径存在，保持此前语义 —— "没声明"与"声明错"不是一回事） |
  | ④ | 文档写了方法 ⇒ **逐个判**：每个被声明的方法都要有相容的代码键（`GET /x、POST /x` 需代码里两种都有，或 `ANY`）。★ 比"（文档方法 ∩ 代码方法）= ∅ 才红"更严：后者在"文档 GET+POST、代码只有 GET"时会**绿掉**那半条 |
  | ⑤ | 路径**只被动态前缀认领**（`/workflows/:id` 靠锚定正则匹配）⇒ 方法不可静态判定 ⇒ 只判路径、**不判方法** |

  形态侧同时补了三件事（否则判据无输入）：同路径**多行声明合并**（`/api/profile` 的读行 + `（POST）` 写行 ——
  此前 key 是 path，**后一条整条被覆盖丢弃**）、**行内方法**（`POST /x` / `GET/POST /x` —— 此前要求 token 以
  `/` 开头，`GET /a` 这类**整条解析不出来**）、**行尾括号的方法**（全角/半角都认，只从第一列读：写在"用途"列的
  `（GET）` 是散文，不算声明）。**方法名大小写不敏感**（复审批补的口子）：三个方法正则加 `i` 且解析结果
  **规范化为大写** —— 此前只认大写 ⇒ 行尾 `（delete）` 被当成"没写方法"（**静默绿**）、行内 `post /x`
  **整条消失**（反被 CT2 报"未覆盖"）、§7.1 的 `get /x` 整行解析不出（**连 CT2 都不红**）；
  `（POST 同义）` 这类**同义注释的豁免语义未变**（仍只记 `synonyms`、仍不是"必须存在"的方法）。
  `routes` 的值新增 `methods: Set` / `methodLines: Map`，`method` 保留为
  **兼容字段**（= 按字典序首个被声明的方法；不用"首个出现的"是因为那是书写次序的函数 ——
  `GET/POST` 与 `POST/GET` 必须给出同一结果）。
  真仓实测（**盘根干净克隆**，批 M 代码 + 提交态文档，@`1fed25f` 基线）：**绿**（0 条不相容 —— 真仓**写了方法的
  50 条声明**都与代码相容 = §7 的 **33** 个 `(方法,路径)` + §7.1 的 **17** 行；**注意 50 是"收进判据输入"的条数**，
  真被逐条比对的只有 **35** 条 —— 见下面的覆盖面口径，别把 50 读成"受判 50"）；
  变异实测（把 §7 第 296 行 `/probe-provider` 的 `（POST）` 改成 `（DELETE）` 并提交）
  ⇒ **`CT3` 红 1 条**：`[CT3] routes DELETE /probe-provider docs/bridge-contract.md:296`
  （文档声明 DELETE、代码只有 `POST /probe-provider`）；还原 ⇒ 红 0。
  ★ **覆盖面如实说明（这批不是"方法全量对账"）**：§7 有 **98** 条具体路径（非通配），其中**只有 33 条写了方法**
  （**12 行** = "方法真正被书写的行数"，可复算：271,280,282,284,288,290,294,295,296,299,301,302
  —— ★ 注意：`12` 与上一段的 `33` 是**两个口径**（12 是**行**、33 是**声明**：一行可含多端点，如 `/api/profile` 的
  `GET` 与 `（POST）` 在两行 ⇒ 该路径算 2 条声明；报数时必须点明用的是哪个）。
  ★ 另有 **2 行**（§7.1 的 `/workflows` 的 GET/POST）真被方法比对 —— §7.1 的 17 行里只有这 2 行没被动态前缀跳过，
  **不要**把 `12 + 2` 当成一个"口径"去报（它混了 §7 的"行"与 §7.1 的"行"，与 `33 + 2` 的声明口径也不同 —— 已被这条说明取代），
  其余 **65 条只写路径** ⇒ 按规则③**不判方法**。§7.1 的 **17** 行虽然都写了方法，但其中 **15 行只被动态前缀认领**
  （`/workflows/:id` 一族）⇒ 按规则⑤**跳过方法判定** ⇒ **真被方法比对的只有 2 行**（`/workflows` 的 `GET`/`POST`）。
  ⇒ **有效方法比对 = 33 + 2 = 35 / 115 = 30%**（分母 **115** = §7 的 98 条具体路径 + §7.1 的 17 行；
  **口径必须写明：`/workflows` 在 115 里被计 3 次** —— §7 路径 1 次 + §7.1 的 `GET`/`POST` 两行，
  这是"按声明计"的口径，不写清楚数字就复算不出来）；**人工兜底 = 115 − 35 = 80 条**。
  上面这几个数字是**"盘根干净克隆"复算值**（@`dfc1965` 提交态的 `docs/bridge-contract.md` + 批 M 代码）；
  主树因他人在途改动会多出端点，**别拿主树数字对表**。
  ★ 此前这里写过 **"受判 50 / 115（43%）"** —— 那是**高估**：50 把 §7.1 的 17 行全算成"受判"，
  而其中 15 行按规则⑤根本不判方法。审查独立复算纠正为 **35 / 115（30%）**。
  这不是缺陷而是"没声明≠声明错"，但要**如实计入**门禁强度：**想让覆盖率上去，得先把 §7 那 65 条补上方法写法**
  （那是文档工作，不是规则工作）；§7.1 那 15 行要受判，得先让代码提取器能**静态判定**这类路径的方法
  （动态前缀认领的路径，方法本就不可静态判定 —— 规则⑤）。
  **已知边界**：`（POST 同义）` 只记 `synonyms`、不当"必须存在"的方法（它是"也接受"的注释）；
  §7 的 `*` 通配行不判（不给覆盖信用，反例⑧）；写进第二列（用途）的方法名不算声明。
- **WS 的「方向」也是判据（P1.5 收尾批改的）**：`§5` = bridge → GUI（outbound）、`§6` = GUI → bridge（inbound）。
  此前两节合成**一个**声明集（`§5 ∪ §6`）⇒ **方向写反不红**：实测把 §5 的 `bridge_hello` 挪进 §6 后
  `kit:check` **红 0**（唯一信号是 `contract-doc.test.mjs` 的 26/16 计数）—— 而方向是契约语义：
  GUI 实现者会把 `send`/`onmessage` 写反。现在 `wsOut` 只减 §5 的声明集、`wsIn` 只减 §6 的，CT3 同理
  （§5 的每条声明必须在 `ws.out`、§6 的必须在 `ws.in`）。两个方向各有一条单元用例
  （`contract-rules.test.mjs` 的「收尾批①②」：挪一条 ⇒ `CT2`（未覆盖）+ `CT4`（未登记）+ `CT3` 三红；
  「收尾批③」钉住"只挪一行、条数不变，在 `CT8` 里也必须逐条可见"）。
  ★ 同批**在 §5 补了 `browser:event`**（此前只在 §6 声明）：它在代码里**双向**
  （`server/browser-routing.mjs` 广播给 GUI + bridge 的 `onmessage` 收执行器帧）⇒ "两节都写"才是对的
  （同 `pet:show-main`/`pet:quit-app`）。不补它，按方向判时 `wsOut` 真值会多出这一条
  （真仓实测：严格判据下的**唯一**红点 = `wsOut browser:event`）。**允许两节都声明同一类型**不是放宽：
  两个方向都是真的；该红的只有"只声明在一节、而代码对应方向没有它"。
- **`CT3` 的工具指纹取自哪里（`|| snapTools` 兜底的边界）**：`tools.shapeOf(name)` 是**运行时出口**
  （`await import('kernel/tools.mjs')` → `toolSchemas()`），`snapTools[name]` 是**已提交快照**
  （`versions.json#channels.tools`）；前者优先，`||` 兜底只在**"该工具名在出口清单里、但运行时给不出指纹"**
  时生效（实测两类触发：`kernel/tools.mjs` 不可加载 ⇒ 运行时 `byName` 为空、`names` 退化成静态 registry 键；
  静态 registry 有该键而 `toolSchemas()` 不导出它）。此时 CT3 对的是**快照** —— 于是分工是：
  **CT3 = 文档 ↔ 快照**；**快照 ↔ 运行时**归 `CT6`（`tools runtime` 显式红 + 逐工具指纹 + `staticToolCount`）；
  **快照 ↔ 代码**归 `CT1`（现场重算）。三者串起来 = **传递覆盖** ⇒ "改坏 `kernel/tools.mjs` 而 CT3 仍绿"
  是**设计**不是漏判（盘根干净克隆 @`87342a3` 实测：CT1 红 22 + CT6 红 1，CT3 `evaluated=183` 仍绿）。
- **工具指纹到底覆盖哪些 schema 关键字（批 F 收紧后的**如实边界**）**：`fingerprintOf` 的输入 =
  `JSON.stringify(shapeOfNode(schema, 0))`，**递归**取：
  `type`（数组则排序后 `|` 连接）· `enum`（**排序后**比较 ⇒ 换书写顺序不红）· `items`（含数组元素，递归）·
  `properties`（**含嵌套对象字段**，递归）· `required`（排序）· `additionalProperties`（**存在性**即判据，`<absent>` 与 `"false"` 不同）·
  `pattern` · `format`。**深度上限 8 层**（超出记 `nested:'<deep>'`，防病态嵌套吹爆输入）。
  ★ **字段次序 = `shapeOfNode` 的实际插入次序**（上面只是分类罗列，**不是**哈希里的顺序）：
  `JSON.stringify` **保留对象插入次序** ⇒ 仅凭上面的罗列**复现不出同一个哈希**。以源码为准，逐节点是：
  `type`（恒写）→ `enum`（写了才写）→ `pattern` → `format`（`SHAPE_KEYS = ['pattern','format']` 的顺序，
  且**仅当值是字符串**）→ 触到深度上限时写 `nested:'<deep>'` 并**提前返回** → `items` → `properties`
  （**键按字典序**递归）→ `required`（排序）→ `additionalProperties`。改这条次序 = 改所有指纹，
  必须走下面的"改口径流程"。
  **仍不纳入**（都有原因，不是遗漏）：`description`/`title`/`examples` —— **散文与展示**，改文案不该红；
  `minimum`/`maximum`/`minLength`/`maxLength`/`minItems`/`maxItems`/`uniqueItems`/`multipleOf` —— **数值范围约束**
  （值域，非形状；若日后要纳，需先想清"范围放宽"是否算契约变更）；`default` —— 属**行为**不属形状；
  `deprecated`/`readOnly`/`writeOnly` —— 元信息；`$ref`/`oneOf`/`anyOf`/`allOf` —— **组合子**（真仓当前**零使用**，
  一旦引入会被下面的守卫测试挡下）。
  ★ **守卫测试**（`contract-tools.test.mjs` 的「批 F④」）会**扫描真仓全部工具 schema**，
  出现"结构类关键字"却未在纳入/豁免名单里 ⇒ **直接失败**，逼后来者显式决定（杜绝静默漏判）。
  **改这批口径的完整流程**：改 `shapeOfNode` → 同步该测试的两份名单 → `npm run kit:sync`
  （重算 `versions.json#channels.tools`）→ `node kit/sync-fingerprints.mjs <in.md> <out.md>` 同步 §12 的 21 个指纹 → `check` 绿。
  （该脚本带**双向校验**：文档有而快照没有 ⇒ 报"文档腐烂"；快照有而文档缺 ⇒ 报"漏登记"；`--check` 只校验不写，
  可用来防"指纹过期"。刻意做成"对任意基线文件可复现"⇒ 提交时能走 `git show HEAD:` + `hash-object` + `update-index` 的**局部暂存**路径。）
  **批 F 实测**：21 条指纹**全变**（如 `Bash 055829fc → 5622e4cf`），`CT3` 一次报满 21 条红 ⇒ 逐条同步后才绿；
  变异（改某工具 `enum` 一个取值）⇒ `CT6` 红（快照↔运行时）；缺口证伪见「批 F①②③」三条单元用例。
  唯一保持 fail-closed 的方向：**两边都取不到指纹 ⇒ 红**（`liveFp === null` 分支）。**刻意不**收紧成
  "取不到就红"：CT3 若也承担运行时职责，就会与 CT1/CT6 重复报同一件事，并惩罚"快照已落盘、运行时临时
  不可用"的正常仓。单元用例 `contract-rules.test.mjs` 的「收尾批⑤」钉住这条分工（CT6 红 / CT3 不红）。

### CT2 与 CT4 的关系（如实的说明）

**`CT2` 是 `CT4` 的单向投影，没有独立判据**：`CT2` = "真值 ⊆ scope 命中"（逐条报"未覆盖"），
`CT4` = "真值 ∖ 文档已声明 == scope members"（集合相等：既含 `missing` 方向，也含 `extra` 方向）。
也就是说 `CT2` 判的东西被 `CT4` 完全覆盖。

**为什么不合并、也不硬造差异**：留 `CT2` 是为了报告的**归因可读性**（它逐条挂在"代码→文档"这条腿上，
hint 指文档补遗；`CT4` 的 hint 指 scope 登记），以及让"代码真值"这一侧**逐类可读**
（P1.5 起它遍历**五类**：routes/wsOut/wsIn/ipc/tools，每类的 `expected` 直接写成该补哪一节）。
把它改成独立职责（例如"每条真值必须能在文档小节定位"）需要引入新的口径（真值定义就要跟着改），
而"跨文档小节定位"的判据已经在 `CT4C` 的 `docSection` 指针与 `CT3` 里各有一半 ——
硬造一条新判据只会新增一套真相，属于 plan §7 反例的边界（做假）。**故如实写明"退化的形式"，不假装它独立。**

## 品牌标识与名称的统一管理（真源 = `kit/manifest/brand.json`；门禁 = CT10）

品牌名此前**分散在 4 个载体**里各写一份（`electron-builder.yml` 的 `productName`、`index.html` 的
`<title>`、`version.mjs` 的两行版本线注释、`versions.json` 的 `lines[].label`）—— 改一处没人告诉你另三处
没跟上。现在**唯一真源**是 `kit/manifest/brand.json`：

| 真源字段 | 内容 |
|---|---|
| `layers[]` | 两层名：`app` = **`YFWorking`**（用户可见：窗口标题 / 安装产品名）、`kernel` = **`ponos`**（★ 无 turbo） |
| `brandZh` | 中文品牌名（`新远方数据`）与它出现的位置（标识资源） |
| `declarations[]` | **14 条声明点**：`id` + `file` + `kind` + 取值位置（`key` / `pointer` / `constName`）+ `expects`（`{layer}` 或 `{literal}`）+ `why` + `severityIfWrong` |
| `retiredAliases[]` | 待废弃别名（`Ponos-Turbo` → `ponos`，层 `kernel`）+ 为什么废弃 + `scope` |
| `knownWidespread[]` | **已知广泛存在、明确不在门禁范围**：`Ponos-Turbo` 精确写法 **33 处 / 12 文件**（含各种写法 115 处 / 61 文件），散在 `kernel/`、`kernel-tests/` 与 `docs/` 的**叙述性文本**里（全仓统一改名是**独立工作项**）。★ 数字是 `measuredAt` 提交上的**快照**，会漂移 ⇒ 要当前值跑真源里的 `recompute` 命令（口径：提交态 HEAD、**排除真源自身**——它必然提到该别名） |
| `knownUngated[]` | **已知但未纳管的声明点**（运行时窗口标题、i18n 文案、安装器/图像资产、CLI 横幅）：如实登记还没统一，改名时人工过一遍 —— ★ 没有这份清单，14 条会被误读成品牌已全部统一 |

**14 条声明点**（判据口径在 CT10，逐条都能红）：

| id | file | kind | 取值位置 | 期望 |
|---|---|---|---|---|
| `product-name` | `electron-builder.yml` | `yaml-scalar` | `productName` | 层 `app` |
| `window-title` | `index.html` | `html-title` | `<title>` | 层 `app` |
| `app-id` | `electron-builder.yml` | `yaml-scalar` | `appId` | 字面量 `com.yfworking.desktop` |
| `npm-name` | `package.json` | `json-key` | 顶层 `name` | 字面量 `yfworking-gui` |
| `app-label` | `version.mjs` | `comment-label` | 含 `APP_VERSION` 的那行注释 | 层 `app` |
| `kernel-label` | `version.mjs` | `comment-label` | 含 `KERNEL_VERSION` 的那行注释 | 层 `kernel` |
| `lines-label-app` | `kit/manifest/versions.json` | `json-pointer` | `lines[id=APP_VERSION].label` | 层 `app` |
| `lines-label-kernel` | `kit/manifest/versions.json` | `json-pointer` | `lines[id=KERNEL_VERSION].label` | 层 `kernel` |
| `meta-description` | `index.html` | `html-meta-description` | `<meta name="description">` 的 `content` | 层 `app` |
| `shortcut-name` | `electron-builder.yml` | `yaml-scalar` | `shortcutName`（nsis 段：桌面/开始菜单快捷方式名） | 层 `app` |
| `copyright` | `electron-builder.yml` | `yaml-scalar` | `copyright`（安装器/属性里的版权行） | 层 `app` |
| `pkg-description` | `package.json` | `json-key` | 顶层 `description` | 层 `app` |
| `kernel-pkg-name` | `kernel/package.json` | `json-key` | 顶层 `name`（`ponos-kernel`） | 层 `kernel` |
| `kernel-pkg-description` | `kernel/package.json` | `json-key` | 顶层 `description` | 层 `kernel` |

★ 前 8 条是最初一批；**后 6 条是复核审查指出「只有 8 条 = 过度承诺」后补的** ——
`kernel/package.json` 那两条实测**残留着废弃别名**（`Ponos-turbo 内核独立部署包`），
恰好证明「没登记的声明点会悄悄漂移」。补进真源后，机器可读的声明点才算真的被统一管住。

两条 `expects` 口径（**别混**）：`{"layer":"x"}` ⇒ 实际值里**出现**该层名（**不区分大小写**、子串即过，
因为声明点通常还带别的说明文字，如「YFWorking 应用（ponos 内核版）」）；`{"literal":"…"}` ⇒ **精确等于**。

四条判据（`kit/lib/brand-rules.mjs`）：

1. **(a) 层名/字面量不符** ⇒ 红：`subject` = declaration id、`file` = 该文件、`line` = **实际行号**
   （定不到就 null）、`expected` = 期望的人话、`actual` = **实际取到的值**、`hint` = 怎么修
   （改那个文件，**或**改真源重新定义）；
2. **(b) 受管声明点里出现 `retiredAliases`** ⇒ 红（别名匹配**不区分大小写**）。★ 判据**只查声明点指向的
   那段文本**（某行注释 / 某 key 的值 / `<title>` 的内容 / 台账某条 label）—— **不扫整文件、更不扫全仓**：
   全仓那批叙述文本是 `knownWidespread`，明确不在范围（否则 CT10 会永远红，红灯失去信息量）；
3. **(c) 真源不可读/结构不合法**（文件缺、JSON 坏、14 条 declaration 不齐、`kind` 不认识、
   `severityIfWrong` 不是 `red`、声明点引用了不存在的层）⇒ 红（`subject` = `brand.json`）且**不抛异常**；
4. **`evaluated` 如实** = 实际检查的声明点数（健康态 = 14；真源不可读 = **0** —— 不许报成"8 条都过"）。
   另有 fail-closed 的一支：某条声明点**取不到值**（文件缺失、key 被删、格式变了）同样红 ——
   "取不到"不等于"没问题"（窗口标题丢了你不会收到任何别的告警）。

**读哪棵树（与其它 CT 一致）**：CT10 读**提交态**（`head*` / `readTracked`）⇒ 改完品牌**要提交**才被门禁看见；
要"现在这棵树改完没有"的即时反馈用 `node scripts/brand.mjs check`（**读工作树**，与 CT10 是同一份判据实现）。
**不可基线豁免**：`baseline.mjs` 的 `BASELINE_FORBIDDEN` 判据是"除 `CT9` 外全部 `CT`" ⇒ CT10 自动落进去
（这正是意图：品牌门禁不许靠加一条基线蒙过去）。

### 重新定义品牌（`scripts/brand.mjs`）

| 命令 | 作用 |
|---|---|
| `node scripts/brand.mjs show` | 打印真源（层名 + 14 条声明点含 `why` + 废弃别名 + 已知广泛存在 + 下一步） |
| `node scripts/brand.mjs check` | 按 CT10 判据查**工作树**：每条声明点一行（✔/✘ + `file:line` + 期望 + 实际 + 怎么修），有红 exit 1 |
| `node scripts/brand.mjs set <layer> <name>` | **重新定义**：改真源 `layers[].name` → **自动同步可安全同步的**声明点（`version.mjs` 两行注释、`versions.json` 的 `lines[].label`；两级名都进文本）→ 打印**仍需手工改**的清单（`productName` / `<title>` / npm 包名 / `appId` —— 改了会影响安装与发布身份，**不自动改**，只给具体建议值） |

用法错（未知子命令 / 缺参数 / 层名不合法）⇒ usage + **exit 2**。零依赖、不联网、不碰 git、不碰 `src/**` 与 `server/**`。
`set` 只在**本机**跑，且**不动**安装身份类声明点。

★ **生成点**（不在那 14 条声明点内，但改品牌时必须同改，否则会被 `kit:sync` 冲掉）：
`kit/lib/ledger.mjs` 的 `LINE_SPECS` 里 `APP_VERSION.label` / `KERNEL_VERSION.label` ——
`versions.json` 的 `lines[].label` 由它**重写**（`label` 不在 `MANUAL_FIELDS` 里）⇒
**只改 `versions.json` 会在下一次 `kit:sync` 被改回旧名**。`set` 的清单里会给出这两条的具体新文本。
（同理 `scripts/bump-version.mjs` 的控制台标签是同源文案，人手维护。）

## 章（`kit-stamp.json`）的字段集



`npm run kit:stamp` 写出 `release/YFWorking/kit-stamp.json`（`release/` 被 `.gitignore` 覆盖 → **local-only，不进 CI 门禁**）。

- **字段集以 spec §8 + `kit/lib/stamp.test.mjs` 为准，不含 `debug`**：spec §8 原文没有 `debug` 字段（其"形状示意不是契约"那段仍成立，故 Task 14 把字段集写成了明确列表）；仓内也不存在可记的调试状态，加一个恒 `null` 的字段只会让人误以为"调试态可查"。**不要照早期计划草图把它加回来。**
- `channel` / `appVersion` / `kernelVersion` / `guiVersion` / `commit` / `commitSubject` / `dirty{tracked,untracked}` / `tag` / `ahead` / `builtAt` / `artifacts[]` / `missing[]` / `stampFile`。
- 三条版本值**只读** `kit/manifest/versions.json`（单一真源）；读不到 → `null`（不是 `undefined` —— 落盘会被 JSON 丢掉）。
- 无 tag ⇒ `tag: null` + `ahead: null`（"没有锚点"是**未知**，不拿"全部提交数"冒充）。
- `artifacts[].path` 一律**仓库相对 + 正斜杠**，且按码元序稳定排序；未构建的产物根进 `missing`（未构建也要能盖章）。
- **本仓首个 tag `v3.0.0-dev.0` 打在 `5684580`（P0 HEAD = `anchors` 归零提交）** —— 所以 `git show v3.0.0-dev.0 --stat` 只看得到 `docs/_anchors.json`，**不是** tag 漏了功能提交：P0 的全部功能在该提交之前的 `816f7f0` 等提交里，tag 落在"红灯归零 + 锚点复核完"的那一刻是刻意的。

## 四条铁律

1. **不许手改 `sync` 生成的字段**：`values` / `location` / `evidence` / `sha256` / `packages[].status` 由 sync 重写，人工改动会被覆盖。
   人工段（sync 原样保留）只有：`versions` 的 `exclude` / `note` / `consumers` / `migrationNote` / `manual` 条目 / `history`；`deps` 的 `_note` / `python.embedded` / `notes` / `gates` / `sizes`。
2. **放行即人工且可见**：`kit/manifest/drift-baseline.json` 独立成文件、每条写 `reason`；豁免**红灯**必须在该条目显式写 `"severity": "red"`，条目数不得增加。
3. **扫描域是 `git ls-files`**：新写的文件/测试不 `git add` 就不在判定范围内；新增测试文件后必须重算 `docs/_anchors.json`。
   ★ **唯一例外（第 4 批）**：`CT8` 的**工作树侧**额外含「未忽略的未跟踪文件」（`--others --exclude-standard`）——
   否则未 `git add` 的新路由模块对"在途差异"整块不可见（实测：报告还打印"与 HEAD 一致"）。契约**真值侧**与其余全部规则照旧只看索引。
4. **铁律 4（真仓数字口径）**：凡从真仓实测得到、且会随他人未提交改动漂移的数字（测试计数、**路由/端点条数**、文件数、行数、schema 数…），引用时**必须取干净克隆（盘根目录）的值**；主树数字必须显式标注「含他人在途改动」并给出干净克隆值。
   **本规矩同样适用于测试代码里的硬编码期望值**（例：`kit/lib/contract-routes.test.mjs` 的真仓路由数）。
   **替代做法**：若该数字会在主树漂移，**改用"点名断言 + 下界"**，并在注释里写明口径。
   判定方法：把该数字拿来问「**这是哪棵树测的？**」——答不出即违规。
   适用范围（不许只当"报告用语规范"看）：任何**报告、提交信息、文档**（含 commit message、审查意见、进度汇报）**以及测试代码里的硬编码期望值**。**只允许这两种形态**：① 用**干净克隆**（**盘根目录**，如 `C:\p2rev`、`C:\t14rev` —— 不能在家目录链上的 `/tmp`）实测的数字；② 主树数字，但**必须在同一句里显式写「含他人在途改动」并同时给出干净克隆的数字**。**裸数字**（只写"762 项"而不说测的是哪棵树）与**拿主树数字当全量数字**（不标注、直接说"全仓 762 项"）**一律算违反本条**。
   原因（实测）：主树长期有**他人在途的测试文件**，同一个提交在两棵树上会给出不同计数 —— `src/**/*.test.ts` 实测 **762 项（主树）/ 710 项（盘根干净克隆）**；**路由条数**同理：同一提交 **105（主树，含他人在途端点 `ANY /app-info`、`POST /generate-title`）/ 103（盘根干净克隆）**。主树数字还会随别人的提交悄悄变，而读者无从分辨。引用数字前先问"这棵树干净吗"，不干净就去干净克隆里重测。
   ★ **这个坑出现过三次**（P0 的 src 762/710；`075e369` 用本铁律判出 5 处裸计数；`9c8cc3f` 把主树路由数写进**测试期望值** ⇒ 干净检出必红）—— 根因是"只讲了报告/文档里的**引用**，没覆盖**测试代码里的硬编码期望值**"，故本条已按上面的措辞把它纳入范围；**在测试里钉真仓数字时，优先用"点名 + 下界 + 注释口径"，而不是精确相等**。

## CI 里的位置

`.github/workflows/ci.yml` 的 `test` 作业：`npm run typecheck` → **`npm run kit:check`（单独一步）** → `npm run test:ci`。
单独一步的理由是**归因**（台账漂移 ≠ 测试挂了）；`test:ci` 里也含它，本地一条命令即可跑全。

**为什么它必须进 CI**：本仓唯一能抓"依赖删了但其实还在用"的就是 P2；而**本机这条判定不成立** —— 家目录下的杂散 `node_modules` 会沿父目录链把缺声明的包解析到（本仓内 `import('nanoid')` 实测 OK，盘根克隆 `ERR_MODULE_NOT_FOUND`，见 `docs/待处理清单.md` 的"杂散 node_modules"条）。所以"删包之后本机全绿"不构成证据，**只有 CI / 盘根克隆上的判定才是真实的**。

## GUI（报告）与 agent 入口

**一块完全独立的报告界面**——**不起服务、不监听端口、不接应用界面**（不碰 `src/**`/`server/**`，
不引任何依赖，不复用应用主题）。生成一个**自包含单文件 HTML**（CSS/JS/数据全内联、零外链），
`file://` 双击即可打开：

```bash
npm run kit:gui                          # → kit-report.html（默认）
node kit/gui.mjs --out scratch/r.html    # 指定输出
node kit/gui.mjs --open                  # 生成后用默认程序打开
node kit/gui.mjs --json                  # 只打数据包（给脚本消费）
npm run kit:agent                        # ★ 给 agent：打印套件规范纯文本
```

★ **产物不入仓**（`.gitignore` 里有 `/kit-report.html`）：它是生成物，随时 `npm run kit:gui` 再生。
★ 生成**总是 exit 0**（报告工具）：哪怕门禁红，也要能生成报告看为什么红 —— 结论写在页面顶部与 stdout 里
（`门禁结论：红 N ⇒ EXIT=1`）。数据来源是**公开 JSON 出口**（`kit/cli.mjs check --json` + `view --json`），
所以 GUI 与 agent 读的是**同一份**契约输出；注意 `check` 在红时**退出码 1 但仍有完整 JSON**，取数要解析 stdout 而不是看退出码。

页面共**八段**（侧边锚点导航）：概览 / 红灯与黄灯（可按 rule 与 severity 筛选）/ 规则矩阵 /
台账 / 依赖域 / **版本控制** / **品牌标识与名称** / **Agent 套件规范**。

- **版本控制**段是**只读展示**：版本线（`versions.json` 的 `lines`/`contracts`/`history`）+ **git 锚定现状**
  （分支 / HEAD / HEAD 标题 / 未提交 tracked·untracked / tag 数与最新 tag / worktree 列表）。
  **快照、回退、对比、清理**（影子引用快照 `refs/yfw/snap/*`）由 `docs/superpowers/specs/2026-09-15-version-manager-design.md`
  （已批准）的 **version-manager 工作线**实施 —— 本 GUI **不重复实现、不写 git**。
- **品牌标识与名称**段现在展示**真源**（两块的顺序）：(a) **品牌真源**（`kit/manifest/brand.json`：层级名
  `app=YFWorking` / `kernel=ponos`、中文品牌名、**14 条声明点表**（含每条 `why`）+ **已知未纳管清单**；
  (b) **废弃别名与已知广泛存在**（`Ponos-Turbo` → 应替换为 `ponos`；精确 33 处 / 12 文件散在
  `kernel/`、`kernel-tests/` 与 `docs/` 的叙述文本里 —— **不在门禁范围**，是独立工作项），
  外加"重新定义"的**可复制命令**（`node scripts/brand.mjs show | check | set <layer> <name>`）。
  段内仍保留"只读汇总"的定位（页面无任何写操作），但**一致性不再是"只提示不断言"**：
  **CT10 已生效**（14 条声明点逐条对账、**不可基线豁免**），结论逐条出现在「红灯与黄灯」与「规则矩阵」里；
  探针表新增 `declId` 一列（探针与真源声明点**按 id 对齐**，对不齐的显示 `—`，不硬凑）。

### agent 每次开发如何按套件规范执行（四层，防漂移）

1. **单一真源**：`kit/lib/agent-guide.mjs` 的 `AGENT_GUIDE`（纯数据：四段「开工前 / 改动契约面时 / 交付前 / 红灯怎么修」
   + 四条铁律 + CI 锚点 + **入口登记 `entry`**）。**清单内容只写在这一处**。
2. **两个消费端**：GUI 的第 8 段渲染它；`npm run kit:agent` 给 agent 打印**纯文本**（含可复制命令）。
3. **入口层（两个文件，别混）**：
   - **仓根 `AGENTS.md`** = **自动注入入口**（工具开工自动读仓根同名文件；Ponos 内核也自动发现 ——
     `kernel/prompt.mjs#discoverAgentsMd` 从 cwd 逐级向上到 `.git` 所在目录 + `--add-dir` 根）。
     极短，只放"入口 + 红线 + 坑"，**必须指向真源**（否则它自己会长成第二份清单）。
     ★ **它要进便携版**（调试版人工测试环境）—— 三条同步路径见上文《agent 自动注入入口与其「不掉」保障》；
     此前它**不在任何同步清单里** ⇒ 调试版里**从来没有**入口，agent 静默不受约束。
   - **`kit/AGENT.md`** = 规范清单的**可读副本**（≈ `npm run kit:agent` 的内容，≤60 行），给"已经在本仓翻文档的人"。
     ★ 它**不是**自动注入入口 —— 别把这两者当成一个（这正是本节的由来：早先 README 把入口写成了 `kit/AGENT.md`）。
4. **门禁**：**CT11** 核入口（必备锚点 + 行数上限 + **便携版同步清单**，真源 = `AGENT_GUIDE.entry`，
   **不可基线豁免**）；CI 里的 `npm run kit:check`（`.github/workflows/ci.yml`）作最后拦截。
   ★ **有牙齿**：`report.test.mjs` 会核对 `AGENT_GUIDE.ci.line` 与 CI 文件里 `kit:check` 的**实际行号**
   —— CI 挪了行号而没同步 ⇒ 测试红。

### 「只报不拦」是**一份**名单，别再各处硬编码

`report.mjs#NON_BLOCKING_RULES` 是唯一真源（当前 `CT8`/`CT9`/`P5`/`P6`），`gui-data.mjs` 把它算进
`checks[].nonBlocking` 供渲染层使用。★ 起因是一次实测缺陷：渲染层曾各自硬编码 `['CT8','CT9']`，
而 `P5`/`P6` 同样只发 `YELLOW` ⇒ 被**误标成「阻断」**，读者会把"本来就不拦"读成"门禁失败"。
现在 `report.test.mjs` 把名单与规则实现**双向锁死**：源码里发过 `YELLOW` 的规则**必须**在名单里，
名单里的规则**不得**发过 `RED`（并含反向自证，防正则写坏导致断言恒真）。

## 目录

```
kit/cli.mjs                 唯一入口：check | sync | view | stamp
kit/lib/scan.mjs            扫描基座（git ls-files 域扫描）
kit/lib/ledger.mjs          台账读写 + syncVersions / syncDeps / syncSkillsLock
kit/lib/version-rules.mjs   V1–V8′（11 个规则号）
kit/lib/dep-rules.mjs       P0–P7（8 个规则号）
kit/lib/head-tree.mjs       提交态（HEAD）物化：契约规则的唯一真值来源 + worktreeClean
kit/lib/contract-routes.mjs 路由提取器（4 种判定形态 + 动态前缀）
kit/lib/contract-ws.mjs     WS 事件类型提取器（发送函数白名单 + 守恒）
kit/lib/contract-ipc.mjs    IPC 通道提取器（按侧：invoke/handle/send/on/push）
kit/lib/contract-tools.mjs  工具 schema 提取器（运行时出口 + 静态 registry + 结构指纹）
kit/lib/contract-doc.mjs    bridge-contract.md 解析器（§5/§6/§7/§7.1 表）
kit/lib/contract-snapshot.mjs 契约快照（复算 / 落盘 / 逐类比较）
kit/lib/contract-rules.mjs  CT0–CT12（含 CT4B/CT4C/CT8 与品牌 CT10、agent 入口 CT11、DevKit 边界 CT12）
kit/lib/brand-rules.mjs     ★ CT10：品牌声明点 ↔ 品牌真源（8 条；零依赖取值；只查声明点那一段）
kit/lib/contract-scope.mjs  范围登记判定（只读；禁通配、禁自动生成）
kit/lib/python-manifest.mjs 内嵌 Python 包清单的唯一读取入口（构建脚本与测试同源）
kit/lib/report.mjs          统一报告 schema + 人话渲染 + **NON_BLOCKING_RULES（只报不拦的唯一真源）**
kit/lib/baseline.mjs        漂移基线、红灯认领与数量护栏
kit/lib/stamp.mjs           dev 渠道身份（章）
kit/lib/agent-guide.mjs     ★ agent 套件规范唯一真源（AGENT_GUIDE + 纯文本渲染）
kit/lib/gui-data.mjs        独立 GUI 的数据组装（纯函数；走公开 JSON 出口 + 只读台账）
kit/lib/gui-html.mjs        独立 GUI 的单文件 HTML 渲染（零外链、数据内联）
kit/gui.mjs                 独立 GUI 入口：--out | --json | --agent | --open
kit/AGENT.md                ★ agent 入口（简短指针，不含清单内容）
kit/manifest/versions.json  版本台账（唯一真源；`#channels` 是契约快照）
kit/manifest/brand.json      ★ 品牌**唯一真源**（层名 / 14 条声明点 / 废弃别名 / 已知广泛存在 / 已知未纳管）—— 改它 = 重新定义
scripts/brand.mjs           品牌「可重新定义」入口：show | check（读工作树）| set <layer> <name>
kit/manifest/deps.json      依赖台账（唯一真源）
kit/manifest/contract-scope.json  🖐 人工维护的范围登记（sync 绝不写它）
kit/manifest/drift-baseline.json  🖐 人工维护的已知漂移（每条写 reason；**不放"在途噪声"**）
kit/schema/*.json           台账自身 schema
```
