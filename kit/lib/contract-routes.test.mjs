// kit/lib/contract-routes.test.mjs —— T1 路由提取器（DevKit P1 · 契约快照）
//
// 为什么必须有这些断言（每条都能独立失败）：
//   · 夹具仓一律 mkdtemp + `git init` + `git add -A`（口径见 kit/cli.test.mjs 的 fixture()）：
//     提取器的扫描域 = `git ls-files`，不依赖本机磁盘状态（CI 无 release/ scratch/ dist/ 也能跑）。
//   · **禁止按文件找 Set 表**（D1：`FILES_ROUTE_PATHS` 定义在 bridge.mjs:271，处理在 files-routes.mjs）
//     ⇒ 夹具刻意把表与处理器分放两个模块，只扫 bridge.mjs 的实现会漏。
//   · 磁盘副本不是真相（D4）：夹具在 `git add` **之后**才落一份 `release/YFWorking/` 副本，
//     未入库 ⇒ 提取结果里不得出现它。
//   · 注释不是代码（bridge.mjs:1757/1829 的真实形态）：假路径写在行注释/块注释里不得入集。
//   · "提取不到 ≠ 不存在"：非 bridge 面的路径字面量必须逐条进 excluded 且带 reason。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { trackedFiles, codeFiles, readTracked } from './scan.mjs'
import { extractRoutes } from './contract-routes.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ESC = String.fromCharCode(92)  // 反斜杠：源码里写裸 \ 易被编辑链吃掉

/** 夹具仓：真 git + `git add -A`（未入库文件不参与判定） */
function fixture(filesMap) {
  const root = mkdtempSync(join(tmpdir(), 'yfw-ct-routes-'))
  const write = (rel, content) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  for (const [rel, content] of Object.entries(filesMap)) write(rel, content)
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', '-A'], { cwd: root })
  return { root, write, read: (file) => readTracked({ root, file }) }
}

const filesOf = (root) => codeFiles(trackedFiles({ root }), { includeTests: false })

// ── 夹具源码：复刻真仓的关键形态（每条都对应一个真实出处）────────────────────
const SET_IN_BRIDGE = [
  '// 文件类端点集中登记（D1：表在 bridge.mjs:271，处理在 files-routes.mjs）',
  "const FILES_ROUTE_PATHS = new Set(['/list-dir', '/read-file', '/raw-file', '/write-file'])",
  'if (FILES_ROUTE_PATHS.has(url.pathname)) { dispatch() }',
  "if (url.pathname === '/health' && req.method === 'GET') { reply() }",
  "if (url.pathname === '/mcp' || url.pathname === '/mcp/test' || url.pathname === '/mcp/status') {",
  '  dispatchMcp()',
  '}',
  "if (url.pathname.startsWith('/knowledge')) { dispatchKnowledge() }",
  "if (url.pathname.startsWith('/providers/')) { dispatchProviders() }",
  '// 注释里写假路径是真实形态（bridge.mjs:1757/1829）：以下两行都不是代码',
  "// if (pathname === '/fake-line-comment') { NEVER }",
  '/* if (pathname === \'/fake-block-comment\') { NEVER } */',
  '',
].join('\n')

const FILES_ROUTES = [
  "if (pathname === '/list-dir') { listDir() }",
  "if (pathname === '/read-file') { readFile() }",
  "if (pathname === '/write-file' && method === 'POST') { writeFile() }",
  '',
].join('\n')

const MCP_ROUTES = [
  "const wantGet = pathname === '/mcp' && method === 'GET'",
  "const wantPut = pathname === '/mcp' && method === 'PUT'",
  "const wantTest = pathname === '/mcp/test' && method === 'POST'",
  '',
].join('\n')

