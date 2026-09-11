# 工作流第五模块 · 内核计划（DSL v2 / DAG 引擎 / 工作流即工具）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把内核工作流引擎从"数组顺序执行"升级为真 DAG（edges 即真相），并让每个工作流注册为具名工具（private/bound/public 三态），使工作流成为用户可自制的工具与适配器。

**Architecture:** 把现有 `kernel/workflow.mjs`（1037 行）拆为四个职责单一的文件：`workflow-dsl.mjs`（解析/校验/迁移）、`workflow-dag.mjs`（就绪集合调度器）、`workflow-nodes.mjs`（节点执行器）、`workflow-engine.mjs`（引擎装配：审计/事件/webhook/cron/confirm）。新增 `kernel/dyntools.mjs` 做"工作流 → 具名工具"的 schema 派生与可见性过滤，接线到 `tools.mjs`（注册表叠加过滤）与 `cli.mjs`（装载）。内置 `spec-dev` 重写为显式连线，bridge 安装逻辑升级为按 version 覆盖。

**Tech Stack:** Node.js ESM（内核零外部依赖，YAML 用既有子集解析器）；测试用 `node --test`；无新依赖。

## Global Constraints

- 内核零外部运行时依赖：`kernel/**` 不得 import 任何 npm 包，只能用 `node:*` 与仓库内相对路径（`scripts/build-kernel.mjs` 以 `bun build --external=node:*` 打包必须仍能成功）。
- 内核版本线：新增 DSL 版本常量 `DSL_VERSION = 2`；导出包 `manifest.kernelMinVersion` 用 `"0.2"`。
- 节点并行度默认 **4**（`settings.max_parallel`）；`loop` 恒串行（轮间共享 `var` 状态）；`iterate` 沿用现有 `parallel_nums`。
- 审计哈希链 `auditAppend` / `verifyRun` 语义不得改变；`confirm` 挂起与 `resolveConfirm` 契约不得改变；工具审批门 `checkToolPermission`（含 Bash 无门 fail-closed）不得绕过。
- 保留既有导出面：`createWorkflowEngine` / `discoverWorkflows` / `discoverWorkflowsAll` / `loadWorkflow` / `verifyRun` / `matchAutoTrigger` / `parseYaml` / `renderTemplate` 仍从 `kernel/workflow.mjs` 可导入（`workflow.mjs` 变为薄 re-export 层，保证 cli.mjs / tools.mjs / kernel-tests 零改动）。
- 命名：工作流 id 用 kebab-case；工具名 `run_<id 蛇形转写>`（`[a-z0-9_]`）。
- 旧格式工作流不得静默失败：必须报 `LEGACY_DSL` 并提供 `migrateLegacy` 转换。
- 测试命令：`node --test kernel-tests/<file>.test.mjs`。

---

## 文件结构（本计划锁定）

| 文件 | 职责 |
|---|---|
| `kernel/workflow-dsl.mjs`（新建） | YAML 解析、模板渲染、变量寻址、条件求值、发现/加载、`validateWorkflow`、`migrateLegacy`、`normalizeWorkflow` |
| `kernel/workflow-dag.mjs`（新建） | 图构建、环检测、就绪集合调度器（join / 并行 / 条件边 / 错误边 / 重试 / 跳过传播 / 子图递归） |
| `kernel/workflow-nodes.mjs`（新建） | 23 种节点执行器 + `callLLMText` / `runAgentLoop` / `checkToolPermission` |
| `kernel/workflow-engine.mjs`（新建） | `createWorkflowEngine`：审计、事件、webhook、cron、confirm、stop |
| `kernel/workflow.mjs`（改写为 re-export） | 对外兼容面，防其他模块回归 |
| `kernel/dyntools.mjs`（新建） | `slugToToolName` / `deriveInputSchema` / `deriveToolDescription` / `buildWorkflowTools` / `filterToolsForAgent` |
| `kernel/tools.mjs`（改） | 注册表接受 `dynamicTools()` 叠加视图 |
| `kernel/cli.mjs`（改） | 装载动态工具、`--agent <id>`、工作流 stop 子命令 |
| `kernel/agents.mjs`（改） | 解析 agent frontmatter 的 `workflows:` 字段 |
| `workflows/spec-dev/workflow.yml`（重写） | 内置工作流转为显式 edges |
| `server/bridge.mjs`（改） | 内置工作流安装升级为按 version 覆盖 |
| `kernel-tests/workflow-{dsl,migrate,dag,nodes,engine,dyntools,binding}.test.mjs`（新建）、`workflow-specdev.test.mjs`（改写） | 验收 |

依赖顺序：Task 1 → 2 →（3 与 4 可并行）→ 5 → 6 → 7 → 8。

---

### Task 1: DSL v2 解析与校验

**Files:**
- Create: `kernel/workflow-dsl.mjs`
- Modify: `kernel/workflow.mjs:1-300`（把解析/发现/加载相关函数整体搬出并 re-export）
- Test: `kernel-tests/workflow-dsl.test.mjs`

**Interfaces:**
- Consumes: 无（本计划起点）
- Produces:
  - `export const DSL_VERSION = 2`
  - `parseYaml(text) → object`、`renderTemplate(tpl, vars) → string`、`resolvePath(vars, selector) → any`、`evalCondition(cond, vars) → boolean`
  - `discoverWorkflows({root}) → [{id,name,description,version,triggers,autoTrigger,nodes,lines,dslVersion,legacy}]`
  - `discoverWorkflowsAll({roots}) → same[]`、`loadWorkflow({roots,id}) → wf|null`
  - `normalizeWorkflow(wf) → wf`（节点 `config` 摊平为扁平字段，保留 `label/position/retry/on_error/body`）
  - `validateWorkflow(wf) → { ok, errors: [{code,node?,edge?,message}], warnings: [] }`

- [ ] **Step 1: 写失败测试**

创建 `kernel-tests/workflow-dsl.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseYaml, loadWorkflow, validateWorkflow, normalizeWorkflow, DSL_VERSION } from '../kernel/workflow-dsl.mjs'

const GOOD = `name: demo
version: 1.0.0
triggers: [演示]
settings: { max_parallel: 4 }
trigger_config: { manual: true, webhook: false }
inputs:
  - { name: q, type: string, required: true, description: 问题 }
nodes:
  - { id: start, type: start, label: 开始, position: {x: 0, y: 0} }
  - id: ask
    type: llm
    label: 生成
    config: { prompt: "回答：{{inputs.q}}" }
    retry: { max: 2, delay_ms: 500, on_error: fail }
  - { id: done, type: end, label: 结束, config: { outputs: [{ name: text, selector: "{{ask}}" }] } }
edges:
  - { id: e1, source: start, target: ask }
  - { id: e2, source: ask, target: done }
`

function withFile(content, fn) {
  const root = mkdtempSync(join(tmpdir(), 'wf-dsl-'))
  try {
    mkdirSync(join(root, 'demo'), { recursive: true })
    writeFileSync(join(root, 'demo', 'workflow.yml'), content, 'utf-8')
    return fn(root)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('DSL v2：加载后 config 摊平、edges 保留、校验通过', () => {
  withFile(GOOD, (root) => {
    const wf = loadWorkflow({ roots: [root], id: 'demo' })
    assert.equal(wf.dslVersion, DSL_VERSION)
    const ask = wf.nodes.find((n) => n.id === 'ask')
    assert.equal(ask.prompt, '回答：{{inputs.q}}', 'config.prompt 应摊平到节点')
    assert.equal(ask.retry.max, 2, 'retry 留在节点顶层')
    assert.equal(ask.config, undefined, 'config 键应被消费掉')
    assert.equal(wf.edges.length, 2)
    const v = validateWorkflow(wf)
    assert.deepEqual(v.errors, [], `不应有错误：${JSON.stringify(v.errors)}`)
  })
})

test('校验器：缺 edges → LEGACY_DSL', () => {
  const legacy = GOOD.replace(/edges:[\s\S]*$/, '')
  const wf = normalizeWorkflow(parseYaml(legacy))
  const v = validateWorkflow(wf)
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => e.code === 'LEGACY_DSL'))
})

test('校验器：环 / 悬空边 / 重复 id / 缺 start', () => {
  const cyc = normalizeWorkflow({ nodes: [{ id: 'a', type: 'start' }, { id: 'b', type: 'llm' }], edges: [{ id: 'e1', source: 'a', target: 'b' }, { id: 'e2', source: 'b', target: 'a' }] })
  assert.ok(validateWorkflow(cyc).errors.some((e) => e.code === 'CYCLE'))

  const dang = normalizeWorkflow({ nodes: [{ id: 'a', type: 'start' }], edges: [{ id: 'e1', source: 'a', target: 'nope' }] })
  assert.ok(validateWorkflow(dang).errors.some((e) => e.code === 'DANGLING_EDGE'))

  const dup = normalizeWorkflow({ nodes: [{ id: 'a', type: 'start' }, { id: 'a', type: 'end' }], edges: [] })
  assert.ok(validateWorkflow(dup).errors.some((e) => e.code === 'DUP_NODE_ID'))

  const nostart = normalizeWorkflow({ nodes: [{ id: 'a', type: 'llm' }], edges: [] })
  assert.ok(validateWorkflow(nostart).errors.some((e) => e.code === 'NO_START'))
})

test('校验器：body 越界与跨子图边', () => {
  const wf = normalizeWorkflow({
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'lp', type: 'loop', body: ['body1', 'ghost'] },
      { id: 'body1', type: 'llm', prompt: 'x' },
      { id: 'done', type: 'end' },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'lp' },
      { id: 'e2', source: 'lp', target: 'done' },
      { id: 'e3', source: 'body1', target: 'done' },
    ],
  })
  const codes = validateWorkflow(wf).errors.map((e) => e.code)
  assert.ok(codes.includes('BODY_MEMBER_MISSING'), `应报 body 成员不存在：${codes}`)
  assert.ok(codes.includes('BODY_ESCAPE'), `应报跨子图边：${codes}`)
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test kernel-tests/workflow-dsl.test.mjs`
Expected: FAIL — `Cannot find module '../kernel/workflow-dsl.mjs'`

- [ ] **Step 3: 建立 `kernel/workflow-dsl.mjs` —— 平移既有实现**

从 `kernel/workflow.mjs` **原样剪切**以下函数到新文件并加 `export`（逻辑不变）：
`splitKV`、`unquote`、`parseYaml`、`treeToValue`、`resolvePath`、`renderTemplate`、`OPS`、`evalCondition`、
`discoverWorkflows`、`discoverWorkflowsAll`、`matchAutoTrigger`、`loadWorkflow`、`parseWorkflowFile`。
（对应 `kernel/workflow.mjs:29-301` 区间，含"轻量 YAML 子集解析 / 变量系统 / 条件求值 / 发现与加载"四节。）

- [ ] **Step 4: 实现 `normalizeWorkflow` 与 `validateWorkflow`**

追加到 `kernel/workflow-dsl.mjs`：

