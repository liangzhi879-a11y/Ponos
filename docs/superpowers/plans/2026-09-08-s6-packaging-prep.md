# S6 打包与验收 — Batch A：收编与准备迭代实施计划

- 日期：2026-09-08
- 执行仓库：`C:\Users\T203-15\yfworking`（净室，HEAD d00c498，S5 完结态）
- 上级权威：`docs/superpowers/specs/2026-09-07-yfworking-ponos-kernel-switch-design.md` §4（DoD）/§6（子工程表 S6）/§11（验收与零残留审计）
- 上级路线：`docs/superpowers/plans/2026-09-07-s3-s6-cleanroom-roadmap.md` S6 节 + S4/S5 backlog ①-⑩
- 范围界定（用户 2026-09-08 决策）：本轮 = S6 之 **Batch A（收编与准备迭代）**；安装包实跑（electron-builder NSIS 出包、四层审计产物面、GUI 全栈冒烟、双版并存、破坏性 ops）归 **Batch B**（后续会话，按 roadmap S6 推进标注另立计划）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐 Task 实施。步骤用 checkbox（`- [ ]`）跟踪。每 Task 由 implementer（fresh subagent）+ 1 轮 reviewer（只读复核）执行，沿用 S4/S5 惯例。

**Goal:** 完成 S6 全部可独立推进的收编/清洗/测试补齐/决策落位项，使净室库进入"可出包"状态（打包资源受控自含、文档与脚本零旧库残留、依赖面/测试面补齐），并把出包验收批的边界与前提固化。

**Architecture:** 六个改动面互不交织——① 内置模板收编为 git 受控资产并改接 electron-builder 源；② 版本/身份决策落位（2.8.0 + 正式替换身份）；③ 脚本批清洗（BASE 相对化/legacy env/注释/diag 退役）；④ 文档批清洗（BUILD.md/manual 旧端口与版本）；⑤ 测试面补齐（部署零依赖断言 + 环境性失败隔离）；⑥ S5 minor 注释一致性 + ②-08 结论。除 T1 新增受控模板目录与 T3 宣传页 logo 收编（拷贝自旧库，见 Global Constraints 拷贝清单）外，不改动任何功能行为。

**Tech Stack:** electron-builder.yml（extraResources/nsis.include）、NSIS installer.nsh、node --test（server/electron）、ESM .mjs/.cjs、docs/manual markdown、无新依赖引入。

## Global Constraints

1. **零触碰**：`kernel/`、`kernel-tests/`、`version.mjs`（Ponos 版本线，与 GUI 发布线 package.json version 无关）、`YF/`（untracked 用户素材）一律不改。`git add` 不得误收 `YF/`、`dist/`、`runtime/`、`kernel-dist/`、`node.exe`。
2. **唯一功能行为改动 = 安装包组装源改接**（electron-builder.yml extraResources 3 段 from `runtime/agents|memory|tools` → `build/templates/agents|memory|tools`）与 installer.nsh 技能数文案去硬编码；其余全部为文档/注释/脚本/测试改动。
3. **拷贝来源清单**（只读源：旧库 `C:\Users\T203-15\claude-code-gui`，逐项执行者以 `cp -r` 复制入净室并 git 入库，源文件内容本身不修改）：
   - `runtime/agents/`（11 个 `*.md` 专家代理模板）→ 净室 `build/templates/agents/`
   - `runtime/memory/personal/`（7 个主题 starter `*.md`）→ 净室 `build/templates/memory/personal/`
   - `runtime/tools/`（`README.md` + `yfw-helper/`）→ 净室 `build/templates/tools/`
   - `docs/manual/images/logo_新远方数据LOGO横版.png` → 净室 `docs/manual/images/`（宣传页脚本 logo 收编，T3）
4. **删除清单**（用户批准本计划即授权执行；执行者在对应 Task 内 `git rm`，commit 前复查一次路径）：
   - 仓库根 `diag-yfw.bat`——legacy 旧 bun 布局安装诊断工具（检测 `resources/runtime/bun/bun.exe` 等），净室运行时 = node（D1），整文件失效且有误导性，退役删除。删除前 `git log --oneline -- diag-yfw.bat` 确认无独有内容需要保留（该工具逻辑属通用诊断，如确有可复用片段执行者在 report 中记录，再行删除）。
