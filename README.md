# Ponos

**Ponos-turbo 内核 + 桌面 GUI** —— 零 npm 依赖的 agent 内核引擎，配 React + Vite + Tailwind 桌面客户端。

- **内核**（`kernel/`）：多文件 ESM agent 内核，零外部依赖，Node >= 18 即跑；可通过 `scripts/build-kernel.mjs`（bun build）打成单文件 bundle。
- **GUI**（`src/` + `electron/`）：桌面应用，Shadow 游戏平台主题（vaporwave 深黑霓虹），完整会话/设置/技能/子代理面板。
- **服务层**（`server/`）：bridge（GUI↔内核桥接）、transcript、经验库、打包器等。

---

## 一行部署内核（零依赖，无需 npm install）

### Linux / macOS / WSL

```bash
curl -fsSL https://raw.githubusercontent.com/USERNAME/ponos/main/scripts/install-kernel.sh | bash
```

### Windows（PowerShell）

```powershell
irm https://raw.githubusercontent.com/USERNAME/ponos/main/scripts/install-kernel.ps1 | iex
```

脚本自动完成：node 检查 → clone → 生成 `.env` → 冒烟验证 → 提示启动。

### 手动部署（等价一行）

```bash
git clone https://github.com/USERNAME/ponos.git && cd ponos/kernel && cp .env.example .env && node cli.mjs
```

> 首次使用先编辑 `kernel/.env` 填入 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL`（Anthropic 兼容端点）。

---

## 架构

```
GUI (React/Electron)  ──bridge──▶  server/bridge.mjs  ──spawn──▶  kernel/cli.mjs (Ponos-turbo)
                                                                       │
                                          NDJSON 标准输入/输出事件流（type: user / control_request）
```

- 内核协议契约：`docs/bridge-contract.md`
- GUI↔bridge 契约：`docs/architecture.md`
- 内核配置清单：`docs/manual/kernel-config.md`

## 开发

```bash
npm install        # 安装 GUI 依赖
npm run dev        # Vite dev server
npm run build      # tsc + vite build
npm test           # server + electron 测试
```

## 测试与验证

```bash
npm run typecheck  # TS 类型检查
npm test           # 全量测试（server/*.test.mjs electron/*.test.mjs）
```

## 许可

UNLICENSED（内部项目，教育/研究用途）
