# S1 差异盘点审计：claude-code-gui（在售 yfworking v2 产品线） vs ponos-dev（内核现行开发地 + 2026-09 协议增强）

- 日期：2026-09-07
- 范围与方法：只读目录级对照（`ls`/`git ls-files`/`git archive HEAD` + `diff -rq`），聚焦"产品功能归属"；不做整树逐文件无差别 diff、不做内核自身 diff。两库工作树均有未提交在途修改（ponos-dev 的 kernel/api.mjs、kernel/engine.mjs、server/api-protocol.test.mjs 修改 + 2 未跟踪测试；claude-code-gui 的 src/electron/server/docs 等 20+ 文件修改与若干未跟踪文件），故一切文件集/`diff -q` 证据基于 **git archive HEAD 快照**（稳定可复现），工作树 dirty 状态仅作上下文记录。
- 仓库 HEAD 快照：
  - claude-code-gui `C:\Users\T203-15\claude-code-gui` @ `6ba18ecfd8d6e982797f0dde7b950b8fecfb45a1`
  - ponos-dev `C:\Users\T203-15\ponos-dev` @ `030f0a2251430baeda321e8ccfdb41249e8341c4`
- 只读纪律：本审计全程未修改两库任何文件、未 commit/checkout；仅在本文件（yfworking/docs/superpowers/audits/）写入。yfworking 的 git commit 由控制器在 Task 4 统一执行。
- 说明：`git ls-files` 顶层计数中的 `"YF`/`"docs`/`"pet` 等带引号分组是 CJK 文件名被 `core.quotepath` 加引号所致（非异常文件）；本表计数以 HEAD 快照 `find -type f` 为准。

## 三清单索引

- [x] **清单① 产品面差异表**（本文件，Task 1 完成）
- [x] **清单② 协议增强候选表**（本文件，Task 2 完成）
- [x] **清单③ 残留引用点与 v3 排除边界**（本文件，Task 3 完成）

---

## 清单① 产品面差异表