```js
export const DSL_VERSION = 2

// 节点专属配置写在 node.config（画布友好）；执行器读扁平字段 → 加载期摊平。
export function normalizeNode(n) {
  const { config = {}, ...rest } = n || {}
  return { ...rest, ...config }
}

export function normalizeWorkflow(wf) {
  return { ...(wf || {}), nodes: ((wf && wf.nodes) || []).map(normalizeNode), edges: Array.isArray(wf?.edges) ? wf.edges : null }
}

// 无向可达性（用于环检测与祖先判定）：edges 视为有向。
function buildGraph(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const incoming = new Map(nodes.map((n) => [n.id, []]))
  const outgoing = new Map(nodes.map((n) => [n.id, []]))
  for (const e of edges || []) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue
    outgoing.get(e.source).push(e)
    incoming.get(e.target).push(e)
  }
  return { byId, incoming, outgoing }
}

export function detectCycle(nodes, edges) {
  const { byId, incoming, outgoing } = buildGraph(nodes, edges)
  const indeg = new Map([...byId.keys()].map((id) => [id, incoming.get(id).length]))
  const q = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id)
  const seen = new Set()
  while (q.length) {
    const id = q.shift()
    seen.add(id)
    for (const e of outgoing.get(id)) {
      const d = indeg.get(e.target) - 1
      indeg.set(e.target, d)
      if (d === 0) q.push(e.target)
    }
  }
  return seen.size === byId.size ? null : [...byId.keys()].filter((id) => !seen.has(id))
}

// 所有字符串字段里的 {{selector}} 引用（递归遍历节点值）
function collectRefs(node) {
  const out = []
  const walk = (v) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/\{\{([^}]+)\}\}/g)) out.push(m[1].trim())
    } else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(node)
  return out
}

const LOCAL_SCOPES = new Set(['inputs', 'var', 'item', 'index', 'iter', 'root'])

export function validateWorkflow(wf) {
  const errors = []
  const warnings = []
  const nodes = Array.isArray(wf?.nodes) ? wf.nodes : []
  if (!nodes.length) errors.push({ code: 'NO_NODES', message: 'nodes 为空' })
  if (!Array.isArray(wf?.edges)) {
    errors.push({ code: 'LEGACY_DSL', message: '缺少 edges：旧格式（数组顺序执行）不再支持，请用 migrateLegacy 迁移' })
    return { ok: false, errors, warnings }
  }
  const ids = new Set()
  for (const n of nodes) {
    if (!n?.id) errors.push({ code: 'BAD_NODE', message: '节点缺少 id' })
    else if (ids.has(n.id)) errors.push({ code: 'DUP_NODE_ID', node: n.id, message: `节点 id 重复: ${n.id}` })
    else ids.add(n.id)
  }
  const nStart = nodes.filter((n) => n.type === 'start').length
  if (nStart !== 1) errors.push({ code: nStart ? 'MULTI_START' : 'NO_START', message: `需要且仅需要一个 start 节点（当前 ${nStart}）` })
  if (!nodes.some((n) => n.type === 'end' || n.type === 'answer')) {
    warnings.push({ code: 'NO_END', message: '无 end/answer 节点：作为工具调用时回退最后成功节点的输出' })
  }
  const edges = wf.edges
  for (const e of edges) {
    if (!e?.id) errors.push({ code: 'BAD_EDGE', message: '边缺少 id' })
    if (e && !ids.has(e.source)) errors.push({ code: 'DANGLING_EDGE', edge: e.id, message: `边 ${e.id} source 不存在: ${e.source}` })
    if (e && !ids.has(e.target)) errors.push({ code: 'DANGLING_EDGE', edge: e.id, message: `边 ${e.id} target 不存在: ${e.target}` })
  }
  // 子图边界：body 成员必须存在；边不得跨主图/子图
  const bodyOf = new Map()
  for (const n of nodes) {
    if ((n.type === 'loop' || n.type === 'iterate') && Array.isArray(n.body)) {
      for (const b of n.body) {
        if (!ids.has(b)) errors.push({ code: 'BODY_MEMBER_MISSING', node: n.id, message: `节点 ${n.id} 的 body 成员不存在: ${b}` })
        bodyOf.set(b, n.id)
      }
    }
  }
  for (const e of edges) {
    if (!e || !ids.has(e.source) || !ids.has(e.target)) continue
    const sb = bodyOf.get(e.source)
    const tb = bodyOf.get(e.target)
    if (sb !== tb) errors.push({ code: 'BODY_ESCAPE', edge: e.id, message: `边 ${e.id} 跨越子图边界（${e.source} → ${e.target}）` })
  }
  // 环检测：主图 + 每个 body 子图
  const main = nodes.filter((n) => !bodyOf.has(n.id))
  const mainCycle = detectCycle(main, edges.filter((e) => !bodyOf.has(e.source) && !bodyOf.has(e.target)))
  if (mainCycle) errors.push({ code: 'CYCLE', message: `主图存在环: ${mainCycle.join(' → ')}` })
  for (const owner of new Set(bodyOf.values())) {
    const members = nodes.filter((n) => bodyOf.get(n.id) === owner)
    const subEdges = edges.filter((e) => bodyOf.get(e.source) === owner && bodyOf.get(e.target) === owner)
    const c = detectCycle(members, subEdges)
    if (c) errors.push({ code: 'CYCLE', node: owner, message: `子图 ${owner} 存在环: ${c.join(' → ')}` })
  }
  // 变量可达性：{{nodeId.field}} 的 nodeId 必须是同作用域内的祖先节点
  const { incoming } = buildGraph(nodes, edges)
  const ancestorsOf = (id) => {
    const seen = new Set()
    const stack = [...(incoming.get(id) || []).map((e) => e.source)]
    while (stack.length) {
      const cur = stack.pop()
      if (seen.has(cur)) continue
      seen.add(cur)
      for (const e of incoming.get(cur) || []) stack.push(e.source)
    }
    return seen
  }
  for (const n of nodes) {
    const anc = ancestorsOf(n.id)
    for (const ref of collectRefs(n)) {
      const root = ref.split('.')[0]
      if (LOCAL_SCOPES.has(root) || root === n.id) continue
      if (!ids.has(root)) errors.push({ code: 'VAR_UNKNOWN', node: n.id, message: `节点 ${n.id} 引用未知变量 {{${ref}}}` })
      else if (!anc.has(root) && bodyOf.get(root) === bodyOf.get(n.id)) {
        errors.push({ code: 'VAR_UNREACHABLE', node: n.id, message: `节点 ${n.id} 引用非上游节点 {{${ref}}}` })
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings }
}
```

同时改 `loadWorkflow` / `parseWorkflowFile`：加载后走 `normalizeWorkflow` 并挂 `dslVersion`，
`discoverWorkflows` 的条目增 `dslVersion` 与 `legacy`（`!Array.isArray(parsed.edges)`）两个字段。

- [ ] **Step 5: `kernel/workflow.mjs` 改为薄 re-export 层**

删除已搬走的函数体，文件头改为：

```js
// kernel/workflow.mjs —— 兼容 re-export 层（实现见 workflow-dsl/dag/nodes/engine）
// 保持既有 import 面不变：cli.mjs / tools.mjs / kernel-tests 无需改动。
export {
  DSL_VERSION, parseYaml, renderTemplate, resolvePath, evalCondition,
  discoverWorkflows, discoverWorkflowsAll, matchAutoTrigger, loadWorkflow,
  normalizeWorkflow, validateWorkflow, migrateLegacy,
} from './workflow-dsl.mjs'
export { createWorkflowEngine, verifyRun } from './workflow-engine.mjs'
```

（`migrateLegacy` / `createWorkflowEngine` / `verifyRun` 在 Task 2/5 落地；本步先只 re-export 已完成项，
Task 2 与 Task 5 各自补上对应行，保证每步测试都能跑。）

- [ ] **Step 6: 运行测试，确认通过**

Run: `node --test kernel-tests/workflow-dsl.test.mjs`
Expected: PASS（4 个 test 全绿）

- [ ] **Step 7: 回归 —— 既有工作流测试仍可导入**

Run: `node --test kernel-tests/workflow-specdev.test.mjs`
Expected: FAIL（此时 spec-dev 仍是旧格式，属预期）；关键是**不得**出现 `Cannot find module` 或 `discoverWorkflows is not a function` —— 若出现即为 re-export 遗漏，必须先修。

- [ ] **Step 8: Commit**

```bash
git add kernel/workflow-dsl.mjs kernel/workflow.mjs kernel-tests/workflow-dsl.test.mjs
git commit -m "feat(workflow): DSL v2 模块拆分 + edges 校验器（LEGACY_DSL/CYCLE/BODY_ESCAPE/VAR_*）"
```

---

### Task 2: 旧格式迁移器

**Files:**
- Modify: `kernel/workflow-dsl.mjs`（追加 `migrateLegacy`）
- Modify: `kernel/workflow.mjs`（re-export 补 `migrateLegacy`）
- Test: `kernel-tests/workflow-migrate.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `normalizeWorkflow` / `validateWorkflow`
- Produces: `migrateLegacy(wf) → { workflow, notes: string[] }`（`workflow.edges` 已生成、旧 `next*` 字段已删、`trigger_config` 已收敛）

- [ ] **Step 1: 写失败测试**

创建 `kernel-tests/workflow-migrate.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { migrateLegacy, validateWorkflow } from '../kernel/workflow-dsl.mjs'

const LEGACY = {
  name: 'old', schedule: '0 18 * * 5', auto_trigger: true, triggers: ['日报'],
  nodes: [
    { id: 'start', type: 'start', next: 'gate' },
    { id: 'gate', type: 'if', conditions: [{ var: 'inputs.n', op: '>', value: 3 }], next_true: 'big', next_false: 'small' },
    { id: 'big', type: 'llm', prompt: '大' },
    { id: 'small', type: 'llm', prompt: '小' },
    { id: 'out', type: 'end', outputs: [{ name: 'r', selector: '{{big}}' }] },
  ],
}

test('迁移：数组顺序补边 + if 双分支条件边 + 旧字段清理', () => {
  const { workflow, notes } = migrateLegacy(LEGACY)
  const byPair = workflow.edges.map((e) => `${e.source}->${e.target}${e.sourceHandle ? ':' + e.sourceHandle : ''}`)
  assert.ok(byPair.includes('start->gate'), `顺序边缺失：${byPair}`)
  assert.ok(byPair.includes('gate->big:true'), `true 分支缺失：${byPair}`)
  assert.ok(byPair.includes('gate->small:false'), `false 分支缺失：${byPair}`)
  assert.ok(byPair.includes('big->out'), `big 顺序补边缺失：${byPair}`)
  assert.ok(byPair.includes('small->out'), `small 顺序补边缺失：${byPair}`)
  assert.equal(workflow.nodes.some((n) => 'next' in n || 'next_true' in n || 'next_false' in n), false)
  assert.ok(notes.length >= 3)
  assert.deepEqual(validateWorkflow(workflow).errors, [], '迁移结果必须自校验通过')
})