5. **GUI/产物验证口径**：服务端/脚本改动 = 对应命令验证（grep/node --check/node --test）；GUI 代码零改动（T6 仅注释）；不引入新依赖；本轮**不运行 electron-builder 出包**（Batch B）。对需打包配置的校验，落 `scripts/verify-package-assets.mjs`（T1）供 Batch B 复用。
6. **commit 前缀**：`feat(s6)` / `refactor(s6)` / `test(s6)` / `docs(s6)` / `chore(s6)`。
7. **回归基线**：`npm run typecheck`、`npm test`（默认 home 下应 142/142——T5 修复后）、`node --test kernel-tests/*.test.mjs`（50/50）每 Task 收尾复核。

## 决策（本计划依据，2026-09-08 用户定案）

| # | 决策 | 内容 |
|---|---|---|
| D6-A | 版本 | package.json version **2.7.5 → 2.8.0**（净室首版；触发 installer.nsh 升级覆盖语义）。不改 version.mjs |
| D6-B | 产物身份 | **正式替换身份**：appId `com.yfworking.desktop` / productName `YFWorking` 保持；安装形态经 installer.nsh 版本比较覆盖升级；双版并行走便携/dev 目录隔离 + `YFWORKING_HOME` userData 重定向（main.cjs:93-95 行为不变，仅注释定案） |
| D6-C | 内置模板源 | agents/memory/tools 收编 `build/templates/`（git 受控）；python 与 skills 维持构建期组装 `runtime/` |
| D6-D | 冒烟口径 | Batch B：自动为主 + 授权 manual 行（S5 遗留 5 minor 视觉/注释随 Batch B GUI 冒烟覆盖） |
| D6-E | ②-08 | 保持 backlog（产品无热切需求）；T6 在 roadmap 落结论 |

## Task 明细

---

### Task 0: 计划入库

- [ ] **Step 1**：本计划文档 commit
```bash
git add docs/superpowers/plans/2026-09-08-s6-packaging-prep.md
git commit -m "docs(s6): Batch A 收编与准备迭代实施计划成稿——模板收编/版本身份/清洗批/测试补齐"
```

产出 commit：`docs(s6)`。

---

### Task 1: 内置模板收编入库 + 打包资源面改接（backlog ⑨②）

**范围**：agents/memory/tools 模板从旧库收编为净室受控资产；electron-builder extraResources 3 段源改接；installer.nsh 技能数硬编码治理；新增打包资源预检脚本。

**Files:**
- Create: `build/templates/agents/*.md`（11 个，源 `C:\Users\T203-15\claude-code-gui\runtime\agents\`）
- Create: `build/templates/memory/personal/*.md`（7 个，源 旧库 `runtime/memory/personal/`）
- Create: `build/templates/tools/`（README.md + yfw-helper/，源 旧库 `runtime/tools/`）
- Create: `scripts/verify-package-assets.mjs`
- Modify: `electron-builder.yml:40-85`（extraResources 3 段 from 改接 + :118 注释 bun 字样，见 Task 3 重叠项——bun 注释归 T3，此处只改 from 段）
- Modify: `build/installer.nsh:155`（技能数文案）与 `:205`（marker 计数）

- [ ] **Step 1: 收编模板**（三个 cp，逐项核对文件数与内容性质）

```bash
mkdir -p build/templates
cp -r "/c/Users/T203-15/claude-code-gui/runtime/agents" build/templates/agents
cp -r "/c/Users/T203-15/claude-code-gui/runtime/memory/personal" build/templates/memory/personal
cp -r "/c/Users/T203-15/claude-code-gui/runtime/tools" build/templates/tools
find build/templates -type f | wc -l    # 预期 ≥ 19（11 agents + 7 memory + tools 组）
```
抽查：`head -12 build/templates/agents/audit-verifier.md` 应为 YFWorking 自研 subagent frontmatter（name/description/whenToUse/model/skills），无 anthropic/claude 专有内核内容；任一 memory starter 为空白主题模板。若发现内容与净室技能体系（gxtz-*/yfwdoc-*/yfwweb-*/yfwx-*）不符，report 说明并暂停该项。

