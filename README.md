# YFWorking 源码自述文档

> **本文档的产出方式**：全文结论来自对仓库**真实源码**的阅读（函数名、常量、分支、协议字段、数值、脚本命令），每条关键断言都标注 `文件:行`。**代码注释与既有文档只用于定位，不作为结论依据**；凡注释与代码冲突，一律以代码为准，并在 §8「注释与代码不一致清单」中列出。
>
> **取证基线**：分支 `feature/app-universal-onboarding`，HEAD `c37054b`（2026-09-16），git 跟踪文件 **1315** 个，提交数 **483**（首次提交 2026-09-07）。工作树干净（含 ignored 检查）。
>
> **复核方式**：本文所有 `file:line` 均可直接跳读；§5 的量化结论与 §3 的命令均给出一行可复现命令。

---

## 1. 项目概览

### 1.1 三个可独立运行的部分

| 部分 | 入口 | 形态 |
|---|---|---|
| **Agent 内核**（Ponos-turbo） | `kernel/cli.mjs` | 零第三方依赖的 Node CLI，可单独跑（`node kernel/cli.mjs --print …`） |
| **桥 / 本地服务** | `server/bridge.mjs` | HTTP + WebSocket 同端口服务，唯一中枢：同时对接前端、内核进程、Python 脚本、知识库、工作流 |
| **界面** | `src/main.tsx`（Vite 构建）、`electron/main.cjs`（桌面壳） | 同一份前端 bundle 既可在 Electron 里跑，也可直接在浏览器里跑 |

三者关系由代码可证：`electron/main.cjs:523` 启动 bridge 并等待 `/health`；`server/bridge.mjs:1251` 以 `spawn` 拉起内核进程并走 stdio 通信；前端只认 bridge 的 `51517`（`src/lib/bridgeBase.ts:20`、`vite.config.ts:11`）。

### 1.2 代码规模（`git ls-files` + `wc -l` 实测）

| 目录 | 文件数 | 行数 | 职责 |
|---|---:|---:|---|
| `kernel/` | 66（其中 62 个 `.mjs`） | 25,812 | Agent 内核：主循环、工具、权限、上下文/压缩、知识、工作流、MCP |
| `src/` | 306 | 57,642 | React GUI：组件 156、lib 118、stores 20、i18n、styles |
| `server/` | 102 | 21,518 | bridge 及路由：知识、工作流、备份、日志、导入任务、审批 |
| `electron/` | 39 | 11,457 | 桌面壳：窗口、IPC、密码库、浏览器执行器、诊断、宠物 |
| `kernel-tests/` | 183 | 32,797 | 内核测试（181 个 `*.test.mjs` + 2 个 fixture stub server） |
| `shared/` | 10 | 3,699 | kernel 与 server 共用的纯函数层（5 个实现 + 5 个测试） |
| `scripts/` | 26 | 3,682 | 构建/打包/校验脚本 |
| 其它 | — | — | `build/`、`pet/`、`workflows/`、`public/`、配置与文档 |

测试文件合计 **417** 个：`shared/` 13、`server/` 90、`electron/` 12、`kernel-tests/` 210、`src/` 74（全部为 `.test.ts`，无 `.test.tsx`）、`kit/` 18 —— 见 §3.6。
★ 口径（铁律 4）：这是**盘根干净克隆** `<盘根目录>/<克隆名>@ba878fa` 的 `git ls-files` 实测值（= `docs/_anchors.json#testTotal`，与 `npm test` 的 glob 分组一致）；**主树含他人在途改动为 427**（`server/` 93、`src/` 81，其余同）。上面那张表是**另一口径**（各目录文件总数，非测试文件名录），未随本行同步重算。

### 1.3 版本线（四条，实测）

| 版本实体 | 值 | 载体 |
|---|---|---|
| `APP_VERSION` | `dev 3.0.0` | `version.mjs:9` |
| `KERNEL_VERSION` | `dev 0.2` | `version.mjs:12`（对应 `kernel/package.json` `"version": "0.2.0"`） |
| `SCHEMA_VERSION` | `1` | `version.mjs:15`（settings 文件 schema） |
| GUI 发布线 | `2.8.0` | `package.json:3`，经 `vite.config.ts:10` 以 `__APP_VERSION__` 注入前端 |
| 构建标识 | `PONOS_BUILD_ID` 或 `'dev'` | `version.mjs:20-21` |

`scripts/bump-version.mjs` 只改 `version.mjs`（app/kernel 两条）与 `kernel/package.json`（仅 kernel 线，`:67-80`），**不触碰根 `package.json` 的 version**。

### 1.4 技术栈（依据 `package.json` 依赖段与 import 实证）

- **前端**：React 18.3 + TypeScript 5.7 + zustand 4.5（14 个 store）+ Radix UI（声明 7 个包，**7 个全部在用** —— 原先的 11 个声明里 `collapsible`/`context-menu`/`popover`/`separator` 零引用，已于 2026-09-19 删除，见 §4.8 第 8 条）+ Tailwind 3.4 + CodeMirror 6（20 个语言包）+ `@xyflow/react` 12（工作流画布与知识图谱）+ `@assistant-ui/react` 0.15（聊天线）+ `react-markdown`/`remark-gfm`。
- **服务端**：Node 原生 `http` + `ws`（实测在用：`server/bridge.mjs`、`electron/main.cjs`）；Office/表格解析由 **Python 脚本**承担（如 `server/convert_xls.py` 走 openpyxl/xlrd），不由 npm 包承担 —— 原先并列的 `classic-level`/`xlsx`/`mammoth` 已于 2026-09-19 按依赖台账删除（实测零引用，见 §4.8 第 8 条）。
- **内核**：**零第三方依赖**——`kernel/package.json` 无 `dependencies` 键，且 `server/deploy-smoke.test.mjs` 断言其恒为空；内核只 import `node:*` 内置模块，故可被 `bun build --external=node:*` 打成单文件。
- **桌面/构建**：Electron 43 + electron-builder 26 + Vite 5.4 + `bun build`（仅用于内核 bundling）+ 内嵌 Python 3.12。

---

## 2. 运行与启动方法

### 2.1 环境前提（实测本机版本）

| 项 | 本机实测 | 约束出处 |
|---|---|---|
| Node.js | v24.14.1 | `kernel/package.json` 声明 `engines.node >= 18`；`npm test` 依赖 Node 原生 TS 类型剥离（`node --test src/**/*.test.ts` 实测通过） |
| npm | 11.11.0 | 应用依赖安装（`package-lock.json` 已入库） |
| bun | 1.3.14 | **仅**构建内核 bundle 时必需（`scripts/build-kernel.mjs:24`）；`bun.lock` 亦入库 |
| Python | 可选 | 仅 Office 文档转换/OCR/Excel 等能力需要；开发态可用系统 Python，分发态用 `runtime/python`（内嵌 3.12） |

仓库根**没有** `.env` / `.env.local`（且被 `.gitignore:8-9` 忽略），环境变量需外部注入，见 §2.7。

### 2.2 形态一：浏览器形态（最省事）

```bat
REM 方式 A：双击/命令行运行仓库自带脚本
start.bat

REM 方式 B：走 npm bin（等价逻辑，另在 4s 后自动开浏览器）
node bin/cli.mjs
```

`start.bat` 逐行行为（`:11`–`:49`）：设 `YFW_BRIDGE_PORT=51517`、`YFW_VITE_PORT=5197`、`YFWORKING_HOME=%USERPROFILE%\.yfw` → `netstat` 清理两个端口残留监听 → `start /MIN cmd /c "node server\bridge.mjs"` → `start /MIN cmd /c "npx vite --host 0.0.0.0 --port 5197"` → 等 3s 打印访问地址。
`bin/cli.mjs` 行为（`:40-106`）：`spawn('node', ['server/bridge.mjs'])` + `spawn('npx', ['vite','--host','0.0.0.0','--port','5197'])` → 3s 后打印方框 → 4s 后 `start "" <url>` 打开浏览器 → `SIGINT/SIGTERM` 双杀子进程。

然后浏览器打开 `http://localhost:5197`。**两条路径都不启动 Electron**。

### 2.3 形态二：Electron 桌面（开发态）

```bash
npm install
npm run dev                 # 终端 1：vite dev server（5197，strictPort）
npx vite --port 5197 &      # 若上一条已在前台，忽略此条
VITE_DEV_SERVER_URL=http://localhost:5197 npx electron .   # 终端 2（Git Bash / WSL）
```

