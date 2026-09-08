#!/usr/bin/env node
// YFWorking 内置工具：文件批量处理
// 用法：node yfw-helper <command> [args]
//
// 命令：
//   hash <dir>              计算目录下所有文件的 SHA-256
//   rename <dir> <from> <to>  批量替换文件名中的字符串（带 .bak 备份）
//   count <dir>             统计目录文件数与总大小
//   help                    显示帮助
import { createHash } from 'crypto'
import { readdirSync, statSync, existsSync, copyFileSync, renameSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

function help() {
  console.log('YFWorking 内置工具 — yfw-helper')
  console.log('')
  console.log('用法：')
  console.log('  node yfw-helper hash <dir>')
  console.log('  node yfw-helper rename <dir> <from> <to>')
  console.log('  node yfw-helper count <dir>')
  console.log('  node yfw-helper help')
}

function hashDir(dir) {
  if (!existsSync(dir)) { console.error('dir not found:', dir); process.exit(1) }
  const files = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile())
  for (const f of files) {
    const fp = join(dir, f.name)
    const buf = readFileSync(fp)
    const h = createHash('sha256').update(buf).digest('hex')
    console.log(h.slice(0, 16) + '  ' + f.name)
  }
}

function renameInDir(dir, from, to) {
  if (!existsSync(dir)) { console.error('dir not found:', dir); process.exit(1) }
  let n = 0
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    if (!f.isFile()) continue
    if (!f.name.includes(from)) continue
    const oldPath = join(dir, f.name)
    const newName = f.name.split(from).join(to)
    const newPath = join(dir, newName)
    // .bak 备份
    const bakPath = oldPath + '.bak'
    if (!existsSync(bakPath)) copyFileSync(oldPath, bakPath)
    renameSync(oldPath, newPath)
    console.log('  ' + f.name + ' → ' + newName)
    n++
  }
  console.log(n + ' files renamed')
}

function countDir(dir) {
  if (!existsSync(dir)) { console.error('dir not found:', dir); process.exit(1) }
  let count = 0
  let total = 0
  function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name))
      else { count++; total += statSync(join(d, e.name)).size }
    }
  }
  walk(dir)
  console.log(count + ' files, ' + (total / 1024 / 1024).toFixed(1) + ' MB')
}

const [, , cmd, ...args] = process.argv
switch (cmd) {
  case 'hash':   hashDir(args[0]); break
  case 'rename': renameInDir(args[0], args[1], args[2]); break
  case 'count':  countDir(args[0]); break
  case 'help':
  case '--help':
  case '-h':
  default:       help()
}