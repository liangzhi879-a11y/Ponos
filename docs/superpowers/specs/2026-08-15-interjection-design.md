# 生成中插话（Mid-Run Interjection）设计

日期：2026-08-15
状态：已确认（brainstorming 完成）

## 1. 背景与目标

agent 运行中途，客户（应用用户）希望**插话**——在任务执行过程中补充提供信息或调整要求，而无需等待当前轮次结束或停止后重新发起。

**核心语义（与用户确认）**：插话**不是**"更新任务目标"或"开启新任务"，而是**任务中途补充信息 / 调整要求**，agent 应结合已有任务进展继续执行。

现状：生成中输入框禁用（ChatInput.tsx:691 `disabled={isStreaming}`）、提交被拦截（:230 `if (!prompt || isStreaming) return`）。内核 `priority:'now'` 的打断-继续机制原生存在但 bridge 不透传 priority，前端无插话入口。

## 2. 需求

1. **排队插话（默认）**：生成中输入回车 → 插话消息立即在聊天中显示，并**立即**以 `priority:'next'` 发送——内核在下一个工具调用边界把消息注入当前轮（模型当轮吸收补充信息，不打断）；若当前轮已无工具迭代，则等当前轮结束后作为新轮处理。
2. **紧急插话（显式）**：点击「插话」按钮 → 立即打断当前轮次（**含进程内子 agent**，与停止按钮同机制），携带插话内容开启新一轮。
3. **语义包装**：插话消息发送给模型时带"补充信息/调整要求、继续当前任务"的显式语义包装；聊天界面仍显示用户原文。
4. 停止按钮行为不变（仍为停止生成）。

## 3. 方案选型

| 方案 | 做法 | 结论 |
|---|---|---|
| **A：复用内核 `now` 优先级** | WS send 携带 `priority:'now'`，bridge 透传，前端 pendingInterject 缓冲 | ✅ 采用。零内核改动，实测验证 |
| B：扩展 control_request 新 subtype | 内核新增 interject 协议 | 需改内核+重建 bundle，与现有 abort 重复 |
| C：cancel + send 组合 | 先中断再排队发送 | 双消息竞态、时序不可控 |

### 实测结论（内核 `now` 优先级，ponos-kernel/claude-code/dist/cli.mjs）

- 长生成中注入 `{type:'user', message, priority:'now'}` → 当前轮 47ms 内中止，emit `result`（`is_error=false, subtype=success`，比 control_request 中断的 `error_during_execution` 更干净）
- 插话内容作为新一轮执行，进程存活、session_id 不变、后续对话正常
- 中断级联终止子进程（Bash 工具子进程实测归零）；进程内子 agent 的 abort controller 为父级 child，级联同机制

## 4. 架构与组件

三层，改动集中在 bridge 一行 + 前端 hook/UI：

```
┌─────────────┐   WS: {type:'send', priority}   ┌──────────────┐   stdin: {type:'user', priority:'now'}   ┌────────┐
│  ChatInput   │ ───────────────────────────────▶│  bridge.mjs  │ ─────────────────────────────────────▶│  内核   │
│  usePonosCLI   │ ◀───────────────────────────────│  (透传priority) │ ◀─────────────────────────────────────│ (零改动)│
└─────────────┘   events: result/assistant/...   └──────────────┘   control_response/result              └────────┘
```

### 4.1 内核（零改动）

- `priority:'now'` 用户消息 → messageQueueManager 'now'(0) → print.ts subscribeToCommandQueue（:1858-1863）→ `abortController.abort('interrupt')` → 当前轮中止（级联子 agent）→ 该消息作为新一轮执行
- stdin 用户消息入队带 `priority: message.priority`（print.ts:4108-4115），缺省 `next`

### 4.2 bridge.mjs（一行）

send handler（约 :1616）stdin 写入透传优先级：

```js
session.proc.stdin.write(JSON.stringify({
  type: 'user',
  message: { role: 'user', content: msg.prompt },
  ...(msg.priority ? { priority: msg.priority } : {}),
}) + '\n')
```

### 4.3 前端

#### usePonosCLI.ts

- `dispatchSend` 增加可选 `priority` 参数，payload 携带 `priority`
- 新增 `pendingInterject: Map<conversationId, true>`（模块级，与 sessionState 同域）
- 新增导出 `interject(conversationId, userContent)`：
  1. `store._addMessage` 原文立即入库（显示可见）
  2. 发送 WS `{type:'send', prompt: wrapInterject(userContent), priority:'now', ...}`（发送包装文本；**不**新建 assistant 占位、**不**覆盖 sessionState——保证被打断轮的输出归属正确）
  3. `pendingInterject.set(conversationId, true)`
  4. 兜底：10s 定时器清除 pendingInterject（内核无响应时避免悬挂；已发用户消息保留）
- result handler（约 :411-440）修订：
  - 处理 aborted-turn 的 result 后（`_finishStreaming` 保留部分输出 → `streamingSessions.delete`）
  - 若 `pendingInterject.get(sid)` → 清除标记 → 调用 `setupStreamingState(sid)`（创建新 assistant 占位 + sessionState）→ 插话轮输出落到新消息
  - 抑制该 result 的 notifyTaskComplete（pendingInterject 存在时不弹"任务完成/出错"）
