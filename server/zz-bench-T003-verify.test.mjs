import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pruneToolResult } from '../kernel/compact.mjs'

test('A. JSON 单行 minified（>20000 字符）：重排采样，truncated 时尺寸真实下降', () => {
  const parts = []
  for (let i = 0; i < 2000; i++) parts.push('"k' + i + '":"' + 'v'.repeat(8) + i + '"')
  const big = '{"name":"big-result","items":{' + parts.join(',') + '}}'
  assert.ok(big.length > 20000)
  const r = pruneToolResult(big)
  assert.equal(r.truncated, true)
  assert.equal(r.kind, 'json')
  assert.ok(r.text.length < big.length, '裁剪后 ' + r.text.length + ' 应小于原 ' + big.length)
  assert.ok(r.text.includes('"name":"big-result"'))
})

test('B. JSON 多行 pretty（>20000 字符）：键名行与错误行保留', () => {
  const lines = ['{', '  "name": "deploy-service",', '  "items": [']
  for (let i = 0; i < 400; i++) lines.push('    ' + i + ', // ' + 'x'.repeat(50))
  lines.push('  ],', '  "status": "error",', '  "message": "connection refused"', '}')
  const big = lines.join('\n')
  assert.ok(big.length > 20000)
  const r = pruneToolResult(big)
  assert.equal(r.truncated, true)
  assert.equal(r.kind, 'json')
  assert.ok(r.text.includes('"name": "deploy-service"'))
  assert.ok(r.text.includes('"status": "error",'))
})

test('C. JSONL 多行（含逗号 >20 行）：走 json 键名分支而非 table 采样', () => {
  const lines = []
  for (let i = 0; i < 600; i++) lines.push('{"ts":' + i + ',"name":"entry-' + i + '","v":"' + 'x'.repeat(30) + '"}')
  const big = lines.join('\n')
  assert.ok(big.length > 20000)
  const r = pruneToolResult(big)
  assert.equal(r.truncated, true)
  assert.equal(r.kind, 'json')
  const kept = r.text.split('\n')
  assert.ok(kept.length <= 60, 'json 分支行数上限，实际 ' + kept.length)
  assert.ok(r.text.includes('"name":"entry-0"'))
  assert.ok(r.text.includes('"name":"entry-599"'))
})
