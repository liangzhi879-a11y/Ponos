# YFW-turbo 内核生产化规划（Production Plan）

> 用途：yfwturbo 内核从"评测/原型"走向"生产环境使用"的分阶段路线图。覆盖可靠性、安全、可观测、平台化、长会话、部署六大维度。
> 权威来源：kernel/（13 文件 2987 行）、server/bridge.mjs、electron/（GUI）、benchmark/（评测平台）。
> 更新日期：2026-08-21

**子项目细化文档**（每阶段独立文档：压力基线 → 能力映射 → 验收标准 → 任务清单 → 前端集成点 → 验证方式）：

| 文档 | 阶段 | 核心内容 |
|---|---|---|
| docs/production/reliability.md | P1 | 流式断线重连、优雅退出、崩溃自愈、并发治理、结构化日志 |
| docs/production/security.md | P2 | transcript 脱敏、env 白名单、审计导出、权限规则、路径加固 |
| docs/production/observability.md | P3 | 用量回传、健康接口扩展、诊断完备、成本预警 |
| docs/production/platform.md | P4 | provider 配置内核化、hooks、分层 settings、技能挂载 |
| docs/production/session.md | P5 | compact 关键信息保留、token 预算、记忆内核化、上下文预测 |
| docs/production/deploy.md | P6 | 配置文档化、schema 版本化、transcript 兼容、独立部署包 |

---

## 1. 定位与背景

yfwturbo 内核以 ~3000 行 JS（13 文件）实现成熟项目（claude-code 48188 行 / pi 28004 行 / deepseek-harness 53830 行）约 1/9~1/18 的体积，在评测任务（T001-T006 + SWE）上达到 ~70% 能力（T003 已优化至 27 次工具调用 / 272s，逼近 claude 的 16 次 / 222-340s）。

**体积买的是"正确性之外的确定性"**：评测环境（干净 worktree、单轮、API 稳定）是成熟项目体积收益最低的场景；生产环境（API 抖动、长会话、多用户、合规审计）正是体积投入最密集的地方。本规划的目标是：**保持 1/18 体积的轻量优势，精准补齐生产环境必需的高杠杆机制，不照搬历史包袱（UI 组件/遥测平台/多端适配/兼容层）**。

## 2. 现状能力盘点

**已具备（生产可用基础）**：
- 完整 agent 循环：engine.mjs（555 行）——工具执行/审批/重试退避（P0-1 指数退避+jitter，对照 pi）/流式
- 15 工具：Bash / Read / Write / Edit / Glob / Grep / Agent / Task / TodoWrite / WebFetch / WebSearch / OCR / Vision / Skill / Browser
- 会话持久化 session.mjs（JSONL transcript）+ `--resume` 恢复
- 上下文压缩 compact.mjs（275 行）+ 工具结果裁剪（CLAUDE_CODE_TOOL_RESULT_BUDGET_BYTES）
- 权限：highrisk.mjs（33 行）+ permissions.mjs（26 行）硬编码高危命令匹配
- 健康检查 health.mjs（112 行）+ `/test-provider` 诊断
- 评测平台 benchmark/（4 agents × 任务集 + 报告 + 成本统计 + 审计导出）
- 零 npm 依赖设计（OCR 走外部 python 引擎）

**已落地的探索效率优化**（2026-08-20 ~ 21）：
1. 探索纪律提示词 + prompt cache 显式化（b177404）
2. 工具描述效率规则 + cwd 注入 + resolvePath + Read 容量透明化（ed4b5fb）
3. 评测：T003 从 55 次/417s 优化至 27 次/272s（-51%/-35%），保持 pass

## 2.5 生产场景压力清单（设计基线）

各子文档的量化基线统一自下表；规划落地时以"能否扛住该压力"为验收准绳。

| 压力 | 量化基线 | 涉及阶段 |
|---|---|---|
| API 不稳定 | 断流/超时/5xx 占比 ≥1% | P1 |
| 进程生命周期 | 随用随启、随时关（切会话/关窗/睡眠） | P1 |
| 多会话并发 | 个人 5+ / 团队同机 20 并发 | P1/P3 |
| 长会话轮次 | 单会话 200~500 轮、>100K token | P1/P5 |
| 多人共享机器 | 2~5 用户、共享技能库 | P2 |
| 隐私与合规 | 对话含 key/客户数据；"执行过什么"可追溯 | P2 |
| 成本失控 | 月 token 消耗、缓存命中率漂移 | P3 |
| 多模型路由 | 2~10 provider（含视觉桥接） | P4 |
| 团队技能共享 | 20+ 技能版本一致 | P4 |
| 升级与漂移 | 月 2~5 次发布、多机行为一致性 | P6 |

