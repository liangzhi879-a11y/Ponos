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
//
// ★ 2026-09-19 P1-T9：契约对账（CT0–CT12）接线；★ 2026-09-20 品牌批加 CT10、agent 入口批加 CT11、devkit 边界批加 CT12。三条约束直接落在这里：
//   · **同源**：`collect()` 是 check/view 的唯一入口（含契约提取）—— 两处各跑一套会出现"两个真相"；
//   · **可见性**：`renderHuman` 恒打印「契约范围登记（N 组 / M 键）」**逐条**（kind/ns/count/docSection/reason）
//     —— 只报总数等于把"范围边界"藏起来（先例：spec §7.3 规则 3）；
//   · **sync 不写 scope**：`contract-scope.json` 是人工文件，sync 只**读**它做摘要，绝不改写
//     （同一心智先例：sync 不写 drift-baseline.json）。
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { trackedFiles, codeFiles, readTracked } from './lib/scan.mjs'
import { makeReport, renderHuman, RED } from './lib/report.mjs'
import { loadBaseline, applyBaseline, baselineGrowth } from './lib/baseline.mjs'
import { materializeHead, worktreeClean } from './lib/head-tree.mjs'
import { readVersions, readDeps, readJson, syncVersions, syncDeps, syncSkillsLock, computeGhost } from './lib/ledger.mjs'
import { runVersionRules } from './lib/version-rules.mjs'
import { runDepRules } from './lib/dep-rules.mjs'
import { parseDoc } from './lib/contract-doc.mjs'
import { buildSnapshot, readSnapshot, diffSnapshot } from './lib/contract-snapshot.mjs'
import { loadScope } from './lib/contract-scope.mjs'
import { runContractRules } from './lib/contract-rules.mjs'

const ROOT = process.env.YFW_KIT_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 契约文档（受控子集；P1 只解析不修改 —— 补文档另开 P1.5） */
const DOC_FILE = 'docs/bridge-contract.md'
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

/** 范围登记的摘要（给报告用：**逐条**带 kind/ns/count/docSection/reason，绝不只给总数） */
function scopeSummary(scope) {
  const entries = scope?.entries || []
  return {
    present: Boolean(scope?.present),
    total: entries.length,
    keys: entries.reduce((n, e) => n + e.members.length, 0),
    groups: entries.map((e) => ({
      kind: e.kind, ns: e.ns, count: e.members.length, docSection: e.docSection,
      reason: e.reason, problems: e.problems.length,
    })),
  }
}

/**
 * 一次收集：扫描域（git ls-files，I2）+ 台账 + 全部规则（版本/依赖/契约）。
 * check 与 view **必须共用本函数** —— 各跑一套就会出现"两个真相"（测试已钉住 summary 逐字相等）。
 * 契约侧（第 3 批起）：**真值取自提交态 HEAD**（`materializeHead` 物化成临时干净检出），
 * 工作树只用于 `CT8`（在途差异、黄灯）；文档两侧都现场解析；快照**现场重算**（CT1 的红线）。
 */
