// kernel-tests/knowledge-related-agent.test.mjs —— S5 Task 10：agent 侧集成（注入附锚点 + KnowledgeSearch 的 related 一跳）
// ---------------------------------------------------------------------------
// 被钉住的六件事（spec §7.6 / §11-14）：
//   ① unified 注入的命中行**附锚点摘要**，且**绝不含正文**（锚点只允许 `文件#块号「标题」[理由]`，
//      多一个正文字段就是 S3 的老毛病：注入是每次请求都要付的固定成本）；
//   ② `off` 模式（`knowledgeRelateMode: 'off'`）**不附**锚点，且输出与 S4 逐字节一致
//      （把 on 的输出做字符串手术剥掉锚点后必须**逐字节相等** —— 这是"可回滚"最硬的证明）；
//   ③ `duplicate` 类锚点**不进注入**（它是去重提示，不是阅读路径）；
//   ④ `KnowledgeSearch.related` 返回**一跳**锚点，同样不含正文；
//   ⑤ **一跳不二级扩散**：造 A→B→C，查 A 只得到 B（C 绝不出现）；
//   ⑥ 既有 query 检索行为不变（回归）。
//
// 隔离纪律：一律 mkdtempSync 临时 configDir，绝不碰真实 ~/.yfworking / ~/.yfw；
// 全程不启 bridge、不联网（只调内核纯函数与工具注册表）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildKnowledgeInjection, resolveInjectMode } from '../kernel/knowledge-inject.mjs'
import { createKnowledgeStore } from '../kernel/knowledge.mjs'
import { createToolRegistry } from '../kernel/tools.mjs'
import { RELATED_EXPAND_LIMIT } from '../kernel/knowledge-search.mjs'

