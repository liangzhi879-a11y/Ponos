// 版本升级脚本（开发流程强制入口）——升级版本号禁止手改文件。
// ---------------------------------------------------------------------------
// 用法：
//   node scripts/bump-version.mjs app 3.0.1     # Ponos 应用（turbo 内核版）
//   node scripts/bump-version.mjs kernel 0.2    # Ponos-Turbo 内核（同步 kernel/package.json）
//   node scripts/bump-version.mjs app 3.0.1 --dry-run   # 演练：只打印将发生的改动
// 版本格式：dev <major>.<minor>[.<patch>]（发布稳定后去掉 dev 前缀）。
// 自动同步位置：
//   - version.mjs 常量（APP_VERSION / KERNEL_VERSION）
//   - server/version.test.mjs 期望值断言
//   - kernel/package.json semver（仅内核线：'dev X.Y' -> 'X.Y.0'，'dev X.Y.Z' -> 'X.Y.Z'）
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const VERSION_MJS = join(ROOT, 'version.mjs')
const VERSION_TEST = join(ROOT, 'server', 'version.test.mjs')
const KERNEL_PKG = join(ROOT, 'kernel', 'package.json')

const [target, rawVer] = process.argv.slice(2)
const dryRun = process.argv.includes('--dry-run')

function fail(msg) {
  console.error(`[bump] ✗ ${msg}`)
  console.error('用法: node scripts/bump-version.mjs <app|kernel> <版本号> [--dry-run]')
  process.exit(1)
}

if (target !== 'app' && target !== 'kernel') fail(`未知目标 "${target}"，应为 app 或 kernel`)
if (!rawVer) fail('缺少版本号')

// 归一化：dev 前缀可带可不带；统一为 'dev <semver>' 展示形式
const ver = rawVer.startsWith('dev ') ? rawVer : rawVer.startsWith('dev') ? `dev ${rawVer.slice(3)}` : `dev ${rawVer}`
const semverPart = ver.replace(/^dev /, '')
if (!/^\d+\.\d+(\.\d+)?$/.test(semverPart)) fail(`非法版本号 "${rawVer}"，应为 <major>.<minor>[.<patch>]`)

const bump = target === 'app' ? { const: 'APP_VERSION' } : { const: 'KERNEL_VERSION' }
const label = target === 'app' ? 'Ponos 应用（turbo 内核版）' : 'Ponos-Turbo 内核'

// 校验当前值并生成替换
const vm = readFileSync(VERSION_MJS, 'utf8')
const cur = vm.match(new RegExp(`export const ${bump.const} = '([^']+)'`))?.[1]
if (!cur) fail(`version.mjs 中未找到 ${bump.const} 常量`)
const patch = (file, from, to, what) => {
  if (!file.includes(from)) fail(`${what}: 未找到待替换文本 "${from}"`)
  if (!dryRun) writeFileSync(file, file.replace(from, to), 'utf8')
  console.log(`[bump] ${dryRun ? '[演练] ' : ''}${what}: '${from}' -> '${to}'`)
}

patch(vm, `export const ${bump.const} = '${cur}'`, `export const ${bump.const} = '${ver}'`, `version.mjs ${bump.const}`)

// 同步测试期望值（旧断言值可能是 dev 前缀格式，与新值一致）
const vt = readFileSync(VERSION_TEST, 'utf8')
patch(vt, `assert.equal(${bump.const}, '${cur}')`, `assert.equal(${bump.const}, '${ver}')`, `server/version.test.mjs ${bump.const} 断言`)

// 内核线额外同步 kernel/package.json semver
if (target === 'kernel') {
  const pkg = JSON.parse(readFileSync(KERNEL_PKG, 'utf8'))
  const semver = semverPart.split('.').length === 2 ? `${semverPart}.0` : semverPart
  if (pkg.version !== semver) {
    pkg.version = semver
    if (!dryRun) writeFileSync(KERNEL_PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
    console.log(`[bump] ${dryRun ? '[演练] ' : ''}kernel/package.json version: -> '${semver}'`)
  } else {
    console.log(`[bump] kernel/package.json version 已一致（'${semver}'），无需改动`)
  }
}

console.log(`[bump] ${dryRun ? '[演练完成] ' : '完成 '}${label}: ${cur} -> ${ver}`)
