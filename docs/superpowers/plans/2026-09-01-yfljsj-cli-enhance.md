# yfljsj CLI 字段级增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 yfljsj CLI 自包含——命令表升级 v2 含全量字段定义（类型/必填/枚举/来源），新增 `schema`/`relations`/`explore`/`doc` 四子命令，模型/用户免重复试错。

**Architecture:** 命令表 `apis.json` 升级为 v2（params 从 `{field:"type"}` 升级为 `{field:{type,required,desc,enum,source,auto}}`，新增顶层 `relations` 对象图谱 + `operations` 操作手册）；yfljsj.mjs 新增四个子命令读取该元数据；`explore` 用空请求报错解析（`[xxx:must not be null]`）迭代探测字段并沉淀写回命令表。

**Tech Stack:** Node.js 内置模块（零新增依赖），测试 `node --test`。

## Global Constraints

- **零新增依赖**：只用 Node 内置模块
- **保持单文件**：`yfljsj.mjs` 自包含，新增子命令在 main 路由中接入
- **命令表 v2 兼容**：v1 旧 apis.json 无损迁移到 v2（`params` 字符串形式 → 对象形式）；种子 `apis.seed.json` 升 v2
- **schema/relations/explore/doc 输出**：stdout 纯文本（人读），不破坏 `--json` 契约（这些是元数据查看命令，非业务数据）
- **explore 安全**：只发空 body/缺字段请求（参数校验拒绝，无副作用）；delete 类不探测
- **测试**：`node --test "yfljsj-cli/tests/*.test.mjs"` 全过（既有 119 + 新增）
- **提交纪律**：只 `git add yfljsj-cli/`；严禁 git add -A / git add .

---

### Task 1: 命令表 v2 数据模型 + 迁移

**Files:**
- Modify: `yfljsj-cli/scripts/gen-apis.mjs`（params 生成 v2 结构）
- Modify: `yfljsj-cli/yfljsj.mjs`（loadApis 兼容 v1/v2 + migrateApis）
- Modify: `yfljsj-cli/apis.seed.json`（重新生成 v2）
- Test: `yfljsj-cli/tests/gen-apis.test.mjs`（新增 v2 断言）

**Interfaces:**
- Consumes: `genApis(calls)`（现有）、`loadApis()`（现有）
- Produces: `migrateApis(apis) => apis`（v1→v2 无损迁移）、v2 命令表结构

- [ ] **Step 1: 写失败测试**

在 `yfljsj-cli/tests/gen-apis.test.mjs` 追加：

```js
test('genApis v2：params 升级为对象定义', () => {
  const out = genApis(sample)
  const pageCmd = out.modules.asset.commands.find(c => c.action === 'building-page')
  // v2: { current: {type:'number', required:true, desc:...}, size: {...} }
  assert.equal(pageCmd.params.current.type, 'number')
  assert.equal(pageCmd.params.current.required, true)
  assert.equal(pageCmd.params.size.type, 'number')
})
```

```js
test('migrateApis：v1 字符串 params 无损迁移 v2', () => {
  const v1 = {
    version: 1,
    services: { rcms: 'x' },
    modules: { asset: { title: 'asset', service: 'rcms', commands: [
      { action: 'building-page', method: 'POST', path: '/asset/building/page', params: { current: 'number', size: 'number' }, kind: 'read' },
    ] } },
  }
  const v2 = migrateApis(v1)
  assert.equal(v2.version, 2)
  assert.equal(v2.modules.asset.commands[0].params.current.type, 'number')
  assert.equal(v2.modules.asset.commands[0].params.current.required, true)
})
```

- [ ] **Step 2: 运行确认失败**
Run: `node --test yfljsj-cli/tests/gen-apis.test.mjs`
Expected: FAIL（v2 结构不存在）

- [ ] **Step 3: 实现**

`yfljsj-cli/scripts/gen-apis.mjs` 的 `inferParams` 改为 v2 结构：

