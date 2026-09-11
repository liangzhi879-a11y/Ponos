# Spec：工作流第五模块 —— 可搭建·可绑定·可公开的自制工具（2026-09-11）

## 背景与输入

目标：把内核已有的工作流引擎升级为与 chat / task / agents / skills **并列的第五个功能模块**，
参考 Dify 的工作流形态，让用户能可视化搭建工作流、一键运行调试，并把工作流**绑定到指定 agent
或公开为全局工具**——本质上成为用户自己的工具开发与适配器机制。

现状实证（2026-09-11 源码核对）：

| 层 | 现状 | 缺口 |
|---|---|---|
| 内核引擎 `kernel/workflow.mjs`（1037 行） | 自有 YAML DSL（零依赖解析）；20 种节点（start/end/llm/code/template/if/assign/aggregate/http/document/tool/list/classify/extract/memory/store/agent/iterate/loop/confirm）；变量系统 `{{a.b.c}}`；cron 调度；webhook `POST /wf/run/<id>`；confirm 人工审批挂起；节点级审计哈希链 `verifyRun`；工具审批门（Bash 无门 fail-closed） | 执行是**线性单指针**（默认数组顺序 + `next` 跳转），无多入边 join、无并行汇聚、无错误分支、无节点重试；无动态工具注册 |
| 暴露方式 `kernel/tools.mjs:1306` | 仅一个通用 `Workflow{workflow, inputs}` 工具，靠提示词【可用工作流】清单选择 | 无"每工作流一个具名工具"；无绑定/公开三态 |
| 发现机制 `workflow.mjs:215` | 与技能同根 `~/.yfworking/skills/<id>/workflow.yml`；内置 spec-dev 由 `bridge.mjs:2512` 开机安装 | 与技能混在同一面板；无独立工作流根 |
| GUI | rail 仅 4 项（`src/stores/viewStore.ts:19`）；无工作流面板、无画布、无运行视图；`bridge.mjs` 有 `/skills` 无 `/workflows`；对话模式禁用 Workflow 工具（`bridge.mjs:861`） | 全部 GUI 能力缺失 |
| agent 绑定载体 | 专业 agent `skills[]`/`tools[]` 经 `agentStore.syncAgentsToKernel` 落为内核 `.md`（`kernel/agents.mjs:135`）；main session 无 `--agent` 参数 | 无 `workflows` 字段、无绑定解析、会话不携带 agent 身份 |
| 执行入口 | CLI 已支持 stdio `workflow_command`（list/run/verify/webhook/scheduler）与 `workflow_confirm`（`kernel/cli.mjs:744-752`）；事件已发 `wire.system('workflow', ev)`（`cli.mjs:334`） | 无 GUI 侧接线；无运行级 stop；无授权清单 |

决策记录（用户九项定案，逐条约束下文设计）：

1. 范围：**A+B+C+D 一期全做**（工具化 / 画布 / 运行调试 / 管理分发），并作为第五 rail 模块；
2. 画布语义：**升级为真 DAG**，只保留 DAG 语义，**内置工作流全量重写**为显式连线；
3. 存储：**独立工作流根**（不复用技能根）；
4. 公开语义：**本机全局注册为工具 + 可导出分享包**，两者都要；
5. 工具粒度：**每工作流一个具名工具**；
6. 引擎策略：单套 DAG 调度器（不并存双执行器）；
7. 运行宿主：bridge 起**独立常驻工作流宿主进程**；
8. 运行授权：**运行前授权清单，一次放行**（授权不免除审计）；
9. 画布技术：引入 **@xyflow/react**，套现有自研设计语言。

## 设计原则

1. **一份 DSL 是唯一真相**：画布、YAML 编辑器、导入导出、工具注册读写同一份 `workflow.yml`。
   画布只是编辑器之一——这保证"手工写 YAML 进阶用户"与"拖拽入门用户"不产生两套数据源。
