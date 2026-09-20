#!/usr/bin/env node
// scripts/brand.mjs —— 品牌「可重新定义」的入口（品牌标识与名称的统一管理）
//
// 三个子命令（零依赖；不联网、不碰 git、不碰 src/** 与 server/**）：
//   · `show`                    打印品牌真源（层级名 + 8 条声明点 + 废弃别名 + 已知广泛存在）
//   · `check`                   ★ 跑 CT10 的判据，读**工作树**（"现在这棵树改完没有"的即时反馈）
//   · `set <layer> <name>`      ★ 重新定义：改 `kit/manifest/brand.json` 的 layers[] 名，
//                               然后**自动同步可以安全同步的声明点**（version.mjs 的注释行、
//                               versions.json 的 lines[].label），最后打印**仍需手工改的声明点**
//                               （安装身份/窗口标题等改了会影响安装身份 ⇒ 不自动改，只给建议值）
//
// 为什么 `check` 读工作树而门禁 CT10 读提交态：两者的职责不同 ——
//   · 门禁（`npm run kit:check` 的 CT10）与其它 CT 同口径读**提交态**：CI 在干净检出上跑，
//     判定必须可复现、且不被别人未提交的编辑干扰；
//   · 本工具是**本机操作入口**：刚 `set` 完或刚改完文件时，你要的是"现在改完没有" ⇒ 读工作树。
//   两者判据是**同一份实现**（`brandCheck`），只有"读哪棵树"不同 —— 不存在两套口径。
//
// 退出码：0 = 通过 / 1 = 有红或有错 / 2 = 用法错（未知子命令、层名不合法、缺参数）。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readTracked, trackedFiles } from '../kit/lib/scan.mjs'
import { brandCheck, loadBrandTruth, describeExpects, layerName, BRAND_TRUTH, REQUIRED_DECLARATIONS } from '../kit/lib/brand-rules.mjs'

/** 仓根：`--root` > `YFW_KIT_ROOT` > 本脚本所在仓 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const USAGE = `用法：node scripts/brand.mjs <show|check|set> [选项]

  show                    打印品牌真源（${BRAND_TRUTH}）：层级名 + 8 条声明点 + 废弃别名 + 已知广泛存在
  check                   按 CT10 的判据检查**工作树**（每条声明点一行：✔/✘ + 文件 + 期望 + 实际；有红 ⇒ exit 1）
  set <layer> <name>      重新定义某层名：改真源 + 同步可安全同步的声明点，再列出**仍需手工改**的声明点

选项：
  --root <dir>            指定仓根（默认：${REPO_ROOT}；也认环境变量 YFW_KIT_ROOT）

★ 与门禁的分工（同判据、不同树）：
  本工具 check 读**工作树**（改完立刻能看）；\`npm run kit:check\` 的 CT10 读**提交态**
  （CI 与评审克隆的口径）⇒ 改完品牌记得**提交**，否则门禁那边还看不到。
  另：全仓还有一批 \`Ponos-Turbo\` 散在 kernel/、kernel-tests/ 与 docs 的**叙述文本**里
  （规模见 \`brand show\` 的"已知广泛存在"，数字以真源登记的 \`recompute\` 命令为准 —— 别信写死的数），
  那是独立工作项 —— 门禁只查**受管声明点**，不扫全仓。`

/** 解析 argv：子命令 + 位置参数 + --root（不引参数解析库：只有这一种选项） */
function parseArgs(argv) {
  const pos = []
  let root = process.env.YFW_KIT_ROOT || REPO_ROOT
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') {
      if (!argv[i + 1]) return { error: '--root 后面要跟目录' }
      root = resolve(argv[i + 1]); i++
    } else if (argv[i].startsWith('--')) {
      return { error: `未知选项：${argv[i]}` }
    } else pos.push(argv[i])
  }
  return { cmd: pos[0] || null, args: pos.slice(1), root }
}

const reader = (root) => (f) => readTracked({ root, file: f })