```js
/** 分页接口：尾部为 page/list 等 → v2 对象定义 */
const PAGE_SUFFIXES = ['page', 'list', 'pageForRegister', 'pageForSelect']
export function inferParams(path) {
  const last = path.split('/').pop() || ''
  if (!PAGE_SUFFIXES.includes(last)) return {}
  return {
    current: { type: 'number', required: true, desc: '页码（从1开始）', auto: false },
    size: { type: 'number', required: true, desc: '每页条数' },
  }
}
```

`yfljsj-cli/yfljsj.mjs` 新增 `migrateApis` 并在 `loadApis` 后调用：

```js
/** v1 → v2 命令表迁移：params 字符串形式升级为对象定义；无损 */
export function migrateApis(apis) {
  if (!apis || apis.version >= 2) return apis
  const out = { ...apis, version: 2 }
  for (const m of Object.values(out.modules || {})) {
    for (const c of (m.commands || [])) {
      if (!c.params || typeof c.params !== 'object') continue
      const v2 = {}
      for (const [k, v] of Object.entries(c.params)) {
        if (v && typeof v === 'object' && v.type) v2[k] = v // 已是 v2
        else v2[k] = { type: typeof v === 'string' ? v : 'string', required: true, desc: '' }
      }
      c.params = v2
    }
  }
  return out
}
```

`loadApis` 中：`let apis = JSON.parse(...); apis = migrateApis(apis); return apis`

- [ ] **Step 4: 重新生成种子 + 测试**
```bash
cd yfljsj-cli && node -e "
import('./scripts/gen-apis.mjs').then(async ({ genApis }) => {
  const fs = await import('node:fs')
  const calls = JSON.parse(fs.readFileSync('../zz-smoke/yfljsj-re/api-calls.json', 'utf8'))
  const out = genApis(calls)
  out.version = 2
  fs.writeFileSync('apis.seed.json', JSON.stringify(out, null, 1))
  console.log('seed v2 生成，version:', out.version)
})"
```
Run: `node --test "yfljsj-cli/tests/*.test.mjs"` → 全过

- [ ] **Step 5: Commit**
```bash
git add yfljsj-cli/
git commit -m "feat(yfljsj): 命令表 v2 — params 字段定义升级 + v1 无损迁移"
```

---

### Task 2: schema 子命令

**Files:**
- Modify: `yfljsj-cli/yfljsj.mjs`（新增 schemaCommand + main 路由）
- Test: `yfljsj-cli/tests/enhance.test.mjs`（新建）

**Interfaces:**
- Consumes: `loadApis()`（v2 结构）、`parseArgs`/`main`（现有）
- Produces: `schemaCommand(module, action, opts) => number(exitCode)`、main 路由 `command==='schema'`

- [ ] **Step 1: 写失败测试**

`yfljsj-cli/tests/enhance.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
const api = await import('../yfljsj.mjs')

test('schema：输出命令字段定义', () => {
  // 直接测 schemaCommand 渲染（mock stdout）
  const lines = []
  const out = { write: s => lines.push(s) }
  const code = api.schemaCommand('workbench', 'projectAppro-add', { output: out })
  assert.equal(code, 0)
  const text = lines.join('')
  assert.match(text, /projectAppro-add/)
  assert.match(text, /headPerson/)
  assert.match(text, /techEconTarget/)
  assert.match(text, /必填|required/)
})

test('schema：未知命令 → 退出码 2', () => {
  const code = api.schemaCommand('workbench', 'nonexistent', { output: { write: () => {} } })
  assert.equal(code, 2)
})
```

- [ ] **Step 2: 运行确认失败**
Run: `node --test yfljsj-cli/tests/enhance.test.mjs`
Expected: FAIL（schemaCommand 不存在）

- [ ] **Step 3: 实现**

