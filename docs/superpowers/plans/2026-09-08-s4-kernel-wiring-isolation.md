# S4 内核接线与双版隔离实施计划

- 日期：2026-09-08
- 执行仓库：`C:\Users\T203-15\yfworking`（净室，HEAD 0d50727，S3 完结态）
- 上级权威：`docs/superpowers/specs/2026-09-07-yfworking-ponos-kernel-switch-design.md` §8（隔离矩阵）/§9（四条主链）
- 输入基线：`.superpowers/sdd/2026-09-07-s3-cleanroom-migration/task-5-report.md`「S4 backlog」表（22 行，scratch 不入 git）；S1 audit 清单③
- 前置状态：641 tracked 文件；产品 130/128/2 与内核 50/50 全绿；净室零 yfw-kernel on-disk（引用残留在代码中）

## 1. 目标

将净室 dev / 构建 / bootstrap / 打包四条主链全部改接至本库 ponos 内核（`kernel/` 源码直跑 或 `kernel-dist/cli.mjs` bundle），删除全部 yfw-kernel 引用分支与旧 Claude Code 兜底；隔离矩阵逐行落地使净室新版与在售旧版（cg v2.7.5）可同机双版并行；以接线测试 + 双版冒烟验收。

**范围边界**：本子工程**不实际出安装包**（S6）；`electron-builder.yml` 仅做配置接线（kernel/pet 源改指净室现状），真实构建与产物四层审计归 S6。S4 产出的可运行物 = dev 双版（净室 dev 全套 env 启动 vs 在售版），验证到"各起一轮真实/模拟会话互不干扰"。

## 2. 调研结论（2026-09-08 实测，plan 依据）

### 2.1 现状事实