test('迁移：schedule/auto_trigger 收敛进 trigger_config 并删原字段', () => {
  const { workflow } = migrateLegacy(LEGACY)
  assert.equal(workflow.trigger_config.schedule, '0 18 * * 5')
  assert.equal(workflow.trigger_config.auto_trigger, true)
  assert.equal(workflow.schedule, undefined)
  assert.equal(workflow.auto_trigger, undefined)
})

test('迁移：classify routes → route:<i> 条件边', () => {
  const { workflow } = migrateLegacy({
    nodes: [
      { id: 'start', type: 'start', next: 'c' },
      { id: 'c', type: 'classify', classes: ['甲', '乙'], routes: ['a', 'b'] },
      { id: 'a', type: 'llm', prompt: 'A' },
      { id: 'b', type: 'llm', prompt: 'B' },
      { id: 'e', type: 'end' },
    ],
  })
  const pairs = workflow.edges.map((x) => `${x.source}->${x.target}${x.sourceHandle ? ':' + x.sourceHandle : ''}`)
  assert.ok(pairs.includes('c->a:route:0'), pairs.join(','))
  assert.ok(pairs.includes('c->b:route:1'), pairs.join(','))
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test kernel-tests/workflow-migrate.test.mjs`
Expected: FAIL — `migrateLegacy is not a function`

- [ ] **Step 3: 实现 `migrateLegacy`**

追加到 `kernel/workflow-dsl.mjs`：

```js
const EDGE_ID = (source, target, handle, n) => `e${n}_${source}_${target}${handle ? '_' + String(handle).replace(/[^\w]/g, '') : ''}`

// 旧 DSL（数组顺序 + next/next_true/next_false + 平铺 schedule/auto_trigger）→ DSL v2。
// 确定性规则，不改节点语义；返回 notes 供 GUI 展示迁移明细。
export function migrateLegacy(input) {
  const wf = normalizeWorkflow(input)
  const nodes = wf.nodes || []
  const notes = []
  const edges = []
  let seq = 0
  const push = (source, target, handle) => {
    if (!source || !target) return
    if (!nodes.some((n) => n.id === source) || !nodes.some((n) => n.id === target)) return
    if (edges.some((e) => e.source === source && e.target === target && e.sourceHandle === handle)) return
    edges.push({ id: EDGE_ID(source, target, handle, ++seq), source, target, ...(handle ? { sourceHandle: String(handle) } : {}) })
  }
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    const fallthrough = nodes[i + 1]?.id
    if (n.type === 'if') {
      if (n.next_true) push(n.id, n.next_true, 'true')
      if (n.next_false) push(n.id, n.next_false, 'false')
      notes.push(`if 节点 ${n.id}：next_true/next_false → 条件边 true/false`)
      continue
    }
    if (n.type === 'classify' && Array.isArray(n.routes)) {
      n.routes.forEach((t, idx) => push(n.id, t, `route:${idx}`))
      notes.push(`classify 节点 ${n.id}：routes → 条件边 route:0..${n.routes.length - 1}`)
      continue
    }
    if (n.next) {
      push(n.id, n.next)
      notes.push(`节点 ${n.id}：next → 显式边`)
      continue
    }
    if (fallthrough && n.type !== 'end' && n.type !== 'answer') {
      push(n.id, fallthrough)
      notes.push(`节点 ${n.id}：按数组顺序补边 → ${fallthrough}`)
    }
  }
  const cleaned = nodes.map((n) => {
    const { next, next_true, next_false, ...rest } = n
    return rest
  })
  const trigger_config = {
    manual: true,
    ...(wf.trigger_config || {}),
    ...(wf.schedule ? { schedule: wf.schedule } : {}),
    ...(wf.auto_trigger !== undefined ? { auto_trigger: wf.auto_trigger } : {}),
  }
  const { schedule, auto_trigger, ...restWf } = wf
  if (schedule) notes.push(`schedule → trigger_config.schedule（${schedule}）`)
  if (auto_trigger !== undefined) notes.push(`auto_trigger → trigger_config.auto_trigger`)
  return { workflow: { ...restWf, trigger_config, nodes: cleaned, edges }, notes }
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `node --test kernel-tests/workflow-migrate.test.mjs`
Expected: PASS（3 个 test 全绿）

- [ ] **Step 5: Commit**

```bash
git add kernel/workflow-dsl.mjs kernel/workflow.mjs kernel-tests/workflow-migrate.test.mjs
git commit -m "feat(workflow): 旧 DSL 迁移器（顺序补边/条件边/route 边/trigger_config 收敛）"
```

---

### Task 3: DAG 调度器

**Files:**
- Create: `kernel/workflow-dag.mjs`
- Test: `kernel-tests/workflow-dag.test.mjs`

**Interfaces:**
- Consumes: `kernel/workflow-dsl.mjs`（`resolvePath` / `detectCycle`）
- Produces:
  - `buildGraph(nodes, edges) → { byId, incoming, outgoing }`
  - `schedule({ nodes, edges, inputs, runId, executeNode, maxParallel, signal, onSettle, onEdge }) → Promise<{ ok, status, settled, steps, error, node }>`
  - `executeNode(node, ctx) → Promise<{ ok, output?, route?, error?, dur_ms? }>`（由调用方注入；`route` 为 `'true'|'false'|'route:<i>'`）
  - `settled` 结构：`Map<nodeId, { ok, skipped, output, error, dur_ms }>`

- [ ] **Step 1: 写失败测试**

创建 `kernel-tests/workflow-dag.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { schedule } from '../kernel/workflow-dag.mjs'

// 通用执行器桩：按 node.id 返回 { ok, output, route }
function stub(map, log) {
  return async (node) => {
    log.push(node.id)
    const r = map[node.id]
    if (typeof r === 'function') return r(node)
    return r ?? { ok: true, output: node.id, dur_ms: 1 }
  }
}

const N = (id, extra = {}) => ({ id, type: 'llm', ...extra })
const E = (source, target, handle) => ({ id: `e_${source}_${target}${handle || ''}`, source, target, ...(handle ? { sourceHandle: handle } : {}) })

test('多入边 join：等待所有入边 settle 才执行一次', async () => {
  const log = []
  const nodes = [N('a'), N('b'), N('c')]
  const edges = [E('a', 'c'), E('b', 'c')]
  const r = await schedule({ nodes, edges, executeNode: stub({}, log), maxParallel: 4 })
  assert.equal(r.ok, true)
  assert.equal(log.filter((x) => x === 'c').length, 1, 'c 只执行一次')
  assert.ok(log.indexOf('c') > log.indexOf('a') && log.indexOf('c') > log.indexOf('b'), `c 应在 a/b 之后：${log}`)
})

test('并行：同批无依赖节点并发执行（maxParallel 限制）', async () => {
  let peak = 0; let cur = 0
  const nodes = [N('a'), N('b'), N('c'), N('d')]
  const edges = []
  const exec = async () => {
    cur++; peak = Math.max(peak, cur)
    await new Promise((r) => setTimeout(r, 20))
    cur--
    return { ok: true, output: 1 }
  }
  await schedule({ nodes, edges, executeNode: exec, maxParallel: 2 })
  assert.ok(peak <= 2, `并发不得超过 2，实测 ${peak}`)
  assert.equal(peak, 2, '应真正并行（而非串行）')
})

test('条件边：if 命中 true → false 分支被跳过并向下游传播跳过', async () => {
  const log = []
  const nodes = [N('g'), N('t'), N('f'), N('after')]
  const edges = [E('g', 't', 'true'), E('g', 'f', 'false'), E('f', 'after')]
  const r = await schedule({
    nodes, edges,
    executeNode: stub({ g: { ok: true, output: { pass: true }, route: 'true' } }, log),
  })
  assert.equal(r.ok, true)
  assert.ok(log.includes('t'))
  assert.equal(log.includes('f'), false, 'false 分支不执行')
  assert.equal(log.includes('after'), false, '仅依赖被跳过入边的节点也应跳过')
  assert.equal(r.settled.get('f').skipped, true)
  assert.equal(r.settled.get('after').skipped, true)
})

test('错误边：on_error=branch 失败 → 只走 fail 边；未配 fail 边则整 run 失败', async () => {
  const log = []
  const nodes = [N('x', { retry: { max: 0, on_error: 'branch' } }), N('ok'), N('bad')]
  const edges = [E('x', 'ok'), E('x', 'bad', 'fail')]
  const r = await schedule({ nodes, edges, executeNode: stub({ x: { ok: false, error: 'boom' } }, log) })
  assert.equal(r.ok, true, `有 fail 分支时不应整体失败：${r.error}`)
  assert.equal(log.includes('bad'), true)
  assert.equal(log.includes('ok'), false)

  const r2 = await schedule({ nodes, edges, executeNode: stub({ x: { ok: false, error: 'boom' } }, log) })
  assert.equal(r2.ok, true)
  const r3 = await schedule({ nodes, edges: [E('x', 'ok')], executeNode: stub({ x: { ok: false, error: 'boom' } }, log) })
  assert.equal(r3.ok, false)
  assert.equal(r3.node, 'x')
})

test('retry：失败重试 max 次后成功；耗尽仍失败则按 on_error 收尾', async () => {
  let calls = 0
  const nodes = [N('r', { retry: { max: 2, delay_ms: 1 } })]
  const r = await schedule({
    nodes, edges: [],
    executeNode: async () => { calls++; return calls < 3 ? { ok: false, error: 'e' } : { ok: true, output: 'done' } },
  })
  assert.equal(calls, 3, `应尝试 3 次（1 初始 + 2 重试），实测 ${calls}`)
  assert.equal(r.settled.get('r').output, 'done')
})

test('skip 传播后仍可达的节点照常执行；signal 取消立即停止', async () => {
  const log = []
  const nodes = [N('g'), N('f'), N('t'), N('after')]
  const edges = [E('g', 'f', 'true'), E('g', 't', 'false'), E('t', 'after'), E('f', 'after')]
  const r = await schedule({
    nodes, edges,
    executeNode: stub({ g: { ok: true, route: 'false' } }, log),
  })
  assert.equal(r.ok, true)
  assert.ok(log.includes('after'), `after 有一条 active 入边（t→after），应执行：${log}`)

  const signal = { aborted: false }
  const p = schedule({
    nodes: [N('long')],
    edges: [],
    signal,
    executeNode: async () => { signal.aborted = true; return { ok: true, output: 1 } },
  })
  const r2 = await p
  assert.equal(r2.status, 'cancelled')
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test kernel-tests/workflow-dag.test.mjs`
Expected: FAIL — `Cannot find module '../kernel/workflow-dag.mjs'`

- [ ] **Step 3: 实现 `kernel/workflow-dag.mjs`**

```js
// kernel/workflow-dag.mjs —— 就绪集合调度器（edges 即真相）
// 语义：① 节点在其全部入边 settle 且至少一条 active 时可执行，执行一次；
//      ② 条件边：源节点 route → 命中 handle 的边 active，其余 skipped；
//      ③ 入边全 skipped 的节点 skipped 并向其出边传播；
//      ④ on_error=branch 的失败节点走 'fail' handle；
//      ⑤ 节点级 retry 在调度器内做退避重试（不改节点实现）。
// 子图（loop/iterate body）由节点执行器递归调用本函数，作用域 = body 成员集合。
import { resolvePath } from './workflow-dsl.mjs'

export function buildGraph(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const incoming = new Map(nodes.map((n) => [n.id, []]))
  const outgoing = new Map(nodes.map((n) => [n.id, []]))
  for (const e of edges || []) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue
    outgoing.get(e.source).push(e)
    incoming.get(e.target).push(e)
  }
  return { byId, incoming, outgoing }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 出边激活：无 sourceHandle 的源节点 → 成功时全部 active；有 handle → 按 route 命中。
function activateOutgoing(node, result, outgoing, edgeState) {
  const outs = outgoing.get(node.id) || []
  const branching = outs.some((e) => e.sourceHandle)
  for (const e of outs) {
    if (!branching) { edgeState.set(e.id, result.ok ? 'active' : 'skipped'); continue }
    const h = e.sourceHandle
    let active
    if (!result.ok) active = h === 'fail'
    else if (h === 'fail') active = false
    else if (h === 'true' || h === 'false') active = String(result.route || '') === h
    else active = String(result.route || '') === h || h === 'default'
    edgeState.set(e.id, active ? 'active' : 'skipped')
  }
}

async function runWithRetry(node, ctx) {
  const retry = node.retry || {}
  const max = Math.max(0, Number(retry.max || 0))
  const base = Math.max(0, Number(retry.delay_ms || 0))
  const onError = retry.on_error || 'fail'   // fail | branch | continue
  let last
  for (let attempt = 0; attempt <= max; attempt++) {
    if (ctx.signal?.aborted) return { ok: false, error: 'cancelled', cancelled: true }
    last = await ctx.executeNode(node, ctx)
    if (last?.ok) return last
    if (attempt < max) await sleep(Math.min(base * Math.pow(2, attempt), 30_000))
  }
  return { ...last, onError }
}

export async function schedule({ nodes, edges, inputs = {}, runId = '', executeNode, maxParallel = 4, signal = { aborted: false }, onSettle, onEdge, ctxExtra = {} }) {
  const { byId, incoming, outgoing } = buildGraph(nodes, edges || [])
  const settled = new Map()
  const edgeState = new Map()   // edgeId -> 'active'|'skipped'
  const order = nodes.map((n) => n.id)
  const stepsLimit = Math.max(500, nodes.length * 50)
  let steps = 0

  const settleEdgesOf = (nodeId, result) => {
    activateOutgoing(byId.get(nodeId), result, outgoing, edgeState)
    for (const e of outgoing.get(nodeId) || []) onEdge?.({ edge: e.id, state: edgeState.get(e.id) })
  }

  while (true) {
    if (signal.aborted) return { ok: false, status: 'cancelled', settled, steps, error: '已取消' }
    const pending = order.filter((id) => !settled.has(id))
    if (!pending.length) break
    const ready = pending.filter((id) => {
      const ins = incoming.get(id)
      if (!ins.length) return true                                   // 源节点（含 start）
      if (!ins.every((e) => edgeState.has(e.id))) return false        // 入边未全 settle
      return ins.some((e) => edgeState.get(e.id) === 'active')
    })
    const skipped = pending.filter((id) => {
      const ins = incoming.get(id)
      if (!ins.length) return false
      if (!ins.every((e) => edgeState.has(e.id))) return false
      return ins.every((e) => edgeState.get(e.id) === 'skipped')
    })
    if (!ready.length && !skipped.length) {
      return { ok: false, status: 'failed', settled, steps, error: '调度死锁：存在无法就绪也无法跳过的节点' }
    }
    for (const id of skipped) {
      const r = { ok: true, skipped: true, output: undefined }
      settled.set(id, r)
      settleEdgesOf(id, { ok: true, skipped: true })
      onSettle?.({ node: id, ...r })
    }
    for (let i = 0; i < ready.length; i += maxParallel) {
      if (signal.aborted) return { ok: false, status: 'cancelled', settled, steps, error: '已取消' }
      const batch = ready.slice(i, i + maxParallel)
      const results = await Promise.all(batch.map(async (id) => {
        const node = byId.get(id)
        const r = await runWithRetry(node, { ...ctxExtra, executeNode, signal, runId, inputs, settled })
        return { id, r }
      }))
      for (const { id, r } of results) {
        steps++
        if (steps > stepsLimit) return { ok: false, status: 'failed', settled, steps, error: '执行步数超限' }
        const rec = { ok: !!r.ok, skipped: false, output: r.output, route: r.route, error: r.ok ? undefined : (r.error || '节点失败'), dur_ms: r.dur_ms || 0 }
        settled.set(id, rec)
        settleEdgesOf(id, rec)
        onSettle?.({ node: id, ...rec })
        const onError = byId.get(id).retry?.on_error || 'fail'
        const hardFail = !rec.ok && (onError === 'fail')
        if (hardFail) return { ok: false, status: 'failed', settled, steps, error: rec.error, node: id }
      }
    }
  }
  return { ok: true, status: 'completed', settled, steps }
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `node --test kernel-tests/workflow-dag.test.mjs`
Expected: PASS（6 个 test 全绿）

- [ ] **Step 5: Commit**

```bash
git add kernel/workflow-dag.mjs kernel-tests/workflow-dag.test.mjs
git commit -m "feat(workflow): DAG 就绪集合调度器（join/并行/条件边/错误边/重试/跳过传播/取消）"
```

---

### Task 4: 节点执行器与新增节点

**Files:**
- Create: `kernel/workflow-nodes.mjs`
- Modify: `kernel/workflow.mjs`（暂不改，Task 5 统一补）
- Test: `kernel-tests/workflow-nodes.test.mjs`

**Interfaces:**
- Consumes: `kernel/workflow-dsl.mjs`（`renderTemplate` / `resolvePath` / `evalCondition`）；Task 3 的 `schedule`（供 `loop`/`iterate` 子图递归）
- Produces:
  - `export function createNodeExecutor({ registry, getModel, memoryRoot, engine }) → executeNode(node, ctx)`
  - `executeNode(node, ctx) → Promise<{ ok, output?, route?, error?, dur_ms }>`（**归一化包装**，抛错自动转 `{ok:false,error}`，与现有 `executeNode` 行为一致）
  - 分支节点的 `route`：`if` → `'true'|'false'`；`classify` → `'route:<i>'`
  - 子图支持：`loop`/`iterate` 的 `ctx.runBody(bodyIds)` 由 `createNodeExecutor` 内部实现（复用 `schedule`）

- [ ] **Step 1: 写失败测试**

创建 `kernel-tests/workflow-nodes.test.mjs`：

```js
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNodeExecutor } from '../kernel/workflow-nodes.mjs'
import { createToolRegistry } from '../kernel/tools.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function mkExec(over = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wf-nodes-'))
  const registry = createToolRegistry({ cwd: root, addDirs: [root], skipPermissions: true })
  const exec = createNodeExecutor({ registry, getModel: () => 'mock-model', ...over })
  return { exec, root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('if 节点返回 route=true/false（不再返回 next）', async () => {
  const { exec, cleanup } = mkExec()
  try {
    const a = await exec({ id: 'g', type: 'if', conditions: [{ var: 'inputs.n', op: '>', value: 3 }] }, { inputs: { n: 5 }, vars: {}, var: {} })
    assert.equal(a.ok, true)
    assert.equal(a.route, 'true')
    const b = await exec({ id: 'g', type: 'if', conditions: [{ var: 'inputs.n', op: '>', value: 3 }] }, { inputs: { n: 1 }, vars: {}, var: {} })
    assert.equal(b.route, 'false')
  } finally { cleanup() }
})

test('template/assign/aggregate/list/join 纯计算节点', async () => {
  const { exec, cleanup } = mkExec()
  try {
    const t = await exec({ id: 't', type: 'template', template: '你好 {{inputs.name}}' }, { inputs: { name: '远方' }, vars: {}, var: {} })
    assert.equal(t.output, '你好 远方')

    const ctx = { inputs: {}, vars: { a: { x: 1 } }, var: {} }
    const asg = await exec({ id: 's', type: 'assign', items: [{ variable: 'k', value: '{{a.x}}' }] }, ctx)
    assert.equal(asg.output.k, 1)
    assert.equal(ctx.var.k, 1)

    const agg = await exec({ id: 'g', type: 'aggregate', variables: [{ selector: '{{a.x}}' }], output_type: 'string' }, ctx)
    assert.equal(agg.output, '1')

    const lst = await exec({ id: 'l', type: 'list', variable: '{{a}}' }, { inputs: {}, vars: { a: [3, 1, 2] }, var: {} , listRef: true })
    assert.deepEqual(lst.output, [3, 1, 2])

    const jn = await exec({ id: 'j', type: 'join', mode: 'concat', separator: ' | ' }, { inputs: {}, vars: { p: '甲', q: '乙' }, var: {}, joinSelectors: ['{{p}}', '{{q}}'] })
    assert.equal(String(jn.output).includes('甲'), true)
  } finally { cleanup() }
})

test('join 节点按 config.mode 聚合多分支（array/concat/first）', async () => {
  const { exec, cleanup } = mkExec()
  try {
    const ctx = { inputs: {}, vars: {}, var: {} }
    const node = { id: 'j', type: 'join', mode: 'array', sources: ['{{a}}', '{{b}}'] }
    ctx.vars = { a: 'A', b: 'B' }
    const r = await exec(node, ctx)
    assert.deepEqual(r.output, ['A', 'B'])
  } finally { cleanup() }
})

test('subworkflow 深度上限防自递归', async () => {
  let calls = 0
  const { exec, cleanup } = mkExec({
    engine: {
      run: async () => { calls++; return { ok: true, outputs: { done: true } } },
    },
  })
  try {
    const deep = await exec({ id: 's', type: 'subworkflow', workflow: 'other' }, { inputs: {}, vars: {}, var: {}, depth: 5 })
    assert.equal(deep.ok, false)
    assert.match(String(deep.error), /深度/)
    const okRun = await exec({ id: 's', type: 'subworkflow', workflow: 'other' }, { inputs: {}, vars: {}, var: {}, depth: 1 })
    assert.equal(okRun.ok, true)
    assert.equal(calls, 1)
  } finally { cleanup() }
})

test('answer 节点：输出 answer 文本并标记为终端节点', async () => {
  const { exec, cleanup } = mkExec()
  try {
    const r = await exec({ id: 'a', type: 'answer', template: '结论：{{x}}' }, { inputs: {}, vars: { x: 'OK' }, var: {} })
    assert.equal(r.ok, true)
    assert.equal(r.output.answer, '结论：OK')
  } finally { cleanup() }
})

test('loop 子图：runBody 由调度器递归执行，break 条件命中即提前结束', async () => {
  const { exec, cleanup } = mkExec()
  try {
    const ctx = {
      inputs: {}, vars: {}, var: {}, depth: 0,
      childNodes: [{ id: 'b1', type: 'template', template: '第{{iter}}轮' }],
      childEdges: [],
    }
    const r = await exec({ id: 'lp', type: 'loop', count: 3, body: ['b1'], break_conditions: [{ var: 'b1', op: 'contains', value: '第1轮' }] }, ctx)
    assert.equal(r.ok, true)
    assert.equal(r.output.iterations, 2, `第 1 轮后 break 应命中（含 break 检查发生在轮末）：${JSON.stringify(r.output)}`)
  } finally { cleanup() }
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test kernel-tests/workflow-nodes.test.mjs`
Expected: FAIL — `Cannot find module '../kernel/workflow-nodes.mjs'`

- [ ] **Step 3: 平移既有节点实现到 `kernel/workflow-nodes.mjs`**

从 `kernel/workflow.mjs:303-768` **原样剪切**：`sleep`、`callLLMText`、`runAgentLoop`、`execLLM`、
`execClassify`、`execExtract`、`execMemory`、`execStore`、`execCode`、`execTemplate`、`execIf`、
`execAssign`、`execAggregate`、`execHttp`、`parseHeaderLines`、`checkToolPermission`、`execDocument`、
`execTool`、`execList`、`executeNode`（switch）。改为导出一个工厂：

```js
export function createNodeExecutor({ registry, getModel = () => '', memoryRoot = '', engine = null }) {
  // …此处放入平移来的各 execXxx（把对模块级 registry/getModel/memoryRoot 的引用
  //   换成闭包变量；checkToolPermission 的 ctx.permissionGate 语义不变）…

  return async function executeNode(node, ctx) { /* 原 executeNode 的 switch，改为： */ }
}
```

关键改动点（其余逐字保留）：

1. `execIf` 返回 `{ output: { pass }, route: pass ? 'true' : 'false' }`（**删掉 next 字段**）。
2. `execClassify` 返回 `{ output: {...}, route: routeIdx != null ? 'route:' + idx : 'default' }`（删 `next`）。
3. 所有 `execXxx` 的返回中 `next: node.next` 一律删除（调度由 edges 决定）。
4. `loop`/`iterate` 的 body 执行改为调用注入的 `ctx.runBody(node.body)`；`createNodeExecutor` 内部用 `schedule` 实现：

```js
  async function runBody(ctx, bodyIds, extraVars = {}) {
    const nodes = bodyIds.map((id) => ctx.childNodes.find((n) => n.id === id)).filter(Boolean)
    const edges = (ctx.childEdges || []).filter((e) => bodyIds.includes(e.source) && bodyIds.includes(e.target))
    const r = await schedule({
      nodes, edges, inputs: ctx.inputs, runId: ctx.runId, signal: ctx.signal,
      maxParallel: ctx.maxParallel ?? 4,
      executeNode: (n, sub) => executeNode(n, { ...ctx, ...sub, vars: { ...ctx.vars, ...extraVars }, var: ctx.var }),
      onSettle: (s) => ctx.onNodeSettled?.({ ...s, in_body: true }),
      onEdge: (s) => ctx.onEdge?.({ ...s, in_body: true }),
    })
    const lastId = [...r.settled.keys()].pop()
    return { ok: r.ok, output: r.settled.get(lastId)?.output, settled: r.settled, iterations: r.steps }
  }
```

5. `iterate` / `loop` 调用 `runBody(ctx, node.body, { item, index } | { iter: i, index: i })`。

- [ ] **Step 4: 新增四个节点类型**

在 switch 中追加：

```js
      case 'join': {
        const mode = node.mode || 'concat'
        const sels = node.sources || []
        const vals = sels.map((s) => resolvePath(ctx.vars, s))
        result = {
          output: mode === 'array' ? vals : mode === 'first' ? (vals[0] ?? null) : vals.map((v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))).join(node.separator ?? '\n'),
        }
        break
      }
      case 'answer': {
        const text = node.template ? renderTemplate(node.template, ctx.vars) : String(resolvePath(ctx.vars, node.value || '') ?? '')
        result = { output: { answer: text, ...(node.variable ? { [node.variable]: text } : {}) } }
        break
      }
      case 'subworkflow': {
        const depth = Number(ctx.depth || 0)
        if (depth >= 5) throw new Error('subworkflow 调用深度超限（>=5，疑似递归）')
        if (!engine?.run) throw new Error('subworkflow 节点不可用：引擎未注入')
        const wid = renderTemplate(String(node.workflow || ''), ctx.vars)
        const sub = {}
        for (const [k, v] of Object.entries(node.inputs || {})) sub[k] = typeof v === 'string' ? renderTemplate(v, ctx.vars) : v
        const r = await engine.run({ id: wid, inputs: sub, depth: depth + 1 })
        if (!r.ok) throw new Error(`子工作流 ${wid} 失败: ${r.error}`)
        result = { output: r.outputs ?? {} }
        break
      }
```

`executeNode` 的归一化包装（保留现有 try/catch 语义）：

```js
  return async function executeNode(node, ctx) {
    const t0 = Date.now()
    try {
      const r = await dispatch(node, ctx)          // 上面的 switch 体
      return { ok: true, ...r, dur_ms: Date.now() - t0 }
    } catch (err) {
      return { ok: false, error: err?.message || String(err), dur_ms: Date.now() - t0 }
    }
  }
```

`engine` 由 Task 5 的 `createWorkflowEngine` 注入（`engine: { run } `）；`ctx.depth` 由引擎在 subworkflow 调用时透传。

- [ ] **Step 5: 运行测试，确认通过**

Run: `node --test kernel-tests/workflow-nodes.test.mjs`
Expected: PASS（6 个 test 全绿）

- [ ] **Step 6: Commit**

```bash
git add kernel/workflow-nodes.mjs kernel-tests/workflow-nodes.test.mjs
git commit -m "feat(workflow): 节点执行器独立成模块 + join/answer/subworkflow/route 语义"
```

---

### Task 5: 引擎装配（审计 / 事件 / 调度接线 / stop）

**Files:**
- Create: `kernel/workflow-engine.mjs`
- Modify: `kernel/workflow.mjs`（re-export 补 `createWorkflowEngine` / `verifyRun`）
- Test: `kernel-tests/workflow-engine.test.mjs`

**Interfaces:**
- Consumes: Task 1（dsl）、Task 3（`schedule`）、Task 4（`createNodeExecutor`）
- Produces:
  - `createWorkflowEngine({ configDir, registry, onEvent, getModel, signal, memoryRoot }) → engine`
  - `engine.run({ id, inputs, mode, depth, runId }) → Promise<{ ok, status, outputs, steps, error, node, runId, auditPath, settled }>`
  - `engine.stop(runId) → { ok }`、`engine.setDeps(deps)`、`engine.addRoot(root)`、`engine.discover(root)`、`engine.load(id)`、`engine.verify(path)`、`engine.resolveConfirm(runId, nodeId, {action, comment})`、`engine.startScheduler({onRun})`、`engine.createWebhookServer()`、`engine.cronMatches(expr, date)`
  - `verifyRun(auditPath) → { ok, lines, tampered, lastHash }`
  - 新增事件：`{ type:'node', ..., route }`（既有）、`{ type:'edge_taken', runId, edge, state }`、`{ type:'node_skipped', runId, node }`、`{ type:'end', status:'cancelled' }`

- [ ] **Step 1: 写失败测试**

创建 `kernel-tests/workflow-engine.test.mjs`：

```js
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkflowEngine, verifyRun } from '../kernel/workflow-engine.mjs'
import { createToolRegistry } from '../kernel/tools.mjs'

const WF = `name: demo
version: 1.0.0
inputs:
  - { name: n, type: number, required: true }
nodes:
  - { id: start, type: start }
  - { id: g, type: if, conditions: [{ var: "inputs.n", op: ">", value: 3 }] }
  - { id: big, type: template, template: "大 {{inputs.n}}" }
  - { id: small, type: template, template: "小 {{inputs.n}}" }
  - { id: done, type: end, config: { outputs: [{ name: result, selector: "{{big}}" }] } }
edges:
  - { id: e1, source: start, target: g }
  - { id: e2, source: g, target: big, sourceHandle: "true" }
  - { id: e3, source: g, target: small, sourceHandle: "false" }
  - { id: e4, source: big, target: done }
  - { id: e5, source: small, target: done }
`

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'wf-eng-'))
  mkdirSync(join(root, 'wf', 'demo'), { recursive: true })
  writeFileSync(join(root, 'wf', 'demo', 'workflow.yml'), WF, 'utf-8')
  const registry = createToolRegistry({ cwd: root, addDirs: [root], skipPermissions: true })
  const engine = createWorkflowEngine({ configDir: root, registry, getModel: () => 'mock-model' })
  engine.addRoot(join(root, 'wf'))
  return { root, engine, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('DAG 运行：条件分支 + end 输出聚合 + 审计落盘可校验', async () => {
  const { root, engine, cleanup } = setup()
  try {
    const events = []
    engine.setDeps({ onEvent: (ev) => events.push(ev) })
    const r = await engine.run({ id: 'demo', inputs: { n: 5 } })
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300))
    assert.equal(r.outputs.done.output.result, '大 5')
    const skipped = events.filter((e) => e.type === 'node' && e.status === 'skipped').map((e) => e.node)
    assert.ok(skipped.includes('small'), `small 应被跳过：${JSON.stringify(events.map((e) => [e.type, e.node, e.status]))}`)
    assert.ok(events.some((e) => e.type === 'edge_taken'), 'edge_taken 事件缺失')
    assert.ok(r.auditPath && readFileSync(r.auditPath, 'utf-8').trim().split('\n').length >= 4, '审计应逐节点落盘')
    assert.equal(verifyRun(r.auditPath).ok, true, '哈希链应可校验')
  } finally { cleanup() }
})

