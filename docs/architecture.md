# Ponos 系统架构

> 本文档梳理 Ponos 应用与 Ponos-Turbo 内核的分层结构、运行形态与版本管理。
> 版本线变更请走 `scripts/bump-version.mjs`（见文末「版本管理」章节）。

## 1. 分层结构

```
┌─────────────────────────────────────────────────────┐
│  Ponos 应用（GUI 层）                             │
│  React + Vite（src/）→ dist/ 静态资源                 │
│  WebSocket 客户端（src/hooks/usePonosCLI.ts）           │
│  Electron 壳（electron/main.cjs，主进程/窗口/桥架启停） │
└──────────────────────────┬──────────────────────────┘
                           │ WebSocket（ws://127.0.0.1:51311）
┌──────────────────────────▼──────────────────────────┐
│  桥架 bridge.mjs（server/，Node）                     │
│  职责：会话管理、transcript 持久化、内核进程生命周期、 │
│  diag 采集（kernelVersion/schemaVersion/buildId）     │
└──────────────────────────┬──────────────────────────┘
                           │ stdin/stdout NDJSON（stream-json）
┌──────────────────────────▼──────────────────────────┐
│  Ponos-Turbo 内核（kernel/，零 npm 依赖）               │
│  cli.mjs 入口：--print --output-format stream-json   │
│  engine.mjs 会话引擎 / tools / skills / memory ...    │
└─────────────────────────────────────────────────────┘
```

**依赖方向单向**：GUI → 桥架 → 内核。内核不反向依赖 GUI/桥架，可完全独立运行。

## 2. 内核独立运行

内核是纯 Node 程序，不依赖任何 GUI 组件，通过 stdin/stdout 的 NDJSON
（stream-json 契约）对话：

```bash
node kernel/cli.mjs --print --output-format stream-json --input-format stream-json \
  --verbose --dangerously-skip-permissions --permission-prompt-tool stdio
```

- 独立运行态：`kernel/tui.mjs`（全屏交互终端）、`zz-smoke/interact-real-api.mjs`、
  benchmark/harness 等直接以子进程方式驱动内核。
- 组装态：桥架以子进程方式拉起内核，`kernel + bridge + GUI = 完整 Ponos 应用`。

## 3. 桥架职责边界

| 职责 | 归属 | 说明 |
|---|---|---|
| 会话管理 / 并发上限执行 | 桥架 | 单进程内核无法感知其他会话 |
| transcript 持久化 | 桥架 | 内核 --resume 复用同一文件 |
| 模型/工具初始化 | 内核 | init 事件上报 model/tools/skills |
| 版本三源（kernelVersion/schemaVersion/buildId） | 内核产出 → 桥架采集 | init 事件 `version` 字段 |
| WebSocket 服务 | 桥架 | 默认 51311（dev 版 51310） |

## 4. 版本实体（三条独立版本线）

| 实体 | 版本线 | 当前值 | 存放位置 |
|---|---|---|---|
| **Ponos 应用**（turbo 内核版） | `APP_VERSION` | `dev 3.0.0` | `version.mjs` |
| **Ponos-Turbo 内核**（ponos-turbo） | `KERNEL_VERSION` | `dev 0.1` | `version.mjs` + `kernel/package.json` |
| Ponos GUI 发布线（旧内核稳定版，当前开发平台） | `package.json version` | `2.7.0` | 根 `package.json`（electron-builder 打包名） |

- 应用与内核分开管理：应用升级（bump app）不影响内核；内核升级（bump kernel）同步
  `kernel/package.json` 的 semver。
- 单一下游：内核 init 事件 `version` 字段 = `KERNEL_VERSION`（桥架采集为
  `diagInfo.kernelVersion`，语义即"内核版本"）。
- 版本格式：`dev <major>.<minor>[.<patch>]`；发布稳定后去掉 `dev` 前缀。

## 5. 环境隔离（dev 调试版 vs 正式版）

| 维度 | 正式版 | dev 调试版（Ponos-dev-3.0.0） |
|---|---|---|
| home | `~/.ponos` | `~/.ponos-dev`（PONOS_HOME 注入） |
| bridge 端口 | 51311 | 51310（PONOS_BRIDGE_PORT 注入） |
| 内核来源 | 正式 runtime | 源码直跑或 bootstrap 到 dev home runtime |
| 启动入口 | Ponos.vbs | Ponos-dev-3.0.0/Ponos.vbs |

隔离原则：前端（dist）、桥架（server）、内核均不与正式版共享模块/状态。

## 6. 版本管理（开发流程）

单一数据源：`version.mjs` 导出 `APP_VERSION` / `KERNEL_VERSION` / `SCHEMA_VERSION` /
`buildId()`。**升级版本号禁止手改**，一律走脚本：

```bash
node scripts/bump-version.mjs app 3.0.1      # 应用版本：dev 3.0.0 → dev 3.0.1
node scripts/bump-version.mjs kernel 0.2     # 内核版本：dev 0.1 → dev 0.2（同步 kernel/package.json）
```

脚本自动同步：`version.mjs` 常量 + `server/version.test.mjs` 期望值 +
`kernel/package.json` semver（内核）。见 `scripts/bump-version.mjs` 头部注释与 BUILD.md。
