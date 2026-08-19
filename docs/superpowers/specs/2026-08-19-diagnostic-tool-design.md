# 应用内诊断工具设计（2026-08-19）

## 1. 背景与目标

生产版（NSIS 安装版 / 便携版）是 GUI 子系统应用，主进程日志只走 `console.log` 无落盘，
用户在安装机上遇到问题（典型：bun 内核启动后秒退、bridge 起不来）时无法查看任何终端信息，
只能依赖外部 bat 脚本，体验差且定位困难。

目标：**应用内置自动化异常诊断**，覆盖全部功能模块，让用户无需任何外部工具即可
查看运行状态、定位故障、一键导出诊断信息给开发者。

- 定位：自动化异常检测（非被动日志浏览器）
- 时机：启动自检 + 运行期持续监测 + 事件驱动即时重测
- 范围：核心链路 / 会话系统 / 浏览器自动化 / 文档处理 / 附加进程 / 配置数据 / 网络 / 渲染健康
- 入口：右上角命令面板（CommandPalette）呼出，非设置页 tab

## 2. 架构总览

```
主进程 main.cjs
 ├─ 日志 tee ──→ ~/.yfworking/logs/app.log（console.log/error 双写，>5MB 轮转保留 1 份）
 ├─ DiagnosticMonitor
 │    ├─ 检测项注册表：{ id, group, 检测函数, 状态判定 }（24 项 / 8 组）
 │    ├─ 自检（ready 后 2s）+ 巡检（30s）+ 事件驱动重测
 │    ├─ 状态聚合：逐项 ok/warn/error/unknown → overall
 │    └─ 状态翻转 → webContents.send('diag:status-changed')
 ├─ IPC handle：
 │    diag:get-status / diag:rerun / diag:run-kernel-check / diag:export
 └─ 事件源：bridge exit、executor 断连、GPU crash、内核会话失败

渲染层
 ├─ CommandPalette 新增命令「诊断」(Stethoscope, help 组)
 ├─ DiagnosticPanel（Dialog 宽屏弹出）
 └─ 异常通知：overall=error → 右侧滑入横幅「检测到 N 项异常」→ 点击打开面板
```

## 3. 日志落盘（基础能力，GUI 起不来也必须工作）

诊断存活边界：**主进程能启动 = 诊断存活**。渲染层/窗口/bridge/内核均可能失败，但只要
Electron 主进程进程活着，日志 tee 与崩溃兜底就在工作。主进程本身起不来的场景（系统级
故障）超出应用内工具能力范围，不在此设计内。

### 3.1 落盘时机：main.cjs 最早期

- 文件：`~/.yfworking/logs/app.log`（追加写）
- 初始化位置：`electron/main.cjs` 顶部（`app.whenReady()` 之前，所有模块 require 之后
  立即执行），保证**启动序列第一行日志即入盘**（含 spawn bridge、内核路径解析等早期步骤）。
- 实现：独立模块 `electron/log-tee.cjs`，`initLogTee()` 包装 `console.log` / `console.error`
  为 tee——原输出行为不变（终端/管道场景），同时写入文件；wrapper 捕获 EPIPE 不抛出
  （沿袭现有 76-82 行逻辑）。
- **每条日志加时间戳前缀**：`[2026-08-19T14:30:00.123Z] [main] ...`（tee 内部处理，
  console 原输出不变）。
- 兜底：`process.on('uncaughtException'/'unhandledRejection')` 在 main.cjs 顶部注册，
  写入日志后再按原行为处理（不吞异常）。
- 轮转：启动时检查，若文件 >5MB → 改名 `app.log.1`（覆盖旧备份，保留 1 份）。
- 写入失败（磁盘满/权限）：静默降级，不阻塞应用。

### 3.2 渲染层错误全链路入盘

解决"界面挂了日志却空白的盲区"，主进程挂载以下监听（失败即落盘）：

| 事件 | 落盘内容 |
|---|---|
| `did-fail-load` | URL、错误码、错误描述、进程号 |
| `render-process-gone` | 原因、退出码 |
| `console-message` | 渲染层 console 全量转发（level + message + 来源）——顺带解决之前"渲染层 console 收不到"的盲区 |
| `preload-error` | preload 脚本加载错误 |
| `unresponsive` / 恢复 | 渲染进程无响应事件 |

另在 preload 注入 `window.onerror` / `unhandledrejection` 监听，经 IPC 上报主进程落盘
（渲染层 JS 运行时错误也进日志）。

### 3.3 启动失败兜底（last-boot.json + 原生对话框）

