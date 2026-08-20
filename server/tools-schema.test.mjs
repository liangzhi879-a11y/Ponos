import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createToolRegistry } from '../kernel/tools.mjs'

function reg() {
  return createToolRegistry({ cwd: '/tmp', addDirs: ['/tmp'], skipPermissions: false })
}

test('registry 每工具带 input_schema（JSON Schema，additionalProperties:false）', () => {
  const schemas = reg().toolSchemas()
  assert.deepEqual(schemas.map((s) => s.name), ['Bash', 'Read', 'Write'])
  for (const s of schemas) {
    assert.equal(typeof s.description, 'string')
    assert.ok(s.description.length > 0)
    assert.equal(s.input_schema.type, 'object')
    assert.equal(s.input_schema.additionalProperties, false)
    assert.ok(s.input_schema.properties && typeof s.input_schema.properties === 'object')
  }
})

test('各工具 input_schema 字段与 required 正确', () => {
  const schemas = reg().toolSchemas()
  const byName = Object.fromEntries(schemas.map((s) => [s.name, s]))
  assert.ok(byName.Bash.input_schema.properties.command)
  assert.deepEqual(byName.Bash.input_schema.required, ['command'])
  assert.ok(byName.Read.input_schema.properties.file_path)
  assert.deepEqual(byName.Read.input_schema.required, ['file_path'])
  assert.ok(byName.Write.input_schema.properties.file_path)
  assert.ok(byName.Write.input_schema.properties.content)
  assert.deepEqual(byName.Write.input_schema.required, ['file_path', 'content'])
})
