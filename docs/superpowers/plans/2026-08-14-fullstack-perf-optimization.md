# 全栈运行效率优化（渐进三批次）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不降低 agent 功能与运行效果的前提下，分三批提升 claude-code-gui 的界面流畅度、响应延迟与 token 成本。

**Architecture:** 批次1 改前端渲染层（消息列表虚拟化 + markdown 配置稳定化 + 流式事件 rAF 批处理）；批次2 改 bridge 中间层（resume 技能清单精简注入 + 首 token 计时探针）；批次3 改内核 token 成本（启用已内置的工具结果预算 feature + 上下文利用率探针）。三批互相独立，每批构建验证 + 同步 YFDesigningDebug 副本 + 用户验收。

**Tech Stack:** React 18 + TypeScript + Vite + Zustand + @tanstack/react-virtual（新增，纯 JS）+ radix ScrollArea + Node bridge.mjs + ponos-kernel/claude-code 内核（bun bundle）

## Global Constraints

- **红线：agent 功能/运行效果零打折。** 所有行为改动默认保守、提供配置开关、可一键回退。任何经验证降低输出质量的改动一律撤销。
- 纯 JS 依赖优先：新增依赖仅限 `@tanstack/react-virtual`（纯 JS，无原生模块）。
- 每批完成必须 `npx tsc --noEmit && npm run build` 通过，然后同步 `C:\Users\T203-15\YFDesigningDebug\app\`（dist/electron/server），最后用户验收。
- 同步与重启规则：进程重启前必须征得用户同意；改动内核需同时 patch `ponos-kernel/claude-code/dist/cli.mjs` 与调试版内核 bundle（如存在）。
- 工作区根：`C:\Users\T203-15\claude-code-gui`。
- 提交风格：中文，前缀 `perf:`，标注批次（如 `perf(batch1): ...`）。

---

### Task 1: 消息列表虚拟化（批次 1）

**Files:**
- Modify: `src/components/chat/ChatWindow.tsx`（消息渲染区 282-296 行 `messages.map`）
- Test: 构建 + 人工验收（无单测基建）

**Interfaces:**
- Consumes: `messages`（chatStore 原样数组）、`streamingConversations`、`retryMessage`/`editMessage`（既有）
- Produces: `useVirtualizer` 实例绑定 ScrollArea viewport；`scrollToIndex` 供搜索定位/滚动到底

**背景:** 当前 `messages.map` 全量渲染，万级消息卡顿。radix ScrollArea 的 viewport 是真实滚动容器，虚拟化用 fixed 高度容器 + transform 平移模拟。

- [ ] **Step 1: 安装依赖**

```bash
cd C:/Users/T203-15/claude-code-gui && npm install @tanstack/react-virtual
```

- [ ] **Step 2: 改造 ChatWindow 渲染区**

替换 282-296 行 `{messages.map(...)}` 块。思路：

```tsx
import { useVirtualizer } from '@tanstack/react-virtual'

// 在组件内（messages 定义之后）：
const scrollElement = scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null
const virtualizer = useVirtualizer({
  count: messages.length,
  getScrollElement: () => scrollElement ?? null,
  estimateSize: () => 96,        // 动态内容下界；实际高度由测量回调校正
  overscan: 6,
  getItemKey: index => messages[index].id,
})
```

渲染区改为：

```tsx
<div className="pb-2 min-w-0 overflow-hidden" style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
  {virtualizer.getVirtualItems().map(vi => {
    const msg = messages[vi.index]
    return (
      <div
        key={msg.id}
        ref={virtualizer.measureElement}
        data-index={vi.index}
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
      >
        <MessageBubble
          message={msg}
          isStreaming={streamingConversations[conversationId] === msg.id}
          onRetry={msg.role === 'assistant' ? () => retryMessage(conversationId, msg.id) : undefined}
          onEdit={msg.role === 'user' ? () => {
            const textBlocks = msg.content.filter(b => b.type === 'text')
            const text = textBlocks.map(b => b.content).join('\n')
            editMessage(conversationId, msg.id, msg.content)
            setPendingInput(text)
          } : undefined}
        />
      </div>
    )
  })}