- [ ] **Step 2: electron-builder.yml extraResources 3 段源改接**（改前先读文件确认当前文本）
将 agents/memory/tools 三段改为（python/skills 两段保持 `from: runtime/...` 不动，它们是构建期组装产物）：
```yaml
  # Built-in agent templates (installed to ~/.yfworking/agents/ on first run)
  - from: build/templates/agents
    to: runtime/agents
    filter:
      - "**/*"
  # Built-in memory starter templates (installed to ~/.yfworking/memory/personal/)
  - from: build/templates/memory
    to: runtime/memory
    filter:
      - "**/*"
  # Built-in CLI tools (installed to ~/.yfworking/tools/)
  - from: build/templates/tools
    to: runtime/tools
    filter:
      - "**/*"
```

- [ ] **Step 3: installer.nsh 技能数硬编码治理**（`build/installer.nsh`）
- `:155` 弹窗文案去掉具体计数：「技能包包含全部申报、文档处理、浏览器自动化等技能，安装到您的用户技能库（~\.yfworking\skills）。已有内容不会被覆盖（仅新增/更新的文件生效）。…」（保留句意，删「85 个」字样与「85 个技能」计数句）
- `:205` marker JSON：`"skills":85,"deployedCount":85` 改为 `"skills":"bundle","deployedCount":"bundle"` 并在该行上方加一行 NSIS 注释 `; 技能数随出包机技能库动态变化，不再硬编码计数（S6 backlog② 治理）`。全文件再 `grep -n "85\|技能数"` 确认无其它硬编码技能计数。

- [ ] **Step 4: 新增打包资源预检脚本 `scripts/verify-package-assets.mjs`**（Batch B 出包前复用，纯文件存在性断言，node 直跑无依赖）
```js
// scripts/verify-package-assets.mjs
// S6 打包资源面预检（Batch B 出包前跑）。校验 electron-builder.yml extraResources
// 声明的源在本仓库的存在性；构建期组装源（runtime/python、runtime/skills）标注为
// build-installer.mjs 前置产物，缺失时提示先跑 build-installer.mjs。
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { load } from 'js-yaml'

const ROOT = join(import.meta.dirname, '..')
const yml = load(readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8'))
const BUILD_TIME = new Set(['runtime/python', 'runtime/skills'])
let failed = false
for (const er of yml.extraResources ?? []) {
  const from = join(ROOT, er.from)
  if (BUILD_TIME.has(er.from)) {
    if (!existsSync(from)) {
      console.log(`[skip] ${er.from} —— 构建期组装源，先跑 scripts/build-installer.mjs 生成`)
    } else {
      console.log(`[ok  ] ${er.from} (构建期组装源已存在)`)
    }
    continue
  }
  const ok = existsSync(from)
  console.log(`[${ok ? 'ok' : 'FAIL'}] ${er.from} -> ${er.to}`)
  if (!ok) failed = true
}
// kernel-dist/cli.mjs 是 files 的打包前提（electron-builder.yml 有注释声明，另做存在性断言）
if (!existsSync(join(ROOT, 'kernel-dist', 'cli.mjs'))) {
  console.log('[FAIL] kernel-dist/cli.mjs 缺失——先跑 scripts/build-kernel.mjs')
  failed = true
}
if (failed) { console.error('\n资源面校验失败，请补齐后重试'); process.exit(1) }
console.log('\n打包资源面校验通过')
```
依赖 js-yaml（electron-builder 传递依赖，devDependencies 不显式含——若 `node scripts/verify-package-assets.mjs` 报 `Cannot find module 'js-yaml'`，改用 `npx electron-builder --help` 的 node_modules 解析或显式 `import('js-yaml')` 前先验证 `node -e "require('js-yaml')"` 可解析；若不可解析则将脚本改为逐行正则解析 5 个 `- from:` 块（实现者按实测选型，report 说明）。

- [ ] **Step 5: 验证**
```bash
node scripts/verify-package-assets.mjs
# 预期：build/templates/{agents,memory,tools} 三行 [ok]；runtime/python|skills 两行 [skip] 或 [ok]；kernel-dist/cli.mjs ok
grep -c "85 个技能\|85 个技能）" build/installer.nsh   # 预期 0
node --check scripts/verify-package-assets.mjs
```

