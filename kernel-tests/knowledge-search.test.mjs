// KnowledgeSearch 工具测试：只读检索，走临时 configDir 隔离。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchKnowledge } from '../kernel/knowledge-search.mjs'
import { CHAT_MODE_DISALLOWED, createToolRegistry } from '../kernel/tools.mjs'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-ks-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  writeFileSync(join(personal, 'workflow.md'), [
    '---', 'name: workflow', '---',
    '- [会话|企微CLI化] 只发文件传输助手 -- 涉及真实沟通渠道的测试一律只发文件传输助手',
    '- [会话|申报材料] 四表联动交叉校验 -- RD/PS/IP/TOAI 四表的产品名称与收入口径必须对齐',
  ].join('\n') + '\n', 'utf-8')
  return dir
}

test('searchKnowledge 返回可读条目清单（含来源与行号）', () => {
  const dir = fixture()
  try {
    const r = searchKnowledge({ configDir: dir, query: '四表联动', keywords: ['申报材料'] })
    assert.equal(r.isError, false)
    assert.match(r.content, /四表联动交叉校验/)
    assert.match(r.content, /experience\/workflow\.md/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('searchKnowledge 无命中给出明确提示而非报错', () => {
  const dir = fixture()
  try {
    const r = searchKnowledge({ configDir: dir, query: 'zzzzz', keywords: ['zzzzz'] })
    assert.equal(r.isError, false)
    assert.match(r.content, /无.*命中|未命中/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('searchKnowledge 空 query 返回 isError', () => {
  const dir = fixture()
  try {
    const r = searchKnowledge({ configDir: dir, query: '' })
    assert.equal(r.isError, true)
    assert.match(r.content, /query/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// 隔离纪律：不存在路径一律落在 tmpdir 内（绝不用 /definitely/not/here 这类绝对路径去
// 真实盘符根建目录），测后清理。
test('searchKnowledge 索引不可用时不抛异常（降级为无命中）', () => {
  const dir = join(tmpdir(), `ponos-ks-absent-${process.pid}-${Date.now()}`)
  try {
    const r = searchKnowledge({ configDir: dir, query: '任意' })
    assert.equal(r.isError, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('S1：KnowledgeSearch 与 MemorySearch 同列 chat 禁用表', () => {
  assert.ok(CHAT_MODE_DISALLOWED.includes('KnowledgeSearch'))
})

// ── 注册表接线（锁 configDir 的推导：memoryRoot = <configDir>/memory/personal）───
// 这是本任务最容易静默错的一环：推导少一级会指向 <configDir>/memory（空空间清单），
// 多一级会指向 <configDir> 的父目录（读到别人的知识库）。故直接经 registry.run 断言。
test('注册表：经 tools.run 调用时 configDir 推导正确（能命中临时 configDir 下的条目）', async () => {
  const dir = fixture()
  try {
    const tools = createToolRegistry({
      cwd: dir, addDirs: [], skipPermissions: true, memoryRoot: join(dir, 'memory', 'personal'),
    })
    assert.ok(tools.toolNames.includes('KnowledgeSearch'))
    const r = await tools.run({ name: 'KnowledgeSearch', input: { query: '四表联动', topK: 3 } }, {})
    assert.equal(r.isError, false)
    assert.match(r.content, /四表联动交叉校验/)
    assert.match(r.content, /experience\/workflow\.md/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('注册表：未传 memoryRoot 时不猜路径（不写 cwd，降级且不报错）', async () => {
  const tools = createToolRegistry({ cwd: tmpdir(), addDirs: [], skipPermissions: true })
  const r = await tools.run({ name: 'KnowledgeSearch', input: { query: '任意' } }, {})
  assert.equal(r.isError, false)
  assert.match(r.content, /不可用/)
})
