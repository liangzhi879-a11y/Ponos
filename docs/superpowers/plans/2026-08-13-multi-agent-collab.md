# 多 Agent 协同任务处理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 主 agent 能原生识别 GUI 注册的专业/自定义 agent 并按优势场景分发子任务；前端二级显示各子 agent 运行进度与工具活动流。

**Architecture:** 方案 A（内核零改动）。① agentStore 变更 → IPC `agents:sync` → electron main 写/删 `$PONOS_HOME/agents/<id>.md`（内核标准用户级 agents 目录，CLI 进程启动时自动加载，模型经 Agent 工具按 `whenToUse` 路由）。② 内核在 stream-json+verbose 模式输出 `system/task_started / task_progress / task_notification` SDK 事件 → bridge 原样转发 → usePonosCLI 新增分支 → chatStore `subAgentTasks` 切片 → ChatWindow 内二级面板渲染。

**Tech Stack:** Electron (main.cjs/preload.cjs)、React + zustand (persist)、TypeScript、Vite。无单元测试框架——每任务验证用 `npm run typecheck`，最终手动验收。

## Global Constraints

- 零内核改动、零重编译：不得修改 `ponos-kernel/` 与 `release/*/kernel/` 任何文件
- `$PONOS_HOME` = `%USERPROFILE%\.ponos`（`ensurePonosHome()` 解析）
- 只注入 `type === 'professional' | 'custom'` 且 `enabled === true` 的 agent；builtin（Explore/general-purpose/Plan/statusline-setup）与 ponos 不注入
- `.md` frontmatter 必须含非空 `name` 与 `description`（内核 `parseAgentFromMarkdown` 校验），正文 `prompt` 非空；`description` 换行压成单行并 YAML 双引号转义
- 只删除 GUI 已知 id（registry `.ponos-managed.json`）的 `.md`，不触碰用户手写文件
- 所有新增 UI 文案与现有代码一致用简体中文
- 同步失败静默降级（`.catch(() => {})` / try-catch），不得影响现有会话
- 事件处理按 `task_id` upsert，终态幂等（已终态任务不被 running/进度覆盖）
- `subAgentTasks` 为运行时瞬态，不持久化（不进 partialize）

---

### Task 1: Agent 模型新增 `whenToUse` 字段 + 专业 agent 预填

**Files:**
- Modify: `src/lib/agents.ts`

**Interfaces:**
- Produces: `Agent.whenToUse?: string`（优势场景，映射内核 whenToUse）；6 个专业 agent 均带预填 `whenToUse` 文案。Task 5 表单、Task 3 的 .md 生成（`whenToUse || description`）消费此字段。

- [ ] **Step 1: `Agent` 接口加字段**

在 `src/lib/agents.ts` 的 `description: string` 之后插入：

```ts
  /** 优势场景/适用任务 — 映射内核 whenToUse，供主 agent 路由子任务 */
  whenToUse?: string
```

- [ ] **Step 2: 6 个专业 agent 预填 whenToUse**

`PROFESSIONAL_AGENTS` 中每个对象在 `description` 行后加一行 `whenToUse:`：

- material-writer：
  `whenToUse: '当任务涉及撰写申报材料正文（研发立项报告、管理制度、成果转化说明、高新技术产品说明等）时使用；擅长专业正式、数据可溯源的成文写作',`
- table-expert：
  `whenToUse: '当任务涉及核心表格生成（RD/PS/IP/科技人员清单/TOAI 汇总表）或需要严格遵循模板、格式零偏差的输出时使用',`
- audit-verifier：
  `whenToUse: '当任务涉及专审报告核对（研发费用/高新收入）、发票与 PS 匹配、多维度一致性校验时使用',`
- packaging-engineer：
  `whenToUse: '当任务涉及申报材料整理、扫描排序、合并压缩、命名合规校验、生成最终上传包时使用',`
- info-collector：
  `whenToUse: '当任务涉及企业信息调查、收资清单生成、资料完备性检查或从企业微信收集资料时使用',`
