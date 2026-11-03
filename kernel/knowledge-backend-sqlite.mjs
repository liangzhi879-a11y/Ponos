// kernel/knowledge-backend-sqlite.mjs —— 知识库索引的 SQLite 后端（存储层）
// ---------------------------------------------------------------------------
// **它是什么**：把 jsonl 派生索引（`docs`/`inverted`/`related`/`files`/`idf`）放进一个 SQLite
// 库里，让「按查询 gram 取 postings」变成主键直查（实测开库 + 取数 35 ms），而不是每次冷加载
// 读 26 MB 再全库重新分词（实测 1558→2176 ms，随语料增长）。
//
// **它不是什么**（三条边界，改代码前先读）：
//   ① **不实现打分**：候选生成与块级评分一律留在 `kernel/knowledge.mjs`（复用既有
//      `scoreBlock`/`scoreBlockBm25`/`toItem`/融合公式）——本模块只负责"取数"。任何在本模块里
//      写第二份评分的行为都会让"结果逐位不变"这条验收失效（spec §5.3 明令）。
//   ② **不改真源**：md 仍是唯一真源，本库是**派生物**（删掉 `knowledge/index.db` 毫发无损，
//      重建即可）。
//   ③ **不放任何上限**：知识库不做上限约束（2026-09-30 用户裁决）——写入与读取都不得有
//      "条数到了就丢"的路径（对应内核侧已删除的 `MAX_BLOCKS_PER_DOC` / `FILE_LIMIT_PER_SPACE`）。
//
// **架构依赖（有意为之的一处循环 import）**：本模块的 `migrateToSqlite()` 需要
// `createKnowledgeStore`（迁移的源是 jsonl 索引），而 `kernel/knowledge.mjs` 需要本模块的
// `backendOf`/`dbPathOf` 来选后端 ⇒ 两模块互相 import。这是**安全的循环**：两边都只在函数体
// 内使用对方（ESM 的函数声明在实例化阶段就已初始化，运行时调用不会命中 TDZ），且两模块的顶层
// 都不调用对方。切勿把任一方的用法提到模块顶层（那会变成真正的初始化顺序问题）。
//
// 数据版本：`SQLITE_SCHEMA_VERSION` 是**SQLite 库自己的代数**（写入 `meta.schemaVersion`），
// 与 jsonl 的 `INDEX_VERSION` 相互独立（spec D2：jsonl 格式未变 ⇒ INDEX_VERSION 保持 4）。
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { blockIndexText, countGrams, retrievalText } from '../shared/knowledge-core.mjs'
import { knowledgeRoot } from './knowledge-paths.mjs'

/**
 * `node:sqlite` 的**惰性**加载。
 *
 * **为什么用 `createRequire` 而不是 `import`**（这是本模块唯一一处"不按 ESM import 写"的地方）：
 *   · 后端类型检查域（`tsconfig.backend.json`）是**哈希锁定**的（`kit/lib/ts-rules.mjs` 用
 *     `domainHash` 钉住域定义本身），而本仓的 `@types/node` 是 v20 —— 其中**没有**
 *     `node:sqlite` 的声明文件 ⇒ `import { DatabaseSync } from 'node:sqlite'` 会报 TS2307，
 *     把错误数抬高（`ts-baseline.json` 是"只许降不许升"的棘轮，抬高它＝放松标准，禁止）。
 *     既是类型滞后（不是代码错），也不该靠 `@ts-expect-error` 吞掉（全仓零先例）。
 *     `require('node:sqlite')` 对内置模块合法，且返回 any ⇒ 不引入假类型。
 *   · 为什么**惰性**：`node:sqlite` 一旦加载就开始打 `ExperimentalWarning`（走 stderr）。
 *     本模块被 `kernel/knowledge.mjs` 静态 import（后端选择要用 `backendOf`），若在模块顶层
 *     加载，则**缺省的 jsonl 路径也会看到那条告警** —— 无关路径不该为未启用的能力付代价。
 *     惰性化后：只有真开 sqlite 后端时才加载（也就那时才出现告警，符合"用了实验特性就有提示"）。
 */
const require0 = createRequire(import.meta.url)
/** @type {any} */
let _sqliteMod = null
function sqliteMod() {
  if (!_sqliteMod) _sqliteMod = require0('node:sqlite')
  return _sqliteMod
}

/**
 * 与 `kernel/knowledge.mjs#indexTextOf` **同式**（该函数未导出；`shared/knowledge-core.mjs`
 * 才是它的权威来源，故这里只做一行接线）。
 *
 * ⚠️ 这是一处**有意的双写**：口径若漂移，迁移算出的块级 df 会与内核算 idf 用的 df 不同 ⇒
 * `idf` 表口径就错了（正是 spec §2.5 的陷阱）。防漂移靠**守卫**而不是靠注释：
 * `kernel-tests/knowledge-backend-parity.test.mjs` 逐 gram 比对两后端 idf，口径一旦漂移该测试立刻红。
 * 另一条路（把 `indexTextOf` 从知识内核导出）会改动内核的导出面，代价大于收益（本模块只用到这一行）。
 */
const indexTextOfSafe = (b) => blockIndexText({ kind: b.kind, text: retrievalText(b), entryTag: b.tag })

/**
 * SQLite 库结构代数。**它变了就必须重建库**（判定点唯一：`meta.schemaVersion`）。
 * 与 jsonl 的 `INDEX_VERSION` 无关（后者是 jsonl 结构代数，本次未变 ⇒ 保持 4，spec D2）。
 */
export const SQLITE_SCHEMA_VERSION = 1

/**
 * DDL（spec §5.2 逐字落地，含两条**实测踩坑**的硬约束）。
 *
 * ★ 约束一：`inverted.gram` / `idf.gram` 必须是 **TEXT**。`g` 是 `hashLine()` 的 8 位零填充
 *   十六进制串（如 `'000e3043'`）；若声明 INTEGER，SQLite 的 numeric affinity 会把它解析成
 *   `0e3043` = **0** ⇒ 主键大面积相撞（实测 `UNIQUE constraint failed`，28 组键撞在一起）。
 * ★ 约束二：必须有 `idx_blocks_doc`。没有它时 `WHERE doc=?` 走全表扫：实测取候选块
 *   **696 ms → 33 ms**（20 倍）。
 */
