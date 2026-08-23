#!/usr/bin/env node
// Ponos-turbo 内核单文件打包（bun build → kernel-dist/cli.mjs）
// ---------------------------------------------------------------------------
// 用途：bridge 的 bootstrapKernelToUserDir 只复制单个 cli.mjs 到
// ~/.ponos/runtime/kernel/（生产规避 Program Files ACL）。turbo 内核是
// 多文件源码版（kernel/*.mjs + ../version.mjs），直接复制单文件会断依赖，
// 故先经 bun build 打成零外部依赖的单文件 ESM bundle，再走既有 bootstrap。
// 输出到 kernel-dist/ 而非 dist/：vite build 的 emptyOutDir:true 会清空整个
// dist/（生产构建 npm run build 先于 electron-builder，会误删内核 bundle）。
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