function die(msg, code = 2) {
  process.stderr.write(`${msg}\n\n${USAGE}\n`)
  process.exit(code)
}

/** 真源里"该层"的名字（`show`/`set` 共用；不在真源里 ⇒ null） */
const nameOf = (truth, id) => layerName(truth.layers, id)

// ── show ────────────────────────────────────────────────────────────────────

function cmdShow({ root }) {
  const { truth, problems } = loadBrandTruth({ readTracked: reader(root) })
  if (truth === null) die(`读不到品牌真源 ${BRAND_TRUTH}（在 ${root} 下）：${problems.join('；')}\n先补上真源再看它。`, 1)
  const out = []
  out.push(`品牌真源：${BRAND_TRUTH}（在 ${root}）`)
  out.push('')
  out.push('层级名：')
  for (const l of truth.layers || []) out.push(`  ${l.id.padEnd(8)} ${l.name}   ${l.note || ''}`)
  if (truth.brandZh) out.push(`中文品牌名：${truth.brandZh.name}   ${truth.brandZh.where || ''}`)
  out.push('')
  out.push(`声明点（${(truth.declarations || []).length} 条；判据见 CT10）：`)
  for (const d of truth.declarations || []) {
    out.push(`  ${d.id.padEnd(18)} ${String(d.file).padEnd(26)} ${String(d.kind).padEnd(14)} 期望 ${describeExpects(d, truth.layers)}`)
    if (d.why) out.push(`    ${' '.repeat(16)}为什么算声明点：${d.why}`)
  }
  out.push('')
  out.push('废弃别名（受管声明点里出现即红）：')
  for (const a of truth.retiredAliases || []) out.push(`  ${a.alias} → ${a.replaceWith}（层 ${a.layer}）${a.why || ''}`)
  out.push('')
  out.push('已知广泛存在（**不在门禁范围**，独立工作项）：')
  for (const k of truth.knownWidespread || []) {
    const c = k.counts || {}
    const ex = c.exactCaseSensitive
    const fam = c.aliasFamily
    const parts = []
    if (ex) parts.push(`精确写法 ${ex.lines} 处 / ${ex.files} 个文件`)
    if (fam) parts.push(`含各种写法共 ${fam.lines} 处 / ${fam.files} 个文件`)
    if (c.aliasFamilyInKernelDocs) parts.push(`其中 kernel+kernel-tests+docs ${c.aliasFamilyInKernelDocs.files} 个文件`)
    const at = k.measuredAt ? `（@${k.measuredAt} 量的**快照**，会漂移 —— 要当前值就按下面的命令自己跑）` : ''
    out.push(`  ${k.alias}：${parts.join('；') || '（真源未登记规模）'}${at}`)
    out.push(`    不在本门禁范围的理由：${k.why}`)
    if (k.whyNotGated) out.push(`    为什么不纳入：${k.whyNotGated}`)
    if (k.recompute) out.push(`    复算：${k.recompute}`)
  }
  out.push('')
  out.push('下一步：')
  out.push('  node scripts/brand.mjs check                       # 现在这棵树改完没有（读工作树）')
  out.push('  node scripts/brand.mjs set <layer> <name>          # 重新定义某层名（改真源 + 同步能同步的）')
  out.push('  npm run kit:check                                  # 门禁（CT10 读提交态 ⇒ 改完要提交）')
  if (problems.length) {
    out.push('')
    out.push(`⚠ 真源结构问题（CT10 会因此报红）：${problems.join('；')}`)
  }
  process.stdout.write(out.join('\n') + '\n')
  return problems.length ? 1 : 0
}

// ── check（读工作树）────────────────────────────────────────────────────────

