# S3 净室库落成（产品迁入 + 内核迁入 + 四步流水线对齐）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `C:\Users\T203-15\yfworking` 净室库上，从 claude-code-gui 工作树（在售 v2.7.5 全量形态）迁入自研产品代码/根配置/docs，从 ponos-dev HEAD `1696286`（P1-11 已落地）迁入内核源码与测试，使 `npm ci → typecheck → vite build → npm test` 对齐旧库基线，内核测试 8 套件 50 用例全绿，为 S4 内核接线交付"源码直跑 dev"形态的净室库。

**Architecture:** 迁移 = 纯文件拷贝（cp，非 git 操作），在 yfworking 既有的全新 git 历史（docs/superpowers 净室原生 8 文件（7 + 本 S3 计划文档） + .gitignore）之上逐任务增量提交。产品侧迁入"工作树 on-disk"内容（保留在途 v2.7.5 改动），排除旧内核 yfw-kernel/ 与全部非运行面目录；内核侧迁入 kernel/ 33 文件 + 根 version.mjs + 8 个内核测试套件（放 `kernel-tests/`，相对 import `../kernel/` 天然指向根 kernel/，无需改路径）。S3 不触碰内核路径引用改接（bridge/kernel-paths 等残留指向旧内核属 S4 接线范围，本计划只记录现状基线）。

**Tech Stack:** node v24（node:test 内建）、npm 11、vite 5、typescript 5.7、electron 43（不打包）；内核零 npm 依赖多文件 ESM。

---

## Global Constraints（任务隐含遵守，逐字生效）

