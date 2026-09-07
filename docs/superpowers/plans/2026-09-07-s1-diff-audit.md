# S1 差异盘点审计计划（只读先行，产出清单①②③）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) 或 executing-plans。本计划为**只读盘点**（不改动任何源码/仓库状态），每任务交付一份清单段落；任务门 = 清单产出完整性与证据可溯。步骤用 checkbox（`- [ ]`）跟踪。

**Goal:** 以只读方式盘点 claude-code-gui（在售 yfworking v2 产品线）与 ponos-dev（内核现行开发地 + 2026-09 协议增强）两线差异，产出三份清单：①GUI/server/electron 差异表、②需移植的协议增强候选（逐项标影响面/依赖/建议）、③旧内核/专有标识全部残留引用点 + v3 排除边界文件集——作为 S3（净室迁入排除）、S4（接线删分支）、S5（移植清单）的权威输入。

**Architecture:** 目录级 diff 聚焦"产品功能归属"（设计 §13：避免文件级深挖无底洞）→ 命中目录再文件级确认；grep 精确 pattern 扫残留；三清单统一表格模板，证据 = 文件:行 + 判定，全部写入 `docs/superpowers/audits/2026-09-07-s1-diff-audit.md`（新库、可入库）。

**Tech Stack:** 只读 shell（ls/git ls-files/git log）、Grep（ripgrep）、无源码改动。

## Global Constraints

- 仓库路径（实测存在）：旧产品线 `C:\Users\T203-15\claude-code-gui`；内核/增强线 `C:\Users\T203-15\ponos-dev`；净室目标库 `C:\Users\T203-15\yfworking`
- **只读纪律**：不修改两仓库任何文件、不 commit、不 checkout、不移动；仅把审计报告写入 yfworking（全新文件）
- 目录级优先：先 `ls`/`git ls-files` 顶层对照定位"产品功能归属"差异，禁止对整树做无差别逐文件 diff
- 内核侧内容（kernel/ 及其测试）不属于 S1 差异主体——S2 已单独推进；S1 只需记录 kernel 相关引用点（清单③），不做内核自身 diff
- ponos-dev 的 v3 平台内容（harness/modules/cockpit 等，实测目录名为准）只进清单③"排除边界"，不做功能盘点
- 清单文档模板（每清单必须含的列，见各 Task"产出"）；所有"影响面/建议/判定"必须有证据行号或路径，禁止无据判断

---

### Task 1: 产品面目录级差异盘点 → 清单①

**Files:**
- Create: `C:\Users\T203-15\yfworking\docs\superpowers\audits\2026-09-07-s1-diff-audit.md`（本任务创建文件与表头，后续 Task 追加）
- Run only（只读扫描）：claude-code-gui 与 ponos-dev 的 `src/`、`server/`、`electron/`、`pet/`、`build/`、`scripts/`、`bin/`、`public/`、`docs/` 及根配置（package.json、vite/ts/tailwind/postcss、index.html、skills-lock.json、electron-builder.yml）

**Interfaces:**
- Consumes: 无
- Produces: 清单①差异表（列：目录/文件 | claude-code-gui 侧要点 | ponos-dev 侧要点 | 差异性质[仅旧线/仅增强线/双向演进] | 对净室库影响 | 证据），标注哪些目录属于"在售功能"主体

- [ ] **Step 1: 顶层结构对照**

Run:
```bash
cd C:/Users/T203-15/claude-code-gui && ls -1 && echo ===GIT=== && git ls-files | sed 's#/.*##' | sort | uniq -c | sort -rn | head -30
cd C:/Users/T203-15/ponos-dev && ls -1 && echo ===GIT=== && git ls-files | sed 's#/.*##' | sort | uniq -c | sort -rn | head -30
```
记录两库顶层差异，标出 ponos-dev 的 v3 平台目录名单（harness/modules/cockpit 等，以实测 ls 为准，进清单③不盘点功能）。

- [ ] **Step 2: 产品功能归属逐目录对照**

对 Global Constraints 列出的产品目录逐一：两库同目录 `ls -1` 对照文件集；同名文件用 `diff -q` 或 `git diff --no-index --stat` 判定是否一致；ponos-dev 独有 / claude-code-gui 独有的目录项各列出。**目的**：建立"在售功能代码在旧线、2026-09 增强在增强线"的归属地图，不逐文件读内容。

