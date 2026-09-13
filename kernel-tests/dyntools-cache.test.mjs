// K1.2 工具视图缓存契约（2026-09-13「任务运行慢」系统性优化 Task 3）
// ---------------------------------------------------------------------------
// 背景：`registry.toolNames` / `isConcurrencySafe` / `toolSchemas` / `run` 每次访问都回调
// `dynamicView()`（tools.mjs:1496），实测每迭代 ≈6 次求值 × 22.2ms（技能根 64 项 readdir +
// 逐文件 loadWorkflow + registry/spec/binding 读取）= **132ms/步**，而结果恒为空。
//
// 本文件锁四件事：
//   1) **不陈旧的输入集**：签名必须覆盖「增/删/改名/改型（名字列表）+ 编辑（文件指纹）+
//      应用侧 registry/binding/spec」三类变化，且同盘面连续多次求值**逐字相同**（这才是
//      "只构建一次"的输入侧证明）。
//   2) **Windows mtime 粒度**：等长改写 + `sleep(30)` 必须仍然失效——本条一旦失败，说明该
//      机器的 mtime 不可靠 ⇒ **该机器应默认关缓存**（`PONOS_DYNTOOLS_CACHE=0`）。
//   3) **失败即退化**：不可 stat ⇒ 签名返回 null ⇒ 调用方不缓存（行为回到"每次求值"），
//      绝不抛穿视图函数。ENOENT 例外：那是**合法稳定态**（目录里没有 workflow.yml）。
//   4) **权限副作用与缓存正交**：`syncAppPermissionRules` 有副作用（改 rules.allow/ask），
//      是"进/离控制台即生效"的主机制 ⇒ 必须在缓存判定**之前**每次求值都跑。第 11/12 条
//      分别从行为侧与结构侧钉死这一点。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toolSourceSignature, buildWorkflowTools, createToolsViewCache } from '../kernel/dyntools.mjs'
import { syncAppPermissionRules } from '../kernel/app-permissions.mjs'

const KERNEL_DIR = fileURLToPath(new URL('../kernel', import.meta.url))

const wfYml = (name, extra = '') => `name: ${name}
description: 缓存夹具
expose: { mode: public }
nodes:
  - { id: start, type: start }
  - { id: done, type: end }
edges:
  - { id: e1, source: start, target: done }
${extra}`

// 旧格式（DSL v1）：不可运行、不入工具池，但**同样决定工具池**（legacy 变现代 = 工具池变化）
const LEGACY_YML = `name: legacy-demo
nodes:
  - { id: start, type: start, next: done }
  - { id: done, type: end }
`

