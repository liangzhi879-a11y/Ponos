#!/usr/bin/env node
// 文档口径纳入 CI（P2 · 2026-09-17 新增）
// ---------------------------------------------------------------------------
// 解决什么问题：本仓库的文档（架构/契约/运维手册/spec）大量引用**具体代码路径、行数、测试文件数**。
// 这些数字一旦与代码脱节，文档就从"可信依据"退化成"需要人工核对的猜测"——而读者通常
// **不会**去核对，于是照着过期文档操作。把可客观校验的口径变成 CI 断言，是最省事的解法。
//
// 两类检查：
//   A. **路径存在性**：扫描本仓库文档里反引号包裹的仓库相对路径，断言文件真实存在。
//      文档提到"某文件某某行为"而文件已改名/移动/删除时立即暴露。
//      确属**有意**引用的不存在路径（构建产物名、刻意构造的负例、文档在说明"该引用已失效"），
//      登记到 docs/_anchors-allow.json（**手写**，每条写理由）即可放行。
//   B. **各层测试文件数**：与 docs/_anchors.json 比对，抓"整层测试静默消失 / glob 写错"。
//   C. **文档的图谱数字**（P2-4①）：docs/architecture.md 里声明的模块数/域数/边数等，
//      必须与**已提交的** docs/architecture-graph.html 内嵌数据一致。
//
// 为什么 C 不会变成"每次重构都红"的负担（这是它与"硬卡源码行数"的关键区别）：
//   C 比的是**文档与图谱产物这两个都在仓库里的文件**，而不是"文档 vs 现场扫描"。
//   两者平时由同一次改动一起更新（跑 build-arch-graph.mjs 就会同时动图谱与 §12 的口径），
//   因此只有当**只更新了其中一个**（重生成图谱却忘改文档，或手改了文档数字）时才会报警——
//   那正是需要我们介入的时刻。反之若拿它去卡"源码总行数"，则每次重构都会红。
//
// 用法：
//   node scripts/check-doc-anchors.mjs           # 校验（CI 用）
//   node scripts/check-doc-anchors.mjs --write   # 重新生成 docs/_anchors.json
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { globSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEST_GLOBS, trackedTestCounts } from './test-tiers.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ANCHORS = resolve(ROOT, 'docs/_anchors.json')
const ALLOW = resolve(ROOT, 'docs/_anchors-allow.json')
const write = process.argv.includes('--write')

/**
 * 白名单**刻意放在独立的手写文件**（`docs/_anchors-allow.json`，每条带 reason），
 * 而不是塞进自动生成的 `_anchors.json`：
 * 后者由 --write 重写，若把白名单也放进去，"重新生成"就等于"把所有问题自动放行"，
 * 门禁会被一次 --write 悄悄架空。分离后，放行必须是一次**显式的人工编辑**。
 */
function readAllow() {
  if (!existsSync(ALLOW)) return new Map()
  try {
    const j = JSON.parse(readFileSync(ALLOW, 'utf8'))
    return new Map((j.allow || []).map((e) => [e.path, e.reason || '（未写理由）']))
  } catch (e) {
    console.error(`❌ docs/_anchors-allow.json 解析失败：${e.message}`)
    process.exit(1)
  }
}

/** 五个待拆巨石（P2 清单）——仅作**信息展示**，不参与门禁（见下方"门禁强度"说明） */
const MONOLITHS = ['kernel/knowledge.mjs', 'kernel/engine.mjs', 'kernel/tools.mjs', 'electron/main.cjs', 'server/bridge.mjs']

/**
 * 扫描范围：只扫**描述本仓库现状**的文档。
 * 刻意排除三类（它们"路径不存在"是正常状态，纳入只会让白名单膨胀到上百条、门禁失效）：
 *   · `docs/superpowers/specs|plans|audits/**` — 设计/计划/审计**记录**，写的是"当时打算建什么"，
 *     且常含对外部参考实现的引用；
 *   · 五引擎架构对比笔记 — **对比他人引擎**的调研；
 *   · 其余 `docs/*.md`（本仓库的架构/契约/运维手册）与 `docs/manual/**` **在范围内**。
 */
const DOC_GLOBS = ['docs/*.md', 'docs/manual/**/*.md']
const DOC_EXCLUDE = [/五引擎架构性能对比分析/]