- [ ] **Step 3: 汇总清单①**

把 Step 1/2 结果按模板填入审计文档"## 清单① 产品面差异表"。对每个差异目录给"对净室库影响"判定：S3 迁入来源（旧线主体/增强线补充）、或仅记录不改。

---

### Task 2: 协议增强候选盘点 → 清单②

**Files:**
- Modify: `C:\Users\T203-15\yfworking\docs\superpowers\audits\2026-09-07-s1-diff-audit.md`（追加清单②）
- Run only（只读）：ponos-dev 的 `server/`、`electron/`、`src/` 与 claude-code-gui 同目录 diff；git log 找 2026-09 增强提交

**Interfaces:**
- Consumes: Task 1 的归属地图
- Produces: 清单②协议增强候选表（列：候选名 | 定位（ponos-dev 文件:行/提交） | 变更性质[内核侧已随 kernel 迁入/server 侧/GUI 侧] | 影响面 | 依赖（S1 清单、前置子工程） | 移植建议[整项移植/部分/不移植] | 证据）；内置 2026-09 已知特性候选：审批门接线、压缩可见化（「正在压缩上下文…」指示条）、技能清单去重、浏览器桥接迭代、守卫自愈接线、CJK 上下文估算接线

- [ ] **Step 1: 定位 2026-09 增强提交与文件**

Run:
```bash
cd C:/Users/T203-15/ponos-dev && git log --oneline --since=2026-09-01 -- server electron src | head -40
```
把 2026-09-01 后 server/electron/src 的提交按主题归类；对 Global Constraints 已知特性候选，用 Grep 在 ponos-dev 定位实现文件与入口，记录文件:行。

- [ ] **Step 2: 与旧线 server/GUI 侧差异核对**

对每个候选：在 claude-code-gui 侧 Grep 同功能名/字段名，判定"旧线是否已有 / 缺接线 / 缺 UI"。**判据**：内核侧实现（engine/compact/health/api 等）一律标"内核侧已随 kernel/ 整体迁入，不重复移植"；仅 server/GUI 侧接线与 UI 进候选表。

- [ ] **Step 3: 汇总清单②**

按模板填入"## 清单② 协议增强候选"。每项必须含移植建议与影响面，标注是否依赖 S4（接线）或可独立。

---

### Task 3: 专有残留与排除边界盘点 → 清单③

**Files:**
- Modify: `C:\Users\T203-15\yfworking\docs\superpowers\audits\2026-09-07-s1-diff-audit.md`（追加清单③）
- Run only（只读 grep）：两仓库

**Interfaces:**
- Consumes: Task 1 的 v3 目录名单
- Produces: 清单③三节——(a) 旧内核残留引用点表（列：文件:行 | 引用内容 | 所在库 | 处置[剔除/改写/保留理由]）；(b) yfw-kernel 泄漏副本引用点；(c) v3 排除边界文件集（目录级名单 + 说明）

- [ ] **Step 1: 专有标识 grep**

在两仓库产品代码范围（src/server/electron/pet/build/scripts/bin/docs/根配置，**排除** node_modules/dist/release）Grep 专有标识，pattern 至少含：`anthropic`、`Anthropic`、`claude`、`Claude`、`claude-code`、`yfw-kernel`、`/claude-code`。每库记录命中清单（Grep 输出存审计文档证据节或单独附件文件，标注路径）。注意区分：协议字段名/许可证文本（允许，仅记录）vs 内核路径/派生内核 bootstrap 引用（处置=剔除）。

- [ ] **Step 2: v3 排除边界名单**

以 Task 1 实测的 ponos-dev 顶层目录为准，列出 v3 平台目录与"不进入净室库"的其它排除项（node_modules/release/dist/kernel-dist/.env/调试临时/运行时二进制），逐项注明排除理由。

- [ ] **Step 3: 汇总清单③**

填入"## 清单③ 残留与排除边界"。残留引用点处置列给出可执行去向（哪些待 S3 剔除、哪些待 S4 删分支、哪些保留），供后续计划直接引用。

---

### Task 4: 审计报告自检与入库

**Files:**
- Modify: `C:\Users\T203-15\yfworking\docs\superpowers\audits\2026-09-07-s1-diff-audit.md`（首部补摘要与三清单索引）