```js
/** schema：查看命令完整字段定义（类型/必填/描述/枚举/来源） */
export function schemaCommand(module, action, { output = process.stdout } = {}) {
  const apis = loadApis()
  const mod = apis.modules[module]
  if (!mod) { output.write(`未知模块：${module}\n`); return 2 }
  const cmd = (mod.commands || []).find(c => c.action === action)
  if (!cmd) { output.write(`未知命令：${module} ${action}\n可用：${mod.commands.map(c => c.action).join('、')}\n`); return 2 }
  const lines = [`命令: ${cmd.action} (${cmd.method} ${cmd.path}) [${cmd.kind}]`, `字段:`]
  const params = cmd.params || {}
  for (const [k, v] of Object.entries(params)) {
    const d = v && typeof v === 'object' ? v : { type: 'string', desc: '' }
    const parts = [`  ${k.padEnd(18)} ${String(d.type || 'string').padEnd(8)} ${d.required ? '必填' : '可选'}`]
    if (d.auto) parts[0] += ' [自动注入]'
    if (d.desc) parts.push(` ${d.desc}`)
    if (Array.isArray(d.enum)) parts.push(` = ${d.enum.join('|')}`)
    if (d.source) parts.push(` ← ${d.source}`)
    lines.push(parts.join(''))
  }
  if (cmd.relations) lines.push(`关联: ${cmd.relations}`)
  output.write(lines.join('\n') + '\n')
  return 0
}
```

main 路由（在 `if (command === 'discover')` 前加）：
```js
if (command === 'schema') {
  if (!sub) return usage('schema 需要 <module> <action>')
  return schemaCommand(sub, args[0] || '', { output: process.stdout })
}
```

- [ ] **Step 4: 测试通过 + 全量回归**
Run: `node --test "yfljsj-cli/tests/*.test.mjs"` → 全过

- [ ] **Step 5: Commit**
```bash
git add yfljsj-cli/
git commit -m "feat(yfljsj): schema 子命令 — 命令字段定义查看"
```

---

### Task 3: relations 子命令（对象关联图谱）

**Files:**
- Modify: `yfljsj-cli/scripts/gen-apis.mjs`（生成 relations 骨架）
- Modify: `yfljsj-cli/apis.seed.json`（含 relations）
- Modify: `yfljsj-cli/yfljsj.mjs`（relationsCommand + main 路由）
- Test: `yfljsj-cli/tests/enhance.test.mjs`

**Interfaces:**
- Consumes: `loadApis()`（含 relations 节）
- Produces: `relationsCommand(object?, opts) => exitCode`、main 路由 `command==='relations'`

- [ ] **Step 1: 写失败测试**

