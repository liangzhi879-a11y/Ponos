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

【推进标注——写完整 plan 前必须补】：
- [ ] 读 claude-code-gui 实际 bridge 内核解析/bootstrap 代码，列出待删分支与兜底的具体文件:行（S1 清单③ 输入）
- [ ] 新版各隔离资源的具体取值（端口号、appId、运行时目录名、数据根名）——取值表需与旧版清单无交集
- [ ] 双版并行的冒烟用例清单（同用例在两版各跑一遍的对照表）
- [ ] `YFW_HOME` 覆盖机制在 claude-code-gui 现有实现的核实（环境变量名与传播路径）

**执行记录（2026-09-08，S4 推进中）**：
- **CDP 隔离行修订（D5）**：净室 browser executor 的 CDP 为进程内 `webContents.debugger.attach('1.3')`（browser-executor.cjs），**无网络端口**——设计 §8 隔离矩阵第 3 行"52319/9223 端口隔离"对净室不适用，修订为 **N/A（进程内 CDP）**；52319 仅 `server/interject.e2e.mjs` 固定测试口（单测语境，不与双版并行冲突）。
- **T6 backlog 显式登记**（T4 完结复查移交，均归 T6/S6 处置）：① `kernel/cli.mjs:5` 注释「bun 运行时 spawn（findPonos 候选 #1）」措辞统一为净室语义（YFWORKING_KERNEL，D8）——kernel 本体纪律零改动，本行仅登记不改；② installer.nsh 技能数 65→85 校准与手册版本不一致（S6 出包统一）；③ build_promo_pdf.py BASE 硬编码路径参数化；④ BUILD.md + docs/manual 的 YF/旧端口默认值（51309/5173）文档引用清洗（S6 文档面）；⑤ 产物身份 appId/productName 区分决策（S6）；⑥ CRLF/.gitattributes 字节复核；⑦ 根 diag-yfw.bat（legacy 安装诊断工具）bun 布局引用（`resources/runtime/bun/bun.exe` 等）清洗或退役（T4 review concern 3）；⑧ verify-permission-flow.mjs env 的 `CLAUDE_CODE_USE_NATIVE_FILE_SEARCH:'true'` 残留（旧内核 rg 语义、ponos 内核忽略；随 S5/S6 脚本清洗顺带移除，T4 review concern 5）；⑨ electron-builder.yml :40-69 runtime/python、runtime/skills 等 extraResources 源悬空（净室无 runtime/，S6 出包须随构建补齐资源或调整源，T4 concern 2）；⑩ electron-builder.yml compression 段注释 bun.exe 残留措辞（T4 review Minor）。（⑦-⑩ 为 T4 review Approve 建议项补登，2026-09-08）

---

## S5：协议增强移植

**目标**（设计 §6/§10）：按 S1 清单②逐项把 2026-09 协议增强从 ponos-dev server/GUI 侧移植到新库；内核侧能力（审批门内核部分、守卫自愈、CJK 估算等已随 kernel/ 整体迁入）不重复移植；不携带 v3 UI。

**候选范围**（设计提及，以 S1 清单②实测为准）：审批门接线、压缩可见化（「正在压缩上下文…」指示条）、技能清单去重、浏览器桥接迭代等 server/GUI 侧特性。

**移植纪律**：移植单元 = 代码改动 + 配套测试；沿用"测试权威"惯例（先跑/先写测试再改实现）；每项独立 task + review 门禁。

【推进标注——写完整 plan 前必须补】：
- [ ] S1 清单②完成（逐项标 影响面/依赖/建议）——本子工程的输入
- [ ] 每项候选在 ponos-dev 的源码位置与在新库的目标落点对照表
- [ ] 与 v3 内容的边界：逐项确认不携带 harness/modules/cockpit UI

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
- [ ] 冒烟矩阵用例逐项脚本化（参照旧库现有冒烟/回归资产）
- [ ] 打包产物结构核对清单（resources/app、kernel-dist 落位）
- [ ] 双版并存运行验证的时长与资源（同机同开）
- [ ] 旧库/旧产物处置（退役 yfw-kernel 等破坏性操作）——单独逐项征询，不预设

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
