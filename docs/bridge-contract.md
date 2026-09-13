# YFWorking 桥接契约规格（Bridge Contract）

> 用途：GUI↔bridge↔内核 三层交互的**可重建契约基线**。目标是在不修改 GUI 的前提下，以自研/合规实现替换内核（净室重建）时，协议语义可逐条对照、可测试。
> 权威来源：`server/bridge.mjs`、`electron/main.cjs`、内核 `kernel/cli.mjs`（净室 ponos 内核，stream-json 模式）。
> 更新日期：2026-09-08（S4 净室改接后同步：运行时 = node；内核落点 `<home>/runtime/ponos-kernel/`；新版独立端口 51517/5197/4197；双版 env 隔离表见 §10；S6 身份定案）

---

## 1. 进程拓扑（运行架构）

```
┌────────────────────────────────────────────────────────────────┐
│ Electron 主进程 (node.exe, electron/main.cjs)                  │
│   ├── Browser 执行器 (electron/browser-executor.cjs, WS 客户端)│
│   └── spawn → server/bridge.mjs (Node: HTTP + WebSocket)       │
│             端口 51517 (新版独立默认，YFW_BRIDGE_PORT 可覆盖； │
│             在售旧版为 51309，可同机并行)                       │
│              ├── spawn(每会话一个内核进程) → kernel/cli.mjs     │
│              │     经 node 直跑，stream-json 模式              │
│              ├── HTTP REST（文件/转换/配置/技能/transcript…）   │
│              └── WebSocket（GUI 渲染层 + 桌面宠物 + 执行器）    │
├── GUI 渲染层 (React/Vite，file:// 或 localhost:5197) ← WS → bridge
├── 桌面宠物 (pet/jiajia-pet.py, Python Tkinter) ← WS → bridge
└── 内核进程 (node + cli.mjs, --print --output-format stream-json)
        stdin  ← NDJSON（user / control_request / control_response）
        stdout → NDJSON（system / assistant / result / control_request / …）
```

关键事实：
- **桥是唯一中枢**：GUI 不直接接触内核；内核也不直接接触 GUI。替换内核时只需保持"bridge 眼中的内核协议"，GUI 零改动。
- 内核启动链：Electron 主进程 → bridge → `bootstrapKernelToUserDir` 把内核镜像同步到 `<home>/runtime/ponos-kernel/`（目录名**专用**——默认 home 下也不与在售旧版 `~/.yfworking/runtime/kernel` 互覆；多文件源码内核整目录镜像，`../version.mjs` 等父依赖逃逸到 `<home>/runtime/`；规避 Program Files ACL）→ spawn。运行时 = node（D1），由调用方定位（bridge = `process.execPath`；Electron main = bundled node.exe 或 PATH 'node'）。`YFWORKING_KERNEL` 环境变量是**唯一逃生口**，可显式指定内核 cli.mjs 路径（值无效即抛错，绝不静默回退）。
- 内核空闲回收：会话内核进程空闲 10min 被 bridge `taskkill`（reapIdleKernels），下次发消息以 `--resume` 无缝重启。

## 2. 内核 spawn 契约（bridge → kernel）

命令（经 cmd.exe，参数均已引号转义；`<kernel>` = 安装候选 `<repo>/kernel/cli.mjs`（源码）或 `<repo>/kernel-dist/cli.mjs`（bundle），或 home 缓存 `<home>/runtime/ponos-kernel/cli.mjs` 兜底）：
```
"<node>" "<kernel>" \
  --print --output-format stream-json --input-format stream-json \
  --verbose \
  --approval-mode <manual|auto|loose|bypass> \
  [--dangerously-skip-permissions]        # 仅 loose/bypass 传（见下表）\
  --permission-prompt-tool stdio \
  --disallowedTools AskUserQuestion \
  [--resume <sessionId>] \
  [--append-system-prompt-file <%TEMP%\yfw-prompt-<sid>[.resume].txt>] \
  [--model <provider 主模型>] \
  [--add-dir <会话 cwd>] [--add-dir <技能根目录>]
```

### 2.1 审批放行档位（`--approval-mode`，2026-09-12）

档位由 `server/approval-mode.mjs` 决定 spawn 参数（`approvalSpawnArgs`）；会话级临时覆盖
（仅内存，进程退出即清）优先于 config.json 的全局档（`resolveEffectiveApprovalMode`）。

| 档位 | 传 `--dangerously-skip-permissions` | 语义（谁还会问） |
|---|---|---|
| `manual` | 否 | 普通 Bash 也问 |
| `auto` | 否 | 工具层写文件（Write/Edit/…）、联网、子 Agent 问 |
| `loose`（**默认**） | 是 | 只问高危 Bash（`server/highrisk.mjs`）与灾难命令 = 应用此前的真实行为 |
| `bypass` | 是 | 除灾难命令外都不问 |

**应用智控工具（`app_*`，2026-09-13）**：应用智控按用户提供的目标**动态生成**工具，静态表无法判定
其是否会改动外部数据，故 `kernel/approval-mode.mjs` 将其单独归入保守类 `appTool`
（允许档 `bypass`，与 `highRiskBash` 同级）：`manual` / `auto` / `loose` 三档**一律询问**，
仅 `bypass` 档放行。

> 之所以不能沿用既有的 `unknown`（允许档 `loose`）：默认档恰为 `loose`，`2 >= 2` 会**直接放行**，
> 等于把应用的写操作变成静默执行。`appTool` 的允许档刻意严于 `write`，确保兜底有效。
> read 放行 / write 询问的精确区分，由内核按 App Spec 的 `kind` 注入显式规则完成
> （显式规则优先级高于档位表、命中即定）。

