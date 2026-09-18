// scripts/grid-bm25.mjs —— BM25 参数标定（P1，2026-09-18）
// ---------------------------------------------------------------------------
// **为什么必须自己搜**：来源材料（SIGIR'26 / hornet 分享）给的 `k1=10 / b=1`、`k1=25` 之类
// 是在**它们自己的语料**（5000 词网页文档、十万～亿级文档）上网格搜出来的。本应用是
// 238 篇 / 6917 块的私有中文库，语料长度分布、查询风格（编号/条款/标签逐字核对）都不同 ——
// 照搬等于把别人的最优点当成自己的。故本脚本在**自有量尺**上搜参数，结果与命令一起留档。
//
// 用法：
//   node scripts/grid-bm25.mjs                       # 默认网格
//   node scripts/grid-bm25.mjs --k1 0.9,1.2,2 --b 0.5,0.75,1 --sat 4,8,16 --limit 60
//
// **单进程复用 store**：每组参数只换打分，不换语料/用例（同一套用例跨组可比）——
// "一组一个进程"会把加载索引的几秒乘上组数，还会让冷启动噪声混进耗时列。
// 筛选口径：先看 `autoRecall@K`（能不能找到），并列再看 `top1`/`MRR`（排得够不够前），
// 最后看耗时 —— **不看命中总数**（`total`），因为它对参数不敏感却容易误导（分数尺度变了）。
import { homedir } from 'node:os'
import { createKnowledgeStore } from '../kernel/knowledge.mjs'
import { resolveConfigDir } from '../kernel/config.mjs'
import { buildGoldCases, runEval } from './eval-retrieval.mjs'

const LIST = (v, dft) => (v ? String(v).split(',').map((x) => Number(x)).filter((n) => Number.isFinite(n)) : dft)

const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a.startsWith('--')) { args[a.slice(2)] = process.argv[i + 1]; i += 1 }
}

const K1S = LIST(args.k1, [0.9, 1.2, 2.0])
const BS = LIST(args.b, [0.5, 0.75, 1.0])
const SATS = LIST(args.sat, [8])
const LIMIT = Number(args.limit) || 60
const TOPK = Number(args.topk) || 5

const configDir = String(args['config-dir'] || resolveConfigDir(process.env, homedir))
// 打分器可指定：bm25f 的字段权重标定复用本脚本（同一套网格/FW 逻辑，避免两份实现漂移）
const SCORER = String(args.scorer || 'bm25')
const seed = 20260918

// 一次性构造用例（同一套用例跨参数组可比）：用 legacy 模式加载即可 —— 用例构造只读语料与倒排
const probe = createKnowledgeStore({ configDir })
probe.load({})
const gold = buildGoldCases(probe, { limit: LIMIT, seed })
if (!gold.cases.length) {
  console.error('构造不出用例（语料为空或不含稀有 gram）：先确认 configDir 指向有内容的库')
  process.exit(2)
}
console.log(`用例 ${gold.cases.length} 条（limit=${LIMIT}）　语料 ${gold.blocks} 块　topK=${TOPK}　打分器=${SCORER}${args.fw ? `　fw=${args.fw}` : ''}`)
console.log('k1\tb\tsat\tautoRecall\ttop1\tMRR\tP50ms\tP95ms')
// 复用同一 store（参数**随每次查询注入**，见 eval-retrieval.mjs 的 searchOpts）：
// 每组重建 store 要重读 11MB 索引，9 组就是 9 次白等，还会让冷启动噪声混进耗时列。
const store = createKnowledgeStore({ configDir, scorerMode: SCORER })
store.load({})
const rows = []
for (const k1 of K1S) {
  for (const b of BS) {
    for (const sat of SATS) {
      const r = runEval({
        store, cases: gold.cases, topK: TOPK,
        searchOpts: { bm25: { k1, b, sat, ...(args.fw ? { fw: args.fw.split(',').map(Number) } : {}) } },
      })
      const s = r.summary
      rows.push({ k1, b, sat, s })
      console.log(`${k1}\t${b}\t${sat}\t${s.autoRecallAtK.toFixed(3)}\t\t${s.top1.toFixed(3)}\t${s.mrr.toFixed(3)}\t${s.msP50}\t${s.msP95}`)
    }
  }
}
const best = [...rows].sort((a, c) => (c.s.autoRecallAtK - a.s.autoRecallAtK)
  || (c.s.top1 - a.s.top1) || (c.s.mrr - a.s.mrr))[0]
console.log(`\n最优：k1=${best.k1} b=${best.b} sat=${best.sat}  autoRecall=${best.s.autoRecallAtK.toFixed(3)} top1=${best.s.top1.toFixed(3)} MRR=${best.s.mrr.toFixed(3)}`)
console.log('固化方式：把胜出值写进 bm25Params 的缺省（kernel/knowledge.mjs），并更新方案文档的参数小节。')
