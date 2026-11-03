# Ponos-turbo 内核

> **可嵌入的本地 agent 内核**：一个 Node 进程跑完「模型 ↔ 工具 ↔ 会话 ↔ 记忆/知识 ↔ 子代理」的全部编排，
> 通过 NDJSON 协议对外服务。它只提供引擎，不提供界面 —— 桌面应用（Electron 渲染层、主题、安装包）在私有仓，
> 内核以 `kernel/` 目录随应用交付，边界见 §11。

![Node](https://img.shields.io/badge/node-%E2%89%A518-3c873a)
![Tests](https://img.shields.io/badge/tests-1083%20(1080%20pass%20%2F%203%20skip)-brightgreen)
![Deps](https://img.shields.io/badge/npm%20deps-0-blueviolet)
![License](https://img.shields.io/badge/license-MIT-black)

---

## 1. 定位与边界

| 这是 | 这不是 |
|---|---|
| **内核与编排**：模型调用、工具执行与审批、上下文治理与压缩、会话持久化、记忆/知识库、技能、子代理、循环模式、MCP、工作流 DSL | **不含界面**：没有 Electron、没有主题/CSS、没有窗口管理 |
| **可独立运行**：`node kernel/cli.mjs` 即可起步（TUI / 一次性 print 两种形态），不需要 GUI | **不含宿主侧工具**：屏幕读控、密码库、剪贴板、应用自控这些由宿主注入；本仓只带 21 个通用工具 |
| **协议化**：stdio NDJSON 协议，可被任意宿主内嵌 | **不发安装包**：NSIS / 便携包属于应用仓 |
| **零 npm 依赖**：只用 Node 内置模块（`node:test` / `fetch` / `crypto` …） | **不是"多模态大前端"**：视觉/OCR 能力是"调模型"，不是自带渲染器 |

## 2. 能力清单

数字按本仓代码核对（2026-11-03，`main` @ `c0160fc2`）：

| 能力 | 落地模块 | 核实口径 |
|---|---|---|
| **21 个内建工具**（文件/命令、编排、知识记忆、多模态四组，见 §6） | `kernel/tools.mjs` | `createToolRegistry({}).toolNames` 长度 21 |
| **四档审批**（默认询问 / 计划模式 / 接受编辑 / 全自动）+ 白名单 + 灾难命令硬拒 | `permissions` `approval-mode` `blacklist` `highrisk` `guards` | `docs/bridge-contract.md` §2.1「审批放行档位」+ `scripts/verify-permission-flow.mjs` |
| **上下文治理**：压缩、注入台账、保真约束、effort 策略 | `compact` `context` `inject-ledger` `fidelity` `effort-policy` | `kernel-tests/` 同名用例 |
| **循环模式**：`--fresh` / `--until`、轮次 profile、轮间校验、自动唤醒 | `loop` `loop-modes` `loop-profile` `loop-verify` `loop-commands` `auto-wake` | 同上 |
| **会话与记忆**：会话持久化、记忆检索、标签、团队工作区、技能历史 | `session` `memory` `memory-search` `tag-store` `team-store` `skill-history` | 同上 |
| **知识库**：导入（含 OCR/表格）、检索、注入、回收站 | `knowledge*`（8 个模块） | 同上 |
| **技能系统**：目录扫描、搜索、按需加载 | `skills` `skill-dirs` `skill-search` | `scripts/verify-skill-listing.mjs` |
| **子代理**：派发、并发约束、结构化回填 | `agents` `orchestrate` `graph` | 同上 |
| **工作流**：DSL → DAG → 执行器（本仓自带 `workflows/spec-dev/workflow.yml`） | `workflow` `workflow-dsl` `workflow-dag` `workflow-engine` `workflow-nodes` | 同上 |
| **MCP**：stdio / http 客户端、能力注册 | `mcp` `mcp-caps` `mcp-http` | 同上 |
| **可观测**：健康快照、自愈梯、成本与价格表、统计、脱敏审计 | `health` `health-snapshot` `heal-ladder` `cost` `model-prices` `stats` `redact` `audit` | 同上 |

## 3. 目录地图

| 路径 | 体量 | 职责 |
|---|---|---|
| `kernel/` | 86 个 `.mjs` + `wire/` 5 个（共 95 个文件） | 内核全部逻辑；单层模块 + `wire/`（模型侧协议适配：anthropic/openai/usage/url/segment），入口 `cli.mjs` |
| `kernel-tests/` | 122 个测试文件 | 内核契约与行为测试（`node --test`） |
| `shared/` | 32 个模块（`.mjs` + `.cjs` 双份） | 内核与宿主共用的**纯逻辑**：文件安全、原子写、凭据、知识包、团队、egress、归因… |
| `scripts/` | 13 个 | 安装（sh/ps1）、构建、测试、版本推进、技能同步、5 个专项 `verify-*` |
| `docs/` | 63 个文件 | `architecture.md`（架构与模块地图）、`bridge-contract.md`（协议契约）、`manual/`（配置）、`production/`、`superpowers/`（设计与计划留档） |
| `workflows/` | 1 个 | 工作流定义（`spec-dev`） |
| `version.mjs` | — | 两条版本线：`APP_VERSION`（应用线）与 `KERNEL_VERSION`（内核线，当前 `0.2`） |

`kernel/` 内部按域归纳（**权威版见 `docs/architecture.md` §6 内核模块地图**）：

- **入口与配置**：`cli` `tui` `protocol` `api` `settings` `config` `config-scan` `legacy-env-boot` `provider` `perf`
- **主循环与上下文**：`engine` `engine-config` `context` `compact` `prompt` `inject-ledger` `fidelity` `effort-policy` `hooks` `heartbeat` `auto-wake` `loop*`
- **工具与审批**：`tools` `dyntools` `app-tools` `permissions` `approval-mode` `blacklist` `highrisk` `guards` `gen-guards` `readonly` `untrusted` `exec-base` `process-cli` `process-hygiene` `audit` `redact` `disabled`
- **会话、记忆、知识、技能**：`session` `memory` `memory-search` `tag-store` `team-store` `skill-history` `skill-dirs` `skills` `skill-search` `knowledge*`
- **子代理与工作流**：`agents` `orchestrate` `graph` `workflow*`
- **MCP 与可观测**：`mcp*` `health` `health-snapshot` `heal-ladder` `disk-write` `disk-telemetry` `file-collab` `cost` `model-prices` `stats` `log` `opportunity-mine` `trace-project` `governance-router` `app-spec` `app-naming` `app-permissions`

## 4. 快速开始

### 一行部署（macOS / Linux / WSL）

```bash
curl -fsSL https://raw.githubusercontent.com/liangzhi879-a11y/Ponos/main/scripts/install-kernel.sh | bash
```

### Windows (PowerShell)

```powershell
iwr -useb https://raw.githubusercontent.com/liangzhi879-a11y/Ponos/main/scripts/install-kernel.ps1 | iex
```

两段脚本都是**幂等**的：检查 Node ≥ 18 → 克隆/更新到 `~/.local/opt/ponos-kernel` → 从
`kernel/.env.example` 复制 `.env`（已存在则跳过）→ 提示你填三个变量（§5）→ 跑一遍冒烟测试。

### 手动

```bash
git clone https://github.com/liangzhi879-a11y/Ponos.git
cd Ponos
cp kernel/.env.example kernel/.env      # 然后填下面三个变量
node kernel/cli.mjs                      # TUI 交互
```

一次性调用（脚本/CI 场景）：

```bash
node kernel/cli.mjs -p "用三句话解释这个仓库做什么" --output-format stream-json
```

冒烟（不花 token，只验装配）：

```bash
npm test                                 # scripts/test-kernel.mjs：展开 kernel-tests/ + shared/ 的用例再交给 node --test（支持 --filter）
node kernel/cli.mjs --help
```

## 5. 配置

最小配置是**三个变量**（`kernel/.env.example` 已给出模板）：

| 变量 | 含义 |
|---|---|
| `ANTHROPIC_BASE_URL` | 模型服务地址（Anthropic 兼容端点） |
| `ANTHROPIC_AUTH_TOKEN` | 鉴权令牌 |
| `ANTHROPIC_MODEL` | 默认模型 ID |

可选：`CLAUDE_CONFIG_DIR`（复用既有配置目录）、`PONOS_HOME`（数据根，默认 `~/.ponos`）。
配置来源优先级与逐项说明见 `docs/manual/kernel-config.md`（`--config` / `--skills-dir` 等命令行开关可覆盖）。

## 6. 内建工具（21 个）

| 组 | 工具 |
|---|---|
| 文件与命令 | `Read` `Write` `Edit` `Glob` `Grep` `Bash` |
| 编排 | `Agent` `Task` `TodoWrite` `Workflow` `Skill` `SkillSearch` |
| 知识与记忆 | `MemorySearch` `KnowledgeSearch` `KnowledgeImport` `KnowledgeDelete` |
| 多模态与网络 | `WebFetch` `WebSearch` `OCR` `Vision` `Browser` |

工具 schema 是**契约面**：改动 `kernel/tools.mjs` 里的名称/参数会同时影响宿主与快照，见 §8。
宿主还可以注入自己的工具（`kernel/app-tools.mjs` 是扩展点），本仓不包含那些工具的实现。

## 7. 协议与契约

- **传输**：stdio NDJSON，一行一条消息；请求带 `id`，响应/事件按 `id` 与 `type` 关联。
- **契约文档**：`docs/bridge-contract.md`（消息形态、事件表、IPC 面、§7/§7.1/§12 与实现同步维护）。
- **变更纪律**：改协议/工具 schema/台账前先读 `docs/architecture.md`；协议改动与文档必须同一次提交，
  否则 `scripts/verify-*` 与下游宿主的契约快照会对不上。

## 8. 测试与验证

```bash
node --test --test-timeout=120000 "kernel-tests/*.test.mjs" "shared/*.test.mjs"
```

当前状态（本次实测，本仓 `main`）：**1083 例 / 1080 通过 / 3 跳过 / 0 失败**（跳过项是需要外部二进制的对拍）。
122 个内核测试文件 + 3 个 shared 测试文件。

`scripts/` 里的专项验证（都在 CI 与本地可跑）：

| 脚本 | 守什么 |
|---|---|
| `verify-permission-flow.mjs` | 高风险命令审批链路（四档审批 → 硬拒） |
| `verify-highrisk.mjs` | 灾难命令/危险模式的匹配表 |
| `verify-experience-inject.mjs` | 新会话是否注入经验段 |
| `verify-skill-listing.mjs` | 宿主清单瘦身回归 |
| `verify-milestones-start.mjs` | `MILESTONE-START` 解析（进度协议） |

## 9. 构建与版本

```bash
node scripts/build-kernel.mjs     # → kernel-dist/cli.mjs（Bun 单文件产物，需本机有 bun）
node scripts/bump-version.mjs     # 推进版本线（读 version.mjs）
node scripts/sync-builtin-skills.mjs
```

- **零依赖**是硬约束：源码侧只用 Node 内置模块，`kernel-dist/` 才做单文件打包。
- `version.mjs` 里有两条线：`APP_VERSION`（应用仓推进）与 `KERNEL_VERSION`（本仓推进，当前 `0.2`）。
  发布内核时只动后者。

## 10. 文档索引

| 文档 | 内容 |
|---|---|
| `docs/architecture.md` | 架构图、线程/进程模型、**§6 内核模块地图**、上下文治理、安全模型 |
| `docs/bridge-contract.md` | 协议契约（消息/事件/IPC §7、§7.1、§12） |
| `docs/manual/kernel-config.md` | 配置来源与优先级 |
| `docs/production/` | 生产部署要点（`deploy.md` 等） |
| `docs/superpowers/` | 设计与计划留档（历史决策，读时注意日期） |

## 11. 与完整应用的关系

```
私有仓：完整应用（Electron 主进程 + 渲染层 + 主题 + 打包）
   └── kernel/           ← 本仓（内核线）：文件级随应用交付，协议不变即可整体替换
   └── electron/、src/   ← 宿主：窗口、屏幕读控、密码库、剪贴板、应用自控
```

- **两个仓、两条版本线**：应用线在私有仓推进；本仓只推进内核线（`KERNEL_VERSION`）。
- **宿主注入**：需要用屏幕、密码库、剪贴板等能力时，由宿主注册工具（`app-tools.mjs` 扩展点），
  内核不感知具体实现 —— 所以本仓的工具数是 21，而应用里会更多。
- **契约优先**：内核 ↔ 宿主的唯一耦合面是 `docs/bridge-contract.md`。想在本仓改动它，必须同步改文档
  并在提交信息里写明影响面。

## 12. 许可

MIT，见 `LICENSE`。