硬约束（**不随档位变化**，内核侧 `kernel/blacklist.mjs`）：
`rm -rf /`、`rm -rf ~`、`mkfs*`、`format X:`、`diskpart`、`dd of=/dev/…`、`shutdown/reboot/halt/poweroff`。
命中时四档**都发 `can_use_tool`（带 `hard:true`）**——即仍弹窗、可单次放行，但：
① 不参与拒绝降级连击计数；② 弹窗文案为「本次放行」，**不存在"总是允许"记忆**
（回执固定 `decisionClassification:'user_temporary'`，内核仅在本次 tool_use 生效）。
`opts.disallowedTools` 里的工具在闸门处提前放行（如 chat 模式禁用的本地工具），
由注册表自己回"工具已被禁用"，避免 manual/auto 下弹无意义的窗。

旧内核兼容：忽略未知 flag（`cli.mjs parseArgs` 的 `default:` 分支），且因
`--dangerously-skip-permissions` 仍在而停在 `loose`；bridge 经 §4 的 `init.approval_mode`
回显比对发现不一致时报 `approval-mode-degraded`（§5）。打包前须跑 `node scripts/build-kernel.mjs`。

环境变量（`buildChildEnv()`，解析序统一 `YFWORKING_HOME || CLAUDE_CONFIG_DIR || ~/.yfworking`，见 server/yfw-home.cjs）：
| 变量 | 值 | 作用 |
|---|---|---|
| `CLAUDE_CONFIG_DIR` | `<home>` | 内核独立配置/会话目录 |
| `YFWORKING_HOME` | `<home>` | 数据根（隔离双版时指向专用目录） |
| `CLAUDE_CODE_AGENT_TRIGGERS` | `true` | 启用内核原生定时任务（CronCreate/…） |
| `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` | 用户配置的第三方 provider | 内核实际调用的 API |
| `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_SONNET/OPUS/HAIKU_MODEL` | provider 主/子模型 | 模型路由 |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | contextWindow | 自动压缩窗口 |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | 64000（可覆盖） | 输出 token 上限 |
| `YFW_HEALTH_COMPACT_COUNT` | 历史压缩次数（有值才注入） | 健康血条恢复。**内核读双名**（`PONOS_HEALTH_COMPACT_COUNT` / `YFW_HEALTH_COMPACT_COUNT`）并取两者较大值，非法值回落 0——此前只读 `PONOS_` 前缀导致该 seed 从未生效（2026-09-12 修） |

系统提示词注入：**不通过命令行传长文本**（cmd.exe 8191 字符限制），而是写入 `%TEMP%/yfw-prompt-<sid>.txt`（新会话）或 `.resume.txt`（resume），经 `--append-system-prompt-file` 传入；会话进程退出时删除。内容 = 身份提示词（或自定义 agent systemPrompt）+ 互动问答格式（ASK_USER 卡片规范）+ 里程碑协议 + 技能清单（resume 用精简版）+ 经验注入（沉积引导+摘要索引，可配置）。

## 3. 内核 stdin 协议（bridge → kernel，NDJSON 行）

| type | 载荷 | 语义 |
|---|---|---|
| `user` | `{ message:{role:'user',content}, priority?, uuid? }` | 投递一轮用户消息（队列化；`uuid` 用于生命周期追踪） |
| `control_request` | `{ request_id, request:{subtype} }` | 中断/取消。`subtype:'cancel'`（bridge 的优雅停止）、`'interrupt'`（abort 主查询）等 |
| `control_request` | `{ request_id, request:{ subtype:'reasoning_effort', payload:{value} } }` | 思考深度热切换（Task 12） |
| `control_request` | `{ request_id, request:{ subtype:'approval_mode', payload:{value} } }` | 审批档位热切换（2026-09-12）。`value` ∈ `manual/auto/loose/bypass`；非法值**不报错不崩**，回落默认档并回 `system/approval_mode_rejected`（§4）。生效后内核侧记 `appendMeta('approval_mode')` 审计 |
| `control_response` | `{ response:{ request_id, subtype:'success', response:{ behavior:'allow'/'deny', updatedInput, toolUseID, decisionClassification } } }` | 权限审批回执，解除 `can_use_tool` 挂起。`decisionClassification` 恒为 `'user_temporary'`（一次性，无"总是允许"记忆） |
| `anchor_applied` | `{ issueIds: string[] }` | 上下文失真「重新锚定」已生效（2026-09-12）：用户在 GUI 确认并发送锚点后，把这些失真证据标记为 resolved → 失真档**立即回绿**并进入观察期（`observeTurns` 轮）。**不是真值来源**：只表达"用户已处理"；内核按 id 匹配，未知 id 静默忽略。上报路径：GUI → `POST /session/anchor-applied`（§7）→ 内核对目标会话 stdin 写本消息 |

注：内核 CLI 还支持从 stdin 读取 agents JSON、systemPrompt 等（绕过 ARG_MAX）；`structuredIO.structuredInput` 为逐行解析器（print.ts:2834 起）。

## 4. 内核 stdout 协议（kernel → bridge，NDJSON 事件流）

非 JSON 行 → bridge 以 `raw` 转发（不解析）。

