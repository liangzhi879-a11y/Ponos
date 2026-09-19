// 版本升级脚本（开发流程强制入口）——升级版本号禁止手改文件。
// ---------------------------------------------------------------------------
// 用法：
//   node scripts/bump-version.mjs app 3.0.1     # Ponos 应用（turbo 内核版）
//   node scripts/bump-version.mjs kernel 0.2    # Ponos-Turbo 内核（同步 kernel/package.json）
//   node scripts/bump-version.mjs pkg 2.9.0     # GUI 发布线（package.json version）
//   node scripts/bump-version.mjs app 3.0.1 --dry-run   # 演练：只打印将发生的改动
// 版本格式：dev <major>.<minor>[.<patch>]（发布稳定后去掉 dev 前缀）。
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

// 校验当前值并生成替换
// 注意：第一个参数是**文件路径**（按路径读原文、按路径写回）。
// 早期版本把"文件内容"当路径传给了 writeFileSync —— 于是 version.mjs 实际写不进去：
// 真跑直接 EXIT=1（路径里含换行/中文，写入抛错），而 --dry-run 与只读校验看不出来。
const patch = (path, from, to, what) => {
  const file = readFileSync(path, 'utf8')
  if (!file.includes(from)) fail(`${what}: 未找到待替换文本 "${from}"`)
  if (!dryRun) writeFileSync(path, file.replace(from, to), 'utf8')
  console.log(`[bump] ${dryRun ? '[演练] ' : ''}${what}: '${from}' -> '${to}'`)
}

// ── ① 宿主文件：version.mjs 常量 或 package.json 的 version ─────────────────
let currentValue = ''
if (bump.const) {
  const vm = readFileSync(VERSION_MJS, 'utf8')
  const cur = vm.match(new RegExp(`export const ${bump.const} = '([^']+)'`))?.[1]
  if (!cur) fail(`version.mjs 中未找到 ${bump.const} 常量`)
  currentValue = cur
  patch(VERSION_MJS, `export const ${bump.const} = '${cur}'`, `export const ${bump.const} = '${ver}'`, `version.mjs ${bump.const}`)
} else {
  const pkg = JSON.parse(readFileSync(PKG_JSON, 'utf8'))
  currentValue = pkg.version
  patch(PKG_JSON, `"version": "${pkg.version}"`, `"version": "${ver}"`, 'package.json version')
}

// ── ② 同步测试期望值（A5）──────────────────────────────────────────────────
// A5 之前 server/version.test.mjs **不存在**，这个分支永远走 else —— 版本断言实际不存在，
// 改版本号不会让任何测试变红（"同步测试期望值"是死路径）。该文件现已存在，故这里是真实路径。
// 判据是**字面替换**：故该文件里的断言行必须严格保持 `assert.equal(CONST, '旧值')` 单行单引号形态，
// 失了形态就在这儿 fail（宁可发版被卡住，也不要静默跳过而留下过期断言）。
if (bump.const && existsSync(VERSION_TEST)) {
  patch(VERSION_TEST, `assert.equal(${bump.const}, '${currentValue}')`, `assert.equal(${bump.const}, '${ver}')`, `server/version.test.mjs ${bump.const} 断言`)
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
    const pkgSrc = readFileSync(KERNEL_PKG, 'utf8')
    const nextSrc = pkgSrc.replace(`"version": "${pkg.version}"`, `"version": "${semver}"`)
    if (nextSrc === pkgSrc) fail('kernel/package.json: version 字段未找到')
    if (!dryRun) writeFileSync(KERNEL_PKG, nextSrc, 'utf8')
    console.log(`[bump] ${dryRun ? '[演练] ' : ''}kernel/package.json version: '${pkg.version}' -> '${semver}'`)
  } else {
    console.log(`[bump] kernel/package.json version 已一致（'${semver}'），无需改动`)
  }
}

// ── ④ 台账同步（值 + history.records）──────────────────────────────────────
// A3 的实质：V3（历史链连续 + 末条 to == 当前值）**只读 history.records**。
// 若 bump 不写历史，V3 的 evaluated 恒为 0 —— 换版本号没人记账，门禁形同不存在。
//
// 顺序很重要 —— 先追加历史记录再 sync：sync 会用**已含记录**的 prev 作合并基底，
// 于是写出的值必然等于末条记录的 to，V3 当场成立。
if (existsSync(VERSIONS_LEDGER) && !dryRun) {
  try {
    const { readVersions, writeVersions, syncVersions } = await import('../kit/lib/ledger.mjs')
    const ledger = readVersions({ root: ROOT })
    const key = bump.ledgerKeyOf()
    const entry = [...(ledger.lines || []), ...(ledger.contracts || [])].find((e) => `${e.id}@${e.file}` === key)
    ledger.history = ledger.history || { baselineCount: 0, records: [] }
    ledger.history.records = ledger.history.records || []
    ledger.history.records.push({
      key,
      from: entry ? String(entry.value) : String(currentValue),
      to: ver,
      at: new Date().toISOString().slice(0, 10),
      reason: 'bump-version.mjs',
    })
    ledger.history.baselineCount = ledger.history.baselineCount ?? 0
    writeVersions({ root: ROOT, data: ledger })
    syncVersions({ root: ROOT })
    console.log(`[bump] kit/manifest/versions.json 已同步（history.records + ${key}）`)
  } catch (e) {
    fail(`台账同步失败：${e.message}（版本号已改，请手跑 npm run kit:sync 后重试）`)
  }
} else if (!existsSync(VERSIONS_LEDGER)) {
  console.log('[bump] 未发现 kit/manifest/versions.json（本仓未建台账），跳过台账同步')
}

console.log(`[bump] ${dryRun ? '[演练完成] ' : '完成 '}${label}: ${currentValue} -> ${ver}`)
