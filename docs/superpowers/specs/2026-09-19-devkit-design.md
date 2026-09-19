# DevKit（SDK 开发套件）设计方案

日期：2026-09-19 ｜ 状态：设计已获用户批准（三处决策已锁定），待实施
范围：P0（版本 + 依赖台账与漂移门禁）。P1–P4 另出独立计划。

---

## 0. 一句话

把"架构已完善、但标准/版本/依赖/资源四者之间没有机器可读契约"这件事补上——**套件首先是一层可判定的工程契约，包化是它的结果而不是起点**。

---

## 1. 背景：为什么现在需要它

YFWorking 现状（全部实测，非推断）：

| 面 | 已具备 | 缺口 |
|---|---|---|
| 规范 | `README.md`（源码自述，含 §8 的 17 条「注释↔代码不一致」清单）、`docs/architecture.md`(467 行)、`docs/bridge-contract.md`(456 行)、`docs/ci.md`(130 行)、`docs/_anchors.json` | 全是**散文**：AI 与人需读数万字才能判断是否合规，没有一条可被程序判定 |
| 版本 | 4 条版本线 + 20 处版本常量 + 技能 3 套版本载体 | **`git tag` = 0 个**；四类载体互不校验；`skills-lock.json` 20/20 哈希不符 |
| 依赖 | npm 52 运行时 + 13 dev、内核零依赖、内嵌 Python 13 包、技能侧 requirements | 四域**零台账**：无来源/用途/未用判定/体积门禁 |
| 测试 | **408** 个测试文件（**已入库**口径，与 `docs/_anchors.json` 的 `testTotal` 一致）、3678 断言（**主树**实测、**含他人在途改动** —— 测试计数必须注明测量树，见 `kit/README.md`「四条铁律」第 4 条）、`scripts/test-tiers.mjs` 为分层口径单一真源、`ci-preflight` 抓"零测试绿灯"、`perf-baseline` 性能门禁 | 11 个 `verify-*.mjs` **零挂载**；6 个构建/校验脚本无 npm script；无覆盖率 |
| 设计资源 | `themes.css` 三主题、`tailwind.config.ts`、logo/icon 派生链、安装图 | **无机器可读 token 真源**（CSS 是真源、Tailwind 是手抄镜像）；派生资产无谱系 |
| AI 通道 | 约 30 个内置技能、11 个 agent 定义、7 个记忆模板、工具模板、spec-dev 工作流、MCP | 各一套格式，无统一 schema、无版本、无一致性校验 |
| GUI 载体 | `FilesHistoryOverlay` + `viewStore.SecondTabId` 抽屉机制、Settings、AppsPanel、知识/工作流/用量/诊断面板 | 无"套件资源"视图，无"红灯在哪"的统一入口 |

**根因一句话**：能力长齐了，但标准、版本、依赖、资源之间没有任何机器可读的契约把它们钉在一起。`README.md` §8 的 17 条不一致清单就是这份诊断的最强证据——不是文档没写好，而是**没有台账**。

---

## 2. 需求（用户已确认，三处决策锁定）

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 套件定位 | **本体工程 DevKit**：管理 YFWorking 自身（版本/依赖/契约/设计资源/出包），不面向第三方发布 |
| D2 | P0 范围 | **版本 + 依赖台账与漂移门禁** |
| D3 | 落地形态 | **先 `kit/` 目录**，零构建改造；验证有效后再按需包化为 `@yfw/kit` |
| D4 | 调试版 | **保留**。它是开发基座 + 用户测试通道；套件不改其工作方式，只给它**可追溯的渠道身份** |
| D5 | `skills-lock.json` 语义 | **重定义为「本地安装后哈希」并纳入门禁**（重算 20 条基线） |
| D6 | 历史欠账 | **P0 顺带修完**，不留给基线长期挂着 |

---

## 3. 设计总纲：四条不变量

| # | 不变量 | 现状反例（实测） |
|---|---|---|
| I1 | **单一真源**：一个事实只写一处，其余派生 | `tailwind.config.ts` 手工镜像 `themes.css`；`src/lib/knowledgeQuery.ts` 手写镜像 `shared/knowledge-core.mjs` |
| I2 | **判据是「是否入库」**，不是「磁盘上有没有」 | `scratch/`（gitignored）内含 claude-code 参考源码副本与 `ponos-repo`；磁盘遍历会把参考代码当本仓源码 → **依赖判定的扫描域必须是 `git ls-files`**（先例：`scripts/check-doc-anchors.mjs` 的 `repoHas`） |
| I3 | **门禁必须可复现**：同一提交在任何机器上结论一致 | 不得读本机 `.git/info/exclude`（先例：`check-doc-anchors.mjs` 刻意用显式 `LOCAL_PREFIXES` 清单） |
| I4 | **放行即人工**：白名单/基线独立成文件、每条写理由 | 反例（已被规避的设计）：把白名单塞进自动生成文件，则一次 `--write` 就等于把所有问题自动放行 |

---

## 4. 架构

```
kit/
  cli.mjs                      唯一入口：check | sync | stamp | view
  lib/
    ledger.mjs                 台账读写（版本 + 依赖）
    version-rules.mjs          版本校验规则（V1–V8 + V8′，见 §5.3）
    dep-rules.mjs              依赖校验规则（P1–P6，5 类引用证据，见 §6.2/§6.3）
    scan.mjs                   git ls-files 域扫描（I2）
    report.mjs                 统一报告 schema + 人类可读渲染
    baseline.mjs               漂移基线（读取/比对/数量护栏）
  manifest/
    versions.json              版本台账（唯一真源）
    deps.json                  依赖台账（唯一真源）
    drift-baseline.json        🖐 人工维护的已知漂移（每条写 reason）
  schema/
    versions.schema.json
    deps.schema.json
  *_test.mjs                   与 lib 同层单测（新增测试层，见 §7.1）
  README.md                    给 AI 的操作契约（结构化，非散文）
```

**消费端（三层，各自只读同一批 manifest）**：

```
            kit/manifest/*.json  ← 唯一真源
              （versions/deps 由 sync 生成；drift-baseline 由人工编辑，见 I4）
                    │
   ┌────────────────┼─────────────────────┬──────────────────┐
   ▼                ▼                     ▼                  ▼
kit/cli.mjs    npm run kit:check      server/kit-routes.mjs   kit/README.md
（AI 经 Bash）  （CI 门禁）            （GUI 经 HTTP）         （AI 提示词）
```

---

## 5. 版本台账设计

### 5.1 `manifest/versions.json` 分区（全部实测）

