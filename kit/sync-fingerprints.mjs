#!/usr/bin/env node
// kit/sync-fingerprints.mjs —— 把 docs/bridge-contract.md §12 的 21 个结构指纹同步为快照当前值
//
// 为什么单独一个脚本（而不是让 agent 手抄）：
//   §12 的指纹是**被 CT3 逐字比对**的值 —— 手抄 21 个 8 位十六进制 = 必然出错且无痕迹。
//   本脚本从 `kit/manifest/versions.json#channels.tools`（唯一真值 = `kit:sync` 的产物）取值，
//   并**双向校验**：文档有而快照没有 ⇒ 报"文档腐烂"退出 1；快照有而文档缺 ⇒ 报"漏登记"退出 1。
//   ⇒ 不存在"只同步了一半还静默通过"的形态。
//
// ★ 与 D6 局部暂存的关系（P1.5 起 `docs/bridge-contract.md` 常与他人在途改动共存）：
//   本脚本刻意设计成**对任意基线文件都可复现**（只读入参、只写出行参，不碰 git 索引），
//   于是"把 HEAD 版本跑一遍 → hash-object → update-index --cacheinfo"这条提交路径能用同一个脚本，
//   保证"提交进去的内容 = 对 committed 基线跑出的结果"，他人在途的改动不会被一起提交。
//   用法：
//     node kit/sync-fingerprints.mjs <in.md> <out.md>      # 同步到指定文件
//     node kit/sync-fingerprints.mjs --check <in.md>       # 只校验、不写（CI 可用来防"指纹过期"）
//
// 改指纹口径（`shapeOfNode`）后的完整流程（见 kit/README.md「工具指纹到底覆盖哪些」）：
//   改 shapeOfNode → 同步 contract-tools.test.mjs 的两份关键字名单 → `npm run kit:sync`
//   → 本脚本同步 §12 → `node kit/cli.mjs check` 绿
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const checkOnly = argv[0] === '--check'
const [inPath, outPath] = checkOnly ? [argv[1], null] : argv
if (!inPath || (!checkOnly && !outPath)) {
  console.error('用法：node kit/sync-fingerprints.mjs <in.md> <out.md>   或   node kit/sync-fingerprints.mjs --check <in.md>')
  process.exit(2)
}

const tools = JSON.parse(readFileSync(join(ROOT, 'kit/manifest/versions.json'), 'utf8')).channels.tools
const lines = readFileSync(inPath, 'utf8').split('\n')

// §12 区间：`## 12.` 标题行 → 下一个 `## ` 标题行
const start = lines.findIndex((l) => /^## 12\./.test(l))
if (start < 0) { console.error('✗ 未找到 §12 标题'); process.exit(2) }
let end = lines.findIndex((l, i) => i > start && /^## /.test(l))
if (end < 0) end = lines.length

let replaced = 0
const hit = new Set()
for (let i = start; i < end; i++) {
  const m = lines[i].match(/^\|\s*`([^`]+)`\s*\|\s*`([0-9a-f]{8})`\s*\|/)
  if (!m) continue
  const [, name, oldFp] = m
  const newFp = tools[name]
  if (!newFp) { console.error(`✗ §12 有工具 "${name}"，但快照 versions.json 里没有 ⇒ 文档腐烂（人工处置后重跑）`); process.exit(1) }
  hit.add(name)
  if (oldFp !== newFp) {
    lines[i] = lines[i].replace('`' + oldFp + '`', '`' + newFp + '`')
    replaced++
    if (!checkOnly) console.log(`  ${name.padEnd(16)} ${oldFp} → ${newFp}`)
  }
}
const missing = Object.keys(tools).filter((n) => !hit.has(n))
if (missing.length) { console.error(`✗ 快照有但 §12 缺：${missing.join(', ')} ⇒ 补完再跑`); process.exit(1) }

if (checkOnly) {
  if (replaced > 0) {
    console.error(`✗ §12 有 ${replaced} 条指纹过期（快照已是新值）⇒ 跑 \`node kit/sync-fingerprints.mjs <in> <out>\` 同步`)
    process.exit(1)
  }
  console.log(`✓ §12 的 ${hit.size} 条指纹与快照一致`)
} else {
  writeFileSync(outPath, lines.join('\n'))
  console.log(`✓ 更新 ${replaced} 条指纹（共 ${hit.size} 个工具），已写 ${outPath}`)
}