// ★ `!==` 早退守卫 = **认领该端点**（真形态：`server/agents-routes.mjs:28`、
//   `server/disabled-routes.mjs:23`、`server/skill-detail-routes.mjs:28` 三条都是
//   `if (pathname !== '/x') return null`）。把 `!==` 一律跳过 ⇒ 这三条既不在 routes
//   也不在 excluded（"每条字面量都有归宿"被违反，且报告里 100 条是漏抓后的数）。
const NEG_GUARD_ROUTES = [
  '/** `/agents` 的 GET（真形态 server/agents-routes.mjs）*/',
  'export async function handleAgentsRoute(ctx) {',
  '  const { method, pathname } = ctx || {}',
  "  if (pathname !== '/agents') return null",
  "  if (method !== 'GET') return null",     // ★ 主语是 method，不是 pathname ⇒ 不得当路径判定
  '  return { status: 200, body: {} }',
  '}',
  '',
  'export async function handleDisabledRoute(ctx) {',
  '  const { pathname } = ctx || {}',
  "  if (pathname !== '/disabled') return null",
  '  return { status: 200, body: {} }',
  '}',
  '',
  'export async function handleSkillDetailRoute(ctx) {',
  '  const { pathname } = ctx || {}',
  "  if (pathname !== '/skill-detail') return null",
  '  return { status: 200, body: {} }',
  '}',
  '',
].join('\n')

const HOST_ROUTES = [
  "const FIXED_PATHS = new Set(['/health', '/boot-status'])",
  'export function isHostPath(pathname) {',
  "  return FIXED_PATHS.has(pathname) || pathname.startsWith('/transcript/')",
  '}',
  "if (pathname === '/transcript/list') { listTranscript() }",
  '',
].join('\n')

const KNOWLEDGE_ROUTES = [
  "const isPost = String(method).toUpperCase() === 'POST'",
  "if (!isPost && p === '/knowledge/spaces') return ok(1)",
  "if (method.toUpperCase() === 'DELETE' && p === '/knowledge/delete') { return drop() }",
  '',
].join('\n')

const WORKFLOW_ROUTES = [
  'const p = url.pathname',
  "if (p !== '/workflows' && !p.startsWith('/workflows/')) return false",
  "if (p === '/workflows' && req.method === 'GET') { return list() }",
  "if (p === '/workflows' && req.method === 'POST') { return save() }",
  'const m = p.match(/^\\/workflows\\/([^/]+)(\\/.*)?$/)',
  'if (m) {',
  '  const id = decodeURIComponent(m[1])',
  "  const sub = m[2] || ''",
  "  if (id === 'run' && req.method === 'POST') { return run() }",
  "  if (id === 'bindings') { return bindings() }",
  "  if (sub === '/duplicate' && req.method === 'POST') { return dup() }",
  '}',
  '',
].join('\n')

const BASE_FIXTURE = {
  'server/bridge.mjs': SET_IN_BRIDGE,
  'server/files-routes.mjs': FILES_ROUTES,
  // ★ 系统目录字面量（文件系统判定）与"名字里含系统目录名的端点"必须分开：
  // `'/boot-status'.startsWith('/boot')` 为真 —— 裸前缀比对会把真端点误判成系统目录（实测踩过）
  'server/fs-guard.mjs': ["if (path === '/usr/bin') { deny() }", ''].join('\n'),
  // ★ `!==` 早退守卫三形态（/agents /disabled /skill-detail）与"非端点的 `!==`"（根路径判定）
  'server/neg-guard-routes.mjs': NEG_GUARD_ROUTES,
  'server/root-neg-guard.mjs': ["if (pathname !== '/') return null", ''].join('\n'),
  // ★ stripComments 的已知边界：正则字面量里的撇号会开一个伪字符串 ⇒ **其后的注释整段留下**
  //   （真形态：server/bridge.mjs:1716 的注释在剥注释后仍在）。命中的 raw 行是注释时必须丢掉。
  'server/leaky.mjs': ["const re = /'/", "// if (pathname === '/from-comment') { hidden() }", 'export const x = re', ''].join('\n'),
  'server/mcp-routes.mjs': MCP_ROUTES,
  'server/host-routes.mjs': HOST_ROUTES.concat("if (pathname === '/boot-status') { status() }\n"),
  'server/knowledge-routes.mjs': KNOWLEDGE_ROUTES,
  'server/workflow-routes.mjs': WORKFLOW_ROUTES,
  'server/bridge-token.cjs': [
    'function isTokenExemptPath(pathname) {',
    "  if (pathname === '/health') return true",
    "  return pathname === '/api/auth' || pathname.startsWith('/api/auth/')",
    '}',
    '',
  ].join('\n'),
  'src/lib/proxyUi.ts': "const path = u.pathname === '/' ? '' : u.pathname\n",
  'scripts/build-x.mjs': "const path = resolve(join(root, 'dist'))\nif (path === '/dist/out.js') { keep() }\n",
  'public/sample-skills/demo/server.cjs': "if (req.method === 'GET' && pathname === '/' && q) { bootstrap() }\n",
}

