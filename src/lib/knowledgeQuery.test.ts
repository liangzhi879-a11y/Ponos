// src/lib/knowledgeQuery.test.ts
// 运行：node --test src/lib/knowledgeQuery.test.ts（Node 原生 TS 服务）
//
// 前端检索语法镜像（`src/lib/knowledgeQuery.ts`）用例（批次 3）。
//
// 这份前端实现**只服务 UI 提示**（输入过程中的算子提示、高亮分词），不参与结果判定 ——
// 但它必须与内核**同口径**：否则 UI 会提示"字段 10 已生效"而结果是按文本搜的，
// 提示与实际行为不符比不提示更糟（用户会据此判断结果为何变少）。
//
// 因此这一组用例与 `shared/knowledge-query.test.mjs` 的关键用例**刻意重复**：
// 两份实现各自独立钉住同一组行为，任何一边漂移都会被自己的用例抓住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describeQuery, splitOperator, tokenizeQueryForHighlight } from './knowledgeQuery.ts'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

test('批次3：未知字段/时间/URL 回落成文本，不误报成算子', () => {
  for (const q of ['10:30', 'http://example.com', 'a:b', '1:2']) {
    assert.equal(splitOperator(q), null, `${q} 不是算子`)
    assert.deepEqual(describeQuery(q).fields, [], `${q} 不该报出算子字段`)
  }
  // 具体到 `10:30`：若 UI 报"字段 10 已生效"，用户会以为过滤生效了（实际按文本搜）
  assert.deepEqual(describeQuery('ratio 1:2').fields, [])
})

test('批次3：已知字段（含别名与大小写）识别为算子', () => {
  assert.deepEqual(splitOperator('tag:财务'), { field: 'tag', value: '财务' })
  assert.deepEqual(splitOperator('tags:财务'), { field: 'tag', value: '财务' })
  assert.deepEqual(splitOperator('heading:背景'), { field: 'section', value: '背景' })
  assert.deepEqual(splitOperator('line:营收'), { field: 'content', value: '营收' })
  assert.deepEqual(splitOperator('TAG:财务'), { field: 'tag', value: '财务' })
  // 冒号在首/末位都不算算子（与内核同一判据）
  assert.equal(splitOperator(':x'), null)
  assert.equal(splitOperator('tag:'), null)
})

test('批次3：describeQuery 汇总算子字段、布尔标志与"无正向文本"', () => {
  assert.deepEqual(describeQuery('tag:财务 path:reports/').fields, ['tag', 'path'])
  assert.equal(describeQuery('tag:财务').noPositiveText, true)
  assert.equal(describeQuery('tag:财务 营收').noPositiveText, false)
  assert.equal(describeQuery('-foo bar').negated, true)
  assert.equal(describeQuery('a OR b').hasOr, true)
  // 小写 or 不算布尔（否则英文查询会被拆坏）
  assert.equal(describeQuery('arm or leg').hasOr, false)
  assert.equal(describeQuery('"季度 报告"').hasPhrase, true)
  assert.equal(describeQuery('/\\d+/').hasRegex, true)
  // 空查询不报"无文本"（此时还没输入，提示只是噪音）
  assert.equal(describeQuery('   ').noPositiveText, false)
})

test('批次3：高亮分词保留原文与类型（引号内不拆、OR 单独成 token）', () => {
  const toks = tokenizeQueryForHighlight('tag:财务 "季度 报告" -技术 OR /ab/')
  assert.deepEqual(toks.map((t) => [t.kind, t.text]), [
    ['filter', 'tag:财务'],
    ['phrase', '"季度 报告"'],
    ['term', '-技术'],
    ['or', 'OR'],
    ['regex', '/ab/'],
  ])
  assert.equal(toks[2].negate, true)
  assert.equal(toks[0].field, 'tag')
})

test('批次3：未闭合的引号按"余下全是短语"处理（用户意图就是要搜这段）', () => {
  const toks = tokenizeQueryForHighlight('foo "bar baz')
  assert.deepEqual(toks.map((t) => t.kind), ['term', 'phrase'])
  assert.equal(toks[1].text, '"bar baz"')
})

test('批次3：镜像实现不得引入检索判定（只做提示，判定权威在内核）', () => {
  // 这条是**架构契约**扫描：前端若复制一份"命中判定"出来，两份实现漂移时会表现为
  // "UI 说这个过滤生效了、结果却没按它过滤" —— 不报错、不稳定复现，最难排查的一类不一致。
  // 因此本文件只允许解析/描述类导出；出现 match*/hit*/score* 之类的函数即视为违约。
  const src = read('./knowledgeQuery.ts')
  assert.ok(!/export function (match|hit|score)/i.test(src),
    '前端镜像不得导出判定函数：判定只在内核做，结果以内核回传的 query 元信息为准')
  assert.ok(src.includes('describeQuery') && src.includes('tokenizeQueryForHighlight'),
    '应保留解析与提示所需的导出')
})
