# S3–S6 净室库落成路线大纲（推进时完善再实施）

> **For agentic workers:** 本文件是**大纲**（outline），不是可逐任务执行的实施计划。每一节均带【推进标注】列出"实施前必须补全的内容"。批准推进某子工程时：先按该节【推进标注】补齐为完整 plan（writing-plans 规范：逐任务文件/接口/步骤/代码/测试命令，无占位），再以 superpowers:subagent-driven-development 执行。

**定位**：承接设计 `docs/superpowers/specs/2026-09-07-yfworking-ponos-kernel-switch-design.md` 的 §6 子工程表 S3→S6 与已完成/进行中的 S1（差异盘点）、S2（内核修复 P0 已完、P1/P2 进行中）。前置依赖：S3 需 **S2 修复后内核基线**（ponos-dev 的修复以版本化基线搬移）；S5 需 **S1 清单②**（协议增强候选）。

**四段依赖链**：S3（净室库落成）→ S4（内核接线与双版隔离）→ S5（协议增强移植）→ S6（打包与验收）。S3 可先于 S5；S5 依赖 S1 产物。

---

## S3：净室库落成（拷贝不移动，全新 git 历史）

**目标**（设计 §5/§7）：在 `C:\Users\T203-15\yfworking` 已建立净室库起点（git init + 设计 + S2-P0 计划已入库）之上，从 claude-code-gui 迁入自研产品代码与根配置、从 ponos-dev 迁入修复后内核源码与构建脚本，使 `npm ci → typecheck → vite build → npm test` 对齐旧库基线。

**迁移清单**（设计 §7，来源 → 内容）：
- claude-code-gui → `src/`、`electron/`、`server/`、`pet/`、`build/`、`scripts/`、`bin/`、`public/`、`docs/`（自研，筛除指向旧内核的过时内容）、根配置（package.json/lock、electron-builder.yml、vite/ts/tailwind/postcss、index.html、skills-lock.json）、BUILD.md 等
- ponos-dev → `kernel/`（S2 修复后基线）、`scripts/build-kernel.mjs`、内核测试与配置文档

**排除**：`yfw-kernel/`、`node_modules/`、`release/`、`dist/`、`kernel-dist/`、`.env`、调试临时目录、运行时二进制、ponos-dev 的 v3 平台目录（harness/modules/cockpit）、任何指向旧内核路径的兜底分支。

**关键决策（落地时敲定）**：
1. 内核维护策略落地：版本化内核同步（固定基线版本 → 定期从 ponos-dev 搬移 + 新库全量测试）——首版基线版本号、同步间隔、谁触发。
2. docs/ 迁入范围：哪些 claude-code-gui docs 保留、哪些因"指向旧内核"剔除（以 S1 清单③ 为据）。
3. 运行时方案预研：内核零依赖 node≥18；打包内 node vs 系统 node 是 S4 决策，S3 只需 dev 链路能起（系统 node）。

【推进标注——写完整 plan 前必须补】：
- [x] 逐目录核对 claude-code-gui 与 ponos-dev 待迁文件的实际清单（以 `ls`/`git ls-files` 实测，勿凭记忆），排除集逐项验证存在性
- [x] claude-code-gui 的 `npm ci → typecheck → vite build → npm test` 旧库基线数值（各命令 pass/fail、时长），作对齐基准
- [x] kernel 迁入后的测试入口与依赖（内核测试是否需独立脚本；bun build 是否在 S3 引入）
- [x] S1 清单③（残留引用点 + v3 排除边界）作为排除集的权威依据——若 S1 未完成，S3 不得开始

**执行记录（2026-09-08，S3 完结）**：S3 净室库落成完结，5 Task 全部完成（计划见 `docs/superpowers/plans/2026-09-07-s3-cleanroom-migration.md`）。
- Commits：`86280e8`（S3 计划）→ `8e164b7`（Task 1 产品代码迁入，556 文件含 .gitignore）→ `12cbec4`（Task 2 docs/manual 27 受控 + 在途宣传页/6 截图 + bridge-contract）→ `ff492ff`/`b4db8a5`（docs/superpowers 计数 7→8 修正）→ `9061826`（YFWORKING_HOME 变量名修正）→ `0dda384`（Task 4 内核 kernel/33 + 根 version.mjs + kernel-tests 8 套件）→ 完结 commit（本文件 roadmap S3 节更新）。Task 3 为纯验证任务无 commit。
- 四步流水线对齐旧库基线：`npm ci` exit 0（28.4s，51+13 deps）→ `typecheck` exit 0（12.3s）→ `vite build` exit 0（46.9s）→ `npm test` **130 tests / 128 pass / 2 fail 与旧库基线精确一致**（2 失败均为预期环境性：browser-executor whitelist 污染——YFWORKING_HOME 隔离后单文件 15/15 通过证根因；transcript mtime flaky 非确定复现）。
- 内核：kernel/ 33 文件 + 根 version.mjs（3 处 import 前提）迁入，kernel-tests/ 8 套件 **50/50 全绿**（无 env 前缀直跑）。
- 排除集验证（Task 5）：追踪面 grep 0 命中；on-disk 全部不存在；node_modules/dist/release/runtime gitignored OK；docs/superpowers 仍为净室原生 8 受控文件（7 + S3 计划文档，非 cg 迁入）。
- 决策落点（S3 纯拷贝、零代码改写，下列清洗项只记 backlog）：build_promo_pdf.py BASE 硬编码 `C:\Users\T203-15\claude-code-gui` 需参数化（归 S4/S6 脚本清洗批，与 package-portable/verify-permission-flow 同族）；installer.nsh 技能数 65→85 校准与手册 V2.7.2/V2.7.5 版本不一致（记 S6 出包统一）；YFWORKING_HOME 变量名实测（browser-common.cjs:115）；CRLF/.gitattributes 延迟至 S6 字节复核前。
- **S4 backlog**：S1 清单③ 残留引用（旧内核路径 + Claude Code 兜底）此刻全部"原样残留"、无一改接——完整 `文件:行 + 引用 + S4 改接去向` 表见完结报告 `.superpowers/sdd/2026-09-07-s3-cleanroom-migration/task-5-report.md`「S4 backlog」节（scratch，不入 git），S4 计划直接消费。