/** 夹具 + 提取（一次调用，避免各用例各写一遍） */
function extract(filesMap = BASE_FIXTURE) {
  const fx = fixture(filesMap)
  const files = filesOf(fx.root)
  return { ...fx, files, out: extractRoutes({ files, readTracked: fx.read }) }
}

const keysWithPath = (map, path) => [...map.keys()].filter((k) => k === path || k.endsWith(' ' + path))
const anyKeyWithPath = (map, path) => keysWithPath(map, path)

test('★D1：Set 表与处理器分属两模块 —— 路由仍被提取（按文件找表必漏）', () => {
  const { out } = extract()
  // 表在 bridge.mjs，处理器在 files-routes.mjs：两条路径都必须在
  assert.deepEqual(anyKeyWithPath(out.routes, '/list-dir'), ['ANY /list-dir'])
  // /raw-file 只在 Set 表里出现（夹具刻意不给处理器）——只认 `pathname ===` 的实现会漏掉它
  assert.deepEqual(anyKeyWithPath(out.routes, '/raw-file'), ['ANY /raw-file'],
    'Set 形态必须扫（D1 的核心：表与处理器可以分属两个模块）')
  const list = out.routes.get('ANY /list-dir')
  assert.deepEqual([...list.forms].sort(), ['eq', 'set:FILES_ROUTE_PATHS'],
    'forms 必须同时记住表来源与处理器来源')
  assert.deepEqual(list.hints.map((h) => h.file).sort(), ['server/bridge.mjs', 'server/files-routes.mjs'])
  assert.equal(list.file, 'server/bridge.mjs', 'file/line 取首个命中点（bridge.mjs:2 的 Set 定义）')
})

test('★注释里的假路径不入集（stripComments 前置，真形态 bridge.mjs:1757/1829）', () => {
  const { out } = extract()
  for (const fake of ['/fake-line-comment', '/fake-block-comment']) {
    assert.deepEqual(anyKeyWithPath(out.routes, fake), [], `${fake} 只在注释里，不得入集`)
    assert.equal(out.excluded.some((e) => e.literal === fake), false,
      '注释里的字面量连 excluded 都不该出现（提取前已剥注释，不是"提取不到"）')
  }
})

test('★未入库的磁盘副本不入集（禁 readdirSync，D4）', () => {
  const { root, files, out, read } = extract()
  // 夹具仓只有 base? 这里在 git add 之后才落副本 ⇒ 未入库
  const fx = fixture(BASE_FIXTURE)
  mkdirSync(join(fx.root, 'release/YFWorking/server'), { recursive: true })
  writeFileSync(join(fx.root, 'release/YFWorking/server/copy-routes.mjs'), "if (pathname === '/from-disk-copy') { }\n")
  const files2 = filesOf(fx.root)
  assert.equal(files2.includes('release/YFWorking/server/copy-routes.mjs'), false, '夹具前提：副本未入库')
  const seen = []
  const out2 = extractRoutes({
    files: files2,
    readTracked: (f) => { seen.push(f); return readTracked({ root: fx.root, file: f }) },
  })
  assert.deepEqual(anyKeyWithPath(out2.routes, '/from-disk-copy'), [])
  assert.equal(seen.some((f) => f.includes('release/')), false, '提取器不得要求读非 files 里的文件（磁盘遍历必红）')
  // 同一份源码，结果与"没有副本"时逐字相同
  const base = fixture(BASE_FIXTURE)
  const out3 = extractRoutes({ files: filesOf(base.root), readTracked: (f) => readTracked({ root: base.root, file: f }) })
  assert.deepEqual([...out3.routes.keys()], [...out2.routes.keys()])
  void root; void files; void out; void read
})