| 目录/文件 | claude-code-gui 侧要点 | ponos-dev 侧要点 | 差异性质[仅旧线/仅增强线/双向演进] | 对净室库影响 | 证据 |
|---|---|---|---|---|---|
| **src/**（GUI 前端） | 83 受控文件。独有 `src/hooks/useYFWCLI.ts`。 | 120 受控文件。独有 38 项：boot/cockpit/dock/module/windows/charts/login、`layout/RightRail`、`settings/SettingsContent`、`chat/KernelStallBar`/`LoopStatusBar`、`hooks/usePonosCLI.ts`（替代 useYFWCLI）、`lib/busPublish/moduleBridge/moduleIcons`、`stores/dockStore/tokenStatsStore/viewStore`（+对应 test）。 | 双向演进（同源分叉，核心组件大面积分叉） | **S3 迁入来源=旧线主体**（cg `src/` 83 文件为在售 GUI 主体）；pd 独有 38 项属 v3 模块化 UI/2026-09 组件仅记录；44 个同名分叉文件的 pd 侧改动是否移植由清单②/S5 判定 | 两库 HEAD 快照 `find src -type f`=83/120；`comm` 同名 82、`diff -rq` 相同 38/分叉 44（App.tsx、components/chat/ChatWindow/ChatInput/MessageBubble/CompressedToast/HealthMeter、components/layout/*、i18n/translations/en-US/zh-CN、stores/agentStore/chatStore/diagStore/doubaoStore/healthStore/settingsStore/uiStore、lib/*、types/index.ts、main.tsx 等全在分叉集）；only_cg=src/hooks/useYFWCLI.ts |
| **server/**（服务端） | 23 受控文件，全部在 pd 有同名（only_cg=0）。 | 91 受控文件。独有 68 项 = 大量 `*.test.mjs`（engine-*/guard-*/session-*/provider-*/kernel-* 等）+ `mock-kernel.mjs`。 | 双向演进（同名 12 分叉；pd 侧增量几乎全是测试与 mock） | **S3 迁入来源=旧线主体**（cg server/ 23 文件为在售服务端主体）；pd 侧 68 个测试/增强仅记录，2026-09 增强候选由清单②评估 | 同名 23：相同 11（askuser/browser-routing/convert_docx/convert_xls/docx_edit/highrisk/milestones/sheet_edit/watermark_remove.test.py + 各 .test.mjs），分叉 12（bridge.mjs、doubao.mjs、experience.mjs、packager.mjs、transcript.mjs、watermark_remove.py、interject.e2e.mjs + diag-info/doubao/experience/packager/transcript .test.mjs）；only_pd=68 |
| **electron/**（桌面壳） | 11 受控文件。 | 24 受控文件。独有 13：approval-center、dock-service、state-bus、module-registry、window-manager、anchor-layout、link-overlay(.cjs/.html)、link-registry（含 .test）。 | 双向演进（强分叉：同名 10/11 分叉） | **S3 迁入来源=旧线主体**（cg electron/ 11 文件）；pd 独有/分叉项多属 2026-09 协议增强与平台化（dock/approval/module/anchor/window-manager）→ 仅记录，候选评估见清单② | 同名 11：相同 1（log-tee.test.mjs），分叉 10（main.cjs、preload.cjs、browser-common.cjs、browser-executor.cjs、diag-monitor.cjs、doubao-page-script.js、log-tee.cjs + 对应 .test）；only_pd=13 |
| **pet/**（桌宠） | 25 受控文件。 | 54 受控文件。独有 29：`dafeiyu-pet/`（像素宠：桌宠.py/启动桌宠.bat + sprites 12 图，CJK 文件名）+ `assets/dafeiyu-*-spritesheet.png` 5 张 + `make_dafeiyu_sprites.py`。 | 双向演进（主体相同，pd 增像素宠补充） | **S3 迁入来源=旧线主体**（cg pet/ 25 文件）；pd 独有 dafeiyu-pet 像素宠为增强线补充→仅记录（可作 S5 可选移植） | 同名 25：相同 24，分叉 1（jiajia-pet.py，86 diff 行，均为品牌/数据目录改名：YFW_BRIDGE_PORT→PONOS_BRIDGE_PORT、`~/.yfworking/pet*.json/log`→`~/.ponos/`、YFW_HOME→PONOS_HOME dev 隔离）；only_pd=29 |
| **public/**（静态资源+内置技能） | 373 受控文件，无 only_cg。 | 381 受控文件。独有 8：`sample-skills/_common/ocr_pipeline.py` + `shadow-theme/` 7 图。 | 双向演进（320 相同；分叉 53 全为品牌图标/占位符改名；pd 独有 shadow-theme 少量增强） | **S3 迁入来源=旧线主体**（cg public/ 373 文件：图标+内置技能属在售资源）；40 个分叉 SKILL.md 归一化品牌词后仅剩品牌别名/`~/.yfworking`→`~/.yfw` 目录表述差异→净室库以旧线文本为基准仅记录；pd 独有 shadow-theme/ocr_pipeline.py 仅记录 | 同名 373：相同 320/分叉 53（图标 9：icon-{16,32,48,64,128,256}.png/icon.png/icon.ico/logo.png；`sample-skills/_common` 4 脚本；`sample-skills/*/SKILL.md` 40）；分叉 SKILL.md 归一化（PONOS/Ponos/ponos→YFW 系）后 18 个仍差，抽样 example-skill/yfwx-kexiao 剩余差异=品牌别名（"YFWorking 会提示"↔"YFW 会提示"）与技能安装目录 `C:/Users/T203-15/.yfworking/skills`↔`C:/Users/T203-15/.yfw/skills`；only_pd=8 |
| **docs/** | 65 受控文件。独有 2：`docs/manual/YFWorking产品使用说明书.md/.pdf`（在售产品手册）。 | 117 受控文件。独有 54：Ponos产品使用说明书.md/.pdf、architecture.md、bridge-contract.md、kernel-config.md、ponos/*、production/*、superpowers/plans+specs 2026-08-20 之后全部（ponos-turbo/kernel-*/modular-platform/yfljsj-cli/cockpit/frontend-upgrade/neon/holographic 等）。 | 双向演进（共享 08-19 前 superpowers 文档集后分叉；08-20 起 pd 走 ponos/v3/内核文档线） | **S3 迁入来源=旧线主体**（cg docs/：在售产品手册 `YFWorking产品使用说明书.*` + 共享 docs/manual/images 截图 25 张；superpowers 开发计划类仅记录）；pd 独有 54 项（Ponos 品牌/v3/内核文档）排除不迁 | 同名 63：相同 28（docs/manual/images/*.png 25 张产品截图 + logo_新远方数据LOGO*.png 2 + 共享 plan/spec 2：2026-08-16-theme-accent-red 系、2026-08-17-file-preview-edit-design），分叉 35（docs/superpowers/plans/specs 2026-08-10~08-19 系列两线各自演化）；only_cg=2、only_pd=54 |
| **根配置（package.json 等 10 项同名）** | name=`yfworking-gui` v2.6.0。 | name=`ponos-gui` v2.7.0。 | 双向演进（品牌+工具链分叉） | **S3 迁入来源=旧线主体**（cg 根配置为准：package.json 的 name/scripts/deps、vite.config.ts、tailwind.config.ts、index.html、electron-builder.yml）；pd 独有包管理/构建配置仅记录 | `diff -q` 逐项：DIFFER=package.json/package-lock.json/vite.config.ts/tailwind.config.ts/index.html/electron-builder.yml（index.html title `YFWorking`↔`Ponos dev`；package.json name/version 见上）；IDENTICAL=tsconfig.json/tsconfig.node.json/postcss.config.js/skills-lock.json |
| **根配置（单侧独有文件）** | cg 独有：bun.lock、start.bat、diag-yfw.bat、.gitignore。 | pd 独有：pnpm-lock.yaml、pnpm-workspace.yaml、vite.modules.config.ts、version.mjs、lefthook.yml、README.md、AGENTS.md、MIGRATION-NOTES.md。 | 混合：cg 启动/诊断入口仅旧线；pd 包管理与 v3/CI 工具仅增强线 | **S3 迁入来源=旧线主体**（start.bat/diag-yfw.bat/bun.lock/.gitignore 属在售启动与诊断入口）；pd 独有 pnpm/vite.modules/lefthook/version.mjs 仅记录（v3/开发工具）；README/AGENTS/MIGRATION-NOTES 为 pd 库文档不迁 | 两库 HEAD 快照顶层清单（上文列名）；git ls-files 两库顶层计数对照 |
| **yfw-kernel/**（cg 独有，2490 文件） | 旧派生内核（Anthropic claude-code fork）：顶层 `claude-code/`（docker/grafana/helm/mcp-server/web/drizzle/vercel.json/renovate.json/biome.json，官方仓库同源）+ `skills/`。在售产品**运行依赖**此树构建产物。 | 无此目录（内核由自身 `kernel/` 全新实现替代）。 | 仅旧线 | **排除不迁**（内核本体不迁入净室库）。在售依赖路径须记录并改接 pd `kernel/`（S2 已修复状态）：`server/bridge.mjs:526,649`（kernel 指向 `yfw-kernel/claude-code/dist/cli.mjs`）、`electron-builder.yml:77-80`（`from: yfw-kernel/claude-code/dist`）、`scripts/package-portable.cjs:127,137`、`scripts/verify-permission-flow.mjs:15`、`server/transcript.mjs:3`、`src/lib/transcriptAdapter.ts:3`、`.gitignore:32` | cg `git ls-files` 顶层计数 yfw-kernel=2490；HEAD 快照 `ls yfw-kernel`=`claude-code/`+`skills/`；`ls yfw-kernel/claude-code` 见 Dockerfile/helm/grafana/mcp-server/web/vercel.json/renovate.json；产品引用行见左列 file:line |
| **kernel/**（pd 独有受控，33 文件） | 无此目录（旧内核在 cg 是 yfw-kernel/）。 | 全新精简内核实现，扁平结构：engine.mjs/api.mjs/compact.mjs/config.mjs/context.mjs/cost.mjs/graph.mjs/health.mjs/highrisk.mjs/hooks.mjs/memory.mjs/permissions.mjs/prompt.mjs/protocol.mjs/provider.mjs/redact.mjs/session.mjs/skills.mjs/tools.mjs/tui.mjs/workflow.mjs/package.json 等。 | 仅增强线 | 内核增强线主体。对净室库影响 = **S3 迁入来源（内核侧，随 S2 已修复状态迁入）**；本 S1 不做内核自身 diff（Global Constraints：内核侧内容不属于 S1 差异主体） | pd HEAD 快照 `ls kernel/`=33 项扁平清单（上列）；pd `git ls-files` kernel=33 |
| **pd v3 平台/开发工具目录（modules/harness/yfljsj-cli/external-sdk/benchmark/zz-smoke/user-data）** | 均不存在于 cg。 | modules=119、harness=38、yfljsj-cli=18、external-sdk=8、benchmark=73、zz-smoke=8、user-data=5（git ls-files 计数）。 | 仅增强线 | **排除不迁或仅记录**（v3 平台/工具，不做功能盘点；正式名单进清单③排除边界） | pd `git ls-files` 顶层计数：modules 119/harness 38/yfljsj-cli 18/external-sdk 8/benchmark 73/zz-smoke 8/user-data 5；两库 HEAD 快照顶层清单对照（cg 无同名目录） |
| **未受控运行产物/临时文件（两库各自 on-disk，非 git 跟踪）** | dist/release/runtime/node_modules + node.exe；根下临时 crash 文件 `UsersT203-15AppDataLocalTemplogtee-crash-*`/`probe-*`、`e2e-entry5.ts`（未跟踪）。 | dist/release/runtime/kernel-dist/logo/node_modules；benchmark-*.log、screen-*.png（未跟踪）。 | —（非受控产物，两库各自） | **排除不迁**（构建产物/运行时/本地临时物均不进净室库） | 两库工作树 `ls -1` 顶层清单 vs `git ls-files` 计数对照（dist/release/runtime/kernel-dist/logo/node_modules 不出现在受控清单） |
| **.claude/ + .agents/**（cg 独有受控） | .claude=159、.agents=158 受控文件（Agent 开发工具配置/技能缓存类）。 | 无（pd 用根级 AGENTS.md/lefthook.yml）。 | 仅旧线 | **仅记录**（非产品运行面，S3 是否迁入由控制器/清单③判定） | cg HEAD `find .claude/.agents -type f`=159/158；两库 HEAD 顶层对照 pd 无同名 |
| **YF/**（cg 独有受控） | 品牌素材/源文件目录：logo 源文件（新远方数据LOGO.pdf/横版.pdf、远方数据源文件.ai/.psd/.png/.jpg、研发智能体.png、纯logo-改白色.ai 等）+ `jiajia/`、`jiajia-pixel-pet/` 素材。共 48 受控文件。 | 无同名目录（pd 品牌素材散落未受控 `logo/`）。 | 仅旧线 | **仅记录**（品牌资产归档，非运行时代码；是否迁入由控制器判定） | cg HEAD `ls YF/`（上列文件）；`find YF -type f`=48；两库顶层对照 |
| **bin/**（CLI 入口） | cli.mjs + yfworking.cmd（2 受控）。 | cli.mjs + ponos.cmd（2 受控）。 | 双向演进（同名 cli.mjs 分叉轻微，命令入口按品牌各命名） | **S3 迁入来源=旧线主体**（cg bin/：cli.mjs + yfworking.cmd） | 同名 1（cli.mjs）分叉仅 2 行：`:10` 环境变量 `YFW_BRIDGE_PORT`(默认 51309)↔`PONOS_BRIDGE_PORT`(默认 51311)；`:85` banner `YFWorking GUI`↔`Ponos GUI`（diff 全量 2 行）；only_cg=yfworking.cmd、only_pd=ponos.cmd |
| **build/**（安装包/品牌图构建） | 6 受控文件（installer.nsh、make_installer_art.py 等）。 | 7 受控文件（+make_ponos_icon.py）。 | 双向演进（同名 2/6 分叉） | **S3 迁入来源=旧线主体**（cg build/ 6 文件）；pd 独有 make_ponos_icon.py（Ponos 图标脚本）不迁 | 同名 6：相同 4/分叉 2（installer.nsh、make_installer_art.py）；only_pd=1（make_ponos_icon.py） |
| **scripts/**（构建/校验脚本） | 16 受控文件（build-installer.mjs、build_manual_pdf.py、package-portable.cjs、verify-*.mjs、sync-builtin-skills.mjs、aggregate-skill-triggers.mjs、gen-icons.ps1 等）。 | 21 受控文件（+build-kernel.mjs、build-modules.mjs、bump-version.mjs、install-kernel.ps1/.sh）。 | 双向演进（同名 11/16 分叉） | **S3 迁入来源=旧线主体**（cg scripts/ 16 文件）；pd 独有 5 项全为内核/v3 构建工具（build-kernel/build-modules/install-kernel/bump-version）→ 排除不迁或随内核线仅记录 | 同名 16：相同 5/分叉 11（build-installer.mjs、build_manual_pdf.py、gen-icons.ps1、package-portable.cjs、verify-*.mjs、sync-builtin-skills.mjs、aggregate-skill-triggers.mjs、annotate-skill-parent.mjs 等）；only_pd=5（见左列） |

### 逐目录"对净室库影响"汇总判定

- **在售功能主体（S3 必须迁入，来源=claude-code-gui 旧线主体）**：`src/`、`server/`、`electron/`、`pet/`、`public/`、`docs/`（在售手册+共享截图）、`bin/`、`build/`、`scripts/`、根配置（package.json 等 + start.bat/diag-yfw.bat/bun.lock/.gitignore）。共 cg 侧受控 83+23+11+25+373+65+2+6+16+2 ≈ 606 个产品面文件。
- **S3 迁入来源（内核侧，随 S2）**：ponos-dev `kernel/`（33 文件，不做内核 diff）。
- **排除不迁**：cg `yfw-kernel/`（2490 文件，旧派生内核本体；产品依赖点见上表待改接）、两库未受控运行产物、pd v3 平台目录（modules/harness/yfljsj-cli/external-sdk/benchmark/zz-smoke/user-data，正式名单进清单③）。
- **仅记录不改**：pd 独有产品目录内增量（src 38 项、server 68 测试、electron 13 项、pet dafeiyu-pet、public 8 项、docs 54 项）——2026-09 协议增强候选是否移植由清单②/S5 判定；`.claude/`、`.agents/`、`YF/` 等非运行面目录。

---

## 清单② 协议增强候选（Task 2 追加）

只读盘点范围：ponos-dev（@ 030f0a2）`server/`、`electron/`、`src/`（+scripts/ 技能回归）与 claude-code-gui（@ 6ba18ec）同名对照；不深入 `kernel/` 与 v3 平台目录。判据已落实：内核侧实现一律标「内核侧已随 kernel/ 整体迁入（S3 内核迁入来源）、不重复移植」；只有真正 server/GUI 侧新接线/新 UI 才进入「整项移植/部分」候选。实现落于 v3 平台（modules/harness）或多窗口 v3 UI 的仅记录/排除（正式排除名单归清单③）。

### 2026-09 提交归类（路径过滤 `-- server electron src`，pd 共 19 条命中；GUI 主体改动多在 modules/ 侧，仅 src 4 条、electron 1 条直接命中产品目录）

- **内核守护族**：d0bc5e2 / 7d32099 / 5aca7e9 / 0817e8d / 126d7b6 / 7121800 / 3e87f01 / 882464c / 4a6e594 / 1b350c5 / 94c1bdb / 77f337b / bf28829 / 030f0a2（审计 #1-#11 收尾；大多顺带改 server/*.test.mjs 集合同步测试）→ S3 内核侧
- **压缩/健康可见化**：26bd8de（「正在压缩上下文」指示条，实现在 modules/shared，不进产品目录）、0817e8d（compact/context 内核侧）
- **bridge/连接**：ca800a8（bridge 回 pong）、da7c1e3（GUI 应用层心跳）、ade601c+659d2b1（bridge 端口运行时探测 dev/prod）、5985d0f（审批/提问原生窗口数据通道+LinkRegistry）
- **provider/effort**：7a16f96（authScheme）、4301688（provider 配置面板，实现在 modules/settings + harness）
- **v3 模块/窗口平台**：p1-p6 系列（RPC/窗口/模块/agent-core，落 harness/modules 与 src/module 窗口）+ 91eb7f0（src 窗口联动渲染体系）

### 候选表

| 候选名 | 定位（pd 文件:行/提交） | 变更性质 | 影响面 | 依赖（S1 清单/前置子工程） | 移植建议 | 证据 |
|---|---|---|---|---|---|---|
| ②-01 审批门接线（工作流审批门/工具权限门） | kernel engine.mjs:386-396,951-990（gateToolUse/can_use_tool 挂起+审批超时 L0-a）、workflow.mjs:534,660-670,787,812-816（confirm 节点/内嵌工具审批门）=提交 0817e8d；pd server 仅测试 workflow-gate.test.mjs / engine-approval-timeout.test.mjs；GUI 侧 electron/approval-center.cjs:1-14、src/stores/dockStore.ts:5-12、src/components/module/windows/ApprovalModule.tsx（5985d0f 起） | 内核侧（审批门判定/挂起/超时，随 S3 迁入）+ GUI 侧（审批独立窗/dock 气泡=v3 窗口平台） | 高危 Bash/工具与 Workflow 内嵌工具审批闭环；净室 GUI 审批基座（PermissionDialog + approval↔approval-response）已同协议 | 内核 S3（审批门/超时语义）；GUI 无前置 | 内核不重复移植；bridge 审批路由 cg/pd 同构无需改；GUI 窗口化附加不移植（v3） | cg bridge.mjs:896,1087-1115,2189-2217 ↔ pd bridge.mjs:979,1178-1206,2423-2451 同构；cg src/components/permissions/PermissionDialog.tsx + AppShell.tsx:398；pd approval-center.cjs 头注（队列去重/原生数据通道） |
| ②-02 压缩可见化（「正在压缩上下文…」指示条） | modules/shared/src/chat/session.ts:134-148 + ChatPane.tsx（提交 26bd8de, 2026-09-07）；事件源 kernel/compact.mjs:350,374,427（wire.system('compaction', state:start/done)） | GUI 侧（pd 实现在 v3 modules/shared，仅参照不可整拷）；内核事件源已随 S3 | 长压缩（2m+）静默期给用户「压缩整理中」指示，防误判失速/焦虑 | 内核 system/compaction 事件（S3，经 bridge 普通 event 透传） | 部分移植：在净室 ChatWindow/chatStore 按其事件态渲染指示条（v3 实现为参照） | cg 仅 CompressedToast.tsx（压缩完成 toast，无进行中态），cg useYFWCLI 无 compaction 分支；pd session.ts 26bd8de diff（compacting 瞬态字段+reduceTurn 归约） |
| ②-03 技能清单去重（P8 双路注入收敛） | server/bridge.mjs:989-990,1013-1014（P8：宿主不再 appendSkillList，技能由内核从 --add-dir 技能根注入）、918-931 appendSkillList 保留导出 | server 侧 | 新会话/resume 系统提示中技能清单唯一性与体积（双注入=技能重复条目/超长 prompt） | 内核 S3（cli.mjs composeSystemPrompt 技能块）；S1 清单 server/bridge.mjs 分叉项 | 整项移植（净室 bridge 接 pd kernel 后必须停宿主注入，否则技能双份） | cg bridge.mjs:858,881-882 仍 appendSkillList（new/resume 双路径）↔ pd bridge.mjs:1013-1014 停用；pd scripts 保留 verify-skill-listing 回归 |
| ②-04 浏览器桥接迭代（browser executor 快照增强） | electron/browser-executor.cjs:114-132,146-170（SEL 扩 dropdown/浮层 + isInsideOverlay + option role）、612（download-listener 分区去重）；基线 10c07f7（2026-08-19 净室初始化）起 pd 独有 | GUI/electron 侧（主进程浏览器自动化注入脚本） | 内置浏览器自动化快照的可点/可读性（下拉/悬浮层选项），影响 web 工具成功率 | 无（electron 壳内自足）；server/browser-routing.mjs 与 browser-common.cjs 两线一致 | 部分可选移植（几十行差量可直接并入净室 electron/browser-executor.cjs，独立于内核） | cg/pd browser-executor.cjs diff（cg 无 isInsideOverlay/select-option 扩展）；Task1 同名 server/browser-routing 相同 |
| ②-05 守卫自愈接线（失速/循环状态可见化） | 内核守卫族提交 d0bc5e2/7d32099/5aca7e9/0817e8d/audit#1-#11（engine.mjs）；GUI 侧 KernelStallBar.tsx:1-60、LoopStatusBar.tsx:1-45、挂载 ChatWindow.tsx:223-225、数据 uiStore.ts:105-110（kernelStalls）/chatStore.ts:360,1175-1185（loopStates）/usePonosCLI.ts:613-616,638-652 | 内核侧（守卫/自愈逻辑，随 S3 迁入）+ GUI 侧（两状态条接线） | 内核静默（≥阈值）失速提示、守卫自愈/loop 轮次对用户可见；cg 现丢弃 kernel-stall、无 loop 渲染 | KernelStallBar←bridge kernel-stall（cg server/bridge.mjs:2059 已发，无需改 server）；LoopStatusBar←内核 loop 事件（S3） | 部分移植：KernelStallBar 组件+uiStore 字段+hook 分支可独立先行；LoopStatusBar 依赖 S3 loop 事件 | cg src 全树 grep 无 kernel-stall/loopStates 消费（仅 bridge 发事件）；pd 文件/行如上 |
| ②-06 CJK 上下文估算接线 | 内核 0817e8d context.mjs/engine.mjs（CJK ~1 字/token、窗口真实化）；产品目录内仅痕迹 pd server/context.test.mjs:34-46 | 内核侧（已随 kernel/ 迁入）；无 server/GUI 新接线 | 中文会话上下文预算（pre-step 压缩阈值/触发由内核内部计算）；GUI 消费的 health 字段不变 | 内核 S3 | 不重复移植（随 S3 内核迁入）；GUI 无额外改动 | pd server/context.test.mjs:34-46（countCjk/estimateTokens 断言、CLAUDE_CODE_TOKEN_DENSITY_CJK env）；healthStore.ts cg/pd diff 仅品牌名 |
| ②-07 WS 半开连接 GUI 心跳 + bridge pong 应答 | server bridge.mjs:2311-2315（收 GUI ping→回 pong；ca800a8）；GUI usePonosCLI.ts:102-129（startHeartbeat 15s ping/60s 判死强重建；da7c1e3）、167-169（滤 pong） | server 侧（ping 应答分支）+ GUI 侧（应用层心跳判死） | TCP 半开（浏览器 send 假成功）致「agent 无响应且无提示」的自愈重连 | 无内核依赖；bridge 5 行 + GUI ~30 行 | 整项移植（低风险、连接健壮性直接收益） | pd bridge 事件类型集含 pong、cg 无；pd usePonosCLI 心跳块 vs cg useYFWCLI 无 |
| ②-08 推理 effort/Provider 切换协议（set_effort・authScheme・switch_provider） | server bridge.mjs:2369-2382（set_effort→control_request reasoning_effort）、519-535（switch_provider 注入空闲会话）；GUI usePonosCLI.ts:456-464（setEffort）；内核 7a16f96 provider.mjs authScheme（x-api-key/bearer）；配置面板 modules/settings（4301688,v3）+ src/components/settings/SettingsContent.tsx 仅 authScheme 字段 | 内核侧（provider 鉴权/切换处理，随 S3）+ server 侧（两类 control_request 透传分支）+ GUI 侧（面板主体在 v3） | 运行时切 provider/思考深度、本地 vLLM Bearer-only 端点支持 | 内核 S3（reasoning_effort/switch_provider/authScheme 语义）；provider 面板 v3 modules/settings（排除） | 部分移植：bridge 透传分支可随产品需要并入；设置面板主体不迁，产品 SettingsContent 可选补 authScheme 输入 | pd/cg bridge WS 事件类型差（pong/reasoning_effort/switch_provider 仅 pd）；usePonosCLI setEffort 导出 |
| ②-09 审批/提问独立原生窗 + 逻辑连线（electron 独有 13 项整体判定） | electron only_pd 13 项：approval-center/state-bus/dock-service/module-registry/window-manager/anchor-layout/link-overlay(.cjs/.html)/link-registry(+.test)（提交 5985d0f 及 p1-p6 系列）+ src/module/windows/*、hooks/useAnchorContext.ts、lib/moduleBridge.ts、stores/dockStore.ts/viewStore.ts | GUI/electron 侧（v3 多窗口模块平台） | 主窗口外独立模块窗（审批/提问/会话/文件）编排、窗口间连线/状态总线——依赖 modules/harness 生态 | v3 平台（modules/state-bus/window-manager 等排除不迁） | 不移植（v3 平台，归清单③排除边界；净室单窗口 GUI 沿用 PermissionDialog+主窗弹层） | Task1 only_pd electron 13 名单；5985d0f --stat（14 文件 +1550）；approval-center.cjs:1-14 头注 |

### 记录与排除说明（不另立行）

- **server 独有 68 项**全部为 `*.test.mjs` + mock-kernel.mjs（生产文件零独有，增量全在 12 个分叉同名文件内，其中最相关 bridge.mjs 差异已并入②-03/②-07/②-08）：作为内核语义固化测试**仅记录**，S3 内核迁入后按需并入测试集。
- **src 独有 38 项**中：②-05 两状态条为唯一判"部分移植"的产品 GUI 接线；boot/cockpit/charts/login/dock/module 窗口/layout-RightRail/stores(dockStore/viewStore/tokenStatsStore)+lib(moduleBridge/busPublish) 均 v3 驾驶舱/窗口 UI——仅记录、归清单③；hooks/usePonosCLI.ts 为 cg useYFWCLI 的品牌孪生（净室 GUI 落点，其相对 cg 的语义增量 = ②-02/⑤/⑦/⑧ 的 GUI 消费端 + turbo 内核 chunk 流块序号适配 2026-08-22）。
- **内核侧其它候选不重复移植**：工作流确认/审批门（②-01）、守卫自愈全套（②-05）、CJK 估算与窗口真实化（②-06）及 health chainDepth 窗口增量计数（882464c）等均为 kernel/ 内逻辑，随 S3 内核迁入；GUI 仅按既有 health/kernel-stall/loop/compaction 事件渲染，不涉及内核自身 diff。
- **cg 唯一独有 src/hooks/useYFWCLI.ts**：不在移植面；净室 GUI 迁 cg src 时改接 pd 内核事件语义即可（前述候选的 GUI 落点同一处）。

---

## 清单③ 残留引用点与 v3 排除边界（Task 3 追加）

### 只读范围、证据基线与判定基准

- grep 范围：两库产品代码（`src/server/electron/pet/build/scripts/bin/docs/` + 根配置），**排除** node_modules/dist/release/runtime/yfw-kernel 本体/kernel-dist/未受控 on-disk 物。patterns：`anthropic` `Anthropic` `claude` `Claude` `claude-code` `yfw-kernel` `/claude-code`（执行含 case-insensitive 联合与单 pattern 计数）。
- 证据基线：本清单命中为 **工作树 on-disk** grep（Task 1 行号以 HEAD 快照为准，工作树 bridge.mjs 等有在途修改故行号微移）；`electron/kernel-paths.cjs` 为 cg 未跟踪在途文件（`??`）。完整 grep 命令清单与计数见 `task-3-report.md`。
- 判定基准：**协议字段名**（ANTHROPIC_*/CLAUDE_*/anthropic-version/`/anthropic` 端点）/ **许可证文本** / **品牌词** = 允许，仅记录；**内核路径引用 / 派生内核 bootstrap 引用 / 需改写才干净** = 处置剔除或改写。
- yfw-kernel/（2490 tracked = claude-code/ 2484 + skills/ 6）本体内部残留**不逐文件盘点**：即 Anthropic claude-code 官方仓库同源树（含 LICENSE、@anthropic-ai/* 依赖、claude-code 品牌面），属 S3 整体排除对象 / S4 删分支对象，以本句记录，不入下方产品代码表。

### (a) 旧内核残留引用点表

| 文件:行 | 引用内容（摘录） | 所在库 | 性质 | 处置 |
|---|---|---|---|---|
| `server/bridge.mjs:529,699` | 注释「built from yfw-kernel/claude-code」；`ripgrepAvailable()` dev 候选 `join(__dirname,'..','yfw-kernel','claude-code','dist')` | cg | 派生内核路径引用 | 剔除/改接 → pd kernel/ 或 kernel-dist（S3，与 8 依赖点同批） |
| `electron/kernel-paths.cjs:38-40`（未跟踪/在途） | dev 候选 `{ kernel:<appRoot>/yfw-kernel/claude-code/dist/cli.mjs, bun:~/.bun/bin/bun.exe }` | cg | 派生内核路径引用 | S3 改接 pd kernel；文件未跟踪，净室以受控版为准 |
| `electron-builder.yml:77,80-86` | 注释「built from yfw-kernel/claude-code」；`from: yfw-kernel/claude-code/dist` → to kernel（filter cli.mjs+vendor/**） | cg | 打包路径（Task1 依赖点 77-80） | 改接 kernel-dist 产物（pd scripts/build-kernel.mjs 同机制） |
| `scripts/package-portable.cjs:127,137` | `kernelSrc/kernelVendorSrc=ROOT/yfw-kernel/claude-code/dist/{cli.mjs,vendor}` | cg | 便携包内核拷贝路径 | 改接 kernel-dist bundle |
| `scripts/verify-permission-flow.mjs:15` | `KERNEL=join(cwd,'yfw-kernel','claude-code','dist','cli.mjs')` | cg | 校验脚本内核路径 | 改接 kernel-dist |
| `.gitignore:32` | `yfw-kernel/claude-code/dist/*.map` | cg | 内核产物 ignore 条目 | S4 删分支后移除/随 S3 失效 |
| `server/transcript.mjs:3-4` | 注释「内核（yfw-kernel/claude-code，claude-code 官方同源）…transcript：CLAUDE_CONFIG_DIR ?? ~/.yfworking」 | cg | 派生内核说明注释 | S3 换源后注释改写（transcript 格式本身保留） |
| `src/lib/transcriptAdapter.ts:3,20,193`、`src/lib/transcriptAdapter.test.ts:105` | 注释「claude-code 会把 tool_result 作为 user 消息块回传」等 | cg | 派生内核行为/格式注释 | 保留（对 pd kernel transcript 同格式仍成立）或随 S3 注释改写，不阻断 |
| `bin/yfworking.cmd:5-6,11-12,25-26,35-55` | 「Wraps the Claude Code binary…Redirect Claude Code's config dir…`where claude.cmd`/`where claude` → `claude %*` / Claude Code CLI not found」 | cg | 包装 Claude Code 并兜底 spawn 库存 Claude（品牌+功能残留） | 改写：净室 launcher 直呼内核（YFWORKING_KERNEL），不依赖 PATH 上的 Claude Code |
| `start.bat:2,22` | `title Claude Code GUI`；注释「Start the bridge (Claude CLI WebSocket + file APIs)」 | cg | 品牌词残留（旧产品标题） | 改写（净室名） |
| `electron/main.cjs:5` | 架构注释「stdio──► claude CLI」 | cg | 品牌词（注释） | 改写 |
| `server/bridge.mjs:565-570` | last resort `where claude.cmd / claude / claude-code`，return `'claude.cmd'` | cg | 库存 Claude Code 兜底 spawn（dev 便利） | 剔除（净室不得回退库存 Claude Code） |
| `server/bridge.mjs:35,95` | 注释「presents itself as Claude」+ 系统提示「禁止声称自己是任何其他 AI 产品（包括但不限于 Claude、ChatGPT、Copilot、Gemini）…」 | cg | 品牌词（身份隔离守卫，属产品能力） | 保留 |
| `electron/main.cjs:1165`；`src/lib/agents.ts:65-205`（11 行） | 「严禁自称 Claude、Anthropic 或其他 AI 品牌。」 | cg | 品牌词（agent 系统提示守卫） | 保留 |
| `src/main.tsx:14-19,46` | localStorage 迁移 `claude-code-{settings,chat,ui-v2}` → `yfworking-*` | cg | 品牌词/旧数据键（升级路径） | 保留（净室仍读旧键做一次性迁移） |
| `server/bridge.mjs:117-119,628-629` | 「STRICTLY ISOLATED from Claude…never read ~/.claude」 | cg | 品牌词（隔离设计注释） | 保留（设计意图延续） |
| `server/bridge.mjs:445-451,647-648,654-664,669,680-688,907-908` | env 注入 `ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL/DEFAULT_*_MODEL` 与 `CLAUDE_CODE_*`（AUTO_COMPACT_WINDOW/AGENT_TRIGGERS/MAX_OUTPUT_TOKENS/USE_NATIVE_FILE_SEARCH/TOOL_RESULT_BUDGET/FULL_SKILL_LIST） | cg | 协议字段名（内核读取的 env 契约） | 保留（兼容面；改名属 S5 可选需 pd kernel 同步） |
| `server/bridge.mjs:222-223,227,238,260,284-285`；`src/stores/settingsStore.ts:59,76,82,94`；`src/components/settings/SettingsView.tsx:833` | anthropic 兼容端点（api.deepseek.com/anthropic、api.minimaxi.com/anthropic、`/anthropic/v1` 归一化、placeholder） | cg | 协议字段名/端点路径（Anthropic Messages 兼容 API） | 保留（第三方 provider 功能） |
| `server/bridge.mjs:1515,1537,1623` | `/v1/messages`、header `'anthropic-version': '2023-06-01'`、读 env.ANTHROPIC_MODEL | cg | 协议字段名 | 保留 |
| `server/bridge.mjs:1724-1725,1820-1823,1841,1896` | `SKILL.md/CLAUDE.md/AGENTS.md` 与 `format:'claude'/'codex'` 识别 | cg | 生态文件格式名（技能/指令文件兼容读取） | 保留（改名需 S5 且影响存量技能） |
| `server/bridge.mjs:628,635`；`scripts/verify-permission-flow.mjs:40`；`bin/yfworking.cmd:26`；`electron/browser-common.cjs:115`；`server/transcript.mjs:51` | `CLAUDE_CONFIG_DIR` 配置目录 env（重定向 YFW_HOME） | cg | 协议字段名 | 保留（pd kernel 仍在读，见 pd transcript.mjs:50-53） |
| `src/i18n/translations/en-US.ts:193`、`zh-CN.ts:199` | 「Anthropic-compatible API provider」/「Anthropic 兼容 API 供应商」 | cg | 品牌词（UI 文案） | 保留 |
| `scripts/sync-builtin-skills.mjs:4-37`、`sync-sample-skills.mjs:8` | 源 `~/.claude/skills` + `.claude/skills` 路径占位符重写 | cg | 路径/品牌词（内置技能同步源） | 记录；净室作者目录改名后改写 |
| `scripts/build_promo_pdf.py:17,183`、`build_manual_pdf.py:21`、`gen-icons.ps1:47` | 本机绝对路径 `C:\Users\T203-15\claude-code-gui`；「任意 Anthropic 兼容 API」宣传语 | cg | 品牌词+本机绝对路径 | 改写（参数化/相对化）；品牌语仅记录 |
| `skills-lock.json:41,91`、`bun.lock:6` | `"source":"anthropics/skills"`、`.claude/skills/…`、lockfile name `claude-code-gui` | cg | 品牌词（上游来源元数据/lockfile） | 记录（可再生） |
| `docs/manual/YFWorking产品使用说明书.md:42,163,506,593` | 「任意 Anthropic 兼容 API」「/anthropic 结尾（Anthropic 兼容接口）」 | cg | 品牌词（在售手册功能描述） | 保留（如实功能描述，非专有代码） |
| `docs/bridge-contract.md:51-57`（未跟踪/在途） | CLAUDE_CONFIG_DIR/CLAUDE_CODE_*/ANTHROPIC_* env 协议表 | cg | 协议字段名文档 | 保留 |
| `docs/superpowers/plans+specs` 2026-08 系列（29 文件 180 行） | claude/anthropic/yfw-kernel 开发计划语料与内核路径示例 | cg | 品牌词/路径（开发计划） | 仅记录（计划类不迁净室/迁入时清洗） |
| `server/bridge.mjs:586-588,604,620-621,776` | 注释「built from ponos-kernel/claude-code」；候选 `ponos-kernel/claude-code/dist/cli.mjs`（向后兼容 last resort，pd 无此目录=死路径） | pd | 派生内核路径残留 | 改写/剔除（指向 pd `kernel/` 源码或 `kernel-dist`；与 ②-03 改接同批） |
| `server/bridge.mjs:635-640` | `where claude.cmd/claude/claude-code` 兜底 | pd | 库存 Claude Code 兜底 | 剔除 |
| `scripts/package-portable.cjs:127,137` | kernelSrc 指向 `ROOT/ponos-kernel/claude-code/dist/cli.mjs`（pd 不存在；现行 packaging 走 kernel-dist） | pd | 死路径残留 | 改写（kernel-dist）或随脚本淘汰 |
| `scripts/verify-permission-flow.mjs:15` | `KERNEL=join(cwd,'ponos-kernel','claude-code','dist','cli.mjs')` | pd | 死路径残留 | 改写（kernel-dist） |
| `scripts/install-kernel.ps1:77`、`.sh:12,80` | `ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL` 提示 | pd | 协议字段名 | 保留 |
| `build_manual_pdf.py:21`、`gen-icons.ps1:47` | 本机绝对路径指向 `C:\Users\T203-15\claude-code-gui`（cg 仓库） | pd | 本机路径残留 | 改写（pd 自身路径/参数化） |
| `sync-builtin-skills.mjs:4-37` | 源 `~/.claude/skills` | pd | 同 cg | 记录 |
| `bin/ponos.cmd:5-55`（12 行） | 包装 Claude Code 兜底（结构同 cg，品牌 ponos） | pd | 品牌词+兜底 | 记录（pd 线 launcher；净室不采用） |
| `electron/main.cjs:5,1516`、`electron/browser-common.cjs:115`、`src/hooks/usePonosCLI.ts:482`、`src/main.tsx:15-20,37` | 架构注释 claude CLI、身份守卫、CLAUDE_CONFIG_DIR 兜底、迁移键 claude-code-*→ponos-* | pd | 品牌词/守卫/协议 | 记录（pd GUI 不在 S3 主体迁入，评估时按需） |
| `server/*.test.mjs` 30 文件 195 行（api-protocol.test.mjs:72-118,378-456、provider.test.mjs:6-42、context.test.mjs:34-46 等） | CLAUDE_CODE_*/ANTHROPIC_* 协议 env 断言（含 CLAUDE_CODE_TOKEN_DENSITY_CJK、CLAUDE_CODE_EFFORT_LEVEL） | pd | 协议字段名（内核语义固化测试） | 仅记录（S3 内核迁入后按需并入测试集，见清单② 记录说明） |
| `docs/` 46 文件 395 行 + 根文档（MIGRATION-NOTES.md:13,22,30-31、AGENTS.md:13,35、README.md:33、FREEZE-INVESTIGATION.md 7 行、skills-lock.json 2 行） | 品牌词/协议文档/计划语料；MIGRATION-NOTES 明示「ponos-kernel/claude-code = Anthropic 专有代码泄漏副本，净室工作区不携带」 | pd | 品牌词/文档 | 仅记录 |

