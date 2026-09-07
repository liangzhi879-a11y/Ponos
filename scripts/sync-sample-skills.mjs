/**
 * sample-skills 完整技能库同步脚本
 *
 * 从 runtime/skills（开发期完整技能库：gxtz + coding + yfwdoc + yfwweb）
 * 同步缺失技能目录到 public/sample-skills（安装包预置源），并重新生成
 * _builtin_index.json（从各 SKILL.md frontmatter 提取 id/name/description/version）。
 *
 * 与 sync-builtin-skills.mjs 的区别：后者只处理 gxtz-* 扁平 .md（源 ~/.claude/skills），
 * 本脚本处理 runtime/skills 下所有目录式技能。
 *
 * 用法: node scripts/sync-sample-skills.mjs [--dry-run]
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, statSync, rmSync } from 'fs'
import { join } from 'path'

const SRC = join(process.cwd(), 'runtime', 'skills')
const DEST = join(process.cwd(), 'public', 'sample-skills')
const DRY = process.argv.includes('--dry-run')

// 运行时数据 / 缓存目录，禁止进入安装包
const EXCLUDE_DIRS = new Set(['__pycache__', 'browser_profiles', 'node_modules', '.git', '_test_output', 'cache', 'Cache'])

function collectFiles(dir, out) {
  for (const it of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(it.name)) continue
    const full = join(dir, it.name)
    if (it.isDirectory()) collectFiles(full, out)
    else out.push(full)
  }
  return out
}

function copyDir(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true })
  for (const it of readdirSync(srcDir, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(it.name)) continue
    const s = join(srcDir, it.name)
    const d = join(destDir, it.name)
    if (it.isDirectory()) copyDir(s, d)
    else copyFileSync(s, d)
  }
}

// ── 1. 找出缺失技能目录并复制 ──
const srcSkills = new Set(readdirSync(SRC, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name))
const destSkills = new Set(readdirSync(DEST, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name))
const missing = [...srcSkills].filter(n => n !== '_common' && !destSkills.has(n)).sort()

console.log(`[1/2] runtime skills=${srcSkills.size} | packaged skills=${destSkills.size} | missing=${missing.length}`)
for (const name of missing) console.log('  +', name)

if (!DRY) {
  for (const name of missing) {
    const srcDir = join(SRC, name)
    const files = collectFiles(srcDir, [])
    if (!files.some(f => f.toLowerCase().endsWith('skill.md'))) {
      console.warn(`  SKIP ${name}: no SKILL.md found (${files.length} files)`)
      continue
    }
    copyDir(srcDir, join(DEST, name))
    console.log(`  copied ${name} (${files.length} files)`)
  }
}

// ── 2. 重新生成 _builtin_index.json ──
if (!DRY) {
  console.log('[2/2] rebuilding _builtin_index.json...')
  const index = []
  for (const it of readdirSync(DEST, { withFileTypes: true })) {
    if (!it.isDirectory() || it.name === '_common') continue
    const mdPath = join(DEST, it.name, 'SKILL.md')
    if (!existsSync(mdPath)) continue
    const md = readFileSync(mdPath, 'utf-8')
    const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    const meta = { name: it.name, description: '', version: '' }
    if (m) {
      const grab = (key) => { const k = m[1].match(new RegExp('^' + key + ':\\s*["\']?(.+?)["\']?\\s*$', 'm')); return k ? k[1].trim() : '' }
      meta.name = grab('name') || it.name
      meta.description = grab('description')
      meta.version = grab('version')
    }
    index.push({ id: it.name, name: meta.name, description: meta.description, version: meta.version })
  }
  index.sort((a, b) => a.id.localeCompare(b.id))
  writeFileSync(join(DEST, '_builtin_index.json'), JSON.stringify(index, null, 2), 'utf-8')
  console.log(`  index entries: ${index.length}`)
}

console.log(`DONE. dryRun=${DRY}`)
