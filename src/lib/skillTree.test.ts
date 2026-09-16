// src/lib/skillTree.test.ts
// 技能父子归属与分类的纯逻辑（2026-09-15，P1 批次二 C）。
//
// 这份测试存在的意义 = 把两个**曾在界面上真实发生的缺陷**钉死（它们都属"静默失败"：
// 不报错、不提示，只是东西不见了或归类错了，用户几乎无法归因）：
//   ① **父级判据不一致** ⇒ 只被 `parent` 反指的父级被当普通技能 ⇒ **子技能不渲染**；
//   ② **孤儿技能彻底消失** ⇒ 声明了 `parent` 但父级不在（未安装/拼写错/跨根）⇒
//      既被顶层过滤掉（`!s.parent`）、又在渲染时被跳过（`if (s.parent) return null`），
//      用户在界面上**看不到它**，也无法查看详情/使用。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  defaultFolderOf, resolveFolder, isParentSkill, childIdsOf, isOrphanChild,
  topLevelSkills, childrenToShow,
} from './skillTree.ts'

type S = { id: string; parent?: string; subskills?: string[] }
const mk = (id: string, extra: Partial<S> = {}): S => ({ id, ...extra })

// ── 分类（folder）──────────────────────────────────────────────────────────

test('defaultFolderOf：既有前缀启发式保持不变（改口径会让老用户技能整批换组）', () => {
  for (const id of ['gxtz-ip-tables', 'yfwdoc-word', 'yfwweb-scrape', 'yfwx-suite']) {
    assert.equal(defaultFolderOf(id), 'Working', `${id} 应归 Working`)
  }
  for (const id of ['brainstorming', 'test-driven-development', 'my-skill']) {
    assert.equal(defaultFolderOf(id), 'Coding', `${id} 应归 Coding`)
  }
})

test('resolveFolder：**人工指派优先于前缀启发式**', () => {
  const map = { 'gxtz-ip-tables': 'Coding', 'plain-skill': 'Working' }
  assert.equal(resolveFolder('gxtz-ip-tables', map), 'Coding', '显式指派必须压过前缀推断')
  assert.equal(resolveFolder('plain-skill', map), 'Working')
  assert.equal(resolveFolder('gxtz-other', map), 'Working', '未指派的仍走启发式')
  assert.equal(resolveFolder('plain-other', map), 'Coding')
})

test('resolveFolder：指派为空串/纯空白时回落到启发式（不产生空分组名）', () => {
  assert.equal(resolveFolder('gxtz-a', { 'gxtz-a': '' }), 'Working', '空串不该变成"无分类"')
  assert.equal(resolveFolder('gxtz-a', { 'gxtz-a': '   ' }), 'Working')
  assert.equal(resolveFolder('plain-a', undefined), 'Coding', 'map 缺失也不崩')
})

// ── 父级判据（缺陷 ① 的回归）──────────────────────────────────────────────

test('**回归 ①**：只被 `parent` 反指的父级也必须判为父级（否则子技能不渲染）', () => {
  // 场景：父级自己没写 subskills，只有子技能用 parent 指向它（本仓库官方支持的写法）
  const all = [mk('yfwx-suite'), mk('yfwx-project-eval', { parent: 'yfwx-suite' })]
  const parent = all[0]
  assert.deepEqual(parent.subskills, undefined, '前提：父级未声明 subskills')
  assert.equal(isParentSkill(parent, all), true,
    '**关键**：判据必须合并双来源，否则该父级被当普通技能 ⇒ 子技能永远不渲染')
})

test('isParentSkill：声明了 subskills 即为父级；两者都无则否', () => {
  const all = [mk('p', { subskills: ['c'] }), mk('c'), mk('lone')]
  assert.equal(isParentSkill(all[0], all), true)
  assert.equal(isParentSkill(all[1], all), false)
  assert.equal(isParentSkill(all[2], all), false)
})

test('isParentSkill：自指（parent 指向自己）不得被判为父级（否则自己成为自己的子项）', () => {
  const all = [mk('self', { parent: 'self' })]
  assert.equal(isParentSkill(all[0], all), false, '自指的坏数据不该让技能变成父级')
})

test('childIdsOf：双来源合并 + 去重 + 剔除不存在 + 排除自指', () => {
  const all = [
    mk('p', { subskills: ['a', 'ghost', 'p'] }), // 含不存在的 ghost 与自指 p
    mk('a', { parent: 'p' }),                    // a 同时被两种来源指到 ⇒ 去重
    mk('b', { parent: 'p' }),                    // 仅 parent 来源
    mk('z'),
  ]
  const ids = childIdsOf(all[0], all)
  assert.deepEqual(ids.sort(), ['a', 'b'], 'ghost（不存在）与 p（自指）必须剔除，a 不重复')
})

test('childIdsOf：父级 subskills 里写着但列表里不存在的 id 不返回（避免渲染洞）', () => {
  const all = [mk('p', { subskills: ['not-installed'] })]
  assert.deepEqual(childIdsOf(all[0], all), [], '不存在的子项不能出现在渲染清单里')
})

// ── 孤儿判定（缺陷 ② 的回归）──────────────────────────────────────────────

test('**回归 ②**：parent 指向不存在的技能 ⇒ 孤儿（必须留在顶层，否则界面上彻底消失）', () => {
  const all = [mk('child', { parent: 'not-installed' })]
  assert.equal(isOrphanChild(all[0], all), true)
  const visible = topLevelSkills(all, () => true)
  assert.deepEqual(visible.map((s) => s.id), ['child'],
    '**关键**：孤儿若不留在顶层，它就既不是顶层、也不是任何人的子项 —— 用户看不到它')
})

