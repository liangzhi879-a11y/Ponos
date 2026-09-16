// kernel-tests/skill-detail.test.mjs
// 技能详情（只读）加载器（2026-09-15，P1 批次二 C）。
//
// 断言重点：
//   ① **显式声明优先**（D1）：SKILL.md 里声明的 `parent` 必须被识别并标 `parentSource='explicit'`
//      —— 这是"父级分类浏览"的权威来源，界面据此区分"声明的"与"按前缀猜的"；
//   ② 关联脚本清单：区分脚本（.py/.sh/...）与伴随文档（.md/.json/...），排除 SKILL.md 自身，
//      且**不列出**非白名单后缀（否则 .gitkeep、临时文件会混进"关联脚本"）；
//   ③ **平铺式技能（<root>/<id>.md）必须返回空脚本清单**：它的"目录"其实是技能根，
//      列出父目录文件会把**别的技能**的文件算作它的关联脚本（误导性错误信息，比"没有"更糟）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSkillDetail } from '../kernel/skills.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'ponos-skill-detail-'))

function makeSkill(root, id, frontmatter = '', files = {}) {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${id}\ndescription: 演示技能\n${frontmatter}---\n\n正文第一行\n正文第二行\n`, 'utf-8')
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, 'utf-8')
  return dir
}

test('基本形态：返回目录/文件路径/行数与标志位', () => {
  const root = tmp()
  try {
    const dir = makeSkill(root, 'demo-skill')
    const d = loadSkillDetail({ roots: [root], id: 'demo-skill' })
    assert.equal(d.id, 'demo-skill')
    assert.equal(d.dir, dir)
    assert.equal(d.skillFile, join(dir, 'SKILL.md'))
    assert.equal(d.isFlat, false)
    assert.ok(d.contentLines >= 5, '行数应反映文件内容')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('**D1 显式声明优先**：parent 被识别且标记 explicit；未声明时 parentSource=none', () => {
  const root = tmp()
  try {
    makeSkill(root, 'with-parent', 'parent: gxtz-group\n')
    const a = loadSkillDetail({ roots: [root], id: 'with-parent' })
    assert.equal(a.parent, 'gxtz-group')
    assert.equal(a.parentSource, 'explicit', '声明的父级必须标 explicit（界面据此区分"作者定的"与"猜的"）')

    makeSkill(root, 'no-parent')
    const b = loadSkillDetail({ roots: [root], id: 'no-parent' })
    assert.equal(b.parent, '')
    assert.equal(b.parentSource, 'none', '未声明 ⇒ none（界面走前缀启发式兜底）')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('触发规则：frontmatter 列表与逗号串两种写法都能解析', () => {
  const root = tmp()
  try {
    makeSkill(root, 'list-form', 'triggers:\n  - 触发甲\n  - 触发乙\n')
    assert.deepEqual(loadSkillDetail({ roots: [root], id: 'list-form' }).triggers, ['触发甲', '触发乙'])

    makeSkill(root, 'comma-form', 'triggers: 触发丙, 触发丁\n')
    assert.deepEqual(loadSkillDetail({ roots: [root], id: 'comma-form' }).triggers, ['触发丙', '触发丁'])

    makeSkill(root, 'none-form')
    assert.deepEqual(loadSkillDetail({ roots: [root], id: 'none-form' }).triggers, [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('关联脚本 vs 伴随文档：按后缀分流，且排除 SKILL.md 自身与非白名单文件', () => {
  const root = tmp()
  try {
    makeSkill(root, 'demo-skill', '', {
      'run.py': 'print(1)\n',
      'helper.sh': 'echo hi\n',
      'gen.mjs': 'export {}\n',
      'notes.md': '# 说明\n',
      'config.json': '{}\n',
      '.gitkeep': '',                 // 非白名单：不得出现在任何清单里
      'temp.swp': 'x',                // 同上
    })
    const d = loadSkillDetail({ roots: [root], id: 'demo-skill' })
    assert.deepEqual(d.scripts.map((s) => s.name).sort(), ['gen.mjs', 'helper.sh', 'run.py'])
    assert.deepEqual(d.docs.map((x) => x.name).sort(), ['config.json', 'notes.md'])
    assert.equal([...d.scripts, ...d.docs].some((f) => f.name === 'SKILL.md'), false, '不列 SKILL.md 自身')
    assert.equal([...d.scripts, ...d.docs].some((f) => f.name === '.gitkeep'), false, '非白名单后缀不得混入关联脚本')
    assert.equal([...d.scripts, ...d.docs].some((f) => f.name === 'temp.swp'), false)
    assert.ok(d.scripts[0].sizeKb >= 1, 'sizeKb 至少 1（0KB 会让界面显示得像是空脚本）')
    assert.ok(d.scripts[0].path.startsWith(d.dir), '脚本路径应为绝对可打开路径（界面据此调系统打开）')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('**平铺式技能**：返回空脚本清单（不得把父目录里别的技能文件算作它的脚本）', () => {
  const root = tmp()
  try {
    // 平铺形态：<root>/<id>.md；同一目录下还有**另一个**技能与一个脚本
    writeFileSync(join(root, 'flat-skill.md'), '---\nname: flat-skill\ndescription: 平铺\n---\n\n正文\n', 'utf-8')
    writeFileSync(join(root, 'other-skill.md'), '---\nname: other-skill\ndescription: 另一个\n---\n\n正文\n', 'utf-8')
    writeFileSync(join(root, 'somebody-else.py'), 'print(2)\n', 'utf-8')

    const d = loadSkillDetail({ roots: [root], id: 'flat-skill' })
    assert.equal(d.isFlat, true)
    assert.equal(d.skillFile, join(root, 'flat-skill.md'))
    assert.deepEqual(d.scripts, [], '**关键**：平铺形态不列脚本（否则会把别的技能的文件算成它的）')
    assert.deepEqual(d.docs, [], '伴随文件同理不列')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('flatRoots 白名单：非白名单根下的平铺技能不解析（与 discoverSkills 同口径）', () => {
  const root = tmp()
  try {
    writeFileSync(join(root, 'flat-skill.md'), '---\nname: flat-skill\ndescription: 平铺\n---\n\n正文\n', 'utf-8')
    // 传入 flatRoots=[] ⇒ 该根不走平铺形态
    assert.equal(loadSkillDetail({ roots: [root], id: 'flat-skill', flatRoots: [] }), null)
    // 不传 flatRoots ⇒ 允许平铺（与缺省行为一致）
    assert.ok(loadSkillDetail({ roots: [root], id: 'flat-skill' }))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('未找到 / 空 id / 根不存在 → null（调用方出 404，别拿到半个对象）', () => {
  const root = tmp()
  try {
    assert.equal(loadSkillDetail({ roots: [root], id: 'ghost' }), null)
    assert.equal(loadSkillDetail({ roots: [root], id: '' }), null)
    assert.equal(loadSkillDetail({ roots: [root], id: '   ' }), null)
    assert.equal(loadSkillDetail({ roots: [join(root, 'nope')], id: 'demo' }), null)
    assert.equal(loadSkillDetail({ roots: [], id: 'demo' }), null)
    // 目录存在但没有 SKILL.md：不算技能
    mkdirSync(join(root, 'empty-dir'), { recursive: true })
    assert.equal(loadSkillDetail({ roots: [root], id: 'empty-dir' }), null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('多根：在第一个命中的根里解析（与 discoverSkills 的先后顺序一致）', () => {
  const r1 = tmp(); const r2 = tmp()
  try {
    makeSkill(r2, 'only-in-root2', 'parent: p2\n')
    const d = loadSkillDetail({ roots: [r1, r2], id: 'only-in-root2' })
    assert.equal(d.parent, 'p2')
    assert.ok(d.dir.startsWith(r2))
  } finally { rmSync(r1, { recursive: true, force: true }); rmSync(r2, { recursive: true, force: true }) }
})

test('subskills 声明被解析（父级子级分类浏览的依据之一）', () => {
  const root = tmp()
  try {
    makeSkill(root, 'parent-skill', 'subskills:\n  - child-a\n  - child-b\n')
    assert.deepEqual(loadSkillDetail({ roots: [root], id: 'parent-skill' }).subskills, ['child-a', 'child-b'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