2. **确定性执行优先于模型自觉**：DAG 调度、join 汇聚、错误分支、重试由引擎确定性完成，
   不由模型判断（延续 `kernel/workflow.mjs:1` 的"skill=灵活处理 / workflow=严格输出"定位）。
3. **执行一律经内核**：bridge 不 import 引擎（避免绕过权限门与审计链路）；宿主是常驻内核子进程。
4. **授权不等于免审计**：一次放行只免除交互打断，每次工具调用仍写哈希链——这是本模块可被
   企业审核场景接受的前提。
5. **纯逻辑与 UI 分离**：DSL 转换、能力推导、校验等纯函数放 `src/lib/workflowDsl.ts`，可 node 单测
   （沿用 `src/lib/*.test.ts` 纪律）；引擎侧 DSL/调度/节点/引擎四文件分离，各自可独立测试。
6. **破坏式升级必须显式提示**：只保留 DAG 语义意味着旧格式工作流不可直接运行，
   必须"列表标记需升级 + 一键迁移 + 原文件备份"，绝不静默失败。

## 方案

### §1 总体架构

```
GUI    rail=workflows → 列表 ⇄ 画布编辑器 ⇄ 运行/记录抽屉
       src/components/workflows/**   src/stores/workflowStore.ts   src/lib/workflowDsl.ts
         │  HTTP /workflows/*（CRUD / 导入导出 / 运行 / 确认 / 停止）
         │  WS   { type:'workflow_event', sessionId:'_wfhost', event }
bridge server/workflow-store.mjs（磁盘权威 CRUD：扫描/读写/版本/导入导出/元数据一致性）
       server/workflow-host.mjs（常驻宿主会话 _wfhost 生命周期 + grantToken 发放校验）
         │  stdin: workflow_command / workflow_confirm / cancel
内核   kernel/workflow-dsl.mjs（解析+校验+迁移）
       kernel/workflow-dag.mjs（就绪集合调度器：join / 并行 / 条件边 / 错误边 / 重试）
       kernel/workflow-nodes.mjs（20+4 种节点执行器，由原 execXxx 平移）
       kernel/workflow-engine.mjs（引擎装配：审计 / 事件 / 调度器 / webhook / cron / confirm）
       kernel/dyntools.mjs（工作流 → 具名工具动态注册，visibility 三态过滤）
磁盘   ~/.yfworking/workflows/<id>/workflow.yml        用户工作流（源，权威）
       ~/.yfworking/workflows/<id>/versions/<ts>.yml   保存历史（保留最近 20 版）
       ~/.yfworking/workflows/_bindings.json           agent 绑定与信任态
       ~/.yfworking/workflow-runs/<id>/<ts>-<runId>.jsonl  审计哈希链（位置不变）
       ~/.yfworking/workflow-runtime/                  宿主 cwd（脚本产物 / 临时文件）
```

同一定义双身份：**手动运行**（面板"运行"→ 授权卡 → 宿主张执行）与**注册工具**（模型按名调用）
共用同一引擎与审计链路。

### §2 DSL v2 —— 真 DAG 契约

```yaml
name: 周报生成
description: 拉取本周数据并生成周报
version: 1.0.0
triggers: [周报, weekly report]                     # 触发词（与 skill 同 schema）
trigger_config: { manual: true, schedule: "0 18 * * 5", webhook: false, auto_trigger: false }
settings: { max_parallel: 4 }                       # 同批可就绪节点的并行度上限
inputs:
  - { name: week, type: string, required: true, description: 第几周 }
nodes:
  - { id: start, type: start, label: 开始, position: {x: 0, y: 0} }
  - { id: fetch, type: http,  label: 拉数据, position: {x: 240, y: 0},
      config: { url: "https://api.example.com/week", method: GET },
      retry: { max: 2, delay_ms: 1000, on_error: fail } }      # fail | branch | continue
  - { id: gen,   type: llm,   label: 生成周报, position: {x: 480, y: 0},
      config: { prompt: "根据{{fetch.body}}生成周报", model: "" } }
  - { id: done,  type: end,   label: 结束, position: {x: 720, y: 0},
      config: { outputs: [{ name: report, selector: "{{gen}}" }] } }
edges:                                              # 执行真相（画布连线的落盘形态）
  - { id: e1, source: start, target: fetch }
  - { id: e2, source: fetch, target: gen }
  - { id: e3, source: gen,   target: done }
expose:
  mode: private | bound | public                    # 缺省 private
  tool_name: run_weekly_report                      # 缺省 run_<id 蛇形转写>
  bind_agents: [material-writer]                    # mode=bound 时生效
permissions:                                        # 运行前授权清单（声明式）
  tools: [Read, Write, Bash, WebFetch]
  write_dirs: ["<workspace>"]
  network: true
```

