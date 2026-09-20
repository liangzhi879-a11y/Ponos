// kit/lib/contract-rules.test.mjs —— 契约对账规则 CT0–CT10（T7）
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
import { fingerprintOf } from './contract-tools.mjs'
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

/** 夹具工具的**结构指纹**：现算（不写死 8 位字面量）—— 写死会在指纹算法演进时变成"文档腐烂"假红，
 *  而本文件要测的是"文档 ↔ 代码逐字对账"这条通路，不是指纹算法本身（它有自己的测试）。 */
const T1_FP = fingerprintOf({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] })
/** 末位翻一位（改指纹用；保证仍是 8 位十六进制） */
const flipLast = (hex) => hex.slice(0, -1) + (hex.slice(-1) === '0' ? '1' : '0')

// ── 品牌夹具（CT10 的 8 条声明点）─────────────────────────────────────────────
//
// 为什么契约夹具也要配品牌文件：下面的「基准夹具全绿」是一条**判据**（"只有 CT9 允许出 finding"），
// 而 CT10 对"真源/声明点取不到值"是 **fail-closed** ⇒ 夹具里缺品牌文件会多出一条与契约无关的红灯，
// 把那些精确断言污染成噪声。⇒ 夹具一开始就配齐 8 条声明点（真源 + 5 个声明点文件）。
// ★ 品牌名**故意不用真仓的**（`FxApp` / `fxk`）：CT10 的判据必须全部来自真源 ——
//   若规则里硬编码了 `YFWorking` / `ponos`，这里的"全绿"立刻变红（这正是该夹具的哨兵作用）。
const FX_APP = 'FxApp'
const FX_KERNEL = 'fxk'
const FX_APP_LABEL = `${FX_APP} 应用（${FX_KERNEL} 内核版）`
const FX_KERNEL_LABEL = `${FX_KERNEL} 内核`
const FX_BRAND_JSON = JSON.stringify({
  schemaVersion: 1,
  note: '夹具品牌真源（8 条声明点；判据见 kit/lib/brand-rules.test.mjs）',
  layers: [
    { id: 'app', name: FX_APP, note: '夹具应用层' },
    { id: 'kernel', name: FX_KERNEL, note: '夹具内核层' },
  ],
  brandZh: { name: '夹具中文名', where: '夹具标识资源用此名' },
  declarations: [
    { id: 'product-name', file: 'electron-builder.yml', kind: 'yaml-scalar', key: 'productName', expects: { layer: 'app' }, why: '夹具：安装产品名', severityIfWrong: 'red' },
    { id: 'window-title', file: 'index.html', kind: 'html-title', expects: { layer: 'app' }, why: '夹具：窗口标题', severityIfWrong: 'red' },
    { id: 'app-id', file: 'electron-builder.yml', kind: 'yaml-scalar', key: 'appId', expects: { literal: 'com.fx.desktop' }, why: '夹具：安装身份', severityIfWrong: 'red' },
    { id: 'npm-name', file: 'package.json', kind: 'json-key', key: 'name', expects: { literal: 'fx-pkg' }, why: '夹具：包名', severityIfWrong: 'red' },
    { id: 'app-label', file: 'version.mjs', kind: 'comment-label', constName: 'APP_VERSION', expects: { layer: 'app' }, why: '夹具：应用线注释', severityIfWrong: 'red' },
    { id: 'kernel-label', file: 'version.mjs', kind: 'comment-label', constName: 'KERNEL_VERSION', expects: { layer: 'kernel' }, why: '夹具：内核线注释', severityIfWrong: 'red' },
    { id: 'lines-label-app', file: 'kit/manifest/versions.json', kind: 'json-pointer', pointer: 'lines[id=APP_VERSION].label', expects: { layer: 'app' }, why: '夹具：台账应用线 label', severityIfWrong: 'red' },
    { id: 'lines-label-kernel', file: 'kit/manifest/versions.json', kind: 'json-pointer', pointer: 'lines[id=KERNEL_VERSION].label', expects: { layer: 'kernel' }, why: '夹具：台账内核线 label', severityIfWrong: 'red' },
    // ★ 与真源同步的第 9–14 条（`REQUIRED_DECLARATIONS` 已扩到 14 ⇒ 夹具也必须凑齐，
    //   否则 `CT10` 会判"真源结构不合法"而红 —— 这正是它该有的 fail-closed 行为）
    { id: 'meta-description', file: 'index.html', kind: 'html-meta-description', expects: { layer: 'app' }, why: '夹具：页面摘要', severityIfWrong: 'red' },
    { id: 'shortcut-name', file: 'electron-builder.yml', kind: 'yaml-scalar', key: 'shortcutName', expects: { layer: 'app' }, why: '夹具：快捷方式名', severityIfWrong: 'red' },
    { id: 'copyright', file: 'electron-builder.yml', kind: 'yaml-scalar', key: 'copyright', expects: { layer: 'app' }, why: '夹具：版权行', severityIfWrong: 'red' },
    { id: 'pkg-description', file: 'package.json', kind: 'json-key', key: 'description', expects: { layer: 'app' }, why: '夹具：包摘要', severityIfWrong: 'red' },
    { id: 'kernel-pkg-name', file: 'kernel/package.json', kind: 'json-key', key: 'name', expects: { layer: 'kernel' }, why: '夹具：内核包名', severityIfWrong: 'red' },
    { id: 'kernel-pkg-description', file: 'kernel/package.json', kind: 'json-key', key: 'description', expects: { layer: 'kernel' }, why: '夹具：内核包摘要', severityIfWrong: 'red' },
  ],
  retiredAliases: [{ alias: 'Ponos-Turbo', replaceWith: 'ponos', layer: 'kernel', why: '夹具：内核层统一为 ponos（无 turbo）', scope: 'declarations' }],
  knownWidespread: [{
    alias: 'Ponos-Turbo',
    counts: { exactCaseSensitive: { lines: 33, files: 12 }, aliasFamily: { lines: 115, files: 61 } },
    measuredAt: 'fixture',
    recompute: 'git grep -F "Ponos-Turbo" HEAD -- \':!*.lock\' | wc -l',
    why: '夹具：散在 kernel/、kernel-tests/ 与 docs 的叙述文本里（不在本门禁范围）',
  }],
}, null, 2)

