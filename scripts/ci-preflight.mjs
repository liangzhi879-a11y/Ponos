#!/usr/bin/env node
// CI 预检守卫（2026-09-17 新增）
// ---------------------------------------------------------------------------
// 为什么需要它：`node --test <glob>` 在某条 glob **匹配不到任何文件**时**不报错、直接 0 退出**
// ——CI 会显示绿灯而实际一个测试都没跑。这是测试基建最经典的静默失败，且一旦发生会
// 让人误以为"有保护"。本脚本把这类问题在跑测试之前就变成硬失败。
//
// 检查项：
//   1. Node 版本（`src/**/*.test.ts` 依赖原生 TS 类型剥离，Node ≥ 23.6 默认开启）
//   2. 每条测试 glob 必须至少匹配到 1 个文件，且各层文件数与 `docs/_anchors.json` 声明一致
//      （后者可抓出"glob 写错导致整层静默消失"）
//   3. 本机若已有进程占用 51517（正在运行的应用），**警告并中止**：server 侧测试会起桥，
//      而桥在 EADDRINUSE 时会自愈式 `taskkill` 命令行含 `yfworking|bridge.mjs` 的进程
//      ——即"本地跑测试把用户正在用的应用杀掉"。用 --allow-running-app 可显式跳过。
//      （测试自身多用 YFW_BRIDGE_PORT 随机端口隔离，故此风险主要来自默认端口路径。）
//
// 用法：
//   node scripts/ci-preflight.mjs                # 检查（CI 与本地都用）
//   node scripts/ci-preflight.mjs --allow-running-app
import { existsSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { globSync } from 'node:fs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const allowRunningApp = process.argv.includes('--allow-running-app')

/** 必须与 package.json 的 test 脚本保持同一组 glob（改一处必须改两处） */
export const TEST_GLOBS = [
  'shared/**/*.test.mjs',
  'server/*.test.mjs',
  'electron/*.test.mjs',
  'kernel-tests/*.test.mjs',
  'src/**/*.test.ts',
]

const problems = []
const warnings = []

// ── 1. Node 版本 ─────────────────────────────────────────────────────────
const major = Number(process.versions.node.split('.')[0])
const minor = Number(process.versions.node.split('.')[1])
if (major < 22 || (major === 22 && minor < 6)) {
  problems.push(`Node ${process.versions.node} 过旧：src/**/*.test.ts 需要原生 TS 类型剥离（Node ≥ 23.6 默认开启，≥ 22.6 需 --experimental-strip-types）`)
} else if (major < 24) {
  warnings.push(`Node ${process.versions.node} 可运行，但本项目在 Node 24 上验证（CSV 见 docs）；CI 固定 24.x`)
}

// ── 2. 每条 glob 必须匹配到文件；各层数量与声明锚点一致 ──────────────────
const counts = {}
for (const g of TEST_GLOBS) {
  let files = []
  try { files = globSync(g, { cwd: ROOT }) } catch (e) { problems.push(`glob 解析失败: ${g} — ${e.message}`); continue }
  counts[g] = files.length
  if (files.length === 0) {
    problems.push(`glob 匹配不到任何测试文件（会导致"零测试但绿灯"）：${g}`)
  }
}
const total = Object.values(counts).reduce((a, b) => a + b, 0)
if (total === 0) problems.push('全部 glob 都匹配不到文件：测试脚本已失效')

// 与文档锚点比对（锚点由 node scripts/check-doc-anchors.mjs --write 生成）
const anchorsPath = resolve(ROOT, 'docs/_anchors.json')
if (existsSync(anchorsPath)) {
  try {
    const anchors = JSON.parse(readFileSync(anchorsPath, 'utf8'))
    for (const [g, n] of Object.entries(anchors.testFileCounts || {})) {
      if (g in counts && counts[g] !== n) {
        problems.push(`测试文件数与文档锚点不符：${g} 实际 ${counts[g]}，锚点 ${n}（若为有意新增/删除，请跑 node scripts/check-doc-anchors.mjs --write 更新声明）`)
      }
    }
  } catch (e) {
    warnings.push(`无法读取 docs/_anchors.json：${e.message}`)
  }
} else {
  warnings.push('未找到 docs/_anchors.json（可跑 node scripts/check-doc-anchors.mjs --write 生成，以启用"文档口径纳入 CI"）')
}

// ── 3. 本机是否已有应用占用桥端口（本地跑测试的误杀风险）─────────────────
const BRIDGE_PORT = Number(process.env.YFW_BRIDGE_PORT || 51517)
if (!process.env.CI && !allowRunningApp && Number.isInteger(BRIDGE_PORT) && BRIDGE_PORT > 0) {
  const occupied = await new Promise((res) => {
    const s = connect({ port: BRIDGE_PORT, host: '127.0.0.1' })
    const done = (v) => { try { s.destroy() } catch { /* 已断开 */ } ; res(v) }
    s.setTimeout(400)
    s.on('connect', () => done(true))
    s.on('error', () => done(false))
    s.on('timeout', () => done(false))
  })
  if (occupied) {
    problems.push(
      `端口 ${BRIDGE_PORT} 已被占用（很可能是正在运行的本应用）。server 侧测试会起桥，` +
      `桥在 EADDRINUSE 时会自愈式 taskkill 掉命令行含 "yfworking|bridge.mjs" 的进程 —— ` +
      `直接跑测试可能把你在用的应用杀掉。请先关闭应用，或加 --allow-running-app 明确承担风险。`,
    )
  }
}

// ── 输出 ────────────────────────────────────────────────────────────────
for (const w of warnings) console.warn(`  ⚠️  ${w}`)
if (problems.length > 0) {
  console.error('\n❌ CI 预检未通过：')
  for (const p of problems) console.error(`   · ${p}`)
  process.exit(1)
}
console.log(`✅ CI 预检通过：Node ${process.versions.node}，${total} 个测试文件`)
for (const [g, n] of Object.entries(counts)) console.log(`     ${String(n).padStart(4)}  ${g}`)