契约条目（每条都需要被校验器强制）：

1. **edges 是执行真相**，节点不再有 `next/next_true/next_false`。
2. **条件边用 `sourceHandle`**：`'true' | 'false'`（if 节点）、`'route:<i>'`（classify 第 i 类）、
   `'fail'`（配合 `retry.on_error: branch`）。
3. **多入边 = 自动 join**：节点在所有**未被跳过**的入边就绪后执行一次；全部入边被跳过 → 节点
   skipped 并向下游传播跳过。另提供显式 `join` 节点用于聚合（`config.mode: concat|array|first`）。
4. **子图（loop / iterate body）**：保留 `body: [nodeId...]` 声明，body 内节点间的边同样写在
   `edges`；body 节点不得连到主图节点（校验期报错）。调度器递归复用同一实现。
5. **布局信息 `position` 内联在节点上**（GUI 需要，引擎忽略）；不做独立的 layout 文件，
   避免"布局与定义两份真相"。
6. **变量引用**：`{{nodeId.field}}` / `{{inputs.x}}` / `{{item}}` / `{{index}}` / `{{iter}}`；
   校验器检查 `nodeId` 是否存在且为**上游可达**（拓扑序在前或祖先）。
7. **旧格式**：引擎只有一套 DAG 调度器。加载无 `edges` 的旧 YAML 时抛明确错误
   （`LEGACY_DSL`），GUI 列表标记"需升级"，提供一键迁移（确定性规则：数组顺序 → 顺序边；
   if 的 next_true/next_false → 条件边；迁移前把原文件备份到 `versions/legacy-<ts>.yml`）。
8. **内置工作流**：`workflows/<id>/workflow.yml` 全量重写为显式连线；`bridge.autoInstallBuiltinWorkflows`
   增强为**按 version 比对覆盖**已安装副本（避免旧格式残留在用户机器上导致启动即失败）。
9. **触发配置收敛到 `trigger_config`**：`manual`（是否允许手动运行，缺省 true）、
   `schedule`（cron 表达式，取代旧平铺字段 `schedule`）、`webhook`（是否开放
   `POST /wf/run/<id>`）、`auto_trigger`（取代旧 `auto_trigger` 平铺字段，命中 `triggers`
   触发词自动运行）。迁移时把旧 `schedule` / `auto_trigger` 平铺字段搬入 `trigger_config`
   并删除原字段——调度器与自动触发逻辑改读新位置。
10. **并发度**：顶层 `settings.max_parallel`（缺省 4）控制同一批可就绪节点的并行数；
    `iterate` 仍沿用节点级 `parallel_nums`（现有语义不变）；`loop` 恒串行（轮间共享 `var` 状态）。
11. **返回值合成（工具形态）**：模型调 `run_<slug>` 的返回 = `end` 节点的 `config.outputs`
    聚合结果；若存在 `answer` 节点，其渲染文本并入返回（多 answer 按拓扑序拼接）。
    手动运行时同一合成结果渲染到运行面板；`end.outputs` 为空且无 `answer` 时，
    返回最后一个成功节点的输出（保持与现有 `Workflow` 工具行为的连续性）。

### §3 内核引擎改造

`kernel/workflow.mjs` 拆为四文件（现有 `execXxx` 函数体平移，逻辑不变）：

