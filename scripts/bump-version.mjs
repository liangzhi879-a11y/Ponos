// 版本升级脚本（开发流程强制入口）——升级版本号禁止手改文件。
// ---------------------------------------------------------------------------
// 用法：
//   node scripts/bump-version.mjs app 3.0.1     # Ponos 应用（turbo 内核版）
//   node scripts/bump-version.mjs kernel 0.2    # Ponos-Turbo 内核（同步 kernel/package.json）
//   node scripts/bump-version.mjs pkg 2.9.0     # GUI 发布线（package.json version）
//   node scripts/bump-version.mjs app 3.0.1 --dry-run   # 演练：只打印将发生的改动
// 版本格式：dev <major>.<minor>[.<patch>]（发布稳定后去掉 dev 前缀）。
//   ★ 例外：`pkg` 目标的宿主是 npm 的 package.json，**不带** dev 前缀 —— 它必须是合法 semver
//     （`app-builder-lib` 对非 semver 抛 `Invalid major number`；`semver.major('dev 2.9.0')` 实测抛错），
//     照"一律 dev 前缀"改回去会直接打断 GUI 发布线。见 spec §10 的 A2 行。
// 自动同步位置：
//   - version.mjs 常量（APP_VERSION / KERNEL_VERSION）
//   - server/version.test.mjs 期望值断言（A5 后该文件已存在，分支不再跳过）
//   - package.json version（仅 pkg 目标：GUI 发布线，Vite 注入 __APP_VERSION__）
//   - kernel/package.json semver（仅内核线：'dev X.Y' -> 'X.Y.0'，'dev X.Y.Z' -> 'X.Y.Z'）
//   - kit/manifest/versions.json（值 + history.records；V3 要求版本变更必须留记录）
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const VERSION_MJS = join(ROOT, 'version.mjs')
const VERSION_TEST = join(ROOT, 'server', 'version.test.mjs')
const KERNEL_PKG = join(ROOT, 'kernel', 'package.json')
const PKG_JSON = join(ROOT, 'package.json')
const VERSIONS_LEDGER = join(ROOT, 'kit', 'manifest', 'versions.json')

// 三条可 bump 的版本线。`ledgerKeyOf()` 返回该线在 kit/manifest/versions.json 里的台账键
// （`<id>@<file>`，与 ledger.mjs 的 keyOfVersion 同构）—— 台账同步靠它对号入座。
const TARGETS = {
  app: { const: 'APP_VERSION', label: 'Ponos 应用（turbo 内核版）', ledgerKeyOf: () => 'APP_VERSION@version.mjs' },
  kernel: { const: 'KERNEL_VERSION', label: 'Ponos-Turbo 内核', ledgerKeyOf: () => 'KERNEL_VERSION@version.mjs' },
  pkg: { jsonPath: 'version', label: 'GUI 发布线', ledgerKeyOf: () => 'GUI_VERSION@package.json' },
}

const [target, rawVer] = process.argv.slice(2)
const dryRun = process.argv.includes('--dry-run')

function fail(msg) {
  console.error(`[bump] ✗ ${msg}`)
  console.error('用法: node scripts/bump-version.mjs <app|kernel|pkg> <版本号> [--dry-run]')
  process.exit(1)
}

if (!Object.prototype.hasOwnProperty.call(TARGETS, target)) fail(`未知目标 "${target}"，应为 app、kernel 或 pkg`)
if (!rawVer) fail('缺少版本号')

// 归一化：dev 前缀可带可不带；统一为 'dev <semver>' 展示形式
const rawSemver = rawVer.startsWith('dev ') ? rawVer.slice(4) : rawVer.startsWith('dev') ? rawVer.slice(3) : rawVer
const semverPart = rawSemver.trim()
if (!/^\d+\.\d+(\.\d+)?$/.test(semverPart)) fail(`非法版本号 "${rawVer}"，应为 <major>.<minor>[.<patch>]`)
// ★ `pkg` 是 GUI **发布线**，宿主是 npm 的 package.json —— 值必须是合法 semver，
//   带 `dev ` 前缀会被 npm 判非法（打包/发布直接失败），故 pkg 目标不写 dev 前缀。
//   应用线/内核线是 dev 渠道标识，保持 'dev X.Y[.Z]'。
const ver = target === 'pkg' ? semverPart : `dev ${semverPart}`

const bump = TARGETS[target]
const label = bump.label