test('★/mcp 双判：同名同法去重为 1 条，hints 列 2 处（bridge.mjs:2803-2804 与 mcp-routes.mjs:66-71 形态）', () => {
  const { out } = extract()
  const get = out.routes.get('GET /mcp')
  assert.ok(get, 'GET /mcp 必须存在')
  assert.deepEqual(get.hints.map((h) => h.file).sort(), ['server/bridge.mjs', 'server/mcp-routes.mjs'],
    '/mcp 在两处判定（无方法约束的一处 + method === GET 的一处）⇒ 1 条、2 个 hint')
  assert.deepEqual(get.forms, ['eq'], '两处都是 `===` 形态')
  assert.deepEqual([...out.routes.keys()].filter((k) => k.endsWith('/mcp')).sort(),
    ['GET /mcp', 'PUT /mcp'],
    '有显式方法时不产生 ANY 条目（一套路径两种方法的写法不该被折叠成一条）')
  const postTest = out.routes.get('POST /mcp/test')
  assert.deepEqual(postTest.hints.find((h) => h.file === 'server/mcp-routes.mjs').methods, ['POST'],
    '方法字面量必须读出来（`(?!={2,3})` 后不带 \b —— 引号后没有单词边界，写了就恒读不到）')
  assert.deepEqual(postTest.hints.find((h) => h.file === 'server/bridge.mjs').methods, [],
    'bridge.mjs 的判定不带方法约束 ⇒ 该 hint 的 methods 为空（并因此并入每个方法条目）')
  assert.deepEqual(postTest.hints.map((h) => h.file).sort(),
    ['server/bridge.mjs', 'server/mcp-routes.mjs'])
})

test('方法推断：显式字面量 > isPost 写法（knowledge-routes 的 GET 侧）', () => {
  const { out } = extract()
  assert.ok(out.routes.has('GET /knowledge/spaces'), '`!isPost` = 非 POST 侧（GET），必须推断出来')
  assert.ok(out.routes.has('DELETE /knowledge/delete'), "`method.toUpperCase() === 'DELETE'` 用字面量")
  assert.equal(keysWithPath(out.routes, '/workflows').includes('GET /workflows'), true)
  assert.equal(keysWithPath(out.routes, '/workflows').includes('POST /workflows'), true)
  assert.equal([...out.routes.keys()].some((k) => k.startsWith('ANY /workflows')), false)
})

