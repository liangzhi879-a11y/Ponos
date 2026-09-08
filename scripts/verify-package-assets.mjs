// scripts/verify-package-assets.mjs
// S6 打包资源面预检（Batch B 出包前跑）。校验 electron-builder.yml extraResources
// 声明的源在本仓库的存在性；构建期组装源（runtime/python、runtime/skills）标注为
// build-installer.mjs 前置产物，缺失时提示先跑 build-installer.mjs。
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { load } from 'js-yaml'

const ROOT = join(import.meta.dirname, '..')
const yml = load(readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8'))
const BUILD_TIME = new Set(['runtime/python', 'runtime/skills'])
let failed = false
for (const er of yml.extraResources ?? []) {
  const from = join(ROOT, er.from)
  if (BUILD_TIME.has(er.from)) {
    if (!existsSync(from)) {
      console.log(`[skip] ${er.from} —— 构建期组装源，先跑 scripts/build-installer.mjs 生成`)
    } else {
      console.log(`[ok  ] ${er.from} (构建期组装源已存在)`)
    }
    continue
  }
  const ok = existsSync(from)
  console.log(`[${ok ? 'ok' : 'FAIL'}] ${er.from} -> ${er.to}`)
  if (!ok) failed = true
}
// kernel-dist/cli.mjs 是 files 的打包前提（electron-builder.yml 有注释声明，另做存在性断言）
if (!existsSync(join(ROOT, 'kernel-dist', 'cli.mjs'))) {
  console.log('[FAIL] kernel-dist/cli.mjs 缺失——先跑 scripts/build-kernel.mjs')
  failed = true
}
if (failed) { console.error('\n资源面校验失败，请补齐后重试'); process.exit(1) }
console.log('\n打包资源面校验通过')
