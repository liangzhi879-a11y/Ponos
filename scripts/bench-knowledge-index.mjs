// scripts/bench-knowledge-index.mjs —— 知识库索引性能仪表（实施计划 T1）
// ---------------------------------------------------------------------------
// **为什么需要它**（spec §11 四问审计结论：问 4 是本条线最大的系统性欠账）：
// 本仓有排序质量量尺（`scripts/eval-retrieval.mjs`），却**没有任何索引性能量与基线** ——
// 于是"索引存储升级"既无法证明有效、也无法发现退化（做完只知道"测试还是绿的"）。
// 本脚本补的就是这一维：**可复现地量出冷加载 / 检索 / 单文档增量更新**三项耗时，并附
// **语料指纹**（跨语料不可比的显式标记）。
//
// 三条设计纪律（照 spec / 计划逐条落地，别自行简化）：
//   ① **缺省不碰真实库**：`configDir = null` 时用 `mkdtempSync` 造隔离 fixture（3+ 篇文档、
//      ≥50 块、含 heading/entry/table 三类），只在该临时根下建索引 —— 用户库一个字节不动；
//   ② **取不到就报 null，不造数字**：`updateDoc` 仅在"确有该方法 + 库里确有可读文档"时测量
//      （没有 docId 却硬编一个 0/1 ms，是"假仪表"，比没有仪表更糟）；
//   ③ **只报不拦**：脚本不设任何性能阈值、退出码恒 0（性能与机器相关，硬阈值必然误报，
//      见 spec §10 Q5 的裁决 —— 这里是"黄灯"仪表，不是门禁）。
//
// 用法：
//   node scripts/bench-knowledge-index.mjs                                  # 隔离 fixture
//   node scripts/bench-knowledge-index.mjs --config-dir <dir> --iterations 3
//   node scripts/bench-knowledge-index.mjs --out .ponos/process/x.json
// ⚠️ 带 `--config-dir` 时会在**那个库**上跑 `updateDoc`（同内容重写 ⇒ 是库的正常写路径，
//    不改任何 .md）。测真实库前请确认它在跑完前不会被别处删除。
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createKnowledgeStore, knowledgeRoot } from '../kernel/knowledge.mjs'
import { backendOf } from '../kernel/knowledge-backend-sqlite.mjs'

/**
 * 固定 query 集（≥5 条、中英混合）：**必须固定** —— 换查询集等于换量尺，
 * 两次运行的数字就不可比（基线对账的前提）。故意含一条纯英文/编号词（`R&D 立项`）
 * 与一条表头词，让"倒排候选"/"关键词路"两条分支都被走到。
 */
const QUERIES = [
  '研发费用 归集',
  '高新收入 占比',
  '知识产权 一类',
  '立项报告',
  '辅助账 台账',
  'R&D project',
]