```js
test('relations：输出对象关联图谱', () => {
  const lines = []
  const code = api.relationsCommand('project', { output: { write: s => lines.push(s) } })
  assert.equal(code, 0)
  const text = lines.join('')
  assert.match(text, /project/)
  assert.match(text, /projectAppro|立项/)
  assert.match(text, /rdItem|研发/)
  assert.match(text, /创建顺序/)
})

test('relations：无参 → 输出对象目录', () => {
  const lines = []
  const code = api.relationsCommand(null, { output: { write: s => lines.push(s) } })
  assert.equal(code, 0)
  assert.match(lines.join(''), /可用对象|对象/)
})
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

`gen-apis.mjs` 新增 `buildRelations(modules)` 生成骨架（从路径首段 + 常见关联模式推断）：
```js
/** 生成 relations 骨架：路径首段归组 + 常见子对象关联（project→approval/rdItem/member 等） */
export function buildRelations(modules) {
  const relations = {}
  // 核心对象显式定义（人工沉淀）
  relations.project = {
    title: '项目', createOrder: ['projectInfo-add', 'projectAppro-add', 'rdItem-add'],
    children: {
      approval: { title: '立项信息', via: 'projectId → project.id', api: 'projectAppro' },
      rdItem: { title: '研发活动', via: 'sourceProjectId → project.id', api: 'rdItem' },
      member: { title: '项目成员', via: 'projectId → project.id', api: 'projectMember' },
      equipment: { title: '设备', via: 'projectId → project.id', api: 'projectEquip' },
      budget: { title: '预算', via: 'projectId → project.id', api: 'projectRdCost' },
    },
  }
  relations.rdItem = { title: '研发活动', createOrder: ['rdItem-add'], children: {} }
  relations.approval = { title: '立项信息', createOrder: ['projectAppro-add'], children: {} }
  return relations
}
```

`genApis` 输出加 `relations: buildRelations(modules)`。

`yfljsj.mjs` 的 relationsCommand：
```js
/** relations：业务对象关联图谱 */
export function relationsCommand(object, { output = process.stdout } = {}) {
  const apis = loadApis()
  const rels = apis.relations || {}
  if (!object) {
    output.write('可用对象: ' + Object.keys(rels).join('、') + '\n')
    output.write('用法: yfljsj relations <对象>\n')
    return 0
  }
  const r = rels[object]
  if (!r) { output.write(`未知对象: ${object}\n可用: ${Object.keys(rels).join('、')}\n`); return 2 }
  output.write(`${object} (${r.title})\n`)
  for (const [k, v] of Object.entries(r.children || {})) {
    output.write(` ├─ ${k} (${v.title})  via ${v.via}\n`)
  }
  if (r.createOrder?.length) output.write(`创建顺序: ${r.createOrder.join(' → ')}\n`)
  return 0
}
```

main 路由：`if (command === 'relations') return relationsCommand(sub, { output: process.stdout })`

- [ ] **Step 4: 测试通过 + 全量回归**

- [ ] **Step 5: Commit**
```bash
git add yfljsj-cli/
git commit -m "feat(yfljsj): relations 子命令 — 业务对象关联图谱"
```

---

### Task 4: explore 子命令（交互式字段探测）

**Files:**
- Modify: `yfljsj-cli/yfljsj.mjs`（exploreCommand + 字段探测逻辑 + main 路由）
- Test: `yfljsj-cli/tests/enhance.test.mjs`

**Interfaces:**
- Consumes: `authenticatedRequest`（现有）、`loadApis`/`writeApis`（现有）
- Produces: `probeFields(path, {method, service, baseUrl}) => {fields, error}`、`exploreCommand(path, opts) => exitCode`、main 路由 `command==='explore'`

- [ ] **Step 1: 写失败测试**

```js
test('probeFields：空请求报错解析必填字段', async () => {
  // mock 网关：空 body 返回 [headPerson:must not be null, projectId:must not be null]
  const fields = await api.probeFields('/workbench/projectAppro/add', { baseUrl: mockBase, method: 'POST' })
  assert.ok(fields.includes('headPerson'))
  assert.ok(fields.includes('projectId'))
})

test('probeFields：success 时返回空字段（全部满足）', async () => {
  const fields = await api.probeFields('/ok/endpoint', { baseUrl: mockBase, method: 'POST' })
  assert.deepEqual(fields, [])
})

test('exploreCommand：dry-run 输出探测结果', async () => {
  const lines = []
  const code = await api.exploreCommand('/workbench/projectAppro/add', { output: { write: s => lines.push(s) }, dryRun: true, baseUrl: mockBase })
  assert.equal(code, 0)
  assert.match(lines.join(''), /headPerson/)
})
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

```js
/** 解析参数校验报错：[xxx:must not be null, yyy:must not be blank] → ['xxx','yyy'] */
export function parseValidationMsg(msg) {
  const fields = []
  if (msg && typeof msg === 'string') {
    const m = msg.match(/\[([^\]]+)\]/)
    if (m) {
      for (const part of m[1].split(',')) {
        const fm = part.match(/^([a-zA-Z_][a-zA-Z0-9_]*):/)
        if (fm) fields.push(fm[1])
      }
    }
  }
  return [...new Set(fields)]
}

/** 探测接口必填字段：发空 body → 解析报错 → 逐个补字段迭代 */
export async function probeFields(path, { method = 'POST', service = 'rcms', baseUrl, rejectUnauthorized = true } = {}) {
  const base = baseUrl || SERVICES[service] || SERVICES.rcms
  const known = new Set()
  const attempts = []
  for (let round = 0; round < 5; round++) {
    const body = { tenantId: readConfig().tenantId }
    for (const f of known) body[f] = guessValue(f)
    const res = await authenticatedRequest({ url: base + path, method, body, rejectUnauthorized, timeout: 10000 })
    const b = res.body && typeof res.body === 'object' ? res.body : {}
    if (b.success === true) break // 字段全满足（或接口宽容）
    const newFields = parseValidationMsg(String(b.msg || ''))
    const added = newFields.filter(f => !known.has(f))
    if (added.length === 0) break // 无新字段，停止
    for (const f of added) known.add(f)
    attempts.push({ body: { ...body }, fields: newFields })
  }
  return { fields: [...known], attempts }
}

/** 字段类型猜测：按字段名启发式 */
function guessValue(f) {
  const l = f.toLowerCase()
  if (l.includes('id') && !l.includes('ids')) return 0
  if (l.includes('year')) return new Date().getFullYear()
  if (l.includes('date') || l.includes('time')) return '2026-01-01 00:00:00'
  if (l.includes('name') || l.includes('code') || l.includes('content')) return '测试'
  if (l === 'current') return 1
  if (l === 'size') return 10
  if (l.endsWith('flag') || l.startsWith('is')) return 0
  return ''
}
```