- [ ] **Step 6: Commit**
```bash
git add build/templates electron-builder.yml build/installer.nsh scripts/verify-package-assets.mjs
git commit -m "feat(s6): 内置模板收编 build/templates 受控入库 + electron-builder 源改接 + installer.nsh 技能数去硬编码（backlog⑨②）"
```

---

### Task 2: 版本与产物身份落位（backlog⑤，D6-A/D6-B）

**Files:**
- Modify: `package.json:3`（version）
- Modify: `electron/main.cjs:89-95`（注释定案）
- Modify: `electron-builder.yml:1-3`（顶部注释）
- Modify: `docs/bridge-contract.md`（§10 身份行 + 更新日期行 :5）

- [ ] **Step 1: package.json 版本**：`"version": "2.7.5"` → `"version": "2.8.0"`。
- [ ] **Step 2: main.cjs 注释定案**（:92 行尾句「安装版产物身份（appId/productName）归 S6。」替换）：
```js
// 安装版产物身份（S6 定案，正式替换身份）：appId com.yfworking.desktop / productName
// YFWorking 与在售一致——安装形态经 installer.nsh 版本比较（2.8.0）覆盖升级保留数据；
// 双版并存由便携/dev 目录隔离 + 本 userData 重定向兜底，无需独立 appId。
```
- [ ] **Step 3: electron-builder.yml 顶部注释**（appId/productName 行上方加一行）：
```yaml
# S6 产物身份定案（正式替换身份）：与在售同 appId/productName，安装形态走
# build/installer.nsh 版本比较覆盖升级；双版并存见 docs/bridge-contract.md §10。
```
- [ ] **Step 4: bridge-contract.md §10**：`:5` 更新日期行尾补 `；S6 身份定案`；`:183` 表格行与 `:185` 尾句更新为定案取值（appId/productName 正式替换身份、版本 2.8.0、userData 规则 = main.cjs:93-95 现行为）。执行者读 :180-185 后按语义最小改写，保留对照表其余行。
- [ ] **Step 5: 验证**
```bash
node -e "console.log(require('./package.json').version)"   # 预期 2.8.0
npm run build    # 确认 __APP_VERSION__ 注入链路无碍（dist 产物，构建成功即可）
git diff --stat # 仅 package.json / main.cjs / electron-builder.yml / bridge-contract.md
```
- [ ] **Step 6: Commit**
```bash
git add package.json electron/main.cjs electron-builder.yml docs/bridge-contract.md
git commit -m "chore(s6): 版本 2.8.0 + 产物身份正式替换定案落位（backlog⑤，D6-A/D6-B）"
```

---

### Task 3: 脚本清洗批（backlog ③⑦⑧⑩ + 宣传页 logo 收编）

**Files:**
- Modify: `scripts/build_promo_pdf.py`（:17-20 BASE 相对化、:137/:155 版本字面、输出路径）
- Create: `docs/manual/images/logo_新远方数据LOGO横版.png`（收编自旧库，Global Constraints 拷贝清单）
- Modify: `scripts/verify-permission-flow.mjs:51`（删除残留 env 行）
- Modify: `electron-builder.yml:118`（注释 bun 字面量）
- Delete: 根 `diag-yfw.bat`（Global Constraints 删除清单）

