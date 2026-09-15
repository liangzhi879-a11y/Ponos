#!/usr/bin/env node
// 纯内核测试套件运行器
//   node scripts/test-kernel.mjs              跑全部内核测试
//   node scripts/test-kernel.mjs --filter knowledge   只跑文件名含 knowledge 的
// 说明：Node 24 的 `node --test <相对目录>` 对目录参数解析不稳定（会被当模块解析），
// 这里显式展开测试文件清单再交给 node --test，保证在任意 cwd 下都可用。
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DIRS = ['kernel-tests', 'shared']
const i = process.argv.indexOf('--filter')
const filter = i >= 0 ? (process.argv[i + 1] || '') : ''

const files = []
for (const dir of DIRS) {
  for (const f of readdirSync(join(ROOT, dir))) {
    if (!f.endsWith('.test.mjs')) continue
    if (filter && !f.includes(filter)) continue
    files.push(join(dir, f))
  }
}
if (files.length === 0) {
  console.error(filter ? `没有匹配 --filter ${filter} 的测试文件` : '没有找到测试文件')
  process.exit(1)
}
console.log(`运行 ${files.length} 个内核测试文件…`)
const r = spawnSync(process.execPath, ['--test', ...files], { cwd: ROOT, stdio: 'inherit' })
process.exit(r.status ?? 1)
