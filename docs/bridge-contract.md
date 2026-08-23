# YFWorking 桥接契约规格（Bridge Contract）

> 用途：GUI↔bridge↔内核 三层交互的**可重建契约基线**。目标是在不修改 GUI 的前提下，以自研/合规实现替换内核（净室重建）时，协议语义可逐条对照、可测试。
> 权威来源：`server/bridge.mjs`、`electron/main.cjs`、内核 `kernel/cli.mjs`（YFW-turbo 净室重建，stream-json 模式）。
> 更新日期：2026-08-21

---

## 1. 进程拓扑（运行架构）

```
┌────────────────────────────────────────────────────────────────┐
│ Electron 主进程 (node.exe, electron/main.cjs)                  │
│   ├── Browser 执行器 (electron/browser-executor.cjs, WS 客户端)│
│   └── spawn → server/bridge.mjs (Node: HTTP + WebSocket)       │
│             端口 51309 (YFW_BRIDGE_PORT 可覆盖)                 │
│              ├── spawn(每会话一个内核进程) → kernel/cli.mjs     │
│              │     经 runtime/bun/bun.exe，stream-json 模式    │
│              ├── HTTP REST（文件/转换/配置/技能/transcript…）   │
│              └── WebSocket（GUI 渲染层 + 桌面宠物 + 执行器）    │
├── GUI 渲染层 (React/Vite，file:// 或 localhost:5173) ← WS → bridge
├── 桌面宠物 (pet/jiajia-pet.py, Python Tkinter) ← WS → bridge
└── 内核进程 (bun + cli.mjs, --print --output-format stream-json)
        stdin  ← NDJSON（user / control_request / control_response）
        stdout → NDJSON（system / assistant / result / control_request / …）
```

关键事实：
- **桥是唯一中枢**：GUI 不直接接触内核；内核也不直接接触 GUI。替换内核时只需保持"bridge 眼中的内核协议"，GUI 零改动。
- 内核启动链：Electron 主进程 → bridge → `bootstrapKernelToUserDir` 把 kernel+bun 拷贝到 `~/.yfworking/runtime/`（规避 Program Files ACL 限制）→ spawn。`YFWORKING_KERNEL` 环境变量可显式指定内核路径（开发调试用）。
- 内核空闲回收：会话内核进程空闲 10min 被 bridge `taskkill`（reapIdleKernels），下次发消息以 `--resume` 无缝重启。

## 2. 内核 spawn 契约（bridge → kernel）

命令（经 cmd.exe，参数均已引号转义；`<kernel>` 为 YFW-turbo 净室重建内核：
dev 用 `<repo>/kernel/cli.mjs` 源码，生产用 `scripts/build-kernel.mjs` 打成的单文件
bundle `<app>/kernel-dist/cli.mjs`（node-targeted ESM，bun 运行；bundle 放
`kernel-dist/` 而非 `dist/`，避开 vite `emptyOutDir:true` 对 dist/ 的清空），
bootstrap 复制到 `~/.yfworking/runtime/kernel/cli.mjs`）：
```
"<bun>" "<kernel>/cli.mjs" \
  --print --output-format stream-json --input-format stream-json \
  --verbose --dangerously-skip-permissions \
  --permission-prompt-tool stdio \
  --disallowedTools AskUserQuestion \
  [--resume <sessionId>] \
  [--append-system-prompt-file <%TEMP%\yfw-prompt-<sid>[.resume].txt>] \
  [--model <provider 主模型>] \
  [--add-dir <会话 cwd>] [--add-dir <技能根目录>]
```

环境变量（`buildChildEnv()`，bridge.mjs:586）：
| 变量 | 值 | 作用 |
|---|---|---|
| `CLAUDE_CONFIG_DIR` | `~/.yfworking` | 内核独立配置/会话目录 |
| `YFWORKING_HOME` | `~/.yfworking` | 同上（YFW 隔离） |
| `CLAUDE_CODE_AGENT_TRIGGERS` | `true` | 启用内核原生定时任务（CronCreate/…） |
| `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` | 用户配置的第三方 provider | 内核实际调用的 API |
| `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_SONNET/OPUS/HAIKU_MODEL` | provider 主/子模型 | 模型路由 |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | contextWindow | 自动压缩窗口 |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | 64000（可覆盖） | 输出 token 上限 |
| `YFW_HEALTH_COMPACT_COUNT` | 历史压缩次数（有值才注入） | 健康血条恢复 |

