import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { createToolRegistry } from '../kernel/tools.mjs'

function reg() {
  return createToolRegistry({ cwd: '/tmp', addDirs: ['/tmp'], skipPermissions: false })
}

test('registry 每工具带 input_schema（JSON Schema，additionalProperties:false）', () => {
  const schemas = reg().toolSchemas()
  assert.deepEqual(schemas.map((s) => s.name), ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent', 'Task', 'TodoWrite', 'WebFetch', 'OCR'])
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
  assert.ok(byName.Read.input_schema.properties.offset)
  assert.ok(byName.Read.input_schema.properties.limit)
  assert.ok(byName.Write.input_schema.properties.file_path)
  assert.ok(byName.Write.input_schema.properties.content)
  assert.deepEqual(byName.Write.input_schema.required, ['file_path', 'content'])
  assert.ok(byName.Edit.input_schema.properties.old_string)
  assert.ok(byName.Edit.input_schema.properties.new_string)
  assert.ok(byName.Edit.input_schema.properties.replace_all)
  assert.deepEqual(byName.Edit.input_schema.required, ['file_path', 'old_string', 'new_string'])
  assert.ok(byName.Glob.input_schema.properties.pattern)
  assert.deepEqual(byName.Glob.input_schema.required, ['pattern'])
  assert.ok(byName.Grep.input_schema.properties.pattern)
  assert.ok(byName.Grep.input_schema.properties.glob)
  assert.ok(byName.Grep.input_schema.properties.context)
  assert.deepEqual(byName.Grep.input_schema.required, ['pattern'])
  // 新工具（subagent 体系 + 扩展工具）schema
  assert.deepEqual(byName.Agent.input_schema.required, ['subagent_type', 'prompt'])
  assert.ok(byName.Agent.input_schema.properties.subagent_type)
  assert.ok(byName.Agent.input_schema.properties.run_in_background)
  assert.deepEqual(byName.Task.input_schema.required, ['command'])
  assert.ok(byName.Task.input_schema.properties.task_id)
  assert.deepEqual(byName.TodoWrite.input_schema.required, ['todos'])
  assert.deepEqual(byName.WebFetch.input_schema.required, ['url'])
  assert.deepEqual(byName.OCR.input_schema.required, ['file_path'])
  assert.ok(byName.OCR.input_schema.properties.mode)
  assert.ok(byName.OCR.input_schema.properties.project)
})

// 功能测试：临时目录内执行工具（真实文件系统，Windows 兼容）
function tmpReg() {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-tools-'))
  return { dir, reg: createToolRegistry({ cwd: dir, addDirs: [dir], skipPermissions: true }) }
}

test('Edit：唯一匹配替换 + 多匹配拒绝 + replace_all 全替换', async () => {
  const { dir, reg } = tmpReg()
  try {
    const f = join(dir, 'a.txt')
    writeFileSync(f, 'hello world\nhello again\n', 'utf-8')
    // 多匹配（hello ×2）无 replace_all → 拒绝
    let r = await reg.run({ name: 'Edit', input: { file_path: f, old_string: 'hello', new_string: 'hi' } }, {})
    assert.equal(r.isError, true)
    assert.match(r.content, /不唯一/)
    // replace_all → 全替换
    r = await reg.run({ name: 'Edit', input: { file_path: f, old_string: 'hello', new_string: 'hi', replace_all: true } }, {})
    assert.equal(r.isError, false)
    assert.match(r.content, /2 处替换/)
    assert.equal(readFileSync(f, 'utf-8'), 'hi world\nhi again\n')
    // 唯一匹配 → 单次替换
    r = await reg.run({ name: 'Edit', input: { file_path: f, old_string: 'hi world', new_string: 'HELLO' } }, {})
    assert.equal(r.isError, false)
    assert.equal(readFileSync(f, 'utf-8'), 'HELLO\nhi again\n')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Read offset/limit：行范围读取，offset 从 1 开始', async () => {
  const { dir, reg } = tmpReg()
  try {
    const f = join(dir, 'multi.txt')
    writeFileSync(f, 'L1\nL2\nL3\nL4\nL5\n', 'utf-8')
    const r = await reg.run({ name: 'Read', input: { file_path: f, offset: 2, limit: 3 } }, {})
    assert.equal(r.isError, false)
    assert.equal(r.content, 'L2\nL3\nL4\n')
    assert.deepEqual(r.meta.range, [2, 4])
    assert.equal(r.meta.totalLines, 5)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Glob：递归匹配通配模式，隐藏目录跳过', async () => {
  const { dir, reg } = tmpReg()
  try {
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'a.mjs'), 'x', 'utf-8')
    writeFileSync(join(dir, 'sub', 'b.mjs'), 'x', 'utf-8')
    writeFileSync(join(dir, 'sub', 'c.txt'), 'x', 'utf-8')
    mkdirSync(join(dir, '.hidden'), { recursive: true })
    writeFileSync(join(dir, '.hidden', 'd.mjs'), 'x', 'utf-8')
    const r = await reg.run({ name: 'Glob', input: { pattern: '**/*.mjs' } }, {})
    assert.equal(r.isError, false)
    const hits = r.content.split('\n')
    assert.equal(hits.length, 2)
    assert.ok(hits.some((h) => h.endsWith('a.mjs')))
    assert.ok(hits.some((h) => h.endsWith('sub' + sep + 'b.mjs')))
    assert.ok(!r.content.includes('d.mjs'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Grep：正则匹配 + context 上下文行 + glob 过滤', async () => {
  const { dir, reg } = tmpReg()
  try {
    writeFileSync(join(dir, 'one.mjs'), 'line1\nTODO fix me\nline3\n', 'utf-8')
    writeFileSync(join(dir, 'two.txt'), 'no match\n', 'utf-8')
    const r = await reg.run({ name: 'Grep', input: { pattern: 'TODO', glob: '**/*.mjs', context: 1 } }, {})
    assert.equal(r.isError, false)
    assert.match(r.content, /one\.mjs/)
    assert.match(r.content, /1:line1/)
    assert.match(r.content, /2:TODO fix me/)
    assert.match(r.content, /3:line3/)
    assert.ok(!r.content.includes('two.txt'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