---

## S4：内核接线与双版隔离

**目标**（设计 §8/§9）：bridge 内核解析/构建/bootstrap 全指向本库内核；删 yfw-kernel 分支与旧兜底（破坏性，逐项征询）；隔离矩阵落地；dev 双版并行冒烟。

**四条主链**：
1. dev：bridge 内核解析顺序全指向本库 `kernel/` 源或 `kernel-dist/cli.mjs`；删除 yfw-kernel 分支与旧兜底；`PONOS_KERNEL` 覆盖保留作调试逃生口
2. 构建：`scripts/build-kernel.mjs` 在本库产出 `kernel-dist/cli.mjs`
3. bootstrap：主进程把内核拷到新版专用运行时目录（不与旧 `~/.yfworking/runtime/kernel` 互覆）
4. 打包：electron-builder 将 `kernel-dist` 打入 `resources/app`

**隔离矩阵**（设计 §8）逐行落地：bridge WS 端口（旧 51309 → 新版独立默认值，环境变量覆盖）、vite dev/preview（5173/4173 → 不同口）、Electron CDP 52319 及工具链 9223、App 身份/userData（appId/productName 区分）、内核运行时落地目录、数据根（`YFW_HOME` 覆盖可切回旧 home 读老会话）、技能/经验目录**共享只读沿用**（`--add-dir` 指向）。原则：可写且互踩全隔离、只读共享。

**运行时决策**（设计 §13 开放项在此敲定）：打包内 node vs 系统 node。

【推进标注——写完整 plan 前必须补】（全部完成，2026-09-08 S4 完结勾选）：
- [x] 读 claude-code-gui 实际 bridge 内核解析/bootstrap 代码，列出待删分支与兜底的具体文件:行（S1 清单③ 输入）——T3/T4 落地：解析顺序全指向本库 `kernel/`→`kernel-dist`→`<home>/runtime/ponos-kernel`
- [x] 新版各隔离资源的具体取值（端口号、appId、运行时目录名、数据根名）——取值表需与旧版清单无交集——D3/D4 取值落位，双版 env 隔离取值表见 `docs/bridge-contract.md` §10；appId/userData 取值归 S6（backlog ⑤）
- [x] 双版并行的冒烟用例清单（同用例在两版各跑一遍的对照表）——T6 冒烟矩阵全跑，见下方「S4 完结执行记录」
- [x] `YFW_HOME` 覆盖机制在 claude-code-gui 现有实现的核实（环境变量名与传播路径）——实测变量名为 `YFWORKING_HOME`（原设计名修正），解析序 `YFWORKING_HOME || CLAUDE_CONFIG_DIR || ~/.yfworking`，见 server/yfw-home.cjs

**执行记录（2026-09-08，S4 推进中）**：
- **CDP 隔离行修订（D5）**：净室 browser executor 的 CDP 为进程内 `webContents.debugger.attach('1.3')`（browser-executor.cjs），**无网络端口**——设计 §8 隔离矩阵第 3 行"52319/9223 端口隔离"对净室不适用，修订为 **N/A（进程内 CDP）**；52319 仅 `server/interject.e2e.mjs` 固定测试口（单测语境，不与双版并行冲突）。
- **T6 backlog 显式登记**（T4 完结复查移交，均归 T6/S6 处置）：① `kernel/cli.mjs:5` 注释「bun 运行时 spawn（findPonos 候选 #1）」措辞统一为净室语义（YFWORKING_KERNEL，D8）——kernel 本体纪律零改动，本行仅登记不改；② installer.nsh 技能数 65→85 校准与手册版本不一致（S6 出包统一）；③ build_promo_pdf.py BASE 硬编码路径参数化；④ BUILD.md + docs/manual 的 YF/旧端口默认值（51309/5173）文档引用清洗（S6 文档面）；⑤ 产物身份 appId/productName 区分决策（S6）；⑥ CRLF/.gitattributes 字节复核；⑦ 根 diag-yfw.bat（legacy 安装诊断工具）bun 布局引用（`resources/runtime/bun/bun.exe` 等）清洗或退役（T4 review concern 3）；⑧ verify-permission-flow.mjs env 的 `CLAUDE_CODE_USE_NATIVE_FILE_SEARCH:'true'` 残留（旧内核 rg 语义、ponos 内核忽略；随 S5/S6 脚本清洗顺带移除，T4 review concern 5）；⑨ electron-builder.yml :40-69 runtime/python、runtime/skills 等 extraResources 源悬空（净室无 runtime/，S6 出包须随构建补齐资源或调整源，T4 concern 2）；⑩ electron-builder.yml compression 段注释 bun.exe 残留措辞（T4 review Minor）。（⑦-⑩ 为 T4 review Approve 建议项补登，2026-09-08）