- 主进程在启动序列关键节点打点（main ready / bridge spawn / bridge health / window load
  done / kernel spawn），启动序列结束（成功或失败）时写 `~/.yfworking/logs/last-boot.json`：
  各节点时间戳、成败、错误详情。
- **界面起不来时的用户提醒**：主进程检测到启动失败（窗口 `did-fail-load`、`render-process-gone`
  且无界面可用、或 bridge 启动失败且窗口未加载完成）→ 弹**原生对话框**（`dialog.showMessageBox`，
  不依赖渲染层）：
  ```
  ⚠ YFWorking 启动异常
  应用界面启动失败。完整错误日志已保存到：
  C:\Users\<user>\.yfworking\logs\app.log
  [打开日志目录] [复制路径] [确定]
  ```
  该对话框为兜底提醒，仅在检测到异常时出现，正常启动不打扰。

## 4. DiagnosticMonitor（检测引擎）

位置：`electron/diag-monitor.cjs`（独立模块，main.cjs 引入）。

### 4.1 运行时机

| 触发 | 时机 | 说明 |
|---|---|---|
| 启动自检 | app ready 后 2s | 全量跑一遍，结果推送渲染层 |
| 定时巡检 | 每 30s | 全量重跑；单项结果与上次相同时不推送（状态翻转才推） |
| 事件驱动 | bridge exit / executor 断连 / GPU crash / 内核会话首 token 失败 | 立即重测相关组 |

### 4.2 检测项约束

- 每项检测函数**硬超时**：本地类 3s，网络类 8s；超时按该项 error 处理（detail 注明超时）。
- 检测函数串行执行（非并发），避免与 bridge/内核抢资源；总时长受单项超时上界约束。
- 检测不得改变系统状态：禁止启动/重启常驻服务（bridge/内核会话/宠物等）；允许 spawn
  无副作用的只读探测命令（`--version` 类），检测后立即回收。
- 注册表模式：新增检测项 = 注册一个 `{id, group, label, check}` 对象，无需改动引擎骨架。

### 4.3 状态模型

```
CheckStatus = 'ok' | 'warn' | 'error' | 'unknown'
CheckResult = { id, group, label, status, detail, lastCheckedAt, latencyMs }
Overall = 'ok' | 'warn' | 'error'   // 任一 error → error；否则任一 warn → warn；全 ok → ok
```

推送规则：仅当某单项状态或 overall 发生变化时 `send('diag:status-changed', snapshot)`。

## 5. 检测项矩阵（8 组 24 项）

### A 核心链路（kernel-files, kernel-bootstrap, kernel-launch, bridge-port, bridge-alive, kernel-session, kernel-crash）

| id | 数据源 | 判定 |
|---|---|---|
| kernel-files | `<app>/kernel/cli.mjs` + `<app>/runtime/bun/bun.exe`（dev 时按 findYFWorking 候选路径） | 都存在=ok |
| kernel-bootstrap | `~/.yfworking/runtime/kernel/cli.mjs` + `runtime/bun/bun.exe` 存在且大小与源一致 | ok |
| kernel-launch | spawn `"<bun>" "<kernel>" --version`，15s 超时 | stdout 含 `(YFW)` 且 exit 0=ok |
| bridge-port | `http://127.0.0.1:51309/health`（800ms 超时） | 200=ok |
| bridge-alive | 本进程 spawn 的 bridge 存活；重启计数（BRIDGE_RESTART 系列） | 存活=ok；重启>3 次=warn |
| kernel-session | bridge 侧最近 3 次会话 spawn 的首 token 到达标记（session.firstTokenAt） | 3 次全到达=ok；存在失败=warn |
| kernel-crash | 内核子进程异常退出（非 cancel）计数 | 0=ok |

### B 会话系统（transcript-dir, transcript-index）

| id | 数据源 | 判定 |
|---|---|---|
| transcript-dir | `~/.yfworking/sessions/` 目录可读 | 可读=ok |
| transcript-index | bridge `GET /transcript/list` 端点 | 200 且 JSON 可解析=ok |

### C 浏览器自动化（executor-connected, executor-window, browser-whitelist）

| id | 数据源 | 判定 |
|---|---|---|
| executor-connected | 浏览器执行器 WS 连接状态（main.cjs browserExecutor） | 已连接=ok |
| executor-window | 最近会话窗口存活（executor 状态查询） | 正常=ok |
| browser-whitelist | `~/.yfworking/browser-whitelist.json` JSON 解析 | 可解析=ok |

### D 文档处理（python-runtime, office-ocr）

