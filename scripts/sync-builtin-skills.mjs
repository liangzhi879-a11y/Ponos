/**
 * 内置技能包同步脚本
 *
 * 从 ~/.claude/skills 把 gxtz-* 技能（扁平 .md）与 _common 共享库
 * 转成目录式内置包（public/sample-skills/gxtz-xxx/SKILL.md + _common/），
 * 并把技能内所有 .claude/skills 路径引用重写为 {{YFW_SKILLS}} 占位符，
 * 由 bridge install-skill 在安装时替换为实际的 ~/.yfworking/skills 绝对路径。
 *
 * 用法: node scripts/sync-builtin-skills.mjs [--dry-run]
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, rmSync, statSync } from 'fs'
import { homedir } from 'os'
import { join, dirname, basename, extname } from 'path'

const SRC = join(homedir(), '.claude', 'skills')
const DEST = join(process.cwd(), 'public', 'sample-skills')
const DRY = process.argv.includes('--dry-run')

// 排除项（不复制进内置包）
const EXCLUDE_DIRS = new Set(['__pycache__', '_test_output', 'node_modules', '.git'])
const EXCLUDE_EXTS = new Set(['.pyc', '.pyo', '.log', '.tmp'])

/** 文本文件才做占位符替换 */
const TEXT_EXTS = new Set(['.md', '.py', '.json', '.txt', '.yaml', '.yml', '.js', '.mjs', '.cjs', '.ts', '.html', '.css', '.sh', '.bat', '.cmd', '.csv'])

const PLACEHOLDER = '{{YFW_SKILLS}}'

/** 将各种 .claude/skills 引用形式统一替换为占位符 */
function rewrite(text) {
  const variants = [
    /C:\\Users\\[^\\\s"'`)]+\\.claude\\skills/g,
    /C:\/Users\/[^/\s"'`)]+\/\.claude\/skills/g,
    /~\/\.claude\/skills/g,
    /~\/\\\.claude\/skills/g,
    /\.claude\/skills/g,
    /\.claude\\skills/g,
    /\.claude\\\\skills/g,
  ]
  let t = text
  let count = 0
  for (const re of variants) {
    const m = t.match(re)
    if (m) count += m.length
    t = t.replace(re, PLACEHOLDER)
  }
  return { text: t, count }
}

function collectFiles(dir, out, prefix) {
  for (const it of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(it.name)) continue
    const full = join(dir, it.name)
    if (it.isDirectory()) collectFiles(full, out, prefix)
    else out.push({ src: full, rel: join(prefix, it.name) })
  }
  return out
}

let totalRewrites = 0
let copied = 0

function copyWithRewrite(srcDir, destDir, rewriteContent) {
  for (const it of readdirSync(srcDir, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(it.name)) continue
    const s = join(srcDir, it.name)
    const d = join(destDir, it.name)
    if (it.isDirectory()) {
      mkdirSync(d, { recursive: true })
      copyWithRewrite(s, d, rewriteContent)
    } else {
      const ext = extname(it.name).toLowerCase()
      if (TEXT_EXTS.has(ext) && rewriteContent) {
        const { text, count } = rewrite(readFileSync(s, 'utf-8'))
        totalRewrites += count
        writeFileSync(d, text, 'utf-8')
      } else {
        copyFileSync(s, d)
      }
      copied++
    }
  }
}

// ── 1. gxtz-* 技能（扁平 .md → 目录式 SKILL.md） ──
const skills = readdirSync(SRC).filter(n => n.startsWith('gxtz-') && n.endsWith('.md'))
console.log(`[1/3] gxtz-* skills found: ${skills.length}`)

for (const name of skills) {
  const skillId = name.slice(0, -3)
  const srcFile = join(SRC, name)
  const destDir = join(DEST, skillId)
  const content = readFileSync(srcFile, 'utf-8')
  const { text, count } = rewrite(content)
  totalRewrites += count
  if (!DRY) {
    mkdirSync(destDir, { recursive: true })
    writeFileSync(join(destDir, 'SKILL.md'), text, 'utf-8')
  }
  copied++
}

// ── 2. _common 共享库 ──
const srcCommon = join(SRC, '_common')
if (existsSync(srcCommon)) {
  console.log('[2/3] copying _common shared lib...')
  if (DRY) {
    const files = collectFiles(srcCommon, [], '')
    console.log(`  _common files (post-exclusion): ${files.length}`)
  } else {
    const destCommon = join(DEST, '_common')
    mkdirSync(destCommon, { recursive: true })
    copyWithRewrite(srcCommon, destCommon, true)
  }
}

// ── 3. 内置技能索引（供 UI /sample-skills 展示的元数据） ──
// 直接从各 SKILL.md frontmatter 生成，保证与包内一致
if (!DRY) {
  console.log('[3/3] writing builtin index...')
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

console.log(`DONE. copied=${copied} pathRewrites=${totalRewrites} dryRun=${DRY}`)