**执行记录（2026-09-08，S4 完结）**：
- **Commit 链**：`932f351`（S4 计划+修订）→ `80d89cf`（T1 kernel-dist 构建链+D1 实证）→ `1e0e2b6`/`c0a74e3`/`312e35b`（T2 home env-aware）→ `a622e71`/`d11e8cd`/`110ca09`（T3 内核解析链改接+整目录镜像）→ `958f790`→`7025e8e` 8 commits（T4 端口/启动器/打包/残留清扫）→ `ef28690`（T5 spawn 接线测试）→ `2fb45d8`（T6 backlog 补登）→ `bdf289c`（T6 文档完结：bridge-contract 净室契约基线 §10）。
- **Decision 全集落位**：D1 runtime=node（非 bun）；D2 home 解析序 `YFWORKING_HOME || CLAUDE_CONFIG_DIR || ~/.yfworking`；D3 bootstrap 目录专用化 `<home>/runtime/ponos-kernel`（2026-09-08 覆写事故固化）；D4 端口 51517/5197/4197 + env 覆盖（YFW_BRIDGE_PORT/YFW_VITE_PORT/YFW_VITE_PREVIEW_PORT）；D5 browser CDP 进程内无端口（隔离矩阵行 N/A）；D6 App 身份/userData 区分决策已定、取值归 S6（backlog ⑤）；D7 kernel-dist gitignored 构建产物；D8 `YFWORKING_KERNEL` 唯一逃生口（值无效即抛错）。
- **T6 双版冒烟（脚本化行全跑，GUI 行按授权标 manual）**：旧版 51309（在售运行中）与新版 51517（隔离 home）同机同时 healthy；隔离 home 下 bootstrap 落地 `runtime/ponos-kernel`，在售 `runtime/kernel` 前后 md5 不变（`86697d84…`）；spawn 行指向 repo `kernel/cli.mjs`；bridge 级 mock 会话（RESULT subtype=success，usage in=10/out=20）；真实云端 ds 1532ms「收到」（input 10348）；真实本地 Qwen（218.17.137.219:8900）5629ms。token 临时配置与全部测试进程已清理，端口 51517/5197 free。Electron 全栈 GUI 行 = manual（S6 功能冒烟矩阵承接）。
- **Review 门禁**：T1-T5 各 1 轮 reviewer Approve（T3 修复轮 1 后；T4/T5 0 blocking，T5 3 minors 已清理/登记）。T6 docs/state 复核通过后 ledger 记 S4 完结（见 .superpowers/sdd ledger）。
- **S5/S6 backlog 移交**：S5 输入 = 本 roadmap §S5 推进标注（**S1 清单② 未完成则 S5 不得启动**）；S6 承接 = 上文 T6 backlog ①-⑩ + `docs/bridge-contract.md` §10 双版取值表 App 身份行 + GUI 全栈功能冒烟矩阵 + 打包实跑（electron-builder.yml runtime/ 悬空源，backlog ⑨）。

---

## S5：协议增强移植

**目标**（设计 §6/§10）：按 S1 清单②逐项把 2026-09 协议增强从 ponos-dev server/GUI 侧移植到新库；内核侧能力（审批门内核部分、守卫自愈、CJK 估算等已随 kernel/ 整体迁入）不重复移植；不携带 v3 UI。

**候选范围**（设计提及，以 S1 清单②实测为准）：审批门接线、压缩可见化（「正在压缩上下文…」指示条）、技能清单去重、浏览器桥接迭代等 server/GUI 侧特性。

**移植纪律**：移植单元 = 代码改动 + 配套测试；沿用"测试权威"惯例（先跑/先写测试再改实现）；每项独立 task + review 门禁。

【推进标注——写完整 plan 前必须补】（全部完成，2026-09-08 S5 完结勾选）：
- [x] S1 清单②完成（逐项标 影响面/依赖/建议）——本子工程的输入；S1 清单② 9 项全 complete（②-01…②-09），纳入 S5 的 4 项见下方执行记录
- [x] 每项候选在 ponos-dev 的源码位置与在新库的目标落点对照表——pd 参照证据包 `.superpowers/sdd/2026-09-08-s5-protocol-porting/pd-reference-pack.md`（pd HEAD 1696286 只读）；净室实测事实 F1-F13 见 S5 plan §2.1
- [x] 与 v3 内容的边界：逐项确认不携带 harness/modules/cockpit UI——②-09（v3 windows 平台）明确排除；②-02/②-05 移植仅取事件消费/归约语义，pd 的 v3 busy 闸/会话树模型不携带（净室 streamingSessions 语义简化，见 S5 plan D5/§Task 4）