| type | 关键字段 | 语义 / bridge 处理 |
|---|---|---|
| `system` | `subtype`（init/status/session_state_changed/task_notification/task_started/task_progress/post_turn_summary/rate_limit/approval_mode_updated/approval_mode_rejected…） | 生命周期与系统事件；`task_progress` 视为低优先级可丢弃。`init` 携带 `approval_mode`（内核此刻**实际生效**档位，供 bridge 做旧内核检测）；`approval_mode_updated` 带 `{value}`，`approval_mode_rejected` 带 `{reason, value}` |
| `assistant` | `message.content[]`（text/thinking/tool_use 块）、`uuid` | 模型回复。bridge 从中**提取并剥离**里程碑标记与 `<!--ASK_USER-->` 卡片 |
| `result` | `usage{input_tokens,output_tokens}` | 一轮结束；cancel 生效确认点；`_turnActive` 复位 |
| `control_request` | `request{ subtype:'can_use_tool', request_id, tool_use_id, tool_name, input, decision_reason, hard?, mode? }` | 权限审批弹窗触发源（bridge 转发为 `approval`，GUI 批准后回 `control_response`）。`hard:true` = 命中灾难级硬黑名单（§2.1，四档都问、不计入降级连击）；`mode` = 发起询问时生效的档位。二者缺省省略（旧载荷逐字节不变） |
| `bridge_request` | `route:'browser', …` | 内置浏览器自动化请求 → **bridge 直连浏览器执行器，不转发 GUI**（防敏感载荷泄漏） |
| `stream_event` / `keep_alive` / `streamlined_text` / `prompt_suggestion` | — | 流式/保活/精简输出/建议（SDK 消费者用） |
| `error` | `{message}` | 错误 |
| `ponos_health` | `score/tier/compactCount/remainingPct/remainingTurns/suggestNewSession/reason/…` + `distortion?{}` | 上下文健康事件（档位变化才发；初始即绿不发）。**bridge 无需改动**：整包经 `event` 原样透传 GUI，`distortion` 为纯增量可选字段（缺省即 green）。字段语义见 §4.1 |
| `ponos_summary` | `{summary, compactCount}` | 压缩摘要落地事件（`yfw_summary` 同义转发），血条压缩脉冲与建议卡摘要来源 |

### 4.1 上下文健康：两个独立被测量（2026-09-12）

**压力**（还能装多少）与**失真**（还准不准）是两个被测量，统计上近乎不相关，**严禁互相赋值**：
`tier` 是压力语义，`distortion.tier` 是失真语义。血条宽度/颜色只读 `tier`；**一切建议弹窗与泛光只读 `distortion.tier`**
（压力档已降级为纯仪表，不再触发任何提醒）。

`ponos_health.distortion`（**可选字段，缺省一律按 green**——老内核/老快照不显示任何失真提示）：

| 字段 | 类型 | 语义 |
|---|---|---|
| `score` | number | 0–100。三轴**各自归一**后取最大值（不跨轴求和，避免不同性质的证据互相稀释） |
| `tier` | `green`/`amber`/`red` | 失真档。**强证据直通 red**；仅中证据时封顶 65（< red 阈值 70）只到 amber |
| `axes` | `{memory, coherence, goal}` | 三轴分数：记忆（压缩丢/改事实）、自洽（自相矛盾/陈旧引用）、目标（漂移） |
| `issues[]` | `{id, axis, kind, strength, turn, evidence, at, recurred?, recurredCount?}` | 证据清单（最多 10 条，强证据在前）。`id` 即去抖键；`strength` ∈ `strong`/`medium`。**复发**：证据被「重新锚定」处理后又再现 → 复活并带 `recurred: true`，`recurredCount` 递增（第几次复发）；前端抑制键为 `<id>#recurred<次数>`，故**每次复发各提醒一次**，同一复发态不重复弹 |
| `trigger` | string \| null | 去抖键（前端据此"同一证据只弹一次"）。**仅 red 且存在最强证据时非空**；观察期/无证据为 `null` |
| `observeUntilTurn` | number \| null | 回绿后的观察期截止轮次：期内复发才重新上报（防"刚关掉又弹"） |
| `anchorAvailable` | boolean | 是否可重新锚定（仅 red 为 true） |
| `anchorText` | string（**仅 red 附带**） | 确定性拼接的权威事实（首条真实任务 + 会话工作记忆 + 硬约束，≤4KB，不调用模型），供「重新锚定」直接注入。非 red 不带（省流量） |

真值优先级：**用户纠错 > 工具记录/文件系统/实体覆盖 > 模型自评**（LLM 保真审计上限 medium，绝不作结论来源）。
误报控制：无信号恒 green；用户显式改需求＝合法转向（锚点跟随、清目标轴）；显式演进语（改为/已修正/换成/弃用）不计矛盾。
可修复性：失真**有回绿路径**（`anchor_applied` → 证据 resolved → 立即回绿 + 观察期 3 轮），这点与压力红档不同（后者只有 5 分钟 dismiss 冷却）。
env 调参：`PONOS_FIDELITY`（`0` 总开关关）、`_WINDOW`（默认 12 轮）、`_DECAY`（0.85）、`_RED`（70）、`_AMBER`（40）、`_LLM_AUDIT`（默认开，每次压缩至多 1 次调用、`maxOut=512`、失败不计熔断）。

## 5. WebSocket：bridge → GUI（outbound 事件）