| 分区 | 内容 | 实测现状 | 宿主 |
|---|---|---|---|
| `lines` | 四线：APP / KERNEL / GUI / KB-schema | `dev 3.0.0`、`dev 0.2`、`2.8.0`、schema 1 | `version.mjs:9,12,15`、`package.json:3` |
| `contracts` | 14 处项目自有版本常量 | 实测 `git grep` 得 **20 处** `*_VERSION = ` 声明（初稿写的"17 处"来自更窄的 grep 模式，2026-09-19 Task 3 实施时实测修正）；其中减 `ANTHROPIC_VERSION` ×2（外部协议版本，不纳管；该常量出现在 `electron/app-llm.cjs` 与 `electron/app-websearch.cjs` 两处）、`SUPERPOWERS_VERSION` ×1（上游技能资产，不纳管）、版本线已纳管 3 处（`version.mjs` 的 `APP_VERSION`/`KERNEL_VERSION`/`SCHEMA_VERSION`）→ 余 **14 处**纳管 | `kernel/graph.mjs`、`kernel/knowledge-import.mjs`、`kernel/loop.mjs`、`kernel/mcp-http.mjs`、`kernel/session.mjs`、`kernel/team-store.mjs`、`kernel/workflow-dsl.mjs`、`server/workflow-store.mjs`、`shared/knowledge-core.mjs`、`shared/tag-registry.mjs`、`shared/team-crypto.mjs`、`shared/team-members.mjs`、`shared/team-source.mjs`、`electron/vault.cjs` |
| `skills` | 22 条技能版本（`skills.json` ↔ `SKILL.md` frontmatter） | **实测 22/22 一致（0 漂移）→ 好基线，纳入门禁即可** | `public/skills.json`、`public/sample-skills/*/SKILL.md` |
| `skillsLock` | 20 条 sha256 | **实测 20/20 与本地文件不符**（lock 原记上游原文，本地已被 frontmatter/占位符改写）→ 按 D5 重定义为本地安装后哈希。2026-09-19 Task 9 已重算：**重算后 20/20 一致**（`syncSkillsLock`：`updated 20 / unchanged 0 / missing 0`，二次运行 `updated 0 / unchanged 20` 幂等）。★ 哈希**先对行尾归一（CRLF → LF）再算**：本仓 `core.autocrlf=true` 且无 `.gitattributes`，同一个 `SKILL.md` 在长驻工作树是 LF、在干净克隆是 CRLF —— 按原始字节哈希会让干净克隆里 **15/20 假红**（实测），判据就成了"检出方式"的函数 | `skills-lock.json` |
| `commonTools` | `_common` 下 Python 工具的版本 | 实测实有 **98 个 `.py`**；manifest 仅登记 9 条；且 98 个脚本中**零个**声明 `__version__`。2026-09-19 Task 9 已全量登记 **98/98**（有版本者 9 条 `versionSource=manifest` 且值等于 manifest 的 `current_version` 可复算；未标注者 89 条 `version=null` + `unmarked`，**不回填、不编造版本号**） | `public/sample-skills/_common/_common_manifest.json`（其顶层 `_note` 说明该版本不可从脚本内容校验） |
| `channels` | 渠道身份（dev / release） | 新增，见 §8 | `release/YFWorking/kit-stamp.json`（local-only） |
| `history` | 版本变更流水（`{key, from, to, at, reason}`） | 新增。**V3 单调性与 §7.3 基线数量护栏都读它**，故必须与台账同文件存放，不能另建文件（否则两者可能不同步）。★ 字段名是 **`key`**（`<id>@<file>`，与 `keyOfVersion` 同构）：`kit/lib/version-rules.mjs` 按 `r.key` 分组，写成 `id` 的记录会被归进 `undefined` 组 —— **V3 根本不核它（静默失效）**。2026-09-19 Task 9 rider 3 改正（此处曾误写为 `id`） | `manifest/versions.json` 的 `history` 分区 |

### 5.2 台账条目形状

```jsonc
// contracts 分区单条（必须"可解析-回读"：校验时重新解析宿主文件比对）
{ "id": "INDEX_VERSION", "file": "shared/knowledge-core.mjs", "line": 44,
  "kind": "data-schema", "value": 4,
  "consumers": ["src/lib/knowledgeQuery.ts"],   // 同口径镜像处（I1 的观察点）
  "note": "知识索引格式；改值必须提供迁移链" }
```

### 5.3 校验规则（版本侧 11 个规则号，每条都要能真红）

> **规则条数口径（2026-09-19 Task 8 收口，此前三处并存）**：口径统一为 **规则号数**，不是"表格行数"。
> 本套门禁共 **19 个规则号** = 版本侧 11（`V1`、`V1b`、`V2`–`V8`、`V8b`、`V8′`）+ 依赖侧 8（`P0`–`P7`）。
> 其中 `V1b`（台账键唯一）、`V8b`（实有 `.py` 全部登记）**不在下表**（它们是同一判据轴上的反向/唯一性补充，
> 单列规则号是为了让"哪条判据失败"一眼可辨）；`P0` 在下表 §6.3 中。
> 因此 **`summary.rules` 必须恒为 19**（`--verbose` 的"规则逐条（19）"同源），
> 表 §5.3 九行 + §6.3 八行 = 17 只是"表内行数"，不得再当作规则条数引用。

| # | 规则 | 判据 | 现状会红吗 |
|---|---|---|---|
| V1 | 声明位置可解析 | 台账声明的定位（`file` + `locator`）处仍能解析出该常量且值相等 | 否（初始同步后应全绿） |
| V2 | 每条线至少一个载体 | `lines` 每项有宿主文件 | 否 |
| V3 | 历史链连续（★ 比 semver 单调更严） | ① `history.records` 的链首尾相接（上一条 `to` == 下一条 `from`）；② **末条 `to` == 当前台账值**。即"任何值变更都必须记账"，防静默改值。**不**做 semver 大小比较（记账为 `from:4,to:2` 可过）——落地后按实测收紧措辞 | 否（新机制） |
| V4 | 跨载体映射一致 | `KERNEL_VERSION='dev 0.2'` ↔ `kernel/package.json:3 '0.2.0'` | 否（当前一致） |
| V5 | schema 变更需迁移链 | `kind=data-schema` 且值变更时，必须同时出现迁移条目 | 否（新机制） |
| V6 | 技能版本**三方**一致（Task 8 补齐） | ① `skills.json.version` ↔ `SKILL.md` frontmatter 逐条相等；② **台账 `skills[].value` / `frontmatterVersion` 必须等于源文件复算出来的真值**（与 V1 同族）。缺②时台账可被静默改值而无人报红，且报告文案"三方一致"对外说假话（评审发现的 V6 返工项，2026-09-19 Task 8 落地并补反例测试） | 否（实测 22/22 三处一致） |
| V7 | lock 语义落地 | 20 条 sha256 == 实际 `SKILL.md` 文件哈希（判据恒为**已提交的 `skills-lock.json`**，不读台账 —— 否则跑一次 sync 就能把门禁刷绿；见 §5.1 与 `version-rules.test.mjs` 的"防自证"反例）。哈希按**行尾归一后**的内容算（与 `syncSkillsLock` 同一函数，见 §5.1） | 否（Task 9 重算后 20/20 一致，实测红灯 V7 20 → **0**；干净克隆里同样 0） |
| V8 | manifest 覆盖 | `commonTools` 记录的条目 ⊆ 实有 `.py`，且**覆盖率不得下降** | 否（Task 9 实测 98/98 登记，V8/V8b 全绿） |
| V8′ | 新增文件必须自证版本 | **新增的** `.py` 必须携带 `__version__` 或显式登记 `version: null` + `versionSource:"unmarked"`（**存量 98 个豁免**，见 §5.4） | 否（新机制） |