- `package.json:12` 的 `npm run electron` 就是这条命令的封装，但它用的是 **POSIX 内联环境变量语法**，在 `cmd.exe` / PowerShell 下不成立——Windows 原生命令行请显式 `set VITE_DEV_SERVER_URL=…` 或用 Git Bash。
- Electron 自己负责拉起 bridge：`electron/main.cjs:523` `startBridgeAndWait()` → `:280` `spawn(resolveNode(), [server/bridge.mjs], { env: {…, YFW_BRIDGE_PARENT_PID: String(process.pid)} })`。
- `resolveNode()`（`:243-246`）优先用 `<appRoot>/node.exe`（分发态内置），仓库根当前**没有** `node.exe`，故开发态回落 PATH 上的 `node`。
- 就绪判据（`:477-491`）：`/health` 重试 30 次 × 500ms（最长 **15s**），且响应体必须匹配 `/"status"\s*:\s*"ok"/`（`:210-227`，超时 800ms）。

启动序列（`app.whenReady`，`electron/main.cjs:1614-1646`）：
1. `YFWORKING_HOME` 缺省 = `%USERPROFILE%\.yfw`（`:30-32`，必须早于 `initLogTee()`）；
2. `app.setPath('userData', <YFWORKING_HOME>/userData)`（`:39-42`）；
3. `bootPhase('mainReady')` → `await registerIpc()`；
4. **回收残留桥**：`findPortPid(51517)` + `isBridgeProcess()` → 命中则 `taskkill` 并等 500ms；
5. `startBridgeAndWait()`（含 `waitForBridge`，15s 上限）；
6. `startBootProgressPoll()`：每 **300ms** 拉 `/boot-status`，四步 `bridge/kernel/skills/provider`；
7. 先建 **认证小窗**（`?auth=1`，420×560，无边框）；主窗口只在收到 `auth:granted` 后创建；
8. `createTray()` / `connectPetBridgeListener()` / `connectBrowserExecutor()`。

### 2.4 形态三：只跑内核（headless，无需 GUI）

```bash
node kernel/cli.mjs --help
# 契约：必须 stream-json 双向（REQUIRED_FORMAT，kernel/cli.mjs:66；不满足则 stderr + 退出码 2，:330-333）
node kernel/cli.mjs --print --output-format stream-json --input-format stream-json --verbose \
  --approval-mode loose --add-dir /path/to/skills

# 只读子命令（单行 JSON 输出，不进主链路）：kernel/cli.mjs:344-352
node kernel/cli.mjs --usage
node kernel/cli.mjs --audit
node kernel/cli.mjs --agents

# 知识子命令（动态 import knowledge-cli.mjs，避免普通会话付解析成本）kernel/cli.mjs:354-427
node kernel/cli.mjs --knowledge search --text "关键词"
```

注意：`parseArgs` 是**手写 switch 白名单**（`kernel/cli.mjs:78-280`），**未登记的 `--xxx` 参数会被静默忽略**（`:275-278`）——传错参数不会报错。

### 2.5 形态四：分发态（便携版 / 安装包）

| 产物 | 命令 | 关键前置 | 实测现状 |
|---|---|---|---|
| 内核单文件 bundle | `node scripts/build-kernel.mjs` | 需要 `bun` | `kernel-dist/cli.mjs` = **482,161 B** |
| 前端产物 | `npm run build`（= `tsc && vite build`） | `tsc` 只做类型检查（`tsconfig.json:12` `noEmit:true`） | `dist/` = 13 MB |
| 内嵌 Python | `node scripts/build-embedded-python.mjs` | 需联网下载 | `runtime/python` = **415 MB**（Python 3.12.0 embed + 13 个包） |
| 安装包 | `node scripts/build-installer.mjs` → `npx electron-builder --win nsis` | Python + skills + `npm run build` + 临时复制 `node.exe` | `release/installer/` **当前不存在**（本机无产物） |
| 便携目录 | `node scripts/package-portable.cjs` | `dist/ kernel-dist/ runtime/` 齐备 | `release/YFWorking/` = **1.4 GB** |
| 便携 zip | `node scripts/package-portable-zip.mjs` | — | `release/YFWorking-portable-debug-2.8.0-20260914.zip` = 1,277,000,770 B（压缩率 90.2%） |

`scripts/build-installer.mjs` 四步：`[1/4]` 检查/生成 `runtime/python`（超时 600s）→ `[2/4]` 用 `~/.yfworking/skills` 覆盖 `runtime/skills` → `[3/4]` `npm run build`（超时 120s）→ `[3.5]` 把 `process.execPath` 复制成仓库根 `node.exe` → `[4/4]` `npx electron-builder --win nsis`（超时 600s，`NODE_ENV=production`），`finally` 里删除临时 `node.exe`。

> ⚠️ **`npm run build:electron` ≠ 出安装包**：它只是 `npm run build && electron-builder`（`package.json:17`），不跑 Python/skills 前置，也不生成临时 `node.exe`，而 `electron-builder.yml:37` 的 `files` 段又声明了 `node.exe`。

### 2.6 端口与路径（源码常量，逐处实证）

| 端口 | 用途 | 证据 |
|---|---|---|
| **51517** | bridge HTTP + WebSocket（同端口复用） | `server/bridge.mjs:79`、`electron/main.cjs:206`、`bin/cli.mjs:10`、`vite.config.ts:11`、`src/lib/bridgeBase.ts:20` |
| **5197** | Vite dev server（`strictPort: true`） | `vite.config.ts:50-51`、`start.bat:14`、`bin/cli.mjs:11` |
| **4197** | Vite preview | `vite.config.ts:55` |
| 52319 | 仅 `server/interject.e2e.mjs:7` 的 e2e 用 | — |

数据根 `YFWORKING_HOME`（缺省 `%USERPROFILE%\.yfw`）下的实测落点：`userData/`（Electron userData、`profile.json`）、`settings.json`、`config.json`、`skills/`、`tools/`、`knowledge/spaces/`、`workflows/`、`workflow-runs/`、`logs/kernel-stderr.log`、`apps/registry.json` —— 见 `server/bridge.mjs:161-164,592,817,848-849,918`。

### 2.7 环境变量（按模块归类，`process.env` 实收：kernel 94 个、server 30 个、electron 7 个、scripts 12 个）

代表性清单：

| 类别 | 变量（默认值） | 证据 |
|---|---|---|
| 端口/根 | `YFWORKING_HOME`、`YFW_BRIDGE_PORT`(51517)、`YFW_VITE_PORT`(5197)、`VITE_DEV_SERVER_URL`、`VITE_BRIDGE_URL` | `electron/main.cjs:30,206`、`vite.config.ts:50`、`src/lib/config.ts:15` |
| 进程关系 | `YFW_BRIDGE_PARENT_PID`（父进程守护）、`YFW_BRIDGE_NO_LISTEN`（测试隔离） | `electron/main.cjs:291`、`server/bridge.mjs:3064` |
| 内核选择 | `YFWORKING_KERNEL`（显式内核路径，D8 唯一逃生口） | `server/bridge.mjs:763-766` |
| WS 心跳 | `YFW_WS_HEARTBEAT_MS`(30000)、`YFW_WS_PONG_GRACE_MS`(3×心跳)、`YFW_WS_PONG_HARD_MS`(300000) | `server/bridge.mjs:2841-2846` |
| 内核回收 | `YFW_KERNEL_IDLE_MS`(10min)、`_TURN_REAP_MS`(20min)、`_WAIT_EXEMPT_MS`(30min) | `server/bridge.mjs:2885,2891,2895` |
| 内核守卫 | `PONOS_LOOP_GUARD`、`PONOS_LOOP_MAX_ITERATIONS`、`PONOS_STREAM_IDLE_MS`、`PONOS_OVERFLOW_MAX_RETRIES`、`PONOS_LANE_MAX_CONCURRENT` | `kernel/engine-config.mjs:34-203` |
| 输出预算 | `PONOS_MAX_OUTPUT_TOKENS`(64000) | `kernel/engine.mjs:63` |
| 计费 | `PONOS_PRICE_PER_M_INPUT/OUTPUT`、`PONOS_CACHE_READ_RATIO`、`PONOS_BUDGET_USD` | `kernel/engine.mjs:155-162` |
| Mock/测试 | `PONOS_MOCK_*`（22 个）、`PONOS_TEST_HOME` | `kernel/api.mjs:265+` |

