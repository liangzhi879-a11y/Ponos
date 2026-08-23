// scripts/annotate-skill-parent.mjs —— 批量标注（--dry-run 预览 / 默认执行）
// 53 项映射 = spec 4.2 分类表；技能库在 ~/.ponos/skills（不在 git 仓库），改前已整体备份
// 注：code-review-and-quality 是符号链接（→ .agents/skills/…），写文件会穿透链接修改技能库之外
// 的数据，故跳过并在输出中标记；其 parent 归属仍按 MAP（using-superpowers）。
import { readFileSync, writeFileSync, readdirSync, existsSync, lstatSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const SKILLS_DIR = join(homedir(), '.ponos', 'skills')
// 分类表（spec 4.2，53 项完整映射；键=目录名）：
const MAP = {
  // gxtz → gxtz-suite（23）
  'gxtz-achievement-materials': 'gxtz-suite',
  'gxtz-audit-verification': 'gxtz-suite',
  'gxtz-contract-review': 'gxtz-suite',
  'gxtz-core-tables': 'gxtz-suite',
  'gxtz-experience-sync': 'gxtz-suite',
  'gxtz-file-compressor': 'gxtz-suite',
  'gxtz-file-organizer': 'gxtz-suite',
  'gxtz-info-collector': 'gxtz-suite',
  'gxtz-innovation-statement': 'gxtz-suite',
  'gxtz-invoice-ps-matching': 'gxtz-suite',
  'gxtz-ip-materials': 'gxtz-suite',
  'gxtz-ip-tables': 'gxtz-suite',
  'gxtz-management-materials': 'gxtz-suite',
  'gxtz-precision-refiner': 'gxtz-suite',
  'gxtz-progress-manager': 'gxtz-suite',
  'gxtz-ps-materials': 'gxtz-suite',
  'gxtz-ps-tables': 'gxtz-suite',
  'gxtz-rd-report': 'gxtz-suite',
  'gxtz-rd-tables': 'gxtz-suite',
  'gxtz-staff-materials': 'gxtz-suite',
  'gxtz-submission-packager': 'gxtz-suite',
  'gxtz-toai-tables': 'gxtz-suite',
  'gxtz-wecom-collector': 'gxtz-suite',
  // yfwdoc → yfwdoc-suite（5）
  'yfwdoc-word': 'yfwdoc-suite',
  'yfwdoc-pptx': 'yfwdoc-suite',
  'yfwdoc-pdf': 'yfwdoc-suite',
  'yfwdoc-excel': 'yfwdoc-suite',
  'yfwdoc-template': 'yfwdoc-suite',
  // yfwweb → yfwweb-suite（3）
  'yfwweb-scrape': 'yfwweb-suite',
  'yfwweb-form': 'yfwweb-suite',
  'yfwweb-verify': 'yfwweb-suite',
  // yfwx → yfwx-suite（7）
  'yfwx-qualification-chain': 'yfwx-suite',
  'yfwx-kexiao': 'yfwx-suite',
  'yfwx-zhuanjingtexin': 'yfwx-suite',
  'yfwx-xiaojuren': 'yfwx-suite',
  'yfwx-dengling': 'yfwx-suite',
  'yfwx-unicorn': 'yfwx-suite',
  'yfwx-seal-extract': 'yfwx-suite',
  // superpowers → using-superpowers（15）
  'brainstorming': 'using-superpowers',
  'code-review-and-quality': 'using-superpowers',
  'dispatching-parallel-agents': 'using-superpowers',
  'example-skill': 'using-superpowers',
  'executing-plans': 'using-superpowers',
  'finishing-a-development-branch': 'using-superpowers',
  'receiving-code-review': 'using-superpowers',
  'requesting-code-review': 'using-superpowers',
  'subagent-driven-development': 'using-superpowers',
  'systematic-debugging': 'using-superpowers',
  'test-driven-development': 'using-superpowers',
  'using-git-worktrees': 'using-superpowers',
  'verification-before-completion': 'using-superpowers',
  'writing-plans': 'using-superpowers',
  'writing-skills': 'using-superpowers',
}
const dryRun = process.argv.includes('--dry-run')
let changed = 0
for (const [key, parent] of Object.entries(MAP)) {
  const dir = join(SKILLS_DIR, key)
  const entry = join(dir, 'SKILL.md')
  if (!existsSync(entry)) { console.error('缺失: ' + key); process.exit(1) }
  // 符号链接目录：写入会穿透到技能库之外，跳过并记录（parent 归属以 MAP 为准）
  if (lstatSync(dir).isSymbolicLink()) { console.log(`[skip-symlink] ${key} → parent: ${parent}（目录为符号链接，未写文件）`); continue }
  let md = readFileSync(entry, 'utf-8')
  if (!/^---\r?\n/.test(md)) { console.error('无 frontmatter: ' + key); process.exit(1) }
  if (md.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1].includes('parent:')) { console.log('已有 parent，跳过: ' + key); continue }
  const next = md.replace(/^(---\r?\n)/, `$1parent: ${parent}\n`)
  if (dryRun) { console.log(`[dry-run] ${key} → parent: ${parent}`) }
  else { writeFileSync(entry, next); changed++ }
}
console.log(dryRun ? `\n[dry-run] 预览完成` : `\n已标注 ${changed} 个技能`)