// ── 预检/落盘分离（Task 9 rider 2）──────────────────────────────────────────
// 原先这里是"边找边写"：某一路替换不到就 fail 退出，此时**前面的文件已经写过了** ——
// 仓库停在"改了四分之三"的半成品状态，且**重跑同命令不自愈**（第二次从新值去找旧文本，
// 必然再失败），只能手改。现在改为**先全量预检（所有待改文本都能找到）再统一落盘**：
// 任一路失败 → 一字节未落盘。落盘本身按"原内容 → 新内容"整文件写，便于失败时回滚。
// 注意：第一个参数是**文件路径**（按路径读原文、按路径写回）。
// 早期版本把"文件内容"当路径传给了 writeFileSync —— 于是 version.mjs 实际写不进去：
// 真跑直接 EXIT=1（路径里含换行/中文，写入抛错），而 --dry-run 与只读校验看不出来。
const planned = new Map()   // path -> { path, src, next, what }
const planReplace = (path, from, to, what) => {
  const prev = planned.get(path)
  const src = prev ? prev.next : readFileSync(path, 'utf8')
  if (!src.includes(from)) fail(`${what}: 未找到待替换文本 "${from}"`)
  planned.set(path, {
    path,
    src: prev ? prev.src : src,
    next: src.replace(from, to),
    what: prev ? `${prev.what} + ${what}` : what,
  })
  console.log(`[bump] ${dryRun ? '[演练] ' : ''}${what}: '${from}' -> '${to}'`)
}
/** 统一落盘；返回"真的改了内容"的文件（回滚要按这个清单恢复） */
const commitPlanned = () => {
  const written = [...planned.values()].filter((p) => p.next !== p.src)
  if (!dryRun) for (const p of written) writeFileSync(p.path, p.next, 'utf8')
  return written
}

// ── ① 宿主文件：version.mjs 常量 或 package.json 的 version ─────────────────
let currentValue = ''
if (bump.const) {
  const vm = readFileSync(VERSION_MJS, 'utf8')
  const cur = vm.match(new RegExp(`export const ${bump.const} = '([^']+)'`))?.[1]
  if (!cur) fail(`version.mjs 中未找到 ${bump.const} 常量`)
  currentValue = cur
  planReplace(VERSION_MJS, `export const ${bump.const} = '${cur}'`, `export const ${bump.const} = '${ver}'`, `version.mjs ${bump.const}`)
} else {
  const pkg = JSON.parse(readFileSync(PKG_JSON, 'utf8'))
  currentValue = pkg.version
  planReplace(PKG_JSON, `"version": "${pkg.version}"`, `"version": "${ver}"`, 'package.json version')
}

// ── ② 同步测试期望值（A5）──────────────────────────────────────────────────
// A5 之前 server/version.test.mjs **不存在**，这个分支永远走 else —— 版本断言实际不存在，
// 改版本号不会让任何测试变红（"同步测试期望值"是死路径）。该文件现已存在，故这里是真实路径。
// 判据是**字面替换**：故该文件里的断言行必须严格保持 `assert.equal(CONST, '旧值')` 单行单引号形态，
// 失了形态就在这儿 fail（宁可发版被卡住，也不要静默跳过而留下过期断言）。
if (bump.const && existsSync(VERSION_TEST)) {
  planReplace(VERSION_TEST, `assert.equal(${bump.const}, '${currentValue}')`, `assert.equal(${bump.const}, '${ver}')`, `server/version.test.mjs ${bump.const} 断言`)
} else if (!bump.const) {
  console.log('[bump] server/version.test.mjs：pkg 目标无版本常量断言，无需同步')
} else {
  console.log('[bump] 跳过 server/version.test.mjs（本仓无此文件）')
}

// ── ③ 内核线额外同步 kernel/package.json semver ─────────────────────────────
if (target === 'kernel') {
  const pkg = JSON.parse(readFileSync(KERNEL_PKG, 'utf8'))
  const semver = semverPart.split('.').length === 2 ? `${semverPart}.0` : semverPart
  if (pkg.version !== semver) {
    // 只替换那一处字符串，不做 JSON.stringify 重写：否则每次升级都会把 bin/engines
    // 这类单行对象展开成多行，制造一整片与版本无关的格式 diff。
    planReplace(KERNEL_PKG, `"version": "${pkg.version}"`, `"version": "${semver}"`, 'kernel/package.json version')
  } else {
    console.log(`[bump] kernel/package.json version 已一致（'${semver}'），无需改动`)
  }
}

