// P1 打分器（BM25）测试，2026-09-18
// ---------------------------------------------------------------------------
// 这一批锁定的是"**换了什么、没换什么**"：
//   ① 缺省是 bm25（2026-09-18 经量尺验证后翻正）—— 且**必须能一键退回 legacy**：
//      "可回退"不是文档里的承诺，而是这条测试钉住的事实；
//   ② 开关要真的生效，而且回执要能证明是哪个打分器给的结果（`scorer` 字段）；
//   ③ 两个打分器**只在块级公式上不同** —— 候选、过滤、截断、关联、语法层必须一致；
//   ④ BM25 的"部分长度归一化"要能测出来：同一查询下，长块与短块的相对排序不该被块长主导
//      （这是 P0 基线暴露的核心缺陷：heading 94% vs table 52%）。
//
// 语料用临时 configDir 隔离：不读用户真实库，测试可离线重复。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKnowledgeStore } from '../kernel/knowledge.mjs'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-bm25-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  writeFileSync(join(personal, 'workflow.md'), [
    '---', 'name: workflow', 'tags: [安装包, 冒烟]', '---',
    '# 安装包制作',
    '- [会话|安装包制作] 打包前先跑冒烟 -- electron-builder 打包前必须跑一次冒烟测试，否则坏包会直接发给用户',
    '- [会话|企微CLI化] 沟通渠道纪律 -- 涉及真实沟通渠道的测试一律只发文件传输助手',
  ].join('\n') + '\n', 'utf-8')
  // 一篇"长块"文档：同一个稀有词出现在很长的段落里（用于检验长度归一化）
  writeFileSync(join(personal, 'long.md'), [
    '---', 'name: long', '---',
    '# 长文测试',
    `- [会话|长块] 冒烟清单 -- 冒烟检查项：${'无关填充内容用于拉长这个块使它显著长于语料里的其他块。'.repeat(40)}`,
  ].join('\n') + '\n', 'utf-8')
  return dir
}

function load(dir, opts = {}) {
  const store = createKnowledgeStore({ configDir: dir, ...opts })
  store.load({})
  return store
}

