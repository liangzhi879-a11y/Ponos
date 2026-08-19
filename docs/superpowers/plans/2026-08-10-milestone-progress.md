# 导航栏会话里程碑进度条 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 执行中的会话在导航栏会话条目背景显示真实进度（里程碑驱动），无里程碑时回退为活动条。

**Architecture:** 方案 A（系统提示协议，用户已确认）：bridge 在注入的 YFW_SYSTEM_PROMPT 追加里程碑协议规则 → agent 输出 `<!--MILESTONES n 名称|...-->` 与 `<!--MILESTONE-OK i/n 名称-->` 标记 → bridge 解析剥离并转发事件 → chatStore 记录 per-conversation 进度 → Sidebar 条目背景进度条渲染。与提问卡片机制同构，不改内核。

**Tech Stack:** Electron + React 18 + zustand；server/bridge.mjs（Node ESM）；纯函数模块 server/milestones.mjs；CSS 变量主题（yuanfang-light/yuanfang/dark/light）。

## Global Constraints

- **不改内核 bundle**（yfw-kernel/ 与 release 的 kernel/cli.mjs 均不动）
- **标记全部从对话流剥离**；会话标签标题不变；进度只体现在条目背景
- **全部使用 CSS 变量（--brand-300/400/500）**，适配四主题；不支持硬编码色值
- **无 git 仓库**：不执行 commit；每个任务以验证/构建代替，最终统一同步 release 副本（server/ + pet 不动 + dist/）
- `conversationProgress` **不加入** chatStore persist 的 partialize 白名单（运行时瞬态，重启消失）
- 错误处理：畸形标记忽略不崩溃，走活动条回退

---

### Task 1: bridge 系统提示注入里程碑协议段落

**Files:**
- Modify: `server/bridge.mjs`（YFW_SYSTEM_PROMPT 模板字符串，line 52-75 内 `${YFW_ASKUSER_FORMAT}` 之后）

**Interfaces:**
- Consumes: 无
- Produces: agent 行为约定（里程碑标记输出规则）——Task 2 解析依赖该约定

- [ ] **Step 1: 在 YFW_SYSTEM_PROMPT 中追加协议段落**

在 `server/bridge.mjs` 的 `YFW_SYSTEM_PROMPT` 模板字符串中，把 `${YFW_ASKUSER_FORMAT}` 一行替换为 `${YFW_ASKUSER_FORMAT}` + 新段落（普通文本，内部不得出现反引号）：

```js
${YFW_ASKUSER_FORMAT}

【任务里程碑进度协议】
- 执行多步骤/多阶段任务时：开始实施前，先内部拟定任务目标与阶段/里程碑清单，
  并用一行结构化标记声明总里程碑数及各里程碑名称：
  <!--MILESTONES 3 需求分析|方案设计|编码实现-->
- 每完成一个里程碑，立即输出该里程碑的达成标记：
  <!--MILESTONE-OK 1/3 需求分析-->
- 简单任务（闲聊、单步问答）无需声明里程碑。
- spec/plan 任务：以用户主导的计划步骤作为里程碑。
- 以上标记仅用于进度展示，不要向用户解释标记本身，不要在对话中展示里程碑清单。
```

- [ ] **Step 2: 验证语法**

Run: `node --check server/bridge.mjs`
Expected: 无输出（exit 0）

- [ ] **Step 3: 同步 release 副本**

Run:
```bash
cp server/bridge.mjs release/YFWorking_ms92cd6u/server/bridge.mjs
```
Expected: exit 0（release 副本与源码一致，Task 6 会再整体同步）

---

### Task 2: 里程碑标记解析模块 + bridge 集成

**Files:**
- Create: `server/milestones.mjs`
- Modify: `server/bridge.mjs`（import + assistant 解析处 line 569-587）

**Interfaces:**
- Consumes: Task 1 的协议段落（标记格式约定）
- Produces: `extractMilestoneMarks(text: string) => { stripped: string; milestones: { total: number; names: string[] } | null; oks: { index: number; total: number; name: string }[] }` —— Task 4/5 依赖事件 shape

