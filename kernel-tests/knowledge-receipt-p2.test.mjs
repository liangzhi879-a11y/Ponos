// P2 回执能力（命中词 / 分页）测试，2026-09-18
// ---------------------------------------------------------------------------
// P2 的两件事都必须在**回执层**被钉住，因为它们的价值全在"模型能不能看见"：
//   ① 命中词：让模型知道"为什么返回这条"（来源材料三次强调的字面匹配优势）；
//   ② 分页：让模型知道"还有没有、怎么续看"（此前只给 count，模型无法区分
//      "只有 5 条"与"是 300 条里的 5 条"，于是不会翻页，也不会想到换词）。
//
// 三条纪律在本文件里逐条断言：
//   - legacy 打分器（缺省）下回执**逐字不变**（无 hits 字段 → 不拼那段；零回归）；
//   - 命中词有硬预算（≤4 个词、每词 ≤12 字）—— 否则它会变成第二个内容字段；
//   - 分页不得破坏 maxBytes 预算语义（跳过的条目不占预算）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchKnowledge, searchKnowledgeItems } from '../kernel/knowledge-search.mjs'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-p2-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  // 造 8 篇**独立文档**、每篇一条含"冒烟"的条目：足以触发分页（topK=3 时还有下一页）。
  // 为什么不用"单文件 8 条列表"：连续的 `- ` 行会被 splitBlocks 合并成一个 list 块，
  // 于是"总命中数=1"，分页根本测不到（这是踩过的坑）。
  for (let i = 1; i <= 8; i++) {
    writeFileSync(join(personal, `smoke${i}.md`), [
      '---', `name: smoke${i}`, '---',
      `# 冒烟第${i}篇`,
      `- [会话|冒烟第${i}条] 冒烟检查第${i}项 -- 打包前必须依次跑完冒烟清单的第${i}项，避免坏包发给用户`,
    ].join('\n') + '\n', 'utf-8')
  }
  return dir
}

test('P2：BM25 模式下回执带命中词，legacy 下逐字不含（零回归）', () => {
  const dir = fixture()
  const saved = process.env.PONOS_KNOWLEDGE_SCORER
  try {
    const args = { configDir: dir, query: '冒烟 打包', topK: 3 }
    process.env.PONOS_KNOWLEDGE_SCORER = 'bm25'
    const bm25 = searchKnowledge(args)
    assert.match(bm25.content, /命中「.+」/, `BM25 回执应给出命中词：${bm25.content}`)

    process.env.PONOS_KNOWLEDGE_SCORER = 'legacy'
    const legacy = searchKnowledge(args)
    assert.ok(!legacy.content.includes('命中「'),
      `legacy（缺省）回执必须与改造前逐字一致，不得出现命中词段：${legacy.content}`)
  } finally {
    if (saved === undefined) delete process.env.PONOS_KNOWLEDGE_SCORER
    else process.env.PONOS_KNOWLEDGE_SCORER = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P2：命中词有硬预算（≤4 个词、每词 ≤12 字），不能变成第二个内容字段', () => {
  const dir = fixture()
  const saved = process.env.PONOS_KNOWLEDGE_SCORER
  try {
    process.env.PONOS_KNOWLEDGE_SCORER = 'bm25'
    const r = searchKnowledge({ configDir: dir, query: '冒烟 打包 依次 清单 第', topK: 3 })
    const m = r.content.match(/命中「([^」]*)」/)
    assert.ok(m, `应出现命中词：${r.content}`)
    const words = m[1].split(' ').filter(Boolean)
    assert.ok(words.length <= 4, `命中词最多 4 个，实际 ${words.length}`)
    for (const w of words) assert.ok(w.length <= 12, `单个命中词 ≤12 字，实际「${w}」`)
    // 回执整体字节量不该被这项撑大（每次工具调用都付这份成本）
    assert.ok(Buffer.byteLength(r.content, 'utf-8') < 4096, `回执不应被撑大：${Buffer.byteLength(r.content, 'utf-8')}B`)
  } finally {
    if (saved === undefined) delete process.env.PONOS_KNOWLEDGE_SCORER
    else process.env.PONOS_KNOWLEDGE_SCORER = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P2：分页 —— 回执给出 total 与 nextOffset，第二页内容与第一页不重叠', () => {
  const dir = fixture()
  try {
    const p1 = searchKnowledge({ configDir: dir, query: '冒烟 清单', topK: 3 })
    assert.match(p1.content, /共 \d+ 条命中/, `应报总量：${p1.content}`)
    const m = p1.content.match(/offset=(\d+)/)
    assert.ok(m, `还有下一页时应给 nextOffset：${p1.content}`)
    const next = Number(m[1])
    assert.equal(next, 3, '第二页偏移应等于第一页条数')

    const p2 = searchKnowledge({ configDir: dir, query: '冒烟 清单', topK: 3, offset: next })
    // 用**文档名**而不是行号当标识：8 篇 fixture 的条目都在同一行号上，用行号会
    // 把"不同文档的同号行"误判成重叠（踩过这个坑）。
    const pick = (txt) => [...txt.matchAll(/smoke(\d+)\.md/g)].map((x) => x[1])
    const ids1 = pick(p1.content)
    const ids2 = pick(p2.content)
    assert.equal(ids1.length, 3)
    assert.ok(ids2.length > 0, `第二页应仍有命中：${p2.content}`)
    assert.equal(ids1.filter((x) => ids2.includes(x)).length, 0, `两页不得重叠（1页=${ids1} 2页=${ids2}）`)
    assert.ok(!/offset=\d+/.test(p2.content) || p2.content.includes('已是最后一批') || Number(p2.content.match(/offset=(\d+)/)[1]) > next,
      '续看偏移必须单调前进（不得原地打转）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('P2：分页不破坏 maxBytes 预算语义（跳过的条目不吃预算）', () => {
  const dir = fixture()
  try {
    const base = { configDir: dir, query: '冒烟 清单', topK: 3, mode: 'full' }
    const a = searchKnowledgeItems({ ...base, offset: 0 })
    const b = searchKnowledgeItems({ ...base, offset: 3 })
    assert.equal(a.count, 3)
    assert.equal(b.count, 3, '第二页的条数不该因为"跳过"而变少')
    assert.equal(b.offset, 3)
    assert.notEqual(a.items[0].blockId, b.items[0].blockId)
    // total 是截断前的候选总数：两页看到同一个 total（据此才知道还有没有下一批）
    assert.equal(a.total, b.total)
    assert.ok(a.total >= 6, `构造了 8 条含"冒烟"的条目，total 应 ≥6，实际 ${a.total}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('P2：offset 超出总量时返回空页而不是报错（翻到底不该变成故障）', () => {
  const dir = fixture()
  try {
    const r = searchKnowledgeItems({ configDir: dir, query: '冒烟', topK: 3, offset: 500 })
    assert.equal(r.ok, true)
    assert.equal(r.count, 0)
    assert.ok(r.total > 0, 'total 仍应报真实总量，供调用方纠正 offset')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