**Interfaces:**
- Consumes: Task 1/2/3 清单
- Produces: 最终审计报告（含：范围与方法、仓库状态快照（git rev-parse HEAD 两库）、三清单、开放项/证据缺口）

- [ ] **Step 1: 自检**

逐清单检查：每个"判定/建议"行是否带证据（文件:行或路径或命令输出）；有无把内核侧 diff 误当产品差异；v3 目录是否只出现在清单③。发现缺证据的行补查或删判定。

- [ ] **Step 2: 提交审计报告**

Run:
```bash
cd C:/Users/T203-15/yfworking && git add docs/superpowers/audits/2026-09-07-s1-diff-audit.md && git commit -m "docs(audit): S1 差异盘点清单①产品面 ②协议增强候选 ③残留与排除边界"
```

---

## 执行记录（S1，2026-09-07 完成）

- **两库 HEAD**：claude-code-gui `6ba18ecfd8d6e982797f0dde7b950b8fecfb45a1`；ponos-dev `030f0a2251430baeda321e8ccfdb41249e8341c4`（含 P1-11 在途批 dirty，只读不受影响）。全程只读：两库零修改；仅 yfworking 新增审计文档。
- **产出**：`docs/superpowers/audits/2026-09-07-s1-diff-audit.md`（179 行，清单三件套 + 处置去向汇总）。
  - 清单①（17 行差异表 + 汇总判定）：产品功能主体全部在旧线 cg（src/server/electron/pet/public/docs 手册/根配置 ≈606 产品文件），S3 迁入来源 = 旧线主体 + pd kernel/（33 文件，内核侧随 S2）；cg yfw-kernel/（2490 文件旧派生内核）排除不迁（8 依赖点）；同源分叉（08-19 前共享历史），分叉多品牌重命名 + pd 测试/v3 增量。
  - 清单②（9 项候选）：整项移植 2（②-03 技能清单去重 P8、②-07 WS 心跳+pong）、部分移植 4（②-02 压缩可见化、②-04 browser-executor 增强、②-05 守卫自愈 GUI 接线、②-08 effort/provider 透传）、不移植/排除 2（②-01 审批窗 v3、②-09 v3 多窗口平台）、纯内核随迁 1（②-06 CJK 估算）。
  - 清单③：(a) 残留引用点 39 行（内核路径/派生内核 bootstrap → S3 改接 pd kernel/kernel-dist；协议 env/生态格式/身份守卫品牌词/文档语料 → 白名单保留）；(b) yfw-kernel 泄漏副本字面引用 13 行/9 文件（Task 1 8 依赖点复核 + 补全 kernel-paths.cjs；cg 可执行引用 5 文件）；(c) v3 排除边界 12 项（pd modules/harness/yfljsj-cli/external-sdk/benchmark/zz-smoke/user-data + 未受控产物 + cg yfw-kernel/ + v3 窗口项）。
- **决策性开放项（移交 S3 计划/用户）**：
  1. cg 工作树存在未提交在途修改与未跟踪文件（src/electron/server/docs 20+、docs/bridge-contract.md、docs/prototypes/、e2e-entry5.ts、YF/jiajia-pixel-pet/*、electron/kernel-paths.cjs）——S3 迁入以 HEAD 快照为源，是否并入在途工作需先裁决。
  2. pd 自身残留 ponos-kernel/claude-code 死路径（bridge.mjs:586-621,776、package-portable.cjs:127,137、verify-permission-flow.mjs:15）待改写；两库"库存 Claude Code 兜底 spawn"（where claude.cmd）净室剔除；两库脚本本机绝对路径 C:\Users\T203-15\claude-code-gui 待参数化。
  3. public 40 个分叉 SKILL.md 归一化品牌词后 18 个仍差（品牌别名 + ~/.yfworking↔~/.yfw skills 目录）——净室以旧线文本为基准。
  4. ②-07/⑧ bridge.mjs 大分叉（2279 vs 2571 行）：S3 迁 cg 主体后按语义 diff 选择性并入，勿整体覆盖丢失 cg 产品特化（askuser/browser-routing 接线）。
  5. ②-04 browser-executor 基线 2026-08-19 非 09 新增 → 降 S5 可选；yfw-kernel 本体 2490 文件残留概括记录（Anthropic claude-code 官方同源），S4 删分支对象。