- [ ] **Step 1: 写解析函数（纯模块）**

创建 `server/milestones.mjs`：

```js
// 里程碑标记解析（方案 A 协议，见 docs/superpowers/specs/2026-08-10-milestone-progress-design.md）
// 计划声明：<!--MILESTONES 3 需求分析|方案设计|编码实现-->
// 达成 check：<!--MILESTONE-OK 1/3 需求分析-->
export function extractMilestoneMarks(text) {
  const out = { stripped: text, milestones: null, oks: [] }
  const planMatch = text.match(/<!--MILESTONES\s+(\d+)\s+([\s\S]*?)-->/)
  if (planMatch) {
    const total = parseInt(planMatch[1], 10)
    if (total > 0) {
      out.milestones = {
        total,
        names: planMatch[2].split('|').map(s => s.trim()).filter(Boolean),
      }
    }
  }
  const okRe = /<!--MILESTONE-OK\s+(\d+)\/(\d+)\s+([\s\S]*?)-->/g
  let m
  while ((m = okRe.exec(text)) !== null) {
    out.oks.push({
      index: parseInt(m[1], 10),
      total: parseInt(m[2], 10),
      name: m[3].trim(),
    })
  }
  if (out.milestones || out.oks.length > 0) {
    out.stripped = text
      .replace(/<!--MILESTONES\s*[\s\S]*?-->|<!--MILESTONE-OK\s*[\s\S]*?-->/g, '')
      .trim()
  }
  return out
}
```

- [ ] **Step 2: 脚本验证解析函数**

Run:
```bash
node --input-type=module -e "
import { extractMilestoneMarks } from './server/milestones.mjs'
const r1 = extractMilestoneMarks('任务说明 <!--MILESTONES 3 需求分析|方案设计|编码实现--> 继续')
console.log('strip1:', JSON.stringify(r1.stripped), 'total:', r1.milestones?.total, 'names:', JSON.stringify(r1.milestones?.names))
const r2 = extractMilestoneMarks('<!--MILESTONE-OK 1/3 需求分析--> 已完成')
console.log('strip2:', JSON.stringify(r2.stripped), 'oks:', JSON.stringify(r2.oks))
const r3 = extractMilestoneMarks('普通文本，无标记')
console.log('plain:', JSON.stringify(r3.stripped), 'milestones:', r3.milestones, 'oks:', r3.oks.length)
const r4 = extractMilestoneMarks('<!--MILESTONE-OK 9/3 越界-->')
console.log('overflow index:', r4.oks[0].index)
"
```
Expected:
- r1: stripped 不含标记；total=3；names 长度 3
- r2: stripped 不含标记；oks 含 {index:1,total:3,name:'需求分析'}
- r3: stripped 原样；milestones null；oks 空
- r4: oks 保留 {index:9,...}（越界钳制由前端 Task 3 处理）

- [ ] **Step 3: bridge 集成——import**

在 `server/bridge.mjs` 顶部 import 区（line 1 附近）加入：

```js
import { extractMilestoneMarks } from './milestones.mjs'
```

- [ ] **Step 4: bridge 集成——assistant 文本解析处剥离与转发**

在 `server/bridge.mjs` line 569-587 的 assistant 解析循环内、现有 ASK_USER 处理之前插入里程碑处理（`block.text` 为 `string` 时）：

```js
if (block.type === 'text' && typeof block.text === 'string') {
  const mk = extractMilestoneMarks(block.text)
  if (mk.milestones) {
    send({ type: 'milestones', sessionId: sid, data: mk.milestones })
  }
  for (const ok of mk.oks) {
    send({ type: 'milestone-ok', sessionId: sid, data: ok })
  }
  if (mk.stripped !== block.text) {
    block.text = mk.stripped || '(…)'   // 防止全标记文本变成空块
  }
  const askMatch = block.text.match(/<!--ASK_USER\s*([\s\S]*?)-->/)
  // ……现有 ASK_USER 逻辑保持不变
}
```