</div>
```

- [ ] **Step 3: 改造滚动到底/自动跟随逻辑**

现有逻辑（34-110 行）直接操作 `el.scrollTop = el.scrollHeight` 和读取 `scrollHeight`——虚拟化后 `scrollHeight` 不再是内容真实高度。改为：

- 自动跟随：isPinned 判断仍读 viewport 的 `scrollTop/scrollHeight/clientHeight`（滚动容器真实值不变）；到底动作改为 `virtualizer.scrollToIndex(messages.length - 1, { align: 'end' })`。
- `scrollToBottom()`（134 行）：同样改 `virtualizer.scrollToIndex(messages.length - 1, { align: 'end' })`。
- 签名 effect（71-110 行）中 `el.scrollTop = el.scrollHeight` 两处替换为 `virtualizer.scrollToIndex(messages.length - 1)`（当 pinned 且签名变化时）。`virtualizer` 需加入该 effect 依赖。
- 流式期间新消息出现：virtualizer 默认会随 count 变化自动处理；在 pinned 状态下调用 scrollToIndex 保持跟随。

- [ ] **Step 4: 改造搜索定位**

116-127 行 `__scrollToMessageId` 处理器：由 `scrollIntoView` 改为按 id 找 index 再 `virtualizer.scrollToIndex(index, { align: 'center' })`，然后给该虚拟项容器加 `animate-pulse-soft`（通过临时 state 记录高亮 id，渲染时附加 class）。`data-message-id` 属性保留在虚拟项容器上（供复制/右键等既有查询）。

- [ ] **Step 5: 构建验证**

```bash
npx tsc --noEmit && npm run build
```
Expected: 0 errors。

- [ ] **Step 6: 提交**

```bash
git add package.json package-lock.json src/components/chat/ChatWindow.tsx
git commit -m "perf(batch1): 消息列表虚拟化（@tanstack/react-virtual）"
```

---

### Task 2: markdown 渲染配置稳定化（批次 1）

**Files:**
- Modify: `src/components/chat/MessageBubble.tsx`（149-232 行 ReactMarkdown 区域）

**Interfaces:**
- Consumes: 现有 `ReactMarkdown` 用法
- Produces: 模块级稳定 `components`/`remarkPlugins` 引用（不新建文件）

**背景:** MessageBubble 已用 `memo` 阻止跨消息重复解析（448 行）。剩余浪费：每次 MessageBubble 重渲染（流式更新自己那条消息）时 `components` 对象字面量重建 → ReactMarkdown 子组件（代码块/链接/复制按钮）全量重挂载。提取为模块级常量后，同一消息的流式更新只更新文本节点。

- [ ] **Step 1: 提取稳定引用**

在 `MessageBubble.tsx` 文件顶部（import 之后、组件定义之前）新增：

```tsx
// 模块级稳定引用：流式更新重渲染时避免 components/插件对象重建导致
// ReactMarkdown 子树全量重挂载（代码块、复制按钮等状态丢失）。
const MD_COMPONENTS: Components = { /* 原 151-231 行 components 内容原样搬入 */ }
const MD_PLUGINS = [remarkGfm]
```

组件内 149-151 行改：

```tsx
<ReactMarkdown remarkPlugins={MD_PLUGINS} components={MD_COMPONENTS}>
```

注意：若原 components 中引用了组件内闭包变量（如翻译函数 `t`、状态 setter），不能直接模块级化。遇到此类引用时，仅把**不依赖闭包**的部分提升为模块级，依赖闭包的保留内联（宁可部分提升也不破坏行为）。改完后逐项确认无闭包依赖。

- [ ] **Step 2: 构建验证**

```bash
npx tsc --noEmit && npm run build
```
Expected: 0 errors。

- [ ] **Step 3: 提交**

```bash
git add src/components/chat/MessageBubble.tsx
git commit -m "perf(batch1): ReactMarkdown components/插件引用稳定化"
```

---

### Task 3: 流式事件 rAF 批处理（批次 1）

**Files:**
- Modify: `src/hooks/usePonosCLI.ts`（`handleMessage` 中 `assistant` 事件分支，355-378 行）

**Interfaces:**
- Consumes: `handleMessage` 现有事件处理、`upsertBlock`（513 行）
- Produces: `pendingStreamEvents` 队列 + `flushStreamEvents()`（rAF 驱动）

**背景:** 内核每推送一次 `assistant` 事件（含完整 content blocks）前端就 `upsertBlock` → `setState` → 该消息重渲染。同一帧内多次 assistant 事件（多 block/多工具）可合并为一次 flush，减少重渲染次数。事件语义不变（每条事件仍完整应用，仅时间上批量）。

- [ ] **Step 1: 新增批处理基础设施**

在 `usePonosCLI.ts` 模块顶部（`toolUseAgentMap` 附近）新增：

```tsx
// 流式事件批处理：同一帧内的多次 assistant 事件合并为一次状态更新。
// 每事件语义不变（完整应用），仅降低重渲染频率。
// st 类型与模块顶部 sessionState 的 value 类型一致：
// { assistantId: string; blockIds: Record<string, string> }
type StreamEvent = { sid: string; st: { assistantId: string; blockIds: Record<string, string> }; aid: string; event: Record<string, unknown> }
const pendingStreamEvents: StreamEvent[] = []
let streamFlushScheduled = false