**执行记录（2026-09-08，S5 完结）**：S5 协议增强移植完结，5 Task 全 approve（计划见 `docs/superpowers/plans/2026-09-08-s5-protocol-porting.md`，范围 = ②-03/②-07/②-05/②-02 四候选）。
- **Commit 链**：`206d803`（S5 计划成稿）→ `1218aaf`（T1 技能内核块基线测试）→ `bb99840`（T1 停用 bridge 宿主技能注入）→ `5002b28`（T2 WS ping→pong 接线测试）→ `df6a0bc`（T2 GUI 15s/60s 半开心跳）→ `96185b0`（T3 KernelStallBar+LoopStatusBar 守卫自愈接线）→ `7ac001c`（T4 CompactingBar 压缩可见化）。
- **四候选实测结论**：②-03 技能清单去重——双份实锤（内核 composeSystemPrompt【可用技能】块 kernel/prompt.mjs:100 vs bridge 宿主【已安装技能清单】注入）→ 停宿主注入（D1），技能可见性唯一来源 = 内核技能块（经 `--add-dir` 技能根发现），宿主保留 ASKUSER/MILESTONE/经验注入；`server/prompt-skills.test.mjs` 锁内核块行为 + `scripts/verify-skill-listing.mjs` 改写（宿主清单断言 → 内核技能块结构不变量）。②-07 WS 半开心跳——bridge WS 分支链加 ping→pong（server/bridge.mjs:2118-2123，ws 库级心跳不动）+ `server/ws-heartbeat.test.mjs`（spawn bridge + WS ping→pong 锁线协议）+ GUI 15s ping/60s 判死强关走既有指数退避重连（src/hooks/useYFWCLI.ts）。②-05 守卫自愈接线（GUI）——kernel-stall 顶层消息 + loop start/iter/end 帧归约 → KernelStallBar（内核静默警告+取消+关闭）+ LoopStatusBar（轮次进度）；store 放置 = uiStore.kernelStalls（不入 partialize）+ chatStore.loopStates（runtime-only）。②-02 压缩可见化（GUI）——system/compaction start/done 帧归约 → chatStore.compactingBySession（runtime-only）+ CompactingBar（「正在压缩上下文…」指示条）；不引入 pd v3 busy 闸（净室 streamingSessions 语义简化），cancelled/closed 复位兜底防悬挂。
- **②-04 已落地/②-08 延后**：②-04 browser-executor snapshot 净室已含（electron/browser-executor.cjs:121/164/170 isInsideOverlay 行号与 pd 全同），S5 不重复移植；②-08（set_effort/switch_provider）内核已支持（kernel/cli.mjs:595/620），bridge 透传 + GUI 档位入口价值有限，延后为 S5 backlog，S6 前产品明确热切需求再评估。
- **范围纪律**：kernel/、kernel-tests/ 零改动（②-0x 全部 server/GUI 侧）；`YF/` untracked 用户素材零触碰；diff 逐 task 复核（T2 3 文件、T3 9 文件、T4 6 文件全在 server//src/）。GUI 验证 = typecheck + vite build + 授权 manual 标注（未执行，S6 GUI 全栈冒烟承接）。
- **回归**：npm test 142/142（临时 home；electron/browser-executor isBlockedUrl 1 fail 为真实 home whitelist 环境性 pre-existing，经 stash 复跑证实与 S5 无关，归 S6 backlog）；kernel-tests 50/50；typecheck/build 0 逐 Task 收尾。
- **Review 门禁**：T1-T4 各 1 轮 reviewer Approve（T1 0/0、T2 0/2、T3 0/2、T4 0/1；minors 全部视觉/文档级或 pd 同构，零阻塞）。ledger 见 `.superpowers/sdd/2026-09-08-s5-protocol-porting/`。
- **S5→S6 backlog 移交**：②-08 热切需求评估（本 S5 延后项）+ S6 backlog ①-⑩（S4 T6 登记）保持 + browser-executor.test isBlockedUrl 环境性失败修复 + 本 S5 三处 minor 视觉/注释项（可随 S6 文档/视觉面一并处理）。

---

## S6：打包与验收

**目标**（设计 §11）：YFWorking 品牌安装包；零残留四层审计；在售功能冒烟矩阵；双版并存运行验证；DoD 全项（设计 §4）。

**四层零残留审计**：
1. 代码面：全库 grep 不命中专有内核路径/标识（仅允许协议字段名与许可证文本）
2. 产物面：安装包内 cli.mjs 标记探测——ponos 标记 > 0 且 anthropic 标记 = 0（对照旧内核 21.9MB / 409 命中）
3. 依赖面：内核零 npm 依赖（沿用 deploy-smoke 断言）
4. 测试面：内核基线 + 产品基线全绿

**功能冒烟矩阵**：浏览器/填表/抓取/文档/表格/打包/宠物/技能/企微等主要功能，新旧两版同用例对照。

【推进标注——写完整 plan 前必须补】：
- [x] 冒烟矩阵用例逐项脚本化（参照旧库现有冒烟/回归资产）——（归 Batch B，2026-09-08）
- [x] 打包产物结构核对清单（resources/app、kernel-dist 落位）——（归 Batch B，2026-09-08；verify-package-assets.mjs 已就绪，T1）
- [x] 双版并存运行验证的时长与资源（同机同开）——（归 Batch B，2026-09-08）
- [x] 旧库/旧产物处置（退役 yfw-kernel 等破坏性操作）——单独逐项征询，不预设（归 Batch B，2026-09-08）