| type | 载荷 | 说明 |
|---|---|---|
| `event` | `{ data: 内核NDJSON事件 }` | 内核事件原样包装转发（主要通道） |
| `raw` | `{ data: 原始行 }` | 内核非 JSON stdout |
| `stderr` | `{ data }` | 内核 stderr 行 |
| `ack` | `{ requestId, sessionId }` | `send` 已受理 |
| `error` | `{ message }` | spawn 失败等 |
| `closed` | `{}` | 内核退出（空闲回收退出不广播，保留 UI 状态） |
| `cancelled` | `{ sessionId }` | cancel 已受理 |
| `milestones` / `milestone-start` / `milestone-ok` | 解析出的标记数据 | 从 assistant text/thinking 提取的结构化进度（散文兜底：`阶段 X/Y` 叙述驱动） |
| `question` | 解析后的 ASK_USER 卡片数据（或 `{raw}` 容错） | 提问卡片；解析失败带 raw 让前端兜底 |
| `question-resolved` | `{ sessionId }` | 提问已被回答/跳过（撤销嘉嘉等监听者提示） |
| `approval` | `{ toolUseId, command, requestId, reason, toolName, highRisk, hard, mode }` | 权限审批弹窗。`hard:true` = 灾难级（弹窗显示灾难级警示条，「本次放行」一次性）；`mode` = 内核发起询问时生效的档位 |
| `approval-resolved` | `{ sessionId, toolUseId }` | 审批已回执 |
| `approval-mode-changed` | `{ sessionId, data:{ mode, override, global, scope } }` | 生效档位变更（2026-09-12）。`mode` = 本会话**实际**生效档位；`override` = 是否存在会话级临时覆盖（**布尔**；为 true 时 GUI 显示「临时」，其值即 `mode`）；`global` = 全局档；`scope` ∈ `session`（用户切档）/`cleared`（覆盖被清，回落全局）/`global`（全局热生效推到本会话）。GUI 一律以此为准渲染，**不做本地乐观写** |
| `approval-mode-degraded` | `{ sessionId, data:{ expected, actual, message } }` | 内核回显的档位与 bridge 期望不符（跑的是忽略 `--approval-mode` 的旧缓存内核）→ GUI 弹系统提示条。**必须让用户看见**：否则他会以为选的 `manual` 生效了 |
| `approval-mode-rejected` | `{ sessionId, data:{ reason, mode } }` | 档位切换被 bridge 拒绝（非法值 / 工作流宿主会话 `_wfhost` 不支持临时覆盖）→ GUI 弹同一条提示条 |
| `pet:show-main` / `pet:quit-app` | `{}` | 宠物双击/退出广播 |
| `workflow_event` | `{ sessionId, event: { type:'start'\|'node'\|'node_skipped'\|'edge_taken'\|'end', runId, … } }` | 工作流运行事件（§7.1），`sessionId` 通常为宿主会话 `_wfhost` |

背压：单客户端 WS 缓冲 >8MB 标记过载，丢弃低优先级事件（milestones/milestone-*/question-resolved/raw/stderr/task_progress），<2MB 恢复（滞回）。

## 6. WebSocket：GUI → bridge（inbound 消息）

| type | 载荷 | 语义 |
|---|---|---|
| `send` | `{ sessionId, cwd, resumeId, systemPrompt, model, compactCount, prompt, requestId, priority, uuid }` | 发消息；无会话则 spawn（`resumeId` 有 → `--resume` 恢复，无 → 新会话注入 systemPrompt） |
| `cancel` | `{ sessionId }` | 优雅停止（`control_request(cancel)` + 6s 超时后 taskkill 兜底） |
| `answer` | `{ sessionId, data:{ answers[], notes } }` | 卡片回答 → 拼装成用户消息注入内核 stdin，广播 `question-resolved` |
| `question-dismiss` | `{ sessionId }` | 跳过卡片（CLI 保持等待，广播 `question-resolved`） |
| `approval-response` | `{ sessionId, toolUseId, approved }` | 审批结果 → `control_response` 注入内核 |
| `approval-mode` | `{ sessionId, mode }` | 会话级档位临时覆盖（2026-09-12，状态栏徽标）：`mode` ∈ 四档 → 记入内存 Map 并热切活内核；`mode:null` → 清覆盖回落全局。**不写 config.json**（全局档只在 `/config`）。非法值/`_wfhost` → `approval-mode-rejected`；成功后广播 `approval-mode-changed` |
| `browser_control` | `{ sessionId, command }` | 暂停/继续浏览器执行器（纯路由） |
| `executor:hello` | — | 主进程浏览器执行器注册（从 GUI 广播列表摘除） |
| `browser:exec:response` | `{ requestId, … }` | 执行器完成 → 回写内核 stdin |
| `browser:event` | `{ sessionId, event }` | 执行器事件 → 广播 GUI |
| `pet:show-main` / `pet:quit-app` | `{}` | 宠物请求显示主窗口 / 退出应用（广播） |

安全：WS 服务只接受本机可信来源——无 Origin、`file:`、`localhost/127.0.0.1/::1`；外部 Origin 一律 403。

## 7. HTTP REST API（同端口 51517）

| 端点 | 用途 |
|---|---|
| `/drives`、`/list-dir`、`/read-file`、`/raw-file`、`/write-file` | 文件系统访问（带 Origin 白名单保护） |
| `/convert-office`、`/read-sheet`、`/write-sheet`、`/read-docx`、`/write-docx` | Office 读写（调 python 脚本 `convert_docx.py`/`convert_xls.py`/`docx_edit.py`/`sheet_edit.py`） |
| `/transcript/list`、`/transcript/load`、`/transcript/search` | 会话转录（内核 transcript 为权威源，GUI 只读索引） |
| `/health`、`/diag/info` | 健康/诊断 |
| `/session/anchor-applied`（POST） | 上下文失真「重新锚定」上报（2026-09-12）：body `{sessionId, issueIds[]}` → 校验后向该会话内核 stdin 写 `anchor_applied`（§3）。`sessionId` 缺失/空白 → **400** `{ok:false,error:'sessionId required'}`（不允许无主消息落进某个会话）；`issueIds` 非数组/含脏值 → 清洗（去重、剔非字符串、单条限长 120、封顶 50）后照常 **200** `{ok:true}`。路由只做校验+转发，**判定永远在内核** |
| `/test-provider`、`/verify-provider` | provider 连通性 |
| `/config`、`/providers`、`/providers/*` | 配置读写（`~/.yfworking/config.json`，写前备份+迁移）。新字段（2026-09-12）：`approvalMode`（全局审批档，非法值被 `sanitizeConfigPatch` 钳回默认 `loose`）、`logPolicy`（日志策略，见 §7.2 与 `server/log-policy.cjs` 的 `normalizeLogPolicy` 钳制） |
| `/logs/list`、`/logs/tail`、`/logs/prune` | 运行日志端点（2026-09-12，见 §7.2） |
| `/skills`、`/sample-skills`、`/install-skill`、`/uninstall-skill` | 技能管理（写入 `~/.yfworking/skills/`） |
| `/worktrees`、`/branches` | git worktree/分支管理 |
| `/workflows`、`/workflows/*` | 工作流模块（CRUD/运行/停止/确认/审计记录/导入导出/绑定，见 §7.1） |

