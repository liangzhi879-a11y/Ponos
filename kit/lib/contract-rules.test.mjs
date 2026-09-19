// kit/lib/contract-rules.test.mjs —— 契约对账规则 CT0–CT9（T7）
//
// 全部用**夹具仓**（mkdtemp + 显式 files，不依赖 git 与本机状态），每条规则都能独立失败。
// ★ 红线（plan §7 反例⑤）：**CT1 必须现场重算** —— 手改快照一个端点即使文档/scope 全都自洽，
//   也必须报红；本文件里"改坏代码而快照不动"与"手改快照"两个方向各有一条断言。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { readTracked } from './scan.mjs'
import { buildSnapshot } from './contract-snapshot.mjs'
import { parseDoc } from './contract-doc.mjs'
import { loadScope, SCOPE_FILE } from './contract-scope.mjs'
import {
  runContractRules, buildTruth, docDeclaredSets, frontendFetchPaths, frontendDiff, CT_RULES,
} from './contract-rules.mjs'

const ALPHA = [
  'export function route(pathname) {',
  "  if (pathname === '/a') return 1",
  "  if (pathname === '/known') return 1",
  "  if (pathname !== '/b') return null",
  "  if (pathname.startsWith('/ns/')) return 1",
  "  if (pathname.startsWith('/workflows/')) return wf(pathname)",
  '  return null',
  '}',
  // 动态前缀只能靠"锚定正则"表达（CT2/CT3 必须用它，否则 /workflows/:id 系会漏报）
  'export function wf(p) { return p.match(/^\\/workflows\\/([^/]+)(\\/.*)?$/) ? 1 : 0 }',
].join('\n')

const WS_HUB = [
  "export function notify(ws) { send(ws, { type: 'ev1' }) }",
  'export function attach(ws) {',
  "  ws.on('message', (raw) => {",
  "    if (msg.type === 'in1') return",
  '  })',
  '}',
].join('\n')

const TOOLS = [
  'export function createToolRegistry() {',
  "  return { toolSchemas() { return [{ name: 't1', input_schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } }] } }",
  '}',
  'const registry = {',
  '    t1: {',
  "        input_schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },",
  '    },',
  '}',
  'export { registry }',
].join('\n')

const DOC = [
  '# 契约夹具',
  '',
  '## 5. 桥 → GUI 事件',
  '',
  '| 事件 | 说明 |',
  '| --- | --- |',
  '| `ev1` | 出站 |',
  '',
  '## 6. GUI → 桥',
  '',
  '| 事件 | 说明 |',
  '| --- | --- |',
  '| `in1` | 入站 |',
  '',
  '## 7. HTTP REST API',
  '',
  '| 端点 | 说明 |',
  '| --- | --- |',
  '| `/a` | 直判 |',
  '| `/known` | 前端 fetch 的端点 |',
  '',
  '## 7.1 工作流',
  '',
  '| 端点 | 说明 |',
  '| --- | --- |',
  '| `GET /workflows/:id` | 详情（动态段） |',
  '',
].join('\n')

/** 夹具仓：写盘 + 返回 {root, files, doc}；`mutate` 在写盘后跑（造变异） */
function fixture({ mutate = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yfw-rules-'))
  const files = []
  const write = (rel, content) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), content)
    files.push(rel)
  }
  write('server/alpha-routes.mjs', ALPHA)
  write('server/ws-hub.mjs', WS_HUB)
  write('electron/preload.cjs', [
    "const { ipcRenderer } = require('electron')",
    "ipcRenderer.invoke('demo:get', 1)",
    "ipcRenderer.send('demo:fire', 1)",
    "ipcRenderer.on('demo:push', () => {})",
  ].join('\n'))
  write('electron/main.cjs', [
    "const { ipcMain } = require('electron')",
    "ipcMain.handle('demo:get', () => 1)",
    "ipcMain.on('demo:fire', () => {})",
    "mainWindow.webContents.send('demo:push', 1)",
  ].join('\n'))
  write('kernel/tools.mjs', TOOLS)
  write('src/lib/api.ts', [
    "const base = '/bridge'",
    'export const known = () => fetch(`${base}/known`)',
    'export const ghost = () => fetch(`${base}/ghost-path`)',
  ].join('\n'))
  write('docs/bridge-contract.md', DOC)
  if (mutate) mutate(root)
  // ★ 文档**从磁盘重新解析**（不是直接用 `DOC` 常量）：`mutate` 可能改了文档（CT8 的文档在途差异就是这么造的）
  return { root, files, doc: parseDoc(readFileSync(join(root, 'docs/bridge-contract.md'), 'utf8')) }
}

