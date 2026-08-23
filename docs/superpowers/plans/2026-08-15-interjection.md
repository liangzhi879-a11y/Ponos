# 生成中插话（Mid-Run Interjection）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在 agent 生成中途插话——排队补充（回车）或紧急打断补充（插话按钮），插话带"补充信息/调整要求、继续当前任务"语义包装。

**Architecture:** 零内核改动，复用内核 `priority:'now'` 的打断-继续机制。bridge.mjs 一行透传 priority；前端 usePonosCLI 新增 `interject()` + `pendingInterject` 缓冲（紧急插话被打断轮 result 到达后才建新流式占位），ChatInput 输入框生成中常开 + 新增插话按钮。

**Tech Stack:** Node.js bridge (bridge.mjs)、React + zustand (src/)、Electron 应用；验证用 `node --test`（server 侧）+ `npm run typecheck` + E2E 脚本。

## Global Constraints

- 插话语义（用户确认）：**补充信息/调整要求，不是新任务**。发送给内核的文本必须带 `wrapInterject` 包装；聊天界面显示用户原文。
- 紧急插话 = 全会话中断（含进程内子 agent），与停止按钮（bridge cancel → control_request interrupt）同机制但走 `priority:'now'` 用户消息路径。
- 排队插话复用现有 `sendQueue` 串行机制（usePonosCLI.ts:255-257），不新增并行路径。
- 内核零改动；`dist/cli.mjs` 不重建。
- 现有测试框架：`npm test` 仅覆盖 `server/*.test.mjs`（纯单元，无内核/API 依赖）；E2E 脚本放 `server/interject.e2e.mjs`（不含 `.test.mjs`，不进 npm test）。
- 停止按钮行为不变。
- release 运行副本必须同步（源码改动 → `release/Ponos_ms92cd6u/`），重启需用户确认。

---

### Task 1: bridge.mjs priority 透传 + E2E 脚本

**Files:**
- Modify: `server/bridge.mjs`（send handler，约 :1611-1617）
- Create: `server/interject.e2e.mjs`（E2E 脚本，自托管测试 bridge）

**Interfaces:**
- Consumes: WS 消息 `{type:'send', prompt, sessionId, cwd, resumeId, systemPrompt, model, priority?}`
- Produces: 内核 stdin 写入 `{type:'user', message:{role:'user', content}, priority?}`（priority 透传）

- [ ] **Step 1: 修改 send handler，stdin 写入透传 priority**

当前代码（bridge.mjs，约 :1616）：
```js
session.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: msg.prompt } }) + '\n')
```
改为：
```js
session.proc.stdin.write(JSON.stringify({
  type: 'user',
  message: { role: 'user', content: msg.prompt },
  ...(msg.priority ? { priority: msg.priority } : {}),
}) + '\n')
```

- [ ] **Step 2: 语法检查**

Run: `node --check server/bridge.mjs`
Expected: 无输出（通过）

- [ ] **Step 3: 创建 E2E 脚本（自托管测试 bridge，场景A紧急插话 + 场景B排队插话）**

Create `server/interject.e2e.mjs`：
```js
// 生成中插话 E2E：spawn 独立 bridge（固定测试端口 52319）→ WS 两个场景 →
// 通过则 exit 0。运行：node server/interject.e2e.mjs
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = 52319
const bridge = spawn(process.execPath, [join(__dirname, 'bridge.mjs')], {
  env: { ...process.env, PONOS_BRIDGE_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
bridge.stderr.on('data', d => process.stdout.write('[bridge-err] ' + String(d).slice(0, 120) + '\n'))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const t0 = Date.now()
const log = (...a) => console.log(`+${Date.now() - t0}ms`, ...a)

async function connectWS() {
  for (let i = 0; i < 40; i++) {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`)
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('no bridge')) })
      return ws
    } catch { await sleep(500) }
  }
  throw new Error('bridge did not start')
}

