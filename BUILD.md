# Ponos 构建与发布说明

> **必读**：本说明用于防止构建过程中意外破坏调试便携版。新会话中的 agent 请务必读完本文件再操作构建/打包。

## 目录约定

| 路径 | 用途 | 是否被自动清空 |
|---|---|---|
| `release/Ponos/` | **调试便携版**（手动维护的测试环境） | ❌ **不要触碰** |
| `release/installer/` | 安装包构建产物（NSIS） | ✅ 由 electron-builder 自动管理 |
| `release/win-unpacked/` | 解包后的可执行文件夹（旧产物） | 一次性遗留，不会再被生成 |
| `release/Ponos_ms92cd6u/` | 历史构建副本 | 手动维护，可清理 |

## ⚠️ 关键警告

`release/Ponos/` 是**手动维护的调试环境**，由 `cp` 命令同步源码 dist/server/public/pet 到该目录。

**绝不要**：
- 直接运行 `rm -rf release/Ponos`
- 在 `release/` 根目录运行 `electron-builder`（老配置会清空 `release/` 全部内容）
- 改变 `electron-builder.yml` 中 `directories.output` 的值（必须保持 `release/installer`）
- 改变 `package.json` 的 `build.directories.output`（必须保持 `release/installer`）

## 构建命令

### 仅构建前端
```bash
npm run build
```
输出：`dist/`（静态资源），可手工同步到调试版。

### 调试版同步（手动）
```bash
# 从源码 dist 同步到 release/Ponos/
rm -rf release/Ponos/dist/*
cp -r dist/* release/Ponos/dist/
cp -r server/* release/Ponos/server/
cp -r public/* release/Ponos/public/
cp YF/jiajia-pixel-pet/jiajia-pet.py release/Ponos/pet/jiajia-pet.py
```

### 打包安装包
```bash
npm run build:electron
```
输出：`release/installer/Ponos Setup x.y.z.exe`（不再生成到 `release/` 根目录）。

### 启动调试版
```bash
"release/Ponos/electron/electron.exe" "release/Ponos/electron/main.cjs"
```

## 端口配置

桥接服务器默认监听 **51311**（由 `PONOS_BRIDGE_PORT` 环境变量控制）。

**为什么不是 3099？** Windows WinNAT（Hyper-V/WSL/Docker）会预留 3095-3194 端口段，导致 3099 被封锁（`EACCES`）。51311 远高于动态端口范围（1024-15001）和常见 WinNAT 预留段。

### 修改端口

设置环境变量后重启应用：

```bash
set PONOS_BRIDGE_PORT=51311
# 然后启动 Ponos
```

**注入位置**（全部读取同一环境变量）：
- `server/bridge.mjs` — `PONOS_BRIDGE_PORT` env var，默认 51311
- `electron/main.cjs` — `PONOS_BRIDGE_PORT` env var，默认 51311
- `bin/cli.mjs` — `PONOS_BRIDGE_PORT` env var，默认 51311
- `src/lib/config.ts` — Vite `__BRIDGE_PORT__` 编译时常量（同环境变量注入）
- `YF/jiajia-pixel-pet/jiajia-pet.py` — `PONOS_BRIDGE_PORT` env var，默认 51311
- `start.bat` — 可以通过 `set PONOS_BRIDGE_PORT=...` 覆盖

## 版本号（三条独立版本线）

| 实体 | 常量 / 位置 | 当前值 | bump 命令 |
|---|---|---|---|
| Ponos 应用（turbo 内核版） | `APP_VERSION`（version.mjs） | dev 3.0.0 | `npm run bump:app -- 3.0.1` |
| Ponos-Turbo 内核（ponos-turbo） | `KERNEL_VERSION`（version.mjs + kernel/package.json） | dev 0.1 | `npm run bump:kernel -- 0.2` |
| Ponos GUI 发布线（旧内核稳定版） | 根 package.json `version` | 2.7.0 | 手改（electron-builder 打包名） |

**升级版本号禁止手改 `version.mjs`**，一律走 `scripts/bump-version.mjs`（`npm run bump:app -- <版本>` / `npm run bump:kernel -- <版本>`，加 `--dry-run` 演练）。脚本自动同步：
- `version.mjs` 对应常量（APP_VERSION / KERNEL_VERSION）
- `server/version.test.mjs` 期望值断言
- `kernel/package.json` semver（仅内核线：`dev X.Y` → `X.Y.0`）

版本格式：`dev <major>.<minor>[.<patch>]`，发布稳定后去掉 `dev` 前缀。

界面版本号 `__APP_VERSION__` 由 Vite 从 `version.mjs` 的 `APP_VERSION` 注入（`PONOS_APP_VERSION` env 可临时覆盖），不再读 package.json。改动版本号后需重新构建并同步 dist；GUI 发布线改 package.json `version` 只影响 electron-builder 安装包命名。完整架构见 `docs/architecture.md`。

## 故障排查

| 症状 | 原因 | 解决 |
|---|---|---|
| 调试版 `release/Ponos/` 不见了 | 误运行 `electron-builder` 旧版配置 | 从 git 历史恢复或重新手动构建 |
| 安装包生成到 `release/` 根目录 | `package.json` 或 `electron-builder.yml` 的 `output` 被改 | 改回 `release/installer` |
| 浅色主题下代码块看不清 | `--bg-code` 与 `--text-primary` 颜色冲突 | 检查 `src/styles/themes.css` 中是否定义了 `--code-text` token |
| 桌面有两个同名 `Ponos` 快捷方式 | 便携版与安装版快捷方式同名 | 区分使用即可，快捷方式指向不同 |
| 启动无窗口，进程僵尸堆积 | 端口被 WinNAT 封锁 + 无单实例锁 | 设置 `PONOS_BRIDGE_PORT=51311` 后重试 |
| `listen EACCES: permission denied 0.0.0.0:3099` | WinNAT 预留了 3095-3194 端口段 | 改用 51311 或更高端口（见端口配置章节） |

## 关键文件

- `electron-builder.yml` — electron-builder 配置文件（installer 输出目录、图标、NSIS 选项）
- `package.json` — `build` 块是 electron-builder 的另一份配置（与 yml 合并）
- `scripts/package-portable.cjs` — 手动打包便携版的脚本（创建 vbs 启动器 + 桌面快捷方式）
- `vite.config.ts` — 前端构建配置（`__APP_VERSION__` 注入）
- `src/styles/themes.css` — 4 套主题的 CSS 变量定义