- experience-keeper：
  `whenToUse: '当任务涉及经验沉淀、跨会话知识汇聚、驱动技能迭代升级时使用',`

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck`
Expected: 无错误（whenToUse 为可选字段，现有代码不受影响）

- [ ] **Step 4: Commit**

```bash
git add src/lib/agents.ts
git commit -m "feat(agents): Agent 模型新增 whenToUse 字段，专业 agent 预填优势场景文案"
```

---

### Task 2: PonosAPI 类型 + preload 暴露 `agentsSync`

**Files:**
- Modify: `src/types/index.ts`、`electron/preload.cjs`

**Interfaces:**
- Produces: `PonosAPI.agentsSync(agents: AgentSyncPayload[]) => Promise<{ ok: boolean; written?: string[]; removed?: string[]; error?: string }>`；`window.ponosAPI.agentsSync` 可用（preload）。Task 4（agentStore）调用；Task 3（main IPC）实现。

- [ ] **Step 1: types/index.ts 新增载荷类型与 API 签名**

在 `export interface AgentConfig`（约 249 行）之后新增：

```ts
/** agents:sync IPC 载荷（与 src/lib/agents.ts 的 Agent 结构化兼容，避免循环依赖） */
export interface AgentSyncPayload {
  id: string
  name: string
  description: string
  whenToUse?: string
  type: string
  model: string
  systemPrompt: string
  skills: string[]
  tools: string[]
  enabled: boolean
}
```

在 `PonosAPI` 接口（约 336 行）的 `setPetConfig` 之后新增：

```ts
  /** 将 GUI 注册的专业/自定义 agent 同步为内核 agent 文件（写/删 $PONOS_HOME/agents/*.md） */
  agentsSync: (agents: AgentSyncPayload[]) => Promise<{ ok: boolean; written?: string[]; removed?: string[]; error?: string }>
```

- [ ] **Step 2: preload.cjs 暴露 agentsSync**

在 `openInExplorer` 之后新增：

```js
  agentsSync: (agents) => ipcRenderer.invoke('agents:sync', agents),
```

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add src/types/index.ts electron/preload.cjs
git commit -m "feat(electron): preload 暴露 agentsSync IPC（agent 注册表同步内核）"
```

---

### Task 3: electron main 实现 `agents:sync` IPC（写/删 .md + registry）

**Files:**
- Modify: `electron/main.cjs`（`registerIpc()` 内新增 handler；文件内新增 `toYamlString` 工具函数）

**Interfaces:**
- Consumes: `ensurePonosHome()`（已存在，返回 `$PONOS_HOME`）、`path`、`fs`（文件顶部已 require）；IPC 载荷 `AgentSyncPayload[]`（Task 2）
- Produces: `ipcMain.handle('agents:sync', ...)` 返回 `{ ok, written, removed } | { ok: false, error }`

- [ ] **Step 1: 新增 `toYamlString` 工具函数**

在 `registerIpc()` 函数定义之前（如 `recordExperienceAlert` 附近）新增：

```js
// Agent 描述写入 YAML frontmatter：压成单行 + 双引号转义（内核解析时会把 \n 还原）
function toYamlString(v) {
  return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ') + '"'
}
```

- [ ] **Step 2: registerIpc() 内新增 agents:sync handler**

在 `shell:open-path` handler 之后新增：

