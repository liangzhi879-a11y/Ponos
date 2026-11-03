# Ponos-turbo 内核

> **可嵌入的本地 agent 内核**：一个 Node 进程跑完「模型 ↔ 工具 ↔ 会话 ↔ 记忆/知识 ↔ 子代理」的全部编排，
> 通过 NDJSON 协议对外服务。它只提供引擎，不提供界面 —— 桌面应用（Electron 渲染层、主题、安装包）在私有仓，
> 内核以 `kernel/` 目录随应用交付，边界见 §11。

![Node](https://img.shields.io/badge/node-%E2%89%A518-3c873a)
![Tests](https://img.shields.io/badge/tests-3068%20(3057%20pass%20%2F%2011%20skip)-brightgreen)
![Deps](https://img.shields.io/badge/npm%20deps-0-blueviolet)
![License](https://img.shields.io/badge/license-MIT-black)

---

## 1. 定位与边界

| 这是 | 这不是 |
|---|---|
| **内核与编排**：模型调用、工具执行与审批、上下文治理与压缩、会话持久化、记忆/知识库、技能、子代理、循环模式、MCP、工作流 DSL | **不含界面**：没有 Electron、没有主题/CSS、没有窗口管理 |
| **可独立运行**：`node kernel/cli.mjs` 即可起步（TUI / 一次性 print 两种形态），不需要 GUI | **不含宿主侧**：窗口、IPC 桥、打包面、渲染层这些由宿主提供；本仓只带 26 个工具（其中 `Screen` / `Vault` 的执行体由宿主注入，见 §6.1） |
| **协议化**：stdio NDJSON 协议，可被任意宿主内嵌 | **不发安装包**：NSIS / 便携包属于应用仓 |
| **零 npm 依赖**：只用 Node 内置模块（`node:test` / `fetch` / `crypto` …） | **不是"多模态大前端"**：视觉/OCR 能力是"调模型"，不是自带渲染器 |

## 2. 能力清单

数字按本仓代码核对（2026-11-03 内核线同步后）：

| 能力 | 落地模块 | 核实口径 |
|---|---|---|
| **26 个内建工具**（文件/命令、编排、知识与记忆、多模态与网络、检索与索引、屏幕与凭据六组，见 §6） | `kernel/tools.mjs` | `createToolRegistry({}).toolNames` 长度 26 |
| **四档审批**（默认询问 / 计划模式 / 接受编辑 / 全自动）+ 白名单 + 灾难命令硬拒 | `permissions` `approval-mode` `blacklist` `highrisk` `guards` | `docs/bridge-contract.md` §2.1「审批放行档位」+ `scripts/verify-permission-flow.mjs` |
| **上下文治理**：压缩、注入台账、保真约束、effort 策略 | `compact` `context` `inject-ledger` `fidelity` `effort-policy` | `kernel-tests/` 同名用例 |
| **循环模式**：`--fresh` / `--until`、轮次 profile、轮间校验、自动唤醒 | `loop` `loop-modes` `loop-profile` `loop-verify` `loop-commands` `auto-wake` | 同上 |
| **会话与记忆**：会话持久化、记忆检索、标签、团队工作区、技能历史 | `session` `memory` `memory-search` `tag-store` `team-store` `skill-history` | 同上 |
| **知识库**：导入（含 OCR/表格）、检索、注入、回收站 | `knowledge*`（8 个模块） | 同上 |
| **技能系统**：目录扫描、搜索、按需加载、**草案产出**（不装不生效） | `skills` `skill-dirs` `skill-search` `skill-drafts` `skill-forge` | `scripts/verify-skill-listing.mjs` |
| **项目索引（`ProjectAtlas`）**：按标识符/职责/关系召回，影响面分析；本地索引格式版本 `ATLAS_VERSION=6` | `atlas/`（16 个模块：`store` `query` `config` `term-index` `inject` …） | `kernel-tests/atlas-*.test.mjs`（13 个） |
| **按需工具检索（`ToolSearch`）**：工具太多时只把精简清单放进提示，命中后再取回完整 schema | `tool-search.mjs` + `tools.mjs` 的 `deferred` 机制 | `kernel-tests/tool-search*.test.mjs` |
| **子代理**：派发、并发约束、结构化回填 | `agents` `orchestrate` `graph` | 同上 |
| **工作流**：DSL → DAG → 执行器（本仓自带 `workflows/spec-dev`、`workflows/gen-review`） | `workflow` `workflow-dsl` `workflow-dag` `workflow-engine` `workflow-nodes` | 同上 |
| **MCP**：stdio / http 客户端、能力注册 | `mcp` `mcp-caps` `mcp-http` | 同上 |
| **可观测**：健康快照、自愈梯、成本与价格表、统计、脱敏审计 | `health` `health-snapshot` `heal-ladder` `cost` `model-prices` `stats` `redact` `audit` | 同上 |

## 3. 目录地图

| 路径 | 体量 | 职责 |
|---|---|---|
| `kernel/` | 143 个 `.mjs` + `wire/` 5 个（共 147 个文件；`atlas/` 16 个） | 内核全部逻辑；单层模块 + `wire/`（模型侧协议适配：anthropic/openai/usage/url/segment）+ `atlas/`（项目索引），入口 `cli.mjs` |
| `kernel-tests/` | 311 个测试文件（另 98 个宿主面测试不收录，见 `kernel-tests/EXCLUDED.md`） | 内核契约与行为测试（`node --test`） |
| `shared/` | 53 个文件（`.mjs` + `.cjs` 双份） | 内核与宿主共用的**纯逻辑**：文件安全、原子写、凭据、知识包、团队、egress、归因… |
| `scripts/` | 16 个 | 安装（sh/ps1）、构建、测试、版本推进、技能同步、5 个专项 `verify-*`、知识索引基准/召回评估、团队容器迁移 |
| `docs/` | 63 个文件 | `architecture.md`（架构与模块地图）、`bridge-contract.md`（协议契约）、`manual/`（配置）、`production/`、`superpowers/`（设计与计划留档） |
| `workflows/` | 2 个 | 工作流定义（`spec-dev`、`gen-review`） |
| `version.mjs` | — | 两条版本线：`APP_VERSION`（应用线）与 `KERNEL_VERSION`（内核线，当前 `0.2`） |

`kernel/` 内部按域归纳（**权威版见 `docs/architecture.md` §6 内核模块地图**）：

- **入口与配置**：`cli` `tui` `protocol` `api` `settings` `config` `config-scan` `legacy-env-boot` `provider` `perf`
- **主循环与上下文**：`engine` `engine-config` `context` `compact` `prompt` `inject-ledger` `fidelity` `effort-policy` `hooks` `heartbeat` `auto-wake` `loop*`
- **工具与审批**：`tools` `dyntools` `app-tools` `permissions` `approval-mode` `blacklist` `highrisk` `guards` `gen-guards` `readonly` `untrusted` `exec-base` `process-cli` `process-hygiene` `audit` `redact` `disabled`
- **会话、记忆、知识、技能**：`session` `memory` `memory-search` `tag-store` `team-store` `skill-history` `skill-dirs` `skills` `skill-search` `skill-drafts` `skill-forge` `knowledge*`
- **索引与按需工具**：`atlas/`（16 个模块）`tool-search`
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

## 6. 内建工具（26 个）

| 组 | 工具 |
|---|---|
| 文件与命令 | `Read` `Write` `Edit` `Glob` `Grep` `Bash` |
| 编排与子代理 | `Agent` `Task` `TodoWrite` `Workflow` `Skill` `SkillSearch` |
| 知识与记忆 | `MemorySearch` `KnowledgeSearch` `KnowledgeImport` `KnowledgeDelete` |
| 检索与索引 | `ToolSearch` `ProjectAtlas` |
| 技能草案 | `SkillDraft` |
| 多模态与网络 | `WebFetch` `WebSearch` `OCR` `Vision` `Browser` |
| 屏幕与凭据（执行体在宿主） | `Screen` `Vault` |

工具 schema 是**契约面**：改动 `kernel/tools.mjs` 里的名称/参数会同时影响宿主与快照，见 §8。
宿主还可以注入自己的工具（`kernel/app-tools.mjs` 是扩展点），本仓不包含那些工具的实现。

### 6.1 内核侧 / 宿主侧怎么分（2026-11-03 同步后的现状）

判据一句话：**能不能在没有界面的 Node 进程里、只依赖 `kernel/` + `shared/` 跑完**。
能 → 整个工具进内核；需要 Windows 原生 / Electron 主进程能力 → **只把 schema 留在内核**
（与 `Browser` 同构的 `ctx.*Driver` 委派），执行体留宿主。

| 工具 | 内核侧（本仓有） | 执行体 | 归属 |
|---|---|---|---|
| `ToolSearch` | `kernel/tool-search.mjs` + `tools.mjs` 的 `deferred` 机制 | 内核 | **内核** |
| `ProjectAtlas` | `kernel/atlas/`（16 模块，本地索引，只读 fs；索引格式 `ATLAS_VERSION=6`） | 内核 | **内核** |
| `SkillDraft` | `kernel/skill-drafts.mjs` + `skill-forge.mjs`（写 `.drafts/`，不装不生效） | 内核 | **内核** |
| `Screen` | `tools.mjs` 里的 schema；`run` 委派 `ctx.screenDriver` | **宿主**：`electron/screen-executor.cjs` + `screen.ps1`（UIA / SendInput） | schema 在内核，driver 在宿主 |
| `Vault` | `tools.mjs` 里的 schema（含解锁校验）；`run` 委派 `ctx.vaultDriver` | **宿主**：`electron/vault.cjs`（DPAPI + AES-GCM）+ 主进程审批闸门 | schema 在内核，driver 在宿主 |

★ 共同契约：缺 driver 时 `Screen` / `Vault` 应报**不可用**，不能让内核加载失败；`node kernel/cli.mjs`
在无宿主环境里必须照常起步（本仓测试覆盖这一点）。

★ 同步边界：**宿主面测试不进本仓**（它们 import 或读取 `electron/`、`src/`、`server/`、`dist/`、`docs/`），
98 个这样的文件逐条记在 `kernel-tests/EXCLUDED.md`，含判据与分组；这些断言由应用仓 CI 覆盖。

## 7. 协议与契约

- **传输**：stdio NDJSON，一行一条消息；请求带 `id`，响应/事件按 `id` 与 `type` 关联。
- **契约文档**：`docs/bridge-contract.md`（消息形态、事件表、IPC 面、§7/§7.1/§12 与实现同步维护）。
- **变更纪律**：改协议/工具 schema/台账前先读 `docs/architecture.md`；协议改动与文档必须同一次提交，
  否则 `scripts/verify-*` 与下游宿主的契约快照会对不上。

## 8. 测试与验证

```bash
node --test --test-timeout=120000 "kernel-tests/*.test.mjs" "shared/*.test.mjs"
```

当前状态（本次实测，本仓 `main`）：**3068 例 / 3057 通过 / 11 跳过 / 0 失败**
（跳过项是需要外部二进制或特定平台的用例）。收录 311 个内核测试文件 + `shared/` 的纯逻辑测试。

宿主面测试（98 个，import 或读取 `electron/`/`src/`/`server/`/`dist/`/`docs/`）**不收录**本仓，
逐条清单与判据见 `kernel-tests/EXCLUDED.md`；这些断言由应用仓 CI 覆盖。

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
- **宿主注入面（driver）**：内核只声明 schema，能力由宿主实现后经 `ctx` 传入 —— 本仓现已包含
  `Browser` / `Screen` / `Vault` 三个 schema，它们的 `ctx.browserDriver` / `ctx.screenDriver` /
  `ctx.vaultDriver` **都在宿主**。共同契约：内核侧可单独加载，缺 driver 时该工具**报不可用**而不是崩。
- **同步状态（2026-11-03）**：已完成一次**内核线整体同步** —— 应用仓 `kernel/`、`shared/`、
  `workflows/gen-review`、3 个内核脚本（知识索引基准/召回评估/团队容器迁移）全部进来，
  `tools.mjs` 取应用仓版本（26 个工具）。此后本仓**不再是应用仓的真子集之外的孤儿**，
  而是"应用仓内核 + 内核面测试"的公开镜像；同步方向永远是 **应用仓 → 本仓**，
  按 §6.1 判据分层：宿主面（`electron/`、`src/`、`server/`、`dist/`、`doctor/`）不进本仓。
- **契约优先**：内核 ↔ 宿主的唯一耦合面是 `docs/bridge-contract.md`。想在本仓改动它，必须同步改文档
  并在提交信息里写明影响面。

## 12. 许可

MIT，见 `LICENSE`。
