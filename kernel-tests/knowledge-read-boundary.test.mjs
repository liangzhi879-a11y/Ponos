// kernel-tests/knowledge-read-boundary.test.mjs —— 知识空间**只读边界**（P3，2026-09-20）
// ---------------------------------------------------------------------------
// 病灶（实测）：任务模式下，非 experience 的知识空间（如 id「政策」，物理在
// `<配置根>/knowledge/spaces/政策/…`）**既不能 Read 也不能 Grep**——只读白名单只放行了记忆根；
// 而 KnowledgeSearch 的回执/工具描述却无条件引导"需全文用 Read 读对应文件行"，
// 模型照做只会撞"拒绝访问：路径超出会话目录边界"。
//
// 本文件钉住五件事（缺一即回归）：
//   ① 正面：已授权空间的文件可 Read、内容可 Grep（含 path 收窄到该空间——不再报越界）；
//   ② 反面：未授权空间仍被拒（Read 与 Grep 的 path 都是"超出会话目录边界"，且错误里列出的
//      可用根目录不含未授权空间）；
//   ③ **写入承诺**：Write/Edit 对知识空间路径仍一律拒绝（文件字节零变化）——只读放行是单向的，
//      另有一条静态断言锁住"写侧不许引用只读白名单"（防后人顺手把 readAllowDirs 传进 writeFile）；
//   ④ 三态纪律：`knowledgeSpaces=[]`（本会话无库）时不放行任何知识目录；`null`（不限）也**不会**
//      因此放行全部空间——"不限"只影响检索范围，文件边界严格等于上层显式给的那份；
//   ⑤ 文案收口：KnowledgeSearch 的回执按"该空间能否 Read"分支（可读 → 引导 Read；
//      不可读 → 引导 mode='full'），不再无条件说"用 Read 读文件行"。
//
// 隔离纪律：全部 mkdtempSync 临时目录自建夹具，绝不碰真实 ~/.yfw / ~/.yfworking，离线可重复。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createToolRegistry } from '../kernel/tools.mjs'
import { createKnowledgeStore } from '../kernel/knowledge.mjs'

const TOOLS_SRC = readFileSync(fileURLToPath(new URL('../kernel/tools.mjs', import.meta.url)), 'utf8')

// 三处针脚分别落在三个不同空间：授权空间（政策）/ 未授权空间（秘密）/ 会话目录。
const NEEDLE_POLICY = 'NEEDLE_POLICY'
const NEEDLE_SECRET = 'NEEDLE_SECRET'
const NEEDLE_WORK = 'NEEDLE_WORK'

/**
 * 夹具布局（memoryRoot 与知识根的相对位置必须与真实一致：memoryRoot = <配置根>/memory/personal，
 * 工具层就是靠"上溯两级"推 configDir 的）：
 *   <dir>/work/                              ← cwd（会话目录）
 *   <dir>/memory/personal/note.md            ← experience 空间（已授权）
 *   <dir>/knowledge/spaces/政策/手册.md       ← 已授权用户空间（本任务的主战场）
 *   <dir>/knowledge/spaces/秘密/内部.md       ← **未授权**用户空间
 */
