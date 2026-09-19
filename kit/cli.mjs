#!/usr/bin/env node
// kit/cli.mjs —— DevKit 唯一入口
//
// 四命令分工（刻意分离，禁止合并）：
//   check  纯只读门禁（CI 用；退出码 0/1）—— 绝不写文件，否则"跑门禁"会改仓库状态
//   sync   从宿主文件发现事实、重写台账（人工维护的字段被保留）
//   view   给 AI 读的稳定 schema 摘要（不解析散文）
//   stamp  给调试版盖章（Task 13 实现具体字段；未实现时**明确报错**，不假装成功）
//
// ★ 2026-09-19 Task 7 的两处关键接线（都是实测踩出来的）：
//   · Rider 1：ghost 只能由 `ledger.computeGhost` 算（sync/check 共用一份判据）。
//     计划原文另写的 `ghostOf()` 在真仓会多报 `~` 与 `jszip` 两条假幽灵（ghost 4→6），
//     与 docs/待处理清单.md 记的"4 条"对不上，也会让 P2 的红灯数报错。
//     ★ Task 8 更正：Task 7 的提交信息曾把这里写成"P2 涨到 **15** 条"——**那是错的**。
//       实测按计划原文（**带** builtins 过滤）是 **6** 条（多报 `~`、`jszip`），与上面"4→6"一致；
//       "15"只在**去掉** builtins 过滤时才会出现。**以后不要引用"15"这个数字。**
//   · Rider 3：`runDepRules` 的 ghost 是必传参数（缺省抛错），所以这里的 collect() 必须
//     真的算出来 —— 漏了不会"静默全绿"，会直接炸。
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { trackedFiles, codeFiles, readTracked } from './lib/scan.mjs'
import { makeReport, renderHuman, RED } from './lib/report.mjs'
import { loadBaseline, applyBaseline, baselineGrowth } from './lib/baseline.mjs'
import { readVersions, readDeps, readJson, syncVersions, syncDeps, syncSkillsLock, computeGhost } from './lib/ledger.mjs'
import { runVersionRules } from './lib/version-rules.mjs'
import { runDepRules } from './lib/dep-rules.mjs'

const ROOT = process.env.YFW_KIT_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..')
const USAGE = `用法：node kit/cli.mjs <check|sync|view|stamp> [选项]

  check [--json] [--verbose]   台账门禁（只读）。退出码 0=无红灯，1=有红灯
  sync  [--dry-run]            从宿主文件重建台账（保留人工字段）
  view  [--json]               输出台账摘要（AI 侧稳定 schema）
  stamp [--json]               给 dev 渠道盖章（写 release/YFWorking/kit-stamp.json）

退出码：check 有红灯 → 1；view/sync 成功 → 0；未知子命令 → 1`

/** package.json 声明的 npm 包名（P2 的 declared 与 P7 的对账都用它；读不到 → 空集，由 P7 报红） */
function declaredNames(pkg) {
  return new Set(['dependencies', 'devDependencies'].flatMap((f) => Object.keys(pkg?.[f] || {})))
}

/**
 * 一次收集：扫描域（git ls-files，I2）+ 台账 + 全部规则。
 * check 与 view **必须共用本函数** —— 各跑一套就会出现"两个真相"（测试已钉住 summary 逐字相等）。
 */
function collect() {
  const files = trackedFiles({ root: ROOT })
  const versions = readVersions({ root: ROOT })
  const deps = readDeps({ root: ROOT })
  const pkg = readJson({ root: ROOT, rel: 'package.json', fallback: null })
  // 幽灵依赖：sync 与 check 共用 computeGhost（Rider 1）。探针清单优先用台账里已登记的
  // （`optionalProbes` 含 file:line，供人复核），台账缺失时该函数会现场重算。
  const ghost = deps
    ? computeGhost({
      root: ROOT,
      files: codeFiles(files, { includeTests: true }),
      declared: declaredNames(pkg),
      probes: deps.optionalProbes || null,
    })
    : []
  const v = runVersionRules({ root: ROOT, versions, files })
  // pkg 显式传入：P7 的对账对象必须与 P2 的 declared 是**同一次读取**（否则两次读盘之间
  // 有人改了 package.json，报告里会出现互相矛盾的两段结论）。
  const d = runDepRules({ root: ROOT, deps, ghost, pkg })
  return { files, versions, deps, checks: [...v.checks, ...d.checks], findings: [...v.findings, ...d.findings] }
}