**执行记录（2026-09-08，S6 Batch A 完结）**：S6 Batch A（收编与准备迭代）完结——T0-T6 全过 + T7（本 commit）完结勾选（计划见 `docs/superpowers/plans/2026-09-08-s6-packaging-prep.md`；范围 = 模板收编/版本身份/脚本与文档清洗批/测试面补齐/注释一致性）。出包实跑、四层审计产物面、GUI 冒烟、双版并存、破坏性 ops 不在本批执行，遗留交接见文末 Batch B 清单。
- **Commit 链**：`a502665`（T0 计划入库）→ `b51e787`（T1 内置模板收编）→ `d169b6b`（T2 版本身份落位）→ `f56ce5e`（T3 脚本清洗批）→ `cc651ec`（T4 文档清洗批）→ `876def8`（T5 测试面补齐）→ `bbfb346`（T6 S5 minor 注释一致性）→ T7（本 commit，roadmap S6 节完结）。并行 agentloop 计划提交 `ba87c8e`/`917d43b`（`docs(spec)`/`docs(s6-agentloop)`，插于 d169b6b 与 f56ce5e 间、f56ce5e 与 cc651ec 间）为其它子工程工作（本批 range 内插入、非 S6 产物；review 按实际父链复核，零改动）。
- **Decision 全集（D6-A~E，2026-09-08 用户定案）**：D6-A 版本 = package.json **2.7.5 → 2.8.0**（净室首版，触发 installer.nsh 版本比较覆盖升级语义；version.mjs 不改）；D6-B 产物身份 = **正式替换身份**——appId `com.yfworking.desktop` / productName `YFWorking` 与在售一致，安装形态经 installer.nsh 版本比较覆盖升级；双版并行走便携/dev 目录隔离 + `YFWORKING_HOME` userData 重定向兜底（main.cjs 行为不变，仅注释定案）；D6-C 内置模板源 = agents/memory/tools 收编 `build/templates/`（git 受控），python 与 skills 维持构建期组装 `runtime/`；D6-D 冒烟口径 = Batch B 自动为主 + 授权 manual 行（S5 遗留视觉/注释 minor 随 Batch B GUI 冒烟覆盖）；D6-E ②-08 保持 backlog（产品无热切需求，结论见下）。
- **S6 backlog ①-⑩ 处置状态**（出处 = §S4「T6 backlog 显式登记」+ §S5 移交）：

| # | 登记项 | 处置（S6 Batch A） |
|---|---|---|
| ① | `kernel/cli.mjs:5` spawn 注释措辞统一为净室语义（YFWORKING_KERNEL，D8） | 已处理关闭——现注释即为净室语义（`YFWORKING_KERNEL` 逃生口候选 #1），本批复核确认；kernel 本体零改动原则保持 |
| ② | installer.nsh 技能数硬编码（65→85 校准后仍为固定计数）与手册版本不一致 | T1 去硬编码：弹窗文案去「85 个」计数、marker `skills`/`deployedCount` → `"bundle"`（随出包机技能库动态变化）；手册版本由 T4 文档清洗统一至 2.8.0 |
| ③ | build_promo_pdf.py BASE 硬编码路径参数化 | T3 处理：BASE 改 repo 根相对解析，footer/c-foot 版本字面 V2.7.2→V2.8.0；宣传页 logo（`docs/manual/images/logo_新远方数据LOGO横版.png`）已在净室受控，收编确认 |
| ④ | BUILD.md/docs/manual 旧端口（51309/5173）与旧版本/日期文档引用清洗 | T4 处理：BUILD.md + 产品使用说明书 51309→51517、补 5197/4197、pet 源改接、2.7.2/2026-08-20→2.8.0/2026-09-08；扫描 0 命中（bridge-contract §10 对照表 51309→51517 历史映射行属例外白名单，未触碰） |
| ⑤ | 产物身份 appId/productName 区分决策 | T2 落位（D6-A/D6-B）：version 2.8.0 + 正式替换身份定案注释/取值同步 electron-builder.yml、main.cjs、bridge-contract §10 |
| ⑥ | CRLF/.gitattributes 字节复核 | 本轮未处理——归 Batch B 字节复核（出包前字节审计） |
| ⑦ | 根 diag-yfw.bat（legacy 安装诊断工具，bun 布局）退役 | T3 执行 `git rm` 退役删除——净室运行时 = node（D1），整文件失效且无独有可复用逻辑；净室诊断 = 应用内「诊断」面板 + NSIS 自身机制 |
| ⑧ | verify-permission-flow.mjs `CLAUDE_CODE_USE_NATIVE_FILE_SEARCH:'true'` env 残留 | T3 删除该行（旧内核 rg 语义，ponos 内核忽略） |
| ⑨ | electron-builder.yml extraResources 源悬空（runtime/agents 等） | T1 改接（D6-C）：agents/memory/tools 三段源 → `build/templates/` 受控源；python/skills 保持构建期组装源并登记预检；新增 `scripts/verify-package-assets.mjs`（T1）供 Batch B 出包前复用 |
| ⑩ | electron-builder.yml compression 段注释 bun.exe 残留措辞 | T3 清洗：`(bun.exe, node.exe, Python wheels, embedded CLI bundle)` 去 bun.exe；全文 bun.exe 0 命中（「bun 不随包」否定表述无 bun.exe 字面，保留） |

- **②-08 结论（S5 延后项，D6-E）**：结论草稿由 T6 拟定、T7 落位 roadmap，全文如下。
  > ②-08 set_effort/switch_provider：内核已支持（kernel/cli.mjs:595/620）；净室 bridge 未透传、GUI 无档位入口（pd 面板属 v3 排除）；产品侧无热切需求 → 保持 backlog，评估触发条件 = 产品明确需要会话内切换 provider/思考深度时，按 pd bridge 语义 diff 最小透传（bridge 分支 + GUI 菜单项），不移植 v3 面板。