| # | 事实 | 证据 |
|---|---|---|
| F1 | `electron/kernel-paths.cjs` 候选 1 `<appRoot>/kernel/cli.mjs`（净室库根）已命中 → dev 直跑源已天然就绪 | kernel-paths.cjs:33-41；净室 `kernel/cli.mjs` 存在 |
| F2 | 净室内核 = pd 源码树，node/bun 均可直跑；`node kernel/cli.mjs --help` 实测秒出 | kernel/package.json:9-10 `start: node cli.mjs`；实测 exit 0 |
| F3 | 净室内核 **Grep/Glob 原生 node 递归，无 ripgrep/vendor 依赖**（kernel/tools.mjs 429 grepSearch/globSearch 全 node 实现）→ kernel-dist **不需要 vendor/** | kernel/tools.mjs；pd 调研（pd kernel/ 无 vendor） |
| F4 | pd `scripts/build-kernel.mjs` 存在：`bun build kernel/cli.mjs --target=node --format=esm --external=node:* --outfile=kernel-dist/cli.mjs --minify`，输出单文件 ~166KB、无 banner | pd scripts/build-kernel.mjs:20-31；实测 kernel-dist 166,447B |
| F5 | `PONOS_MOCK_API=1` 内核 mock 支持已随迁（api.mjs:988 / engine.mjs:126 / tools.mjs:573,620,845,866）→ 接线测试免真 token 全自动 | kernel/ 实测 |
| F6 | home 硬编码点清单（全部 `join(homedir(),'.yfworking')`，**不读 env**）：server/bridge.mjs:121、electron/diag-monitor.cjs:41、electron/kernel-paths.cjs:28、electron/main.cjs:137(DOUBAO_SESSION_FILE)/681/686、server/doubao.mjs:8-10、electron/log-tee.cjs:29、server/packager.mjs:8、scripts/verify-permission-flow.mjs:16 | grep 实测 |
| F7 | env-aware 先例仅两处：electron/browser-common.cjs:115（`YFWORKING_HOME \|\| CLAUDE_CONFIG_DIR \|\| ~/.yfworking`）、server/experience.mjs:5（`YFW_TEST_HOME` 测试注入） | 实测 |
| F8 | bridge spawn 会话 args（bridge.mjs:895-949）：`--print --output-format stream-json --input-format stream-json --verbose --dangerously-skip-permissions --permission-prompt-tool stdio --disallowedTools AskUserQuestion [--resume] [--append-system-prompt-file] [--model] --add-dir cwd --add-dir skillRoot`——与 pd 内核 parseArgs 契约一致 | bridge.mjs:895/899/901/946-949；kernel/cli.mjs:54-70 |
| F9 | env 逃生口现存：`YFWORKING_KERNEL`（bridge.mjs:538，显式内核路径）+ `YFW_BRIDGE_PORT`（bridge.mjs:21/main.cjs:161/diag-monitor.cjs:119/bin/cli.mjs:10/vite.config.ts:11 全支持）。**PONOS_KERNEL 名净室无**（仅 pd 侧 bridge 用） | 实测 grep |
| F10 | 端口现状：vite dev 5173 strictPort（vite.config.ts:42）、preview 4173（:47）**写死无 env**；interject.e2e.mjs:8 固定测试口 52319；Electron 内置浏览器 CDP = `webContents.debugger.attach('1.3')` **进程内、无网络端口**（browser-executor.cjs:652） | 实测 grep |
| F11 | dev 双版 userData 冲突：cg 与净室 package.json name 均为 `yfworking-gui`（Electron dev userData 取 package name → `%APPDATA%\yfworking-gui`）；安装版 `%APPDATA%\YFWorking`（productName） | package.json:2；pd 调研（cg 同） |
| F12 | 净室 pet/ 与旧 YF/jiajia-pixel-pet 同形（accessories_lib.py + assets + jiajia-pet.py）→ electron-builder #11 / package-portable #14 可直接改指 `pet/` | 实测 ls pet/ |
| F13 | 净室**无 runtime/**（python/bun/skills 打包资源不在库）→ S4 无法实跑 electron-builder --dir；主链 4 只做配置接线 | 实测 |
| F14 | 技能根 `YFW_SKILLS_DIR` = YFW_HOME/skills（bridge.mjs:122）；first-run auto-install sample skills 已有（bridge.mjs:2234）→ 隔离 home 可自足 | 实测 |
| F15 | `~/.yfworking/config.json` 存在（用户真实 provider 已配）→ 手动真 API 冒烟可行；自动冒烟走 F5 mock | 实测 |

### 2.2 已敲定决策（D 表）

| # | 决策 | 内容 | 验证/兜底 |
|---|---|---|---|
| D1 | **运行时 = node** | 内核源与 kernel-dist bundle 均以 node 直跑（bundle 为 `--target=node` ESM）。bridge `findYFWorking` 返回 `"<node>" "<kernel>"`（node = 包内 node.exe 兜底 process.execPath）。放弃 bun 随包 | T1 实证 `node kernel-dist/cli.mjs` mock 轮次；失败则回退 bun 随包（D1b），plan 不预设 |
| D2 | **home 中心开关 = `YFWORKING_HOME`** | 沿用 browser-common.cjs:115 解析序 `YFWORKING_HOME \|\| CLAUDE_CONFIG_DIR \|\| ~/.yfworking`；建单一共享解析模块，F6 全部硬编码点改接；隔离 home 后 runtime/skills/logs 等派生目录自动专用 | T2 隔离 home 实证 + 130 测试回归 |
| D3 | bootstrap 目标随 D2 home | 内核拷至 `<home>/runtime/kernel/`（env 隔离时即专用目录，不与旧 `~/.yfworking/runtime/kernel` 互覆）；**去掉 vendor 复制语义**（F3） | T3 |
| D4 | **新版独立端口默认值**（env 全部可覆盖；与旧值 51309/5173/4173/52319/9223 无交集）：bridge WS 51309→**51517**、vite dev 5173→**5197**、vite preview 4173→**4197**。新增统一 env `YFW_VITE_PORT` / `YFW_VITE_PREVIEW_PORT`（bridge 沿用 `YFW_BRIDGE_PORT`） | 前端 define `__BRIDGE_PORT__` 默认同步 51517；既有测试中显式传 baseUrl 的 URL 字面量**语义保留不动**，仅改"默认/回退"语境 | T4 双版冒烟对照 |
| D5 | **Electron CDP 隔离行修订**：净室 browser executor CDP 为进程内 attach（F10）→ 设计 §8 矩阵第 3 行"52319/9223 端口隔离"**不适用净室**，修订为"N/A（进程内 CDP）"并留 interject.e2e 固定测试口 52319（单测语境，不冲突）；记录于 roadmap 执行记录 | — | T4 文档修订 |
| D6 | **dev userData 隔离 = `app.setPath('userData', <home>/userData)`**（main.cjs app-ready 前，home 解析随 D2）；未设 env 时保持 Electron 默认（单版场景） | 安装版 userData/appId/productName 区分归 S6（产物身份） | T2 |
| D7 | kernel-dist 为 gitignored 可再生产物（.gitignore:5 已有 `kernel-dist/` 预期）；不入 git | — | T1/T3 |
| D8 | `YFWORKING_KERNEL` 保留为唯一逃生口（沿用现名，不引入 PONOS_KERNEL 以免双名漂移；kernel/cli.mjs:5 注释中的 "findPonos 候选 #1" 措辞随 T3 注释改写统一为 YFWORKING_KERNEL） | — | T3 |

## 3. 残留引用消费映射（S4 backlog 22 行 → Task）

| Task | 消费 backlog 行 | 内容摘要 |
|---|---|---|
| T1 | —（构建链落地） | 迁 pd `scripts/build-kernel.mjs` → 本库产 `kernel-dist/cli.mjs`；实证 D1 |
| T2 | #8（随 home 自动）/ 部分 #9 | home env-aware 化（F6 全点 + main.cjs userData D6） |
| T3 | #1、#2、#3、#5、#6、#7、#19、#20、#21、#22 | kernel-paths/bridge 解析改接 + 兜底删除 + bootstrap 去 vendor/运行时 |
| T4 | #4、#9、#10、#11、#12、#13、#14、#15、#16、#17、#18 | 端口 env/默认值、启动器、打包配置、pet repoint、脚本、兜底 spawn 删除、品牌词注释 |
| T5 | —（接线测试） | 迁 pd kernel-bridge 测试族适配净室 + 更新受影响测试 |
| T6 | —（完结） | 双版冒烟矩阵 + roadmap 完结 + S5/S6 backlog 移交 |

> #22（.gitignore）无需动作：kernel-dist/ 已在忽略规则；T3 删分支后复核一次。

## 4. Task 明细

---

### T1：kernel-dist 构建链落地 + 运行时决策实证（D1）

**范围**：纯增量 + 验证，不动产品接线。产出 gitignored `kernel-dist/cli.mjs`。

步骤：
1. 从 pd 迁 `scripts/build-kernel.mjs`（版本化基线搬移，语义同 S3 kernel 迁入；文件自身为 pd 原创脚本）：
   - `cp -p C:\Users\T203-15\ponos-dev\scripts\build-kernel.mjs scripts/build-kernel.mjs`
   - 校对内容：`bun build kernel/cli.mjs --target=node --format=esm --external=node:* --outfile=kernel-dist/cli.mjs --minify`（pd scripts/build-kernel.mjs:20-31 原样）。
2. 运行 `node scripts/build-kernel.mjs`，预期 exit 0、`kernel-dist/cli.mjs` 生成。
3. **实证 D1**（运行时 = node）：
   - `node kernel-dist/cli.mjs --help` → 预期打印 usage、exit 0。
   - mock 轮次实证（协议闭环在 kernel-dist 下仍成立）：
     `PONOS_MOCK_API=1 node kernel-dist/cli.mjs --print --output-format stream-json --input-format stream-json --verbose --dangerously-skip-permissions --permission-prompt-tool stdio --disallowedTools AskUserQuestion --add-dir <TMP>`，向 stdin 写一个 user 消息 JSON，观察 stdout 出现 system(init)/assistant 消息（若 kernel-tests 有等价已测覆盖可引用，不重复造；至少 --help + init 到首轮响应）。
   - **决策记录**：node 跑通 → D1 生效；跑不通 → 记录 D1b（bun 随包），在 T3 决策处相应保留 bun 语义，并在本 task report 明示。
4. 回归：`npm test` 与 `kernel-tests` 全量（确认未受影响）。

**commit 范围**：`scripts/build-kernel.mjs`（新增，1 文件）。kernel-dist/ 被 ignore 不入 git（D7）。

---

### T2：home 数据根 env-aware 化（D2 + D6）

**范围**：F6 全部硬编码点 → 共享解析；main.cjs userData 隔离。

步骤：
1. 新建共享模块 `server/yfw-home.cjs`（CJS；ESM 侧 `import pkg from ...` 或 `createRequire` 复用——净室先例 kernel-paths.cjs 同型双兼容）：
   - `resolveYfwHome()` = `process.env.YFWORKING_HOME || process.env.CLAUDE_CONFIG_DIR || join(os.homedir(),'.yfworking')`（与 browser-common.cjs:115 完全一致，消除漂移）。
   - 导出 home/skills/logs 等派生（或仅 home，派生由各调用点 join）。
2. F6 全点改接（**保留变量名与语义，仅取值经 resolveYfwHome**）：
   - server/bridge.mjs:121（YFW_HOME）——注意模块加载期即解析，spawn env（:635-636 CLAUDE_CONFIG_DIR/YFWORKING_HOME）注入解析后 home
   - server/doubao.mjs:8-10、server/packager.mjs:8
   - electron/main.cjs:137、681、686（137 为模块级常量，解析同法）
   - electron/diag-monitor.cjs:41、electron/log-tee.cjs:29、electron/kernel-paths.cjs:28
   - scripts/verify-permission-flow.mjs:16
   - electron/browser-common.cjs:115 改为 require 共享模块（去本地重复）
3. main.cjs userData 隔离（D6）：`app` 事件最早处（`app.whenReady` 前，紧随 83 行 setAppUserModelId 附近的模块级/首个事件回调内）：`if (process.env.YFWORKING_HOME) app.setPath('userData', join(resolveYfwHome(), 'userData'))`——不改 default 行为。
4. 单测：为 yfw-home 解析写 `server/yfw-home.test.mjs`（设/删 env 断言三态；复用现有 YFW_TEST_HOME/隔离测试风格）。若既有测试依赖旧解析（如 diag-monitor.test、browser-common.test 已用 YFWORKING_HOME）保持通过。
5. **隔离实证**（关键验收）：
   - `YFWORKING_HOME="$TMPHOME" YFW_BRIDGE_PORT=51599 node server/bridge.mjs` 启动（或短命健康检查），确认日志 `[bridge] YFWorking home: <TMPHOME>` 且 `$TMPHOME` 下出现 skills/logs 等派生目录；Ctrl-C 或 timeout 结束后清理。
   - 回归：`npm test` 全量（重点 diag-monitor/log-tee/browser-common 套件不破）；kernel-tests 50/50。

**commit 范围**：server/yfw-home.cjs（新）、yfw-home.test.mjs（新）+ F6 各文件。

---

### T3：内核解析链改接（dev 主链 1 + bootstrap 主链 3）

**范围**：bridge/kernel-paths 全部 yfw-kernel 引用与旧兜底清零；运行时按 D1。

步骤（以 `git grep -n "yfw-kernel" server electron scripts` 逐行清）：
1. `electron/kernel-paths.cjs`：
   - 候选 3（:40 `yfw-kernel/claude-code/dist`）删除/改指 → 候选 3 = `<appRoot>/kernel-dist/cli.mjs`（bundle 形态，供构建后 dev 自选）+ 候选 1 `<appRoot>/kernel/cli.mjs`（源码）保留。注释同步（backlog #6）。
   - bun 语义：D1 生效后候选 `bun` 字段改 `node`（`install.node = process.execPath` 或 bundled node.exe）；`cachedBun`→`cachedRuntime`（名称按实现取舍，契约字段以调用点为准，勿留 bun 死名）。D1b 时保留 bun。
   - :28 yfwHome 经 T2 共享模块。
2. `server/bridge.mjs`：
   - `findYFWorking()`（527-571）重写为净室解析序：①`YFWORKING_KERNEL` env（保留，F9/D8，bun 名不引入）②kernel-paths 候选（install.kernel 命中 → `"<node>" "<kernel>"`；bundle/源码均可）③bootstrap 缓存兜底（缓存优先语义保留，路径随 T2 home）④**删除 565-570 `where claude*` last resort**（backlog #4），兜不到 → 抛清晰错误（`[bridge] kernel not found: set YFWORKING_KERNEL or run scripts/build-kernel.mjs`）或退出提示。
   - 529 注释改写（backlog #2）→ "built from kernel/ or kernel-dist — NOT stock Claude Code"。
   - 543-547 注释保留（机制延续，backlog #3）。
   - `bootstrapKernelToUserDir`（480-525）：按 D1 去 vendor 复制语义（F3），拷贝目标 = T2 home 下 runtime/kernel；bun→node 配套；D1b 时保留 vendor+bun 语义。
   - `ripgrepAvailable()`（695-711）及 buildChildEnv 的调用（680-682）删除或按 D1 判定：新内核无 rg（F3），`CLAUDE_CODE_USE_NATIVE_FILE_SEARCH` 注入不再必要（内核忽略未知 env）→ 删函数与注入，注释说明（旧内核 rg 语义不适用）。若回归测试断言该 env（grep 后确认），同步更新测试。
   - main.cjs:5 架构注释、server/transcript.mjs:3、src/lib/transcriptAdapter.ts:3/20/193 注释改写（backlog #7/#19/#20/#21）——transcript 格式语义不变，仅内核来源说明改写。
3. 验证：
   - `node server/bridge.mjs` 以默认 home 启动（health 检查），bridge 日志显示 `[bridge] YFWorking CLI: "<node路径>" "<库根>/kernel/cli.mjs"`（或 kernel-dist 路径）——**实际 spawn 行须指向本库内核**。
   - `YFWORKING_KERNEL="<某不存在路径>"` 启动 → 明确报错而非静默回退 claude。
   - `git grep -n "yfw-kernel" server electron scripts src bin *.yml *.cmd` → 预期 0（或仅剩 BUILD.md 文档类，若 grep 命中则归 T4/文档）。
   - 回归：npm test + kernel-tests。

**commit 范围**：kernel-paths.cjs、bridge.mjs、main.cjs(注释)、transcript.mjs、transcriptAdapter.ts（+ .test.ts 如断言改动）。

---

### T4：隔离矩阵端口/身份/启动器 + 打包配置接线 + 残留清扫

**范围**：backlog #4 兜底删除（若 T3 未覆盖则在此兜底）、#9、#10、#11、#12、#13、#14、#15、#16、#17、#18 + D4 端口默认值 + D5 CDP 修订记录。

步骤：
1. **端口 env 化 + 新默认值（D4）**：
   - `vite.config.ts:42/47`：server.port ← `Number(process.env.YFW_VITE_PORT || '5197')`、preview.port ← `Number(process.env.YFW_VITE_PREVIEW_PORT || '4197')`；:11 `__BRIDGE_PORT__` 默认 51309→51517。
   - `server/bridge.mjs:21`、`electron/main.cjs:161`、`electron/diag-monitor.cjs:119`、`bin/cli.mjs:10`：默认 51309→51517。
   - 前端/测试中**显式 URL 字面量**（如 transcriptAdapter.test.ts 的 baseUrl localhost:51309）为 mock 注入值——保留语义不动；但**默认/回退语境**的 51309/5173/4173 字面量必须逐处人工判断改默认值。
   - `electron/browser-executor.test.mjs:155` 等 isBlockedUrl 白名单判定若写死 5173：改判逻辑须与 vite dev 新默认（5197）或 env 一致（读该函数实现决定放行集合来源；若其放行 localhost 任意端口则无需改）。
   - `bin/cli.mjs:11` VITE_PORT=5173 → env 化（YFW_VITE_PORT 默认 5197）。
   - `start.bat`：端口默认值同步 + 全 env 可覆盖。
2. **启动器（backlog #17）**：`bin/yfworking.cmd` 重写为净室 launcher：设 home env → `where node` → `node "%~dp0cli.mjs"` dev 兜底（删除 where claude* 三支与 claude.cmd %* 转发）；`start.bat:2` title 品牌词（#18）改净室名。
3. **脚本改接**：
   - `scripts/package-portable.cjs`：:127-137 kernelSrc/kernelVendorSrc → `ROOT/kernel-dist/cli.mjs`（bundle 单文件；**无 vendor**，:137-141 vendor 段删除）；:142-149 bunSrc 段删除（D1）或注释；:95 petSrc → `ROOT/pet`（#14，去掉 fail-silent 隐患——pet/ 在库必在，existsSync 守卫可留可去但路径改对）。
   - `scripts/verify-permission-flow.mjs:15`：KERNEL → `join(cwd,'kernel-dist','cli.mjs')`（或 kernel/cli.mjs 源，二选一注释说明）——backlog #16。
   - `electron/main.cjs` resolvePetScript :1265 YF 兜底删除（#15，库内 pet/ 候选 :1261-1263 已先命中）。
4. **打包配置接线（主链 4，不实跑）**：
   - `electron-builder.yml:77-86`：kernel extraResources `from: yfw-kernel/claude-code/dist` → `from: kernel-dist`，filter 仅 `cli.mjs`（去 vendor/**，F3）。
   - :89-92 bun extraResources 段删除（D1）或改 node.exe 注释（files 已含 node.exe:30）。
   - :70-76 pet 三条 `from: YF/jiajia-pixel-pet/...` → `from: pet/jiajia-pet.py` / `from: pet/accessories_lib.py` / `from: pet/assets`（to 不变）（#11）。
   - appId/productName（:1-2）**不动**（S6 产物身份决策）。
5. **diag-monitor 适配（#9）**：:194 kernel-runtime-rg 探针改判——净室 kernel 无 rg（F3），该项改为探测 `<home>/runtime/kernel/cli.mjs` 存在性（内核进程可跑）或整项移除并注释；与 T3 bootstrap 布局复核一致（#8 的 kernel-stderr 布局不变，随 home 自动）。
6. **验证**：
   - `git grep -n "yfw-kernel\|YF/jiajia\|where claude\|claude.cmd" --include 产品树(排除 docs/kernel)` → 预期 0（残留清零里程碑；BUILD.md 若含 YF 引用记入 S6 文档清洗 backlog）。
   - 默认值一致性检查：grep 确认 51517/5197/4197 默认值落地点成对（代码默认 vs env 回退）。
   - `npm run typecheck`、`vite build`、`npm test` 回归。
7. **roadmap 修订（D5）**：`2026-09-07-s3-s6-cleanroom-roadmap.md` S4 节或执行记录处加一行 CDP 隔离修订说明（进程内 CDP 无网络口；52319 仅测试口）。

**commit 范围**：上述文件分批 scoped commit（端口/启动器一批、打包配置一批、脚本一批，或按改动域合理分组）。

---

### T5：接线测试（协议契约偏差兜底）

**范围**：净室此前**无任何 spawn 真内核的测试**（调研 F0）——补 bridge↔内核协议闭环测试，使"新内核与产品 server 协议"以测试锁定（设计 §13 开放项）。

步骤：
1. 参照 pd `server/kernel-bridge.test.mjs`（PONOS_KERNEL + PONOS_MOCK_API + node 当运行时）迁一版适配净室：净室内核名/PONOS_MOCK_API 已随迁（F5）；测试放 `server/kernel-bridge.test.mjs`。
   - 覆盖：spawn 内核（`node kernel/cli.mjs`）→ 发 user → 收 system(init)/assistant → control_request(cancel 或 high-risk) → control_response 闭环；session/resume 参数兼容。
   - 环境：`YFWORKING_HOME` 指向测试临时目录（不碰真实 ~/.yfworking——沿用净室既有 YFW_TEST_HOME/隔离风格），`PONOS_MOCK_API=1` 免网络。
   - **注意 npm test glob**（`server/*.test.mjs`）会收录新测试 → 必须能在无真实 config 下通过（mock + 隔离 home）。
2. 断言既有测试不受 T1-T4 改动影响并修正任何被默认值/解析改动波及的断言（如端口默认、kernel 路径相关 mock）。
3. 验证：`npm test` 全量（预期原 130 + 新增）与 kernel-tests 50/50；隔离 home 下无网络也能跑（mock）。

**commit 范围**：server/kernel-bridge.test.mjs（新）+ 必要测试修正。

---

### T6：双版并行冒烟 + roadmap 完结 + S5/S6 backlog 移交

**范围**：终验收 + 文档完结。

步骤：
1. **双版冒烟矩阵**（同用例两版各跑一遍对照；本机旧版 = cg 工作树 dev）：
   | 用例 | 旧版（cg dev） | 新版（净室 dev env） | 判据 |
   |---|---|---|---|
   | bridge 健康 | 51309 /health 200 | 51517 /health 200 | 各 200 `"status":"ok"` |
   | GUI dev | 5173 | 5197（YFW_VITE_PORT） | 各可达 |
   | 内核 spawn | — | bridge 日志 spawn 行指向本库 kernel/ 或 kernel-dist | 无 yfw-kernel |
   | 会话一轮 | 真 provider 或跳过 | `PONOS_MOCK_API=1` 一轮 stream-json | result 正常 |
   | 数据根 | ~/.yfworking（不动） | 隔离 TMP/专用 home | 两版目录互不写入对方 |
   | userData | %APPDATA%\yfworking-gui | <新 home>/userData（D6） | 两版 theme 独立 |
   | 同时运行 | 两版同开，端口/数据根无冲突 | — | 无端口占用失败 |
   执行方式：新版启动命令全 env（`YFW_BRIDGE_PORT=51517 YFW_VITE_PORT=5197 YFWORKING_HOME=<新home> node server/bridge.mjs` + vite 同 env）；旧版用 cg 现状命令。真实 API 会话为**可选人工项**（需新 home 内 config.json，可复制用户 config 或在 GUI 配置；mock 闭环已覆盖协议）。
2. **文档完结**：
   - `docs/bridge-contract.md`：进程拓扑/§2 spawn 契约中 bun 表述 → node（D1）；bootstrap 目标目录与 vendor 段更新（F3）；`YFWORKING_KERNEL` 说明保留；端口默认值更新 51517/5197/4197 + 双版 env 对照表。
   - `docs/superpowers/plans/2026-09-07-s3-s6-cleanroom-roadmap.md` S4 节：四【推进标注】勾选 + 「执行记录」段（commit 链、D1-D8 决策记录、隔离实测数值、双版冒烟结果）+ S5 backlog 指针。
3. **S5 backlog 移交**：以 T3/T4 完成态做残留复查（`git grep yfw-kernel/Claude/ANTHROPIC 白名单外`），清点仍属 S5（协议增强移植）候选的差异（S1 清单②）与 S6 项（installer.nsh 技能数、手册版本、build_promo_pdf BASE 参数化、BUILD.md YF 文档引用、产物身份 appId、CRLF/.gitattributes 字节复核）写入完结报告（scratch，仿 S3 移交）。
4. **完结判定**：双版冒烟表全过、全量测试绿、`git grep yfw-kernel`（产品树）0 命中、工作树干净、scoped commits。

**commit 范围**：bridge-contract.md、roadmap（docs）+ 完结报告 scratch（不入 git）。

## 5. DoD（本子工程）

- 产品树（src/server/electron/scripts/bin/build）`yfw-kernel`、`YF/`、`where claude*`、`claude.cmd` 引用 **0 命中**（白名单协议字段名除外）。
- bridge 实际 spawn 内核 = 本库 `kernel/` 或 `kernel-dist/cli.mjs`（日志实证）；`YFWORKING_KERNEL` 逃生口可用。
- home 解析全库统一 `YFWORKING_HOME || CLAUDE_CONFIG_DIR || ~/.yfworking`；隔离 home 实证通过。
- 端口默认值 51517/5197/4197 env 可覆盖；双版（cg v2.7.5 vs 净室）同机并行无端口/数据根/userData 冲突。
- `npm test` 全绿（≥130，含新增接线测试）、kernel-tests 50/50、typecheck/build 通过。
- 决策记录（D1-D8）与遗留（S5/S6）在 roadmap/完结报告可追溯。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| D1 node 跑 kernel-dist 失败（bundle 有 bun 特有依赖） | T1 早实证；失败走 D1b（bun 随包 + 保留 vendor/bun 语义），T3/T4 相应分支 |
| 5173 等端口字面量散布前端/测试/白名单，漏改导致双版误连 | T4 全库 grep 5173/51309/4173 逐处人工判定"默认/回退 vs 显式测试值"；双版冒烟兜底 |
| yfw-home 改接引入漂移（多处 home 不一致） | 共享模块单一来源 + 隔离实证 + diag/browser-common 既有测试回归 |
| kernel-bridge 测试收录进 npm test 后 flaky（spawn 类） | 沿用 pd 既有稳定化设置（mock、隔离 home、超时）；若 flaky 按 P2-11 治理 |
| 现有 2 环境性失败测试（browser-executor whitelist/transcript mtime） | 非本子工程引入；维持基线 2 失败不动 |