注意：该代码块要放在现有 `if (block.type === 'text' && typeof block.text === 'string') {` 内部的最前面，ASK_USER 的 `askMatch` 之前。

- [ ] **Step 5: 语法与逻辑验证**

Run:
```bash
node --check server/bridge.mjs && node --check server/milestones.mjs
```
Expected: 均无输出（exit 0）

- [ ] **Step 6: 同步 release 副本**

Run:
```bash
cp server/milestones.mjs server/bridge.mjs release/YFWorking_ms92cd6u/server/
```
Expected: exit 0

---

### Task 3: chatStore 进度状态与 actions

**Files:**
- Modify: `src/types/index.ts`（新增 `ConversationProgress` 接口）
- Modify: `src/stores/chatStore.ts`（interface 字段 + 初始化 + 2 个 action + deleteConversation 清理）

**Interfaces:**
- Consumes: Task 2 的事件 shape（milestones: {total,names} / milestone-ok: {index,total,name}）
- Produces: `useChatStore` 暴露 `conversationProgress: Record<string, ConversationProgress>`、`setConversationMilestones(id, total, names)`、`setMilestoneDone(id, index)` —— Task 4 handler 与 Task 5 Sidebar 使用

- [ ] **Step 1: 类型定义**

在 `src/types/index.ts` 的 Chat 类型区（`Message` 定义之后）加入：

```ts
/** 会话里程碑进度（运行时瞬态，不持久化） */
export interface ConversationProgress {
  total: number
  names: string[]
  current: number
}
```

- [ ] **Step 2: store interface 字段与 actions 签名**

在 `src/stores/chatStore.ts` 的 `ChatState` interface（line 7-84）中，`pendingQuestions` 声明（line 37）之后加入：

```ts
  // Milestone progress — per-conversation, runtime-only (not persisted)
  conversationProgress: Record<string, ConversationProgress>
```

在 actions 区（`setPendingQuestion`/`clearPendingQuestion` 声明 line 82-83 之后）加入：

```ts
  setConversationMilestones: (conversationId: string, total: number, names: string[]) => void
  setMilestoneDone: (conversationId: string, index: number) => void
```

- [ ] **Step 3: 初始化 + 实现 actions**

在 state 初始化处（`pendingQuestions: {}`，line 101 之后）加入：

```ts
      conversationProgress: {},
```

在 `setPendingQuestion`/`clearPendingQuestion` 实现（line ~420 附近）之后加入：

```ts
      setConversationMilestones: (id, total, names) => set(state => ({
        conversationProgress: {
          ...state.conversationProgress,
          [id]: { total, names: Array.isArray(names) ? names : [], current: 0 },
        },
      })),

      setMilestoneDone: (id, index) => set(state => {
        const cur = state.conversationProgress[id]
        if (!cur) return {}
        // 容忍乱序 check：current 取最大值；index 越界钳制到 total
        const next = Math.max(cur.current, Math.min(index, cur.total))
        if (next === cur.current) return {}
        return {
          conversationProgress: {
            ...state.conversationProgress,
            [id]: { ...cur, current: next },
          },
        }
      }),
```

- [ ] **Step 4: deleteConversation 同步清理**

修改 `deleteConversation` 实现（line 126-134），在 `nextActive` 计算后返回前加入清理：

```ts
      deleteConversation: (id) => {
        set(state => {
          const filtered = state.conversations.filter(c => c.id !== id)
          const nextActive = state.activeConversationId === id
            ? (filtered[0]?.id || null)
            : state.activeConversationId
          const conversationProgress = { ...state.conversationProgress }
          delete conversationProgress[id]
          return { conversations: filtered, activeConversationId: nextActive, conversationProgress }
        })
      },
```

- [ ] **Step 5: 验证类型**