/** 人工登记（**逐条手写**，不由代码生成 —— 反例③）：3 组 = 1 端点 + 1 前缀命名空间 + 1 IPC 推送 */
const SCOPE_ENTRIES = [
  { kind: 'routes', ns: '/b', members: ['ANY /b'], docSection: null, reason: '夹具：`!==` 早退守卫端点，文档 §7 未声明' },
  { kind: 'routes', ns: '/ns/', members: ['ns /ns/'], docSection: null, reason: '夹具：前缀 /ns/ 的段名运行时拼装，children 为空且无锚定正则 ⇒ 静态不可枚举' },
  { kind: 'ipc', ns: 'push', members: ['demo:push'], docSection: null, reason: '夹具：IPC 通道在 bridge-contract.md 零章节，没有可声明的文档面' },
]
function writeScope(root, entries = SCOPE_ENTRIES) {
  mkdirSync(join(root, 'kit/manifest'), { recursive: true })
  writeFileSync(join(root, SCOPE_FILE), JSON.stringify({ version: 1, _note: '人工维护', entries }, null, 2))
  return loadScope({ root })
}

async function setup({ entries = SCOPE_ENTRIES, recorded = { scopeCount: 3, scopeRedCount: 3 }, mutate = null } = {}) {
  const { root, files, doc } = fixture({ mutate })
  const read = (f) => readTracked({ root, file: f })
  const snapshot = await buildSnapshot({ root, files, readTracked: read, now: 'T' })
  const scope = writeScope(root, entries)
  return { root, files, doc, snapshot, scope, recorded, read }
}
const run = (f, over = {}) => runContractRules({
  root: f.root, files: f.files, doc: f.doc, snapshot: f.snapshot, scope: f.scope, recorded: f.recorded, readTracked: f.read, ...over,
})

/**
 * 提交态 / 工作树 **两个**夹具（默认同内容，`mutateWork` 只动工作树那一份）—— CT8 的"在途差异"就靠它造。
 *
 * 为什么必须两个真实目录、而不是"同一个目录改文件"：提交态真值取自 HEAD（物化检出），
 * 工作树取自工作树 —— 两者是**两棵树**。用一个目录造差异只能测出"文件列表不同"，
 * 测不出"同一路径的内容在两侧不同"（那正是最常见的情形：改一行为变体）。
 */
async function setupPair({ mutateWork = null, entries = SCOPE_ENTRIES, recorded = { scopeCount: 3, scopeRedCount: 3 } } = {}) {
  const head = fixture()
  const work = fixture({ mutate: mutateWork })
  const readHead = (f) => readTracked({ root: head.root, file: f })
  const readWork = (f) => readTracked({ root: work.root, file: f })
  const snapshot = await buildSnapshot({ root: head.root, files: head.files, readTracked: readHead, now: 'T' })
  const scope = writeScope(work.root, entries)
  const out = await runContractRules({
    root: work.root, files: work.files, readTracked: readWork,
    headRoot: head.root, headFiles: head.files, headReadTracked: readHead,
    doc: head.doc, docWorktree: work.doc,
    snapshot, scope, recorded,
  })
  return { out, head, work, snapshot, scope, recorded }
}
const ct8 = (out) => out.findings.filter((f) => f.rule === 'CT8')
/** 读改写：供 mutateWork 造"同一路径两侧内容不同" */
const rewrite = (root, rel, fn) => writeFileSync(join(root, rel), fn(readFileSync(join(root, rel), 'utf8')))
const rulesFired = (out) => [...new Set(out.findings.map((x) => x.rule))].sort()
const reds = (out) => out.findings.filter((x) => x.severity === 'red')

