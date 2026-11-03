// T4：SQLite 后端的**结构守卫** —— DDL 两条硬约束 + 缺省开关 + 迁移统计非零。
//
// 为什么这三条值得单独钉住（都是实测踩过的坑，不是理论风险）：
//  ① `gram` 列声明成 INTEGER：SQLite 的 numeric affinity 会把 `'000e3043'` 读成 `0e3043` = 0
//     ⇒ 主键大面积相撞（实测 `UNIQUE constraint failed`，28 组键撞在一起）。
//  ② 缺 `idx_blocks_doc`：`WHERE doc=?` 走全表扫，取候选块实测 696 ms → 33 ms（20 倍）。
//  ③ 后端开关**缺省必须是 jsonl**：sqlite 路径未通过全部验收前不得成为缺省
//     （spec §13：缺省切 sqlite 属"需人类批准"）。
//  ④ 迁移统计若是零，"迁移成功"就可能是空库（空集合 = fail-open）。
import { createKnowledgeStore } from '../kernel/knowledge.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrateToSqlite, backendOf, backendDecisionOf, dbPathOf, SQLITE_SCHEMA_VERSION } from '../kernel/knowledge-backend-sqlite.mjs'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-mig-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  writeFileSync(join(personal, 'a.md'), [
    '---', 'name: a', '---', '## 研发费用',
    '- [会话|高企口径] 研发费用归集口径 -- 五类费用',
  ].join('\n') + '\n', 'utf-8')
  return dir
}

test('后端开关缺省 jsonl（未验证前不得默认 sqlite）', () => {
  const dir = fixture()
  assert.equal(backendOf(dir), 'jsonl')
})

test('迁移产出库，且 gram 列是 TEXT、idx_blocks_doc 存在、meta 齐备', () => {
  const dir = fixture()
  const dbPath = dbPathOf(dir)
  const stat = migrateToSqlite({ configDir: dir, store: createKnowledgeStore({ configDir: dir }) })
  assert.ok(existsSync(dbPath))
  assert.ok(stat.docs >= 1 && stat.grams > 0, '迁移统计必须非零（空集合 = fail-open）')
  const db = new DatabaseSync(dbPath)
  const gram = db.prepare('PRAGMA table_info(inverted)').all().find((c) => c.name === 'gram')
  assert.equal(String(gram.type).toUpperCase(), 'TEXT', 'gram 必须是 TEXT（INTEGER 会把 000e3043 读成 0）')
  const idfGram = db.prepare('PRAGMA table_info(idf)').all().find((c) => c.name === 'gram')
  assert.equal(String(idfGram.type).toUpperCase(), 'TEXT', 'idf.gram 同样必须 TEXT')
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_blocks_doc'").get()
  assert.ok(idx, 'idx_blocks_doc 必须存在（否则取候选块全表扫）')
  const meta = new Map(db.prepare('SELECT k, v FROM meta').all().map((r) => [r.k, r.v]))
  assert.equal(Number(meta.get('schemaVersion')), SQLITE_SCHEMA_VERSION)
  assert.ok(Number(meta.get('nBlocks')) > 0, 'meta.nBlocks 必须写入（idf 的 N）')
  assert.ok(meta.get('builtAt'), 'meta.builtAt 必须写入')
  db.close()
})