/**
 * ⚠️ **门禁强度是刻意的**：只对"变化慢、且脱节后果严重"的口径设卡：
 *   · 各层测试文件数（防"glob 写错 ⇒ 整层静默消失、CI 假绿"）
 *   · 文档引用的仓库路径是否存在（防文档腐烂）
 * 而**模块数 / 总行数 / 巨石行数不做等值门禁**，只写入锚点供人查看：
 * 它们每次合法重构都会变，硬卡会逼人每次都跑 --write，最终结果是人把检查绕过或删掉——
 * 那还不如一开始就别卡。需要看趋势时读 docs/_anchors.json 即可。
 */
function computeAnchors() {
  const src = execFileSync('git', ['ls-files', '*.mjs', '*.cjs', '*.ts', '*.tsx'], { cwd: ROOT, encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean)
    .filter((f) => !/\.test\.(mjs|ts|tsx)$/.test(f))
    .filter((f) => !f.startsWith('scripts/') && !f.startsWith('public/') && !f.startsWith('kernel-dist/'))
  let loc = 0
  for (const f of src) { try { loc += readFileSync(resolve(ROOT, f), 'utf8').split('\n').length } catch { /* 读不到则不计 */ } }
  // 测试文件数只算 git 已跟踪的（口径与 ci-preflight 共用 scripts/test-tiers.mjs）：
  // 工作树里可能有别人尚未提交的在途文件，算进来会让锚点记录"只存在于本机"的数量，
  // CI 在干净克隆上必然对不上而变红。
  const testFileCounts = trackedTestCounts(ROOT)
  const monoliths = {}
  for (const m of MONOLITHS) { try { monoliths[m] = readFileSync(resolve(ROOT, m), 'utf8').split('\n').length } catch { monoliths[m] = -1 } }
  return {
    // ── 信息项（不门禁）──
    info: { sourceModules: src.length, sourceLoc: loc, monoliths },
    // ── 门禁项 ──
    testFileCounts,
    testTotal: Object.values(testFileCounts).reduce((a, b) => a + b, 0),
  }
}

/** 从**本仓库文档**抽取反引号内的仓库相对路径（限定 DOC_GLOBS，排除 DOC_EXCLUDE） */
function extractDocPaths() {
  const files = DOC_GLOBS.flatMap((g) => globSync(g, { cwd: ROOT }))
    .filter((f) => !DOC_EXCLUDE.some((re) => re.test(f)))
  const found = new Map()   // path -> Set(引用它的文档)
  // 形如 `a/b/c.mjs` / `src/x.ts:12` 的反引号片段；要求含 `/` 且有已知扩展名，避免把普通词当路径
  const re = /`([A-Za-z0-9_@.\-/]+\.(?:mjs|cjs|ts|tsx|js|json|md|py|yml|yaml))(?::\d+(?:-\d+)?)?`/g
  for (const f of files) {
    let src
    try { src = readFileSync(resolve(ROOT, f), 'utf8') } catch { continue }
    for (const m of src.matchAll(re)) {
      const p = m[1]
      if (p.includes('://') || p.startsWith('/') || p.startsWith('.')) continue   // URL/绝对/相对不确定者跳过
      if (!p.includes('/')) continue                                              // 必须含目录，降低误报
      if (!found.has(p)) found.set(p, new Set())
      found.get(p).add(f)
    }
  }
  return found
}

// ── 门禁 C 的数据源：从已提交的图谱产物里读"权威数字" ────────────────────────
// 图谱 HTML 是自包含的，数据内嵌在 `const DATA = {...}` 里。我们只读它、绝不现场重扫——
// 现场重扫会让门禁依赖构建时序（CI 上不该为了校验文档而跑一遍架构扫描）。
function readGraphStats() {
  const p = resolve(ROOT, 'docs/architecture-graph.html')
  if (!existsSync(p)) return null
  const html = readFileSync(p, 'utf8')
  const m = html.match(/const DATA = (\{[\s\S]*?\});\s*\n/)
  if (!m) return null
  let data
  try { data = JSON.parse(m[1]) } catch { return null }
  const s = data.stats || {}
  return { files: s.files, edges: s.edges, domains: s.domains, loc: s.loc, testsExcluded: s.testsExcluded, orphans: s.orphans, refEdges: s.refEdges, untracked: s.untracked }
}

// 文档里声明的图谱数字 → 对应的图谱统计量。**措辞改动必须同步此表**：
// 若某条的 re 在文档里匹配不到，门禁会明确报"断言失效"而不是静默放过（见下方）。
const GRAPH_CLAIMS = [
  { file: 'docs/architecture.md', re: /(\d[\d,]*)\s*个源码模块一个不漏/g, keys: ['files'], label: '§12 导语的总模块数' },
  { file: 'docs/architecture.md', re: /覆盖全部\s*(\d[\d,]*)\s*个源码模块/g, keys: ['files'], label: '§1 的图谱覆盖模块数' },
  { file: 'docs/architecture.md', re: /功能域视图\s*(\d[\d,]*)\s*域/g, keys: ['domains'], label: '§12.1 的功能域数' },
  { file: 'docs/architecture.md', re: /功能域视图\*{0,2}（默认，\s*(\d[\d,]*)\s*域）/g, keys: ['domains'], label: '§12.7 的功能域数' },
  { file: 'docs/architecture.md', re: /模块视图\s*(\d[\d,]*)\s*模块/g, keys: ['files'], label: '§12.1 的模块视图模块数' },
  { file: 'docs/architecture.md', re: /模块视图\*{0,2}（\s*(\d[\d,]*)\s*模块）/g, keys: ['files'], label: '§12.7 的模块视图模块数' },
  { file: 'docs/architecture.md', re: /排除\s*\*\*(\d[\d,]*)\s*个测试文件\*\*/g, keys: ['testsExcluded'], label: '§12.2 排除的测试文件数' },
  { file: 'docs/architecture.md', re: /(\d[\d,]*)\s*模块\s*·\s*([\d,]+)\s*行\s*·\s*([\d,]+)\s*条依赖边/g, keys: ['files', 'loc', 'edges'], label: '§12.4 的模块/行/边合计' },
  { file: 'docs/architecture.md', re: /其中\s*(\d[\d,]*)\s*条按路径引用/g, keys: ['refEdges'], label: '§12.4 的按路径引用边数' },
  { file: 'docs/architecture.md', re: /孤立模块（(\d[\d,]*)\s*个/g, keys: ['orphans'], label: '§12.6 的孤立模块数' },
]

const num = (s) => Number(String(s).replace(/,/g, ''))

function checkGraphNumbers(problemsC) {
  const stats = readGraphStats()
  if (!stats) {
    problemsC.push('读不到 docs/architecture-graph.html 的内嵌数据（文件缺失或格式变了）——门禁 C 失效，请检查 scripts/build-arch-graph.mjs 的输出')
    return
  }
  for (const claim of GRAPH_CLAIMS) {
    let src
    try { src = readFileSync(resolve(ROOT, claim.file), 'utf8') } catch { problemsC.push(`${claim.file} 读不到，无法校验「${claim.label}」`); continue }
    const hits = [...src.matchAll(claim.re)]
    if (hits.length === 0) {
      // 静默放过会让门禁形同虚设：文档改写了措辞却没同步 GRAPH_CLAIMS 时必须报出来
      problemsC.push(`${claim.label}：在 ${claim.file} 里匹配不到声明语句（措辞可能已改）——请同步 scripts/check-doc-anchors.mjs 的 GRAPH_CLAIMS`)
      continue
    }
    for (const h of hits) {
      claim.keys.forEach((k, i) => {
        const declared = num(h[i + 1])
        const actual = stats[k]
        if (actual === undefined) { problemsC.push(`${claim.label}：图谱数据里没有 ${k}`); return }
        if (declared !== actual) {
          problemsC.push(`${claim.label} 与图谱不符：文档写 ${declared.toLocaleString('en-US')}，图谱实际 ${actual.toLocaleString('en-US')}（跑 node scripts/build-arch-graph.mjs 重建图谱后同步文档）`)
        }
      })
    }
  }
}

const anchors = computeAnchors()

if (write) {
  const out = {
    _note: '由 node scripts/check-doc-anchors.mjs --write 生成（**不要手改**）。info 段仅信息展示；testFileCounts 参与 CI 门禁（只计 git 已跟踪文件）。文档路径白名单是手写的 docs/_anchors-allow.json。',
    _scope: `文档扫描范围：${DOC_GLOBS.join(', ')}（已排除：${DOC_EXCLUDE.map(String).join(', ')}）`,
    ...anchors,
  }
  writeFileSync(ANCHORS, JSON.stringify(out, null, 2) + '\n')
  const allow = readAllow()
  const missing = []
  for (const [p] of extractDocPaths()) if (!existsSync(resolve(ROOT, p))) missing.push(p)
  const unresolved = missing.filter((p) => !allow.has(p))
  console.log('✅ 已写入 docs/_anchors.json（仅计数口径；白名单见 docs/_anchors-allow.json）')
  console.log(`   信息：源码模块 ${out.info.sourceModules} / 总行 ${out.info.sourceLoc} / 测试文件 ${out.testTotal}`)
  console.log(`   门禁：各层测试文件数 + 文档路径存在性（手写白名单 ${allow.size} 条）+ 文档图谱数字（${GRAPH_CLAIMS.length} 条声明）`)
  if (missing.length) {
    console.log(`\n${missing.length} 个文档引用的路径不存在：`)
    for (const p of missing) console.log(`   ${allow.has(p) ? '[已白名单]' : '[未处理]'} ${p}`)
  }
  if (unresolved.length) {
    console.error(`\n❌ 有 ${unresolved.length} 个缺失路径未处理。请：`)
    console.error('   · 文档腐烂（文件已改名/移动/删除）→ **修文档**，这是首选；')
    console.error('   · 确属真·历史引用（构建产物名、刻意举例的负例路径、文档在说明"该引用已失效"等）')
    console.error('     → 手写进 docs/_anchors-allow.json 并写明 reason。')
    process.exit(1)
  }
  process.exit(0)
}

// ── 校验模式 ─────────────────────────────────────────────────────────────
const problems = []
const warnings = []

if (!existsSync(ANCHORS)) {
  console.error('❌ 缺少 docs/_anchors.json —— 先跑 node scripts/check-doc-anchors.mjs --write')
  process.exit(1)
}
const declared = JSON.parse(readFileSync(ANCHORS, 'utf8'))
const allowMissing = readAllow()

// 门禁 A：各层测试文件数（防整层静默消失）
for (const [g, n] of Object.entries(anchors.testFileCounts)) {
  const expect = (declared.testFileCounts || {})[g]
  if (expect !== undefined && n !== expect) {
    problems.push(`测试文件数[${g}] 与锚点不符：实际 ${n}，锚点 ${expect}（确认无误后跑 npm run anchors:write）`)
  }
}
// 门禁 A′：分层清单本身要与 package.json 的测试脚本一致（防"改了脚本忘了改口径"）
try {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))
  const scriptsText = JSON.stringify(pkg.scripts || {})
  for (const g of TEST_GLOBS) {
    if (!scriptsText.includes(g)) warnings.push(`分层清单里的 ${g} 未出现在 package.json 的测试脚本中（口径与脚本已漂移，请同步）`)
  }
} catch { warnings.push('无法读取 package.json 校验分层清单一致性') }

