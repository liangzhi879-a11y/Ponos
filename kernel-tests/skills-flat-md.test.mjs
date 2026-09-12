// 平铺 .md 技能污染（2026-09-12 P2-1，诊断证据链的第 ③ 条）
// ---------------------------------------------------------------------------
// 病灶：discoverSkills 把技能根下任意 `<id>.md` 都当技能——只要该根被列为技能根，
// 项目根目录里的普通文档就进了系统提示【可用技能】清单与 Skill 工具回执。
// 实证：仓库根 BUILD.md（无 frontmatter 的纯说明文档）成为 "BUILD" 技能，AGENTS.md
// 同样中招（技能数是 2 而非 1）。
// 修复两道闸：
//   ① 平铺文件必须带 frontmatter（`---` 块）——纯文档不是技能；
//   ② 只有技能集合根（显式 --skills-dir、<configDir>/skills）认平铺；项目/addDirs
//      根必须用 <id>/SKILL.md 目录形式。
// 目录形式是技能唯一的强约定（bridge 安装、sample-skills、~/.yfw/skills 全用它），
// 故本测试同时锁住"目录形式不被这两道闸误伤"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverSkills, discoverSkillsAll, loadSkillContent } from '../kernel/skills.mjs'

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'flat-md-'))
  // 项目根：无 frontmatter 的文档（BUILD.md 同款）+ AGENTS.md + 目录形式技能
  writeFileSync(join(dir, 'BUILD.md'), '# 构建说明\n\n不带 frontmatter 的纯文档。\n')
  writeFileSync(join(dir, 'AGENTS.md'), '# 项目指令\n')
  mkdirSync(join(dir, 'docs-skill'), { recursive: true })
  writeFileSync(join(dir, 'docs-skill', 'SKILL.md'), '---\nname: docs-skill\ndescription: 目录形式技能\n---\n步骤\n')
  // 技能集合根（configDir/skills）：legacy 平铺技能带 frontmatter + 无 frontmatter 的文档
  const skillsRoot = join(dir, 'home', 'skills')
  mkdirSync(skillsRoot, { recursive: true })
  writeFileSync(join(skillsRoot, 'legacy-flat.md'), '---\nname: legacy-flat\ndescription: legacy 平铺技能\ntriggers:\n  - 平铺\n---\n步骤\n')
  writeFileSync(join(skillsRoot, 'NOTES.md'), '# 随手记\n\n无 frontmatter。\n')
  return { dir, skillsRoot, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('平铺 <id>.md 无 frontmatter → 不是技能（BUILD.md/AGENTS.md 不再进技能清单）', () => {
  const env = makeEnv()
  try {
    const ids = discoverSkills({ root: env.dir }).map((s) => s.id)
    assert.ok(!ids.includes('BUILD'), `无 frontmatter 的 BUILD.md 不得成为技能（实际 ${ids.join(', ')}）`)
    assert.ok(!ids.includes('AGENTS'), `无 frontmatter 的 AGENTS.md 不得成为技能（实际 ${ids.join(', ')}）`)
    assert.deepEqual(ids, ['docs-skill'], '同一根里的目录形式技能必须照常发现')
  } finally { env.cleanup() }
})

test('技能集合根认平铺：带 frontmatter 的 legacy 平铺技能保留，无 frontmatter 的仍排除', () => {
  const env = makeEnv()
  try {
    const ids = discoverSkills({ root: env.skillsRoot, allowFlat: true }).map((s) => s.id)
    assert.ok(ids.includes('legacy-flat'), `legacy 平铺技能（带 frontmatter）必须仍可发现（实际 ${ids.join(', ')}）`)
    assert.ok(!ids.includes('NOTES'), '无 frontmatter 的 NOTES.md 不得成为技能')
  } finally { env.cleanup() }
})

test('项目根不认平铺：allowFlat=false 时即便带 frontmatter 也只认 <id>/SKILL.md', () => {
  const env = makeEnv()
  try {
    writeFileSync(join(env.dir, 'with-fm.md'), '---\nname: with-fm\ndescription: 带 frontmatter 的项目文档\n---\n正文\n')
    const ids = discoverSkills({ root: env.dir, allowFlat: false }).map((s) => s.id)
    assert.deepEqual(ids, ['docs-skill'], '项目根只有目录形式算技能')
  } finally { env.cleanup() }
})

test('flatRoots 白名单贯通全链：项目文档不能经 Skill 工具加载，技能集合根的平铺仍可加载', () => {
  const env = makeEnv()
  try {
    writeFileSync(join(env.dir, 'with-fm.md'), '---\nname: with-fm\ndescription: 带 frontmatter 的项目文档\n---\n正文\n')
    const roots = [env.dir, env.skillsRoot]
    // 发现：白名单外不认平铺
    const ids = discoverSkillsAll({ roots, flatRoots: [env.skillsRoot] }).map((s) => s.id)
    assert.deepEqual(ids.sort(), ['docs-skill', 'legacy-flat'])
    // 加载：白名单外的平铺 id 取不到（提示词里没有的 id 也不该能加载）
    assert.equal(loadSkillContent({ roots, id: 'with-fm', flatRoots: [env.skillsRoot] }), null,
      '项目根的项目文档不得经 Skill 工具加载')
    assert.match(String(loadSkillContent({ roots, id: 'legacy-flat', flatRoots: [env.skillsRoot] })), /legacy 平铺技能/,
      '技能集合根的平铺技能仍应可加载')
    assert.match(String(loadSkillContent({ roots, id: 'docs-skill', flatRoots: [env.skillsRoot] })), /目录形式技能/,
      '目录形式技能不受白名单影响')
    // 零回归：不传 flatRoots（engine 直跑/旧调用方）→ 旧行为，平铺全认
    assert.ok(ids.length > 0)
    assert.match(String(loadSkillContent({ roots, id: 'with-fm' })), /带 frontmatter 的项目文档/,
      'flatRoots 缺省须保持旧行为（全认平铺）')
  } finally { env.cleanup() }
})