- **S5→S6 backlog 其余移交项**：browser-executor.test isBlockedUrl 环境性失败（真实 home whitelist 污染断言）＝ T5 数据根隔离修复消除（145/145 全绿）；S5 minor = 注释类 T6 就地处理、视觉/纯内存类归 Batch B GUI 冒烟（D6-D，见下）。
- **S5 minor 处置**：注释类就地处理——T6 在 `src/hooks/useYFWCLI.ts` heartbeatDead 声明前插入 1 行语义注释（S5 r2 minor「heartbeatDead 只写不读」，行为零改动，commit `bbfb346`）；判死兜底 :127 注释经核与实现逐字相符（判死 = 置位 + `s.close()` → onclose → `scheduleReconnect` 指数退避，无额外 taskkill/强杀），条件式授权不成立未改写，r2 minor 消解；LoopStatusBar/CompactingBar 组件注释与视觉类归 Batch B GUI 冒烟覆盖（D6-D）。
- **回归**：npm test **145/145**（默认 home）、kernel-tests **50/50**、typecheck 0 error、build 成功——T5 修复环境性失败后全量即此值，T7 完结复核同值（verbatim 见 Batch A ledger/report）。
- **Review 门禁**：T0 N/A（纯文档 commit）；T1-T6 各 1 轮 reviewer 过门（0 blocking；deferred minor 与 ⚠️ 裁决全量记 scratch ledger `.superpowers/sdd/2026-09-08-s6-packaging-prep/progress.md`，随 Batch B 处置）。
- **Batch B 遗留（交接清单）**：
  - 打包实跑出包 + 产物结构核对清单定稿（resources/app、kernel-dist 落位）——出包机先跑 `scripts/verify-package-assets.mjs` 预检（T1 已就绪）；构建期组装源 runtime/python、runtime/skills 由 build-installer.mjs 前置生成
  - 四层零残留审计收口——产物面（安装包内 cli.mjs 标记探测：ponos 标记 > 0 且 anthropic 标记 = 0，对照旧内核 21.9MB/409 命中）为 Batch B 必做项；代码面全库 grep 复核、依赖面（deploy-smoke 断言已入库 T5）、测试面基线（npm test 145/145 + kernel-tests 50/50）Batch A 已具备，出包后全量复核
  - .gitattributes/CRLF 字节复核（backlog⑥）
  - 冒烟矩阵用例逐项脚本化 + GUI 全栈功能冒烟（自动为主 + 授权 manual 行，D6-D；S5 视觉/注释 minor 随行覆盖）
  - 双版并存运行验证（时长与资源、同机同开）
  - 旧库/旧产物处置（退役 yfw-kernel 等破坏性 ops）——单独逐项征询、不预设
  - 文档面 manual 行：说明书/宣传页 PDF 重建——重建前先做 `scripts/build_manual_pdf.py` 清洗（终审 carry-forward：:21 旧库绝对路径 BASE 相对化、:285 V2.7.2/2026-08-20 版本字面同步 2.8.0/2026-09-08，与 T3 promo 同批；T3/T4 已清洗范围 = build_promo_pdf.py + BUILD.md/manual .md，build_manual_pdf.py 不在其内）；`scripts/gen-icons.ps1:47` 旧路径顺带核；package-lock.json root version 2.7.5 与 package.json 2.8.0 drift（t2-minor1）后续清洗