/** 中位数（偶数个取中间两个的均值）。空数组返回 0 —— 调用方按"样本数"自行判断可信度。 */
function median(xs) {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * 隔离 fixture：`<root>/memory/personal/*.md` 共 4 篇 / 61 块（4 heading + 56 entry + 1 table）。
 * 为什么是"4 篇 + 每篇一组条目"而不是 1 篇长文档：单篇里的块共用一个 docIdx，倒排候选
 * 只数得到 1 个文档 —— 那样量不到"候选文档数"这一维（本仓的大库瓶颈正是候选×块）。
 */
export function makeBenchFixture() {
  const root = mkdtempSync(join(tmpdir(), 'yfw-bench-'))
  const personal = join(root, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  const groups = [
    {
      name: 'a-研发费用.md', title: '研发费用归集',
      heading: '研发费用归集口径',
      lines: (i) => `- [会话|高企口径] 研发费用归集口径第${i}条 -- 人员人工、直接投入、折旧费用、无形资产摊销、其他费用五类`,
    },
    {
      name: 'b-高新收入.md', title: '高新收入占比',
      heading: '高新收入占比口径',
      lines: (i) => `- [会话|高企口径] 高新收入占比第${i}条 -- 近一年高新技术产品收入占同期总收入比例不低于60%`,
    },
    {
      name: 'c-知识产权.md', title: '知识产权评分',
      heading: '知识产权口径',
      lines: (i) => `- [会话|知识产权] 知识产权第${i}条 -- 一类知识产权按1件计，二类按数量折算，不含商标`,
    },
    {
      name: 'd-立项与辅助账.md', title: '立项报告与辅助账',
      heading: '立项报告与研发辅助账',
      lines: (i) => `- [会话|研发管理] 立项报告与辅助账第${i}条 -- 研发项目立项报告须含目标、周期、预算、参与人员；辅助账按项目辅助核算`,
    },
  ]
  for (const g of groups) {
    const body = [
      '---', `name: ${g.title}`, '---', `## ${g.heading}`,
      ...Array.from({ length: 14 }, (_, i) => g.lines(i + 1)),
    ]
    writeFileSync(join(personal, g.name), body.join('\n') + '\n', 'utf-8')
  }
  // 一个表格块（第三类块形状：table）—— 块类型覆盖是"量到三类块"的前提
  writeFileSync(join(personal, 'e-汇总表.md'), [
    '---', 'name: 费用汇总表', '---', '## 研发费用汇总（单位：万元）',
    '| 项目 | 金额 |', '| --- | --- |', '| 人员人工 | 100 |', '| 直接投入 | 60 |',
    '- [会话|高企口径] 汇总表说明 -- 上表按辅助账口径汇总，与立项报告预算逐项对应',
  ].join('\n') + '\n', 'utf-8')
  return root
}

/**
 * 生效的后端开关（`<configDir>/config.json#knowledgeIndexBackend`，**缺省 `jsonl`**）。
 *
 * 口径**唯一真源** = `kernel/knowledge-backend-sqlite.mjs#backendOf` ⇒ 这里**直接引用**它，
 * 不再留副本（2026-10-26 补齐：副本在 `auto` 档落地后会让 bench 把"auto"误报成 jsonl，
 * 于是基准测的根本不是用户实际走的路径 —— 这类漂移靠注释挡不住，只能靠不写副本）。
 */
const backendOfLocal = backendOf

/** 索引是否已在盘上（jsonl 的 manifest.json / sqlite 的 index.db 任一存在即可）。 */
function hasDiskIndex(root) {
  return existsSync(join(knowledgeRoot(root), '.index', 'manifest.json'))
    || existsSync(join(knowledgeRoot(root), 'index.db'))
}

/**
 * 跑一次仪表。
 * @param {{ configDir?: string | null, iterations?: number }} [opts]
 *   `configDir = null` ⇒ 造隔离 fixture（**不碰真实库**）；给了则测该库（以只读为主，
 *   唯一写路径是 `updateDoc` 的同内容重写）。
 * @returns {Promise<{ corpus: { docs: number, blocks: number, grams: number, digest: string },
 *   timings: { coldLoadMs: number, searchMs: number, updateDocMs: number | null },
 *   backend: string, indexVersion: number, fixtureRoot: string, machine: string, at: string }>}
 */
export async function runBench({ configDir = null, iterations = 3 } = {}) {
  const n = Math.max(1, Math.floor(Number(iterations) || 1))
  const root = configDir ? String(configDir) : makeBenchFixture()
  if (configDir && !existsSync(root)) {
    throw new Error(`config-dir 不存在：${root}（拒绝在不存在的位置建库：那会长出一棵没人找得到的树）`)
  }
  const coldSamples = []
  const searchSamples = []
  const updateSamples = []
  let last = null
  for (let it = 0; it < n; it++) {
    // 冷加载 = 新建 store + load。索引不在盘上时 `force: true`（含建索引 —— fixture 首次必走），
    // 已有索引时走自然 load（**不 force**）：`force` 会把"全量重建"混进"冷加载"，
    // 而本仪表要量的是"冷启动加载既有索引"这一项（spec §8.5 的验收对象，实测参照 1558 ms；
    // 全量重建是另一个数字 ≈1384 ms）。混在一起会让"升级前后"的对比失去定向能力。
    const force = !hasDiskIndex(root)
    const t0 = Date.now()
    const store = createKnowledgeStore({ configDir: root })
    store.load({ force })
    coldSamples.push(Date.now() - t0)

    for (const q of QUERIES) {
      const t1 = Date.now()
      store.search({ query: q, topK: 5 })
      searchSamples.push(Date.now() - t1)
    }

    // 增量更新：只在确有实现 + 确有可读文档时测（取不到 ⇒ null，不造数字）
    if (typeof store.updateDoc === 'function') {
      const doc = (store.getDocs() || []).find((d) => d && d.id)
      if (doc) {
        const t2 = Date.now()
        const r = store.updateDoc(doc.id)
        const ms = Date.now() - t2
        if (r && r.updated === true) updateSamples.push(ms)
      }
    }
    last = store
  }
  const stats = last.stats()
  const docs = Number(stats.docs) || 0
  const blocks = Number(stats.blocks) || 0
  const grams = Number(stats.grams) || 0
  // 语料指纹：跨语料不可比的显式标记（不同 digest ⇒ 两次基线不可对比）
  const digest = createHash('sha1').update(`${docs}|${blocks}|${grams}`).digest('hex').slice(0, 12)
  return {
    corpus: { docs, blocks, grams, digest },
    timings: {
      coldLoadMs: Math.round(median(coldSamples)),
      searchMs: Math.round(median(searchSamples)),
      updateDocMs: updateSamples.length ? Math.round(median(updateSamples)) : null,
    },
    backend: backendOfLocal(configDir),
    indexVersion: Number(stats.version) || 0,
    fixtureRoot: root,
    machine: `${process.platform} ${process.arch} node ${process.version}`,
    at: new Date().toISOString(),
  }
}

/** 极简参数解析（无第三方依赖）：只认本脚本登记的三个 flag。 */
export function parseBenchArgs(argv = []) {
  const out = { configDir: null, out: null, iterations: 3, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') { out.help = true; continue }
    const v = argv[i + 1]
    if (a === '--config-dir') { out.configDir = v ?? null; i += 1; continue }
    if (a === '--out') { out.out = v ?? null; i += 1; continue }
    if (a === '--iterations') { out.iterations = Number(v) || 3; i += 1; continue }
  }
  return out
}

async function main() {
  const args = parseBenchArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法: node scripts/bench-knowledge-index.mjs [--config-dir <dir>] [--iterations N] [--out <file>]')
    return
  }
  const result = await runBench({ configDir: args.configDir, iterations: args.iterations })
  if (args.out) {
    mkdirSync(dirname(String(args.out)), { recursive: true })
    writeFileSync(String(args.out), JSON.stringify(result, null, 2), 'utf-8')
  }
  process.stdout.write(JSON.stringify(result, null, 2))
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) await main()
