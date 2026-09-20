# CI 与测试分层

本文件说明仓库的持续集成怎么跑、为什么这么配，以及踩过的坑。配置本体在 `.github/workflows/ci.yml`。

## 一句话总览

```
npm run verify   # = typecheck + test:ci（本地推之前跑这个）
npm run test:ci  # = 预检 → 文档口径 → DevKit 台账 → 单测层 → server 层 → 内核层 → verify:ci（实测为绿的门禁）
```

| 命令 | 内容 | 本机实测（**主树** —— 即**含他人在途改动**；口径见「真仓数字口径」一节） |
|---|---|---|
| `npm run test:preflight` | 预检：Node 版本、测试 glob 必须匹配到文件、端口占用风险 | <1s |
| `node scripts/check-doc-anchors.mjs` | 文档口径（路径存在性 + 各层测试文件数） | <1s |
| `npm run kit:check` | DevKit 台账门禁（版本/依赖/契约台账 ↔ 宿主文件；只读） | 主仓 **2.38/2.46/2.59 s**（**含他人在途改动** ⇒ CT8 走两遍契约提取）；盘根干净克隆 `<盘根目录>/<克隆名>` @`945a837` **2.27/2.29/2.35 s**；两者冷缓存首跑 ≈3.9 s（物化 HEAD 1.2 s） |
| `npm run test:unit` | `shared` + `electron` + `src` + `kit` 四层 | 1041 项 / 23s（**主树、含他人在途改动**；`shared`+`electron`+`src` 三层接入 kit 前实测）**＋ kit 层 262 项**（`node --test "kit/**/*.test.mjs"` 的 `tests` 计数；口径 = **干净克隆** `<盘根目录>/<克隆名>@ba878fa` 实测，主树同值 —— 2026-09-19 第 4 批收口，上一批同一命令为 250 项） |
| `npm run test:server` | `server` 层（含起桥的端到端测试） | 694 项 / 91s（**主树、含他人在途改动**） |
| `npm run test:kernel` | `kernel-tests` 层 | 1943 项 / 48s（**主树、含他人在途改动**） |
| `npm run verify:ci` | 实测为绿的 `verify-*.mjs` 门禁（见「门禁挂载」两节） | 7 个脚本 / 实测 ≈6.0s（含 npm 启动开销；**主树**实测、含他人在途改动；5 脚本时代为 ≈4.0s） |
| `npm run typecheck` | `tsc --noEmit` | 16s |

合计 **3678 项断言 / 约 3 分钟**（**主树**实测、**含他人在途改动**，且为 kit 层接入前，本机 8 核）。CI 为 2 核 Windows 运行器，实耗会更长，作业超时设 30 分钟。
★ 引用上表任何数字都要按「真仓数字口径」注明测量树：这张表是**主树**口径（含别人尚未提交的测试文件，数字会漂）；**对外引用请用干净克隆的数字** —— 「DevKit 台账门禁」一节有盘根干净克隆的完整链路实测（如 `test:unit` 1225 项 / `test:server` 770 项）。

## 两个刻意的环境决策

**1）`runs-on: windows-latest`（不用 ubuntu）**
本仓库是 Windows 桌面应用，测试含平台特定断言：`C:\…` 字面路径、盘符枚举、`sep` 分支、`taskkill`/PowerShell 探测、预览页 `file://` 帧语义等。跑 Linux 会产生一批**与被测行为无关**的失败（更糟的是静默跳过），门禁随即失去意义——"CI 绿"必须等价于"这台机器上绿"。

**2）`ELECTRON_SKIP_BINARY_DOWNLOAD=1`**
测试只 `require` 或 stub electron 模块，**没有一处 spawn 真二进制**（已核查）。不下载 ~100MB 二进制可显著缩短安装，并避免网络受限时的假失败。

## 为什么要有 `test:preflight`

`node --test <glob>` 在某条 glob **匹配不到任何文件**时**不报错、直接 0 退出**——CI 会显示绿灯而实际一个测试都没跑。这是测试基建最经典的静默失败：门禁看起来在，其实不在。预检把它变成硬失败，并顺带校验各层文件数与 `docs/_anchors.json` 一致（抓"glob 写错导致整层静默消失"）。

预检还检查 **51517 端口是否被占用**（即本应用是否正在运行）。原因见下节。

## ⚠️ 本地跑测试可能杀掉你正在用的应用

`server/bridge.mjs` 监听固定端口 51517；它遇到 `EADDRINUSE` 时会**自愈式 `taskkill`** 掉命令行含 `yfworking` 或 `bridge.mjs` 的进程——也就是你正在使用的应用本体。

因此**请先关闭应用再跑 `npm run test:server` / `test:ci`**。若确认要带风险运行，加 `--allow-running-app`：

```bash
node scripts/ci-preflight.mjs --allow-running-app
```

好消息：测试自身大多用 `YFW_BRIDGE_PORT` 指定**随机端口**，与应用的 51517 不冲突；风险主要来自默认端口路径。CI 上端口必然空闲（`CI=true` 时预检直接跳过该检查）。

## 并发上限为什么是 4（有实测证据）

把全部测试**合成一次调用**并调高并发会引入**假失败**。实测：

| 并发 | 结果 |
|---|---|
| 4（`server` 层独立跑） | 694/694 通过，91s（**主树、含他人在途改动**） |
| 8（全部层合成一次调用） | `server/reap-guard.test.mjs` 与 `server/sheet-ops.test.mjs` **失败**（各约 39s） |

这两个测试单独跑均全绿，说明是**资源争抢**（它们会 spawn python / 子进程，并带内部超时），不是真 bug。

由此定下两条：**① 各层作为独立进程串行执行**（`test:ci` 用 `&&` 串起来，而不是把 5 条 glob 塞进一次 `node --test`）——既避开跨层争抢，也让失败归因一眼可辨；**② 层内并发上限 4**。

> 反过来也说明：**不要为了"跑得快"随手调高 `--test-concurrency`**，否则你会开始排查并不存在的 bug。