/** 把 **14 条**声明点所需的文件写进夹具（`write` 由各夹具自己给，签名见 `fixture()`）
 *  ★ 条数必须与 `brand-rules.mjs#REQUIRED_DECLARATIONS` 一致：少写一条 ⇒ `CT10` 判"真源结构不合法"而红
 *  ——这是 fail-closed 该有的行为，所以夹具必须跟着真源走。 */
function writeBrandFixture(write, { npmName = 'fx-pkg' } = {}) {
  const truth = JSON.parse(FX_BRAND_JSON)
  truth.declarations.find((d) => d.id === 'npm-name').expects.literal = npmName
  write('kit/manifest/brand.json', JSON.stringify(truth, null, 2))
  // 后 6 条新增声明点落在这些文件里：yml 的 shortcutName/copyright、html 的 meta、
  // package.json 的 description、以及内核包 kernel/package.json 的 name/description
  write('electron-builder.yml', `appId: com.fx.desktop\nproductName: ${FX_APP}\n`
    + `  shortcutName: ${FX_APP}\ncopyright: Copyright © 2026 ${FX_APP}\n`)
  write('index.html', `<!doctype html>\n<html><head>\n  <title>${FX_APP}</title>\n`
    + `  <meta name="description" content="${FX_APP} —— 夹具应用">\n</head></html>\n`)
  write('version.mjs', `// 夹具版本线\n//   1. APP_VERSION     — ${FX_APP_LABEL}\n//   2. KERNEL_VERSION  — ${FX_KERNEL_LABEL}\n`
    + "export const APP_VERSION = 'dev 1.0.0'\nexport const KERNEL_VERSION = 'dev 0.1'\n")
  write('package.json', JSON.stringify({ name: npmName, version: '1.0.0', description: `${FX_APP} 夹具应用` }, null, 2))
  write('kernel/package.json', JSON.stringify({
    name: `${FX_KERNEL}-kernel`, version: '0.1.0', description: `${FX_KERNEL} 内核独立部署包（夹具）`,
  }, null, 2))
  write('kit/manifest/versions.json', JSON.stringify({
    version: 1,
    lines: [
      { id: 'APP_VERSION', label: FX_APP_LABEL, file: 'version.mjs', value: 'dev 1.0.0' },
      { id: 'KERNEL_VERSION', label: FX_KERNEL_LABEL, file: 'version.mjs', value: 'dev 0.1' },
    ],
  }, null, 2))
}

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
  // ★ P1.5：夹具也要有 §12（工具出口），否则 `t1` 进真值 ⇒ 基准夹具不再全绿。
  //   注意**用途列不写反引号**：§12 的行是整行取反引号 token 的（散文里的裸串会被当候选）。
  '## 12. 工具 input_schema 出口',
  '',
  '| 工具 | 结构指纹 | 用途 |',
  '| --- | --- | --- |',
  `| \`t1\` | \`${T1_FP}\` | 夹具工具 |`,
  '',
].join('\n')

/** 夹具文档 + 一节 §11（IPC 推送）：P1.5 起 IPC 也能靠文档面覆盖，不再只有"登记"一条路 */
const docWithIpc = (ch = 'demo:push', base = DOC) => `${base}\n## 11. IPC 通道（主进程 → 渲染层推送）\n\n| 通道 | 方向 | 时机 |\n| --- | --- | --- |\n| \`${ch}\` | 主进程 → 渲染层 | 夹具：推送通道 |\n`

/** 夹具仓：写盘 + 返回 {root, files, doc}；`mutate` 在写盘后跑（造变异） */
function fixture({ mutate = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yfw-rules-'))
  const files = []
  const write = (rel, content) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), content)
    files.push(rel)
  }
  writeBrandFixture(write)
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