系统提示词注入：**不通过命令行传长文本**（cmd.exe 8191 字符限制），而是写入 `%TEMP%/yfw-prompt-<sid>.txt`（新会话）或 `.resume.txt`（resume），经 `--append-system-prompt-file` 传入；会话进程退出时删除。内容 = 身份提示词（或自定义 agent systemPrompt）+ 互动问答格式（ASK_USER 卡片规范）+ 里程碑协议 + 技能清单（resume 用精简版）+ 经验注入（沉积引导+摘要索引，可配置）。

## 3. 内核 stdin 协议（bridge → kernel，NDJSON 行）

| type | 载荷 | 语义 |
|---|---|---|
| `user` | `{ message:{role:'user',content}, priority?, uuid? }` | 投递一轮用户消息（队列化）。**priority/uuid 与 type/message 平级**（顶层，bridge.mjs:2258 转发 shape） |
| `control_request` | `{ request_id, request:{subtype} }` | 中断/取消。`subtype:'cancel'`（bridge 的优雅停止）、`'interrupt'`（abort 主查询）、`'browser_response'`（浏览器执行器回写，见 §4 bridge_request）等 |

**插话语义（priority）**：`priority:'next'` = 排队插话——内核吸收（`command_lifecycle` 确认）后在**工具边界注入当前轮**（模型尽快看到补充信息）；`priority:'now'` = 紧急插话——吸收确认后中断当前轮，消息作为新轮立即执行。`uuid` 必填：内核吸收时立即回发 `command_lifecycle(uuid, 'started')`，供 GUI 解除气泡悬浮态（useYFWCLI settlePendingInterject）。轮次间隙到达（无活跃轮）的 `next` 消息作为新轮直接执行，同样先发 `started` 确认。
| `control_response` | `{ response:{ request_id, subtype:'success', response:{ behavior:'allow'/'deny', updatedInput, toolUseID, decisionClassification } } }` | 权限审批回执，解除 `can_use_tool` 挂起 |

注：内核 CLI 还支持从 stdin 读取 agents JSON、systemPrompt 等（绕过 ARG_MAX）；`structuredIO.structuredInput` 为逐行解析器（print.ts:2834 起）。

## 4. 内核 stdout 协议（kernel → bridge，NDJSON 事件流）

非 JSON 行 → bridge 以 `raw` 转发（不解析）。

| type | 关键字段 | 语义 / bridge 处理 |
|---|---|---|
| `system` | `subtype`（init/status/session_state_changed/task_notification/task_started/task_progress/post_turn_summary/rate_limit…） | 生命周期与系统事件；`task_progress` 视为低优先级可丢弃 |
| `assistant` | `message.content[]`（text/thinking/tool_use 块）、`uuid` | 模型回复。bridge 从中**提取并剥离**里程碑标记与 `<!--ASK_USER-->` 卡片 |
| `result` | `usage{input_tokens,output_tokens}` | 一轮结束；cancel 生效确认点；`_turnActive` 复位 |
| `control_request` | `request{ subtype:'can_use_tool', request_id, tool_use_id, tool_name, input, decision_reason }` | 权限审批弹窗触发源（bridge 转发为 `approval`，GUI 批准后回 `control_response`） |
| `bridge_request` | `route:'browser', requestId, payload{action,params}` | 内置浏览器自动化请求 → **bridge 直连浏览器执行器，不转发 GUI**（防敏感载荷泄漏）。执行器完成后经 stdin `control_request{request:{subtype:'browser_response', requestId, ok, snapshot?, error?}}` 回写内核（`engine.resolveBrowser` 解除挂起）；120s 超时兜底报错 |
| `command_lifecycle` | `data{ uuid, state }` | 插话/排队消息接收确认：内核吸收 user 消息时回发 `state:'started'`（GUI 解除气泡悬浮） |
| `yfw_health` | `tier/compactCount/tokenUsage…` | 上下文健康血条（档位变化时发；`YFW_HEALTH_COMPACT_COUNT` env 恢复压缩史） |
| `yfw_summary` | `text, compactCount` | 上下文压缩摘要事件 |
| `stream_event` / `keep_alive` / `streamlined_text` / `prompt_suggestion` | — | 流式/保活/精简输出/建议（SDK 消费者用） |
| `error` | `{message}` | 错误 |

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
| `approval` | `{ toolUseId, command, requestId, reason, toolName, highRisk }` | 权限审批弹窗 |
| `approval-resolved` | `{ sessionId, toolUseId }` | 审批已回执 |
| `pet:show-main` / `pet:quit-app` | `{}` | 宠物双击/退出广播 |