### 7.1 工作流模块（`/workflows`）（2026-09-11，UI Task 12）

实现：`server/workflow-routes.mjs`（`handleWorkflowRoute({url, req, reply, readJsonBody, store, host, root, runsRoot})`）+ `server/workflow-host.mjs`（常驻宿主会话 `_wfhost`）+ `server/workflow-store.mjs`（磁盘权威存储）。
挂载：`server/bridge.mjs` 在 HTTP 路由链**最前**、且仅 `pathname === '/workflows' || pathname.startsWith('/workflows/')` 时调用；未匹配的路径该函数返回 `false`，交回既有路由链（不吞其他端点）。
数据落点（`root` / `runsRoot` 由 bridge 注入）：`<YFW_HOME>/workflows/<id>/workflow.yml`、版本 `<id>/versions/<ts>.yml`（保留最近 20）、绑定 `<workflows>/_bindings.json`、审计 `<YFW_HOME>/workflow-runs/<name>/*.jsonl`。
`id` 由路径段 `decodeURIComponent` 后使用；`assertSafeId` 白名单（`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`，拒 Windows 设备名/尾点/`..`/保留字 `run|stop|confirm|runs|import|export|bindings|verify|validate`），`ts` 亦有白名单——两者违规统一 **400**（不是 500）。

路由表（全部同源 `http://127.0.0.1:51517`，请求/响应均为 JSON）：

| 方法 + 路径 | 请求体 | 响应（成功） |
|---|---|---|
| `GET /workflows` | — | `{ ok:true, workflows: [{id,name,description,version,triggers,expose,nodeCount,edgeCount,legacy,hasEnd,settings,updatedAt,lastRun}], root }` |
| `POST /workflows` | `{ id, model?, yaml? }` | `{ ok:true, id, backup }`（`id` 必填） |
| `GET /workflows/:id` | — | `{ ok:true, id, yml, validation, model }`（宿主解析；不存在 → 404） |
| `PUT /workflows/:id` | `{ model? , yaml? }` | `{ ok:true, id, backup, validation }` |
| `DELETE /workflows/:id` | — | `{ ok:true, id }` |
| `POST /workflows/:id/duplicate` | `{ toId }` | `{ ok:true, id, backup }`（`id` = 新 id） |
| `GET /workflows/:id/validate` | — | `{ ok, errors:[{code,message,node?}], warnings:[] }` |
| `GET /workflows/:id/versions` | — | `{ ok:true, versions: [{ ts, path }] }`（新→旧） |
| `POST /workflows/:id/rollback` | `{ ts }` | `{ ok:true, id, backup }`（回滚 = 用快照覆盖并再快照旧版） |
| `GET /workflows/:id/export` | — | `{ ok:true, bundle: { format:'yfworking-workflow', schemaVersion:2, exportedAt, workflow, manifest:{kernelMinVersion,requiredTools,nodeTypes} }, filename:'<id>.yfwflow' }` |
| `POST /workflows/import` | `{ bundle, id? }` | `{ ok:true, id, warnings:[], meta }` |
| `GET /workflows/bindings` | — | `{ ok:true, agents:{<agentId>:[wfId…]}, trusted:[wfId…] }` |
| `PUT /workflows/bindings`（POST 同义） | `{ agents, trusted }` | `{ ok:true }` |
| `POST /workflows/run` | `{ id, inputs?, capabilities:{tools,write_dirs,network} }` | `{ ok:true, runId, status, steps, outputs, finalOutput, unresolved?, error?, node?, auditPath }`（**同步等待跑完**才回执，见下「运行回执」） |
| `POST /workflows/stop` | `{ runId }` | `{ ok, error? }` |
| `POST /workflows/confirm` | `{ runId, node, action:'approved'\|'rejected', comment? }` | `{ ok, error? }` |
| `GET /workflows/runs?name=<wfId>`（兼容 `?id=`） | — | `{ ok:true, runs: [{ file, path, ts, steps, status }] }`（新→旧，≤20） |

失败态：`PUT/POST` 的内核校验失败 → `400 { ok:false, error:'校验失败', errors:[…], warnings:[…] }`（**不落盘**）；运行失败 → `400 { ok:false, error, code?, node?, errors? }`；`/workflows/*` 未匹配子路由/方法 → `404 { ok:false, error:'not found' }`；**宿主未注入 → `500 { ok:false, error:'工作流宿主未注入' }`**（不静默降级）；存储层入参违规 → `400`；其余异常 → `500 { ok:false, error }`。