test('isOrphanChild：父级存在 ⇒ 不是孤儿；未声明 parent ⇒ 不是孤儿', () => {
  const withParent = [mk('p'), mk('c', { parent: 'p' })]
  assert.equal(isOrphanChild(withParent[1], withParent), false)
  const noParent = [mk('solo')]
  assert.equal(isOrphanChild(noParent[0], noParent), false)
})

test('isOrphanChild：parent 不存在但自己被他人的 subskills 收录 ⇒ 不算孤儿（会被渲染为子项）', () => {
  const all = [mk('p', { subskills: ['c'] }), mk('c', { parent: 'ghost-parent' })]
  assert.equal(isOrphanChild(all[1], all), false,
    '它已经能作为 p 的子项被渲染出来，不需要（也不该）再在顶层重复出现')
})

// ── 顶层可见技能 ──────────────────────────────────────────────────────────

test('topLevelSkills：正常父子结构下，子技能不出现在顶层（避免重复渲染）', () => {
  const all = [mk('p', { subskills: ['c'] }), mk('c', { parent: 'p' }), mk('solo')]
  assert.deepEqual(topLevelSkills(all, () => true).map((s) => s.id).sort(), ['p', 'solo'])
})

test('topLevelSkills：搜索命中子技能时把父级一并带出（否则"搜到了却看不到入口"）', () => {
  const all = [mk('p', { subskills: ['c'] }), mk('c', { parent: 'p' })]
  const matches = (s: S) => s.id === 'c'
  assert.deepEqual(topLevelSkills(all, matches).map((s) => s.id), ['p'],
    '父级必须带出 —— 子项是折叠在父级下的，只留子项等于搜不到')
})

test('topLevelSkills：搜索命中父级时保留父级', () => {
  const all = [mk('p', { subskills: ['c'] }), mk('c', { parent: 'p' })]
  assert.deepEqual(topLevelSkills(all, (s: S) => s.id === 'p').map((s) => s.id), ['p'])
})

test('topLevelSkills：无搜索（matches 恒真）时父级带出所有父级，且不重复', () => {
  const all = [mk('p1', { subskills: ['c1'] }), mk('c1', { parent: 'p1' }), mk('p2'), mk('c2', { parent: 'p2' })]
  const visible = topLevelSkills(all, () => true).map((s) => s.id)
  assert.deepEqual(visible.sort(), ['p1', 'p2'])
  assert.equal(new Set(visible).size, visible.length, '不得重复')
})

test('topLevelSkills：孤儿 + 搜索不命中 ⇒ 不显示（搜索结果仍应尊重过滤）', () => {
  const all = [mk('orphan', { parent: 'gone' })]
  assert.deepEqual(topLevelSkills(all, (s: S) => s.id === 'other'), [],
    '孤儿留在顶层 ≠ 无视搜索（否则搜任何词都看到它）')
})

// ── 子项显示 ──────────────────────────────────────────────────────────────

test('childrenToShow：非搜索态显示全部子项', () => {
  const all = [mk('p', { subskills: ['a', 'b'] }), mk('a', { parent: 'p' }), mk('b', { parent: 'p' })]
  const kids = childrenToShow(all[0], all, () => true, false)
  assert.deepEqual(kids.map((k) => k.id).sort(), ['a', 'b'])
})

test('childrenToShow：搜索态下父级命中 → 显示全部子项（父级是你找的那个，子项要能一起看）', () => {
  const all = [mk('p', { subskills: ['a', 'b'] }), mk('a', { parent: 'p' }), mk('b', { parent: 'p' })]
  const kids = childrenToShow(all[0], all, (s: S) => s.id === 'p', true)
  assert.deepEqual(kids.map((k) => k.id).sort(), ['a', 'b'])
})

test('childrenToShow：搜索态下父级未命中 → 只显示命中的子项', () => {
  const all = [mk('p', { subskills: ['a', 'b'] }), mk('a', { parent: 'p' }), mk('b', { parent: 'p' })]
  const kids = childrenToShow(all[0], all, (s: S) => s.id === 'a', true)
  assert.deepEqual(kids.map((k) => k.id), ['a'], '父级只是被带出来的容器，不该把无关子项也摊开')
})

test('childrenToShow：无子项 → 空数组（且不因缺字段抛错）', () => {
  const all = [mk('lone')]
  assert.deepEqual(childrenToShow(all[0], all, () => true, false), [])
  assert.deepEqual(childrenToShow(all[0], all, () => true, true), [])
})

test('真实样例数据（runtime/skills 的 yfwx 父子对）走通全链路', () => {
  // 与磁盘上的真实声明一致：yfwx-project-eval 声明 parent: yfwx-suite
  const all: S[] = [
    mk('yfwx-suite'),
    mk('yfwx-project-eval', { parent: 'yfwx-suite' }),
    mk('gxtz-ip-tables'),
  ]
  assert.equal(isParentSkill(all[0], all), true, '父级由子项的 parent 反指即可成立')
  assert.equal(isOrphanChild(all[1], all), false, '父级已安装，不是孤儿')
  assert.deepEqual(topLevelSkills(all, () => true).map((s) => s.id).sort(), ['gxtz-ip-tables', 'yfwx-suite'])
  assert.deepEqual(childrenToShow(all[0], all, () => true, false).map((s) => s.id), ['yfwx-project-eval'])
  assert.equal(defaultFolderOf('yfwx-suite'), 'Working')
})
