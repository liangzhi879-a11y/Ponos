// T1.2（治理计划 2026-10-20-token-context-governance）：技能清单阶梯 —— 修"悬崖"。
//
// 问题（问0）：旧阶梯是 ['triggers', 'desc', 'ids']，而实测 triggers 14,885 B < desc 22,332 B
// ⇒ 档位**非单调**：任何 < 14.9 KB 的预算都会跳过 desc **直接掉到 ids（2,076 B）**，
// 一次掉 12.8 KB —— 触发词全丢，"该用技能没用"必然上升。这不是节省，是悬崖。
//
// 改法：只做"一件事的连续退化" —— 触发词 80→48→40→32→24，连 24 字档都装不下才退 ids。
//   `desc` 档删除（它比全量 triggers 还大，作为"更省"的中间档根本不成立 = 假阶梯）。
//
// 本文件钉住 6 条（前 3 条在改动前必红）：
//   ① ★ 单调：预算越大字节数不减（旧阶梯在 14.9 KB 附近会"预算变小反而变短 12.8 KB"）
//   ② ★ 8192 预算落 24 字档且**保留全部 id**（丢 id = 丢能力，是本任务的硬底线）
//   ③ ★ 小于全量 triggers 的预算不得一步掉到 ids 档（旧实现必红）
//   ④ 缺省（不传预算）逐字节等于改动前形态（存量行为不变）
//   ⑤ 极小预算仍保全部 id（宁超预算也不丢技能）
//   ⑥ 子技能仍内联在父技能行（既有语义一字不改）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderSkillCatalog, resolveSkillCatalogBudget } from '../kernel/prompt.mjs'

/** 造 n 个带长触发词的父技能（贴近实测量级：triggers 全量 ≈14.9 KB / 89 个父技能） */
function manySkills(n = 40) {
  return Array.from({ length: n }, (_, i) => ({
    id: `skill-${String(i).padStart(2, '0')}`,
    description: `第 ${i} 个技能的说明文字，用于在没有触发词时回退展示`,
    // 触发词要够长：真实技能表里 triggers 单条约 160 B（多个中文触发词），
    // 这样 40 个父技能的全量才落到 6 KB 以上，70% 预算才有区分度
    triggers: [`触发词甲${i}号`, `触发词乙${i}号`, `触发词丙${i}号`, `触发词丁${i}号`, `触发词戊${i}号`, `触发词己${i}号`],
    parent: null,
  }))
}

const bytes = (t) => Buffer.byteLength(t, 'utf8')
const idsOf = (skills) => skills.filter((s) => !s.parent).map((s) => s.id)

test('★★ ② 预算 8192 ⇒ 落 24 字档且保留全部 id', () => {
  const skills = manySkills()
  const text = renderSkillCatalog(skills, 8192)
  assert.ok(bytes(text) <= 8192, `预算 8192 下清单实测 ${bytes(text)} B，超预算`)
  for (const id of idsOf(skills)) {
    assert.ok(text.includes(id), `★ 丢失技能 id ${id} —— "保留全部 id"是硬底线（丢 id = 丢能力）`)
  }
  // 必须还在 triggers 档（有触发词），而不是掉到 ids 档（只有 id 没有触发词）
  assert.ok(text.includes('触发词甲0号'), '★ 8192 预算下必须仍带触发词（掉到 ids 档 = 触发词全丢）')
  assert.equal(text.includes('仅列 id'), false, '★ 不得落到 ids 终档')
})

test('★ ③ 小于全量触发词字节的预算不得一步掉到 ids 档（旧实现必红）', () => {
  const skills = manySkills()
  const full = bytes(renderSkillCatalog(skills, null))
  assert.ok(full > 5_000, `夹具自检：全量触发词应足够大（实测 ${full} B）`)
  // 取全量的 70%：旧阶梯下 desc 比全量还大 ⇒ 直接掉 ids（2 KB 级）；新阶梯应落中间档
  const budget = Math.floor(full * 0.7)
  const text = renderSkillCatalog(skills, budget)
  assert.ok(bytes(text) <= budget, `应满足预算（实测 ${bytes(text)} vs ${budget}）`)
  assert.equal(text.includes('仅列 id'), false,
    `★ 预算为全量的 70%（${budget} B）时不得直接掉到 ids 档 —— 这正是旧阶梯的悬崖（一次丢 12.8 KB 触发词）`)
  // 仍须有"每个技能的细节"：触发词或描述二选一（哪个更省由技能库本身决定 ——
  // 有的库描述短、触发词长，此时 desc 档才是合理降级；这正是"按实际字节择优"的意义）
  assert.ok(text.includes('触发词甲0号') || text.includes('第 0 个技能的说明文字'),
    '必须仍带每个技能的细节（触发词或描述），不能只剩 id')
})