- [ ] **Step 1: build_promo_pdf.py BASE 相对化**：`:17-20` 替换为 repo 根相对解析：
```python
# S6 清洗：BASE 由 repo 根解析（原硬编码旧库路径 claude-code-gui，随 S3 迁移失效）
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # = <repo 根>（scripts/ 上一级）
IMG_DIR = os.path.join(BASE, "docs", "manual", "images")
LOGO_PNG = os.path.join(IMG_DIR, "logo_新远方数据LOGO横版.png")
OUT_PDF = os.path.join(BASE, "docs", "manual", "YFWorking宣传页.pdf")
```
先确认 logo 已收编（`ls docs/manual/images/logo_新远方数据LOGO横版.png` 存在；不存在则先 `cp`，来源见 Global Constraints）。全文 `grep -n "claude-code-gui\|51309\|2\.7\.2" scripts/build_promo_pdf.py`：`:137` footer 与 `:155` c-foot 的 `V2.7.2` 字面同步为 `V2.8.0`；任何 51309 引用按语义改 51517（预期无）。
- [ ] **Step 2: verify-permission-flow.mjs 删残留 env**：删除 `:51` 整行 `CLAUDE_CODE_USE_NATIVE_FILE_SEARCH: 'true',`（旧 rg 语义，ponos 内核忽略；S4 T4 review concern 5）。删除后确认该对象仍合法（前后行逗号规整）。
- [ ] **Step 3: electron-builder.yml:118 注释修订**：`(bun.exe, node.exe, Python wheels, embedded CLI bundle)` → `(node.exe, Python wheels, embedded CLI bundle)`。:79-80「bun 不随包」否定表述语义正确，不动。
- [ ] **Step 4: diag-yfw.bat 退役删除**（先执行前置复查再删）
```bash
git log --oneline -- diag-yfw.bat   # 确认历史；无独有内容需保留
git rm diag-yfw.bat
```
若 log 显示其含未迁移的独有诊断逻辑，report 记录可复用片段（如 nsloop 检测段）到 Task 报告后仍删除（净室诊断 = 应用内「诊断」面板 + NSIS 自身机制，此独立 bat 无消费方）。
- [ ] **Step 5: 验证**
```bash
node --check scripts/verify-permission-flow.mjs
python -c "import ast; ast.parse(open('scripts/build_promo_pdf.py',encoding='utf-8').read())"   # 语法有效（不执行渲染）
grep -rn "claude-code-gui" scripts/build_promo_pdf.py scripts/verify-permission-flow.mjs   # 预期 0
grep -n "bun\.exe" electron-builder.yml   # 预期 0（注释已清；「bun 不随包」为无 bun.exe 字面）
git status --short   # diag-yfw.bat 已删、无 YF/ 误入
```
- [ ] **Step 6: Commit**
```bash
git add scripts/build_promo_pdf.py scripts/verify-permission-flow.mjs electron-builder.yml docs/manual/images/logo_新远方数据LOGO横版.png
git rm diag-yfw.bat   # 若上一步未 git rm 则在此执行
git commit -m "chore(s6): 脚本清洗批——宣传页 BASE 相对化+logo 收编、删 legacy env 行、bun 注释、退役 diag-yfw.bat（backlog③⑦⑧⑩）"
```

---

### Task 4: 文档清洗批（backlog④ + 手册版本同步）

**范围**：BUILD.md 与 docs/manual 说明书 .md 的旧端口/旧路径/旧版本字面全部清洗至净室现状（51517/5197/4197、pet/、2.8.0）。PDF 产物（说明书/宣传页 pdf）重建属 Batch B 文档面 manual 行，本轮不动。

**Files:**
- Modify: `BUILD.md`
- Modify: `docs/manual/YFWorking产品使用说明书.md`