**命名契约与兼容垫片**（2026-09-16 起）：自主实现的环境变量**一律以 `PONOS_` 为主名**，包括端点与模型契约（`PONOS_BASE_URL`／`PONOS_AUTH_TOKEN`／`PONOS_MODEL`／`PONOS_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL`／`PONOS_AUTH_SCHEME`／`PONOS_API_KEY`）与配置根 `PONOS_CONFIG_DIR`。
历史旧名（Anthropic 兼容协议时代的 `ANTHROPIC_*`、早前内核的 `CLAUDE_CODE_*`，共 35 个）由**唯一映射实现** `shared/legacy-env.mjs` 兜底，语义为**主名优先、旧名仅兜底、旧名不删除**：

- 垫片必须早于任何模块顶层读 env，故以 `kernel/legacy-env-boot.mjs` 作为 `kernel/cli.mjs` 与 `server/bridge.mjs` 的**首个 import**（`engine-config.mjs` 在顶层读 env，晚于该模块即失效）；
- settings.json 里的旧键在 `loadSettings()` 合并 env 之后由同一映射二次兜底；
- wire 层不受影响：HTTP 头 `anthropic-version`（`2023-06-01`）与请求体字段仍是 Anthropic Messages API 兼容协议的事实标准，**不参与改名**；
- 契约测试 `shared/legacy-env.test.mjs`（8 例）锁定以上语义，并显式断言 `ANTHROPIC_VERSION` 不在映射表内。

### 2.8 测试与校验命令

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --test --test-timeout=300000，6 组 glob（417 个测试文件：干净克隆 <盘根目录>/<克隆名>@ba878fa；主树含他人在途改动为 427）
node scripts/verify-portable-layout.mjs     # 便携布局校验（需 S6_TEST_DESKTOP 等环境）
node scripts/verify-gui-fidelity.mjs        # GUI 保真度（需 electron + 图形会话）
```

实测全量测试基线（本机 `.tmp-testF.log`，2026-09-15）：`tests 2892 / suites 7 / pass 2890 / fail 1 / skipped 1 / duration_ms 88195`；唯一失败为 `kernel-tests/app-tools-mount.test.mjs:181` 的 `rmSync` **EPERM**（Windows 临时目录清理竞态，非断言失败）。
**11 个 `scripts/verify-*.mjs` 均未挂进任何 npm script**，须手工执行；其中 GUI/权限流两个需要图形会话或真内核，不属 CI 可跑范围。

---

## 3. 架构描述

### 3.1 分层与进程拓扑

```
┌─────────────────────────────────────────────────────────────────────┐
│ 渲染层（同一份 Vite 产物，Electron 与浏览器共用）                    │
│ src/main.tsx → App.tsx → 4 类窗口根 + MainApp(ViewRouter)            │
│ 状态：14 个 zustand store（7 个 persist 到 localStorage）            │
│ 传输：WebSocket 单例（业务）+ fetch（配置/知识/工作流/用量等 15 模块）│
└───────────────┬─────────────────────────────────┬───────────────────┘
                │ ws://127.0.0.1:51517            │ contextBridge
                ▼                                 ▼
┌──────────────────────────────┐   ┌──────────────────────────────────┐
│ server/bridge.mjs（唯一中枢）│   │ electron/main.cjs（桌面壳）      │
│ HTTP + WS 同端口；路由 40+   │   │ 窗口/IPC/密码库/浏览器/诊断/托盘 │
│ 知识库、工作流、备份、日志   │◀──│ 57 个 ipcMain.handle + 10 个 .on  │
└───────┬──────────────────────┘   └──────────────────────────────────┘
        │ stdio（NDJSON，一行一个 JSON）
        ▼
┌──────────────────────────────────────────────┐    ┌─────────────────┐
│ kernel/cli.mjs（每个会话一个进程，Ponos-turbo）│    │ Python 子进程   │
│ engine 主循环 → 工具 → 守卫 → 压缩 → 工作流   │───▶│ runtime/python  │
│ 零第三方依赖，可打成单文件 kernel-dist/cli.mjs│    │ (Office/OCR/表格)│
└──────────────────────────────────────────────┘    └─────────────────┘
```

### 3.2 两跳通信（协议实证）

**第一跳：前端 ↔ bridge（WebSocket，端口 51517）**
- 前端 side：模块级单例 `ws`（`src/hooks/useYFWCLI.ts:50-51`），`getWsUrl()` 把 `http→ws`（`src/lib/config.ts:18-20`）；**不使用 EventSource / SSE**。
- 顶层下行事件类型（`useYFWCLI.ts:890` 分发处）：`pong`、`bridge_hello`、`kernel-stall`、`approval-mode-changed`、`approval-mode-degraded`、`approval-mode-rejected`、`event`、`browser:event`、`error`、`cancelled`、`closed`、`question`、`question-resolved`、`approval`、`approval-resolved`、`approval-expired`、`milestones`、`milestone-start`、`milestone-ok`、`provider_updated`、`knowledge_changed`。
- 内层 `event.type`（`:959-1295`）：`system`（子类型含 `first_byte_pending`/`init`/`task_started`/`task_progress`/`task_notification`/`compaction`/`lane_compaction`/`mcp_status`/`loop_result`）、`ponos_health`/`yfw_health`、`yfw_summary`、`ponos_warning`、`tool_result`、`command_lifecycle`、`loop`、`assistant`、`result`。
- 上行：`{type:'cancel'}` 取消、`browser_control` 控浏览器（`:594-601`）、会话 payload 由 `buildSendPayload`（`:379`）携带 `cwd/mode/resumeId/systemPrompt/model/compactCount/knowledgeSpaces`。
- 心跳与重连：客户端 15s 发 `{type:'ping'}`、60s 无活动判死（`useYFWCLI.ts:73-74`）；重连退避 `min(2000×2ⁿ, 10000)`（`:127-139`）；桥侧 30s 发心跳、`3×心跳` 宽限、`5min` 硬阈值（`server/bridge.mjs:2842-2846`），窗口不可见/后台时用 `buffered > 2MB` 或 `since >= PONG_HARD_MS` 兜底关闭（`:2857`）。

**第二跳：bridge ↔ kernel（stdio NDJSON，一行一条 JSON）**

spawn 契约（会话进程，`server/bridge.mjs:1251`）：

```
node kernel/cli.mjs --print --output-format stream-json --input-format stream-json --verbose
  [--approval-mode manual|auto|loose|bypass]     # :1252-1270（loose/bypass 另附 --dangerously-skip-permissions）
  [--session-mode chat --disallowedTools <CHAT_DISALLOWED>]   # :1271-1274（chat 会话禁工具）
  [--resume <sessionId>] [--add-dir <skillRoot>]
