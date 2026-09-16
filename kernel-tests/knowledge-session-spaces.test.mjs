// kernel-tests/knowledge-session-spaces.test.mjs
// 会话知识范围（2026-09-15，待处理清单 P1「会话模式关联经验库之外的知识库」）的**可调用性**验证。
//
// 两层证据，缺一不可：
//   ① 工具层（本文件直接构造 registry 真调）：范围外必须**明确拒绝**（不是空命中），范围内必须真命中；
//   ② 注入层（spawn 真内核）：带 `--knowledge-spaces` 时抽调层**真的从关联库取到了内容**
//      （针脚打在储备库文档的短语上），不带时取不到；init 帧回显让"关联到底传到没有"可判定。
//
// 为什么注入层必须 spawn 真进程：范围是在 kernel/cli.mjs 启动段解析并消费的，engine 级单测
// 绕不过去——而"关联了却没生效"正是本任务要防的头号故障（4 跳透传，任一跳漏登记即静默失效）。
//
// 隔离纪律：PONOS_CONFIG_DIR/YFW_HOME 与所有夹具都在 mkdtempSync 临时目录内，绝不碰真实 home。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createToolRegistry } from '../kernel/tools.mjs'

const KERNEL_CLI = fileURLToPath(new URL('../kernel/cli.mjs', import.meta.url))

/**
 * 针脚顺序即 bits 顺序。三条设计纪律（第一条曾踩坑：初版用库名当"未关联"的针脚，
 * 而库名同时出现在"可检索"行里 ⇒ 无法区分"已关联"与"未关联"，断言假绿）：
 *   0 `【本会话知识库】` 范围块本身；
 *   1 `储备库专属条目` 只存在于储备库正文 ⇒ 命中即证明**真的从关联库抽调到了内容**；
 *   2 `【相关知识抽调】` 抽调层标题（unified 下应在）；
 *   3 库名（可检索行里出现 = 已关联）；
 *   4 `未关联的库` 该措辞只在"存在未关联库"时渲染 ⇒ 用它判"是否告知模型还有库没关联"。
 */
const NEEDLES = ['【本会话知识库】', '储备库专属条目', '【相关知识抽调】', '测试运营库', '未关联的库']
const PHRASE = '储备库专属条目'

/** 夹具：个人经验库（内置）+ 一个用户储备库 `docs`（库名"测试运营库"）。 */
function makeHome() {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-session-spaces-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  writeFileSync(join(personal, 'workflow.md'), [
    '---', 'name: workflow', 'description: 工作流', '---',
    '- [会话|申报材料] 四表联动交叉校验 -- RD/PS/IP/TOAI 四表口径必须对齐',
  ].join('\n') + '\n', 'utf-8')
  // 会话记忆目录：builtin 空间 `session-memory` 的存在与否由目录决定（discoverSpaces 只认已存在
  // 的空间），故夹具要把它建出来——否则 init 帧的期望值会随夹具缺项而漂移。
  const session = join(dir, 'memory', 'session')
  mkdirSync(session, { recursive: true })
  writeFileSync(join(session, 's.md'), '# 会话记忆\n', 'utf-8')
  const space = join(dir, 'knowledge', 'spaces', 'docs')
  mkdirSync(space, { recursive: true })
  writeFileSync(join(space, '.space.json'), JSON.stringify({ name: '测试运营库' }), 'utf-8')
  writeFileSync(join(space, '手册.md'), [
    '---', 'name: 手册', 'description: 用户储备库文档', '---',
    '# 运营手册', '',
    `${PHRASE}：这条只存在于用户储备库，用于验证会话知识范围真的能从关联库抽调。`, '',
  ].join('\n'), 'utf-8')
  return dir
}

const toolOf = (dir, knowledgeSpaces) => createToolRegistry({
  cwd: dir, addDirs: [], skipPermissions: true,
  memoryRoot: join(dir, 'memory', 'personal'),
  ...(knowledgeSpaces === undefined ? {} : { knowledgeSpaces }),
})