### 5.4 关于 V8 与 98 个 `.py` 的处理口径（明确划界）

98 个 `_common/*.py` 是**技能侧资产**（源自 `~/.claude/skills`，经 `scripts/sync-builtin-skills.mjs` 同步），其中 89 个从未在任何 manifest 里登记版本。方案：

- **不**为此给 98 个文件回填 `__version__`（会制造大量与本套件无关的技能改动，违背"变更最小"）；
- `commonTools` 台账**全量登记 98 条**，未标注版本者值记为 `null` + `versionSource:"unmarked"`；
- 新增规则 **V8′**：**新增** `.py` 必须携带 `__version__` 或显式登记 `null`（防止欠账继续扩大）；
- 覆盖率作为**趋势指标**记账，不设"必须 100%"的硬门禁（避免再一次 churn）。

---

## 6. 依赖台账设计

### 6.1 四域分区

| 域 | 来源 | 实测数量 |
|---|---|---|
| `npm-runtime` | `package.json` dependencies | 52 |
| `npm-dev` | `package.json` devDependencies | 13 |
| `kernel` | `kernel/package.json` | **0**（零依赖，已有 `server/deploy-smoke.test.mjs` 断言） |
| `python` | 内嵌：硬编码在 `scripts/build-embedded-python.mjs:82`（13 包）；技能侧：`public/sample-skills/_common/requirements.txt`（约 25 包） | 两处**不同集、无对账** |

### 6.2 ★ 未用判定必须靠四类引用证据（P0 最容易做错的地方）

只扫 `import` 会得出 11 个"未用"，其中 **6 个是假阳性**：

| 证据类 | 例（实测） | 只做类 1 的后果 |
|---|---|---|
| 1. `import` / `require`（源码域内） | `class-variance-authority`、`zustand` | — |
| 2. **动态 `import()`** | `scripts/patch-icon.mjs:10` 的 `await import('rcedit')` | `rcedit` 误判未用 |
| 3. **配置文件引用**（根级：`vite.config.ts`、`tailwind.config.ts`、`postcss.config.js`、`tsconfig.json`、`index.html`） | `@tailwindcss/typography`、`@vitejs/plugin-react`、`tailwindcss`、`postcss`、`autoprefixer`、`typescript`、`vite` | 7 个误判 |
| 4. **CLI 调用**（`package.json` scripts、`execSync('npx …')`、`electron-builder.yml`） | `electron-builder`（`scripts/build-installer.mjs:65` 的 `npx electron-builder`） | `electron-builder` 误判未用 |
| 5. 类型包特例 | `@types/node`、`@types/react`、`@types/diff` 等 | 由 `tsconfig.json` 消费，按"声明的类型包"登记为 `types` 类，不参与未用判定 |

**实测结论（四类证据齐备后）**：真正未用的运行时依赖 **10 个**：
`classic-level`、`diff`、`mammoth`、`nanoid`、`xlsx`、`@tanstack/react-virtual`、`@radix-ui/react-collapsible`、`@radix-ui/react-context-menu`、`@radix-ui/react-popover`、`@radix-ui/react-separator`。

> **状态：这 10 个已于 2026-09-19 全部删除**（DevKit Task 10 / 欠账 B1）。做法与证据：**逐个**删（不批量 —— 删错的代价是线上功能静默失效），每删一个跑 `npx tsc --noEmit` + `npm run test:unit`（`xlsx`/`mammoth` 两个高风险包另跑 `npm run test:server`），并立刻 `npm run kit:sync` 让台账跟上（P7 双向对账因此不许"删了忘 sync"），单包单提交便于回滚。结果：`dependencies` 52 → 42、`kit:check` 红灯 **14 → 4**（P1 清零，只剩 P2 的 4 条真幽灵）、`npm run build` 产物与删前**逐字节一致**。
> 副作用（如实登记，需后续裁定）：`jszip` 在锁里的**唯一**来源就是 `mammoth`，删后 `shared/pack-zip.test.mjs` 的"与 jszip 双向对拍"在干净环境会 `t.skip` 跳过 —— 见 `docs/待处理清单.md` 的 B1 条目。

> 注：`ws` 经核实**在用**（`electron/` + `server/`），`README.md` §4.8.8 把它与 `classic-level` 并列描述，实测二者不同——以台账判定为准。

### 6.3 校验规则（依赖侧 8 个规则号：`P0`–`P7`）

> 口径同上（§5.3 的"规则号数"）：本表 8 行 + §5.3 表 9 行 = 17 是**表内行数**；
> 加上表外的 `V1b`、`V8b` 才是实现与 `summary.rules` 的 **19**。
> **`P0` 也必须有 `checkResult`**（Task 8 收口）：原先"台账缺失"分支只 push finding 就早退，
> 结果 `summary.rules` 报 18、`--verbose` 的逐条表里看不到 `P0` —— 报告与实现两套口径。
> 现在 `P0` **无条件** push（台账在 → `passed=true`），故正常仓的 `rules` 也恒为 19。

| # | 规则 | 说明 |
|---|---|---|
| P0 | 台账存在 | **读不到 `deps.json` → 红**（单列规则号而不并入 P1：P0 是"文件在不在"这条判据轴，并入 P1 会把"没台账"说成"某条声明没证据"，而那时根本没有声明可判定）；**该规则同样产出 `checkResult`（无条件，台账在即 `passed=true`）**，否则 `summary.rules` 少一个规则号、`--verbose` 里缺一格 |
| P1 | 声明 ⊆ 有证据 | 每个依赖至少一类引用证据，否则 `unused` |
| P2 | 反向幽灵依赖 | 源码 import 了但未声明 → 红 |
| P3 | 域隔离 | 内核域恒零依赖（复用既有断言）；`ws` 归 `electron,server` 而非 `src` |
| P4 | Python 包清单化 | 13 包从 `build-embedded-python.mjs` **提到 `deps.json`**，脚本读清单（消 double） |
| P5 | 双 Python 清单对账 | 内嵌集 vs `requirements.txt` 的差集必须显式标注（一方缺项 → 黄灯+说明，不红） |
| P6 | 体积记账 | 记录每域体积（`node_modules` 实测 379M、`runtime/python` 415M、`runtime/skills` 180M），仅趋势，不设阈值；**核对的键 = `syncDeps` 真正写下的 3 个**（`SIZES_KEYS`），缺一项即该规则未通过（旧口径"有任意一键就通过"宽到无法失败） |
| P7 | 台账 ↔ `package.json` 双向对账 | ① 台账声明的包必须出现在 `package.json` 的 `dependencies` / `devDependencies` / `optionalDependencies`（少一个 = 台账陈旧 → 红，提示重跑 `npm run kit:sync`）；② 反向：`package.json` 声明了但台账没有 → 红。**`peerDependencies` 不纳入**（peer 是消费方约束、不是本仓分发内容；纳入会让正常配置假红，且"把包从 dependencies 挪进 peer"会变成绕过 P7 的后门）。为什么必须有：P1/P2 **只读台账**，宿主删掉声明却不重跑 sync 时两条规则一条红都不报（实测删 zustand / xlsx / @types/node，红灯数仍是 14） |