// 门禁 B：文档路径存在性（未白名单的缺失 = 文档腐烂）
for (const [p, refs] of extractDocPaths()) {
  if (existsSync(resolve(ROOT, p))) continue
  if (allowMissing.has(p)) continue
  problems.push(`文档引用了不存在的路径 \`${p}\`（引用它的文档：${[...refs].join(', ')}）——首选修文档；确属真·历史引用才写进 docs/_anchors-allow.json 并注明理由`)
}
// 已白名单却已存在的路径：提示清理（不算失败）
for (const p of allowMissing.keys()) if (existsSync(resolve(ROOT, p))) warnings.push(`白名单里的 \`${p}\` 现已存在，可移除该条目`)

// 门禁 C：文档声明的图谱数字必须与**已提交的图谱产物**一致（P2-4①）
checkGraphNumbers(problems)

for (const w of warnings) console.warn(`  ⚠️  ${w}`)
if (problems.length) {
  console.error('\n❌ 文档口径校验未通过：')
  for (const p of problems) console.error(`   · ${p}`)
  process.exit(1)
}
console.log(`✅ 文档口径校验通过：${anchors.testTotal} 个测试文件（分层计数一致）；文档路径引用均存在或已白名单（${allowMissing.size} 条，每条有理由）；文档图谱数字与产物一致（${GRAPH_CLAIMS.length} 条声明）`)
console.log(`   （信息）源码模块 ${anchors.info.sourceModules} / 总行 ${anchors.info.sourceLoc}；巨石行数：${Object.entries(anchors.info.monoliths).map(([k, v]) => `${k}=${v}`).join(', ')}`)