| 文件 | 职责 |
|---|---|
| `workflow-dsl.mjs` | `parseYaml` / `renderTemplate` / `resolvePath` / `evalCondition` / `validateWorkflow` / `migrateLegacy` / `discoverWorkflows` / `loadWorkflow` |
| `workflow-dag.mjs` | 就绪集合调度器 + join + 并行 + 条件边 + 错误边 + 重试 + 跳过传播 + 子图递归 |
| `workflow-nodes.mjs` | 节点执行器（含新增 4 种） |
| `workflow-engine.mjs` | `createWorkflowEngine`（审计 / 事件 / webhook / cron / confirm / setDeps 保持现有签名） |

**调度器语义**（替换现 `run()` 的单指针 while）：

```
ready = {start}；settled = {}；skipped = {}
while (ready ∪ running) 非空:
    batch = ready 中入边全部 settle 且非 skipped 的节点（受 settings.max_parallel 限制，默认 4）
    并行执行 batch：
        节点失败 且 retry.max 未耗尽        → 退避重试（delay_ms 指数增长，上限 30s）
        节点失败 且 retry.on_error=branch   → 激活 'fail' 出边
        节点失败 且 retry.on_error=continue → 记录错误继续
        节点失败 且 retry.on_error=fail     → 整 run 失败（现有行为）
    条件边：源输出 route → 仅激活命中出边，其余出边标记 skipped
    入边全 skipped → 节点 skipped 并级联
    单节点超时：node.timeout_ms（现有语义保留）
```

保留不动：节点级审计哈希链（`auditAppend` / `verifyRun`）、confirm 挂起与 `resolveConfirm`、
cron 调度器、webhook 服务、`{ aborted }` 信号取消、`setDeps` 依赖注入契约、工具审批门
（`checkToolPermission`，含 Bash 无门 fail-closed）。

**节点集补齐**（现有 20 种之上）：

| 新增 | 语义 |
|---|---|
| `answer` | 对话型输出：作为工具时进入返回值；手动运行时渲染到运行面板（对标 Dify answer） |
| `join` | 显式多分支汇聚（自动 join 之外的显式形态；concat / array / first） |
| `subworkflow` | 调用另一工作流（复用"工作流即工具"；调用深度上限 5，超限报错防环） |
| 节点级 `retry` / `on_error: branch` | 重试与失败分支（对标 Dify fail-branch） |

**事件增补**（沿用现有 `wire.system('workflow', ev)` 通道）：新增
`edge_taken`、`node_skipped`、`run_cancelled` 三类；GUI 据此给节点着色
（待运行 / 运行中 / 成功 / 失败 / 跳过）。

### §4 工作流即工具（用户自制工具与适配器）

**动态注册** `kernel/dyntools.mjs`：

- 每个工作流 → 一个具名工具 `run_<slug>`；`input_schema` 由 `inputs[]` 自动派生
  （type / required / description），工具描述 = 工作流 `description` + 输入说明。
- 执行体调用同引擎 `run()`；带 `depth` 守卫防自递归（subworkflow 同源）。
- **可见性三态**（`expose.mode`）：
  - `private` —— 仅面板手动运行，模型不可见；
  - `bound` —— 仅 `bind_agents` 列出的 agent 可见（内核按会话 `--agent <id>` 读该 agent `.md`
    的 `workflows:` frontmatter 判定）；
  - `public` —— 全局注册，任何会话可用；受设置项"公开工作流上限"（缺省 20）约束，
    超限按最近使用频次截断，超出部分经提示词【可用工作流】清单给指针。
- `kernel/tools.mjs` 的 `toolNames` / `toolSchemas` / `run` / `isConcurrencySafe` 四个视图像现有
  `blocked` 一样叠加动态过滤（被禁/不可见工具的执行请求直接拒绝，防模型绕过工具列表）。

**绑定 agent**：`src/lib/agents.ts` 的 `Agent` 增 `workflows?: string[]`；`agentStore.syncAgentsToKernel`
写入 frontmatter；`kernel/agents.mjs` 解析该字段；bridge 新增 `--agent <id>` 使 main session 携带
agent 身份（在此之前，绑定只能靠 GUI 侧 `systemPrompt`/`skills` 注入口近似实现）。
绑定与信任态同时镜像到 `_bindings.json` 供 bridge / GUI 读取与列表展示。