```js
  // Agent 注册表同步：写入/删除 $PONOS_HOME/agents/<id>.md，供内核识别 GUI 注册的
  // 专业/自定义 agent 作为子 agent（方案 A，零内核改动）。
  // 只处理 professional/custom 且 enabled 的 agent；builtin 内核原生已有不注入。
  // 用 .ponos-managed.json 记录 GUI 管理的 id，删除时只删这些，不触碰用户手写文件。
  ipcMain.handle('agents:sync', async (_e, agents) => {
    try {
      const ponosHome = ensurePonosHome()
      const agentsDir = path.join(ponosHome, 'agents')
      fs.mkdirSync(agentsDir, { recursive: true })
      const registryFile = path.join(agentsDir, '.ponos-managed.json')
      let registry = []
      try { registry = JSON.parse(fs.readFileSync(registryFile, 'utf8')) } catch {}
      if (!Array.isArray(registry)) registry = []
      const managed = Array.isArray(agents)
        ? agents.filter(a => a && (a.type === 'professional' || a.type === 'custom'))
        : []
      const written = []
      const removed = []
      const keep = new Set()
      for (const a of managed) {
        const whenToUse = String(a.whenToUse || a.description || '').trim()
        if (!a.enabled || !whenToUse) continue
        const prompt = String(a.systemPrompt || '').trim()
        const body = prompt || `你是 Ponos 的 Agent「${a.name}」：${a.description}。使用简体中文，严禁自称 Claude、Anthropic 或其他 AI 品牌。`
        const lines = ['---', `name: ${a.id}`, `description: ${toYamlString(whenToUse)}`]
        if (Array.isArray(a.tools) && a.tools.length > 0) lines.push(`tools: ${a.tools.join(', ')}`)
        if (a.model) lines.push(`model: ${a.model}`)
        if (Array.isArray(a.skills) && a.skills.length > 0) lines.push(`skills: ${a.skills.join(', ')}`)
        lines.push('---', '', body)
        fs.writeFileSync(path.join(agentsDir, `${a.id}.md`), lines.join('\n'), 'utf8')
        written.push(a.id)
        keep.add(a.id)
      }
      for (const id of registry) {
        if (keep.has(id)) continue
        const f = path.join(agentsDir, `${id}.md`)
        if (fs.existsSync(f)) { try { fs.unlinkSync(f); removed.push(id) } catch {} }
      }
      fs.writeFileSync(registryFile, JSON.stringify([...keep]))
      console.log('[main] agents:sync → written:', written.join(','), 'removed:', removed.join(','))
      return { ok: true, written, removed }
    } catch (e) {
      console.warn('[main] agents:sync error:', e.message)
      return { ok: false, error: e.message }
    }
  })
```

- [ ] **Step 3: 语法检查**

Run: `node --check electron/main.cjs`
Expected: 无输出（通过）

- [ ] **Step 4: Commit**

```bash
git add electron/main.cjs
git commit -m "feat(electron): agents:sync IPC 写/删内核 agent 文件（.md + registry）"
```

---

### Task 4: agentStore 各变更 action 内同步到内核

**Files:**
- Modify: `src/stores/agentStore.ts`

**Interfaces:**
- Consumes: `window.ponosAPI.agentsSync`（Task 2）；store 的 `(set, get)`
- Produces: 每次增/删/改/启停/重置后自动同步；rehydrate 后启动时同步一次

- [ ] **Step 1: 新增同步 helper**

在 `mergeWithDefaults` 之后新增：

```ts
// 将 agent 注册表同步为内核 agent 文件（.md）。失败静默降级，不影响会话。
function syncAgentsToKernel(agents: Agent[]) {
  const api = (window as any).ponosAPI
  if (!api?.agentsSync) return
  api.agentsSync(agents).catch(() => {})
}
```

- [ ] **Step 2: creator 签名改为 (set, get)**

`persist((set) => ({` 改为 `persist((set, get) => ({`

- [ ] **Step 3: 各变更 action 末尾调用同步**

以下 6 个 action 的 `set(...)` 语句之后各加一行 `syncAgentsToKernel(get().agents)`：

- `toggleAgent`：启用/禁用（禁用即从内核移除该 agent）
- `addAgent`：新增自定义 agent
- `updateAgent`：修改自定义 agent（名称/描述/优势场景/提示词/工具等）
- `deleteAgent`：删除自定义 agent
- `resetAgent`：重置
- `resetAllAgents`：全部重置

`setAgentAvatar` **不触发**（头像不影响内核 agent 文件）。

- [ ] **Step 4: rehydrate 后启动同步一次**

`onRehydrateStorage` 回调中，在 `state.agents = mergeWithDefaults(state.agents)` 之后加：

```ts
          syncAgentsToKernel(state.agents)
```