function cmdCheck({ root }) {
  // ★ 非 git 仓（临时夹具目录）也要能跑：`files` 只用于把"读不到"讲清楚（是文件缺失，还是不在扫描域），
  //   取不到就传 null —— 判据本身只看文件内容。
  let files = null
  try { files = trackedFiles({ root }) } catch { files = null }
  const out = brandCheck({ readTracked: reader(root), files })
  const { truth } = loadBrandTruth({ readTracked: reader(root) })
  const decls = (truth && truth.declarations) || []
  const badFor = (id) => out.findings.filter((f) => f.subject === id)
  const truthProblems = out.findings.filter((f) => f.subject === 'brand.json')

  const lines = []
  lines.push(`品牌声明点检查（CT10 判据，读**工作树**：${root}）`)
  lines.push('')
  for (const f of truthProblems) lines.push(`✘ 真源  ${BRAND_TRUTH}  ${f.actual}`)
  for (const d of decls) {
    const bad = badFor(d.id)
    if (!bad.length) {
      lines.push(`✔ ${d.id.padEnd(18)} ${d.file}   期望 ${describeExpects(d, truth.layers)}`)
      continue
    }
    for (const f of bad) {
      lines.push(`✘ ${d.id.padEnd(18)} ${f.file}${f.line ? ':' + f.line : ''}`)
      lines.push(`   期望 ${f.expected}`)
      lines.push(`   实际 ${f.actual}`)
      lines.push(`   → ${f.hint}`)
    }
  }
  lines.push('')
  lines.push(`小计：${decls.length - new Set(decls.map((d) => d.id).filter((id) => badFor(id).length)).size} / ${decls.length} 条已跟上真源`
    + `；evaluated=${out.check.evaluated}，passed=${out.check.passed}`)
  lines.push('★ 门禁（`npm run kit:check` 的 CT10）读的是**提交态** ⇒ 这里绿了之后记得提交，否则 CI 还看不到。')
  // ★ 反向也要说清（复核审查指出只提示了一个方向）：这里红、门禁却可能是绿的 —— 因为工作树与 HEAD 不同。
  //   不点明的话，人会以为"门禁绿 = 没问题"，然后带着未提交的品牌漂移继续干活。
  if (out.findings.length) {
    lines.push('★ 反过来：这里有红**不等于** `kit:check` 会红 —— 门禁看的是**已提交**的内容。'
      + '所以"当下状态"以本命令为准、"提交后会不会被拦"以 `npm run kit:check` 为准（两者互补，别只看一个）。')
  }
  process.stdout.write(lines.join('\n') + '\n')
  return out.findings.length ? 1 : 0
}

// ── set（重新定义）──────────────────────────────────────────────────────────

/** 把 `version.mjs` 里"含该常量名的那行注释"整行替换成新文本（行尾换行符原样保留） */
function syncCommentLine({ root, file, constName, text }) {
  const raw = readTracked({ root, file })
  if (raw === null) return { file, ok: false, why: '文件读不到' }
  const lines = raw.split('\n')
  const idx = lines.findIndex((l) => /^[ \t]*\/\//.test(l) && l.includes(constName))
  if (idx < 0) return { file, ok: false, why: `没有含 "${constName}" 的那行注释` }
  const cr = lines[idx].endsWith('\r') ? '\r' : ''
  const before = lines[idx]
  lines[idx] = text + cr
  if (before === lines[idx]) return { file, ok: true, changed: false, line: idx + 1, text }
  writeFileSync(join(root, file), lines.join('\n'))
  return { file, ok: true, changed: true, line: idx + 1, text }
}

/**
 * 把台账 `lines[]` 里某条的 `label` 换成新文本。
 * ★ 只改那一行的**值**（不动 JSON 结构与行尾）：`versions.json` 是 sync 的产物、体量大，
 *   整份 re-stringify 会引入与品牌无关的全文件 diff。
 */
function syncLedgerLabel({ root, file, id, text }) {
  const raw = readTracked({ root, file })
  if (raw === null) return { file, ok: false, why: '文件读不到（先跑 kit:sync 生成台账）' }
  const lines = raw.split('\n')
  const idRe = /"id"\s*:\s*"([^"]*)"/
  const labelRe = /^([ \t]*"label"[ \t]*:[ \t]*")((?:\\.|[^"\\])*)(".*)$/
  let lastId = null
  for (let i = 0; i < lines.length; i++) {
    const m = idRe.exec(lines[i])
    if (m) lastId = m[1]
    if (lastId !== id) continue
    const lm = labelRe.exec(lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i])
    if (!lm) continue
    const next = `${lm[1]}${text.replace(/"/g, '\\"')}${lm[3]}` + (lines[i].endsWith('\r') ? '\r' : '')
    if (next === lines[i]) return { file, ok: true, changed: false, line: i + 1, text }
    lines[i] = next
    writeFileSync(join(root, file), lines.join('\n'))
    return { file, ok: true, changed: true, line: i + 1, text }
  }
  return { file, ok: false, why: `lines[] 里没有 id=${id} 那条（或它没有 label）` }
}

