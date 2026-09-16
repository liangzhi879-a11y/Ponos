// S2-D6 归一规则 parity：内核 `shared/tag-registry.mjs` ≡ 渲染层 `src/lib/knowledgeTags.ts`
// ---------------------------------------------------------------------------
// 【为什么需要这个文件】D6 把标签的"归一规则"内核侧实现放进了 `shared/tag-registry.mjs`，而渲染层
// 早已有一份 `knowledgeTags.ts` 的 `normalizeTag`（标签树的展示口径）。同一个标签若被两处用不同
// 规则理解，会出现一种很难查的坏现象：**合并表认 A、索引里存 A′、界面显示 A″** —— 用户明明合并了
// 两个标签，界面上仍是两个。这里把两份实现放在**同一张用例表**上逐例对比：规则一旦分叉立刻变红，
// 而不是等用户在界面上看到"合并了却没生效"。
//
// 【为什么放在 kernel-tests 而不是 src/lib】本文件要**运行时 import** `shared/*.mjs`。src 侧此前从无
// TS→shared/*.mjs 的运行时 import（`knowledgeTags.test.ts` 里出现的 `shared/` 是文档注释里的路径提及，
// 不是 import），首次引入会触发 `tsc` 的 TS7016（JS 文件无类型声明）——在 src 下要么加 shim、要么
// `@ts-ignore`（本仓无此先例）。放在 kernel-tests（**不过 tsc**）既保持零噪声，又能真跑跨层校验：
// 该目录直接 `import '../src/lib/knowledgeTags.ts'` 经实测可行（Node 类型剥离）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeTag } from '../src/lib/knowledgeTags.ts'
import { normalizeTagName } from '../shared/tag-registry.mjs'

/** 逐例表：覆盖前导 #、重复/首尾斜杠、空白、空值、非字符串等边界 */
const CASES = [
  '财务', '#财务', '###财务', ' 财务 ', '  财务  ',
  '财务部/', '/财务部', '//财务部//',
  'a//b/', '//a///b//', 'a/b/c', '税务/增值税', '#税务/增值税/',
  'a', '#', '###', '/', '//', '   ', '', null, undefined,
  '#/a/', 'a//', '/a', 'A/B', 'a b/c d', 123, '0',
]

test('parity：内核 normalizeTagName ≡ 渲染层 normalizeTag（同一张用例表逐例一致）', () => {
  for (const raw of CASES) {
    const kernel = normalizeTagName(raw)
    const renderer = normalizeTag(raw)
    assert.equal(
      kernel, renderer,
      `归一规则分叉：输入 ${JSON.stringify(raw)} → 内核 ${JSON.stringify(kernel)} / 渲染层 ${JSON.stringify(renderer)}`,
    )
  }
})

test('parity：规则要点本身（防"两边一起错"的假一致）', () => {
  // 这条给"两边同时被改错"兜底：要点写成显式断言，就算 parity 仍成立也会红
  for (const [raw, want] of [
    ['#财务', '财务'], ['###财务', '财务'], ['  #财务  ', '财务'],
    ['a//b/', 'a/b'], ['//a///b//', 'a/b'], ['#/a/', 'a'],
  ]) {
    assert.equal(normalizeTagName(raw), want, `内核规则要点：${raw}`)
    assert.equal(normalizeTag(raw), want, `渲染层规则要点：${raw}`)
  }
  // 空 → null（不是空串）：否则会有一个"看不见的标签"混进标签树与计数
  for (const raw of ['', '   ', '#', '///', null, undefined]) {
    assert.equal(normalizeTagName(raw), null, `内核空值口径：${JSON.stringify(raw)}`)
    assert.equal(normalizeTag(raw), null, `渲染层空值口径：${JSON.stringify(raw)}`)
  }
})

test('解析器把归一"吃进去"：存量脏写法也能与规范实体对上（旧数据无需迁移）', async () => {
  const { createTagRegistry, ensureTag, resolveTagName } = await import('../shared/tag-registry.mjs')
  const reg = createTagRegistry()
  ensureTag(reg, '财务', { scope: 'personal' })
  // 历史上存进库里的可能是未归一写法（内核 collectTags 只去前导 #，不合并 //、不去首尾 /）
  for (const dirty of ['#财务', ' 财务 ', '财务/', '//财务']) {
    assert.equal(resolveTagName(reg, dirty, { scope: 'personal' }), '财务', `${dirty} 应解析到规范实体`)
  }
})