test('规则集固定：CT0–CT9（含 CT4B/CT4C 与 CT8）逐条产出 checkResult', async () => {
  const out = await run(await setup())
  assert.deepEqual([...out.checks.map((c) => c.rule)].sort(), [...CT_RULES].sort())
  assert.deepEqual(CT_RULES, ['CT0', 'CT1', 'CT2', 'CT3', 'CT4', 'CT4B', 'CT4C', 'CT5', 'CT6', 'CT7', 'CT8', 'CT9'])
})

test('基准夹具全绿（除 CT9 的黄灯：前端 fetch 存在无 server 路由的 /ghost-path）', async () => {
  const out = await run(await setup())
  assert.deepEqual(reds(out), [], `夹具不该有红灯：${JSON.stringify(reds(out))}`)
  assert.deepEqual(rulesFired(out), ['CT9'], `只有 CT9 允许出 finding（黄、只报不拦），实测 ${rulesFired(out)}`)
  assert.deepEqual(out.findings.map((f) => `${f.rule}:${f.subject}:${f.severity}`), ['CT9:/ghost-path:yellow'])
  assert.equal(out.checks.find((c) => c.rule === 'CT9').passed, false, 'CT9 的 check 如实反映"差集非空"，但 severity 是黄、不阻断')
  // 两侧同一棵树 ⇒ 无在途差异（CT8 恒空、恒绿）
  assert.deepEqual(ct8(out), [])
  assert.equal(out.checks.find((c) => c.rule === 'CT8').passed, true)
})

// ── buildTruth：真值 = 代码真值 ∖ 文档已声明（含"空命名空间"的显式处理） ──────────
test('buildTruth：文档已声明的键不进真值；未被文档覆盖的**前缀命名空间**进真值（显式登记用）', async () => {
  const { root, files, doc } = fixture()
  const read = (f) => readTracked({ root, file: f })
  const { extractRoutes } = await import('./contract-routes.mjs')
  const { extractWs } = await import('./contract-ws.mjs')
  const { extractIpc } = await import('./contract-ipc.mjs')
  const routes = extractRoutes({ files, readTracked: read })
  const ws = extractWs({ files, readTracked: read })
  const ipc = extractIpc({ files, readTracked: read })
  const d0 = docDeclaredSets(doc)
  const t = buildTruth({ routes, prefixes: routes.prefixes, ws, ipc, doc })
  assert.deepEqual(t.truth.routes, ['ANY /b', 'ns /ns/'], '已声明的 /a、/known 不进真值；/ns/ 是命名空间声明（文档零声明）')
  assert.deepEqual(t.truth.wsOut, [], 'ev1 已由 §5 声明')
  assert.deepEqual(t.truth.wsIn, [], 'in1 已由 §6 声明')
  assert.deepEqual(t.truth.ipc, ['demo:push'], 'IPC 无文档章节 ⇒ 推送通道全部需登记')
  // 文档侧：`*` 通配**不给覆盖信用**（反例⑧）—— 只登记在 wildcards 里
  const d = docDeclaredSets(doc)
  assert.deepEqual([...d.paths].sort(), ['/a', '/known'])
  assert.deepEqual([...d.wfKeys].sort(), ['GET /workflows/:id'])
  assert.deepEqual([...d.ws].sort(), ['ev1', 'in1'])
  assert.equal(d.wildcards.size, 0)
})

test('docDeclaredSets：`/providers/*` 只进 wildcards，绝不进 paths（反例⑧）', () => {
  const d = docDeclaredSets(parseDoc([
    '## 7. HTTP',
    '',
    '| 端点 | 说明 |',
    '| --- | --- |',
    '| `/providers` | 列表 |',
    '| `/providers/*` | 命名空间通配 |',
    '',
  ].join('\n')))
  assert.deepEqual([...d.paths], ['/providers'])
  assert.deepEqual([...d.wildcards], ['/providers/*'])
})