## 文档口径纳入 CI

文档一旦与代码脱节，读者通常**不会**去核对，于是照着过期内容操作。所以把可客观校验的口径变成断言：

- **门禁 A：各层测试文件数**（防上面说的"整层静默消失"）。数字存在 `docs/_anchors.json`，由 `npm run anchors:write` 重新生成。
- **门禁 B：文档引用的仓库路径是否存在**。扫描 `docs/*.md` 与 `docs/manual/**/*.md` 里反引号包裹的相对路径，断言文件真实存在。

### 计数口径：只算 git 已跟踪的文件

分层清单与计数逻辑抽在 `scripts/test-tiers.mjs`（单一真源，预检与门禁共用——两处各写一份迟早漂移，表现为"预检通过、门禁失败"这种难查的自相矛盾）。

其中**测试文件数只统计 `git ls-files` 的已跟踪文件**，而"每条 glob 至少匹配到一个文件"用工作树扫。这个区分是刻意的：

- 工作树里可能有**别人尚未提交的在途文件**（本仓库会同时跑多个任务）。若把未跟踪文件算进锚点，锚点就记录了"只存在于我这台机器"的数量，**CI 在干净克隆上必然对不上而变红**。
- 反过来，新加的测试文件即使还没 `git add`，也要能立刻发现"glob 失效"，所以那一项用工作树。

由此预检里的比对语义是**不对称**的（`scripts/ci-preflight.mjs`）：工作树数 **少于**锚点 → 疑似测试文件被删（失败）；已跟踪数 **少于**锚点 → 提交后 CI 会失败，提醒先 `git add`。本地比锚点多属正常（有新文件没提交），不报错。

但 `check-doc-anchors.mjs` 的门禁 A 是**精确相等**判定（不是"至少"），所以**工作树红 ≠ 你的改动坏了**：工作树里只要有**他人尚未提交**的测试文件，它就会红。实测本仓库并发跑多任务时：`node scripts/check-doc-anchors.mjs` → **EXIT=1**，报 `测试文件数[server/*.test.mjs] 与锚点不符：实际 92，锚点 89` 与 `测试文件数[src/**/*.test.ts] … 实际 81，锚点 74`（这两个"实际"是**主树口径，含他人在途改动**；同一提交的干净克隆里 **EXIT=0**，无此差异）。那些文件各自提交后计数即恢复；确属本层合法新增时才跑 `npm run anchors:write` 重算锚点（**不要**为了让自己的工作树变绿而把别人在途文件的计数写进锚点）。

### 门禁 A′：层与脚本**逐脚本**对齐（新增测试层要同步四处，含本文件）

同一份分层清单里还登记了**每一层必须出现在哪些 package.json 脚本里**（`scripts/test-tiers.mjs` 的 `TIER_SCRIPTS`，与 `TEST_GLOBS` 定义在同一文件、紧邻，避免第二处真源）。门禁 A′ 按它**逐脚本**断言。

"CI 真的会跑这一层吗"的判据**不是**一份手写的链路常量，而是**从 `package.json` 的 `test:ci` 解析出来的脚本名**（`scripts/test-tiers.mjs` 的 `ciChainScripts`：按 `&&` / `||` 切分后逐段 token 精确匹配 `npm [run] <name>`）。两条判据都有实测取证：

- **不用子串 `includes`**：实测把 `test:ci` 里的 `npm run test:unit` 改成 `npm run test:unit:legacy`（`test:unit` 脚本仍在，但 CI 不再跑它）→ 子串判据 **EXIT=0**，即 `shared`/`electron`/`src`/`kit` 四层在 CI 里静默不跑而门禁全绿；改为 token 精确匹配后同一操作 **EXIT=1**。判据必须是"**这个脚本名**是否被执行"，不是"这个字符串是否出现过"。
- **不另存 `CI_CHAIN_SCRIPTS` 常量**：那是会漂移的第二份真源，漂移的后果是**误报**（消息与事实相反）。实测新增一层专用脚本 `test:kit`（glob 放进它）、并在 `test:ci` 里**确实**追加 `npm run test:kit` 时，常量口径仍报"只挂在 CI 不跑的脚本上"（**EXIT=1**，而事实是 CI 已经跑到它）；改为就地解析 `test:ci` 后 **EXIT=0**。

为什么必须逐脚本，而不是"这个 glob 出现在**某个**测试脚本里就算过"：CI 跑的是 `test:ci`，**从不跑 `test`**（全量脚本，只在本机手工用）。实测只从 `test:unit` 删掉 `kit` 层的 glob（`test` 里仍保留）时，旧写法 **EXIT=0** —— kit 层在 CI 里静默不跑，门禁却全绿；逐脚本校验后同一操作 **EXIT=1**。层是否真的在 CI 上跑，必须按**脚本名**核对，不能按"glob 字符串出现过"核对。

于是**新增一层测试目录要同步四处**（spec §7.1 的清单；该清单第 3 项把"`docs/ci.md` 的口径说明 + `npm run anchors:write`"合成一条，这里拆成两个可见步骤，故是四处）：

1. `scripts/test-tiers.mjs`：`TEST_GLOBS` 加一行 + `TIER_SCRIPTS` 补上该层必须归属的脚本；
2. `package.json`：`test` / `test:unit` / `test:server` / `test:kernel` 里补该层的 glob，并确认 `test:ci` 链路覆盖到它；
3. **本文件**（`docs/ci.md`）的口径说明——它是这套规则的对外表述，spec §7.1 把它与上面几处并列为需要同步的位置；
4. `docs/_anchors.json`：跑 `npm run anchors:write` 重新生成（新增层若漏了这一步，门禁 A 会报"不在 testFileCounts 中"）。

门禁 A/A′ **实际覆盖到的**与**刻意没覆盖的**（如实列出，避免把"没检查"当成"已检查"）：