背压：单客户端 WS 缓冲 >8MB 标记过载，丢弃低优先级事件（milestones/milestone-*/question-resolved/raw/stderr/task_progress），<2MB 恢复（滞回）。

## 6. WebSocket：GUI → bridge（inbound 消息）

| type | 载荷 | 语义 |
|---|---|---|
| `send` | `{ sessionId, cwd, resumeId, systemPrompt, model, compactCount, prompt, requestId, priority, uuid }` | 发消息；无会话则 spawn（`resumeId` 有 → `--resume` 恢复，无 → 新会话注入 systemPrompt） |
| `cancel` | `{ sessionId }` | 优雅停止（`control_request(cancel)` + 6s 超时后 taskkill 兜底） |
| `answer` | `{ sessionId, data:{ answers[], notes } }` | 卡片回答 → 拼装成用户消息注入内核 stdin，广播 `question-resolved` |
| `question-dismiss` | `{ sessionId }` | 跳过卡片（CLI 保持等待，广播 `question-resolved`） |
| `approval-response` | `{ sessionId, toolUseId, approved }` | 审批结果 → `control_response` 注入内核 |
| `browser_control` | `{ sessionId, command }` | 暂停/继续浏览器执行器（纯路由） |
| `executor:hello` | — | 主进程浏览器执行器注册（从 GUI 广播列表摘除） |
| `browser:exec:response` | `{ requestId, … }` | 执行器完成 → 回写内核 stdin |
| `browser:event` | `{ sessionId, event }` | 执行器事件 → 广播 GUI |
| `pet:show-main` / `pet:quit-app` | `{}` | 宠物请求显示主窗口 / 退出应用（广播） |

安全：WS 服务只接受本机可信来源——无 Origin、`file:`、`localhost/127.0.0.1/::1`；外部 Origin 一律 403。

## 7. HTTP REST API（同端口 51309）

| 端点 | 用途 |
|---|---|
| `/drives`、`/list-dir`、`/read-file`、`/raw-file`、`/write-file` | 文件系统访问（带 Origin 白名单保护） |
| `/convert-office`、`/read-sheet`、`/write-sheet`、`/read-docx`、`/write-docx` | Office 读写（调 python 脚本 `convert_docx.py`/`convert_xls.py`/`docx_edit.py`/`sheet_edit.py`） |
| `/transcript/list`、`/transcript/load`、`/transcript/search` | 会话转录（内核 transcript 为权威源，GUI 只读索引） |
| `/health`、`/diag/info` | 健康/诊断 |
| `/yfw/doubao/*` | 豆包抓取/下载/水印去除（调 `watermark_remove.py`） |
| `/test-provider`、`/verify-provider` | provider 连通性 |
| `/config`、`/providers`、`/providers/*` | 配置读写（`~/.yfworking/config.json`，写前备份+迁移） |
| `/skills`、`/sample-skills`、`/install-skill`、`/uninstall-skill` | 技能管理（写入 `~/.yfworking/skills/`） |
| `/worktrees`、`/branches` | git worktree/分支管理 |

## 8. 会话生命周期

- 会话以 `sessionId` 为键存于 bridge 内存；一个会话 = 一个内核进程。
- 新会话：spawn + 注入身份/技能/经验提示词文件；resume：`--resume <id>` + 精简技能清单。
- 轮次活跃跟踪：`assistant` 事件开轮、`result` 事件闭轮；空闲 10min → `taskkill` 回收（`_reaped` 置位，不广播 `closed`）。
- 取消语义：`control_request(cancel)` → 内核 abort 主查询（ShellCommand 真杀 bash）+ killAllRunningAgentTasks（子 agent 逐个 abort）；6s 内持续输出则回退 `taskkill -F -T`。内核进程保留，会话可无缝续聊。
- 崩溃统计：非零退出码且非主动取消 → `diagInfo.kernelCrashCount++`。

## 9. 净室重建的契约边界（替换内核时）

**必须保持**（GUI 零改动的前提）：
1. 内核 spawn 参数与 env 契约（§2）——尤其 `stream-json` 输入/输出格式与 `--permission-prompt-tool stdio`、`--disallowedTools AskUserQuestion`。
2. 内核 stdin/stdout NDJSON 语义（§3、§4）——`user`（含顶层 `priority`/`uuid` 插话契约）/`control_request`/`control_response` 输入；`system`/`assistant`/`result`/`control_request`/`bridge_request`/`command_lifecycle`/`yfw_health`/`yfw_summary` 输出。
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