test('★ ① 单调：预算越大，字节数不减（旧阶梯非单调，必红）', () => {
  const skills = manySkills()
  const budgets = [null, 12_000, 9_000, 8_192, 7_000, 5_000, 3_000, 500]
  const sizes = budgets.map((b) => bytes(renderSkillCatalog(skills, b)))
  for (let i = 1; i < budgets.length; i++) {
    // 预算在递减（null = 无上限视作最大），字节数必须**不增**
    assert.ok(sizes[i] <= sizes[i - 1] + 1,
      `预算 ${String(budgets[i])} 的清单（${sizes[i]} B）比更宽松的 ${String(budgets[i - 1])}（${sizes[i - 1]} B）更大 ⇒ 阶梯非单调`)
  }
})

test('④ 缺省（不传预算）逐字节等于改动前形态', () => {
  const skills = manySkills()
  const a = renderSkillCatalog(skills)
  const b = renderSkillCatalog(skills, null)
  const c = renderSkillCatalog(skills, 0)
  const d = renderSkillCatalog(skills, -5)
  assert.equal(a, b, 'null 与缺省必须一致')
  assert.equal(a, c, '0 不解释为"不注入"（预算 0 会退化成 triggers 档，不是清单消失）')
  assert.equal(a, d)
  // 触发词仍是 80 字上限（既有语义）
  assert.ok(a.includes('触发词甲0号'))
})

test('⑤ 极小预算仍保全部 id（宁超预算也不丢技能）', () => {
  const skills = manySkills()
  const text = renderSkillCatalog(skills, 100)   // 远小于 ids 档也不会丢 id
  for (const id of idsOf(skills)) assert.ok(text.includes(id), `极小预算下仍必须保留 id ${id}`)
  assert.ok(bytes(text) > 100, '（允许超预算：这是刻意的取舍，超限由调用方观测告警）')
})

test('⑥ 子技能内联在父技能行（既有语义不变）', () => {
  const skills = [
    { id: 'parent-a', description: '父技能', triggers: ['父触发'], parent: null },
    { id: 'child-b', description: '子技能', triggers: ['子触发'], parent: 'parent-a' },
    { id: 'parent-c', description: '另一个父', triggers: ['另一触发'], parent: null },
  ]
  const text = renderSkillCatalog(skills)
  assert.ok(text.includes('parent-a：父触发（子：child-b）'), `子技能必须内联在父行：${text}`)
  // 子技能不单独成行（既有语义）
  assert.equal(/- child-b/.test(text), false, '子技能不得单独成行')
})

test('resolveSkillCatalogBudget：缺省不设限（不改存量行为），正数一律取整', () => {
  assert.equal(resolveSkillCatalogBudget({ settings: null }), null)
  assert.equal(resolveSkillCatalogBudget({ settings: {} }), null, '★ 设置缺省仍是 null（GC7：改默认是独立一步）')
  assert.equal(resolveSkillCatalogBudget({ settings: { skill: { catalogBudgetBytes: 0 } } }), null)
  assert.equal(resolveSkillCatalogBudget({ settings: { skill: { catalogBudgetBytes: -1 } } }), null)
  assert.equal(resolveSkillCatalogBudget({ settings: { skill: { catalogBudgetBytes: 'abc' } } }), null)
  assert.equal(resolveSkillCatalogBudget({ settings: { skill: { catalogBudgetBytes: 8192.9 } } }), 8192)
  assert.equal(resolveSkillCatalogBudget({ settings: { skill: { catalogBudgetBytes: 8192 } } }), 8192,
    '显式配置必须生效（否则机制存在 ≠ 机制生效）')
})
