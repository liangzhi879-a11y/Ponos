// kernel-tests/knowledge-recall-quota.test.mjs
// 数据膨胀护栏 G3（单空间抽调配额）与范围观测（2026-09-15，待处理清单 P1）。
//
// 覆盖什么：spec §6.4 —— 单个巨型库不能把抽调层刷满（`MAX_RECALL_PER_SPACE`），
// stats 的 scope / spacesDropped / spacesCapped 三项要如实上报（膨胀问题唯一的事后证据）。
//
// 为什么用"一个大库 + 一个小库"而不是"一个大库"：配额只有在**有库被压制**时才可观测——
// 只放一个库时，4 条上限与 8 条候选的差别会被"反正都是同一个库"掩盖，测试会假绿。
// 隔离纪律：mkdtempSync 临时 configDir，绝不碰真实 ~/.yfworking。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildKnowledgeInjection, resetInjectStats, getInjectStats } from '../kernel/knowledge-inject.mjs'

/** 造一个用户空间，写 N 篇都能命中「四表联动」的文档（每篇一个独立 docId ⇒ 不被每文档配额限住）。 */
function writeSpace(dir, id, name, docs) {
  const root = join(dir, 'knowledge', 'spaces', id)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, '.space.json'), JSON.stringify({ name }), 'utf-8')
  for (let i = 0; i < docs; i += 1) {
    writeFileSync(join(root, `d${i}.md`), [
      '---', `name: ${id}-${i}`, `description: ${name} 文档 ${i}`, '---',
      `# ${name} ${i}`, '',
      `- [会话|${id}] 四表联动口径 ${i} -- 四表联动的产品名称与收入口径必须对齐（${id} 第 ${i} 篇）`,
    ].join('\n') + '\n', 'utf-8')
  }
}

/** 夹具：巨型库 big（8 篇可命中）+ 小库 small（1 篇可命中）。 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-quota-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  writeFileSync(join(personal, 'workflow.md'), '# 工作流\n\n- [会话|测试] 四表联动 -- 经验库也有一条\n', 'utf-8')
  writeSpace(dir, 'big', '巨型库', 8)
  writeSpace(dir, 'small', '小库', 1)
  return dir
}

const run = (dir, spaces) => buildKnowledgeInjection({
  configDir: dir, memoryRootDir: join(dir, 'memory', 'personal'),
  query: '四表联动 口径', keywords: ['四表联动'], mode: 'unified',
  spaces, totalBudget: 32768,   // 预算放大：让断言只考"分配"而不是"谁能塞进预算"
})

test('G3：单个巨型库最多贡献 4 块，其余库仍能出现（配额防"一库刷屏"）', () => {
  const dir = fixture()
  try {
    resetInjectStats()
    const r = run(dir, ['experience', 'big', 'small'])
    const rows = r.recallSection.split('\n').filter((l) => l.startsWith('- ['))
    const perSpace = {}
    for (const l of rows) {
      // 行格式：`- [空间|标题] 摘要 -- docId › 小节 · 第 N 行 (块id)`
      const m = l.match(/^- \[([^|\]]+)\|/)
      const space = m ? m[1] : 'unknown'
      perSpace[space] = (perSpace[space] || 0) + 1
    }
    assert.ok(rows.length > 0, `应有抽调（实际 ${rows.length}）\n${r.recallSection}`)
    for (const [space, n] of Object.entries(perSpace)) {
      assert.ok(n <= 4, `空间 ${space} 超过单库配额 4（实际 ${n}）：\n${r.recallSection}`)
    }
    assert.ok(perSpace.big >= 1 && perSpace.big <= 4, `巨型库应在 1..4 之间（实际 ${perSpace.big}）`)
    assert.equal(perSpace.small, 1, `小库不得被巨型库挤掉——这正是配额要解决的现象（分布 ${JSON.stringify(perSpace)}）\n${r.recallSection}`)
    // 配额压制必须留痕：否则"关联了库却没出现"与"那个库本来没命中"无法区分
    assert.deepEqual(r.stats.spacesCapped, ['big'], `被压制的空间要记账（实际 ${JSON.stringify(r.stats.spacesCapped)}）`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('观测：stats 如实上报范围（scope）+ 超上限被丢弃的库（spacesDropped）', () => {
  const dir = fixture()
  try {
    resetInjectStats()
    const r = run(dir, ['experience', 'small'])
    assert.deepEqual(r.stats.scope, ['experience', 'small'], 'scope = 本次注入实际使用的白名单')
    assert.deepEqual(r.stats.spacesDropped, [], '没超上限时不得凭空报丢弃')
    const s = getInjectStats()
    assert.deepEqual(s.scope, ['experience', 'small'], '累加器要同步（/knowledge/stats 与 metrics.json 读这里）')
    assert.deepEqual(s.spacesCapped, [], '小库不会被压制')

    const r2 = buildKnowledgeInjection({
      configDir: dir, memoryRootDir: join(dir, 'memory', 'personal'),
      query: '四表联动', keywords: ['四表联动'], mode: 'unified',
      spaces: ['experience', 'big', 'small'], spacesDropped: ['overflow-1', 'overflow-2'],
    })
    assert.deepEqual(r2.stats.spacesDropped, ['overflow-1', 'overflow-2'], '超上限被忽略的库必须可见')
    assert.deepEqual(getInjectStats().spacesDropped, ['overflow-1', 'overflow-2'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('legacy：不使用范围，故 scope 如实为 null（不照抄调用方的白名单）', () => {
  const dir = fixture()
  try {
    resetInjectStats()
    const r = buildKnowledgeInjection({
      configDir: dir, memoryRootDir: join(dir, 'memory', 'personal'),
      query: '四表联动', keywords: ['四表联动'], mode: 'legacy', spaces: ['experience', 'small'],
    })
    assert.equal(r.stats.scope, null, 'legacy 注入的是个人经验目录行，与范围无关：照抄会让统计说谎')
    assert.equal(getInjectStats().scope, null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