const DDL = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, size INT, mtime INT, hash TEXT);
CREATE TABLE IF NOT EXISTS docs (i INTEGER PRIMARY KEY, id TEXT UNIQUE, spaceId TEXT, rel TEXT,
  title TEXT, tags TEXT, hash TEXT, mtime INT, size INT, lines INT);
CREATE TABLE IF NOT EXISTS blocks (doc INT, n INT, kind TEXT, level INT, text TEXT, line INT,
  tag TEXT, heading TEXT, full TEXT);
CREATE INDEX IF NOT EXISTS idx_blocks_doc ON blocks(doc);
CREATE TABLE IF NOT EXISTS inverted (gram TEXT PRIMARY KEY, df INT, p TEXT);
CREATE TABLE IF NOT EXISTS idf (gram TEXT PRIMARY KEY, df INT, idf REAL);
CREATE TABLE IF NOT EXISTS related (from_id TEXT, to_id TEXT, why TEXT, sigFrom TEXT, sigTo TEXT);
CREATE INDEX IF NOT EXISTS idx_related_from ON related(from_id);
`

/** 必需表清单（`isHealthy` 用；缺任一 ⇒ 判损坏 ⇒ 重建，fail-closed）。 */
const REQUIRED_TABLES = ['meta', 'files', 'docs', 'blocks', 'inverted', 'idf', 'related']

/**
 * 库文件路径：`<configDir>/knowledge/index.db`。
 * 为什么不放 `.index/`（jsonl 索引所在的目录）：两者是**互斥的后端**，同目录共存会让
 * "删掉 `.index/` 重建 jsonl"这种既有运维动作意外留下一个可能被误读的 `.db`；
 * 而且 `walkMd` 跳过 `.` 开头的目录 —— 放 `.index/` 里反而更"干净"，但 `index.db` 独立在
 * `knowledge/` 下更好解释（它就是这一层的第二个可选产物，与 `spaces/`、`packs/` 平级）。
 */
export function dbPathOf(configDir) {
  return join(knowledgeRoot(configDir), 'index.db')
}

/**
 * 生效的后端：`<configDir>/config.json#knowledgeIndexBackend`（**缺省 `jsonl`**）。
 *
 * **为什么缺省是 jsonl 而不是 sqlite**（spec §13 棘轮：后端开关缺省切 sqlite 属"需人类批准"）：
 * sqlite 路径必须先在真机跑完 §8 全部验收（含 parity 逐位不变、损坏恢复、回退演练）才谈缺省；
 * 在那之前它只是一个**显式可选**的加速档。缺省值等于"新能力关闭"是本仓的一贯纪律
 * （缺省必须等于既有行为）。
 *
 * 判定与 `knowledgeScorer` / `knowledgeRelateMode` 同款落点（读 config.json）：
 * 配置集中在一个用户可见文件里，权威判定在内核，server 只透传。
 * 脏值（拼错/大小写/非字符串）一律落回 `jsonl`，**不报错** —— 配置写错不该让检索整个不可用。
 *
 * ★ 2026-10-26 增第三值 `auto`（**不是新缺省**，棘轮不动）：显式写 `auto` 才探测，判据是
 *   "`index.db` 存在且 `isHealthy`" ⇒ sqlite，否则回退 jsonl。价值是把"手工改配置 + 手工迁移"
 *   这一步收成一次配置：迁移过库 = 自动享受 6.1s→1.3s 的加载提速，库坏了/没迁移 = 静默回退旧路。
 *   缺省仍是 `jsonl`：把缺省切 sqlite 属"需人类批准"的棘轮（spec §13），本函数无权自行放宽。
 */
export function backendOf(configDir) {
  return backendDecisionOf(configDir).effective
}

/**
 * `auto` 探测结果的进程内缓存（键 = 库文件路径）。
 *
 * **为什么要缓存**：`auto` 的健康判定要真开库 + `PRAGMA quick_check`（38 MB 库实测数百毫秒）。
 * `backendOf` 在每次 `store.load()` 都会被调用（见 `kernel/knowledge.mjs` 的 load 注释：
 * "后端每次 load 重新判定"），而 load 在桥 / 内核子进程 / CLI 里都是高频动作
 * ⇒ 不缓存就等于**给每次检索加几百毫秒**，正好抵消 sqlite 后端带来的提速。
 * 失效条件：库文件的 `mtime`/`size` 变了（重建/迁移后立即重探）或超过 60 s（外部改库兜底）。
 */
const AUTO_PROBE_TTL_MS = 60_000
/** @type {Map<string, { backend: 'sqlite' | 'jsonl', why: string, atMs: number, mtimeMs: number, size: number }>} */
const autoProbeCache = new Map()

/**
 * `auto` 的探测：有**健康**的 `index.db` 就用它，否则回退 jsonl。
 *
 * 判据复用 `isHealthy`（fail-closed 三项：quick_check 全 ok / 必需表齐 / schemaVersion 相符）
 * —— 不另写一套"够用就行"的宽松判据：那会让半写的库被当成合法库读，静默少结果。
 *
 * ⚠️ 先 `statSync` 再看库：`openIndex()` 会 `mkdirSync` + `new DatabaseSync(path)`
 * ——对不存在的路径它会**建出一个空库**。若探测直接开库，则"从来没有库"的用户会被凭空
 * 生成一个 `index.db`，下次 auto 探测又判它不健康 ⇒ 每次启动都多一次无谓开库。
 */
function probeAuto(configDir) {
  const dbPath = dbPathOf(configDir)
  /** @type {{ mtimeMs: number, size: number }} */
  let st
  try { st = statSync(dbPath) } catch { return { backend: /** @type {const} */ ('jsonl'), why: 'auto:no-db' } }
  const now = Date.now()
  const hit = autoProbeCache.get(dbPath)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && now - hit.atMs < AUTO_PROBE_TTL_MS) {
    return { backend: hit.backend, why: hit.why }
  }
  /** @type {'sqlite' | 'jsonl'} */
  let backend = 'jsonl'
  let why = 'auto:unhealthy'
  try {
    const { db, close } = openIndex(dbPath)
    try {
      if (isHealthy(db)) { backend = 'sqlite'; why = 'auto:healthy' }
    } finally { close() }
  } catch { backend = 'jsonl'; why = 'auto:open-failed' }
  autoProbeCache.set(dbPath, { backend, why, atMs: now, mtimeMs: st.mtimeMs, size: st.size })
  return { backend, why }
}

