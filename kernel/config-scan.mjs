#!/usr/bin/env node
// 内核配置清单生成器（D1-1）：扫描 kernel/*.mjs 提取 env 引用与 CLI flag，
// 输出生成式 reference（docs/manual/kernel-config.md）。零依赖正则扫描。
// 用法：node kernel/config-scan.mjs [--out <path>]
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ENV_RE = /(?:process\.env|env)\.([A-Z][A-Z0-9_]*)/g
const FLAG_RE = /case\s+'([^']*)':/g

export function scanKernelConfig({ dir }) {
  const env = new Set()
  const flags = new Set()
  let files = []
  try { files = readdirSync(dir).filter((f) => f.endsWith('.mjs')) } catch { return { env: [], flags: [] } }
  for (const f of files) {
    const src = readFileSync(join(dir, f), 'utf-8')
    let m
    ENV_RE.lastIndex = 0
    while ((m = ENV_RE.exec(src))) env.add(m[1])
    if (f === 'cli.mjs') {
      FLAG_RE.lastIndex = 0
      while ((m = FLAG_RE.exec(src))) {
        const flag = m[1]
        if (flag.startsWith('--')) flags.add(flag)
      }
    }
  }
  return { env: [...env].sort(), flags: [...flags].sort() }
}

export function renderConfigReference({ env = [], flags = [] } = {}) {
  const lines = [
    '# 内核配置参考（生成式）',
    '',
    '> 本文件由 `node kernel/config-scan.mjs` 生成，覆盖 kernel/ 源码中的 env 引用与 CLI flag。',
    '> 默认值/示例/影响面为人工补注（生成器只负责盘点名称）。',
    '',
    '## 环境变量',
    '',
    '| 环境变量 | 默认值 | 示例 | 影响面 |',
    '|---|---|---|---|',
  ]
  for (const e of env) lines.push(`| ${e} |  |  |  |`)
  lines.push('', '## 命令行参数', '', '| 命令行参数 | 说明 |', '|---|---|')
  for (const f of flags) lines.push(`| ${f} |  |`)
  return lines.join('\n') + '\n'
}

// 主入口判定：argv[1] 统一转 file URL（相对路径按 cwd 解析）再与 import.meta.url 比对
let isMain = false
try {
  const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
  isMain = !!entry && import.meta.url === entry
} catch { /* 入口不可解析（test runner）→ 非主执行 */ }
if (isMain) {
  const dir = join(dirname(fileURLToPath(import.meta.url)))
  const { env, flags } = scanKernelConfig({ dir })
  const md = renderConfigReference({ env, flags })
  const outIdx = process.argv.indexOf('--out')
  if (outIdx >= 0 && process.argv[outIdx + 1]) {
    writeFileSync(process.argv[outIdx + 1], md, 'utf-8')
    console.log(`[config-scan] ${env.length} env / ${flags.length} flags -> ${process.argv[outIdx + 1]}`)
  } else {
    process.stdout.write(md)
  }
}