**成功回执一律带 `ok:true`（契约，2026-09-12 修）**：客户端 `workflowApi.call()` 的失败判定是「HTTP 非 2xx」+「`body.ok === false`」，而消费方一律写 `const r = await listWorkflows(); if (!r.ok) …`。store 的纯数据回执原本**没有 ok 字段** → 成功被当失败，表现为**工作流列表恒显「暂无工作流」**（实际有数据）、运行前授权卡报 **「读取信任清单失败：undefined」**、运行历史恒空 —— 后端日志干净、curl 正常、单测全绿（单测只断言 `body.runs`/`body.trusted`，从不看 `ok`），因此极难自查。现由路由层 `json()` 助手统一补全（`obj.ok === undefined ? { ok:true, ...obj } : obj`；已有 `ok` 的内核/宿主回执原样保留），并加「ok 契约守卫」测试枚举全部路由断言 **2xx 必带 ok**。

**运行回执（`POST /workflows/run`）是同步的**：宿主 `h.run` 等内核 `end` 事件后返回完整结果（`status/steps/outputs/finalOutput/auditPath`），**不是"只回 runId"**。前端 `startRun` 必须把它当权威兜底（合成 node/end 事件补进运行视图）——只认 WS 事件流的界面在丢事件时会永远停在「等待事件…」，用户观感即"点了运行没反应"。

**`unresolved`（取值失败的返回值）**：内核变量作用域是 `{ inputs, var, <nodeId>: <该节点 output> }`——**节点 id 直接就是输出值**。故 `{{t.output}}` 在 t 输出为标量（template/llm/code/answer 均为字符串）时解析成 `undefined`，而 `JSON.stringify` 会把值为 `undefined` 的键**整条丢掉** → 上层只看到 `finalOutput:{}`，无从自查（实测：`{{t}}` → `"hello world"`，`{{t.output}}` → 丢键）。现 `end` 节点与 `synthesizeOutput` 均**保留键并置 `null`**，并把解析失败的项收集为 `unresolved: ["<outName> ← {{selector}}"]` 透传到回执与 `end` 事件；GUI 在 end 面板与运行前授权卡对 `{{x.output}}` 写法给出告警。

**CORS 预检（renderer 跨源调用必需）**：`OPTIONS` 由 bridge 统一应答 `204` + `Access-Control-Allow-Origin`（回显请求来源）+ `Access-Control-Allow-Headers: Content-Type` + `Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS`。**白名单必须含 `PUT/PATCH/DELETE`**：保存（`PUT /workflows/:id`）、信任清单（`PUT /workflows/bindings`）、删除（`DELETE`）都是带 `application/json` 的**非简单请求**，预检未声明该方法则**真实请求根本不发出** → 前端只收到 `TypeError: Failed to fetch`（用户现象即"信任清单无法写入"）。curl 与直调路由的单测都不走预检，此类缺陷须靠浏览器真实 origin 回归或预检契约测试（`server/auth-preflight.test.mjs`）捕获。

**`workflow_event` 事件形状**（WS outbound，§5；由内核 `workflow` 事件转发）：

```
{ type:'workflow_event', sessionId:'_wfhost' | '<发起会话id>', event: { type:…, runId, … } }
```

| `event.type` | 字段 | UI 语义 |
|---|---|---|
| `start` | `runId, workflow, nodes, mode` | 清空状态，全部节点 `idle` |
| `node` | `runId, node, node_type, status:'running'\|'done'\|'failed'\|'skipped', dur_ms?, output?, error?, route?, in_body?` | 节点着色 + 输出预览（`status:'skipped'` 与 `node_skipped` 同帧到达） |
| `node_skipped` | `runId, node, node_type, in_body?` | 节点置灰 `skipped` |
| `edge_taken` | `runId, edge, state:'active'\|'skipped', in_body?` | 边高亮/淡化 |
| `end` | `runId, status:'completed'\|'failed'\|'cancelled', steps, error?, node?, unresolved?` | 顶部状态 + 刷新历史（`unresolved` 非空时 GUI 显式提示"N 个返回值取不到值"） |

事件源：宿主会话（`_wfhost`）的事件由 `server/workflow-host.mjs` 的 `onEvent` 抛出；其他会话（`auto_trigger` 命中的内置触发）由 bridge 在 stdout 分发处直接广播——两者形状一致，只差 `sessionId`。同一帧也会经既有 `event` 通道原样转发一次（`data.type` 为事件名、`data.subtype === 'workflow'`），前端只按 `workflow_event` 消费即可。

**grant 生命周期（授权清单，fail-closed）**：
1. GUI 运行前必须提交 `capabilities = { tools:[], write_dirs:[], network:false }`；**缺失一律 400 且不运行**（授权清单是运行前置，不是可选参数）。
2. 宿主 `issueGrant(runId, mergeCapabilities({}, capabilities))` 记账（一次运行有效，键 = `runId`），随 `workflow_command{run}` 的 `grant` 与 `cwd` 注入内核；节点内 `checkToolPermission` 对未列入清单的工具调用**直接失败**（不是事后告警）——摘除项在本次运行内不生效。
3. 运行结束（成功/失败/停止）`finally revokeGrant(runId)`：grant 不跨运行、不跨工作流复用；`runId` 以内核回执为准回迁（防 id 分叉导致 `stop`/`confirm` 打空）。
4. `_bindings.json` 的 `trusted` 只影响前端默认勾选，**服务端不因 trusted 跳过 grant 校验**；审计不受影响（每次工具调用仍写哈希链）。