| 漂移形态 | 门禁反应 |
|---|---|
| `TIER_SCRIPTS` 里某个必需脚本漏了该层 glob（含"只加进 `test`、漏了 CI 实跑的 `test:unit`"） | 🔴 红：`未出现在 package.json 的 <脚本> 脚本中` |
| 该层归属的脚本**全都不在** `test:ci` 链路里（按解析出的脚本名判定） | 🔴 红：`只挂在 CI 不跑的脚本…上` |
| `TEST_GLOBS` 有该层、但 `_anchors.json` 的 `testFileCounts` 里没有该键 | 🔴 红：`不在 docs/_anchors.json 的 testFileCounts 中` |
| 某层测试文件数与锚点不符 | 🔴 红 |
| 锚点里**多**了 `TEST_GLOBS` 里没有的键 | ⚪ **不**检查（遍历以 `TEST_GLOBS` 为准） |
| `_anchors.json` 的 `testTotal` 写错 | ⚪ **不**检查（门禁只逐层比计数，`testTotal` 仅作展示） |

**刻意不门禁**：模块数、总行数、巨石行数——它们每次合法重构都会变，硬卡会逼人每次都重跑 `anchors:write`，最终结果是人把检查绕过或删掉，那还不如一开始就别卡。这些数字仍写进 `docs/_anchors.json` 的 `info` 段供人查看。

**刻意不扫描**：`docs/superpowers/{specs,plans,audits}/**`（设计/计划/审计记录，写的是"当时打算建什么"，且常引用外部参考实现）与引擎架构对比笔记（对比**他人**引擎的调研）。把它们纳入会让白名单膨胀到上百条，门禁随之失效。

白名单是**手写的** `docs/_anchors-allow.json`（每条必须写 `reason`），刻意与自动生成的 `_anchors.json` 分开：否则"重新生成"就等于"把所有问题自动放行"，一次 `--write` 就把门禁架空了。

发现缺失路径时的处理顺序：**首选改文档**（多半是文件被改名/移动后忘改）；只有确属真·历史引用（构建产物名、文档在说明"该引用已失效"、刻意构造的负例路径）才进白名单。

### 首次启用时抓到的问题

首次运行即抓出 4 处真实文档腐烂，均已修正：`src/types/index.ts`（原文只写了 types/index.ts）、`src/components/mcp/mcpFormat.ts`（原文仍写 settings 目录）、MCP 配置界面路径随目录整理移动并被拆分、以及一处把个人记忆目录写成仓库相对路径的引用。修正前的旧路径不再复述，以免文档又出现"引用不存在的路径"。

启用后它**又抓到两处**，说明对新文档同样有效：① 我在新文档里把"修正前后的旧路径"都写成反引号形式，立刻被判为引用不存在；② 增删测试文件后计数与锚点不符（这条是设计内的正常触发，跑 `anchors:write` 即可）。

---

## DevKit 台账门禁

`npm run kit:check` —— 校验 `kit/manifest/versions.json`（版本台账 + **契约快照 `#channels`**）与
`kit/manifest/deps.json` 是否与宿主文件一致（**契约侧的真值取提交态 HEAD**，见下）。

- **在 CI 里的位置**：`.github/workflows/ci.yml` 的 `test` 作业里**单独一步**（`typecheck` 之后、`test:ci` 之前），
  命令 `npm run kit:check`。单独一步是**归因**需要（"台账漂移"与"测试挂了"是两类问题，一眼可辨）；
  `test:ci` 链路里也含它，本地一条命令即可跑全。**这条门禁必须进 CI 的理由**见本节末。
- **规则集**：版本侧 `V1–V8′`（11 个规则号）+ 依赖侧 `P0–P7`（8 个）+ **契约侧 `CT0–CT10`（13 个，含 `CT4B`/`CT4C`/`CT8`/`CT10`）**
  + 护栏 `BASE`/`BASELINE_NO_REASON`，逐条释义见 `kit/README.md`（「读红灯的正确姿势」与「契约快照与范围登记」两节）。
  **P1.5（2026-09-19）起契约面对账覆盖五类**：路由（§7）、WS 出/入（§5/§6）、IPC 推送通道（§11）、
  工具出口 + 结构指纹（§12）—— `CT2` 由"3 类"扩到"5 类"，`CT3` 新增"IPC 通道 ∈ 代码 push 侧"与
  "工具 ∈ 出口**且指纹逐字相等**"两条；`contract-scope.json` 的范围登记同步从 **20 组 / 92 键降到 2 组 / 2 键**
  （只剩两个**无法文档化**的空命名空间：`children` 为空且无锚定正则 ⇒ 没有具体端点可写）。
  规则号个数**未变**（12 个），故 CI 里的规则计数与耗时口径不变。
