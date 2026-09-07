# YFWorking 构建与发布说明

> **必读**：本说明用于防止构建过程中意外破坏调试便携版。新会话中的 agent 请务必读完本文件再操作构建/打包。

## 目录约定

| 路径 | 用途 | 是否被自动清空 |
|---|---|---|
| `release/YFWorking/` | **调试便携版**（手动维护的测试环境） | ❌ **不要触碰** |
| `release/installer/` | 安装包构建产物（NSIS） | ✅ 由 electron-builder 自动管理 |
| `release/win-unpacked/` | 解包后的可执行文件夹（旧产物） | 一次性遗留，不会再被生成 |
| `release/YFWorking_ms92cd6u/` | 历史构建副本 | 手动维护，可清理 |

## ⚠️ 关键警告

`release/YFWorking/` 是**手动维护的调试环境**，由 `cp` 命令同步源码 dist/server/public/pet 到该目录。

**绝不要**：
- 直接运行 `rm -rf release/YFWorking`
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
# 从源码 dist 同步到 release/YFWorking/
rm -rf release/YFWorking/dist/*
cp -r dist/* release/YFWorking/dist/
cp -r server/* release/YFWorking/server/
cp -r public/* release/YFWorking/public/
cp YF/jiajia-pixel-pet/jiajia-pet.py release/YFWorking/pet/jiajia-pet.py
```

### 打包安装包
```bash
npm run build:electron
```
输出：`release/installer/YFWorking Setup x.y.z.exe`（不再生成到 `release/` 根目录）。

### 启动调试版
```bash
"release/YFWorking/electron/electron.exe" "release/YFWorking/electron/main.cjs"
```

## 端口配置

桥接服务器默认监听 **51309**（由 `YFW_BRIDGE_PORT` 环境变量控制）。

**为什么不是 3099？** Windows WinNAT（Hyper-V/WSL/Docker）会预留 3095-3194 端口段，导致 3099 被封锁（`EACCES`）。51309 远高于动态端口范围（1024-15001）和常见 WinNAT 预留段。

### 修改端口

设置环境变量后重启应用：

```bash
set YFW_BRIDGE_PORT=51309
# 然后启动 YFWorking
```

**注入位置**（全部读取同一环境变量）：
- `server/bridge.mjs` — `YFW_BRIDGE_PORT` env var，默认 51309
- `electron/main.cjs` — `YFW_BRIDGE_PORT` env var，默认 51309
- `bin/cli.mjs` — `YFW_BRIDGE_PORT` env var，默认 51309
- `src/lib/config.ts` — Vite `__BRIDGE_PORT__` 编译时常量（同环境变量注入）
- `YF/jiajia-pixel-pet/jiajia-pet.py` — `YFW_BRIDGE_PORT` env var，默认 51309
- `start.bat` — 可以通过 `set YFW_BRIDGE_PORT=...` 覆盖

## 版本号

修改 `package.json` 的 `version` 字段后，`__APP_VERSION__` 会通过 Vite 构建时注入。所有发布目录（dist、release/YFWorking、release/installer）需要重新构建/同步。

## 故障排查

| 症状 | 原因 | 解决 |
|---|---|---|
| 调试版 `release/YFWorking/` 不见了 | 误运行 `electron-builder` 旧版配置 | 从 git 历史恢复或重新手动构建 |
| 安装包生成到 `release/` 根目录 | `package.json` 或 `electron-builder.yml` 的 `output` 被改 | 改回 `release/installer` |
| 浅色主题下代码块看不清 | `--bg-code` 与 `--text-primary` 颜色冲突 | 检查 `src/styles/themes.css` 中是否定义了 `--code-text` token |
| 桌面有两个同名 `YFWorking` 快捷方式 | 便携版与安装版快捷方式同名 | 区分使用即可，快捷方式指向不同 |
| 启动无窗口，进程僵尸堆积 | 端口被 WinNAT 封锁 + 无单实例锁 | 设置 `YFW_BRIDGE_PORT=51309` 后重试 |
| `listen EACCES: permission denied 0.0.0.0:3099` | WinNAT 预留了 3095-3194 端口段 | 改用 51309 或更高端口（见端口配置章节） |

## 关键文件

- `electron-builder.yml` — electron-builder 配置文件（installer 输出目录、图标、NSIS 选项）
- `package.json` — `build` 块是 electron-builder 的另一份配置（与 yml 合并）
- `scripts/package-portable.cjs` — 手动打包便携版的脚本（创建 vbs 启动器 + 桌面快捷方式）
- `vite.config.ts` — 前端构建配置（`__APP_VERSION__` 注入）
- `src/styles/themes.css` — 4 套主题的 CSS 变量定义