test('非法工作流：校验失败即拒绝运行并给出 code', async () => {
  const { root, engine, cleanup } = setup()
  try {
    writeFileSync(join(root, 'wf', 'bad', 'workflow.yml').replace(/bad/, 'bad'), '', 'utf-8')
    mkdirSync(join(root, 'wf', 'bad'), { recursive: true })
    writeFileSync(join(root, 'wf', 'bad', 'workflow.yml'), 'name: bad\nnodes:\n  - { id: a, type: start }\n', 'utf-8')
    const r = await engine.run({ id: 'bad', inputs: {} })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'LEGACY_DSL')
  } finally { cleanup() }
})

test('stop：运行中取消 → status=cancelled 且发 end(cancelled)', async () => {
  const { root, engine, cleanup } = setup()
  try {
    const events = []
    engine.setDeps({ onEvent: (e) => events.push(e) })
    const p = engine.run({ id: 'demo', inputs: { n: 1 }, runId: 'run-x' })
    engine.stop('run-x')
    const r = await p
    assert.equal(r.status, 'cancelled')
    assert.ok(events.some((e) => e.type === 'end' && e.status === 'cancelled'))
  } finally { cleanup() }
})

test('cron 匹配与调度器回调（不依赖真实定时器）', async () => {
  const { engine, cleanup } = setup()
  try {
    assert.equal(engine.cronMatches('0 18 * * 5', new Date('2026-09-11T18:00:00')), true)
    assert.equal(engine.cronMatches('0 18 * * 5', new Date('2026-09-11T19:00:00')), false)
  } finally { cleanup() }
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test kernel-tests/workflow-engine.test.mjs`
Expected: FAIL — `Cannot find module '../kernel/workflow-engine.mjs'`

- [ ] **Step 3: 平移审计与调度器外围代码**

从 `kernel/workflow.mjs:170-201`（`sha256` / `auditAppend` / `verifyRun`）与
`kernel/workflow.mjs:770-1037`（`createWorkflowEngine` 全量）剪切到 `kernel/workflow-engine.mjs`，`export verifyRun`
与 `createWorkflowEngine`。

- [ ] **Step 4: 改写 `run()` 为调度器接线**

```js
  async function run({ id, inputs = {}, mode = 'sync', depth = 0, runId: presetRunId } = {}) {
    const wf = loadWorkflow({ roots, id })
    if (!wf) return { ok: false, error: `工作流不存在: ${id}` }
    const v = validateWorkflow(wf)
    if (!v.ok) {
      return { ok: false, error: `工作流校验失败: ${v.errors.map((e) => e.code).join(', ')}`, code: v.errors[0]?.code, errors: v.errors }
    }
    const runId = presetRunId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const auditPath = _configDir ? join(_configDir, 'workflow-runs', wf.name || id, `${ts}-${runId}.jsonl`) : ''
    const vars = { inputs: { ...inputs }, var: {}, root: {} }
    const auditState = { path: auditPath, prev: '-' }
    const runSignal = { get aborted() { return _signal.aborted || cancelledRuns.has(runId) } }
    const ctx = {
      inputs, vars, var: vars.var, nodes: new Map(wf.nodes.map((n) => [n.id, n])),
      childNodes: wf.nodes, childEdges: wf.edges, registry: _registry, signal: runSignal,
      getModel: _getModel, memoryRoot: _memoryRoot, runId, depth, maxParallel,
      event, confirmWaiters: { create: createConfirmWaiter }, permissionGate: _permissionGate,
      getToolCtx: _getToolCtx, nodeRuns: {},
    }
    event('start', { runId, workflow: wf.name || id, nodes: wf.nodes.length, mode })
    const r = await schedule({
      nodes: wf.nodes, edges: wf.edges, inputs, runId, signal: runSignal, maxParallel,
      executeNode: (node, sub) => nodeExecutor(node, { ...ctx, ...sub }),
      onSettle: ({ node, ok, skipped, output, error, dur_ms, route }) => {
        ctx.nodeRuns[node] = { ok, skipped, output, error, dur_ms }
        if (ok && output !== undefined) { vars[node] = output; if (output && typeof output === 'object') Object.assign(vars.root, output) }
        auditState.prev = auditPath ? auditAppend(auditPath, nodes.get(node), { ok, output, error, dur_ms }, auditState.prev) : auditState.prev
        event(skipped ? 'node_skipped' : 'node', { runId, node, status: skipped ? 'skipped' : ok ? 'done' : 'failed', dur_ms, output: ok ? output : undefined, error: ok ? undefined : error, route })
      },
      onEdge: ({ edge, state }) => event('edge_taken', { runId, edge, state }),
    })
    const outputs = {}
    for (const [nid, rec] of r.settled) outputs[nid] = { ok: rec.ok, output: rec.output, skipped: rec.skipped, error: rec.error }
    const finalOutput = synthesizeOutput(wf, r.settled, inputs)
    const status = r.status
    event('end', { runId, status, steps: r.steps, error: r.error })
    return { ok: r.ok, status, outputs, finalOutput, steps: r.steps, error: r.error, node: r.node, runId, auditPath, settled: r.settled }
  }
```

`synthesizeOutput(wf, settled)`（规格契约条目 11）：

```js
function synthesizeOutput(wf, settled, inputs = {}) {
  const ends = wf.nodes.filter((n) => n.type === 'end')
  const answers = wf.nodes.filter((n) => n.type === 'answer')
  // 变量作用域必须是"节点 id → 节点输出值"（settled 的值是 {ok,output,...} 记录，
  // 直接摊平会让 {{node}} 解析成记录对象——务必取 .output）。
  const scope = { inputs, var: {} }
  for (const [nid, rec] of settled) scope[nid] = rec.output
  const out = {}
  for (const e of ends) {
    for (const o of e.outputs || []) out[o.variable || o.name] = resolvePath(scope, o.selector || o.value || '')
  }
  if (answers.length) {
    out.answer = answers.map((a) => settled.get(a.id)?.output?.answer ?? '').filter(Boolean).join('\n')
  }
  if (!Object.keys(out).length) {
    const last = [...settled.entries()].filter(([, r]) => r.ok && !r.skipped).pop()
    if (last) out.result = last[1].output
  }
  return out
}
```

`end` 节点执行器需改为读 `node.outputs` 并返回聚合对象（Task 4 已平移，此处仅确认 `end` 分支从
`ctx.settled` 取值——为简化，`end` 节点返回 `{ output: {} }`，聚合统一由 `synthesizeOutput` 做）。

- [ ] **Step 5: 补 `stop` 与事件常量**

```js
  const cancelledRuns = new Set()
  function stop(runId) {
    if (!runId) return { ok: false, error: 'runId 必填' }
    cancelledRuns.add(runId)
    return { ok: true }
  }
```
返回对象追加 `stop`。`_signal` 语义保持（全局取消）；`runSignal` 合并两者。

- [ ] **Step 6: 运行测试，确认通过**

Run: `node --test kernel-tests/workflow-engine.test.mjs`
Expected: PASS（4 个 test 全绿）

- [ ] **Step 7: Commit**

```bash
git add kernel/workflow-engine.mjs kernel/workflow.mjs kernel-tests/workflow-engine.test.mjs
git commit -m "feat(workflow): 引擎装配调度器（审计/事件/edge_taken/跳过事件/run 级 stop/输出合成）"
```

---

### Task 6: 工作流 → 具名工具（动态注册 + 三态可见性）

**Files:**
- Create: `kernel/dyntools.mjs`
- Modify: `kernel/tools.mjs:937`（签名加 `dynamicTools`）、`kernel/tools.mjs:1363-1390`（`toolNames` / `toolSchemas` / `run` / `isConcurrencySafe` 叠加动态视图）
- Modify: `kernel/cli.mjs:284-360`（创建 dyntools 并注入 engine opts）、`kernel/cli.mjs:596-640`（`/wf` 命令扩展 stop/export）
- Test: `kernel-tests/workflow-dyntools.test.mjs`

**Interfaces:**
- Consumes: `kernel/workflow-dsl.mjs`（`discoverWorkflowsAll`）、引擎 `run`
- Produces:
  - `slugToToolName(id) → string`（`run_` + 非字母数字转 `_`）
  - `deriveInputSchema(inputs) → { type:'object', additionalProperties:false, properties, required }`
  - `deriveToolDescription(wf) → string`
  - `buildWorkflowTools({ roots, engine, agentId, publicLimit }) → { [toolName]: { description, input_schema, run } }`
  - `visibilityOf(wf, agentId) → 'private' | 'bound' | 'public' | null`（null = 对当前会话不可见）
  - `filterToolNames(names, tools) → string[]`（供 `toolNames` 视图过滤）

- [ ] **Step 1: 写失败测试**

创建 `kernel-tests/workflow-dyntools.test.mjs`：

```js
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { slugToToolName, deriveInputSchema, visibilityOf, buildWorkflowTools } from '../kernel/dyntools.mjs'
import { createToolRegistry } from '../kernel/tools.mjs'

const wfYml = (id, expose) => `name: ${id}
version: 1.0.0
description: 演示工作流 ${id}
inputs:
  - { name: topic, type: string, required: true, description: 主题 }
  - { name: count, type: number, required: false }
nodes:
  - { id: start, type: start }
  - { id: t, type: template, template: "生成 {{inputs.topic}}" }
  - { id: e, type: end, config: { outputs: [{ name: result, selector: "{{t}}" }] } }
edges:
  - { id: e1, source: start, target: t }
  - { id: e2, source: t, target: e }
expose:
${expose}
`

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'wf-tools-'))
  const wfRoot = join(root, 'workflows')
  const mk = (id, expose) => { mkdirSync(join(wfRoot, id), { recursive: true }); writeFileSync(join(wfRoot, id, 'workflow.yml'), wfYml(id, expose), 'utf-8') }
  mk('weekly-report', '  mode: public\n  tool_name: run_weekly_report')
  mk('private-one', '  mode: private')
  mk('bound-one', '  mode: bound\n  bind_agents: [material-writer]')
  return { root, wfRoot, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('工具名与 schema 派生', () => {
  assert.equal(slugToToolName('weekly-report'), 'run_weekly_report')
  assert.equal(slugToToolName('My Flow.v2'), 'run_My_Flow_v2')
  const s = deriveInputSchema([{ name: 'topic', type: 'string', required: true, description: '主题' }, { name: 'count', type: 'number' }])
  assert.deepEqual(s.required, ['topic'])
  assert.equal(s.properties.topic.type, 'string')
  assert.equal(s.properties.count.type, 'number')
  assert.equal(s.additionalProperties, false)
})

test('可见性三态：private 不入池；bound 只对该 agent；public 全局', () => {
  const wfPub = { id: 'p', expose: { mode: 'public' } }
  const wfPri = { id: 'v', expose: { mode: 'private' } }
  const wfBound = { id: 'b', expose: { mode: 'bound', bind_agents: ['material-writer'] } }
  assert.equal(visibilityOf(wfPub, null), 'public')
  assert.equal(visibilityOf(wfPri, null), null)
  assert.equal(visibilityOf(wfBound, null), null)
  assert.equal(visibilityOf(wfBound, 'material-writer'), 'bound')
  assert.equal(visibilityOf(wfBound, 'table-expert'), null)
  assert.equal(visibilityOf({ id: 'x' }, null), null, '缺 expose 默认 private')
})

test('buildWorkflowTools：只输出当前会话可见的工具，且 run 走引擎', async () => {
  const { wfRoot, cleanup } = setup()
  try {
    const calls = []
    const engine = { run: async ({ id, inputs }) => { calls.push({ id, inputs }); return { ok: true, finalOutput: { result: `生成 ${inputs.topic}` } } } }
    const tools = buildWorkflowTools({ roots: [wfRoot], engine, agentId: null })
    assert.ok(tools.run_weekly_report, `public 工具应存在：${Object.keys(tools)}`)
    assert.equal(tools.run_private_one, undefined)
    assert.equal(tools.run_bound_one, undefined)
    const r = await tools.run_weekly_report.run({ topic: '周报' })
    assert.equal(r.isError, false)
    assert.match(String(r.content), /生成 周报/)
    assert.equal(calls[0].id, 'weekly-report')

    const t2 = buildWorkflowTools({ roots: [wfRoot], engine, agentId: 'material-writer' })
    assert.ok(t2.run_bound_one, '绑定 agent 应看到 bound 工具')
    assert.equal(t2.run_private_one, undefined, 'private 永远不入池')
  } finally { cleanup() }
})

test('tools.mjs 接线：动态工具进 toolSchemas 且可执行；未初始化时零影响', async () => {
  const registry = createToolRegistry({ cwd: process.cwd(), addDirs: [process.cwd()], skipPermissions: true })
  assert.ok(registry.toolNames.includes('Workflow'), '既有 Workflow 工具仍在')
  const dyn = { run_demo: { description: 'd', input_schema: { type: 'object' }, run: async () => ({ content: 'ok' }) } }
  const r2 = createToolRegistry({ cwd: process.cwd(), addDirs: [process.cwd()], skipPermissions: true, dynamicTools: () => dyn })
  assert.ok(r2.toolNames.includes('run_demo'), `动态工具应进 toolNames：${r2.toolNames.slice(-5)}`)
  const res = await r2.run({ name: 'run_demo', input: {} })
  assert.equal(res.content, 'ok')
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test kernel-tests/workflow-dyntools.test.mjs`
Expected: FAIL — `Cannot find module '../kernel/dyntools.mjs'`

- [ ] **Step 3: 实现 `kernel/dyntools.mjs`**

```js
// kernel/dyntools.mjs —— 工作流即工具：把每个工作流注册为具名工具（run_<slug>）。
// 可见性三态（wf.expose.mode）：private（仅面板手动运行，不入工具池）/ bound（仅
// bind_agents 列出的 agent 可见）/ public（全局注册）。schema 由 inputs 派生。
import { discoverWorkflowsAll, loadWorkflow } from './workflow-dsl.mjs'

export function slugToToolName(id) {
  const s = String(id || '').trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return `run_${s || 'workflow'}`
}

const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object'])

export function deriveInputSchema(inputs = []) {
  const properties = {}
  const required = []
  for (const it of inputs || []) {
    const name = it?.name
    if (!name) continue
    const t = JSON_TYPES.has(it.type) ? it.type : 'string'
    properties[name] = { type: t, ...(it.description ? { description: String(it.description) } : {}) }
    if (it.required === true) required.push(name)
  }
  return { type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) }
}

export function deriveToolDescription(wf) {
  const ins = (wf.inputs || []).map((i) => `${i.name}${i.required ? '(必填)' : ''}`).join('、')
  const base = wf.description || wf.name || wf.id
  const tail = ins ? ` 输入参数：${ins}。` : ''
  return `运行工作流「${wf.name || wf.id}」：${base}${tail}（确定性流程执行，带审计留痕）`
}

export function visibilityOf(wf, agentId) {
  const expose = wf?.expose || {}
  const mode = expose.mode || 'private'
  if (mode === 'public') return 'public'
  if (mode === 'bound') {
    if (!agentId) return null
    const list = Array.isArray(expose.bind_agents) ? expose.bind_agents.map(String) : []
    return list.includes(String(agentId)) ? 'bound' : null
  }
  return null
}

const LIMIT_DEFAULT = 20

// 构建动态工具表：roots 下发现 → 按可见性过滤 → public 超限按 expose.order / id 截断。
export function buildWorkflowTools({ roots = [], engine, agentId = null, publicLimit = LIMIT_DEFAULT } = {}) {
  const tools = {}
  const metas = discoverWorkflowsAll({ roots })
  const visible = []
  for (const m of metas) {
    if (m.legacy) continue                       // 旧格式：不可运行，不入池（GUI 提示升级）
    const wf = loadWorkflow({ roots, id: m.id })
    if (!wf) continue
    const vis = visibilityOf(wf, agentId)
    if (!vis) continue
    visible.push({ wf, vis })
  }
  const publics = visible.filter((x) => x.vis === 'public')
  const others = visible.filter((x) => x.vis !== 'public')
  const picked = publics.length > publicLimit ? publics.slice(0, publicLimit) : publics
  for (const { wf } of [...picked, ...others]) {
    const name = (wf.expose && wf.expose.tool_name) || slugToToolName(wf.id || wf.name)
    tools[name] = {
      description: deriveToolDescription(wf),
      input_schema: deriveInputSchema(wf.inputs),
      concurrencySafe: false,
      run: async (input) => {
        if (!engine?.run) return { content: '工作流引擎不可用', isError: true }
        const r = await engine.run({ id: wf.id, inputs: input || {} })
        if (!r.ok) return { content: `工作流「${wf.id}」执行失败: ${r.error}${r.node ? `（节点 ${r.node}）` : ''}`, isError: true }
        const out = r.finalOutput ?? r.outputs ?? {}
        return { content: `工作流「${wf.id}」执行完成（${r.status}，${r.steps} 步）\n审计: ${r.auditPath || '未落盘'}\n输出: ${JSON.stringify(out, null, 2)}`, isError: false }
      },
    }
  }
  return tools
}
```

- [ ] **Step 4: `kernel/tools.mjs` 接线**

签名：`createToolRegistry({ ..., dynamicTools = null })`；在 `registry` 字面量之后、返回之前插入：

```js
  // 动态工具（工作流即工具）：视图函数每次求值，磁盘上增删工作流即时生效。
  const dynamicView = () => { try { return (typeof dynamicTools === 'function' ? dynamicTools() : dynamicTools) || {} } catch { return {} } }
```

`toolNames` / `toolSchemas` / `run` / `isConcurrencySafe` 四处叠加：

```js
    toolNames: [...Object.keys(registry).filter((n) => !blocked.has(n)), ...Object.keys(dynamicView()).filter((n) => !blocked.has(n) && !(n in registry))],
    toolSchemas() {
      const statics = Object.entries(registry).filter(([name]) => !blocked.has(name)).map(([name, tool]) => ({ name, description: tool.description, input_schema: tool.input_schema }))
      const dyn = Object.entries(dynamicView()).filter(([name]) => !blocked.has(name) && !(name in registry)).map(([name, tool]) => ({ name, description: tool.description, input_schema: tool.input_schema }))
      return [...statics, ...dyn]
    },
    // run 内：blocked 判定后、静态查表前，先查动态表
    const dynTool = dynamicView()[name]
    if (!dynTool && !tool) { /* 现有未知工具分支 */ }
```

- [ ] **Step 5: `kernel/cli.mjs` 装载 + `/wf` 命令扩展**

在 `const wfEngine = createWorkflowEngine({ configDir })` 之后：

```js
  const { buildWorkflowTools } = await import('./dyntools.mjs')   // 或顶部静态 import
```

`createEngine` 的 `opts` 增：

```js
      dynamicTools: () => buildWorkflowTools({ roots: workflowRoots, engine: wfEngine, agentId: args.agent || null }),
```

并把 `skillRoots` 之外的**独立工作流根** `<configDir>/workflows` 加入 `workflowRoots`（与 Task 8 的安装目录一致）：

```js
  const workflowRoots = [...skillRoots, join(configDir, 'workflows')]
  for (const dir of workflowRoots) wfEngine.addRoot(dir)
```

`handleWorkflowCommand` 增两个分支：

```js
      } else if (subtype === 'stop') {
        const r = wfEngine.stop(msg?.payload?.runId || '')
        wire.system('workflow_result', { subtype: 'stop', ...r })
      } else if (subtype === 'validate') {
        const wf = wfEngine.load(msg?.payload?.id || '')
        const v = wf ? validateWorkflow(wf) : { ok: false, errors: [{ code: 'NOT_FOUND', message: '工作流不存在' }] }
        wire.system('workflow_result', { subtype: 'validate', ...v })
      }
```

- [ ] **Step 6: 运行测试，确认通过**

Run: `node --test kernel-tests/workflow-dyntools.test.mjs`
Expected: PASS（4 个 test 全绿）

- [ ] **Step 7: Commit**

```bash
git add kernel/dyntools.mjs kernel/tools.mjs kernel/cli.mjs kernel-tests/workflow-dyntools.test.mjs
git commit -m "feat(workflow): 工作流即工具——具名工具注册、inputs→schema 派生、三态可见性"
```

---

### Task 7: Agent 绑定（workflows 字段全链路）

**Files:**
- Modify: `kernel/agents.mjs:114-145`（解析 `workflows:` frontmatter）
- Modify: `kernel/cli.mjs:60-100`（新增 `--agent <id>`）、`kernel/cli.mjs` 装载处传 `agentId`
- Modify: `src/lib/agents.ts`（`Agent` 增 `workflows?: string[]`）
- Modify: `src/stores/agentStore.ts:44-50`（`syncAgentsToKernel` 带上 workflows）
- Modify: `electron/preload.cjs` / `src/types/index.ts:419`（`AgentSyncPayload` 增字段）
- Test: `kernel-tests/workflow-binding.test.mjs`

**Interfaces:**
- Consumes: Task 6 的 `buildWorkflowTools({ agentId })`
- Produces:
  - `parseAgentWorkflows(frontmatter) → string[]`（`kernel/agents.mjs` 导出）
  - agent `.md` frontmatter 支持 `workflows: id1, id2`
  - CLI `--agent <id>` → `args.agent`
  - GUI `Agent.workflows?: string[]`

- [ ] **Step 1: 写失败测试**

创建 `kernel-tests/workflow-binding.test.mjs`：

```js
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverUserAgents } from '../kernel/agents.mjs'
import { buildWorkflowTools } from '../kernel/dyntools.mjs'

