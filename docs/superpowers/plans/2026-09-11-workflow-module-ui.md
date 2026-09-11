# 工作流第五模块 · 宿主与 GUI 计划（运行宿主 / 授权清单 / 第五 rail / 画布）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在 GUI 里搭建、运行、调试工作流（Dify 式画布），并把它绑定到指定 agent 或公开为全局工具；运行走常驻宿主 + 运行前授权清单。

**Architecture:** bridge 新增两个模块：`server/workflow-store.mjs`（磁盘权威 CRUD / 版本 / 导入导出 / 绑定，**纯 fs + 轻量正则元数据**）与 `server/workflow-host.mjs`（常驻内核宿主会话 `_wfhost`，承载 DSL 解析、校验、序列化、运行与事件流）。GUI 新增第五 rail 与三层界面（列表 / 画布 / 运行抽屉），画布用 `@xyflow/react`，DSL 的解析与序列化**全部在内核**（前端只持有 JSON 模型），避免两套 DSL 实现。

**Tech Stack:** Node.js ESM（bridge/内核，零新依赖）；React 18 + Zustand + Tailwind（GUI）；`@xyflow/react`（画布，唯一新增依赖）；测试用 `node --test`（server）与 `node --test` 跑 TS 逻辑测试（`src/lib/*.test.ts` 由既有约定 `npm test` 之外单独执行）。

## Global Constraints

- **server/ 不得 import `kernel/*.mjs`**：生产包只带 `kernel-dist/cli.mjs`（`electron-builder.yml` 的 files 不含 `kernel/**`），server 侧离线引用会在安装版直接崩。DSL 解析/序列化/校验一律经宿主会话（内核）完成。
- 内核零外部运行时依赖；GUI 只新增 `@xyflow/react` 一个依赖。
- 桥接端口默认 **51517**（`YFW_BRIDGE_PORT`）；新增 HTTP 路由沿用现有 `reply()` 风格与 `readJsonBody()`；WS 下行复用既有 `broadcastGui()`。
- 授权只免除交互、**不免除审计**：每次工具调用仍写哈希链（`auditAppend`）。
- 未授权调用 **fail-closed**（拒绝并作为节点输出/事件），不得挂起等待、不得中断整轮。
- 运行级取消 `runId` 作用域；全局取消（现有 `_signal`）语义不变。
- 工作流根目录：`<YFW_HOME>/workflows/<id>/workflow.yml`（用户），版本 `<id>/versions/<ts>.yml`（保留最近 20），绑定与信任 `<YFW_HOME>/workflows/_bindings.json`，审计 `<YFW_HOME>/workflow-runs/`（位置不变），宿主 cwd `<YFW_HOME>/workflow-runtime/`。
- 依赖前置：本计划假定内核计划（`2026-09-11-workflow-module-kernel.md`）Task 1-8 已完成（DSL v2 / DAG 调度器 / 节点执行器 / 引擎 / dyntools / 绑定 / spec-dev 重写）。

---

## 文件结构（本计划锁定）

| 文件 | 职责 |
|---|---|
| `kernel/workflow-dsl.mjs`（补） | 增 `serializeWorkflow(model) → yml` 与 `toModel(wf) → model`（画布模型 ⇄ DSL 双向，唯一实现） |
| `kernel/workflow-nodes.mjs`（补） | `checkToolPermission` 支持 `ctx.grant`（按 runId 的能力授权，fail-closed） |
| `kernel/cli.mjs`（补） | `workflow_command` 增 `load/save/save-raw/stop/validate`；run 支持 `grant` 与 `runId` |
| `server/workflow-store.mjs`（新建） | 工作流磁盘 CRUD、版本快照、导入导出、绑定与信任态（无内核依赖） |
| `server/workflow-host.mjs`（新建） | 常驻宿主会话生命周期、命令注入与回执、grantToken 发放与校验、事件转发 |
| `server/bridge.mjs`（改） | 挂载 `/workflows*` 路由；`workflow` 事件 → `workflow_event` 广播 |
| `src/stores/viewStore.ts`（改） | `RailId` 增 `'workflows'`（含 `sanitizeRail` 白名单） |
| `src/components/layout/railMeta.ts`（改） | rail 元数据增 workflows 项（lucide `Workflow` 图标） |
| `src/components/layout/WorkShell.tsx`（改） | rail 分支渲染 `WorkflowsPanel` |
| `src/lib/workflowApi.ts`（新建） | bridge HTTP 客户端（列表/读写/运行/停止/确认/记录/导入导出） |
| `src/stores/workflowStore.ts`（新建） | 列表与编辑器状态、运行状态（persist 只落列表元数据与最近打开 id） |
| `src/lib/workflowModel.ts`（新建） | DSL 的 TS 类型 + 画布模型转换 + 能力推导 + 本地校验（纯函数，可测） |
| `src/components/workflows/**`（新建） | `WorkflowsPanel` / `WorkflowList` / `RunDrawer` / `AuthzDialog` / `canvas/*` |
| `docs/bridge-contract.md`（改） | 新增"工作流模块"章节（路由契约 + 事件契约） |

依赖顺序：Task 9 → 10 → 11 → 12 →（13 与 14 依赖 12）→ 13 → 14。

---

### Task 9: 内核补丁（serializeWorkflow / toModel / grant 授权）

**Files:**
- Modify: `kernel/workflow-dsl.mjs`（增 `serializeWorkflow` / `toModel`）
- Modify: `kernel/workflow-nodes.mjs`（`checkToolPermission` 支持 `ctx.grant`）
- Test: `kernel-tests/workflow-serialize.test.mjs`、`kernel-tests/workflow-grant.test.mjs`

**Interfaces:**
- Consumes: 内核计划的 `normalizeWorkflow` / `validateWorkflow` / `checkToolPermission`
- Produces:
  - `toModel(wf) → { name, description, version, triggers, trigger_config, settings, inputs, nodes:[{id,type,label,position,retry,on_error,...config}], edges, expose, permissions }`
  - `serializeWorkflow(model|wf) → yml`（稳定输出：固定键序，缩进 2 空格，`config` 重新收拢）
  - `checkToolPermission(ctx, name, input)` 新增 grant 语义：`ctx.grant && ctx.grant.tools.includes(name)` → 放行；`grant.write_dirs` 约束 Write/Edit 落点；未命中 → 拒绝（fail-closed）
  - 若内核计划的 `discoverWorkflows` 条目尚未含 `expose`，一并补上（GUI 列表与工具池需要）

- [ ] **Step 1: 写失败测试**

创建 `kernel-tests/workflow-serialize.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serializeWorkflow, toModel, parseYaml, normalizeWorkflow, validateWorkflow } from '../kernel/workflow-dsl.mjs'

const MODEL = {
  name: 'demo', description: '演示', version: '1.0.0', triggers: ['演示'],
  trigger_config: { manual: true, webhook: false },
  settings: { max_parallel: 4 },
  inputs: [{ name: 'q', type: 'string', required: true, description: '问题' }],
  nodes: [
    { id: 'start', type: 'start', label: '开始', position: { x: 0, y: 0 } },
    { id: 'ask', type: 'llm', label: '生成', position: { x: 240, y: 0 }, prompt: '回答：{{inputs.q}}', retry: { max: 2, delay_ms: 500, on_error: 'fail' } },
    { id: 'done', type: 'end', label: '结束', position: { x: 480, y: 0 }, outputs: [{ name: 'text', selector: '{{ask}}' }] },
  ],
  edges: [{ id: 'e1', source: 'start', target: 'ask' }, { id: 'e2', source: 'ask', target: 'done' }],
  expose: { mode: 'public', tool_name: 'run_demo' },
  permissions: { tools: ['Read'], network: false },
}

test('serialize → parse 往返：模型语义不变', () => {
  const yml = serializeWorkflow(MODEL)
  assert.match(yml, /^name: demo$/m)
  assert.match(yml, /^edges:$/m)
  const back = normalizeWorkflow(parseYaml(yml))
  assert.equal(back.nodes.find((n) => n.id === 'ask').prompt, '回答：{{inputs.q}}', 'config 摊平后应还原')
  assert.deepEqual(back.edges.map((e) => `${e.source}->${e.target}`), ['start->ask', 'ask->done'])
  assert.equal(back.expose.mode, 'public')
  assert.deepEqual(validateWorkflow(back).errors, [])
})

test('toModel：node 的非配置字段不进 config（label/position/retry 保持顶层）', () => {
  const wf = normalizeWorkflow(parseYaml(serializeWorkflow(MODEL)))
  const m = toModel(wf)
  const ask = m.nodes.find((n) => n.id === 'ask')
  assert.equal(ask.label, '生成')
  assert.deepEqual(ask.position, { x: 240, y: 0 })
  assert.equal(ask.retry.max, 2)
  const yml2 = serializeWorkflow(m)
  assert.match(yml2, /label: 生成/)
  assert.match(yml2, /position: \{x: 240, y: 0\}/)
})

test('serialize 稳定性 + 幂等（已是模型形态时不丢 config）', () => {
  assert.equal(serializeWorkflow(MODEL), serializeWorkflow(MODEL))
  // 幂等：把 toModel 的产物再喂回去，config 必须原样保留
  const once = toModel(MODEL)
  const twice = toModel(once)
  assert.deepEqual(twice.nodes.find((n) => n.id === 'ask').config, once.nodes.find((n) => n.id === 'ask').config)
  assert.match(serializeWorkflow(once), /prompt: 回答：\{\{inputs\.q\}\}/)
})
```

创建 `kernel-tests/workflow-grant.test.mjs`：

```js
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodeExecutor } from '../kernel/workflow-nodes.mjs'
import { createToolRegistry } from '../kernel/tools.mjs'

test('grant：命中授权清单放行，未命中 fail-closed 且不挂起', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-grant-'))
  try {
    // 无 permissionGate（脱离引擎）时：Bash 默认拒绝；grant 命中则放行
    const registry = createToolRegistry({ cwd: root, addDirs: [root], skipPermissions: true })
    const exec = createNodeExecutor({ registry, getModel: () => 'mock' })
    const denied = await exec({ id: 't', type: 'tool', tool: 'Bash', input: { command: 'echo hi' } }, { inputs: {}, vars: {}, var: {} })
    assert.equal(denied.ok, false, '无 grant 时 Bash 应 fail-closed')
    assert.match(String(denied.error ?? denied.output), /拒绝|无审批通道/)

    const granted = await exec({ id: 't', type: 'tool', tool: 'Bash', input: { command: 'echo hi' } }, { inputs: {}, vars: {}, var: {}, grant: { tools: ['Bash'], write_dirs: [], network: false } })
    assert.equal(granted.ok, true, `grant 命中应放行：${JSON.stringify(granted)}`)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('grant：write_dirs 约束写入落点', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-grant2-'))
  try {
    const registry = createToolRegistry({ cwd: root, addDirs: [root], skipPermissions: true })
    const exec = createNodeExecutor({ registry, getModel: () => 'mock' })
    const outside = await exec({ id: 'w', type: 'tool', tool: 'Write', input: { file_path: join(root, '..', 'evil.txt'), content: 'x' } }, { inputs: {}, vars: {}, var: {}, grant: { tools: ['Write'], write_dirs: [join(root, 'ok')], network: false } })
    assert.equal(outside.ok, false, '越界写入应被拒绝')
    assert.match(String(outside.error ?? outside.output), /授权目录/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test kernel-tests/workflow-serialize.test.mjs kernel-tests/workflow-grant.test.mjs`