- [ ] **Step 1: 定位全部待清洗点**
```bash
grep -n "51309\|5173\|4173\|3099\|yfw-kernel\|claude-code-gui\|jiajia-pixel-pet\|2\.7\.2\|2026-08-20" BUILD.md docs/manual/YFWorking产品使用说明书.md
```
- [ ] **Step 2: BUILD.md 清洗**（逐处按表改，读上下文后语义化落笔）
| 现状 | 改为 |
|---|---|
| 端口章节「默认 51309」及四处注入位置列举（:55/:64/:69-73） | 默认 **51517**；注入位置表删 `YF/jiajia-pixel-pet/jiajia-pet.py` 行、`src/lib/config.ts` 行保留（`__BRIDGE_PORT__` 编译时常量）；补 preview/dev 端口 4197/5197 一句（vite 配置，读 vite.config.ts 后写准） |
| 「为什么不是 3099？WinNAT 预留」段落 | 改写为「51517 高于 WinNAT 预留段（3095-3194）与常见动态端口」并保留 env 覆盖说明 |
| 故障表 `YFW_BRIDGE_PORT=51309` 两处（:64/:88） | `=51517` |
| 调试版同步 `cp YF/jiajia-pixel-pet/jiajia-pet.py ...`（:39） | `cp -r pet/* release/YFWorking/pet/`（pet 源已在根 pet/） |
| 其它 `YF/`、`yfw-kernel`、`claude-code-gui`、`3099` 命中 | 按语义删除或改为净室对应路径；不再指向在售旧库 |
| 目录约定表 `release/YFWorking_ms92cd6u` 行 | 保留（历史副本说明），不指向旧库路径 |
- [ ] **Step 3: manual 说明书清洗**
- 版本：`:6` 适用版本表、`:85` 安装包名、`:552` 「当前为 2.7.2」→ 均改 **2.8.0**；`:8` 更新日期 `2026-08-20` → `2026-09-08`。
- 端口：`:590`「检查 51309 端口」→「检查 51517 端口」；`:591` EACCES/3099 叙述 → 「如遇 `listen EACCES`，请用 `YFW_BRIDGE_PORT` 修改端口后重启（新版默认 51517，已避开 WinNAT 预留段）」；`:609`「默认 51309」→「默认 51517」。
- 通读 :586-609 FAQ/附录上下文，保证叙述与净室默认值一致（vite dev 5197 等如出现一并清洗）。
- [ ] **Step 4: 验证**
```bash
grep -n "51309\|5173\|4173\|3099\|yfw-kernel\|claude-code-gui\|jiajia-pixel-pet\|2\.7\.2\|2026-08-20" BUILD.md docs/manual/YFWorking产品使用说明书.md
# 预期 0（bridge-contract.md 的 §10 对照表保留 51309→51517 历史映射属例外，不在本批范围）
```
- [ ] **Step 5: Commit**
```bash
git add BUILD.md docs/manual/YFWorking产品使用说明书.md
git commit -m "docs(s6): BUILD.md/manual 旧端口 51309 与版本 2.7.2 清洗至净室默认（51517/5197/4197、2.8.0）（backlog④）"
```

---

### Task 5: 测试面补齐——deploy-smoke 零依赖断言 + browser-executor 环境性失败隔离

**Files:**
- Create: `server/deploy-smoke.test.mjs`
- Modify: `electron/browser-executor.test.mjs`

- [ ] **Step 1: 新增 `server/deploy-smoke.test.mjs`**（node --test，会被 `npm test` glob 收集；对照 ponos-dev deploy-smoke 语义在净室重写，断言内核独立部署包零依赖可直跑）
```js
// server/deploy-smoke.test.mjs
// S6 部署冒烟：内核独立部署包零 npm 依赖 + node 直跑 + 产品 bin 契约（DoD 四层审计「依赖面」）
// 事实依据：kernel/package.json 无 dependencies 键（2026-09-08 实测）；bin 指向 cli.mjs、main 指向 engine.mjs。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('内核独立部署包 package.json 零 npm 依赖且入口指向 cli.mjs', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'kernel', 'package.json'), 'utf8'))
  assert.ok(!('dependencies' in pkg), 'kernel/package.json 不得声明 npm dependencies')
  assert.equal(pkg.bin?.['ponos-kernel'], 'cli.mjs')
  assert.equal(pkg.main, 'engine.mjs')
  assert.ok((pkg.engines?.node ?? '').includes('>=18'))
})

test('内核 cli.mjs 可经 node 直跑 --help（exit 0 且有输出）', () => {
  const out = execFileSync(process.execPath, [join(ROOT, 'kernel', 'cli.mjs'), '--help'], {
    encoding: 'utf8', timeout: 30000,
  })
  assert.ok(out.length > 0)
})

test('产品 bin/cli.mjs 默认端口为新版隔离值', () => {
  const src = readFileSync(join(ROOT, 'bin', 'cli.mjs'), 'utf8')
  assert.match(src, /YFW_BRIDGE_PORT \|\| '51517'/)
  assert.match(src, /YFW_VITE_PORT \|\| '5197'/)
})
```
前置确认（落盘前先跑一次）：`node kernel/cli.mjs --help` 应 exit 0 且有输出——若实测行为不符（如 exit 非 0），以真实行为调整该用例断言并在 report 记录，不得跳过用例。