/** 最小 home：工作流根 + 应用根（apps 缺省为空目录） */
function makeHome({ legacy = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dyntools-'))
  const wfRoot = join(root, 'workflows')
  const appRoot = join(root, 'apps')
  mkdirSync(join(wfRoot, 'demo'), { recursive: true })
  mkdirSync(appRoot, { recursive: true })
  writeFileSync(join(wfRoot, 'demo', 'workflow.yml'), wfYml('demo'))
  if (legacy) {
    mkdirSync(join(wfRoot, 'old'), { recursive: true })
    writeFileSync(join(wfRoot, 'old', 'workflow.yml'), LEGACY_YML)
  }
  return {
    root, wfRoot, appRoot,
    sig: (files = []) => toolSourceSignature({ workflowRoots: [wfRoot], workflowFiles: files, appRoots: [appRoot] }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

const writeSpec = (appRoot, appId, spec) => {
  mkdirSync(join(appRoot, appId), { recursive: true })
  writeFileSync(join(appRoot, appId, 'spec.json'), JSON.stringify(spec))
}

test('同盘面连续 5 次：签名逐字相同（缓存只构建一次的输入侧证明）', () => {
  const h = makeHome()
  try {
    const files = [join(h.wfRoot, 'demo', 'workflow.yml')]
    const first = h.sig(files)
    assert.equal(typeof first, 'string')
    for (let i = 0; i < 4; i++) assert.equal(h.sig(files), first, `第 ${i + 2} 次求值签名必须一致`)
  } finally { h.cleanup() }
})

test('新增工作流目录（不加 sleep）：名字列表即失效', () => {
  const h = makeHome()
  try {
    const before = h.sig([])
    mkdirSync(join(h.wfRoot, 'later'), { recursive: true })
    writeFileSync(join(h.wfRoot, 'later', 'workflow.yml'), wfYml('later'))
    // 注意：不加 sleep —— 靠的是名字列表，不依赖 mtime
    assert.notEqual(h.sig([]), before, '新增目录必须换签名（否则新工作流要等重启才进池）')
  } finally { h.cleanup() }
})

test('删除工作流目录：名字列表即失效', () => {
  const h = makeHome()
  try {
    const before = h.sig([])
    rmSync(join(h.wfRoot, 'demo'), { recursive: true, force: true })
    assert.notEqual(h.sig([]), before)
  } finally { h.cleanup() }
})

test('名字↔目录互转（flat `x.yml` → `x/workflow.yml`）：签名必须变化', () => {
  const h = makeHome()
  try {
    writeFileSync(join(h.wfRoot, 'flat.yml'), wfYml('flat'))
    const before = h.sig([])
    rmSync(join(h.wfRoot, 'flat.yml'), { force: true })
    mkdirSync(join(h.wfRoot, 'flat'), { recursive: true })
    writeFileSync(join(h.wfRoot, 'flat', 'workflow.yml'), wfYml('flat'))
    assert.notEqual(h.sig([]), before, '条目类型（文件↔目录）入键，否则改型后工具表陈旧')
  } finally { h.cleanup() }
})

test('改已有工作流文件且改变字节数：文件指纹失效', () => {
  const h = makeHome()
  try {
    const f = join(h.wfRoot, 'demo', 'workflow.yml')
    const before = h.sig([f])
    writeFileSync(f, wfYml('demo', 'triggers: 改动后触发词\n'))
    assert.notEqual(h.sig([f]), before)
  } finally { h.cleanup() }
})

test('等长改写 + sleep(30)：Windows mtime 粒度下也必须失效', async () => {
  const h = makeHome()
  try {
    const f = join(h.wfRoot, 'demo', 'workflow.yml')
    const before = h.sig([f])
    const raw = readFileSync(f, 'utf-8')
    // 等长（字节数不变）改写：只有 mtime 能暴露这次变化（size 不变）。若本机 mtime 粒度
    // 粗于此，本条会红 —— 那就说明该机器应默认关缓存（PONOS_DYNTOOLS_CACHE=0）。
    const next = raw.replace('name: demo', 'name: DEMO')
    assert.notEqual(next, raw, '夹具必须真的被改写')
    assert.equal(Buffer.byteLength(next), Buffer.byteLength(raw), '必须是等长改写（size 不变的唯一防线是 mtime）')
    writeFileSync(f, next)
    await new Promise((r) => setTimeout(r, 30))
    assert.notEqual(h.sig([f]), before, '等长改写未被察觉 = 签名不可靠')
  } finally { h.cleanup() }
})

test('不可 stat 的**文件**：返回 null（不抛）= 调用方退化为每次求值', () => {
  const h = makeHome()
  try {
    // 非法路径 → statSync 抛非 ENOENT 异常（ERR_INVALID_ARG_VALUE）
    assert.equal(h.sig(['C:/x/\u0000bad']), null, '文件无法判定 ⇒ 不得缓存')
    assert.equal(toolSourceSignature({ appRoots: ['C:/x/\u0000bad'] }), null, '应用侧同理（registry/binding 走 stat）')
    assert.doesNotThrow(() => h.sig(['C:/x/\u0000bad']))
  } finally { h.cleanup() }
})

test('读不到的**根**：与 discoverWorkflows 同口径（读不到即空）→ 稳定可缓存、且目录出现即失效', () => {
  // 有意的不对称：根用 readdir（失败 ⇒ 空，与发现层一致），文件用 stat（失败 ⇒ 不缓存）。
  // 若根也返回 null，"尚未创建工作流目录"这一常见态会永远不可缓存。
  const a = toolSourceSignature({ workflowRoots: ['C:/x/\u0000bad'] })
  assert.equal(typeof a, 'string')
  assert.equal(toolSourceSignature({ workflowRoots: ['C:/x/\u0000bad'] }), a)
})

test('ENOENT 是合法稳定态（不置 null）：不存在的已知文件仍给出稳定签名', () => {
  const h = makeHome()
  try {
    const ghost = join(h.wfRoot, 'ghost.yml')
    const a = h.sig([ghost])
    assert.equal(typeof a, 'string', 'ENOENT 不得置 null——否则"没有工作流"这一常见态永远不可缓存')
    assert.equal(h.sig([ghost]), a)
  } finally { h.cleanup() }
})

test('工作流根不存在（尚未创建目录）：不抛、稳定可缓存', () => {
  const root = mkdtempSync(join(tmpdir(), 'dyntools-'))
  try {
    const missing = join(root, 'nope')
    const a = toolSourceSignature({ workflowRoots: [missing] })
    assert.equal(typeof a, 'string')
    assert.equal(toolSourceSignature({ workflowRoots: [missing] }), a)
    // 目录随后被创建（GUI 首次新建工作流）→ 必须失效
    mkdirSync(missing, { recursive: true })
    assert.notEqual(toolSourceSignature({ workflowRoots: [missing] }), a)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('应用侧：registry / binding / spec / 新增应用 任一变化都必须失效', () => {
  const h = makeHome()
  try {
    const base = h.sig([])
    writeFileSync(join(h.appRoot, 'registry.json'), JSON.stringify([{ id: 'demo', name: 'Demo' }]))
    const withApp = h.sig([])
    assert.notEqual(withApp, base, 'registry.json 变化（新增应用）必须失效')

    writeSpec(h.appRoot, 'demo', { appId: 'demo', name: 'Demo', commands: [{ action: 'query', kind: 'read' }] })
    const withSpec = h.sig([])
    assert.notEqual(withSpec, withApp, 'spec.json 出现必须失效')

    writeFileSync(join(h.appRoot, 'binding.json'), JSON.stringify({ s1: { appId: 'demo' } }))
    const withBind = h.sig([])
    assert.notEqual(withBind, withSpec, 'binding.json 变化（绑定/解绑）必须失效')
    assert.equal(h.sig([]), withBind, '无变化则稳定')
  } finally { h.cleanup() }
})

test('sourcePaths = 发现实际读过的文件全集（含 legacy 与未入池者）', () => {
  const h = makeHome({ legacy: true })
  try {
    const tools = buildWorkflowTools({ roots: [h.wfRoot], engine: null, agentId: null })
    const paths = tools.sourcePaths
    assert.ok(Array.isArray(paths))
    const norm = paths.map((p) => p.replace(/\\/g, '/'))
    assert.ok(norm.some((p) => p.endsWith('/demo/workflow.yml')), `应含可运行工作流（实际 ${paths}）`)
    assert.ok(norm.some((p) => p.endsWith('/old/workflow.yml')), `legacy 也必须入签名（实际 ${paths}）`)
    for (const p of paths) assert.equal(typeof p, 'string')
  } finally { h.cleanup() }
})

test('sourcePaths 非枚举：`{...tools}` 不带出（与 nameConflicts 同机制）', () => {
  const h = makeHome()
  try {
    const tools = buildWorkflowTools({ roots: [h.wfRoot], engine: null, agentId: null })
    assert.equal(Object.keys(tools).includes('sourcePaths'), false, '不得进工具表视图')
    assert.equal('sourcePaths' in { ...tools }, false, '展开后不得带出')
    assert.ok(Array.isArray(tools.sourcePaths), '但可直接读取（缓存签名用）')
  } finally { h.cleanup() }
})

test('权限副作用与缓存正交：绑定/解绑应用后 rules.ask 必须变化', () => {
  const rules = { allow: [], ask: [] }
  const spec = {
    appId: 'demo', name: 'Demo',
    commands: [{ action: 'query', kind: 'read' }, { action: 'submit', kind: 'write' }],
  }
  // ① 未绑定：不注入
  syncAppPermissionRules({ rules, spec: null })
  assert.deepEqual(rules.ask, [])
  // ② 绑定：write → ask、read → allow（带 `:*` 后缀，见 app-permissions.mjs 头注）
  syncAppPermissionRules({ rules, spec })
  assert.deepEqual(rules.ask, ['app_demo_submit:*'])
  assert.deepEqual(rules.allow, ['app_demo_query:*'])
  // ③ 解绑：精确回收自己注入的（不碰用户手写规则）
  syncAppPermissionRules({ rules, spec: null })
  assert.deepEqual(rules.ask, [], '解绑后必须回收——这正是缓存绝不能包住它的原因')
  assert.deepEqual(rules.allow, [])
})

test('缓存容器：容量上限 + LRU 淘汰（无上限 Map 曾涨到 300MB+）', () => {
  const c = createToolsViewCache({ max: 3 })
  assert.equal(c.max, 3)
  c.set('a', 1); c.set('b', 2); c.set('c', 3)
  assert.equal(c.size, 3)
  c.set('d', 4)                       // 超上限 → 淘汰最久未用 a
  assert.equal(c.size, 3)
  assert.equal(c.get('a'), null, '应淘汰最久未用者')
  c.get('b')                          // 命中 → b 变最近使用
  c.set('e', 5)                       // 淘汰 c（b 刚被刷新，d/e 更新）
  assert.equal(c.get('c'), null)
  assert.equal(c.get('b'), 2, '命中应重插队尾（否则 LRU 退化成 FIFO）')
  assert.equal(c.get('e'), 5)
  // 键为假值（签名不可判定 / 关缓存）= no-op ⇒ 调用方自然退化为每次求值
  assert.equal(c.get(null), null)
  assert.equal(c.get(undefined), null)
  assert.equal(c.get('missing'), null)
  c.set(null, 9)
  assert.equal(c.size, 3, 'null 键不得入表')
  assert.equal(createToolsViewCache().max, 8, '默认上限 8')
  assert.equal(createToolsViewCache({ max: 0 }).max, 8, '非法上限回退默认')
})

test('结构护栏：cli.mjs 里权限注入必须早于缓存命中判定（不被搬进缓存）', () => {
  const src = readFileSync(join(KERNEL_DIR, 'cli.mjs'), 'utf-8')
  const syncAt = src.indexOf('syncAppPermissionRules({ rules: permissionRules')
  const hitAt = src.indexOf('viewCache.get(sig)')
  assert.ok(syncAt > 0, '未找到权限注入调用点')
  assert.ok(hitAt > 0, '未找到缓存命中判定')
  assert.ok(syncAt < hitAt, '权限注入必须每次求值都跑（有副作用），不得被缓存命中短路')
  // 缓存必须包住工具表构造（否则等于没缓存）
  assert.ok(src.indexOf('buildWorkflowTools({ roots: workflowRoots') > hitAt)
})
