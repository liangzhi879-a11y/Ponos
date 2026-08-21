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

test('Edit（CRLF 归一化）：LF old_string 命中 CRLF 文件，写回保留原行尾', async () => {
  const { dir, reg } = tmpReg()
  try {
    // Windows 仓库文件普遍 CRLF：\r\n 行尾
    const f = join(dir, 'crlf.txt')
    writeFileSync(f, 'line1\r\nTODO fix me\r\nline3\r\n', 'utf-8')
    // 模型按 LF 习惯写 old_string——归一化后必须命中（对照 claude FileEditTool.ts:214）
    const r = await reg.run({ name: 'Edit', input: { file_path: f, old_string: 'TODO fix me', new_string: 'DONE' } }, {})
    assert.equal(r.isError, false)
    assert.match(r.content, /1 处替换/)
    // 写回保留 CRLF 行尾（git diff 不整文件漂移）
    const out = readFileSync(f, 'utf-8')
    assert.equal(out, 'line1\r\nDONE\r\nline3\r\n')
    assert.ok(!out.includes('\nline1'), '行尾必须保持 CRLF')
    // old_string 自带 CRLF 也能命中（模型复制原文时）
    const f2 = join(dir, 'crlf2.txt')
    writeFileSync(f2, 'aaa\r\nbbb\r\n', 'utf-8')
    const r2 = await reg.run({ name: 'Edit', input: { file_path: f2, old_string: 'aaa\r\nbbb', new_string: 'AAA\r\nBBB' } }, {})
    assert.equal(r2.isError, false)
    assert.equal(readFileSync(f2, 'utf-8'), 'AAA\r\nBBB\r\n')
    // 纯 LF 文件行为不变
    const f3 = join(dir, 'lf.txt')
    writeFileSync(f3, 'a\nb\n', 'utf-8')
    const r3 = await reg.run({ name: 'Edit', input: { file_path: f3, old_string: 'a\nb', new_string: 'A\nB' } }, {})
    assert.equal(r3.isError, false)
    assert.equal(readFileSync(f3, 'utf-8'), 'A\nB\n')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Read offset/limit：行范围读取，offset 从 1 开始', async () => {
  const { dir, reg } = tmpReg()
  try {
    const f = join(dir, 'multi.txt')
    writeFileSync(f, 'L1\nL2\nL3\nL4\nL5\n', 'utf-8')
    const r = await reg.run({ name: 'Read', input: { file_path: f, offset: 2, limit: 3 } }, {})
    assert.equal(r.isError, false)
    // 部分读取在正文后追加续读进度指引（对照 pi 的 showing X-Y of N）
    assert.ok(r.content.startsWith('L2\nL3\nL4\n'))
    assert.match(r.content, /共 5 行，已显示 2-4；用 offset=5 继续读取剩余 1 行/)
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

test('Bash（A4）：超长输出截尾保留尾部并带 [truncated] 标记', async () => {
  const { dir, reg } = tmpReg()
  try {
    const r = await reg.run({ name: 'Bash', input: { command: `node -e "process.stdout.write('x'.repeat(250000))"` } }, {})
    assert.equal(r.isError, false)
    assert.match(r.content, /\[truncated: stdout 输出超过上限，已截断保留尾部\]/)
    assert.ok(r.content.length < 200500, '截断后内容应远小于原始 250000')
    assert.ok(r.content.includes('xxx'), '保留尾部内容可引用')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('disallowedTools 过滤：toolNames/toolSchemas 不含禁用工具，run 直接拒绝', async () => {
  const g = createToolRegistry({ cwd: '/tmp', addDirs: ['/tmp'], skipPermissions: false, disallowedTools: ['Agent', 'Task'] })
  assert.deepEqual(g.toolNames, ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite', 'WebFetch', 'OCR'])
  assert.ok(!g.toolSchemas().some((s) => s.name === 'Agent' || s.name === 'Task'))
  // 被禁工具的执行请求（防绕过工具列表）→ 明确拒绝
  const r = await g.run({ name: 'Agent', input: { subagent_type: 'general-purpose', prompt: 'x' } }, {})
  assert.equal(r.isError, true)
  assert.match(r.content, /已被禁用/)
  // 未禁用工具不受影响
  const ok = await g.run({ name: 'Read', input: { file_path: '/tmp/nonexist-xyz' } }, {})
  assert.equal(typeof ok.content, 'string')
})
