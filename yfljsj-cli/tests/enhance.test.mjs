import { test } from 'node:test'
import assert from 'node:assert/strict'
const api = await import('../yfljsj.mjs')

test('schema：输出命令字段定义', () => {
  // 直接测 schemaCommand 渲染（mock stdout）
  const lines = []
  const out = { write: s => lines.push(s) }
  const code = api.schemaCommand('workbench', 'projectAppro-add', { output: out })
  assert.equal(code, 0)
  const text = lines.join('')
  assert.match(text, /projectAppro-add/)
  assert.match(text, /headPerson/)
  assert.match(text, /techEconTarget/)
  assert.match(text, /必填|required/)
})

test('schema：未知命令 → 退出码 2', () => {
  const code = api.schemaCommand('workbench', 'nonexistent', { output: { write: () => {} } })
  assert.equal(code, 2)
})