| id | 数据源 | 判定 |
|---|---|---|
| python-runtime | `runtime/python/python.exe`（随应用捆绑）存在 | 存在=ok |
| office-ocr | spawn `python.exe --version`，5s 超时 | 有输出且 exit 0=ok |

### E 附加进程（pet-alive, doubao-session, editor-available）

| id | 数据源 | 判定 |
|---|---|---|
| pet-alive | 宠物进程存活（petProcess） | 存活=ok |
| doubao-session | `~/.yfworking/doubao-session.json` JSON 解析 | 可解析=ok |
| editor-available | 编辑器依赖（原生窗口可用性基础资源）存在 | 存在=ok |

### F 配置数据（config-valid, provider-valid, data-dirs, skills-index）

| id | 数据源 | 判定 |
|---|---|---|
| config-valid | `~/.yfworking/config.json` + `settings.json` JSON 解析 | 均可解析=ok |
| provider-valid | 当前 provider 配置完整性（apiBaseUrl + apiKey 非空） | 完整=ok |
| data-dirs | sessions/skills/memory/chats 目录存在且可写（写入探针文件后删除） | 全部可写=ok |
| skills-index | `~/.yfworking/skills/_skill_index.json` 可解析 + 技能目录可扫描 | 正常=ok |
| last-boot | `~/.yfworking/logs/last-boot.json`（3.3 生成） | 上次启动成功=ok；上次异常=warn（面板显示"上次启动异常"卡片） |

### G 网络（provider-reach）

| id | 数据源 | 判定 |
|---|---|---|
| provider-reach | 最近一次内核 API 请求成功标记（bridge 会话 usage 事件有值） | 有成功记录=ok；近 7 天内全失败=warn |

### H 渲染健康（gpu-health, render-health）

| id | 数据源 | 判定 |
|---|---|---|
| gpu-health | `child-process-gone` GPU 事件计数 | 0=ok；>0=warn |
| render-health | `render-process-gone` / unresponsive 事件计数 | 0=ok；>0=warn |

> 实现说明：部分数据源（kernel-session 首 token 标记、provider-reach、bridge 重启计数、
> gpu/render 计数）需要 main.cjs / bridge.mjs 增加**轻量埋点**，见第 8 节改动清单。

## 6. IPC 契约（preload 暴露 `window.yfw.diag`）

| 通道 | 类型 | 入参 | 返回 |
|---|---|---|---|
| `diag:get-status` | handle | — | `{ overall, checks: CheckResult[], lastRunAt }` |
| `diag:rerun` | handle | `{ id }` | 单项最新 `CheckResult` |
| `diag:rerun-all` | handle | — | 全量重跑后的快照 |
| `diag:run-kernel-check` | handle | — | `{ ok, stdout, stderr, exitCode, latencyMs }`（手动内核自检） |
| `diag:export` | handle | — | `{ text }`（诊断报告全文，渲染层负责复制/保存） |
| `diag:open-log-dir` | handle | — | `shell.openPath` 结果 |
| `diag:get-boot-summary` | handle | — | `last-boot.json` 内容（无则 null） |
| `diag:status-changed` | send | snapshot | 状态翻转推送 |

## 7. 渲染层

### 7.1 入口

- `CommandPalette.tsx` `COMMAND_DEFS` 新增：
  `{ id: 'diagnostics', icon: Stethoscope, cat: 'help', labelKey: 'commandPalette.cmd.diagnostics', descKey: 'commandPalette.cmd.diagnosticsDesc' }`
- action：`openDiagnostics()`（uiStore 新增状态 `diagOpen`）。

### 7.2 DiagnosticPanel（新组件 `src/components/diagnostic/DiagnosticPanel.tsx`）

Dialog 宽屏（size="lg"），打开时 `diag:get-status` 拉取快照：

- 顶部：overall 状态徽章（正常/警告/N 项异常）+ 最近检测时间 + 「重新检测全部」按钮
- 中部：按组折叠列表，每项显示——状态图标（ok 绿 / warn 黄 / error 红 / unknown 灰）、
  名称、detail（截断）、lastCheckedAt、单项「重测」按钮
- 底部工具栏：
  - **内核自检**：调用 `diag:run-kernel-check`，显示原始 stdout/stderr（等宽字体小窗）
  - **日志尾部**：读取 `app.log` 尾部 100 行预览 + 「打开日志目录」按钮
  - **导出报告**：调用 `diag:export` → 复制到剪贴板 + 另存为文件（`dialog:save` 已有模式）

### 7.3 异常通知（两层）