Run: `npx tsc --noEmit`
Expected: exit 0（无输出）

---

### Task 4: useYFWCLI 事件 handler

**Files:**
- Modify: `src/hooks/useYFWCLI.ts`（handleMessage，question handler 之后 line 320）

**Interfaces:**
- Consumes: Task 2 事件（msg.type 'milestones' / 'milestone-ok'，msg.sessionId）；Task 3 store actions
- Produces: 无（消费终点）

- [ ] **Step 1: 新增两个事件分支**

在 `useYFWCLI.ts` 的 `handleMessage` 中，`if (msg.type === 'question') { ... }` 块（line 311-320）之后、函数闭合 `}`（line 321）之前插入：

```ts
  if (msg.type === 'milestones') {
    const d = msg.data as { total?: number; names?: string[] } | undefined
    if (d && typeof d.total === 'number' && d.total > 0) {
      useChatStore.getState().setConversationMilestones(sid, d.total, d.names || [])
    }
    return
  }

  if (msg.type === 'milestone-ok') {
    const d = msg.data as { index?: number } | undefined
    if (d && typeof d.index === 'number') {
      useChatStore.getState().setMilestoneDone(sid, d.index)
    }
    return
  }
```

- [ ] **Step 2: 验证类型**

Run: `npx tsc --noEmit`
Expected: exit 0

---

### Task 5: Sidebar 背景进度条渲染 + CSS 视觉

**Files:**
- Modify: `src/components/layout/Sidebar.tsx`（destructure + props + ConversationItem）
- Modify: `src/styles/globals.css`（进度条样式，追加到文件末尾）

**Interfaces:**
- Consumes: Task 3 的 `conversationProgress`、现有 `streamingConversations`/`pendingQuestions`；`ConversationProgress` 类型
- Produces: 视觉交付物（真实进度条/活动条/冻结/四主题）

- [ ] **Step 1: 类型导入与 destructure**

`Sidebar.tsx` 顶部 import 区加：

```ts
import type { ConversationProgress } from '@/types'
```

Sidebar 组件 destructure（line 30）加 `conversationProgress`：

```ts
  const { conversations, activeConversationId, streamingConversations, pendingQuestions, conversationProgress, createConversation, setActiveConversation, deleteConversation, renameConversation, pinConversation, reorderConversations } = useChatStore()
```

- [ ] **Step 2: 传递 props 到两处 ConversationItem**

`ConvItemProps` interface（line 220-244）加：

```ts
  progress?: ConversationProgress
```

pinned 与 unpinned 两处 `<ConversationItem>`（line 137-163 与 168-194）各加一个 prop（与 `isAwaiting` 相邻）：

```tsx
                        progress={conversationProgress[conv.id]}
```

- [ ] **Step 3: ConversationItem 渲染进度条**

函数签名解构（line 246-251）加 `progress`：

```ts
function ConversationItem({
  conv, active, isStreaming, isAwaiting, progress, renaming, renameValue,
  ...
```

在渲染内，`{renaming ? (...) : (...)}` 的 else 分支**外层 div（line 280，className 含 `relative`）内部、会话行 div 之后**加入进度条元素（放在 `</div>`（line 326 会话行闭合）与 context menu 注释之间）：

```tsx
      {/* 背景进度条：执行中显示（待回复时冻结当前宽度），非执行中隐藏 */}
      {(isStreaming || isAwaiting) && (
        <div
          className={cn('conv-progress', isAwaiting && 'conv-progress-paused')}
          title={isStreaming && progress
            ? `${progress.names[progress.current] || '任务'} ${progress.current}/${progress.total}`
            : isStreaming ? '执行中' : undefined}
        >
          {progress && progress.total > 0 ? (
            <div
              className="conv-progress-fill"
              style={{ width: `${Math.min(100, Math.round((progress.current / progress.total) * 100))}%` }}
            />
          ) : (
            <div className="conv-progress-flow" />
          )}
        </div>
      )}
```