function cmdSet({ root, args }) {
  const [layer, name] = args
  const { truth, problems } = loadBrandTruth({ readTracked: reader(root) })
  if (truth === null) die(`读不到品牌真源 ${BRAND_TRUTH}（在 ${root} 下）：${problems.join('；')}`, 1)
  const layerIds = (truth.layers || []).map((l) => l.id)
  if (!layer || !name) die('set 需要两个参数：<layer> <name>（层名必须是 app / kernel）')
  if (!layerIds.includes(layer)) {
    die(`层名不合法："${layer}" —— 真源里的层是 ${layerIds.join(' / ')}（应用层 = app、内核层 = kernel）`)
  }
  // 1) 改真源（保留其余字段与格式：JSON.stringify(…, 2) 与本仓 `writeJson` 同口径）
  const before = JSON.stringify(truth, null, 2) + '\n'
  const next = JSON.parse(before)
  const target = next.layers.find((l) => l.id === layer)
  const oldName = target.name
  target.name = name
  const after = JSON.stringify(next, null, 2) + '\n'
  // 只改那一行的值：把 `"name": "<旧>"` 在**该层**的那一行换掉（避免整份重排）
  const raw = readTracked({ root, file: BRAND_TRUTH })
  const lines = raw.split('\n')
  const idRe = /"id"\s*:\s*"([^"]*)"/
  let lastId = null
  let done = false
  for (let i = 0; i < lines.length; i++) {
    const m = idRe.exec(lines[i])
    if (m) lastId = m[1]
    const nm = /^([ \t]*"name"[ \t]*:[ \t]*")((?:\\.|[^"\\])*)(".*)$/.exec(lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i])
    if (lastId === layer && nm) {
      lines[i] = `${nm[1]}${name.replace(/"/g, '\\"')}${nm[3]}` + (lines[i].endsWith('\r') ? '\r' : '')
      done = true
      break
    }
  }
  if (!done) die(`真源里找不到层 ${layer} 的 name 字段（真源结构可能被改坏了）`, 1)
  writeFileSync(join(root, BRAND_TRUTH), lines.join('\n'))
  void after

  const appName = nameOf(next, 'app')
  const kernelName = nameOf(next, 'kernel')
  const appLabel = `${appName} 应用（${kernelName} 内核版）`
  const kernelLabel = `${kernelName} 内核`

  // 2) 同步"可安全同步"的声明点：其文本由层名**拼出来**、且不影响安装身份
  const synced = [
    syncCommentLine({ root, file: 'version.mjs', constName: 'APP_VERSION', text: `//   1. APP_VERSION     — ${appLabel}` }),
    syncCommentLine({ root, file: 'version.mjs', constName: 'KERNEL_VERSION', text: `//   2. KERNEL_VERSION  — ${kernelLabel}，独立可运行` }),
    syncLedgerLabel({ root, file: 'kit/manifest/versions.json', id: 'APP_VERSION', text: appLabel }),
    syncLedgerLabel({ root, file: 'kit/manifest/versions.json', id: 'KERNEL_VERSION', text: kernelLabel }),
  ]

  // 3) 打印"仍需手工改的声明点"（改了会影响安装身份/发布身份 ⇒ 不自动改，只给建议值）
  const manual = [
    { id: 'product-name', file: 'electron-builder.yml', suggest: `productName: ${appName}`, why: '安装产品名（用户可见，但它是**安装身份**的一部分：改了会让升级/并存行为变化，必须人确认）' },
    { id: 'window-title', file: 'index.html', suggest: `<title>${appName}</title>`, why: '窗口标题（只影响界面显示，但它是 .html 的正文 —— 自动改 HTML 正文属于"越界改别人的文件"，留人工）' },
    { id: 'npm-name', file: 'package.json', suggest: `"name": "${truth.declarations.find((d) => d.id === 'npm-name')?.expects?.literal ?? '(见真源)'}"（按需改）`, why: 'npm 包名是**发布身份**：重新定义显示名通常不该改它' },
    { id: 'app-id', file: 'electron-builder.yml', suggest: `appId: ${truth.declarations.find((d) => d.id === 'app-id')?.expects?.literal ?? '(见真源)'}（按需改）`, why: 'appId 是**安装识别的唯一键**：改了就是换产品身份（与在售产品的覆盖升级关系会断）' },
  ]
  const out = []
  out.push(`已重新定义：层 ${layer} 的名称 ${oldName} → ${name}`)
  out.push(`  真源：${BRAND_TRUTH}`)
  out.push('')
  out.push('已自动同步的声明点（文本由层名拼出、不影响安装身份）：')
  for (const r of synced) {
    out.push(r.ok
      ? `  ${r.changed === false ? '=' : '✔'} ${r.file}${r.line ? ':' + r.line : ''}  ${r.text}`
      : `  ✘ ${r.file}  ${r.why}`)
  }
  out.push('')
  out.push('仍需手工改的声明点（自动改会影响安装/发布身份 ⇒ 只给建议）：')
  for (const m of manual) out.push(`  · ${m.id.padEnd(14)} ${m.file} → ${m.suggest}\n      ${m.why}`)
  out.push('')
  out.push('★ 还有一个**生成点**是 sync 会覆盖的（不在上面 8 条声明点内，但改品牌时必须同改）：')
  out.push(`  · kit/lib/ledger.mjs 的 LINE_SPECS：APP_VERSION.label = "${appLabel}"、KERNEL_VERSION.label = "${kernelLabel}"`)
  out.push('    （versions.json 的 label 由它重写 ⇒ 不改它，下一次 `npm run kit:sync` 会把标签改回去）')
  out.push(`  · scripts/bump-version.mjs 的控制台标签：app = "${appLabel}"、kernel = "${kernelLabel}"（同源文案，人手维护）`)
  out.push('')
  out.push('下一步：node scripts/brand.mjs check  →  改上面几条  →  提交  →  npm run kit:check')
  process.stdout.write(out.join('\n') + '\n')
  return 0
}

// ── 入口 ────────────────────────────────────────────────────────────────────

const parsed = parseArgs(process.argv.slice(2))
if (parsed.error) die(parsed.error)
if (!parsed.cmd) die('缺子命令')
if (!['show', 'check', 'set'].includes(parsed.cmd)) die(`未知子命令：${parsed.cmd}`)
// ★ 多余参数不再静默忽略（复核审查抓到：`set app X 额外` 会 exit 0 让人以为生效了）。
//   允许的位置参数个数：`set` 是 2（层 + 新名），`show`/`check` 是 0；其余一律报错退出。
const allowedPositionals = parsed.cmd === 'set' ? 2 : 0
const extra = (parsed.args || []).slice(allowedPositionals)
if (extra.length) {
  die(`多余参数：${extra.join(' ')} —— ${parsed.cmd} 只接受 ${allowedPositionals} 个位置参数（可用选项：--root <dir>）`)
}
const code = parsed.cmd === 'show' ? cmdShow(parsed)
  : parsed.cmd === 'check' ? cmdCheck(parsed)
    : cmdSet(parsed)
process.exit(code)