function flushStreamEvents() {
  streamFlushScheduled = false
  if (pendingStreamEvents.length === 0) return
  const batch = pendingStreamEvents.splice(0)
  const store = useChatStore.getState()
  for (const { sid, st, aid, event } of batch) {
    const content = (event.message as any)?.content as Array<Record<string, unknown>> | undefined
    const msgId = (event.message as any)?.id as string || '0'
    if (!content) continue
    for (const block of content) {
      const bt = block.type as string
      const suffix = bt === 'tool_use' ? (block.id as string || 'tool') : msgId
      if (bt === 'thinking' && block.thinking) {
        upsertBlock(store, st!, aid, 'thinking-' + suffix, { id: '', type: 'thinking', content: sanitizeText(block.thinking as string) })
      } else if (bt === 'text' && block.text) {
        upsertBlock(store, st!, aid, 'text-' + suffix, { id: '', type: 'text', content: sanitizeText(block.text as string) })
      } else if (bt === 'tool_use') {
        const toolInput = (block as any).input || {}
        if (block.name === 'Agent' && block.id) {
          toolUseAgentMap.set(block.id as string, String(toolInput.subagent_type || ''))
        }
        upsertBlock(store, st!, aid, 'tool-' + suffix, {
          id: '', type: 'tool_use', content: sanitizeText(JSON.stringify(block.input || {}, null, 2)),
          metadata: { toolName: block.name, status: 'completed', toolUseId: block.id as string | undefined },
        })
      }
    }
  }
}

