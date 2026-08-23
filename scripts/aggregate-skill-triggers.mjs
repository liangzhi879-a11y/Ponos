// 聚合子技能触发词生成父技能 description 初稿（人工审定后写入父技能 frontmatter）
// 用法：node scripts/aggregate-skill-triggers.mjs gxtz-suite [--print]
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const SKILLS_DIR = join(homedir(), '.ponos', 'skills')
const parentName = process.argv[2]
if (!parentName) { console.error('用法: node scripts/aggregate-skill-triggers.mjs <父技能名>'); process.exit(1) }

// 子技能 = 声明了 parent: <parentName> 的技能（frontmatter 解析）
function parseFrontmatter(md) {
  const yaml = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!yaml) return {}
  const get = (re) => { const m = yaml[1].match(re); return m ? m[1].trim().replace(/^["']|["']$/g, '') : '' }
  const list = (key) => {
    const re = new RegExp('^' + key + ':\\s*\\n((?:\\s*-\\s*.+\\n?)+)', 'm')
    const m = yaml[1].match(re)
    return m ? m[1].split('\n').map(l => l.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, '')).filter(Boolean) : []
  }
  return { name: get(/name:\s*["']?(.+?)["']?\s*$/m), description: get(/description:\s*["']?(.+?)["']?\s*$/m), triggers: list('triggers'), parent: get(/^parent:\s*["']?(.+?)["']?\s*$/m) }
}

const children = []
for (const it of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
  if (!it.isDirectory() || it.name.startsWith('_')) continue
  const entry = join(SKILLS_DIR, it.name, 'SKILL.md')
  if (!existsSync(entry)) continue
  const fm = parseFrontmatter(readFileSync(entry, 'utf-8'))
  if (fm.parent === parentName) children.push({ dir: it.name, ...fm })
}

// 聚合：triggers 优先，无则从 description 提取"当用户提到…时调用"场景段
const seen = new Set()
const terms = []
for (const c of children) {
  const src = c.triggers.length ? c.triggers : [c.description]
  for (const t of src) {
    const key = t.replace(/[，。、]/g, '')
    if (seen.has(key)) continue
    seen.add(key)
    terms.push(t)
  }
}
console.log(`子技能数：${children.length}`)
console.log(`聚合触发词初稿（${terms.length} 项）：`)
console.log(`description: "${parentName} 是总路由父技能。当用户提到${terms.join('、').slice(0, 200)}…时调用本技能，再按目录索引具体子技能。"`)