- [ ] **Step 5: 类型检查**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add src/stores/agentStore.ts
git commit -m "feat(agents): agentStore 各变更 action 自动同步内核 agent 文件"
```

---

### Task 5: AgentsPanel 编辑表单新增"优势场景"输入框

**Files:**
- Modify: `src/components/agents/AgentsPanel.tsx`

**Interfaces:**
- Consumes: `form.whenToUse`（Task 1 字段）
- Produces: 表单可编辑 whenToUse，保存后经 updateAgent/addAgent（Task 4）自动同步

- [ ] **Step 1: EMPTY_AGENT 补 whenToUse**

`const EMPTY_AGENT: Agent = { id: '', name: '', description: '', ... }` 中 `description: ''` 后加 `whenToUse: '',`

- [ ] **Step 2: 表单新增输入框**

在"描述"Input 块之后（约 402 行后）插入：

```tsx
              <div>
                <label className="block text-[11px] font-medium text-secondary mb-1">
                  优势场景（主 agent 分发任务时据此路由，留空用描述）
                </label>
                <Textarea
                  value={form.whenToUse || ''}
                  onChange={e => setForm(p => ({ ...p, whenToUse: e.target.value }))}
                  placeholder="例如：当任务涉及撰写申报材料正文时使用，擅长专业正式、数据可溯源的成文写作"
                  className="min-h-[56px] text-xs resize-y"
                />
              </div>
```

（`Textarea` 已在 AgentsPanel 顶部 import，无需新增。）

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add src/components/agents/AgentsPanel.tsx
git commit -m "feat(agents): 编辑表单新增优势场景字段"
```

---

### Task 6: SubAgentTask 类型 + chatStore `subAgentTasks` 切片

**Files:**
- Modify: `src/types/index.ts`、`src/stores/chatStore.ts`

**Interfaces:**
- Produces: `SubAgentTask` 类型；`useChatStore.subAgentTasks: Record<string, SubAgentTask[]>`、`upsertSubAgentTask(conversationId, patch)`、`clearSubAgentTasks(conversationId)`。Task 7（usePonosCLI）写、Task 8（SubAgentPanel）读。

- [ ] **Step 1: types/index.ts 新增 SubAgentTask**

在 `ConversationProgress`（约 54 行）之后新增：

```ts
/** 子 agent 任务（运行时瞬态，不持久化；由内核 system/task_* SDK 事件驱动） */
export interface SubAgentTask {
  taskId: string
  name: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  prompt?: string
  toolUseCount: number
  tokenCount: number
  durationMs: number
  lastToolName?: string
  /** 工具活动流：每次 task_progress 的 description（如"正在读取 xx.xlsx"）追加一行 */
  activities: { toolName: string; description: string; ts: number }[]
  summary?: string
  outputFile?: string
  error?: string
}
```

- [ ] **Step 2: chatStore 接口新增字段与 actions**

`ChatState` 接口中 `conversationProgress` 之后新增：

```ts
  // 子 agent 任务（二级面板数据源，运行时瞬态不持久化）
  subAgentTasks: Record<string, SubAgentTask[]>
```

`setMilestoneDone` 声明之后新增：

```ts
  upsertSubAgentTask: (conversationId: string, patch: Partial<SubAgentTask> & { taskId: string }) => void
  clearSubAgentTasks: (conversationId: string) => void
```

- [ ] **Step 3: 初始状态与 actions 实现**

初始状态 `conversationProgress: {}` 后加 `subAgentTasks: {},`

`setMilestoneDone` 实现之后（`}),` 之前）新增：

