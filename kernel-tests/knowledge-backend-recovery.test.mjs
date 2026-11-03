// T6：写路径（事务增量）+ 损坏恢复（fail-closed）。
//
// 三条断言各自的"为什么"：
//  ① 语义未变的重写 ⇒ 增量结果 == 全量重建：**只在 idf 不变的前提下**成立。idf 不重算是既有取舍
//     （`kernel/knowledge.mjs` 的 updateDoc 注释明文记载），而 postings 权重由 idf 算出
//     ⇒ "改内容后增量 == 全量"在数学上不可达（全量会用新 idf 重算**所有**文档的权重）。
//     本文件**保持**该取舍：不写一条做不到的断言，也不为了好看"顺手重算全库 idf"。
//  ② 改动必须真的生效：新增词可被检索到、命中来自被改文档（证明增量真的落库）。
//  ③ 残库（删表）/缺库 ⇒ 判损坏并**重建后再检索**，而不是返回空结果（fail-closed；
//     空集合是 fail-open，本仓明令判红）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createKnowledgeStore } from '../kernel/knowledge.mjs'
import { migrateToSqlite, dbPathOf } from '../kernel/knowledge-backend-sqlite.mjs'

const A_ORIGINAL = [
  '---', 'name: a', '---', '## 研发费用',
  '- [会话|口径] 研发费用归集 -- 五类',
].join('\n') + '\n'

function fx() {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-rec-'))
  const p = join(dir, 'memory', 'personal')
  mkdirSync(p, { recursive: true })
  writeFileSync(join(p, 'a.md'), A_ORIGINAL, 'utf-8')
  writeFileSync(join(p, 'b.md'), [
    '---', 'name: b', '---', '- [会话|口径] 高新收入 -- 不低于60%',
  ].join('\n') + '\n', 'utf-8')
  migrateToSqlite({ configDir: dir, store: createKnowledgeStore({ configDir: dir }) })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ knowledgeIndexBackend: 'sqlite' }), 'utf-8')
  return dir
}

test('updateDoc 在**语义未变**的重写后，结果与全量重建逐位相同（idf 未变 ⇒ 可比）', () => {
  const dir = fx()
  const s = createKnowledgeStore({ configDir: dir }); s.load({})
  assert.equal(s.getBackend(), 'sqlite', '必须真的跑在 sqlite 后台上（静默回落会让本断言变成空断言）')
  assert.equal(typeof s.updateDoc, 'function', 'updateDoc 必须存在（否则本测试无意义）')
  const before = s.search({ query: '研发费用 归集', topK: 5 }).items.map((i) => [i.blockId, i.score])
  assert.ok(before.length > 0, 'fixture 必须先有命中（空集合 = fail-open）')
  // ★ 关键：**逐字重写同一内容**（不带语义变化）⇒ idf 不变 ⇒ 与全量重建可比。
  //   为什么不用"改内容后比全量"：见本文件头注释第 ① 条（idf 漂移是**设计内**行为）。
  writeFileSync(join(dir, 'memory', 'personal', 'a.md'), A_ORIGINAL, 'utf-8')
  const r = s.updateDoc('experience/a.md')
  assert.equal(r.updated, true, `增量更新必须成功（reason=${r.reason}）`)
  const after = s.search({ query: '研发费用 归集', topK: 5 }).items.map((i) => [i.blockId, i.score])
  // ★ 这里刻意**不**用 `load({force:true})` 造第二个 store：那会走"从盘读回 jsonl 再重建库"
  //   的路径（本文件要测的是"事务增量写 == 全量重建"，不是"库的重建链"，后者由恢复用例覆盖）。
  //   全清后重建 = 现场重算一遍索引 → 与增量路径比对的语义最直接。
  const s2 = createKnowledgeStore({ configDir: dir })
  s2.load({ force: true })
  assert.equal(s2.getBackend(), 'sqlite')
  const full = s2.search({ query: '研发费用 归集', topK: 5 }).items.map((i) => [i.blockId, i.score])
  assert.ok(full.length > 0, '全量重建后必须有命中（空集合 = fail-open）')
  assert.deepEqual(after, full, '同语料同 idf 下，增量路径结果必须与全量重建逐位相同')
})

