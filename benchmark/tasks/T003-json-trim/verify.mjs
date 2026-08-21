// T003 验收：pruneToolResult 对三种 JSON 形态裁剪正确
// 用法：node verify.mjs <workspace>
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const ws = process.argv[2]
const testFile = join(ws, 'server', 'zz-bench-T003-verify.test.mjs')
const testContent = `import { test } from 'node:test'
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
  // 键名保留（格式容忍：minified 或重排后 pretty 形态均算保留——
  // 只断言内容存在，不断言原始压缩形态，否则会误杀语义正确但已 pretty 化的实现）
  assert.ok(/"name"\\s*:\\s*"big-result"/.test(r.text), '键名应保留，实际输出：' + r.text.slice(0, 200))
})

test('B. JSON 多行 pretty（>20000 字符）：键名行与错误行保留', () => {
  const lines = ['{', '  "name": "deploy-service",', '  "items": [']
  for (let i = 0; i < 400; i++) lines.push('    ' + i + ', // ' + 'x'.repeat(50))
  lines.push('  ],', '  "status": "error",', '  "message": "connection refused"', '}')
  const big = lines.join('\\n')
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
  const big = lines.join('\\n')
  assert.ok(big.length > 20000)
  const r = pruneToolResult(big)
  assert.equal(r.truncated, true)
  assert.equal(r.kind, 'json')
  const kept = r.text.split('\\n')
  assert.ok(kept.length <= 60, 'json 分支行数上限，实际 ' + kept.length)
  // 同样格式容忍：minified 或 pretty 形态的 entry-0 / entry-599 均算保留
  assert.ok(/"name"\\s*:\\s*"entry-0"/.test(r.text), '首条应保留：' + r.text.slice(0, 200))
  assert.ok(/"name"\\s*:\\s*"entry-599"/.test(r.text), '末条应保留：' + r.text.slice(-200))
})
`
writeFileSync(testFile, testContent)
try {
  execFileSync(process.execPath, ['--test', testFile], { cwd: ws, stdio: 'pipe', timeout: 60000 })
  console.log('VERIFY_PASS')
  process.exit(0)
} catch (e) {
  const out = e.stdout?.toString?.() || ''
  const err = e.stderr?.toString?.() || ''
  console.error('VERIFY_FAIL')
  console.error((out + '\n' + err).split('\n').slice(-25).join('\n'))
  process.exit(1)
} finally {
  try { unlinkSync(testFile) } catch { }
}
