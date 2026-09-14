// S5.1（条目级图谱层级 + 引用接入为 ref 类型 + 伪链接修复）中 **ref 层**的回归测试。
//
// 被钉住的四件事（spec `2026-09-13-knowledge-relations-s51-design.md` §3/§4）：
//   ① **伪链接必须被拦**：真实库 workflow.md 讲 JS 写法时写了 `` `anyOf:[['a','b']]` ``，
//      wiki 正则把 JS 嵌套数组当成 [[引用]]，于是 links.jsonl 出现 `{"to":"'a','b'"}` 垃圾行
//      （全库 7 个文档唯一的链接就是这个假货）。两道防护：代码跨度排除 + 目标形状校验。
//   ② **真链接必须产生条目级 ref 边**：源 = 链接所在的**条目**（不是文档），
//      目标 = 被引文档的条目，按内容相似度取前 MAX_REF_RELATED。没有这条，
//      "引用一条经验"就永远关联不到别的经验（用户实测反馈的原始痛点）。
//   ③ **断链不产生边**：`target` 为 null（指向不存在的文档）时零边 —— 这同时是①的兜底。
//   ④ **ref 边不因内容改动失效**：引用是**手写意图**，"这条经验引用了那篇文档"不因
//      目标内容被编辑而消失；故 `validateRelation` 的 ref 分支只要求两端存在，**不比指纹**。
//
// 隔离纪律：全部走 mkdtempSync 临时 configDir，绝不碰真实 ~/.yfworking / ~/.yfw。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKnowledgeStore } from '../kernel/knowledge.mjs'
import { extractLinks, validateRelation, MAX_REF_RELATED } from '../shared/knowledge-core.mjs'

function makeHome() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kref-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  return { dir, personal }
}

const A_LINES = [
  '# 主题甲',
  '',
  '- [会话|主题甲] 甲零 -- 这条甲零讲部署流程与回滚步骤的具体做法，涵盖环境准备与验证要点',
  '- [会话|主题甲] 甲一 -- 详见 [[b.md]] 里关于数据库迁移的做法，本条讲迁移前置检查与备份策略',
]

function seedB(personal, n) {
  const lines = ['# 主题乙', '']
  for (let i = 0; i < n; i++) {
    lines.push(`- [会话|主题乙] 乙${i} -- 乙${i}讲数据库迁移的第${i}种情形：表结构变更、索引重建与回滚`,
      `  以及迁移期间的双写与一致性校验细节，编号 ${i}`)
  }
  writeFileSync(join(personal, 'b.md'), lines.join('\n'), 'utf8')
}

test('① 伪链接：代码跨度内的 [[..]] 与形状异常的目标都不产生链接', () => {
  // 真实库那条垃圾的原始形态：JS 嵌套数组写在行内代码里
  assert.deepEqual(extractLinks("要写成 `anyOf:[['a','b']]`（我第一版写错）"), [])
  assert.deepEqual(extractLinks("[[a'b]]"), [], '含单引号的目标不是路径 → 拒')
  assert.deepEqual(extractLinks("[x](a,b)"), [], '逗号不是路径字符 → 拒')
  // 真链接照旧可用（别把防护做过头，误伤正常引用）
  assert.equal(extractLinks('详见 [[b.md]]').length, 1)
  assert.equal(extractLinks('见 [文档](sub/c.md)').length, 1)
})