```
- 内核定位：`YFWORKING_KERNEL` 显式覆盖 → `kernel-dist/cli.mjs`；spawn 时 `shell:true` 且 `[YFWORKING, ...args].join(' ')`（`:1364`，args 已逐个加引号转义）。
- Python 辅助脚本同类：`spawn(findPythonExe(), [scriptPath, …], { timeout: 15000 })`（`:1965`、`:1987`），stdout 必须是单行 JSON。

### 3.3 内核模块地图与 Agent 主循环

**入口与生命周期**（`kernel/cli.mjs`）：
1. 仅直接执行时进 `main()`：`import.meta.url === pathToFileURL(process.argv[1]).href`（`:1567`），失败退出码 1；
2. 手写参数白名单 `parseArgs`（`:78-280`）→ 格式硬门 `stream-json`（`:330-333`）→ 分支：只读子命令（`:344-352`）、知识子命令（`:354-427`，动态 import）、`--help`（`:268`）；
3. `main()` 顺序（代码顺序即执行顺序）：`makeWire()`（`:429`）→ `sessionId = args.resume || newSessionId()`（`:432`）→ `configDir`（`:434`）→ 技能根 `skillRoots`（`:440`，`resolveSkillRoots` `:307-316`）→ 平铺根白名单（`:449`）→ shared 目录并入 `addDirs`（`:455`）→ `loadSettings` 分层合并（`:454`）→ settings.env 回填。

**主循环骨架**（`kernel/engine.mjs` `createEngine({opts, wire, session, compactor, health})`，`:52`）：
- 每轮循环：模型请求（`kernel/api.mjs`）→ 流式分片 → 工具调用装配 → 工具执行 → 结果回灌 → 再循环；四条出口：迭代上限、错误连击、循环停滞、明确收尾。
- 关键限值都来自 `kernel/engine-config.mjs`（可被环境变量覆盖）：

| 常量 | 默认 | 含义 | 证据 |
|---|---:|---|---|
| `MAX_TOOL_ITERATIONS` | **0（不限）** | 单轮工具迭代上限；显式设 `PONOS_LOOP_MAX_ITERATIONS` 才生效 | `engine-config.mjs:41-45` |
| `TURN_TIMEOUT_MS` | **0（不限）** | 轮次墙钟上限（2026-09-10 取消 30 分钟硬上限） | `:51` |
| `MAX_OVERFLOW_RETRIES` | 12 | 上下文溢出重试上限（防 1MB 请求无界重发） | `:58` |
| `STREAM_IDLE_MS` | 300_000（5min） | 流式中段停顿判挂起 | `:64` |
| `STREAM_FIRST_BYTE_MS` / `FIRST_BYTE_HARD_CAP_MS` | 300_000 / 480_000 | 首内容宽限（prefill + 隐藏思考） | `:75-76` |
| `MAX_ERROR_ITERATIONS` | 6 | 连续错误熔断 | `:141` |
| `NEAR_REPEAT_RECENT / AVG / SIM / BACK` | 10 / 1.2 / 0.6 / 48 | 近似重复输出检测 | `:160-163` |
| `OUTPUT_TIERS` | `[8192,16384,32768,65536]` | 输出预算档位（截断后续接） | `:181` |
| `LANE_MAX_CONCURRENT` | 4 | 后台子 Agent（lane）并发上限，超限排队 | `:203`（排队逻辑 `engine.mjs:1970-1976`） |
| `LOOP_STALL_MS` / `STALL_HEAL_MAX` | 600_000 / 2 | 循环停滞自愈 | `:198-199` |
| `UPSTREAM_DEAD_HEAL_MAX` / `_BACKOFF_MS` | 2 / 30_000 | 上游假死自愈与退避 | `:188-189` |
| `IDLE_DEAD_RETRY_MAX` / `_BACKOFF_MS` | 3 / 3000 | 零数据挂起重试 | `:125-126` |
| `FID_ANCHOR_MAX_CONSEC` / `_REINJECT_EVERY` | 2 / 8 | 失真锚点注入节奏 | `:120-121` |
- 预算与安全阀：输出 token 上限 `PONOS_MAX_OUTPUT_TOKENS`（默认 64000，`engine.mjs:63`）；会话美元预算 `PONOS_BUDGET_USD`（`:162,2266-2271`）；单条工具结果字节预算默认 **20000 B**（`:1109`），批量预算默认 **100000 B**（下限 20000，`:998`）；审批拒绝连击 `DENIAL_STREAK_LIMIT=3` / `DENIAL_TOTAL_LIMIT=20`（`:1175-1176`）。

**工具与能力**（`kernel/tools.mjs` 等）：工具注册与执行在 `tools.mjs`（Bash/Read/Grep/Glob/Write/Edit/WebFetch/WebSearch/Task/TodoWrite/OCR/Vision 等，含 `kernel/dyntools.mjs` 动态工具与 `kernel/app-tools.mjs` 应用工具）；实测限制：

| 限制 | 值 | 证据 |
|---|---:|---|
| Bash 超时 | 120_000 ms | `tools.mjs:71` |
| Read 上限 | 2000 行 / 2 MiB | `tools.mjs:74-75` |
| 文件扫描让步 | 每 128 项让出事件循环 | `tools.mjs:359` |
| WebSearch 超时 / max_uses / tokens | 30s / 5 / 4096 | `tools.mjs:689-691` |
| OCR 超时 | 300_000 ms | `tools.mjs:791` |
| Vision 超时 / tokens / 图片上限 | 60s / 2048 / 20 MiB | `tools.mjs:960-962` |

**上下文与压缩**（`kernel/context.mjs`、`kernel/compact.mjs`）：
- 窗口来源优先级：内置模型表 `MODEL_CONTEXT_WINDOWS` → `PONOS_AUTO_COMPACT_WINDOW` → 默认 `DEFAULT_WINDOW = 200_000`（本地模型 `LOCAL_DEFAULT_WINDOW = 65_536`）（`context.mjs:8,14,17,31-34`）。
- token 估算带 **WeakMap 记忆化**（`BLK_CACHE`/`MSG_CACHE`，`:151-152`）+ 内容纪元 `bumpContentEpoch()`（`:146`）做失效；`predictTurns()` 以 `thresholdRatio=0.8` 预测剩余轮数（`:321-334`）。
- 压缩产物用统一占位符 `[旧工具结果已清除——需要时重新调用工具读取]`（`compact.mjs:25`），且只有**可重放工具**才允许清除：`Read/Bash/Grep/Glob/WebFetch/OCR`（`compact.mjs:26`）；压缩后做保真度门禁：缺失点 `>= FIDELITY_GATE_MIN_MISSING(3)` 且比例 `>= FIDELITY_GATE_RATIO(0.5)` 才判失真（`:381-382`）。

**工作流引擎**（`kernel/workflow-dsl.mjs` / `workflow-dag.mjs` / `workflow-engine.mjs` / `workflow-nodes.mjs`）：DAG 调度，并发度取 workflow 级 `settings.max_parallel`，**缺省 4**（`workflow-engine.mjs:234`）；节点结果按 `settled` 表回填作用域（`:80-83,295`）；运行审计落地 `YFWORKING_HOME/workflow-runs/*.jsonl`（`server/bridge.mjs:849`）。

**MCP 集成**（`kernel/mcp.mjs` + `mcp-http.mjs` + `mcp-tools.mjs`）：自包含 JSON-RPC 2.0 客户端，**只做 tools**（resources/prompts/sampling 不做）；传输二选一由 `classifyMcpEntry()` 判定——`command`（stdio）与 `url`（必须 http/https 绝对地址，Streamable HTTP）**恰好其一**（`mcp.mjs:57-84`），两者共用同一会话核心 `createJsonRpcSession`（`:210`）；工具名 `mcpToolName()`（`:179`），可见性 `mcpVisibilityOf(entry, agentId)`（`:496`）支持按 Agent 过滤。

### 3.4 桥层（`server/bridge.mjs`，224 KB）

- 单进程同时提供 HTTP 与 WebSocket（同端口 51517）；`YFW_BRIDGE_NO_LISTEN` 可只 import 不起服务（便于测试）。
- 路由域（实际注册）：文件读写 `list-dir/read-file/raw-file/write-file/read-sheet/write-sheet/read-docx/write-docx/convert-office`、系统信息 `known-folders/drives/health/boot-status`、`/logs/{list,tail,prune}`、`/api/auth/{status,setup,login}`、`/knowledge/*`（委派 `server/knowledge-routes.mjs`）、`/workflows` 与 `/workflows/*`（委派 `handleWorkflowRoute`）等。
- 体量门禁：`/read-file` 超 **524288 B** 拒绝、`/write-file` 超 **2097152 B** 拒绝。
- 端口自愈：EADDRINUSE → `findPidOnPort`（`netstat -ano`）+ `isYfworkingProcess`（PowerShell 读 CommandLine 匹配 `yfworking|bridge.mjs`）→ 自家孤儿 `taskkill -F -T`，外来进程 `exit(1)`；最多重试 3 次。
- 会话=内核进程：空闲回收 10min（`KERNEL_IDLE_REAP_MS`，`:2885`）+ 轮级 20min（`:2891`）+ 等待豁免 30min（`:2895`），回收 tick 60s。
- 系统提示词注入：`YFW_ASKUSER_FORMAT`（`:97`，用注释卡片替代 `AskUserQuestion` 工具）与 `YFW_MILESTONE_PROTOCOL`（`:131`）在桥层拼进会话提示词；会话进程同时 `--disallowedTools AskUserQuestion`（`:2396`）。
- 备份保留：`BACKUP_KEEP_PER_DAY = 1`、`BACKUP_KEEP_TOTAL = 20`（`:54-55`）。

### 3.5 桌面壳（`electron/`）

- 窗口面：主窗、认证小窗（`?auth=1`）、设置窗、编辑窗、profile 窗、utility 窗；均由 `?key=1` 查询参数分流（`electron/main.cjs:659,726,1061,1161`）。
- 安全设置（4 处窗口一致）：`preload: electron/preload.cjs`、`contextIsolation: true`、`nodeIntegration: false`、`sandbox: false`（`main.cjs:604-608,713-717,1052-1056,1142-1146`）。
- IPC 面实测：`ipcMain.handle` 共 **57** 个（`app-ipc.cjs` 19、`main.cjs` 28、`vault-ipc.cjs` 10）+ `ipcMain.on` **10** 个，按域命名（`app:*`、`agents:*`、`auth:*`、`browser:*`、`diag:*`、`dialog:*`、`vault:*`…）。
- 密钥：`electron/vault.cjs` 通过注入的 `crypto` 接口调用 Electron **safeStorage**（Windows 落 DPAPI）加解密；`vault-ipc.cjs` 只按 id 复制明文，明文不进渲染进程。

### 3.6 前端（`src/`）

- 入口：`main.tsx:66-73` `createRoot` → `StrictMode > ErrorBoundary > App`；挂载前同步做旧键迁移（`claude-code-* → yfworking-*`）与主题类预置（`main.tsx:18-56`），挂载后异步 `hydrateSecretsFromVault()`（`:80`）。
- **无路由库**：按查询参数分 4 类窗口根 + `viewStore` 状态机 `AppView = 'boot' | 'cockpit' | 'work'`（`stores/viewStore.ts:13`）；`CockpitScreen` **常驻不卸载**，只切 `display:none`（`ViewRouter.tsx:150-157`）。
- 布局：`WorkShell` = Header + 48px RailNav + 240px SecondPanel + 中心列 + StatusBar（`components/layout/WorkShell.tsx:201-300`）。
- 状态：14 个 zustand store；7 个 persist（键 `yfworking-chat/-agents/-health/-knowledge/-settings/-ui/-view`）；`chatStore` 采用**索引式持久化**——只落会话元数据，消息体权威源是内核 transcript JSONL，内存最多驻留 3 个会话（`MAX_LOADED_CONVERSATIONS = 3`，`chatStore.ts:106`），落盘防抖 600ms / 流式中 5000ms（`:80,85`），并有镜像键与四级 JSON 修复（`resilientChatStorage`）。
- 消息模型：`Message{id, role, content: ContentBlock[], timestamp, model?, tokensUsed?, …}`，`ContentBlock.type ∈ {text, tool_use, tool_result, thinking, image, file}`（`types/index.ts:29-52`）。

### 3.7 共享纯函数层（`shared/`）

- `knowledge-core.mjs`（1095 行）是知识检索/图谱的**唯一权威算法**：`INDEX_VERSION = 4`、`hashLine`、`splitBlocks`、`gramTokens`、`vectorizeText`、`cosine`、`buildIdf`、`fuseScore`、`extractLinks`、`relatedCandidates`；权重 `W_VECTOR=0.60`、`W_KEYWORD=0.25`、`W_STRUCT=0.15`、`GRAPH_DECAY=0.9`、`SIM_THRESHOLD=0.15`、`DUP_COS=0.95`、`MAX_RELATED=8`。
- `pack-zip.mjs`：自实现 zip（仅 stored/deflate，显式拒绝 zip64/加密/多卷），**固定 DOS 时间戳 0x0021（1980-01-01）**，故同内容产出逐字节相同的 zip（可哈希、可复现）。
- `atomic-write.mjs`：同目录临时名 `.yfw-tmp-<pid>-<rand>-<basename>` → `fsync` → `rename`（不 fsync 父目录）。
- `knowledge-pack.mjs`：知识包限额 `maxFileBytes 2MB`、`maxTotalBytes 50MB`、`maxFiles 2000`、`maxEntries 4000` + 扩展名白/黑名单 + semver 兼容判定。
- 依赖纪律：这 5 个模块只 import `node:path`/`node:crypto`/`node:zlib`，因此可被内核单文件 bundle 内联；前端**不** import `shared/`（`src/lib/knowledgeQuery.ts` 是手写同口径镜像）。

### 3.8 安全与审批模型

- **审批四档**：`APPROVAL_MODES = ['manual','auto','loose','bypass']`，默认 `loose`，等级 `manual 0 < auto 1 < loose 2 < bypass 3`（`kernel/approval-mode.mjs:26-29`）；工具按类放行 `TOOL_CLASS_ALLOW_FROM`（`:32`），判定入口 `classifyTool`（`:59`）/`modeAllows`（`:73`）/`deriveApprovalMode`（`:79`）。
- **档位传播**：桥按"会话覆盖 || 全局档位"生成 `--approval-mode`（`server/bridge.mjs:1252-1270`）；前端不做乐观写，权威在桥（`useYFWCLI.ts:933-947`）。
- **其他守卫**：`kernel/guards.mjs`（路径/参数校验）、`kernel/permissions.mjs`、`kernel/highrisk.mjs`、`kernel/blacklist.mjs`（深度 `MAX_DEPTH=3`、段数 `MAX_SEGMENTS=200`）、`kernel/readonly.mjs`（只读子命令 + `MTIME_SAFETY_MS=3_600_000`）、`kernel/audit.mjs`（审计）、`kernel/redact.mjs`（脱敏）、`kernel/disabled.mjs`（工具/技能禁用表）。
- **桌面侧**：`contextIsolation:true` + `nodeIntegration:false` + preload 白名单 API；密钥走 safeStorage；`electron/app-permissions.cjs`/`app-validator.cjs` 校验"应用"能力声明。
- **已知取舍**：`sandbox:false`（4 处窗口一致）意味着渲染进程未启用 Chromium 沙箱，隔离靠 contextIsolation 与 preload 面收窄。

### 3.9 数据落点（实测）

| 数据 | 位置 |
|---|---|
| 应用数据根 | `%USERPROFILE%\.yfw`（`YFWORKING_HOME`） |
| Electron userData / profile | `<根>/userData/`（`profile.json`） |
| 设置 / 配置 | `<根>/settings.json`、`<根>/config.json` |
| 技能 / 工具 | `<根>/skills/`、`<根>/tools/` |
| 知识库 | `<根>/knowledge/spaces/`（索引 jsonl）；仓库内 `knowledge/` 仅运行时数据且被 `.gitignore:52` 根锚定忽略 |
| 工作流 / 运行审计 | `<根>/workflows/`、`<根>/workflow-runs/*.jsonl` |
| 内核 stderr 日志 | `<根>/logs/kernel-stderr.log` |
| 应用注册表 | `<根>/apps/registry.json` |
| 前端轻量状态 | localStorage（7 个 persist 键），密钥不入 localStorage |

---

## 4. 性能分析（全部来自源码常量、配置与产物实测）

### 4.1 启动路径的时间预算

| 环节 | 数值 | 证据 |
|---|---|---|
| 桥就绪等待 | 30 × 500ms = **15s** 上限；健康判据 800ms 超时 | `electron/main.cjs:477-491,210-227` |
| 残留桥回收 | `taskkill` 后等 500ms | `electron/main.cjs:1625-1632` |
| 启动进度轮询 | 每 **300ms** 拉 `/boot-status`（4 步） | `electron/main.cjs:1640,260-278` |
| 认证先行 | 主窗在 `auth:granted` 之后才创建 | `electron/main.cjs:1597-1609` |
| BootScreen 硬超时 | **15_000ms** | `src/components/boot/BootScreen.tsx`（`BOOT_HARD_TIMEOUT_MS`） |
| `start.bat` 等待 | 3s 后打印地址；`bin/cli.mjs` 4s 后开浏览器 | `start.bat:40`、`bin/cli.mjs:82-95` |
| 首帧防闪白 | 挂载前同步写主题类与 body 底色 | `src/main.tsx:31-56`、`index.html` |

### 4.2 前端渲染性能（数值均为源码常量）

| 机制 | 实测参数 | 证据 |
|---|---|---|
| 视图保活 | 驾驶舱常驻；WorkShell 空闲预热 `requestIdleCallback(timeout 1500)`，回退 `setTimeout 600` | `ViewRouter.tsx:124-133,150-162` |
| **长列表不用虚拟滚动** | `@tanstack/react-virtual` 已声明但 `src/` **零引用**；改用 CSS containment：消息数 ≥ **60** 时挂 `.msg-contain`，规则 `content-visibility:auto; contain-intrinsic-size:auto 120px` | `src/lib/longListContainment.ts:32-35`、`styles/globals.css:885` |
| 流式合帧 | 满速目标 **16ms** 一帧（刻意不用 rAF）；降频档 `coalesceMs = 120` | `src/lib/streamPressure.ts:53-61`、`useYFWCLI.ts:743-752` |
| 降频门控（滞回） | 进：队列 `depth>=8` 或 `age>=120ms`；出：`depth<=2 && age<=40ms` 持续 **250ms** | `streamPressure.ts:53-61` |
| 子 Agent 进度 | 每帧只留最后一条 + rAF 批量应用 | `useYFWCLI.ts:788-792` |
| memo 密度 | 非测试 **8 处**（三视图、MarkdownTextPart/Blocks、MessageBubble、ConversationItem、ChatListPanel），且用自定义比较器避免恒失效 | `AssistantMessageView.tsx:34,47,65`、`MessageBubble.tsx:504`、`MarkdownText.tsx:186` |
| Markdown 流式 | "稳定前缀 + 增长尾块" `createPrefixFreezer`（切点限空行且不在围栏内），仅 `running` 态启用；插件/组件表模块级稳定 | `src/lib/markdownStream.ts`、`MarkdownText.tsx:20,25,157,178-183` |
| 消息→ThreadMessage | WeakMap 身份缓存 + `statusKey` 增量转换 | `src/lib/chatParts.ts`、`chatRuntime.tsx:34,60-72` |
| 订阅粒度 | `useChatStore(s => …)` 精细订阅 **74** 处，但仍有约 **20** 处整店订阅；未使用 `useShallow` | `layout/Header.tsx:21-22`、`permissions/PermissionDialog.tsx:40` 等 |
| 落盘节流 | 600ms / 流式中 5000ms；镜像超 30MB 跳过；`beforeunload` 强刷 | `chatStore.ts:80,85,90,181-189` |
| 画布回写 | 300ms 节流 + 指纹比较（仅 id/type/position/label/边端点参与） | `WorkflowCanvas.tsx:52,93-110` |
| 节能降级 | `html.speed-mode` → 全站 `animation:none` + `backdrop-filter:none`；`html.anim-paused` 随 `document.hidden` | `styles/globals.css:732-745`、`WorkShell.tsx:93` |
| 渲染遥测 | 每 **5s** POST `/diag/render-frame`：`msP50/msP95/gapP50/gapMax/heavyIn/heavyOut/qMax/qAgeMax`，采样上限 400 | `useYFWCLI.ts:660-741` |

### 4.3 内核循环与上下文性能

- **上下文估算记忆化**：`BLK_CACHE`/`MSG_CACHE` WeakMap + `bumpContentEpoch()`（`kernel/context.mjs:146-152`）；请求面记忆化开关 `PONOS_REQUEST_FACE_CACHE`（默认开，**惰性读**，`engine-config.mjs:78`）。
- **零迭代上限（性能取向的显式取舍）**：`MAX_TOOL_ITERATIONS` 与 `TURN_TIMEOUT_MS` 默认 0，官方理由写在代码里：长任务单轮几十次工具调用属正常，硬上限只会误杀；挂起防护改由空闲看门狗、重复生成守卫、工具 deadline 承担（`engine-config.mjs:41-51`）。
- **溢出自愈有上限**：`MAX_OVERFLOW_RETRIES=12`，因为每次重试都是一次完整 API 请求（贴窗口请求体可达 1MB），代码中记录过"7 分钟重发 240 次"的事故（`:53-58`）。
- **并行与排队**：后台子 Agent（lane）并发 `LANE_MAX_CONCURRENT=4`，超限入队并返回排队文案（`engine.mjs:139-140,1970-1976`）；工作流节点并发缺省 4（`workflow-engine.mjs:234`）；知识深挖并发 6、总预算 25s、候选上限 15、单个 SKILL.md 上限 16KB（`kernel/skill-search.mjs:37-40`）。
- **批量与截断**：工具结果单条默认 20000 B、批量默认 100000 B（下限 20000）（`engine.mjs:998,1109`）；Read 2000 行 / 2 MiB；大文件扫描每 128 项让出事件循环（`tools.mjs:359`）。
- **缓存 TTL**：技能市场清单 10 分钟（`skill-search.mjs:36`）、只读命令 mtime 安全窗 1 小时（`readonly.mjs:36`）、用量缓存可由 `PONOS_USAGE_CACHE_TTL_MS` 覆盖（`server/bridge.mjs:1826`）。

### 4.4 桥层性能与稳定性

| 项 | 数值 | 证据 |
|---|---|---|
| WS 背压阈值 | 缓冲 > **8 MiB** 判过载，回落 < **2 MiB** 解除 | `server/bridge.mjs:1745-1746,1774-1779` |
| WS 心跳 | 30s 发；3×心跳宽限；5min 硬阈值 | `:2842-2846,2857` |
| 事件循环漂移探测 | 探测间隔 100ms、判定块 ≥50ms | `:895-896` |
| 内核回收 | 空闲 10min / 轮级 20min / 等待豁免 30min，tick 60s | `:2885,2891,2895` |
| askuser 缓冲上限 | 8192 B | `:1788` |
| 子进程超时 | Python/Office 脚本 15s | `:1965,1987` |
| 备份保留 | 每天 1 份、总量 20 份 | `:54-55` |
| 大文件门禁 | 读 512 KB / 写 2 MB | `:1929-1932,1941-1946` |

### 4.5 构建体积（实测产物）

- 前端：`npm run build` → `dist/` **13 MB**；`dist/assets` 8 个文件，最大 `index-*.js` **2,131,494 B**（gzip 679,821）、`index-*.css` 128,785 B（gzip 21,626），分包规则见 `vite.config.ts:26-43`（`vendor-react/-radix/-assistant/-framer/-markdown/-icons/-store`），`chunkSizeWarningLimit = 350` KB。
- 内核：`bun build … --minify --external=node:*` → `kernel-dist/cli.mjs` **482,161 B**（单文件 ESM）。
- 便携目录 1.4 GB 的构成：`electron/` 349M（含 `electron.exe` 225,605,120 B）、`node_modules/` 379M、`runtime/` 540M（`python` 362M + `skills` 179M）、`dist/` 13M。
- 压缩策略：安装包 `compression: store` + `asar: false`（`electron-builder.yml:123,127`）；便携 zip 大文件走 store（阈值 4 MiB，`scripts/package-portable-zip.mjs:105`），实测整体压缩率 90.2%。

### 4.6 代码里写死的性能门禁（`npm test` 会跑）

| 断言 | 阈值 | 证据 |
|---|---|---|
| 压缩热路径 | `warm <= cold / 10`；`findCutPoint < 30ms`；`splitCoveredIntoChunks < 80ms` | `kernel-tests/perf-baseline.test.mjs:94,140,145` |
| 缓存收益 | `off >= on * 5`；`back <= off / 5`；`6× warm < 60ms`；`cold < 150ms` | 同上 `:110,116,127,132` |
| 线性度 | `t2 <= t1 * 3.2` | `:160+` |
| 上下文缓存 | 2.5MB 历史连调 3 次 `< 200ms`；命中 `ms2 < ms1/5` 且 `< 20ms` | `kernel-tests/context-cache.test.mjs:111,46-47` |
| 保真检查吞吐 | 单轮 20 万字符 `< 200ms` | `kernel-tests/fidelity.test.mjs:452` |
| 大文本处理 | 1.08M 字符样本：正则 `msRegex * 5 < msCharwise` 且 `< 300ms` | `src/lib/utils.test.ts:98-99` |
| 只读扫描 | 4 万行夹具下 `on.ms * 5 < off.ms` | `kernel-tests/readonly-mtime-prune.test.mjs` |
| 流式扫描量 | `scannedChars <= total * 2 + 64` | `src/lib/markdownStream.test.ts:75` |

### 4.7 可观测性

- 桥侧：`/health`、`/boot-status`、`/logs/{list,tail,prune}`、`/diag/render-frame`；`electron/diag-monitor.cjs` + `electron/log-tee.cjs` 采集与落盘日志；内核 stderr 单独落 `<根>/logs/kernel-stderr.log`。
- 内核侧：`ponos_health`/`yfw_health`/`yfw_summary`/`ponos_warning` 事件回流前端（`useYFWCLI.ts:959-1295`）；`kernel/perf.mjs`、`kernel/stats.mjs`、`kernel/cost.mjs` 提供性能、统计与成本计量点。
- 前端侧：渲染帧遥测（§4.2 末行）+ 诊断面板（`components/diagnostic/DiagnosticPanel.tsx`）。

### 4.8 性能债（源码可证的优化余地）

1. **无代码分割**：`React.lazy`/`<Suspense>` 零命中，`import()` 仅出现在测试文件 → 首包 `index.js` 2.13 MB（gzip 680 KB）一次性加载。
2. **虚拟滚动声明未用**【**已消除（2026-09-19）**】：`@tanstack/react-virtual` 曾声明但零引用，已按依赖台账删除（B1）；长列表仍靠 `content-visibility` 兜底 —— 将来若要真虚拟滚动，需重新引入并接线。
3. **降频/合帧常量偏保守**：满速 16ms 一帧 + `coalesceMs 120`，超长会话下依靠滞回门控，未做按消息数自适应。
4. **约 20 处整店订阅**：`useChatStore()` 无 selector，流式高频更新时可能放大渲染。
5. **字体走 CDN**：`index.html:13-15` 引 Google Fonts（Inter/Sora/JetBrains Mono），离线环境下首屏字体退化（无本地字体、无子集化）。
6. **静态打包语言包**：CodeMirror 20 个 `@codemirror/lang-*` 全量静态 import（`CodeEditor.tsx:13-29`），未按需加载。
7. **空转的分包规则**：`vite.config.ts:39` 的 `vendor-framer` 无命中（`framer-motion` 唯一引用点 `boot/LogoMorph.tsx` 无调用方），实测产物无该 chunk。
8. **声明未用依赖**【**已消除（2026-09-19）**】：逐个复核五类引用证据后删除了 **10 个**零引用的运行时依赖 —— `@radix-ui/react-collapsible`、`@radix-ui/react-context-menu`、`@radix-ui/react-popover`、`@radix-ui/react-separator`、`@tanstack/react-virtual`、`classic-level`、`diff`、`mammoth`、`nanoid`、`xlsx`（`dependencies` 52 → 42 条；`kit:check` 红灯 14 → 4）。**原描述把 `ws` 与 `classic-level` 并列是错的**：`ws` 实测在用（`server/bridge.mjs`、`electron/main.cjs`），真未用的是 `classic-level`；`framer-motion` 与这 10 个不同类（它在 `package.json` 里**根本没有声明**），见第 7 条。
9. **`electron-builder.yml:37` 声明的 `node.exe` 在仓库根不存在**（仅打包期临时复制），`npm run build:electron` 路径与该声明不一致。

---

## 5. 技术方案（关键决策、代码依据与代价）

| # | 决策 | 代码依据 | 代价/风险 |
|---|---|---|---|
| 1 | **桥是唯一中枢**，前端不直连内核 | `server/bridge.mjs:79`（单端口）、`electron/main.cjs:523`（桥先起） | 桥成为单点；桥崩则全线断（前端有 `bridgeLostSessions` 收口逻辑 `useYFWCLI.ts:194-232`） |
| 2 | **前后端走 WS 传 NDJSON**，不用 JSON-RPC | `useYFWCLI.ts:50-51`、`bridge.mjs:1251` | 协议轻、零依赖；但无 schema 校验，靠两侧各自解析 |
| 3 | **内核零第三方依赖 + 单文件 bundle** | `kernel/package.json` 无 dependencies、`deploy-smoke.test.mjs` 断言、`scripts/build-kernel.mjs:24-32` | 需要自实现 grep/glob/zip 等能力（`shared/pack-zip.mjs`、`tools.mjs` 原生递归）；换来免 npm 安装的分发 |
| 4 | **会话 = 内核进程 + stdin/stdout 通道** | `bridge.mjs:1251,1364`（spawn + 传参）、`KERNEL_IDLE_REAP_MS`（`:2885`） | 隔离性好、崩溃不串会话；代价是进程数与回收复杂度（10/20/30min 三档） |
| 5 | **取消单轮硬上限，改多守卫自愈** | `engine-config.mjs:41-58`（迭代/墙钟默认 0） | 长任务不被误杀；靠溢出重试上限、停滞自愈、重复生成守卫、空闲看门狗兜底 |
| 6 | **压缩 + 保真双计量** | `compact.mjs:26`（仅可重放工具可清）、`:381-382`（保真门禁）、`engine-config.mjs:120-121`（锚点重注） | 省 token 同时防"记忆失真"；实现复杂度高（另设 `fidelity.mjs`/`health.mjs`） |
| 7 | **审批四档 + 会话级覆盖** | `approval-mode.mjs:26-32`、`bridge.mjs:1252-1273` | 默认 `loose` 偏便利；四档语义清晰、可按会话降级，便于审计 |
| 8 | **问答卡片用注释标记而非工具** | `bridge.mjs:97`（YFW_ASKUSER_FORMAT）、`:2396`（禁 `AskUserQuestion`） | 规避 GUI 工具交互渲染成本；代价是模型需遵循文本协议，靠提示词约束 |
| 9 | **内核工具只暴露纯函数层 `shared/`** | `shared/*.mjs` 仅 `node:path/crypto/zlib`；`knowledge-core.mjs` 40+ 导出 | 两端同一套算法（索引版本 `INDEX_VERSION = 4`）；代价是前端需手写同口径镜像（`src/lib/knowledgeQuery.ts`） |
| 10 | **确定性打包** | `shared/pack-zip.mjs:22-24`（固定 DOS 时间戳）、UTF-8 名 + bit 11 | 同内容可复现、可哈希比对；放弃系统 tar（中文代码页乱码风险） |
| 11 | **原子写 + 备份保留** | `shared/atomic-write.mjs:22,51`（tmp→fsync→rename）、`bridge.mjs:54-55`（1/天、共 20） | 抗断电/半写；代价是无父目录 fsync（掉电跨目录一致性弱） |
| 12 | **MCP 只做 stdio + Streamable HTTP 的 tools** | `mcp.mjs:57-84,210` | 覆盖面够用、零依赖；不支持 resources/prompts/sampling |
| 13 | **工作流 DAG 并发缺省 4** | `workflow-engine.mjs:234` | 简单可控；对 I/O 型节点未做自适应并发 |
| 14 | **知识检索为自研词法+结构融合打分** | `knowledge-core.mjs` 权重常量（0.60/0.25/0.15）、`kernel/knowledge.mjs:47-534` | 无需向量库与网络；代价是召回上限依赖 `SEARCH_SAMPLES=100`、`SNIPPET_LEN=120` 这类经验参数 |
| 15 | **Electron 关闭沙箱、开启 contextIsolation** | `main.cjs:604-608` 等 4 处 | 兼容 preload 的文件/进程能力；安全边界由 preload 面与 IPC 校验承担 |
| 16 | **测试用 `node --test`（非 vitest/jest）** | `package.json:19`、Node ≥18 原生 TS 剥离 | 零测试框架依赖、可直接跑 `.ts`；代价是无 watch/覆盖率生态 |

---

## 6. 源码目录导航

```
kernel/            Agent 内核（62 个 .mjs，可直接 node 运行）
  cli.mjs          入口/参数/生命周期；engine.mjs 主循环；engine-config.mjs 全部限值与开关
  api.mjs          模型 API 调用与重试；provider.mjs；stream-runtime.mjs
  tools.mjs        内置工具执行；dyntools.mjs 动态工具；app-tools.mjs 应用工具
  guards/permissions/highrisk/blacklist/readonly/audit/redact/disabled  安全与权限
  context.mjs      窗口/估算/记忆化；compact.mjs 压缩；health.mjs 健康；fidelity.mjs 失真
  knowledge*.mjs   知识库索引/检索/导入/注入；graph.mjs 图谱；memory.mjs 记忆
  workflow*.mjs    DSL/DAG/引擎/节点；loop*.mjs 循环守卫；mcp*.mjs MCP 客户端
  session.mjs      会话持久化；skills.mjs/skill-search.mjs 技能；tui.mjs 终端界面
server/            bridge.mjs（HTTP+WS 中枢）与各领域路由/服务（知识、工作流、备份、日志、导入、审批、用量）
electron/          main.cjs（窗口与启动序列）、preload.cjs（contextBridge 面）、app-ipc.cjs（应用域 IPC）、
                   vault*.cjs（safeStorage 密码库）、browser-executor.cjs（CDP 驱动）、diag-monitor.cjs、log-tee.cjs
src/               main.tsx/App.tsx 入口与窗口分流；components/（chat、apps、knowledge、workflows、settings…）
                   stores/（14 个 zustand）；hooks/useYFWCLI.ts（WS 主链路）；lib/（API 客户端与纯逻辑）；i18n/；styles/
shared/            kernel 与 server 共用纯函数：knowledge-core / knowledge-query / knowledge-pack / pack-zip / atomic-write
kernel-tests/      内核测试 181 个（含 perf-baseline、context-cache、e2e 等）
scripts/           构建（build-kernel / build-embedded-python / build-installer）、打包（package-portable）、
                   bump-version、11 个 verify-*.mjs 校验脚本
build/             installer.nsh、安装图、portable-docs、templates/{agents,memory,tools}
pet/               桌宠 Python 脚本与素材；workflows/ 内置工作流定义；public/ 静态资源与示例技能
```

---

## 7. 交付包说明（源码包如何按 git 原则生成）

源码交付包由 `scripts/pack-source-zip.mjs` 生成（该脚本自身通过 `.git/info/exclude:11` 排除在版本库之外，只在本地使用）：

```bash
node scripts/pack-source-zip.mjs --dry-run    # 只列出将入包/被排除的文件
node scripts/pack-source-zip.mjs              # 打包；发现疑似密钥则中止
node scripts/pack-source-zip.mjs --suffix r2  # 出 -r2 包，不覆盖已发出的
```

- **条目清单唯一来源是 git**：`git ls-files -z --cached --others --exclude-standard`（`:145`）——即"已跟踪 + 未跟踪但未被忽略"，"工作区完整快照"由 git 定义，不由脚本遍历磁盘。
- **第二道排除闸**：`EXCLUDE_RULES`（`:32-79`）在 `.gitignore` 之外独立维护，每条都写明理由（依赖、构建产物、测试、内部设计文档、密钥与本地配置、运行时数据、打包脚本自身等）。
- **擦除先于扫描**：`SCRUB_RULES`（`:87`）先改写入包副本字节（如 Dify 相关章节、示例技能里的真实 key），再跑 `SECRET_PATTERNS`（`:112`）扫描**入包后的实际字节**；扫描上限 1 MiB/文件、只扫文本扩展名（`:132-133`）；高熵判定 `looksHighEntropy`（`:129`）。
- **命名**：`release/YFWorking-src-<package.json version>-<YYYYMMDD>[-suffix].zip`（`:175-179`），同目录另出 `.files.txt`（入包清单）与 `.manifest.txt`（版本/分支/提交/文件数/擦除与排除统计）。
- **可复现性**：zip 由 `shared/pack-zip.mjs` 自实现，条目名按 UTF-8 编码并置 UTF-8 标志位，DOS 时间戳固定为 1980-01-01，因此同内容必然产出逐字节相同的 zip。

---

## 8. 已知缺口与"注释/文档 ↔ 代码"不一致清单

以下均为源码可证的现状或矛盾，交付与接手时需按代码而非注释行事：

**启动与构建**
1. `package.json:12` 的 `electron` script 使用 POSIX 内联环境变量语法，且把端口硬编码为 `5197`（与 `YFW_VITE_PORT` 解耦）。
2. `scripts/build-kernel.mjs` **没有任何 npm script 或脚本调用它**——`npm run build` 不产出 `kernel-dist/cli.mjs`，必须手工执行（或经 `scripts/package-portable.cjs` 的告警提示）。
3. `electron-builder.yml:37` 声明 `files: node.exe`，但仓库根不存在 `node.exe`（`.gitignore:32` 忽略 `/node.exe`），仅 `release/YFWorking/node.exe` 存在；`scripts/build-installer.mjs` 在打包期临时复制、`finally` 删除。
4. `release/installer/`（`electron-builder.yml:16` 的输出目录）**当前不存在**，本机无 NSIS 安装包产物可验证。
5. 版本纪律双轨：`BUILD.md` 指示手改 `package.json` version，而 `bump-version.mjs` 从不改它；`version.mjs:7` 注释声称 bump 会同步 `package.json`，代码未实现（只同步 `server/version.test.mjs`，且该文件在本仓不存在 → 永走跳过分支）。
6. `compression: store` 的注释理由是"payload 多为已压缩二进制、重压缩收益小"，但便携 zip 实测压缩率 90.2%（大文件 store、小文件 deflate 的混合策略）。

**运行时行为**
7. `MAX_TOOL_ITERATIONS`/`TURN_TIMEOUT_MS` 默认 0（不限）——一旦上游持续假死，兜底依赖 `STREAM_IDLE_MS`、`LOOP_STALL_MS`、`MAX_OVERFLOW_RETRIES`、`MAX_ERROR_ITERATIONS` 四个守卫，任一被 `PONOS_LOOP_GUARD=0` 关掉即整体失去限流。
8. `sandbox:false` 在 4 类窗口一致；隔离实际依赖 contextIsolation + preload 白名单。
9. 内核与 `release/YFWorking/kernel/` 的 `cli.mjs` 同名不同物（482,161 B bundle vs 106,164 B），内核候选路径顺序为 `<appRoot>/kernel/cli.mjs` → 上溯一级 → `kernel-dist/cli.mjs`（`electron/kernel-paths.cjs:42-49`），便携形态命中前者，属源码与 bundle 混放。
10. `start.bat` / `bin/cli.mjs` 走 PATH 上的 `node`/`npx`，与分发态的 `node.exe` 不同源，Node 版本一致性无断言。
11. 11 个 `scripts/verify-*.mjs` 未挂进任何 npm script，且其中 GUI/权限流校验依赖图形会话或真内核，不属 CI 可跑范围。
12. `server/interject.e2e.mjs` 文件名不匹配 `npm test` 的 glob（`server/*.test.mjs`），不会随 `npm test` 执行；`kernel-tests/*-e2e.test.mjs` 在 glob 内但依赖 `PONOS_MOCK_API=1` 为 mock 级。

**约定与产物**
13. `skills-lock.json` 记录技能来源与 sha256，但**未找到任何运行时代码读取它**。
14. `runtime/skills` 实测 180 MB（其中 `yfwweb-verify` 单库 154 MB），`electron-builder.yml:58-61` 全量 `**/*` 打入且 `compression: store`，未见任何体积上限断言。
15. `.superpowers/`、`.trae/` 等目录被 `.gitignore` 忽略但实际存在于工作区，其内容不在受控面内，不可作为结论依据。
16. 其他未确认项：`runtime/sample-skills` 是否在运行时被索引（体积是否被用户感知）、`@tanstack/react-virtual` 历史用法、i18n 缺失键是否有统计上报、`themes.css` 283 个变量未逐一核对。
17. **兼容垫片的覆盖边界**（§2.7）：`kernel/engine-config.mjs` 在**模块顶层**读 env，因此只有"进程 env 已有旧名"的情形能被首个 import 的垫片覆盖；若旧名只存在于 `settings.json` 的 env 段，则该模块的顶层常量取不到映射值（`loadSettings()` 的二次兜底发生在模块求值之后）。其余在函数内惰性读 env 的模块（provider/api/compact 等）两条路径均覆盖。彻底消除需把 engine-config 的读取改为惰性，属可选的后续重构。

---

## 9. 变更与维护提示（给接手者）

- **改限值先找 `kernel/engine-config.mjs`**：迭代、超时、重试、并发、退避、锚点节奏全部集中在此，且都是"环境变量 + 默认值 + 可用 0/负值关闭"的统一写法；`PONOS_LOOP_GUARD=0` 是一键关闭全部循环守卫的总闸（调试用，生产慎用）。
- **改端口/根目录要同步四处**：`server/bridge.mjs:79`、`electron/main.cjs:206`、`bin/cli.mjs:10`、`vite.config.ts:11`（前端另经 `src/lib/bridgeBase.ts:20` 兜底）。
- **新增内核参数必须登记进 `parseArgs`**，否则静默失效（`cli.mjs:275-278`）。
- **新增交付文件后检查两道闸**：`.gitignore` 与 `pack-source-zip.mjs` 的 `EXCLUDE_RULES`（排除清单本身就是审计面）。
- **涉密内容一律走 `SCRUB_RULES`**：入包前按字节擦除、再扫描实际入包字节（顺序不能反）。
- **性能回归靠 `kernel-tests/perf-baseline.test.mjs` 的门禁**，改动压缩/上下文/工具扫描路径后应保持这些断言通过。

---

*本文档由源码阅读产出，不含任何来自注释或既有文档的未经验证的宣称；如发现代码变更导致上述行号或数值失效，以当前代码为准并同步更新本文。*
