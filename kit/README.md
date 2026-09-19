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
| `BASE` | 基线条目总数 / 豁免红灯条数**超过**上次登记值（红） | 基线是"已知欠账"，不是"遇红就塞"：修代码，别加条目 |
| `baselineUnused` | 基线里已不再命中的条目（提示） | 应摘除（避免基线长期挂着过期豁免） |

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

## 目录

```
kit/cli.mjs                 唯一入口：check | sync | view | stamp
kit/lib/scan.mjs            扫描基座（git ls-files 域扫描）
kit/lib/ledger.mjs          台账读写 + syncVersions / syncDeps / syncSkillsLock
kit/lib/version-rules.mjs   V1–V8′（11 个规则号）
kit/lib/dep-rules.mjs       P0–P7（8 个规则号）
kit/lib/python-manifest.mjs 内嵌 Python 包清单的唯一读取入口（构建脚本与测试同源）
kit/lib/report.mjs          统一报告 schema + 人话渲染
kit/lib/baseline.mjs        漂移基线、红灯认领与数量护栏
kit/lib/stamp.mjs           dev 渠道身份（章）
kit/manifest/versions.json  版本台账（唯一真源）
kit/manifest/deps.json      依赖台账（唯一真源）
kit/manifest/drift-baseline.json  🖐 人工维护的已知漂移（每条写 reason）
kit/schema/*.json           台账自身 schema
```