/**
 * 后端判定的**全量结果**（配置值 + 生效值 + 理由），`backendOf` 只是它的 `.effective`。
 *
 * **为什么要暴露理由**：`auto` 会在库不健康时**静默**回退 jsonl（这是对的：检索不能因为
 * 一个派生物坏掉就不可用），但"我明明配了 auto 怎么还慢"必须可解释 —— 启动日志
 * （`server/bridge.mjs` 的 `knowledge index warmed in Xms (backend)`）与 CLI 排障都读这个 why。
 *
 * @param {string} [configDir]
 * @returns {{ configured: string | null, effective: 'sqlite' | 'jsonl', why: string }}
 */
export function backendDecisionOf(configDir) {
  if (!configDir) return { configured: null, effective: 'jsonl', why: 'no-config-dir' }
  /** @type {string} */
  let v = ''
  try {
    const raw = JSON.parse(readFileSync(join(String(configDir), 'config.json'), 'utf-8'))
    v = String(raw?.knowledgeIndexBackend ?? '').trim().toLowerCase()
  } catch { return { configured: null, effective: 'jsonl', why: 'config-missing' } } // 无 config.json / 损坏 ⇒ 缺省 jsonl
  if (v === 'sqlite') return { configured: 'sqlite', effective: 'sqlite', why: 'explicit' }
  if (v === 'auto') {
    const p = probeAuto(configDir)
    return { configured: 'auto', effective: p.backend, why: p.why }
  }
  // 脏值（拼错/大小写/非字符串）一律落回 jsonl，**不报错**——配置写错不该让检索整个不可用
  return { configured: v || null, effective: 'jsonl', why: v ? 'unknown-value' : 'default' }
}

/**
 * 开库：连接 + 三个 PRAGMA（spec §5.2）。
 * - `journal_mode=WAL`：桥 / 内核子进程 / CLI 可能并发读写（本仓常态）；
 * - `busy_timeout=5000`：短锁等待，超时由调用方降级（**不抛进会话**）；
 * - `synchronous=NORMAL`：派生数据，极端掉电后重建即可（换写入吞吐）。
 *
 * `mkdirSync(dirname)`：首次迁移时 `knowledge/` 可能还不存在 —— 不先建目录，`DatabaseSync`
 * 会直接抛（表现为"迁移失败"而不是"目录不存在"）。
 *
 * @param {string} dbPath
 * @returns {{ db: any, close: () => void }}
 */
export function openIndex(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const { DatabaseSync } = sqliteMod()
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA synchronous = NORMAL')
  return { db, close: () => { try { db.close() } catch { /* 已关 / 进程退出中：关闭失败不该掩盖主流程结果 */ } } }
}

/** 建表（幂等：全部 `IF NOT EXISTS`）。 */
export function ensureSchema(db) {
  db.exec(DDL)
}

/** `meta` 读成普通对象（键值都是字符串；数值由调用方自行 `Number()`）。 */
export function readMeta(db) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const r of db.prepare('SELECT k, v FROM meta').all()) out[dec(r.k)] = String(dec(r.v))
  return out
}

/**
 * 完整性判定（**fail-closed**：任何一项不满足 ⇒ `false` ⇒ 调用方重建）。
 *
 * 三项（spec §5.5）：
 *   ① `PRAGMA quick_check` 必须全 `ok`（能发现页级损坏，比 jsonl 的行数指纹强一档）；
 *   ② 必需表齐全（`DROP TABLE blocks` 这类残库必须被判损坏 —— 否则它解析成"合法但更少"）；
 *   ③ `meta.schemaVersion` 等于本模块的代数（版本不符 ⇒ 旧结构，不能按新结构读）；
 *   ④ `meta` 的关键键存在（`nBlocks`/`docCount`/`builtAt`）：只判 `schemaVersion` 会让"半写的
 *      meta"蒙混过关 —— 空库也一样健康（0 文档是合法状态，故判**存在**而非 `>0`）。
 *
 * 注意：本函数**不抛异常**（任何异常都折成 `false`）——它的调用方在冷启动路径上，
 * 抛错会让"检索整个不可用"，而它想表达的只是"这份库不能信，重建吧"。
 */
export function isHealthy(db) {
  try {
    const cc = db.prepare('PRAGMA quick_check').all()
    if (!cc.length) return false
    for (const row of cc) {
      const v = String(Object.values(row)[0] ?? '').toLowerCase()
      if (v !== 'ok') return false
    }
    const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => String(r.name)))
    for (const t of REQUIRED_TABLES) if (!have.has(t)) return false
    const meta = readMeta(db)
    if (Number(meta.schemaVersion) !== SQLITE_SCHEMA_VERSION) return false
    for (const k of ['nBlocks', 'docCount', 'builtAt', 'invLines']) {
      if (meta[k] === undefined) return false
    }
    return true
  } catch { return false }
}

/**
 * 全量写入（迁移与"重建"共用这一条路径：**只有一个写入口**，避免两套写法漂移）。
 *
 * 单事务（`BEGIN IMMEDIATE`）：要么整库落在盘上，要么一行都没有 —— 半写的 SQLite 库
 * 比半写的 jsonl 更危险（它会被当成合法库读，静默少结果）。
 *
 * @param {any} db
 * @param {{ docs?: any[], inverted?: any[], idf?: any[], related?: any[], files?: any[], meta?: Record<string, any> }} [payload]
 *   各数组的形状：
 *   - `docs`: `{ i, id, spaceId, rel, title, tags, hash, mtime, size, lines, blocks: [...] }`
 *     （`i` = docIdx，与 `inverted[].p[][0]` 的语义**唯一对应**；块行从 `blocks` 里拆出）
 *   - `inverted`: `{ g, df, p: [[docIdx, weight], ...] }`（`p` 落 TEXT/JSON）
 *   - `idf`: `{ gram, df, idf }`（★ `df` 必须是**块级** df，`idf` 必须用 `N = 块数` 算 —— 见 spec §2.5）
 *   - `related`: `{ from, to, why, sigFrom, sigTo }`（`why` 落 TEXT/JSON）
 *   - `files`: `{ id, size, mtime, hash }`
 *   - `meta`: 字符串化后写进 `meta` 表（`schemaVersion`/`nBlocks`/`builtAt`/…）
 * @returns {{ docs: number, blocks: number, inverted: number, idf: number, related: number, files: number }}
 */