**渲染层横幅**（界面正常时）：
- 新 store：`src/stores/diagStore.ts`（zustand）：`snapshot`、`overall`、`errorCount`、`diagOpen`
- 订阅 `diag:status-changed`：overall=error → 右侧滑入横幅「检测到 N 项异常」（5s 自动消失，
  可点击打开诊断面板）；warn 仅面板内标记。
- 横幅复用现有 toast/通知样式，不引入新 UI 体系。

**主进程原生对话框**（界面起不来时，见 3.3）：
- 启动失败兜底提醒，`dialog.showMessageBox` 弹出，告知日志已保存路径并支持打开日志目录。
- 与渲染层横幅互斥：有可用界面走横幅，无界面（启动失败）走原生对话框。

## 8. 文件改动清单

| 文件 | 改动 |
|---|---|
| `electron/log-tee.cjs` | **新增**：日志 tee（时间戳前缀、EPIPE 防护、轮转、uncaughtException/unhandledRejection 兜底落盘） |
| `electron/main.cjs` | 顶部 initLogTee；渲染层错误监听（did-fail-load/render-process-gone/console-message/preload-error/unresponsive）；启动打点 + last-boot.json；启动失败原生对话框；引入 DiagnosticMonitor；IPC 注册；事件埋点（gpu/render 计数、bridge 重启计数、executor 状态记录） |
| `electron/diag-monitor.cjs` | **新增**：检测引擎（注册表、自检/巡检/事件驱动、状态聚合） |
| `electron/preload.cjs` | 暴露 `window.yfw.diag` IPC 封装 |
| `server/bridge.mjs` | 埋点：会话首 token 标记查询、provider-reach 成功记录、内核崩溃退出标记 |
| `src/stores/uiStore.ts` | 新增 `diagOpen` 状态 + `openDiagnostics()` |
| `src/stores/diagStore.ts` | **新增**：诊断状态 store + 事件订阅 |
| `src/components/command-palette/CommandPalette.tsx` | 新增「诊断」命令 |
| `src/components/diagnostic/DiagnosticPanel.tsx` | **新增**：诊断面板 |
| `src/lib/diag.ts` | **新增**：`window.yfw.diag` 类型封装（或并入 preload 类型） |
| `src/i18n/...` | 新增 i18n 文案（commandPalette 命令 + 面板文本） |
| `src/types/index.ts` | `window.yfw.diag` 类型声明 |

## 9. 错误处理

- 日志写入失败：静默降级（console 原行为保留）。
- 检测函数异常：捕获 → 该项 status=error，detail=异常消息，不中断整轮巡检。
- IPC 调用时 monitor 未就绪（启动早期）：返回 `{ overall:'unknown', checks:[] }`，
  渲染层显示"检测初始化中"。
- 内核自检并发：用户连点时防抖（面板按钮 loading 态，主进程侧加 in-flight 守卫）。

## 10. 测试

- `electron/diag-monitor.test.mjs`（node --test）：
  - 状态聚合：error/warn/ok 组合 → overall 正确
  - 检测项注册表完整性：24 项齐全、id 唯一、分组合法
  - 单项检测函数：mock fs/端口/进程，验证 ok/warn/error/unknown 分支
  - 超时路径：mock 慢检测 → 超时按 error 处理
  - 推送去抖：状态未翻转不触发推送回调
- `electron/log-tee.test.mjs`（node --test）：
  - 时间戳前缀格式
  - 双写行为（原 console 输出 + 文件内容一致）
  - 轮转（>5MB 改名 app.log.1）
  - EPIPE 不抛出
- 手动验证清单（打包版）：
  - 正常启动 → 面板全绿，无横幅，app.log 有时间戳全量日志
  - 模拟 bun 缺失（临时改名 kernel/cli.mjs）→ kernel-files=error，横幅出现
  - 断网 → provider-reach=warn
  - 导出报告 → 剪贴板与文件内容一致、含日志尾部
  - **模拟界面启动失败**（临时改名 dist/index.html 或注入 did-fail-load）→ app.log 有
    渲染层错误记录 + last-boot.json 标记异常 + 原生对话框弹出提示日志路径

## 11. 边界（非目标）

- 不做历史日志浏览器（仅尾部 100 行预览）
- 不做自动修复动作（检测+展示+导出，修复靠人工/后续版本）
- 不做系统级通知（OS toast/banner；启动失败的 Electron 原生对话框属应用内兜底，不算系统通知）
- 不采集遥测/上报数据（报告由用户主动导出）
- 主进程自身无法启动的场景（系统级故障）不在覆盖范围（见第 3 节存活边界）