test('规则集固定：CT0–CT10（含 CT4B/CT4C、CT8 与品牌 CT10）逐条产出 checkResult', async () => {
  const out = await run(await setup())
  assert.deepEqual([...out.checks.map((c) => c.rule)].sort(), [...CT_RULES].sort())
  assert.deepEqual(CT_RULES, ['CT0', 'CT1', 'CT2', 'CT3', 'CT4', 'CT4B', 'CT4C', 'CT5', 'CT6', 'CT7', 'CT8', 'CT9', 'CT10'])
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
  assert.deepEqual(t.truth.ipc, ['demo:push'], 'IPC 在夹具文档里零章节 ⇒ 推送通道全部需登记')
  assert.deepEqual(t.truth.tools, [], 't1 已由 §12 声明（P1.5 起工具出口进真值；声明的从真值减掉）')
  // 文档侧：`*` 通配**不给覆盖信用**（反例⑧）—— 只登记在 wildcards 里
  const d = docDeclaredSets(doc)
  assert.deepEqual([...d.paths].sort(), ['/a', '/known'])
  assert.deepEqual([...d.wfKeys].sort(), ['GET /workflows/:id'])
  // WS 按**方向**两个字段（收尾批起不再合成一个 `ws`）：出站只认 §5、入站只认 §6
  assert.deepEqual([...d.wsOut].sort(), ['ev1'], '§5 只声明出站 ev1')
  assert.deepEqual([...d.wsIn].sort(), ['in1'], '§6 只声明入站 in1')
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

// ── 批 M：CT3 的**方法维度**（文档声明的方法必须在代码里有相容的键）──────────────
//
// 为什么单立一节：此前 CT3 只比**路径**（`POST /x` 与 `GET /x` 视为同一端点）⇒ 文档把方法写反
// **不红**（"真做假面"）。相容关系必须**明确定义**（原文见 contract-rules.mjs 的 CT3 段）：
//   · 代码键 = `'<METHOD> <path>'`（`METHOD ∈ {ANY, GET, POST, …}`），**`ANY` 与任意方法相容**；
//   · **文档没写方法**（只写路径）⇒ **不判方法**（只判路径存在；否则一行未写方法就炸出假红）；
//   · 文档写了方法 ⇒ **逐个判**：每个被声明的方法都要有相容的代码键（`GET /x、POST /x` 需要代码里
//     两种都有，或 `ANY`；两个方向都不相交时当然也红 —— 逐条判是"不相交⇒红"的严格化）；
//   · 路径只被**动态前缀**认领（`/workflows/:id` 这类）⇒ 方法不可静态判定 ⇒ 只判路径、不判方法。
/** 方法维度的最小夹具：代码侧一个受方法守卫的端点 + 文档 §7 一行（两棵树同内容 ⇒ 无 CT8 噪声） */
async function methodFixture({ docRow, code, wfRow = null }) {
  const mk = () => {
    const root = mkdtempSync(join(tmpdir(), 'yfw-method-'))
    // 品牌文件同样要齐（CT10 fail-closed ⇒ 少了会多出与"方法维度"无关的红灯）
    writeBrandFixture((rel, content) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true })
      writeFileSync(join(root, rel), content)
    })
    mkdirSync(join(root, 'server'), { recursive: true })
    writeFileSync(join(root, 'server/m-routes.mjs'), code)
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs/bridge-contract.md'), [
      '# 方法维度夹具', '',
      '## 7. HTTP REST API', '',
      '| 端点 | 用途 |', '| --- | --- |', docRow, '',
      ...(wfRow ? ['### 7.1 工作流', '', '| 方法 + 路径 | 请求体 |', '| --- | --- |', wfRow, ''] : []),
    ].join('\n'))
    return root
  }
  const headRoot = mk()
  const workRoot = mk()
  const files = ['server/m-routes.mjs', 'docs/bridge-contract.md']
  const readHead = (f) => readTracked({ root: headRoot, file: f })
  const readWork = (f) => readTracked({ root: workRoot, file: f })
  const doc = parseDoc(readHead('docs/bridge-contract.md'))
  const snapshot = await buildSnapshot({ root: headRoot, files, readTracked: readHead, now: 'T' })
  const out = await runContractRules({
    root: workRoot, files, readTracked: readWork,
    headRoot, headFiles: files, headReadTracked: readHead, doc, docWorktree: doc,
    snapshot, scope: null, recorded: { scopeCount: null, scopeRedCount: null },
  })
  return { out, root: workRoot, docLine: 7 }
}
const ct3red = (out) => reds(out).filter((x) => x.rule === 'CT3')
/** 代码侧只认 GET 的端点（键 = `GET /m`） */
const CODE_GET_ONLY = ['export function route(pathname, method) {', "  if (pathname === '/m' && method === 'GET') return 1", '  return null', '}'].join('\n')
/** 代码侧不认方法（键 = `ANY /m`）：与任意文档方法相容 */
const CODE_ANY = ['export function route(pathname) {', "  if (pathname === '/m') return 1", '  return null', '}'].join('\n')
/** 代码侧认 GET 与 POST（键 = `GET /m` + `POST /m`） */
const CODE_GET_POST = [
  'export function route(pathname, method) {',
  "  if (pathname === '/m' && method === 'GET') return 1",
  "  if (pathname === '/m' && method === 'POST') return 1",
  '  return null',
  '}',
].join('\n')