**内核侧通道**（内核 ← 宿主，`workflow_command` / `workflow_confirm`）：`load`、`save`、`save-raw`、`validate`、`run`、`stop`（另沿用 `list`/`verify`/`migrate`/`webhook`/`scheduler`）。`save` 收 `payload.model` → `serializeWorkflow`；`save-raw` 收 `payload.yaml` 原文（保留排版/注释，缺 `yaml` 时回退 `model`）；两者都只做「序列化 → 解析归一 → 校验 → 回传 `{ok, id, yml, validation}`」或 `{ok:false, error:'校验失败', errors}`，**内核绝不写用户工作流目录**（多内核会话 = 多写者会互相覆盖版本快照；写盘唯一写者 = bridge 侧存储层，内核仅 `migrate` 是显式例外）。

### 7.2 运行日志端点（`/logs/*`）（2026-09-12，UI 设置页「日志」）

实现：`server/logs-routes.mjs`（`handleLogsRoute({method, pathname, searchParams, home, policy})` → `{status, body}`，未命中返回 `null` 交回路由链）；
策略与文件操作真源：`server/log-policy.cjs`（CJS，桥与 Electron 主进程共用；GUI 侧 `src/lib/logUi.ts` 与之逐位一致，由 `server/log-policy-parity.test.mjs` 钉住）。
落点：`<YFW_HOME>/logs/{app.log, kernel-stderr.log, renderer-console.log}`（+ `.1`、`.2`… 轮转份）。
默认策略（`DEFAULT_LOG_POLICY`）：`{ persist:true, level:'info', maxFileBytes:5MB, maxFiles:3, maxAgeDays:14 }`；钳制 `LOG_POLICY_LIMITS`：单文件 64KB–100MB、份数 0–20、天数 1–365、`level ∈ debug|info|warn|error`。**只有显式 `persist:false` 才关闭**（字段缺失/拼错/字符串 `'false'` 一律保持开启）。

| 方法 + 路径 | 请求 | 响应（成功） |
|---|---|---|
| `GET /logs/list` | — | `{ ok:true, dir, persist, policy, limits, levels, files:[{name,base,index,size,mtimeMs}] }`（新→旧；`persist:false` 时 `files` 仍返回历史） |
| `GET /logs/tail?file=app.log&lines=200` | `lines` 钳 1–500（默认 200，非法→200） | `{ ok:true, file, lines:[…] }` |
| `POST /logs/prune` | — | `{ ok:true, removed, freedBytes, files:[…] }` |

失败态：文件名不合规（穿越/非白名单/`k > maxFiles`）→ `400 { ok:false, error }`；`/logs/prune` 用 GET → `405`；`/logs/*` 其他子路径 → `404`。
文件名校验三重（`assertLogFileName` + 基名白名单 `{app.log, kernel-stderr.log, renderer-console.log}` + `resolve(join(dir,name)).startsWith(dir+sep)`）——`../config.json` 之类一律 400，**绝不读到日志目录以外的文件**。
`persist:false` = 只停止写入：**绝不删除已有日志**，`/logs/tail` 与 `/logs/prune` 照常可用。
`[立即清理]`（prune）只删轮转份（`.1`、`.2`…）并把当前主文件轮转成 `.1`——主文件从不被直接 `unlink`（`kernel-stderr.log` 的崩溃原文可能正被诊断读取）；不受 `persist` 开关影响（用户主动点清理即明确意图）。
**明确不在日志策略管辖内**：`projects/**/*.jsonl`（内核 transcript = 权威对话档案）、`sessions/**`、`chats/**`、`runs/*.running|.err`、`config.json(.bak*)`、`memory/ skills/ workflows/ browser-whitelist.json auth.json`。

## 8. 会话生命周期

- 会话以 `sessionId` 为键存于 bridge 内存；一个会话 = 一个内核进程。
- 新会话：spawn + 注入身份/技能/经验提示词文件；resume：`--resume <id>` + 精简技能清单。
- 轮次活跃跟踪：`assistant` 事件开轮、`result` 事件闭轮；空闲 10min → `taskkill` 回收（`_reaped` 置位，不广播 `closed`）。
- 取消语义：`control_request(cancel)` → 内核 abort 主查询（ShellCommand 真杀 bash）+ killAllRunningAgentTasks（子 agent 逐个 abort）；6s 内持续输出则回退 `taskkill -F -T`。内核进程保留，会话可无缝续聊。
- 崩溃统计：非零退出码且非主动取消 → `diagInfo.kernelCrashCount++`。
- 档位覆盖生命周期（2026-09-12）：会话级临时覆盖（§6 `approval-mode`）只存 bridge 内存 Map；
  进程 `close`/`error`（含 provider 切换重建进程、空闲回收）即清并广播 `approval-mode-changed{scope:'cleared'}`，
  徽标可见地弹回全局档。⇒ **进程重建后生效的必是全局档**（这也是 GUI 把 `init.approval_mode` 回显
  一律标 `override:false` 的依据）。

## 9. 净室重建的契约边界（替换内核时）

**必须保持**（GUI 零改动的前提）：
1. 内核 spawn 参数与 env 契约（§2、§2.1）——尤其 `stream-json` 输入/输出格式与 `--permission-prompt-tool stdio`、`--disallowedTools AskUserQuestion`、`--approval-mode`（替换内核时必须同样识别该 flag 并回显，否则 bridge 会报 `approval-mode-degraded`）、**灾难级硬黑名单底线**（§2.1，四档都不放开）。
2. 内核 stdin/stdout NDJSON 语义（§3、§4）——`user`/`control_request`/`control_response` 输入；`system`/`assistant`/`result`/`control_request`/`bridge_request` 输出；`can_use_tool` 的 `hard`/`mode` 字段与 `system/init` 的 `approval_mode` 回显。
3. 里程碑标记与 ASK_USER 卡片在 assistant 文本中的**输出格式**（bridge 提取/剥离依赖其结构）。
4. HTTP REST 端点与响应形状（§7，GUI 直接调用）。
5. WS 事件/消息形状（§5、§6）。