- **P1.5 遗留补强（批 M / 批 F，2026-09-19）—— 只加判据维度，不动规则号**：
  - **批 M：`CT3` 从"路径对账"升级为"方法 + 路径对账"**。此前文档写 `POST /x`、代码只有 `GET /x` **不红**（方法被丢弃）。
    相容规则：代码 `ANY` 与任意方法相容；**文档没写方法 ⇒ 不判方法**（"没声明"≠"声明错"）；
    文档写了方法 ⇒ **逐个判**（比"两集合不相交才红"更严，能抓住"文档 `GET+POST`、代码只有 `GET`"）；
    只被动态前缀认领的路径不判方法（方法不可静态判定）。判据**只在 `CT3`**：`CT2/CT4` 仍是**路径粒度**
    （覆盖面与登记集口径不变）。
    ★ 形态侧同时补了三处输入缺口：同路径**多行声明合并**（此前 key 是 path ⇒ 后一行**整条被覆盖丢弃**）、
    **行内方法**（`POST /x` —— 此前要求 token 以 `/` 开头 ⇒ 这类**整条解析不出来**）、**行尾括号方法**（全角/半角，只从第一列读）。
    **`CT3` 判定条数 186 → 236**（+50 = §7 写了方法的 33 条 + §7.1 的 17 行）。
    ★ **覆盖面如实口径（"盘根干净克隆"复算值，@`dfc1965` 提交态文档 + 批 M 代码）**：§7 有 98 条具体路径
    （非通配），**只有 33 条写了方法**（**12 行** = "方法真正被书写的行数"，可复算；
    另有 **2 行** = §7.1 里真被方法比对的 `/workflows` 的 GET/POST —— **不要把 `12 + 2` 当口径报**，
    它混了 §7 的"行"与 §7.1 的"行"，与下面的 `33 + 2` 声明口径也不同），
    其余 65 条只写路径 ⇒ 不判方法。§7.1 的 17 行虽都写了方法，但**只有 2 行**（`/workflows` 的 GET/POST）
    **真被方法比对**，其余 15 行只被动态前缀认领（`/workflows/:id` 一族）⇒ 按规则⑤跳过方法判定。
    ⇒ **有效方法比对 35 / 115 = 30%**（分母 115 = §7 的 98 条具体路径 + §7.1 的 17 行；**`/workflows`
    在 115 里被计 3 次** —— §7 路径 1 次 + §7.1 的 GET/POST 两行，不写清这个口径数字就复算不出来），
    **人工兜底 = 115 − 35 = 80 条**。上一行的 **"+50"是 `CT3` 的 `evaluated` 增量（收进判据输入的声明条数）**，
    **不是"受判条数"** —— 别把它读成 50 条真被逐条比对（此前这里写过 "受判 50/115（43%）"，是高估）。
    这不是缺陷（"没声明≠声明错"），但要如实计入门禁强度：**覆盖率要上去得先补文档的方法写法**。
    真仓实测（盘根干净克隆）：**绿**（收进判据输入的 50 条全部相容）；变异（把 §7 `/probe-provider` 的 `（POST）` 改 `（DELETE）` 并提交）
    ⇒ **红 1**：`[CT3] routes DELETE /probe-provider docs/bridge-contract.md:296`；还原 ⇒ 红 0。
    ★ **方法名大小写不敏感（复审批）**：三个方法正则加 `i`、解析结果**规范化为大写**。此前只认大写 ⇒
    三个可绕过口且**零测试覆盖**：`（delete）` 被当成"没写方法"⇒ 静默绿；行内 `post /x` 整条消失
    ⇒ 反被 `CT2` 报"未覆盖"；§7.1 的 `get /x` 整行解析不出 ⇒ 连 `CT2` 都不红（纯假绿）。
    `（POST 同义）` 这类**同义注释的豁免语义未变**（仍只记 `synonyms`、仍不是"必须存在"的方法）。
  - **批 F：工具指纹从"只有顶层"改为递归**，纳入 `enum`（排序后比较）· `items` · **嵌套 `properties`** ·
    `pattern`/`format`（深度上限 8）。此前"某工具 `mode` 的枚举悄悄放宽一个取值"⇒ 指纹不变 ⇒ **无人发现**；
    现在 ⇒ 指纹变 ⇒ `CT3` 红（须同步 `versions.json` 与 §12）。**仍不纳入**（README 有逐项理由）：
    散文/展示（`description`/`title`/`examples`）、数值范围（`minimum`/`maxLength`…）、`default`、元信息、组合子（`oneOf` 等，真仓零使用）。
    ★ 新增 **关键字守卫测试**：扫描真仓全部工具 schema，出现"结构类关键字"却未在纳入/豁免名单 ⇒ **直接失败**
    （逼后来者显式决定，杜绝静默漏判）。改口径的流程：改 `shapeOfNode` → 同步测试名单 → `npm run kit:sync`
    → `node kit/sync-fingerprints.mjs <in> <out>` 同步 §12 → `check` 绿。
    实测：21 条指纹**全变**（如 `Bash 055829fc → 5622e4cf`），`CT3` 一次报满 **21 条红** ⇒ 逐条同步后才绿。
  契约侧里 **`CT8`（在途差异：工作树 ∖ HEAD）与 `CT9`（渲染层 fetch 单向外）都是黄灯、只报不拦**
  —— `CT8` 逐条列出"尚未提交"的契约改动，提交后自己变空；`CT9` 的差集逐条登记在
  `kit/manifest/drift-baseline.json`。契约规则的真值取**提交态 HEAD**（物化一份临时干净检出），
  故**主树脏不脏都不产生红灯**，与 CI 的干净检出同口径（**为什么**见 README 的「committed 口径」。
  这同时说明：**"为在途差异加基线"不是本门禁的用法** —— 基线条目现在只剩 5 条真实已知差异，且没有一条是红灯）。
- **耗时（P1.5 后复测）**：**主仓 2.74/2.61/2.54 s**（3 次；**含他人在途改动** ⇒ `CT8` 走两遍提取）；
  **盘根干净克隆**（`<盘根目录>/<克隆名>` @`c86ae02`）**2.47/2.55/2.46 s**（3 次，中位 **2.47 s**）。
  边际增量来自 P1.5 新声明的契约面（**逐项标口径，不同口径不相加**）：
  **§7** `+25` **行**表行 ⇒ **72 个 method+path 键**（**代码侧**口径：这 68 条新路径在代码里共 72 个键 ——
  `/api/profile`、`/knowledge/doc`、`/mcp`、`/file-collab/policies` 各一行两方法）/ **68 条 distinct 路径**
  （**文档侧**口径）；**§5** `+6` + **§6** `+3` = WS `+9`（口径 = 表格行数）；**§11**（新章）`7` 条 IPC 推送通道；
  **§12**（新章）`21` 个工具 + 结构指纹。整份文档 `+93` 行，其中**表格数据行 62** = 25 + 9 + 7 + 21
  （其余 31 行是标题/表头/说明；口径 = `git diff --numstat 404f283~1 87342a3 -- docs/bridge-contract.md`，干净克隆）。
  `CT2` 由 3 类扩到 5 类；`CT3` 的比对条数 78 → **183**（口径 = **判定条数**：§7 非通配路径 98 + §7.1 的 17 个
  method+path 键 + WS 声明 40（§5 26 ∪ §6 16，`pet:show-main`/`pet:quit-app` 两节都声明 ⇒ 去重）+ §11 7 + §12 21；
  ★ 收尾批把 WS 改成**按方向各判**并给 §5 补 `browser:event` ⇒ 该数现为 **186** = 98+17+27+16+7+21，
  ★ **`186 − 183 = 3` 的来源**：`browser:event` / `pet:quit-app` / `pet:show-main` 这 **3 条同名双向事件**
  在并集口径下被**去重**成一次，按方向后**两侧各算一次** ⇒ `43 − 40 = 3`；另 `27 / 16` 是 **WS 类型数**、
  与表格行数 `24 / 15` **不同口径**（一行可写多类型）——
  与上一句的"新增条数"**不是同一口径**，**不同口径不可相加**）。
  范围登记 **20 组 / 92 键 → 2 组 / 2 键**：即**摘除 90 键**（口径 = `members[]` 逐条计数求和；
  逐类 routes **76 → 2**、wsOut **6 → 0**、wsIn **3 → 0**、ipc **7 → 0**；组数 routes 17 → 2，
  其余三类各 1 → 0）。提取器未改，
  故下面那条 P1 的细分解剖口径不变（未在 P1.5 复测）。**仍远低于 spec §7.2 的 < 5 s 硬约束**。
