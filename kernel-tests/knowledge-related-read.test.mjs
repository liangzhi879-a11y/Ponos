// S5 Task 6（读时校验 `getRelated()` + `search()` 附锚点 + `stats()` 扩展）的回归测试。
//
// 被钉住的四件事（spec §6.2/§7.2/§11-1/§11-9）：
//   ① 读时校验三条各自生效：块删除 / tag 变更 / 内容变更 ⇒ 该边从**视图**剔除；
//      `validate:false` 仍返回未校验的行（调试用）；
//   ② 校验是**只读语义**：不改 `related.jsonl` 一个字节、不影响随后的 `validate:false`；
//   ③ `search()` 的 `related` 只有摘要 `{blockId,docId,title,why,score}`（**断言字段集合**，
//      钉住"防上下文膨胀"——S3 的教训）；条数受 topN 限制；`off` 模式**不带**该字段；
//   ④ `stats().related` 只数物化行数 + **计算期**丢弃；连查多次不变
//      （若把读时剔除计入 dropped，同一库的 stats 会随查询历史漂移、不可复现）。
//
// "物化陈旧"是**真实存在**的状态（增量只补同 tag 入边，见 relateIncremental 的③），
// 所以夹具刻意用「改 `docs.jsonl` 后的重新 load」来构造：`.md` 未动 ⇒ 不触发重建，
// 物化行仍是旧的 ⇒ 正好是读时校验要处理的场景。
//
// 隔离纪律：全部走 mkdtempSync 临时 configDir，绝不碰真实 ~/.yfworking / ~/.yfw。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKnowledgeStore } from '../kernel/knowledge.mjs'
import { MAX_RELATED, MAX_TAG_RELATED, MAX_CONTENT_RELATED } from '../shared/knowledge-core.mjs'

const idxDir = (dir) => join(dir, 'knowledge', '.index')
const relText = (dir) => readFileSync(join(idxDir(dir), 'related.jsonl'), 'utf-8')
const docsPath = (dir) => join(idxDir(dir), 'docs.jsonl')
/** 锚点摘要的**精确字段集合**：多一个 `text/full/snippet` 都算失败（防上下文膨胀）。 */
const SUMMARY_KEYS = ['blockId', 'docId', 'score', 'title', 'why']

function makePersonal(name) {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-krelread-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  return { dir, personal, md: join(personal, `${name}.md`) }
}

// ── 夹具 1：读时校验用（同 tag 对 #0↔#1 + 跨 tag 内容相似对 #2↔#3）────────────
const VALIDATE_LINES = [
  '- [会话|企微CLI化] 只发文件传输助手 -- 涉及真实沟通渠道的测试一律只发文件传输助手，避免打扰真人',
  '- [会话|企微CLI化] 步骤字段契约 -- js 步骤需 expression、click 类需 ref，写错会静默失败很长时间',
  '- [会话|主题甲] 标题一 -- 用 rsync 增量同步目录时先 dry-run 预览变更清单再执行，避免误删文件',
  '- [会话|主题乙] 标题二 -- 用 rsync 增量同步目录时先 dry-run 预览变更清单再执行，确认无误后再落地',
]
const DOC1 = 'experience/validate.md'

function makeValidateFixture() {
  const f = makePersonal('validate')
  writeFileSync(f.md, ['---', 'name: validate', '---', ...VALIDATE_LINES].join('\n') + '\n', 'utf-8')
  return f
}

/**
 * 模拟"物化陈旧"：直接改 `docs.jsonl`（**内存索引的物化**）而不动 `.md`。
 * `.md` 未动 ⇒ `indexStale()` 为假 ⇒ 不重建 ⇒ `relEdges` 仍是旧行 —— 正是读时校验的存在理由。
 * 这是白盒构造，但构造出的状态（"边两端的内容/存在性已变"）在真实库里由增量路径自然产生。
 */