test('★批 M① 文档写 `（POST）`、代码只有 `GET /m` ⇒ CT3 红（finding 写清"文档声明 POST、代码只有 GET"）', async () => {
  const { out } = await methodFixture({ docRow: '| `/m`（POST） | 写端点 |', code: CODE_GET_ONLY })
  const f = ct3red(out)
  assert.equal(f.length, 1, `必须恰好一条方法红灯：${JSON.stringify(f)}`)
  assert.equal(f[0].subject, 'routes POST /m')
  assert.match(f[0].expected, /POST \/m/, 'expected 要写出文档声明的方法+路径')
  assert.match(f[0].actual, /GET/, 'actual 要写出代码实际有的方法（"代码只有 GET"）')
  assert.equal(f[0].file, 'docs/bridge-contract.md', '文档侧的问题要指到文档那行（可定位）')
  assert.equal(f[0].line, 7)
})

test('★批 M② 代码是 `ANY /m`（不认方法）⇒ 与任意文档方法相容 ⇒ 绿', async () => {
  const { out } = await methodFixture({ docRow: '| `/m`（POST） | 写端点 |', code: CODE_ANY })
  assert.deepEqual(ct3red(out), [], `ANY 与任意方法相容（真仓有 ANY /agents 这类键）：${JSON.stringify(ct3red(out))}`)
})

test('★批 M③ 文档只写路径（没写方法）⇒ **不判方法**（保持路径粒度语义，避免海量假红）', async () => {
  const { out } = await methodFixture({ docRow: '| `/m` | 只写路径 |', code: CODE_GET_ONLY })
  assert.deepEqual(ct3red(out), [], `没写方法就只判路径存在：${JSON.stringify(ct3red(out))}`)
})

test('★批 M④ 文档 `GET /m、POST /m`、代码只有 `GET /m` ⇒ 红（一条声明里多方法要逐个判）', async () => {
  const { out } = await methodFixture({ docRow: '| `GET /m`、`POST /m` | 行内两方法 |', code: CODE_GET_ONLY })
  const f = ct3red(out)
  assert.deepEqual(f.map((x) => x.subject), ['routes POST /m'], `缺的那条要指名道姓：${JSON.stringify(f.map((x) => x.subject))}`)
})

test('★批 M⑤ 方法**完备**时绿；声明的方法与代码方法集**不相交**时红（`PUT` vs 代码 `GET/POST`）', async () => {
  const ok = await methodFixture({ docRow: '| `POST /m` | 写端点 |', code: CODE_GET_POST })
  assert.deepEqual(ct3red(ok.out), [], '代码里有 `POST /m` ⇒ 绿')
  const bad = await methodFixture({ docRow: '| `PUT /m` | 覆盖写 |', code: CODE_GET_POST })
  const f = ct3red(bad.out)
  assert.equal(f.length, 1)
  assert.equal(f[0].subject, 'routes PUT /m')
  assert.match(f[0].actual, /GET\/POST|POST\/GET/, 'actual 列出代码该路径下的全部方法键')
})

