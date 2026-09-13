// S5 Task 5：增量更新（`updateDoc`）的关联维护 —— 回归测试。
//
// 被钉住的三件事（spec §6.1 的"折中"方案）：
//   ① 本文档条目的**出边**重算（索引已更新，旧出边可能失效；含覆盖层 content 边）；
//   ② **只对同 tag 的其它条目补入边**（这些必然是 tag 边）——content 类入边不即时重算，
//      这是已明示的取舍（最坏到下次全量重建才补齐）；
//   ③ 增量后 `manifest.relLines` 必须与文件行数同步 —— 否则下次 load 会判定
//      "实际行数 < 指纹" → 误判损坏 → 每次都整库重建（S1 的截断教训反过来咬人）。
// 另：删除的块不得在物化文件里留下端点（读时校验是兜底，不是唯一防线）。
//
// 隔离纪律：mkdtempSync 临时 configDir，绝不碰真实 ~/.yfworking / ~/.yfw。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKnowledgeStore } from '../kernel/knowledge.mjs'
import { SIM_THRESHOLD, DUP_COS } from '../shared/knowledge-core.mjs'

const idxDir = (dir) => join(dir, 'knowledge', '.index')
const relRows = (dir) => readFileSync(join(idxDir(dir), 'related.jsonl'), 'utf-8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l))
const relLineCount = (dir) => readFileSync(join(idxDir(dir), 'related.jsonl'), 'utf-8')
  .split('\n').filter(Boolean).length
const manifestOf = (dir) => JSON.parse(readFileSync(join(idxDir(dir), 'manifest.json'), 'utf-8'))
const key = (r) => `${r.from}\u0000${r.to}`

const BODY_A = '构建脚本经验：打包前先清理 dist 目录，否则旧产物会被一起发布出去'
const BODY_B = '企微审批字段契约：金额必须用分单位整数，浮点会丢精度导致审批直接失败'
const BODY_A2 = '知识包安装顺序：先备份现有目录再解压，解压失败要能回滚到备份状态'
// 与 BODY_A 高度重叠但不等（实测 cos≈0.92 < DUP_COS）——用来观测**出边重算**（content 类）
const BODY_A_SIM = '构建脚本经验：打包前先清理 dist 目录，否则旧的产物会被一起发布出去，务必核对'

/** 两个文档各一条条目：tag 不同、正文不相似 ⇒ 基线**零边**（增量效果可观测的前提）。 */
function makeIncrementalFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-krel-inc-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  writeFileSync(join(personal, 'a.md'), `- [会话|甲标签] 条目甲 -- ${BODY_A}\n`, 'utf-8')
  writeFileSync(join(personal, 'b.md'), `- [会话|共享主题] 条目乙 -- ${BODY_B}\n`, 'utf-8')
  return { dir, personal }
}