- **耗时（P1 批基线，同口径留存）**：**主仓 2.38/2.46/2.59 s**（3 次；**含他人在途改动** ⇒ `CT8` 要多跑一遍契约提取）；
  **盘根干净克隆**（`<盘根目录>/<克隆名>` @`945a837`）**2.27/2.29/2.35 s**（3 次，中位 **2.29 s**）；
  两者**冷缓存首跑 ≈3.9 s**（其中物化 HEAD 1.2 s，热缓存后 0.07 s）。契约侧细分（干净克隆、热缓存）：
  物化 65 ms + 契约规则 ≈1.8 s（`extractRoutes` 481 ms / `extractWs` 256 ms 为主）；脏树再 +≈0.8 s（`CT8` 的第二遍提取）。
  纯解析 + `git ls-files`/`git read-tree`，**零网络**，两者都仍低于 spec §7.2 的 < 5 s 硬约束
  （P0 时代 853 ms/1271 ms；本批为"提交态对账"多付了第二棵树与物化的代价）。
  ★ 数字口径：主仓那三个数**含他人在途改动**（走 `CT8` 两遍提取，故比克隆慢），对外引用请用克隆值（铁律 4）。
  （P0 时代本项为「主仓 853/863/815 ms；干净克隆 `C:\t14rev` @`b59cdc7` 1271/1283/1268 ms」——
  那时代码侧与文档侧**都读工作树**、没有第二棵树与物化开销，后来也为"规则读工作树"付出了加红灯基线的代价。）
- **退出码**：0 = 无红灯；1 = 有红灯（CI 失败）。黄灯（如 P5 的 Python 清单差集）不影响退出码。
- **完整离线链路实测**（盘根干净克隆 `C:\t14rev` @`b59cdc7`，`CI=true` + `ELECTRON_SKIP_BINARY_DOWNLOAD=1`，2026-09-19 Task 14 Step 1）：

  | 段 | 耗时 | EXIT |
  |---|---|---|
  | `npm ci` | 20.3 s | 0 |
  | `npm run build` | 46.4 s | 0 |
  | `npm run typecheck` | 16.0 s | 0 |
  | `npm run test:preflight` | 1.0 s | 0 |
  | `node scripts/check-doc-anchors.mjs` | 0.94 s | 0 |
  | `npm run kit:check`（3 次取中位） | 1.27 s | 0 |
  | `npm run verify:ci`（该克隆当时 **5** 脚本；2026-09-19 P1 起为 **7** 脚本，故 4.4 s 是 5 脚本口径） | 4.4 s | 0 |
  | `npm run test:unit` | 30.1 s（1225 项 / 0 fail / 1 skip） | 0 |
  | `npm run test:server` | 117.1 s（770 项 / 0 fail） | 0 |
  | `npm run test:kernel` | 75.2 s | 0 |

  **合计 ≈ 5 分 13 秒**（本机 8 核；CI 为 2 核 Windows 运行器，实耗更长，作业超时 30 分钟）。
  ★ 该表是 P0 时代（`b59cdc7`）的链路快照：其中 `kit:check` 现为 **2.29 s**（干净克隆，见上一条「耗时」），
  其余各段口径未变（`verify:ci` 已由 5 脚本变 7 脚本，表内已标注）。- **红灯怎么办**：按 `finding.hint` 操作。**默认动作是修宿主文件或跑 `npm run kit:sync`**，
  **不是**往 `kit/manifest/drift-baseline.json` 里加条目 —— 基线是"已知欠账"，
  条目数受 `versions.json` 的 `history.baselineCount` 护栏限制（超了直接红 `BASE`）；
  豁免**红灯**还必须在该条目里显式写 `"severity": "red"`（缺 `reason` 也红：`BASELINE_NO_REASON`）。
  规则号逐条释义（**32 个规则号** + `BASE`/`BASELINE_NO_REASON`）见 `kit/README.md`；
  契约侧（`CT0–CT10`、登记文件、committed 口径）见该文「**契约快照与范围登记**」与「**品牌标识与名称的统一管理**」两节。
- **相关命令**：
  | 命令 | 作用 | 是否写文件 |
  |---|---|---|
  | `npm run kit:check` | 门禁（只读） | 否 |
  | `npm run kit:sync` | 重建台账（保留人工字段） | 是 |
  | `npm run kit:view` | 输出台账摘要 JSON（AI 用） | 否 |
  | `npm run kit:stamp` | 给 dev 渠道盖章到 `release/YFWorking/` | 是（local-only） |

