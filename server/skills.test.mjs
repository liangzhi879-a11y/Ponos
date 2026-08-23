// server/skills.test.mjs —— P4-4 技能发现内核化（SKILL.md 目录 + legacy .md + prompt 注入 + init 概览）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { discoverSkills, discoverSkillsAll, loadSkillContent, parseFrontmatter, verifySkillVersions } from '../kernel/skills.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'yfw-skills-'))
test.after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch {} })

test('parseFrontmatter：key: value 解析 + 去引号', () => {
  const md = '---\nname: "My Skill"\ndescription: does things\nversion: 1.2.0\n---\n# My Skill\nbody'
  assert.deepEqual(parseFrontmatter(md), { name: 'My Skill', description: 'does things', version: '1.2.0' })
  assert.deepEqual(parseFrontmatter('# no frontmatter'), {})
})

test('discoverSkills：SKILL.md 目录格式 + legacy <id>.md 格式 + 排序', () => {
  mkdirSync(join(tmp, 'sroot', 'alpha'), { recursive: true })
  mkdirSync(join(tmp, 'sroot', 'beta'), { recursive: true })
  writeFileSync(join(tmp, 'sroot', 'alpha', 'SKILL.md'), '---\nname: Alpha\ndescription: first skill\nversion: 1.0.0\n---\nbody', 'utf-8')
  writeFileSync(join(tmp, 'sroot', 'beta', 'SKILL.md'), '---\ndescription: second skill\n---\nbody', 'utf-8')
  writeFileSync(join(tmp, 'sroot', 'legacy.md'), '---\ndescription: legacy flat\n---\nbody', 'utf-8')
  writeFileSync(join(tmp, 'sroot', 'notes.txt'), 'not a skill', 'utf-8')
  const skills = discoverSkills({ root: join(tmp, 'sroot') })
  assert.deepEqual(skills.map((s) => s.id), ['alpha', 'beta', 'legacy'])
  assert.equal(skills[0].name, 'Alpha')
  assert.equal(skills[0].version, '1.0.0')
  assert.equal(skills[1].name, 'beta') // 无 name 用 id
  assert.equal(skills[2].description, 'legacy flat')
  assert.ok(skills.every((s) => s.lines > 0))
})

test('discoverSkills（P8 业务适配）：triggers/subskills 列表解析 + parent 单行 + dependencies 回退', () => {
  const root = join(tmp, 'sroot-p8')
  mkdirSync(join(root, 'suite'), { recursive: true })
  mkdirSync(join(root, 'sub1'), { recursive: true })
  mkdirSync(join(root, 'sub2'), { recursive: true })
  writeFileSync(join(root, 'suite', 'SKILL.md'), [
    '---',
    'name: suite',
    'description: 父技能',
    'triggers:',
    '  - 高企认定',
    '  - 知识产权',
    'subskills:',
    '  - sub1',
    '  - sub2',
    '---',
    'body',
  ].join('\n'), 'utf-8')
  writeFileSync(join(root, 'sub1', 'SKILL.md'), '---\nname: sub1\ndescription: 子一\nparent: suite\n---\nbody', 'utf-8')
  writeFileSync(join(root, 'sub2', 'SKILL.md'), [
    '---',
    'name: sub2',
    'description: 子二',
    'triggers: 单行触发',
    'dependencies:',
    '  - legacy',
    '---',
    'body',
  ].join('\n'), 'utf-8')
  const skills = discoverSkills({ root })
  const byId = Object.fromEntries(skills.map((s) => [s.id, s]))
  assert.deepEqual(byId.suite.triggers, ['高企认定', '知识产权'])
  assert.deepEqual(byId.suite.subskills, ['sub1', 'sub2'])
  assert.equal(byId.suite.parent, '')
  assert.equal(byId.sub1.parent, 'suite')
  assert.deepEqual(byId.sub1.triggers, [])
  // 单行 triggers 字符串归一为数组
  assert.deepEqual(byId.sub2.triggers, ['单行触发'])
  // 未声明 subskills 时回退 dependencies
  assert.deepEqual(byId.sub2.subskills, ['legacy'])
})

test('verifySkillVersions：lock 不匹配 → outdated 列表', () => {
  const lockPath = join(tmp, 'skills-lock.json')
  writeFileSync(lockPath, JSON.stringify({ alpha: '1.0.0', beta: '2.0.0', skills: { legacy: '9.0.0' } }), 'utf-8')
  const skills = [
    { id: 'alpha', version: '1.0.0' },
    { id: 'beta', version: '0.9.9' },
    { id: 'legacy', version: '1.1.1' },
    { id: 'gamma', version: '3.0.0' },
  ]
  assert.deepEqual(verifySkillVersions({ lockPath, skills }).outdated.map((o) => o.id), ['beta', 'legacy'])
  assert.deepEqual(verifySkillVersions({ lockPath: join(tmp, 'nope.json'), skills }), { outdated: [] })
})

