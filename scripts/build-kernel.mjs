#!/usr/bin/env node
// 净室 ponos 内核单文件打包（bun build --target=node → kernel-dist/cli.mjs）
// ---------------------------------------------------------------------------
// 用途：kernel/ 为多文件源码（kernel/*.mjs + 逃逸到 ../version.mjs），自足单
// 文件形态供 bootstrap 缓存与打包落位更简单——故先经 bun build 打成零外部
// 依赖的单文件 ESM bundle。运行时 = node 直跑（D1），bundle 为 --target=node；
// 净室内核 Grep/Glob 原生 node 递归（kernel/tools.mjs），无 vendor/ripgrep
// 依赖（F3）。输出到 kernel-dist/（gitignored）而非 dist/：vite build 的
// emptyOutDir:true 会清空整个 dist/（生产构建 npm run build 先于
// electron-builder，会误删内核 bundle）。
// dev 环境可用 `node kernel/cli.mjs` 源码直跑（无需本脚本）；本脚本服务于
// 生产打包与 bootstrap 复制。用法：node scripts/build-kernel.mjs [outfile]

import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')
const outFile = process.argv[2] || join(repoRoot, 'kernel-dist', 'cli.mjs')

mkdirSync(dirname(outFile), { recursive: true })
execFileSync('bun', [
  'build',
  join(repoRoot, 'kernel', 'cli.mjs'),
  '--target=node',
  '--format=esm',
  '--external=node:*',
  '--outfile=' + outFile,
  '--minify',
], { stdio: 'inherit', cwd: repoRoot })
console.log('[build-kernel] bundled to', outFile)