// ── 预检 ④：台账必须与宿主一致（Task 9 rider 1，治理）────────────────────────
//
// ★ 修前的漏洞：history 记录的 `from` 取自**台账旧值**（`entry.value`）。于是"手改台账
//   （此时 V1 已红）→ 跑一次 bump → sync 后 V1/V3 全绿"，漂移被无声擦掉，history 里
//   还留下一段与事实不符的假历史。这与"基线抹平红灯""ghost 静默放行"同族：
//   用一次动作把检查结果擦干净。故本处**fail-loud**：台账 ≠ 宿主真值时拒绝 bump，
//   并把两个值都打出来（`from` 因此永远等于宿主真值，不可能记错）。
// 放在落盘之前：失败时宿主文件一字节未改，仓库不会停在半成品状态。
const ledgerKey = bump.ledgerKeyOf()
let ledgerLib = null
let ledger = null
let ledgerEntry = null
if (existsSync(VERSIONS_LEDGER)) {
  ledgerLib = await import('../kit/lib/ledger.mjs')
  ledger = ledgerLib.readVersions({ root: ROOT })
  ledgerEntry = ledger
    ? [...(ledger.lines || []), ...(ledger.contracts || [])].find((e) => `${e.id}@${e.file}` === ledgerKey) || null
    : null
  if (ledgerEntry && String(ledgerEntry.value) !== String(currentValue)) {
    fail(`台账与宿主不一致：${ledgerKey} 台账值 '${ledgerEntry.value}' ≠ 宿主真值 '${currentValue}'。`
      + '先跑 npm run kit:sync 或查因 —— 直接 bump 会把这段漂移写进 history 并顺手抹平（假历史 + 红灯消失）')
  }
}

// ── 落盘（到此为止全部预检已通过）───────────────────────────────────────────
const writtenFiles = commitPlanned()

// ── ⑤ 台账同步（值 + history.records）──────────────────────────────────────
// A3 的实质：V3（历史链连续 + 末条 to == 当前值）**只读 history.records**。
// 若 bump 不写历史，V3 的 evaluated 恒为 0 —— 换版本号没人记账，门禁形同不存在。
//
// 顺序很重要 —— 先追加历史记录再 sync：sync 会用**已含记录**的 prev 作合并基底，
// 于是写出的值必然等于末条记录的 to，V3 当场成立。
if (ledgerLib && ledger && !dryRun) {
  try {
    ledger.history = ledger.history || { baselineCount: 0, records: [] }
    ledger.history.records = ledger.history.records || []
    ledger.history.records.push({
      // 字段名是 `key`（`<id>@<file>`）：V3 按 `r.key` 分组，写成 spec 旧稿的 `id`
      // 会被归进 `undefined` 组 —— V3 根本不核它，静默失效（spec §5.1 已同步改正）。
      key: ledgerKey,
      // `from` 取**宿主真值**（上面已断言它与台账值相等）：绝不取"台账里那个可能已经漂移的值"
      from: String(currentValue),
      to: ver,
      at: new Date().toISOString().slice(0, 10),
      reason: 'bump-version.mjs',
    })
    ledger.history.baselineCount = ledger.history.baselineCount ?? 0
    ledgerLib.writeVersions({ root: ROOT, data: ledger })
    ledgerLib.syncVersions({ root: ROOT })
    console.log(`[bump] kit/manifest/versions.json 已同步（history.records + ${ledgerKey}）`)
  } catch (e) {
    // 台账是"另外一个文件"：它失败时把宿主文件回滚，避免留下"版本号改了、台账没改"
    // 的半成品（那正是 rider 2 要消灭的状态）。回滚用预检时留下的原内容。
    for (const p of writtenFiles) writeFileSync(p.path, p.src, 'utf8')
    fail(`台账同步失败：${e.message}（已回滚 ${writtenFiles.length} 个宿主文件，仓库状态未变；查因后重试）`)
  }
} else if (!existsSync(VERSIONS_LEDGER)) {
  console.log('[bump] 未发现 kit/manifest/versions.json（本仓未建台账），跳过台账同步')
}

console.log(`[bump] ${dryRun ? '[演练完成] ' : '完成 '}${label}: ${currentValue} -> ${ver}`)