// 场景A：紧急插话（priority:'now'）—— 长生成中注入，期望当前轮快速中止 + 插话轮完成
async function scenarioA() {
  const sid = 'e2e-a-' + Date.now()
  const ws = await connectWS()
  let results = 0
  let sawInterject = false
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data) } catch { return }
    if (m.type === 'event' && m.data?.type === 'result') {
      results++
      log(`[A] result#${results} is_error=${m.data.is_error} subtype=${m.data.subtype}`)
    }
    if (m.type === 'event' && m.data?.type === 'assistant' && Array.isArray(m.data.message?.content)) {
      for (const b of m.data.message.content) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.includes('插话成功')) sawInterject = true
      }
    }
  }
  ws.send(JSON.stringify({ type: 'send', prompt: '请写一篇关于海洋生态的科普长文，至少3000字，不要使用任何工具。', requestId: 'a1', sessionId: sid, cwd: __dirname }))
  await sleep(8000)
  ws.send(JSON.stringify({ type: 'send', prompt: '【插话成功】请改为只写 500 字，主题改为珊瑚礁。', requestId: 'a2', sessionId: sid, cwd: __dirname, priority: 'now' }))
  await sleep(15000)
  log(`[A] results=${results} sawInterject=${sawInterject}`)
  ws.close()
  if (results < 2) throw new Error('A FAIL: 未产生两个 result（中止+插话轮）')
  if (!sawInterject) throw new Error('A FAIL: 插话轮未输出插话内容')
  log('[A] PASS')
}

// 场景B：排队插话（无 priority）—— 当前轮正常结束后才处理插话
async function scenarioB() {
  const sid = 'e2e-b-' + Date.now()
  const ws = await connectWS()
  let results = 0
  let firstResultAt = 0
  let queuedResultAt = 0
  let sawCoral = false
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data) } catch { return }
    if (m.type === 'event' && m.data?.type === 'result') {
      results++
      if (results === 1) firstResultAt = Date.now() - t0
      else queuedResultAt = Date.now() - t0
      log(`[B] result#${results} is_error=${m.data.is_error}`)
    }
    if (m.type === 'event' && m.data?.type === 'assistant' && Array.isArray(m.data.message?.content)) {
      for (const b of m.data.message.content) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.includes('珊瑚礁')) sawCoral = true
      }
    }
  }
  ws.send(JSON.stringify({ type: 'send', prompt: '请写一篇关于海洋生态的科普短文，200字，不要使用任何工具。', requestId: 'b1', sessionId: sid, cwd: __dirname }))
  await sleep(3000)
  ws.send(JSON.stringify({ type: 'send', prompt: '排队插话：请补充珊瑚礁保护的内容。', requestId: 'b2', sessionId: sid, cwd: __dirname }))
  await sleep(15000)
  log(`[B] results=${results} firstResultAt=${firstResultAt} queuedResultAt=${queuedResultAt} sawCoral=${sawCoral}`)
  ws.close()
  if (results < 2) throw new Error('B FAIL: 排队插话未产生第二个 result')
  if (queuedResultAt <= firstResultAt) throw new Error('B FAIL: 排队插话未等当前轮结束')
  log('[B] PASS')
}

try {
  await scenarioA()
  await scenarioB()
  log('ALL PASS')
  process.exit(0)
} catch (e) {
  log('FAIL:', e.message)
  process.exit(1)
}
```

- [ ] **Step 4: 运行 E2E 场景 A（紧急插话）**

Run: `node server/interject.e2e.mjs 2>&1 | grep -v -i deprecation`
Expected: `[A] PASS`（当前轮快速中止、插话轮输出"插话成功"内容、results>=2）

- [ ] **Step 5: 提交**

```bash
git add server/bridge.mjs server/interject.e2e.mjs
git commit -m "feat(interjection): bridge 透传 priority，支持内核 now 优先级插话"
```

---

### Task 2: usePonosCLI.ts —— interject + pendingInterject + 重构

**Files:**
- Modify: `src/hooks/usePonosCLI.ts`（dispatchSend 重构、send() 排队包装、interject()、result handler、模块级 pendingInterject、hook 返回值）

**Interfaces:**
- Consumes: `wrapInterject(raw)`（本任务定义）；`buildSendPayload(conversationId, prompt, priority?)`；`setupStreamingState(conversationId)`；`sendPayloadWS(conversationId, payload)`
- Produces: hook 返回值 `{ send, stop, interject, connected }`（ChatInput 消费 `interject(conversationId, userContent)`）

- [ ] **Step 1: 模块级声明 pendingInterject + wrapInterject 工具**

在 `src/hooks/usePonosCLI.ts` 模块顶部（`streamingSessions` 声明附近，约 :30-40）加入：
```ts
// 紧急插话缓冲：interject() 发送 now 优先级消息后置位，
// 被打断轮次的 result 到达时消费（建插话轮流式占位），10s 无响应兜底清除。
const pendingInterject = new Map<string, true>()
```
在模块级（`sendAnswer`/`dismissQuestion` 附近）加入：
```ts
// 插话语义包装：插话=补充信息/调整要求（非新任务），引导模型继续当前任务。
function wrapInterject(raw: string): string {
  return `【用户插话——补充信息/调整要求】\n${raw}\n——\n说明：这是用户在当前任务执行中补充的信息或调整的要求，不是新任务。请结合已有的任务进展继续执行。`
}
```

- [ ] **Step 2: 重构 dispatchSend → buildSendPayload / setupStreamingState / sendPayloadWS**

将现有 `dispatchSend`（:147-196）替换为三个函数：
```ts
// 构建 WS send payload；会话不存在返回 null
function buildSendPayload(conversationId: string, prompt: string, priority?: 'now' | 'next' | 'later'): Record<string, unknown> | null {
  const store = useChatStore.getState()
  const conversation = store.conversations.find(c => c.id === conversationId)
  if (!conversation) return null
  lastSessionId = conversationId
  const agent = getAgentById(useAgentStore.getState().agents, conversation.agentId)
  const sState = useSettingsStore.getState().settings
  const activeProv = sState.providers.find(p => p.id === sState.activeProvider)
  return {
    type: 'send',
    prompt,
    requestId: generateId(),
    sessionId: conversationId,
    cwd: conversation.cwd,
    // Resume this conversation's own CLI session (if any) — never another conversation's
    resumeId: conversation.sessionId || undefined,
    // 绑定专业 Agent 时注入其专属系统提示词（覆盖默认身份提示词）
    ...(agent ? { systemPrompt: agent.systemPrompt } : {}),
    // 携带当前主模型：bridge 以 --model 传入 CLI，resume 时可覆盖会话内
    // 存储的旧模型，实现同一聊天中两段会话之间的无缝模型切换
    ...(activeProv?.primaryModel ? { model: activeProv.primaryModel } : {}),
    ...(priority ? { priority } : {}),
  }
}