test('增量：updateDoc 后同 tag 入边即时可见、出边已更新，relLines 同步（不误判损坏）', async () => {
  const { dir, personal } = makeIncrementalFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    assert.equal(relRows(dir).length, 0, '基线：tag 不同且内容不相似 ⇒ 无边')

    // ① a.md 追加一条 tag=共享主题 的条目（与 b.md 的条目同 tag，但内容不相似）
    writeFileSync(join(personal, 'a.md'),
      `- [会话|甲标签] 条目甲 -- ${BODY_A}\n- [会话|共享主题] 条目甲二 -- ${BODY_A2}\n`, 'utf-8')
    assert.deepEqual(store.updateDoc('experience/a.md'), { updated: true })
    const afterAdd = relRows(dir)
    const byKey = new Map(afterAdd.map((r) => [key(r), r]))
    const inEdge = byKey.get(key({ from: 'experience/b.md#0', to: 'experience/a.md#1' }))
    // 这条是"入边"：b.md 没被改写、它的出边没重算过 ⇒ 只能由**补入边**产生
    assert.deepEqual(inEdge?.why, { kind: 'tag', tag: '共享主题' }, '同 tag 入边必须即时可见')
    const outEdge = byKey.get(key({ from: 'experience/a.md#1', to: 'experience/b.md#0' }))
    assert.deepEqual(outEdge?.why, { kind: 'tag', tag: '共享主题' }, '本文件条目的出边已重算')
    // ② relLines 必须同步：否则下次 load 会判定"文件行数 < 指纹"而整库重建
    assert.equal(manifestOf(dir).relLines, relLineCount(dir))
    const reload = createKnowledgeStore({ configDir: dir })
    reload.load()
    assert.equal(reload.stats().builtAt, store.stats().builtAt, '增量后 load 不得触发重建（指纹同步）')

    // ③ 出边重算含覆盖层：改 b.md 的正文使其与 a.md 的条目甲相似
    writeFileSync(join(personal, 'b.md'), `- [会话|共享主题] 条目乙 -- ${BODY_A_SIM}\n`, 'utf-8')
    assert.deepEqual(store.updateDoc('experience/b.md'), { updated: true })
    const afterEdit = relRows(dir)
    const content = afterEdit.find((r) => r.from === 'experience/b.md#0' && r.to === 'experience/a.md#0')
    assert.equal(content?.why.kind, 'content', '改后的正文必须重算内容锚点（不能停在旧出边）')
    assert.ok(content.why.score >= SIM_THRESHOLD && content.why.score < DUP_COS)
    assert.ok(content.why.shared.length > 0, 'content 边必须带 shared')
    assert.ok(afterEdit.some((r) => r.from === 'experience/a.md#0' && r.to === 'experience/b.md#0'),
      '反向边也在（无向物化）')
    // 同 tag 边在内容变更后仍成立（tag 层不因正文变化而失效）
    assert.ok(afterEdit.some((r) => r.from === 'experience/b.md#0' && r.to === 'experience/a.md#1'
      && r.why.kind === 'tag'))
    assert.equal(manifestOf(dir).relLines, relLineCount(dir))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('增量：删除块后物化侧不再保留已消失的端点', async () => {
  const { dir, personal } = makeIncrementalFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const aPath = join(personal, 'a.md')
    writeFileSync(aPath,
      `- [会话|甲标签] 条目甲 -- ${BODY_A}\n- [会话|共享主题] 条目甲二 -- ${BODY_A2}\n`, 'utf-8')
    store.updateDoc('experience/a.md')
    assert.ok(relRows(dir).length >= 2, '先造出真实边（含指向 a#1 的两条）')

    // 删掉第二条：a#1 消失
    writeFileSync(aPath, `- [会话|甲标签] 条目甲 -- ${BODY_A}\n`, 'utf-8')
    assert.deepEqual(store.updateDoc('experience/a.md'), { updated: true })
    const rows = relRows(dir)
    assert.ok(!rows.some((r) => r.from === 'experience/a.md#1' || r.to === 'experience/a.md#1'),
      '已消失的端点不得留在物化文件里（读时校验是兜底，不是唯一防线）')
    assert.equal(manifestOf(dir).relLines, relLineCount(dir), '删除后指纹也要同步')
    const reload = createKnowledgeStore({ configDir: dir })
    reload.load()
    assert.equal(reload.stats().builtAt, store.stats().builtAt, '删除后也不得误判损坏')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('增量：只补同 tag 入边（content 入边延迟是既定取舍，不是漏洞）', async () => {
  const { dir, personal } = makeIncrementalFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    // 改 b.md 正文使其与 a.md 内容相似：此时 b 的出边（content→a）会被重算出来，
    // 但 a.md **未被改写**、其出边未重算 —— 反向的那条由镜像轮补上（物化无向的必然结果），
    // 而"a 主动发现 b"这类**新**内容关系仍要等 a 自己更新或全量重建。
    writeFileSync(join(personal, 'b.md'), `- [会话|共享主题] 条目乙 -- ${BODY_A_SIM}\n`, 'utf-8')
    store.updateDoc('experience/b.md')
    const rows = relRows(dir)
    assert.ok(rows.some((r) => r.from === 'experience/b.md#0' && r.to === 'experience/a.md#0'
      && r.why.kind === 'content'), '改文档的出边 content 锚点即时可见')
    // 反向边由镜像轮补上 —— 物化的不变量是"行集对反向封闭"（全量路径的镜像轮同一件事），
    // 否则 related(blockId) 会只看得到有向的一半，退化成"谁指向我"要看运气。
    assert.ok(rows.some((r) => r.from === 'experience/a.md#0' && r.to === 'experience/b.md#0'
      && r.why.kind === 'content'), '反向镜像边同时落盘')
    assert.equal(manifestOf(dir).relLines, relLineCount(dir))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