const BODY_A = '同步企微通讯录时先拉全量再做差集比对，避免把离职同事重新写回组织架构'
const BODY_B = '发送前先确认群名，群名拼错会把消息发到别人的群里'
/** 锚点片段的**精确形状**：`文件#块号` + 可选「标题」 + `[理由]`。任何正文都会破坏它。 */
const ANCHOR_RE = /^([^\s#]+#\d+)(「[^」]*」)?\[[^\]]+\]$/

/** 造一个临时 configDir（体验根 = <dir>/memory/personal），files: {文件名: [行...] }。 */
function home(files) {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kagent-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  for (const [name, lines] of Object.entries(files)) {
    writeFileSync(join(personal, name), [...lines, ''].join('\n'), 'utf-8')
  }
  return { dir, personal }
}

/** 两条同 tag 条目（A/B 互为骨架层锚点，正文互不重合 ⇒ 正文一旦泄漏一眼可辨）。 */
const pairFixture = () => home({
  'agent.md': ['---', 'name: agent', '---',
    `- [会话|锚点标签] 主体条目 -- ${BODY_A}`,
    `- [会话|锚点标签] 同伴条目 -- ${BODY_B}`],
})

const inject = ({ dir, personal }, extra = {}) => buildKnowledgeInjection({
  configDir: dir, memoryRootDir: personal, query: '群名', keywords: ['群名'], mode: 'unified', totalBudget: 4096, ...extra,
})

/** 命中行（`- [...`）与其锚点片段分开：锚点一律追加在行尾的 ` ↵关联：` 之后。 */
const rowOf = (section, blockId) => section.split('\n')
  .find((l) => l.startsWith('- [') && new RegExp(`\\(${blockId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`).test(l))

test('unified 注入：命中行附锚点摘要（文件#块号「标题」[理由]），且绝不含正文', () => {
  const f = pairFixture()
  try {
    const store = createKnowledgeStore({ configDir: f.dir })
    store.load({})
    const hit = store.search({ query: '群名', keywords: ['群名'], topK: 3 }).items[0]
    assert.ok(hit, '前置：夹具必须能命中一条（否则本用例是空转）')
    const oneHop = store.getRelated(hit.blockId)
    assert.equal(oneHop.length, 1, `前置：主体条目应有 1 条同 tag 锚点（实际 ${oneHop.length}）`)

    const r = inject(f)
    assert.equal(r.stats.recallBlocks, 1)
    const row = rowOf(r.recallSection, hit.blockId)
    assert.ok(row, '命中行必须在注入里')
    assert.ok(row.includes(' ↵关联：'), '命中行应附锚点摘要（S5 §7.6）')

    const seg = row.split(' ↵关联：')[1]
    const pieces = seg.split(' ；')
    assert.equal(pieces.length, oneHop.length, '锚点条数应与内核给出的一跳锚点一致')
    assert.deepEqual(pieces.map((p) => ANCHOR_RE.exec(p)?.[1]),
      oneHop.map((x) => x.blockId), '锚点顺序 = 内核排序（分数降序），不自造排序')
    for (const p of pieces) {
      assert.ok(ANCHOR_RE.test(p), `锚点片段必须是「文件#块号「标题」[理由]」形态：${p}`)
    }
    assert.equal(pieces[0], `experience/agent.md#0「agent」[同标签:锚点标签]`, 'tag 边的理由给标签值')
    // 防膨胀：锚点里**不得**出现任何正文（夹具的正文字段是判别性证据）
    assert.ok(!seg.includes('离职同事') && !seg.includes(BODY_A.slice(6, 14)), '锚点不得携带目标条目正文')
    assert.ok(!/\.(md)\b[^[]*--/.test(seg), '锚点里不该出现正文/来源那种整行结构')
    // 说明性表头只在确有锚点时出现（off 模式的输出因此与 S4 逐字节一致，见下一条用例）
    assert.match(r.recallSection, /一跳锚点/)
  } finally { rmSync(f.dir, { recursive: true, force: true }) }
})

test('off 模式不附锚点，且剥掉锚点后与 on 模式（S5 输出）逐字节相等 = 等价 S4', () => {
  const on = pairFixture()
  const off = pairFixture()
  try {
    const onSec = inject(on).recallSection
    assert.ok(onSec.includes(' ↵关联：'), '前置：on 模式必须有锚点（否则本条是空转）')
    process.env.PONOS_KNOWLEDGE_RELATE_MODE = 'off'
    try {
      const offSec = inject(off).recallSection
      assert.ok(!offSec.includes(' ↵关联：'), 'off 模式不得附锚点（等价 S4 行为）')
      assert.ok(!offSec.includes('一跳锚点'), 'off 模式连锚点说明都不该出现（否则不是逐字节等价）')
      assert.ok(offSec.includes('(experience/agent.md#1)'), 'off 模式仍要有命中行（只是没有锚点）')
      // 最硬的等价证明：把 on 的输出做字符串手术（去说明行 + 截掉 ` ↵关联：` 之后）后逐字节相等
      const stripped = onSec.split('\n')
        .filter((l) => !l.includes('一跳锚点'))
        .map((l) => l.split(' ↵关联：')[0])
        .join('\n')
      assert.equal(stripped, offSec, 'off 输出必须等于"on 去掉锚点"（回滚开关的语义）')
    } finally { delete process.env.PONOS_KNOWLEDGE_RELATE_MODE }
  } finally {
    rmSync(on.dir, { recursive: true, force: true })
    rmSync(off.dir, { recursive: true, force: true })
  }
})

test('duplicate 锚点不进注入（去重提示不是阅读路径，白耗预算）', () => {
  const X = `${BODY_A}，这条与另一条完全同文，用于制造 duplicate 边`
  const f = home({
    'dup.md': ['---', 'name: dup', '---',
      `- [会话|甲标签] 甲条目 -- ${X}`,
      `- [会话|乙标签] 乙条目 -- ${X}`],
  })
  try {
    const store = createKnowledgeStore({ configDir: f.dir })
    store.load({})
    const hit = store.search({ query: '同步企微通讯录 差集比对', keywords: ['同步企微通讯录'], topK: 3 }).items[0]
    assert.ok(hit, '前置：应命中一条')
    assert.ok(store.getRelated(hit.blockId).some((x) => x.why.kind === 'duplicate'),
      '前置：内核确实物化了 duplicate 边（否则"不出现"是数据本来就没有，钉不住过滤）')

    const r = inject(f, { query: '同步企微通讯录 差集比对', keywords: ['同步企微通讯录'] })
    assert.ok(r.stats.recallBlocks >= 1, '命中行仍应在（只是没有锚点）')
    assert.ok(!r.recallSection.includes(' ↵关联：'), 'duplicate 是唯一的锚点时，注入里不该出现任何锚点')
    assert.ok(!/疑似重复/.test(r.recallSection), 'duplicate 不进注入（去重提示属于 GUI/工具侧）')
  } finally { rmSync(f.dir, { recursive: true, force: true }) }
})

test('legacy 注入路径不变：无抽调层、无锚点（灰度开关下的零回归）', () => {
  const f = pairFixture()
  try {
    assert.equal(resolveInjectMode({}), 'legacy', '缺省仍是 legacy')
    const r = buildKnowledgeInjection({ configDir: f.dir, memoryRootDir: f.personal, query: '群名', keywords: ['群名'] })
    assert.equal(r.stats.strategy, 'legacy')
    assert.equal(r.recallSection, '', 'legacy 不产出抽调层 ⇒ 锚点自然不存在（纯增量，不动老路径）')
    assert.ok(!r.indexSection.includes('↵关联'), '索引层（目录行）也不得掺入锚点')
  } finally { rmSync(f.dir, { recursive: true, force: true }) }
})

// ── 链式夹具：A→B（同 tag 骨架）+ B→C（内容相似），而 A 与 C 无任何关系 ─────────
// 这正是"一跳不二级扩散"的判别性夹具：如果实现顺手把结果的锚点也展开，C 必然出现。
const CHAIN_MID = '打包知识包前必须校验清单与文件一一对应，缺项会让安装方静默少装文档，这条用于验证一跳边界'
const CHAIN_TAIL = '打包知识包前必须校验清单与文件一一对应，缺项会让安装方静默少装文档；打完后按序号命名'

function chainFixture() {
  const f = home({
    'chain.md': ['---', 'name: chain', '---',
      `- [会话|链头] 甲 -- ${BODY_A}`,
      `- [会话|链头] 乙 -- ${CHAIN_MID}`,
      `- [会话|链尾] 丙 -- ${CHAIN_TAIL}`],
  })
  const store = createKnowledgeStore({ configDir: f.dir })
  store.load({})
  const a = 'experience/chain.md#0'
  const b = 'experience/chain.md#1'
  const c = 'experience/chain.md#2'
  // 前置断言（在测试里做，避免夹具与实际内核脱节）：A→B 有边、B→C 有边、A→C 无边
  assert.deepEqual(store.getRelated(a).map((x) => x.blockId), [b], '前置：A 的一跳只有 B')
  assert.ok(store.getRelated(b).some((x) => x.blockId === c), '前置：B 的一跳含 C（第二跳确实存在）')
  assert.ok(!store.getRelated(a).some((x) => x.blockId === c), '前置：A 与 C 无直接边')
  return { ...f, store, a, b, c }
}

test('KnowledgeSearch.related：只展开一跳（A→B 不出现 C），且只回 blockId/标题/理由', async () => {
  const f = chainFixture()
  try {
    const tools = createToolRegistry({ cwd: f.dir, addDirs: [], skipPermissions: true, memoryRoot: f.personal })
    // 只给 related（不给 query）：钉住 schema 的 required 放宽（否则 API 层直接 400，参数成摆设）
    const r = await tools.run({ name: 'KnowledgeSearch', input: { related: f.a } }, {})
    assert.equal(r.isError, false)
    assert.match(r.content, /【一跳关联】/)
    assert.ok(r.content.includes(f.b), '应给出一跳目标 B')
    assert.ok(!r.content.includes(f.c), '**不得二级扩散**：B 的锚点 C 绝不能出现（spec §7.6 非目标）')
    assert.ok(!r.content.includes('打完后按序号命名'), '不得携带正文（C 的正文特征词）')
    assert.ok(!r.content.includes('校验清单与文件一一对应'), '不得携带正文（B 的正文特征词）')
    // 逐条对齐内核的一跳视图（工具不得自造排序/自加条数）
    const got = r.content.split('\n').filter((l) => l.startsWith('- ')).map((l) => /^- \[([^\]]+)\]/.exec(l)?.[1])
    assert.deepEqual(got, f.store.getRelated(f.a).map((x) => x.blockId))
    assert.match(r.content, /需正文用 Read/)
  } finally { rmSync(f.dir, { recursive: true, force: true }) }
})

test('KnowledgeSearch.related：条数受上限约束（既有同 tag 同伴多于上限时被截断）', async () => {
  const lines = ['---', 'name: limit', '---', `- [会话|限额标签] 主体 -- ${BODY_A}`]
  for (let i = 2; i <= 7; i++) {
    lines.push(`- [会话|限额标签] 同伴${i} -- 这是第${i}条同标签条目，正文与主体条目毫无重合，仅用于撑起骨架层预算`)
  }
  const f = home({ 'limit.md': lines })
  try {
    const tools = createToolRegistry({ cwd: f.dir, addDirs: [], skipPermissions: true, memoryRoot: f.personal })
    const r = await tools.run({ name: 'KnowledgeSearch', input: { related: 'experience/limit.md#0' } }, {})
    assert.equal(r.isError, false)
    const got = r.content.split('\n').filter((l) => l.startsWith('- '))
    assert.equal(got.length, RELATED_EXPAND_LIMIT, `一跳条数必须被截到 ${RELATED_EXPAND_LIMIT}（实际 ${got.length}）`)
    assert.match(r.content, new RegExp(`最多 ${RELATED_EXPAND_LIMIT} 条`))
  } finally { rmSync(f.dir, { recursive: true, force: true }) }
})

test('KnowledgeSearch：related 与 query 共存且互不干扰（既有 query 检索行为不变）', async () => {
  const f = chainFixture()
  try {
    const tools = createToolRegistry({ cwd: f.dir, addDirs: [], skipPermissions: true, memoryRoot: f.personal })
    const schema = tools.toolSchemas().find((t) => t.name === 'KnowledgeSearch')
    assert.ok(schema.input_schema.properties.related, 'schema 应暴露 related 参数（否则模型无从得知）')
    assert.deepEqual(schema.input_schema.required, [], 'required 放宽为"至少给一个"，由 run() 判定')

    // 既有用法：按 query 检索 —— 回执仍是检索清单（不因新参数而变）
    const q = await tools.run({ name: 'KnowledgeSearch', input: { query: '同步企微通讯录', keywords: ['同步企微通讯录'], topK: 3 } }, {})
    assert.equal(q.isError, false)
    assert.match(q.content, /【相关知识检索】/)
    assert.ok(!q.content.includes('【一跳关联】'), 'query 路不得走到展开路')

    // 新用法：query + related 同时给 → related 优先（同一工具两个查询维度，互不污染）
    const both = await tools.run({ name: 'KnowledgeSearch', input: { query: '随便', related: f.a } }, {})
    assert.match(both.content, /【一跳关联】/)

    // 参数缺失 / blockId 不存在：明确提示且不抛错（不打断会话）
    const none = await tools.run({ name: 'KnowledgeSearch', input: {} }, {})
    assert.equal(none.isError, true)
    assert.match(none.content, /query/)
    const miss = await tools.run({ name: 'KnowledgeSearch', input: { related: 'experience/chain.md#99' } }, {})
    assert.equal(miss.isError, false)
    assert.match(miss.content, /未找到条目/)
    const badShape = await tools.run({ name: 'KnowledgeSearch', input: { related: '不是块号' } }, {})
    assert.equal(badShape.isError, false)
    assert.match(badShape.content, /未找到条目/)
  } finally { rmSync(f.dir, { recursive: true, force: true }) }
})