export function writeAll(db, { docs = [], inverted = [], idf = [], related = [], files = [], meta = {} } = /** @type {any} */ ({})) {
  ensureSchema(db)
  const insDoc = db.prepare('INSERT OR REPLACE INTO docs (i, id, spaceId, rel, title, tags, hash, mtime, size, lines) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const insBlock = db.prepare('INSERT INTO blocks (doc, n, kind, level, text, line, tag, heading, full) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const insInv = db.prepare('INSERT OR REPLACE INTO inverted (gram, df, p) VALUES (?, ?, ?)')
  const insIdf = db.prepare('INSERT OR REPLACE INTO idf (gram, df, idf) VALUES (?, ?, ?)')
  const insRel = db.prepare('INSERT INTO related (from_id, to_id, why, sigFrom, sigTo) VALUES (?, ?, ?, ?, ?)')
  const insFile = db.prepare('INSERT OR REPLACE INTO files (id, size, mtime, hash) VALUES (?, ?, ?, ?)')
  const insMeta = db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)')
  let nBlocks = 0
  const counts = { docs: 0, blocks: 0, inverted: 0, idf: 0, related: 0, files: 0 }
  db.exec('BEGIN IMMEDIATE')
  try {
    // 全量写入口同时承担"重建"：先清空（顺序按外键语义，本项目未声明外键，但清空顺序仍按
    // doc → 依赖它的行，便于排查）
    for (const t of ['blocks', 'docs', 'inverted', 'idf', 'related', 'files', 'meta']) db.exec(`DELETE FROM ${t}`)
    for (const d of docs) {
      insDoc.run(d.i, enc(d.id), enc(d.spaceId), enc(d.rel), enc(d.title), enc(JSON.stringify(d.tags || [])), enc(d.hash) ?? null,
        d.mtime ?? null, d.size ?? null, d.lines ?? null)
      for (const b of d.blocks || []) {
        // 全部字符串列过 `enc`（见其注释：TEXT 在 NUL 处截断 ⇒ 含 NUL 的块走 BLOB）
        insBlock.run(d.i, b.n, enc(b.kind) ?? null, b.level ?? null, enc(b.text) ?? null, b.line ?? null,
          enc(b.tag) ?? null, enc(b.heading) ?? null, enc(b.full) ?? null)
        nBlocks += 1
        counts.blocks += 1
      }
      counts.docs += 1
    }
    for (const e of inverted) {
      insInv.run(enc(String(e.g)), Number(e.df) || 0, enc(JSON.stringify(e.p || [])))
      counts.inverted += 1
    }
    for (const e of idf) {
      insIdf.run(enc(String(e.gram)), Number(e.df) || 0, Number(e.idf))
      counts.idf += 1
    }
    for (const r of related) {
      insRel.run(enc(String(r.from)), enc(String(r.to)), enc(JSON.stringify(r.why ?? null)), enc(r.sigFrom) ?? null, enc(r.sigTo) ?? null)
      counts.related += 1
    }
    for (const f of files) insFile.run(enc(String(f.id)), f.size ?? null, f.mtime ?? null, enc(f.hash) ?? null)
    counts.files = files.length
    // meta 最后写：它是"这份库可用"的判据（`isHealthy` 读它）。放最后 + 单事务 ⇒
    // 不会出现"meta 说完整、表却半写"的窗口。
    for (const [k, v] of Object.entries({ ...meta, schemaVersion: SQLITE_SCHEMA_VERSION, nBlocks })) {
      insMeta.run(enc(String(k)), enc(String(v)))
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 回滚失败：保留原始异常更有信息量 */ }
    throw e
  }
  return counts
}

/** `related.jsonl` 的行形状（内核侧物化产物）→ 本模块的写入形状。 */
function relatedRowsOf(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    from: r.from, to: r.to, why: r.why, sigFrom: r.sigFrom, sigTo: r.sigTo,
  }))
}

/**
 * 一次性迁移：读**现有 jsonl 索引** → 建并写 SQLite 库（spec §5.4 重建链）。
 *
 * 为什么需要它：用户升级后第一次打开不该等一次全量重扫（实测该库全量重建 18162 ms）；
 * 迁移读的是**已经在盘上**的 jsonl 索引，只付"一次顺序读 + 一次批量写"（实测量级 1.4 s）。
 *
 * @param {{ configDir: string, dbPath?: string | null, store?: any }} opts
 *   `store`（可选）：调用方**已经 load 过**的 store（CLI 就是这种情况）——传进来可省掉一次
 *   冷加载（实测 2.1 s 量级）。不传则本函数自己造一个（测试与脚本的直接调用路径）。
 * @returns {{ docs: number, blocks: number, grams: number, related: number }}
 *   `grams` = 写入 `inverted` 表的行数（检索路要用的那份）。
 */