**导出 / 导入分享包**：单文件 JSON（`.yfwflow`，零依赖，不引入 zip）：

```json
{ "format": "yfworking-workflow", "schemaVersion": 2, "exportedAt": "...",
  "workflow": "<workflow.yml 原文>",
  "manifest": { "kernelMinVersion": "0.2", "requiredTools": ["Bash"], "nodeTypes": ["llm","http"] } }
```

导入时先校验 `schemaVersion` 与 `requiredTools` 是否满足本机，再落盘并提示缺失依赖（不静默降级）。

### §5 运行宿主与权限授权

**常驻宿主**：bridge 起专用内核会话 `sessionId = '_wfhost'`（`mode = task`，
`cwd = <YFW_HOME>/workflow-runtime`，工具全开——真正的闸门是授权清单）。不进聊天记录、不占用户
会话；GUI 打开工作流 rail 时懒启动；空闲回收策略与现有会话一致。

**运行前授权清单（一次放行）**：

1. GUI 点"运行" → 前端 `deriveCapabilities()` 计算能力清单 = `permissions` 声明 ∪ 节点推导
   （`tool` 节点 → 该工具；`http` → 网络；`code` → 沙箱执行；`document` → Read/OCR；
   `agent` → 子 Agent 工具集；`store`/`memory` → 记忆读写）。
2. 弹授权卡：逐项列出（读文件 / 写这些目录 / 执行 Shell / 访问网络 / 调用这些工具），
   用户可勾除某项后仍运行——被勾除项在该次运行内 **fail-closed**（拒绝原因作为节点输出与
   事件，不挂起、不中断整轮）。
3. 确认 → 生成 `grantToken`（仅内存、一次运行有效、运行结束即失效）→ 随 `workflow_command`
   注入宿主。
4. 宿主内 `gateToolUse` 按 `runId` 查授权表：命中放行，未命中拒绝并回传输出。
5. **每次工具调用仍写审计哈希链**（授权只免除交互，不免除留痕）。
6. 可选"信任此工作流"（列表项菜单，可随时撤销）→ 后续运行跳过授权卡，审计仍全量。

**接口**：`/workflows/run`（带 grant）、`/workflows/confirm`（confirm 节点审批）、
`/workflows/stop`（运行级取消，内核新增 subtype）、`/workflows/runs`（历史列表）、
`/workflows/verify`（哈希链校验）、`/workflows` 系列 CRUD 与导入导出。

### §6 GUI —— 第五 rail

**rail 项**：`RailId` 增 `'workflows'`（`src/stores/viewStore.ts:15` + `RAIL_IDS` + `sanitizeRail`
白名单，`viewStore.test.ts` 补一条断言）。

**面板三层**：

1. **列表**（rail 面板）：分组"内置 / 我的 / 已公开"；每项显示节点数 / 触发词 / 暴露态 /
   最近运行状态 / 需升级标记；行菜单（运行 / 复制 / 导出 / 删除 / 绑定 agent / 信任 / 查看审计）。
2. **画布编辑器**（占满 work 区，`src/components/workflows/canvas/`）：`@xyflow/react` + 自定义
   节点组件，套现有设计语言（`.cut` 单对角切角 / 热边 / 四主题变量 / 玻璃态）。
   - 左侧节点面板按 Dify 式分类：输入（inputs/start）/ 模型（llm/classify/extract/agent）/
     处理（code/template/http/document/list/iterate/loop/memory/store）/ 工具（tool/subworkflow）/
     流程（if/join/assign/aggregate/confirm）/ 输出（answer/end）。
   - 右侧配置面板：按节点类型渲染动态表单 + **变量选择器**（`{{nodeId.field}}` 可视化插入，
     按上游可达性过滤候选）。
   - 顶部工具栏：保存 / 校验 / 运行 / 版本历史 / 导入导出 / YAML 双向切换（同一份源）。
   - 连线：条件边按 handle 分色（true/false/route/fail），悬空与环即时提示。