- **扫描域**：全部判定基于 `git ls-files`（**已入库**文件），不是磁盘遍历 ——
  `scratch/`、`release/`、`dist/`、`kernel-dist/`、`runtime/` 一律不参与（见 spec 不变量 I2）。

### 真仓数字口径（铁律 4）

**铁律 4（真仓数字口径）**：凡从真仓实测得到、且会随他人未提交改动漂移的数字
（测试计数、**路由/端点条数**、文件数、行数、schema 数…），引用时**必须取干净克隆（盘根目录）的值**；
主树数字必须显式标注「含他人在途改动」并给出干净克隆值。
**本规矩同样适用于测试代码里的硬编码期望值**（例：`kit/lib/contract-routes.test.mjs` 的真仓路由数）。
**替代做法**：若该数字会在主树漂移，**改用"点名断言 + 下界"**，并在注释里写明口径。
判定方法：把该数字拿来问「**这是哪棵树测的？**」——答不出即违规。

**逐字照抄 `kit/README.md` 的「四条铁律」第 4 条（违反即违规）**：只允许两种形态 ——
① 用**干净克隆**（**盘根目录**，如 `C:\p2rev` / `C:\t14rev`；`/tmp` 不算 —— 它仍在家目录解析链上，会命中杂散 `node_modules`）实测的数字；
② 主树数字，但**必须在同一句里显式写「含他人在途改动」并同时给出干净克隆的数字**。
**裸数字**（只写"762 项"而不说测的是哪棵树）与**拿主树数字当全量数字**（不标注）**一律算违反本条**。

原因（实测，2026-09-19 同一提交）：主树长期有**他人在途的测试文件与在途端点**，同一个提交在两棵树上计数不同 ——
`src/**/*.test.ts` **762 项（主树）/ 710 项（盘根干净克隆）**；真仓路由条数 **105（主树，含他人在途端点）/ 103（盘根干净克隆）**。
这套口径本身也有机器门禁的另一面：锚点只统计 `git ls-files`（见「计数口径：只算 git 已跟踪的文件」），
故**引用锚点式的"文件数"要说是已入库口径**。

> ★ **同一个坑出现过三次**：P0 的 src 762/710；`075e369` 用本铁律判出 5 处裸计数；`9c8cc3f` 把**主树路由数写进测试期望值**
> （`contract-routes.test.mjs` 的 `assert.equal(out.routes.size, 105)`）⇒ **干净检出（= CI）必红**。
> 教训：本铁律原先只讲"引用测试计数"，**没覆盖测试代码里的硬编码期望值**，现范围已补全（见上）。
> 在测试里钉真仓数字时，优先"**逐条点名断言 + 条数下界**"（漏抓由点名拦截），不要写精确相等。

### ★ 为什么这条门禁必须进 CI（Task 10 审查指出的唯一关卡）

`kit:check` 的 **P2 规则（反向幽灵依赖：源码 `import` 了却没在 `package.json` 声明）**是仓库里
**唯一**能抓"这个依赖被删了、但其实还有人在用"的判据。而它在本机**恰好不成立**：

Node 解析 `import`/`require` 会沿父目录链向上找 `node_modules`，本仓（`…\yfworking`）的父链上有
`C:\Users\T203-15\node_modules`（家目录里另一个小工程留下的安装树，约 46 个条目）。实测：
`cd <仓库根> && node -e "import('nanoid')"` → **IMPORT OK**（`nanoid` 已随 B1 从本仓删除，是从家目录那棵树解析到的）；
把同样的夹具放到**盘根目录** → `ERR_MODULE_NOT_FOUND`。⇒ **"删包之后本机测试全绿"不构成任何证据。**
CI 是干净检出、没有那棵树，所以只有 CI（与盘根克隆）上的 P2 判定才是真实的。
完整实测记录与本机隔离方法见 `docs/待处理清单.md` 的「杂散 `node_modules` 会掩盖缺依赖」条。

## 两个会让人白折腾半天的坑

### 1. 块注释里的 `**/` 会提前结束注释

写 glob 说明时很容易写出 `` /** 支持 `**/`（跨目录） */ `` —— 注释里的 `**/` 让块注释**提前终止**，后半截变成代码，报出莫名其妙的 `Unexpected token '}'`。本仓库已因同类问题吃过两次（一次在源码守卫测试的朴素注释剥离器上）。

**规避**：注释里不要出现双星号紧邻斜杠的序列，改写成"双星号斜杠"之类的文字描述。

### 2. 测试清理里的 `rmSync` 竞态（Windows）

测试若 `spawn` 子进程时把 `cwd` 指向临时目录，又在 `finally` 里直接 `rmSync`，会撞上 Windows 的句柄未释放 → **EPERM**。断言全过、只是清理抛错，于是报成"测试失败"。**并发跑时更容易命中**（子进程退出更慢），表现为随机变红的 CI。

本仓库已有 **26 处** `rmSyncRetry` 重试兜底定义（`function rmSyncRetry` 的出现数；口径 = **干净克隆** `<盘根目录>/<克隆名>@ba878fa` 实测，主树同值 —— 抽查时发现原文写"3 处"，已随第 4 批收口按实测修正），如 `kernel-tests/app-page-scope.test.mjs`。本次实测命中一次：`kernel-tests/app-tools-mount.test.mjs` 在 `--test-concurrency=4` 下随机 EPERM（单独跑 3/3 通过），已按同样方式加兜底，之后连跑两次全绿。

> 未做全仓批量修补：`rmSync` 出现在 **210** 个测试文件里（口径 = **干净克隆** `<盘根目录>/<克隆名>@ba878fa`：`git ls-files` 的 `*.test.*` 里含 `rmSync` 的文件数；**主树含他人在途改动为 211** —— 原文"约 155"是更早状态的裸数字，已按第 4 批收口修正），但只有"**被 kill 的子进程的 cwd 就是该目录**"这一种形态才有风险（**约 47 处**，量级估计而非逐处复核值）。在没有实际命中的证据前不动它们，避免一次无法审阅的大改动；命中时按上面的 `rmSyncRetry` 模式就地修即可。


## 门禁挂载：11 个 `verify-*.mjs` 现在都有入口了

C2 的原状态是**零挂载**：`scripts/verify-*.mjs` 共 11 个，`package.json` 里一个入口都没有 ——
既不在 CI，也没有 `npm run` 名字，于是**没有任何人会看到它们腐烂**。实测（干净克隆 `@9825c96`）：
其中 3 个当场 `EXIT=1`，断言与现行代码判据早已漂移。

现在每个脚本都有 `npm run verify:<后缀>` 入口（后缀 = 文件名去掉 `verify-` 前缀），
并**恰好**归入 `kit/manifest/deps.json#gates` 的一个桶。分类**由实测决定**（spec §10 C2 明令不允许凭印象），
下面是逐脚本的实测值（干净克隆 + `node_modules`，即 CI `npm ci` 之后的状态）：