**执行记录（2026-09-08，S6 Batch B 完结）**：S6 Batch B（便携版交付 + 验收收口）完结——T0-T8 全过 + T8（本 commit）完结勾选（计划见 `docs/superpowers/plans/2026-09-08-s6-batchb-portable.md`；范围 = 图标统一 icon-logo/boost-logo / 便携出包 / 文档清洗收口 / 四层零残留审计 / GUI 全栈冒烟 / 双版并存 / 完结交接）。NSIS 安装包本批不构建（D6-B2 明确留后续出包批）；旧库/旧产物处置等破坏性 ops 不自动执行，随完结汇报逐项征询用户。
- **Commit 链**：`1af70a4`（T0 计划成稿 8 Task）→ `579bac1`（T1 图标统一，D6-F/G/H）→ `9a4c495`（plan fence 修正 docs）→ `f51c4c9`（T3 出包修订，D6-B2/I）→ `318cc0e`（T4 文档清洗收口 + deferred minors + gen-icons.ps1 退役）→ `2dfbfb6`（T5 审计代码面清理）；T2（前置产物）/T6（GUI 冒烟）/T7（双版并存）为无 commit 验证任务；本 commit = T8 roadmap 完结。HEAD = 2dfbfb6。
- **D6 决策全集补录（Batch A 定 D6-A~E，本批补 D6-B2/F/G/H/I）**：D6-B2 打包形态 = **便携版**（package-portable.cjs → `release/YFWorking/`），本轮不建 NSIS 安装包、installer 配置就位留后续出包批；D6-F 应用图标族统一 `YF/icon-logo.ai`（方形徽标）矢量渲染；D6-G UI 品牌 logo/favicon 统一 `YF/boost-logo.ai`（横版标识）矢量渲染；D6-H 渲染 PNG/ICO 资产 + 渲染脚本（`scripts/render-ai-assets.py` + png-to-ico.cjs 参数化）入 git、`.ai` 源留 `YF/` 不入库；D6-I 桌面快捷方式经 PowerShell `[Environment]::GetFolderPath('Desktop')` 真实桌面解析（OneDrive 重定向安全，解析失败回退 homedir）。
- **便携出包 + 产物核对（T1-T3）**：public 10 资产替换为 icon-logo.ai/boost-logo.ai 渲染族（icon-256 中心 (200,92,37) 非白、icon-16 不透明 95%、icon.ico 6 entries/favicon.ico 4 entries、logo 512×356）；前置产物 dist（1984 modules）/kernel-dist cli.mjs（193864B）/runtime python（362M）/runtime skills（180M）；package-portable.cjs 补模板资源拷贝（build/templates/{agents,memory,tools}→release/YFWorking/runtime/，缺失 console.error+exit 1）与真实桌面解析；出包 [1/5]..[5/5] 全过含 icon 注入；`release/YFWorking/` du **1.3G**；verify-portable-layout.mjs 布局核对 EXIT 0（桌面快捷方式命中 `C:\Users\T203-15\Desktop\YFWorking.lnk`、electron.exe 215.2 MB、模板三组非空）。
- **四层零残留审计（T5）**：代码面零残留——transcriptAdapter.test.ts 6 处 51309 fixture 裁决改 51517（fixture 语义 = 渲染层所连 bridge 地址 = 新版默认，生产缺省 getBridgeUrl()=51517；单文件 +6/-6，commit `2dfbfb6`），其余命中全落五类（fixture 字面/历史注释/第三方依赖/白名单区/untracked 素材）；产物面便携 kernel/cli.mjs **ponos=104 / anthropic=25**（25 处全白名单归因：`anthropic-version` 协议头×3、ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL env 兼容标识、skills 市场源 anthropics/skills、帮助文案，UA=Ponos-turbo/0.1，零旧 claude 逻辑），对照旧便携（claude-code-gui）**anthropic=871 / ponos=0**（20.91MB）；依赖面 deploy-smoke **3/3** + 便携 cli --help **exit 0**；测试面 npm test **145/145** + kernel-tests **50/50**。
- **backlog⑥ CRLF 字节复核（T5）**：**关闭于「字节复核完成、无功能风险」**——全库无 .gitattributes，索引层 680 文件全量 LF（602 text `i/lf` + 80 binary `i/-text`，`i/crlf` 0 个），工作树 159 个 `w/crlf` 为 autocrlf=true 检出态、提交时自动归一 LF；.gitattributes 引入留待跨平台成员协作再实施（可选，非必需）。
- **GUI 全栈冒烟（T6，隔离 home yfw-s6-smoke + PONOS_MOCK_API=1）**：自动行全绿——cscript VBS 拉起便携（electron 33084 + bridge 46700），8s 后 /health `{"status":"ok"}`、51517 LISTENING、kernel bootstrap 落 `<隔离home>/runtime/ponos-kernel/cli.mjs`（193864B 逐字节同源）；模板首启落位 agents **11/11** + memory/personal **7/7**（diff 与 build/templates 全等）；WS 会话 RESULT subtype=success usage 10/20 文本 "mock: 你好内核 (turn=1)"；browser-executor **15/15**；自启进程树 taskkill 回收、51517 零残留、在售 51309 未扰。**发现 F1（交付级，转后续批）**：portable 首启无 tools 模板播种方——agents 有 main.cjs:1159 `agents:sync`、memory/personal 有 bridge.mjs:823 ensurePersonalDir 播种，tools（runtime/tools README.md+yfw-helper）无对称代码路径（reviewer 限定：installer.nsh:246-261 对安装形态已有可选 tools→home 拷贝）。manual 授权行 M1-M4（窗口/托盘图标 icon-logo、Header/气泡 boost-logo、窗口标题版本）待用户在 GUI 人工核对。
- **双版并存（T7）**：新版便携 51517（隔离 home yfw-s6-dual，bootstrap md5 `9b05f6ec`=新版包 kernel）与在售旧版 51309（ms92cd6u，PID 54408/77008，今日 11:05 重启致真实 home kernel 被旧包 e76efbbf 覆盖、S4 基线 86697d84 不可直接对照——报告披露改以「前后不变」断言）同机同开：双 /health 200 同时 LISTENING（51309 pid 54408 + 51517 pid 77216）；**5 面 kernel md5 前后不变**；真实 home/旧版包目录零新写入（时间戳验证）；并存期间新版 mock 会话 subtype=success；桌面双快捷方式并存（YFWorking.lnk 新版便携 + 旧版调试版 lnk 带 `--remote-debugging-port=9223`，未删改，BUILD.md:88 引用真实命中）；回收新版进程树 81052、51517 零残留、51309 不受扰。
- **文档清洗收口（T4）**：build_manual_pdf.py BASE 相对化（os.path.dirname×2 对齐 promo 先例）+ 版本字面 2.8.0/2026-09-08；PDF 重建成功无缺依赖（manual 文本层 2.8.0×8/2026-09-08×2/51517×3 命中、promo 2.8.0×4）；Batch A deferred minors 收口：t1-minor2（verify-package-assets readdirSync import 删）、t2-minor1（package-lock root version→2.8.0）、t4-minor3（BUILD.md:57 表述避开 WinNAT 预留段 3095-3194）、t5-minor1（exit 清理注释改「文件头」）；gen-icons.ps1 `git rm` 退役（被 render-ai-assets.py+png-to-ico.cjs 取代，无独有逻辑丢失）。
- **Batch B deferred minors 处置表（均记录不阻断）**：