3. **运行抽屉**（右侧 420px，复用现有 `SecondTabId` 抽屉模式）：Tab A 实时运行（节点状态着色 +
   输出预览 + 授权卡 + confirm 审批 + 停止）；Tab B 历史记录（运行列表 + 单次步骤瀑布 +
   校验完整性按钮）。

**前端纯逻辑**（可 node 单测）：

- `src/lib/workflowDsl.ts` —— DSL 类型、`edges ⇄ 画布` 转换、`deriveInputSchema`、
  `deriveCapabilities`、`validateLocal`（环 / 悬空 / 变量引用 / body 越界 / 旧格式识别）；
- `src/stores/workflowStore.ts` —— 列表与编辑器状态、运行状态；persist 只落列表元数据与
  上次打开的工作流 id，不落运行态（避免持久化脏状态）。

**对话模式**：`bridge.mjs:861` 的 `CHAT_DISALLOWED` 是否放开 `Workflow` 由设置项决定，缺省保持
禁用（chat 模式定位纯聊，与技能同策略）。

### §7 落盘与验收

**落盘**：见 §1 架构图磁盘段（`workflows/` / `versions/` / `_bindings.json` /
`workflow-runs/` / `workflow-runtime/`）。

**验收方式（分节独立可验证）**：

| 节 | 验收 |
|---|---|
| §2 | `kernel-tests/workflow-dsl.test.mjs`：edges 解析、环 / 悬空边 / body 越界 / 变量不可达 / start-end 唯一性校验、旧格式 `LEGACY_DSL` 错误与 `migrateLegacy` 转换正确性（含备份） |
| §3 | `kernel-tests/workflow-dag.test.mjs`：多入边 join（全就绪才跑）、跳过传播、并行分支、条件边（true/false/route）、错误边、retry 退避与 on_error 三态、子图递归；`workflow-specdev.test.mjs` 改写为 DAG 版并保持"收敛语义"断言（判定基准从"步数"改为"节点完成集合"） |
| §4 | `kernel-tests/workflow-dyntools.test.mjs`：input_schema 派生、private/bound/public 三态可见性、未知/不可见工具调用被拒、subworkflow 深度上限、导出/导入往返一致性 |
| §5 | `server/workflow-host.test.mjs`：宿主懒启动、run/confirm/stop 注入、grantToken 发放与运行结束失效、未授权调用 fail-closed 且不挂起、审计仍落盘 |
| §6 | `src/lib/workflowDsl.test.ts`（DSL 转换/能力推导/本地校验）、`viewStore.test.ts` 补 rail 白名单；画布交互人工验收清单（拖拽 / 连线 / 条件边分色 / 变量选择 / 运行着色 / 历史瀑布） |
| §7 | 端到端：GUI 新建 → 画布搭 4 节点（含一个 if 分支）→ 运行 → 授权卡勾除一项 → 实时节点事件 → 记录里 `verifyRun` 通过 |

**实施顺序**：§2 + §3 内核（DSL 与调度器，含内置 spec-dev 重写与 bridge 升级逻辑）→ §4 工具化与
绑定 → §5 宿主与授权 → §6 画布与面板 → §7 收尾与端到端。前置依赖：§4 动态工具需 §3 引擎可用；
§6 画布依赖 §2 DSL 定型；§5 授权依赖 §4 能力推导（前端纯函数）。

**非目标（本期不做）**：

- 工作流的多人协作 / 云端同步（"公开"仅本机全局 + 单文件分享包，不做服务端市场）；
- 工作流版本控制的高级能力（仅保留最近 20 版快照，无分支 / 合并 / diff 审阅）；
- 引擎级分布式执行 / 跨机器调度（webhook 与 cron 仍在本机）；
- 图形化调试断点（仅"单节点试跑 + 运行记录回看"，不做逐步断点）。