test('★批 M⑥ §7.1 的静态行同样判方法；只有动态段认领的路径不判（方法不可静态判定）', async () => {
  const code = ['export function route(pathname, method) {',
    "  if (pathname === '/workflows' && method === 'GET') return 1",
    "  if (pathname.startsWith('/workflows/')) return wf(pathname)",
    '  return null',
    '}',
    'export function wf(p) { return p.match(/^\\/workflows\\/([^/]+)(\\/.*)?$/) ? 1 : 0 }'].join('\n')
  const badWf = await methodFixture({
    docRow: '| `/workflows` | 只写路径（不判方法） |', code,
    wfRow: '| `POST /workflows` | 建工作流 |',
  })
  assert.deepEqual(ct3red(badWf.out).map((x) => x.subject), ['routes POST /workflows'],
    '§7.1 的 `METHOD path` 键也是"文档声明的方法"，静态命中时必须判')
  const dyn = await methodFixture({
    docRow: '| `/workflows` | 只写路径（不判方法） |', code,
    wfRow: '| `DELETE /workflows/:id` | 删（只有动态段认领 ⇒ 不判方法） |',
  })
  assert.deepEqual(ct3red(dyn.out), [], '动态段认领的路径只判路径（`/workflows/:id` 系列方法不可静态判定）')
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
    'push 每条必须在文档 §11 或 scope 里（夹具文档没有 §11 ⇒ 只能靠 scope）')
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

// ★ 第 4 批（收口，低危）：双引号形态（`pathname === "/x"`）原先**两侧都只认单引号** ⇒ 静默漏抓：
//   提取器看不见它（CT1/CT2/CT4 全绿），CT7 的独立重扫也看不见它（守恒等式照样成立）。
//   这里钉两件事：① 提取器认双引号（进而 CT2/CT4 会红）；② CT7 的独立重扫与提取器**同口径**
//   （否则同一处字面量会一边"有归宿"一边"无归宿" ⇒ 假红）。
test('★双引号端点：CT2/CT4 必须红（修前提取器只认单引号 ⇒ 全静默）', async () => {
  const f = await setup({ mutate: (root) => writeFileSync(join(root, 'server/alpha-routes.mjs'),
    `${ALPHA}\nexport const dq = (p) => p === "/zzz-dq"\n`) })
  const out = await run(f)
  assert.ok(reds(out).some((x) => x.rule === 'CT2' && /zzz-dq/.test(x.subject)),
    `双引号端点必须进代码真值 ⇒ CT2 报"未覆盖"，实测 reds=${JSON.stringify(reds(out).map((x) => `${x.rule}:${x.subject}`))}`)
  assert.ok(reds(out).some((x) => x.rule === 'CT4' && /zzz-dq/.test(x.subject)),
    `同样必须进 scope 集合对账（CT4），实测 reds=${JSON.stringify(reds(out).map((x) => `${x.rule}:${x.subject}`))}`)
})

test('★双引号形态：CT7 的独立重扫与提取器同口径（双引号字面量必须有归宿）', async () => {
  const { root, files } = fixture({ mutate: (r) => writeFileSync(join(r, 'server/alpha-routes.mjs'),
    `${ALPHA}\nexport const dq = (p) => p === "/zzz-dq"\nexport const dqNs = (p) => p.startsWith("/zzz-ns/")\nexport const DQS = new Set(["/zzz-set"])`) })
  const read = (f) => readTracked({ root, file: f })
  const { extractRoutes } = await import('./contract-routes.mjs')
  const { routeFormOrphans } = await import('./contract-rules.mjs')
  const full = extractRoutes({ files, readTracked: read })
  assert.deepEqual([...full.routes.keys()].filter((k) => k.includes('/zzz-')).sort(), ['ANY /zzz-dq', 'ANY /zzz-set'],
    `三种双引号形态（=== / new Set / startsWith）都必须被提取：实测 ${[...full.routes.keys()].filter((k) => k.includes('/zzz-')).join('|') || '无'}`)
  assert.deepEqual(full.prefixes.filter((p) => p.prefix === '/zzz-ns/').length, 1, '双引号 startsWith 进 prefixes')
  assert.deepEqual(routeFormOrphans({ files, readTracked: read, routes: full }), [],
    '独立重扫必须与提取器同口径（少认一种引号 ⇒ 同一处一边"有归宿"一边"无归宿"）')
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

test('★CT8 的等价性捷径：`worktreeIdentical:true` ⇒ **不读工作树**（第二遍提取整段跳过）、CT8 空', async () => {
  const f = await setup()
  let calls = 0
  const out = await runContractRules({
    root: f.root, files: f.files, doc: f.doc, snapshot: f.snapshot, scope: f.scope, recorded: f.recorded,
    headRoot: f.root, headFiles: f.files, headReadTracked: f.read,
    // 只有"跳过"才可能一次都不读工作树；读了就抛（把"捷径真的走了"变成可证伪的断言）
    readTracked: () => { calls++; throw new Error('worktreeIdentical:true 时不得读工作树') },
    worktreeIdentical: true,
  })
  assert.equal(calls, 0, '捷径必须真的跳过第二遍提取（实测 ≈0.8 s/次，CI 每次都会走这条路）')
  assert.deepEqual(ct8(out), [])
  assert.equal(out.checks.find((c) => c.rule === 'CT8').passed, true)
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
  assert.equal(out.checks.find((c) => c.rule === 'CT4').evaluated, 3, 'CT4 的 evaluated = 真值键数（夹具 2 路由 + 1 IPC；§12 声明的 t1 从真值里减掉了，故不计）')
  rmSync(join(tmpdir(), 'yfw-rules-'), { recursive: true, force: true })
})

// ── P1.5：真对账从「路由 + WS」扩到**五类**（IPC §11 / 工具出口 §12 进文档面）─────────
//
// 判据 (c) 的三个方向在下面各有一条**单元级**用例（端到端版在 cli.test.mjs 与批报告变异记录里）：
//   ① 删掉一条 §11 声明 ⇒ 该通道回到真值 ⇒ **CT2（未覆盖）+ CT4（未登记）双红**；
//   ② 改掉一个工具指纹（末位改一位）⇒ **CT3 红**（逐字比对）；缺指纹同样红（fail-closed）；
//   ③ 反向：把已摘除的成员塞回 scope ⇒ **CT4 多登记红**。
// 三条共同证明的不是"能报红"，而是**登记的语义变了**：文档声明得越全，登记集越小 ——
// 登记只该剩"没法写进文档的空洞"，而不是"文档没写的部分"。

test('★P1.5-buildTruth：工具出口进真值；§12 声明后从真值里减掉（两个方向都可证伪）', async () => {
  const { root, files } = fixture()
  const read = (f) => readTracked({ root, file: f })
  const { extractRoutes } = await import('./contract-routes.mjs')
  const { extractWs } = await import('./contract-ws.mjs')
  const { extractIpc } = await import('./contract-ipc.mjs')
  const { extractTools } = await import('./contract-tools.mjs')
  const routes = extractRoutes({ files, readTracked: read })
  const ws = extractWs({ files, readTracked: read })
  const ipc = extractIpc({ files, readTracked: read })
  const tools = await extractTools({ root })
  assert.deepEqual(tools.names, ['t1'], '前提：夹具只有一个静态工具')
  const text = readFileSync(join(root, 'docs/bridge-contract.md'), 'utf8')
  const withS12 = parseDoc(text)
  assert.deepEqual(buildTruth({ routes, prefixes: routes.prefixes, ws, ipc, tools, doc: withS12 }).truth.tools, [],
    '§12 声明了 t1 ⇒ 不在真值里')
  // 删掉整节 §12 ⇒ t1 回到真值（= "代码有、文档没有" ⇒ 必须有人接住：补文档或登记）
  const noS12 = parseDoc(text.replace(/^## 12\.[\s\S]*$/m, ''))
  assert.deepEqual(buildTruth({ routes, prefixes: routes.prefixes, ws, ipc, tools, doc: noS12 }).truth.tools, ['t1'])
  // 老调用口径（不传 tools）不炸：空集（夹具之外的调用方不必改签名）
  assert.deepEqual(buildTruth({ routes, prefixes: [], ws, ipc, doc: noS12 }).truth.tools, [])
})

test('★P1.5-变异①：§11 声明后 IPC 不必登记；删掉该声明 ⇒ CT2（未覆盖）+ CT4（未登记）双红', async () => {
  // 基准：文档补上 §11 且**摘掉** ipc 的 scope 登记（P1.5 的形状：登记集 3 → 2）
  const f = await setup({
    entries: [SCOPE_ENTRIES[0], SCOPE_ENTRIES[1]], recorded: { scopeCount: 2, scopeRedCount: 2 },
    mutate: (root) => writeFileSync(join(root, 'docs/bridge-contract.md'), docWithIpc()),
  })
  const green = await run(f)
  assert.deepEqual(reds(green), [], `§11 声明 + 摘掉登记后必须全绿：${JSON.stringify(reds(green))}`)
  assert.equal(green.checks.find((c) => c.rule === 'CT5').passed, true, 'CT5 的 push 覆盖判据必须认文档 §11')
  // 变异：把 §11 里的通道名改掉（= 原通道不再被声明）
  rewrite(f.root, 'docs/bridge-contract.md', () => docWithIpc('demo:push-renamed'))
  const doc2 = parseDoc(readTracked({ root: f.root, file: 'docs/bridge-contract.md' }))
  const out = await run(f, { doc: doc2 })
  const got = reds(out).map((x) => `${x.rule}:${x.subject}`)
  assert.ok(got.includes('CT2:ipc demo:push'), `CT2 必须报"未覆盖"：${JSON.stringify(got)}`)
  assert.ok(got.includes('CT4:ipc 未登记 demo:push'), `CT4 必须报"未登记"：${JSON.stringify(got)}`)
  assert.ok(got.includes('CT3:ipc demo:push-renamed'), `文档写的新通道代码里没有 ⇒ CT3 也红：${JSON.stringify(got)}`)
})

test('★P1.5-变异②：§12 工具指纹改末位一位 ⇒ CT3 红（逐字比对）；缺指纹同样红（fail-closed）', async () => {
  const f = await setup({ mutate: (root) => rewrite(root, 'docs/bridge-contract.md', (s) => s.replace(T1_FP, flipLast(T1_FP))) })
  const ct3 = reds(await run(f)).filter((x) => x.rule === 'CT3')
  assert.deepEqual(ct3.map((x) => x.subject), ['tools t1'], `指纹不一致必须报在 tools t1：${JSON.stringify(reds(await run(f)))}`)
  assert.equal(ct3[0].expected, flipLast(T1_FP), 'expected = 文档里写的（含错的那位）')
  assert.equal(ct3[0].actual, T1_FP, 'actual = 代码出口的实际指纹')
  // 缺指纹（把反引号摘掉 ⇒ 解析成 fp=null）不许"跳过比对"，必须红
  const f2 = await setup({ mutate: (root) => rewrite(root, 'docs/bridge-contract.md', (s) => s.replace('`' + T1_FP + '`', T1_FP)) })
  const ct3b = reds(await run(f2)).filter((x) => x.rule === 'CT3')
  assert.deepEqual(ct3b.map((x) => x.subject), ['tools t1'])
  assert.equal(ct3b[0].actual, '文档里没给指纹')
})

test('★P1.5-变异③：把已由 §11 覆盖的成员塞回 scope ⇒ CT4 多登记红（登记集必须与真值差集相等）', async () => {
  const f = await setup({
    entries: [...SCOPE_ENTRIES], recorded: { scopeCount: 3, scopeRedCount: 3 },
    mutate: (root) => writeFileSync(join(root, 'docs/bridge-contract.md'), docWithIpc()),
  })
  const got = reds(await run(f)).map((x) => `${x.rule}:${x.subject}`)
  assert.ok(got.includes('CT4:ipc 多登记 demo:push'),
    `文档已声明却仍登记 = 给已覆盖的键发放豁免 ⇒ 必须红：${JSON.stringify(got)}`)
  assert.equal(got.some((x) => x.startsWith('CT2:ipc')), false, 'CT2 是"未覆盖"方向：已被文档声明 ⇒ 不该出现在这一侧')
})

test('★P1.5：工具出口进 CT2/CT4 —— §12 声明被删 ⇒ CT2+CT4 双红；登记后转绿', async () => {
  const f = await setup({ mutate: (root) => rewrite(root, 'docs/bridge-contract.md', (s) => s.split('\n').filter((l) => !l.includes('| `t1` |')).join('\n')) })
  const got = reds(await run(f)).map((x) => `${x.rule}:${x.subject}`)
  assert.ok(got.includes('CT2:tools t1'), `CT2 必须报"未覆盖"：${JSON.stringify(got)}`)
  assert.ok(got.includes('CT4:tools 未登记 t1'), `CT4 必须报"未登记"：${JSON.stringify(got)}`)
  const fixed = await run(f, {
    scope: writeScope(f.root, [...SCOPE_ENTRIES, { kind: 'tools', ns: 'static', members: ['t1'], docSection: '§12', reason: '夹具：工具未在 §12 声明，按精确键登记' }]),
    recorded: { scopeCount: 4, scopeRedCount: 4 },
  })
  assert.deepEqual(reds(fixed), [], `登记后必须转绿（登记这条通路是真的能放行且只放行它登记的那条）：${JSON.stringify(reds(fixed))}`)
})

test('★P1.5-CT3：文档声明了代码没有的工具 ⇒ 红（文档腐烂），且不掩盖真差异', async () => {
  const f = await setup({
    mutate: (root) => rewrite(root, 'docs/bridge-contract.md',
      (s) => s.replace(`| \`t1\` | \`${T1_FP}\` |`, `| \`NoSuchTool\` | \`${T1_FP}\` | 夹具：代码里没有 |\n| \`t1\` | \`${T1_FP}\` |`)),
  })
  const ct3 = reds(await run(f)).filter((x) => x.rule === 'CT3')
  assert.deepEqual(ct3.map((x) => x.subject), ['tools NoSuchTool'])
  assert.equal(ct3[0].actual, '代码里没有该工具')
})

test('★P1.5-CT8：文档声明集的在途差异覆盖新增的 ipc/tools 两类（DECLARED_FIELDS 扩域）', async () => {
  const { out } = await setupPair({ mutateWork: (root) => rewrite(root, 'docs/bridge-contract.md', (s) => docWithIpc('demo:push', s)) })
  assert.deepEqual(reds(out), [], `文档在途改动不得红（规则读 HEAD 文档）：${JSON.stringify(reds(out))}`)
  const doc = ct8(out).filter((f) => f.subject.startsWith('doc.'))
  assert.deepEqual(doc.map((f) => `${f.subject}|${f.expected}|${f.actual}`), ['doc.ipc demo:push|HEAD 缺|工作树 有'],
    `§11 的在途新增必须被 CT8 报出来：${JSON.stringify(ct8(out))}`)
})

// ── P1.5 收尾批：**WS 方向按 §5/§6 各判**（此前两节合成一个集合 ⇒ 方向写反不红）──────────
//
// 为什么必须判方向：§5 = bridge → GUI（outbound）、§6 = GUI → bridge（inbound）。把出站事件抄进 §6
// 会让 GUI 实现者把 `send`/`onmessage` 写反 —— 这是契约语义错误，不是排版问题。
// 实测（收尾批在盘根干净克隆上跑过端到端变异）：合成口径下"把 §5 的 `bridge_hello` 挪进 §6"
// ⇒ `kit:check` **红 0**（唯一信号是 `contract-doc.test.mjs` 的 26/16 计数）；按方向判后
// ⇒ CT2（wsOut 未覆盖）+ CT4（未登记）+ CT3（§6 侧代码里没有）三红。
//
// 两个方向各一条（缺任一条，判据都可能被"只在一个方向实现"糊过去）。

/** 把夹具文档里的某条 WS 行从它所在的那节**挪到另一节**（造"方向写反"） */
function moveWsRow(text, rowToken, toHead) {
  const lines = text.split('\n')
  const idx = lines.indexOf(rowToken)
  assert.notEqual(idx, -1, `夹具行没找到：${rowToken}`)
  lines.splice(idx, 1)
  const to = lines.indexOf(toHead)
  assert.notEqual(to, -1, `目标节没找到：${toHead}`)
  let i = to + 1
  while (i < lines.length && !lines[i].startsWith('|')) i++   // 跳过表头
  while (i < lines.length && lines[i].startsWith('|')) i++    // 跳过表体
  lines.splice(i, 0, rowToken)
  return lines.join('\n')
}
const S5 = '## 5. 桥 → GUI 事件'
const S6 = '## 6. GUI → 桥'

test('★收尾批①：§5 的出站事件挪进 §6 ⇒ CT2(wsOut 未覆盖) + CT4(未登记) + CT3(§6 侧代码里没有) 三红', async () => {
  const f = await setup({
    mutate: (root) => rewrite(root, 'docs/bridge-contract.md', (s) => moveWsRow(s, '| `ev1` | 出站 |', S6)),
  })
  const got = reds(await run(f)).map((x) => `${x.rule}:${x.subject}`)
  assert.ok(got.includes('CT2:wsOut ev1'), `CT2 必须报"出站未覆盖"：${JSON.stringify(got)}`)
  assert.ok(got.includes('CT4:wsOut 未登记 ev1'), `CT4 必须报"未登记"：${JSON.stringify(got)}`)
  assert.ok(got.includes('CT3:ws ev1'), `§6 声明了、代码入站侧没有 ⇒ CT3 也要红：${JSON.stringify(got)}`)
  // 反向断言：真值侧只多出 wsOut 那一条（说明减的是 §5 的声明集，不是并集）
  assert.equal(got.some((x) => x === 'CT2:wsIn ev1' || x === 'CT4:wsIn 未登记 ev1'), false,
    `§6 里多了一行不该让 wsIn 侧也报"未覆盖"（那是并集口径的误报）：${JSON.stringify(got)}`)
})

test('★收尾批②：§6 的入站事件挪进 §5 ⇒ 同样三红（两个方向都判，不是只判出站）', async () => {
  const f = await setup({
    mutate: (root) => rewrite(root, 'docs/bridge-contract.md', (s) => moveWsRow(s, '| `in1` | 入站 |', S5)),
  })
  const got = reds(await run(f)).map((x) => `${x.rule}:${x.subject}`)
  assert.ok(got.includes('CT2:wsIn in1'), `CT2 必须报"入站未覆盖"：${JSON.stringify(got)}`)
  assert.ok(got.includes('CT4:wsIn 未登记 in1'), `CT4 必须报"未登记"：${JSON.stringify(got)}`)
  assert.ok(got.includes('CT3:ws in1'), `§5 声明了、代码出站侧没有 ⇒ CT3 也要红：${JSON.stringify(got)}`)
})

test('★收尾批③：只挪一行（未提交/未动条数）在 CT8 里也必须看得见（方向是声明集的两个字段）', async () => {
  const { out } = await setupPair({ mutateWork: (root) => rewrite(root, 'docs/bridge-contract.md', (s) => moveWsRow(s, '| `ev1` | 出站 |', S6)) })
  assert.deepEqual(reds(out), [], `文档在途改动不得红（规则读 HEAD 文档）：${JSON.stringify(reds(out))}`)
  const doc = ct8(out).filter((f) => f.subject.startsWith('doc.')).map((f) => `${f.subject}|${f.expected}|${f.actual}`)
  assert.deepEqual(doc.sort(), ['doc.wsIn ev1|HEAD 缺|工作树 有', 'doc.wsOut ev1|HEAD 有|工作树 缺'],
    `方向搬家必须逐条报出来（合并成一类会看不出差异）：${JSON.stringify(ct8(out))}`)
})

test('★收尾批⑤：运行时出口不可用 ⇒ CT6 红而 CT3 仍绿（CT3 = 文档 ↔ 快照；快照 ↔ 运行时归 CT6）', async () => {
  // 两棵树：**健康树**落盘快照（含 t1 的指纹），**坏树**只坏 `kernel/tools.mjs`。
  //   为什么必须换目录：`await import(pathToFileURL(root/kernel/tools.mjs))` 按 **URL 缓存** ——
  //   在同一个 root 上先成功导入过，再改坏文件也拿不到 error（同一进程内 URL 命中缓存）。
  //   这也解释了真仓里为什么"改坏后新起一次 `kit:check` 才红"。
  const healthy = fixture()
  const readH = (f) => readTracked({ root: healthy.root, file: f })
  const snapshot = await buildSnapshot({ root: healthy.root, files: healthy.files, readTracked: readH, now: 'T' })
  assert.ok(snapshot.tools && snapshot.tools.t1, '前提：夹具快照里有 t1 的指纹（否则本用例测不到兜底通路）')
  const broken = fixture({ mutate: (root) => rewrite(root, 'kernel/tools.mjs', (s) => `${s}\nthis is broken {{{\n`) })
  const readB = (f) => readTracked({ root: broken.root, file: f })
  const out = await runContractRules({
    root: broken.root, files: broken.files, readTracked: readB, doc: broken.doc,
    snapshot, scope: writeScope(broken.root, SCOPE_ENTRIES), recorded: { scopeCount: 3, scopeRedCount: 3 },
  })
  const got = reds(out).map((x) => `${x.rule}:${x.subject}`)
  assert.ok(got.includes('CT6:tools runtime'), `CT6 必须报"运行时不可加载"（不许静默绿）：${JSON.stringify(got)}`)
  assert.equal(got.some((x) => x.startsWith('CT3:tools')), false,
    `CT3 对的是**已提交快照** ⇒ 文档与快照仍一致时不该红（运行时漂移由 CT6 接住）：${JSON.stringify(got)}`)
  assert.ok(got.includes('CT1:tools t1'), `快照 ↔ 现场重算 由 CT1 接住（本用例同时钉住"失败没被吞掉"）：${JSON.stringify(got)}`)
})