function scheduleStreamFlush() {
  if (streamFlushScheduled) return
  streamFlushScheduled = true
  requestAnimationFrame(flushStreamEvents)
}
```

- [ ] **Step 2: 改造 assistant 事件分支**

355-378 行的 `if (type === 'assistant' && aid) { ... }` 整个分支替换为：

```tsx
if (type === 'assistant' && aid) {
  pendingStreamEvents.push({ sid, st, aid, event })
  scheduleStreamFlush()
  return
}
```

注意：分支内原有 `return` 语义保持（该类型不再走后续逻辑）。

- [ ] **Step 3: 页面隐藏兜底 flush**

在 `document.addEventListener('visibilitychange', onVisible)` 处理器（226 行附近）中补充：页面变为 hidden 时立即 `flushStreamEvents()`，避免 rAF 暂停期间丢更新（实际不丢——下次 rAF 会跑，但切后台回来前保持最新）。

```tsx
function onVisibilityChange() {
  if (document.visibilityState === 'hidden') flushStreamEvents()
}
// 已有 onVisible 逻辑之外单独注册：
document.addEventListener('visibilitychange', onVisibilityChange)
```

- [ ] **Step 4: 构建验证**

```bash
npx tsc --noEmit && npm run build
```
Expected: 0 errors。注意确认 `upsertBlock`、`sanitizeText`、`toolUseAgentMap`、`SessionState` 类型在当前文件作用域内可见（它们在模块顶部定义）。

- [ ] **Step 5: 提交**

```bash
git add src/hooks/usePonosCLI.ts
git commit -m "perf(batch1): 流式 assistant 事件 rAF 批处理合并重渲染"
```

---

### Task 4: resume 技能清单精简注入（批次 2）

**Files:**
- Modify: `server/bridge.mjs`（`appendSkillList` 660-684 行、`getOrCreateSession` resume 分支 714-722 行）

**Interfaces:**
- Consumes: `listInstalledSkills()`、`formatSkillEntry()`（既有）
- Produces: `appendSkillList(basePrompt, compact=false)`——compact 时注入精简清单

**背景:** resume 会话通过 `--append-system-prompt-file` 重新注入完整技能清单（60 技能 × 全描述），每次恢复都白耗 token。精简版只保留 `技能id: 触发词`，模型 resume 续跑时本就知道已装技能，仅需可定位。

- [ ] **Step 1: appendSkillList 支持 compact**

```js
function buildCompactSkillSection() {
  const skills = listInstalledSkills()
  if (!skills.length) return ''
  const lines = skills
    .map(s => {
      const triggers = Array.isArray(s.triggers) ? s.triggers.slice(0, 6).join('/') : ''
      const parent = s.parent ? `（父:${s.parent}）` : ''
      return `- ${s.name}${parent}${triggers ? `：${triggers}` : ''}`
    })
    .filter(Boolean)
  return '\n\n【已安装技能清单（精简）】技能名即唯一调用标识，任务匹配时直接用 Skill 工具调用对应技能：\n' + lines.join('\n')
}

