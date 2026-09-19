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
| 测试 | **408** 个测试文件、3678 断言、`scripts/test-tiers.mjs` 为分层口径单一真源、`ci-preflight` 抓"零测试绿灯"、`perf-baseline` 性能门禁 | 11 个 `verify-*.mjs` **零挂载**；6 个构建/校验脚本无 npm script；无覆盖率 |
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
| `skillsLock` | 20 条 sha256 | **实测 20/20 不符**（lock 记的是上游原文，本地已被 frontmatter/占位符改写）→ 按 D5 重定义为本地安装后哈希 | `skills-lock.json` |
| `commonTools` | `_common` 下 Python 工具的版本 | **实测实有 98 个 `.py`，manifest 仅登记 9 条；且 98 个脚本中零个声明 `__version__`** | `public/sample-skills/_common/_common_manifest.json` |
| `channels` | 渠道身份（dev / release） | 新增，见 §8 | `release/YFWorking/kit-stamp.json`（local-only） |
| `history` | 版本变更流水（`{id, from, to, at, reason}`） | 新增。**V3 单调性与 §7.3 基线数量护栏都读它**，故必须与台账同文件存放，不能另建文件（否则两者可能不同步） | `manifest/versions.json` 的 `history` 分区 |

### 5.2 台账条目形状

```jsonc
// contracts 分区单条（必须"可解析-回读"：校验时重新解析宿主文件比对）
{ "id": "INDEX_VERSION", "file": "shared/knowledge-core.mjs", "line": 44,
  "kind": "data-schema", "value": 4,
  "consumers": ["src/lib/knowledgeQuery.ts"],   // 同口径镜像处（I1 的观察点）
  "note": "知识索引格式；改值必须提供迁移链" }
```

### 5.3 校验规则（8 条，每条都要能真红）

| # | 规则 | 判据 | 现状会红吗 |
|---|---|---|---|
| V1 | 声明位置可解析 | 台账 `{file,line}` 处仍存在该常量且值相等 | 否（初始同步后应全绿） |
| V2 | 每条线至少一个载体 | `lines` 每项有宿主文件 | 否 |
| V3 | semver 单调 | 台账值 ≥ 上一记录值（`manifest/versions.history` 记账） | 否（新机制） |
| V4 | 跨载体映射一致 | `KERNEL_VERSION='dev 0.2'` ↔ `kernel/package.json:3 '0.2.0'` | 否（当前一致） |
| V5 | schema 变更需迁移链 | `kind=data-schema` 且值变更时，必须同时出现迁移条目 | 否（新机制） |
| V6 | 技能三方一致 | `skills.json.version` ↔ `SKILL.md` frontmatter ↔ 台账 | 否（实测一致） |
| V7 | lock 语义落地 | 20 条 sha256 == 实际 `SKILL.md` 文件哈希 | **是（20/20 不符）** |
| V8 | manifest 覆盖 | `commonTools` 记录的条目 ⊆ 实有 `.py`，且**覆盖率不得下降** | **是（9/98）** |
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

> 注：`ws` 经核实**在用**（`electron/` + `server/`），`README.md` §4.8.8 把它与 `classic-level` 并列描述，实测二者不同——以台账判定为准。

### 6.3 校验规则（6 条）

| # | 规则 | 说明 |
|---|---|---|
| P1 | 声明 ⊆ 有证据 | 每个依赖至少一类引用证据，否则 `unused` |
| P2 | 反向幽灵依赖 | 源码 import 了但未声明 → 红 |
| P3 | 域隔离 | 内核域恒零依赖（复用既有断言）；`ws` 归 `electron,server` 而非 `src` |
| P4 | Python 包清单化 | 13 包从 `build-embedded-python.mjs` **提到 `deps.json`**，脚本读清单（消 double） |
| P5 | 双 Python 清单对账 | 内嵌集 vs `requirements.txt` 的差集必须显式标注（一方缺项 → 黄灯+说明，不红） |
| P6 | 体积记账 | 记录每域体积（`node_modules` 实测 379M、`runtime/python` 415M、`runtime/skills` 180M），仅趋势，不设阈值 |

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

### 7.3 漂移基线（`manifest/drift-baseline.json`）

🖐 **人工维护、独立文件、每条写 reason**（I4）：

```jsonc
{ "version": 1,
  "_note": "已知漂移登记后不再报红，但数量不得增加；减少时应摘除条目",
  "entries": [
    { "rule": "P5", "subject": "python.embedded-vs-requirements",
      "reason": "内嵌集是分发态最小集，requirements.txt 含可选增强包（rapidocr-openvino 等）",
      "at": "2026-09-19" }
  ] }
```

**数量护栏**：`check` 会断言"基线条目数不超过上次记录数"（记在 `versions.history`），防"遇到红灯就往基线里塞"。

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