test('集成：spawn 内核 + 技能目录 → init 事件带 skills 数量与 provider/vision 概览', async () => {
  const configDir = join(tmp, 'scfg')
  const cwd = join(tmp, 'sproj')
  const skillRoot = join(tmp, 'sroot2')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  mkdirSync(join(skillRoot, 'demo'), { recursive: true })
  writeFileSync(join(skillRoot, 'demo', 'SKILL.md'), '---\nname: Demo\ndescription: demo skill\nversion: 1.0.0\n---\nbody', 'utf-8')
  writeFileSync(join(configDir, 'providers.json'), JSON.stringify({
    activeProvider: 'p1',
    providers: [{ id: 'p1', apiBaseUrl: 'https://x.example.com', authToken: 't', primaryModel: 'm1' }],
  }), 'utf-8')
  const child = spawn(process.execPath, [
    join(dirname(fileURLToPath(import.meta.url)), '..', 'kernel', 'cli.mjs'),
    '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--permission-prompt-tool', 'stdio',
    '--disallowedTools', 'AskUserQuestion', '--add-dir', cwd, '--add-dir', skillRoot,
  ], {
    env: { ...process.env, YFW_MOCK_API: '1', CLAUDE_CONFIG_DIR: configDir, YFW_VISION_BASE_URL: 'https://v.example.com', YFW_VISION_MODEL: 'gpt-v' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = []
  const waiters = []
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (l) => {
    const t = l.trim()
    if (!t) return
    if (waiters.length) waiters.shift()(t)
    else lines.push(t)
  })
  const nextEvent = (ms = 5000) => {
    if (lines.length) return Promise.resolve(JSON.parse(lines.shift()))
    return new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('timeout: ' + JSON.stringify(lines))), ms)
      waiters.push((l) => { clearTimeout(to); res(JSON.parse(l)) })
    })
  }
  try {
    const ev = await nextEvent()
    assert.equal(ev.subtype, 'init')
    assert.equal(ev.skills, 1)
    assert.ok(ev.provider && ev.provider.model === 'm1')
    assert.deepEqual(ev.vision, { model: 'gpt-v' })
    assert.ok(Number.isInteger(ev.settings.hooks))
  } finally {
    try { child.stdin.end() } catch {}
  }
})

test('loadSkillContent：跨 root 加载 SKILL.md 目录格式与 legacy 平铺格式，未命中返回 null', () => {
  const r1 = join(tmp, 'lc-root1')
  const r2 = join(tmp, 'lc-root2')
  mkdirSync(join(r1, 'dirskill'), { recursive: true })
  mkdirSync(r2, { recursive: true })
  writeFileSync(join(r1, 'dirskill', 'SKILL.md'), '---\ndescription: dir\n---\n目录格式技能正文', 'utf-8')
  writeFileSync(join(r2, 'flatskill.md'), '---\ndescription: flat\n---\n平铺格式技能正文', 'utf-8')
  assert.equal(loadSkillContent({ roots: [r1, r2], id: 'dirskill' }), '---\ndescription: dir\n---\n目录格式技能正文')
  assert.equal(loadSkillContent({ roots: [r1, r2], id: 'flatskill' }), '---\ndescription: flat\n---\n平铺格式技能正文')
  assert.equal(loadSkillContent({ roots: [r1, r2], id: 'missing' }), null)
  assert.equal(loadSkillContent({ roots: [r1, r2], id: '' }), null)
})

test('discoverSkillsAll：跨 root 去重发现，重复 id 只保留首个', () => {
  const r1 = join(tmp, 'all-root1')
  const r2 = join(tmp, 'all-root2')
  mkdirSync(join(r1, 'dup'), { recursive: true })
  mkdirSync(join(r2, 'dup'), { recursive: true })
  writeFileSync(join(r1, 'dup', 'SKILL.md'), '---\nname: DupOne\n---\nbody1', 'utf-8')
  writeFileSync(join(r2, 'dup', 'SKILL.md'), '---\nname: DupTwo\n---\nbody2', 'utf-8')
  writeFileSync(join(r2, 'only2.md'), '---\nname: OnlyTwo\n---\nbody3', 'utf-8')
  const all = discoverSkillsAll({ roots: [r1, r2] })
  assert.deepEqual(all.map((s) => s.id), ['dup', 'only2'])
  assert.equal(all[0].name, 'DupOne') // 首个 root 的重复 id 胜出
})