| 脚本 | 桶 | 干净克隆实测 EXIT | 一句话依据 |
|---|---|---|---|
| `verify-milestones-start` | ci | 0 | 只 import `server/milestones.mjs` 做纯函数断言（`scripts/verify-milestones-start.mjs:2`） |
| `verify-s4-security` | ci | 0 | `mkdtempSync` 隔离 + `shared/pack-zip.mjs`（`:14-18`），无 GUI / 无外部进程 |
| `verify-skill-listing` | ci | 0 | 只读技能库 + `kernel/prompt.mjs`（`:13-16`）；库不存在时降级为空库断言（`:61-63`，故 CI 上不假失败） |
| `verify-experience-inject` | ci | 0 | 用**随机端口**（`:12` `39000+random`）+ 临时 home（`:8`）加载 `server/bridge.mjs`，与图形会话无关 |
| `verify-highrisk` | ci | 0 | 只 import `shared/high-risk.mjs` + 薄转发 `server/highrisk.mjs`，无外部进程；**2026-09-19 P1 修好 5 项失败后从 `pendingFix` 移入本桶**（原 5 项：断言 `47379e2` 有意删掉的 any-usage 模式） |
| `verify-knowledge-gui` | ci | 0 | 静态读 `src/components/knowledge/**` + `knowledgeStore.ts`，无外部进程；**2026-09-19 Task 14 修好 3 项失败后从 `pendingFix` 移入本桶**（原 3 项：2 项真违规 + 1 项脚本字面量腐烂，见下节） |
| `verify-knowledge-import-gui` | ci | 0 | 静态读对话框 + 明细报告子组件 + hook + 路由，无外部进程；**2026-09-19 P1 修好 7 项失败后从 `pendingFix` 移入本桶**（原 7 项：断言停在"抽组件/改写 hook 之前"的位置与写法） |
| `verify-gui-fidelity` | manual | **1** | `:19` 定位 `electron/dist/electron.exe`、`:359` 用 `BrowserWindow` 加载真组件并截图比对 —— 干净克隆实测 `ENOENT ... dist/assets`（未构建） |
| `verify-permission-flow` | manual | **1** | `:26` 用 `kernel-dist/cli.mjs` 拉起真内核、`:87` 打印 spawn args、按 stream-json 注入 `control_response` —— 干净克隆实测 `Cannot find module ... kernel-dist/cli.mjs` |
| `verify-portable-layout` | manual | **1** | `:6-18` 断言 `release/YFWorking/` 打包产物（`:14` `electron/electron.exe`、`:15` `runtime/python/python.exe`）—— 干净克隆实测 `MISSING DIR: dist / electron / server / public` |
| `verify-package-assets` | manual | **1** | `:28` 要求 `kernel-dist/cli.mjs` 存在（先跑 `build-kernel`）—— 干净克隆实测 `[FAIL] kernel-dist/cli.mjs 缺失`；它本就是出包前预检（`:2`） |

> `manual` 那 4 条的 `EXIT=1` 是**构建产物不存在**造成的（不是脚本腐烂）："先构建/先出包就能跑"。
> 上表里已没有「**跑起来就断言失败**」的条目 —— `pendingFix` 桶**当前为空**（2026-09-19 P1 的两个脚本都已修绿并移入 `ci`）；
> 空桶是合法状态，将来出现"跑起来也断言失败"的脚本照同一判据登记进该桶。

> 上表由 `kit/cli.test.mjs` 的 3 条测试守：① 每个脚本都有 npm 入口且**恰好**归一个桶；
> ② `ci` 桶 ⊆ `verify:ci` ⊆ `test:ci`，且**任一非空非 `ci` 桶**（`manual` / `pendingFix`）都**不得**出现在
> `verify:ci` 链路里 —— 并显式锁住 `verify-highrisk` 与 `verify-knowledge-import-gui` **确在** `ci` 桶与链路里
> （否则"清空 pendingFix"可以靠把脚本从两份名单里一起删掉来假达成）；
> ③ `manual` / `pendingFix` 每条必须写 `reason`（I4：放行即人工，理由要能被读者看到）。
> 新增或改名 `verify-*.mjs` 时，这三条会立刻红 —— 不要绕开它们改文档。

### `manual` 桶：手动门禁（不在 CI 自动跑，需图形会话 / 真内核 / 打包产物）

判据是**环境依赖**，不是工作量 ——「因为麻烦所以放手动」不是理由。

| 命令 | 依赖 | 为什么不能进 CI |
|---|---|---|
| `npm run verify:gui-fidelity` | Electron 真二进制 + 图形会话 | 截图比对无法在无头环境稳定复现 |
| `npm run verify:permission-flow` | `kernel-dist/cli.mjs` 真内核进程 | 需真实审批协议往返（还会按档位删临时文件） |
| `npm run verify:portable-layout` | `release/YFWorking/` 打包产物 | `release/` 是 gitignored，干净克隆必然 FAIL |
| `npm run verify:package-assets` | `kernel-dist/cli.mjs` | 出包前预检，构建产物不在干净克隆里 |