function buildReport() {
  const { checks, findings, versions } = collect()
  const baseline = loadBaseline({ root: ROOT })
  const applied = applyBaseline(findings, baseline)
  const report = makeReport({ checks, findings: applied.findings })
  const growth = baselineGrowth({ baseline, recordedCount: versions?.history?.baselineCount ?? null })
  if (growth) {
    // BASE：基线条目数超过登记值 → 红。没有它，基线会变成"遇红就塞"的垃圾桶。
    const exceeded = growth.exceeded ?? growth.redExceeded
    const what = growth.exceeded !== null && growth.exceeded !== undefined ? '条目总数' : '豁免红灯的条目数'
    report.findings.push({
      rule: 'BASE', severity: RED, subject: 'drift-baseline.entries',
      expected: growth.exceeded !== null && growth.exceeded !== undefined ? String(growth.recordedCount) : String(growth.recordedRedCount),
      actual: String(exceeded),
      hint: `基线的${what}超过了每次签入时登记的数量（versions.json#history.baselineCount）：基线是"已知欠账"，不是"遇红就塞"`,
    })
    report.ok = false
    report.summary.red += 1
  }
  report.baselineUnused = applied.unused
  return report
}

/** 台账规模摘要（view 的 AI 契约字段之一：让 AI 不必解析散文就知道台账多大） */
function ledgerSizes() {
  const v = readVersions({ root: ROOT }) || {}
  const d = readDeps({ root: ROOT }) || {}
  const count = (k) => ((d.domains?.[k]?.packages) || []).length
  return {
    versions: {
      lines: (v.lines || []).length, contracts: (v.contracts || []).length,
      skills: (v.skills || []).length, skillsLock: (v.skillsLock?.ids || []).length,
      commonTools: (v.commonTools?.entries || []).length,
    },
    deps: {
      'npm-runtime': count('npm-runtime'), 'npm-dev': count('npm-dev'), kernel: count('kernel'),
      'python-embedded': count('python-embedded'), 'python-skills': count('python-skills'),
    },
  }
}

/**
 * --verbose 的额外内容：**逐条规则的判定结果**。
 * 为什么必须由 --verbose 提供：默认报告只列 findings，"哪条规则真的跑过、evaluated 是多少"
 * 在红灯之外看不见 —— P7 这种"两个集合对账"的规则若因故没接线，报告会与"全绿"长得一样。
 */
function renderRuleTable(report, sizes) {
  const lines = ['', `规则逐条（${report.checks.length}）`]
  for (const c of report.checks) {
    lines.push(`  ${c.passed ? '✔' : '✘'} [${c.rule}] ${c.title}  evaluated=${c.evaluated}`)
  }
  lines.push('', `台账规模：versions ${JSON.stringify(sizes.versions)}`)
  lines.push(`          deps ${JSON.stringify(sizes.deps)}`)
  return lines.join('\n')
}

function runSync({ dryRun }) {
  // syncVersions/syncDeps 都是"重写台账"的操作；--dry-run 时两者都不落盘（测试已钉住）。
  const files = trackedFiles({ root: ROOT })
  const v = syncVersions({ root: ROOT, files, dryRun })
  const d = syncDeps({ root: ROOT, files, dryRun })
  // Task 9：lock 重算走真实现（此前是 `{updated:[],unchanged:[],missing:[]}` 占位 —— 占位期间
  // 跑 sync 也不会重算哈希，V7 的 20 条红灯永远擦不掉）。
  // 三件事都认 dryRun：预演**不得**落盘（否则"预演"会把仓库改到一半）。
  const lock = syncSkillsLock({ root: ROOT, files, dryRun })
  const data = d.data
  return {
    lines: [
      `versions: lines ${v.data.lines.length} / contracts ${v.data.contracts.length} / skills ${v.data.skills.length} / lockIds ${v.data.skillsLock.ids.length} / commonPy ${v.data.commonTools.entries.length}`,
      `  added ${v.added.length}  removed ${v.removed.length}`,
      ...(v.added.length ? [`  + ${v.added.join('\n  + ')}`] : []),
      ...(v.removed.length ? [`  - ${v.removed.join('\n  - ')}`] : []),
      `skills-lock: updated ${lock.updated.length} / unchanged ${lock.unchanged.length} / missing ${lock.missing.length}`,
      ...(lock.missing.length ? [`  ! lock 里登记但无对应 SKILL.md（条目保留，V7 会报红）：${lock.missing.join(', ')}`] : []),
      `deps: runtime ${data.domains['npm-runtime'].packages.length} / dev ${data.domains['npm-dev'].packages.length}`,
      `  unused ${d.unused.length}: ${d.unused.join(', ') || '(无)'}`,
      `  ghost  ${d.ghost.length}: ${d.ghost.join(', ') || '(无)'}`,
      dryRun ? '（--dry-run：台账未写盘）' : '（台账已写盘）',
    ].join('\n'),
  }
}