export function migrateToSqlite({ configDir, dbPath = null, store = null }) {
  const target = dbPath || dbPathOf(configDir)
  // ① 先把 jsonl 索引准备好（缺失/过期 ⇒ 内核内部会建/重建）：迁移的**源**是它，
  //    不在本函数里重写一套扫描逻辑（单一定义原则）。
  // `createKnowledgeStore` 的 JSDoc 未登记 `configDir`（callee 缺口，正式补全在知识内核的棘轮批次），
  // 故这里按仓内既有写法做**实参位**桥接（`kernel/knowledge-cli.mjs` 同款），不新增类型断言之外的语义。
  // 迁移源必须由调用方提供：本模块**不再** import 知识内核（那会造成静态环，见
  // kernel/knowledge-paths.mjs 头注释）。缺 store 是**编程错误**，故直接抛清晰错误而不是隐式自造。
  if (!store) throw new Error('migrateToSqlite 需要 store（迁移源）—— 请由调用方 createKnowledgeStore 后传入')
  const src = store
  // 确保源已加载：store 可能是调用方刚 new 出来的（未 load）。
  // 原写法是 ` if (!store) src.load({}) ` ——「没传 store 时自造并加载」；解环后 store **必传**，
  // 该条件恒假 ⇒ 传进来的空 store 会让迁移产出空库（实测：迁移统计为 0，被 fail-open 守卫判红）。
  // `load({})` 自带 staleness 判断 ⇒ 已新鲜的 store 上是廉价幂等操作。
  // 确保源数据就绪（**有 load 才调**）：
  //   · 调用方可能传"刚 new 出来、尚未 load"的 store —— 不 load 就是空索引，迁移产出**空库**
  //     （实测：迁移统计为 0，被 fail-open 守卫判红）；
  //   · 内核内部传的是**只暴露读取口的最小 shim**（`kernel/knowledge.mjs` 的注释说明：避免 store
  //     自引用自己），它**没有 load** ⇒ 无条件调用会抛 `src.load is not a function`，
  //     被上层 catch 成"sqlite 后端不可用，回落 jsonl"（实测踩到：parity 的 fail-closed 前提断言
  //     当场红，正是它救了我——否则会静默退化成"两边都是 jsonl"的假绿）。
  //   `load({})` 自带 staleness 判断 ⇒ 已新鲜时是廉价幂等。
  if (typeof src.load === 'function') src.load({})
  const docs = src.getDocs() || []
  const inverted = src.getInverted()
  const idfMap = src.getIdf()
  const stats = src.stats()

  // ② docs 行（含块）—— 与内核 `persist()` 落 jsonl 时**同一形状**（i 即 docIdx）
  const docRows = docs.map((d, i) => ({
    i, id: d.id, spaceId: d.spaceId, rel: d.rel, title: d.title, tags: d.tags || [],
    hash: d.hash ?? null, mtime: d.mtime ?? null, size: d.size ?? null, lines: d.lines ?? null,
    blocks: (d.blocks || []).map((b) => ({
      n: b.n, kind: b.kind, level: b.level, text: b.text, line: b.line, tag: b.tag, heading: b.heading, full: b.full,
    })),
  }))

  // ③ inverted：`inverted` Map 里**已经**是剪枝后的结果（buildIndex 按
  //    PRUNE_MIN_DOCS/PRUNE_DF_RATIO 剔过高频 gram）⇒ 原样落库即与 jsonl 路径候选集一致。
  //    ★ 若在这里"重新判一遍剪枝"，两后端候选集就会漂移（parity 会红，且原因极难查）。
  const invRows = []
  for (const e of inverted.values()) invRows.push({ g: e.g, df: e.df, p: e.p })

  // ④ idf 表：★ **必须**是"块级 df + N=块数"口径（spec §2.5）。
  //    盘上 `inverted.df` 是**文档级**（实测仅 43.8% 的 gram 两侧相等）——直接搬进 idf 表会让
  //    100% 的 gram idf 相对差 >5%、最大 110%，全库排序**静默改变**。故这里现场按块重算 df
  //    （与 kernel/knowledge.mjs 的 buildIndex/loadIndexFromDisk 的口径逐字一致），
  //    守卫见 kernel-tests/knowledge-idf-semantics.test.mjs（jsonl 侧）+ knowledge-backend-parity.test.mjs（sqlite 侧）。
  const blockDf = new Map()
  let nBlocks = 0
  for (const d of docs) {
    for (const b of d.blocks || []) {
      nBlocks += 1
      for (const g of countGrams(indexTextOfSafe(b)).keys()) blockDf.set(g, (blockDf.get(g) || 0) + 1)
    }
  }
  const idfRows = []
  for (const [gram, df] of blockDf) {
    // 只落"检索会用到的那份口径"：idf 值直接取内核算好的（同源，不重算一遍公式免得两处漂移）；
    // 内核 idf 里没有的 gram（理论上不会发生，防御性兜底）按同公式现算。
    const v = idfMap.get(gram)
    idfRows.push({
      gram, df,
      idf: typeof v === 'number' ? v : Math.log((nBlocks + 1) / (df + 1)) + 1,
    })
  }

  // ⑤ related：从 `.index/related.jsonl` 读物化行（内核内存里的 relEdges 未对外暴露；
  //    该文件就是它的落盘镜像，且 off 模式不产文件 ⇒ 空表）。**必须写**，否则"重启一次
  //    关联就没了"的旧病会在新后端重演（spec §5.3）。
  const related = relatedRowsOf(readRelatedFile(configDir))

  // ⑥ files：与 `persist()` 的 manifest.files 同源（逐文档 size/mtime/hash）
  const files = docs.map((d) => ({ id: d.id, size: d.size ?? null, mtime: d.mtime ?? null, hash: d.hash ?? null }))

  const meta = {
    indexVersion: stats.version,          // jsonl 侧的代数，**仅作记录**（判定只看 schemaVersion）
    builtAt: stats.builtAt || new Date().toISOString(),
    docCount: docRows.length,
    invLines: invRows.length,
    // 语料指纹（跨语料不可比的显式标记；与 scripts/bench-knowledge-index.mjs 同式）
    digest: createHash('sha1')
      .update(`${docRows.length}|${nBlocks}|${invRows.length}`).digest('hex').slice(0, 12),
    backend: 'sqlite',
  }

  const { db, close } = openIndex(target)
  try {
    writeAll(db, { docs: docRows, inverted: invRows, idf: idfRows, related, files, meta })
  } finally {
    close()
  }
  return { docs: docRows.length, blocks: nBlocks, grams: invRows.length, related: related.length }
}

/** 读 `.index/related.jsonl`（缺失/损坏 ⇒ 空数组：关联是可选派生层，缺它不该让迁移失败）。 */
function readRelatedFile(configDir) {
  const p = join(knowledgeRoot(configDir), '.index', 'related.jsonl')
  if (!existsSync(p)) return []
  try {
    const raw = readFileSync(p, 'utf-8')
    return raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  } catch { return [] }
}

// ── 读路径（T5）：按需取数 ─────────────────────────────────────────────────
// 设计（为什么是这几个函数、为什么这么切）：
//   · **postings 按查询取**（`fetchPostings`/`queryPostings`）：这是本次升级的主要收益来源 ——
//     旧路径每次冷加载都要读 15.6 MB `inverted.jsonl` 并解析 14 万行 JSON（实测 371 ms），
//     而一次检索其实只用到几个查询 gram 的 postings（实测 4 个 gram < 1 ms）。
//   · **docs/blocks/idf 仍全量物化**（`loadDocs`+`fetchBlocks`+`loadIdf`）：它们是**打分与过滤**
//     的输入（块级重排要遍历候选文档的块；词法过滤要遍历文档元信息；`legacy` 打分器还要用 idf
//     向量化**任意**块文本）。在这条路径上"按需"化需要重写 `readView`/关联读时校验/枚举检索等
//     多处方可保持"结果逐位不变"，属**阶段 2**（spec §14）的范围，不在本次一次落地的范围内。
//     诚实记账：这部分实测 docs 2 ms + blocks 124 ms + idf 199 ms（21670 块的真实库）。
//   · **不在这里写任何打分**：本模块只把数据搬进内存，评分/融合/截断一律留在
//     `kernel/knowledge.mjs`（spec §5.3 的关键约束）。