// ── CT0 / CT1 ────────────────────────────────────────────────────────
test('CT0：快照缺失 / 形状不完整 → 红（删 channels 键即此情形）', async () => {
  const f = await setup()
  const out = await run(f, { snapshot: null })
  assert.equal(out.checks.find((c) => c.rule === 'CT0').passed, false)
  assert.ok(reds(out).some((x) => x.rule === 'CT0'))
  const broken = await run(f, { snapshot: { ...f.snapshot, ipc: { invoke: [] } } })
  assert.ok(reds(broken).some((x) => x.rule === 'CT0' && /ipc/.test(x.message || '')))
})

test('★CT1 红线：手改快照一个端点 → 红；且**代码变了快照不动**同样红（绝不读快照当答案）', async () => {
  const f = await setup()
  const handEdited = { ...f.snapshot, routes: { ...f.snapshot.routes, 'POST /zzz-hand-edited': null } }
  const out = await run(f, { snapshot: handEdited })
  const ct1 = reds(out).filter((x) => x.rule === 'CT1')
  assert.equal(ct1.length, 1, `逐条报：${JSON.stringify(ct1)}`)
  assert.match(ct1[0].subject, /POST \/zzz-hand-edited/)
  assert.equal(out.checks.find((c) => c.rule === 'CT1').passed, false)
  // 反向：改代码（加端点）而不动快照 —— 若 CT1 读快照当答案，这里会**假绿**
  const f2 = await setup({ mutate: (root) => {
    writeFileSync(join(root, 'server/alpha-routes.mjs'), `${ALPHA}\nexport const extra = (p) => p === '/added-later'\n`)
  } })
  const out2 = await run(f2, { snapshot: f.snapshot })   // 用旧快照
  assert.ok(reds(out2).some((x) => x.rule === 'CT1' && /added-later/.test(x.subject)),
    `代码新增端点而快照未同步必须红，实测 ${JSON.stringify(reds(out2).map((x) => x.subject))}`)
})

// ── CT2 / CT3：双向对账 ───────────────────────────────────────────────
test('CT2：代码新增 WS 出站事件且文档与 scope 都没有 → 红（改坏 send({type:newEv}) 即此情形）', async () => {
  const f = await setup({ mutate: (root) => writeFileSync(join(root, 'server/ws-hub.mjs'), `${WS_HUB}\nexport const fresh = (ws) => send(ws, { type: 'newEv' })\n`) })
  const out = await run(f)
  const ct2 = reds(out).filter((x) => x.rule === 'CT2')
  assert.deepEqual(ct2.map((x) => x.subject), ['wsOut newEv'])
  assert.match(ct2[0].hint, /contract-scope|bridge-contract/)
  // 登记进 scope 后必须转绿（否则"登记"这个机制不成立）
  const fixed = await run(f, {
    scope: writeScope(f.root, [...SCOPE_ENTRIES, { kind: 'wsOut', ns: 'bridge→GUI', members: ['newEv'], docSection: null, reason: '夹具：新增出站事件，文档未声明' }]),
    recorded: { scopeCount: 4, scopeRedCount: 4 },
  })
  assert.deepEqual(reds(fixed).filter((x) => x.rule === 'CT2'), [])
})

test('CT3：文档声明的 /fake 在代码里不存在 → 红（文档腐烂）；删掉文档行即恢复', async () => {
  const f = await setup({ mutate: (root) => writeFileSync(join(root, 'docs/bridge-contract.md'),
    // 把 /fake 插进 **§7 的表内**（追加到文件末尾会落进 §7.1 表，而 §7.1 的行需要方法名 ⇒ 解析不到）
    DOC.replace('| `/known` | 前端 fetch 的端点 |', '| `/known` | 前端 fetch 的端点 |\n| `/fake` | 文档腐烂的端点 |')) })
  // 文档是**传入**的（现场解析），故这里重新解析被改过的文档
  const doc = parseDoc(readTracked({ root: f.root, file: 'docs/bridge-contract.md' }))
  const out = await run(f, { doc })
  const ct3 = reds(out).filter((x) => x.rule === 'CT3')
  assert.deepEqual(ct3.map((x) => x.subject), ['routes /fake'])
  // 动态段：文档里的 /workflows/:id 由**锚定正则**兜住（不得因为 routes 里没有该静态键就报红）
  assert.deepEqual(reds(out).filter((x) => x.rule === 'CT3' && /workflows/.test(x.subject)), [])
})