async function collect() {
  const files = trackedFiles({ root: ROOT })
  // ★ CT8 的**工作树侧**域 = 索引 ∪ 未忽略的未跟踪文件（plan §6 D7）：`git ls-files` 只列索引，
  //   未 `git add` 的新路由模块会整块从 CT8 的视野里消失（审查实测：`?? server/zzz-wip-routes.mjs`
  //   摆在那里，报告却打印"工作树契约面与 HEAD 一致"）。契约**真值侧**（head*/CT0–CT7/CT9）与
  //   `kit:sync` 照旧用上面的 `files`（索引域，不变量 I2 不变）。
  const workFiles = trackedFiles({ root: ROOT, includeUntracked: true })
  // ★ 提交态 = 契约规则的唯一真值来源。物化失败（空仓/git 不可用）**不静默**：
  //   把 error 交给 runContractRules 报成 CT1 红（"对账不可进行"不是"没事"），此时真值退化为工作树。
  const head = materializeHead({ root: ROOT })
  const headRoot = head.available ? head.dir : ROOT
  const headFiles = head.available ? head.files : files
  const versions = readVersions({ root: ROOT })
  const deps = readDeps({ root: ROOT })
  const pkg = readJson({ root: ROOT, rel: 'package.json', fallback: null })
  const read = (f) => readTracked({ root: ROOT, file: f })
  const readHeadOf = (f) => readTracked({ root: headRoot, file: f })
  const readHead = head.available ? readHeadOf : read
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
  const docText = readHead(DOC_FILE)
  const doc = docText === null ? null : parseDoc(docText)
  const docWorkText = read(DOC_FILE)
  const docWorktree = docWorkText === null ? null : parseDoc(docWorkText)
  const scope = loadScope({ root: ROOT })
  const channels = versions && versions.channels && typeof versions.channels === 'object' ? versions.channels : null
  const c = await runContractRules({
    root: ROOT, files, workFiles, doc, docWorktree, snapshot: channels, scope, readTracked: read,
    headRoot, headFiles, headReadTracked: readHead,
    headError: head.available ? null : head.error,
    // 工作树与 HEAD 一致（CI/干净克隆的常态）⇒ CT8 侧不必再跑一遍全量提取（等价性捷径，见 head-tree.mjs）
    worktreeIdentical: worktreeClean({ root: ROOT }),
    recorded: { scopeCount: channels?.scopeCount ?? null, scopeRedCount: channels?.scopeRedCount ?? null },
  })
  return {
    files, versions, deps, scope,
    checks: [...v.checks, ...d.checks, ...c.checks],
    findings: [...v.findings, ...d.findings, ...c.findings],
  }
}