---

## 7. 门禁接入

### 7.1 测试层（套件必须自己先守规矩）

`scripts/test-tiers.mjs:9` 明文规定"新增一层测试目录时，**三处一起改**"。套件新增 `kit/**/*.test.mjs` 层，同步改：

1. `scripts/test-tiers.mjs` 的 `TEST_GLOBS`
2. `package.json` 的 `test` / `test:unit`
3. `docs/ci.md` 的口径说明 + `npm run anchors:write`

**⚠️ 自审发现的真实机制缺口（必须如实记录，不要以为现有门禁能兜住）**：
`scripts/check-doc-anchors.mjs` 的「门禁 A′（分层清单 vs package.json 测试脚本一致性）」用的是 **`warnings.push`，不是 `problems.push`** —— 也就是说：
- 漏改 `package.json`（`TEST_GLOBS` 加了 kit 层而 test script 没加）→ 只有**黄字警告，退出码仍为 0**；
- 漏跑 `anchors:write` → 门禁 A 只遍历**锚点已有的键**，新增的层根本不在遍历范围内，不会报任何东西。

即"新增测试层漏同步"当前**不会让 CI 变红**。套件的第一件事就是把自己要依赖的机制补硬：把 A′ 从 warning 升级为 **problem（红）**，并让门禁 A 在"`TEST_GLOBS` 有键但锚点无该键"时也报红（双向覆盖，而非单向）。该改动列入 §10 的 C4。

### 7.2 CI 接入

`.github/workflows/ci.yml` 的 `test` 作业，在 `typecheck` 之后、`test:ci` 之前插入一行：

```yaml
- name: DevKit 台账门禁
  run: npm run kit:check
```

**性能约束**：`kit:check` 必须 **< 5s、零网络**（纯文件解析 + `git ls-files`），否则会拖慢 30 分钟上限的 CI 作业。
实测（Task 14 Step 1，主仓 3 次 853/863/815 ms）满足；落地位置见 `.github/workflows/ci.yml` 的「DevKit 台账门禁」步骤（**单独一步**，`typecheck` 之后、`test:ci` 之前；`test:ci` 内也含它）。
★ 该步骤的**存在理由**不只是"接进门禁"：本仓唯一能抓"依赖删了但其实还在用"的是 `kit:check` 的 P2，而本机因家目录杂散 `node_modules` 会给出假绿 ⇒ 只有 CI（干净检出）上的判定才是真实的（详见 `docs/ci.md`「为什么这条门禁必须进 CI」与 `docs/待处理清单.md` 的同名条目）。

### 7.3 漂移基线（`manifest/drift-baseline.json`）

🖐 **人工维护、独立文件、每条写 reason**（I4）：

```jsonc
{ "version": 1,
  "_note": "登记后不再计入漂移数，但条目数与「红灯豁免数」都不得增加；减少时应摘除条目",
  "entries": [
    { "rule": "P5", "subject": "python.embedded-vs-requirements",
      "reason": "内嵌集是分发态最小集，requirements.txt 含可选增强包（rapidocr-openvino 等）",
      "at": "2026-09-19" },

    // 豁免「红灯」必须在条目里显式认领（见下方规则 1）
    { "rule": "V7", "subject": "skillsLock.brainstorming",
      "severity": "red",
      "reason": "20 条锁哈希为上游原文，待 A3 重算；本轮先登记以免阻塞 P0 落地",
      "at": "2026-09-19" }
  ] }
```

#### 豁免规则（★ 2026-09-19 裁定：基线不得无声抹平红灯）

> **为什么需要这条**：初版设计里 `applyBaseline` 无条件把命中的 finding 降级为 `baselined`，
> 于是**加一行 JSON 就能把红灯变绿**，且报告首行照样打印「✅ 通过」。这使整个门禁可被
> 单行人工编辑绕过 —— 与 I4「放行即人工」的初衷相反（I4 要求的是"人工且**可见**"，
> 不是"人工即可静默"）。但完全禁止豁免红也不可行：P0 落地时仓库本身存在 20 条锁哈希红，
> 若红不可豁免则门禁永远无法变绿。故取"**可豁免，但必须显式认领 + 始终可见 + 数量封顶**"。

1. **默认只豁免黄**。基线条目命中**黄**灯时，直接记为 `baselined`（不计入漂移数）。
   命中的是**红灯**时，**只有条目里显式写了 `"severity": "red"`** 才豁免；
   没写就**不豁免**，该 finding 保持红（即"随手加一行 `{rule,subject,reason}`"只能豁免黄，豁免红必须亲手动笔认领）。
2. **`reason` 必填且非空**。缺 reason 或 reason 为空白 → 该条目**不生效**，且额外报一条红
   `BASELINE_NO_REASON`（把"I4 无处强制"变成"违反 I4 本身就是红灯"）。
3. **豁免统计必须始终可见**。`makeReport` 暴露 `baselined: { total, red }`；`renderHuman`
   **在任何情况下（含通过）**都要打印豁免统计行；**通过行不得写成裸「✅ 通过」** ——
   有豁免时必须写成 `✅ 通过（红灯 0 / 基线豁免 N 条，其中红灯 M 条）`（M>0 时另起一行逐条列出
   `rule subject reason`，让人一眼看到"绿灯里藏着 N 条人工放行"）。
4. **两条数量护栏**（都记在 `versions.history`，都读 `baselineGrowth`）：
   ① 基线条目**总数**不得超过上次记录数；
   ② 其中**豁免红灯的条数**不得超过上次记录数。
   防"遇到红灯就往基线里塞"。超限 → 红。

**数量护栏**：`check` 会断言"基线条目数不超过上次记录数"（记在 `versions.history`），防"遇到红灯就往基线里塞"。
（规则 4 的两条护栏是本条的精确化版本；`versions.history` 需同时记录 `baselineCount` 与 `baselineRedCount`。）

---

## 8. 调试版渠道身份（D4：保留 + 可追溯）

不改调试版的工作方式，只给它盖章。`kit/cli.mjs stamp` 写出：

```jsonc
// release/YFWorking/kit-stamp.json（release/ 是 gitignored → local-only，不进 CI 门禁）
{ "channel": "dev", "appVersion": "dev 3.0.0", "kernelVersion": "dev 0.2",
  "guiVersion": "2.8.0", "commit": "<sha>", "commitSubject": "…",
  "dirty": { "tracked": 20, "untracked": 3 },
  "ahead": 0,                       // 距最近 tag 的提交数（P0 打首个 tag 后可算）
  "builtAt": "2026-09-19T…+08:00",
  "artifacts": [{ "path": "dist/index-*.js", "sha256": "…", "bytes": 2131494 },
                { "path": "kernel-dist/cli.mjs", "sha256": "…", "bytes": 482161 }] }
```