/** SQLite 变量个数上限保护（默认 32766，但不同构建可能更小）——批量查询一律分块。 */
const BIND_CHUNK = 400

/**
 * 写库前的字符串编码（**无损**，2026-09-29 实测踩坑后补）。
 *
 * **为什么需要**：`node:sqlite` 的 **TEXT** 路径在 **NUL（`\u0000`）处截断** —— 实测把
 * `'abc\u0000def\u0000ghi'` 写进 TEXT 列读回来只有 `'abc'`（3/11 字符）。
 * 这不是理论风险：真实库里就有一篇会话转储的代码块含二进制内容（实测
 * `session-memory/会话蒸馏/2026-09-11-yfworking-17891101.md#151` 的 text 从 633 字符被截到 33），
 * 后果是**全库分数的平均块长 `avgdl` 偏移**（246.2898 → 246.2621）⇒ 两后端**每一个**分数都不再相同
 * （差在第 5–6 位有效数字 —— 最容易被"看起来没问题"放过的形态）。
 * 既然本库的硬指标是"结果逐位不变"、且"知识库不做上限/不丢数据"是用户明令，TEXT 截断不可接受。
 *
 * **做法**：含 NUL 的字符串走 **BLOB**（`Buffer`）—— 实测 BLOB 原样往返（11/11 字符）。
 * 不含 NUL 的字符串仍写 TEXT（可在 SQL 里直接读、便于人排查；实测 `\r\n`/`\u0001`/emoji 都无损）。
 * 故这些列的存储类型是**混合**的（TEXT 或 BLOB）—— 读取一律过 `dec()`，语义由它保证。
 */
function enc(v) {
  if (typeof v === 'string' && v.includes('\u0000')) return Buffer.from(v, 'utf8')
  return v
}

/**
 * 读库后的字符串解码：`string`（TEXT）| `Uint8Array`（BLOB，含 `Buffer`）| null。
 * 与 `enc` 成对；**所有**读取路径都必须过它，否则含 NUL 的块会以 `Uint8Array` 形态漏进索引
 * （表现为 `.length` 是字节数、`retrievalText` 产出乱码 —— 比截断更难查）。
 */
function dec(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('utf8')
  return String(v)
}