test('★动态前缀单列：/transcript/ 有枚举子路径，/providers/ 为空且不可枚举（通配是否被枚举可判定）', () => {
  const { out } = extract()
  const byPrefix = new Map(out.prefixes.map((p) => [p.prefix, p]))
  assert.ok(byPrefix.has('/knowledge'), '/knowledge 前缀必须单列')
  assert.ok(byPrefix.has('/providers/'), '/providers/ 前缀必须单列')
  assert.deepEqual(byPrefix.get('/transcript/').children, ['/transcript/list'],
    '前缀下用 `===` 判定的子路径要枚举出来（夹具里 host-routes 只处理 /transcript/list）')
  assert.deepEqual(byPrefix.get('/knowledge').children, ['/knowledge/delete', '/knowledge/spaces'],
    '前缀下用 `===` 判定的子路径必须枚举出来（这就是"通配是否被枚举"的判据）')
  assert.deepEqual(byPrefix.get('/providers/').children, [], '真仓 /providers/* 的段是动态拼的，枚举不出子路径')

  const wf = byPrefix.get('/workflows/')
  assert.ok(wf, '/workflows/ 前缀必须单列')
  assert.deepEqual(wf.children, [], '正则动态段：静态枚举不出 `:id` 子路径（不得凭文档编造）')
  assert.ok(wf.dynamic, '正则分派必须被识别（否则 `:id` 子路径会被当成"不存在"）')
  assert.equal(wf.dynamic.pattern, '/^' + ESC + '/workflows' + ESC + '/([^/]+)(' + ESC + '/.*)?$',
    `dynamic.pattern 必须是锚定在该前缀上、且带动态段的正则（:id 子路由的真相），实测 ${wf.dynamic.pattern}`)
  assert.deepEqual(wf.dynamic.segments.map((x) => x.literal).sort(),
    ['bindings', 'run'], '段比较（`id === \'run\'`）是动态前缀的枚举子项')
  assert.deepEqual(wf.dynamic.suffixes.map((x) => x.literal).sort(), ['/duplicate'], '子路径字面量（`sub === \'/duplicate\'`）同样要枚举')
  assert.equal(byPrefix.get('/knowledge').dynamic, null, '没有锚定正则就不该编一个 dynamic 出来')
})

test('★excluded 逐条带 reason、无兜底条目；非 bridge 面的字面量必须可见', () => {
  const { out } = extract()
  assert.ok(out.excluded.length >= 3)
  for (const e of out.excluded) {
    assert.equal(typeof e.literal, 'string')
    assert.ok(e.literal.length > 0)
    assert.match(e.reason, /^[a-z-]+：/, `reason 必须带可机读的分类前缀：${JSON.stringify(e)}`)
    assert.ok(e.file && e.line > 0, '排除项必须定位到文件与行')
    assert.equal(/其余|其他全部|others|rest of/i.test(e.reason), false, '禁止"其余全部"这类兜底条目')
  }
  const reasonOf = (lit) => out.excluded.filter((e) => e.literal === lit).map((e) => e.reason)
  assert.deepEqual(out.excluded.filter((e) => e.file === 'public/sample-skills/demo/server.cjs').map((e) => e.literal), ['/'])
  assert.match(reasonOf('/')[0], /^root-path-check/)
  assert.match(reasonOf('/api/auth')[0], /^token-guard/)
  assert.match(reasonOf('/api/auth/')[0], /^token-guard/)
  assert.match(out.excluded.find((e) => e.file === 'src/lib/proxyUi.ts').reason, /^root-path-check/)
  assert.deepEqual(out.excluded.filter((e) => e.file === 'scripts/build-x.mjs').map((e) => e.literal), ['/dist/out.js'])
  assert.match(out.excluded.find((e) => e.file === 'scripts/build-x.mjs').reason, /^non-bridge-surface/)
  // 系统目录字面量（文件系统判定）必须排除；但**名字里含系统目录名的端点**必须还在：
  // `'/boot-status'.startsWith('/boot')` 为真 ⇒ 裸前缀比对会把真端点误判成系统目录（实测踩过）
  assert.deepEqual(out.excluded.filter((e) => e.file === 'server/fs-guard.mjs').map((e) => e.literal), ['/usr/bin'])
  assert.match(out.excluded.find((e) => e.file === 'server/fs-guard.mjs').reason, /^system-dir/)
  assert.ok(out.routes.has('ANY /boot-status'), '/boot-status 是端点，不得被系统目录规则吞掉')
  // ★ 剥注释被击穿时（正则里的撇号）注释里的假路径仍不得入集 —— raw 行再兜一道
  assert.deepEqual(anyKeyWithPath(out.routes, '/from-comment'), [],
    '注释行上的假路径必须丢掉（stripComments 不认正则字面量，会连注释一起留下）')
  assert.equal(out.excluded.some((e) => e.literal === '/from-comment'), false, '注释里的字面量连 excluded 都不该进')
  // 反向：/health 在 bridge-token 的豁免判定不进 routes，但同名字面量在 host-routes 是真端点
  assert.ok(out.routes.has('GET /health'), '同名字面量在 host-routes 是真端点（bridge-token 的豁免另走 excluded）')
  assert.deepEqual(out.routes.get('GET /health').hints.map((h) => h.file),
    ['server/bridge.mjs', 'server/host-routes.mjs'],
    'bridge.mjs 的 GET /health 与 host-routes 的 FIXED_PATHS 都是判定点；bridge-token 的豁免另走 excluded')
  // 净化：排除项不得反向污染路由集合
  for (const lit of ['/', '/api/auth', '/api/auth/']) {
    assert.deepEqual(anyKeyWithPath(out.routes, lit), [], `${lit} 不是端点，不得进 routes`)
  }
})