Expected: FAIL — `serializeWorkflow is not a function` / grant 未生效

- [ ] **Step 3: 实现 `toModel` / `serializeWorkflow`**

追加到 `kernel/workflow-dsl.mjs`：

```js
const NODE_META_KEYS = new Set(['id', 'type', 'label', 'position', 'retry', 'on_error', 'body', 'note'])
const TOP_KEYS = ['name', 'description', 'version', 'triggers', 'trigger_config', 'settings', 'inputs', 'nodes', 'edges', 'expose', 'permissions']

// wf（摊平后）→ 画布模型：非元数据字段收拢回 node.config。
// 幂等：若节点已是模型形态（已带 config），则把 config 展开后重新收拢，不会丢配置。
export function toModel(wf) {
  const nodes = (wf.nodes || []).map((n) => {
    const { config: existing = {}, ...rest } = n || {}
    const out = { id: rest.id, type: rest.type }
    const cfg = { ...existing }
    for (const [k, v] of Object.entries(rest)) {
      if (k === 'id' || k === 'type') continue
      if (NODE_META_KEYS.has(k)) out[k] = v
      else cfg[k] = v
    }
    if (Object.keys(cfg).length) out.config = cfg
    return out
  })
  const model = {}
  for (const k of TOP_KEYS) if (wf[k] !== undefined) model[k] = wf[k]
  model.nodes = nodes
  model.edges = wf.edges || []
  return model
}

// —— 极简 YAML 输出（只覆盖 DSL 结构；稳定键序，便于版本 diff）——
const needsQuote = (s) => /^$|^[\s>|*&!%@`{}\[\],#?:-]|[:#]\s|\n|^\d+(\.\d+)?$|^(true|false|null|~)$/.test(String(s))
function scalar(v) {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  const s = String(v)
  return needsQuote(s) ? JSON.stringify(s) : s
}
const inlineObj = (o) => `{${Object.entries(o).map(([k, v]) => `${k}: ${typeof v === 'object' && v !== null ? JSON.stringify(v) : scalar(v)}`).join(', ')}}`
function blockLines(value, indent) {
  const pad = ' '.repeat(indent)
  if (Array.isArray(value)) {
    return value.flatMap((it) => {
      if (it && typeof it === 'object') {
        const ent = Object.entries(it)
        const [k0, v0] = ent[0]
        const first = `${pad}- ${k0}: ${v0 && typeof v0 === 'object' ? inlineObj(v0) : scalar(v0)}`
        const rest = ent.slice(1).map(([k, v]) => `${pad}  ${k}: ${v && typeof v === 'object' ? inlineObj(v) : scalar(v)}`)
        return [first, ...rest]
      }
      return [`${pad}- ${scalar(it)}`]
    })
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([k, v]) => {
      if (v && typeof v === 'object') {
        const inner = v
        if (Array.isArray(inner) && inner.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
          return [`${pad}${k}:`, ...blockLines(inner, indent + 2)].join('\n')
        }
        if (Array.isArray(inner)) return `${pad}${k}: [${inner.map(scalar).join(', ')}]`
        return `${pad}${k}: ${inlineObj(inner)}`
      }
      return `${pad}${k}: ${scalar(v)}`
    })
  }
  return [`${pad}${scalar(value)}`]
}

export function serializeWorkflow(input) {
  // toModel 幂等（见上），因此统一过一遍即可，无需判断输入形态——
  // 早期版本用启发式判断"是否已是模型"，会静默丢掉已有 config。
  const model = toModel(input || {})
  const out = []
  for (const k of ['name', 'description', 'version']) if (model[k] !== undefined) out.push(`${k}: ${scalar(model[k])}`)
  if (model.triggers) out.push(`triggers: [${model.triggers.map(scalar).join(', ')}]`)
  out.push('trigger_config: ' + inlineObj(model.trigger_config || { manual: true }))
  if (model.settings) out.push('settings: ' + inlineObj(model.settings))
  if (model.inputs?.length) out.push('inputs:', ...blockLines(model.inputs, 2))
  out.push('nodes:', ...blockLines(model.nodes, 2))
  out.push('edges:', ...blockLines(model.edges || [], 2).map((l, i) => (/^- /.test(l.trim()) ? l.replace(/^(\s*)- /, '$1- ') : l)))
  if (model.expose) out.push('expose: ' + inlineObj(model.expose))
  if (model.permissions) out.push('permissions: ' + inlineObj(model.permissions))
  return out.join('\n') + '\n'
}
```

- [ ] **Step 4: 运行序列化测试**

Run: `node --test kernel-tests/workflow-serialize.test.mjs`
Expected: PASS（3 个 test 全绿）；若往返断言失败，优先修 `blockLines` 的对象数组分支而非放宽断言。

- [ ] **Step 5: 实现 grant 授权**

在 `kernel/workflow-nodes.mjs` 的 `checkToolPermission` **之前**插入：

```js
// 运行级授权（一次放行）：ctx.grant = { tools: string[], write_dirs: string[], network: boolean }。
// 命中授权 → 放行（免除交互，但审计照写）；未命中 → 拒绝并返回原因（fail-closed，不挂起）。
const WRITE_TOOLS = new Set(['Write', 'Edit'])
function grantDecision(grant, name, input) {
  if (!grant) return null
  const tools = Array.isArray(grant.tools) ? grant.tools : []
  if (!tools.includes(name)) return { denied: true, message: `工具 ${name} 不在本次运行的授权清单内（拒绝执行）` }
  if (WRITE_TOOLS.has(name)) {
    const dirs = Array.isArray(grant.write_dirs) ? grant.write_dirs.map((d) => String(d).replace(/\\/g, '/').replace(/\/$/, '')) : []
    const p = String(input?.file_path || '').replace(/\\/g, '/')
    if (p && dirs.length && !dirs.some((d) => p.startsWith(d + '/'))) {
      return { denied: true, message: `写入路径不在授权目录内：${input.file_path}（授权目录：${dirs.join('、')}）` }
    }
  }
  return { denied: false }
}
```

并把 `checkToolPermission` 改为：

```js
async function checkToolPermission(ctx, name, input) {
  const g = grantDecision(ctx?.grant, name, input)
  if (g) return g                                   // 有 grant：授权清单为唯一判据
  const gate = ctx?.permissionGate
  if (typeof gate !== 'function') {
    if (name === 'Bash') return { denied: true, message: '当前工作流无审批通道：Bash 工具默认拒绝执行（请在交互会话中运行该工作流，由引擎审批门放行）' }
    return { denied: false }
  }
  // …以下保持原实现不变（gate 调用 / 异常归一化）…
}
```

- [ ] **Step 6: 运行 grant 测试**

Run: `node --test kernel-tests/workflow-grant.test.mjs`
Expected: PASS（2 个 test 全绿）

- [ ] **Step 7: 补 `discoverWorkflows` 的 expose 字段（若内核计划未含）**

在 `discoverWorkflows` 的条目对象中确认存在：

```js
      expose: parsed.expose || {},
      permissions: parsed.permissions || {},
```

Run: `node --test kernel-tests/`
Expected: 全绿（含内核计划既有测试）

- [ ] **Step 8: Commit**

```bash
git add kernel/workflow-dsl.mjs kernel/workflow-nodes.mjs kernel-tests/workflow-serialize.test.mjs kernel-tests/workflow-grant.test.mjs
git commit -m "feat(workflow): DSL 序列化/模型双向 + 运行级 grant 授权（fail-closed）"
```

---

### Task 10: 工作流存储层

**Files:**
- Create: `server/workflow-store.mjs`
- Test: `server/workflow-store.test.mjs`

**Interfaces:**
- Consumes: 无（纯 fs，禁止 import kernel）
- Produces:
  - `wfRootOf(home)`、`listWorkflowMetas({ root, runsRoot })`、`readWorkflowYml({ root, id })`
  - `writeWorkflowYml({ root, id, yml }) → { ok, backup }`（写前把上一版快照进 `versions/`，保留最近 20）
  - `createWorkflow({ root, id, yml })`、`deleteWorkflow({ root, id })`、`duplicateWorkflow({ root, fromId, toId })`
  - `listVersions({ root, id })`、`rollbackVersion({ root, id, ts })`
  - `exportBundle({ root, id }) → { bundle, filename }`、`importBundle({ root, bundle }) → { ok, id, warnings }`
  - `readBindings({ root })`、`writeBindings({ root, bindings })`
  - `parseWorkflowMeta(yml) → { name, description, version, triggers, expose, nodeCount, edgeCount, legacy, hasEnd, settings }`（轻量正则，**仅供列表展示**；权威校验由宿主完成）
  - `recentRuns({ runsRoot, id, limit })`

- [ ] **Step 1: 写失败测试**

创建 `server/workflow-store.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseWorkflowMeta, listWorkflowMetas, writeWorkflowYml, listVersions, rollbackVersion,
  createWorkflow, deleteWorkflow, duplicateWorkflow, exportBundle, importBundle, readBindings, writeBindings,
} from './workflow-store.mjs'

const YML = `name: 周报生成
description: 拉数并生成周报
version: 1.0.0
triggers: [周报, weekly]
trigger_config: { manual: true, webhook: false }
nodes:
  - { id: start, type: start }
  - { id: t, type: template, template: hi }
  - { id: e, type: end }
edges:
  - { id: e1, source: start, target: t }
  - { id: e2, source: t, target: e }
expose: { mode: public, tool_name: run_weekly }
`