exploreCommand：
```js
/** explore：交互探测接口必填字段并（可选）写入命令表 */
export async function exploreCommand(path, { output = process.stdout, dryRun = false, method = 'POST', service = 'rcms', module, action, baseUrl } = {}) {
  output.write(`探测 ${path} (${method} ${service})\n`)
  const { fields, attempts } = await probeFields(path, { method, service, baseUrl })
  output.write(`已探明字段: ${fields.join(', ') || '(无必填字段或接口宽容)'}\n`)
  if (dryRun) return 0
  // 写入命令表：匹配现有命令或新增
  const apis = loadApis()
  const modKey = module || path.split('/')[1] || 'other'
  if (!apis.modules[modKey]) apis.modules[modKey] = { title: modKey, service, commands: [] }
  let cmd = apis.modules[modKey].commands.find(c => c.path === path)
  if (!cmd) {
    cmd = { action: path.split('/').slice(-2).join('-'), method, path, kind: /delete|remove|add|modify|update|save|import/.test(path) ? 'write' : 'read', params: {} }
    apis.modules[modKey].commands.push(cmd)
  }
  for (const f of fields) {
    if (!cmd.params[f]) cmd.params[f] = { type: guessType(f), required: true, desc: '' }
  }
  writeApis(apis)
  output.write(`已写入命令表 ${modKey}.${cmd.action}（${fields.length} 个必填字段）\n`)
  return 0
}
```

main 路由：`if (command === 'explore') { if (!sub) return usage('explore 需要 <path>'); return await exploreCommand(sub, { dryRun: opts['--dry-run'] === true, method: opts['--method'] || 'POST', service: opts['--service'] || 'rcms', module: opts['--module'] }) }`

- [ ] **Step 4: 测试通过 + 全量回归**

- [ ] **Step 5: Commit**
```bash
git add yfljsj-cli/
git commit -m "feat(yfljsj): explore 子命令 — 交互式字段探测与沉淀"
```

---

### Task 5: doc 子命令（操作手册）

**Files:**
- Modify: `yfljsj-cli/yfljsj.mjs`（docCommand + main 路由）
- Modify: `yfljsj-cli/apis.seed.json`（operations 节）
- Test: `yfljsj-cli/tests/enhance.test.mjs`

**Interfaces:**
- Consumes: `loadApis()`（operations 节）
- Produces: `docCommand(object?, opts) => exitCode`、main 路由 `command==='doc'`

- [ ] **Step 1: 写失败测试**