| # | 欠账（实测） | 修复方式 | 验证 |
|---|---|---|---|
| A1 | `git tag` = 0 个 | 打首个 tag，建立版本锚点（**属写 git 操作，实施前单独获批**） | `git tag` 非空；`stamp` 能算 `ahead` |
| A2 | GUI 版本线（`package.json` 2.8.0）无 bump 入口 | `bump-version.mjs` 增加 `pkg` 目标 | `--dry-run` 三线各自演练正确 |
| A3 | `version.mjs:7` 注释称"三条独立版本线"，`bump-version.mjs` 只支持 `app\|kernel`（其他直接 fail）→ 注释↔代码不符 | 脚本补 `pkg`，注释同步为"四条" | 注释与代码一致；非法目标仍非 0 退出 |
| A4 | 14 处版本常量无台账 | 纳入 `contracts` 分区（V1 可解析-回读） | `kit:check` V1 全绿 |
| A5 | `server/version.test.mjs` 不存在 → `bump-version.mjs` 的"同步测试期望值"分支**永走跳过**（死路径） | 二选一：补该测试文件，或删除该死分支改为显式说明（**取"补测试文件"**，让版本断言真正存在） | 该测试能红（改错值即失败） |
| A6 | `_common_manifest.json` 仅 9/98；98 个 `.py` 零个声明 `__version__` | 台账全量登记 98 条（未标注者 `null`），新增 V8′ 只对新文件强制 | V8 覆盖率记为 9/98 起点，之后不下降 |
| A7 | `skills-lock.json` 20/20 哈希不符 | 按 D5 重定义为本地安装后哈希，`kit:sync` 重算 20 条 | V7 全绿；改任一 `SKILL.md` 后立刻红 |
| B1 | 10 个未用运行时依赖 | **逐个核实后删除**（每个都跑 `typecheck` + `build` + 全量测试；`xlsx`/`mammoth` 需先确认无运行时动态加载） | 删除后 `kit:check` P1 无 `unused`；产物可构建 |
| B2 | 内嵌 Python 13 包硬编码在构建脚本 | 提到 `deps.json`，脚本读清单 | 构建脚本行为不变（`node --test` + 干跑打印） |
| B3 | 双 Python 清单（内嵌 13 vs requirements 约 25）无对账 | P5 差集显式标注（黄灯，不红） | 报告能列出差集 |
| C1 | `_anchors.json`：407 vs 已跟踪 **408**（`kernel-tests` 209 vs 210） | `npm run anchors:write` | `check-doc-anchors` 绿 |
| C2 | 11 个 `verify-*.mjs` **零挂载** | 分两类：CI 可跑的挂进 `test:ci`；需图形会话/真内核的挂**独立 npm script** 并在台账登记为 `manual` 门禁 | `package.json` 中 11 个均可执行；CI 不因图形依赖而假红 |
| C3 | `build-kernel` / `build-embedded-python` / `build-installer` / `package-portable` / `sync-builtin-skills` / `bump-version` 均无 npm script | 全部挂 npm script（`kit:` 与 `build:` 命名空间） | `npm run` 列表可发现全部构建/校验入口 |
| C4 | **门禁 A′ 只管黄不管红**（§7.1 实测）→ "新增测试层漏同步"不会让 CI 变红 | `check-doc-anchors.mjs`：A′ 由 `warnings` 升级为 `problems`；门禁 A 双向覆盖（`TEST_GLOBS` 有键而锚点无该键 → 红） | 故意漏改 `package.json` 的 test script → `node scripts/check-doc-anchors.mjs` **退出码非 0** |

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
| **P0** | `kit/` 骨架 + 版本台账 + 依赖台账 + `check/sync/stamp/view` + 测试层接入 + CI 接入 + §10 全部欠账（A1–A7、B1–B3、C1–C4，共 17 条） | `npm run kit:check` < 5s 零网络且全绿；每条规则有**正反例测试**（反例必须真能红） |
| P1 | 契约快照（bridge 路由 / WS 事件类型 / IPC 通道 / 工具 `input_schema`）↔ `docs/bridge-contract.md` 双向对账 | 快照差异 = 0 或已登记 |
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
| G5 | 漂移基线可用且防滥用 | 登记一条 → 不再报红；条目数增加超过记录值 → 红 |
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
| `kit/lib/*_test.mjs` | 与实现同层单测（对应 G2/G3/G4/G5） |
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
| `package.json` | `test`/`test:unit` glob 同步；新增 `kit:check`/`kit:sync`/`kit:stamp`/`kit:view`；§10 C3 的构建脚本 npm script |
| `scripts/bump-version.mjs` | 增加 `pkg` 目标（A2）；修正注释口径（A3） |
| `scripts/build-embedded-python.mjs` | 包列表改读 `deps.json`（B2） |
| `skills-lock.json` | 20 条哈希重算（A7） |
| `public/sample-skills/_common/_common_manifest.json` | 全量登记 98 条（A6） |
| `version.mjs` | 注释口径同步（A3） |
| `docs/_anchors.json` | `anchors:write` 同步（C1） |
| `docs/ci.md` | 新增 DevKit 门禁一节 + 实测耗时（G6） |
| `.github/workflows/ci.yml` | `test` 作业插入 `npm run kit:check` |

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