test('② 真引用产生条目级 ref 边：源是**条目**、目标是**被引文档的条目**（≤3）', async () => {
  const { dir, personal } = makeHome()
  try {
    writeFileSync(join(personal, 'a.md'), A_LINES.join('\n'), 'utf8')
    seedB(personal, 5) // 5 条 > MAX_REF_RELATED(3)，验证上限真的生效
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })

    // links 行必须带块定位（否则无从知道"是哪条经验引用的"）。
    // 用 `getLinkOut()`（暴露内部 linkOut，含 block/line）；`getLinks()` 面向反链、不含 block，
    // 故不为了测试去扩它的返回形态（那会动到 S2 既有断言）。
    const link = store.getLinkOut().get('experience/a.md').find((l) => l.to === 'b.md')
    assert.ok(link, '真引用应进 linkOut')
    assert.equal(link.target, 'experience/b.md', 'target 解析成功')
    // `n` 是**全块序号**（块 0 是 `# 主题甲` 标题），故第 2 条条目的 id 是 #2
    assert.equal(link.block, 2, '链接在第 2 条条目里 → block=2（不是文档级 null）')

    const rel = store.getRelated('experience/a.md#2', { validate: false })
    const refs = rel.filter((r) => r.why.kind === 'ref')
    assert.ok(refs.length > 0, '引用必须产生 ref 边（用户痛点：引用关联不到别的经验）')
    assert.equal(refs.length, MAX_REF_RELATED, `目标数受 MAX_REF_RELATED=${MAX_REF_RELATED} 约束`)
    assert.ok(refs.every((r) => r.docId === 'experience/b.md'), 'ref 边的目标应全部落在被引文档内')
    assert.ok(refs.every((r) => r.why.to === 'experience/b.md'), 'why 里记着被引文档，供 UI 显示"引用：<文档>"')
    // 源必须是**条目**而不是文档：文档级源会让 ref 边挂在不存在锚点的位置上。
    // 从 a 的视角看，返回项是**目标**（b 的条目）；源的形态由**反向边**验证。
    assert.ok(refs.every((r) => r.blockId.startsWith('experience/b.md#')), '锚点项是目标（b 的条目）')
    const back = store.getRelated(refs[0].blockId, { validate: false }).filter((r) => r.why.kind === 'ref')
    assert.ok(back.some((r) => r.blockId === 'experience/a.md#2'),
      '反向边：被引条目能回答"谁引用了我"，且源是**条目** id（docId#n）而非文档')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('③ 断链（指向不存在的文档）不产生任何 ref 边', async () => {
  const { dir, personal } = makeHome()
  try {
    writeFileSync(join(personal, 'a.md'), [
      '# 甲', '',
      '- [会话|甲] 甲零 -- 详见 [[nope.md]] 但那个文档不存在，本条讲部署与回滚的具体步骤做法',
    ].join('\n'), 'utf8')
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const l = store.getLinkOut().get('experience/a.md').find((x) => x.to === 'nope.md')
    assert.equal(l.target, null, '解析不到 → target=null（links 仍留痕，便于 GUI 显示断链）')
    const refs = store.getRelated('experience/a.md#0', { validate: false }).filter((r) => r.why.kind === 'ref')
    assert.equal(refs.length, 0, '断链零 ref 边（这是伪链接的兜底防线）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('④ ref 边不按内容指纹校验——被引内容改了也不失效（手写意图 ≠ 内容派生）', () => {
  const edge = {
    from: 'experience/a.md#2', to: 'experience/b.md#1', why: { kind: 'ref', to: 'experience/b.md', score: 0.2 },
    sigFrom: 'deadbeef0000', sigTo: 'cafebabe0000', // 故意与当前内容指纹都不符
  }
  const mk = (text) => ({ kind: 'entry', text, full: text, tag: null })
  const lookup = (id) => (id === 'experience/a.md#2' ? mk('甲一 现在改过了') : mk('乙零 也改过了'))
  assert.equal(validateRelation(edge, lookup), true,
    'ref 只要求两端存在：引用是手写意图，不该因目标改一个字就凭空消失')
  // 对照：content 边同样输入**必须**被剔除（指纹不符）——证明上面不是"校验被整体关掉"
  const cEdge = { ...edge, why: { kind: 'content', score: 0.2, shared: ['x'] } }
  assert.equal(validateRelation(cEdge, lookup), false, 'content 边仍严格比对指纹')
  // 端点消失时 ref 边照样剔除
  assert.equal(validateRelation(edge, (id) => (id === 'experience/a.md#2' ? mk('x'.repeat(30)) : null)), false,
    '端点不存在 → ref 边也剔除')
})