### `pendingFix` 桶：当前为**空**（2026-09-19 P1 修绿后清空）

这个桶的用途是"**脚本自身已腐烂**：干净克隆实测 `EXIT=1`，断言与现行代码判据已漂移" ——
这类失败与"环境不够"是两回事，所以**不能**丢进 `manual` 桶当解释；也不串进 `test:ci`
（串进去 = CI 永久红，红灯就被当成噪声，门禁随即失去意义）。处置一律是：
挂上 `npm run` 入口 + 在 `gates.pendingFix` 里写明失败断言 + 本表留证，**逐项判清哪边才是对的口径后修**，
修到绿再从 `pendingFix` 移入 `ci`（`gates.pendingFix` 现为空数组，键位保留）。

| 曾经在桶里的脚本 | 原失败断言 | 哪边才是对的口径 |
|---|---|---|
| `verify-highrisk`（5 项，2026-09-19 修绿移入 `ci`） | `rm 后跟路径命中` / `erase 命中` / `move 命中` / `mv 命中` / `Stop-Process 命中` | **脚本陈旧**：提交 `47379e2`「高危命令判定改三级分类（T1 问+标 / T2 标不问 / T3 不问不标）」**有意删除**了 any-usage 模式（`rm <任意路径>`、`mv`、`move`、`erase`、无 `-Force` 的 `Stop-Process` 等日常操作），理由是**告警疲劳**会淹没真正危险的那几条。⇒ 改**脚本**：断言改成双向（T1 必须命中 / T3 日常操作必须不命中），样本取自单一真源 `shared/high-risk.mjs#HIGH_RISK_RULES`，并复算 `sign ⊇ approval` 不变量与"薄转发逐点一致"。 |
| `verify-knowledge-import-gui`（7 项，2026-09-19 修绿移入 `ci`） | i18n key 计数、`import { importDocuments } from '@/hooks/useKnowledge'` 恰好一项、`r.data.dryRun \|\| !changed`、`const space = r.data.spaceId`、三档明细 / 失败原因 / 源文件名（三项在对话框里找不到） | **脚本陈旧**：明细渲染 2026-09-14 抽到子组件 `KnowledgeImportReport.tsx`、失效逻辑挪到 `useKnowledge.invalidateAfterImport(data)`、对话框 import 多了 `importDocumentsTracked`（**行为都在，位置/写法变了**）。⇒ 改**脚本**：明细断言改为"对话框 + 报告组件两文件合看"，hook 两条改为在 `invalidateAfterImport` 函数体内断言语义（dryRun 早退 + 用回执 `spaceId`），并**加强**成子组件同样受 i18n / 无硬编码中文 / 不得值导入 `knowledgeApi` 三条约束。 |

> 逐项原因与修法写进了提交信息与 **`docs/待处理清单.md`** 的 `P2`【DevKit 记入·2026-09-19 · Task 14 Rider 1】条
> （已按该文件既有做法改成 `[x]` 并补实测证据）—— 门禁配置里的失败必须同时进"欠账台账"，否则翻页就丢。
> ★ 两条修法的共同教训：**"组件演进、脚本未同步"这种含糊归因会让真违规被当成脚本问题放行**；
> 每条失败都要按"哪边才是对的口径"逐项判（本节的"哪边才是对的口径"列即为该判据的留证）。

#### `verify-knowledge-gui` 已移出本桶（2026-09-19 Task 14 · Rider 2）——归因被更正

它原在本桶，理由写的是"组件演进后脚本未同步"。**这个归因是错的**（Task 12 实现者的判断，Task 14 复核推翻）：

- **2 项是真违规**（改的是**组件**，不是脚本）：`docs/superpowers/specs/2026-09-13-knowledge-gui-design.md:92` 明文
  「图标 lucide only，**禁 emoji**」，且该 spec 的 `:208-209` 记着先例 —— 上一轮 emoji 命中（`KnowledgeDocView.tsx`
  与 `src/components/knowledge/graph/KnowledgeEdge.tsx` 的注释）当时的修法就是**改代码**。故：
  `KnowledgeToolbar.tsx` 的 UI 警示符号（commit `8664f1e`）改为 lucide `AlertTriangle` 图标；
  `KnowledgeSidebar.tsx` 注释里的符号改为文字。
- **1 项是脚本字面量腐烂**（改的是**脚本**）：视图白名单，真源 `src/stores/knowledgeStore.ts:27` 已是
  6 值（2026-09-14 批次 1 新增 `tags`，`knowledgeStore.test.ts` 有「六视图集合」断言），脚本仍逐字比 5 值。

修后干净环境实测 `EXIT=0`，故移入 `ci` 桶并串进 `verify:ci`（`package.json`）——
`pendingFix` 从 **3 脚本 / 15 项失败** 降为 **2 脚本 / 12 项失败**（两个剩余脚本已于 2026-09-19 P1 修绿，见上表 ⇒ 本桶清空）。
教训写在这里：**"组件演进、脚本未同步"这种含糊归因会让真违规被当成脚本问题放行**；
每条失败都要按"哪边才是对的口径"逐项判（本节与 `docs/待处理清单.md` 均按此写）。

## 更新文档锚点

```bash
npm run anchors:write   # 重新生成 docs/_anchors.json（只在计数确实该变时跑）
```

跑完请**看一眼输出了什么**：若有"未处理"的缺失路径，说明有文档腐烂待修。

## 两条流水线作业

| 作业 | 内容 | 为什么单列 |
|---|---|---|
| `test` | typecheck + `npm run kit:check`（单独一步，见「DevKit 台账门禁」）+ `test:ci` | 主要门禁 |
| `build` | `npm run build` + `node scripts/build-kernel.mjs` | **产物可产出本身就是断言**：类型、导入、打包配置坏了时，测试可能全绿，而用户拿到的是坏包 |

`concurrency` 设了按分支取消旧跑批：既省额度，也避免"旧提交的绿灯"被误当成当前状态。