test('agent frontmatter workflows 字段被解析', () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-agent-'))
  try {
    writeFileSync(join(root, 'material-writer.md'), `---
name: material-writer
description: 材料撰写专家
tools: Read, Write
skills: gxtz-rd-report
workflows: weekly-report, report-review
---
你是材料撰写专家。`, 'utf-8')
    const agents = discoverUserAgents({ root })
    const a = agents.find((x) => x.name === 'material-writer')
    assert.ok(a, `应发现 agent：${JSON.stringify(agents.map((x) => x.name))}`)
    assert.deepEqual(a.workflows, ['weekly-report', 'report-review'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('绑定生效：同一工作流对绑定 agent 可见、对其他 agent 不可见', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-bind-'))
  const wfRoot = join(root, 'workflows')
  try {
    mkdirSync(join(wfRoot, 'bound-one'), { recursive: true })
    writeFileSync(join(wfRoot, 'bound-one', 'workflow.yml'), `name: bound-one
description: 绑定演示
nodes:
  - { id: s, type: start }
  - { id: t, type: template, template: hi }
  - { id: e, type: end }
edges:
  - { id: e1, source: s, target: t }
  - { id: e2, source: t, target: e }
expose: { mode: bound, bind_agents: [material-writer] }
`, 'utf-8')
    const engine = { run: async () => ({ ok: true, finalOutput: { result: 'hi' }, status: 'completed', steps: 2 }) }
    assert.ok(buildWorkflowTools({ roots: [wfRoot], engine, agentId: 'material-writer' }).run_bound_one)
    assert.equal(buildWorkflowTools({ roots: [wfRoot], engine, agentId: 'table-expert' }).run_bound_one, undefined)
    assert.equal(buildWorkflowTools({ roots: [wfRoot], engine, agentId: null }).run_bound_one, undefined)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test kernel-tests/workflow-binding.test.mjs`
Expected: FAIL — `a.workflows` 为 `undefined`

- [ ] **Step 3: 实现 kernel 侧解析与 CLI 参数**

`kernel/agents.mjs` 的 `parseAgentFile` 增：

```js
      workflows: String(fields.workflows || '').split(',').map((s) => s.trim()).filter(Boolean),
```

`kernel/cli.mjs` 参数解析增 `case '--agent': out.agent = next() ?? null; break`，
用法串补 `[--agent <id>]`；`createEngine` opts 传 `agentId: args.agent || null`，
`createToolRegistry` 透传并在 `buildWorkflowTools` 调用时作为 `agentId`。

- [ ] **Step 4: 实现 GUI 侧字段与同步**

`src/lib/agents.ts`：`Agent` 接口增

```ts
  /** 绑定的工作流 id 列表（内核按此过滤 bound 工作流的工具可见性） */
  workflows?: string[]
```

`src/stores/agentStore.ts` 的 `syncAgentsToKernel` 保持整体透传（已传全对象），只需确认
payload 类型允许新字段；`src/types/index.ts:419` 的 `AgentSyncPayload` 增 `workflows?: string[]`。

- [ ] **Step 5: 运行测试，确认通过**

Run: `node --test kernel-tests/workflow-binding.test.mjs`
Expected: PASS（2 个 test 全绿）

- [ ] **Step 6: 前端类型检查**

Run: `npm run typecheck`
Expected: 通过（无 `workflows` 相关类型错误）

- [ ] **Step 7: Commit**

```bash
git add kernel/agents.mjs kernel/cli.mjs src/lib/agents.ts src/stores/agentStore.ts src/types/index.ts kernel-tests/workflow-binding.test.mjs
git commit -m "feat(workflow): agent 绑定工作流全链路（frontmatter workflows + --agent + 可见性过滤）"
```

---

### Task 8: 内置工作流重写 + 安装升级

**Files:**
- Modify: `workflows/spec-dev/workflow.yml`（全量重写为显式 edges）
- Modify: `server/bridge.mjs:2509-2535`（`autoInstallBuiltinWorkflows` 按 version 覆盖）
- Modify: `kernel-tests/workflow-specdev.test.mjs`（改写为 DAG 断言）
- Test: 同上 + `server/workflow-install.test.mjs`（新建）

**Interfaces:**
- Consumes: Task 1-5 的 DSL v2 与 DAG 引擎
- Produces: `autoInstallBuiltinWorkflows({ force })` 升级语义；`spec-dev` DAG 版

- [ ] **Step 1: 改写 spec-dev 为 DAG（先写测试）**

改写 `kernel-tests/workflow-specdev.test.mjs`：把"节点链顺序"断言改为"edges 断言"：

```js
test('spec-dev 发现与解析：edges 显式连线 + loop body + 断点条件齐全', () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-specdev-'))
  try {
    mkdirSync(join(root, 'spec-dev'), { recursive: true })
    copyFileSync(SRC, join(root, 'spec-dev', 'workflow.yml'))
    const wf = loadWorkflow({ roots: [root], id: 'spec-dev' })
    assert.ok(wf, 'loadWorkflow 应解析成功')
    const ids = wf.nodes.map((n) => n.id)
    for (const id of ['start', 'specify', 'plan', 'tasks', 'impl_loop', 'implement', 'converge', 'end']) {
      assert.ok(ids.includes(id), `应有节点 ${id}`)
    }
    const pairs = wf.edges.map((e) => `${e.source}->${e.target}`)
    for (const p of ['start->specify', 'specify->plan', 'plan->tasks', 'tasks->impl_loop', 'impl_loop->end']) {
      assert.ok(pairs.includes(p), `应有边 ${p}：${pairs.join(',')}`)
    }
    const inner = wf.edges.filter((e) => e.source === 'implement' || e.source === 'converge').map((e) => `${e.source}->${e.target}`)
    assert.ok(inner.includes('implement->converge'), `loop body 内应有 implement->converge：${inner}`)
    const loop = wf.nodes.find((n) => n.id === 'impl_loop')
    assert.equal(loop.type, 'loop')
    assert.deepEqual(loop.body, ['implement', 'converge'])
    assert.equal(loop.count, 3)
    assert.equal(validateWorkflow(wf).ok, true, JSON.stringify(validateWorkflow(wf).errors))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
```
第二个冒烟测试保持"`r.ok === true`"断言不变。

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test kernel-tests/workflow-specdev.test.mjs`
Expected: FAIL — 缺 `edges`（`LEGACY_DSL`）

- [ ] **Step 3: 重写 `workflows/spec-dev/workflow.yml`**

保留全部节点内容不变（agent 提示词逐字保留），做三件事：
① 节点改为 `id/type/label/position` + `config: { ... }` 结构；
② 末尾加 `edges`：

```yaml
edges:
  - { id: e1, source: start, target: specify }
  - { id: e2, source: specify, target: plan }
  - { id: e3, source: plan, target: tasks }
  - { id: e4, source: tasks, target: impl_loop }
  - { id: e5, source: impl_loop, target: end }
  - { id: e6, source: implement, target: converge }
```

③ 加 `settings: { max_parallel: 4 }` 与 `trigger_config: { manual: true, auto_trigger: false }`。

- [ ] **Step 4: 运行测试，确认通过**

Run: `node --test kernel-tests/workflow-specdev.test.mjs`
Expected: PASS（2 个 test 全绿）

- [ ] **Step 5: 安装逻辑升级（先写失败测试）**

创建 `server/workflow-install.test.mjs`：断言"用户机上存在旧版本副本时，安装器按 version 比对并覆盖"：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installBuiltinWorkflows } from './bridge.mjs'

test('内置工作流安装：版本不同即覆盖（旧格式残留被升级）', () => {
  const src = mkdtempSync(join(tmpdir(), 'wf-src-'))
  const dst = mkdtempSync(join(tmpdir(), 'wf-dst-'))
  try {
    mkdirSync(join(src, 'demo'), { recursive: true })
    writeFileSync(join(src, 'demo', 'workflow.yml'), 'name: demo\nversion: 2.0.0\nnodes: [{id: s, type: start}]\nedges: []\n', 'utf-8')
    mkdirSync(join(dst, 'demo'), { recursive: true })
    writeFileSync(join(dst, 'demo', 'workflow.yml'), 'name: demo\nversion: 1.0.0\nnodes: [{id: s, type: start, next: null}]\n', 'utf-8')
    const r = installBuiltinWorkflows({ srcRoot: src, dstRoot: dst })
    assert.deepEqual(r.updated, ['demo'])
    assert.match(readFileSync(join(dst, 'demo', 'workflow.yml'), 'utf-8'), /version: 2\.0\.0/)
  } finally { rmSync(src, { recursive: true, force: true }); rmSync(dst, { recursive: true, force: true }) }
})
```

- [ ] **Step 6: 实现安装升级**

把 `server/bridge.mjs:2512-2533` 的 `autoInstallBuiltinWorkflows` 抽出可测函数并导出：

```js
// 内置工作流安装：按 version 比对覆盖（旧格式副本必须被升级，否则启动即 LEGACY_DSL 失败）。
export function installBuiltinWorkflows({ srcRoot, dstRoot }) {
  const out = { installed: [], updated: [], skipped: [] }
  if (!existsSync(srcRoot)) return out
  for (const d of readdirSync(srcRoot, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const srcFile = join(srcRoot, d.name, 'workflow.yml')
    if (!existsSync(srcFile)) continue
    const dstDir = join(dstRoot, d.name)
    const dstFile = join(dstDir, 'workflow.yml')
    const srcVer = (readFileSync(srcFile, 'utf-8').match(/^version:\s*(\S+)/m) || [])[1] || ''
    const dstVer = existsSync(dstFile) ? ((readFileSync(dstFile, 'utf-8').match(/^version:\s*(\S+)/m) || [])[1] || '') : null
    try {
      if (dstVer === null) { mkdirSync(dstDir, { recursive: true }); copyFileSync(srcFile, dstFile); out.installed.push(d.name) }
      else if (dstVer !== srcVer) {
        const bak = join(dstDir, `workflow.v${dstVer || '0'}.bak.yml`)
        try { copyFileSync(dstFile, bak) } catch {}
        copyFileSync(srcFile, dstFile)
        out.updated.push(d.name)
      } else out.skipped.push(d.name)
    } catch (e) { console.warn('[bridge] builtin workflow install failed:', d.name, '-', e?.message || e) }
  }
  return out
}
```

`autoInstallBuiltinWorkflows()` 改为：

```js
function autoInstallBuiltinWorkflows() {
  try {
    const r = installBuiltinWorkflows({ srcRoot: join(__dirname, '..', 'workflows'), dstRoot: join(YFW_HOME, 'workflows') })
    if (r.installed.length || r.updated.length) console.log('[bridge] builtin workflows:', JSON.stringify(r))
  } catch (e) {
    console.warn('[bridge] autoInstallBuiltinWorkflows failed:', e?.message || e)
  }
  bootState.workflowsInstalled = true
}
```

- [ ] **Step 7: 运行测试**

Run: `node --test server/workflow-install.test.mjs && node --test kernel-tests/`
Expected: 全绿（含既有 kernel 测试）

- [ ] **Step 8: 打包验证（内核零依赖约束）**

Run: `node scripts/build-kernel.mjs`
Expected: 输出 `[build-kernel] bundled to ...`，无 unresolved import 报错。

- [ ] **Step 9: Commit**

```bash
git add workflows/spec-dev/workflow.yml server/bridge.mjs server/workflow-install.test.mjs kernel-tests/workflow-specdev.test.mjs
git commit -m "feat(workflow): spec-dev 重写为显式 DAG + 内置工作流按 version 覆盖安装"
```

---

## Self-Review

**Spec 覆盖**：§2 DSL（Task 1-2）、§3 引擎（Task 3-5）、§4 工具化与绑定（Task 6-7）、§2 契约条目 8 内置重写（Task 8）均已覆盖。§5 宿主与授权、§6 GUI、§7 端到端由第二份计划（`2026-09-11-workflow-module-ui.md`）承担。

**类型一致性**：`schedule()` 返回 `{ ok, status, settled, steps, error, node }` 在 Task 3 定义、Task 5 消费；`executeNode(node, ctx)` 归一化返回 `{ ok, output, route, error, dur_ms }` 在 Task 4 定义、Task 3 调用；`buildWorkflowTools({ roots, engine, agentId, publicLimit })` 在 Task 6 定义、Task 7 测试与 Task 6 的 cli 装载一致；`vis` 判定用 `visibilityOf(wf, agentId)`，GUI 侧同名校验函数在第二份计划中复用同一语义（`private → null`）。

**风险提示（执行者必读）**：Task 4 平移节点代码时，`execIf`/`execClassify` 的返回必须删掉 `next` 字段——这是 DAG 化最容易漏的一处；漏改会导致调度器把它们当普通节点、分支失效（Task 3 的条件边测试不覆盖真实 if 执行器，Task 5 的引擎测试才会暴露）。