- [ ] **Step 2: 复现 browser-executor 环境性失败（基线确认）**：`npm test` 或单跑 `node --test electron/browser-executor.test.mjs`，确认 `isBlockedUrl 对白名单/非白名单判断正确`（:153）在默认 home 下 fail（真实 `~/.yfworking/browser-whitelist.json` 的 allow 域污染了断言期望）。
- [ ] **Step 3: 测试隔离修复**（`electron/browser-executor.test.mjs` 顶部 import 之后、测试用例之前）
根因：`browser-common.cjs` `isWhitelisted` 惰性读 `resolveYfwHome()/browser-whitelist.json`（browser-common.cjs:100-135），默认 home 下用户 allow 域使 `isBlockedUrl('https://evil.example.com')` 误判 false。修复 = 该测试文件内显式隔离数据根：
```js
// S6 环境性隔离：真实 home 的 browser-whitelist.json allow 域会污染单测断言，
// 故在 import 后、用例前把数据根指向临时空目录（browser-common 惰性读取，运行期生效）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const isoHome = mkdtempSync(join(tmpdir(), 'yfw-bexec-'))
process.env.YFWORKING_HOME = isoHome
process.env.CLAUDE_CONFIG_DIR = isoHome
// …原有 import 与用例不变…
// 文件最末追加清理（node --test 进程退出即回收，亦可用 test.after 或 process.on('exit')）
process.on('exit', () => { try { rmSync(isoHome, { recursive: true, force: true }) } catch {} })
```
注意：若 browser-executor.test.mjs 顶部为静态 `import ... from './browser-executor.cjs'`，ESM import 提升先于赋值语句执行，但 browser-common 仅在函数调用时解析 home（无模块顶层副作用），运行期 env 生效即可——实现者落盘后以「单跑该文件 + 全量 npm test 双绿」为准；若仍有模块顶层缓存问题，将 isoHome 前置到文件最顶部（import 声明之前物理置顶不改变提升顺序，则改用 `await import()` 动态引入被测模块的方案，report 记录选型）。
- [ ] **Step 4: 验证**
```bash
node --test electron/browser-executor.test.mjs        # 全绿
npm test                                              # 默认 home 142/142（原 1 fail 消除）+ 新增 deploy-smoke 用例
node --test kernel-tests/*.test.mjs                   # 50/50 不受影响
```
- [ ] **Step 5: Commit**
```bash
git add server/deploy-smoke.test.mjs electron/browser-executor.test.mjs
git commit -m "test(s6): deploy-smoke 内核零依赖断言补齐 + browser-executor isBlockedUrl 数据根隔离修复"
```

---

### Task 6: S5 minor 注释一致性 + ②-08 结论落位

**范围**：S5 review 5 minor 中「注释/表述」类就地处理（不改行为）；「视觉/纯内存」类保持并随 Batch B GUI 冒烟覆盖；②-08 在 roadmap 落结论。

**Files:**
- Modify: `src/hooks/useYFWCLI.ts`（注释类，:49/:110-145 区间）
- Modify: `docs/superpowers/plans/2026-09-07-s3-s6-cleanroom-roadmap.md`（S6 节记录在 T7 统一做——本 Task 只产出结论草稿段落，见 Step 3）

- [ ] **Step 1: 读现状**：读 `src/hooks/useYFWCLI.ts:40-150`，确认 heartbeatDead 声明（:49）、判死置位（:128）、重建清位（:143）与周边注释。
- [ ] **Step 2: 注释一致性（纯注释，行为零改动）**：
- heartbeatDead 声明处补注释说明其语义：`// 判死标记（S5 ②-07）：置位后立即 s.close() 触发既有指数退避重连；重建路径（onopen）清位。该标记为显式化"为何关闭"，供调试观测，不做二次判定。`
- 判死兜底注释（约 :110-130 区间 startHeartbeat 附近）若与实现不符（S5 r2 minor「判死兜底表述与实现不符」），按实现实际（60s 无消息 → close 走重连，无额外 taskkill 兜底）改写注释。
- 若读到其它 S5 新增注释与实现有出入（LoopStatusBar reason chip 兜底注释、CompactingBar 边界注释），同批就地微调（仅注释）。
- **不改任何逻辑/值/结构**；改后 `git diff` 必须只含注释行变化。
- [ ] **Step 3: ②-08 结论草稿**（供 T7 写入 roadmap）：结论 = 「②-08 set_effort/switch_provider：内核已支持（kernel/cli.mjs:595/620）；净室 bridge 未透传、GUI 无档位入口（pd 面板属 v3 排除）；产品侧无热切需求 → 保持 backlog，评估触发条件 = 产品明确需要会话内切换 provider/思考深度时，按 pd bridge 语义 diff 最小透传（bridge 分支 + GUI 菜单项），不移植 v3 面板。」将本段落到本 Task 报告，T7 统一写入 roadmap。
- [ ] **Step 4: 验证**
```bash
npm run typecheck
git diff --stat    # 仅 useYFWCLI.ts
git diff src/hooks/useYFWCLI.ts | grep -E "^[+-]" | grep -vE "^[+-]{3}" | grep -vE "^\+\s*//|^-\s*//" || echo "仅注释变更 OK"
```
- [ ] **Step 5: Commit**
```bash
git add src/hooks/useYFWCLI.ts
git commit -m "chore(s6): S5 minor 注释一致性就地处理（heartbeatDead/判死兜底表述，行为零改动）"
```