test('isPath 谓词（返回式）= 认领关系，不是新端点：forms 里记 isPath:<fn> 且不新增路由', () => {
  const { out } = extract()
  const health = out.routes.get('GET /health')
  assert.deepEqual([...health.forms].sort(), ['eq', 'isPath:isHostPath', 'set:FIXED_PATHS'])
  assert.deepEqual(anyKeyWithPath(out.routes, '/transcript/'), [])
  const t = out.prefixes.find((p) => p.prefix === '/transcript/')
  assert.deepEqual(t.hints.map((h) => h.file), ['server/host-routes.mjs'])
  assert.deepEqual([...new Set(t.hints.flatMap((h) => h.forms))].sort(), ['isPath:isHostPath', 'startsWith'])
})

test('★`!==` 早退守卫 = 认领该端点（真形态 /agents /disabled /skill-detail 三条）', () => {
  const { out } = extract()
  // 漏抓时的症状：这三条**既不在 routes 也不在 excluded**（违反"每条字面量都有归宿"）
  for (const p of ['/agents', '/disabled', '/skill-detail']) {
    assert.deepEqual(anyKeyWithPath(out.routes, p), [`ANY ${p}`],
      `${p} 的 `!==` 早退守卫是认领关系，必须进 routes（实测 routes=${out.routes.size}）`)
    assert.deepEqual(out.routes.get(`ANY ${p}`).forms, ['negated-guard'],
      'form 必须标出守卫形态（与 `===` 的 eq 区分：形态是判据的一部分）')
    assert.deepEqual(out.routes.get(`ANY ${p}`).hints.map((h) => h.file), ['server/neg-guard-routes.mjs'])
    assert.equal(out.excluded.some((e) => e.literal === p), false, '认领关系不得同时落进 excluded')
  }
  // 反向：无方法约束的守卫 ⇒ ANY（`method !== 'GET'` 的主语是 method，不得当成路径判定）
  assert.deepEqual([...out.routes.keys()].filter((k) => k.endsWith('/agents')), ['ANY /agents'])
  // `!==` **不豁免**归类：非端点的 `!==` 仍必须进 excluded（没有"第三条路"）
  const rootNeg = out.excluded.find((e) => e.file === 'server/root-neg-guard.mjs')
  assert.ok(rootNeg, '`if (pathname !== \'/\') return null` 是绝对路径判定 ⇒ 必须进 excluded')
  assert.match(rootNeg.reason, /^root-path-check/)
  assert.deepEqual(anyKeyWithPath(out.routes, '/'), [])
  // workflow-routes 的 `p !== '/workflows' && !p.startsWith('/workflows/')`：也是认领（/workflows 已是端点）
  assert.deepEqual(out.routes.get('GET /workflows').forms, ['eq', 'negated-guard'])
  assert.deepEqual(out.routes.get('POST /workflows').forms, ['eq', 'negated-guard'])
})