test('★ 含 NUL（\\u0000）的块文本必须**无损**往返（TEXT 列会在 NUL 处截断）', () => {
  // 实测坑（2026-09-29）：`node:sqlite` 的 TEXT 路径把 `'abc\u0000def'` 读回来只有 `'abc'`
  // ——真实库里就有一篇会话转储的代码块含二进制内容（实测 633 字符被截到 33）。
  // 后果不是"少一个块"而轻：它让全库平均块长 `avgdl` 偏移，于是**每一个**检索分数都不再逐位相同
  // （差在第 5–6 位有效数字）。故这里钉住"写进去多少、读回来多少"。
  const dir = fixture()
  const NUL_TEXT = '```\noccurrences: 2\n== at 6569\nt?A\u0000b\u0000c\u0000d\n```'
  writeFileSync(join(dir, 'memory', 'personal', 'bin.md'), [
    '---', 'name: bin', '---', '## 二进制片段',
    NUL_TEXT,
  ].join('\n') + '\n', 'utf-8')
  const stat = migrateToSqlite({ configDir: dir, store: createKnowledgeStore({ configDir: dir }) })
  assert.ok(stat.blocks >= 2, 'fixture 至少要有两个块（fail-closed）')
  const db = new DatabaseSync(dbPathOf(dir))
  const rows = db.prepare('SELECT text FROM blocks').all()
  const hit = rows.map((r) => (typeof r.text === 'string' ? r.text : Buffer.from(r.text).toString('utf8')))
    .find((t) => t.includes('occurrences: 2'))
  db.close()
  assert.ok(hit, '含 NUL 的块必须落库（fail-closed）')
  assert.equal(hit, NUL_TEXT, `含 NUL 的块文本必须原样往返（得到 ${JSON.stringify(hit)}）`)
})

// ── `auto` 档（2026-10-26 增）：显式配 auto 才探测，缺省语义不变 ───────────────────────────
//
// 三条断言各自对应一个**真实失效模式**（不是为覆盖率凑数）：
//  ① 有健康库却不选 sqlite ⇒ auto 形同虚设（用户配了也没提速）；
//  ② 库坏了却仍选 sqlite ⇒ 检索直接抛/静默少结果（比慢更糟），必须 fail-closed 回 jsonl；
//  ③ 探测给"从没建过库"的用户凭空建出空 index.db ⇒ 每次启动多一次无谓开库，
//     且下次探测又判它不健康（自我制造噪声）。

test('auto：库健康 ⇒ 选 sqlite；库损坏 ⇒ 回退 jsonl（且缓存随 mtime 失效）', () => {
  const dir = fixture()
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ knowledgeIndexBackend: 'auto' }), 'utf-8')
  // ① 还没有库 ⇒ jsonl（不是 sqlite，也不是报错）
  assert.deepEqual(backendDecisionOf(dir), { configured: 'auto', effective: 'jsonl', why: 'auto:no-db' })
  migrateToSqlite({ configDir: dir, store: createKnowledgeStore({ configDir: dir }) })
  // ② 健康库 ⇒ sqlite
  assert.deepEqual(backendDecisionOf(dir), { configured: 'auto', effective: 'sqlite', why: 'auto:healthy' })
  // 缓存命中路径：同一 mtime/size 再问一次，结论必须一致（不能"缓存把健康读成损坏"）
  assert.equal(backendDecisionOf(dir).effective, 'sqlite')
  // ③ 库损坏（少一张必需表）⇒ 必须回退 jsonl，且**缓存必须随 mtime 失效**（否则损坏库被当成健康）
  const db = new DatabaseSync(dbPathOf(dir))
  db.exec('DROP TABLE blocks')
  db.close()
  const after = backendDecisionOf(dir)
  assert.equal(after.effective, 'jsonl', '损坏库必须 fail-closed 回退 jsonl')
  assert.equal(after.why, 'auto:unhealthy')
})

test('auto：绝不为"从没建过库"的配置目录凭空创建 index.db', () => {
  const dir = fixture()
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ knowledgeIndexBackend: 'auto' }), 'utf-8')
  assert.equal(backendDecisionOf(dir).effective, 'jsonl')
  assert.equal(existsSync(dbPathOf(dir)), false, '探测不得建空库（openIndex 会对不存在的路径建库）')
})

test('auto 不影响缺省语义：未配置 / 脏值仍落 jsonl', () => {
  const dir = fixture()
  assert.equal(backendOf(dir), 'jsonl', '无 config.json ⇒ 缺省 jsonl（棘轮不动）')
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ knowledgeIndexBackend: 'sqlite' }), 'utf-8')
  assert.equal(backendOf(dir), 'sqlite')
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ knowledgeIndexBackend: 'SQLITE ' }), 'utf-8')
  assert.equal(backendOf(dir), 'sqlite', '大小写/空白应容错')
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ knowledgeIndexBackend: 'sqlit' }), 'utf-8')
  assert.equal(backendOf(dir), 'jsonl', '拼错不得报错、也不得启用')
})