```ts
      upsertSubAgentTask: (conversationId, patch) => set(state => {
        const list = state.subAgentTasks[conversationId] || []
        const idx = list.findIndex(t => t.taskId === patch.taskId)
        if (idx === -1) {
          const task: SubAgentTask = {
            taskId: patch.taskId,
            name: patch.name || String(patch.taskId).slice(0, 8),
            status: patch.status || 'running',
            prompt: patch.prompt,
            toolUseCount: patch.toolUseCount ?? 0,
            tokenCount: patch.tokenCount ?? 0,
            durationMs: patch.durationMs ?? 0,
            lastToolName: patch.lastToolName || '',
            activities: patch.activities || [],
            summary: patch.summary,
            outputFile: patch.outputFile,
            error: patch.error,
          }
          return { subAgentTasks: { ...state.subAgentTasks, [conversationId]: [...list, task] } }
        }
        const prev = list[idx]
        const task: SubAgentTask = { ...prev, ...patch, activities: undefined }
        // 终态幂等：running 进度不覆盖已终态任务；终态通知不覆盖 summary/outputFile 已置的旧值以外的新值
        if (prev.status !== 'running' && patch.status === 'running') task.status = prev.status
        if (patch.activities && patch.activities.length > 0) {
          task.activities = [...prev.activities, ...patch.activities].slice(-200)
        }
        const next = [...list]
        next[idx] = task
        return { subAgentTasks: { ...state.subAgentTasks, [conversationId]: next } }
      }),

      clearSubAgentTasks: (conversationId) => set(state => {
        if (!state.subAgentTasks[conversationId]) return {}
        const next = { ...state.subAgentTasks }
        delete next[conversationId]
        return { subAgentTasks: next }
      }),
```

- [ ] **Step 4: deleteConversation 同步清理**

`deleteConversation` 实现（约 133-143 行）当前为：

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

在其中 `conversationProgress` 副本行之后新增两行，并把 `subAgentTasks` 加入 return：

```ts
          const subAgentTasks = { ...state.subAgentTasks }
          delete subAgentTasks[id]
          return { conversations: filtered, activeConversationId: nextActive, conversationProgress, subAgentTasks }
```

持久化 partialize 只含 conversations/activeConversationId/lastCwd，`subAgentTasks` 天然不落盘。

- [ ] **Step 5: 类型检查**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add src/types/index.ts src/stores/chatStore.ts
git commit -m "feat(chat): chatStore 新增 subAgentTasks 切片（upsert/clear，瞬态不持久化）"
```

---

### Task 7: usePonosCLI 消费内核 system/task_* SDK 事件

**Files:**
- Modify: `src/hooks/usePonosCLI.ts`

**Interfaces:**
- Consumes: `useChatStore.upsertSubAgentTask / clearSubAgentTasks`（Task 6）
- Produces: 事件→`subAgentTasks` 的完整映射；模块级 `toolUseAgentMap`（tool_use_id → agentType，供 task_started 取名）

- [ ] **Step 1: 模块级 toolUseAgentMap**

`handleMessage` 函数定义之前新增：

```ts
// Agent 工具调用的 tool_use_id → subagent_type（agentType）映射。
// 内核 task_started/task_progress 只带 tool_use_id，需回查 leader 消息里的 Agent 工具调用块取 agent 名。
const toolUseAgentMap = new Map<string, string>()
```

- [ ] **Step 2: assistant 分支记录 Agent 工具调用**

`handleMessage` 中 `bt === 'tool_use'` 分支（约 290 行）的 upsertBlock 调用之前插入：

```ts
          const toolInput = (block as any).input || {}
          if (block.name === 'Agent' && block.id) {
            toolUseAgentMap.set(block.id as string, String(toolInput.subagent_type || ''))
          }
