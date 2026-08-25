# Ponos-turbo 内核

零 npm 依赖的 agent 内核引擎（Node ESM，Node >= 18 即跑）。由 Ponos 桌面应用经 bridge 以 stream-json 协议 spawn 驱动；本仓库为纯内核形态，可独立部署运行。

## 特性

- **零运行时依赖**：单进程纯 Node ESM，无需 npm install
- **工具系统**：Bash / Read / Write / Edit / Glob / Grep / Agent / Task / TodoWrite / WebFetch / WebSearch / OCR / Vision / Skill / SkillSearch / Workflow / Browser（路径边界校验 + 高危命令审批）
- **会话持久化**：transcript 权威源、`--resume` 流式恢复、两阶段压缩（结构剪枝 + 摘要 checkpoint）
- **神经图谱记忆**：经验沉淀双写图谱、append-only GraphStore、余弦 + 关键词检索注入
- **工作流引擎**：确定性 DAG（对标 Dify，自有 DSL）、与 Skill 平权、auto_trigger 自动触发、confirm/cron/webhook 触发
- **多 provider**：Anthropic 兼容端点（OpenAI/DeepSeek 等）、KV 缓存对齐、usage 归一化记账
- **技能生态**：本地技能根发现（`--skills-dir` / `<configDir>/skills`）+ SkillSearch 联网检索 Claude Code marketplace

## 快速开始

### 一行部署（零依赖）

Linux / macOS / WSL：

```bash
curl -fsSL https://raw.githubusercontent.com/liangzhi879-a11y/Ponos/main/scripts/install-kernel.sh | bash
```

Windows（PowerShell）：

```powershell
irm https://raw.githubusercontent.com/liangzhi879-a11y/Ponos/main/scripts/install-kernel.ps1 | iex
```

脚本自动完成：node 检查 → clone → 生成 `.env` → 冒烟验证 → 提示启动。

### 手动部署

```bash
git clone https://github.com/liangzhi879-a11y/Ponos.git
cd Ponos/kernel
cp .env.example .env
node cli.mjs
```

首次使用先编辑 `kernel/.env` 填入 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL`（Anthropic 兼容端点）。

## 协议

- 标准输入逐行 NDJSON（`type: user` / `control_request`），标准输出 NDJSON 事件流
- 协议契约：`docs/bridge-contract.md`
- 配置清单：`docs/manual/kernel-config.md`
- 架构与生产化：`docs/architecture.md`、`docs/production-plan.md`、`docs/production/`

## 开发

- 内核本体：`kernel/`（`cli.mjs` 为入口；engine/session/compact/tools 等模块）
- 版本管理：`version.mjs` 单一数据源，升级走 `scripts/bump-version.mjs`
- 单文件打包：`scripts/build-kernel.mjs`（bun build → `kernel-dist/cli.mjs`）

冒烟验证：

```bash
node kernel/cli.mjs --help
PONOS_MOCK_API=1 node kernel/cli.mjs --print --output-format stream-json --input-format stream-json
```

## 许可

UNLICENSED（内部项目，教育/研究用途）