回答的问题：**"用户正在测的这版，对应哪个 commit、含哪些产物、是否 dirty、差多少个提交"**——现在这个问题无法回答。

**字段集（明确列表 —— 上段 JSON 只是形状示意，本列表才是契约；Task 14 / Rider 4-2 补）**：

`kit-stamp.json` 的字段**恰好**为以下 13 个（顺序即原子写落盘顺序）：

| 字段 | 类型 | 语义 |
|---|---|---|
| `channel` | `"dev"` | 渠道身份（本节第一性字段；release 渠道另有其身份，本任务不做） |
| `appVersion` | string \| null | 读 `kit/manifest/versions.json` 的 `APP_VERSION` |
| `kernelVersion` | string \| null | 同上，`KERNEL_VERSION` |
| `guiVersion` | string \| null | 同上，`GUI_VERSION` |
| `commit` | string \| null | `git rev-parse --short HEAD` |
| `commitSubject` | string \| null | `git log -1 --pretty=%s` |
| `dirty` | `{ tracked, untracked }` | `git status --porcelain` 的**分类**计数（已跟踪改动 / 未跟踪文件） |
| `tag` | string \| null | 可达的**最近** tag（`git describe --tags --abbrev=0`）；无 tag ⇒ `null` |
| `ahead` | number \| null | 最近 tag 到 HEAD 的提交数；无 tag ⇒ `null`（不拿"全部提交数"冒充） |
| `builtAt` | string | ISO 时间（可注入，便于复现） |
| `artifacts` | `[{ path, sha256, bytes }]` | 产物清单；`path` = 仓库相对 + 正斜杠，按码元序稳定排序 |
| `missing` | string[] | 未构建的产物根（如 `["dist","kernel-dist"]`）—— 未构建**不是错误** |
| `stampFile` | string | 落盘绝对路径（`<root>/release/YFWorking/kit-stamp.json`） |

**不含 `debug`**：早期计划草图里写过"未构建时 `debug: null`"，但本节从未定义该字段（Task 13 审查裁定：仓内不存在可记的调试状态，一个恒 `null` 的字段只会让人误以为"调试态可查"）⇒ **不要加回**。
字段集的执行判据是 `kit/lib/stamp.test.mjs` 的断言（含"可 JSON 无损序列化"、`null` 而非 `undefined`），本文档与它必须同时改。

**Task 13 交付时定下的几处判据**（都以 `kit/lib/stamp.test.mjs` 的断言为准）：
- `artifacts` 的 `path` 一律**仓库相对 + 正斜杠**；未构建的产物根进 `missing`（`["dist","kernel-dist"]`），**不是**报错 —— 未构建也要能盖章。
- `tag` / `ahead`：无 tag ⇒ 两者都是 `null`（"没有锚点"是**未知**，不冒充成"等于全部提交数"）；有 tag ⇒ `ahead` = 最近 tag 到 HEAD 的提交数。
- 版本三字段只**读** `kit/manifest/versions.json`（单一真源，不重复采集）；读不到 ⇒ `null` 而不是 `undefined`（`undefined` 落盘会被 JSON 丢掉，字段看着"在"实际"没了"）。
- `write` 为真就落盘（原子写），**拿不到 git 事实也照写**（`commit: null`）："退出码 0 但什么都没写"比没有章更危险。

---

## 9. 双通道（AI 与人）

| 通道 | 产物 | 设计要点 |
|---|---|---|
| **AI** | `kit/cli.mjs view --json` + `kit/README.md` | 输出**固定 schema**，AI 不必解析散文；`README.md` 写"何时跑、怎么读红灯、改台账的正确顺序"，并声明**禁止手改 manifest 中的生成段** |
| **人** | `kit/cli.mjs check --verbose` | 人话报告：红灯 → 定位（`file:line`）→ 建议动作 |
| **GUI**（P3） | `src/components/kit/KitPanel.tsx` + `server/kit-routes.mjs` | 四视图（台账 / 红灯 / 依赖 / 资源），经既有 `SecondTabId` 抽屉接入（同 `VersionPanel` 的 +1 行接法）；路由模块与 `logs-routes.mjs` / `knowledge-routes.mjs` **同构** |

**统一报告 schema**（`check` 与 `view` 共用，AI 侧稳定契约）：

```jsonc
{ "ok": false, "generatedAt": "…",
  "summary": { "red": 1, "yellow": 2, "baselined": 1, "green": 40 },
  "findings": [{ "rule": "V7", "severity": "red", "subject": "skillsLock.brainstorming",
                 "expected": "f8a4a6…", "actual": "79fec7…",
                 "file": "skills-lock.json", "hint": "跑 npm run kit:sync 重算本地哈希" }] }
```

---

## 10. P0 历史欠账清单与修复方式（D6：顺带修完）

> **逐条状态（2026-09-19 Task 14 收尾时按实测回填，本条规则：只允许"✅ 已修 + 实测证据"或"⏸ 未执行 + 用户决定 + 原因"，不允许"已尝试"）**。
> 表中每一行都带状态标记；`⏸` 项 0 条 —— A1–A7、B1–B3、C1–C4 **全部已修**。
> ★ 行数口径更正：§12 曾写"共 17 条"，但本表实际只有 **14 行**（A1–A7 七行 + B1–B3 三行 + C1–C4 四行）；
> 此处按**实际行数**逐条标注，并把 §12 的数字一并改正。