test('updateDoc 的改动必须真的生效（新词可检索到、命中来自被改文档，且**真的落库**）', () => {
  const dir = fx()
  const s = createKnowledgeStore({ configDir: dir }); s.load({})
  writeFileSync(join(dir, 'memory', 'personal', 'a.md'), [
    '---', 'name: a', '---', '## 研发费用',
    '- [会话|口径] 研发费用归集口径已修订 -- 五类加外聘研发人员劳务费',
  ].join('\n') + '\n', 'utf-8')
  const r = s.updateDoc('experience/a.md')
  assert.equal(r.updated, true, `reason=${r.reason}`)
  const hit = s.search({ query: '外聘研发人员劳务费', topK: 5 })
  assert.ok(hit.count > 0, '修订后新增的内容必须能被检索到（增量写真的落库了）')
  assert.ok(hit.items.some((i) => String(i.docId).endsWith('a.md')), '命中必须来自被修订的文档')
  // ★ 关键加固：**同进程内存命中**不足以证明"落库"（sqlite 后端下检索走库，但内存态也可能被同步）。
  //   故新建一个 store 实例（等价于新进程）再查一次 —— 它只可能从**库**里读到新内容。
  //   实测踩过同类假绿：仅查内存时，即使增量写整个没落库，断言照样全绿。
  const s2 = createKnowledgeStore({ configDir: dir })
  s2.load({})
  assert.equal(s2.getBackend(), 'sqlite')
  const again = s2.search({ query: '外聘研发人员劳务费', topK: 5 })
  assert.ok(again.count > 0, '新实例（新进程语义）也必须能搜到新词 ⇒ 增量写确实落库了')
  assert.ok(again.items.some((i) => String(i.docId).endsWith('a.md')), '新实例的命中同样必须来自被修订的文档')
  // 且新实例**不得**因"库还是旧的"而触发重建（那说明增量写没落库、只是靠重建掩盖）——
  // 用 builtAt 判据：增量写会刷新 meta.builtAt，重建会把它换成另一个新值。
  assert.equal(s2.stats().builtAt, s.stats().builtAt, '增量写后加载不得触发重建（builtAt 应保持增量写时写入的值）')
})

test('新文档增量插入同步 meta.docCount（loadMeta 的权威计数不落后）', () => {
  const dir = fx()
  const s = createKnowledgeStore({ configDir: dir }); s.load({})
  assert.equal(s.getBackend(), 'sqlite')
  const readCount = () => {
    const db = new DatabaseSync(dbPathOf(dir))
    const v = Number(db.prepare("SELECT v FROM meta WHERE k = 'docCount'").get().v)
    db.close()
    return v
  }
  const before = readCount()
  writeFileSync(join(dir, 'memory', 'personal', 'c.md'), [
    '---', 'name: c', '---', '- [会话|口径] 新文档增量插入 -- meta 计数同步',
  ].join('\n') + '\n', 'utf-8')
  const r = s.updateDoc('experience/c.md')
  assert.equal(r.updated, true)
  assert.equal(r.added, true)
  assert.equal(readCount(), before + 1, 'meta.docCount 必须随增量插入更新')
})

test('删掉 blocks 表 ⇒ 判损坏并重建（绝不放行成空结果）', () => {
  const dir = fx()
  const dbPath = dbPathOf(dir)
  const db = new DatabaseSync(dbPath); db.exec('DROP TABLE blocks'); db.close()
  const s = createKnowledgeStore({ configDir: dir }); s.load({})
  assert.equal(s.getBackend(), 'sqlite', '重建后必须回到 sqlite 后端（而不是永久降级成 jsonl）')
  assert.ok(s.search({ query: '研发费用', topK: 5 }).count > 0, '不得因残库退化成空结果')
})

test('库文件缺失 ⇒ 重建后再检索（空集合判红，不许 fail-open）', () => {
  const dir = fx()
  const dbPath = dbPathOf(dir)
  rmSync(dbPath); rmSync(dbPath + '-wal', { force: true }); rmSync(dbPath + '-shm', { force: true })
  const s = createKnowledgeStore({ configDir: dir }); s.load({})
  assert.equal(s.getBackend(), 'sqlite')
  assert.ok(s.search({ query: '研发费用', topK: 5 }).count > 0, '库缺失 ⇒ 重建后再检索')
})

// ── 超出计划稿的加固（实施时补；见汇报"偏离"一节）──
// 计划稿的三条断言全绿也可能什么都没验证：若内核**静默回落**成 jsonl，上述断言照样通过。
// 故每条都补 `getBackend()==='sqlite'`（已内联到上面），再加一条直接打 `isHealthy()` 的用例。
test('★ isHealthy 对"残库/缺表/版本不符"必须为 false（fail-closed 的判定点）', async () => {
  const { isHealthy, openIndex, SQLITE_SCHEMA_VERSION, readMeta } = await import('../kernel/knowledge-backend-sqlite.mjs')
  const dir = fx()
  const dbPath = dbPathOf(dir)
  {
    const h = openIndex(dbPath)
    assert.equal(isHealthy(h.db), true, '正常库必须判健康（否则"恒判损坏"也算 fail-closed，但会永远重建）')
    h.close()
  }
  {
    const db = new DatabaseSync(dbPath); db.exec('DROP TABLE idf'); db.close()
    const h = openIndex(dbPath)
    assert.equal(isHealthy(h.db), false, '缺必需表 ⇒ 必须判损坏')
    h.close()
  }
  {
    const db = new DatabaseSync(dbPath)
    // 版本不符：把 schemaVersion 改成别的值（模拟"旧结构被新代码读"）
    db.prepare('UPDATE meta SET v=? WHERE k=?').run(String(SQLITE_SCHEMA_VERSION + 1), 'schemaVersion')
    db.close()
    const h = openIndex(dbPath)
    assert.equal(Number(readMeta(h.db).schemaVersion), SQLITE_SCHEMA_VERSION + 1, '版本必须真被改掉（否则本断言空转）')
    assert.equal(isHealthy(h.db), false, 'schemaVersion 不符 ⇒ 必须判损坏')
    h.close()
  }
})