async function buildReport() {
  const { checks, findings, versions, scope } = await collect()
  const baseline = loadBaseline({ root: ROOT })
  const applied = applyBaseline(findings, baseline)
  const report = makeReport({ checks, findings: applied.findings, scope: scopeSummary(scope) })
  // ★ P0 暴露的坑（P1-T8 一次写全）：`baselineGrowth` 的第二道护栏（豁免红灯的条数）需要
  //   `history.baselineRedCount` —— 此前**只读不写**（台账里没有该键）⇒ 第二道护栏形同不存在。
  //   现在两侧都接线：值由人工写进 versions.json#history（与 baselineCount 同段），这里读它。
  const growth = baselineGrowth({
    baseline,
    recordedCount: versions?.history?.baselineCount ?? null,
    recordedRedCount: versions?.history?.baselineRedCount ?? null,
  })
  if (growth) {
    // BASE：基线条目数超过登记值 → 红。没有它，基线会变成"遇红就塞"的垃圾桶。
    const exceeded = growth.exceeded ?? growth.redExceeded
    const what = growth.exceeded !== null && growth.exceeded !== undefined ? '条目总数' : '豁免红灯的条目数'
    report.findings.push({
      rule: 'BASE', severity: RED, subject: 'drift-baseline.entries',
      expected: growth.exceeded !== null && growth.exceeded !== undefined ? String(growth.recordedCount) : String(growth.recordedRedCount),
      actual: String(exceeded),
      hint: `基线的${what}超过了每次签入时登记的数量（versions.json#history.baselineCount / baselineRedCount）：基线是"已知欠账"，不是"遇红就塞"`,
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
  // 契约快照摘要（P1-T9）：口径与 `--verbose` 里 CT 规则的 evaluated 同源 —— 数字对不上时一眼可见
  const c = v.channels && typeof v.channels === 'object' ? v.channels : {}
  const ipcCount = Object.values(c.ipc || {}).reduce((n, a) => n + (Array.isArray(a) ? a.length : 0), 0)
  return {
    versions: {
      lines: (v.lines || []).length, contracts: (v.contracts || []).length,
      skills: (v.skills || []).length, skillsLock: (v.skillsLock?.ids || []).length,
      commonTools: (v.commonTools?.entries || []).length,
      channels: {
        routes: Object.keys(c.routes || {}).length,
        routePrefixes: Object.keys(c.routePrefixes || {}).length,
        wsOut: (c.wsOut || []).length, wsIn: (c.wsIn || []).length, ipc: ipcCount,
        tools: Object.keys(c.tools || {}).length, staticToolCount: c.staticToolCount ?? null,
        excluded: (c.excluded || []).length, scopeCount: c.scopeCount ?? null, scopeRedCount: c.scopeRedCount ?? null,
      },
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
 * 契约侧同理：CT0–CT12 的 evaluated 与台账规模里的 channels 计数必须能互相对照。
 */
function renderRuleTable(report, sizes) {
  const lines = ['', `规则逐条（${report.checks.length}）`]
  for (const c of report.checks) {
    lines.push(`  ${c.passed ? '✔' : '✘'} [${c.rule}] ${c.title}  evaluated=${c.evaluated}`)
  }
  lines.push('', `台账规模：versions ${JSON.stringify({ ...sizes.versions, channels: undefined })}`)
  lines.push(`          channels ${JSON.stringify(sizes.versions.channels)}`)
  lines.push(`          deps ${JSON.stringify(sizes.deps)}`)
  return lines.join('\n')
}

/**
 * sync：把**提交态（HEAD）复算出来的契约快照**写进 `versions.json#channels`（P1-T6/T10）。
 * 三条纪律：
 *   · **快照取自提交态**（第 3 批）：台账是**提交物**，与 CI 的干净检出同口径 ⇒ 脏工作树里跑
 *     sync **不会**把在途改动写进台账（工作树 ∖ HEAD 的差异由 `kit:check` 的 CT8 逐条报黄，
 *     并在下面如实打印条数，免得人以为"sync 过了 = 在途端点已入账"）；
 *   · `snapshotAt` **幂等**：机器字段没变时保留旧时间戳（否则每次 sync 都产生无意义 diff，
 *     "提交 channels 变化"这条约定会被噪声淹没）；
 *   · **绝不写 `contract-scope.json`**（人工文件）—— 这里只读它做摘要打印。
 *     `kit/cli.test.mjs` 断言"sync 前后 scope 文件逐字节不变"。
 */
async function runSync({ dryRun }) {
  const files = trackedFiles({ root: ROOT })
  const read = (f) => readTracked({ root: ROOT, file: f })
  const head = materializeHead({ root: ROOT })
  const headRoot = head.available ? head.dir : ROOT
  const headFiles = head.available ? head.files : files
  const readHead = head.available ? (f) => readTracked({ root: headRoot, file: f }) : read
  const prev = readVersions({ root: ROOT }) || {}
  const before = prev.channels && typeof prev.channels === 'object' ? prev.channels : null
  const live = await buildSnapshot({ root: headRoot, files: headFiles, readTracked: readHead })
  const same = before ? diffSnapshot(before, live).equal : false
  const channels = { ...live, snapshotAt: same && before.snapshotAt ? before.snapshotAt : live.snapshotAt }
  // 在途差异只报数（逐条明细是 check 的 CT8 的职责）：主体是**没被落盘**这件事
  const workSnap = await buildSnapshot({ root: ROOT, files, readTracked: read })
  const inflight = diffSnapshot(live, workSnap).diffs.length

  // syncVersions/syncDeps 都是"重写台账"的操作；--dry-run 时两者都不落盘（测试已钉住）。
  const v = syncVersions({ root: ROOT, files, dryRun, channels })
  const d = syncDeps({ root: ROOT, files, dryRun })
  // Task 9：lock 重算走真实现（此前是 `{updated:[],unchanged:[],missing:[]}` 占位 —— 占位期间
  // 跑 sync 也不会重算哈希，V7 的 20 条红灯永远擦不掉）。
  // 三件事都认 dryRun：预演**不得**落盘（否则"预演"会把仓库改到一半）。
  const lock = syncSkillsLock({ root: ROOT, files, dryRun })
  const data = d.data
  const scope = loadScope({ root: ROOT })
  const snapDiff = before ? diffSnapshot(before, live) : { equal: false, diffs: [] }
  return {
    lines: [
      `versions: lines ${v.data.lines.length} / contracts ${v.data.contracts.length} / skills ${v.data.skills.length} / lockIds ${v.data.skillsLock.ids.length} / commonPy ${v.data.commonTools.entries.length}`,
      `  added ${v.added.length}  removed ${v.removed.length}`,
      ...(v.added.length ? [`  + ${v.added.join('\n  + ')}`] : []),
      ...(v.removed.length ? [`  - ${v.removed.join('\n  - ')}`] : []),
      // 契约快照：**每次 sync 都打印规模与"变没变"** —— 端点搬家/新增后必须由人确认并提交 channels 变化
      `channels: routes ${Object.keys(live.routes).length} / prefixes ${Object.keys(live.routePrefixes).length} / wsOut ${live.wsOut.length} / wsIn ${live.wsIn.length}`
        + ` / ipc ${Object.values(live.ipc).reduce((n, a) => n + a.length, 0)} / tools ${Object.keys(live.tools).length} / excluded ${live.excluded.length}`,
      `  ${same ? '快照无变化（保留 snapshotAt）' : `快照已更新（机器字段差异 ${snapDiff.diffs.length} 处）`}`,
      ...[...new Set(snapDiff.diffs.map((x) => x.kind))].sort().map((k) => `    ~ ${k}：${snapDiff.diffs.filter((x) => x.kind === k).length} 处`),
      // ★ 在途差异**只报数、不落盘**：台账按提交态生成（口径见 kit/README.md）。若这里静默，
      //   人会以为"跑过 sync = 在途端点已入账"。逐条明细在 `check` 的 CT8（黄灯）。
      inflight === 0
        ? '  工作树与提交态的契约面一致（无在途差异）'
        : `  ⚠ 工作树有 ${inflight} 处在途契约差异**未落盘**（台账按提交态生成）：先提交再 sync；明细见 npm run kit:check 的 CT8`,
      // scope 是**人工**文件：这里只报它多大，绝不改写（判据在 cli.test.mjs 的逐字节断言）
      `scope（人工维护，本次未改写）: ${scope.entries.length} 组 / ${scope.entries.reduce((n, e) => n + e.members.length, 0)} 键${scope.present ? '' : '（文件不存在）'}`,
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
    const report = await buildReport()
    if (asJson) console.log(JSON.stringify(report, null, 2))
    else {
      console.log(renderHuman(report))
      if (verbose) console.log(renderRuleTable(report, ledgerSizes()))
      // ★ 在途差异（CT8）**恒打印一行**：契约规则的判据取自提交态 ⇒ "工作树还有哪些契约改动没提交"
      //   是读者必须一眼知道的事。空的时候也要**明说"无"**（"没打印"与"没有差异"不是一回事）。
      //   ★ 域必须自报（第 4 批）：CT8 的工作树侧 = **git 跟踪 + 未忽略的未跟踪文件**（含未 `git add`
      //   的新源文件）—— 不写清楚，读者会把这一行读成"连 `release/` 里的副本都算过了"。
      const inflight = report.findings.filter((f) => f.rule === 'CT8')
      const CT8_DOMAIN = '扫描域：git 跟踪 + 未忽略的未跟踪文件'
      console.log(`\n（契约）在途差异（CT8，黄、只报不拦）：${inflight.length
        ? `${inflight.length} 条 —— 工作树 ∖ HEAD，逐条见上方黄灯段（${CT8_DOMAIN}）`
        : `无 —— ${CT8_DOMAIN}，与 HEAD 契约面一致`}`)
      if (report.baselineUnused?.length) console.log(`\n（信息）基线中 ${report.baselineUnused.length} 条未生效或已不再命中，可摘除：${report.baselineUnused.join(', ')}`)
    }
    return report.ok ? 0 : 1
  }

  if (cmd === 'view') {
    const report = await buildReport()
    const payload = {
      schemaVersion: 1, generatedAt: report.generatedAt, ok: report.ok, summary: report.summary,
      ledgers: ledgerSizes(), scope: report.scope, findings: report.findings,
    }
    console.log(asJson
      ? JSON.stringify(payload, null, 2)
      : `${renderHuman(makeReport({ checks: [], findings: report.findings, scope: report.scope }))}\n\n${renderRuleTable(report, ledgerSizes())}`)
    // view 是"查看"：契约恒 0（门禁退出码只在 check 上）。测试已钉住这条反向断言。
    return 0
  }

  if (cmd === 'sync') {
    const problems = syncPreconditions()
    if (problems.length) {
      console.error(`sync 前置条件不满足：\n  - ${problems.join('\n  - ')}`)
      return 1
    }
    const r = await runSync({ dryRun: rest.includes('--dry-run') })
    console.log(r.lines)
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