- `dispatchSend` 拆出 `setupStreamingState(conversationId)`（原 153-155 行的占位+sessionState 逻辑），供 result handler 复用

#### ChatInput.tsx

- :691 去掉 `disabled={isStreaming || voiceActive}` → 生成中输入框可用；voiceActive 仍禁用
- :230 提交拦截改为仅拦 `!prompt`；生成中回车走排队插话（现有 sendQueue 串行机制，usePonosCLI.ts:255-257）
- streaming 时按钮区：`[插话]`（有内容且非空才可点，onClick=interject）+ `[停止]`（原停止保留）
- 排队插话与紧急插话共用 `wrapInterject` 包装（显示原文、发送包装文本）

#### wrapInterject（新增工具，hook 内联或 utils）

```ts
export function wrapInterject(raw: string): string {
  return `【用户插话——补充信息/调整要求】\n${raw}\n——\n说明：这是用户在当前任务执行中补充的信息或调整的要求，不是新任务。请结合已有的任务进展继续执行。`
}
```

## 5. 关键时序

### 排队插话（回车）—— 方案A（工具边界注入，2026-08-15 修订）

> 修订背景：原方案前端把排队消息 hold 在 `sendQueue`、等当前轮 result 才发送——
> 对长 agentic turn（数分钟）用户感知"一直插不进去"。内核本就支持：`priority:'next'`
> 的消息在**下一个工具调用边界**被 `getQueuedCommandAttachments`（query.ts）作为附件
> 注入当前轮，无需等整轮结束。方案A改为前端**立即发送**、不再前端排队。

1. 前端 `_addMessage` 原文入库（立即可见）
2. 当前 streaming → **立即** WS send `priority:'next'`（带 `wrapInterject` 包装文本），不建新占位
3. 内核行为分岔：
   - 当前轮仍在工具调用阶段 → 下一个 query 迭代把消息作为附件注入当前轮，模型当轮吸收补充信息，回复融进当前输出块（不产生新轮）
   - 当前轮已进入纯文本生成（无更多工具迭代）→ 消息等当前轮 result 后由内核作为新轮处理
4. 新轮场景：内核新轮的 assistant 事件到达时本会话已不在 `streamingSessions` → result handler 之外由 handleMessage 的"新轮自动建块"兜底（`setupStreamingState`），避免输出错挂上一轮块或被静默丢弃
5. 错误/取消/关闭 → 现有 error/cancelled/closed 路径清理流式状态（已无前端排队队列）

> 注：内核 query.ts:1622 `sleepRan ? 'later' : 'next'` —— 若上一迭代调用了 SLEEP
> 工具，该迭代只注入 'later' 级消息，'next' 排队消息顺延到下一迭代或轮结束，属预期。

### 紧急插话（插话按钮）

1. 用户点插话 → `interject()`：原文入库 + WS send(priority:'now', 包装文本) + `pendingInterject.set`
2. 内核 enqueue 'now' → abort 当前轮（级联终止子 agent）→ 快速 emit result（is_error=false）
3. 前端 result handler：`_finishStreaming(旧aid)`（部分输出保留在会话中）→ 检测 pendingInterject → 建新 assistant 占位 + 切 sessionState → 清除标记
4. 内核插话轮输出 → 落到新消息
5. 会话进程保留，后续对话正常

## 6. 错误处理

| 场景 | 处理 |
|---|---|
| bridge stdin 写入失败 | 走现有 error 路径（发送 error 事件） |
| 排队插话期间当前轮错误/取消/关闭 | 方案A无前端队列：消息已发内核，内核队列/会话进程级回收；前端 error/cancelled/closed 清理流式状态即可 |
| 紧急插话内核无响应（aborted result 超时） | pendingInterject 10s 定时器清理；已发用户消息保留；不建占位 |
| 用户连续点插话 | pendingInterject 已存在时忽略重复（aborted result ~50ms 内到达并清除标记，窗口极短；插话轮运行中再点插话是新一次插话，自然生效） |
| 插话时输入为空 | 插话按钮禁用 |

## 7. 测试计划

1. **内核级**（已完成）：'now' 插话打断-继续、子进程终止、session 保留
2. **E2E**（扩展既有 ponos-e2e 脚本）：
   - WS send 带 priority:'now' → bridge 透传 → 当前轮中止 → 插话轮执行 → 续聊
   - 排队插话（priority 缺省，纯文本轮）→ 当前轮结束后作为新轮处理
   - 排队插话（priority 缺省，长工具执行中）→ 不打断当前轮，插话内容被模型吸收
3. **UI 手测**：
   - 生成中输入框可用、回车排队插话、插话/停止按钮状态
   - 紧急插话：被打断消息保留部分输出、插话轮输出落新消息、无"任务完成"误报
   - 子 agent 运行中插话：子 agent 终止、插话轮正常

## 8. 交付物

- server/bridge.mjs：priority 透传（1 行）
- src/hooks/usePonosCLI.ts：interject + pendingInterject + result handler 修订 + setupStreamingState 拆分
- src/components/chat/ChatInput.tsx：输入框常开 + 插话按钮 + 回车排队
- src/utils（或 hook 内）：wrapInterject
- 同步 release 副本 + 重启验证（需用户确认）
