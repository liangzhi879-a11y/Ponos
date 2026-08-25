import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gramTokens, vectorizeText, cosine, buildIdf, hashLine } from '../kernel/graph.mjs'

test('gramTokens：中文 bigram + 英文单词', () => {
  assert.deepEqual([...gramTokens('知识图谱')], ['知识', '识图', '图谱'])
  assert.deepEqual([...gramTokens('High tech')], ['high', 'tech'])
})

test('gramTokens：中英混排分段', () => {
  assert.deepEqual([...gramTokens('PS表与RD表')], ['ps', '表与', '与r', 'rd', 'rd表'])
  assert.deepEqual([...gramTokens('  a  ')], ['a'])
  assert.deepEqual([...gramTokens('')], [])
})

test('vectorizeText：TF 平滑 + 归一化 + tag 加权', () => {
  const v1 = vectorizeText('知识 知识 图谱')   // 知识 tf=2
  const v2 = vectorizeText('知识 图谱', { tagBoost: 3 })
  const mag = (v) => Math.sqrt(v.reduce((s, [, w]) => s + w * w, 0))
  assert.ok(Math.abs(mag(v1) - 1) < 1e-9, '归一化')
  const w1 = Object.fromEntries(v1); const w2 = Object.fromEntries(v2)
  assert.ok(w1[hashLine('知识')] > w1[hashLine('图谱')], 'TF 高者权重大')
  assert.ok(w2[hashLine('知识')] > w1[hashLine('知识')], 'tagBoost 生效')
})

test('cosine：同义文本高、无关文本低', () => {
  const a = vectorizeText('成果转化材料整理')
  const b = vectorizeText('成果转化材料整理要点')
  const c = vectorizeText('财务报销发票处理')
  assert.ok(cosine(a, b) > 0.6, `同主题应高相似：${cosine(a, b)}`)
  assert.ok(cosine(a, c) < 0.3, `跨主题应低相似：${cosine(a, c)}`)
})

test('buildIdf：泛化 gram 权重低', () => {
  const g1 = { gramCounts: new Map([['的', 1], ['研发', 1]]) }
  const g2 = { gramCounts: new Map([['研发', 1]]) }
  const idf = buildIdf([g1, g2])
  assert.ok(idf.get('的') < idf.get('研发'), 'df 高者 idf 低')
})
