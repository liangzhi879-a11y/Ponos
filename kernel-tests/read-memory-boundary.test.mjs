// Read 记忆只读边界扩展（2026-09-10）：memory/personal 下的记忆文件必须可 Read
// ---------------------------------------------------------------------------
// 背景：记忆根（<configDir>/memory/personal）与会话目录（--add-dir）互不相交，
// Read 只按 allowDirs 放行 → 模型想引用记忆原文（workflow.md 等）时被拒
// "路径超出会话目录边界"。MemorySearch 能搜但 Read 读不了原文是边界过严。
// 修复：Read 追加个人/项目记忆根（只读扩展）——Write/Edit 仍锁会话目录，
// 记忆写入必须走 memory.mjs 工具链，不允许任意覆盖。本文件钉死该边界。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createToolRegistry } from '../kernel/tools.mjs'

// createToolRegistry 返回 { registry: { Read: { run } }, toolNames, ... }
function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'read-memory-'))
  const cwd = join(dir, 'work')
  const memoryRoot = join(dir, 'home', 'memory', 'personal')
  const outside = join(dir, 'outside')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(memoryRoot, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(cwd, 'in-work.txt'), 'work file')
  writeFileSync(join(memoryRoot, 'workflow.md'), '# 记忆原文')
  writeFileSync(join(outside, 'secret.txt'), 'outside file')
  const tools = createToolRegistry({ cwd, addDirs: [], skipPermissions: true, memoryRoot })
  return { tools, cwd, memoryRoot, outside, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('Read：记忆目录文件可读（memoryRoot 只读扩展）', () => {
  const env = makeEnv()
  try {
    const r = env.tools.registry.Read.run({ file_path: join(env.memoryRoot, 'workflow.md') })
    assert.equal(r.isError, undefined) // isError 缺省 = 成功
    assert.match(String(r.content), /记忆原文/)
  } finally { env.cleanup() }
})

test('Read：会话目录文件照常可读（零回归）', () => {
  const env = makeEnv()
  try {
    const r = env.tools.registry.Read.run({ file_path: join(env.cwd, 'in-work.txt') })
    assert.equal(r.isError, undefined)
    assert.match(String(r.content), /work file/)
  } finally { env.cleanup() }
})

test('Read：会话/记忆之外的路径仍拒绝', () => {
  const env = makeEnv()
  try {
    const r = env.tools.registry.Read.run({ file_path: join(env.outside, 'secret.txt') })
    assert.equal(r.isError, true)
    assert.match(String(r.content), /拒绝访问：路径超出会话目录边界/)
  } finally { env.cleanup() }
})

test('Write：记忆目录仍拒绝（只读扩展不放大写边界）', () => {
  const env = makeEnv()
  try {
    const r = env.tools.registry.Write.run({ file_path: join(env.memoryRoot, 'x.md'), content: 'overwrite' })
    assert.equal(r.isError, true)
    assert.match(String(r.content), /拒绝访问/)
  } finally { env.cleanup() }
})

test('Edit：记忆目录仍拒绝', () => {
  const env = makeEnv()
  try {
    const r = env.tools.registry.Edit.run({ file_path: join(env.memoryRoot, 'workflow.md'), old_string: 'a', new_string: 'b' })
    assert.equal(r.isError, true)
    assert.match(String(r.content), /拒绝访问/)
  } finally { env.cleanup() }
})

test('readAllowFiles：会话 transcript 文件只读放行（渐进式披露按行展开），未授权时拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'read-transcript-'))
  const cwd = join(dir, 'work')
  const transcript = join(dir, 'home', 'projects', 'x', 'session.jsonl')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(join(dir, 'home', 'projects', 'x'), { recursive: true })
  writeFileSync(transcript, '{"type":"user","seq":1}\n')
  try {
    // 授权（engine 传 session.file）：可读
    const granted = createToolRegistry({ cwd, addDirs: [], skipPermissions: true, memoryRoot: null, readAllowFiles: [transcript] })
    const ok = granted.registry.Read.run({ file_path: transcript })
    assert.equal(ok.isError, undefined, 'transcript 在白名单时应可读')
    assert.match(String(ok.content), /"type":"user"/)
    // 未授权：仍拒绝（不放宽目录）
    const denied = createToolRegistry({ cwd, addDirs: [], skipPermissions: true, memoryRoot: null })
    const bad = denied.registry.Read.run({ file_path: transcript })
    assert.equal(bad.isError, true)
    assert.match(String(bad.content), /拒绝访问/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('memoryRoot 缺省（null）：记忆目录文件拒绝（既有语义零回归）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'read-memory-null-'))
  const cwd = join(dir, 'work')
  const memoryRoot = join(dir, 'home', 'memory', 'personal')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(memoryRoot, { recursive: true })
  writeFileSync(join(memoryRoot, 'workflow.md'), 'mem')
  try {
    const tools = createToolRegistry({ cwd, addDirs: [], skipPermissions: true, memoryRoot: null })
    const r = tools.registry.Read.run({ file_path: join(memoryRoot, 'workflow.md') })
    assert.equal(r.isError, true)
    assert.match(String(r.content), /拒绝访问/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