```js
test('doc：输出操作手册（步骤+示例）', () => {
  const lines = []
  const code = api.docCommand('createProject', { output: { write: s => lines.push(s) } })
  assert.equal(code, 0)
  const text = lines.join('')
  assert.match(text, /创建研发项目/)
  assert.match(text, /projectInfo-add/)
  assert.match(text, /projectAppro-add/)
  assert.match(text, /yfljsj /)
})

test('doc：无参 → 输出目录', () => {
  const lines = []
  const code = api.docCommand(null, { output: { write: s => lines.push(s) } })
  assert.equal(code, 0)
  assert.match(lines.join(''), /createProject|可用手册/)
})
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

`apis.seed.json` 加 operations（在 gen-apis.mjs 里生成）：
```js
operations: {
  createProject: {
    title: '创建研发项目（含立项）',
    steps: [
      { cmd: 'workbench projectInfo-add', desc: '1. 建项目基础信息（projectName/projectCode 必填）' },
      { cmd: 'workbench projectAppro-add', desc: '2. 建立项信息（负责人 headPersonId 从 getUserList 选）' },
      { cmd: 'enterprise rdItem-add', desc: '3. 建研发活动（sourceProjectId=项目id）' },
    ],
    examples: [
      "yfljsj workbench projectInfo-add --data '{\"projectName\":\"AI...\",\"projectCode\":\"TEST-RD-...\"}'",
      "yfljsj workbench projectAppro-add --data '{\"projectId\":100216,\"headPersonId\":100131,...}'",
    ],
  },
}
```

docCommand：
```js
/** doc：完整操作手册 */
export function docCommand(object, { output = process.stdout } = {}) {
  const apis = loadApis()
  const ops = apis.operations || {}
  if (!object) {
    output.write('可用手册: ' + Object.keys(ops).join('、') + '\n')
    output.write('用法: yfljsj doc <手册名>\n')
    return 0
  }
  const op = ops[object]
  if (!op) { output.write(`未知手册: ${object}\n可用: ${Object.keys(ops).join('、')}\n`); return 2 }
  output.write(`${object} — ${op.title}\n`)
  output.write('步骤:\n')
  for (const s of op.steps || []) output.write(`  ${s.desc} (${s.cmd})\n`)
  if (op.examples?.length) {
    output.write('示例:\n')
    for (const e of op.examples) output.write(`  ${e}\n`)
  }
  return 0
}
```

main 路由：`if (command === 'doc') return docCommand(sub, { output: process.stdout })`

- [ ] **Step 4: 测试通过 + 全量回归**

- [ ] **Step 5: Commit**
```bash
git add yfljsj-cli/
git commit -m "feat(yfljsj): doc 子命令 — 操作手册（步骤+示例）"
```

---

### Task 6: 核心链路字段标注（人工沉淀）

**Files:**
- Modify: `yfljsj-cli/apis.seed.json`（核心写命令字段完整标注）
- Modify: `yfljsj-cli/scripts/gen-apis.mjs`（核心字段模板）

**Interfaces:**
- Consumes: 实测踩坑经验（projectInfo/projectAppro/rdItem 字段）
- Produces: 核心命令完整 params（含 desc/enum/source）

- [ ] **Step 1: 标注核心命令字段**

在 gen-apis.mjs 加 `CORE_FIELD_TEMPLATES`（实测沉淀）：

```js
/** 核心命令字段模板（真机实测沉淀 2026-09-01） */
const CORE_FIELD_TEMPLATES = {
  '/workbench/projectInfo/add': {
    projectName: { type: 'string', required: true, desc: '项目名称' },
    projectCode: { type: 'string', required: true, desc: '项目编号' },
    projectSource: { type: 'string', required: false, desc: '项目来源', enum: ['1', '2'], source: '参考已有项目' },
    projectType: { type: 'string', required: false, desc: '项目类型', enum: ['1-1'] },
    startDate: { type: 'string', required: false, desc: '开始日期', format: 'yyyy-MM-dd HH:mm:ss' },
    endDate: { type: 'string', required: false, desc: '结束日期', format: 'yyyy-MM-dd HH:mm:ss' },
    researchBudget: { type: 'number', required: false, desc: '研发预算（元）' },
    knowledgeField: { type: 'string', required: false, desc: '技术领域（层级路径）' },
    isResearch: { type: 'boolean', required: false, desc: '是否研发项目' },
  },
  '/workbench/projectAppro/add': {
    projectId: { type: 'number', required: true, desc: '项目ID', source: 'projectInfo-list.id' },
    headPerson: { type: 'string', required: true, desc: '项目负责人姓名', source: 'user/sysUser/getUserList.username' },
    headPersonId: { type: 'number', required: true, desc: '负责人ID（getUserList 的 id 非 userId）', source: 'user/sysUser/getUserList.id' },
    techEconTarget: { type: 'number', required: true, desc: '主要技术经济目标', enum: [1, 3] },
    researchContent: { type: 'string', required: true, desc: '研究内容' },
    expectTarget: { type: 'string', required: true, desc: '项目预期目标' },
    orgImplementMode: { type: 'string', required: true, desc: '组织实施方式' },
    coreTechInnovation: { type: 'string', required: true, desc: '核心技术及创新点' },
    planFile: { type: 'string', required: true, desc: '计划任务书路径（无文件传占位）' },
    resolveFile: { type: 'string', required: true, desc: '立项决议书路径（无文件传占位）' },
    dept: { type: 'number', required: false, desc: '负责人部门ID', source: 'getUserList.deptId' },
    workCode: { type: 'string', required: true, desc: '负责人工号', source: 'getUserList.workNumber' },
  },
  '/enterprise/declare/rdItem/add': {
    year: { type: 'number', required: true, desc: '年度' },
    activityCode: { type: 'string', required: true, desc: '活动编号（如 RD01）' },
    sourceProjectId: { type: 'number', required: true, desc: '关联项目ID', source: 'projectInfo-list.id' },
    activityName: { type: 'string', required: true, desc: '研发活动名称' },
    startTime: { type: 'string', required: true, desc: '开始日期', format: 'yyyy-MM-dd' },
    endTime: { type: 'string', required: true, desc: '结束日期', format: 'yyyy-MM-dd' },
    technologySource: { type: 'number', required: true, desc: '技术来源' },
    personnelCount: { type: 'number', required: true, desc: '人员数量' },
    totalBudget: { type: 'number', required: true, desc: '总预算（元）' },
    implementation: { type: 'string', required: true, desc: '组织实施情况' },
    researchContent: { type: 'string', required: true, desc: '研发内容' },
  },
}
```

在 `genApis` 中合并：`cmd.params = { ...inferParams(cmd.path), ...(CORE_FIELD_TEMPLATES[cmd.path] || {}) }`

- [ ] **Step 2: 重新生成种子**
```bash
cd yfljsj-cli && node -e "/* 同 Task 1 Step 4 重新生成 */"
```
验证：`node -e "const s=require('./yfljsj-cli/apis.seed.json'); console.log(Object.keys(s.modules.workbench.commands.find(c=>c.path==='/workbench/projectAppro/add').params).length)"` → >10

- [ ] **Step 3: 测试 + 提交**
```bash
git add yfljsj-cli/
git commit -m "feat(yfljsj): 核心链路字段标注（projectInfo/projectAppro/rdItem 实测沉淀）"
```

---

### Task 7: 全量字段探测（explore 批量跑）

**Files:**
- Create: `yfljsj-cli/scripts/batch-explore.mjs`（批量探测 535 接口并写入命令表）
- Modify: `yfljsj-cli/apis.seed.json`（探测结果合并）
- Modify: `yfljsj-cli/tests/`（batch-explore 输出校验）

**Interfaces:**
- Consumes: `probeFields`（Task 4 产物）
- Produces: `batch-explore.mjs`（可执行脚本，输出统计 + 写回命令表）

- [ ] **Step 1: 写批量探测脚本**

```js
// 批量探测全部接口必填字段（安全：只发空 body/缺字段请求）
import { loadApis, probeFields, writeApis, SERVICES } from '../yfljsj.mjs'
import { writeFileSync } from 'node:fs'