// ── CT4 / CT4B / CT4C ────────────────────────────────────────────────
test('CT4：members 少一个 → 红；多一个 → 红；写成通配 → CT4C 红且条目失效', async () => {
  const f = await setup()
  const fewer = await run(f, { scope: writeScope(f.root, [SCOPE_ENTRIES[0], SCOPE_ENTRIES[2]]) })
  assert.ok(reds(fewer).some((x) => x.rule === 'CT4' && /ns \/ns\//.test(x.message)), '少登记必须红')
  const more = await run(f, { scope: writeScope(f.root, [...SCOPE_ENTRIES, { kind: 'routes', ns: '/ghost', members: ['ANY /ghost'], docSection: null, reason: '夹具：多登记' }]) })
  assert.ok(reds(more).some((x) => x.rule === 'CT4' && /多登记/.test(x.subject)))
  const wild = await run(f, {
    scope: writeScope(f.root, [SCOPE_ENTRIES[0], { ...SCOPE_ENTRIES[1], members: ['ns /ns/*'] }, SCOPE_ENTRIES[2]]),
  })
  assert.ok(reds(wild).some((x) => x.rule === 'CT4C' && /通配|正则/.test(x.message)), '通配登记必须 CT4C 红')
})

test('CT4B：条数超 channels.scopeCount → 红（组数与键数两条护栏各自独立）', async () => {
  const f = await setup()
  const overCount = await run(f, { recorded: { scopeCount: 1, scopeRedCount: 3 } })
  const b1 = reds(overCount).filter((x) => x.rule === 'CT4B')
  assert.equal(b1.length, 1)
  assert.match(b1[0].subject, /scopeCount/)
  assert.equal(b1[0].expected, '1')
  assert.equal(b1[0].actual, '3')
  const overKeys = await run(f, { recorded: { scopeCount: 3, scopeRedCount: 1 } })
  assert.match(reds(overKeys).filter((x) => x.rule === 'CT4B')[0].subject, /scopeRedCount/)
  const none = await run(f, { recorded: { scopeCount: null, scopeRedCount: null } })
  assert.deepEqual(reds(none).filter((x) => x.rule === 'CT4B'), [], '记录值缺失时不判（与 baselineGrowth 同口径）')
})

test('CT4C：缺 reason → 条目失效并红（且其成员回到"未登记"）', async () => {
  const f = await setup()
  const out = await run(f, { scope: writeScope(f.root, [SCOPE_ENTRIES[0], { ...SCOPE_ENTRIES[1], reason: '  ' }, SCOPE_ENTRIES[2]]) })
  assert.ok(reds(out).some((x) => x.rule === 'CT4C' && /reason/.test(x.message)))
  assert.ok(reds(out).some((x) => x.rule === 'CT4' && /未登记/.test(x.subject)), '失效条目的成员不得被静默放行')
})

// ── CT5：IPC 配对 + push 覆盖 ────────────────────────────────────────
test('CT5：删 main 侧 handle → 红；renderer 侧多 invoke → 红；push 不在 scope → 红', async () => {
  const f = await setup({ mutate: (root) => writeFileSync(join(root, 'electron/main.cjs'), [
    "const { ipcMain } = require('electron')",
    "ipcMain.on('demo:fire', () => {})",
    "mainWindow.webContents.send('demo:push', 1)",
  ].join('\n')) })
  const out = await run(f)
  const ct5 = reds(out).filter((x) => x.rule === 'CT5')
  // 删掉 handle 后：调用侧「没人接」一条；handle 侧**不该**再报一条（它本来就没有该键）
  assert.deepEqual(ct5.map((x) => x.subject), ['invoke demo:get'],
    `双向集合相等的实现必须不重复计数，实测 ${JSON.stringify(ct5)}`)

  const f2 = await setup({ mutate: (root) => writeFileSync(join(root, 'electron/preload.cjs'), [
    "const { ipcRenderer } = require('electron')",
    "ipcRenderer.invoke('demo:get', 1)",
    "ipcRenderer.invoke('demo:ghost', 1)",
    "ipcRenderer.send('demo:fire', 1)",
    "ipcRenderer.on('demo:push', () => {})",
  ].join('\n')) })
  // 多一个 invoke 而 main 侧没有 handle ⇒ subject 报在 **invoke 侧**（调用者没人接）
  assert.ok(reds(await run(f2)).some((x) => x.rule === 'CT5' && x.subject === 'invoke demo:ghost'),
    `实测 ${JSON.stringify(reds(await run(f2)).map((x) => x.subject))}`)

  const f3 = await setup({ entries: [SCOPE_ENTRIES[0], SCOPE_ENTRIES[1]], recorded: { scopeCount: 2, scopeRedCount: 2 } })
  assert.ok(reds(await run(f3)).some((x) => x.rule === 'CT5' && /demo:push/.test(x.subject)),
    'push 每条必须在文档或 scope 里（IPC 无文档章节 ⇒ 只能靠 scope）')
})

// ── CT6：工具出口 ⊆ 快照 / 静态计数 / 动态源登记 ──────────────────────
test('CT6：出口多一个工具 → 红；动态源未登记 → 红；结构指纹变了 → 红', async () => {
  const f = await setup()
  const noSource = { ...f.snapshot, toolSources: { ...f.snapshot.toolSources } }
  delete noSource.toolSources.mcp
  const out1 = await run(f, { snapshot: noSource })
  assert.ok(reds(out1).some((x) => x.rule === 'CT6' && /mcp/.test(String(x.actual) + String(x.subject))))

  // ★ 下面两条用**基准快照**（`f.snapshot`，未变异时落盘的）去比变异后的代码：CT6 的判据是
  //   「代码出口 vs 快照」；若拿变异后重算的快照去比，就变成自证（正是 CT1 红线要防的东西）
  const extraTool = await setup({ mutate: (root) => writeFileSync(join(root, 'kernel/tools.mjs'), TOOLS.replace("name: 't1'", "name: 't2'")) })
  const out2 = await run(extraTool, { snapshot: f.snapshot })
  assert.ok(reds(out2).some((x) => x.rule === 'CT6' && /t2/.test(x.subject)),
    `出口与快照不一致必须红：${JSON.stringify(reds(out2).map((x) => x.subject))}`)

  const shapeChanged = await setup({ mutate: (root) => writeFileSync(join(root, 'kernel/tools.mjs'), TOOLS.replace("required: ['a'] } }] } }", "required: ['a'], additionalProperties: false } }] } }")) })
  const out3 = await run(shapeChanged, { snapshot: f.snapshot })
  assert.ok(reds(out3).some((x) => x.rule === 'CT6' && /指纹/.test(String(x.hint))),
    `结构指纹变化必须红：${JSON.stringify(reds(out3))}`)
})

// ── CT7：提取守恒 ────────────────────────────────────────────────────
test('★CT7：非 sink 处写 {type:\'typo\'} → 红（守恒等式现场成立才绿）', async () => {
  const ok = await run(await setup())
  assert.equal(ok.checks.find((c) => c.rule === 'CT7').passed, true)
  const f = await setup({ mutate: (root) => writeFileSync(join(root, 'server/ws-hub.mjs'), `${WS_HUB}\nexport const stray = { type: 'typo-probe' }\n`) })
  const out = await run(f)
  assert.ok(reds(out).some((x) => x.rule === 'CT7' && /无归宿|守恒/.test(String(x.subject) + String(x.message || '') + String(x.hint))), 'CT7 必须报出该无归宿字面量')
})

test('★CT7：新增 sink 形态未登记（send2）→ 红（"提取不到"不许静默）', async () => {
  const f = await setup({ mutate: (root) => writeFileSync(join(root, 'server/ws-hub.mjs'), `${WS_HUB}\nexport const via = (ws) => send2(ws, { type: 'unseen_ev' })\n`) })
  const out = await run(f)
  assert.ok(reds(out).some((x) => x.rule === 'CT7'))
})

test('CT7：路由侧形态守恒（独立 naive 扫描）—— 删提取器的 startsWith 形态即红', async () => {
  const { root, files } = fixture()
  const read = (f) => readTracked({ root, file: f })
  const { extractRoutes } = await import('./contract-routes.mjs')
  const full = extractRoutes({ files, readTracked: read })
  const { routeFormOrphans } = await import('./contract-rules.mjs')
  assert.deepEqual(routeFormOrphans({ files, readTracked: read, routes: full }), [], '基准：4 形态字面量全部有归宿')
  const crippled = { ...full, prefixes: [] }   // 模拟"提取器不再产出前缀"（startsWith 形态丢失）
  const orphans = routeFormOrphans({ files, readTracked: read, routes: crippled })
  assert.deepEqual(orphans, ['/ns/', '/workflows/'], `startsWith 形态丢失后必须报无归宿，实测 ${JSON.stringify(orphans)}`)
})

// ── CT8：在途差异（工作树 ∖ HEAD）—— 黄、只报不拦 ────────────────────
//
// ★ 本批的核心：契约规则的**真值来源 = 提交态（HEAD）**，在途改动只由 CT8 报黄。
//   两个方向都必须证明：① 在途改动 → 红 0 + CT8 逐条黄；② 提交后漏登记 → CT1/CT2/CT4 红
//   （② 在 cli.test.mjs 的夹具仓用例与"删基线后 M1/M2 必须红"的变异里钉）。
test('★CT8：工作树新增端点（未提交）→ 红灯 0、CT1 不报、CT8 逐条黄灯列出该端点', async () => {
  const { out } = await setupPair({ mutateWork: (root) => rewrite(root, 'server/alpha-routes.mjs', (s) => `${s}\nexport const wip = (p) => p === '/zzz-wip'\n`) })
  assert.deepEqual(reds(out), [], `在途改动不得产生任何红：${JSON.stringify(reds(out))}`)
  assert.equal(out.checks.find((c) => c.rule === 'CT1').passed, true, 'CT1 比的是"台账 vs HEAD"，在他人在途改动下必须照旧 ✔（否则又得靠基线压）')
  const list = ct8(out)
  assert.deepEqual(list.map((f) => f.subject), ['routes ANY /zzz-wip'], `必须逐条列出在途端点：${JSON.stringify(list)}`)
  assert.deepEqual([...new Set(list.map((f) => f.severity))], ['yellow'], 'CT8 只报黄，绝不拦')
  assert.match(list[0].hint, /kit:sync/)
  assert.match(list[0].hint, /contract-scope/)
  assert.equal(out.checks.find((c) => c.rule === 'CT8').passed, false, 'CT8 的 check 如实反映"有在途差异"（黄灯不阻断）')
})

test('★CT8：工作树**删除** committed 端点 → 黄灯，且方向写清（HEAD 有 / 工作树 缺）', async () => {
  const { out } = await setupPair({ mutateWork: (root) => rewrite(root, 'server/alpha-routes.mjs', (s) => s.replace("  if (pathname === '/known') return 1\n", '')) })
  assert.deepEqual(reds(out), [])
  const one = ct8(out).find((f) => f.subject === 'routes ANY /known')
  assert.ok(one, `删除方向也要逐条报：${JSON.stringify(ct8(out))}`)
  assert.equal(one.expected, 'HEAD 有')
  assert.equal(one.actual, '工作树 缺')
})

test('★CT8：在途**文档**改动（删 §7 一行）→ 红灯 0、CT2/CT3/CT4 照旧、CT8 报文档声明差异', async () => {
  const { out } = await setupPair({ mutateWork: (root) => rewrite(root, 'docs/bridge-contract.md', (s) => s.replace('| `/known` | 前端 fetch 的端点 |\n', '')) })
  assert.deepEqual(reds(out), [], `文档在途改动不得红（规则用的是 HEAD 文档）：${JSON.stringify(reds(out))}`)
  const doc = ct8(out).filter((f) => f.subject.startsWith('doc.'))
  assert.deepEqual(doc.map((f) => f.subject), ['doc.routes /known'], `必须报出该在途文档差异：${JSON.stringify(ct8(out))}`)
  assert.equal(doc[0].expected, 'HEAD 有')
  assert.equal(doc[0].actual, '工作树 缺')
})

test('★CT8：工作树把 kernel/tools.mjs 改坏（在途）→ CT6 照旧 ✔（提交态才判），CT8 报工具差异', async () => {
  const { out } = await setupPair({ mutateWork: (root) => writeFileSync(join(root, 'kernel/tools.mjs'), 'export function createToolRegistry() {\n') })
  assert.deepEqual(reds(out), [], `工作树里的工具文件坏掉不得让 CT6 红（提交态的工具出口才是判据）：${JSON.stringify(reds(out))}`)
  assert.equal(out.checks.find((c) => c.rule === 'CT6').passed, true)
  assert.ok(ct8(out).some((f) => f.subject.startsWith('tools ')), `CT8 必须报出工具在途差异：${JSON.stringify(ct8(out))}`)
})

test('★CT8 的边界：提交态读不到（headError）→ CT1 红（"对账不可进行"不是"没事"），不静默拿工作树顶替', async () => {
  const f = await setup()
  const out = await run(f, { headError: 'fatal: ambiguous argument HEAD' })
  const ct1 = reds(out).filter((x) => x.rule === 'CT1')
  assert.deepEqual(ct1.map((x) => x.subject), ['HEAD 物化'])
  assert.equal(out.checks.find((c) => c.rule === 'CT1').passed, false)
  assert.deepEqual(ct8(out), [], 'headError 是 CT1 的红，不是 CT8 的黄（CT8 只报在途差异）')
})

// ── CT9：前端 fetch 单向差集（黄、只报不拦） ──────────────────────────
test('CT9：前端 fetch 路径与 server 路由单向差集；模板基址（/api/${kind}）不算差集', async () => {
  const { root, files } = fixture()
  const read = (f) => readTracked({ root, file: f })
  const fetched = frontendFetchPaths({ files, readTracked: read })
  assert.deepEqual([...fetched.keys()].sort(), ['/ghost-path', '/known'])
  const { extractRoutes } = await import('./contract-routes.mjs')
  const routes = extractRoutes({ files, readTracked: read })
  assert.deepEqual(frontendDiff({ fetched, routes: routes.routes, prefixes: routes.prefixes }), ['/ghost-path'])
  // 组合基址（以 `/` 收尾的模板，如 `/api/` + `${kind}`）只要求"该前缀下有**任何**静态路由"
  const synthetic = new Map([['/api/', ['src/lib/x.ts']], ['/nope/', ['src/lib/y.ts']]])
  const fakeRoutes = new Map([['ANY /api/usage', {}]])
  assert.deepEqual(frontendDiff({ fetched: synthetic, routes: fakeRoutes, prefixes: [] }), ['/nope/'])
  assert.deepEqual(frontendDiff({ fetched: new Map([['/api/', ['src/lib/x.ts']]]), routes: fakeRoutes, prefixes: [] }), [])
})

test('与 plan 一致：CT 规则逐条带 title/evaluated（--verbose 要能看见每条真的跑过）', async () => {
  const out = await run(await setup())
  for (const c of out.checks) {
    assert.equal(typeof c.title, 'string')
    assert.equal(Number.isInteger(c.evaluated), true, `${c.rule} 的 evaluated 必须是整数`)
  }
  assert.equal(out.checks.find((c) => c.rule === 'CT1').evaluated > 0, true)
  assert.equal(out.checks.find((c) => c.rule === 'CT4').evaluated, 3, 'CT4 的 evaluated = 真值键数（夹具 2 路由 + 1 IPC）')
  rmSync(join(tmpdir(), 'yfw-rules-'), { recursive: true, force: true })
})