function tamperDocs(dir, fn) {
  const rows = readFileSync(docsPath(dir), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  fn(rows)
  writeFileSync(docsPath(dir), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8')
}
const patchBlock = (n, patch) => (rows) => {
  for (const d of rows) for (const b of d.blocks) if (b.n === n) Object.assign(b, patch)
}
const dropBlock = (n) => (rows) => {
  for (const d of rows) d.blocks = d.blocks.filter((b) => b.n !== n)
}

/** 重新打开（走 loadIndexFromDisk，不 force）：拿到的 docs 已被篡改、relEdges 仍是旧物化。 */
function reopen(dir) {
  const s = createKnowledgeStore({ configDir: dir })
  s.load()
  return s
}

test('getRelated：返回锚点摘要（字段集合钉死、绝不含正文），带 why 与 score', async () => {
  const { dir } = makeValidateFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const rel = store.getRelated(`${DOC1}#0`)
    assert.ok(rel.length >= 1, '同 tag 对必须产出锚点（否则后面全是空转断言）')
    for (const x of rel) {
      assert.deepEqual(Object.keys(x).sort(), SUMMARY_KEYS,
        '锚点只给摘要：多一个正文字段就是上下文膨胀')
      assert.ok(x.docId && typeof x.docId === 'string')
      assert.equal(x.title, 'validate', 'title 取目标块所属文档标题')
      assert.ok(x.why && typeof x.why === 'object', 'why 必带（无 why 的锚点与随机跳转无异）')
    }
    const tagEdge = rel.find((x) => x.why.kind === 'tag')
    assert.deepEqual(tagEdge.why, { kind: 'tag', tag: '企微CLI化' })
    assert.equal(tagEdge.score, null, 'tag 边没有分数概念 → 不编造（null，不是 0）')
    // 反向可达：双向物化 ⇒ #1 查得到 #0
    assert.ok(store.getRelated(`${DOC1}#1`).some((x) => x.blockId === `${DOC1}#0`))
    // 未知块 / 空参数：返回 []，不抛错（GUI 面板不该因一个过期 blockId 崩）
    assert.deepEqual(store.getRelated(`${DOC1}#999`), [])
    assert.deepEqual(store.getRelated(''), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('读时校验①块删除：端点消失 → 视图剔除；validate:false 仍返回；文件一字不动', async () => {
  const { dir } = makeValidateFixture()
  try {
    const s1 = createKnowledgeStore({ configDir: dir })
    s1.load({ force: true })
    const before = relText(dir)
    assert.ok(s1.getRelated(`${DOC1}#0`, { validate: false })
      .some((x) => x.blockId === `${DOC1}#1`), '前置：物化里确实有 #0→#1')

    tamperDocs(dir, dropBlock(1)) // 块 #1 消失（模拟文档被改：块被删）
    const s2 = reopen(dir)

    const raw = s2.getRelated(`${DOC1}#0`, { validate: false })
    assert.ok(raw.some((x) => x.blockId === `${DOC1}#1`), '未校验视图（调试用）仍返回陈旧边')
    const strict = s2.getRelated(`${DOC1}#0`) // validate 缺省 true
    assert.ok(!strict.some((x) => x.blockId === `${DOC1}#1`), '端点已消失 → 该边必须从视图剔除')
    // 消失的块自己查不到任何东西（两端都要存在）
    assert.deepEqual(s2.getRelated(`${DOC1}#1`), [])
    // 只读语义：校验不落盘、不改物化
    assert.equal(relText(dir), before, '读时校验绝不改 related.jsonl')
    // 也不影响后续 validate:false（顺序无关 = 没有"校验一次就把边删了"的隐式状态）
    assert.ok(s2.getRelated(`${DOC1}#0`, { validate: false }).some((x) => x.blockId === `${DOC1}#1`))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('读时校验②tag 变更 / ③内容变更：各自剔除对应 kind 的边（其余边不受牵连）', async () => {
  const { dir } = makeValidateFixture()
  try {
    const s1 = createKnowledgeStore({ configDir: dir })
    s1.load({ force: true })
    assert.ok(s1.getRelated(`${DOC1}#0`, { validate: false }).some((x) => x.blockId === `${DOC1}#1`))
    assert.ok(s1.getRelated(`${DOC1}#2`, { validate: false })
      .some((x) => x.blockId === `${DOC1}#3` && x.why.kind === 'content'), '前置：物化里有 content 边 #2→#3')

    // #1 的 tag 变 → 同 tag 关系当前不再成立
    // #3 的正文变 → 内容指纹与物化时的 sigTo 不符
    tamperDocs(dir, (rows) => {
      patchBlock(1, { tag: '换过的标签' })(rows)
      patchBlock(3, { full: '完全不同的另一段正文，与任何条目都不重合，专用于验证内容变更后的剔除' })(rows)
    })
    const s2 = reopen(dir)

    const rawFirst = s2.getRelated(`${DOC1}#0`, { validate: false })
    assert.ok(rawFirst.some((x) => x.blockId === `${DOC1}#1`), '未校验视图仍给出陈旧的 tag 边')
    const strictFirst = s2.getRelated(`${DOC1}#0`)
    assert.ok(!strictFirst.some((x) => x.blockId === `${DOC1}#1`), 'tag 变了 → tag 边剔除')
    const rawContent = s2.getRelated(`${DOC1}#2`, { validate: false })
    assert.ok(rawContent.some((x) => x.blockId === `${DOC1}#3`), '未校验视图仍给出陈旧的 content 边')
    const strictContent = s2.getRelated(`${DOC1}#2`)
    assert.ok(!strictContent.some((x) => x.blockId === `${DOC1}#3`), '内容变了 → content 边剔除')
    // 反向边同样剔除（物化双向、校验逐行独立）
    assert.ok(!s2.getRelated(`${DOC1}#1`).some((x) => x.blockId === `${DOC1}#0`))
    // 其余文档/其余条目不受牵连（校验是逐边的，不做连坐）
    assert.ok(s2.getRelated(`${DOC1}#0`, { validate: false }).length >= 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── 夹具 2：search 附锚点用（主体条目 6 个同 tag 同伴 ⇒ 骨架层上限截断到 5）──
const M_BODY = '同步企微通讯录时先拉全量再做差集比对，避免把离职同事重新写回组织架构'
const DOC2 = 'experience/searchrel.md'

function makeSearchFixture() {
  const f = makePersonal('searchrel')
  const lines = ['---', 'name: searchrel', '---', `- [会话|预算标签] 主体条目 -- ${M_BODY}`]
  for (let i = 2; i <= 7; i++) {
    lines.push(`- [会话|预算标签] 同标签${i} -- 这是第${i}条同标签条目，正文与主体条目毫无重合，仅用于撑起骨架层预算`)
  }
  lines.push('- [会话|无关甲] 无关甲 -- 完全无关的一条经验，讲的是打包知识包时校验清单与文件一一对应')
  writeFileSync(f.md, lines.join('\n') + '\n', 'utf-8')
  return f
}

test('search() 附锚点：只给摘要（字段集合）+ topN 条数上限，且 off 模式不带该字段', async () => {
  const { dir } = makeSearchFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    // 前置：主体条目物化出 5 条 tag 边（6 个同伴被 MAX_TAG_RELATED 截断）
    const own = store.getRelated(`${DOC2}#0`)
    assert.equal(own.filter((x) => x.why.kind === 'tag').length, MAX_TAG_RELATED)

    const r = store.search({ query: '企微通讯录 差集比对', keywords: ['企微通讯录'], topK: 5 })
    assert.ok(r.items.length >= 1)
    for (const it of r.items) {
      assert.ok(Array.isArray(it.related), 'on 模式每个 item 都带 related（形状稳定，消费方不必分支）')
      for (const x of it.related) {
        assert.deepEqual(Object.keys(x).sort(), SUMMARY_KEYS,
          'related 只给 {blockId,docId,title,why,score} —— 带正文字段就是 S3 的上下文膨胀翻版')
      }
    }
    const hit = r.items.find((it) => it.blockId === `${DOC2}#0`)
    assert.ok(hit, '查询应命中主体条目（否则本用例的条数断言是空转）')
    assert.equal(hit.related.length, 3,
      `每条 item 的锚点上限 3（SEARCH_RELATED_TOPN）—— 物化有 ${MAX_TAG_RELATED} 条也必须被截断`)
    assert.ok(hit.related.every((x) => x.why.kind === 'tag'))
    // 体积控制：正文（超 16 字的整段片段）绝不可能出现在 related 里（bigram 最长 2 字）
    const json = JSON.stringify(r.items.map((it) => it.related))
    assert.ok(!json.includes(M_BODY.slice(0, 16)), 'related 不得携带正文（哪怕片段）')
    assert.ok(!json.includes('拉全量再做差集比对'), 'related 不得携带正文字段')

    // off 模式（回滚开关）：search 不带 related 字段（不是空数组，是**没有这个字段**）
    const off = createKnowledgeStore({ configDir: dir, relateMode: 'off' })
    off.load({ force: true })
    const r2 = off.search({ query: '企微通讯录 差集比对', keywords: ['企微通讯录'], topK: 5 })
    assert.ok(r2.items.length >= 1)
    for (const it of r2.items) assert.ok(!('related' in it), 'off 模式不得出现 related 字段（等价 S4）')
    assert.deepEqual(off.getRelated(`${DOC2}#0`), [], 'off 模式没有关联概念 → []')
    // `refEdges` 为 S5.1 追加（手写引用 → 条目级关联的边数，spec s51 §4.2）
    assert.deepEqual(off.stats().related,
      { edges: 0, tagEdges: 0, contentEdges: 0, refEdges: 0, dupEdges: 0, dropped: 0 })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── 夹具 3：limit / duplicate 预算用（与 Task 4 的预算夹具同构）────────────────
const C1 = '同步企微通讯录时先拉全量再做差集比对，避免把离职同事重新写回组织架构'
const C2 = '打包知识包前必须校验清单与文件一一对应，缺项会让安装方静默少装文档'
const C3 = '执行高风险命令前用 dry-run 预览全部副作用，确认无误再真正落地操作'
const BODY_X = `${C1}；${C2}；${C3}`
const DOC3 = 'experience/budget.md'

function makeBudgetFixture() {
  const f = makePersonal('budget')
  const lines = ['---', 'name: budget', '---', `- [会话|预算标签] 主体条目 -- ${BODY_X}`]
  // 6 个同 tag 同伴（= 每个同 tag 条目都有 6 个同伴 > MAX_TAG_RELATED(5)）⇒ 必然触发
  // 骨架层截断，`stats().related.dropped` 才有可观测的非零值
  for (let i = 2; i <= 7; i++) {
    lines.push(`- [会话|预算标签] 同标签${i} -- 这是第${i}条同标签条目，正文与其他条目都不同，用于验证骨架层上限`)
  }
  lines.push(`- [会话|相似甲] 相似甲标题 -- ${C1}`)
  lines.push(`- [会话|相似乙] 相似乙标题 -- ${C2}`)
  lines.push(`- [会话|相似丙] 相似丙标题 -- ${C3}`)
  lines.push(`- [会话|重复丁] 重复丁标题 -- ${BODY_X}`)
  writeFileSync(f.md, lines.join('\n') + '\n', 'utf-8')
  return f
}

test('getRelated 的 limit 生效：只约束关联（tag/content），duplicate 不占预算且排在末尾', async () => {
  const { dir } = makeBudgetFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const all = store.getRelated(`${DOC3}#0`)
    const nonDup = all.filter((x) => x.why.kind !== 'duplicate')
    assert.equal(nonDup.length, MAX_RELATED, `非重复锚点应占满预算 ${MAX_RELATED}`)
    assert.equal(all.filter((x) => x.why.kind === 'duplicate').length, 1)
    assert.ok(all.length > MAX_RELATED, 'duplicate 不计入 MAX_RELATED 预算（spec §5.5）')
    // 层序：tag → content → duplicate（duplicate 必须能被调用方一眼分出来）
    const ranks = all.map((x) => (x.why.kind === 'tag' ? 0 : x.why.kind === 'content' ? 1 : 2))
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), 'duplicate 排在关联之后')
    assert.equal(ranks[ranks.length - 1], 2)
    // 覆盖层上限独立生效（不与骨架层混算）
    assert.equal(all.filter((x) => x.why.kind === 'content').length, 3)
    assert.equal(MAX_CONTENT_RELATED >= 3, true)

    const two = store.getRelated(`${DOC3}#0`, { limit: 2 })
    assert.equal(two.filter((x) => x.why.kind !== 'duplicate').length, 2, 'limit 生效')
    assert.equal(two.filter((x) => x.why.kind === 'duplicate').length, 1,
      'duplicate 独立于 limit（要能在 GUI/agent 侧单独提示"疑似重复"）')
    const zero = store.getRelated(`${DOC3}#0`, { limit: 0 })
    assert.equal(zero.filter((x) => x.why.kind !== 'duplicate').length, 0)
    assert.equal(zero.length, 1)
    // 未校验视图与校验视图在"无陈旧边"时逐条相同（校验只做剔除，不重排/不改写）
    assert.deepEqual(store.getRelated(`${DOC3}#0`, { validate: false }), all)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('stats().related：分类计数=物化行数、dropped 只数计算期丢弃，连查多次不漂移', async () => {
  const { dir } = makeBudgetFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const before = store.stats().related
    const lines = relText(dir).split('\n').filter(Boolean).length
    assert.equal(before.edges, lines, 'edges = related.jsonl 物化行数（含镜像行）')
    assert.equal(before.tagEdges + before.contentEdges + before.dupEdges, before.edges, '分类之和 = 总数')
    // 7 个同 tag 条目（主体 + 6 同伴），每个有 6 个同伴、被截到 MAX_TAG_RELATED=5 ⇒
    // 正向 7×5=35 行，镜像轮补 5 行（骨架层按"同文档位置最近"排序，最远的那对双向都被截掉），
    // 共 40 行。期望值以实跑为准（Task 4 的骨架层截断规则不变）
    assert.equal(before.tagEdges, 40, 'tag 边行数 = 7 条目 × 5 同伴 + 镜像补 5')
    assert.equal(before.dupEdges, 2, '重复对（#0↔#9）× 双向')
    assert.equal(before.dropped, 7, '计算期丢弃 = 7 个同 tag 条目各被截掉 1 个同伴')

    // 连查 3 次（校验视图/未校验视图/检索附锚点）后 stats 必须逐字不变：
    // 读时剔除**绝不**计入 dropped —— 否则同一库的 stats 会随查询历史漂移、不可复现（spec §7.2）
    for (let i = 0; i < 3; i++) {
      store.getRelated(`${DOC3}#0`)
      store.getRelated(`${DOC3}#0`, { validate: false })
      store.search({ query: '企微通讯录 差集比对', keywords: ['企微通讯录'], topK: 3 })
    }
    assert.deepEqual(store.stats().related, before, 'stats.related 不随查询次数变化')

    // 陈旧边（篡改 docs.jsonl 制造）被校验剔除后，stats 依旧不变
    tamperDocs(dir, dropBlock(1))
    const s2 = reopen(dir)
    const afterTamper = s2.stats().related
    assert.equal(afterTamper.edges, before.edges, '物化行数没变（load 复用磁盘物化，不重算）')
    const validated = s2.getRelated(`${DOC3}#0`)
    assert.ok(validated.length <= afterTamper.edges)
    assert.deepEqual(s2.stats().related, afterTamper, '读时剔除不进 stats（dropped 也不动）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