### (b) yfw-kernel 泄漏副本引用点（cg 产品代码对 yfw-kernel 路径/其 dist 产物/claude-code 路径的全部引用）

Task 1 记录 8 处依赖点；本盘点在**产品代码（非 yfw-kernel 本体）**复核并补全，`yfw-kernel` 字面引用共 **13 行 / 9 文件**（含 1 个 Task 1 未记录的未跟踪文件），另加文档语料：

| # | 文件:行 | 引用 | S3 改接去向（pd kernel/ 对应路径或机制） |
|---|---|---|---|
| 1 | cg `server/bridge.mjs:529` | 注释「built from yfw-kernel/claude-code」 | 注释改写 |
| 2 | cg `server/bridge.mjs:699` | `ripgrepAvailable()` base `…/yfw-kernel/claude-code/dist`（dev） | → pd bridge 同款 base：`../kernel`（源码直跑）与 `../kernel-dist`（bundle，pd bridge.mjs:611-615） |
| 3 | cg `electron/kernel-paths.cjs:38-40`（**未跟踪/在途**） | dev 候选 `yfw-kernel/claude-code/dist/cli.mjs` + `~/.bun/bin/bun.exe` | → 候选改为 `<repo>/kernel/cli.mjs`（direct 源码）+ `<repo>/kernel-dist/cli.mjs`（bundle）；bun 路径沿用 runtime/bun |
| 4 | cg `electron-builder.yml:77,80` | `from: yfw-kernel/claude-code/dist` → to kernel（cli.mjs+vendor） | → `from: kernel-dist`（对应 pd electron-builder.yml files 段 kernel-dist/**/*） |
| 5 | cg `scripts/package-portable.cjs:127` | `kernelSrc=…/yfw-kernel/claude-code/dist/cli.mjs` | → `ROOT/kernel-dist/cli.mjs` |
| 6 | cg `scripts/package-portable.cjs:137` | `kernelVendorSrc=…/yfw-kernel/claude-code/dist/vendor` | → vendor 随内核构建产物提供或省略 |
| 7 | cg `scripts/verify-permission-flow.mjs:15` | `KERNEL=…/yfw-kernel/claude-code/dist/cli.mjs` | → kernel-dist/cli.mjs |
| 8 | cg `server/transcript.mjs:3` | 注释「内核（yfw-kernel/claude-code…）」 | 注释改写（pd 对应文本为「ponos-kernel/claude-code」同样待改） |
| 9 | cg `src/lib/transcriptAdapter.ts:3` | 同上注释 | 注释改写 |
| 10-11 | cg `.gitignore:32` | `yfw-kernel/claude-code/dist/*.map` | S4 删分支后条目失效移除 |
| 12-13 | cg `docs/` superpowers plans/specs 中 95 行/22 文件引用 yfw-kernel（示例 2026-08-13-health-monitor-design.md:133-135、2026-08-14-fullstack-perf-optimization-design.md:9,80） | 开发计划语料 | 仅记录（计划类不迁净室） |