| # | 内容 | 处置 |
|---|---|---|
| t1b-minor1 | render 重跑在 public/ 留 favicon-*.png untracked 中间产物 | 记录——plan 决策允许（不入 commit，favicon.ico 已打包，重跑即再生成） |
| t2b-minor1/2 | 体积口径（脚本十进制 339.2MB vs du 362M） | 记录——以 du 为准，报告双口径并存 |
| t3b-minor1 | package-portable 模板拷贝仅查 build/templates 根不查组目录 | 记录——verify-portable-layout 脚本兜底，brief 仅要求根检查 |
| t3b-minor2 | 桌面 lnk 检查 warn-only（重定向桌面场景） | 记录——S6_TEST_DESKTOP 测试注入，brief 设计如此 |
| t4b-minor1 | package-lock packages[""] 仍 2.7.5 与根 2.8.0 并存 | 记录——brief 明示只改根；建议正式出包前同步 packages[""] |
| t5b-minor1 | CRLF 计数漂移（报告 80/159 vs 实测 78/154、602+80=682 vs 自称 680） | 记录——报告表述级，结论不变 |
| t5b-minor2 | kernel/*.mjs:1 注释所引 docs/superpowers/specs/2026-08-20-ponos-turbo-* 本库不存在（报告称「指向白名单」失实） | 记录——报告表述订正，裁决保留成立 |
| t6b-minor1 | 报告基线写 b4182b6 实为 2dfbfb6 | 记录——冒烟物与 HEAD 一致，无实质影响 |
| t6b-minor2 | F1 初报未提 installer.nsh 既有 tools 路径 | 记录——reviewer 限定已补，F1 精确表述 = portable 首启无 tools 播种 |
| t6b-minor3 | tools「3 文件」子树实 4 文件措辞歧义 | 记录——报告表述级 |
| t7b-minor1 | lnk 显示名误录——实际「YFWorking 调试版.lnk」 | 记录——目标/参数/并存事实均属实，GBK 乱码所致，reviewer 实测订正 |

- **Review 门禁**：T0/T2 N/A（计划/无 commit 前置产物）；T1/T3/T4/T5 commit 任务各 1 轮 reviewer PASS（T5 PASS-with-minors）；T6/T7 无 commit 任务 PASS-with-minors（自动行全绿，manual 行随完结汇报呈用户）；deferred minor 与裁决全量记 scratch ledger `.superpowers/sdd/2026-09-08-s6-batchb-portable/progress.md`。
- **回归（T8 完结复核）**：typecheck 0 error、npm test 145/145、kernel-tests 50/50、build 成功（verbatim 见 Batch B ledger/report）。
- **后续批/开放项转交**：NSIS 安装包出包（D6-B2，installer 配置与产物身份已就位，build-installer.mjs 前置生成 runtime/python+skills 后实跑）；F1 portable tools 模板首启播种方（定机制后再出正式版）；旧图标程序化资产（favicon-*.png 中间产物、YF/ .ai 源处置）与 YF/ 素材旧路径（51309/claude-code-gui 红线外披露项）；manual GUI 行 M1-M4 待用户授权核对；browser-executor.test 5173 fixture 可选统一 5197、package-lock packages[""] 同步、.gitattributes 引入等建议项随常规改动处理；**旧库/旧产物处置（退役在售旧库 yfw-kernel/旧便携产物、清理 release/ 历史构建副本 YFWorking_ms92cd6u）继续列开放项集中清单，逐项征询后执行**。

**执行记录（2026-09-08，Batch B 收口后续修正，HEAD 1b7976f→6364592）**：完结汇报三项征询落地——F1 立即修、GUI 欢迎屏改版、默认窗口缩小。**F1 修复（commit `23f7b63`）**：bridge.mjs 新增 `autoInstallTools()`（TOOLS_SAMPLE_ROOTS 限定 dev build/templates/tools + portable `<app>/runtime/tools` 无安装器领地，installed 形态 resources/runtime/tools 仍归 installer.nsh 勾选部署），首启幂等补缺省写 `.tools-pack.json`（与 installer.nsh 同名，已部署即跳过）；mock/真实后端两轮隔离 home 冒烟均验证 4 文件落位 + marker installedBy=bridge-autoinstall。**GUI 欢迎屏改版 + 窗口尺寸（commit `6364592`）**：hero 换 boost-logo 横版 logo.png 纯图形主视觉，删除橙色 YFWorking 渐变字标与副标题（用户目视确认无残留）；「开始使用」推荐任务区改为「使用提示」——8 条中英储备池基于应用真实能力编写，空态每次随机展示**单条**（用户插话从 4 条改 1 条）、10s 去重自动轮换、切换会话/语言重抽；废弃 welcomeSubtitle/quickStart/suggestion1-6 翻译键（welcomeTitle/emptyHint/welcomeFooterHint 保留）；BrowserWindow 默认 1400×900 → **1100×720**（minWidth 900/minHeight 600 不变），实测窗口 rect 1101×720。**真实后端冒烟（用户要求非 mock）**：隔离 home 拷贝真实 config.json（activeProvider ruluds-msh3hx4o/deepseek-v4-flash，tokens 不落盘不展示）启动便携，app.log 证 `kernel settings synced -> ruluds-msh3hx4o | model: deepseek-v4-flash`、kernel bootstrap 落隔离 home、51517 healthy；用户 GUI 发送问候收到真实流式回复（非 mock）双确认通过；真实 home 零触碰（仅只读拷贝 config 至 scratch）。**回归全绿**：typecheck 0 error、npm test 145/145、kernel-tests 50/50、build 成功（两次改动各自全量复核）。遗留：冒烟实例/隔离 home（含 config 拷贝）回收 + scratch 入 gitignore 建议，随收尾征询。

---

## 开放项集中清单（跨 S3–S6，来自设计 §13）

| 开放项 | 归属 | 处置 |
|---|---|---|
| S1 盘点工作量 | S1/S5 | 目录级 diff 聚焦产品功能归属，防无底洞 |
| 协议契约偏差 | S4 | S1 清单③ + S4 接线测试兜住 |
| 双版并存细节 | S4 | 以隔离矩阵为纲逐项落地 + 实测 |
| 运行时二进制随包方式 | S4 | 倾向打包内 node 或系统 node，S4 敲定 |
| 数据延续（非 DoD 硬性） | S4 | 保留 `YFW_HOME` 覆盖，老会话可读 |
| 旧库/旧产物处置 | S6 后 | 逐项征询后执行 |
