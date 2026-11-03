// golden 基线录制器（Task 2：iterHead）——**一次性**，之后 golden 即真值源
// ---------------------------------------------------------------------------
// 用法：node kernel-tests/fixtures/record-guard-order-iterhead.mjs
//
// 做什么：把「搬移前」的 iterHead 守卫块从 `git show HEAD:kernel/engine.mjs` 取出，
//   连同**当前 loop-core 守卫体的可观测后果**一起落成 golden。golden 里因此同时有：
//     · iterHeadSource —— 搬移前源码（证明基线与"搬移后"无关，且文案可逐字比对）
//     · runtime        —— injections / events / stop / action / state 增量
//   测试随后只用 golden 比对，不再依赖 git（HEAD 一旦提交即变，录制器不可重复运行）。
//
// ★ 幂等保护：若 HEAD 已含 `runIterHeadGuards`（即搬移已提交），本脚本拒绝覆盖 golden。
import { execFileSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runIterHeadScenario, scenarios } from './guard-order-harness.mjs'

const GOLDEN = fileURLToPath(new URL('./guard-order-iterhead.golden.json', import.meta.url))
const headSrc = execFileSync('git', ['show', 'HEAD:kernel/engine.mjs'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
if (headSrc.includes('runIterHeadGuards')) {
  console.error('HEAD 已含 runIterHeadGuards ⇒ 搬移前的基线已不可再取；拒绝重录（golden 即真值源）')
  process.exit(2)
}
if (existsSync(GOLDEN) && !process.argv.includes('--force')) {
  console.error('golden 已存在；确要重录请显式加 --force（重录会破坏"重构前基线"的证据力）')
  process.exit(2)
}

// 搬移范围 = 迭代头三段守卫（① 墙钟 … ③/③b 愈合计数清零之前）
const from = headSrc.indexOf('// 守卫①：轮次墙钟')
const to = headSrc.indexOf('if (loopStop) break')
if (from < 0 || to < 0 || to <= from) {
  console.error('未能从 HEAD 源码中切出 iterHead 守卫块（行号漂移？请核对标记注释）')
  process.exit(3)
}
const iterHeadSource = headSrc.slice(from, to)

const runtime = {}
for (const [name, state] of Object.entries(scenarios())) {
  runtime[name] = await runIterHeadScenario(state)
}

const payload = {
  recordedFrom: 'git HEAD:kernel/engine.mjs（S2/B1 Task 2 搬移前）',
  recordedAt: new Date().toISOString().slice(0, 10),
  note: 'iterHead 守卫（wallClock/iterCap/stall）搬移前源码 + 搬移后可观测后果快照；测试逐项比对，防文案/事件/计数/收尾时机漂移。',
  iterHeadSource,
  runtime,
}
writeFileSync(GOLDEN, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
const n = Object.keys(payload.runtime).length
const inj = Object.values(payload.runtime).reduce((a, r) => a + r.injections.length, 0)
if (inj === 0) { console.error('拒绝写出：injections 全空 ⇒ 该 golden 无判等价能力'); process.exit(4) }
console.log(`已录制 fixtures/guard-order-iterhead.golden.json（场景=${n} injections=${inj} 源块=${iterHeadSource.length}B）`)
// 顺带打印搬移前源码块的首行，便于人工核对切片正确
console.log(`源块首行：${readFileSync(GOLDEN, 'utf8').split('\n').length} 行 JSON 已写入`)