---

### Task 7: 完结——回归 + roadmap S6 节 + ledger + 汇报

**Files:**
- Modify: `docs/superpowers/plans/2026-09-07-s3-s6-cleanroom-roadmap.md`（S6 节推进标注部分勾选 + Batch A 执行记录 + Batch B 遗留）
- Create（scratch，不入 git）: `.superpowers/sdd/2026-09-08-s6-packaging-prep/{progress.md,task-N-report.md}`

- [ ] **Step 1: roadmap S6 节更新**
- 「推进标注」4 项中勾选本轮完成项并批注：冒烟矩阵脚本化 → 归 Batch B；打包产物结构核对清单 → Batch B（verify-package-assets.mjs 已就绪）；双版并存时长资源 → Batch B；旧库/旧产物处置 → Batch B（逐项征询）。
- 追加「执行记录（2026-09-08，S6 Batch A 完结）」：commit 链、D6-A~E、各 backlog ①-⑩ 处置状态表（①已处理关闭；② 85 计数去硬编码；③ BASE 相对化+logo 收编；④ BUILD.md/manual 清洗；⑤ 身份定案 2.8.0 落位；⑥ .gitattributes/CRLF → 本轮未处理、归 Batch B 字节复核；⑦ diag-yfw.bat 退役删除；⑧ env 行删除；⑨ extraResources 源改接 build/templates + verify-package-assets.mjs；⑩ bun 注释清洗）、②-08 结论（Task 6 Step 3 草稿）、S5 minor 处置说明（注释类已处理、视觉类归 Batch B GUI 冒烟）、Batch B 遗留清单。
- [ ] **Step 2: ledger + completion report（scratch）**：仿 S5 task-5-report.md——每 Task verbatim 验证结果、残余扫描（产品树 `grep -rn "claude-code-gui\|51309" scripts/ docs/ BUILD.md` 对照，bridge-contract §10 例外白名单注明）、Batch B 交接。
- [ ] **Step 3: 全量回归**
```bash
npm run typecheck && npm test && node --test kernel-tests/*.test.mjs && npm run build
```
- [ ] **Step 4: Commit**
```bash
git add docs/superpowers/plans/2026-09-07-s3-s6-cleanroom-roadmap.md
git commit -m "docs(s6): roadmap S6 节推进标注勾选 + Batch A 完结执行记录 + Batch B 交接"
```
- [ ] **Step 5: 完结汇报**（本会话主 agent 输出）：S6 Batch A 汇报 + Batch B 待办与开工条件。

## 门禁与纪律

- 每 Task implementer（subagent）+ 1 轮 reviewer（只读复核，spec 合规 + quality，blocking/minor 分级）；reviewer 关注：范围纪律（kernel/kernel-tests/version.mjs/YF 零触碰）、拷贝清单逐项落地、删除清单仅含批准项。
- **删除/拷贝动作**以 Global Constraints 清单为唯一依据；清单外任何 rm/mv/cp 须暂停征询。
- commit 前缀 `(s6)`；回归基线每 Task 收尾绿。
- Batch B（出包、四层审计产物面、GUI 冒烟、双版并存、破坏性 ops）不在本轮执行，T7 在 roadmap 固化交接。