function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'know-read-'))
  const cwd = join(dir, 'work')
  const memoryRoot = join(dir, 'memory', 'personal')
  const policyRoot = join(dir, 'knowledge', 'spaces', '政策')
  const secretRoot = join(dir, 'knowledge', 'spaces', '秘密')
  for (const d of [cwd, memoryRoot, policyRoot, secretRoot]) mkdirSync(d, { recursive: true })
  writeFileSync(join(cwd, 'work.txt'), `${NEEDLE_WORK}\n`, 'utf-8')
  writeFileSync(join(memoryRoot, 'note.md'), '- [会话|标签] 经验甲 -- 经验正文，仅用于占位\n', 'utf-8')
  // 两条**同标签**条目：既有知识空间的内容检索能力，也天然物化出一跳关联（related 分支要用）。
  // 针脚写在**条目标题段**里（检索回执给的是摘要，正文针脚不会出现在 snippet 里——写成正文
  // 会让"命中"断言假红）；块号从 0 起（无前置标题块，见下方 related 测试的前置断言）。
  writeFileSync(join(policyRoot, '手册.md'), [
    '---', 'name: 手册', '---', '',
    `- [会话|知识产权] ${NEEDLE_POLICY} 条目甲 -- 第一条要点，用于口径校验，正文足够长以进入骨架层`,
    `- [会话|知识产权] ${NEEDLE_POLICY} 条目乙 -- 第二条要点，与甲互不重复，仅用于撑起一跳关联`,
  ].join('\n') + '\n', 'utf-8')
  writeFileSync(join(secretRoot, '内部.md'), `# 未授权\n${NEEDLE_SECRET}\n`, 'utf-8')
  return { dir, cwd, memoryRoot, policyRoot, secretRoot, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 上层（cli）算好的授权清单：id 供回执判"能否 Read"，root 进只读白名单。 */
const authorizedDirs = (env, ids = ['experience', '政策']) => ids.map((id) => ({
  id,
  root: id === 'experience' ? env.memoryRoot : join(env.dir, 'knowledge', 'spaces', id),
}))

/**
 * 构造 registry。**注意 `in` 判据而不是默认参数**：显式传 `null` 必须真的把 null 传下去
 * （`null` 与"不传"在 createToolRegistry 里同义：knowledgeSpaces=不限、knowledgeReadDirs=不放行），
 * 用解构默认值会把显式 null 悄悄换成默认授权清单，测出来的就不是被测语义了。
 */
function makeTools(env, opts = {}) {
  return createToolRegistry({
    cwd: env.cwd, addDirs: [], skipPermissions: true, memoryRoot: env.memoryRoot,
    knowledgeSpaces: 'knowledgeSpaces' in opts ? opts.knowledgeSpaces : ['experience', '政策'],
    knowledgeReadDirs: 'knowledgeReadDirs' in opts ? opts.knowledgeReadDirs : authorizedDirs(env),
  })
}

// ── ① 正面：已授权空间可 Read / 可 Grep ─────────────────────────────────────
test('Read：已授权知识空间的文件可读（本次任务的主战场：政策空间）', () => {
  const env = makeEnv()
  try {
    const r = makeTools(env).registry.Read.run({ file_path: join(env.policyRoot, '手册.md') })
    assert.equal(r.isError, undefined, `已授权空间必须可 Read：${r.content}`)
    assert.match(String(r.content), new RegExp(NEEDLE_POLICY))
  } finally { env.cleanup() }
})

test('Grep：不带 path 也能搜到已授权空间的内容（授权空间进了默认遍历根，会话目录零回归）', async () => {
  const env = makeEnv()
  try {
    // 一个 pattern 命中三个空间的针脚（NEEDLE_POLICY / NEEDLE_SECRET / NEEDLE_WORK），
    // 于是"搜到谁、没搜到谁"一次说清。
    const r = await makeTools(env).registry.Grep.run({ pattern: 'NEEDLE_' })
    assert.ok(!r.isError, `不应报错：${r.content}`)
    assert.match(String(r.content), /work\.txt/, '会话目录仍必须是遍历根（零回归）')
    assert.match(String(r.content), /手册\.md/, '授权空间的内容必须能被搜到')
    // 未授权空间不在遍历根里 ⇒ 默认搜索不得把它的内容带出来（与 path 拦截独立的第二道）
    assert.doesNotMatch(String(r.content), /内部\.md/)
  } finally { env.cleanup() }
})

test('Grep/Glob：path 指向已授权空间可正常收窄（不再报越界），且不串到未授权空间', async () => {
  const env = makeEnv()
  try {
    const tools = makeTools(env)
    const g = await tools.registry.Grep.run({ pattern: NEEDLE_POLICY, path: env.policyRoot })
    assert.ok(!g.isError, `授权空间的 path 不该越界：${g.content}`)
    assert.match(String(g.content), /手册\.md/)
    assert.doesNotMatch(String(g.content), /内部\.md/)
    const gl = await tools.registry.Glob.run({ pattern: '**/*.md', path: env.policyRoot })
    assert.ok(!gl.isError, `授权空间的 path 不该越界：${gl.content}`)
    assert.match(String(gl.content), /手册\.md/)
    assert.doesNotMatch(String(gl.content), /内部\.md/)
  } finally { env.cleanup() }
})

// ── ② 反面：未授权空间仍被拒 ──────────────────────────────────────────────
test('Read：未授权知识空间仍被拒（错误文案含"超出会话目录边界"）', () => {
  const env = makeEnv()
  try {
    const r = makeTools(env).registry.Read.run({ file_path: join(env.secretRoot, '内部.md') })
    assert.equal(r.isError, true, '未授权空间必须拒绝')
    assert.match(String(r.content), /拒绝访问：路径超出会话目录边界/)
    assert.doesNotMatch(String(r.content), new RegExp(NEEDLE_SECRET), '拒绝时不得回吐文件内容')
  } finally { env.cleanup() }
})

test('Grep：path 指向未授权空间仍被拒（且不静默降级为全树扫描）', async () => {
  const env = makeEnv()
  try {
    const r = await makeTools(env).registry.Grep.run({ pattern: NEEDLE_SECRET, path: env.secretRoot })
    assert.equal(r.isError, true)
    assert.match(String(r.content), /拒绝访问：路径超出会话目录边界/)
    assert.doesNotMatch(String(r.content), /内部\.md/)
  } finally { env.cleanup() }
})

// ── ③ 写入承诺：只读放行是单向的 ──────────────────────────────────────────
test('Write：已授权知识空间路径仍拒绝，且文件字节未变（安全承诺）', () => {
  const env = makeEnv()
  try {
    const target = join(env.policyRoot, '手册.md')
    const before = readFileSync(target, 'utf-8')
    const r = makeTools(env).registry.Write.run({ file_path: target, content: 'OVERWRITTEN' })
    assert.equal(r.isError, true, '知识库文件必须只读')
    assert.match(String(r.content), /拒绝访问：路径超出会话目录边界/)
    assert.equal(readFileSync(target, 'utf-8'), before, '被拒的写入不得改动文件一个字节')
  } finally { env.cleanup() }
})

test('Edit：已授权知识空间路径仍拒绝，且文件字节未变', () => {
  const env = makeEnv()
  try {
    const target = join(env.policyRoot, '手册.md')
    const before = readFileSync(target, 'utf-8')
    const r = makeTools(env).registry.Edit.run({ file_path: target, old_string: NEEDLE_POLICY, new_string: 'CHANGED' })
    assert.equal(r.isError, true, '知识库文件必须只读')
    assert.match(String(r.content), /拒绝访问：路径超出会话目录边界/)
    assert.equal(readFileSync(target, 'utf-8'), before)
  } finally { env.cleanup() }
})

test('源码锁：写侧（Write/Edit）边界必须是 allowDirs，不得引用只读白名单', () => {
  // 行为断言只在"这次调用"上生效；这条静态锁防的是**后人顺手改传参**（把 readAllowDirs 传进
  // writeFile/editFile）——那会让知识库在任务会话里变成可写，且既有行为用例未必抓得到。
  assert.match(TOOLS_SRC, /writeFile\(String\(input\?\.file_path \?\? ''\), String\(input\?\.content \?\? ''\), allowDirs,/,
    'Write 的边界必须是 allowDirs（会话目录）')
  assert.match(TOOLS_SRC, /editFile\(String\(input\?\.file_path \?\? ''\), String\(input\?\.old_string \?\? ''\), String\(input\?\.new_string \?\? ''\), input\?\.replace_all === true, allowDirs,/,
    'Edit 的边界必须是 allowDirs（会话目录）')
  assert.doesNotMatch(TOOLS_SRC, /writeFile\([^\n]*readAllowDirs/, '写侧不得引用只读白名单')
  assert.doesNotMatch(TOOLS_SRC, /editFile\([^\n]*readAllowDirs/, '写侧不得引用只读白名单')
})

// ── ④ 三态纪律：空白名单 fail-closed、null 不等于"放行全部空间" ─────────────
test('fail-closed：knowledgeSpaces=[] 时即便传了 knowledgeReadDirs 也不放行任何知识目录', () => {
  const env = makeEnv()
  try {
    const tools = makeTools(env, { knowledgeSpaces: [], knowledgeReadDirs: authorizedDirs(env) })
    const r = tools.registry.Read.run({ file_path: join(env.policyRoot, '手册.md') })
    assert.equal(r.isError, true, '本会话没有任何可检索库 ⇒ 知识目录一个都不放行（与检索边界同口径）')
    assert.match(String(r.content), /拒绝访问：路径超出会话目录边界/)
  } finally { env.cleanup() }
})

test('knowledgeSpaces=null（不限）不等于"放行全部空间"：未显式授权就不放行', () => {
  const env = makeEnv()
  try {
    // null + 未传 knowledgeReadDirs：工具层**从不自己推导**知识路径 ⇒ 一个都不放行
    const tools = makeTools(env, { knowledgeSpaces: null, knowledgeReadDirs: null })
    const a = tools.registry.Read.run({ file_path: join(env.policyRoot, '手册.md') })
    assert.equal(a.isError, true, '"不限"只是检索范围语义，不得变成文件边界全开')
    assert.match(String(a.content), /拒绝访问：路径超出会话目录边界/)
    // 反向：null + 显式给了授权目录 → 只放行给的这一份（政策可读，秘密仍拒）
    const tools2 = makeTools(env, { knowledgeSpaces: null, knowledgeReadDirs: authorizedDirs(env, ['政策']) })
    assert.equal(tools2.registry.Read.run({ file_path: join(env.policyRoot, '手册.md') }).isError, undefined)
    assert.equal(tools2.registry.Read.run({ file_path: join(env.secretRoot, '内部.md') }).isError, true)
  } finally { env.cleanup() }
})

test('setKnowledgeReadDirs：cli 的注入点生效（engine.mjs 不转发该参数的替代链路）', () => {
  const env = makeEnv()
  try {
    // 构造时不传（= engine.mjs 的现状）⇒ 知识空间先被拒
    const tools = makeTools(env, { knowledgeReadDirs: null })
    const before = tools.registry.Read.run({ file_path: join(env.policyRoot, '手册.md') })
    assert.equal(before.isError, true, '未注入前必须拒绝（fail-closed）')
    // cli 拿到 engine.tools 后注入 ⇒ 可读；且写侧不受影响
    tools.setKnowledgeReadDirs(authorizedDirs(env))
    const after = tools.registry.Read.run({ file_path: join(env.policyRoot, '手册.md') })
    assert.equal(after.isError, undefined, `注入后必须可 Read：${after.content}`)
    assert.equal(tools.registry.Write.run({ file_path: join(env.policyRoot, 'x.md'), content: 'y' }).isError, true,
      '热注入只动只读侧：Write 边界在闭包里恒定')
    assert.equal(tools.registry.Read.run({ file_path: join(env.secretRoot, '内部.md') }).isError, true,
      '未在清单里的空间照旧拒绝')
  } finally { env.cleanup() }
})

// ── ⑤ 文案收口：回执按"能否 Read"分支 ─────────────────────────────────────
/** 发一次 KnowledgeSearch（query 检索或 related 展开），返回回执文本。 */
async function ask(env, input, registryOpts) {
  const r = await makeTools(env, registryOpts).run({ name: 'KnowledgeSearch', input }, {})
  return r
}

test('回执：命中已授权空间 → 引导 Read（并给出空间根，路径可拼）', async () => {
  const env = makeEnv()
  try {
    const r = await ask(env, { query: NEEDLE_POLICY, spaces: ['政策'] })
    assert.equal(r.isError, false, r.content)
    assert.match(r.content, new RegExp(NEEDLE_POLICY), '前置：应命中政策空间内容')
    assert.match(r.content, /需全文：用 Read 打开上列文件/, '可读空间应引导 Read（行号已在括号里）')
    assert.ok(r.content.includes(env.policyRoot), '必须给出空间根：docId 是相对路径，没有根就 Read 不到')
    assert.doesNotMatch(r.content, /不可 Read/)
  } finally { env.cleanup() }
})

test('回执：命中未授权（只关联了 experience）空间 → 引导 mode=full，不再无条件说 Read', async () => {
  const env = makeEnv()
  try {
    // 只放行 experience：政策在检索范围内（knowledgeSpaces 给了），但**没有**进只读白名单
    const r = await ask(env, { query: NEEDLE_POLICY, spaces: ['政策'] },
      { knowledgeSpaces: ['experience', '政策'], knowledgeReadDirs: authorizedDirs(env, ['experience']) })
    assert.equal(r.isError, false, r.content)
    assert.match(r.content, /空间「政策」本会话不可 Read/)
    assert.match(r.content, /mode:'full'/, '不可读空间必须给出替代取全文路径')
    assert.doesNotMatch(r.content, /需全文：用 Read 打开上列文件/)
  } finally { env.cleanup() }
})

test('related 回执：同一份判据——可读空间给 Read（含根），不可读空间给 mode=full', async () => {
  const env = makeEnv()
  try {
    // 前置：该库确实物化了一跳关联（否则"文案分支"测的是空回执，断言会假绿）
    const store = createKnowledgeStore({ configDir: env.dir })
    store.load({})
    assert.ok(store.getRelated('政策/手册.md#0', { validate: true, limit: 5 }).length > 0,
      '夹具必须真的产出一跳锚点（同标签骨架层）')

    const ok = await ask(env, { related: '政策/手册.md#0' })
    assert.equal(ok.isError, false, ok.content)
    assert.match(ok.content, /【一跳关联】/)
    assert.match(ok.content, /需正文用 Read 打开对应文件/)
    assert.ok(ok.content.includes(env.policyRoot), '可读分支要给空间根（否则 Read 无从下手）')

    const denied = await ask(env, { related: '政策/手册.md#0' },
      { knowledgeSpaces: ['experience', '政策'], knowledgeReadDirs: authorizedDirs(env, ['experience']) })
    assert.equal(denied.isError, false, denied.content)
    assert.match(denied.content, /该空间「政策」本会话不可 Read/)
    assert.match(denied.content, /mode:'full'/)
    assert.doesNotMatch(denied.content, /需正文用 Read 打开对应文件/)

    // 零回归：调用方没给可读性信息（嵌入/旧调用方）时，措辞与改造前逐字一致
    const legacy = await ask(env, { related: '政策/手册.md#0' },
      { knowledgeSpaces: null, knowledgeReadDirs: null })
    assert.equal(legacy.isError, false, legacy.content)
    assert.match(legacy.content, /需正文用 Read 打开对应文件，不再自动多跳/)
    assert.doesNotMatch(legacy.content, /不可 Read/)
  } finally { env.cleanup() }
})

test('零回归：不传 knowledgeReadDirs 时 query 回执不新增任何引导行', async () => {
  const env = makeEnv()
  try {
    const r = await ask(env, { query: NEEDLE_POLICY, spaces: ['政策'] },
      { knowledgeSpaces: null, knowledgeReadDirs: null })
    assert.equal(r.isError, false, r.content)
    assert.doesNotMatch(r.content, /需全文/)
    assert.doesNotMatch(r.content, /不可 Read/)
  } finally { env.cleanup() }
})

// ── 链路守卫（静态）：cli → 工具层的注入点，删掉即"只读放行静默失效" ──────────
// 与 kernel-tests/knowledge-scope-plumbing.test.mjs 同一理由：这条链跨进程（cli 解析范围 →
// engine 构造 registry → cli 注入边界），行为断言只能覆盖链尾；链头的删除是**静默**的
// （不报错，只是知识空间又变回不可读），正是最需要静态钉住的形态。
test('链路守卫：cli 必须按范围解析空间根并注入工具层（漏任一处 = 只读放行静默失效）', () => {
  const src = readFileSync(fileURLToPath(new URL('../kernel/cli.mjs', import.meta.url)), 'utf8')
  assert.match(src, /discoverSpaces\(\{ configDir, extraSpaceSpecs: safeTeamSpaceSpecs\(configDir\) \}\)/,
    '物理根必须由 cli 解析（tools 层保持"不知道配置根"）')
  assert.match(src, /knowledgeScope\.spaces\.includes\(s\.id\)/,
    '必须按**授权范围**过滤：把整棵知识根交出去 = 未关联的库也能读（授权语义在文件层失效）')
  assert.match(src, /engine\.tools\.setKnowledgeReadDirs\(knowledgeReadDirs\)/,
    'engine.mjs 不转发该参数 ⇒ 必须经 cli 的注入点接上（与 setDynamicTools 同一约定）')
})