// ── ① 工具层：范围内的正面（真的可调用）────────────────────────────────────
test('工具层：关联后 KnowledgeSearch 真能命中储备库内容（"可调用性"的正面证据）', async () => {
  const dir = makeHome()
  try {
    const tools = toolOf(dir, ['experience', 'session-memory', 'docs'])
    const r = await tools.run({ name: 'KnowledgeSearch', input: { query: PHRASE, spaces: ['docs'] } }, {})
    assert.equal(r.isError, false, r.content)
    assert.match(r.content, new RegExp(PHRASE), '关联后必须真取到该库内容')
    assert.match(r.content, /docs\/手册\.md/, '命中来源要能指回储备库文件')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('工具层：未关联时（缺省范围）未指定 spaces 也不会翻到储备库', async () => {
  const dir = makeHome()
  try {
    const tools = toolOf(dir, ['experience', 'session-memory'])
    const r = await tools.run({ name: 'KnowledgeSearch', input: { query: PHRASE } }, {})
    assert.equal(r.isError, false, r.content)
    // 针脚选**库内正文**而不是 query 词：无命中提示里会回显 query，用 query 做否定断言会假绿。
    assert.doesNotMatch(r.content, /只存在于用户储备库/, '缺省范围不得把用户储备库正文带进来')
    assert.doesNotMatch(r.content, /docs\/手册\.md/, '连来源文件都不应出现')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── ② 工具层：范围外的反面（明确拒绝，不是空命中）──────────────────────────
test('工具层：范围外空间被明确拒绝，且文案可执行（含"关联到当前会话"指引）', async () => {
  const dir = makeHome()
  try {
    const tools = toolOf(dir, ['experience', 'session-memory'])
    const r = await tools.run({ name: 'KnowledgeSearch', input: { query: '任意', spaces: ['docs'] } }, {})
    assert.equal(r.isError, true, '越界必须是错误态——空命中无法与"该库确实没有"区分')
    assert.match(r.content, /不在本会话知识范围/)
    assert.match(r.content, /关联到当前会话/, '必须给出用户侧可执行动作')
    assert.match(r.content, /请勿重试/, '必须劝止弱模型的重复重试')
    assert.match(r.content, /当前范围：experience、session-memory/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('工具层：related 展开也受范围约束（blockId 空间前缀一眼可判）', async () => {
  const dir = makeHome()
  try {
    const tools = toolOf(dir, ['experience'])
    const r = await tools.run({ name: 'KnowledgeSearch', input: { related: 'docs/手册.md#1' } }, {})
    assert.equal(r.isError, true, '越界的"展开一跳"等于绕过范围读结构，必须拦')
    assert.match(r.content, /docs/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── ③ 零回归锁：不传 knowledgeSpaces = 不限（嵌入/测试场景的既有行为）────────
test('零回归：未传 knowledgeSpaces 时不收窄（嵌入场景与既有调用方行为不变）', async () => {
  const dir = makeHome()
  try {
    const tools = toolOf(dir, undefined)
    const r = await tools.run({ name: 'KnowledgeSearch', input: { query: PHRASE, spaces: ['docs'] } }, {})
    assert.equal(r.isError, false, r.content)
    assert.match(r.content, new RegExp(PHRASE))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── ③b fail-closed：空白名单 ≠ 不限 ───────────────────────────────────────
test('fail-closed：空白名单（[] = 本会话无可检索库）拒绝一切检索，**不得**退化成"不限"', async () => {
  const dir = makeHome()
  try {
    const tools = toolOf(dir, [])
    // 指定空间：拒
    const a = await tools.run({ name: 'KnowledgeSearch', input: { query: PHRASE, spaces: ['docs'] } }, {})
    assert.equal(a.isError, true, '空白名单时越界判定必须先行')
    // 不指定空间（早先的实现会退化成"全空间"）：同样必须拒
    const b = await tools.run({ name: 'KnowledgeSearch', input: { query: PHRASE } }, {})
    assert.equal(b.isError, true, '空白名单下"未指定"绝不等于"全部可读空间"——这正是 fail-open 缺口')
    assert.match(b.content, /没有任何可检索的知识库/)
    // 经验检索的 all 分支同理（早先 mapped=null ⇒ 全空间）
    const c = await tools.run({ name: 'MemorySearch', input: { query: '四表联动' } }, {})
    assert.equal(c.isError, true, 'MemorySearch(all) 也必须 fail-closed')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('fail-closed（注入层）：spaces=[] 时不抽调任何知识库内容，且 stats.scope 如实为 []', async () => {
  const dir = makeHome()
  try {
    const { buildKnowledgeInjection } = await import('../kernel/knowledge-inject.mjs')
    const r = buildKnowledgeInjection({
      configDir: dir, memoryRootDir: join(dir, 'memory', 'personal'),
      query: PHRASE, keywords: [PHRASE], mode: 'unified', spaces: [], totalBudget: 32768,
    })
    assert.equal(r.recallSection, '', '空白名单 ⇒ 无抽调')
    assert.equal(r.stats.recallBlocks, 0)
    assert.deepEqual(r.stats.scope, [], 'scope 如实上报"空"（不是 null=不限）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── ④ 注入层：spawn 真内核 ────────────────────────────────────────────────
/** 跑一轮真实会话，回 bits + init 帧（等 init → 发一条消息 → 关 stdin → 收全部事件）。 */
async function runTurn({ args = [], env = {}, userText = '储备库专属条目是什么' } = {}) {
  const dir = makeHome()
  const proc = spawn(process.execPath, [
    KERNEL_CLI, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--add-dir', dir, ...args,
  ], {
    env: {
      ...process.env, PONOS_MOCK_API: '1', PONOS_MOCK_SYS_PROBE: NEEDLES.join('|'),
      PONOS_KNOWLEDGE_INJECT_MODE: 'unified', PONOS_MEMORY_KEYWORDS: PHRASE,
      PONOS_CONFIG_DIR: dir, YFW_HOME: dir,
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  let buf = ''
  const events = []
  proc.stdout.on('data', (d) => {
    out += d
    buf += d
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      try { events.push(JSON.parse(line)) } catch { /* 半行/脏行跳过 */ }
    }
  })
  try {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline && !events.some((e) => e.type === 'system' && e.subtype === 'init')) {
      await new Promise((r) => setTimeout(r, 20))
    }
    const init = events.find((e) => e.type === 'system' && e.subtype === 'init')
    proc.stdin.write(JSON.stringify({ type: 'user', session_id: 'knowledge-session-spaces', message: { role: 'user', content: userText } }) + '\n')
    proc.stdin.end()
    const code = await new Promise((res) => { proc.on('close', res) })
    const text = events.filter((e) => e.type === 'assistant')
      .map((e) => (e.message?.content || []).map((b) => (b?.type === 'text' ? b.text : '')).join('')).join('')
    return { code, bits: (text.match(/SYS_PROBE:([01]+)/) || [])[1], init, out, dir }
  } finally {
    try { proc.kill() } catch {}
  }
}

test('注入层：带 --knowledge-spaces docs 时，抽调层真的从关联库取到了内容', async () => {
  const r = await runTurn({ args: ['--knowledge-spaces', 'docs'] })
  try {
    assert.equal(r.code, 0, `内核应正常退出（实际 ${r.code}）\nstdout=${r.out.slice(-400)}`)
    assert.ok(r.bits, `探针未回显：${r.out.slice(-400)}`)
    assert.equal(r.bits[0], '1', '提示词必须含【本会话知识库】范围声明')
    assert.equal(r.bits[1], '1', '**核心断言**：储备库文档的短语出现在提示词里 = 真的从关联库抽调了')
    assert.equal(r.bits[2], '1', 'unified 下块级抽调层应在')
  } finally { rmSync(r.dir, { recursive: true, force: true }) }
})

test('注入层：未关联时抽调不到储备库，但会把"未关联的库"告知模型', async () => {
  const r = await runTurn({})
  try {
    assert.equal(r.code, 0, `内核应正常退出（实际 ${r.code}）\nstdout=${r.out.slice(-400)}`)
    assert.ok(r.bits, `探针未回显：${r.out.slice(-400)}`)
    assert.equal(r.bits[0], '1', '范围声明与是否关联无关（缺省也有范围）')
    assert.equal(r.bits[1], '0', '**核心断言**：未关联 ⇒ 该库内容不得进上下文（这是膨胀收敛的本体）')
    assert.equal(r.bits[4], '1', '"未关联的库"必须出现：模型据此请用户关联（否则指路无门）')
  } finally { rmSync(r.dir, { recursive: true, force: true }) }
})

test('注入层：init 帧回显 knowledge_spaces（4 跳透传是否真的到位，一眼可判）', async () => {
  const on = await runTurn({ args: ['--knowledge-spaces', 'docs'] })
  try {
    assert.deepEqual(on.init?.knowledge_spaces, ['experience', 'session-memory', 'docs'])
  } finally { rmSync(on.dir, { recursive: true, force: true }) }
  const off = await runTurn({})
  try {
    assert.deepEqual(off.init?.knowledge_spaces, ['experience', 'session-memory'], '未关联时不带用户库')
  } finally { rmSync(off.dir, { recursive: true, force: true }) }
})

// ── ⑤ chat 模式：范围同样必须可见 ─────────────────────────────────────────
test('chat 模式：range 块照样渲染（chat 里 KnowledgeSearch 放行 ⇒ 模型必须知道能用哪些库）', async () => {
  // 与 task 模式的一致性理由：S3 D2 决定 chat 下只读检索放行，那么"能用哪些库"就不能只让模型猜。
  const r = await runTurn({ args: ['--knowledge-spaces', 'docs', '--session-mode', 'chat'] })
  try {
    assert.equal(r.code, 0, `内核应正常退出（实际 ${r.code}）\nstdout=${r.out.slice(-400)}`)
    assert.ok(r.bits, `探针未回显：${r.out.slice(-400)}`)
    assert.equal(r.bits[0], '1', 'chat 下也要有【本会话知识库】范围声明')
    assert.equal(r.bits[3], '1', '已关联的库要在"可检索"清单里（chat 下同样可见）')
    assert.equal(r.bits[4], '0', '"未关联的库"不该出现：该库已关联，同一行文案不能自相矛盾')
  } finally { rmSync(r.dir, { recursive: true, force: true }) }
})
