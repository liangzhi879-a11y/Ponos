# AGENTS.md

YFW-turbo 是净室重建的原创 agent 内核（代号 YFW-turbo），运行于 YFWorking 桌面应用，
由 bridge 以 stream-json 协议 spawn 驱动。本文件是仓库级开发守则，供 AI agent 与
人类开发者共用。内核架构设计见 `docs/superpowers/specs/2026-08-20-yfw-turbo-inner-core-design.md`。

## 仓库布局

```
kernel/         内核本体（Node ESM，零运行时依赖）
  cli.mjs       入口：stdin JSON 路由（user / control_request / control_response）
  engine.mjs    Agent 循环：消息→模型→工具→继续；审批挂起；turnStats
  api.mjs       Anthropic 协议流（fetch/SSE/usage 归一化）；mock 流（测试用）
  session.mjs   transcript 事件日志权威源 + surface 投影（压缩/resume 基础）
  compact.mjs   两阶段压缩：结构剪枝 + 摘要 checkpoint（<compacted-summary>）
  health.mjs    多因子健康打分（yfw_health 事件）
  context.mjs   零依赖 token 启发式计价 + 模型窗口表 + tokenLedger
  tools.mjs     工具注册表：Bash/Read/Write/Edit/Glob/Grep（路径边界校验）
  highrisk.mjs  高危 Bash 命令匹配（审批触发）
  permissions.mjs 工具权限判定（allow/ask/deny）
  protocol.mjs  wire 事件构造（init/assistant/result/control_request/health/summary）
  prompt.mjs   提示词三层组装：基础行为规范 + AGENTS.md + append 文件
server/         桥接层测试（内核测试文件统一放这里，*.test.mjs）
docs/           契约文档（bridge-contract.md）与 spec/plan
zz-smoke/       真实 API 冒烟脚本（smoke-real-api.mjs / interact-real-api.mjs）
benchmark/      基准评测（vendors 对照方案、harness）
```

## 命令

```sh
node --test "server/*.test.mjs"        # 内核全量测试（主要验证面）
node --test src/lib/transcriptAdapter.test.ts   # GUI 侧 transcript 适配测试
node kernel/cli.mjs --help             # 内核入口
node zz-smoke/smoke-real-api.mjs       # 真实 API 冒烟（需 ANTHROPIC_* env）
node zz-smoke/interact-real-api.mjs    # 人工交互测试（S1-S5 场景）
```

测试纪律（参照成熟方案）：
- 内核改动必须配套测试；新测试放 `server/`（不在 kernel/ 内）。
- 测试命令固定用 `node --test "server/*.test.mjs"`，不要自定义测试脚本。
- 真实 API 冒烟/交互测试仅在明确需要时运行（消耗额度）；mock 测试 `YFW_MOCK_API=1` 无网络。
- 提交前必须跑过全量测试，全部通过才提交。

## 内核架构铁律

- **transcript 是权威源**：模型可见的一切必须能从事件日志重建。请求消息一律
  `session.deriveMessages()` 派生，不单独维护 message 数组；压缩、resume、子代理
  fork 都建立在同一模型上。
- **压缩语义**：压缩只作用于 surface 派生，原文日志保留可回溯（禁止重写历史条目）。
  切点纪律——绝不拆散 tool_use/tool_result 对；开放尾巴返回 null。
- **零依赖**：内核无运行时依赖（单进程、可被 bun 直接 spawn）。新代码不得引入 npm 包；
  需树遍历/正则等能力时手写（见 tools.mjs 的 Glob/Grep 实现）。
- **单进程隔离契约**：每会话一个进程，不做进程池/多进程治理（spec §3.7 明确拒绝）。
- **usage 记账**：chunk 逐次 addUsage 累计（input/output/cache 各字段）；usage 只写
  轮次最终 assistant 条目，中间工具轮不带 usage。
- **KV 缓存对齐**：摘要调用 prefill 须与主请求前缀一致（system/工具定义/旧消息顺序
  相同），使 cache_read 命中；bridge 注入的 system prompt 文件不得含每次 spawn 变化
  的内容（时间戳/随机 ID），发现即固定化。

## 代码约定

- 全程 ESM（.mjs），顶层 import，禁止 inline import。
- 工具实现遵循"按需读取 > 结构裁剪 > 摘要压缩"：工具层按需读取（Read offset/limit、
  Grep context）优先，裁剪只是兜底。
- 工具返回统一 `{ content, isError }`（registry 归一化）；路径边界校验在工具内。
- 文件操作纪律：修改文件前先 Read 确认；Edit 的 old_string 需唯一或显式 replace_all。
- 不做向后兼容垫片，不做未要求的功能（YAGNI，见 spec §10）。
- 错误处理只在系统边界（用户输入、外部 API）；信任内部代码与框架保证。
- 不提交未经要求的文档文件；代码注释只解释不显然的逻辑。

## Git 纪律

- 只提交本次会话改动的文件；用显式 `git add <path>`，不用 `git add -A` / `git add .`。
- 提交前 `git status` 核对仅暂存自己的文件（工作区常有其他工作线的未跟踪项，
  如 benchmark/、zz-smoke/，不要误入提交）。
- 禁止 `git reset --hard`、`git checkout .`、`git clean -fd`、`git stash`、
  `git commit --no-verify`、force push。
- 用户未要求时不提交、不推送。

## 安全边界

- 不写入密钥/密码/API token/身份证号/银行账号（含注释、测试、文档）。
- Bash 高危命令（rm -rf、git push --force 等）走审批链路（can_use_tool 挂起），
  测试中用 `--dangerously-skip-permissions` 绕过时保持高危断言存在。
- 文件工具只在 `--add-dir` 注入的目录边界内读写（cwd / 技能根）。

## 用户指令覆盖

本文件规则与用户明确指令冲突时，以用户指令为准；执行前可先向用户确认。
