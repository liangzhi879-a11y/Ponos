// 技能可见性回归验证（S5 T1 ②-03 技能清单去重，D1）: node scripts/verify-skill-listing.mjs
// ---------------------------------------------------------------------------
// 背景：bridge 宿主 appendSkillList 注入已停用，技能清单唯一来源 = 内核
// composeSystemPrompt【可用技能】块（技能根经 --add-dir 发现，见 server/bridge.mjs
// getOrCreateSession）。本脚本不再 import bridge（避免模块加载副作用），改为：
//   1) 自包含枚举真实技能库（YFWORKING_HOME/CLAUDE_CONFIG_DIR/~/.yfworking 解析，
//      与 yfw-home.cjs 一致；技能 id = 目录/文件名，同内核发现语义）；
//   2) 数据完整性校验：子技能 parent 声明必须存在且本身无 parent（无孤儿）；
//   3) 内核技能块格式校验：枚举结果喂给 kernel/prompt.mjs composeSystemPrompt，
//      断言块头、行数 = 顶层技能数、行首 token 均为真实技能 id、子技能不独立成条。
// 不再断言宿主专用格式（行首=frontmatter name、<4000 字符瘦身体积、版本号剥离），
// 亦不硬编码技能库绝对计数（旧 5/53/6 已于宿主时代随库演化失效）。
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { composeSystemPrompt } from '../kernel/prompt.mjs'

const HOME = process.env.YFWORKING_HOME || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.yfworking')
const SKILLS_DIR = join(HOME, 'skills')

// 枚举已安装技能（镜像原 bridge listInstalledSkills 的目录/扁平 .md 双格式扫描，
// 但保留 id = 目录/文件名，供内核技能块行首 token 断言）
function listInstalledSkills() {
  const skills = []
  try {
    for (const it of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
      if (it.name.startsWith('_')) continue
      if (!it.isDirectory() && !it.name.endsWith('.md')) continue
      const entry = it.isDirectory() ? join(SKILLS_DIR, it.name, 'SKILL.md') : join(SKILLS_DIR, it.name)
      if (!existsSync(entry)) continue
      const skill = { id: it.name, description: '', triggers: [], parent: '' }
      try {
        const md = readFileSync(entry, 'utf-8')
        const yaml = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
        if (yaml) {
          const dm = yaml[1].match(/description:\s*["']?(.+?)["']?\s*$/m)
          if (dm) skill.description = dm[1].trim()
          const tm = yaml[1].match(/^triggers:\s*\n((?:\s*-\s*.+\n?)+)/m)
          if (tm) skill.triggers = tm[1].split('\n').map(l => l.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, '')).filter(Boolean)
          const pm = yaml[1].match(/^parent:[ \t]*["']?(.+?)["']?[ \t]*$/m)
          if (pm) skill.parent = pm[1].trim().replace(/^["']|["']$/g, '')
        }
      } catch {}
      skills.push(skill)
    }
  } catch {}
  return skills
}

const skills = listInstalledSkills()
const ids = new Set(skills.map(s => s.id))
const children = skills.filter(s => s.parent)
const topLevel = skills.filter(s => !s.parent)

let failed = 0
const check = (cond, label) => {
  if (cond) console.log('ok: ' + label)
  else { console.error('FAIL: ' + label); failed++ }
}

if (!skills.length) {
  console.log(`技能库为空（${SKILLS_DIR} 不存在或无技能）——数据校验跳过，仅验证空库时不产出技能块`)
} else {
  console.log(`技能库：${skills.length}（顶层 ${topLevel.length} / 子 ${children.length}，dir=${SKILLS_DIR.replace(/\\/g, '/')}）`)
}

// ── 数据完整性：parent 声明无孤儿、父级自身无 parent ──
check(children.every(c => ids.has(c.parent)), '子技能声明的 parent 均存在于技能库')
check(children.every(c => topLevel.some(p => p.id === c.parent)), '子技能声明的 parent 均为顶层技能（本身无 parent）')
check(topLevel.every(p => !p.parent), '顶层技能均无 parent')

// ── 内核技能块格式（唯一来源 = composeSystemPrompt，宿主不再拼装）──
const out = composeSystemPrompt({ toolNames: [], skills })
const blockStart = out.indexOf('【可用技能】')
if (topLevel.length === 0) {
  check(blockStart === -1, '技能库为空时不产出【可用技能】块')
} else {
  check(blockStart >= 0, 'composeSystemPrompt 输出含【可用技能】块')
  const block = blockStart >= 0 ? out.slice(blockStart) : ''
  const lines = block.split('\n').filter(l => l.startsWith('- '))
  const tokens = lines.map(l => l.replace(/^-\s*/, '').split(/[：:（\n]/)[0])
  console.log(`\n内核技能块条目行数：${lines.length}（顶层技能 ${topLevel.length}）`)
  console.log(`内核技能块字符数：${block.length}`)
  check(lines.length === topLevel.length, `条目行数 = 顶层技能数（${lines.length} = ${topLevel.length}）`)
  check(tokens.every(t => ids.has(t)), '每行行首 token 均为真实技能 id')
  check(tokens.every(t => topLevel.some(p => p.id === t)), '行首 token 均非子技能（子技能只内联不独立成条）')
  for (const p of topLevel) {
    check(lines.some(l => l.startsWith('- ' + p.id)), `顶层技能 ${p.id} 有且仅有独立条目`)
  }
  // 子技能名不得作为行首出现（应内联在其父条目中）
  const childTokens = new Set(children.map(c => c.id))
  check(!lines.some(l => childTokens.has(l.replace(/^-\s*/, '').split(/[：:（\n]/)[0])), '子技能名不在技能块独立成条')
  for (const p of topLevel) {
    const line = lines.find(l => l.startsWith('- ' + p.id))
    const missing = children.filter(c => c.parent === p.id && !line.includes(c.id))
    check(!missing.length, `顶层技能 ${p.id} 条目内联全部声明的子技能（缺失 ${missing.map(m => m.id).join(',') || '无'}）`)
  }
}

if (failed) { console.error(`\n${failed} 项失败`); process.exit(1) }
console.log('\n全部通过')