function mk() {
  const home = mkdtempSync(join(tmpdir(), 'wf-store-'))
  const root = join(home, 'workflows')
  mkdirSync(root, { recursive: true })
  return { home, root, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

test('parseWorkflowMeta：列表所需的元数据齐全', () => {
  const m = parseWorkflowMeta(YML)
  assert.equal(m.name, '周报生成')
  assert.equal(m.version, '1.0.0')
  assert.deepEqual(m.triggers, ['周报', 'weekly'])
  assert.equal(m.nodeCount, 3)
  assert.equal(m.edgeCount, 2)
  assert.equal(m.legacy, false)
  assert.equal(m.expose.mode, 'public')
})

test('legacy 识别：无 edges 的旧格式被标记', () => {
  const m = parseWorkflowMeta('name: old\nnodes:\n  - { id: s, type: start, next: null }\n')
  assert.equal(m.legacy, true)
})

test('写入即快照版本；rollback 恢复上一版', () => {
  const { root, cleanup } = mk()
  try {
    createWorkflow({ root, id: 'demo', yml: YML })
    const v2 = YML.replace('version: 1.0.0', 'version: 2.0.0')
    writeWorkflowYml({ root, id: 'demo', yml: v2 })
    const vers = listVersions({ root, id: 'demo' })
    assert.ok(vers.length >= 1, `应有版本快照：${JSON.stringify(vers)}`)
    const r = rollbackVersion({ root, id: 'demo', ts: vers[0].ts })
    assert.equal(r.ok, true)
    assert.match(readFileSync(join(root, 'demo', 'workflow.yml'), 'utf-8'), /version: 1\.0\.0/)
  } finally { cleanup() }
})

test('list 元数据含 id 与最近运行（runsRoot 空时 lastRun 为 null）', () => {
  const { home, root, cleanup } = mk()
  try {
    createWorkflow({ root, id: 'demo', yml: YML })
    const list = listWorkflowMetas({ root, runsRoot: join(home, 'workflow-runs') })
    assert.equal(list.length, 1)
    assert.equal(list[0].id, 'demo')
    assert.equal(list[0].name, '周报生成')
    assert.equal(list[0].lastRun, null)
    assert.equal(list[0].valid, true)
  } finally { cleanup() }
})

test('duplicate / delete / 版本保留上限 20', () => {
  const { root, cleanup } = mk()
  try {
    createWorkflow({ root, id: 'a', yml: YML })
    duplicateWorkflow({ root, fromId: 'a', toId: 'b' })
    assert.ok(existsSync(join(root, 'b', 'workflow.yml')))
    for (let i = 2; i <= 25; i++) writeWorkflowYml({ root, id: 'a', yml: YML.replace('1.0.0', `1.0.${i}`) })
    assert.ok(readdirSync(join(root, 'a', 'versions')).length <= 20, '版本快照应保留最近 20')
    deleteWorkflow({ root, id: 'b' })
    assert.equal(existsSync(join(root, 'b')), false)
  } finally { cleanup() }
})

test('导出/导入往返；导入 schemaVersion 不符时拒绝', () => {
  const { root, cleanup } = mk()
  try {
    createWorkflow({ root, id: 'demo', yml: YML })
    const { bundle, filename } = exportBundle({ root, id: 'demo' })
    assert.match(filename, /\.yfwflow$/)
    assert.equal(bundle.format, 'yfworking-workflow')
    const r = importBundle({ root, bundle: { ...bundle, workflow: bundle.workflow.replace('demo', 'demo2') }, id: 'demo2' })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.ok(existsSync(join(root, 'demo2', 'workflow.yml')))
    const bad = importBundle({ root, bundle: { ...bundle, schemaVersion: 99 }, id: 'demo3' })
    assert.equal(bad.ok, false)
    assert.match(bad.error, /schemaVersion/)
  } finally { cleanup() }
})

test('id 校验：非法字符/路径穿越/保留字被拒', () => {
  const { root, cleanup } = mk()
  try {
    assert.throws(() => createWorkflow({ root, id: '../evil', yml: YML }), /非法工作流 id/)
    assert.throws(() => createWorkflow({ root, id: 'run', yml: YML }), /保留字/)
    assert.throws(() => createWorkflow({ root, id: 'verify', yml: YML }), /保留字/)
  } finally { cleanup() }
})

test('绑定与信任态读写', () => {
  const { root, cleanup } = mk()
  try {
    assert.deepEqual(readBindings({ root }), { agents: {}, trusted: [] })
    writeBindings({ root, bindings: { agents: { 'material-writer': ['demo'] }, trusted: ['demo'] } })
    assert.deepEqual(readBindings({ root }).agents['material-writer'], ['demo'])
  } finally { cleanup() }
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test server/workflow-store.test.mjs`
Expected: FAIL — `Cannot find module './workflow-store.mjs'`

- [ ] **Step 3: 实现 `server/workflow-store.mjs`**

```js
// server/workflow-store.mjs —— 工作流磁盘权威存储（CRUD / 版本 / 导入导出 / 绑定）
// 约束：本模块不得 import kernel/*（生产包只带 kernel-dist/cli.mjs 单文件 bundle）。
// 因此只做轻量正则元数据解析（列表展示用）；权威解析/校验/序列化一律经宿主会话。
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, copyFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const SCHEMA_VERSION = 2
export const BUNDLE_FORMAT = 'yfworking-workflow'
const VERSION_KEEP = 20

export const wfRootOf = (home) => join(home, 'workflows')
export const runsRootOf = (home) => join(home, 'workflow-runs')
const wfDir = (root, id) => join(root, id)
const wfFile = (root, id) => join(wfDir(root, id), 'workflow.yml')
const versionsDir = (root, id) => join(wfDir(root, id), 'versions')

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
// 保留字：这些 id 与 /workflows/<sub> 的动作子路由冲突（如 /workflows/run、/workflows/verify），
// 必须禁止创建工作流时使用，否则该工作流永远打不开。
export const RESERVED_IDS = new Set(['run', 'stop', 'confirm', 'runs', 'import', 'export', 'bindings', 'verify', 'validate'])
export function assertSafeId(id) {
  const s = String(id || '')
  if (!SAFE_ID.test(s) || s.includes('..')) throw new Error(`非法工作流 id: ${id}`)
  if (RESERVED_IDS.has(s)) throw new Error(`工作流 id 不能使用保留字: ${id}（保留：${[...RESERVED_IDS].join('、')}）`)
  return s
}

function grab(yml, key) {
  const m = String(yml).match(new RegExp('^' + key + ':\\s*["\']?(.+?)["\']?\\s*$', 'm'))
  return m ? m[1].trim() : ''
}

// 轻量元数据（仅列表展示；valid 由宿主 validate 覆盖，缺省 true）
export function parseWorkflowMeta(yml) {
  const text = String(yml || '')
  const inlineList = (key) => {
    const m = text.match(new RegExp('^' + key + ':\\s*\\[(.*?)\\]\\s*$', 'm'))
    if (!m) return []
    return m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
  }
  const nlList = (key) => {
    const m = text.match(new RegExp('^' + key + ':\\s*\\n((?:\\s*-\\s*.+\\n?)+)', 'm'))
    return m ? m[1].split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean) : []
  }
  const exposeMode = (text.match(/^expose:\s*\{\s*mode:\s*([a-z]+)/m) || text.match(/^expose:\s*\n(?:.*\n)*?\s+mode:\s*([a-z]+)/m) || [])[1]
  const toolName = (text.match(/tool_name:\s*(\S+)/) || [])[1] || ''
  return {
    name: grab(text, 'name'),
    description: grab(text, 'description'),
    version: grab(text, 'version'),
    triggers: inlineList('triggers').length ? inlineList('triggers') : nlList('triggers'),
    expose: { mode: exposeMode || 'private', ...(toolName ? { tool_name: toolName.replace(/["',}]/g, '') } : {}) },
    nodeCount: (text.match(/^\s*-\s*(?:\{)?\s*id:/gm) || []).length,
    edgeCount: (() => {
      const seg = text.split(/^edges:\s*$/m)[1] || ''
      return (seg.match(/^\s*-\s*(?:\{)?\s*id:/gm) || []).length
    })(),
    legacy: !/^edges:\s*$/m.test(text),
    hasEnd: /type:\s*(end|answer)/.test(text),
    settings: { max_parallel: Number((text.match(/max_parallel:\s*(\d+)/) || [])[1] || 4) },
  }
}

export function listWorkflowMetas({ root, runsRoot = '' } = {}) {
  if (!root || !existsSync(root)) return []
  const out = []
  for (const it of readdirSync(root, { withFileTypes: true })) {
    if (!it.isDirectory() || it.name.startsWith('_') || it.name.startsWith('.')) continue
    const f = wfFile(root, it.name)
    if (!existsSync(f)) continue
    let yml = ''
    try { yml = readFileSync(f, 'utf-8') } catch { continue }
    const meta = parseWorkflowMeta(yml)
    let updatedAt = 0
    try { updatedAt = statSync(f).mtimeMs } catch {}
    out.push({ id: it.name, ...meta, valid: true, updatedAt, lastRun: lastRunOf(runsRoot, meta.name || it.name) })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

function lastRunOf(runsRoot, name) {
  if (!runsRoot) return null
  const dir = join(runsRoot, name)
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()
    if (!files.length) return null
    const lines = readFileSync(join(dir, files[files.length - 1]), 'utf-8').trim().split('\n')
    const last = JSON.parse(lines[lines.length - 1])
    return { at: files[files.length - 1], status: last.status || 'unknown', nodes: lines.length }
  } catch { return null }
}

export function readWorkflowYml({ root, id }) {
  assertSafeId(id)
  const f = wfFile(root, id)
  if (!existsSync(f)) return null
  return readFileSync(f, 'utf-8')
}

export function writeWorkflowYml({ root, id, yml }) {
  assertSafeId(id)
  mkdirSync(wfDir(root, id), { recursive: true })
  const f = wfFile(root, id)
  let backup = ''
  if (existsSync(f)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    mkdirSync(versionsDir(root, id), { recursive: true })
    backup = join(versionsDir(root, id), `${ts}.yml`)
    try { copyFileSync(f, backup) } catch { backup = '' }
    const all = readdirSync(versionsDir(root, id)).filter((x) => x.endsWith('.yml')).sort()
    for (const old of all.slice(0, Math.max(0, all.length - VERSION_KEEP))) {
      try { rmSync(join(versionsDir(root, id), old), { force: true }) } catch {}
    }
  }
  writeFileSync(f, String(yml), 'utf-8')
  return { ok: true, id, backup }
}

export function createWorkflow({ root, id, yml }) {
  assertSafeId(id)
  if (existsSync(wfFile(root, id))) return { ok: false, error: `工作流已存在: ${id}` }
  return writeWorkflowYml({ root, id, yml })
}

export function deleteWorkflow({ root, id }) {
  assertSafeId(id)
  const dir = wfDir(root, id)
  if (!existsSync(dir)) return { ok: false, error: `工作流不存在: ${id}` }
  rmSync(dir, { recursive: true, force: true })
  return { ok: true, id }
}

export function duplicateWorkflow({ root, fromId, toId }) {
  const yml = readWorkflowYml({ root, id: fromId })
  if (!yml) return { ok: false, error: `源工作流不存在: ${fromId}` }
  return createWorkflow({ root, id: toId, yml })
}

export function listVersions({ root, id }) {
  const dir = versionsDir(root, id)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.yml')).sort().reverse().map((f) => ({ ts: f.replace(/\.yml$/, ''), path: join(dir, f) }))
}

export function rollbackVersion({ root, id, ts }) {
  const p = join(versionsDir(root, id), `${ts}.yml`)
  if (!existsSync(p)) return { ok: false, error: `版本不存在: ${ts}` }
  const yml = readFileSync(p, 'utf-8')
  return writeWorkflowYml({ root, id, yml })
}

export function exportBundle({ root, id }) {
  const yml = readWorkflowYml({ root, id })
  if (!yml) return { ok: false, error: `工作流不存在: ${id}` }
  const meta = parseWorkflowMeta(yml)
  const bundle = {
    format: BUNDLE_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    workflow: yml,
    manifest: { kernelMinVersion: '0.2', requiredTools: [], nodeTypes: [...new Set((yml.match(/type:\s*([a-z_]+)/g) || []).map((s) => s.split(':')[1].trim()))] },
  }
  return { bundle, filename: `${id}.yfwflow` }
}

export function importBundle({ root, bundle, id }) {
  const b = bundle || {}
  if (b.format !== BUNDLE_FORMAT) return { ok: false, error: `格式不符（期望 ${BUNDLE_FORMAT}）` }
  if (Number(b.schemaVersion) > SCHEMA_VERSION) return { ok: false, error: `schemaVersion ${b.schemaVersion} 高于本机支持的 ${SCHEMA_VERSION}，请升级应用` }
  if (typeof b.workflow !== 'string' || !b.workflow.trim()) return { ok: false, error: '包内缺少 workflow 定义' }
  const warnings = []
  const meta = parseWorkflowMeta(b.workflow)
  if (meta.legacy) warnings.push('该工作流为旧 DSL 格式（无 edges），导入后需先迁移')
  const targetId = assertSafeId(id || meta.name || `imported-${Date.now()}`)
  if (existsSync(wfFile(root, targetId))) warnings.push(`已存在同名工作流 ${targetId}，本次为覆盖（旧版已快照）`)
  const r = writeWorkflowYml({ root, id: targetId, yml: b.workflow })
  return { ...r, id: targetId, warnings, meta }
}

const bindingsFile = (root) => join(root, '_bindings.json')

export function readBindings({ root }) {
  try { return JSON.parse(readFileSync(bindingsFile(root), 'utf-8')) } catch { return { agents: {}, trusted: [] } }
}

export function writeBindings({ root, bindings }) {
  mkdirSync(root, { recursive: true })
  const next = { agents: bindings?.agents || {}, trusted: bindings?.trusted || [] }
  writeFileSync(bindingsFile(root), JSON.stringify(next, null, 2), 'utf-8')
  return { ok: true }
}

export function recentRuns({ runsRoot, id, name = '', limit = 20 }) {
  const dir = join(runsRoot, name || id)
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().reverse().slice(0, limit)
      .map((f) => {
        const p = join(dir, f)
        const lines = readFileSync(p, 'utf-8').trim().split('\n')
        let last = {}
        try { last = JSON.parse(lines[lines.length - 1]) } catch {}
        return { file: f, path: p, ts: f.split('-').slice(0, 3).join('-'), steps: lines.length, status: last.status || 'unknown' }
      })
  } catch { return [] }
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `node --test server/workflow-store.test.mjs`
Expected: PASS（7 个 test 全绿）

- [ ] **Step 5: Commit**

```bash
git add server/workflow-store.mjs server/workflow-store.test.mjs
git commit -m "feat(workflow): 存储层（CRUD/版本快照/导入导出/绑定，纯 fs 无内核依赖）"
```

---

### Task 11: 常驻宿主会话

**Files:**
- Create: `server/workflow-host.mjs`
- Modify: `kernel/cli.mjs`（`workflow_command` 增 `load/save/save-raw/validate/stop`，run 支持 grant）
- Test: `server/workflow-host.test.mjs`

**Interfaces:**
- Consumes: Task 10 的存储层；`kernel/cli.mjs` 的 `handleWorkflowCommand`（内核计划 Task 6 已扩展 stop/validate）
- Produces:
  - `createWorkflowHost({ sessions, getOrCreateSession, writeToKernel, yfwHome, model, onEvent }) → host`
  - `host.ensure() → sessionId('_wfhost')`、`host.send(cmd) → Promise<result>`（按 requestId 配对 `workflow_result`）
  - `host.load(id)`、`host.save({ id, model|yaml })`、`host.validate(id)`、`host.run({ id, inputs, grant, runId })`、`host.stop(runId)`、`host.confirm({ runId, node, action, comment })`
  - `host.issueGrant(runId, capabilities) → token`、`host.revokeGrant(runId)`、`host.isGranted(runId, tool)`
  - `deriveCapabilities({ model, yml }) → { tools: string[], write_dirs: string[], network: boolean }`（**前端口径的服务端镜像**，两侧算法见 Task 13；本模块接收前端传入的清单并做保守合并）

- [ ] **Step 1: 写失败测试**

创建 `server/workflow-host.test.mjs`（用假的 kernel 会话替身，不 spawn 真进程）：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWorkflowHost, mergeCapabilities } from './workflow-host.mjs'

function fakeKernel() {
  const written = []
  let handler = () => {}
  const session = { proc: { stdin: { write: (line) => { written.push(JSON.parse(line)); handler(JSON.parse(line)) } }, killed: false } }
  const sessions = new Map([['_wfhost', session]])
  return {
    written,
    sessions,
    reply: (obj) => handler(obj),
    setReply: (fn) => { handler = fn },
    getOrCreateSession: () => session,
  }
}

test('ensure：懒启动宿主会话并复用', () => {
  const k = fakeKernel()
  const host = createWorkflowHost({ sessions: k.sessions, getOrCreateSession: k.getOrCreateSession, yfwHome: '/tmp/x', model: 'm', onEvent: () => {} })
  const sid1 = host.ensure()
  const sid2 = host.ensure()
  assert.equal(sid1, '_wfhost')
  assert.equal(sid2, '_wfhost')
})

test('send：按 requestId 配对 workflow_result 回执（含超时）', async () => {
  const k = fakeKernel()
  k.setReply((msg) => {
    if (msg.type === 'workflow_command') {
      k.reply({ type: 'system', subtype: 'workflow_result', requestId: msg.requestId, result: { ok: true, subtype: msg.subtype } })
    }
  })
  const host = createWorkflowHost({ sessions: k.sessions, getOrCreateSession: k.getOrCreateSession, yfwHome: '/tmp/x', model: 'm', onEvent: () => {} })
  host.ensure()
  const r = await host.send({ subtype: 'list' })
  assert.equal(r.ok, true)
  assert.equal(r.subtype, 'list')
  await assert.rejects(() => host.send({ subtype: 'never' }, { timeoutMs: 50 }), /超时/)
})

test('run：grant 注入 + 能力清单保守合并（取并集，不放大）', async () => {
  const k = fakeKernel()
  k.setReply((msg) => {
    if (msg.type === 'workflow_command' && msg.subtype === 'run') {
      k.reply({ type: 'system', subtype: 'workflow_result', requestId: msg.requestId, result: { ok: true, status: 'completed', steps: 3, runId: msg.payload.runId } })
    }
  })
  const host = createWorkflowHost({ sessions: k.sessions, getOrCreateSession: k.getOrCreateSession, yfwHome: '/tmp/x', model: 'm', onEvent: () => {} })
  host.ensure()
  const r = await host.run({ id: 'demo', inputs: { q: 1 }, capabilities: { tools: ['Read'], write_dirs: [], network: false } })
  assert.equal(r.ok, true)
  const sent = k.written.find((m) => m.subtype === 'run')
  assert.ok(sent.payload.grant, 'grant 应随命令注入')
  assert.deepEqual(sent.payload.grant.tools, ['Read'])

  const m = mergeCapabilities({ tools: ['Read', 'WebFetch'], write_dirs: ['/a'], network: true }, { tools: ['Read', 'Write'], write_dirs: ['/a', '/b'], network: false })
  assert.deepEqual([...m.tools].sort(), ['Read', 'WebFetch', 'Write'], '应为并集（前端勾选项 ∪ 声明项）')
  assert.equal(m.network, true)
})

test('stop / confirm 转发到内核命令', async () => {
  const k = fakeKernel()
  k.setReply((msg) => {
    if (msg.type === 'workflow_command') k.reply({ type: 'system', subtype: 'workflow_result', requestId: msg.requestId, result: { ok: true } })
  })
  const host = createWorkflowHost({ sessions: k.sessions, getOrCreateSession: k.getOrCreateSession, yfwHome: '/tmp/x', model: 'm', onEvent: () => {} })
  host.ensure()
  await host.stop('run-1')
  await host.confirm({ runId: 'run-1', node: 'gate', action: 'approved' })
  assert.ok(k.written.some((m) => m.type === 'workflow_command' && m.subtype === 'stop' && m.payload.runId === 'run-1'))
  assert.ok(k.written.some((m) => m.type === 'workflow_confirm' && m.payload.node === 'gate'))
})

test('grant 生命周期：运行结束即失效', async () => {
  const k = fakeKernel()
  k.setReply((msg) => {
    if (msg.type === 'workflow_command') k.reply({ type: 'system', subtype: 'workflow_result', requestId: msg.requestId, result: { ok: true, status: 'completed' } })
  })
  const host = createWorkflowHost({ sessions: k.sessions, getOrCreateSession: k.getOrCreateSession, yfwHome: '/tmp/x', model: 'm', onEvent: () => {} })
  host.ensure()
  await host.run({ id: 'demo', inputs: {}, capabilities: { tools: ['Bash'] } })
  const runId = [...host._grants.keys()][0]
  assert.equal(runId, undefined, '运行结束应回收全部 grant')
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test server/workflow-host.test.mjs`
Expected: FAIL — `Cannot find module './workflow-host.mjs'`

- [ ] **Step 3: 实现 `server/workflow-host.mjs`**

```js
// server/workflow-host.mjs —— 常驻工作流宿主（专用内核会话 _wfhost）
// 职责：懒启动宿主会话；把 GUI 请求转为内核 stdin 的 workflow_command/workflow_confirm；
// 按 requestId 配对回执；发放/回收运行级 grantToken；把内核 workflow 事件转给 GUI 广播。
// 说明：宿主 = 普通内核会话（mode=task，cwd=<YFW_HOME>/workflow-runtime，工具全开），
// 真正的闸门是运行前授权清单（grant）——未授权调用在节点执行器内 fail-closed。
import { join } from 'node:path'

export const HOST_SID = '_wfhost'
const DEFAULT_TIMEOUT = 120_000

export function mergeCapabilities(declared = {}, requested = {}) {
  const tools = [...new Set([...(declared.tools || []), ...(requested.tools || [])])]
  const write_dirs = [...new Set([...(declared.write_dirs || []), ...(requested.write_dirs || [])])]
  return { tools, write_dirs, network: declared.network === true || requested.network === true }
}

export function createWorkflowHost({ sessions, getOrCreateSession, yfwHome, model = '', onEvent = () => {} }) {
  const pending = new Map()   // requestId → { resolve, reject, timer }
  const _grants = new Map()   // runId → capabilities

  function ensure() {
    if (!sessions.has(HOST_SID)) {
      getOrCreateSession(HOST_SID, join(yfwHome, 'workflow-runtime'), null, '', model, 0, 'task')
    }
    return HOST_SID
  }

  function send(cmd, { timeoutMs = DEFAULT_TIMEOUT } = {}) {
    const requestId = `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`宿主命令超时（${cmd.subtype}）`)) }, timeoutMs)
      pending.set(requestId, { resolve, reject, timer })
      try {
        ensure()
        sessions.get(HOST_SID).proc.stdin.write(JSON.stringify({ type: 'workflow_command', requestId, ...cmd }) + '\n')
      } catch (e) {
        clearTimeout(timer); pending.delete(requestId); reject(e)
      }
    })
  }

  // 内核回执入口：cli 的 handleWorkflowCommand 把结果写成
  // { type:'system', subtype:'workflow_result', requestId, result }
  function onKernelMessage(msg) {
    if (msg?.type !== 'system' || msg.subtype !== 'workflow_result') return false
    const p = msg.requestId && pending.get(msg.requestId)
    if (!p) return false
    clearTimeout(p.timer); pending.delete(msg.requestId)
    p.resolve(msg.result ?? { ok: false, error: '空回执' })
    return true
  }

  function issueGrant(runId, capabilities) {
    _grants.set(runId, capabilities)
    return `grant-${runId}`
  }
  function revokeGrant(runId) { _grants.delete(runId) }
  function isGranted(runId, tool) {
    const g = _grants.get(runId)
    return !!g && Array.isArray(g.tools) && g.tools.includes(tool)
  }

  async function run({ id, inputs = {}, capabilities = {}, runId = '' }) {
    const rid = runId || `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const grant = mergeCapabilities({}, capabilities)
    issueGrant(rid, grant)
    try {
      const r = await send({ subtype: 'run', payload: { workflow: id, inputs, runId: rid, grant } }, { timeoutMs: 30 * 60_000 })
      return { ...r, runId: rid }
    } finally {
      revokeGrant(rid)     // 一次运行有效：结束即失效
    }
  }

  return {
    ensure,
    send,
    onKernelMessage,
    onEvent,
    load: (id) => send({ subtype: 'load', payload: { id } }),
    validate: (id) => send({ subtype: 'validate', payload: { id } }),
    save: ({ id, model, yaml }) => send({ subtype: model ? 'save' : 'save-raw', payload: { id, model, yaml } }),
    run,
    stop: (runId) => send({ subtype: 'stop', payload: { runId } }, { timeoutMs: 15_000 }),
    confirm: ({ runId, node, action = 'approved', comment = '' }) => {
      ensure()
      sessions.get(HOST_SID).proc.stdin.write(JSON.stringify({ type: 'workflow_confirm', payload: { runId, node, action, comment } }) + '\n')
      return { ok: true }
    },
    issueGrant, revokeGrant, isGranted,
    _grants,
  }
}
```

- [ ] **Step 4: 内核侧补 `load` / `save` / `save-raw`**

`kernel/cli.mjs` 的 `handleWorkflowCommand` 增：

```js
      } else if (subtype === 'load') {
        const id = msg?.payload?.id || ''
        const wf = wfEngine.load(id)
        if (!wf) wire.system('workflow_result', { subtype: 'load', requestId: msg?.requestId, result: { ok: false, error: `工作流不存在: ${id}` } })
        else wire.system('workflow_result', { subtype: 'load', requestId: msg?.requestId, result: { ok: true, id, model: toModel(wf), yml: readFileSync(wf.path, 'utf-8'), validation: validateWorkflow(wf) } })
      } else if (subtype === 'save' || subtype === 'save-raw') {
        const id = msg?.payload?.id || ''
        const yml = subtype === 'save' ? serializeWorkflow(msg?.payload?.model || {}) : String(msg?.payload?.yaml || '')
        const wf = normalizeWorkflow(parseYaml(yml))
        const v = validateWorkflow(wf)
        // 内核只做「序列化 + 校验 + 回传 yml」；落盘由 bridge 侧 store 完成
        //（单一写者，避免内核与 bridge 双写用户工作流目录）。
        wire.system('workflow_result', {
          subtype, requestId: msg?.requestId,
          result: v.ok ? { ok: true, id, yml, validation: v } : { ok: false, error: '校验失败', errors: v.errors },
        })
      }
```

写入落盘由 bridge 侧完成（内核只序列化+校验并回传 yml，`warnings` 一并返回）——**内核不碰用户工作流目录**，避免双写者。`run` 分支增 `payload.runId` 与 `payload.grant` 透传：

```js
        const r = await wfEngine.run({ id: msg?.payload?.workflow || '', inputs: msg?.payload?.inputs || {}, runId: msg?.payload?.runId, grant: msg?.payload?.grant })
```

`wfEngine.run` 需把 `grant` 放进节点 ctx（引擎 Task 5 的 `ctx` 增 `grant: grant`）。

- [ ] **Step 5: 运行测试，确认通过**

Run: `node --test server/workflow-host.test.mjs`
Expected: PASS（5 个 test 全绿）

- [ ] **Step 6: Commit**

```bash
git add server/workflow-host.mjs kernel/cli.mjs server/workflow-host.test.mjs
git commit -m "feat(workflow): 常驻宿主会话（懒启动/回执配对/grant 生命周期/load-save 内核命令）"
```

---

### Task 12: bridge HTTP 路由与事件转发

**Files:**
- Create: `server/workflow-routes.mjs`（`handleWorkflowRoute` 独立模块——**不得写在 bridge.mjs 里**：bridge.mjs 顶层会 `httpServer.listen(51517)`，测试 import 它会真的起桥并可能 taskkill 用户正在运行的应用）
- Modify: `server/bridge.mjs`（挂载路由：`if (await handleWorkflowRoute({...})) return`；`workflow` 事件 → `workflow_event` 广播；`workflow_result` 回执喂给 host）
- Modify: `docs/bridge-contract.md`（新增工作流模块章节）
- Test: `server/workflow-api.test.mjs`

**Interfaces:**
- Consumes: Task 10 存储层、Task 11 宿主
- Produces: `handleWorkflowRoute({ url, req, reply, readJsonBody, store, host, root, runsRoot }) → Promise<boolean>`（`host` 为**必需参数**，由 bridge 注入；返回是否已处理）

- [ ] **Step 1: 写失败测试**

创建 `server/workflow-api.test.mjs`（直接测路由函数，不起服务）：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// 注意：必须从 workflow-routes.mjs 导入，不能 import bridge.mjs
//（bridge.mjs 顶层 listen(51517)，测试里会真起桥并可能 taskkill 用户运行中的应用）。
import { handleWorkflowRoute } from './workflow-routes.mjs'
import * as store from './workflow-store.mjs'

function mkReply() {
  const out = {}
  return { out, reply: (code, headers, body) => { out.code = code; out.body = JSON.parse(body) } }
}
const reqOf = (method, url, body) => ({ method, url, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) } })

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'wf-api-'))
  const root = join(home, 'workflows')
  mkdirSync(root, { recursive: true })
  const host = {
    load: async (id) => ({ ok: true, id, model: { name: id, nodes: [], edges: [] }, yml: 'name: x\nnodes: []\nedges: []\n' }),
    validate: async (id) => ({ ok: true, errors: [], warnings: [] }),
    save: async ({ id, model, yaml }) => ({ ok: true, id, yml: yaml || `name: ${id}\nnodes: []\nedges: []\n` }),
    run: async ({ id, inputs }) => ({ ok: true, id, status: 'completed', steps: 2, runId: 'r1', inputs }),
    stop: async () => ({ ok: true }),
    confirm: () => ({ ok: true }),
  }
  return { home, root, host, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

test('GET /workflows：列表（含 legacy 标记）', async () => {
  const { root, host, cleanup } = setup()
  try {
    store.createWorkflow({ root, id: 'demo', yml: 'name: demo\nversion: 1.0.0\nnodes:\n  - { id: s, type: start }\nedges:\n  - { id: e1, source: s, target: s }\n' })
    const { out, reply } = mkReply()
    const handled = await handleWorkflowRoute({ url: new URL('http://x/workflows'), req: reqOf('GET', '/workflows'), reply, readJsonBody: async () => ({}), store, host, runsRoot: join(root, '..', 'workflow-runs') })
    assert.equal(handled, true)
    assert.equal(out.body.workflows.length, 1)
    assert.equal(out.body.workflows[0].id, 'demo')
  } finally { cleanup() }
})

test('PUT /workflows/:id：存盘并回传内核校验错误', async () => {
  const { root, host, cleanup } = setup()
  try {
    const { out, reply } = mkReply()
    await handleWorkflowRoute({ url: new URL('http://x/workflows/demo'), req: reqOf('PUT', '/workflows/demo', { model: { name: 'demo' } }), reply, readJsonBody: async () => ({ model: { name: 'demo' } }), store, host })
    assert.equal(out.body.ok, true)
    assert.ok(existsSync(join(root, 'demo', 'workflow.yml')))

    const bad = mkReply()
    await handleWorkflowRoute({
      url: new URL('http://x/workflows/demo2'), req: reqOf('PUT', '/workflows/demo2'), reply: bad.reply, readJsonBody: async () => ({ model: {} }),
      store, host: { ...host, save: async () => ({ ok: false, error: '校验失败', errors: [{ code: 'NO_START' }] }) },
    })
    assert.equal(bad.out.code, 400)
    assert.equal(bad.out.body.errors[0].code, 'NO_START')
  } finally { cleanup() }
})

test('POST /workflows/run：授权清单透传宿主，未带清单则 400', async () => {
  const { root, host, cleanup } = setup()
  try {
    const okr = mkReply()
    let seen = null
    await handleWorkflowRoute({ url: new URL('http://x/workflows/run'), req: reqOf('POST', '/workflows/run'), reply: okr.reply, readJsonBody: async () => ({ id: 'demo', inputs: { q: 1 }, capabilities: { tools: ['Read'] } }), store, host: { ...host, run: async (a) => { seen = a; return { ok: true, runId: 'r9' } } } })
    assert.equal(okr.out.body.ok, true)
    assert.deepEqual(seen.capabilities.tools, ['Read'])

    const bad = mkReply()
    await handleWorkflowRoute({ url: new URL('http://x/workflows/run'), req: reqOf('POST', '/workflows/run'), reply: bad.reply, readJsonBody: async () => ({ id: 'demo' }), store, host })
    assert.equal(bad.out.code, 400, '缺 capabilities 应拒绝（授权清单是运行前置）')
  } finally { cleanup() }
})

test('未匹配路径返回 false（不吞其他路由）', async () => {
  const { host, cleanup } = setup()
  try {
    const { out, reply } = mkReply()
    const handled = await handleWorkflowRoute({ url: new URL('http://x/skills'), req: reqOf('GET', '/skills'), reply, readJsonBody: async () => ({}), store, host })
    assert.equal(handled, false)
    assert.equal(out.code, undefined)
  } finally { cleanup() }
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test server/workflow-api.test.mjs`
Expected: FAIL — `handleWorkflowRoute is not a function`

- [ ] **Step 3: 实现路由函数（独立模块 `server/workflow-routes.mjs`）**

创建 `server/workflow-routes.mjs`（`host` 为必需参数，由 bridge 注入；模块内不持有 host 单例）：

```js
// server/workflow-routes.mjs —— 工作流 HTTP 路由（独立模块，便于单测；
// 不得置于 bridge.mjs：bridge 顶层会 listen，测试 import 会真起桥）。
import * as wfStore from './workflow-store.mjs'

export async function handleWorkflowRoute({ url, req, reply, readJsonBody, store = wfStore, host, runsRoot = '', root = '' }) {
  const p = url.pathname
  if (p !== '/workflows' && !p.startsWith('/workflows/')) return false
  if (!host) return reply(500, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: '工作流宿主未注入' })), true
  const h = host
  const json = (code, obj) => reply(code, { 'Content-Type': 'application/json' }, JSON.stringify(obj))
  try {
    if (p === '/workflows' && req.method === 'GET') {
      return json(200, { workflows: store.listWorkflowMetas({ root, runsRoot }), root: root.replace(/\\/g, '/') }), true
    }
    if (p === '/workflows' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const id = String(body.id || '').trim()
      if (!id) return json(400, { ok: false, error: 'id 必填' }), true
      const saved = await h.save({ id, model: body.model, yaml: body.yaml })
      if (!saved.ok) return json(400, saved), true
      return json(200, { ...store.writeWorkflowYml({ root, id, yml: saved.yml }), id }), true
    }
    const m = p.match(/^\/workflows\/([^/]+)(\/.*)?$/)
    if (m) {
      const id = decodeURIComponent(m[1])
      const sub = m[2] || ''
      if (id === 'run' && req.method === 'POST') {
        const body = await readJsonBody(req)
        if (!body?.capabilities) return json(400, { ok: false, error: '缺少 capabilities：运行前必须提供授权清单' }), true
        const r = await h.run({ id: body.id, inputs: body.inputs || {}, capabilities: body.capabilities })
        return json(r.ok === false ? 400 : 200, r), true
      }
      if (id === 'stop' && req.method === 'POST') {
        const body = await readJsonBody(req)
        return json(200, await h.stop(body.runId)), true
      }
      if (id === 'confirm' && req.method === 'POST') {
        const body = await readJsonBody(req)
        return json(200, h.confirm(body)), true
      }
      if (id === 'runs' && req.method === 'GET') {
        const name = url.searchParams.get('name') || ''
        return json(200, { runs: store.recentRuns({ runsRoot, id: name || url.searchParams.get('id') || '', name }) }), true
      }
      if (id === 'import' && req.method === 'POST') {
        const body = await readJsonBody(req)
        return json(200, store.importBundle({ root, bundle: body.bundle, id: body.id })), true
      }
      if (id === 'bindings') {
        if (req.method === 'GET') return json(200, store.readBindings({ root })), true
        const body = await readJsonBody(req)
        return json(200, store.writeBindings({ root, bindings: body })), true
      }
      if (sub === '' && req.method === 'GET') {
        const r = await h.load(id)
        if (!r.ok) return json(404, r), true
        return json(200, r), true
      }
      if (sub === '' && req.method === 'PUT') {
        const body = await readJsonBody(req)
        const saved = await h.save({ id, model: body.model, yaml: body.yaml })
        if (!saved.ok) return json(400, saved), true
        return json(200, { ...store.writeWorkflowYml({ root, id, yml: saved.yml }), id, validation: saved.validation }), true
      }
      if (sub === '' && req.method === 'DELETE') return json(200, store.deleteWorkflow({ root, id })), true
      if (sub === '/duplicate' && req.method === 'POST') {
        const body = await readJsonBody(req)
        return json(200, store.duplicateWorkflow({ root, fromId: id, toId: body.toId })), true
      }
      if (sub === '/validate' && req.method === 'GET') return json(200, await h.validate(id)), true
      if (sub === '/versions' && req.method === 'GET') return json(200, { versions: store.listVersions({ root, id }) }), true
      if (sub === '/rollback' && req.method === 'POST') {
        const body = await readJsonBody(req)
        return json(200, store.rollbackVersion({ root, id, ts: body.ts })), true
      }
      if (sub === '/export' && req.method === 'GET') {
        const r = store.exportBundle({ root, id })
        return json(r.ok === false ? 404 : 200, r), true
      }
    }
    return json(404, { ok: false, error: 'not found' }), true
  } catch (e) {
    return json(500, { ok: false, error: e?.message || String(e) }), true
  }
}
```

在 `server/bridge.mjs` 顶部新增（宿主单例与路由挂载）：

```js
import { handleWorkflowRoute } from './workflow-routes.mjs'
import { createWorkflowHost, HOST_SID } from './workflow-host.mjs'

let _wfHost = null
function workflowHost() {
  if (!_wfHost) {
    _wfHost = createWorkflowHost({
      sessions, getOrCreateSession,
      yfwHome: YFW_HOME,
      model: activeProviderModel(loadConfig()),
      onEvent: (ev) => broadcastGui({ type: 'workflow_event', sessionId: HOST_SID, event: ev }),
    })
  }
  return _wfHost
}
const WF_ROOT = join(YFW_HOME, 'workflows')
const WF_RUNS = join(YFW_HOME, 'workflow-runs')
```

在 `httpServer` 的路由链**最前**（`const url = new URL(...)` 之后）插入：

```js
    if (await handleWorkflowRoute({ url, req, reply, readJsonBody, host: workflowHost(), root: WF_ROOT, runsRoot: WF_RUNS })) return
```

`workflow` 事件转发：内核事件已由各会话 `wire.system('workflow', ev)` 产生，bridge 处理内核消息处（`sessions` 的 stdout 处理分支）增一条：

```js
        // 工作流事件：宿主/任意会话的 workflow 事件 → GUI（含节点/边/跳过/结束）
        if (msg.type === 'system' && (msg.subtype === 'workflow' || msg.subtype === 'workflow_result')) {
          if (msg.subtype === 'workflow') broadcastGui({ type: 'workflow_event', sessionId: sid, event: msg })
          else workflowHost().onKernelMessage(msg)
        }
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `node --test server/workflow-api.test.mjs`
Expected: PASS（4 个 test 全绿）

- [ ] **Step 5: 补 `docs/bridge-contract.md`**

新增"工作流模块（/workflows）"章节：列全部路由、请求/响应示例、`workflow_event` 事件形状
（`start` / `node` / `node_skipped` / `edge_taken` / `end`）、grant 生命周期与 fail-closed 语义。

- [ ] **Step 6: Commit**

```bash
git add server/workflow-routes.mjs server/bridge.mjs docs/bridge-contract.md server/workflow-api.test.mjs
git commit -m "feat(workflow): /workflows 路由模块（CRUD/运行/停止/确认/记录/导入导出/绑定）+ 事件转发"
```

---

### Task 13: DSL 模型与画布（第五 rail 的编辑器）

**Files:**
- Modify: `package.json`（dependency `@xyflow/react`）
- Modify: `src/stores/viewStore.ts:15-25`（`RailId` 增 `'workflows'`）、`src/stores/viewStore.test.ts`（补断言）
- Modify: `src/components/layout/railMeta.ts`（增条目）、`src/components/layout/WorkShell.tsx:170-174`（rail 分支）
- Create: `src/lib/workflowModel.ts`、`src/lib/workflowModel.test.ts`、`src/lib/workflowApi.ts`
- Create: `src/components/workflows/WorkflowsPanel.tsx`、`src/components/workflows/canvas/WorkflowCanvas.tsx`、`src/components/workflows/canvas/NodePalette.tsx`、`src/components/workflows/canvas/ConfigPanel.tsx`、`src/components/workflows/canvas/nodes/WorkflowNode.tsx`

**Interfaces:**
- Consumes: Task 12 的 HTTP 路由
- Produces:
  - `src/lib/workflowModel.ts`：`WorkflowModel`/`NodeModel`/`EdgeModel` 类型；`toFlow(model) → {nodes, edges}`；`fromFlow(flowNodes, flowEdges, base) → WorkflowModel`；`deriveCapabilities(model) → {tools, write_dirs, network}`；`validateLocal(model) → {errors, warnings}`；`NODE_TYPES`（分类目录）
  - `src/lib/workflowApi.ts`：`listWorkflows()`、`loadWorkflow(id)`、`saveWorkflow(id, model)`、`runWorkflow(id, inputs, capabilities)`、`stopRun(runId)`、`confirmNode(payload)`、`listRuns(id)`、`exportWorkflow(id)`、`importWorkflow(bundle, id)`、`getBindings()` / `setBindings()`

- [ ] **Step 1: 写失败测试（纯逻辑）**

创建 `src/lib/workflowModel.test.ts`（沿用仓库既有 `node --test` + TS 直跑约定，断言纯函数）：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toFlow, fromFlow, deriveCapabilities, validateLocal, NODE_TYPES, type WorkflowModel } from './workflowModel'

const MODEL: WorkflowModel = {
  name: 'demo', version: '1.0.0',
  inputs: [{ name: 'q', type: 'string', required: true }],
  nodes: [
    { id: 'start', type: 'start', label: '开始', position: { x: 0, y: 0 } },
    { id: 'ask', type: 'llm', label: '问', position: { x: 200, y: 0 }, config: { prompt: '{{inputs.q}}' } },
    { id: 'f', type: 'tool', label: '写文件', position: { x: 400, y: 0 }, config: { tool: 'Write', input: { file_path: '{{inputs.out}}', content: 'x' } } },
    { id: 'done', type: 'end', label: '结束', position: { x: 600, y: 0 } },
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'ask' },
    { id: 'e2', source: 'ask', target: 'f' },
    { id: 'e3', source: 'f', target: 'done' },
  ],
}

test('toFlow ⇄ fromFlow 往返保持语义与位置', () => {
  const flow = toFlow(MODEL)
  assert.equal(flow.nodes.length, 4)
  assert.equal(flow.nodes[1].position.x, 200)
  assert.equal(flow.edges.length, 3)
  const back = fromFlow(flow.nodes, flow.edges, MODEL)
  assert.deepEqual(back.nodes.map((n) => n.id), MODEL.nodes.map((n) => n.id))
  assert.deepEqual(back.edges.map((e) => `${e.source}->${e.target}`), ['start->ask', 'ask->f', 'f->done'])
})

test('条件边：sourceHandle 映射为画布 handle（true/false/route:i/fail）', () => {
  const m: WorkflowModel = { ...MODEL, edges: [{ id: 'e1', source: 'ask', target: 'done', sourceHandle: 'true' }] }
  const flow = toFlow(m)
  assert.equal(flow.edges[0].sourceHandle, 'true')
  const back = fromFlow(flow.nodes, flow.edges, m)
  assert.equal(back.edges[0].sourceHandle, 'true')
})

test('deriveCapabilities：从节点推导能力清单（工具/网络/写入目录）', () => {
  const caps = deriveCapabilities(MODEL)
  assert.ok(caps.tools.includes('Write'), `应推导出 Write：${caps.tools}`)
  assert.equal(caps.network, false)

  const withHttp: WorkflowModel = { ...MODEL, nodes: [...MODEL.nodes, { id: 'h', type: 'http', config: { url: 'https://x' } }] }
  assert.equal(deriveCapabilities(withHttp).network, true)

  const declared: WorkflowModel = { ...MODEL, permissions: { tools: ['Bash'], network: true, write_dirs: ['D:/ws'] } }
  const c = deriveCapabilities(declared)
  assert.ok(c.tools.includes('Bash') && c.network === true)
  assert.deepEqual(c.write_dirs, ['D:/ws'])
})

test('validateLocal：缺 start / 环 / 引用非上游 报错；正常模型零错误', () => {
  assert.deepEqual(validateLocal(MODEL).errors, [])
  assert.ok(validateLocal({ ...MODEL, nodes: MODEL.nodes.filter((n) => n.type !== 'start'), edges: [] }).errors.some((e) => e.code === 'NO_START'))
  const cyc: WorkflowModel = { ...MODEL, edges: [...MODEL.edges, { id: 'e9', source: 'done', target: 'start' }] }
  assert.ok(validateLocal(cyc).errors.some((e) => e.code === 'CYCLE'))
  const badRef: WorkflowModel = { ...MODEL, nodes: MODEL.nodes.map((n) => (n.id === 'ask' ? { ...n, config: { prompt: '{{done.x}}' } } : n)) }
  assert.ok(validateLocal(badRef).errors.some((e) => e.code === 'VAR_UNREACHABLE'))
})

test('NODE_TYPES：分类目录含全部节点类型且每项有中文名', () => {
  const all = NODE_TYPES.flatMap((g) => g.items).map((i) => i.type)
  for (const t of ['start', 'end', 'answer', 'llm', 'classify', 'extract', 'agent', 'code', 'template', 'http', 'document', 'list', 'iterate', 'loop', 'memory', 'store', 'tool', 'subworkflow', 'if', 'join', 'assign', 'aggregate', 'confirm']) {
    assert.ok(all.includes(t as never), `缺节点类型 ${t}`)
  }
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test src/lib/workflowModel.test.ts`
Expected: FAIL — `Cannot find module './workflowModel'`

- [ ] **Step 3: 实现 `src/lib/workflowModel.ts`**

要点（完整实现按此结构落地）：

```ts
export interface NodeModel { id: string; type: string; label?: string; position?: { x: number; y: number }; retry?: any; on_error?: string; body?: string[]; config?: Record<string, any> }
export interface EdgeModel { id: string; source: string; target: string; sourceHandle?: string }
export interface WorkflowModel { name: string; description?: string; version?: string; triggers?: string[]; trigger_config?: any; settings?: { max_parallel?: number }; inputs?: Array<{ name: string; type?: string; required?: boolean; description?: string }>; nodes: NodeModel[]; edges: EdgeModel[]; expose?: { mode?: string; tool_name?: string; bind_agents?: string[] }; permissions?: { tools?: string[]; write_dirs?: string[]; network?: boolean } }

export const NODE_TYPES: Array<{ group: string; items: Array<{ type: string; label: string; hint: string }> }> = [
  { group: '输入', items: [{ type: 'start', label: '开始', hint: '工作流入口' }, { type: 'inputs', label: '输入参数', hint: '在右侧面板定义 inputs' }] },
  { group: '模型', items: [ { type: 'llm', label: '大模型', hint: '单次生成' }, { type: 'classify', label: '分类', hint: '按类别路由' }, { type: 'extract', label: '字段提取', hint: 'JSON schema 抽取' }, { type: 'agent', label: '智能体', hint: 'ReAct 循环 + 工具' } ] },
  { group: '处理', items: [ { type: 'code', label: '代码', hint: '沙箱 JS' }, { type: 'template', label: '模板', hint: '变量拼接' }, { type: 'http', label: 'HTTP', hint: '请求外部接口' }, { type: 'document', label: '文档读取', hint: 'Read/OCR' }, { type: 'list', label: '列表', hint: '过滤/排序/取值' }, { type: 'iterate', label: '迭代', hint: '并行遍历数组' }, { type: 'loop', label: '循环', hint: '定次/条件循环' }, { type: 'memory', label: '记忆检索', hint: '经验库查询' }, { type: 'store', label: '记忆写入', hint: '沉淀经验' } ] },
  { group: '工具', items: [ { type: 'tool', label: '工具调用', hint: '调用内置/自定义工具' }, { type: 'subworkflow', label: '子工作流', hint: '复用另一工作流' } ] },
  { group: '流程', items: [ { type: 'if', label: '条件分支', hint: 'true/false 双路' }, { type: 'join', label: '汇聚', hint: '多分支合并' }, { type: 'assign', label: '变量赋值', hint: '写 var' }, { type: 'aggregate', label: '聚合', hint: '拼装输出' }, { type: 'confirm', label: '人工审批', hint: '挂起等待批准' } ] },
  { group: '输出', items: [ { type: 'answer', label: '回答', hint: '对话型输出' }, { type: 'end', label: '结束', hint: '定义返回值' } ] },
]

const toFlowNodes = (model: WorkflowModel) => model.nodes.map((n) => ({ id: n.id, type: 'yfw', position: n.position ?? { x: 0, y: 0 }, data: { label: n.label || n.type, nodeType: n.type, config: n.config ?? {} } }))
export function toFlow(model: WorkflowModel) { return { nodes: toFlowNodes(model), edges: model.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}) })) } }
export function fromFlow(flowNodes: any[], flowEdges: any[], base: WorkflowModel): WorkflowModel { /* 位置/data.config 回填，边 sourceHandle 保留，剔除临时字段 */ }

const CAP_TOOLS: Record<string, string[]> = { tool: [], document: ['Read', 'OCR'], memory: ['Read'], store: ['Write'], code: [], http: [], agent: ['Agent', 'Task'] }
export function deriveCapabilities(model: WorkflowModel) {
  const tools = new Set<string>(model.permissions?.tools ?? [])
  let network = model.permissions?.network === true
  for (const n of model.nodes) {
    if (n.type === 'tool') { const t = n.config?.tool; if (t) tools.add(String(t)) }
    if (n.type === 'http') network = true
    for (const t of CAP_TOOLS[n.type] ?? []) tools.add(t)
  }
  for (const n of model.nodes) if (n.type === 'tool' && (n.config?.tool === 'Write' || n.config?.tool === 'Edit')) tools.add('Write')
  return { tools: [...tools].sort(), write_dirs: model.permissions?.write_dirs ?? [], network }
}

export function validateLocal(model: WorkflowModel) { /* 与内核校验同口径：NO_START/NO_NODES/DUP/CYCLE/DANGLING/VAR_UNREACHABLE（本地快速反馈，权威仍在内核） */ }
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `node --test src/lib/workflowModel.test.ts`
Expected: PASS（5 个 test 全绿）

- [ ] **Step 5: rail 与面板骨架**

```bash
npm i @xyflow/react
```

`src/stores/viewStore.ts`：

```ts
export type RailId = 'chat' | 'task' | 'agents' | 'skills' | 'workflows'
export const RAIL_IDS: readonly RailId[] = ['chat', 'task', 'agents', 'skills', 'workflows']
```

`src/stores/viewStore.test.ts` 增：`assert.equal(sanitizeRail('workflows'), 'workflows')`。

`src/components/layout/railMeta.ts` 增：

```ts
  { id: 'workflows', icon: Workflow, labelKey: 'rail.workflows' },
```

`src/components/layout/WorkShell.tsx:170-174` 分支增：

```tsx
        ) : rail === 'workflows' ? (
          <WorkflowsPanel />
```

i18n：`rail.workflows` 各语言词条（zh-CN「工作流」/ en-US「Workflows」）。

`src/components/workflows/WorkflowsPanel.tsx`（列表 + 画布 + 抽屉三段式，骨架）：

```tsx
export function WorkflowsPanel() {
  const [list, setList] = useState<WorkflowMeta[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [model, setModel] = useState<WorkflowModel | null>(null)
  const [dirty, setDirty] = useState(false)
  // 打开即拉列表；选中项经 /workflows/:id 取 model（宿主解析）
  // 工具栏：保存(PUT) / 校验(GET validate) / 运行(先 deriveCapabilities → AuthzDialog) / 导入导出 / YAML 切换
  return openId && model
    ? <WorkflowCanvas model={model} onChange={(m) => { setModel(m); setDirty(true) }} onSave={...} onRun={...} />
    : <WorkflowList list={list} onOpen={...} onDelete={...} onImport={...} />
}
```

- [ ] **Step 6: 画布组件（xyflow + 设计语言）**

`canvas/WorkflowCanvas.tsx` 关键点：

```tsx
import { ReactFlow, Background, Controls, MiniMap, addEdge, useEdgesState, useNodesState } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { WorkflowNode } from './nodes/WorkflowNode'

const nodeTypes = { yfw: WorkflowNode }

export function WorkflowCanvas({ model, onChange, onSave, onRun }: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState(toFlow(model).nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(toFlow(model).edges)
  const [selected, setSelected] = useState<string | null>(null)
  const onConnect = useCallback((c: Connection) => setEdges((es) => addEdge({ ...c, id: `e_${c.source}_${c.target}_${Date.now().toString(36)}` }, es)), [])
  // 变更后回写 model（节流 300ms），保证"一份 DSL 是唯一真相"
  useEffect(() => { const t = setTimeout(() => onChange(fromFlow(nodes, edges, model)), 300); return () => clearTimeout(t) }, [nodes, edges])
  return (
    <div className="flex-1 flex min-h-0">
      <NodePalette onAdd={(type) => {/* 在视口中心插入节点，id 自增 n1/n2…，position 递增避免重叠 */ }} />
      <div className="flex-1 min-w-0">
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onNodeClick={(_, n) => setSelected(n.id)} fitView>
          <Background gap={16} />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
      <ConfigPanel model={model} nodeId={selected} onChange={(next) => onChange(next)} />
    </div>
  )
}
```

`nodes/WorkflowNode.tsx`：单对角切角卡片（复用 `.cut` 工具类 + 品牌色描边），显示类型徽标 + label + 运行状态着色（`idle/running/done/failed/skipped`，状态来自 `RunDrawer` 注入的 `nodeStatus` map）；条件节点（if/classify）渲染 `Handle` 分色：`true`（品牌色）/`false`（灰）/`route:i`（渐变）/`fail`（警示色）。

`ConfigPanel.tsx`：按 `nodeType` 渲染表单（llm → prompt/system/model/max_tokens；http → url/method/headers/body；
if → conditions 行编辑；tool → 工具选择 + input 键值；iterate/loop → body 多选 + count/parallel_nums），
每处文本输入旁给**变量选择器**（下拉列出上游可达节点的输出字段：`{{<nodeId>.<field>}}`，候选由 `validateLocal` 的可达性逻辑产出）。

- [ ] **Step 7: 前端校验与提交**

Run: `npm run typecheck`
Expected: 通过

Run: `node --test src/lib/workflowModel.test.ts src/stores/viewStore.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/stores/viewStore.ts src/stores/viewStore.test.ts src/components/layout src/components/workflows src/lib/workflowModel.ts src/lib/workflowModel.test.ts src/lib/workflowApi.ts src/i18n
git commit -m "feat(workflow): 第五 rail + xyflow 画布（节点面板/配置面板/变量选择器/条件边分色）"
```

---

### Task 14: 运行抽屉 / 授权卡 / 端到端验收

**Files:**
- Create: `src/components/workflows/RunDrawer.tsx`、`src/components/workflows/AuthzDialog.tsx`
- Modify: `src/components/workflows/WorkflowsPanel.tsx`（接线运行与事件订阅）
- Modify: `src/lib/workflowApi.ts`（`subscribeWorkflowEvents()`）
- Modify: `docs/superpowers/specs/2026-09-11-workflow-module-design.md`（把验收结果写回"实现记录"小节）
- Test: 人工验收清单（见 Step 5）

**Interfaces:**
- Consumes: Task 13 的模型层与画布、Task 12 的事件广播
- Produces: `AuthzDialog({ capabilities, onConfirm(capabilities), onCancel })`、`RunDrawer({ runId, events, onStop, onConfirm })`

- [ ] **Step 1: 授权卡**

`AuthzDialog.tsx`：

```tsx
// 运行前授权清单（一次放行）：逐项可勾除；勾除项在本次运行内 fail-closed。
// 审计不受影响——授权只免除交互打断，每次工具调用仍写哈希链。
export function AuthzDialog({ id, capabilities, onConfirm, onCancel }: Props) {
  const [tools, setTools] = useState(capabilities.tools)
  const [dirs, setDirs] = useState(capabilities.write_dirs)
  const [network, setNetwork] = useState(capabilities.network)
  const [trust, setTrust] = useState(false)
  // 列表项：读文件 / 写这些目录 / 执行 Shell / 访问网络 / 调用这些工具 —— 每项一个 switch
  // 确认 → onConfirm({ tools, write_dirs: dirs, network })；勾选“信任此工作流”→ POST /workflows/bindings
}
```

- [ ] **Step 2: 运行抽屉 + 事件订阅**

`src/lib/workflowApi.ts` 增：

```ts
// 复用既有 WS（useYFWCLI 的 getOrCreateWS）接收 { type:'workflow_event' }
export function subscribeWorkflowEvents(handler: (ev: any) => void): () => void
```

`RunDrawer.tsx`：

```tsx
// Tab A 实时运行：节点状态着色（nodeStatus: {nodeId: 'running'|'done'|'failed'|'skipped'}）
//   + 当前节点输出预览 + confirm 审批卡（POST /workflows/confirm）+ 停止按钮（POST /workflows/stop）
// Tab B 历史记录：GET /workflows/runs?id=<id> 列表 → 单次步骤瀑布 → 「校验完整性」按钮
//   （校验走后端 GET /workflows/verify?path=… ，复用引擎 verifyRun）
```

事件 → UI 的映射（照契约实现，勿自创字段）：

| 事件 | UI 反应 |
|---|---|
| `start` | 清空状态，标记全部节点 `idle` |
| `node` + `status:'done'` | 该节点 `done` + 输出预览 |
| `node` + `status:'failed'` | 该节点 `failed` + 错误文本 |
| `node_skipped` | 该节点 `skipped`（灰） |
| `edge_taken` | 该边高亮（`active` 实线加亮 / `skipped` 虚线淡化） |
| `end` | 顶部状态：`completed`/`failed`/`cancelled` + 步数；刷新历史列表 |

- [ ] **Step 3: `/workflows/verify` 路由补齐**

在 `server/workflow-routes.mjs` 的匹配链中增（宿主侧走内核 `workflow_command{subtype:'verify'}`，内核计划已实现）：

```js
      if (id === 'verify' && req.method === 'GET') {
        const p = url.searchParams.get('path') || ''
        const r = await h.send({ subtype: 'verify', payload: { auditPath: p } }, { timeoutMs: 15_000 })
        return json(200, r), true
      }
```

- [ ] **Step 4: 端到端自动化检查（能自动化的部分）**

```bash
node --test server/*.test.mjs kernel-tests/*.test.mjs
npm run typecheck
node scripts/build-kernel.mjs
```

Expected: 全部通过；`build-kernel.mjs` 无 unresolved import。

- [ ] **Step 5: 人工验收清单（GUI，逐条勾）**

1. rail 出现第五项「工作流」，切换后主区显示工作流列表；重启应用后仍停在 workflows rail（persist 生效）。
2. 新建工作流：拖入 `开始 → 大模型 → 条件分支 → (true) 模板 / (false) 模板 → 结束`，连线正常，条件边分色可见。
3. 配置面板改动后 300ms 内 `dirty=true`；点保存 → `PUT /workflows/:id` 落盘；`~/.yfworking/workflows/<id>/workflow.yml` 内容为 DSL v2（含 `edges:`）。
4. 故意造环（把 `结束` 连回 `开始`）→ 画布即时提示 `CYCLE`；保存被后端 400 拒绝并展示内核 error codes。
5. 点运行 → 授权卡列出「调用工具：`Template`？/ 读文件 / 访问网络」，勾除「访问网络」→ 运行；未授权项在运行中被拒绝且**不挂起、不中断整轮**。
6. 运行抽屉节点实时着色（含 skipped 灰）；`end` 后状态 `completed`，步数与节点数一致。
7. 历史记录 Tab 出现本次运行；点「校验完整性」返回 `ok: true`。
8. 运行中改数据后点停止 → 状态 `cancelled`，事件里出现 `end(status:'cancelled')`。
9. 导出 `.yfwflow` 文件 → 删除该工作流 → 导入同一文件 → 内容一致。
10. 把工作流 `expose.mode=bound` 且 `bind_agents: [material-writer]` → 在材料撰写专家会话里可用 `run_<slug>` 工具；在表格专家会话里**不可见**（提示词与工具表都不出现）。
11. 设 `expose.mode=public` → 任意新会话工具表出现该具名工具，模型可直接调用（内含工作流逻辑执行）。
12. 设 `expose.mode=private` → 工具表不出现，但画布可手动运行。

- [ ] **Step 6: 把验收结果写回 spec**

在 `docs/superpowers/specs/2026-09-11-workflow-module-design.md` 末尾追加「## 实现记录（2026-09-XX）」，记录：实际改动文件清单、验收清单勾选结果、未完成/延后项与原因（若有）。

- [ ] **Step 7: Commit**

```bash
git add src/components/workflows src/lib/workflowApi.ts server/workflow-routes.mjs docs/superpowers/specs/2026-09-11-workflow-module-design.md
git commit -m "feat(workflow): 运行抽屉 + 授权卡 + 事件着色 + 端到端验收记录"
```

---

## Self-Review

**Spec 覆盖**：§5 宿主与授权（Task 11 + 14 Step 1-2）、§6 GUI 第五 rail 与画布（Task 13）、运行抽屉与历史（Task 14）、§7 落盘与验收（Task 10 落盘、Task 14 端到端）、非目标里"不做云端市场/断点调试"未引入任何任务（未越界）。§4 的导出/导入分享包在 Task 10 实现、Task 12 暴露路由。

**类型一致性**：`WorkflowModel`（Task 13）字段与内核 `toModel/serializeWorkflow`（Task 9）一致（`nodes[].config` 收拢、`edges[].sourceHandle`）；`capabilities`（Task 13 `deriveCapabilities`）与宿主 `mergeCapabilities`（Task 11）字段一致（`tools/write_dirs/network`）；`workflow_event` 事件字段（Task 12 路由章节）与 RunDrawer 映射表（Task 14）一致；`insertBuiltinWorkflows`/`handleWorkflowRoute` 均为导出函数以便单测。

**风险提示（执行者必读）**：① **server 禁止 import kernel/**——所有 DSL 能力经宿主会话，违反会在安装版崩（dev 环境不显现）；② `src/lib/workflowModel.ts` 的本地校验只是快速反馈，**权威校验必须走后端**，两处口径不一致时以后端为准；③ 画布回写 model 用 300ms 节流，注意在 `onSave` 前 flush 最后一次变更，否则"改了立刻保存"会丢最后一次编辑。