```

（`block` 为该分支循环变量，类型为 `Record<string, unknown>`，无需 import。）

- [ ] **Step 3: system/task_* 事件分支**

`msg.type === 'event'` 处理中，`type === 'system' && subtype === 'init'` 分支之后（约 276 行后）插入：

```ts
    if (type === 'system') {
      const subtype = event.subtype as string
      if (subtype === 'task_started') {
        const t = event as Record<string, any>
        const agentId = t.tool_use_id ? toolUseAgentMap.get(t.tool_use_id as string) : undefined
        useChatStore.getState().upsertSubAgentTask(sid, {
          taskId: t.task_id,
          name: agentId || String(t.task_id).slice(0, 8),
          status: 'running',
          prompt: typeof t.prompt === 'string' ? t.prompt : undefined,
        })
        return
      }
      if (subtype === 'task_progress') {
        const t = event as Record<string, any>
        const usage = t.usage || {}
        useChatStore.getState().upsertSubAgentTask(sid, {
          taskId: t.task_id,
          toolUseCount: usage.tool_uses ?? 0,
          tokenCount: usage.total_tokens ?? 0,
          durationMs: usage.duration_ms ?? 0,
          lastToolName: t.last_tool_name || '',
          activities: t.description
            ? [{ toolName: t.last_tool_name || '', description: String(t.description), ts: Date.now() }]
            : [],
        })
        return
      }
      if (subtype === 'task_notification') {
        const t = event as Record<string, any>
        useChatStore.getState().upsertSubAgentTask(sid, {
          taskId: t.task_id,
          status: t.status === 'completed' ? 'completed' : t.status === 'failed' ? 'failed' : 'stopped',
          summary: t.summary || '',
          outputFile: t.output_file || '',
          toolUseCount: t.usage?.tool_uses ?? 0,
          tokenCount: t.usage?.total_tokens ?? 0,
          durationMs: t.usage?.duration_ms ?? 0,
        })
        return
      }
    }
```

- [ ] **Step 4: 会话退出清理**

`msg.type === 'closed'` 分支（约 354 行）中 `sessionState.delete(sid)` 之后加：

```ts
    useChatStore.getState().clearSubAgentTasks(sid)
```

- [ ] **Step 5: 类型检查**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add src/hooks/usePonosCLI.ts
git commit -m "feat(chat): usePonosCLI 消费内核 task_started/progress/notification 事件"
```

---

### Task 8: SubAgentPanel 二级面板组件

**Files:**
- Create: `src/components/chat/SubAgentPanel.tsx`

**Interfaces:**
- Consumes: `useChatStore.subAgentTasks`（Task 6）、`useAgentStore.agents` + `getAgentById`（src/lib/agents.ts）、`AgentAvatar`（src/components/agents/AgentAvatar.tsx）、`Badge`（@/components/ui）、`useUIStore.setPreviewFile`、`cn`
- Produces: `<SubAgentPanel conversationId={string} />`——无任务时返回 null；每任务一行可展开（行头 + 工具活动流 + 摘要 + 结果文件）

- [ ] **Step 1: 创建组件**

```tsx
import { useState } from 'react'
import { ChevronDown, ChevronRight, FolderOpen, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui'
import { cn } from '@/lib/utils'
import { useChatStore } from '@/stores/chatStore'
import { useAgentStore } from '@/stores/agentStore'
import { useUIStore } from '@/stores/uiStore'
import { getAgentById } from '@/lib/agents'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import type { SubAgentTask } from '@/types'

const STATUS_META: Record<SubAgentTask['status'], { label: string; variant: 'success' | 'danger' | 'warning' | 'default' }> = {
  running: { label: '运行中', variant: 'warning' },
  completed: { label: '完成', variant: 'success' },
  failed: { label: '失败', variant: 'danger' },
  stopped: { label: '已停止', variant: 'default' },
}

function fmtMs(ms: number): string {
  if (!ms) return ''
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${s % 60}s`
}

interface RowProps {
  task: SubAgentTask
  expanded: boolean
  onToggle: () => void
}

