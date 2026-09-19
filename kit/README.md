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
| `BASELINE_FORBIDDEN` | **契约对账类规则（`CT0`–`CT8`）不支持基线豁免**：条目里出现这些规则号即红（第 4 批收口，堵掉"单行 JSON 就能把契约红灯变绿"的通路） | 删掉该条目；契约红灯只能靠修契约面消除（修代码 / `kit:sync` / `contract-scope.json` 登记）。`CT9`（幽灵 fetch 历史欠账，黄）**仍可**登记豁免 |
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
**§5** +6 / **§6** +3 WS 类型（口径 = 表格行数；收尾批又为 §5 补 `browser:event` 一行 ⇒ §5 现 **27** 条）、
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

### 规则表（`CT` 号段：CT0–CT9，含 CT4 的两个子规则）

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

### 三条口径澄清（审查点名要写的）

- **`CT5 evaluated=156` 与 plan 说的"ipc 71"不是一回事**：`evaluated` 是**各侧独立计数之和**
  （invoke 61 + handle 61 + send 10 + on(main) 10 + on(renderer) 7 + push 7 = 156，配对判据必须按侧比，
  同一个通道在多侧各算一次）；"71 通道"是**去重后的通道数**（61 + 10）。数字不同是口径不同，不是漂移。
- **`contract-doc.mjs` 解析出的 method 目前不入账（只比路径）** ⇒ **已知边界**：文档写 `POST /x` 而代码只有
  `GET /x`（或反之）**不会红**。解析器把方法如实呈现（`synonyms`），但对账只做**路径集合**的差集；
  收紧到"方法 + 路径"需要先处理 §7 的"一行多端点、方法写在行内"等形态 —— **P1.5 也没做这一条**
  （P1.5 补的是**覆盖面**：72 条路由 + 9 条 WS + 7 条 IPC + 21 个工具），如实记为遗留。
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
kit/lib/contract-rules.mjs  CT0–CT9（含 CT4B/CT4C/CT8）
kit/lib/contract-scope.mjs  范围登记判定（只读；禁通配、禁自动生成）
kit/lib/python-manifest.mjs 内嵌 Python 包清单的唯一读取入口（构建脚本与测试同源）
kit/lib/report.mjs          统一报告 schema + 人话渲染
kit/lib/baseline.mjs        漂移基线、红灯认领与数量护栏
kit/lib/stamp.mjs           dev 渠道身份（章）
kit/manifest/versions.json  版本台账（唯一真源；`#channels` 是契约快照）
kit/manifest/deps.json      依赖台账（唯一真源）
kit/manifest/contract-scope.json  🖐 人工维护的范围登记（sync 绝不写它）
kit/manifest/drift-baseline.json  🖐 人工维护的已知漂移（每条写 reason；**不放"在途噪声"**）
kit/schema/*.json           台账自身 schema
```