// 建立流式状态（assistant 占位 + sessionState）；dispatchSend 与插话中断后复用。
// 返回 assistantId，失败（会话不存在）返回 null。
function setupStreamingState(conversationId: string): string | null {
  const store = useChatStore.getState()
  if (!store.conversations.find(c => c.id === conversationId)) return null
  streamingSessions.add(conversationId)
  const assistantId = store._addStreamingMessage(conversationId)
  sessionState.set(conversationId, { assistantId, blockIds: {} })
  return assistantId
}

// 发送 WS send payload；未连接时入 pendingQueue（连接后执行），连接断开时输出错误块并清理
function sendPayloadWS(conversationId: string, payload: Record<string, unknown>) {
  const store = useChatStore.getState()
  const doSend = () => {
    const socket = getOrCreateWS()
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      const st = sessionState.get(conversationId)
      if (st?.assistantId) {
        store._appendStreamingBlock(st.assistantId, {
          id: generateId(), type: 'text',
          content: '\n⚠️ **Bridge not connected.**\nRun: `node server/bridge.mjs`\n',
        })
        store.stopStreaming(conversationId)
        sessionState.delete(conversationId)
        streamingSessions.delete(conversationId)
      }
      return
    }
    socket.send(JSON.stringify(payload))
  }
  if (!wsReady) pendingQueue.push(doSend)
  else doSend()
}