export function appendSkillList(basePrompt, compact = false) {
  if (compact) return basePrompt + buildCompactSkillSection()
  const dir = findSkillRoot()
  const fp = skillDirFingerprint(dir)
  if (skillListCache && fp === skillListCacheKey) return basePrompt + skillListCache
  // ... 原完整版逻辑不变
}
```

- [ ] **Step 2: resume 分支用精简版 + 开关**

714-722 行：

```js
args.push('--resume', resumeId)
// 精简技能清单默认开启；CLAUDE_CODE_FULL_SKILL_LIST=1 回退全量（不打折保险）
const resumeCompact = process.env.CLAUDE_CODE_FULL_SKILL_LIST !== '1'
const resumePrompt = appendSkillList(PONOS_ASKUSER_FORMAT + PONOS_MILESTONE_PROTOCOL, resumeCompact)
```

- [ ] **Step 3: 验证 resume 行为**

手工验证：发起一次任务 → 等输出 → 新开会话 resume 该会话 → 确认：a) 模型仍能列出并调用技能（如发 `/gxtz-xxx` 或技能面板插入的技能 prompt）；b) resume 后首个 assistant 事件前无异常。回退开关测试：设 `CLAUDE_CODE_FULL_SKILL_LIST=1` 重启 bridge 后 resume，确认回到全量。

- [ ] **Step 4: 提交**

```bash
git add server/bridge.mjs
git commit -m "perf(batch2): resume 会话技能清单精简注入（开关可回退全量）"
```

---

### Task 5: 首 token 计时探针 + spawn env 核对（批次 2）

**Files:**
- Modify: `server/bridge.mjs`（spawn 段 746-760 行附近、stdout line 处理器）

**Interfaces:**
- Produces: 日志 `[bridge] first-token <ms>`；env 核对结论写入 commit message

- [ ] **Step 1: 首 token 计时**

spawn 前记录 `const spawnT0 = Date.now()`；在 stdout readline line 处理器的第一行输出处：

```js
if (!s.firstTokenAt) {
  s.firstTokenAt = Date.now()
  console.log(`[bridge] first-token ${s.firstTokenAt - spawnT0}ms (sid ${sid.slice(0, 8)})`)
}
```

需在 session 对象上加 `firstTokenAt` 字段（`sessions` Map 的 value 初始化处，或 spawn 后 `proc.firstTokenAt = null` 类似）。实现以最小侵入为准：在 `getOrCreateSession` 的 session 对象创建处初始化。

- [ ] **Step 2: env 逐项核对**

审阅 `buildChildEnv()`（498-532 行）每项 env：
- 确认 `CLAUDE_CODE_AGENT_TRIGGERS`、`ANTHROPIC_*`、`CLAUDE_CODE_AUTO_COMPACT_WINDOW`、`CLAUDE_CODE_MAX_OUTPUT_TOKENS`、`CLAUDE_CODE_USE_NATIVE_FILE_SEARCH` 均为必要且被消费。
- 只删除**确认无消费者**的项（如有）；不确定一律保留。结论（保留/删除清单）写入本次 commit message。
- 若发现 `...process.env` 携带的冗余大 env（如完整 PATH 外的大值），记录到验证日志，不做删除。

- [ ] **Step 3: 提交**

```bash
git add server/bridge.mjs
git commit -m "perf(batch2): 首 token 计时探针 + spawn env 核对（结论见正文）"
```

---

### Task 6: 启用内核工具结果预算（批次 3）

**Files:**
- Modify: `ponos-kernel/claude-code/src/utils/toolResultStorage.ts`（`provisionContentReplacementState` 445-462 行 enabled 判断）
- Modify: `server/bridge.mjs`（`buildChildEnv` 注入开关 env）
- Rebuild: `ponos-kernel/claude-code` bundle（`scripts/build-bundle.ts`）→ `dist/cli.mjs`

**Interfaces:**
- Consumes: 内核既有 `applyToolResultBudget`（924 行）与 `provisionContentReplacementState`
- Produces: env `CLAUDE_CODE_TOOL_RESULT_BUDGET=true` 时启用预算（默认关闭 → 行为不变，红线保险）

**背景:** 内核已内置工具结果 token 预算（`tengu_hawthorn_steeple` feature，growthbook 默认 off）。改为干净的 env 开关控制，绕开需要内部 `USER_TYPE=ant` 的 growthbook override hack。阈值保守（每消息 20KB 截断 + 摘要保留），超出部分持久化到 transcript（既有机制）。

- [ ] **Step 1: 修改 enabled 判断**

`provisionContentReplacementState` 中：

```ts
const enabled = process.env.CLAUDE_CODE_TOOL_RESULT_BUDGET === 'true'
```

替换原 `getFeatureValue_CACHED_MAY_BE_STALE('tengu_hawthorn_steeple', false)`。保留其余逻辑（reconstruct/create 分支）不动。同时将 `getPerMessageBudgetLimit()`（约 417-435 行，原 `tengu_hawthorn_window` override + 硬编码常量回退）改为优先读取 `CLAUDE_CODE_TOOL_RESULT_BUDGET_BYTES` env（数字），未设置则回退现有 override/常量逻辑；env 默认注入 20000（20KB），超预算替换为截断摘要（保留头部 4000 字符 + 尾部 4000 字符 + "已截断"提示，沿用既有 replacement 字符串格式）。

- [ ] **Step 2: bridge 注入开关**

`buildChildEnv()` 末尾追加：

```js
// 内核工具结果预算（默认开启，保守 20KB 截断；设为 false 关闭 = 现状）
if (process.env.CLAUDE_CODE_TOOL_RESULT_BUDGET !== 'false') {
  env.CLAUDE_CODE_TOOL_RESULT_BUDGET = 'true'
}
```

- [ ] **Step 3: 重建内核 bundle 并同步**

```bash
cd C:/Users/T203-15/claude-code-gui/ponos-kernel/claude-code && bun scripts/build-bundle.ts --minify
```
（`scripts/build-bundle.ts` 用法：`bun scripts/build-bundle.ts --minify` 为生产构建。）产物 `dist/cli.mjs` 同步两份：release 副本 `release/Ponos_ms92cd6u/kernel/cli.mjs`（如存在）与调试版副本 `C:/Users/T203-15/YFDesigningDebug/app/runtime/kernel/cli.mjs`（如存在，路径以实际为准——先 `find` 确认）。

- [ ] **Step 4: 验证与回退**

- 验证：同一长任务（含大文件读取）跑两次——开关开 vs `CLAUDE_CODE_TOOL_RESULT_BUDGET=false`，比对 `usage.input_tokens`（bridge 日志/usePonosCLI tokenCount）与输出质量（人工比对回答完整性）。
- 若质量打折 → 默认改回关闭，仅保留 env 手动开启能力。

- [ ] **Step 5: 提交**

```bash
git add ponos-kernel/claude-code/src/utils/toolResultStorage.ts server/bridge.mjs
git commit -m "perf(batch3): 启用内核工具结果预算（env 开关，20KB 保守截断）"
```

---

### Task 7: 上下文利用率探针 + 压缩窗口校准依据（批次 3）

**Files:**
- Modify: `server/bridge.mjs`（result 事件处理附近，或 line 处理器）

**Interfaces:**
- Consumes: CLI 输出流中的 usage/result 事件
- Produces: 每次任务的 `input_tokens` 日志（`[bridge] usage in=X out=Y (sid ...)`）

**背景:** `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 当前取 provider.contextWindow（通常 1M）。是否可下调需先有真实利用率数据。本任务只加统计，不改窗口（避免打折）。