**可自由替换**（已是自研，直接复用或重构）：
- `electron/browser-executor.cjs`、`electron/browser-common.cjs`（浏览器自动化执行器，独立于内核）
- `server/` 全部 python/Node 模块（文件转换、水印、transcript、askuser、milestones、经验注入）
- `pet/`、GUI 渲染层、`~/.yfworking/skills/` 技能体系

**替换面** = 内核的 stream-json 语义实现：Agent 循环（消息→模型→工具→继续）、工具执行器、`can_use_tool` 权限协议、`bridge_request(browser)` 路由、会话持久化（`--resume` 兼容）。

**净室注意事项**：
- 从本契约（用户可见行为 + 公开文档）写实现，不照搬内核源码的文件结构/命名/注释/提示词原文。
- 消息类型名与事件形状是跨层契约（§3-§6），保留是协议需要而非代码抄袭；实现内部的模块划分、算法、提示词应原创。
- 身份提示词（YFW_*）、技能清单注入、经验注入等 bridge 侧文本已是自研内容，可直接沿用。

---

## 10. S4 净室改接实录（2026-09-08，双版隔离取值表）

S4 把 bridge 内核解析/构建/bootstrap 全指向本库内核，并落地在售旧版 ↔ 新版净室的双版隔离取值。两版默认值互不交集，可同机并行：

| 隔离资源 | 旧版在售 | 新版净室（S4 起默认） | 覆盖 / 说明 |
|---|---|---|---|
| 内核运行时 | bun 布局（legacy） | **node**（D1：bridge = `process.execPath`；Electron main = bundled node.exe 或 PATH `node`） | 由调用方定位 |
| bridge HTTP+WS 端口 | 51309 | **51517** | `YFW_BRIDGE_PORT` |
| vite dev / preview 端口 | 5173 / 4173 | **5197 / 4197** | `YFW_VITE_PORT` / `YFW_VITE_PREVIEW_PORT` |
| 数据根 home | `~/.yfworking`（在售） | 默认 `~/.yfw`（净室专属根，2026-09-09 串配置事故修复：各启动入口兜底注入 `YFWORKING_HOME=~/.yfw`——electron/main.cjs 模块头、dev start.bat、bin/yfworking.cmd；显式设 `YFWORKING_HOME=~/.yfworking` 可临时切回读旧会话） | 解析序 `YFWORKING_HOME \|\| CLAUDE_CONFIG_DIR \|\| ~/.yfworking`（server/yfw-home.cjs，模块默认不变，仅入口接线兜底） |
| provider 行为画像 | 无 | config.json provider 可选字段 `profile`（'auto'\|'cloud'\|'local'，auto 启发式：私有网段→local、云域名→cloud、http 公网 IP→local）+ 显式覆盖 `temperature`/`maxOutputTokens`/`firstByteMs`/`idleMs`。本地默认：温度 0.6、提示词 lean 精简纪律段（`PONOS_PROMPT_TIER`）、输出预算 16384；云端零注入（=现状）。唯一决策点 `server/provider-profile.mjs`，经 buildChildEnv/syncKernelSettings 注入 env；syncKernelSettings 先剔除受管键再并入（防切回云端残留） | 2026-09-09 本地模型系统性适配；身份提示词同批动态化（`buildIdentityPrompt(model)`，不再硬编码 deepseek-v4-flash） |
| 内核缓存落地目录 | `~/.yfworking/runtime/kernel`（cli.mjs + vendor/ripgrep，在售使用中，**绝不可覆写**） | `<home>/runtime/ponos-kernel`（多文件源码整目录镜像，专用目录名不互覆，D3） | 2026-09-08 覆写事故固化为专用目录 |
| 内核来源 | yfw-kernel 分支（legacy） | 本库 `kernel/`（源，node 直跑）→ `kernel-dist/cli.mjs`（bundle，D7 产物） | `YFWORKING_KERNEL` 唯一逃生口（D8，值无效即抛错，不静默回退） |
| 内核 API | — | `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL`（第三方 provider） | 实测：云端 ds 与本地 Qwen 均通（2026-09-08） |
| 浏览器 CDP | — | 进程内 `webContents.debugger.attach('1.3')`，**无网络端口**（D5） | 隔离矩阵原 52319/9223 行修订为 N/A |
| App 身份 / userData | 在售 appId/productName | S6 定案（正式替换身份）：与在售同 appId `com.yfworking.desktop` / productName `YFWorking`，版本 2.8.0；userData 恒重定向 `<数据根>/userData`（入口兜底注入 `YFWORKING_HOME` 后 D6 恒成立；2026-09-09 前两版曾共用 `%APPDATA%\Electron`——default_app.asar 无 app 名——theme.json 互串） | 安装形态走 `build/installer.nsh` 版本比较（2.8.0）覆盖升级保留数据；双版并存由便携/dev 目录隔离 + userData 重定向兜底，无需独立 appId |

双版冒烟（2026-09-08，Task 6）：旧版 51309（在售运行中）与新版 51517（隔离 home）同机同时 healthy；隔离 home 下 bootstrap 落地 `runtime/ponos-kernel`，在售 `runtime/kernel` 前后 md5 不变（`86697d84…`）；bridge 级 mock 会话、真实云端 ds、真实本地 Qwen 三态全通。产物身份/userData 区分 S6 定案落位（正式替换身份 = 与在售同 appId/productName，版本 2.8.0，userData 规则 = main.cjs:95-97 现行为），本节后续项仅剩文档面旧值清洗（S6）。