/**
 * stamp（Task 13 才实现 lib/stamp.mjs）。
 * 未实现时**明确报错退出 1**，不静默成功：一个"退出码 0 但什么都没写"的盖章命令，
 * 在 CI/发版脚本里比不存在更危险（调用方以为盖过了）。
 */
async function runStamp({ asJson }) {
  try {
    const { stampChannel } = await import('./lib/stamp.mjs')
    const info = stampChannel({ root: ROOT })
    return { code: 0, out: asJson ? JSON.stringify(info, null, 2) : `已盖章：${info.stampFile}\n  commit ${info.commit}（dirty: tracked ${info.dirty.tracked} / untracked ${info.dirty.untracked}）` }
  } catch (e) {
    if (e && (e.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module/.test(e.message))) {
      return { code: 1, out: `stamp 未实现：缺少 kit/lib/stamp.mjs（Task 13 交付）。\n本次未写任何文件 —— 请勿把退出码 0 当成"已盖章"。` }
    }
    return { code: 1, out: `stamp 失败：${e.message}` }
  }
}

/**
 * sync 的前置条件：**只**要求宿主输入（package.json）可读。
 * 为什么不检查台账在不在：台账缺失正是 sync 要修的状态（首次建台账就是"两个都不在"），
 * 在这里拦下来等于"没台账就没法生成台账"。
 */
function syncPreconditions() {
  return readTracked({ root: ROOT, file: 'package.json' }) === null
    ? [`缺 ${resolve(ROOT, 'package.json')} —— 依赖台账的输入真源不可读，sync 无法给出结论`]
    : []
}

async function main() {
  const [, , cmd, ...rest] = process.argv
  const asJson = rest.includes('--json')
  const verbose = rest.includes('--verbose')

  if (cmd === 'check') {
    const report = buildReport()
    if (asJson) console.log(JSON.stringify(report, null, 2))
    else {
      console.log(renderHuman(report))
      if (verbose) console.log(renderRuleTable(report, ledgerSizes()))
      if (report.baselineUnused?.length) console.log(`\n（信息）基线中 ${report.baselineUnused.length} 条已不再命中，可摘除：${report.baselineUnused.join(', ')}`)
    }
    return report.ok ? 0 : 1
  }

  if (cmd === 'view') {
    const report = buildReport()
    const payload = {
      schemaVersion: 1, generatedAt: report.generatedAt, ok: report.ok, summary: report.summary,
      ledgers: ledgerSizes(), findings: report.findings,
    }
    console.log(asJson
      ? JSON.stringify(payload, null, 2)
      : `${renderHuman(makeReport({ checks: [], findings: report.findings }))}\n\n${renderRuleTable(report, ledgerSizes())}`)
    // view 是"查看"：契约恒 0（门禁退出码只在 check 上）。测试已钉住这条反向断言。
    return 0
  }

  if (cmd === 'sync') {
    const problems = syncPreconditions()
    if (problems.length) {
      console.error(`sync 前置条件不满足：\n  - ${problems.join('\n  - ')}`)
      return 1
    }
    console.log(runSync({ dryRun: rest.includes('--dry-run') }).lines)
    return 0
  }

  if (cmd === 'stamp') {
    const r = await runStamp({ asJson })
    ;(r.code === 0 ? console.log : console.error)(r.out)
    return r.code
  }

  if (!cmd) { console.log(USAGE); return 0 }
  console.error(`未知子命令：${cmd}\n\n${USAGE}`)
  return 1
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(`kit/cli.mjs 内部错误：${e && e.stack ? e.stack : e}`)
  process.exit(1)
})