1. **拷贝不移动、全新 git 历史**：仅 cp 内容**进** yfworking；对 claude-code-gui / ponos-dev 不做任何写/删/移动/checkout/apply/push。净室 git 历史 = 既有 docs 提交 + 本计划各 Task 的 commit 组成。禁止任何形式从两源库引入 git 对象（cherry-pick/merge/archive 解包均不得用于形成净室文件内容）。
2. **迁移源 = on-disk 工作树内容**（cg v2.7.5 在售形态 / pd HEAD 1696286），**不是** git archive HEAD。路径清单用 `git -c core.quotepath=false ls-files <路径>` 生成（CJK 文件名才不被引号包住），再逐文件 `cp -p`。cg 的 26 受控在途修改 + A/B 类未跟踪文件必须在拷贝中体现（受控文件在源盘上已是新内容，直接 cp 即含；未跟踪 A/B 另列显式清单）。
3. **排除集**（权威 = S1 清单③ 与 cg-inflight-adjudication 分类；Task 5 验证不存在性）：
   - cg：`yfw-kernel/`（2490 受控 + vendor/ 等未跟踪 = D 类整体排除）、`.claude/`、`.agents/`、`YF/`、`docs/superpowers/`（38 受控）、`FREEZE-INVESTIGATION.md`（本机卡死调查线索，机器路径/非产品面，裁决排除）、一切未受控杂物（node_modules/dist/release/runtime/.salvage-work/.yfworking/e2e-entry5.ts/docs/manual/_build/docs/prototypes/YF/jiajia-pixel-pet/make_dafeiyu_pixel_anims.py——后两项 C 类排除）。
   - pd：v3 平台目录（modules/harness/yfljsj-cli/external-sdk/benchmark/zz-smoke/user-data）、`kernel-dist/`、根 v3 工具（pnpm-workspace/vite.modules.config/lefthook.yml）、测试只迁 Task 4 点名的 8 套件（**不**全量迁 server/*.test.mjs）。
   - yfworking 净室原生 `docs/superpowers/`（audits/plans/specs 8 文件（7 + 本 S3 计划文档））与 `.gitignore` **保留原样不被覆盖**；cg 同名目录（docs/superpowers、.gitignore）不得拷入。
4. **内核构建决策**（预研④落地）：S3 **不引入** bun 构建，不迁 `scripts/build-kernel.mjs` 与 `kernel-dist/` 产物；只迁 kernel/ 源码 + 根 version.mjs（源码直跑 dev 链路 = bridge direct 语义）。构建/打包链（electron-builder.yml 指向 kernel-dist 等）归 S4。
5. **残留引用保持原样 + 记录，不改接**：bridge.mjs / kernel-paths.cjs / electron-builder.yml / package-portable.cjs / verify-permission-flow.mjs / bin/yfworking.cmd / start.bat / main.cjs 注释中的旧内核路径与 Claude Code 兜底，S3 **原样拷贝不做任何改接**（改接是 S4 工作）；Task 5 产出"残留现状基线"清单作为 S4 backlog。仅 S1 清单③ 判「仅记录/保留」的协议字段名/品牌词同样不动。
6. **版本**：package.json 2.7.5 为准（含 package-lock 2.7.5 同版拷贝，npm ci 确定性）；手册内 V2.7.2·2026-08-20 不一致、installer.nsh 技能数 65→85 校准，**只记录**（归 S6 出包统一）。
7. **npm test 环境性失败是预期**：同机同用户跑，`browser-executor.test.mjs` isBlockedUrl 用例受 `~/.yfworking/browser-whitelist.json`（含 example.com）污染失败、`transcript.test.mjs` mtime flaky 可能失败——与旧库基线 130/128/2 对齐即达标。**禁止修改测试或代码去掩盖**；只做归因记录 + 单文件 YFW_HOME 隔离演示证明环境根因。
8. **提交纪律**：每 Task 一个 scoped commit，`git add <明确路径列表>`（禁止 `git add -A`/`git add .` 全库，防把 .superpowers 工作区或遗漏杂物卷入）；提交前 `git status --short` 检查无意外 untracked；提交后 `git show --stat` 自证。

---

### Task 1: 产品代码迁入（根配置 + src/server/electron/pet/public/build/scripts/bin）

**Files:**
- Copy（源 cg on-disk → 目标 yfworking，全部 `cp -p` 保内容）：根 14 文件 `BUILD.md bun.lock diag-yfw.bat electron-builder.yml index.html package-lock.json package.json postcss.config.js skills-lock.json start.bat tailwind.config.ts tsconfig.json tsconfig.node.json vite.config.ts`
- Copy：`src/` 83、`server/` 23、`electron/` 11、`pet/` 25、`public/` 373、`build/` 6、`scripts/` 16、`bin/` 2（各自 `git ls-files <dir>` 全量，on-disk 内容）
- Copy（未跟踪在途，显式补入）：`electron/kernel-paths.cjs`（B 类，**必须**——bridge/main/diag-monitor import 它，缺则 npm test Module not found）、`scripts/build_promo_pdf.py`（A 类，裁决随迁；logo 依赖 `docs/manual/images/logo_新远方数据LOGO横版.png` 是 tracked 资产、随 Task 2 迁入后依赖闭合）
- Modify（合并，非覆盖）：`C:\Users\T203-15\yfworking\.gitignore`（净室原生 .gitignore 保留 + 增补 cg 条目，见 Step 1）
- 排除（不拷）：`.gitignore`（cg 版）、`FREEZE-INVESTIGATION.md`、`yfw-kernel/`、`.claude/`、`.agents/`、`YF/`、`docs/superpowers/`、全部未受控杂物

**Interfaces:**
- Consumes: cg 工作树（HEAD 6ba18ec + 26 受控在途 + A/B 未跟踪）；排除边界来自 S1 清单③ + cg-inflight-adjudication。
- Produces: 净室产品代码树（yfworking/src、server、electron、pet、public、build、scripts、bin 及根 14 配置）——Task 3 流水线对齐的直接输入；`electron/kernel-paths.cjs` 就位使 Task 3 的 electron 4 测试不 Module not found。

- [ ] **Step 1: 合并 .gitignore（先于任何拷贝，防 npm ci 产物误入追踪面）**

写入 `C:\Users\T203-15\yfworking\.gitignore`（保留原 4 段，增补下列行）：

```gitignore
# S3 合并自 cg（2026-09-07）：构建产物 / 运行时 / 调试残留 / SDD 工作区
dist-electron
/node.exe
__pycache__/
*.pyc
runtime/
.trae/
.superpowers
.cli_*.mjs
.cdp_*.mjs
.yfw_*.mjs
```

验证：`git -c core.quotepath=false check-ignore .superpowers runtime dist-electron` 三个都命中。

- [ ] **Step 2: 生成源路径清单并逐文件拷贝（自 cg 工作树）**

```bash
SRC=/c/Users/T203-15/claude-code-gui; DST=/c/Users/T203-15/yfworking
cd "$SRC"
# 受控清单（8 个产品目录 + 14 个根配置），on-disk 内容
git -c core.quotepath=false ls-files src server electron pet public build scripts bin > /tmp/s3-t1.txt
printf '%s\n' BUILD.md bun.lock diag-yfw.bat electron-builder.yml index.html \
  package-lock.json package.json postcss.config.js skills-lock.json start.bat \
  tailwind.config.ts tsconfig.json tsconfig.node.json vite.config.ts >> /tmp/s3-t1.txt
# 未跟踪 A/B 补入
printf '%s\n' electron/kernel-paths.cjs scripts/build_promo_pdf.py >> /tmp/s3-t1.txt
# 防呆：显式从清单剔除被排除的路径（此处不应命中，命中即报错）
grep -E '^(yfw-kernel|\.claude|\.agents|YF|docs/superpowers|FREEZE-INVESTIGATION|docs/manual/_build)' /tmp/s3-t1.txt && echo "EXCLUSION LEAK" && exit 1
wc -l /tmp/s3-t1.txt
# 拷贝
while IFS= read -r f; do mkdir -p "$DST/$(dirname "$f")" && cp -p "$SRC/$f" "$DST/$f" || exit 1; done < /tmp/s3-t1.txt
```

Expected：清单行数 = 83+23+11+25+373+6+16+2+14+2 = **555**（Task 2 的 docs/manual 另计）；无 EXCLUSION LEAK。

- [ ] **Step 3: 内容级保真校验（对齐 S1 教训：content-level，不比 sha）**

```bash
SRC=/c/Users/T203-15/claude-code-gui; DST=/c/Users/T203-15/yfworking
cd "$SRC"
cat /tmp/s3-t1.txt | while IFS= read -r f; do cmp -s "$SRC/$f" "$DST/$f" || echo "MISMATCH: $f"; done
echo "verify done"   # 无 MISMATCH 输出 = 通过
# 目录计数对齐
cd "$DST"
for d in src server electron pet public build scripts bin; do echo "$d: $(git -c core.quotepath=false status --short $d | grep -c '^??') (expect src 83, server 23, electron 12, pet 25, public 373, build 6, scripts 17, bin 2)"; done
```

Expected：electron = 12（11 受控 + kernel-paths.cjs）、scripts = 17（16 受控 + build_promo_pdf.py），其余等于各自受控数。全部为 `??`（尚未 git add）。

- [ ] **Step 4: scoped commit**

```bash
cd /c/Users/T203-15/yfworking
git add .gitignore BUILD.md bun.lock diag-yfw.bat electron-builder.yml index.html \
  package-lock.json package.json postcss.config.js skills-lock.json start.bat \
  tailwind.config.ts tsconfig.json tsconfig.node.json vite.config.ts \
  src server electron pet public build scripts bin
git commit -m "chore(s3): 产品代码迁入——cg 工作树 v2.7.5 形态（src/server/electron/pet/public/build/scripts/bin + 根配置，含在途 kernel-paths.cjs 与 build_promo_pdf.py）"
```

提交后 `git show --stat | head -8` 自证首行目录齐全；`git status --short` 只剩 docs/ 待迁（Task 2）与 kernel/ 未动。

---

### Task 2: docs/manual 产品手册 + bridge 契约文档迁入

**Files:**
- Copy（源 cg on-disk）：`docs/manual/` 受控 27 文件（`YFWorking产品使用说明书.md/.pdf` CJK 2 + `images/` 25：截图 01-16/18/20-25 与 `logo_新远方数据LOGO.png`、`logo_新远方数据LOGO横版.png`）+ 未跟踪 A 类 7 文件（`YFWorking宣传页.pdf`、`images/19-header-theme.png`、`images/26-diagnostic.png`、`images/27-browser.png`、`images/28-doubao.png`、`images/29-schedule.png`、`images/30-settings-experience.png`）
- Copy（未跟踪 A 类）：`docs/bridge-contract.md`（12KB GUI↔bridge↔内核三层契约，净室基线文档）
- 排除（不拷）：`docs/manual/_build/`（C 类，5.5MB 中间产物，可重建）、cg `docs/superpowers/`（38 文件——yfworking 原生同名目录保留原样）

**Interfaces:**
- Consumes: Task 1 已就位的 scripts/build_promo_pdf.py（logo 资产依赖本次 images 迁入后闭合）。
- Produces: 净室 `docs/manual/`（在售手册 md/pdf + 截图 27 图 + 宣传页）与 `docs/bridge-contract.md`——Task 3 流水线不受 docs 影响，但手册是 S3 在售主体 docs 面的完整交付。

- [ ] **Step 1: 生成清单并拷贝（排除 _build 与 docs/superpowers）**

```bash
SRC=/c/Users/T203-15/claude-code-gui; DST=/c/Users/T203-15/yfworking
cd "$SRC"
git -c core.quotepath=false ls-files docs/manual > /tmp/s3-t2.txt   # 27（含 CJK 2 + logo 2）
printf '%s\n' "docs/manual/YFWorking宣传页.pdf" \
  docs/manual/images/19-header-theme.png docs/manual/images/26-diagnostic.png \
  docs/manual/images/27-browser.png docs/manual/images/28-doubao.png \
  docs/manual/images/29-schedule.png docs/manual/images/30-settings-experience.png \
  docs/bridge-contract.md >> /tmp/s3-t2.txt                          # +8
grep -E '(_build|docs/superpowers)' /tmp/s3-t2.txt && echo "LEAK" && exit 1
while IFS= read -r f; do mkdir -p "$DST/$(dirname "$f")" && cp -p "$SRC/$f" "$DST/$f" || exit 1; done < /tmp/s3-t2.txt
echo "copied: $(wc -l < /tmp/s3-t2.txt)"
```

Expected：拷贝 35 文件（manual 34 + bridge-contract 1）；无 LEAK。

- [ ] **Step 2: 内容保真 + 计数**

```bash
SRC=/c/Users/T203-15/claude-code-gui; DST=/c/Users/T203-15/yfworking
cd "$SRC"
cat /tmp/s3-t2.txt | while IFS= read -r f; do cmp -s "$SRC/$f" "$DST/$f" || echo "MISMATCH: $f"; done; echo done
cd "$DST"
git -c core.quotepath=false status --short docs | grep -c '^??'   # expect 35
# 排除集确认：docs/superpowers 与 docs/manual/_build 不在 untracked 中
git status --short docs/manual/_build docs/superpowers | wc -l     # expect 0（superpowers 已 tracked 原生 8）
```

- [ ] **Step 3: scoped commit**

```bash
cd /c/Users/T203-15/yfworking
git add docs/manual docs/bridge-contract.md
git commit -m "chore(s3): 产品手册与 bridge 契约迁入——docs/manual 27 受控 + 在途宣传页/6 截图 + bridge-contract.md（docs/superpowers 净室原生保留）"
```

---

### Task 3: npm ci → typecheck → vite build → npm test 基线对齐

**Files:**
- 无新增拷贝。本任务为**验证任务**：在 Task 1/2 已落的产品树上跑四步流水线，对齐旧库基线（数值基准 = s3-preflight-cg-baseline.md：typecheck 23.6s exit 0 / build 首跑 48.2s exit 0 / npm test 130 tests·128 pass·2 fail）。

**Interfaces:**
- Consumes: Task 1 产品代码 + Task 2 docs + 根 package.json/package-lock.json（v2.7.5）。内核未就位（Task 4 才迁）——预研已证四步流水线对内核零依赖，本任务先行合法。
- Produces: 基线对齐证据 + 环境性失败归因（写 Task 5 完结报告的输入）；净室 node_modules 就位供 Task 4 内核测试（node:test 零依赖，不受影响）。

- [ ] **Step 1: npm ci（净室首次装依赖，需 npm registry 网络）**

```bash
cd /c/Users/T203-15/yfworking && npm ci
```

Expected：exit 0；`npm ls --depth=0` 顶层 51 dependencies + 13 devDependencies（数量对齐 cg 基线；深度列表不必逐一核对）。

- [ ] **Step 2: typecheck**

```bash
cd /c/Users/T203-15/yfworking && npm run typecheck
```

Expected：exit 0，无任何 TS error（对齐 cg 23.6s / PASS）。

- [ ] **Step 3: vite build**

```bash
cd /c/Users/T203-15/yfworking && npm run build
```

Expected：exit 0；`tsc && vite build` 均过；dist/ 产物出现；仅 chunk>350kB 警告可接受。`dist/` 已被 .gitignore 覆盖（Step1 合并含 `dist`）。

- [ ] **Step 4: npm test + 环境性失败归因**

```bash
cd /c/Users/T203-15/yfworking && npm test 2>&1 | tail -15
```

Expected：tests 130 / pass ≥128 / fail ≤2；11 文件全命中（server 7 + electron 4）。两个环境性失败（若再现）逐一归因：
1. `electron/browser-executor.test.mjs` isBlockedUrl：读 `{home}/browser-whitelist.json`（allow 含 example.com）→ `evil.example.com` 被放行。**演示根因**（单文件、隔离 home，证明是环境不是代码）。注意环境变量为 **`YFWORKING_HOME`**（electron/browser-common.cjs:115 `process.env.YFWORKING_HOME || process.env.CLAUDE_CONFIG_DIR || ~/.yfworking`；测试 harness 会预置真实值，须显式覆盖）：
   ```bash
   cd /c/Users/T203-15/yfworking && TMPHOME=$(mktemp -d) && YFWORKING_HOME="$TMPHOME" node --test electron/browser-executor.test.mjs 2>&1 | tail -5 && rm -rf "$TMPHOME"
   ```
   Expected：该用例在空 home 下 **PASS**（默认白名单 block example.com）。
2. `server/transcript.test.mjs` mtime 倒序 flaky：两次紧邻写文件 mtimeMs 相同 → 退化为目录序。同命令重跑若 PASS 即归因 flaky，不修。
**禁止**为掩盖环境失败修改任何测试/生产代码。

- [ ] **Step 5: 无 commit（纯验证）。写证据段到 Task 5 的完结报告草稿**

将四步结果（命令/exit/时长/测试计数/失败归因）写入 `C:\Users\T203-15\yfworking\.superpowers\sdd\2026-09-07-s3-cleanroom-migration\task-3-report.md`（工作区 scratch，不入 git）。

---

### Task 4: 内核源码 + version.mjs + 8 套件迁入（50/50 绿）

**Files:**
- Copy（源 pd on-disk @ HEAD 1696286）：`kernel/` 全量 33 受控文件（`git -c core.quotepath=false ls-files kernel`）→ 目标 `kernel/`；根 `version.mjs` → 目标根 `version.mjs`（cli.mjs:41/settings.mjs:4/tui.mjs:34 三处 import `../version.mjs` 的同迁前提）
- Copy（pd server/ 8 套件 → 目标 `kernel-tests/`，**文件名不变**，import `../kernel/…` 相对路径天然指向根 kernel/，零改路径）：`engine-guard-deadstream.test.mjs`(4)、`api-empty-stream.test.mjs`(6)、`engine-lane-summary.test.mjs`(1)、`engine-lane-heal.test.mjs`(3)、`engine-lane-trunc.test.mjs`(1)、`subagent.test.mjs`(15)、`api-protocol.test.mjs`(19)、`engine-guard-idle.test.mjs`(1) = 50 用例
- 排除：pd 其它 server/*.test.mjs（60+ 项，非本批）、scripts/build-kernel.mjs、kernel-dist/

**Interfaces:**
- Consumes: pd HEAD 1696286（P1-11 已合规 commit，工作树干净）；Task 1 已就位的根 package.json（version.mjs 与 package.json 同根共存无冲突——cg 无此文件名）。
- Produces: 净室 `kernel/`（33 文件源码直跑形态）+ 根 version.mjs + `kernel-tests/` 8 套件；S4 接线（bridge 指向本库 kernel）的对象已就位。`kernel-tests/` 不在 npm test glob（`server/*.test.mjs` `electron/*.test.mjs`）内 → 产品 130 用例基线不受污染。

- [ ] **Step 1: 拷贝 kernel/ + version.mjs + 8 套件**

```bash
SRC=/c/Users/T203-15/ponos-dev; DST=/c/Users/T203-15/yfworking
cd "$SRC"
git -c core.quotepath=false ls-files kernel > /tmp/s3-t4-kernel.txt        # 33
echo version.mjs >> /tmp/s3-t4-kernel.txt
printf '%s\n' server/engine-guard-deadstream.test.mjs server/api-empty-stream.test.mjs \
  server/api-protocol.test.mjs server/engine-lane-summary.test.mjs \
  server/engine-lane-heal.test.mjs server/engine-lane-trunc.test.mjs \
  server/subagent.test.mjs server/engine-guard-idle.test.mjs > /tmp/s3-t4-tests.txt
grep -vE '^kernel/' /tmp/s3-t4-kernel.txt | grep -v '^version.mjs$' && echo "NONKERNEL LEAK" && exit 1
while IFS= read -r f; do mkdir -p "$DST/$(dirname "$f")" && cp -p "$SRC/$f" "$DST/$f" || exit 1; done < /tmp/s3-t4-kernel.txt
while IFS= read -r f; do mkdir -p "$DST/kernel-tests" && cp -p "$SRC/$f" "$DST/kernel-tests/$(basename "$f")" || exit 1; done < /tmp/s3-t4-tests.txt
echo "kernel $(wc -l < /tmp/s3-t4-kernel.txt) files + tests $(wc -l < /tmp/s3-t4-tests.txt) files"
```

Expected：kernel 34 文件（33 + version.mjs）、kernel-tests 8 文件；无 NONKERNEL LEAK。

- [ ] **Step 2: 内容保真**

```bash
SRC=/c/Users/T203-15/ponos-dev; DST=/c/Users/T203-15/yfworking
cat /tmp/s3-t4-kernel.txt | while IFS= read -r f; do cmp -s "$SRC/$f" "$DST/$f" || echo "MISMATCH $f"; done
cat /tmp/s3-t4-tests.txt | while IFS= read -r f; do cmp -s "$SRC/$f" "$DST/kernel-tests/$(basename "$f")" || echo "MISMATCH $f"; done
echo done   # 无 MISMATCH = 通过
```

- [ ] **Step 3: 跑 8 套件（内核回归基线 50/50 绿）**

```bash
cd /c/Users/T203-15/yfworking && node --test kernel-tests/engine-guard-deadstream.test.mjs kernel-tests/api-empty-stream.test.mjs kernel-tests/api-protocol.test.mjs kernel-tests/engine-lane-summary.test.mjs kernel-tests/engine-lane-heal.test.mjs kernel-tests/engine-lane-trunc.test.mjs kernel-tests/subagent.test.mjs kernel-tests/engine-guard-idle.test.mjs 2>&1 | tail -8
```

Expected：# tests 50 / pass 50 / fail 0（分套件：deadstream 4、empty-stream 6、api-protocol 19、lane-summary 1、lane-heal 3、lane-trunc 1、subagent 15、guard-idle 1）。若某套件报 env/路径类失败：先读该套件文件头部注释确认是否自设 PONOS_MOCK_API（deadstream/guard-idle 在 import 前自设；empty-stream 明确不设、直连本地 http server）——8 套件在 pd 单命令无 env 前缀可全绿（P1-11 已证），净室不应加前缀；确有不自足套件时才在命令前加 `PONOS_MOCK_API=1` 并记录原因。

- [ ] **Step 4: scoped commit**

```bash
cd /c/Users/T203-15/yfworking
git add kernel kernel-tests version.mjs
git commit -m "feat(s3): 内核源码迁入——pd HEAD 1696286 kernel/ 33 文件 + 根 version.mjs + 内核测试 8 套件（kernel-tests/，50 用例基线）"
```

提交后 `git status --short` 应只余 Task 5 待写文档。

---

### Task 5: 净室边界收口 + S1 ③ 残留基线记录 + 完结报告

**Files:**
- Write（yfworking 净室 docs，随本 Task commit）：`C:\Users\T203-15\yfworking\docs\superpowers\plans\2026-09-07-s3-s6-cleanroom-roadmap.md`（S3 节推进标注勾选 + 完结摘要 + 移交 S4 事项）
- Write（scratch，不入 git）：`C:\Users\T203-15\yfworking\.superpowers\sdd\2026-09-07-s3-cleanroom-migration\task-5-report.md`（完结报告）
- Write（scratch，不入 git）：同上工作区 `progress.md`（ledger：Task 1-5 complete + 各 commit）

**Interfaces:**
- Consumes: Task 3 流水线证据、Task 4 内核 50/50、S1 清单③ 处置表（audit doc）作为排除/残留权威。
- Produces: S3 完结判定（DoD 前置："净室库落成、四步对齐、内核测试全绿、排除集验证"）+ S4 backlog 清单（残留引用现状基线 + 需改接文件列表）。

- [ ] **Step 1: 排除集不存在性验证（净室全库扫描）**

```bash
cd /c/Users/T203-15/yfworking
# ① 追踪面零泄漏：排除项不应出现在 git ls-files（node_modules/dist 等构建产物已被 .gitignore 覆盖，同样不应被追踪）
git ls-files | grep -E '^(yfw-kernel|\.claude|\.agents|YF|FREEZE-INVESTIGATION|e2e-entry5|\.salvage-work|node_modules/|^dist/|release|kernel-dist)' || true   # expect 0 命中
# ② 源码树排除项 on-disk 不存在（node_modules/dist/release/runtime 是 gitignored 构建产物，on-disk 存在属预期，不在此查）
for p in yfw-kernel .claude .agents YF FREEZE-INVESTIGATION.md e2e-entry5.ts .salvage-work docs/manual/_build docs/prototypes; do
  [ -e "$p" ] && echo "UNEXPECTED PRESENT: $p" || true
done
# ③ 构建产物确实被忽略（而非被追踪）
git check-ignore node_modules dist release runtime >/dev/null && echo "build artifacts gitignored: OK"
echo "scan done"
# 净室 docs/superpowers 仍为原生文件（未被 cg 同名覆盖）
git -c core.quotepath=false ls-files docs/superpowers | wc -l    # expect 8
```

Expected：① 0 命中；② 无 UNEXPECTED PRESENT；③ OK；docs/superpowers = 8（原生 7 + S3 计划文档，净室自有、非 cg 迁入）。

- [ ] **Step 2: S1 ③ 残留现状基线（= S4 backlog 输入）**

`git -c core.quotepath=false grep -n` 净室树内仍指旧内核的引用点（此刻全部"原样残留"、无一改接），逐项记录为 `文件:行 + 引用 + S4 改接去向`：
- `server/bridge.mjs`（findYFWorking 候选/kernel-paths import/库存 Claude Code 兜底 :565-570 区/注释）
- `electron/kernel-paths.cjs`（第 3 dev 候选 `yfw-kernel/claude-code/dist`）
- `electron/main.cjs`、`electron/diag-monitor.cjs`（kernel-stderr/rg 检查项以旧内核 bootstrap 布局为前提）
- `electron-builder.yml:77-86`、`scripts/package-portable.cjs:127,137`、`scripts/verify-permission-flow.mjs:15`
- `bin/yfworking.cmd`（Claude Code 包装 + `where claude` 兜底）、`start.bat:2`、`electron/main.cjs:5`（标题/注释）
写进 task-5-report.md 的"S4 backlog"表（S4 计划直接消费；S1 清单③(b) 的"5 个可执行引用点文件"应在此表内全覆盖）。

- [ ] **Step 3: 完结判定 + 更新 roadmap + 写 ledger**

roadmap S3 节：勾选 4 项【推进标注】、补"执行记录"短段（commit 列表 + 四步对齐数值 + 50/50 + 决策落点）。本计划为纯拷贝、**不做任何代码改写**，故下列清洗项只记 backlog：build_promo_pdf.py 已随迁但 BASE 硬编码 `C:\Users\T203-15\claude-code-gui` 需参数化（归 S4/S6 脚本清洗批，与 package-portable/verify-permission-flow 同族）、installer.nsh 技能数 65→85 校准与手册 V2.7.2/2.7.5 版本不一致（记 S6 出包统一）。ledger 记：Task1-5 commit hash、测试数值、deferred/minor（若有）、移交 S4 的清单指针。

- [ ] **Step 4: scoped commit（仅 roadmap 更新）**

```bash
cd /c/Users/T203-15/yfworking
git add docs/superpowers/plans/2026-09-07-s3-s6-cleanroom-roadmap.md
git commit -m "docs(s3): S3 净室库落成完结——四步流水线对齐基线、内核 50/50 绿、S4 backlog 移交"
```

- [ ] **Step 5: 报告**

对话返回：S3 状态（DONE/BLOCKED）、各 Task commit、四步对齐数值（typecheck/build/test 计数）、内核 50/50、排除集验证摘要、S4 backlog 要点、concerns。

---

## Self-Review

**Spec/roadmap 覆盖：**
- §S3"拷贝不移动、全新 git 历史"→ Global Constraint 1 + 各 Task cp 语义。
- "从 claude-code-gui 迁入自研产品代码与根配置"→ Task 1 + 2。
- "从 ponos-dev 迁入修复后内核源码与构建脚本"→ Task 4（源码；构建脚本按预研④裁决不迁，已写 Constraint 4 + Task 4 排除）。
- "npm ci → typecheck → vite build → npm test 对齐旧库基线"→ Task 3。
- "docs 迁入范围、筛除指向旧内核的过时内容"→ Task 2（manual 保留、superpowers 剔除、FREEZE-INVESTIGATION 裁决排除）。
- "S1 清单③ 排除集权威"→ Constraint 3 + Task 1 排除 + Task 5 验证。
- 四个【推进标注】前提→本计划承接（文件清单=ls-files 命令、cg 基线数值=Task 3 期望值、kernel 测试入口=Task 4、清单③=Constraint 3/Task 5）。
- 用户裁决落实：cg"工作树 v2.7.5 全量"→ Constraint 2（on-disk 拷贝）；pd"先落地 P1-11 再迁"→ 源 HEAD 1696286；cg-inflight 5 存疑 → Constraint 5/6 + Task 2/5（build_promo_pdf.py 随迁、dafeiyu 脚本排除、installer 计数与版本差异记录）。

**占位扫描：** 无 TBD/TODO；所有命令含预期输出。kernel-tests 分套件用例数（4/6/1/3/1/15/19/1=50）与 P1-11 ledger 实测一致。

**类型/命名一致：** `kernel-tests/` 目录名全程一致；8 套件名与 pd `git ls-files` 实测一致；version.mjs 同迁（3 处 import 前提）在 Task 4 Step 1 显式处理。