## 3. 生产化差距分析（按风险排序）

### P0 风险（上线即出问题）
| # | 风险 | 现状 | 影响 |
|---|---|---|---|
| P0-1 | API 断流无恢复 | 流式中断即整轮失败（STREAM_IDLE_TIMEOUT 兜底，无重连续传） | 长任务中途失败 |
| P0-2 | 崩溃无自愈 | 进程被杀/异常 → 会话不可恢复（评测 T004 已暴露进程死亡） | 丢会话 |
| P0-3 | 无审计 | 生产环境必须知道"执行了什么命令/改了哪些文件" | 合规底线缺失 |
| P0-4 | 密钥管理 | api.mjs 读 env，日志/transcript 未脱敏，子进程 env 全量透传 | 密钥泄漏 |

### P1 风险（规模化暴露）
| # | 风险 | 影响 |
|---|---|---|
| P1-1 | 权限体系不可配置（highrisk 硬编码） | 无法按项目/用户定制 allow/deny |
| P1-2 | 并发会话（engine 单会话状态） | 多用户需多进程，资源管理缺失 |
| P1-3 | 上下文退化（compact 策略简单） | 数百轮长会话 token 预算失准 |
| P1-4 | 无监控（token/延迟/错误率指标） | 无法定位退化与成本失控 |

### P2 机会（产品力）
- hooks 自动化、settings 分层配置、多 provider 路由、MCP 生态
- 技能系统产品化（现有 gxtz-*/yfwx-* 技能挂载/更新机制）

## 4. 分阶段规划

### Phase 1：可靠性内核（生产底线）—— 2~3 周
| 任务 | 说明 | 验证 |
|---|---|---|
| 流式断线恢复 | api.mjs 流式中断 → 指数退避重连，从断点续传（session 已落盘，可重放） | mock 注入中断测试 |
| 优雅退出 | SIGINT/SIGTERM → flush session + 终止子进程 + 状态标记 | 杀进程后 resume 可恢复 |
| 结构化日志 | kernel 全链路 addLog（级别/时间戳/会话 id），log-tee.cjs 雏形扩展 | 日志回看测试 |
| 崩溃自愈 | 启动时检测上次未正常退出 → 提示恢复/清理 | 模拟崩溃测试 |

> 细化：docs/production/reliability.md（P0：R1-1 重连 / R2-1 优雅退出 / R3-1 崩溃检测）

### Phase 2：安全与审计（合规底线）—— 2 周
| 任务 | 说明 |
|---|---|
| 工具调用审计 | transcript 为权威源，补审计导出（谁/何时/执行了什么+结果摘要） |
| 密钥脱敏 | 日志/transcript 脱敏（ANTHROPIC_API_KEY 等），子进程 env 白名单化 |
| 权限规则文件 | settings 中 allow/deny/ask 规则（命令/路径/工具三级），与 highrisk 合并 |
| 路径边界加固 | 符号链接/路径穿越/大小写归一（withinBoundary 补 symlink 检测） |

> 细化：docs/production/security.md（P0：S2-1 脱敏 / S2-2 env 白名单 / S1-1 审计导出）

### Phase 3：可观测与运维（规模化基础）—— 2 周
| 任务 | 说明 |
|---|---|
| 指标采集 | 每轮 token/延迟/工具分布/成本 → 结构化 JSON（benchmark usage 逻辑下沉） |
| 健康接口扩展 | health.mjs 补：内存/会话数/API 连通/队列深度 |
| 诊断完备 | /test-provider 扩展为 /diag（env/工具/配置/skills 全量） |

> 细化：docs/production/observability.md（P0：O1-1 usage 回传 / O2-1 健康扩展 / O3-1 diag 补全）