test('P1：缺省打分器是 bm25，且能一键退回 legacy（回退承诺必须可执行）', () => {
  const dir = fixture()
  const saved = process.env.PONOS_KNOWLEDGE_SCORER
  try {
    delete process.env.PONOS_KNOWLEDGE_SCORER
    assert.equal(load(dir).search({ query: '冒烟 安装包', topK: 3 }).scorer, 'bm25',
      '缺省应是量尺验证过更优的 bm25')
    // 回退路径：config.json 与 env 两条都要能压过缺省（线上排障时未必方便改 env）
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ knowledgeScorer: 'legacy' }), 'utf-8')
    assert.equal(load(dir).search({ query: '冒烟 安装包', topK: 3 }).scorer, 'legacy',
      'config.json 必须能退回 legacy')
    process.env.PONOS_KNOWLEDGE_SCORER = 'legacy'
    assert.equal(load(dir).search({ query: '冒烟 安装包', topK: 3 }).scorer, 'legacy')
  } finally {
    if (saved === undefined) delete process.env.PONOS_KNOWLEDGE_SCORER
    else process.env.PONOS_KNOWLEDGE_SCORER = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P1：开关三态（构造参数 > env > 缺省）都能切到 bm25，且回执带 scorer 证据', () => {
  const dir = fixture()
  const saved = process.env.PONOS_KNOWLEDGE_SCORER
  try {
    // 构造参数优先（测试与标定走这条：同进程换参数，不必改 env）
    assert.equal(load(dir, { scorerMode: 'bm25' }).search({ query: '冒烟' }).scorer, 'bm25')
    // env 次之
    process.env.PONOS_KNOWLEDGE_SCORER = 'bm25'
    assert.equal(load(dir).search({ query: '冒烟' }).scorer, 'bm25')
    // 非法值不得"悄悄当成新模式"（否则一个拼写错误会静默改变全部结果的口径）：
    // 落到**缺省**（bm25），而不是落到某个"看起来像"的模式上
    process.env.PONOS_KNOWLEDGE_SCORER = 'bm25f-typo'
    assert.equal(load(dir).search({ query: '冒烟' }).scorer, 'bm25')
  } finally {
    if (saved === undefined) delete process.env.PONOS_KNOWLEDGE_SCORER
    else process.env.PONOS_KNOWLEDGE_SCORER = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P1：两个打分器只改块级公式 —— 语法层/过滤/截断/关联形状必须一致', () => {
  const dir = fixture()
  try {
    const legacy = load(dir, { scorerMode: 'legacy' })
    const bm25 = load(dir, { scorerMode: 'bm25' })
    const q = { query: '冒烟 安装包', topK: 3, maxBytes: 1e9 }
    const a = legacy.search(q)
    const b = bm25.search(q)
    // 契约是"**共用候选池与过滤/截断**"，不是"给出同一批块"：两个公式本来就会排出不同块
    // （实测同一查询下 BM25 把含标题词的 heading 块排前、legacy 把 entry 块排前 —— 那是
    // 打分差异本身，正是要观测的东西）。
    assert.ok(b.count > 0 && a.count > 0)
    // 每篇文档的**块配额**是有意不同的（P1b）：legacy 固定 1（与改造前一致），
    // bm25 允许 2 —— 因为诊断证明"文档对了、块不对"是主要 miss 形态（一篇长文档里
    // 只让一个块出场，等于丢掉了文档内路由）。故这里断言的是**这个词配额本身**，
    // 而不是"条数相同"（后者会把这条修复钉成 bug）。
    const countPerDoc = (r) => {
      const m = new Map()
      for (const it of r.items) m.set(it.docId, (m.get(it.docId) || 0) + 1)
      return Math.max(0, ...m.values())
    }
    assert.equal(countPerDoc(a), 1, 'legacy 每篇文档最多 1 块（零回归承诺）')
    assert.ok(countPerDoc(b) <= 2, `bm25 每篇文档最多 2 块，实际 ${countPerDoc(b)}`)
    assert.equal(a.count, Math.min(3, a.total), 'legacy 截断仍按 topK')
    assert.equal(b.count, Math.min(3, b.total), 'bm25 截断仍按 topK')
    for (const it of b.items) {
      for (const k of ['docId', 'blockId', 'spaceId', 'title', 'heading', 'snippet', 'line', 'kind', 'tag']) {
        assert.ok(k in it, `回执字段 ${k} 不许因换打分器而丢失`)
      }
    }
    // 过滤/算子路径完全共用：`tag:` 枚举在有/无 BM25 下都必须走同一条 enumerateSearch
    const f1 = legacy.search({ query: 'tag:安装包', topK: 3 })
    const f2 = bm25.search({ query: 'tag:安装包', topK: 3 })
    assert.deepEqual(f1.items.map((x) => x.blockId), f2.items.map((x) => x.blockId))
    // 关联锚点（若开启）不得因为打分器而消失
    if ('related' in a.items[0]) assert.ok('related' in b.items[0], 'related 字段不许因换打分器而丢失')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('P1：BM25 的部分长度归一化 —— 长块不被块长主导（legacy 的完全归一化会压制长块）', () => {
  const dir = fixture()
  try {
    const store = load(dir, { scorerMode: 'bm25' })
    const r = store.search({ query: '冒烟', topK: 5, maxBytes: 1e9 })
    const ids = r.items.map((x) => x.blockId)
    // 长块（long.md）与短块（workflow.md）都含 "冒烟"：两者都该被召回（legacy 的长块
    // 因为被向量模长除而分数被摊薄，长文里出现的关键词常常挤不进 top5）
    assert.ok(ids.some((x) => x.includes('long.md')), `长块应被召回，实际 ${JSON.stringify(ids)}`)
    assert.ok(ids.some((x) => x.includes('workflow.md')), '短块同样应被召回')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('P1：参数可注入且真的影响分数（标定靠它，不是靠改 env 重启进程）', () => {
  const dir = fixture()
  try {
    const store = load(dir, { scorerMode: 'bm25' })
    const weak = store.search({ query: '冒烟', topK: 1, maxBytes: 1e9, bm25: { k1: 0.1, b: 0.75, sat: 8 } })
    const strong = store.search({ query: '冒烟', topK: 1, maxBytes: 1e9, bm25: { k1: 8, b: 0.75, sat: 8 } })
    assert.ok(weak.items.length && strong.items.length)
    // k1 影响 tf 饱和速度 → 同一 query 的分数必须随之变化（不变说明注入没生效）
    assert.notEqual(weak.items[0].score, strong.items[0].score, 'k1 注入必须改变打分结果')
    // 极小的 sat 会让 BM25 分量饱和逼近 1（可观测的单调性）
    const s1 = store.search({ query: '冒烟', topK: 1, maxBytes: 1e9, bm25: { k1: 1.2, b: 0.75, sat: 0.01 } })
    assert.ok(s1.items[0].score >= strong.items[0].score, 'sat 越小，BM25 分量占比越高（分数不该下降）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('P1：降级路（查询 gram 全落空）两个打分器都不得凭空造出结果', () => {
  const dir = fixture()
  try {
    for (const mode of ['legacy', 'bm25']) {
      const r = load(dir, { scorerMode: mode }).search({ query: 'zzzq不存在的词xyz', topK: 5 })
      const hit = r.items.filter((x) => x.score > 0.001)
      assert.equal(hit.length, 0, `${mode}：零相关查询不得返回命中（实际 ${JSON.stringify(r.items.map((x) => x.score))}）`)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('P1c：bm25f 模式可用且字段权重真的生效（能力保留，缺省不启用）', () => {
  const dir = fixture()
  try {
    // 查询词必须**落在字段里**才测得到字段加权（踩过的坑：用只在正文出现的"冒烟"，
    // fw 从 3 抬到 20 分数纹丝不动 —— 那测的是"无关时不生效"，不是"生效"）。
    // fixture 的 `# 安装包制作` 标题与 entry 的 tag 都含"安装包制作"，正是字段查询。
    const store = load(dir, { scorerMode: 'bm25f' })
    assert.equal(store.search({ query: '安装包制作' }).scorer, 'bm25f')
    const q = { query: '安装包制作', topK: 5, maxBytes: 1e9 }
    const base = store.search({ ...q, bm25: { fw: [3, 2, 2] } })
    const boosted = store.search({ ...q, bm25: { fw: [20, 8, 4] } })
    assert.ok(base.items.length && boosted.items.length)
    // 把标签权重从缺省 3 抬到 20：含该标签的块分数必须上升（否则字段加权没接进打分）
    const scoreOf = (r, id) => (r.items.find((x) => x.blockId === id) || {}).score
    const ids = base.items.map((x) => x.blockId)
    const up = ids.filter((id) => scoreOf(boosted, id) > scoreOf(base, id) + 1e-9)
    assert.ok(up.length > 0, `抬高标签权重后应有块分数上升，实际未变：${JSON.stringify(ids.map((id) => [scoreOf(base, id), scoreOf(boosted, id)]))}`)

    // bm25 模式必须与字段权重**完全无关**（否则"bm25f 比 bm25 好多少"的归因就失效）
    const m = load(dir, { scorerMode: 'bm25' })
    const plain = m.search({ ...q, bm25: { fw: [3, 2, 2] } })
    const withFw = m.search({ ...q, bm25: { fw: [20, 8, 4] } })
    assert.deepEqual(
      plain.items.map((x) => x.score), withFw.items.map((x) => x.score),
      'bm25（单字段）不得受 fw 影响 —— 否则两个模式不再可比',
    )
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('P1c：缺省不启用 bm25f（无证据支持的默认值就是净负债）', () => {
  const dir = fixture()
  const saved = process.env.PONOS_KNOWLEDGE_SCORER
  try {
    delete process.env.PONOS_KNOWLEDGE_SCORER
    // 缺省必须是 bm25 而非 bm25f：实测 80 例 field 样本上 bm25f 零收益
    // （0.738 恒定，见 kernel/knowledge.mjs 的 fw 注释），不该默认多付字段计数成本
    assert.equal(load(dir).search({ query: '冒烟' }).scorer, 'bm25')
  } finally {
    if (saved === undefined) delete process.env.PONOS_KNOWLEDGE_SCORER
    else process.env.PONOS_KNOWLEDGE_SCORER = saved
    rmSync(dir, { recursive: true, force: true })
  }
})