// 原 dispatchSend 语义：立即发送（新建流式占位）
function dispatchSend(conversationId: string, userContent: string, priority?: 'now' | 'next' | 'later') {
  const payload = buildSendPayload(conversationId, userContent, priority)
  if (!payload) return
  setupStreamingState(conversationId)
  sendPayloadWS(conversationId, payload)
}
```
注意：原 dispatchSend 的 `console.log('[WS] send:', ...)` 调试行删除（buildSendPayload 不再打印），若需保留可加在 `sendPayloadWS` 的 doSend 内。

- [ ] **Step 3: send() 排队插话时包装内容**

现有（:255-257）：
```ts
if (streamingSessions.has(conversationId)) {
  sendQueue.push({ conversationId, userContent })
  return
}
```
改为：
```ts
if (streamingSessions.has(conversationId)) {
  // 生成中回车=排队插话：内容带插话语义包装（界面仍显示原文，原文已在上面 _addMessage）
  sendQueue.push({ conversationId, userContent: wrapInterject(userContent) })
  return
}
```

- [ ] **Step 4: 新增 interject() 并在 hook 返回值暴露**

在 `stop` 之后（:270 附近）加入：
```ts
const interject = useCallback((conversationId: string, userContent: string) => {
  const store = useChatStore.getState()
  store._addMessage(conversationId, {
    id: generateId(),
    role: 'user',
    content: [{ id: generateId(), type: 'text', content: sanitizeText(userContent) }],
    timestamp: Date.now(),
  })
  const payload = buildSendPayload(conversationId, wrapInterject(userContent), 'now')
  if (!payload) return
  if (!wsReady) return // bridge 未连接：消息已入库可见，用户可稍后重发
  pendingInterject.set(conversationId, true)
  getOrCreateWS()?.send(JSON.stringify(payload))
  // 兜底：内核 10s 无响应（被打断轮 result 未到达）则清除标记，避免悬挂
  setTimeout(() => pendingInterject.delete(conversationId), 10_000)
}, [])
```
返回值（:272）改为：
```ts
return { send, stop, interject, connected }
```

- [ ] **Step 5: result handler —— 插话中断轮次处理 + 通知抑制**

现有（:411-440）：
```ts
if (type === 'result' && aid) {
  const usage = (event.usage || {}) as Record<string, number>
  // 若该会话仍有待回答的提问卡片，说明 CLI 只是结束当前轮次等待用户回答
  // —— 不能结束流式状态，否则会出现"后端在跑但前端显示空闲/有输出无状态"。
  if (!store.pendingQuestions[sid]) {
    store._finishStreaming(aid, { inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0 })
    streamingSessions.delete(sid)
    flushSendQueue(sid)
  }
  store._updateSessionMeta({ totalCost: event.total_cost_usd as number, duration: event.duration_ms as number })
  if (!store.pendingQuestions[sid]) {
    try {
      ... notifyTaskComplete ...
    } catch {}
  }
  return
}
```
改为：
```ts
if (type === 'result' && aid) {
  const usage = (event.usage || {}) as Record<string, number>
  const interjected = pendingInterject.has(sid)
  // 若该会话仍有待回答的提问卡片，说明 CLI 只是结束当前轮次等待用户回答
  // —— 不能结束流式状态，否则会出现"后端在跑但前端显示空闲/有输出无状态"。
  if (!store.pendingQuestions[sid]) {
    store._finishStreaming(aid, { inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0 })
    streamingSessions.delete(sid)
  }
  store._updateSessionMeta({ totalCost: event.total_cost_usd as number, duration: event.duration_ms as number })

  // 紧急插话：被打断轮次的 result 到达 → 先建插话轮流式占位（now 优先级排在排队消息前，
  // 保证内核输出按 插话轮→排队消息 顺序归属到各自 assistant 消息）。
  if (interjected) {
    pendingInterject.delete(sid)
    setupStreamingState(sid)
  }

  if (!store.pendingQuestions[sid]) {
    // 插话中断的轮次：不释放排队消息（等插话轮 result 后由现有逻辑释放）、不弹完成通知
    if (!interjected) {
      flushSendQueue(sid)
      try {
        ... notifyTaskComplete（原样保留） ...
      } catch {}
    }
  }
  return
}
```

- [ ] **Step 6: cancelled/error/closed 时清理 pendingInterject**

在 `msg.type === 'cancelled'`、`'error'`、`'closed'` 三个分支（:443-477）各加一行：
```ts
pendingInterject.delete(sid)
```

- [ ] **Step 7: 类型检查**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 8: 提交**

```bash
git add src/hooks/usePonosCLI.ts
git commit -m "feat(interjection): usePonosCLI interject + pendingInterject 缓冲 + result handler 适配"
```

---

### Task 3: ChatInput.tsx —— 输入框常开 + 插话按钮 + i18n

**Files:**
- Modify: `src/components/chat/ChatInput.tsx`
- Modify: `src/i18n/translations/zh-CN.ts`、`src/i18n/translations/en-US.ts`

**Interfaces:**
- Consumes: `usePonosCLI()` 的 `interject(conversationId, userContent)`
- Produces: 生成中输入框可用（回车=排队插话）；streaming 时按钮区 = [插话] + [停止]

- [ ] **Step 1: 引入 interject 与图标**

第 2 行 import 增加 `MessageSquarePlus`：
```tsx
import { Send, StopCircle, Paperclip, ImageIcon, Mic, MicOff, Command, X, Zap, Repeat, MessageSquarePlus } from 'lucide-react'
```
第 91 行解构：
```tsx
const { send, stop, interject } = usePonosCLI()
```

- [ ] **Step 2: 输入框生成中常开 + 提交拦截放开**

:691 改为：
```tsx
disabled={voiceActive}
```
:230 改为：
```tsx
if (!prompt) return
```

- [ ] **Step 3: 新增 handleInterject**

在 `handleSubmit`（:253 之后）加入：
```tsx
// 紧急插话：立即打断当前生成（含子 agent），携带输入内容作为新一轮执行
const handleInterject = useCallback(() => {
  const prompt = buildPrompt()
  if (!prompt) return
  interject(conversationId, prompt)
  _skipUndo.current = true
  setValue('')
  setAttachments([])
  setActiveSkill(null)
  setShowCommands(false)
  if (textareaRef.current) textareaRef.current.style.height = 'auto'
}, [buildPrompt, conversationId, interject])
```

- [ ] **Step 4: 按钮区 streaming 分支 = [插话] + [停止]**

现有（:695-700）：
```tsx
{isStreaming ? (
  <Tooltip content={t('chat.stop') + ' (Esc)'}>
    <Button variant="danger" size="sm" onClick={() => { stop(conversationId); stopStreaming(conversationId) }} aria-label={t('chat.stop')}>
      <StopCircle className="w-4 h-4" />
    </Button>
  </Tooltip>
) : (
```
改为：
```tsx
{isStreaming ? (
  <div className="flex items-center gap-1.5">
    <Tooltip content={t('chat.interject') + '（打断当前生成并补充信息/调整要求）'}>
      <Button variant="outline" size="sm" onClick={handleInterject} disabled={!value.trim() && attachments.length === 0 && !activeSkill} aria-label={t('chat.interject')}>
        <MessageSquarePlus className="w-4 h-4" />
      </Button>
    </Tooltip>
    <Tooltip content={t('chat.stop') + ' (Esc)'}>
      <Button variant="danger" size="sm" onClick={() => { stop(conversationId); stopStreaming(conversationId) }} aria-label={t('chat.stop')}>
        <StopCircle className="w-4 h-4" />
      </Button>
    </Tooltip>
  </div>
) : (
```

- [ ] **Step 5: i18n 键**

`src/i18n/translations/zh-CN.ts`（`stop: '停止'` 附近）加：
```ts
interject: '插话',
```
`src/i18n/translations/en-US.ts`（`stop: 'Stop'` 附近）加：
```ts
interject: 'Interject',
```

- [ ] **Step 6: 类型检查 + 构建**

Run: `npm run typecheck && npm run build`
Expected: 均通过

- [ ] **Step 7: 提交**

```bash
git add src/components/chat/ChatInput.tsx src/i18n/translations/zh-CN.ts src/i18n/translations/en-US.ts
git commit -m "feat(interjection): 输入框生成中常开 + 插话按钮 + i18n"
```

---

### Task 4: E2E 全链路 + release 同步 + 手测清单

**Files:**
- Run: `server/interject.e2e.mjs`（Task 1 创建）
- Sync: `release/Ponos_ms92cd6u/server/bridge.mjs` ← `server/bridge.mjs`

**Interfaces:**
- Consumes: Task 1-3 全部产物
- Produces: 验证报告；release 副本同步

- [ ] **Step 1: 运行完整 E2E（场景 A 紧急 + 场景 B 排队）**

Run: `node server/interject.e2e.mjs 2>&1 | grep -v -i deprecation`
Expected: `[A] PASS`、`[B] PASS`、`ALL PASS`

- [ ] **Step 2: 验证 bridge 日志优雅路径**

Run: `grep -E "cancel|interject|spawn" <e2e bridge 输出>`（脚本 stderr 透传日志）
Expected: 无异常报错；内核会话未被杀（无强杀日志）

- [ ] **Step 3: 同步 release 副本**

```bash
cp server/bridge.mjs release/Ponos_ms92cd6u/server/bridge.mjs
node --check release/Ponos_ms92cd6u/server/bridge.mjs
diff server/bridge.mjs release/Ponos_ms92cd6u/server/bridge.mjs && echo IDENTICAL
```

- [ ] **Step 4: 手测清单（重启应用后执行，需用户确认重启）**

- 生成中输入框可输入；回车 → 消息立即显示为普通用户消息，当前轮结束后自动处理（排队插话）
- streaming 时按钮区显示 [插话]+[停止]；插话按钮空内容禁用
- 点插话 → 当前输出立即停止，插话轮输出落在新的 assistant 消息；无"任务完成/出错"误报
- 子 agent 运行中点插话 → 子 agent 终止、插话轮正常
- 停止按钮行为不变
- 聊天界面显示用户原文（无"【用户插话】"包装前缀）

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(interjection): 生成中插话（排队+紧急打断）实现完成"
```
（如用户要求一并提交；release 目录若被 gitignore 则不纳入）