- [ ] **Step 4: 追加 CSS 到 globals.css**

在 `src/styles/globals.css` 文件末尾追加（全部使用 --brand-* 主题变量，自动适配四主题）：

```css
/* ===== 会话条目背景进度条（里程碑协议） ===== */
.conv-progress {
  position: absolute;
  left: 4px;
  right: 4px;
  bottom: 2px;
  height: 2px;
  border-radius: 1px;
  overflow: hidden;
  pointer-events: none;
}
/* 真实进度：尾端渐细、头部亮光 */
.conv-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, transparent 0%, var(--brand-500) 55%, var(--brand-300) 100%);
  -webkit-mask-image: linear-gradient(90deg, transparent 0%, #000 35%);
  mask-image: linear-gradient(90deg, transparent 0%, #000 35%);
  box-shadow: 0 0 6px var(--brand-400);
  transition: width 0.3s ease;
}
/* 活动条：中间亮光、两端渐细，左右循环流动 */
.conv-progress-flow {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 40%;
  background: linear-gradient(90deg, transparent, var(--brand-400) 50%, transparent);
  animation: conv-progress-flow 2.2s ease-in-out infinite;
}
@keyframes conv-progress-flow {
  0%   { left: -40%; }
  100% { left: 100%; }
}
.conv-progress-paused .conv-progress-fill,
.conv-progress-paused .conv-progress-flow {
  animation-play-state: paused;
  box-shadow: none;
}
@media (prefers-reduced-motion: reduce) {
  .conv-progress-flow {
    animation: none;
    left: 30%;
    opacity: 0.5;
  }
}
```

- [ ] **Step 5: 验证类型与构建**

Run:
```bash
npx tsc --noEmit && npx vite build
```
Expected: tsc exit 0；vite build 输出 `✓ built in` 且无错误

- [ ] **Step 6: 手动冒烟清单（构建产物预览）**

启动应用（或 dev server）后逐项核对：
- [ ] 发起多步骤任务（要求 agent 分步执行）→ 会话条目底部出现真实进度条，随 `<!--MILESTONE-OK-->` 推进
- [ ] 发起简单任务（如"你好"）→ 活动条流动动画
- [ ] agent 提问卡片期间 → 进度条冻结（不流动不增长）
- [ ] 会话结束 → 进度条消失；切换四主题（设置→主题）→ 进度条颜色随 --brand-* 变化
- [ ] 对话流中**无任何标记残留**，会话标题未变

---

### Task 6: 全量验证与 release 同步

**Files:**
- Modify: 无（同步操作）

**Interfaces:**
- Consumes: Task 1-5 全部产物

- [ ] **Step 1: 同步所有改动到 release 副本**

Run:
```bash
cd "C:/Users/T203-15/claude-code-gui"
npx tsc --noEmit
npx vite build
cp -r dist/assets/. release/YFWorking_ms92cd6u/dist/assets/
cp dist/index.html release/YFWorking_ms92cd6u/dist/index.html
cp server/bridge.mjs server/milestones.mjs release/YFWorking_ms92cd6u/server/
```
Expected: tsc exit 0；build 成功；拷贝 exit 0；`grep -o 'index-[A-Za-z0-9_-]*\.js' release/YFWorking_ms92cd6u/dist/index.html` 输出新构建哈希

- [ ] **Step 2: 复核 release 副本完整性**

Run:
```bash
grep -c "MILESTONES" release/YFWorking_ms92cd6u/server/bridge.mjs   # ≥1（协议段落）
grep -c "extractMilestoneMarks" release/YFWorking_ms92cd6u/server/bridge.mjs  # ≥1
ls release/YFWorking_ms92cd6u/server/milestones.mjs
```
Expected: 三个命令均有非空输出

- [ ] **Step 3: 交付说明**

向用户说明：重启应用（托盘退出→YFWorking-debug.bat）后生效；验证路径 = Task 5 Step 6 冒烟清单；无需重启内核。