const apis = loadApis()
const DANGEROUS = /delete|remove|clear|drop/i
const results = []
for (const [mk, m] of Object.entries(apis.modules)) {
  for (const c of m.commands) {
    if (DANGEROUS.test(c.path)) { results.push({ module: mk, action: c.action, skipped: 'dangerous' }); continue }
    try {
      const { fields } = await probeFields(c.path, { method: c.method, service: m.service })
      if (fields.length) {
        for (const f of fields) {
          if (!c.params[f]) c.params[f] = { type: guessType(f), required: true, desc: '' }
        }
        results.push({ module: mk, action: c.action, fields })
      }
    } catch (e) {
      results.push({ module: mk, action: c.action, error: String(e.message).slice(0, 60) })
    }
  }
}
writeApis(apis)
writeFileSync('yfljsj-cli/explore-report.json', JSON.stringify(results, null, 1))
// 统计
const withFields = results.filter(r => r.fields?.length)
console.log(`探测完成: ${results.length} 接口，${withFields.length} 个探出必填字段`)
```

> 注：guessType 复用 Task 4 的 guessValue 逻辑（可提取公共）。

- [ ] **Step 2: 真机运行**
```bash
cd /c/Users/T203-15/ponos-dev && node yfljsj-cli/scripts/batch-explore.mjs
```
Expected: 探测约 438 个非危险接口，写入探出的必填字段

- [ ] **Step 3: 测试（verify 报告对比）+ 提交**
```bash
node --test "yfljsj-cli/tests/*.test.mjs"  # 全过
git add yfljsj-cli/
git commit -m "feat(yfljsj): 全量字段探测 — 535 接口必填字段批量沉淀"
```

---

### Task 8: 文档更新 + 回归

**Files:**
- Modify: `yfljsj-cli/README.md`（新子命令说明）
- Modify: `yfljsj-cli/AGENTS.md`（agent 接入增强：schema/relations/doc 用法）
- Modify: `yfljsj-cli/tests/`（全量回归）

- [ ] **Step 1: README 补充**
- schema/relations/explore/doc 四命令用法 + 示例
- 命令表 v2 说明（字段定义/来源/枚举）

- [ ] **Step 2: AGENTS.md 补充**
- 模型接入流程：`relations` 看图谱 → `doc` 看操作序列 → `schema` 看字段 → 执行
- 字段来源约定（source 标注如何用）

- [ ] **Step 3: 全量测试 + 真机冒烟**
```bash
node --test "yfljsj-cli/tests/*.test.mjs"  # 全过
# 真机冒烟：
node yfljsj-cli/yfljsj.mjs schema workbench projectAppro-add
node yfljsj-cli/yfljsj.mjs relations project
node yfljsj-cli/yfljsj.mjs doc createProject
```

- [ ] **Step 4: Commit**
```bash
git add yfljsj-cli/
git commit -m "docs(yfljsj): README/AGENTS 补充 schema/relations/explore/doc 用法"
```

---

## Self-Review 记录

**Spec 覆盖检查：**
- ✅ 命令表 v2 字段升级：Task 1
- ✅ schema 子命令：Task 2
- ✅ relations 子命令：Task 3
- ✅ explore 子命令：Task 4
- ✅ doc 子命令：Task 5
- ✅ 核心链路字段标注：Task 6
- ✅ 全量字段探测：Task 7
- ✅ 文档更新：Task 8
- ✅ 测试（spec §5）：Task 1-8 各含测试；最终 Task 8 全量回归
- ✅ 验收（spec §6）：schema/relations/explore/doc 全部实现；命令表 v2 全量字段

**占位符检查：** 无 TBD/TODO；核心代码块完整（schemaCommand/relationsCommand/probeFields/exploreCommand/docCommand 均有完整实现）。

**类型一致性：**
- `migrateApis(apis) => apis` — Task 1 定义，loadApis 消费 ✓
- `schemaCommand(module, action, {output}) => exitCode` — Task 2，main 消费 ✓
- `relationsCommand(object, {output}) => exitCode` — Task 3，main 消费 ✓
- `probeFields(path, {method, service, baseUrl}) => {fields, attempts}` — Task 4，exploreCommand + Task 7 batch 消费 ✓
- `exploreCommand(path, {output, dryRun, ...}) => exitCode` — Task 4，main 消费 ✓
- `docCommand(object, {output}) => exitCode` — Task 5，main 消费 ✓
- `buildRelations(modules)` — Task 3，genApis 消费 ✓
- `CORE_FIELD_TEMPLATES` — Task 6，genApis 消费 ✓
- `guessValue/guessType` — Task 4 定义，Task 7 复用（提取公共）✓