> 结论：cg 产品运行面对 yfw-kernel dist 产物的**可执行引用点**（bridge spawn/kernel-paths 候选、electron-builder、package-portable、verify-permission-flow）= **5 个文件**，均属 Task 1 的 8 依赖点集合内的现行版本（新增：kernel-paths.cjs）。其余为注释/文档/ignore 类，随 S3/S4 改写即可。处置 = S3 统一改接 pd `kernel/`（源码直跑 dev）与 `kernel-dist/`（单文件 bundle，bootstrap 至 `~/.yfworking/runtime/kernel/cli.mjs`），并移除对库存 Claude Code（PATH `where claude.cmd`）的回退 spawn。

### (c) v3 排除边界文件集名单（目录级名单 + 排除理由）

| 项 | 规模/形态 | 排除理由 |
|---|---|---|
| pd `modules/` | 119 受控 | v3 模块化子包（settings/bridge/chat/shared…），与 v3 UI/多窗口平台绑定；净室单窗口主体不消费 |
| pd `harness/` | 38 受控 | 主进程框架（pd package.json `main: harness/src/main.cjs`）；净室沿用 cg electron/ 旧线壳 |
| pd `yfljsj-cli/` | 18 受控 | 专用 CLI 工具 |
| pd `external-sdk/` | 8 受控 | 外部 SDK 适配层 |
| pd `benchmark/` | 73 受控 | 内核/协议基准工具（benchmark-*.log on-disk 附属） |
| pd `zz-smoke/` | 8 受控 | 冒烟脚本（含 smoke-real-api 需 ANTHROPIC_* env，AGENTS.md:35） |
| pd `user-data/` | 5 受控 | 用户数据骨架样例 |
| pd 未受控（gitignored）：`kernel-dist/`（含 cli.mjs ~166KB bundle）、`dist/` `release/` `runtime/` `logo/` `node_modules/` `benchmark-*.log` `screen-*.png` | on-disk | 构建产物/运行时/二进制/临时物；kernel-dist 由 `kernel/`+`scripts/build-kernel.mjs` 重建，不属源码 |
| cg `yfw-kernel/` | 2490 受控（claude-code/ 2484 + skills/ 6） | 旧 Anthropic 派生内核本体，S3 整体排除、S4 删分支；在售依赖点见 (b) |
| cg 未受控（gitignored）：`dist/` `release/` `runtime/` `node_modules/` `node.exe`、根临时 `UsersT203-15AppDataLocalTemp…` crash/probe 目录、`e2e-entry5.ts`、`.salvage-work/` `.yfworking/` | on-disk | 构建产物/运行时/临时物，不进净室 |
| pd electron/src 独有 v3 窗口/模块项 | electron only_pd 13 项 + `src/module/windows/*`、`hooks/useAnchorContext.ts`、`lib/moduleBridge.ts`、`stores/dockStore.ts/viewStore.ts` | 清单② ②-09 判「不移植（v3 平台，归排除边界）」；净室沿用 PermissionDialog+主窗弹层 |
| pd 根 v3 构建/开发态：`pnpm-workspace.yaml` `vite.modules.config.ts` `lefthook.yml` `version.mjs` | 根配置 | v3 包管理/CI/版本工具，不随净室；净室沿用 cg 根配置（npm/bun + vite.config.ts） |