- [ ] **Step 1: 记录 usage**

在 bridge 的 line 处理器中，解析到含 `usage` 的 result 事件时：

```js
if (data && data.usage && data.type === 'result') {
  const u = data.usage
  console.log(`[bridge] usage in=${u.input_tokens ?? '-'} out=${u.output_tokens ?? '-'} (sid ${sid.slice(0, 8)})`)
}
```

（`data` 为已 JSON.parse 的 CLI 输出行对象；若现有处理器未保留 usage 字段则补充透传，不动前端协议。）

- [ ] **Step 2: 统计验证**

跑 2-3 个典型任务（长会话 resume、短任务、含大文件任务），收集 in/out token 分布。产出结论写入 commit message：窗口是否可下调（例如若长会话峰值利用率 < 50% 且无质量损失，可在后续批次下调）。

- [ ] **Step 3: 提交**

```bash
git add server/bridge.mjs
git commit -m "perf(batch3): 上下文利用率探针（usage 日志，供窗口校准决策）"
```

---

## 每批交付清单

- 批次 1（Task 1-3）：`npx tsc --noEmit && npm run build` → 同步 `dist/` 到 YFDesigningDebug → 用户验收（万级消息滚动流畅度、流式期间交互、搜索/复制/附件回归）→ 用户同意后重启。
- 批次 2（Task 4-5）：构建通过 → 同步 `server/bridge.mjs` → 用户验收（resume 后技能调用可用、首 token 日志可见）。
- 批次 3（Task 6-7）：内核 rebuild + 同步两份 cli.mjs + 同步 bridge → 用户验收（长任务 token 下降、输出质量不降）。

每批验收通过后再执行下一批；验收不通过则该批按红线原则回退或调参。