| # | 欠账（实测） | 修复方式 | 验证 |
|---|---|---|---|
| A1 | ✅ 已修（Task 13）：`git tag` = 0 个 | 首个版本锚点 `v3.0.0-dev.0`（annotated）打在本轮**红灯归零后**的 HEAD 上（属写仓库操作，**用户单独批准**；只打本地 tag、**不 push**）；`kit/lib/stamp.mjs` 让"距锚点差多少提交"可算 —— `ahead` = `git describe --tags --abbrev=0`（可达的**最近** tag）到 HEAD 的提交数，**无 tag 时 `ahead: null` + `tag: null`**（不拿 `rev-list --count HEAD` 这个"全部提交数"冒充锚点：真仓会报出 4 位数，看的人会误以为"落后很多"）。★ **tag 落在 `5684580`（`anchors` 归零提交，即 P0 HEAD）** —— 不是丢在功能提交上：`git show v3.0.0-dev.0 --stat` 只见 `docs/_anchors.json`，因为 P0 的功能提交（`816f7f0` 等）都在它之前，而 tag 刻意打在"红灯 0 + 锚点复核完"的那一刻（语出 Task 14 / Rider 4-4，`kit/README.md` 同步写明） | `git tag -l` → `v3.0.0-dev.0`（0 → 1）；`git show v3.0.0-dev.0 --stat` 指向 P0 归零提交 `5684580`；`stamp` 实测 `tag: "v3.0.0-dev.0"` / `ahead: 0`（夹具：tag 后再提交 → 1；多 tag 仓取最近 tag ⇒ 1 而非 2）。两处变异（ahead 回退成全部提交数 / 改取最老 tag）均被抓红后还原 |
| A2 | GUI 版本线（`package.json` 2.8.0）无 bump 入口 | ✅ 已修（Task 8）：`bump-version.mjs` 增加 `pkg` 目标。★ **`pkg` 目标不带 `dev ` 前缀**（Task 9 rider 4 明写进本行）：宿主是 npm 的 `package.json`，值必须保持合法 semver —— `app-builder-lib` 对非 semver 抛 `Invalid major number`，`semver.major('dev 2.9.0')` 实测抛错。照"版本格式一律 `dev <major>.<minor>`"改回去会**打断 GUI 发布线** | `--dry-run` 三线各自演练正确；`pkg` 写出纯 semver |
| A3 | ✅ 已修（Task 8）：`version.mjs:7` 注释称"三条独立版本线"，`bump-version.mjs` 只支持 `app\|kernel`（其他直接 fail）→ 注释↔代码不符 | 脚本补 `pkg`，注释同步为"四条" | 实测 `version.mjs:3` 现写"四条版本线"并逐条列出；`bump-version.mjs` 的 `TARGETS` = `app`/`kernel`/`pkg`（`:33-35`），非法目标仍非 0 退出（用法行 `:43`） |
| A4 | ✅ 已修（Task 3 落地 · Task 14 复核）：14 处版本常量无台账 | 纳入 `contracts` 分区（V1 可解析-回读） | `kit:check --verbose` 实测 `[V1] evaluated=18`（14 条 `contracts` + 4 条 `lines`）全绿；`[V1b] evaluated=18`（台账键唯一）全绿 |
| A5 | ✅ 已修（Task 8）：`server/version.test.mjs` 不存在 → `bump-version.mjs` 的"同步测试期望值"分支**永走跳过**（死路径） | 二选一：补该测试文件，或删除该死分支改为显式说明（**取"补测试文件"**，让版本断言真正存在） | `server/version.test.mjs` 已入库（15,338 字节，Task 8 交付）；"该测试能红"的实测：改错版本值即失败（Task 8 变异验证）；`bump-version.mjs` 的同步分支现在真的命中它 |
| A6 | `_common_manifest.json` 仅 9/98；98 个 `.py` 零个声明 `__version__` | ✅ 已修（Task 9）：台账全量登记 **98/98**（未标注者 `null` + `unmarked`，**不回填版本值**）；`_common_manifest.json` 补顶层 `_note` 说明 `current_version` 不可从脚本内容校验；V8′ 只对**新增**文件强制 | 漏登记计数 0（实测 `实有 98 已登记 98 漏登记 0`；9 条来自 manifest / 89 条 `null`）；V8、V8b、V8′ 全绿 |
| A7 | `skills-lock.json` 20/20 哈希不符 | ✅ 已修（Task 9）：按 D5 重定义为**本地安装后哈希**，新增 `syncSkillsLock` 重算 20 条（`kit/cli.mjs sync` 的占位调用已替换为真实现）；V7 **直读 lock 文件**（不读台账，防"sync 自证"）；哈希**对行尾归一**（`core.autocrlf=true` 的干净克隆否则 15/20 假红） | 实测 V7 红灯 **20 → 0**（主仓与干净克隆都为 0）；二次运行 `updated 0 / unchanged 20`（幂等）；改任一 `SKILL.md` 后立刻红（含"台账里塞正确哈希也不影响判定"的防自证反例） |
| B1 | ✅ 已修（Task 10）：10 个未用运行时依赖 | **逐个核实后删除**（每个都跑 `typecheck` + `build` + 全量测试；`xlsx`/`mammoth` 需先确认无运行时动态加载） | 删除后 `kit:check` **P1 的 10 条 `unused` 清零**（红灯 14 → 4，余下 4 条是 P2 真幽灵，已由 Task 12 Rider A 补声明清零 → 红灯 0）；`npm run build` 产物与删前**逐字节一致**。完整证据（含"4 个 `@radix-ui/*` 仍在锁里"的诚实更正）在 `docs/待处理清单.md` 的 DevKit B1 条 |
| B2 | ✅ 已修（Task 11）：内嵌 Python 13 包硬编码在 `scripts/build-embedded-python.mjs` | 真源移到 `kit/manifest/deps.json#python.embedded`（人工维护、`sync` 原样保留）；新增**唯一读取入口** `kit/lib/python-manifest.mjs` 的 `readEmbeddedPackages({ root })` —— **构建脚本与测试共用它**，读不到 / 键为空 / 条目非字符串一律**抛错**（绝不返回空清单：那会"装 0 个包却报成功"）。★ 为什么不把 `readEmbeddedPackages` 直接写在构建脚本里：测试不能 import 构建脚本（它会下载并安装 Python 运行时），写在脚本内 = 测试只能"读源码正则"，退化成弱断言 | 实测包清单与迁移前**逐条一致**（13 条，真源搬家不改行为）；`kit/lib/python-manifest.test.mjs` 8 用例：① 行为——换 `root` 下的台账 ⇒ 返回值**跟着变**；② 失败开放——缺失/空/形状错/**不传 root** 均抛错；③ 构建脚本**调用点**（`= readEmbeddedPackages({ root: … })`，只 import 不调用是假绿）+ 无本地实现 + 无引号包裹的包名字面量 + 无裸数组；④ 同源——构建脚本 import 的说明符必须解析到测试 import 的同一文件；⑤ 真仓清单**不得缩水**（删包必须是有意改基线）。变异测试三处（改回硬编码列表 / 让实现缓存首值 / 从台账删一个包）均被抓红后还原 |
| B3 | ✅ 已修（Task 11）：双 Python 清单（内嵌 13 vs requirements 23）无对账 | 差集**逐项**写进 `deps.json#notes`：`pythonOnlyEmbedded` **6** 条（beautifulsoup4 / jinja2 / openai / pydantic / pypdf / pypdfium2）、`pythonOnlySkills` **16** 条，每条 `reason` 指向真实调用点或**显式**标注"未核实"；P5 黄灯**刻意保留**（差集是预期事实、不是错误 —— 见 spec §6.3），但不再可能"静默"（差集逐条列在报告里） | 测试断言（读真仓台账）：实测差集里的**每个**包都必须在 `notes` 里有非空且 ≥10 字的 `reason`，且 `reason` 要么含调用点文件名、要么显式写"未核实"（删条目 / 清空理由 / 写一句空话 → 立刻红）；`kit:check` 黄灯 **1**（P5，差集原样列出，条目数未变：仅内嵌 6 / 仅技能 16） |
| C1 | ✅ 已修（Task 12 · Task 14 在干净克隆复核）：`_anchors.json`：407 vs 已跟踪 **408**（`kernel-tests` 209 vs 210） | `npm run anchors:write` | 干净克隆（盘根 `C:\t14rev`，`npm ci` 后）`node scripts/check-doc-anchors.mjs` **EXIT=0**；最近一次重算见 commit `5684580`（kit 层 8→9 个测试文件、总 407→408） |
| C2 | ✅ 已修（Task 12 · Task 14 更新）：11 个 `verify-*.mjs` **零挂载** | 分两类：CI 可跑的挂进 `test:ci`；需图形会话/真内核的挂**独立 npm script** 并在台账登记为 `manual` 门禁 | `package.json` 中 11 个均可执行（`npm run verify:<后缀>`）；`deps.json#gates` 三桶由**实测**决定，`kit/cli.test.mjs` 三条测试守（每个脚本恰好归一个桶 / `ci ⊆ verify:ci ⊆ test:ci` / 非 ci 桶必写 reason）。Task 14 更新：`verify-knowledge-gui` 的 3 项失败已修（2 项改组件、1 项改脚本），从 `pendingFix` 移入 `ci` 并串进 `verify:ci` ⇒ `pendingFix` **3 脚本 15 项失败 → 2 脚本 12 项失败** |
| C3 | ✅ 已修（Task 12）：`build-kernel` / `build-embedded-python` / `build-installer` / `package-portable` / `sync-builtin-skills` / `bump-version` 均无 npm script | 全部挂 npm script（`kit:` 与 `build:` 命名空间） | `kit/cli.test.mjs` 的 C3 测试逐条断言 6 个脚本文件存在且各有 npm 入口（命名空间为 `build:*` / `skills:*` / `version:*`） |
| C4 | ✅ 已修（Task 1）：**门禁 A′ 只管黄不管红**（§7.1 实测）→ "新增测试层漏同步"不会让 CI 变红 | `check-doc-anchors.mjs`：A′ 由 `warnings` 升级为 `problems`；门禁 A 双向覆盖（`TEST_GLOBS` 有键而锚点无该键 → 红） | `scripts/check-doc-anchors.mjs:331-351` 全部走 `problems.push`（含"该层只挂在 CI 不跑的脚本上"）；`:309` 是"锚点缺键"方向的 `problems.push`。Task 1 的变异验证：故意漏改 `package.json` 的 test script → 退出码非 0 |

> **C2 的分类判据（实施时逐条判定，判定结果写入 `deps.json` 的 `gates` 段）**：需要 Electron 真二进制、图形会话或真内核进程者归 `manual`（先例：`docs/ci.md` 已记载 `verify-gui-fidelity.mjs` 与权限流校验依赖图形会话/真内核）；纯 Node 且无外部进程依赖者归 `ci`。**不允许凭印象分类**——每条都要给出"为什么不能进 CI"的一句话依据。

> **说明**：`scratch/`（含 claude-code 参考副本、`ponos-repo`）与 `release/`、`dist/`、`kernel-dist/`、`runtime/` 均为 gitignored，**不在任何扫描域内**（I2）。这是设计层面的硬约束，不是遗漏。

---

## 11. 风险与已知边界

| 风险 | 表现 | 缓解 |
|---|---|---|
| **首填即大面积红** | 台账首填暴露 A6/B1/C2 等欠账 | D6 已定"顺带修完"；未修完项走基线 + 数量护栏 |
| **未用依赖误判** | 动态 import / CLI / 配置文件引用被漏判 | §6.2 四类证据齐备；删除前逐个跑构建验证 |
| **扫描域污染** | `scratch/` 里的参考代码被当本仓源码 → 判"在用" | 全部扫描限定 `git ls-files`（I2） |
| **新增测试层漏同步** | `kit/*.test.mjs` 未同步三处 → 整层静默消失 | 套件自身进 `TEST_GLOBS`；**先修 C4**（把 A′ 升级为红 + 双向覆盖），修复后漏同步才会真红——修之前该风险**实际存在**，不可假设已有门禁能兜住 |
| **门禁拖慢 CI** | 逐文件解析 + `git grep` 超时 | `kit:check` 硬约束 < 5s、零网络；必要时加进程内缓存 |
| **基线被滥用** | 遇红就塞基线 | 基线独立人工文件 + 数量不得增加的护栏 |
| **技能侧改动过大** | 为 98 个 `.py` 回填 `__version__` 制造无关 diff | §5.4：只登记不回填，只对新文件强制 |
| 不改的边界（明确划界） | — | 不动三条构建链（内核 bundle / vite / electron-builder）；不动调试版工作方式；本方案**不**做包化、不做对外 SDK、不做 UI 设计系统重构（P2/P3 另出计划） |

---

## 12. 分期

| 期 | 内容 | 交付判据 |
|---|---|---|
| **P0** ✅ **已交付（2026-09-19，分支 `kit/p0-ledgers`，tag `v3.0.0-dev.0`）** | `kit/` 骨架 + 版本台账 + 依赖台账 + `check/sync/stamp/view` + 测试层接入 + CI 接入 + §10 全部欠账（A1–A7、B1–B3、C1–C4 = **14 条**，原文误写"17 条"，已在 §10 更正） | 交付物：`kit/cli.mjs` + `kit/lib/{scan,ledger,version-rules,dep-rules,report,baseline,stamp,python-manifest}.mjs` + 8 个同层测试文件 + `kit/manifest/{versions,deps,drift-baseline}.json` + `kit/schema/*.json` + `kit/README.md`（AI 操作契约）+ `.github/workflows/ci.yml` 的「DevKit 台账门禁」单独一步 + `docs/ci.md` 的 DevKit 一节。判据：`npm run kit:check` **红灯 0 / 黄灯 1（P5 差集，刻意保留）**、实测 **853 ms**（< 5s 硬约束，零网络）；19 个规则号各有正反例测试（反例真跑真红，逐一做过变异验证） |
| P1 | 契约快照（bridge 路由 / WS 事件类型 / IPC 通道 / 工具 `input_schema`）↔ `docs/bridge-contract.md` 双向对账 | 判据**两条**（原文"双向对账、差异 = 0 或已登记"在文档缺半壁时不可行，见 `.superpowers/sdd/2026-09-19-devkit-p1-contracts/plan.md` §1）：**(a)** 快照可从代码**复算**、差异 = 0（`CT0`/`CT1`，复算对象 = **提交态 HEAD**）；**(b)** **范围登记完整** = 代码真值 ∖ 文档已声明（`CT2`–`CT4`/`CT4B`/`CT4C`，登记只允许逐条精确键、禁通配）。另：在途改动（工作树 ∖ HEAD）只报 `CT8` **黄灯**，不需要基线 |
| P2 | 设计资源单一真源（`tokens.json` → 生成 `themes.css` + `tailwind.config.ts`，消灭手抄镜像；派生资产谱系） | 生成物与手写版逐字节对齐后才替换 |
| P3 | `KitPanel` GUI（四视图）+ `server/kit-routes.mjs` | 面板可用；路由层有端到端测试 |
| P4 | 包化 `@yfw/kit`（exports / 类型 / 独立 semver） | 按需启动，前置是 P0–P2 稳定 |

---

## 13. P0 验收标准

| # | 标准 | 验证方式 |
|---|---|---|
| G1 | 台账是唯一真源且可解析-回读 | 手改任一宿主文件的值 → `kit:check` 立刻红并给出 `file:line` |
| G2 | 每条校验规则有正反例测试 | `kit/*_test.mjs`：正例绿、反例红（**反例必须真跑真红，不允许只断言"函数返回 false"**） |
| G3 | 依赖判定四类证据齐备 | 用 `rcedit`（动态 import）、`electron-builder`（CLI）、`@tailwindcss/typography`（配置文件）做**回归夹具**：三者都必须判为"在用" |
| G4 | 扫描域 = `git ls-files` | 在 `scratch/` 放一个 import 了未用依赖的文件 → 判定**不受影响**（该文件不入库） |
| G5 | 漂移基线可用且防滥用 | 登记黄灯 → 不再计入漂移数；**登记红灯必须显式 `severity:"red"`，否则仍为红**；缺 reason → 红（`BASELINE_NO_REASON`）；豁免统计在报告里始终可见；条目总数或红灯豁免数增加超过记录值 → 红 |
| G6 | 门禁接入且不拖慢 | `npm run verify` 全绿；`kit:check` 实测耗时 < 5s（结果写进 `docs/ci.md`） |
| G7 | 历史欠账清零 | §10 的 A1–A7、B1–B3、C1–C4 **逐条**有证据（命令输出/diff），无"已尝试"项 |
| G8 | 调试版可追溯 | `kit stamp` 产出 `release/YFWorking/kit-stamp.json`，字段完整；且**不进入** CI 门禁（`release/` 为 local-only） |
| G9 | 双通道可用 | `kit view --json` 输出符合统一 schema（可被程序直接解析）；`kit check --verbose` 人话可读 |
| G10 | 无回归 | `npm run typecheck` + `npm run test:ci` + 两个 CI 作业全绿；408 个测试文件计数口径三处一致 |

---

## 14. P0 文件清单

**新增**：

| 文件 | 职责 |
|---|---|
| `kit/cli.mjs` | 唯一入口：`check` / `sync` / `stamp` / `view` |
| `kit/lib/{ledger,version-rules,dep-rules,scan,report,baseline}.mjs` | 纯函数实现（零第三方依赖） |
| `kit/lib/python-manifest.mjs` | 内嵌 Python 包清单的**唯一读取入口**（`readEmbeddedPackages({ root })`，B2）：构建脚本与测试共用，保证"构建脚本装的包"与"台账记的包"同源 |
| `kit/lib/stamp.mjs` | dev 渠道身份（章）：§8 的 13 个字段（含 `tag`/`ahead`/`missing`），字段契约由 `kit/lib/stamp.test.mjs` 钉住 |
| `kit/lib/*.test.mjs` | 与实现同层单测（对应 G2/G3/G4/G5）；共 8 个（scan/report/baseline/ledger/version-rules/dep-rules/python-manifest/stamp） |
| `kit/cli.test.mjs` | CLI 层集成测试：四个子命令（`check`/`sync`/`view`/`stamp`）+ C2/C3 的挂载完整性三条 |
| `kit/manifest/{versions,deps}.json` | 台账（唯一真源） |
| `kit/manifest/drift-baseline.json` | 🖐 人工维护的已知漂移 |
| `kit/schema/{versions,deps}.schema.json` | 台账自身 schema |
| `kit/README.md` | 给 AI 的操作契约 |
| `server/version.test.mjs` | 补齐 A5 的版本断言测试 |

**修改**：

| 文件 | 改动 |
|---|---|
| `scripts/test-tiers.mjs` | `TEST_GLOBS` 增加 `kit/**/*.test.mjs` |
| `scripts/check-doc-anchors.mjs` | A′ 门禁由 warning 升级为 problem；门禁 A 双向覆盖（C4） |
| `package.json` | `test`/`test:unit` glob 同步；新增 `kit:check`/`kit:sync`/`kit:stamp`/`kit:view`；§10 C3 的构建脚本 npm script；`verify:ci` 追加 `npm run verify:knowledge-gui`（Rider 2 把该脚本从 `pendingFix` 移入 `ci` 桶的必要条件 —— `ci` 桶 ⊆ `verify:ci` 由 `kit/cli.test.mjs` 守着） |
| `scripts/bump-version.mjs` | 增加 `pkg` 目标（A2）；修正注释口径（A3） |
| `scripts/build-embedded-python.mjs` | 包列表改读 `deps.json`（B2） |
| `skills-lock.json` | 20 条哈希重算（A7） |
| `public/sample-skills/_common/_common_manifest.json` | 全量登记 98 条（A6） |
| `version.mjs` | 注释口径同步（A3） |
| `docs/_anchors.json` | `anchors:write` 同步（C1） |
| `docs/ci.md` | 新增 DevKit 门禁一节 + 实测耗时（G6）+ `verify-knowledge-gui` 归因更正（Rider 2） |
| `docs/待处理清单.md` | 登记 3 个 `verify-*.mjs` 的 15 项既有失败（Task 14 / Rider 1）——改的是**别人 113 行在途改动同在的文件**，只按基线叠加本任务的行 |
| `scripts/verify-knowledge-gui.mjs` | 视图白名单字面量 5 → 6 值（真源已含 `tags`）；Rider 2 的"脚本腐烂"那一项 |
| `src/components/knowledge/{KnowledgeToolbar,KnowledgeSidebar}.tsx` | Rider 2 的 2 处**真违规**：UI 警示符号改 lucide `AlertTriangle`、注释里的符号改文字（spec 2026-09-13 §5「lucide only，禁 emoji」） |
| `.github/workflows/ci.yml` | `test` 作业插入 `npm run kit:check`（单独一步） |

**不改**：三条构建链的核心逻辑（`build-kernel.mjs` / `vite.config.ts` / `electron-builder.yml`）；`release/` 调试版工作方式；任何 `public/sample-skills/_common/*.py`（§5.4 划界）。

---

## 15. 与既有设计的关系

| 既有设计 | 关系 |
|---|---|
| `docs/superpowers/specs/2026-09-15-version-manager-design.md`（版本管理器：影子引用快照 / `refs/yfw/snap/*`） | **互补不重叠**：版本管理器管"代码快照与回退"（工作区级、可反悔），DevKit 管"版本号台账与漂移门禁"（声明级、可判定）。二者共享 `scripts/bump-version.mjs` 作为唯一版本号入口 |
| `scripts/check-doc-anchors.mjs`（文档口径门禁） | **同构复用**：`repoHas`（I2）、白名单独立手写文件（I4）、"门禁强度刻意只卡慢变量"三条心智直接沿用 |
| `scripts/ci-preflight.mjs` + `scripts/test-tiers.mjs`（分层口径单一真源） | DevKit 新增测试层必须走同一清单，不另立一套 |
| `docs/待处理清单.md` 每轮循环协议第 8 条（"同步到调试版，给用户人工调试"） | DevKit 的 `stamp` 是该环节的**可追溯化**，不替代它 |

---

*本文档全部结论来自对仓库真实源码/产物的实测（函数名、常量、文件数与哈希），关键数字均标注了来源文件；无来自注释的未经验证宣称。若后续代码变更导致数值失效，以当前代码为准并同步更新本文。*