### 处置去向汇总

- **S3 剔除/改写（净室迁入时直接不拷贝或改写）**：cg yfw-kernel/（整体排除）；(a)/(b) 中全部内核路径与派生内核 bootstrap 引用（bridge.mjs:529,699、kernel-paths.cjs:38-40、electron-builder.yml:77-86、package-portable.cjs:127,137、verify-permission-flow.mjs:15、.gitignore:32、bin/yfworking.cmd 与 bridge.mjs:565-570 的库存 Claude Code 兜底 spawn、start.bat:2 旧标题、main.cjs:5 注释、机器绝对路径 4 处）→ 净室统一改接 pd `kernel/`/`kernel-dist` 路径机制；注释类随换源改写。
- **S4 删分支**：cg `yfw-kernel/` 目录本体（2490 文件）在售线解耦（(b) 引用全部改接完毕）后删除/移出在售分支。
- **保留（白名单，仅记录）**：协议字段名（ANTHROPIC_*/CLAUDE_* env、anthropic-version、`/anthropic` 端点归一化、CLAUDE_CONFIG_DIR）、生态格式名（CLAUDE.md/skill.md/AGENTS.md、format claude/codex）、许可证文本、品牌词（身份守卫「严禁自称 Claude/Anthropic」、UI「Anthropic 兼容 API」文案、产品手册描述、localStorage claude-code-* 旧键迁移、~/.claude/skills 同步源记录、docs/superpowers 计划语料、pd *.test.mjs 协议断言、MIGRATION-NOTES 等文档）。