function SubAgentRow({ task, expanded, onToggle }: RowProps) {
  const agents = useAgentStore(s => s.agents)
  // AgentAvatar 的 agent 参数为必填（Pick<Agent,'avatar'|'name'>），未匹配到时回退占位
  const agent = getAgentById(agents, task.name) ?? { avatar: undefined, name: task.name }
  const setPreviewFile = useUIStore(s => s.setPreviewFile)
  const meta = STATUS_META[task.status]
  return (
    <div className="rounded-lg border border overflow-hidden bg-elevated/40">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-hover transition-colors"
      >
        {expanded
          ? <ChevronDown className="w-3 h-3 text-tertiary shrink-0" />
          : <ChevronRight className="w-3 h-3 text-tertiary shrink-0" />}
        <AgentAvatar agent={agent} size={20} />
        <span className="text-xs font-medium text-primary">{task.name}</span>
        <Badge variant={meta.variant}>{meta.label}</Badge>
        {task.status === 'running' && <Loader2 className="w-3 h-3 text-brand-500 animate-spin shrink-0" />}
        {task.lastToolName && (
          <span className="text-[10px] text-tertiary truncate max-w-[200px]">
            当前：{task.lastToolName}
          </span>
        )}
        <span className="text-[10px] text-tertiary ml-auto shrink-0">
          {task.toolUseCount > 0 && `${task.toolUseCount} 工具`}
          {task.tokenCount > 0 && ` · ${task.tokenCount} tokens`}
          {task.durationMs > 0 && ` · ${fmtMs(task.durationMs)}`}
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-2.5 border-t border-subtle">
          {task.prompt && (
            <p className="text-[11px] text-secondary mt-1.5 whitespace-pre-wrap break-all [overflow-wrap:anywhere]">{task.prompt}</p>
          )}
          {task.activities.length > 0 && (
            <div className="mt-1.5 space-y-0.5 max-h-[160px] overflow-auto">
              {task.activities.map((a, i) => (
                <div key={i} className="flex items-center gap-1.5 text-[11px] text-tertiary">
                  <span className="text-brand-500/70 shrink-0">{a.toolName}</span>
                  <span className="truncate">{a.description}</span>
                </div>
              ))}
            </div>
          )}
          {task.status !== 'running' && (task.summary || task.outputFile) && (
            <div className="mt-2 text-[11px] text-secondary border-t border-subtle pt-2">
              {task.summary && (
                <p className="whitespace-pre-wrap break-all [overflow-wrap:anywhere]">{task.summary}</p>
              )}
              {task.outputFile && (
                <button
                  className="mt-1 inline-flex items-center gap-1 text-accent hover:text-accent/80 cursor-pointer"
                  onClick={() => setPreviewFile({ path: task.outputFile!, name: task.outputFile!.split(/[/\\]/).pop() || task.outputFile! })}
                >
                  <FolderOpen className="w-3 h-3" />
                  {task.outputFile}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

interface Props {
  conversationId: string
}

export function SubAgentPanel({ conversationId }: Props) {
  const tasks = useChatStore(s => s.subAgentTasks[conversationId])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  if (!tasks || tasks.length === 0) return null
  return (
    <div className={cn('mx-auto w-full max-w-[1600px] min-w-0 px-6 sm:px-16 lg:px-32 py-1.5 space-y-1.5')}>
      <p className="text-[10px] font-semibold text-tertiary uppercase tracking-wider">子 Agent</p>
      {tasks.map(task => (
        <SubAgentRow
          key={task.taskId}
          task={task}
          expanded={!!expanded[task.taskId]}
          onToggle={() => setExpanded(prev => ({ ...prev, [task.taskId]: !prev[task.taskId] }))}
        />
      ))}
    </div>
  )
}
```

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: 无错误（Step 1 已用 `?? { avatar: undefined, name: task.name }` 兜底 AgentAvatar 必填参数）

- [ ] **Step 3: Commit**

```bash
git add src/components/chat/SubAgentPanel.tsx
git commit -m "feat(chat): 新增 SubAgentPanel 二级子 agent 面板组件"
```

---

### Task 9: ChatWindow 集成 SubAgentPanel

**Files:**
- Modify: `src/components/chat/ChatWindow.tsx`

**Interfaces:**
- Consumes: `<SubAgentPanel conversationId={conversationId} />`（Task 8）

- [ ] **Step 1: import**

文件顶部 import 区新增：

```tsx
import { SubAgentPanel } from './SubAgentPanel'
```

- [ ] **Step 2: 消息列表后渲染**

`</ScrollArea>` 之前（messages 渲染 div 的 `</div>` 之后、约 290 行处），在 `) : (` 的 messages 分支内新增：

```tsx
            <SubAgentPanel conversationId={conversationId} />
```

即：messages 分支的 `<div className="pb-2 min-w-0 overflow-hidden">{messages.map(...)}</div>` 之后加一行 `<SubAgentPanel conversationId={conversationId} />`（与消息同处 ScrollArea 内容区，居中宽度与消息一致）。

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add src/components/chat/ChatWindow.tsx
git commit -m "feat(chat): ChatWindow 集成子 agent 二级面板"
```

---

### Task 10: 构建 + 同步 release 调试版 + 手动验收

**Files:**
- 无代码改动；执行构建与同步命令

- [ ] **Step 1: 构建**

Run: `npm run build`
Expected: `dist/` 生成，tsc + vite 无错误

- [ ] **Step 2: 同步 release 调试版（用户实际运行环境，见 BUILD.md）**

```bash
rm -rf release/Ponos/dist/*
cp -r dist/* release/Ponos/dist/
cp -r server/* release/Ponos/server/
cp -r public/* release/Ponos/public/
cp electron/main.cjs electron/preload.cjs release/Ponos/electron/
cp YF/jiajia-pixel-pet/jiajia-pet.py release/Ponos/pet/jiajia-pet.py
```

- [ ] **Step 3: 手动验收清单（重启应用后逐项勾选）**

- [ ] 启动应用 → 检查 `%USERPROFILE%\.ponos\agents\` 下生成了 6 个专业 agent 的 `.md`（material-writer.md 等），frontmatter 含 `name`/`description`/`model`/`skills`，正文为 systemPrompt
- [ ] 主 agent 会话中让它"并行处理多个子任务"，对话中可见 Agent 工具调用，且前端出现多行"子 Agent"面板，每行有头像/名称/状态徽章/工具数/tokens/耗时
- [ ] 展开某子 agent 行 → 工具活动流实时滚动（"当前：Read / Write..."类行），完成/失败状态徽章正确切换，摘要与结果文件路径展示
- [ ] AgentsPanel 禁用某专业 agent → 对应 `.md` 被删除；新建会话主 agent 不再收到该 agent
- [ ] 手动添加自定义 agent（填名称/描述/优势场景/系统提示词）→ 自动生成 `.md`，新建会话主 agent 能识别调用
- [ ] 自定义 agent 编辑"优势场景"后 → `.md` 的 description 同步更新；留空时回退用描述
- [ ] 会话退出后"子 Agent"面板清空；无子任务运行时无任何残留 UI
- [ ] 用户手写的 `.ponos/agents/xxx.md`（不在 GUI 注册表）不受同步影响，仍被内核加载

- [ ] **Step 4: Commit 剩余构建产物（如有）**

若 `dist/` 不入库则跳过；仅当仓库惯例要求提交构建产物时执行：

```bash
git add -A
git commit -m "build: 同步多 agent 协同功能到 release 调试版"
```

---

## 验收对照（spec §8）

| spec 验收项 | 对应任务 |
|---|---|
| 编辑 agent 后新建会话，主 agent 能调用该 agent | Task 3/4/5 + Task 10 手测①⑤⑥ |
| 手动添加自定义 agent 后能被识别调用 | Task 4（addAgent 同步）+ Task 10 手测⑤ |
| 并行分发时前端多行面板 + 进度实时更新 | Task 6/7/8/9 + Task 10 手测② |
| 工具活动流随 task_progress 滚动 | Task 7（activities 追加）+ Task 8 展开区 |
| 终态徽章/摘要/结果文件 | Task 7 task_notification + Task 8 |
| 禁用/删除后内核不再收到（.md 删除） | Task 3（registry 删除）+ Task 4（toggle/delete 同步） |
| 会话退出面板清空、无残留 UI | Task 7 Step 4 + Task 8（空返回 null） |

## 风险与备注

- **生效时机**：每个会话独立 CLI 进程，spawn 时读取 `$PONOS_HOME/agents/`；已存在会话不感知 agent 变更（与 systemPrompt 行为一致）
- **事件时序**：assistant 消息（含 Agent tool_use）先于 task_started 到达，`toolUseAgentMap` 先填充；若个别时序异常导致取名回退为 task_id 短码，符合 spec 边界设计
- **cmd.exe 限制**：全程 .md 文件注入，不碰 `--agents` JSON 命令行
- **后台子 agent**：`result` 事件后任务仍可更新（面板独立于 leader 消息），Task 8 持续订阅 store