### Phase 4：平台化（扩展性）—— 3~4 周
| 任务 | 说明 |
|---|---|
| hooks 生命周期 | PreToolUse / PostToolUse / UserPromptSubmit / SessionStart，JSON 配置化（对照 claude schemas/hooks.ts） |
| 分层 settings | user / project / local 三级合并（对照 claude settings.ts / pi settings-manager） |
| 多 provider 路由 | provider 表（模型/key/端点/重试策略），lib/llm-api.mjs 下沉内核 |
| provider 热切换 | 内核原生 switch_provider（会话暂停时可连带 baseUrl 切换，免重启进程；替代前端 env 注入 + spawn 探测） |
| 技能挂载 | skills 注册/启用/更新（skills-lock.json 机制完善） |

> 细化：docs/production/platform.md（P0：P4-1 配置传递链 / P4-2 hooks / P4-3 分层 settings / P4-4 技能发现 / P4-5 provider 热切换）

### Phase 5：长会话与记忆（产品力）—— 3 周
| 任务 | 说明 |
|---|---|
| compact 升级 | 关键信息保留（文件状态/todo/决策）、token 预算配置化（对照 dsh compaction-basic） |
| 记忆体系 | 跨会话记忆内核化（现有 ~/.yfworking/memory 机制） |
| 上下文健康 | context.mjs 扩展：容量预测、压缩预警 |

> 细化：docs/production/session.md（P0：L1-1 compact 保留 / L2-1 预算配置化）

### Phase 6：部署与分发（上线）—— 2 周
| 任务 | 说明 |
|---|---|
| 配置文档化 | 全量 env/CLI/settings 文档（docs/manual 产品说明书同步） |
| 打包 | electron-builder 已有（yfw-packaging 技能），补内核独立部署形态 |
| 升级兼容 | 配置 schema 版本化、transcript 格式向后兼容 |

> 细化：docs/production/deploy.md（P0：D1-1 配置清单 / D3-1 独立部署包）

## 5. 依赖链与并行度

```
Phase 1 ──→ Phase 2 ──→ Phase 3 ──┬──→ Phase 6
                                  ├──→ Phase 4 ──→ Phase 5
```

- P1→P2→P3 串行（可靠性是安全/观测的底座）
- P4（平台化）与 P5（长会话）可并行于 P3 之后
- P6（部署）收尾，依赖 P1-P5 全部完成

## 6. 探索效率持续项（并行于各阶段）

与生产化并行推进的评测驱动优化（对照三家源码机制，每个都先落地后评测验证）：

| 项 | 参照 | 状态 |
|---|---|---|
| Read 去重 stub（mtime 未变返回 stub） | claude FILE_UNCHANGED_STUB | ✅ 已落地（kernel/tools.mjs readCache，含测试） |
| 并行工具调用（只读工具并发） | deepseek 有界并行池 | ✅ 已有（engine.mjs P0-4 runToolBatch） |
| harness cache_read usage 解析缺口 | — | ✅ 已修（yfw.mjs 四字段累加 + costOf 缓存定价） |

## 7. 验收标准（总体）

- P1-P3 完成：模拟 API 断流/进程崩溃/密钥泄漏三场景均有防护与恢复
- P4 完成：hooks 脚本可跑通、settings 三级合并生效、≥2 个 provider 可路由
- P5 完成：500 轮长会话 token 预算稳定、跨会话记忆可检索
- P6 完成：内核可独立部署、旧 settings/transcript 升级不破坏
- 每阶段落地后跑全量回归（222+ tests）与 T003 评测确认无退化

## 8. P7 评测回归与优化（2026-08-21 完成）

P1-P6 全部落地后全量横评（yfw × T001-T006 + SWE001-006，deepseek-v4-flash），对比基线（08-20T14:24）：

- **T 系列 6/6、SWE 系列 6/6 全 pass**（基线 5/6 + 5/6），两个基线失败点均转 pass：
  - T004（08-20 fail）根因是 verify 期望 bug（byModelM1 漏算一条 m1 记录），已修（aebdc71）
  - SWE004（08-20 fail）本次通过
- **修复 1 项 P1 引入的真实缺陷**：R1-2 连接超时把 `AbortSignal.timeout` 并入 fetch signal，timer 在响应头到达后仍存活，30s 一到误杀仍在读取的长 thinking 流（deepseek 每轮 >30s 必现，T003 评测复现 "stream interrupted: timeout"）。修复为独立 timer 仅包裹 fetch（`599b9a8`），T003 复评 pass，全量单测 316/316
- 结论：**P1-P6 零退化**，轻量内核在 12 任务全量评测下达到全 pass

> 细化：docs/superpowers/plans/2026-08-21-benchmark-regression.md
