// kernel-tests/atlas-render.test.mjs —— 注入面字节预算与 L1/单卡可读性
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFixture } from './atlas-test-helpers.mjs'
import {
  renderOverview, renderL1, renderCard, truncateBytes, L0_BUDGET, L1_BUDGET,
} from '../kernel/atlas/render.mjs'

test('L0：≤300B，含规模/职责/置信摘要', () => {
  const atlas = buildFixture('zero-header')
  const text = renderOverview(atlas)
  assert.ok(Buffer.byteLength(text) <= L0_BUDGET)
  assert.match(text, /^Atlas · zero-header/)
  assert.match(text, /code 5\/test 1/)
  assert.match(text, /有据职责/)
})

test('L1：≤4096B，含域、高重要度代码、测试/资产不挤占域排名', () => {
  const atlas = buildFixture('business-docs')
  const text = renderL1(atlas)
  assert.ok(Buffer.byteLength(text) <= L1_BUDGET)
  assert.match(text, /^# Atlas · business-docs/m)
  assert.match(text, /域（按代码\/文档数）/)
  assert.match(text, /高重要度代码/)
  assert.match(text, /关系：/)
})

test('truncateBytes：UTF-8 不劈字符，尽量在行边界收尾', () => {
  const text = '第一行内容\n第二行内容\n第三行内容'
  const out = truncateBytes(text, 24)
  assert.ok(Buffer.byteLength(out) <= 24)
  assert.equal(out.includes('�'), false)
  assert.ok(out.endsWith('…'))
  assert.ok(out.startsWith('第一行'))
})

test('单卡：doc 显示标题/小节；域卡显示成员；预算生效', () => {
  const atlas = buildFixture('business-docs')
  const doc = renderCard(atlas, 'doc:报告.md')
  assert.match(doc, /标题：季度业务复盘/)
  assert.match(doc, /小节：/)

  const domain = renderCard(atlas, 'domain:root')
  assert.match(domain, /^\[domain\] root/m)
  assert.match(domain, /成员：/)

  const tiny = renderCard(atlas, 'doc:报告.md', { budget: 80 })
  assert.ok(Buffer.byteLength(tiny) <= 80)
  assert.ok(tiny.endsWith('…'))
})