test('★接口对误用免疫：直接传 trackedFiles（含 test/.md）与传 codeFiles 结果**逐字相同**', () => {
  // JSDoc 曾写"`files` 来自 trackedFiles"，但实际必须**先**过 `codeFiles(..., {includeTests:false})`：
  // 照 JSDoc 传 raw 会多出 test 文件里的端点（假阳性）+ `docs/*.md` 噪声 ⇒ T9 接线自伤。
  // 修法：自筛进提取器内部（接口对误用免疫），而不是靠调用方记得排序调用。
  const raw = trackedFiles({ root: ROOT })
  const filtered = codeFiles(raw, { includeTests: false })
  assert.ok(raw.length > filtered.length, '夹具前提：raw 里确实有 test/.md 文件')
  const read = (f) => readTracked({ root: ROOT, file: f })
  const a = extractRoutes({ files: raw, readTracked: read })
  const b = extractRoutes({ files: filtered, readTracked: read })
  assert.deepEqual([...a.routes.keys()], [...b.routes.keys()], 'raw 传参不得多出（或少掉）任何路由')
  assert.deepEqual(a.routes.size, b.routes.size)
  assert.deepEqual(a.prefixes, b.prefixes)
  assert.deepEqual(a.excluded, b.excluded, 'raw 传参不得让 docs/*.md 之类的噪声进 excluded')
  // 点名两处曾经的自伤面：test 文件里的端点与文档路径
  assert.equal(a.routes.has('ANY /workflows/verify'), false, 'server/*.test.mjs 里的路径不得进 routes（假阳性）')
  assert.equal(a.excluded.some((e) => e.file.endsWith('.md')), false, '文档不是代码，不得进 excluded')
})

test('真仓：路由集**精确**复算（floor 会掩盖漏抓：审查 M1 就是同形态探针仍 100 条）', () => {
  const files = codeFiles(trackedFiles({ root: ROOT }), { includeTests: false })
  const out = extractRoutes({ files, readTracked: (f) => readTracked({ root: ROOT, file: f }) })
  // ★ 只钉两棵树都成立的端点（`/generate-title` 是在途加的，HEAD 上还没有）
  for (const k of ['ANY /list-dir', 'POST /write-file', 'ANY /health', 'ANY /drives', 'ANY /config', 'POST /session/anchor-applied']) {
    assert.ok(out.routes.has(k), `真仓必须有 ${k}（实测 keys=${out.routes.size}）`)
  }
  // ★★ 三条 `!==` 早退守卫（真形态 `server/agents-routes.mjs:28` / `disabled-routes.mjs:23` /
  //    `skill-detail-routes.mjs:28`）：漏抓时它们**既不在 routes 也不在 excluded** —— 直接点名
  for (const k of ['ANY /agents', 'ANY /disabled', 'ANY /skill-detail']) {
    assert.ok(out.routes.has(k), `真仓必须有 ${k}（`!==` 早退守卫形态，实测 keys=${[...out.routes.keys()].filter((x) => /agents|disabled|skill-detail/.test(x)).join('|') || '无'}）`)
    assert.deepEqual(out.routes.get(k).forms, ['negated-guard'], `${k} 的 form 必须标出守卫形态`)
    assert.equal(out.excluded.some((e) => e.literal === k.slice('ANY '.length)), false, `${k} 是认领关系，不得同时出现在 excluded`)
  }
  // ★ 精确条数（**不是 floor**）：floor 恰好掩盖过上面三条的漏抓（M1 变异实测仍绿）。
  //   真仓增删端点时必须**显式**改这一行 —— 那正是要人看一眼的时刻。
  assert.equal(out.routes.size, 105, `路由总数必须精确等于 105（实测 ${out.routes.size}）；floor 口径会掩盖同形态漏抓`)
  for (const p of ['/transcript/', '/file-collab/', '/providers/', '/workflows/', '/knowledge', '/logs/']) {
    assert.ok(out.prefixes.some((x) => x.prefix === p), `真仓动态前缀 ${p} 必须单列`)
  }
  assert.equal(out.excluded.every((e) => /^[a-z-]+：/.test(e.reason)), true)
  // 排除清单必须是"逐条"，不是"一条通配"（条数下界 + 每条各有 literal/file/line）
  assert.ok(out.excluded.length >= 5, `实测 ${out.excluded.length}`)
})