/** 把数组切成每块 ≤ `n` 个元素（保持顺序）。 */
function chunked(arr, n = BIND_CHUNK) {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

/**
 * 按 gram hash 批量取 postings（**原始形状**，与 jsonl 路径内存里的 `inverted` 逐字段同形：
 * `{ g, df, p: [[docIdx, weight], ...] }` —— 同形是为了让"候选累加"能用**同一份循环**，
 * 浮点累加顺序一致 ⇒ 分数逐位相同）。
 * @param {any} db @param {string[]} gramHashes
 * @returns {Map<string, { g: string, df: number, p: Array<[number, number]> }>}
 */
export function fetchPostings(db, gramHashes) {
  const out = new Map()
  const hashes = [...new Set((gramHashes || []).map((h) => String(h)).filter(Boolean))]
  for (const part of chunked(hashes)) {
    const ph = part.map(() => '?').join(',')
    for (const r of db.prepare(`SELECT gram, df, p FROM inverted WHERE gram IN (${ph})`).all(...part)) {
      out.set(dec(r.gram), { g: dec(r.gram), df: Number(r.df), p: JSON.parse(dec(r.p)) })
    }
  }
  return out
}

/**
 * 查询 gram → 候选 docIdx（spec §5.3 的"按查询 gram 取 postings → 取候选块"第一步）。
 *
 * @param {any} db
 * @param {string[]} gramHashes 查询 gram 的 hash 串
 * @param {Map<string, number> | null} [qWeights] 查询向量的 `hash → wq`
 *   ⚠️ **必须是 Map**（调用方用 `new Map(vectorizeText(...))` 折算：`vectorizeText` 返回的是
 *   `[[hash, w]]` 数组，直接把它当 Map 用会静默得到下标键、恒 0 命中 —— 实测踩过）。
 *   给了才累加权重。
 * @returns {Map<number, { df: number, score: number }>}
 *   `score` = Σ(wq × 该 gram 在这个文档里的权重)，**累加顺序与 jsonl 路径逐字一致**
 *   （外层按 `qWeights` 迭代序、内层按 postings 序）⇒ 候选排序不会漂移；
 *   `df` = 该候选**命中的查询 gram 数**（不是语料的文档频率 —— 那个由 `fetchPostings` 的
 *   `df` 给出；这里的 `df` 表达的是"这条候选有几路证据支持"，与检索深度旋钮相关）。
 */
export function queryPostings(db, gramHashes, qWeights = null) {
  const out = new Map()
  const order = qWeights ? [...qWeights.keys()] : [...new Set((gramHashes || []).map(String))]
  const postings = fetchPostings(db, order)
  for (const h of order) {
    const e = postings.get(String(h))
    if (!e) continue
    const wq = qWeights ? (Number(qWeights.get(h)) || 0) : 1
    for (const [di, wd] of e.p) {
      const cur = out.get(di) || { df: 0, score: 0 }
      cur.df += 1
      cur.score += wq * wd
      out.set(di, cur)
    }
  }
  return out
}

/**
 * 读全部文档**元信息**（不含块；`ORDER BY i` = docIdx 定义，postings 的下标语义依赖它）。
 * @param {any} db
 * @returns {Array<{ i: number, id: string, spaceId: string, rel: string, title: string, tags: string[], hash: any, mtime: any, size: any, lines: any }>}
 */
export function loadDocs(db) {
  return db.prepare('SELECT i, id, spaceId, rel, title, tags, hash, mtime, size, lines FROM docs ORDER BY i')
    .all()
    .map((r) => ({
      i: Number(r.i), id: dec(r.id), spaceId: dec(r.spaceId), rel: dec(r.rel),
      title: dec(r.title) ?? '', tags: parseTags(r.tags),
      hash: r.hash ?? null, mtime: r.mtime ?? null, size: r.size ?? null, lines: r.lines ?? null,
    }))
}

/** `tags` 列存 JSON 数组（与 jsonl 路径的 `doc.tags` 同形）；坏值一律当空数组（不让一行坏数据废掉整库）。 */
function parseTags(v) {
  if (Array.isArray(v)) return v
  try {
    const a = JSON.parse(dec(v) ?? '[]')
    return Array.isArray(a) ? a : []
  } catch { return [] }
}

/**
 * 按 docIdx 批量取"文档 + 块"（spec 的"取候选块 → 复用现有打分函数"那一步）。
 *
 * 为什么按 `docIdx`（而不是 docId）：postings 里存的就是 docIdx，用 id 取会多一次映射，
 * 而映射一旦不守恒（比如某处重排过 docs）就会静默取错文档 —— 下标口径只认一处最稳。
 *
 * @param {any} db
 * @param {number[]} docIdxs
 * @returns {Array<{ docIdx: number, doc: any, blocks: any[] }>} 按 docIdx 升序
 */
export function fetchBlocks(db, docIdxs) {
  const out = []
  const idxs = [...new Set((docIdxs || []).map((i) => Number(i)).filter((i) => Number.isFinite(i)))]
  for (const part of chunked(idxs)) {
    const ph = part.map(() => '?').join(',')
    const blocks = db.prepare(`SELECT doc, n, kind, level, text, line, tag, heading, full FROM blocks WHERE doc IN (${ph}) ORDER BY doc, n`).all(...part)
    const byDoc = new Map()
    for (const b of blocks) {
      const k = Number(b.doc)
      const arr = byDoc.get(k)
      const row = {
        n: Number(b.n), kind: dec(b.kind), level: b.level ?? null, text: dec(b.text) ?? '',
        line: b.line ?? null, tag: dec(b.tag), heading: dec(b.heading), full: dec(b.full),
      }
      if (arr) arr.push(row)
      else byDoc.set(k, [row])
    }
    for (const r of db.prepare(`SELECT i, id, spaceId, rel, title, tags, hash, mtime, size, lines FROM docs WHERE i IN (${ph}) ORDER BY i`).all(...part)) {
      const docIdx = Number(r.i)
      out.push({
        docIdx,
        doc: {
          i: docIdx, id: dec(r.id), spaceId: dec(r.spaceId), rel: dec(r.rel),
          title: dec(r.title) ?? '', tags: parseTags(r.tags),
          hash: r.hash ?? null, mtime: r.mtime ?? null, size: r.size ?? null, lines: r.lines ?? null,
        },
        blocks: byDoc.get(docIdx) || [],
      })
    }
  }
  return out.sort((a, b) => a.docIdx - b.docIdx)
}

/**
 * 读 idf 表 → `gram → idf`（★ 打分要用的那份；口径是**块级 df + N=块数**，spec §2.5）。
 * 与 jsonl 路径的 `buildIdf` 产物**逐 gram 一致**（守卫：knowledge-backend-parity.test.mjs）。
 * @param {any} db @returns {Map<string, number>}
 */
export function loadIdf(db) {
  const m = new Map()
  for (const r of db.prepare('SELECT gram, idf FROM idf').all()) m.set(dec(r.gram), Number(r.idf))
  return m
}

/** 读 `files` 表 → `{ id: { size, mtime, hash } }`（`indexStale()` 的判据，与 manifest.files 同形）。 */
export function loadFiles(db) {
  /** @type {Record<string, { size: any, mtime: any, hash: any }>} */
  const out = {}
  for (const r of db.prepare('SELECT id, size, mtime, hash FROM files').all()) {
    out[dec(r.id)] = { size: r.size ?? null, mtime: r.mtime ?? null, hash: dec(r.hash) }
  }
  return out
}

/**
 * 读**全部**倒排行 → `Map<gramHash, { g, df, p }>`（与 jsonl 路径内存里的 `inverted` 同形）。
 *
 * ⚠️ **不要放进检索热路径**：这份全量读（实测 145,955 行 ≈ 0.4–0.6 s + 全部 `p` 的 JSON 解析）
 * 正是本次升级要省掉的成本。它存在的唯一理由是**既有读取口 `store.getInverted()` 的语义**
 * ——消费方（`scripts/eval-retrieval.mjs` 的金标集构造、`kernel-tests/knowledge.test.mjs`
 * 的不变量断言）需要"能看到整张倒排表"，而 sqlite 后端在热路径上刻意不倒排物化。
 * 故 `getInverted()` 用**惰性**方式调它：不用到就不付，用到才付一次（并缓存到内存）。
 *
 * @param {any} db @returns {Map<string, { g: string, df: number, p: Array<[number, number]> }>}
 */
export function loadInverted(db) {
  const out = new Map()
  for (const r of db.prepare('SELECT gram, df, p FROM inverted').all()) {
    out.set(dec(r.gram), { g: dec(r.gram), df: Number(r.df), p: JSON.parse(dec(r.p)) })
  }
  return out
}

/**
 * **事务增量写**：替换单个文档的行、块与其 postings（spec §5.3 的 `updateDoc` 路径）。
 *
 * ## 为什么"删该 doc 的 postings"不需要全表扫描（这是本函数的关键设计）
 * `inverted.p` 是 **JSON 数组**（`[[docIdx, w], ...]`），看起来要更新它就必须先知道"哪些 gram
 * 含这个 doc" —— 朴素做法是全表扫 + 逐行 `JSON.parse`，实测 **449 ms**（145,955 行，真实库），
 * 直接毁掉"单文档增量 <100 ms"的目标。
 * 但那个信息**根本不用查**：某个 doc 的 postings 就是"用**它自己的块**算出来的那批 gram"，
 * 而旧块正是在调用方内存里（`docs[docIdx].blocks`，替换前的值）⇒ 现场重算旧 gram 集合即可
 * （O(该文档的块数)），进而只读改那几行 `inverted`（实测 9788 行 ≈ 20–40 ms）。
 * ⚠️ 这条推理成立的前提是"postings 与该文档的块同源"—— 全量构建、迁移、本函数都满足；
 * 若将来有人让 postings 与块**不同源**（例如另写一套分词），这里会静默漏改旧 gram。
 * 守卫：`kernel-tests/knowledge-backend-recovery.test.mjs` 的"改动生效 + 与全量重建逐位相同"
 * 两条用例（清空后重建会重新算出正确的 postings，两者对拍即可发现残留）。
 *
 * ## `i` 必须保持不变
 * postings 里存的是 **docIdx**（下标），重排 `docs` 会让全部 postings 失效 ⇒ 只替换该行内容，
 * 不动其它文档，也不重编号（与 jsonl 路径 `updateDoc` 同一纪律）。
 *
 * @param {any} db
 * @param {{ docIdx: number, doc: any, blocks: any[], invertedRows: Array<{ g: string, w: number }>,
 *   oldGrams: string[], file?: { size: any, mtime: any, hash: any } | null, builtAt?: string | null,
 *   related?: any[] | null, nBlocksDelta?: number, docCountDelta?: number }} [payload]
 *   `oldGrams` = 该文档**旧**块算出的 gram hash 集合（调用方给，见上方 why）。
 *   `related` 非 null 时**整体替换** `related` 表（行数只有数千，实测 <10 ms；按 doc 过滤反而要
 *   解析 `why` JSON 才能判归属，得不偿失）。
 *   `docCountDelta` 仅新文档插入时传 1（updateDoc 的 `added` 路径）：`meta.docCount` 是
 *   `stats()`/`loadMeta()` 的直接数据源，不维护会出现"插入后统计少一篇"的静默不一致。
 * @returns {{ blocks: number, grams: number, deletedGrams: number }}
 */
export function upsertDocInTx(db, {
  docIdx, doc, blocks = [], invertedRows = [], oldGrams = [], file = null,
  builtAt = null, related = null, nBlocksDelta = 0, docCountDelta = 0,
} = /** @type {any} */ ({})) {
  const selInv = db.prepare('SELECT p FROM inverted WHERE gram = ?')
  const updInv = db.prepare('UPDATE inverted SET p = ?, df = ? WHERE gram = ?')
  const delInv = db.prepare('DELETE FROM inverted WHERE gram = ?')
  let deleted = 0
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('DELETE FROM blocks WHERE doc = ?').run(docIdx)
    const insBlock = db.prepare('INSERT INTO blocks (doc, n, kind, level, text, line, tag, heading, full) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (const b of blocks) {
      insBlock.run(docIdx, b.n, enc(b.kind) ?? null, b.level ?? null, enc(b.text) ?? null, b.line ?? null,
        enc(b.tag) ?? null, enc(b.heading) ?? null, enc(b.full) ?? null)
    }
    db.prepare('INSERT OR REPLACE INTO docs (i, id, spaceId, rel, title, tags, hash, mtime, size, lines) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(docIdx, enc(doc.id), enc(doc.spaceId), enc(doc.rel), enc(doc.title), enc(JSON.stringify(doc.tags || [])),
        enc(doc.hash) ?? null, doc.mtime ?? null, doc.size ?? null, doc.lines ?? null)
    // ①+② 摘旧 + 插新：**按 gram 合并成一次读-改-写**（每个 gram 只碰一次）。
    //   为什么必须合并（实测踩过）：分成两轮时，一个"新旧都在用"的 gram 会被读改写两遍
    //   （`p` 是 JSON ⇒ 每遍一次 `JSON.parse` + `JSON.stringify`），实测该写法让 updateDoc
    //   在 sqlite 后端**比 jsonl 还慢 1.8×**（1787 vs 751 ms，relateMode=off 对照）——
    //   即"换个更快的存储"反而拖慢了写路径。
    //   合并后：`oldGrams ∩ newGrams` 只付一次，且只在**确有变化**时写回（幂等重写不写盘）。
    /** @type {Map<string, number>} gram → 该 gram 的新权重（同一 gram 取最后一次，与 jsonl 路径一致） */
    const newByGram = new Map()
    for (const e of invertedRows) newByGram.set(String(e.g), Number(e.w))
    const allGrams = new Set([...oldGrams.map(String), ...newByGram.keys()])
    for (const gram of allGrams) {
      const row = selInv.get(enc(gram))
      const cur = row ? JSON.parse(dec(row.p) ?? '[]') : []
      const p = cur.filter(([di]) => Number(di) !== docIdx)
      const removed = p.length !== cur.length
      const w = newByGram.get(gram)
      if (w !== undefined) p.push([docIdx, w])
      if (!p.length) {
        if (cur.length) { delInv.run(enc(gram)); deleted += 1 }
        continue
      }
      // 未变化就不写回（幂等 updateDoc 不产生写盘；否则每次"重写同一内容"都会重写该文档的
      // 全部 gram 行，实测这是写路径的主要成本）。
      if (!removed && w === undefined) continue
      // postings 保持 docIdx 升序（与全量构建、检索候选累加的顺序假设一致）。
      // 只在需要时排序：新插入项通常是下标最大的那批之一，`sort` 对已近乎有序的数组很快。
      p.sort((a, b) => Number(a[0]) - Number(b[0]))
      updInv.run(enc(JSON.stringify(p)), new Set(p.map(([di]) => Number(di))).size, enc(gram))
    }
    // ③ staleness 判据与留痕
    if (file) {
      db.prepare('INSERT OR REPLACE INTO files (id, size, mtime, hash) VALUES (?, ?, ?, ?)')
        .run(enc(String(doc.id)), file.size ?? null, file.mtime ?? null, enc(file.hash) ?? null)
    }
    if (related !== null) {
      db.prepare('DELETE FROM related').run()
      const insRel = db.prepare('INSERT INTO related (from_id, to_id, why, sigFrom, sigTo) VALUES (?, ?, ?, ?, ?)')
      for (const r of related) {
        insRel.run(enc(String(r.from)), enc(String(r.to)), enc(JSON.stringify(r.why ?? null)),
          enc(r.sigFrom) ?? null, enc(r.sigTo) ?? null)
      }
    }
    const insMeta = db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)')
    if (builtAt) insMeta.run('builtAt', enc(String(builtAt)))
    if (nBlocksDelta) {
      const cur = Number(readMeta(db).nBlocks) || 0
      insMeta.run('nBlocks', String(cur + nBlocksDelta))
    }
    if (docCountDelta) {
      const cur = Number(readMeta(db).docCount) || 0
      insMeta.run('docCount', String(cur + docCountDelta))
    }
    insMeta.run('invLines', String(Number(db.prepare('SELECT COUNT(*) c FROM inverted').get().c) || 0))
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 回滚失败：保留原始异常更有信息量 */ }
    throw e
  }
  return { blocks: blocks.length, grams: invertedRows.length, deletedGrams: deleted }
}
